#!/usr/bin/env node
// publint and attw (Are the Types Wrong?) on every public package, packed the way `pnpm publish`
// would pack it. Run after the build:
//   node check-package-tools.mjs [--attw-profile esm-only|node16|strict]
// The tools are this repository's own dependencies (pinned in its lockfile): install them first
// with `pnpm install --frozen-lockfile` in this repository.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { publicPackages, report } from "./lib/workspace.mjs";

const { values } = parseArgs({ options: { "attw-profile": { type: "string", default: "esm-only" } } });

const modules = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules");
/** The path of a package's command-line entry, from this repository's node_modules. */
function bin(pkg, name) {
  const manifestPath = path.join(modules, pkg, "package.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`${pkg} is not installed: run pnpm install --frozen-lockfile in ${path.dirname(modules)}`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin[name];
  return path.join(path.dirname(manifestPath), entry);
}
const PUBLINT = bin("publint", "publint");
const ATTW = bin("@arethetypeswrong/cli", "attw");

/** Run a tool; its output, indented, when it fails. */
function run(file, args) {
  const res = spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  if (res.status === 0) return undefined;
  const out = `${res.stdout}${res.stderr}`.trim();
  return out.split("\n").map((l) => `      ${l}`).join("\n");
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), "statewalker-package-tools-"));
const problems = [];
const pkgs = publicPackages();
try {
  for (const pkg of pkgs) {
    const dest = fs.mkdtempSync(path.join(out, "pack-"));
    try {
      execFileSync("pnpm", ["pack", "--pack-destination", dest], { cwd: pkg.path, stdio: "pipe" });
    } catch (err) {
      problems.push(`${pkg.name}: pnpm pack failed: ${String(err.stderr ?? err).split("\n")[0]}`);
      continue;
    }
    const tarball = path.join(dest, fs.readdirSync(dest).find((f) => f.endsWith(".tgz")));
    const publint = run(PUBLINT, ["run", tarball, "--pack", "false"]);
    if (publint) problems.push(`${pkg.name}: publint\n${publint}`);
    const attw = run(ATTW, [tarball, "--profile", values["attw-profile"], "--format", "ascii", "--no-emoji"]);
    if (attw) problems.push(`${pkg.name}: attw (profile ${values["attw-profile"]})\n${attw}`);
  }
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
report(`publint and attw (${pkgs.length} public package${pkgs.length === 1 ? "" : "s"})`, problems);
