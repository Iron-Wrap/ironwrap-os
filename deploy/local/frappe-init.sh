#!/bin/bash
# IronWrap OS local Frappe provisioner (idempotent).
# Runs once per fresh bench-home volume; safe to re-run (skips completed steps).
#
# The container starts as root only so the fresh named volume can be chowned to
# the frappe user; the real provisioning re-executes this script as uid 1000.
if [ "$(id -u)" = "0" ]; then
  chown -R frappe:frappe /home/frappe/frappe-bench
  exec runuser -u frappe -- /bin/bash /usr/local/bin/ironwrap-frappe-init
fi

set -euo pipefail

BENCH_DIR=/home/frappe/frappe-bench
SITE="${SITE_NAME:-ironwrap.localhost}"
ADMIN_PW="${ADMIN_PASSWORD:-ironwrap-local-admin}"
DB_ROOT_PW="${DB_ROOT_PASSWORD:-ironwrap-local-dbroot}"
FRAPPE_BRANCH="${FRAPPE_VERSION:-v15.114.0}"
APP_SRC=/opt/ironwrap_roofing
APP_DEST="$BENCH_DIR/apps/ironwrap_roofing"
STAMP="$BENCH_DIR/sites/.ironwrap_init_done"
# Written by a resync so `predev.mjs` knows the running bench is serving code it
# loaded before the resync and has to be restarted.  The marker lives in the
# volume, not in this process, because the restart happens outside it.
RESYNC_MARKER="$BENCH_DIR/sites/.ironwrap_app_resync_pending"
# on: resync a drifted bench copy (default).  off: refuse to boot on drift.
# force: resync unconditionally, even when the hashes already agree.
APP_RESYNC="${IRONWRAP_LOCAL_APP_RESYNC:-on}"

log() { printf '\n\033[1;34m[ironwrap-init]\033[0m %s\n' "$*"; }
loud() {
  printf '\n\033[1;33m========================================================================\033[0m\n'
  printf '\033[1;33m[ironwrap-init] %s\033[0m\n' "$*"
  printf '\033[1;33m========================================================================\033[0m\n'
}

# Every bounded capture rail refuses to run until its issuer is pinned in the
# site config, so a key that shipped in the app but never reached this function
# leaves that rail dead on a freshly provisioned site (fleet capture did,
# IRO-54).  `tools/validate-site-config-pins.mjs` fails CI when a new key skips
# it, and the pins are re-applied on every start so a volume provisioned before
# a rail shipped heals itself instead of staying dead until it is destroyed.
#
# The field-evidence, fleet-capture, work-package and production-gate-clearance
# rails are all issued by the Worker BFF, which authenticates with the single
# ERPNEXT_API_KEY/SECRET pair, so all four pin the same integration user created
# in step 8.  The customer
# acceptance, QuickBooks and Facet-design-projection rails hold their own
# least-privilege identities and their own key pairs.
pin_service_identities() {
  log "pinning Worker BFF and service issuer site config"
  bench --site "$SITE" set-config ironwrap_field_evidence_issuer_user ironwrap-bus@ironwrap.local
  bench --site "$SITE" set-config ironwrap_fleet_capture_issuer_user ironwrap-bus@ironwrap.local
  bench --site "$SITE" set-config ironwrap_work_package_issuer_user ironwrap-bus@ironwrap.local
  bench --site "$SITE" set-config ironwrap_production_gate_issuer_user ironwrap-bus@ironwrap.local
  bench --site "$SITE" set-config ironwrap_customer_acceptance_service_user ironwrap-customer-acceptance@ironwrap.local
  bench --site "$SITE" set-config ironwrap_customer_decision_service_user ironwrap-customer-decision@ironwrap.local
  bench --site "$SITE" set-config ironwrap_quickbooks_reconciliation_issuer_user ironwrap-quickbooks-issuer@ironwrap.local
  bench --site "$SITE" set-config ironwrap_facet_design_projection_service_user ironwrap-facet-projection@ironwrap.local
  pin_tenant_constants
}

