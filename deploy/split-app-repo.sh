#!/usr/bin/env bash
# Split frappe-apps/ironwrap_roofing into its own git repo so frappe_docker's
# APPS_JSON image build (which clones git URLs) can install it.
# Usage:
#   APP_REPO_URL=https://github.com/ironwrap/ironwrap_roofing.git deploy/split-app-repo.sh
# The target repo must exist and use the canonical credential-free HTTPS URL.
# BuildKit receives private-repository credentials through a secret file, never
# through this URL or Git history.
set -euo pipefail
set +x

APP_PREFIX="frappe-apps/ironwrap_roofing"
BRANCH="${APP_SPLIT_BRANCH:-app-split}"
EXPECTED_APP_REPO_URL="https://github.com/ironwrap/ironwrap_roofing.git"

if [ -z "${APP_REPO_URL:-}" ]; then
  echo "APP_REPO_URL is required (the empty private repo to push the app into)" >&2
  exit 1
fi
if [[ "$APP_REPO_URL" != "$EXPECTED_APP_REPO_URL" ]]; then
  echo "error: APP_REPO_URL must be the canonical credential-free IronWrap app HTTPS URL" >&2
  exit 1
fi
if ! git check-ref-format --branch "$BRANCH" >/dev/null 2>&1; then
  echo "error: APP_SPLIT_BRANCH is not a valid branch name" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"
git subtree split --prefix="$APP_PREFIX" -b "$BRANCH"
git push "$APP_REPO_URL" "$BRANCH:main"
git branch -D "$BRANCH"
echo "ok: $APP_PREFIX pushed to the canonical private app repository"
