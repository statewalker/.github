// Workspace helpers for the statewalker CI checks. No dependencies: Node built-ins and pnpm only.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The workspace's packages, as pnpm sees them: [{ name, version, path, private, manifest }].
 * The root package is included only when it is the sole package (a single-package repository).
 */
export function workspacePackages(root = process.cwd()) {
  const out = execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const listed = JSON.parse(out);
  const rootPath = path.resolve(root);
  const pkgs = listed
    .map((p) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(p.path, "package.json"), "utf8"));
      return { name: manifest.name, version: manifest.version, path: p.path, private: manifest.private === true, manifest };
    })
    .filter((p) => p.name);
  const members = pkgs.filter((p) => path.resolve(p.path) !== rootPath);
  return members.length > 0 ? members : pkgs;
}

/** Public packages (not `private: true`). */
export const publicPackages = (root) => workspacePackages(root).filter((p) => !p.private);

/**
 * The catalogs of pnpm-workspace.yaml: { "": {default catalog}, peers: {...}, <name>: {...} }.
 * A small reader for the flat maps pnpm uses (`catalog:` and `catalogs: <name>:`), not general YAML.
 */
export function readCatalogs(root = process.cwd()) {
  const file = path.join(root, "pnpm-workspace.yaml");
  const catalogs = { "": {} };
  if (!fs.existsSync(file)) return catalogs;
  const unquote = (s) => s.trim().replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
  let section = null;
  let named = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const top = /^([^\s#][^:]*):\s*(#.*)?$/.exec(line) ?? /^([^\s#][^:]*):/.exec(line);
    if (top && !line.startsWith(" ")) {
      section = top[1].trim();
      named = null;
      continue;
    }
    if (section === "catalogs") {
      const head = /^ {2}(["']?)([^"':#]+)\1:\s*(#.*)?$/.exec(line);
      if (head) {
        named = head[2].trim();
        catalogs[named] ??= {};
        continue;
      }
    }
    const entry = /^(\s+)(["']?)([^"'\s:#][^"':#]*?)\2\s*:\s*(.+)$/.exec(line);
    if (!entry) continue;
    if (section === "catalog" && entry[1].length === 2) catalogs[""][entry[3]] = unquote(entry[4]);
    else if (section === "catalogs" && named && entry[1].length === 4) catalogs[named][entry[3]] = unquote(entry[4]);
  }
  return catalogs;
}

export const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** Print problems and exit non-zero when there are any. */
export function report(title, problems) {
  if (problems.length === 0) {
    console.log(`${title}: ok`);
    return;
  }
  console.error(`${title}: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exitCode = 1;
}