# RETIREMENT (IRO-195 / ELEC-115 Path A): compatibility-projection era, superseded by
# IRO-195's D1-native acceptance transition; delete with the producer that reads these.
#
# A Roof Job may not reach `Won` without a workflow profile and the locale-policy pair
# (`domain_policy._validate_roof_job`), and nothing in the product produced any of the
# three, so step 6 of the core workflow was structurally unreachable (ELEC-112).  They
# are tenant reference constants rather than per-job facts, so they are pinned here
# exactly like the service identities above; a real tenant pins its own blessed values
# per docs/WHITE-LABEL-CLONE-PLAYBOOK.md, and an unpinned site fails its acceptance
# closed rather than stamping a jurisdiction fact nobody blessed.  These values are the
# LOCAL DEVELOPMENT stand-ins for Edmonton/Alberta, not legal advice.
pin_tenant_constants() {
  log "pinning tenant workflow-profile and locale-policy constants"
  bench --site "$SITE" set-config ironwrap_default_workflow_profile "Residential Retail"
  bench --site "$SITE" set-config ironwrap_locale_policy_version "ca-ab-local-dev"
  bench --site "$SITE" set-config ironwrap_locale_policy_snapshot_json \
    '{"country":"CA","province":"AB","source":"local-development-stand-in"}'
}

# The bench runs a COPY of the app (pip editable install of the copy), not the
# repo mount, so a volume that survives a code change keeps serving whatever the
# copy held when it was made.  ELEC-95 lost a capstone traverse to exactly that:
# a seven-hour-old volume was missing a Role that had shipped hours earlier, with
# nothing in the boot output saying so.  Hashing both trees with the same filter
# turns that silence into a comparison the fast path can make on every start.
#
# The filter mirrors the tar excludes in `sync_app_source`, so a clean copy hashes
# identical to its source; anything else is real drift (stale volume, or a file
# hand-copied into the bench during debugging).
app_tree_hash() {
  local root="$1"
  [ -d "$root" ] || { echo "missing"; return 0; }
  (
    cd "$root" &&
      find . -type f \
        -not -path '*/__pycache__/*' -not -name '*.pyc' \
        -not -path './.git/*' -not -path '*.egg-info/*' \
        -not -path './build/*' -not -path './dist/*' -not -path '*/.pytest_cache/*' \
        -print0 |
      LC_ALL=C sort -z |
      xargs -0 -r sha256sum |
      sha256sum |
      cut -c1-64
  )
}

# Destructive on purpose: a plain overlay copy never removes a file the repo
# deleted, so the bench copy could never converge back onto the source hash.
sync_app_source() {
  rm -rf "$APP_DEST"
  mkdir -p "$APP_DEST"
  (cd "$APP_SRC" && tar cf - \
    --exclude '__pycache__' --exclude '*.pyc' --exclude '.pytest_cache' \
    --exclude 'build' --exclude 'dist' --exclude '*.egg-info' .) | (cd "$APP_DEST" && tar xf -)
  ./env/bin/pip install --quiet --disable-pip-version-check -e "apps/ironwrap_roofing"
}

# Broker actor identities.  Unlike the least-privilege service identities below,
# each of these is the local stand-in for a human operator login a broker process
# authenticates as: `attestFrappeServicePrincipal` refuses to start a broker whose
# API token resolves to any user other than its configured HERMES_ACTOR_USER
# (`mcp/erpnext-roofing-mcp/src/server.mjs`, frappe_service_principal_mismatch).
# Before this existed, `deploy/*-approval-broker.env.example` named actors nothing
# provisioned, so steps 5 and 6 of the six-step workflow could only be reached by
# hand-creating users first (ELEC-95 process risk 3).
provision_broker_identity() {
  local email="$1" first_name="$2" creds_file="$3"
  local target="$BENCH_DIR/sites/$SITE/$creds_file"
  if [ -s "$target" ] && grep -q '^{' "$target" 2>/dev/null; then return 0; fi
  log "creating broker actor identity $email with API keys"
  bench --site "$SITE" console > "/tmp/${creds_file#.}_raw.json" <<PYEOF
import frappe, json
email = "$email"
if not frappe.db.exists("User", email):
    u = frappe.get_doc({"doctype": "User", "email": email, "first_name": "$first_name",
                        "send_welcome_email": 0, "roles": [{"role": "System Manager"}]})
    u.insert(ignore_permissions=True)
frappe.core.doctype.user.user.generate_keys(email)
u = frappe.get_doc("User", email)
frappe.db.commit()
print("CREDS:" + json.dumps({"api_key": u.api_key or "", "api_secret": u.get_password("api_secret") or ""}))
PYEOF
  grep -o 'CREDS:{.*}' "/tmp/${creds_file#.}_raw.json" | sed 's/^CREDS://' > "$target"
}

