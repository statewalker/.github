// Run a check script the way CI does: from a fixture repository's root, as a separate process.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..");

/** Run `node scripts/<script> ...args` with the fixture `fixtures/<fixture>` as cwd. */
export function runCheck(script, fixture, args = [], env = {}) {
  const res = spawnSync(process.execPath, [path.join(repoRoot, "scripts", script), ...args], {
    cwd: path.join(repoRoot, "fixtures", fixture),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}
