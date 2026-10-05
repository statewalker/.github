# statewalker/.github

Shared CI, releases and dependency updates for the statewalker monorepos.

## Use

A repository's `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  ci:
    uses: statewalker/.github/.github/workflows/ci.yml@main
  release:
    needs: ci
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    uses: statewalker/.github/.github/workflows/release.yml@main
    permissions:
      contents: write
      pull-requests: write
      id-token: write
    secrets: inherit
```

and its `renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>statewalker/.github"]
}
```

A repository without public packages leaves out the `release` job.

Inputs: `node-version` (default `24`), `setup` (shell commands run before the tests, e.g. installing
browsers), `test-command` (default `pnpm run test`), `checks-ref` (the ref of this repository to take
the check scripts from).

## What it runs

1. `pnpm install --frozen-lockfile`
2. **Dependency references** (`scripts/check-conventions.mjs`): workspace packages as `workspace:^`;
   everything else through the catalog (`catalog:`, a named catalog, `catalog:peers` for peers),
   with an entry in that catalog; nothing reaching outside the repository (`link:`, `file:`).
3. `lint:check`, `format:check`, `build`, `typecheck`, then the tests. Root scripts a repository does
   not define are skipped.
4. On the built packages:
   - **Export targets** (`scripts/check-exports.mjs`): every `exports` / `main` / `types` / `bin`
     target exists.
   - **Dist imports** (`scripts/check-dist-imports.mjs`): every bare import in `dist/` is a declared
     dependency, peer or optional dependency, and nothing was bundled into `dist/node_modules`.
   - **Packed manifests** (`scripts/check-pack.mjs`): `pnpm pack` leaves no `workspace:`, `catalog:`,
     `link:` or `file:` specifier for a consumer to trip on.

The scripts are plain Node (no dependencies) and run locally too, from a repository's root:

```sh
node ../.github/scripts/check-conventions.mjs
```

## Releases

`release.yml` runs after CI on every push to `main`:

1. **Changesets for unreleased changes** (`scripts/release-changesets.mjs`). Each public package is
   packed as `pnpm publish` would pack it and compared with npm's `latest`:
   - a packed file differs (sources, `dist/`, README, ...), or the published manifest does (runtime,
     peer or optional dependencies, `exports`): **patch**;
   - a dependency moved to another breaking line (`^0.3` to `^0.4`, `^1` to `^2`): **minor** on 0.x,
     **major** from 1.0; packages depending on it through `workspace:` get the same bump.

   Changesets written by hand take precedence: write one (`pnpm changeset`) to choose the bump or the
   changelog text. Packages whose version is not on npm yet are left alone.
2. **changesets/action**: with changesets pending, it opens or updates the **"chore: version
   packages"** pull request (versions, `CHANGELOG.md`). Merging that pull request publishes every
   package whose version is not on npm yet, with provenance, and creates the GitHub releases.

Run the planning step locally (after `pnpm build`) to see what the next release holds:

```sh
node ../.github/scripts/release-changesets.mjs --dry-run
```

### npm authentication

Either:

- **Trusted publishing** (preferred, no secret): on npmjs.com, each package's *Settings → Trusted
  publishing* names GitHub Actions, the repository, and the workflow file **`ci.yml`** (the calling
  workflow, not this one). With npm 11.15 or later it can be scripted, one 2FA prompt per package:
  `npm trust github <package> --repo statewalker/<repo> --file ci.yml --allow-publish --yes`.
- **`NPM_TOKEN`**: an npm granular access token with read and write access to the `@statewalker`
  packages, as an organization secret (or a repository secret).

## Dependency updates

`default.json` is the [Renovate](https://docs.renovatebot.com) preset; repositories extend it with
`"github>statewalker/.github"`. It needs the Renovate GitHub app installed on the organization.

- Ranges stay as they are while new versions fit them (`rangeStrategy: update-lockfile`): only the
  lockfile changes, and nothing needs releasing. Updates outside a range (a major, a 0.x minor) rewrite
  the range in the catalog.
- **`@statewalker/*`**: one pull request as soon as a version is published, merged when CI passes.
  Merged, it changes the published manifests, so the release job prepares a release of the dependent
  packages: a release in a library repository moves up, repository by repository, to the
  applications.
- Third-party updates within the ranges: one weekly pull request (Monday morning, Paris time),
  merged when CI passes, for versions at least 3 days old.
- Third-party majors, and any update of a third-party package still on 0.x: one pull request each,
  merged by hand.
- GitHub Actions: grouped, merged when CI passes. The lockfile is refreshed monthly.
- pnpm, Node and `@types/node` majors move by hand, in all repositories at once.
