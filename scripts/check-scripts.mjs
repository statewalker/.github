#!/usr/bin/env node
// The required CI baseline, for a repository that opted in with the workflow's `baseline` input:
//   node check-scripts.mjs library   lint:check, format:check, build, typecheck, test
//   node check-scripts.mjs app       build, typecheck
// A missing root script fails, instead of being skipped by `pnpm run --if-present`. So does a root
// script that only delegates to the packages (`pnpm -r run typecheck`) when no package defines the
// script, and, for `typecheck`, any package with a tsconfig.json that does not define it.
//
// Tests are typechecked: every test file (`*.test.*` / `*.spec.*` in TypeScript) must be part of a
// tsconfig that a typecheck step compiles: the root `typecheck` or `typecheck:tests` script's `tsc`,
// or the package scripts they run with `pnpm -r`. `tsc -p <config>` (or the default tsconfig.json)
// names the config; `tsc --listFilesOnly` says which files it holds, following `references`.
// Run after the install: TypeScript is resolved from each config's directory.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { report, workspacePackages } from "./lib/workspace.mjs";

const REQUIRED = {
  library: ["lint:check", "format:check", "build", "typecheck", "test"],
  app: ["build", "typecheck"],
};

const kind = process.argv[2];
if (!(kind in REQUIRED)) {
  console.error(`usage: check-scripts.mjs <${Object.keys(REQUIRED).join("|")}>`);
  process.exit(2);
}

const root = process.cwd();
const rootScripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
const problems = [];

for (const name of REQUIRED[kind]) {
  if (!rootScripts[name]) problems.push(`root package.json has no "${name}" script (required for ${kind} projects)`);
}

// pnpm flags that take a value, so the value is not mistaken for the script name.
const VALUE_FLAGS = new Set(["--filter", "-F", "--workspace-concurrency", "--reporter", "-C", "--dir", "--sort"]);

/** The pnpm command of a recursive segment (`pnpm -r exec tsc` gives "exec"), or undefined. */
function recursiveCommand(tokens) {
  if (tokens[0] !== "pnpm" || !tokens.some((t) => t === "-r" || t === "--recursive")) return undefined;
  for (let i = 1; i < tokens.length; i++) {
    if (VALUE_FLAGS.has(tokens[i])) i++;
    else if (!tokens[i].startsWith("-")) return { command: tokens[i], at: i };
  }
  return undefined;
}

/**
 * The script names a root script runs in every package (`pnpm -r run <name>`, `pnpm -r <name>`).
 * `pnpm -r exec <bin>` and `pnpm -r dlx <bin>` run a binary, not a script.
 */
function delegatedScripts(script) {
  const names = [];
  for (const segment of script.split(/&&|\|\||;/)) {
    const tokens = segment.trim().split(/\s+/);
    const recursive = recursiveCommand(tokens);
    if (!recursive || recursive.command === "exec" || recursive.command === "dlx") continue;
    let name;
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (VALUE_FLAGS.has(t)) i++;
      else if (t.startsWith("-")) continue;
      else if (t === "run" || t === "run-script") continue;
      else {
        name = t;
        break;
      }
    }
    if (name) names.push(name);
  }
  return names;
}

const packages = workspacePackages(root).filter((p) => path.resolve(p.path) !== path.resolve(root));
for (const required of REQUIRED[kind]) {
  if (!rootScripts[required] || packages.length === 0) continue;
  for (const name of delegatedScripts(rootScripts[required])) {
    const defining = packages.filter((p) => p.manifest.scripts?.[name]);
    if (defining.length === 0) {
      problems.push(
        `root "${required}" runs "${name}" in every package, but no package defines it (${packages.map((p) => p.name).join(", ")}): it runs nothing`,
      );
    } else if (name === "typecheck") {
      for (const p of packages) {
        if (!p.manifest.scripts?.typecheck && fs.existsSync(path.join(p.path, "tsconfig.json"))) {
          problems.push(`${p.name} has a tsconfig.json but no "typecheck" script, so root "${required}" skips it`);
        }
      }
    }
  }
}

// --- Typechecked tests ---

const TSC = new Set(["tsc", "tsgo", "vue-tsc"]);

/**
 * The tsconfig files a script compiles with tsc, resolved against `dir`; for `pnpm -r exec tsc`,
 * against each package directory in `packageDirs` that has the config.
 */
