// release-changesets.mjs against a fixture workspace, a fake registry (the package documents the
// script fetches) and the fake npm (the tarballs it packs).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "./helpers.mjs";

const fixture = path.join(repoRoot, "fixtures", "release-changesets", "publish-config");
const published = path.join(fixture, "published", "@fixture", "a");

/** Run the script (--dry-run) with npm's latest @fixture/a 1.0.0 published with `exports`. */
async function run(t, exports) {
  const manifest = { ...JSON.parse(fs.readFileSync(path.join(published, "package.json"), "utf8")), exports };
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name: "@fixture/a", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": manifest } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-changesets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, "registry.json");
  fs.writeFileSync(state, JSON.stringify({ "@fixture/a": { latest: "1.0.0", versions: { "1.0.0": published } } }));
  const child = spawn(process.execPath, [path.join(repoRoot, "scripts", "release-changesets.mjs"), "--dry-run"], {
    cwd: fixture,
    env: {
      ...process.env,
      NPM_REGISTRY: `http://127.0.0.1:${server.address().port}`,
      FAKE_NPM: state,
      PATH: `${path.join(repoRoot, "tests", "fake-npm")}${path.delimiter}${process.env.PATH}`,
    },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, out };
}

test("a package published through publishConfig.exports, unchanged since npm's latest, needs no release", async (t) => {
  const r = await run(t, { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /exports changed/);
  assert.match(r.out, /Nothing to release/);
});

test("publishConfig.exports that differ from npm's latest are reported as changed exports", async (t) => {
  const r = await run(t, { ".": { types: "./dist/index.d.ts", default: "./dist/old.js" } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /@fixture\/a: patch\n\s+exports changed/);
});
