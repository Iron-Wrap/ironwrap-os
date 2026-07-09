#!/usr/bin/env bash
# Split frappe-apps/ironwrap_roofing into its own git repo so frappe_docker's
# APPS_JSON image build (which clones git URLs) can install it.
# Usage:
#   APP_REPO_URL=https://github.com/ironwrap/ironwrap_roofing.git deploy/split-app-repo.sh
# The target repo must exist (private) and the URL may carry a read/write token
# for CI use; never commit a tokenized URL anywhere.
set -euo pipefail

APP_PREFIX="frappe-apps/ironwrap_roofing"
BRANCH="${APP_SPLIT_BRANCH:-app-split}"

if [ -z "${APP_REPO_URL:-}" ]; then
  echo "APP_REPO_URL is required (the empty private repo to push the app into)" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"
git subtree split --prefix="$APP_PREFIX" -b "$BRANCH"
git push "$APP_REPO_URL" "$BRANCH:main"
git branch -D "$BRANCH"
echo "ok: $APP_PREFIX pushed to $APP_REPO_URL main"
