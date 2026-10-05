#!/usr/bin/env node
// Write the changesets a release needs and nobody wrote by hand. Run after the build, before
// `changeset version`.
//
// Every public package is packed the way `pnpm publish` would pack it and compared with the
// version npm calls `latest`:
//   - files: any packed file other than package.json and CHANGELOG.md that differs, appears or
//     disappears (sources, dist, README, ...)                                  -> patch
//   - the published manifest: runtime, peer or optional dependencies added, removed or with
//     another range, or another `exports` map                                  -> patch
//   - one of those dependencies moved to another breaking line (0.3 -> 0.4, 1.x -> 2.x)
//                                                                              -> minor on 0.x, major from 1.0
// devDependencies are not compared: they do not reach consumers.
//
// Packages with a pending changeset (written by hand) keep it. Packages whose version is not on
// npm yet are skipped: `changeset publish` publishes them as they are. Finally, a package that
// depends (runtime or peer, `workspace:`) on a sibling crossing a breaking line crosses one
// itself: it gets the same bump, so its consumers see it.
//
// Writes .changeset/auto-<package>.md files and prints the plan. `--dry-run` only prints.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publicPackages, readCatalogs, workspacePackages } from "./lib/workspace.mjs";

const dryRun = process.argv.includes("--dry-run");
const registry = (process.env.NPM_REGISTRY ?? "https://registry.npmjs.org").replace(/\/$/, "");
const RUNTIME_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];
const BUMPS = ["patch", "minor", "major"];

/** "1.2.3" -> [1, 2, 3]; the lowest version a simple range (^ ~ >= = x.y.z) admits, else null. */
function minVersion(range) {
  const m = /^\s*(?:\^|~|>=|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(String(range));
  if (!m) return null;
  return [Number(m[1]), Number.parseInt(m[2], 10) || 0, Number.parseInt(m[3], 10) || 0];
}

/** The breaking line of a range: "2" for ^2.1.0, "0.4" for ^0.4.1, the range itself otherwise. */
function line(range) {
  const v = minVersion(range);
  return v ? (v[0] > 0 ? `${v[0]}` : `0.${v[1]}`) : String(range);
}

/** The bump that crosses a breaking line for a package at `version`: minor on 0.x, major after. */
const breaking = (version) => ((minVersion(version)?.[0] ?? 0) === 0 ? "minor" : "major");
const max = (a, b) => (BUMPS.indexOf(a) >= BUMPS.indexOf(b) ? a : b);

/** Canonical JSON (sorted keys): the registry stores manifests with their keys sorted. */
const canonical = (v) =>
  JSON.stringify(v ?? null, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );

/** { "path/in/package": sha256 } of a tarball, without package.json and CHANGELOG.md. */
function tarballFiles(tgz, dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["-xzf", tgz, "-C", dir]);
  const root = path.join(dir, "package");
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = path.relative(root, p);
        if (rel === "package.json" || rel === "CHANGELOG.md") continue;
        files[rel] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      }
    }
  };
  walk(root);
  return files;
}

/** Pack a package (pnpm: workspace:/catalog: resolved) or fetch it from npm; returns the .tgz path. */
function pack(args, cwd, dest) {
  const before = new Set(fs.readdirSync(dest));
  execFileSync(args[0], args.slice(1), { cwd, stdio: "pipe" });
  const tgz = fs.readdirSync(dest).find((f) => !before.has(f) && f.endsWith(".tgz"));
  if (!tgz) throw new Error(`${args.join(" ")} produced no tarball`);
  return path.join(dest, tgz);
}

/** Packages named in pending changesets: { name: bump }. */
function pendingChangesets(root) {
  const dir = path.join(root, ".changeset");
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const head = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const l of head?.[1].split("\n") ?? []) {
      const m = /^\s*["']?([^"':]+)["']?\s*:\s*(patch|minor|major)\s*$/.exec(l);
      if (m) out[m[1]] = max(out[m[1]] ?? "patch", m[2]);
    }
  }
  return out;
}

const root = process.cwd();
const all = workspacePackages(root);
const versions = Object.fromEntries(all.map((p) => [p.name, p.version]));
const catalogs = readCatalogs(root);
const pending = pendingChangesets(root);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "statewalker-release-"));

/** The specifier pnpm writes into the published manifest. */
function published(name, spec) {
  if (spec.startsWith("workspace:")) {
    const r = spec.slice("workspace:".length);
    return r === "*" ? versions[name] : r === "^" || r === "~" ? `${r}${versions[name]}` : r;
  }
  if (spec.startsWith("catalog:")) return catalogs[spec.slice("catalog:".length)]?.[name] ?? spec;
  return spec;
}

