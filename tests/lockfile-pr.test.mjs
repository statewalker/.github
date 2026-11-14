import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { moves } from "../scripts/lib/lockfile.mjs";
import { fakeGitHub, run } from "./fake-github.mjs";
import { repoRoot } from "./helpers.mjs";

const SCRIPT = path.join(repoRoot, "scripts/lockfile-pr.mjs");
const BOT = "statewalker-release[bot]";
const BRANCH = "deps/statewalker-lockfile";
const LABEL = "deps:lockfile";
const SHA = "a".repeat(40);
const BASE = "/repos/statewalker/example";

const lock = (files, mem) => `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@statewalker/webrun-files':
        specifier: ^0.10.0
        version: ${files}

packages:

  '@statewalker/webrun-files-mem@${mem}':
    resolution: {integrity: sha512-x}

  '@statewalker/webrun-files@${files}':
    resolution: {integrity: sha512-y}

  left-pad@1.3.0:
    resolution: {integrity: sha512-z}

snapshots:

  '@statewalker/webrun-files@${files}(left-pad@1.3.0)': {}
`;

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

/** A repository with an `origin` (a bare repository) holding pnpm-lock.yaml and package.json on main. */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-pr-"));
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, work);
  fs.writeFileSync(path.join(work, "pnpm-lock.yaml"), lock("0.10.4", "0.10.4"));
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"example"}\n');
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "init", "--allow-empty");
  git(work, "add", ".");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "files");
  git(work, "push", "-q", "origin", "HEAD:main");
  return { dir, origin, work };
}

const env = (api, extra = {}) => ({
  GITHUB_API_URL: api?.url ?? "http://127.0.0.1:9",
  GITHUB_REPOSITORY: "statewalker/example",
  GITHUB_TOKEN: "app-token",
  CHECKS_TOKEN: "checks-token",
  LOCKFILE_POLL_SECONDS: "0",
  ...extra,
});

// ---- moves ----

test("the description lists the @statewalker versions that moved, once each", () => {
  assert.deepEqual(moves(lock("0.10.4", "0.10.4"), lock("0.10.5", "0.10.4")), ["- `@statewalker/webrun-files`: 0.10.4 → 0.10.5"]);
  assert.deepEqual(moves(lock("0.10.4", "0.10.4"), lock("0.10.4", "0.10.4")), []);
});

// ---- check ----

test("check: a moved lockfile is a change", async () => {
  const { work } = repo();
  fs.writeFileSync(path.join(work, "pnpm-lock.yaml"), lock("0.10.5", "0.10.5"));
  const output = path.join(work, "..", "out");
  const r = await run(SCRIPT, ["check"], { cwd: work, env: { GITHUB_OUTPUT: output } });
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(output, "utf8"), "changed=true\n");
});

test("check: an unchanged lockfile is no change", async () => {
  const { work } = repo();
  const output = path.join(work, "..", "out");
  const r = await run(SCRIPT, ["check"], { cwd: work, env: { GITHUB_OUTPUT: output } });
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(output, "utf8"), "changed=false\n");
});

test("check: a changed manifest fails, since it would be republished", async () => {
  const { work } = repo();
  fs.writeFileSync(path.join(work, "pnpm-lock.yaml"), lock("0.10.5", "0.10.5"));
  fs.writeFileSync(path.join(work, "package.json"), '{"name":"example","dependencies":{"@statewalker/webrun-files":"^0.10.5"}}\n');
  const r = await run(SCRIPT, ["check"], { cwd: work, env: {} });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /changed more than pnpm-lock\.yaml: package\.json/);
  assert.match(r.out, /--no-save/);
});

// ---- open ----

function openRoutes(state) {
  return {
    [`GET ${BASE}`]: { default_branch: "main" },
    [`GET /users/${BOT}`]: { id: 42, login: BOT },
    [`GET ${BASE}/pulls`]: () => state.prs,
    [`POST ${BASE}/pulls`]: (q) => {
      const pr = { number: 7, html_url: "https://github.com/statewalker/example/pull/7", ...q.json };
      state.prs.push(pr);
      return [201, pr];
    },
    [`PATCH ${BASE}/pulls/7`]: (q) => ({ number: 7, ...q.json }),
    [`POST ${BASE}/labels`]: [422, { message: "Validation Failed" }],
    [`POST ${BASE}/issues/7/labels`]: (q) => [{ name: q.json.labels[0] }],
  };
}

const openArgs = ["open", "--branch", BRANCH, "--label", LABEL, "--author", BOT, "--source", "statewalker/webrun-files published"];

