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

# 1. app users ---------------------------------------------------------------
step "provisioning app users (owner / ops / field)"
provision() {
  curl -sf -X POST "$BUS/admin/app-users" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
    -d "$1" | j
}
provision '{"tenant_id":"ironwrap","email":"owner@ironwrap.local","display_name":"Ilia Owner","role":"owner","active":true,"provisioned_by":"local-seed"}'
provision '{"tenant_id":"ironwrap","email":"ops@ironwrap.local","display_name":"Olivia Ops","role":"ops","active":true,"provisioned_by":"local-seed"}'
provision '{"tenant_id":"ironwrap","email":"crew@ironwrap.local","display_name":"Cody Crew","role":"field","frappe_user_id":"crew@ironwrap.local","active":true,"provisioned_by":"local-seed"}'

# 2. synthetic leads (both brands) -------------------------------------------
step "ingesting synthetic website leads (IronWrap + iRoof Alberta)"
ingest() {
  curl -sf -X POST "$BUS/ingest/website" \
    -H "Authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
    -d "$1" | j
}
ingest '{"brand":"IronWrap","name":"Synthetic Homeowner A","email":"customer-a@example.invalid","phone":"+1-780-555-0101","address":"100 Example Ave, Edmonton, AB","message":"Metal roof quote for a 1,900 sq ft bungalow. Current shingles are 18 years old.","source_page":"https://ironwrapexteriors.com/metal-roofing","service_intent":"metal_roofing","external_id":"local-seed-iw-001"}'
ingest '{"brand":"iRoof Alberta","name":"Synthetic Homeowner B","email":"customer-b@example.invalid","phone":"+1-780-555-0102","address":"200 Example Ave, Edmonton, AB","message":"Asphalt re-roof, garage included. Please call after 5pm.","source_page":"https://iroofalberta.ca/roof-replacement","service_intent":"roofing","external_id":"local-seed-ir-001"}'

# 3. estimator session --------------------------------------------------------
step "ingesting synthetic estimate session"
curl -sf -X POST "$BUS/ingest/estimate" \
  -H "Authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"brand":"IronWrap","project_key":"local-seed-proj-001","name":"Synthetic Homeowner A","email":"customer-a@example.invalid","phone":"+1-780-555-0101","address":"100 Example Ave, Edmonton, AB","services":[{"service":"metal_roofing","quantity":22.5,"unit":"squares"}],"totals":{"subtotal_cad":41250,"total_cad":43312.5},"raw":{"profile":"standing-seam-24ga","colour":"charcoal"}}' | j

# 4. measurement intake (sanitized synthetic AppliCad fixture) ----------------
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

# 5. verify landing ------------------------------------------------------------
step "D1 envelopes (latest 5)"
curl -sf "$BUS/admin/envelopes?limit=5" -H "Authorization: Bearer $ADMIN_TOKEN" | j

step "Frappe Lead Envelope rows"
curl -sf -H "Authorization: token $FKEY:$FSECRET" \
  "$FRAPPE/api/resource/Lead%20Envelope?limit_page_length=5" | j

step "Frappe Instant Estimate Session rows"
curl -sf -H "Authorization: token $FKEY:$FSECRET" \
  "$FRAPPE/api/resource/Instant%20Estimate%20Session?limit_page_length=5" | j

step "done - local seed complete"
