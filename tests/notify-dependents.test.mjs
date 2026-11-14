import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fakeGitHub, run } from "./fake-github.mjs";
import { repoRoot } from "./helpers.mjs";

const SCRIPT = path.join(repoRoot, "scripts/notify-dependents.mjs");

const installation = (names) => ({
  total_count: names.length,
  repositories: names.map((n) => ({ full_name: `statewalker/${n}`, archived: n.startsWith("old-") })),
});

const notify = (api, packages) =>
  run(SCRIPT, ["--packages", packages], {
    cwd: repoRoot,
    env: { GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "statewalker/webrun-files", GITHUB_TOKEN: "app-token" },
  });

test("every other repository of the installation gets one statewalker-published dispatch", async () => {
  const api = await fakeGitHub({
    "GET /installation/repositories": installation(["webrun-files", "cellb.dev", "httpeers", "old-umbrella"]),
    "POST /repos/statewalker/cellb.dev/dispatches": [204, {}],
    "POST /repos/statewalker/httpeers/dispatches": [204, {}],
  });
  try {
    const r = await notify(api, "@statewalker/webrun-files@0.11.1 @statewalker/webrun-files-mem@0.11.1");
    assert.equal(r.code, 0, r.out);
    const sent = api.writes();
    assert.deepEqual(sent.map((q) => q.path).sort(), ["/repos/statewalker/cellb.dev/dispatches", "/repos/statewalker/httpeers/dispatches"]);
    for (const q of sent) {
      assert.equal(q.json.event_type, "statewalker-published");
      assert.deepEqual(q.json.client_payload, {
        source: "statewalker/webrun-files",
        packages: ["@statewalker/webrun-files@0.11.1", "@statewalker/webrun-files-mem@0.11.1"],
      });
      assert.equal(q.auth, "Bearer app-token");
    }
  } finally {
    await api.close();
  }
});

test("one failed dispatch does not stop the others, and fails the step", async () => {
  const api = await fakeGitHub({
    "GET /installation/repositories": installation(["webrun-files", "cellb.dev", "httpeers"]),
    "POST /repos/statewalker/cellb.dev/dispatches": [403, { message: "Resource not accessible by integration" }],
    "POST /repos/statewalker/httpeers/dispatches": [204, {}],
  });
  try {
    const r = await notify(api, "@statewalker/webrun-files@0.11.1");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /statewalker\/cellb\.dev was not notified/);
    assert.ok(api.writes().some((q) => q.path === "/repos/statewalker/httpeers/dispatches"));
  } finally {
    await api.close();
  }
});

test("nothing published, nobody notified", async () => {
  const api = await fakeGitHub({});
  try {
    const r = await notify(api, "");
    assert.equal(r.code, 0, r.out);
    assert.equal(api.requests.length, 0);
  } finally {
    await api.close();
  }
});
