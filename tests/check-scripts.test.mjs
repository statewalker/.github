import assert from "node:assert/strict";
import { test } from "node:test";
import { runCheck } from "./helpers.mjs";

const check = (fixture, kind) => runCheck("check-scripts.mjs", `check-scripts/${fixture}`, [kind]);

test("a clean library passes", () => {
  const r = check("clean-library", "library");
  assert.equal(r.code, 0, r.out);
});

test("a library missing a required root script fails, naming it", () => {
  const r = check("missing-lint", "library");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /"lint:check"/);
});

test("an app needs only build and typecheck", () => {
  assert.equal(check("app", "app").code, 0);
  const asLibrary = check("app", "library");
  assert.equal(asLibrary.code, 1, asLibrary.out);
  for (const s of ["lint:check", "format:check", "test"]) assert.match(asLibrary.out, new RegExp(`"${s}"`));
});

test("an unknown project kind is a usage error", () => {
  assert.equal(check("app", "service").code, 2);
});

test("a root script delegating to packages that do not define it fails", () => {
  const r = check("typecheck-runs-nothing", "library");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /"typecheck"/);
  assert.match(r.out, /@fixture\/a/);
});

test("a TypeScript package without a typecheck script fails, even when another package has one", () => {
  const r = check("package-without-typecheck", "library");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /@fixture\/b has a tsconfig\.json but no "typecheck" script/);
  assert.doesNotMatch(r.out, /@fixture\/a/);
});

test("tests outside every typechecked tsconfig fail, naming the file", () => {
  const r = check("untypechecked-tests", "library");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /packages\/a\/test\/index\.test\.ts is not typechecked/);
});

test("tests typechecked by a typecheck:tests script pass", () => {
  const r = check("typecheck-tests-script", "library");
  assert.equal(r.code, 0, r.out);
});

test("a single-package app whose tsconfig includes its tests passes", () => {
  const r = check("app", "app");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 test file/);
});
