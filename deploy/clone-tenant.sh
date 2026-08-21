#!/usr/bin/env bash
# Stand up a second white-label tenant on the local stack, as code.
#
# docs/WHITE-LABEL-CLONE-PLAYBOOK.md is the authority for WHAT a tenant clone is. This script
# is the locally-provable half of it: tenant config, tenant Frappe site with its own database
# and its own identities, tenant Worker config with its own bindings, tenant local D1, and the
# validators. Everything it does is reproducible on a laptop with docker and this checkout.
#
# It provisions NO infrastructure. Creating the tenant's Cloudflare account resources (D1, R2,
# queues, secrets, DNS), its Google Shared Drives and its QuickBooks connection is an owner
# action against live accounts; the script prints those steps as a hand-off list and stops
# there. Look for HAND-OFF in the output.
#
# Usage:
#   deploy/clone-tenant.sh --tenant <id> --answers <answers.json> [options]
#   deploy/clone-tenant.sh --tenant <id> --set BRAND_NAME=... --set ... [options]
#
# Options:
#   --worker-port N        host port the tenant Worker will listen on (default 7200)
#   --broker-port-base N   base for the tenant's four approval brokers (default 9200)
#   --skip-site            do not touch the Frappe stack (config and Worker wiring only)
#   --frappe-port N        host port the shared local Frappe stack answers on (default 8000)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/local/docker-compose.yml"

TENANT=""
ANSWERS=""
WORKER_PORT=7200
BROKER_PORT_BASE=9200
FRAPPE_PORT="${IRONWRAP_LOCAL_FRAPPE_PORT:-8000}"
SKIP_SITE=0
SET_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant) TENANT="$2"; shift 2 ;;
    --answers) ANSWERS="$2"; shift 2 ;;
    --set) SET_ARGS+=(--set "$2"); shift 2 ;;
    --worker-port) WORKER_PORT="$2"; shift 2 ;;
    --broker-port-base) BROKER_PORT_BASE="$2"; shift 2 ;;
    --frappe-port) FRAPPE_PORT="$2"; shift 2 ;;
    --skip-site) SKIP_SITE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$TENANT" ]] || { echo "ERROR: --tenant <id> is required" >&2; exit 2; }
[[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{1,63}$ ]] || {
  echo "ERROR: tenant id must be lowercase alphanumeric with hyphens (it is also the site prefix)" >&2
  exit 2
}

# One Frappe site per tenant, reached on its own hostname. Every *.localhost name resolves to
# loopback without touching /etc/hosts, and Frappe v15 resolves the site strictly from the Host
# header, so the tenant site and the IronWrap site share a bench and a port while staying
# separate databases with separate users.
SITE="$TENANT.localhost"
IDENTITY_DOMAIN="$TENANT.local"
FRAPPE_BASE_URL="http://$SITE:$FRAPPE_PORT"
WORKER_ORIGIN="http://localhost:$WORKER_PORT"
WORKER_CONFIG="$ROOT_DIR/workers-bus/wrangler.$TENANT.jsonc"
DEV_VARS="$ROOT_DIR/workers-bus/.dev.vars.$TENANT"
PERSIST_DIR="$ROOT_DIR/workers-bus/.wrangler/state-$TENANT"

step() { printf '\n\033[1;36m[clone-tenant]\033[0m %s\n' "$*"; }
handoff() { printf '\033[1;33m  HAND-OFF\033[0m %s\n' "$*"; }

