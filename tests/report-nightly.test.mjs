import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { repoRoot } from "./helpers.mjs";

const TITLE = "Nightly: browser and end-to-end suites fail";
const RUN = "https://github.com/statewalker/example/actions/runs/1";

/**
 * A stand-in for the GitHub REST API: the few endpoints the reporter uses, over in-memory issues
 * seeded from recorded responses. It records every request.
 */
async function fakeGitHub(issues = []) {
  const state = { issues: structuredClone(issues), comments: [], labels: new Set(["bug"]), requests: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      const json = body ? JSON.parse(body) : undefined;
      state.requests.push({ method: req.method, path: url.pathname, search: url.search, json, auth: req.headers.authorization });
      const send = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const base = "/repos/statewalker/example";
      if (req.method === "GET" && url.pathname === `${base}/issues`) {
        const label = url.searchParams.get("labels");
        return send(200, state.issues.filter((i) => i.state === "open" && i.labels.some((l) => l.name === label)));
      }
      if (req.method === "POST" && url.pathname === `${base}/labels`) {
        if (state.labels.has(json.name)) return send(422, { message: "Validation Failed", errors: [{ code: "already_exists" }] });
        state.labels.add(json.name);
        return send(201, { name: json.name });
      }
      if (req.method === "POST" && url.pathname === `${base}/issues`) {
        const number = 100 + state.issues.length;
        const issue = {
          number,
          state: "open",
          title: json.title,
          body: json.body,
          labels: json.labels.map((name) => ({ name })),
          html_url: `https://github.com/statewalker/example/issues/${number}`,
          pull_request: null,
        };
        state.issues.push(issue);
        return send(201, issue);
      }
      const comment = new RegExp(`^${base}/issues/(\\d+)/comments$`).exec(url.pathname);
      if (req.method === "POST" && comment) {
        state.comments.push({ issue: Number(comment[1]), body: json.body });
        return send(201, { id: state.comments.length });
      }
      send(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { state, url, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function report(api, outcome) {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [path.join(repoRoot, "scripts/report-nightly.mjs"), "--outcome", outcome, "--run-url", RUN, "--suite", "pnpm run test:nightly"],
      { env: { ...process.env, GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "statewalker/example", GITHUB_TOKEN: "test-token" } },
    );
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code, out: `${err.stdout}${err.stderr}` };
  }
}

const writes = (state) => state.requests.filter((r) => r.method !== "GET");

test("a failing run opens one bug issue labelled ci-baseline, linking the run", async () => {
  const api = await fakeGitHub();
  try {
    const r = await report(api, "failure");
    assert.equal(r.code, 0, r.out);
    const created = api.state.issues.filter((i) => i.title === TITLE);
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].labels.map((l) => l.name).sort(), ["bug", "ci-baseline"]);
    assert.match(created[0].body, new RegExp(RUN));
    assert.match(created[0].body, /pnpm run test:nightly/);
    assert.ok(api.state.labels.has("ci-baseline"), "the missing label is created");
    assert.ok(api.state.requests.every((q) => q.auth === "Bearer test-token"));
    assert.match(r.out, /opened .*issues\/100/);
  } finally {
    await api.close();
  }
});

test("a second failure updates the open issue instead of opening another", async () => {
  const api = await fakeGitHub();
  try {
    await report(api, "failure");
    const r = await report(api, "failure");
    assert.equal(r.code, 0, r.out);
    assert.equal(api.state.issues.filter((i) => i.title === TITLE).length, 1);
    assert.equal(api.state.comments.length, 1);
    assert.equal(api.state.comments[0].issue, 100);
    assert.match(api.state.comments[0].body, new RegExp(RUN));
    assert.match(r.out, /updated .*issues\/100/);
  } finally {
    await api.close();
  }
});

test("a passing run opens nothing and writes nothing", async () => {
  const api = await fakeGitHub();
  try {
    const r = await report(api, "success");
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(writes(api.state), []);
  } finally {
    await api.close();
  }
});

test("other ci-baseline issues and pull requests with the same title are not taken for the nightly issue", async () => {
  const recorded = JSON.parse(fs.readFileSync(path.join(repoRoot, "fixtures/nightly/unrelated-ci-baseline-issue.json"), "utf8"));
  const api = await fakeGitHub(recorded);
  try {
    const r = await report(api, "failure");
    assert.equal(r.code, 0, r.out);
    assert.equal(api.state.comments.length, 0);
    assert.equal(api.state.issues.filter((i) => i.title === TITLE && !i.pull_request).length, 1);
  } finally {
    await api.close();
  }
});

test("a cancelled run reports nothing", async () => {
  const api = await fakeGitHub();
  try {
    const r = await report(api, "cancelled");
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(writes(api.state), []);
  } finally {
    await api.close();
  }
});

test("an API error fails the reporter", async () => {
  const api = await fakeGitHub();
  await api.close();
  const r = await report(api, "failure");
  assert.notEqual(r.code, 0, r.out);
});
