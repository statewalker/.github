import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { repoRoot, runCheck } from "./helpers.mjs";

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

test("a root `pnpm -r exec tsc` typechecks each package with its own tsconfig", () => {
  const r = check("recursive-exec-tsc", "library");
  assert.equal(r.code, 0, r.out);
});

test("test files at a monorepo's root, outside the packages, must be typechecked too", () => {
  const r = check("root-tests", "library");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /tests\/root\.test\.ts is not typechecked/);
  assert.doesNotMatch(r.out, /packages\/a/);
});

test("TypeScript 5's tsc is found and lists the files (the repository's own typescript 5)", () => {
  const ts5 = JSON.parse(fs.readFileSync(path.join(repoRoot, "node_modules", "typescript", "package.json"), "utf8"));
  assert.match(ts5.version, /^5\./);
  const r = check("clean-library", "library");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 test file/);
});

test("TypeScript 7's tsc is found though the package does not export typescript/bin/tsc", (t) => {
  // TypeScript 7 exports only "./package.json" and its API entries, so resolving
  // "typescript/bin/tsc" fails with ERR_PACKAGE_PATH_NOT_EXPORTED (statewalker/statewalker-root#50).
  // The fixture gets the real typescript@7, installed here as the "typescript-7" alias, as its
  // own node_modules/typescript, which shadows the repository's typescript 5.
  const ts7 = fs.realpathSync(path.join(repoRoot, "node_modules", "typescript-7"));
  assert.match(JSON.parse(fs.readFileSync(path.join(ts7, "package.json"), "utf8")).version, /^7\./);
  const modules = path.join(repoRoot, "fixtures", "check-scripts", "typescript-7", "node_modules");
  fs.rmSync(modules, { recursive: true, force: true });
  fs.mkdirSync(modules);
  t.after(() => fs.rmSync(modules, { recursive: true, force: true }));
  fs.symlinkSync(ts7, path.join(modules, "typescript"), "junction");

  const r = check("typescript-7", "library");
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /ERR_PACKAGE_PATH_NOT_EXPORTED|cannot list the files/);
  assert.match(r.out, /1 test file/);
});
