#!/usr/bin/env bash
# Run the eight tenant-leakage checks of docs/WHITE-LABEL-CLONE-PLAYBOOK.md against two
# tenants standing side by side on the local stack.
#
# The checks were a prose list nobody could run, which is the same shape as a rail that ships
# dead: the isolation model was documented and never exercised (ELEC-48 audit section 3). Here
# each check drives real traffic through tenant B and then looks for it in tenant A, so a
# regression shows up as a FAIL rather than as an unread paragraph.
#
# Three verdicts:
#   PASS      the check ran locally and found no leakage
#   FAIL      the check ran and found leakage (exit code 1)
#   HAND-OFF  the check needs a live provider account this stack deliberately does not have.
#             Its locally-provable control is asserted and named; the live half stays an
#             owner action. A HAND-OFF is never counted as a pass.
#
# Both tenant Workers must already be running. deploy/clone-tenant.sh prints both commands.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/local/docker-compose.yml"

TENANT_A="ironwrap"
TENANT_B=""
A_ORIGIN="http://localhost:7100"
B_ORIGIN="http://localhost:7200"
A_DEV_VARS="$ROOT_DIR/workers-bus/.dev.vars"
B_DEV_VARS=""
A_CONFIG="$ROOT_DIR/workers-bus/wrangler.jsonc"
A_CONFIG_ENV="local"
B_CONFIG=""
A_PERSIST="$ROOT_DIR/workers-bus/.wrangler/state"
B_PERSIST=""
A_SITE="ironwrap.localhost"
B_SITE=""
FRAPPE_PORT="${IRONWRAP_LOCAL_FRAPPE_PORT:-8000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant-a) TENANT_A="$2"; shift 2 ;;
    --tenant-b) TENANT_B="$2"; shift 2 ;;
    --a-origin) A_ORIGIN="$2"; shift 2 ;;
    --b-origin) B_ORIGIN="$2"; shift 2 ;;
    --a-site) A_SITE="$2"; shift 2 ;;
    --b-site) B_SITE="$2"; shift 2 ;;
    --frappe-port) FRAPPE_PORT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$TENANT_B" ]] || { echo "ERROR: --tenant-b <id> is required" >&2; exit 2; }
B_DEV_VARS="${B_DEV_VARS:-$ROOT_DIR/workers-bus/.dev.vars.$TENANT_B}"
B_CONFIG="${B_CONFIG:-$ROOT_DIR/workers-bus/wrangler.$TENANT_B.jsonc}"
B_PERSIST="${B_PERSIST:-$ROOT_DIR/workers-bus/.wrangler/state-$TENANT_B}"
B_SITE="${B_SITE:-$TENANT_B.localhost}"

PASSES=0
FAILURES=0
HANDOFFS=0

pass() { printf '\033[1;32m  PASS\033[0m     %s\n' "$*"; PASSES=$((PASSES + 1)); }
fail() { printf '\033[1;31m  FAIL\033[0m     %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
note() { printf '           %s\n' "$*"; }
handoff() { printf '\033[1;33m  HAND-OFF\033[0m %s\n' "$*"; HANDOFFS=$((HANDOFFS + 1)); }
check() { printf '\n\033[1;36m[check %s]\033[0m %s\n' "$1" "$2"; }

var_of() { awk -F= -v k="$2" '$1 == k { sub("^" k "=", ""); print; exit }' "$1"; }

A_ADMIN="$(var_of "$A_DEV_VARS" ADMIN_TOKEN)"
B_ADMIN="$(var_of "$B_DEV_VARS" ADMIN_TOKEN)"
B_INGEST="$(var_of "$B_DEV_VARS" INGEST_TOKEN)"
A_FRAPPE_KEY="$(var_of "$A_DEV_VARS" ERPNEXT_API_KEY)"
A_FRAPPE_SECRET="$(var_of "$A_DEV_VARS" ERPNEXT_API_SECRET)"
B_FRAPPE_KEY="$(var_of "$B_DEV_VARS" ERPNEXT_API_KEY)"
B_FRAPPE_SECRET="$(var_of "$B_DEV_VARS" ERPNEXT_API_SECRET)"

for name in A_ADMIN B_ADMIN B_INGEST A_FRAPPE_KEY B_FRAPPE_KEY; do
  [[ -n "${!name}" ]] || { echo "ERROR: $name is empty; is $TENANT_B cloned and are both .dev.vars present?" >&2; exit 2; }
done

status_of() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }

