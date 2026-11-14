# statewalker/.github

Shared CI for the statewalker monorepos, the release-planning script, and site publishing.

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
```

Dependency updates come from Dependabot: each repository has its own `.github/dependabot.yml`
(see "Dependency updates come from Dependabot" below).

Inputs: `node-version` (default `24`), `setup` (shell commands run before the tests, e.g. installing
browsers), `test-command` (default `pnpm run test`), `checks-ref` (the ref of this repository to take
the check scripts from), `baseline` (`off`, `library` or `app`: the required baseline below),
`package-checks` and `attw-profile` (publint and attw), `api-diff` (the API diff against npm),
`secret-scan` (gitleaks) and `release-path` (publishing only from the standard `publish` job); see
the sections below.

## What it runs

1. `pnpm install --frozen-lockfile`
2. **Dependency references** (`scripts/check-conventions.mjs`): workspace packages as `workspace:^`;
   everything else through the catalog (`catalog:`, a named catalog, `catalog:peers` for peers),
   with an entry in that catalog; nothing reaching outside the repository (`link:`, `file:`).
3. `lint:check`, `format:check`, `build`, `typecheck`, then the tests. Root scripts a repository does
   not define are skipped, unless it switched on the required baseline (next section).
4. On the built packages:
   - **Export targets** (`scripts/check-exports.mjs`): every `exports` / `main` / `types` / `bin`
     target exists.
   - **Dist imports** (`scripts/check-dist-imports.mjs`): every bare import in `dist/` is a declared
     dependency, peer or optional dependency, and nothing was bundled into `dist/node_modules`.
   - **Packed manifests** (`scripts/check-pack.mjs`): `pnpm pack` leaves no `workspace:`, `catalog:`,
     `link:` or `file:` specifier for a consumer to trip on.

## The required baseline

With `baseline: library` or `baseline: app`, a missing check fails CI instead of being skipped:

```yaml
jobs:
  ci:
    uses: statewalker/.github/.github/workflows/ci.yml@main
    with:
      baseline: library
```

**Required scripts and typechecked tests** (`scripts/check-scripts.mjs`, right after the install):

- **Root scripts.** A library needs `lint:check`, `format:check`, `build`, `typecheck` and `test`; an
  app needs `build` and `typecheck`. Those steps then run without `--if-present`.
- **Scripts that run nothing.** A root script that delegates to the packages (`pnpm -r run
  typecheck`) fails when no package defines the script, and root `typecheck` fails for every package
  that has a `tsconfig.json` but no `typecheck` script: `pnpm -r` would skip it silently.
- **Typechecked tests.** Every TypeScript test file (`*.test.ts`, `*.spec.tsx`, ...) must be compiled
  by a typecheck step: a tsconfig named by the root `typecheck` or `typecheck:tests` script's `tsc`
  (`-p`/`--project`/`-b`, default `tsconfig.json`; `pnpm -r exec tsc` uses each package's), or by
  the package scripts these run through `pnpm -r run`. Test files at a monorepo's root, outside the
  packages, count too. Include the tests in the package's tsconfig, or give it a `typecheck:tests` script
  (`tsc -p tsconfig.test.json`) run from a root `typecheck:tests` (`pnpm -r run typecheck:tests`);
  CI runs root `typecheck:tests` after `typecheck`. Files a config pulls in through `references`
  count.

`baseline` defaults to `off`, today's behaviour, so projects switch it on one by one
(the `ci-baseline` rollout, `statewalker/statewalker-root#29`).

## Package checks and the API diff

Two more opt-in switches, so projects adopt them one by one (lowest layer first for the API diff):

```yaml
    with:
      package-checks: true   # publint and attw
      api-diff: true         # the public API against npm
```