# The approver the brokers name in every receipt (HERMES_APPROVER_ID) and the
# crew login the field surfaces use.  Neither holds broker credentials; they only
# have to exist as real users for the approval and BFF paths to resolve them.
#
# They also need their IronWrap *business* roles, not just System Manager.  A
# bounded office command checks the domain role `access_control` grants the
# authority to - `work_package_api` release wants IronWrap Owner or Production,
# and so does the ELEC-122 production-gate clearance - and System Manager is a
# platform role, not a business one.  Without this the documented local owner
# login cannot clear a scheduling gate on a fresh site: the rail ships dead, the
# same failure shape IRO-54 hit with an unpinned issuer.  Runs on every start so
# a volume provisioned before this line heals itself.
provision_operator_users() {
  log "ensuring owner-approver and crew operator users and their IronWrap roles"
  bench --site "$SITE" console >/dev/null <<'PYEOF'
import frappe
for email, first_name, ironwrap_role in [
    ("owner@ironwrap.local", "Owner Approver", "IronWrap Owner"),
    ("crew@ironwrap.local", "Field Crew", "IronWrap Field"),
]:
    if not frappe.db.exists("User", email):
        frappe.get_doc({"doctype": "User", "email": email, "first_name": first_name,
                        "send_welcome_email": 0,
                        "roles": [{"role": "System Manager"}]}).insert(ignore_permissions=True)
    if ironwrap_role not in set(frappe.get_roles(email)):
        user = frappe.get_doc("User", email)
        user.append("roles", {"role": ironwrap_role})
        user.save(ignore_permissions=True)
frappe.db.commit()
PYEOF
}

provision_broker_identities() {
  provision_operator_users
  provision_broker_identity lead-concierge@ironwrap.local "Lead Concierge" .lead_triage_broker_credentials
  provision_broker_identity estimator-assistant@ironwrap.local "Estimator Assistant" .quote_revision_broker_credentials
  provision_broker_identity production-controller@ironwrap.local "Production Controller" .production_schedule_broker_credentials
  provision_broker_identity owner-operator@ironwrap.local "Owner Operator" .proposal_publication_broker_credentials
}

cd "$BENCH_DIR" 2>/dev/null || { mkdir -p "$BENCH_DIR"; cd "$BENCH_DIR"; }