function tsconfigsOf(script, dir, packageDirs = []) {
  const configs = [];
  for (const segment of script.split(/&&|\|\||;/)) {
    const tokens = segment.trim().split(/\s+/);
    const at = tokens.findIndex((t) => TSC.has(t));
    if (at < 0) continue;
    const recursive = recursiveCommand(tokens);
    const inEach = recursive?.command === "exec" && recursive.at < at;
    const named = [];
    for (let i = at + 1; i < tokens.length; i++) {
      if (tokens[i] === "-p" || tokens[i] === "--project") named.push(tokens[++i]);
      else if (tokens[i] === "-b" || tokens[i] === "--build") {
        while (tokens[i + 1] && !tokens[i + 1].startsWith("-")) named.push(tokens[++i]);
      }
    }
    const resolve = (base, c) => {
      const file = path.resolve(base, c);
      return fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, "tsconfig.json") : file;
    };
    for (const c of named.length > 0 ? named : ["tsconfig.json"]) {
      if (!inEach) configs.push(resolve(dir, c));
      else for (const d of packageDirs) if (fs.existsSync(resolve(d, c))) configs.push(resolve(d, c));
    }
  }
  return configs;
}

/**
 * Run TypeScript's own CLI, resolved from the config's directory, on one config. The package root
 * is found through `typescript/package.json`, which every version exports: TypeScript 7 does not
 * export the `typescript/bin/tsc` subpath.
 */
function tsc(config, args) {
  const pkg = createRequire(path.join(path.dirname(config), "noop.js")).resolve("typescript/package.json");
  const bin = path.join(path.dirname(pkg), "bin", "tsc");
  return execFileSync(process.execPath, [bin, "-p", config, ...args], { encoding: "utf8", stdio: "pipe" });
}

/** The real paths of every file a config compiles, its references' files included. */
function filesOf(config, seen = new Set()) {
  const files = new Set();
  if (seen.has(config)) return files;
  seen.add(config);
  if (!fs.existsSync(config)) {
    problems.push(`${path.relative(root, config)} does not exist (named by a typecheck script)`);
    return files;
  }
  let listed;
  let shown;
  try {
    listed = tsc(config, ["--listFilesOnly"]);
    shown = JSON.parse(tsc(config, ["--showConfig"]));
  } catch (err) {
    const detail = err.code === "MODULE_NOT_FOUND" ? "typescript is not installed there" : String(err.stdout || err.stderr || err).split("\n")[0];
    problems.push(`cannot list the files of ${path.relative(root, config)}: ${detail}`);
    return files;
  }
  for (const line of listed.split("\n")) {
    if (line.trim() && fs.existsSync(line.trim())) files.add(fs.realpathSync(line.trim()));
  }
  for (const ref of shown.references ?? []) {
    let target = path.resolve(path.dirname(config), ref.path);
    if (!target.endsWith(".json")) target = path.join(target, "tsconfig.json");
    for (const f of filesOf(target, seen)) files.add(f);
  }
  return files;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".turbo"]);
const TEST_FILE = /\.(test|spec)\.(c|m)?tsx?$/;

/** TypeScript test files under `dir`, without descending into other packages or build output. */
function testFiles(dir, packageDirs, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !packageDirs.has(full)) testFiles(full, packageDirs, out);
    } else if (TEST_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

// The root too: a monorepo's own tests (a root tests/) must be typechecked like the packages'.
const owners = [{ path: root }, ...packages];
const configs = new Set();
for (const rootName of ["typecheck", "typecheck:tests"]) {
  const script = rootScripts[rootName];
  if (!script) continue;
  for (const c of tsconfigsOf(script, root, packages.map((p) => p.path))) configs.add(c);
  for (const name of delegatedScripts(script)) {
    for (const p of packages) {
      const own = p.manifest.scripts?.[name];
      if (own) for (const c of tsconfigsOf(own, p.path)) configs.add(c);
    }
  }
}
const typechecked = new Set();
for (const c of configs) for (const f of filesOf(c)) typechecked.add(f);

const packageDirs = new Set(packages.map((p) => path.resolve(p.path)));
let tests = 0;
for (const owner of owners) {
  for (const file of testFiles(path.resolve(owner.path), packageDirs)) {
    tests++;
    if (!typechecked.has(fs.realpathSync(file))) {
      problems.push(
        `${path.relative(root, file)} is not typechecked: include it in the tsconfig the "typecheck" script compiles, or add a "typecheck:tests" script`,
      );
    }
  }
}

report(`required scripts and typechecked tests (${kind}, ${tests} test file${tests === 1 ? "" : "s"})`, problems);
