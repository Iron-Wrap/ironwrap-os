#!/usr/bin/env bash
# converge.sh [target-sha] - move an already-provisioned local/dev stand to the
# tree this script runs from.
#
# This encodes the 2026-08-21 manual deploy sequence (iron-wrap-infra
# DELIVERY-PLATFORM-SPEC.md section 7.7.3): build, compose up, D1 migrations, bench
# migrate, restart the Worker and broker units, record .stand-revision, verify.
# The tree must already be checked out at the target ref - iw-standd
# (iron-wrap-infra/agent/iw-standd) does that and decides WHAT runs; this
# script owns HOW the stack moves between two refs.
#
# It deliberately does NOT run predev.mjs: predev provisions a fresh stand
# (generates keys, scaffolds .dev.vars) and regenerating those on a live stand
# would break the secret agreement between the Worker and the approval brokers.
# Converge assumes .dev.vars, deploy/local/keys/ and workers-bus/.wrangler/
# already exist in this tree.
#
# Knobs (all optional):
#   IRONWRAP_LOCAL_FRAPPE_PORT   Frappe port           (default 8000)
#   IRONWRAP_LOCAL_WORKER_PORT   Worker port           (default 7100)
#   SITE_NAME                    Frappe site           (default ironwrap.localhost)
#   IW_WORKER_UNIT               Worker systemd unit   (default ironwrap-bus-staging.service)
#   IW_BROKER_UNITS              broker units to try-restart, space-separated
#   IW_VERIFY_FACET_URL          facet health URL; empty string skips the probe

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TARGET_SHA="${1:-$(git rev-parse HEAD)}"
FRAPPE_PORT="${IRONWRAP_LOCAL_FRAPPE_PORT:-8000}"
WORKER_PORT="${IRONWRAP_LOCAL_WORKER_PORT:-7100}"
SITE="${SITE_NAME:-ironwrap.localhost}"
WORKER_UNIT="${IW_WORKER_UNIT:-ironwrap-bus-staging.service}"
BROKER_UNITS="${IW_BROKER_UNITS:-ironwrap-production-schedule-approval-broker.service ironwrap-proposal-publication-approval-broker.service}"
FACET_URL="${IW_VERIFY_FACET_URL-http://127.0.0.1:8095/api/health}"

COMPOSE=(docker compose -f deploy/local/docker-compose.yml)
if [ "$(uname -m)" = "x86_64" ]; then
  COMPOSE+=(-f deploy/local/docker-compose.amd64.yml)
fi

log() { echo "converge: $*"; }
die() { echo "converge: ERROR: $*" >&2; exit 1; }

wait_for() {
  local name="$1" url="$2" expect="$3" tries="$4" curl_extra="${5:-}"
  local i body
  for ((i = 1; i <= tries; i++)); do
    # shellcheck disable=SC2086
    body="$(curl -sS -m 5 $curl_extra "$url" 2>/dev/null || true)"
    if [[ "$body" == *"$expect"* ]]; then
      log "$name is up ($url)"
      return 0
    fi
    sleep 2
  done
  die "$name did not answer '$expect' on $url after $((tries * 2))s"
}

log "converging $REPO_ROOT to $TARGET_SHA"

# 1. Dependencies and the PWA bundle (the Worker serves ../app/dist itself).
log "installing workers-bus dependencies"
npm ci --prefix workers-bus --no-audit --no-fund
log "building the PWA"
npm ci --prefix app --no-audit --no-fund
npm run build --prefix app

# 2. The compose stack, single-lineage from this tree.
log "docker compose up (${COMPOSE[*]})"
"${COMPOSE[@]}" --profile frappe up -d --remove-orphans
wait_for "frappe" "http://127.0.0.1:${FRAPPE_PORT}/api/method/ping" '"message":"pong"' 150

# 3. Migrations: D1 first (local Miniflare state), then the Frappe site.
log "applying D1 migrations (local)"
(cd workers-bus && CI=true npx wrangler d1 migrations apply ironwrap-bus --local --env local)
log "running bench migrate for site ${SITE}"
"${COMPOSE[@]}" --profile frappe exec -T frappe bench --site "$SITE" migrate

# 4. Restart the units that execute code from this tree.
if command -v systemctl >/dev/null 2>&1 && systemctl cat "$WORKER_UNIT" >/dev/null 2>&1; then
  log "restarting $WORKER_UNIT"
  systemctl restart "$WORKER_UNIT"
else
  log "worker unit $WORKER_UNIT not present, skipping restart"
fi
for unit in $BROKER_UNITS; do
  if command -v systemctl >/dev/null 2>&1 && systemctl cat "$unit" >/dev/null 2>&1; then
    log "try-restarting $unit"
    systemctl try-restart "$unit" || log "WARNING: $unit failed to restart"
  fi
done

# 5. Verify. The stand is converged only when its surfaces answer.
wait_for "worker" "https://127.0.0.1:${WORKER_PORT}/ready" '"ok":true' 60 "-k"
if [ -n "$FACET_URL" ]; then
  wait_for "facet" "$FACET_URL" '"ok":true' 15
fi

# 6. Record what runs. First token of the first line is the contract iw-standd reads.
{
  echo "$TARGET_SHA"
  echo "synced_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "converged_by=converge.sh"
} >.stand-revision

log "converged to $TARGET_SHA"
