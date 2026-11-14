#!/usr/bin/env node
// Tell the other statewalker repositories that this one has just published to npm, so each one
// updates its lockfile to the new versions within its ranges (statewalker-update.yml there).
//
//   node notify-dependents.mjs --packages "@statewalker/a@1.2.3 @statewalker/b@0.4.1"
//
// Sends a `repository_dispatch` event of type `statewalker-published` to every repository the
// statewalker-release GitHub App is installed on, except this one. A repository without
// statewalker-update.yml ignores it; one whose lockfile does not move opens nothing. Broadcasting
// to the installation instead of computing the dependents keeps this free of a dependency map
// that would go stale.
//
// GITHUB_TOKEN: an installation token of the App (Contents: write on the installation's
// repositories, which `repository_dispatch` needs), minted for the job and revoked at its end.
// GITHUB_REPOSITORY (owner/name) names the sender. A failed dispatch is reported and the others
// still go out; the script then exits 1. The receivers' daily schedule catches what was missed.
import { parseArgs } from "node:util";
import { rest } from "./lib/rest.mjs";

const EVENT = "statewalker-published";

const { values } = parseArgs({ options: { packages: { type: "string", default: "" } } });
const packages = values.packages.split(/[\s,]+/).filter(Boolean);
const self = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!self || !token) {
  console.error("notify-dependents: GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  process.exit(2);
}
if (packages.length === 0) {
  console.log("notify-dependents: nothing was published, nobody to notify");
  process.exit(0);
}

const gh = rest(token);
const targets = (await gh.pages("/installation/repositories", "repositories"))
  .filter((r) => !r.archived && r.full_name.toLowerCase() !== self.toLowerCase())
  .map((r) => r.full_name)
  .sort();

const failed = [];
for (const repo of targets) {
  try {
    await gh.call("POST", `/repos/${repo}/dispatches`, {
      event_type: EVENT,
      client_payload: { source: self, packages },
    });
    console.log(`notified ${repo}`);
  } catch (err) {
    console.log(`::warning::${repo} was not notified: ${err.message}`);
    failed.push(repo);
  }
}
console.log(`notify-dependents: ${packages.join(", ")} from ${self}; ${targets.length - failed.length}/${targets.length} notified`);
if (failed.length) process.exit(1);
