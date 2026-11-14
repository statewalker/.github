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

const gitIn = (dir) => (...args) =>
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

/** A copy of the clean fixture as a git repository, with `extra` files committed. */
function repoWith(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statewalker-secrets-"));
  fs.cpSync(path.join(repoRoot, "fixtures/secrets/clean"), dir, { recursive: true });
  for (const [file, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, file), text);
  const git = gitIn(dir);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return dir;
}

function scan(dir, extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.join(repoRoot, "scripts/check-secrets.mjs")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env, ...extraEnv },
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

/** The clean fixture as a base commit, then a commit adding a token and one deleting it. */
function addedThenDeleted() {
  const dir = repoWith({});
  const git = gitIn(dir);
  const base = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "src/deploy.ts"), `export const githubToken = "${fakeToken}";\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "add a token");
  fs.rmSync(path.join(dir, "src/deploy.ts"));
  git("add", "-A");
  git("commit", "-q", "-m", "delete it again");
  return { dir, base };
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

test("a token added and deleted again within the scanned commits fails, without printing it", opts, () => {
  const { dir, base } = addedThenDeleted();
  const r = scan(dir, { SECRET_SCAN_BASE: base });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /src\/deploy\.ts/);
  assert.doesNotMatch(r.out, new RegExp(fakeToken));
});

test("an all-zero base (a new branch pushed) scans the files only", opts, () => {
  const { dir } = addedThenDeleted();
  const r = scan(dir, { SECRET_SCAN_BASE: "0".repeat(40) });
  assert.equal(r.code, 0, r.out);
});

test("a base outside the fetched history is an error, not a pass", opts, () => {
  const { dir } = addedThenDeleted();
  const r = scan(dir, { SECRET_SCAN_BASE: "1".repeat(40) });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /fetch-depth/);
});

test("without gitleaks the scan is an error, not a pass", () => {
  const r = runCheck("check-secrets.mjs", "secrets/clean", [], { GITLEAKS: "/nonexistent/gitleaks" });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /gitleaks/);
});
