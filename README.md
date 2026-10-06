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

## Releases are made by hand, not by CI

CI never publishes. A maintainer releases from a local checkout, with their own npm login and 2FA,
so no publishing credential is stored in GitHub. The cost: packages carry no provenance attestation,
which only a CI-issued identity can sign.

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
