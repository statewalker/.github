import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot, runCheck } from "./helpers.mjs";

// Each fixture holds the npm copy of its package in published/<name>/, given with --published.
const check = (fixture) => runCheck("check-api-diff.mjs", `api-diff/${fixture}`, ["--published", "published"]);

const passes = (fixture, pattern) => {
  const r = check(fixture);
  assert.equal(r.code, 0, r.out);
  if (pattern) assert.match(r.out, pattern);
  return r;
};
const fails = (fixture, ...patterns) => {
  const r = check(fixture);
  assert.equal(r.code, 1, r.out);
  for (const p of patterns) assert.match(r.out, p);
  return r;
};

test("an unchanged API passes", () => passes("unchanged"));

test("additions need no bump", () => passes("additive", /@fixture\/a: added .*three/));

test("a removed export without a bump fails, naming the export and the bump it needs", () =>
  fails("removed-export", /@fixture\/a: removed export "two" from "\."/, /needs a major bump/, /declares none/));

test("the same removal with a major changeset passes", () => passes("removed-export-major-changeset"));

test("a minor changeset is not enough for a breaking change from 1.0", () =>
  fails("removed-export-minor-changeset", /needs a major bump/, /declares minor/));

test("the same removal with the major version already bumped passes", () => passes("removed-export-version-bumped"));

test("below 1.0 a minor bump is enough for a breaking change", () => passes("zero-major-minor-changeset"));

test("a removed entry point fails", () => fails("removed-subpath", /removed entry point "\.\/extra"/));

test("a removed member of an exported interface fails", () => fails("removed-member", /removed member "Options\.b"/));

test("a package not on npm yet is skipped", () => passes("unpublished", /@fixture\/a: not on npm yet/));

test("renaming a private class member is not a breaking change", () => passes("private-member-renamed"));

test("a removed static member of an exported class fails", () =>
  fails("removed-static-member", /removed member "Foo\.static create"/));

test("an export turned type-only (`export type { Foo }`) is no longer a value and fails", () =>
  fails("value-to-type-only", /export "Foo" of "\." is no longer a value/));

// --- npm itself, right after a release (statewalker/statewalker-root#61) ---
// npm names a just-published version `latest` minutes before it serves its tarball. These run the
// script against a fake npm (tests/fake-npm/npm) whose registry has @fixture/a 1.0.0, without the
// export "three", and 1.1.0, with it, as the workspace has it: a diff against 1.1.0 reports
// nothing added, a diff against 1.0.0 reports "three" added.

const additive = path.join(repoRoot, "fixtures", "api-diff", "additive");
const OLD = path.join(additive, "published", "@fixture", "a");
const NEW = path.join(additive, "packages", "a");

/** Run the script with npm faked from `entry` (the registry's @fixture/a); its output and npm's pack log. */
function againstNpm(t, entry, fixture = "api-diff/additive") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-diff-npm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, "registry.json");
  fs.writeFileSync(state, JSON.stringify({ "@fixture/a": entry }));
  const r = runCheck("check-api-diff.mjs", fixture, [], {
    FAKE_NPM: state,
    PATH: `${path.join(repoRoot, "tests", "fake-npm")}${path.delimiter}${process.env.PATH}`,
    API_DIFF_NPM_RETRY_SECONDS: "0",
  });
  const log = fs.existsSync(`${state}.log`) ? fs.readFileSync(`${state}.log`, "utf8").trim().split("\n") : [];
  return { ...r, packs: log };
}

test("a just-published latest whose tarball turns up while retrying is the one compared", (t) => {
  const r = againstNpm(t, { latest: "1.1.0", versions: { "1.0.0": OLD, "1.1.0": NEW }, missing: { "1.1.0": 2 } });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /added .*three/);
  assert.deepEqual(r.packs, ["@fixture/a@1.1.0", "@fixture/a@1.1.0", "@fixture/a@1.1.0"]);
});

test("a just-published latest whose tarball never turns up: the previous version is compared, and the log says so", (t) => {
  const r = againstNpm(t, { latest: "1.1.0", versions: { "1.0.0": OLD, "1.1.0": NEW }, missing: { "1.1.0": -1 } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /@fixture\/a: npm does not serve 1\.1\.0 yet .*comparing with 1\.0\.0/);
  assert.match(r.out, /@fixture\/a: added .*three/);
  assert.deepEqual(r.packs.at(-1), "@fixture/a@1.0.0");
});

test("a first version whose tarball never turns up counts as not on npm yet", (t) => {
  const r = againstNpm(t, { latest: "1.1.0", versions: { "1.1.0": NEW }, missing: { "1.1.0": -1 } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /@fixture\/a: not on npm yet/);
});

test("an npm failure other than a 404 still fails the check", (t) => {
  const r = againstNpm(t, { latest: "1.1.0", versions: { "1.0.0": OLD, "1.1.0": NEW }, error: { "1.1.0": "EACCES" } });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /EACCES/);
  assert.deepEqual(r.packs, ["@fixture/a@1.1.0"]);
});

test("after a breaking release npm does not serve yet, a pull request's own breaking change still needs a bump from that release", (t) => {
  // npm lists 1.0.0 (a major over 0.9.0) but does not serve it yet; the workspace is at 1.0.0 and
  // removes the export "two" with no changeset. Measured from 0.9.0 the version alone would look
  // like the major bump the removal needs; measured from npm's latest, it declares none.
  const removed = path.join(repoRoot, "fixtures", "api-diff", "removed-export");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-diff-prev-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = path.join(dir, "a");
  fs.cpSync(path.join(removed, "published", "@fixture", "a"), previous, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(previous, "package.json"), "utf8"));
  fs.writeFileSync(path.join(previous, "package.json"), JSON.stringify({ ...manifest, version: "0.9.0" }));
  const r = againstNpm(
    t,
    { latest: "1.0.0", versions: { "0.9.0": previous, "1.0.0": path.join(removed, "packages", "a") }, missing: { "1.0.0": -1 } },
    "api-diff/removed-export",
  );
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /removed export "two"/);
  assert.match(r.out, /needs a major bump/);
  assert.match(r.out, /npm does not serve 1\.0\.0 yet/);
});

test("a member keyed by a unique symbol is the same member in both programs", () =>
  passes("unique-symbol-member"));

test("a symbol-keyed member replaced by a string key of the same spelling fails", () =>
  fails("symbol-key-to-string-key", /removed member "Options\.\[tag\]"/));