if [ -f "$STAMP" ]; then
  log "already provisioned ($STAMP present) - re-applying service identity pins"
  # A pin failure here must not take down a bench that was already serving:
  # report it loudly and leave the stack up.
  pin_service_identities || log "WARNING - could not re-apply service identity pins"
  provision_broker_identities || log "WARNING - could not provision broker actor identities"

  source_hash="$(app_tree_hash "$APP_SRC")"
  installed_hash="$(app_tree_hash "$APP_DEST")"
  if [ "$APP_RESYNC" != "force" ] && [ "$source_hash" = "$installed_hash" ]; then
    log "app source in sync (${source_hash:0:12}) - no resync needed"
    exit 0
  fi
  if [ "$APP_RESYNC" = "off" ]; then
    loud "REFUSING TO BOOT: this bench is serving STALE app code."
    echo "  repo  ${source_hash:0:12}  ($APP_SRC)"
    echo "  bench ${installed_hash:0:12}  ($APP_DEST)"
    echo "  Anything proven against this volume would be proven against the bench hash,"
    echo "  not the checkout you are testing. Resync with:"
    echo "    IRONWRAP_LOCAL_APP_RESYNC=on docker compose -f deploy/local/docker-compose.yml up -d frappe-init"
    exit 1
  fi
  if [ "$APP_RESYNC" = "force" ]; then
    loud "FORCED RESYNC requested (IRONWRAP_LOCAL_APP_RESYNC=force)"
  else
    loud "STALE VOLUME DETECTED: bench app code differs from the repo. Resyncing."
    echo "  repo  ${source_hash:0:12}  ($APP_SRC)"
    echo "  bench ${installed_hash:0:12}  ($APP_DEST)"
  fi
  sync_app_source
  log "bench migrate (applies DocType, Role and permission changes the resync brought in)"
  bench --site "$SITE" migrate
  pin_service_identities || log "WARNING - could not re-apply service identity pins after resync"
  touch "$RESYNC_MARKER"
  resynced_hash="$(app_tree_hash "$APP_DEST")"
  if [ "$resynced_hash" != "$source_hash" ]; then
    loud "RESYNC DID NOT CONVERGE: bench ${resynced_hash:0:12} still differs from repo ${source_hash:0:12}"
    exit 1
  fi
  loud "RESYNC COMPLETE - bench now runs repo revision ${source_hash:0:12}"
  exit 0
fi

# 1. bench init (Frappe framework, pinned branch) -----------------------------
if [ ! -d apps/frappe ]; then
  log "bench init --frappe-branch $FRAPPE_BRANCH (downloads Frappe; first run is slow)"
  bench init \
    --frappe-branch "$FRAPPE_BRANCH" \
    --frappe-path=https://github.com/frappe/frappe.git \
    --no-procfile \
    --no-backups \
    --skip-redis-config-generation \
    --ignore-exist \
    "$BENCH_DIR"
fi

# 2. wire infra ---------------------------------------------------------------
log "writing common_site_config.json (mariadb + redis containers)"
cat > sites/common_site_config.json <<EOF
{
  "db_host": "mariadb",
  "db_port": 3306,
  "redis_cache": "redis://redis-cache:6379",
  "redis_queue": "redis://redis-queue:6379",
  "developer_mode": 1,
  "server_script_enabled": 0,
  "mute_emails": 1,
  "mail_server": "",
  "allow_tests": 1
}
EOF

# 3. install the proprietary app into the bench env ---------------------------
if ! grep -q '^ironwrap_roofing$' sites/apps.txt 2>/dev/null; then
  log "installing ironwrap_roofing app into bench (editable, from repo mount)"
  sync_app_source
fi
# apps.txt is written canonically (bench init may leave no trailing newline, so appending
# would glue names together).
printf 'frappe\nironwrap_roofing\n' > sites/apps.txt

# 4. create the site ----------------------------------------------------------
if [ ! -d "sites/$SITE" ]; then
  log "bench new-site $SITE"
  bench new-site "$SITE" \
    --mariadb-root-username root \
    --mariadb-root-password "$DB_ROOT_PW" \
    --admin-password "$ADMIN_PW" \
    --no-mariadb-socket
fi

# 5. install the app on the site (runs install.py hooks + DocType sync) -------
if ! bench --site "$SITE" list-apps 2>/dev/null | grep -q ironwrap_roofing; then
  log "installing ironwrap_roofing on $SITE (committed DocTypes and policy hooks)"
  bench --site "$SITE" install-app ironwrap_roofing
fi

# 6. build assets (desk UI) ---------------------------------------------------
if [ ! -f sites/.assets-built ]; then
  log "bench build (first build is slow)"
  bench build || log "WARN: bench build failed - REST API still works; desk assets degraded"
  touch sites/.assets-built
fi

# 6b. Procfile for `bench start` (bench init was --no-procfile; redis lives in
# sibling containers, so the Procfile carries only bench-managed processes) ----
if [ ! -f Procfile ]; then
  printf 'web: bench serve --port 8000\nschedule: bench schedule\nworker: bench worker --queue short,default,long\n' > Procfile
