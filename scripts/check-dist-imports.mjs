#!/usr/bin/env node
// What a consumer installs must be enough to load the built package: every bare import in a
// public package's dist (.js / .mjs / .cjs / .d.ts) is a declared dependency, peer or optional
// dependency (or a Node built-in), and nothing was bundled into dist/node_modules -- a sign the
// bundler inlined an undeclared package. Run after the build.
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { publicPackages, report } from "./lib/workspace.mjs";

const BUILTIN = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"'./][^"']*)["']/g;
const PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(m?js|cjs|d\.m?ts)$/.test(entry.name)) yield full;
  }
}

const problems = [];
const pkgs = publicPackages();
for (const pkg of pkgs) {
  const dist = path.join(pkg.path, "dist");
  if (!fs.existsSync(dist)) continue;
  if (fs.existsSync(path.join(dist, "node_modules"))) {
    problems.push(`${pkg.name}: dist/node_modules exists (the bundler inlined undeclared packages)`);
  }
  const m = pkg.manifest;
  const declared = new Set(
    ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((f) => Object.keys(m[f] ?? {})),
  );
  const missing = new Map();
  for (const file of files(dist)) {
    for (const [, spec] of stripComments(fs.readFileSync(file, "utf8")).matchAll(IMPORT)) {
      if (spec.startsWith("node:") || spec.startsWith("#") || spec.includes("://")) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!PACKAGE_NAME.test(name) || BUILTIN.has(name) || name === m.name) continue;
      if (declared.has(name) || declared.has(`@types/${name}`)) continue;
      if (!missing.has(name)) missing.set(name, path.relative(pkg.path, file));
    }
  }
  for (const [name, where] of missing) {
    const dev = name in (m.devDependencies ?? {}) ? "only a devDependency" : "not declared";
    problems.push(`${pkg.name}: imports ${name} (${dev}) in ${where}`);
  }
}
report(`dist imports (${pkgs.length} public packages)`, problems);
