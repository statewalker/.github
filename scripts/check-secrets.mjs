#!/usr/bin/env node
// The secret scan, with gitleaks, run from the repository's root before the install (so
// node_modules is not scanned):
//   - the checked-out files (`gitleaks dir`);
//   - with SECRET_SCAN_BASE=<commit>, also every commit after it (`gitleaks git`, <base>..HEAD), so a
//     secret added and deleted again within a pull request fails too. The history must be fetched
//     (actions/checkout `fetch-depth: 0`). An all-zero base (a new branch) scans the files only.
// A finding fails, with the secret redacted in the output. False positives go in the repository's
// own .gitleaks.toml (allowlist) or .gitleaksignore (fingerprints).
//   GITLEAKS=<path to the gitleaks binary, default: gitleaks on PATH> node check-secrets.mjs
import { spawnSync } from "node:child_process";
import { report } from "./lib/workspace.mjs";

const gitleaks = process.env.GITLEAKS || "gitleaks";
const base = (process.env.SECRET_SCAN_BASE ?? "").trim();
const COMMON = ["--redact", "--no-banner", "--verbose", "--exit-code", "1"];

function fail(message, detail) {
  console.error(`secret scan: ${message}`);
  if (detail) console.error(detail);
  process.exit(2);
}

/** Run gitleaks; its output when it found secrets, undefined when it found none. */
function run(args) {
  const res = spawnSync(gitleaks, [...args, ...COMMON], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (res.error || (res.status !== 0 && res.status !== 1)) {
    fail(`could not run gitleaks (${gitleaks}): ${res.error?.message ?? `exit ${res.status}`}`, res.stderr);
  }
  return res.status === 1 ? `${res.stdout}${res.stderr}`.trim() : undefined;
}

const scans = [["the checked-out files", ["dir", "."]]];
if (base && !/^0+$/.test(base)) {
  const known = spawnSync("git", ["cat-file", "-e", `${base}^{commit}`]);
  if (known.status !== 0) {
    fail(`the base commit ${base} is not in the fetched history: check out with fetch-depth: 0`);
  }
  scans.push([`the commits after ${base.slice(0, 12)}`, ["git", ".", "--log-opts", `${base}..HEAD`]]);
}

const problems = [];
for (const [what, args] of scans) {
  const found = run(args);
  if (!found) continue;
  problems.push(
    `gitleaks found secrets in ${what} (redacted below). Revoke each one: it is exposed once pushed, even after removal. ` +
      `For a false positive, allowlist it in .gitleaks.toml or add its fingerprint to .gitleaksignore.\n${found
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n")}`,
  );
}
report(`secret scan (gitleaks: ${scans.map(([what]) => what).join(", ")})`, problems);
