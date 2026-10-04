#!/usr/bin/env node
// Every file a public package points at -- `exports` targets, `main`, `module`, `types`, `bin` --
// exists. Run after the build: dist targets are build outputs.
import fs from "node:fs";
import path from "node:path";
import { publicPackages, report } from "./lib/workspace.mjs";

const targets = (value) =>
  typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(targets) : [];
const problems = [];
const pkgs = publicPackages();
for (const pkg of pkgs) {
  const m = pkg.manifest;
  const all = [...targets(m.exports), m.main, m.module, m.types, m.typings, ...targets(m.bin)].filter(
    (t) => typeof t === "string" && !t.includes("*"),
  );
  for (const t of new Set(all)) {
    if (!fs.existsSync(path.join(pkg.path, t))) problems.push(`${pkg.name}: ${t} does not exist`);
  }
}
report(`exports (${pkgs.length} public packages)`, problems);
