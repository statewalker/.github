#!/usr/bin/env node
// The statewalker dependency-reference convention, checked for every workspace package:
//   - a package of this workspace is referenced as `workspace:^` (linked locally, published as a
//     `^<version>` range);
//   - any other package through the catalog: `catalog:` (or a named catalog such as `catalog:ts5`)
//     in dependencies / devDependencies / optionalDependencies, `catalog:peers` in peerDependencies;
//   - every `catalog:` reference has an entry in its catalog;
//   - nothing reaches outside the repository (`link:`, `file:`, or `workspace:` to a package that
//     is not in this workspace).
import { DEPENDENCY_FIELDS, readCatalogs, report, workspacePackages } from "./lib/workspace.mjs";

const pkgs = workspacePackages();
const local = new Set(pkgs.map((p) => p.name));
const catalogs = readCatalogs();
const problems = [];

for (const pkg of pkgs) {
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dep, spec] of Object.entries(pkg.manifest[field] ?? {})) {
      const where = `${pkg.name} ${field}.${dep} = "${spec}"`;
      if (local.has(dep)) {
        if (spec !== "workspace:^") problems.push(`${where}: a workspace package is referenced as "workspace:^"`);
        continue;
      }
      if (/^(workspace|link|file):/.test(spec)) {
        problems.push(`${where}: reaches outside the repository; use the catalog`);
        continue;
      }
      if (!spec.startsWith("catalog:")) {
        problems.push(
          `${where}: external dependencies go through the catalog ("${field === "peerDependencies" ? "catalog:peers" : "catalog:"}")`,
        );
        continue;
      }
      const name = spec.slice("catalog:".length);
      if (field === "peerDependencies" && name !== "peers") {
        problems.push(`${where}: peer dependencies use "catalog:peers"`);
        continue;
      }
      if (!(catalogs[name] && dep in catalogs[name])) {
        problems.push(`${where}: no entry for ${dep} in catalog "${name || "default"}" (pnpm-workspace.yaml)`);
      }
    }
  }
}
report(`conventions (${pkgs.length} packages)`, problems);
