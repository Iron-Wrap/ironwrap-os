#!/usr/bin/env bash
# Stand up a second white-label tenant on the local stack, as code.
#
# docs/WHITE-LABEL-CLONE-PLAYBOOK.md is the authority for WHAT a tenant clone is. This script
# is the locally-provable half of it: tenant config, tenant Worker config with its own bindings
# and its own throwaway secrets, tenant local D1, and the validators. Everything it does is
# reproducible on a laptop with this checkout. Frappe is decommissioned, so no tenant gets a
# Frappe site.
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
#   --frappe-port N        port named in the tenant Worker's inert ERPNEXT_BASE_URL (default 8000)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TENANT=""
ANSWERS=""
WORKER_PORT=7200
FRAPPE_PORT="${IRONWRAP_LOCAL_FRAPPE_PORT:-8000}"
SET_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant) TENANT="$2"; shift 2 ;;
    --answers) ANSWERS="$2"; shift 2 ;;
    --set) SET_ARGS+=(--set "$2"); shift 2 ;;
    --worker-port) WORKER_PORT="$2"; shift 2 ;;
    --frappe-port) FRAPPE_PORT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$TENANT" ]] || { echo "ERROR: --tenant <id> is required" >&2; exit 2; }
[[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{1,63}$ ]] || {
  echo "ERROR: tenant id must be lowercase alphanumeric with hyphens (it is also a resource prefix)" >&2
  exit 2
}

# The tenant Worker config still carries ERPNEXT_BASE_URL and ERPNEXT_INTEGRATION_USER with
# the Frappe projection off; they name this tenant's own host and domain so nothing in the
# generated config points at another tenant.
IDENTITY_DOMAIN="$TENANT.local"
FRAPPE_BASE_URL="http://$TENANT.localhost:$FRAPPE_PORT"
WORKER_ORIGIN="http://localhost:$WORKER_PORT"
WORKER_CONFIG="$ROOT_DIR/workers-bus/wrangler.$TENANT.jsonc"
DEV_VARS="$ROOT_DIR/workers-bus/.dev.vars.$TENANT"
PERSIST_DIR="$ROOT_DIR/workers-bus/.wrangler/state-$TENANT"

step() { printf '\n\033[1;36m[clone-tenant]\033[0m %s\n' "$*"; }
handoff() { printf '\033[1;33m  HAND-OFF\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------
step "1/5 tenant config: config/tenants/$TENANT.json"
GENERATE_ARGS=(--set "TENANT_ID=$TENANT")
[[ -n "$ANSWERS" ]] && GENERATE_ARGS=(--answers "$ANSWERS" "${GENERATE_ARGS[@]}")
node "$ROOT_DIR/tools/generate-tenant-config.mjs" "${GENERATE_ARGS[@]}" "${SET_ARGS[@]+"${SET_ARGS[@]}"}"
node "$ROOT_DIR/tools/validate-tenant-config.mjs"

# ---------------------------------------------------------------------------
step "2/5 tenant Worker config: workers-bus/wrangler.$TENANT.jsonc"
HANDOFF_LOG="$(mktemp)"
trap 'rm -f "$HANDOFF_LOG"' EXIT
node "$ROOT_DIR/tools/generate-tenant-worker-config.mjs" \
  --tenant "$TENANT" \
  --out "$WORKER_CONFIG" \
  --frappe-base-url "$FRAPPE_BASE_URL" \
  --worker-origin "$WORKER_ORIGIN" \
  --identity-domain "$IDENTITY_DOMAIN" | tee "$HANDOFF_LOG"

# ---------------------------------------------------------------------------
step "3/5 tenant Worker secrets: workers-bus/.dev.vars.$TENANT (throwaway local values)"
# Seeded from the example so every name the Worker expects exists, then every credential
# is replaced with a value minted for THIS tenant. Nothing is copied from another tenant's
# .dev.vars: playbook step 2.7, "all tokens are NEW values, never reused from another tenant".
cp "$ROOT_DIR/workers-bus/.dev.vars.example" "$DEV_VARS"
chmod 600 "$DEV_VARS"

node - "$DEV_VARS" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const { randomBytes } = require("node:crypto");
const [target] = process.argv.slice(2);
const fresh = () => randomBytes(32).toString("base64url");

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
  ["APP_CUSTOMER_ACCEPTANCE_HMAC_KEY", fresh()],
  ["FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY", fresh()],
  // Turnstile's documented always-pass test secret; the local stack never calls the provider.
  ["PUBLIC_ESTIMATE_TURNSTILE_SECRET", "1x0000000000000000000000000000000AA"],
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

# ---------------------------------------------------------------------------
step "4/5 tenant local D1: $PERSIST_DIR"
(
  cd "$ROOT_DIR/workers-bus"
  CI=true npx wrangler d1 migrations apply "$TENANT-bus" --local \
    --config "$WORKER_CONFIG" --persist-to "$PERSIST_DIR"
)

# ---------------------------------------------------------------------------
step "5/5 validators"
node "$ROOT_DIR/tools/validate-tenant-config.mjs"
# The runtime env comes from the tenant config itself. Deriving it in shell meant word-splitting
# a display name that contains spaces, which turned a healthy tenant into an APP_TENANT_NAME
# mismatch that named the wrong cause.
node "$ROOT_DIR/deploy/local/tenant-runtime-preflight.mjs" "$TENANT" "$WORKER_ORIGIN"

# ---------------------------------------------------------------------------
printf '\n\033[1;32m[clone-tenant] %s is provisioned locally.\033[0m\n' "$TENANT"
cat <<EOF

  tenant config   config/tenants/$TENANT.json
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