d1_query() { # config env persist database sql
  local config="$1" env_flag="$2" persist="$3" database="$4" sql="$5"
  (
    cd "$ROOT_DIR/workers-bus"
    # shellcheck disable=SC2086
    CI=true npx wrangler d1 execute "$database" --local --json \
      --config "$config" $env_flag --persist-to "$persist" --command "$sql"
  )
}

d1_scalar() { node -e '
let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  const parsed = JSON.parse(raw.slice(raw.indexOf("[")));
  const row = parsed[0]?.results?.[0] ?? {};
  process.stdout.write(String(Object.values(row)[0] ?? ""));
});'; }

# Random per run so a stale row from an earlier run can never be mistaken for this one's traffic.
# Pinnable (`IRONWRAP_LEAKCHECK_MARKER=leakcheck-deadbeef`) for the one case that needs a known
# value: planting a row cross-tenant on purpose and confirming the checks BITE. A suite that has
# only ever been quiet has not been shown to detect anything.
MARKER="${IRONWRAP_LEAKCHECK_MARKER:-leakcheck-$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')}"
MARKER_EMAIL="$MARKER@$TENANT_B.example"

# Per-run scratch, not shared /tmp paths: two tenant pairs proven at once on one machine would
# otherwise read each other's captured payloads and call the result isolation.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/$MARKER.XXXXXX")"
chmod 700 "$SCRATCH"
trap 'rm -rf "$SCRATCH"' EXIT

printf '\033[1m Tenant leakage checks: %s (A) vs %s (B)\033[0m\n' "$TENANT_A" "$TENANT_B"
note "marker for this run: $MARKER"

# --------------------------------------------------------------------------- 1
check 1 "tenant config and runtime validators"
config_ok=1
node "$ROOT_DIR/tools/validate-tenant-config.mjs" || config_ok=0
for tenant in "$TENANT_A" "$TENANT_B"; do
  origin="$A_ORIGIN"; [[ "$tenant" == "$TENANT_B" ]] && origin="$B_ORIGIN"
  node "$ROOT_DIR/deploy/local/tenant-runtime-preflight.mjs" "$tenant" "$origin" || config_ok=0
done
if [[ "$config_ok" -eq 1 ]]; then
  pass "id uniqueness, sender-domain isolation, and each tenant's own runtime identity all hold"
else
  fail "a tenant config or runtime preflight was rejected (output above)"
fi

# --------------------------------------------------------------------------- 2
check 2 "cross-tenant admin token, both directions"
b_with_a="$(status_of -H "authorization: Bearer $A_ADMIN" "$B_ORIGIN/admin/envelopes?limit=1")"
a_with_b="$(status_of -H "authorization: Bearer $B_ADMIN" "$A_ORIGIN/admin/envelopes?limit=1")"
b_with_b="$(status_of -H "authorization: Bearer $B_ADMIN" "$B_ORIGIN/admin/envelopes?limit=1")"
note "B/admin/envelopes with A token: $b_with_a | A/admin/envelopes with B token: $a_with_b | B with own token: $b_with_b"
if [[ "$b_with_a" == "401" && "$a_with_b" == "401" && "$b_with_b" == "200" ]]; then
  pass "each Worker refuses the other tenant's ADMIN_TOKEN and accepts its own"
else
  fail "expected 401/401/200, got $b_with_a/$a_with_b/$b_with_b"
fi

# --------------------------------------------------------------------------- 3
check 3 "data plane: a lead ingested into B never appears in A's D1"
a_before="$(d1_query "$A_CONFIG" "--env $A_CONFIG_ENV" "$A_PERSIST" "$TENANT_A-bus" \
  "SELECT COUNT(*) AS n FROM envelopes" | d1_scalar)"
ingest_status="$(curl -s -o "$SCRATCH/ingest.json" -w '%{http_code}' --max-time 20 \
  -X POST "$B_ORIGIN/ingest/estimate" \
  -H "authorization: Bearer $B_INGEST" -H 'content-type: application/json' \
  -d "{\"project_id\":\"$MARKER\",\"name\":\"$MARKER Demo\",\"email\":\"$MARKER_EMAIL\",\"phone\":\"5875550100\",\"address\":\"1 Demo Way\",\"service\":\"metal roofing\"}")"
note "POST B/ingest/estimate -> HTTP $ingest_status"
a_after="$(d1_query "$A_CONFIG" "--env $A_CONFIG_ENV" "$A_PERSIST" "$TENANT_A-bus" \
  "SELECT COUNT(*) AS n FROM envelopes" | d1_scalar)"