test("open: commits the lockfile on the branch as the App's bot and opens a labelled pull request", async () => {
  const { origin, work } = repo();
  fs.writeFileSync(path.join(work, "pnpm-lock.yaml"), lock("0.10.5", "0.10.4"));
  const state = { prs: [] };
  const api = await fakeGitHub(openRoutes(state));
  try {
    const r = await run(SCRIPT, openArgs, { cwd: work, env: env(api) });
    assert.equal(r.code, 0, r.out);
    assert.equal(git(origin, "show", `${BRANCH}:pnpm-lock.yaml`), lock("0.10.5", "0.10.4").trim());
    assert.equal(git(origin, "log", "-1", "--format=%an <%ae>", BRANCH), `${BOT} <42+${BOT}@users.noreply.github.com>`);
    assert.deepEqual(git(origin, "diff", "--name-only", "main", BRANCH).split("\n"), ["pnpm-lock.yaml"]);
    const created = api.writes().find((q) => q.method === "POST" && q.path === `${BASE}/pulls`);
    assert.equal(created.json.head, BRANCH);
    assert.equal(created.json.base, "main");
    assert.match(created.json.body, /`@statewalker\/webrun-files`: 0\.10\.4 → 0\.10\.5/);
    assert.match(created.json.body, /after statewalker\/webrun-files published/);
    assert.deepEqual(api.writes().find((q) => q.path === `${BASE}/issues/7/labels`).json, { labels: [LABEL] });
    assert.ok(api.requests.every((q) => q.auth === "Bearer app-token"));
  } finally {
    await api.close();
  }
});

test("open: the same lockfile again pushes nothing and updates the open pull request", async () => {
  const { origin, work } = repo();
  fs.writeFileSync(path.join(work, "pnpm-lock.yaml"), lock("0.10.5", "0.10.4"));
  const state = { prs: [] };
  const api = await fakeGitHub(openRoutes(state));
  try {
    assert.equal((await run(SCRIPT, openArgs, { cwd: work, env: env(api) })).code, 0);
    const pushed = git(origin, "rev-parse", BRANCH);
    git(work, "checkout", "-q", "main");
    fs.writeFileSync(path.join(work, "pnpm-lock.yaml"), lock("0.10.5", "0.10.4"));
    const r = await run(SCRIPT, openArgs, { cwd: work, env: env(api) });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /already holds this lockfile/);
    assert.equal(git(origin, "rev-parse", BRANCH), pushed);
    assert.equal(api.writes().filter((q) => q.method === "POST" && q.path === `${BASE}/pulls`).length, 1);
    assert.ok(api.writes().some((q) => q.method === "PATCH" && q.path === `${BASE}/pulls/7`));
  } finally {
    await api.close();
  }
});

test("open: refuses anything but the lockfile", async () => {
  const { work } = repo();
  fs.writeFileSync(path.join(work, "pnpm-lock.yaml"), lock("0.10.5", "0.10.4"));
  fs.writeFileSync(path.join(work, "package.json"), "{}\n");
  const api = await fakeGitHub({});
  try {
    const r = await run(SCRIPT, openArgs, { cwd: work, env: env(api) });
    assert.equal(r.code, 1, r.out);
    assert.equal(api.writes().length, 0);
  } finally {
    await api.close();
  }
});

// ---- merge ----

const pull = (over = {}) => ({
  number: 7,
  state: "open",
  user: { login: BOT },
  head: { sha: SHA, ref: BRANCH, repo: { full_name: "statewalker/example" } },
  labels: [{ name: LABEL }],
  ...over,
});
const checkRun = (id, name, status, conclusion = null) => ({ id, name, status, conclusion });

function mergeRoutes({ pr = pull(), files = [{ filename: "pnpm-lock.yaml" }], checks = [[checkRun(1, "ci / ci", "completed", "success")]], statuses = [] } = {}) {
  let poll = 0;
  return {
    [`GET ${BASE}/pulls/7`]: pr,
    [`GET ${BASE}/pulls/7/files`]: files,
    [`GET ${BASE}/actions/runs/99/attempts/1/jobs`]: {
      jobs: [
        { id: 1, status: "completed", runner_name: "r1" },
        { id: 2, status: "in_progress", runner_name: "r2" },
      ],
    },
    [`GET ${BASE}/commits/${SHA}/check-runs`]: () => {
      const runs = checks[Math.min(poll++, checks.length - 1)];
      return { total_count: runs.length + 1, check_runs: [...runs, checkRun(2, "lockfile / merge", "in_progress")] };
    },
    [`GET ${BASE}/commits/${SHA}/status`]: { state: statuses.length ? "pending" : "success", statuses },
    [`POST ${BASE}/issues/7/comments`]: [201, { id: 1 }],
    [`PUT ${BASE}/pulls/7/merge`]: { merged: true, sha: "b".repeat(40) },
  };
}