fi

# 7. localhost site alias (Frappe v15 resolves sites strictly by Host header;
# local callers reach http://localhost:8000, which must map to the one site) ----
ln -sfn "$SITE" "sites/localhost"

# 8. integration user + API keys for the Worker BFF ---------------------------
if [ ! -s "sites/$SITE/.integration_credentials" ] || ! grep -q '^{' "sites/$SITE/.integration_credentials"; then
  log "creating Worker integration user with API keys"
  bench --site "$SITE" console > /tmp/integration_raw.json <<'PYEOF'
import frappe, json
email = "ironwrap-bus@ironwrap.local"
if not frappe.db.exists("User", email):
    u = frappe.get_doc({"doctype": "User", "email": email, "first_name": "IronWrap Bus",
                        "send_welcome_email": 0, "roles": [{"role": "System Manager"}]})
    u.insert(ignore_permissions=True)
keys = frappe.core.doctype.user.user.generate_keys(email)
u = frappe.get_doc("User", email)
frappe.db.commit()
print("CREDS:" + json.dumps({"api_key": u.api_key or "", "api_secret": u.get_password("api_secret") or ""}))
PYEOF
  grep -o 'CREDS:{.*}' /tmp/integration_raw.json | sed 's/^CREDS://' > "sites/$SITE/.integration_credentials"
fi

# 9. dedicated customer-acceptance service identity ----------------------------
if [ ! -s "sites/$SITE/.customer_acceptance_credentials" ] || ! grep -q '^{' "sites/$SITE/.customer_acceptance_credentials"; then
  log "creating scoped customer-acceptance service user with API keys"
  bench --site "$SITE" console > /tmp/customer_acceptance_raw.json <<'PYEOF'
import frappe, json
email = "ironwrap-customer-acceptance@ironwrap.local"
role = "IronWrap Customer Acceptance Service"
if not frappe.db.exists("User", email):
    u = frappe.get_doc({"doctype": "User", "email": email, "first_name": "Customer Acceptance Service",
                        "send_welcome_email": 0, "roles": [{"role": role}]})
    u.insert(ignore_permissions=True)
else:
    u = frappe.get_doc("User", email)
    if role not in {entry.role for entry in u.roles}:
        u.append("roles", {"role": role})
        u.save(ignore_permissions=True)
frappe.core.doctype.user.user.generate_keys(email)
u = frappe.get_doc("User", email)
frappe.db.commit()
print("CREDS:" + json.dumps({"api_key": u.api_key or "", "api_secret": u.get_password("api_secret") or ""}))
PYEOF
  grep -o 'CREDS:{.*}' /tmp/customer_acceptance_raw.json | sed 's/^CREDS://' > "sites/$SITE/.customer_acceptance_credentials"
fi

# 9b. dedicated customer material-decision service identity --------------------
# Separate from the acceptance identity above: this one may record a provisional
# customer preference and its receipt evidence, and can never sign a contract.
if [ ! -s "sites/$SITE/.customer_decision_credentials" ] || ! grep -q '^{' "sites/$SITE/.customer_decision_credentials"; then
  log "creating scoped customer-decision service user with API keys"
  bench --site "$SITE" console > /tmp/customer_decision_raw.json <<'PYEOF'
import frappe, json
email = "ironwrap-customer-decision@ironwrap.local"
role = "IronWrap Customer Decision Service"
if not frappe.db.exists("User", email):
    u = frappe.get_doc({"doctype": "User", "email": email, "first_name": "Customer Decision Service",
                        "send_welcome_email": 0, "roles": [{"role": role}]})
    u.insert(ignore_permissions=True)
else:
    u = frappe.get_doc("User", email)
    if role not in {entry.role for entry in u.roles}:
        u.append("roles", {"role": role})
        u.save(ignore_permissions=True)
