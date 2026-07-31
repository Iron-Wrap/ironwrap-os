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
STAMP="$BENCH_DIR/sites/.ironwrap_init_done"

log() { printf '\n\033[1;34m[ironwrap-init]\033[0m %s\n' "$*"; }

cd "$BENCH_DIR" 2>/dev/null || { mkdir -p "$BENCH_DIR"; cd "$BENCH_DIR"; }

if [ -f "$STAMP" ]; then
  log "already provisioned ($STAMP present) - nothing to do"
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
  mkdir -p apps/ironwrap_roofing
  (cd "$APP_SRC" && tar cf - \
    --exclude '__pycache__' --exclude '*.pyc' --exclude '.pytest_cache' \
    --exclude 'build' --exclude 'dist' --exclude '*.egg-info' .) | (cd apps/ironwrap_roofing && tar xf -)
  ./env/bin/pip install --quiet --disable-pip-version-check -e "apps/ironwrap_roofing"
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

# 11. pinned service identities -------------------------------------------------
log "pinning field-evidence issuer site config"
bench --site "$SITE" set-config ironwrap_field_evidence_issuer_user ironwrap-bus@ironwrap.local
bench --site "$SITE" set-config ironwrap_customer_acceptance_service_user ironwrap-customer-acceptance@ironwrap.local
bench --site "$SITE" set-config ironwrap_quickbooks_reconciliation_issuer_user ironwrap-quickbooks-issuer@ironwrap.local

touch "$STAMP"
log "DONE - site '$SITE' ready (admin: Administrator / $ADMIN_PW)"
cat "sites/$SITE/.integration_credentials" 2>/dev/null || true
