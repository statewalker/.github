#!/usr/bin/env node
// The release path: packages are published only from the standard `publish` job of
// .github/workflows/ci.yml (npm trusted publishing, after a version pull request). Any other
// workflow, job or composite action that publishes fails:
//   - `npm publish`, `pnpm publish` (`pnpm -r publish`, `pnpm --filter x publish`), `yarn publish`,
//     `yarn npm publish`, `bun publish`, `changeset publish` (`--dry-run` does not count);
//   - a root package.json script that runs one of these, directly or through other scripts;
//   - `changesets/action` with a `publish` input, and npm-publish actions.
// Run from the repository's root. YAML is read with this repository's `yaml` dependency.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { report } from "./lib/workspace.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const YAML = createRequire(path.join(here, "..", "package.json"))("yaml");

const root = process.cwd();
const MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
// Flags that take a value, per manager, so the value is not read as the subcommand. (pnpm's `-w`
// is the boolean --workspace-root; npm's `-w` is --workspace <name>.)
const VALUE_FLAGS = {
  npm: new Set(["-w", "--workspace", "--prefix", "-C", "--registry", "--tag", "--access", "--otp"]),
  pnpm: new Set(["--filter", "-F", "-C", "--dir", "--workspace-concurrency", "--reporter", "--registry", "--tag", "--access", "--otp"]),
  yarn: new Set(["--cwd"]),
  bun: new Set(["--cwd"]),
  changeset: new Set(),
};

/**
 * One shell word as a command name: without `VAR=` assignments, `$(`, backticks or parentheses
 * around it, and without a pinned version (`npm@11.19.0` is npm).
 */
const bare = (token) =>
  token
    .replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "")
    .replace(/^(\$\(|`|\()+/, "")
    .replace(/[)`]+$/, "")
    .replace(/^["']|["']$/g, "");
const asManager = (token) => {
  const name = bare(token).replace(/@[^/]*$/, "");
  return MANAGERS.has(name) || name === "changeset" ? name : undefined;
};

/** Shell commands of a script or `run:` block, split on newlines, `&&`, `||`, `;` and `|`. */
const commands = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .flatMap((line) => line.split(/&&|\|\||;|\|/))
    .map((c) => c.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);

/** The non-flag words after a manager, skipping flag values. */
function words(tokens, from, manager) {
  const out = [];
  for (let i = from; i < tokens.length; i++) {
    const t = bare(tokens[i]);
    if (VALUE_FLAGS[manager].has(t)) i++;
    else if (!t.startsWith("-")) out.push(t);
  }
  return out;
}

const rootScripts = (() => {
  const file = path.join(root, "package.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")).scripts ?? {}) : {};
})();

/**
 * What a command publishes: undefined, or a description ("npm publish", or the chain of root
 * scripts that reaches a publish command).
 */
function publishes(tokens, seen = new Set()) {
  if (tokens.some((t) => bare(t) === "--dry-run")) return undefined;
  // Every manager word counts: `pnpm -r exec npm publish`, `yarn workspaces foreach -A npm publish`.
  for (let i = 0; i < tokens.length; i++) {
    const manager = asManager(tokens[i]);
    if (!manager) continue;
    const what = publishesFrom(tokens, i, manager, seen);
    if (what) return what;
  }
  return undefined;
}

function publishesFrom(tokens, i, manager, seen) {
  const w = words(tokens, i + 1, manager);
  if (manager === "changeset") return w[0] === "publish" ? "changeset publish" : undefined;
  if (w[0] === "publish" || (manager === "yarn" && w[0] === "npm" && w[1] === "publish")) return `${manager} publish`;
  // `pnpm changeset publish`, `npx changeset publish`, `pnpm exec changeset publish`: found as
  // the `changeset` word by the caller's loop.
  // A root script: `npm run x`, `pnpm run x`, `pnpm x`, `yarn x`, `bun run x`.
  const name = w[0] === "run" || w[0] === "run-script" ? w[1] : manager === "npm" ? undefined : w[0];
  const recursive = tokens.some((t) => t === "-r" || t === "--recursive");
  if (!name || !Object.hasOwn(rootScripts, name) || seen.has(name) || recursive) return undefined;
  seen.add(name);
  for (const c of commands(rootScripts[name])) {
    const inner = publishes(c, seen);
    if (inner) return inner.startsWith("script ") ? `script "${name}" → ${inner.slice(7)}` : `script "${name}" publishes`;
  }
  return undefined;
}

/** What a step publishes, or undefined. */
function stepPublishes(step) {
  if (typeof step?.run === "string") {
    for (const c of commands(step.run)) {
      const what = publishes(c);
      if (what) return what.startsWith("script ") ? `${c.join(" ")} (${what})` : c.join(" ");
    }
  }
  const uses = typeof step?.uses === "string" ? step.uses.toLowerCase() : "";
  if (uses.startsWith("changesets/action") && step.with?.publish) return "changesets/action with publish";
  if (/(^|\/)npm-publish(@|$)/.test(uses)) return step.uses;
  return undefined;
}

const problems = [];
const workflowsDir = path.join(root, ".github", "workflows");
const workflowFiles = fs.existsSync(workflowsDir)
  ? fs.readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(workflowsDir, f))
  : [];
const read = (file) => {
  try {
    return YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    problems.push(`${path.relative(root, file)}: not valid YAML (${err.message.split("\n")[0]})`);
    return undefined;
  }
};

for (const file of workflowFiles) {
  const standard = /^ci\.ya?ml$/.test(path.basename(file));
  for (const [id, job] of Object.entries(read(file)?.jobs ?? {})) {
    if (standard && id === "publish") continue;
    for (const [n, step] of (job?.steps ?? []).entries()) {
      const what = stepPublishes(step);
      if (what) {
        problems.push(
          `${path.relative(root, file)}, job "${id}", step ${n + 1}: ${what}. Publishing happens only in the standard "publish" job of .github/workflows/ci.yml`,
        );
      }
    }
  }
}

// Composite actions: their steps run wherever they are used.
const actionsDir = path.join(root, ".github", "actions");
if (fs.existsSync(actionsDir)) {
  for (const entry of fs.readdirSync(actionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of ["action.yml", "action.yaml"]) {
      const file = path.join(actionsDir, entry.name, name);
      if (!fs.existsSync(file)) continue;
      for (const [n, step] of (read(file)?.runs?.steps ?? []).entries()) {
        const what = stepPublishes(step);
        if (what) {
          problems.push(`${path.relative(root, file)}, step ${n + 1}: ${what}. Publish from the standard "publish" job of ci.yml itself`);
        }
      }
    }
  }
}

report(`release path (${workflowFiles.length} workflow file${workflowFiles.length === 1 ? "" : "s"})`, problems);