b_marked="$(d1_query "$B_CONFIG" "" "$B_PERSIST" "$TENANT_B-bus" \
  "SELECT COUNT(*) AS n FROM envelopes WHERE contact_email = '$MARKER_EMAIL'" | d1_scalar)"
a_marked="$(d1_query "$A_CONFIG" "--env $A_CONFIG_ENV" "$A_PERSIST" "$TENANT_A-bus" \
  "SELECT COUNT(*) AS n FROM envelopes WHERE contact_email = '$MARKER_EMAIL'" | d1_scalar)"
note "A envelopes before/after: $a_before/$a_after | marker rows in B: $b_marked | in A: $a_marked"
if [[ "$ingest_status" == "202" || "$ingest_status" == "200" ]] &&
   [[ "$b_marked" == "1" && "$a_marked" == "0" && "$a_before" == "$a_after" ]]; then
  pass "B's lead is in B's database only; A's row count is unchanged by B's traffic"
else
  fail "ingest $ingest_status, marker in B=$b_marked A=$a_marked, A count $a_before -> $a_after"
fi

# --------------------------------------------------------------------------- 4
check 4 "R2: B's raw payload lands only in B's bucket"
RAW_KEY="$(d1_query "$B_CONFIG" "" "$B_PERSIST" "$TENANT_B-bus" \
  "SELECT raw_key FROM envelopes WHERE contact_email = '$MARKER_EMAIL'" | d1_scalar)"
note "raw key: ${RAW_KEY:-<none>}"
if [[ -z "$RAW_KEY" ]]; then
  fail "no raw key recorded for the marker lead"
else
  b_object=1; a_object=1
  ( cd "$ROOT_DIR/workers-bus" && CI=true npx wrangler r2 object get "$TENANT_B-bus-raw/$RAW_KEY" \
      --local --persist-to "$B_PERSIST" --config "$B_CONFIG" --pipe >"$SCRATCH/raw-b.json" 2>/dev/null ) || b_object=0
  ( cd "$ROOT_DIR/workers-bus" && CI=true npx wrangler r2 object get "$TENANT_A-bus-raw/$RAW_KEY" \
      --local --persist-to "$A_PERSIST" --config "$A_CONFIG" --env "$A_CONFIG_ENV" --pipe >"$SCRATCH/raw-a.json" 2>/dev/null ) || a_object=0
  note "object present in $TENANT_B-bus-raw: $b_object | in $TENANT_A-bus-raw: $a_object"
  if [[ "$b_object" == "1" && "$a_object" == "0" ]] && grep -q "$MARKER" "$SCRATCH/raw-b.json"; then
    pass "the raw payload exists in B's bucket and the same key is absent from A's"
  else
    fail "raw payload isolation not proven (B=$b_object, A=$a_object)"
  fi
fi

# --------------------------------------------------------------------------- 5
check 5 "Frappe: B's lead is on B's site and its marker appears in no doctype on A's"
# This asked ONE doctype - `Lead Envelope` - until ELEC-143 finding 1. The ingest fan-out
# (`workers-bus/src/erpnext.ts`, pushToErpNext) writes the same contact across several doctypes,
# `Roofing Customer.email` (erpnext.ts:665) among them, so a leak confined to the customer-dedup
# path answered "0 rows" here and was counted as isolation. The sweep asks every doctype the app
# ships - the enumeration comes from the doctype JSONs, not from a list anyone maintains - and
# tools/validate-ingest-doctype-coverage.mjs fails CI if a doctype erpnext.ts names ever falls
# outside it.
marker_sweep() { # site key secret out-file
  node "$ROOT_DIR/deploy/local/frappe-marker-sweep.mjs" \
    --site "$1" --port "$FRAPPE_PORT" --key "$2" --secret "$3" --marker "$MARKER" >"$4"
}
sweep_field() { # file key
  node -e '
const doc = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const value = doc[process.argv[2]];
process.stdout.write(
  Array.isArray(value)
    ? value.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join(" | ")
    : String(value ?? ""),
);' "$1" "$2"
}
b_swept=1; marker_sweep "$B_SITE" "$B_FRAPPE_KEY" "$B_FRAPPE_SECRET" "$SCRATCH/sweep-b.json" || b_swept=0
a_swept=1; marker_sweep "$A_SITE" "$A_FRAPPE_KEY" "$A_FRAPPE_SECRET" "$SCRATCH/sweep-a.json" || a_swept=0
b_hits="$(sweep_field "$SCRATCH/sweep-b.json" totalHits)"
a_hits="$(sweep_field "$SCRATCH/sweep-a.json" totalHits)"
b_where="$(sweep_field "$SCRATCH/sweep-b.json" hitDoctypes)"
a_where="$(sweep_field "$SCRATCH/sweep-a.json" hitDoctypes)"
queried="$(sweep_field "$SCRATCH/sweep-b.json" queried)"
doctypes="$(sweep_field "$SCRATCH/sweep-b.json" doctypes)"
note "swept $doctypes doctypes ($queried queries per site) for marker $MARKER"
note "marker rows on B: $b_hits in [${b_where:-none}]"
note "marker rows on A: $a_hits in [${a_where:-none}]"
[[ "$b_swept" == "1" ]] || note "B sweep errors: $(sweep_field "$SCRATCH/sweep-b.json" errors)"
[[ "$a_swept" == "1" ]] || note "A sweep errors: $(sweep_field "$SCRATCH/sweep-a.json" errors)"
# Both sweeps must have RUN: a query that errored found nothing for the same reason an empty
# table does, and only one of those is isolation.
if [[ "$b_swept" == "1" && "$a_swept" == "1" && "$a_hits" == "0" ]] && [[ "$b_hits" -ge 1 ]]; then
  pass "B's marker is present on B's site (in $b_where) and absent from all $doctypes doctypes on A's"