- **publint and attw** (`scripts/check-package-tools.mjs`, `package-checks: true`): each public
  package is packed as `pnpm publish` packs it, then checked by
  [publint](https://publint.dev) (its errors fail; warnings and suggestions are printed) and
  [attw](https://github.com/arethetypeswrong/arethetypeswrong.github.io) with the profile
  `attw-profile` (default `esm-only`, which ignores the CommonJS and node10 resolutions an ESM-only
  package does not offer; `node16` or `strict` check more).
- **API diff** (`scripts/check-api-diff.mjs`, `api-diff: true`): each public package's packed type
  declarations are compared with npm's `latest`, entry point by entry point (`exports`, resolved as
  a bundler-mode TypeScript consumer resolves them). **Breaking**: an entry point removed or left
  without types, an export removed, an export that stops being a value or a type, a member removed
  from an exported class, interface or enum (private members do not count; `export type { X }` stops X being a value). A breaking change fails unless the pull request
  declares the bump it needs, **major** from 1.0, **minor** on 0.x, **patch** on 0.0.x (what a caret
  range lets through), either with a changeset (`.changeset/*.md`, `"@statewalker/x": major`) or
  with the package.json version already past npm's. Additions are listed and need no bump.
  Packages not on npm yet are skipped. Changed signatures (a parameter's type, a return type) are
  not compared: the reviewer judges those.

The tools (publint, attw, and the TypeScript the API diff uses) are pinned in this repository's
`package.json` and lockfile; the workflow installs them only when a switch is on. Locally:
`pnpm install` here, then from a repository's root, after its build:

```sh
node ../.github/scripts/check-package-tools.mjs
node ../.github/scripts/check-api-diff.mjs
```

## Secret scan and release path

Two more opt-in switches:

```yaml
    with:
      secret-scan: true    # gitleaks
      release-path: true   # publishing only from the standard publish job
```

- **Secret scan** (`scripts/check-secrets.mjs`, `secret-scan: true`): [gitleaks](https://github.com/gitleaks/gitleaks)
  scans, right after the checkout and before the install, the repository's files and every commit
  of the pull request (from its base; on a push, from the previous head), so a secret added and
  deleted again within a pull request fails too. The switch checks out the full history for this
  (`fetch-depth: 0`). A finding fails the job; the output redacts the secret. A leaked secret is revoked, not just deleted: it was exposed
  once pushed. False positives go in the repository's `.gitleaks.toml` (an allowlist) or
  `.gitleaksignore` (fingerprints from the output). gitleaks is pinned, by version and SHA-256,
  in `scripts/install-gitleaks.sh`. This complements GitHub secret scanning with push protection,
  an organization setting that stops a secret before it is pushed.
- **Release path** (`scripts/check-release-path.mjs`, `release-path: true`): fails any publish step
  outside the job `publish` of `.github/workflows/ci.yml`: in another job, another workflow file
  (even one whose job is named `publish`) or a composite action under `.github/actions/`. A publish
  step is `npm publish`, `pnpm publish`, `yarn publish`, `yarn npm publish`, `bun publish` or
  `changeset publish`, wherever it sits in a command (`pnpm -r publish`, `pnpm -w publish`,
  `pnpm -r exec npm publish`, `yarn workspaces foreach -A npm publish`, `npx npm@11 publish`,
  `pnpm changeset publish`, `out=$(npm publish …)`), a root package.json script reaching one of
  these through other scripts, `changesets/action` with a `publish` input, or an npm-publish action.
  `--dry-run` does not count. The check reads commands word by word; it is a guard against
  mistakes, not a sandbox. A version job
  (`changesets/action` with `version` only) passes.

Locally, from a repository's root: `bash ../.github/scripts/install-gitleaks.sh` prints the
`GITLEAKS=` path to use, then `GITLEAKS=<path> node ../.github/scripts/check-secrets.mjs` and
`node ../.github/scripts/check-release-path.mjs` (after `pnpm install` here, for `yaml`).

## Running the checks locally

The scripts are plain Node and run locally too, from a repository's root (`check-scripts.mjs` uses
the repository's own TypeScript; the package checks above use this repository's dependencies):

```sh
node ../.github/scripts/check-conventions.mjs
node ../.github/scripts/check-scripts.mjs library   # after pnpm install
```

This repository checks itself (`.github/workflows/self-test.yml`): `pnpm test` runs each check
script against the small repositories in `fixtures/` (a clean one passes, each defect fails), and
actionlint checks the workflows.

## Releases are made by CI, from the standard publish job

Publishing happens only in CI: npm trusted publishing from the standard `publish` job of each
project's `.github/workflows/ci.yml`, after a "version packages" pull request
([decision](https://github.com/statewalker/statewalker-root/issues/10); root's
`docs/process/README.md` §4). Never publish by hand, with one exception: a package's first version,
which a human publishes once (trusted publishing needs the package to exist on npm; §4 there). The
release-path check above (`release-path: true`) fails a publish step anywhere else in CI.

`scripts/release-changesets.mjs` plans a release. Each public package is packed as `pnpm publish`
would pack it and compared with npm's `latest`:

- a packed file differs (sources, `dist/`, README, ...), or the published manifest does (runtime,
  peer or optional dependencies, `exports`): **patch**;
- a dependency moved to another breaking line (`^0.3` to `^0.4`, `^1` to `^2`): **minor** on 0.x,
  **major** from 1.0; packages depending on it through `workspace:` get the same bump.

It writes a changeset for each, next to any written by hand (`pnpm changeset`), which take
precedence. Packages whose version is not on npm yet are left alone. After `pnpm build`, a dry run
shows what the next release holds:

```sh
node ../.github/scripts/release-changesets.mjs --dry-run
```

A releasing repository has `@changesets/cli` 3 as a root dev dependency and a
`.changeset/config.json` with `"access": "public"`, `"baseBranch": "main"` and
`"privatePackages": { "version": false, "tag": false }` (applications are not versioned).

## Static sites on httpeers.net

`publish-site.yml` publishes a built static site to `<domain>` (any name under `httpeers.net`): it
copies the files into the `sites` bucket at `s3.httpeers.net` under the prefix `<domain>`, where the
sites host serves them at once. Wildcard DNS and certificates cover every `*.httpeers.net` name.

```yaml
jobs:
  site:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    uses: statewalker/.github/.github/workflows/publish-site.yml@main
    with:
      domain: demo.httpeers.net
      build: pnpm --filter @statewalker/demo build
      path: apps/demo/dist
    secrets: inherit
```

- Files other than HTML go first, the HTML pages after them, and files the new build no longer has
  are removed last (`delete: false` keeps them). A page never names a file that is not there yet.
- A pull request preview is the same call with `domain: pr-${{ github.event.number }}-demo.httpeers.net`,
  and `remove: true` in a workflow on `pull_request: types: [closed]` deletes it.
- Secrets `SITES_S3_ACCESS_KEY_ID` and `SITES_S3_SECRET_ACCESS_KEY`: an S3 key of the rustfs
  storage with write access to the `sites` bucket (organization or repository secrets). Pull
  requests from forks get no secrets, so they get no preview.
- The job fails when `https://<domain>/` does not answer 2xx/3xx within 30 seconds after publishing:
  a site without an `index.html` at its root needs a `.site/config.json` that serves something
  there.

## Dependency updates come from Dependabot

Each repository has a `.github/dependabot.yml` (this repository's covers its GitHub Actions only):

- **Weekly**, Monday 06:00 Paris time, for npm (pnpm catalogs included) and GitHub Actions.
- **Ranges stay while new versions fit them** (`versioning-strategy: increase-if-necessary`): only
  the lockfile changes. A version outside a range (a major, or a minor below 1.0) rewrites it.
- **Versions younger than 3 days are skipped** (`cooldown`), so a broken release has time to be
  pulled before it reaches a pull request.
- **Grouped**: one pull request for `@statewalker/*`, one for third-party minor and patch updates;
  majors come one per pull request. Every pull request runs CI and is merged by hand.
- **`@statewalker/*` updates are normally made locally**, right after a release, so the Dependabot
  group only catches what was missed.

Dependabot alerts and security-fix pull requests are enabled on every repository, independently of
this file.