frappe.core.doctype.user.user.generate_keys(email)
u = frappe.get_doc("User", email)
frappe.db.commit()
print("CREDS:" + json.dumps({"api_key": u.api_key or "", "api_secret": u.get_password("api_secret") or ""}))
PYEOF
  grep -o 'CREDS:{.*}' /tmp/customer_decision_raw.json | sed 's/^CREDS://' > "sites/$SITE/.customer_decision_credentials"
fi

# 10. dedicated QuickBooks reconciliation issuer ------------------------------
if [ ! -s "sites/$SITE/.quickbooks_reconciliation_issuer_credentials" ] || ! grep -q '^{' "sites/$SITE/.quickbooks_reconciliation_issuer_credentials"; then
  log "creating least-privilege QuickBooks reconciliation issuer with API keys"
  bench --site "$SITE" console > /tmp/quickbooks_reconciliation_issuer_raw.json <<'PYEOF'
import frappe, json
email = "ironwrap-quickbooks-issuer@ironwrap.local"
role = "IronWrap QuickBooks Reconciliation Issuer"
if not frappe.db.exists("User", email):
    u = frappe.get_doc({"doctype": "User", "email": email, "first_name": "QuickBooks Reconciliation Issuer",
                        "send_welcome_email": 0, "roles": [{"role": role}]})
    u.insert(ignore_permissions=True)
else:
    u = frappe.get_doc("User", email)
    if role not in {entry.role for entry in u.roles}:
        u.append("roles", {"role": role})
        u.save(ignore_permissions=True)
frappe.core.doctype.user.user.generate_keys(email)
u = frappe.get_doc("User", email)
frappe.db.commit()
print("CREDS:" + json.dumps({"api_key": u.api_key or "", "api_secret": u.get_password("api_secret") or ""}))
PYEOF
  grep -o 'CREDS:{.*}' /tmp/quickbooks_reconciliation_issuer_raw.json | sed 's/^CREDS://' > "sites/$SITE/.quickbooks_reconciliation_issuer_credentials"
fi

# 10b. dedicated Facet design projection service identity ----------------------
# The Worker projects an approved Facet v2 design decision into a blank Draft
# Customer Quote through ironwrap_roofing.facet_design_projection_api, which
# refuses any actor that is not the pinned service user holding the
# `IronWrap Facet Design Projection Service` role.  Without this identity the
# whole Facet ingest -> projection chain is unreachable on a local stack.
if [ ! -s "sites/$SITE/.facet_design_projection_credentials" ] || ! grep -q '^{' "sites/$SITE/.facet_design_projection_credentials"; then
  log "creating scoped Facet design projection service user with API keys"
  bench --site "$SITE" console > /tmp/facet_design_projection_raw.json <<'PYEOF'
import frappe, json
email = "ironwrap-facet-projection@ironwrap.local"
role = "IronWrap Facet Design Projection Service"
if not frappe.db.exists("User", email):
    u = frappe.get_doc({"doctype": "User", "email": email, "first_name": "Facet Design Projection Service",
                        "send_welcome_email": 0, "roles": [{"role": role}]})
    u.insert(ignore_permissions=True)
else:
    u = frappe.get_doc("User", email)
    if role not in {entry.role for entry in u.roles}:
        u.append("roles", {"role": role})
        u.save(ignore_permissions=True)
frappe.core.doctype.user.user.generate_keys(email)
u = frappe.get_doc("User", email)
frappe.db.commit()
print("CREDS:" + json.dumps({"api_key": u.api_key or "", "api_secret": u.get_password("api_secret") or ""}))
PYEOF
  grep -o 'CREDS:{.*}' /tmp/facet_design_projection_raw.json | sed 's/^CREDS://' > "sites/$SITE/.facet_design_projection_credentials"
fi

# 10c. broker actor identities --------------------------------------------------
provision_broker_identities

# 11. pinned service identities -------------------------------------------------
pin_service_identities

touch "$STAMP"
log "DONE - site '$SITE' ready (admin: Administrator / $ADMIN_PW)"
cat "sites/$SITE/.integration_credentials" 2>/dev/null || true
