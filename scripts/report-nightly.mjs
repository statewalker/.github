#!/usr/bin/env node
// Report a nightly run of a project's browser and end-to-end suites to its own issue tracker:
//   - failure: one open `bug` issue labelled `ci-baseline`, titled "Nightly: browser and end-to-end
//     suites fail". If it is already open (the duplicate check), a comment with the new run is added
//     to it instead of opening another;
//   - success or cancelled: nothing is written.
//
//   node report-nightly.mjs --outcome <success|failure|cancelled> --run-url <url> [--suite <command>]
//
// GitHub Actions provides GITHUB_REPOSITORY and GITHUB_API_URL; GITHUB_TOKEN needs `issues: write`.
import { parseArgs } from "node:util";

const TITLE = "Nightly: browser and end-to-end suites fail";
const LABELS = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "ci-baseline", color: "ededed", description: "A missing or failing CI baseline measure" },
];

const { values } = parseArgs({
  options: {
    outcome: { type: "string" },
    "run-url": { type: "string" },
    suite: { type: "string", default: "the nightly suites" },
  },
});
const { outcome } = values;
if (!["success", "failure", "cancelled", "skipped"].includes(outcome) || !values["run-url"]) {
  console.error("usage: report-nightly.mjs --outcome <success|failure|cancelled> --run-url <url> [--suite <command>]");
  process.exit(2);
}
if (outcome !== "failure") {
  console.log(`nightly: ${outcome}, nothing to report`);
  process.exit(0);
}

const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repo || !token) {
  console.error("nightly: GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  process.exit(2);
}

/** One REST call; the parsed body. Statuses in `accept` besides 2xx are returned, not thrown. */
async function github(method, route, body, accept = []) {
  const res = await fetch(`${api}/repos/${repo}${route}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !accept.includes(res.status)) {
    throw new Error(`${method} ${route}: HTTP ${res.status} ${data.message ?? ""}`.trim());
  }
  return data;
}

const when = new Date().toISOString().slice(0, 10);

// The duplicate check: the open issue (not a pull request) with this title and label.
const open = await github("GET", "/issues?state=open&labels=ci-baseline&per_page=100");
const existing = open.find((i) => i.title === TITLE && !i.pull_request);

if (existing) {
  await github("POST", `/issues/${existing.number}/comments`, {
    body: `Failed again on ${when}: ${values["run-url"]}`,
  });
  console.log(`nightly: failure, updated ${existing.html_url}`);
} else {
  for (const label of LABELS) await github("POST", "/labels", label, [422]);
  const issue = await github("POST", "/issues", {
    title: TITLE,
    labels: LABELS.map((l) => l.name),
    body: [
      `The nightly run of the browser and end-to-end suites (\`${values.suite}\`) failed on ${when}.`,
      "",
      `Run: ${values["run-url"]}`,
      "",
      "Later failures are added here as comments while this issue is open. Fix the suites (or the code",
      "they caught), then close this issue; the next failure opens a new one.",
    ].join("\n"),
  });
  console.log(`nightly: failure, opened ${issue.html_url}`);
}
