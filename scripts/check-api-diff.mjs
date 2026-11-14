#!/usr/bin/env node
// The public API of every public package, compared with the version on npm (`latest`). A breaking
// change fails unless the pull request declares the bump it needs: a major from 1.0, a minor on
// 0.x, a patch on 0.0.x (what a caret range lets through). The bump is declared by a changeset in
// .changeset/ (`"<name>": major`) or by the package.json version already being past npm's.
//
// The API is read from the packed packages' type declarations, through the entry points of their
// `exports` (resolved like a bundler-mode TypeScript consumer). Breaking: an entry point removed,
// an export removed from one, an export that stops being a value or a type, a member removed from
// an exported class, interface or enum. Changed signatures are not compared.
//
//   node check-api-diff.mjs                     fetch the published packages from npm
//   node check-api-diff.mjs --published <dir>   take them from <dir>/<name>/ instead
//
// Run after the build. TypeScript is this repository's own dependency: install it first with
// `pnpm install --frozen-lockfile` in this repository.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { publicPackages, report } from "./lib/workspace.mjs";

const { values } = parseArgs({ options: { published: { type: "string" } } });
const here = path.dirname(fileURLToPath(import.meta.url));
const ts = createRequire(path.join(here, "..", "package.json"))("typescript");

const root = process.cwd();
const LEVELS = ["none", "patch", "minor", "major"];

// --- Versions and bumps ---

const parse = (v) => v.split("-")[0].split(".").map(Number);

/** The bump from one version to another: none, patch, minor or major. */
function bumpBetween(from, to) {
  const [a, b] = [parse(from), parse(to)];
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return LEVELS[3 - i];
    if (b[i] < a[i]) return "none";
  }
  return "none";
}

/** The bump a breaking change needs from `version`, for caret ranges to keep it out. */
function breakingBump(version) {
  const [major, minor] = parse(version);
  return major > 0 ? "major" : minor > 0 ? "minor" : "patch";
}

/** The highest bump each package's pending changesets declare: { name: level }. */
function changesetBumps() {
  const dir = path.join(root, ".changeset");
  const bumps = {};
  if (!fs.existsSync(dir)) return bumps;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const line of front?.[1].split(/\r?\n/) ?? []) {
      const m = /^\s*(["']?)(.+?)\1\s*:\s*(major|minor|patch)\s*$/.exec(line);
      if (m && LEVELS.indexOf(m[3]) > LEVELS.indexOf(bumps[m[2]] ?? "none")) bumps[m[2]] = m[3];
    }
  }
  return bumps;
}

// --- Packages on disk ---

/** Unpack a tarball's `package/` into `dest`. */
function unpack(tarball, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", dest, "--strip-components", "1"]);
}

/** Pack a workspace package as `pnpm publish` would, into `dest`. */
function packLocal(pkg, dest, work) {
  const out = fs.mkdtempSync(path.join(work, "pack-"));
  execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: pkg.path, stdio: "pipe" });
  unpack(path.join(out, fs.readdirSync(out).find((f) => f.endsWith(".tgz"))), dest);
}

/** Put npm's `latest` of a package into `dest`; its version, or undefined when it is not on npm. */
function fetchPublished(name, dest, work) {
  if (values.published) {
    const dir = path.resolve(root, values.published, name);
    if (!fs.existsSync(path.join(dir, "package.json"))) return undefined;
    fs.cpSync(dir, dest, { recursive: true });
  } else {
    let version;
    try {
      version = JSON.parse(execFileSync("npm", ["view", `${name}@latest`, "version", "--json"], { encoding: "utf8", stdio: "pipe" }));
    } catch (err) {
      if (/E404|404 Not Found/.test(String(err.stderr ?? err))) return undefined;
      throw err;
    }
    const out = fs.mkdtempSync(path.join(work, "npm-"));
    execFileSync("npm", ["pack", `${name}@${version}`, "--pack-destination", out], { stdio: "pipe" });
    unpack(path.join(out, fs.readdirSync(out).find((f) => f.endsWith(".tgz"))), dest);
  }
  return JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8")).version;
}

// --- The API surface ---

/** The entry points of a manifest: "." and the explicit subpaths of `exports`. */
function entryPoints(manifest) {
  const exp = manifest.exports;
  if (exp === undefined || typeof exp === "string" || Array.isArray(exp)) return ["."];
  const keys = Object.keys(exp);
  if (!keys.some((k) => k.startsWith("."))) return ["."];
  return keys.filter((k) => !k.includes("*") && k !== "./package.json" && exp[k] !== null);
}

const OPTIONS = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  skipLibCheck: true,
  noEmit: true,
};

/**
 * The API of the package installed at `<consumer>/node_modules/<name>`:
 * Map(entry point -> Map(export -> { value, type, members: Set }) | null when it has no types).
 */
