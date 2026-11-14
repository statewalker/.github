#!/usr/bin/env node
// The secret scan: gitleaks over the repository's files, run from its root before the install (so
// node_modules is not scanned). A finding fails, with the secret redacted in the output.
// False positives go in the repository's own .gitleaks.toml (allowlist) or .gitleaksignore
// (fingerprints), which gitleaks reads from the scanned directory.
//   GITLEAKS=<path to the gitleaks binary, default: gitleaks on PATH> node check-secrets.mjs
import { spawnSync } from "node:child_process";
import { report } from "./lib/workspace.mjs";

const gitleaks = process.env.GITLEAKS || "gitleaks";
const res = spawnSync(gitleaks, ["dir", ".", "--redact", "--no-banner", "--verbose", "--exit-code", "1"], {
  encoding: "utf8",
  env: { ...process.env, NO_COLOR: "1" },
});
if (res.error || (res.status !== 0 && res.status !== 1)) {
  console.error(`secret scan: could not run gitleaks (${gitleaks}): ${res.error?.message ?? `exit ${res.status}`}`);
  if (res.stderr) console.error(res.stderr);
  process.exit(2);
}
const output = `${res.stdout}${res.stderr}`.trim();
const problems = [];
if (res.status === 1) {
  problems.push(
    `gitleaks found committed secrets (redacted below). Revoke each one: it is exposed once pushed, even after removal. ` +
      `For a false positive, allowlist it in .gitleaks.toml or add its fingerprint to .gitleaksignore.\n${output
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n")}`,
  );
}
report("secret scan (gitleaks)", problems);
