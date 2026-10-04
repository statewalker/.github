# statewalker/.github

Shared CI for the statewalker monorepos.

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
