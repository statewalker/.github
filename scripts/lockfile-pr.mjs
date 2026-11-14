#!/usr/bin/env node
// The lockfile-only pull request that moves a repository to the newest `@statewalker/*` versions
// within its ranges (statewalker-update.yml opens it, merge-lockfile.yml merges it). Three steps:
//
//   node lockfile-pr.mjs check
//     After `pnpm update --recursive --no-save "@statewalker/*"`: did the lockfile move? Writes
//     `changed=true|false` to $GITHUB_OUTPUT. Fails when anything but the root pnpm-lock.yaml
//     changed: a manifest or a catalog that moved would change what the repository publishes.
//
//   node lockfile-pr.mjs open --branch <b> --label <l> --author <login> [--source <text>]
//     In a checkout whose pnpm-lock.yaml was replaced by the updated one: commits it on <b>
//     (from the default branch), pushes it and opens the pull request, labelled <l>, or updates
//     the one already open. Pushes nothing when <b> already holds the same lockfile, and refuses
//     to overwrite <b> when it changes anything besides the lockfile (someone pushed work there).
//
//   node lockfile-pr.mjs merge --pr <n> --sha <sha> --branch <b> --label <l> --author <login>
//     [--timeout <minutes>]
//     Merges pull request <n> (squash, pinned to <sha>) once every other check on <sha> passed,
//     and only if it is still the one `open` makes: opened by <login>, from <b>, labelled <l>,
//     changing the root pnpm-lock.yaml and nothing else, with <sha> as its head. A failed check
//     leaves it open, with a comment, for a session: the dependent does not work with the new
//     versions as they are.
//
// Environment: GITHUB_REPOSITORY; GITHUB_TOKEN, the statewalker-release App's installation token
// (Contents and Pull requests: write), which every write uses so that GitHub runs CI on the push
// and on main after the merge (it does not for GITHUB_TOKEN's). `merge` reads check runs,
// statuses and the workflow's own jobs with CHECKS_TOKEN (the workflow's GITHUB_TOKEN, with
// checks, statuses and actions: read), and finds its own job by GITHUB_RUN_ID,
// GITHUB_RUN_ATTEMPT and RUNNER_NAME. LOCKFILE_POLL_SECONDS (default 20) paces its polling.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { moves } from "./lib/lockfile.mjs";
import { rest } from "./lib/rest.mjs";

const LOCKFILE = "pnpm-lock.yaml";
const TITLE = "chore: update @statewalker dependencies (lockfile only)";
const OK = new Set(["success", "skipped", "neutral"]);

const [command, ...rest_] = process.argv.slice(2);
const { values: args } = parseArgs({
  args: rest_,
  options: {
    branch: { type: "string" },
    label: { type: "string" },
    author: { type: "string" },
    source: { type: "string", default: "" },
    pr: { type: "string" },
    sha: { type: "string" },
    timeout: { type: "string", default: "60" },
  },
});

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const out = (key, value) => {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};
const need = (...names) => {
  const missing = names.filter((n) => !args[n]);
  if (missing.length) {
    console.error(`lockfile-pr ${command}: missing ${missing.map((n) => `--${n}`).join(", ")}`);
    process.exit(2);
  }
};

/** Paths changed in the working tree, untracked files included. */
function changedPaths() {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
}

function check() {
  const paths = changedPaths();
  const others = paths.filter((p) => p !== LOCKFILE);
  if (others.length) {
    console.error(
      `lockfile-pr: the update changed more than ${LOCKFILE}: ${others.join(", ")}.\n` +
        "Was `--no-save` given to `pnpm update`? Without it pnpm rewrites the ranges in package.json and the catalogs, which changes what the repository publishes.",
    );
    process.exit(1);
  }
  const changed = paths.includes(LOCKFILE);
  console.log(changed ? `lockfile-pr: ${LOCKFILE} moved` : "lockfile-pr: every @statewalker/* dependency is already the newest within its range");
  out("changed", String(changed));
}