else
  fail "sweep ran B=$b_swept A=$a_swept; marker rows B=$b_hits ([$b_where]) A=$a_hits ([$a_where]), expected A=0 and B>=1"
fi

# --------------------------------------------------------------------------- 6
check 6 "Drive: the evidence namespace is the tenant's own"
b_bucket="$(node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.r2_buckets[0].bucket_name)' "$B_CONFIG")"
b_drive="$(node "$ROOT_DIR/tools/read-wrangler-var.mjs" --config "$B_CONFIG" --separator '|' \
  SHARED_DRIVE_ID_JOBS SHARED_DRIVE_ID_RESTRICTED SHARED_DRIVE_ID_ARCHIVE)"
note "B raw bucket: $b_bucket | B SHARED_DRIVE_ID_JOBS|RESTRICTED|ARCHIVE: '$b_drive'"
if [[ "$b_bucket" != "$TENANT_A-bus-raw" && "$b_drive" == "||" ]]; then
  handoff "B carries no Shared Drive id at all, so it cannot reach A's Drive; creating B's own Shared Drives and granting its service account is an owner action in the tenant's Google workspace. Locally proven: B's raw-evidence namespace is $b_bucket, not $TENANT_A-bus-raw, and check 4 showed a payload landing in it alone."
else
  fail "B's evidence namespace is not its own (bucket $b_bucket, drives '$b_drive')"
fi

# --------------------------------------------------------------------------- 7
check 7 "MCP: a tenant profile reads only its own tenant, and cross-tenant Frappe keys fail"
mcp_envelopes() { # base-url admin-token
  IRONWRAP_BUS_BASE_URL="$1" IRONWRAP_ADMIN_TOKEN="$2" IRONWRAP_BUS_ALLOW_INSECURE_LOCAL=true \
    HERMES_AGENT_ROLE=owner-operator \
    node "$ROOT_DIR/deploy/local/mcp-list-envelopes.mjs" "$ROOT_DIR/mcp/ironwrap-bus-mcp"
}
mcp_b="$(mcp_envelopes "$B_ORIGIN" "$B_ADMIN" || echo "MCP_ERROR")"
mcp_a="$(mcp_envelopes "$A_ORIGIN" "$A_ADMIN" || echo "MCP_ERROR")"
mcp_b_marker=0; grep -q "$MARKER_EMAIL" <<<"$mcp_b" && mcp_b_marker=1
mcp_a_marker=0; grep -q "$MARKER_EMAIL" <<<"$mcp_a" && mcp_a_marker=1
cross_frappe="$(status_of -H "authorization: token $A_FRAPPE_KEY:$A_FRAPPE_SECRET" \
  "http://$B_SITE:$FRAPPE_PORT/api/method/frappe.auth.get_logged_user")"
note "list_recent_envelopes marker seen: B profile=$mcp_b_marker A profile=$mcp_a_marker | A's Frappe key on B's site: HTTP $cross_frappe"
if [[ "$mcp_b_marker" == "1" && "$mcp_a_marker" == "0" && ( "$cross_frappe" == "401" || "$cross_frappe" == "403" ) ]]; then
  pass "the tenant MCP profile returns only its own tenant's envelopes and A's Frappe credentials are refused by B's site"
