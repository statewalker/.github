import assert from "node:assert/strict";
import { test } from "node:test";
import { runCheck } from "./helpers.mjs";

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
