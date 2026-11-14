#!/usr/bin/env bash
# Install the pinned gitleaks into $RUNNER_TEMP (or a temp dir) after checking its SHA-256, and
# export GITLEAKS=<binary> for the next steps (through $GITHUB_ENV when in GitHub Actions).
set -euo pipefail
VERSION=8.30.1
SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb # gitleaks_8.30.1_linux_x64.tar.gz
dir="${RUNNER_TEMP:-$(mktemp -d)}/gitleaks"
mkdir -p "$dir"
curl -sSfL -o "$dir/gitleaks.tar.gz" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_linux_x64.tar.gz"
echo "${SHA256}  $dir/gitleaks.tar.gz" | sha256sum -c -
tar -xzf "$dir/gitleaks.tar.gz" -C "$dir" gitleaks
"$dir/gitleaks" version
if [ -n "${GITHUB_ENV:-}" ]; then echo "GITLEAKS=$dir/gitleaks" >> "$GITHUB_ENV"; else echo "GITLEAKS=$dir/gitleaks"; fi