const plan = new Map(); // name -> { bump, reasons: [] }
const add = (name, bump, reason) => {
  const p = plan.get(name) ?? { bump, reasons: [] };
  p.bump = max(p.bump, bump);
  p.reasons.push(reason);
  plan.set(name, p);
};

try {
  for (const pkg of publicPackages(root)) {
    const res = await fetch(`${registry}/${pkg.name.replace("/", "%2f")}`);
    if (res.status === 404) {
      console.log(`${pkg.name}@${pkg.version}: not on npm yet, published as it is`);
      continue;
    }
    if (!res.ok) throw new Error(`${pkg.name}: registry answered ${res.status}`);
    const doc = await res.json();
    if (doc.versions?.[pkg.version]) {
      if (doc["dist-tags"]?.latest !== pkg.version) {
        console.log(`${pkg.name}@${pkg.version}: on npm, but latest is ${doc["dist-tags"]?.latest}; skipped`);
        continue;
      }
    } else {
      console.log(`${pkg.name}@${pkg.version}: version not on npm yet, published as it is`);
      continue;
    }
    if (pending[pkg.name]) {
      console.log(`${pkg.name}: pending changeset (${pending[pkg.name]})`);
      continue;
    }
    const latest = doc.versions[pkg.version];

    // Manifest: runtime dependency ranges and exports.
    const now = {};
    const before = {};
    for (const f of RUNTIME_FIELDS) {
      for (const [n, s] of Object.entries(pkg.manifest[f] ?? {})) now[`${f}:${n}`] = published(n, s);
      for (const [n, s] of Object.entries(latest[f] ?? {})) before[`${f}:${n}`] = s;
    }
    for (const key of new Set([...Object.keys(now), ...Object.keys(before)])) {
      const [field, dep] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      const a = before[key];
      const b = now[key];
      if (a === b) continue;
      const label = `${dep}${field === "peerDependencies" ? " (peer)" : field === "optionalDependencies" ? " (optional)" : ""}`;
      if (a && b && line(a) !== line(b)) add(pkg.name, breaking(pkg.version), `${label} ${a} -> ${b}`);
      else add(pkg.name, "patch", a && b ? `${label} ${a} -> ${b}` : a ? `${label} removed` : `${label} ${b} added`);
    }
    if (canonical(latest.exports) !== canonical(pkg.manifest.exports)) add(pkg.name, "patch", "exports changed");

    // Files.
    const dir = path.join(tmp, pkg.name.replace("/", "__"));
    fs.mkdirSync(dir, { recursive: true });
    const [here, there] = [path.join(dir, "local"), path.join(dir, "npm")];
    fs.mkdirSync(here);
    fs.mkdirSync(there);
    const mine = tarballFiles(pack(["pnpm", "pack", "--pack-destination", here], pkg.path, here), here);
    const theirs = tarballFiles(
      pack(["npm", "pack", `${pkg.name}@${pkg.version}`, "--pack-destination", there, "--registry", registry], there, there),
      there,
    );
    const changed = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])]
      .filter((f) => mine[f] !== theirs[f])
      .sort();
    if (changed.length > 0) {
      const shown = changed.slice(0, 5).join(", ");
      add(pkg.name, "patch", `files changed: ${shown}${changed.length > 5 ? `, ${changed.length - 5} more` : ""}`);
    }
  }

  // A sibling crossing a breaking line takes its runtime / peer dependents with it.
  const bumpOf = (name) => plan.get(name)?.bump ?? pending[name];
  for (let changed = true; changed; ) {
    changed = false;
    for (const pkg of publicPackages(root)) {
      const crossing = breaking(pkg.version);
      if (bumpOf(pkg.name) === crossing || bumpOf(pkg.name) === "major") continue;
      for (const f of ["dependencies", "peerDependencies"]) {
        for (const [dep, spec] of Object.entries(pkg.manifest[f] ?? {})) {
          if (!spec.startsWith("workspace:") || !versions[dep]) continue;
          if (bumpOf(dep) && bumpOf(dep) === breaking(versions[dep])) {
            add(pkg.name, crossing, `${dep} crosses a breaking line`);
            changed = true;
          }
        }
      }
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (plan.size === 0) {
  console.log("Nothing to release beyond the pending changesets.");
} else {
  const dir = path.join(root, ".changeset");
  for (const [name, { bump, reasons }] of [...plan].sort(([a], [b]) => (a < b ? -1 : 1))) {
    console.log(`${name}: ${bump}`);
    for (const r of reasons) console.log(`    ${r}`);
    if (dryRun) continue;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `auto-${name.replace(/^@/, "").replace(/[/.]/g, "-")}.md`);
    const body = reasons.map((r) => `- ${r}`).join("\n");
    fs.writeFileSync(file, `---\n"${name}": ${bump}\n---\n\nRelease of the changes since the last published version:\n\n${body}\n`);
  }
}
