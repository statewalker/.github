import assert from "node:assert/strict";
import { test } from "node:test";
import { runCheck } from "./helpers.mjs";

const check = (fixture) => runCheck("check-release-path.mjs", `release-path/${fixture}`);

test("a repository without publish steps passes", () => {
  const r = check("clean");
  assert.equal(r.code, 0, r.out);
});

test("publishing from the standard publish job of ci.yml passes", () => {
  const r = check("standard-publish");
  assert.equal(r.code, 0, r.out);
});

test("a publish step in another job fails, naming the file, job and command", () => {
  const r = check("publish-in-other-job");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ci\.yml, job "release", step 2: npm publish/);
});

test("a job named publish in another workflow file fails", () => {
  const r = check("publish-in-other-workflow");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /release\.yml, job "publish"/);
});

test("a package.json script that publishes, run from another job, fails", () => {
  const r = check("publish-via-script");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /job "release", step 2: pnpm run release \(script "release" → "ship" publishes\)/);
});

test("changesets/action with a publish input outside the publish job fails", () => {
  const r = check("changesets-action-publish");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /job "version", step 2: changesets\/action with publish/);
});

test("a version pull request job, a dry run and a script merely named publish-* pass", () => {
  const r = check("version-pr-only");
  assert.equal(r.code, 0, r.out);
});

test("publish commands in other shapes are found too", () => {
  const r = check("publish-shapes");
  assert.equal(r.code, 1, r.out);
  for (const job of ["workspace-root", "workspace-root-script", "captured", "env-prefix", "recursive-exec", "yarn-foreach", "pinned-npm"]) {
    assert.match(r.out, new RegExp(`job "${job}", step 1`), job);
  }
});
