import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { repoRoot, runCheck } from "./helpers.mjs";

// gitleaks is a binary, installed by the self-test workflow (GITLEAKS=<path>). Without it the
// tests are skipped locally; in CI a missing binary fails them.
const gitleaks = process.env.GITLEAKS || "gitleaks";
const available = spawnSync(gitleaks, ["version"]).status === 0;
if (!available && process.env.CI) throw new Error(`gitleaks not found (GITLEAKS=${process.env.GITLEAKS ?? ""})`);
const opts = { skip: available ? false : "gitleaks is not installed (set GITLEAKS)" };
const env = { GITLEAKS: gitleaks };

// A fake GitHub token, assembled here so that no token is ever committed to this repository.
const fakeToken = ["gh", "p_", "R7tY0wB5cD9fH1jK4sU6gE3aZq3vX8kLmN2p"].join("");

/** A copy of the clean fixture as a git repository, with `extra` files committed. */
function repoWith(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statewalker-secrets-"));
  fs.cpSync(path.join(repoRoot, "fixtures/secrets/clean"), dir, { recursive: true });
  for (const [file, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, file), text);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture");
  return dir;
}

function scan(dir) {
  const res = spawnSync(process.execPath, [path.join(repoRoot, "scripts/check-secrets.mjs")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

test("a clean repository passes the secret scan", opts, () => {
  const r = runCheck("check-secrets.mjs", "secrets/clean", [], env);
  assert.equal(r.code, 0, r.out);
});

test("a committed fake token fails the secret scan, without printing the token", opts, () => {
  const r = scan(repoWith({ "src/deploy.ts": `export const githubToken = "${fakeToken}";\n` }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /src\/deploy\.ts/);
  assert.doesNotMatch(r.out, new RegExp(fakeToken));
});

test("without gitleaks the scan is an error, not a pass", () => {
  const r = runCheck("check-secrets.mjs", "secrets/clean", [], { GITLEAKS: "/nonexistent/gitleaks" });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /gitleaks/);
});