else
  fail "MCP marker B=$mcp_b_marker A=$mcp_a_marker, cross-tenant Frappe auth HTTP $cross_frappe"
fi

# --------------------------------------------------------------------------- 8
check 8 "Email: B sends as B, never from an IronWrap mailbox"
b_from="$(node "$ROOT_DIR/tools/read-wrangler-var.mjs" --config "$B_CONFIG" --separator ' ' \
  FROM_EMAIL OWNER_ALERT_EMAIL BACKUP_ALERT_EMAIL)"
b_declared="$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(d.brand.brands.flatMap(b=>[b.sender_mailbox,...(b.sender_aliases??[])]).join(" "))' "$ROOT_DIR/config/tenants/$TENANT_B.json")"
note "B sender addresses: $b_from"
note "B declared mailboxes: $b_declared"
ironwrap_domains=0
grep -Eq 'ironwrapexteriors\.com|iroofalberta\.ca' <<<"$b_from" && ironwrap_domains=1
declared_ok=1
for address in $b_from; do grep -qF "$address" <<<"$b_declared" || declared_ok=0; done
# A real capture, not an empty one: the outbox only records a link for a user that exists.
# Bootstrap B's first owner as the marker address, then read back whichever owner B actually
# has - a second run of this script gets `first_owner_bootstrap_completed`, and asking B's own
# app_users table is what keeps the check working on run two rather than silently capturing
# nothing and calling that isolation.
curl -s -o /dev/null --max-time 10 -X POST "$B_ORIGIN/admin/app-users/bootstrap" \
  -H "authorization: Bearer $B_ADMIN" -H 'content-type: application/json' \
  -d "{\"tenant_id\":\"$TENANT_B\",\"email\":\"$MARKER_EMAIL\",\"display_name\":\"$MARKER Owner\"}" || true
B_OWNER_EMAIL="$(d1_query "$B_CONFIG" "" "$B_PERSIST" "$TENANT_B-bus" \
  "SELECT email_normalized FROM app_users WHERE tenant_id = '$TENANT_B' AND active = 1 LIMIT 1" | d1_scalar)"
note "B sign-in recipient under test: ${B_OWNER_EMAIL:-<none>}"
curl -s -o /dev/null --max-time 10 -X POST "$B_ORIGIN/api/v1/auth/magic-link/request" \
  -H 'content-type: application/json' -H "origin: $B_ORIGIN" \
  -d "{\"email\":\"$B_OWNER_EMAIL\"}" || true
outbox_b="$(curl -s --max-time 10 -H "authorization: Bearer $B_ADMIN" "$B_ORIGIN/admin/dev-outbox?limit=20")"
outbox_a="$(curl -s --max-time 10 -H "authorization: Bearer $A_ADMIN" "$A_ORIGIN/admin/dev-outbox?limit=20")"
captured_b=0; [[ -n "$B_OWNER_EMAIL" ]] && grep -q "$B_OWNER_EMAIL" <<<"$outbox_b" && captured_b=1
captured_a=0; [[ -n "$B_OWNER_EMAIL" ]] && grep -q "$B_OWNER_EMAIL" <<<"$outbox_a" && captured_a=1
# The captured link must point at B's own origin: a sign-in link on A's origin would hand B's
# recipient a session on the wrong tenant.
href_on_b=0; grep -q "$B_ORIGIN" <<<"$outbox_b" && href_on_b=1
note "outbound capture for B's recipient: in B=$captured_b in A=$captured_a | B link on B's own origin: $href_on_b"
if [[ "$ironwrap_domains" == "0" && "$declared_ok" == "1" && "$captured_b" == "1" && "$captured_a" == "0" && "$href_on_b" == "1" ]]; then
  handoff "every sender address B would use is one of B's own declared mailboxes and none is an IronWrap domain; B's outbound message was captured by B, carries a link on B's own origin, and never reached A. The live half (a message actually leaving B's SMTP with that From) needs the tenant's own Google workspace, which this stack refuses to call."
else
  fail "sender addresses '$b_from' not all B's own, or capture wrong (in B=$captured_b, in A=$captured_a, link on B's origin=$href_on_b)"
fi

# ---------------------------------------------------------------------------
printf '\n\033[1m Result: %s pass, %s hand-off, %s fail (of 8)\033[0m\n' "$PASSES" "$HANDOFFS" "$FAILURES"
[[ "$FAILURES" -eq 0 ]] || exit 1
