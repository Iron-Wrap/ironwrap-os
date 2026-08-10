#!/usr/bin/env bash
# IronWrap OS local seed - provisions app users and drives synthetic intake through the
# running local stack (wrangler dev --env local on :7100 + deploy/local Frappe on :8000).
# Synthetic data only; bridges (JobNimbus/Drive) are disabled in the local env, so every
# write stays inside local D1/R2 and the throwaway Frappe site.
set -euo pipefail

BUS="${BUS_URL:-http://localhost:7100}"
FRAPPE="${FRAPPE_URL:-http://localhost:8000}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

read_var() {
  local key="$1"
  python3 -c "
for l in open('$REPO_ROOT/workers-bus/.dev.vars'):
    if l.startswith('$key='): print(l.split('=',1)[1].strip().strip('\"').strip(\"'\")); break"
}
ADMIN_TOKEN="$(read_var ADMIN_TOKEN)"
INGEST_TOKEN="$(read_var INGEST_TOKEN)"
FKEY="$(read_var ERPNEXT_API_KEY)"
FSECRET="$(read_var ERPNEXT_API_SECRET)"
: "${ADMIN_TOKEN:?missing}" "${INGEST_TOKEN:?missing}" "${FKEY:?missing}" "${FSECRET:?missing}"

j() { python3 -m json.tool 2>/dev/null || cat; }
step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
APP_ORIGIN="${APP_ORIGIN:-http://localhost:7100}"
OWNER_EMAIL="owner@ironwrap.local"
OWNER_COOKIE=""
OWNER_CSRF=""
BOOTSTRAP_BODY="$(mktemp)"
CONSUME_HEADERS="$(mktemp)"
CONSUME_BODY="$(mktemp)"
cleanup_session_files() {
  rm -f "$BOOTSTRAP_BODY" "$CONSUME_HEADERS" "$CONSUME_BODY"
}
trap cleanup_session_files EXIT

# 1. bootstrap the first owner -----------------------------------------------
step "bootstrapping the first owner"
BOOTSTRAP_STATUS="$(curl -sS -o "$BOOTSTRAP_BODY" -w '%{http_code}' \
  -X POST "$BUS/admin/app-users/bootstrap" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"tenant_id\":\"ironwrap\",\"email\":\"$OWNER_EMAIL\",\"display_name\":\"Ilia Owner\"}")"
j < "$BOOTSTRAP_BODY"
if [[ "$BOOTSTRAP_STATUS" != "200" && "$BOOTSTRAP_STATUS" != "409" ]]; then
  echo "first-owner bootstrap failed with HTTP $BOOTSTRAP_STATUS" >&2
  exit 1
fi

# 2. create a real owner session ---------------------------------------------
step "creating an owner magic-link session from the dev outbox"
curl -sf -X POST "$BUS/api/v1/auth/magic-link/request" \
  -H "Origin: $APP_ORIGIN" -H 'content-type: application/json' \
  -d "{\"tenant_id\":\"ironwrap\",\"email\":\"$OWNER_EMAIL\"}" | j

MAGIC_LINK_HREF="$(curl -sf "$BUS/admin/dev-outbox?limit=1" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -c \
'import json,sys; captures=json.load(sys.stdin).get("captures", []); assert captures, "no dev outbox capture"; print(captures[0]["href"])')"
MAGIC_LINK_TOKEN="$(python3 -c \
'import sys, urllib.parse as u; fragment=u.urlsplit(sys.argv[1]).fragment; assert fragment.startswith("token="), "missing token fragment"; print(u.unquote(fragment.split("=",1)[1]))' \
  "$MAGIC_LINK_HREF")"
curl -sfD "$CONSUME_HEADERS" -o "$CONSUME_BODY" -X POST "$BUS/api/v1/auth/magic-link/consume" \
  -H "Origin: $APP_ORIGIN" -H 'content-type: application/json' \
  -d "{\"token\":\"$MAGIC_LINK_TOKEN\"}"
OWNER_COOKIE="$(python3 -c \
'import pathlib, sys; header=next((line.split(":",1)[1].strip() for line in pathlib.Path(sys.argv[1]).read_text().splitlines() if line.lower().startswith("set-cookie:")), ""); assert header, "missing session cookie"; print(header.split(";",1)[0])' \
  "$CONSUME_HEADERS")"
OWNER_CSRF="$(python3 -c \
'import json, sys; print(json.load(open(sys.argv[1]))["csrf_token"])' "$CONSUME_BODY")"
cleanup_session_files
trap - EXIT

# 3. app users (steady-state office session) ---------------------------------
step "provisioning ops and field users via owner session + csrf"
provision_session() {
  curl -sf -X POST "$BUS/api/v1/admin/app-users" \
    -H "Cookie: $OWNER_COOKIE" -H "X-CSRF-Token: $OWNER_CSRF" -H "Origin: $APP_ORIGIN" \
    -H 'content-type: application/json' \
    -d "$1" | j
}
provision_session '{"tenant_id":"ironwrap","email":"ops@ironwrap.local","display_name":"Olivia Ops","role":"ops","active":true}'
provision_session '{"tenant_id":"ironwrap","email":"crew@ironwrap.local","display_name":"Cody Crew","role":"field","frappe_user_id":"crew@ironwrap.local","active":true}'

# 4. synthetic leads (both brands) -------------------------------------------
step "ingesting synthetic website leads (IronWrap + iRoof Alberta)"
ingest() {
  curl -sf -X POST "$BUS/ingest/website" \
    -H "Authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
    -d "$1" | j
}
ingest '{"brand":"IronWrap","name":"Synthetic Homeowner A","email":"customer-a@example.invalid","phone":"+1-780-555-0101","address":"100 Example Ave, Edmonton, AB","message":"Metal roof quote for a 1,900 sq ft bungalow. Current shingles are 18 years old.","source_page":"https://ironwrapexteriors.com/metal-roofing","service_intent":"metal_roofing","external_id":"local-seed-iw-001"}'
ingest '{"brand":"iRoof Alberta","name":"Synthetic Homeowner B","email":"customer-b@example.invalid","phone":"+1-780-555-0102","address":"200 Example Ave, Edmonton, AB","message":"Asphalt re-roof, garage included. Please call after 5pm.","source_page":"https://iroofalberta.ca/roof-replacement","service_intent":"roofing","external_id":"local-seed-ir-001"}'

# 5. estimator session --------------------------------------------------------
step "ingesting synthetic estimate session"
curl -sf -X POST "$BUS/ingest/estimate" \
  -H "Authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"brand":"IronWrap","project_key":"local-seed-proj-001","name":"Synthetic Homeowner A","email":"customer-a@example.invalid","phone":"+1-780-555-0101","address":"100 Example Ave, Edmonton, AB","services":[{"service":"metal_roofing","quantity":22.5,"unit":"squares"}],"totals":{"subtotal_cad":41250,"total_cad":43312.5},"raw":{"profile":"standing-seam-24ga","colour":"charcoal"}}' | j

# 6. measurement intake (sanitized synthetic AppliCad fixture) ----------------
step "ingesting synthetic AppliCad measurement fixture"
XML_FILE="$REPO_ROOT/tools/fixtures/synthetic-applicad-roof.xml"
if [ -f "$XML_FILE" ]; then
  python3 - "$XML_FILE" > /tmp/ironwrap-measurement-payload.json <<'PYEOF'
import json, sys
xml = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace')
print(json.dumps({
    "brand": "IronWrap",
    "provider": "applicad",
    "external_id": "local-seed-meas-001",
    "name": "Synthetic Homeowner A", "email": "customer-a@example.invalid",
    "phone": "+1-780-555-0101", "address": "100 Example Ave, Edmonton, AB",
    "filename": "synthetic-applicad-roof.xml",
    "content_type": "text/xml",
    "content": xml,
}))
PYEOF
  curl -sf -X POST "$BUS/ingest/measurement" \
    -H "Authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
    --data-binary @/tmp/ironwrap-measurement-payload.json | j
else
  echo "sample XML missing: $XML_FILE"
fi

# 7. verify landing ------------------------------------------------------------
step "D1 envelopes (latest 5)"
curl -sf "$BUS/admin/envelopes?limit=5" -H "Authorization: Bearer $ADMIN_TOKEN" | j

step "Frappe Lead Envelope rows"
curl -sf -H "Authorization: token $FKEY:$FSECRET" \
  "$FRAPPE/api/resource/Lead%20Envelope?limit_page_length=5" | j

step "Frappe Instant Estimate Session rows"
curl -sf -H "Authorization: token $FKEY:$FSECRET" \
  "$FRAPPE/api/resource/Instant%20Estimate%20Session?limit_page_length=5" | j

step "done - local seed complete"
