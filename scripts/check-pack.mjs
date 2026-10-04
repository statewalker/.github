#!/usr/bin/env node
// Pack every public package the way `pnpm publish` would, and check the packed package.json:
// no `workspace:`, `catalog:`, `link:` or `file:` specifier may survive (a consumer could not
// install it). Run after the build.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEPENDENCY_FIELDS, publicPackages, report } from "./lib/workspace.mjs";

const out = fs.mkdtempSync(path.join(os.tmpdir(), "statewalker-pack-"));
const problems = [];
const pkgs = publicPackages();
try {
  for (const pkg of pkgs) {
    let tarball;
    try {
      const before = new Set(fs.readdirSync(out));
      execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: pkg.path, stdio: "pipe" });
      tarball = fs.readdirSync(out).find((f) => !before.has(f) && f.endsWith(".tgz"));
    } catch (err) {
      problems.push(`${pkg.name}: pnpm pack failed: ${String(err.stderr ?? err).split("\n")[0]}`);
      continue;
    }
    if (!tarball) {
      problems.push(`${pkg.name}: pnpm pack produced no tarball`);
      continue;
    }
    const manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", path.join(out, tarball), "package/package.json"], { encoding: "utf8" }),
    );
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
        if (/^(workspace|catalog|link|file):/.test(spec)) {
          problems.push(`${pkg.name}: packed ${field}.${dep} = "${spec}"`);
        }
      }
    }
  }
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
report(`packed manifests (${pkgs.length} public packages)`, problems);
