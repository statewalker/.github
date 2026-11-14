import assert from "node:assert/strict";
import { test } from "node:test";
import { runCheck } from "./helpers.mjs";

const check = (fixture, args = []) => runCheck("check-package-tools.mjs", `package-tools/${fixture}`, args);

test("a well-packaged package passes publint and attw", () => {
  const r = check("clean");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 public package/);
});

test("a packaging defect publint reports fails, naming the package", () => {
  const r = check("publint-defect");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /@fixture\/a: publint/);
  assert.match(r.out, /types should be the first/);
});

test("types attw cannot resolve correctly fail, naming the package", () => {
  const r = check("attw-defect");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /@fixture\/a: attw/);
  assert.match(r.out, /Masquerading as CJS/);
});

test("the attw profile is a parameter: strict also counts the CommonJS resolutions", () => {
  const r = check("clean", ["--attw-profile", "strict"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /@fixture\/a: attw/);
});