rand() { node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"; }

# ---------------------------------------------------------------------------
step "1/6 tenant config: config/tenants/$TENANT.json"
GENERATE_ARGS=(--set "TENANT_ID=$TENANT")
[[ -n "$ANSWERS" ]] && GENERATE_ARGS=(--answers "$ANSWERS" "${GENERATE_ARGS[@]}")
node "$ROOT_DIR/tools/generate-tenant-config.mjs" "${GENERATE_ARGS[@]}" "${SET_ARGS[@]+"${SET_ARGS[@]}"}"
node "$ROOT_DIR/tools/validate-tenant-config.mjs"

# ---------------------------------------------------------------------------
if [[ "$SKIP_SITE" -eq 1 ]]; then
  step "2/6 Frappe site: skipped (--skip-site)"
else
  step "2/6 Frappe site $SITE on the local compose stack (own database, own identities on $IDENTITY_DOMAIN)"
  # The shared bench, MariaDB and Redis are the same containers the IronWrap site runs on;
  # only the SITE (its database, its users, its keys) is new.
  docker compose -f "$COMPOSE_FILE" up -d
  docker compose -f "$COMPOSE_FILE" run --rm \
    -e SITE_NAME="$SITE" \
    -e IRONWRAP_LOCAL_IDENTITY_DOMAIN="$IDENTITY_DOMAIN" \
    frappe-init

  step "2/6 waiting for $FRAPPE_BASE_URL/api/method/ping"
  for attempt in $(seq 1 60); do
    if curl -sf --max-time 3 "$FRAPPE_BASE_URL/api/method/ping" | grep -q pong; then
      echo "  $SITE answers on $FRAPPE_BASE_URL"
      break
    fi
    [[ "$attempt" -eq 60 ]] && { echo "ERROR: $SITE never answered" >&2; exit 1; }
    sleep 2
  done
fi

# ---------------------------------------------------------------------------
step "3/6 tenant Worker config: workers-bus/wrangler.$TENANT.jsonc"
HANDOFF_LOG="$(mktemp)"
trap 'rm -f "$HANDOFF_LOG"' EXIT
node "$ROOT_DIR/tools/generate-tenant-worker-config.mjs" \
  --tenant "$TENANT" \
  --out "$WORKER_CONFIG" \
  --frappe-base-url "$FRAPPE_BASE_URL" \
  --worker-origin "$WORKER_ORIGIN" \
  --identity-domain "$IDENTITY_DOMAIN" \
  --broker-port-base "$BROKER_PORT_BASE" | tee "$HANDOFF_LOG"

# ---------------------------------------------------------------------------
step "4/6 tenant Worker secrets: workers-bus/.dev.vars.$TENANT (throwaway local values)"
if [[ "$SKIP_SITE" -eq 1 ]]; then
  echo "  skipped: needs the tenant site's API key pairs"
else
  # Seeded from the example so every name the Worker expects exists, then every credential
  # is replaced with a value minted for THIS tenant. Nothing is copied from another tenant's
  # .dev.vars: playbook step 2.7, "all tokens are NEW values, never reused from another tenant".
  cp "$ROOT_DIR/workers-bus/.dev.vars.example" "$DEV_VARS"
  chmod 600 "$DEV_VARS"

  ACCEPTANCE_HMAC="$(rand)"
  DECISION_HMAC="$(rand)"
  FACET_PROJECTION_HMAC="$(rand)"

  export CLONE_COMPOSE_FILE="$COMPOSE_FILE"
  export CLONE_SITE="$SITE"
  export CLONE_ACCEPTANCE_HMAC="$ACCEPTANCE_HMAC"
  export CLONE_DECISION_HMAC="$DECISION_HMAC"
  export CLONE_FACET_PROJECTION_HMAC="$FACET_PROJECTION_HMAC"

  node - "$DEV_VARS" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const [target] = process.argv.slice(2);
const compose = process.env.CLONE_COMPOSE_FILE;
const site = process.env.CLONE_SITE;
const fresh = () => randomBytes(32).toString("base64url");

const credentials = (file) => {
  const raw = execFileSync(
    "docker",
    ["compose", "-f", compose, "exec", "-T", "frappe", "cat", `/home/frappe/frappe-bench/sites/${site}/${file}`],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(raw);
  if (!parsed.api_key || !parsed.api_secret) throw new Error(`${file} is empty on ${site}`);
  return parsed;
};

const bus = credentials(".integration_credentials");
const quickBooks = credentials(".quickbooks_reconciliation_issuer_credentials");
const fleet = credentials(".fleet_capture_issuer_credentials");
const workPackage = credentials(".work_package_issuer_credentials");
const acceptance = credentials(".customer_acceptance_credentials");
const decision = credentials(".customer_decision_credentials");
const facet = credentials(".facet_design_projection_credentials");

const entries = [
  // Every shared-by-default local placeholder becomes a tenant-only value. ADMIN_TOKEN is
  // the one leakage check 2 exercises in both directions.
  ["INGEST_TOKEN", fresh()],
  ["ADMIN_TOKEN", fresh()],
  ["APP_AUTH_PEPPER", fresh()],
  ["EFFECT_RUNTIME_TOKEN", fresh()],
  ["AUTHORITY_RECORD_EXECUTOR_HMAC_KEY", fresh()],
  ["PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER", fresh()],
  ["FACET_LAUNCH_HMAC_KEY", fresh()],
  ["PROPOSAL_PUBLICATION_BROKER_SHARED_SECRET", fresh()],
  ["PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET", fresh()],
  ["APP_CUSTOMER_ACCEPTANCE_HMAC_KEY", process.env.CLONE_ACCEPTANCE_HMAC],
  ["APP_CUSTOMER_DECISION_HMAC_KEY", process.env.CLONE_DECISION_HMAC],
  ["FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY", process.env.CLONE_FACET_PROJECTION_HMAC],
  // Turnstile's documented always-pass test secret; the local stack never calls the provider.
  ["PUBLIC_ESTIMATE_TURNSTILE_SECRET", "1x0000000000000000000000000000000AA"],
  ["ERPNEXT_API_KEY", bus.api_key],
  ["ERPNEXT_API_SECRET", bus.api_secret],
  ["QB_RECONCILIATION_ISSUER_API_KEY", quickBooks.api_key],
  ["QB_RECONCILIATION_ISSUER_API_SECRET", quickBooks.api_secret],
  ["FLEET_CAPTURE_FRAPPE_API_KEY", fleet.api_key],
  ["FLEET_CAPTURE_FRAPPE_API_SECRET", fleet.api_secret],
  ["WORK_PACKAGE_FRAPPE_API_KEY", workPackage.api_key],
  ["WORK_PACKAGE_FRAPPE_API_SECRET", workPackage.api_secret],
  ["APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY", acceptance.api_key],
  ["APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_SECRET", acceptance.api_secret],
  ["APP_CUSTOMER_DECISION_FRAPPE_API_KEY", decision.api_key],
  ["APP_CUSTOMER_DECISION_FRAPPE_API_SECRET", decision.api_secret],
  ["FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY", facet.api_key],
  ["FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET", facet.api_secret],
];

let text = readFileSync(target, "utf8");
for (const [key, value] of entries) {
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${text.trimEnd()}\n${line}\n`;
}
writeFileSync(target, text, { mode: 0o600 });
console.log(`  wrote ${entries.length} tenant-only values into ${target}`);
NODE

  step "4/6 pinning the tenant site's own HMAC keys"
  # `--` before the key: a base64url secret starting with a hyphen is otherwise read by
  # click as an option and `bench set-config` dies with "No such option: -H".
  docker compose -f "$COMPOSE_FILE" exec -T frappe \
    bench --site "$SITE" set-config -- ironwrap_customer_acceptance_hmac_key "$ACCEPTANCE_HMAC"
  docker compose -f "$COMPOSE_FILE" exec -T frappe \
    bench --site "$SITE" set-config -- ironwrap_customer_decision_hmac_key "$DECISION_HMAC"
  docker compose -f "$COMPOSE_FILE" exec -T frappe \
    bench --site "$SITE" set-config -- ironwrap_facet_design_projection_hmac_key "$FACET_PROJECTION_HMAC"
fi

# ---------------------------------------------------------------------------
step "5/6 tenant local D1: $PERSIST_DIR"
(
  cd "$ROOT_DIR/workers-bus"
  CI=true npx wrangler d1 migrations apply "$TENANT-bus" --local \
    --config "$WORKER_CONFIG" --persist-to "$PERSIST_DIR"
)

# ---------------------------------------------------------------------------
step "6/6 validators"
node "$ROOT_DIR/tools/validate-tenant-config.mjs"
# The runtime env comes from the tenant config itself. Deriving it in shell meant word-splitting
# a display name that contains spaces, which turned a healthy tenant into an APP_TENANT_NAME
# mismatch that named the wrong cause.
node "$ROOT_DIR/deploy/local/tenant-runtime-preflight.mjs" "$TENANT" "$WORKER_ORIGIN"
node "$ROOT_DIR/tools/validate-site-config-pins.mjs"
node "$ROOT_DIR/tools/validate-rail-credential-isolation.mjs"

# ---------------------------------------------------------------------------
printf '\n\033[1;32m[clone-tenant] %s is provisioned locally.\033[0m\n' "$TENANT"
cat <<EOF

  tenant config   config/tenants/$TENANT.json
  Frappe site     $FRAPPE_BASE_URL   (identities on @$IDENTITY_DOMAIN)
  Worker config   workers-bus/wrangler.$TENANT.jsonc
  Worker secrets  workers-bus/.dev.vars.$TENANT   (gitignored, throwaway)
  local D1/R2     $PERSIST_DIR

  Start the tenant Worker:
    cd workers-bus && npx wrangler dev --config wrangler.$TENANT.jsonc \\
      --env-file .dev.vars.$TENANT --persist-to .wrangler/state-$TENANT \\
      --port $WORKER_PORT --test-scheduled

  Prove isolation against the IronWrap tenant:
    deploy/tenant-leakage-checks.sh --tenant-a ironwrap --tenant-b $TENANT

EOF

printf '\033[1;33m[clone-tenant] The rest is an owner action against live accounts. This script called no provider API.\033[0m\n'
grep -E '^  - ' "$HANDOFF_LOG" | while read -r line; do handoff "${line#  - }"; done