async function open() {
  need("branch", "label", "author");
  const repo = process.env.GITHUB_REPOSITORY;
  const gh = rest(process.env.GITHUB_TOKEN);
  const paths = changedPaths();
  if (!paths.includes(LOCKFILE) || paths.some((p) => p !== LOCKFILE)) {
    console.error(`lockfile-pr: expected a change to ${LOCKFILE} alone, found: ${paths.join(", ") || "nothing"}`);
    process.exit(1);
  }
  const { default_branch: base } = await gh.call("GET", `/repos/${repo}`);
  const lines = moves(git("show", `HEAD:${LOCKFILE}`), fs.readFileSync(LOCKFILE, "utf8"));

  const bot = await gh.call("GET", `/users/${encodeURIComponent(args.author)}`);
  const email = `${bot.id}+${args.author}@users.noreply.github.com`;
  git("checkout", "-B", args.branch);
  git("add", LOCKFILE);
  git("-c", `user.name=${args.author}`, "-c", `user.email=${email}`, "commit", "-m", TITLE, "-m", lines.join("\n"));

  const remote = git("ls-remote", "origin", `refs/heads/${args.branch}`);
  let same = false;
  if (remote) {
    // A session may have pushed a fix to the branch despite merging.md: never force-push it away.
    const compare = await gh.call("GET", `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(args.branch)}`);
    const foreign = (compare.files ?? []).map((f) => f.filename).filter((f) => f !== LOCKFILE);
    if (foreign.length) {
      console.error(`lockfile-pr: ${args.branch} also changes ${foreign.join(", ")}; not overwriting it. Move that work to a branch of its own (statewalker-root docs/process/merging.md, "Lockfile-only pull requests").`);
      process.exit(1);
    }
    git("fetch", "--depth=1", "origin", `refs/heads/${args.branch}`);
    same = git("rev-parse", "FETCH_HEAD^{tree}") === git("rev-parse", "HEAD^{tree}");
  }
  if (same) console.log(`lockfile-pr: ${args.branch} already holds this lockfile`);
  else git("push", "--force", "origin", `HEAD:refs/heads/${args.branch}`);

  const owner = repo.split("/")[0];
  const [existing] = await gh.call("GET", `/repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(args.branch)}`);
  const body = [
    `Moves the lockfile to the newest \`@statewalker/*\` versions within the ranges this repository declares${args.source ? `, after ${args.source}` : ""}. No manifest or catalog changes, so nothing is republished; CI shows that this repository works with the new versions.`,
    "",
    ...(lines.length ? lines : ["- (no `@statewalker/*` version moved; only resolution metadata)"]),
    "",
    `Opened by \`statewalker-update.yml\` (statewalker/statewalker-ci). Labelled \`${args.label}\`: \`merge-lockfile.yml\` merges it once every check passes; a failing check leaves it open for a session (statewalker/statewalker-root \`docs/process/merging.md\`, "Lockfile-only pull requests").`,
  ].join("\n");
  let pr = existing;
  if (pr) {
    await gh.call("PATCH", `/repos/${repo}/pulls/${pr.number}`, { title: TITLE, body });
  } else {
    pr = await gh.call("POST", `/repos/${repo}/pulls`, { title: TITLE, head: args.branch, base, body });
  }
  await gh.call("POST", `/repos/${repo}/labels`, { name: args.label, color: "0e8a16", description: "Lockfile-only @statewalker update, merged when green" }, [422]);
  await gh.call("POST", `/repos/${repo}/issues/${pr.number}/labels`, { labels: [args.label] });
  console.log(`lockfile-pr: ${existing ? "updated" : "opened"} ${pr.html_url}`);
  out("pr", String(pr.number));
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function merge() {
  need("pr", "sha", "branch", "label", "author");
  const repo = process.env.GITHUB_REPOSITORY;
  const gh = rest(process.env.GITHUB_TOKEN);
  const checks = rest(process.env.CHECKS_TOKEN || process.env.GITHUB_TOKEN);
  const refuse = async (why) => {
    console.error(`lockfile-pr: not merging #${args.pr}: ${why}`);
    await gh.call("POST", `/repos/${repo}/issues/${args.pr}/comments`, {
      body: `Not merged automatically: ${why}\n\nLeft open for a session (statewalker/statewalker-root \`docs/process/merging.md\`, "Lockfile-only pull requests").`,
    });
    process.exit(1);
  };

  const pr = await gh.call("GET", `/repos/${repo}/pulls/${args.pr}`);
  if (pr.state !== "open") return console.log(`lockfile-pr: #${args.pr} is ${pr.state}`);
  if (pr.head.sha !== args.sha) return console.log(`lockfile-pr: #${args.pr} has a newer commit (${pr.head.sha}); its own run merges it`);
  if (pr.user.login !== args.author) await refuse(`opened by ${pr.user.login}, not ${args.author}.`);
  if (pr.head.ref !== args.branch || pr.head.repo?.full_name !== repo) await refuse(`its branch is not ${repo}:${args.branch}.`);
  if (!pr.labels.some((l) => l.name === args.label)) await refuse(`it is not labelled \`${args.label}\`.`);
  const files = await gh.pages(`/repos/${repo}/pulls/${args.pr}/files`);
  const others = files.map((f) => f.filename).filter((f) => f !== LOCKFILE);
  if (others.length || files.length === 0) await refuse(`it changes ${others.join(", ") || "nothing"}, not only \`${LOCKFILE}\`.`);

  // This job's own check run (a job's id is its check run's id) is still running: skip it.
  let self;
  const { GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt = "1", RUNNER_NAME: runner } = process.env;
  if (run) {
    const jobs = await checks.pages(`/repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs`, "jobs");
    self = jobs.find((j) => j.status === "in_progress" && j.runner_name === runner)?.id;
  }

  const deadline = Date.now() + Number(args.timeout) * 60000;
  const poll = Number(process.env.LOCKFILE_POLL_SECONDS ?? 20);
  let passed;
  for (;;) {
    const runs = (await checks.pages(`/repos/${repo}/commits/${args.sha}/check-runs`, "check_runs")).filter((c) => c.id !== self);
    const status = await checks.call("GET", `/repos/${repo}/commits/${args.sha}/status`);
    const failed = [
      ...runs.filter((c) => c.status === "completed" && !OK.has(c.conclusion)).map((c) => `${c.name} (${c.conclusion})`),
      ...(status.statuses ?? []).filter((s) => ["failure", "error"].includes(s.state)).map((s) => `${s.context} (${s.state})`),
    ];
    if (failed.length) await refuse(`checks failed: ${failed.join(", ")}.`);
    const pending = [
      ...runs.filter((c) => c.status !== "completed").map((c) => c.name),
      ...(status.statuses ?? []).filter((s) => s.state === "pending").map((s) => s.context),
    ];
    if (!pending.length) {
      passed = runs.length + (status.statuses ?? []).length;
      break;
    }
    if (Date.now() > deadline) await refuse(`checks still running after ${args.timeout} minutes: ${pending.join(", ")}.`);
    console.log(`lockfile-pr: waiting for ${pending.join(", ")}`);
    await sleep(poll);
  }

  // The gate's record for a lockfile-only pull request (merging.md): what was verified, in
  // place of a reviewer's pass. Its marker is not a `gate:` line, so the review metrics do not
  // count it as a reviewed pass.
  await gh.call("POST", `/repos/${repo}/issues/${args.pr}/comments`, {
    body: [
      "Merge gate, lockfile-only pull request: verified mechanically, no reviewer pass (no code changes to review).",
      "",
      `- opened by \`${args.author}\` from \`${args.branch}\`, labelled \`${args.label}\`;`,
      `- changes \`${LOCKFILE}\` only;`,
      `- ${passed} other check(s) on ${args.sha.slice(0, 7)} passed.`,
      "",
      "Decision: merge (squash).",
      "",
      `<!-- lockfile-gate: sha=${args.sha} checks=${passed} -->`,
    ].join("\n"),
  });
  const merged = await gh.call("PUT", `/repos/${repo}/pulls/${args.pr}/merge`, { merge_method: "squash", sha: args.sha, commit_title: `${TITLE} (#${args.pr})` }, [405, 409]);
  if (!merged.merged) await refuse(`GitHub refused the merge: ${merged.message ?? merged.httpStatus}.`);
  console.log(`lockfile-pr: merged #${args.pr}`);
}

if (command === "check") check();
else if (command === "open") await open();
else if (command === "merge") await merge();
else {
  console.error("usage: lockfile-pr.mjs check | open --branch <b> --label <l> --author <login> | merge --pr <n> --sha <sha> --branch <b> --label <l> --author <login>");
  process.exit(2);
}