const mergeArgs = ["merge", "--pr", "7", "--sha", SHA, "--branch", BRANCH, "--label", LABEL, "--author", BOT, "--timeout", "1"];
const runEnv = (api) => env(api, { GITHUB_RUN_ID: "99", GITHUB_RUN_ATTEMPT: "1", RUNNER_NAME: "r2" });

test("merge: every other check green → a record comment, then a squash merge pinned to the head", async () => {
  const api = await fakeGitHub(mergeRoutes());
  try {
    const r = await run(SCRIPT, mergeArgs, { cwd: repoRoot, env: runEnv(api) });
    assert.equal(r.code, 0, r.out);
    const writes = api.writes();
    assert.deepEqual(writes.map((q) => `${q.method} ${q.path}`), [`POST ${BASE}/issues/7/comments`, `PUT ${BASE}/pulls/7/merge`]);
    assert.match(writes[0].json.body, /lockfile-gate: sha=a{40} checks=1/);
    assert.doesNotMatch(writes[0].json.body, /<!--\s*gate:/);
    assert.equal(writes[1].json.merge_method, "squash");
    assert.equal(writes[1].json.sha, SHA);
    assert.ok(writes.every((q) => q.auth === "Bearer app-token"));
    assert.ok(api.requests.filter((q) => /check-runs|status$|jobs$/.test(q.path)).every((q) => q.auth === "Bearer checks-token"));
  } finally {
    await api.close();
  }
});

test("merge: waits while other checks run, then merges", async () => {
  const api = await fakeGitHub(
    mergeRoutes({
      checks: [
        [checkRun(1, "ci / ci", "completed", "success"), checkRun(3, "examples", "in_progress")],
        [checkRun(1, "ci / ci", "completed", "success"), checkRun(3, "examples", "completed", "skipped")],
      ],
    }),
  );
  try {
    const r = await run(SCRIPT, mergeArgs, { cwd: repoRoot, env: runEnv(api) });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /waiting for examples/);
    assert.ok(api.writes().some((q) => q.method === "PUT"));
  } finally {
    await api.close();
  }
});

test("merge: a failed check leaves the pull request open with a comment", async () => {
  const api = await fakeGitHub(mergeRoutes({ checks: [[checkRun(1, "ci / ci", "completed", "failure")]] }));
  try {
    const r = await run(SCRIPT, mergeArgs, { cwd: repoRoot, env: runEnv(api) });
    assert.equal(r.code, 1, r.out);
    assert.ok(!api.writes().some((q) => q.method === "PUT"));
    assert.match(api.writes()[0].json.body, /checks failed: ci \/ ci \(failure\)/);
  } finally {
    await api.close();
  }
});

for (const [name, over] of [
  ["a pull request that changes more than the lockfile", { files: [{ filename: "pnpm-lock.yaml" }, { filename: "package.json" }] }],
  ["a pull request opened by someone else", { pr: pull({ user: { login: "someone" } }) }],
  ["a pull request without the label", { pr: pull({ labels: [] }) }],
  ["a pull request from a fork", { pr: pull({ head: { sha: SHA, ref: BRANCH, repo: { full_name: "someone/example" } } }) }],
]) {
  test(`merge: refuses ${name}`, async () => {
    const api = await fakeGitHub(mergeRoutes(over));
    try {
      const r = await run(SCRIPT, mergeArgs, { cwd: repoRoot, env: runEnv(api) });
      assert.equal(r.code, 1, r.out);
      assert.ok(!api.writes().some((q) => q.method === "PUT"));
    } finally {
      await api.close();
    }
  });
}

test("merge: a newer head commit is left to its own run", async () => {
  const api = await fakeGitHub(mergeRoutes({ pr: pull({ head: { sha: "c".repeat(40), ref: BRANCH, repo: { full_name: "statewalker/example" } } }) }));
  try {
    const r = await run(SCRIPT, mergeArgs, { cwd: repoRoot, env: runEnv(api) });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /newer commit/);
    assert.equal(api.writes().length, 0);
  } finally {
    await api.close();
  }
});