function surface(consumer, name) {
  const manifest = JSON.parse(fs.readFileSync(path.join(consumer, "node_modules", name, "package.json"), "utf8"));
  const from = path.join(consumer, "index.ts");
  const files = new Map();
  for (const entry of entryPoints(manifest)) {
    const spec = entry === "." ? name : `${name}${entry.slice(1)}`;
    const resolved = ts.resolveModuleName(spec, from, OPTIONS, ts.sys).resolvedModule;
    files.set(entry, resolved?.resolvedFileName);
  }
  const program = ts.createProgram([...files.values()].filter(Boolean), OPTIONS);
  const checker = program.getTypeChecker();
  const api = new Map();
  for (const [entry, file] of files) {
    if (!file) {
      api.set(entry, null);
      continue;
    }
    const exports = new Map();
    const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(file));
    for (const sym of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
      const members = new Set();
      if (target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) {
        for (const p of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(target))) members.add(p.name);
      }
      if (target.flags & ts.SymbolFlags.Class) {
        for (const p of checker.getPropertiesOfType(checker.getTypeOfSymbol(target))) {
          if (p.name !== "prototype") members.add(`static ${p.name}`);
        }
      }
      if (target.flags & ts.SymbolFlags.Enum) for (const key of target.exports?.keys() ?? []) members.add(String(key));
      exports.set(sym.name, {
        value: Boolean(target.flags & ts.SymbolFlags.Value),
        type: Boolean(target.flags & ts.SymbolFlags.Type),
        members,
      });
    }
    api.set(entry, exports);
  }
  return api;
}

/** Breaking changes and additions from the published API to the local one. */
function diff(before, after) {
  const breaking = [];
  const added = [];
  for (const [entry, exports] of before) {
    if (!after.has(entry)) {
      breaking.push(`removed entry point "${entry}"`);
      continue;
    }
    const now = after.get(entry);
    if (exports === null) continue;
    if (now === null) {
      breaking.push(`entry point "${entry}" no longer resolves to type declarations`);
      continue;
    }
    for (const [name, was] of exports) {
      const is = now.get(name);
      if (!is) {
        breaking.push(`removed export "${name}" from "${entry}"`);
        continue;
      }
      if (was.value && !is.value) breaking.push(`export "${name}" of "${entry}" is no longer a value`);
      if (was.type && !is.type) breaking.push(`export "${name}" of "${entry}" is no longer a type`);
      for (const m of was.members) if (!is.members.has(m)) breaking.push(`removed member "${name}.${m}" from "${entry}"`);
      for (const m of is.members) if (!was.members.has(m)) added.push(`member "${name}.${m}" to "${entry}"`);
    }
    for (const name of now.keys()) if (!exports.has(name)) added.push(`export "${name}" to "${entry}"`);
  }
  for (const entry of after.keys()) if (!before.has(entry)) added.push(`entry point "${entry}"`);
  return { breaking, added };
}

// --- Main ---

const work = fs.mkdtempSync(path.join(os.tmpdir(), "statewalker-api-diff-"));
const problems = [];
const pkgs = publicPackages();
const declared = changesetBumps();
try {
  for (const [i, pkg] of pkgs.entries()) {
    const published = path.join(work, `${i}-published`);
    const local = path.join(work, `${i}-local`);
    const npmVersion = fetchPublished(pkg.name, path.join(published, "node_modules", pkg.name), work);
    if (!npmVersion) {
      console.log(`${pkg.name}: not on npm yet, nothing to compare`);
      continue;
    }
    packLocal(pkg, path.join(local, "node_modules", pkg.name), work);
    const { breaking, added } = diff(surface(published, pkg.name), surface(local, pkg.name));
    for (const a of added) console.log(`${pkg.name}: added ${a}`);
    if (breaking.length === 0) continue;
    const needs = breakingBump(npmVersion);
    const byVersion = bumpBetween(npmVersion, pkg.version);
    const byChangeset = declared[pkg.name] ?? "none";
    const has = LEVELS.indexOf(byVersion) >= LEVELS.indexOf(byChangeset) ? byVersion : byChangeset;
    for (const b of breaking) console.log(`${pkg.name}: ${b}`);
    if (LEVELS.indexOf(has) < LEVELS.indexOf(needs)) {
      problems.push(
        `${pkg.name}: ${breaking.length} breaking change(s) against ${npmVersion} on npm (${breaking.join("; ")}); ` +
          `it needs a ${needs} bump but declares ${has} (version ${pkg.version}, changeset ${byChangeset}). ` +
          `Add a changeset ("${pkg.name}": ${needs}) or restore the API.`,
      );
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
report(`API diff against npm (${pkgs.length} public package${pkgs.length === 1 ? "" : "s"})`, problems);
