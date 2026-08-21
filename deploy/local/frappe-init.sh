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
DEFAULT_SITE=ironwrap.localhost
SITE="${SITE_NAME:-$DEFAULT_SITE}"
ADMIN_PW="${ADMIN_PASSWORD:-ironwrap-local-admin}"
DB_ROOT_PW="${DB_ROOT_PASSWORD:-ironwrap-local-dbroot}"
FRAPPE_BRANCH="${FRAPPE_VERSION:-v15.114.0}"
APP_SRC=/opt/ironwrap_roofing
APP_DEST="$BENCH_DIR/apps/ironwrap_roofing"
# Local stand-in domain for this site's non-interactive identities.  One Frappe site per
# contractor is the isolation unit (docs/WHITE-LABEL-CLONE-PLAYBOOK.md), so a cloned tenant
# provisions its OWN users on its own domain: the playbook forbids a tenant's Worker vars
# from naming another tenant's issuer identity, and ERPNEXT_INTEGRATION_USER /
# QB_RECONCILIATION_ISSUER_USER are exactly those names.  Default unchanged, so the single
# documented stack provisions byte-identical identities to before.
IDENTITY_DOMAIN="${IRONWRAP_LOCAL_IDENTITY_DOMAIN:-ironwrap.local}"
# Per SITE, not per bench.  A second tenant site shares this bench (one Frappe install, one
# app copy) but has its own database, its own users and its own provisioning run, so a
# bench-wide "done" marker would send the second site straight down the already-provisioned
# fast path and it would never be created at all.
STAMP="$BENCH_DIR/sites/.ironwrap_init_done.$SITE"
# Scratch for the `bench console` dumps the credential helpers below grep.  Namespaced by SITE
# and readable only by this user: each dump carries a freshly minted api_secret, and the path
# used to be a bench-wide /tmp name derived from the credential file alone.  Two sites
# provisioned through one container would then write and read the SAME file, and a rail could
# end up holding another site's credentials - the isolation this script exists to create,
# undone by a scratch path.  Safe until now only because clone-tenant.sh runs frappe-init as a
# fresh one-shot container per site, which is the invocation model's property rather than this
# script's (ELEC-143 finding 3).
SCRATCH_DIR="${TMPDIR:-/tmp}/ironwrap-frappe-init/$SITE"
# A bench provisioned before the marker was per-site carries the old bench-wide one.
LEGACY_STAMP="$BENCH_DIR/sites/.ironwrap_init_done"
# Which local domain a site's identities live on, recorded so a bench-wide resync can
# re-provision every site without being told again.
IDENTITY_DOMAIN_FILE="$BENCH_DIR/sites/$SITE/.ironwrap_identity_domain"
# Written by a resync so `predev.mjs` knows the running bench is serving code it
# loaded before the resync and has to be restarted.  The marker lives in the
# volume, not in this process, because the restart happens outside it.
RESYNC_MARKER="$BENCH_DIR/sites/.ironwrap_app_resync_pending"
# on: resync a drifted bench copy (default).  off: refuse to boot on drift.
# force: resync unconditionally, even when the hashes already agree.
APP_RESYNC="${IRONWRAP_LOCAL_APP_RESYNC:-on}"

log() { printf '\n\033[1;34m[ironwrap-init]\033[0m %s\n' "$*"; }
# A scratch path that belongs to THIS site and to this user only.
site_scratch() {
  mkdir -p "$SCRATCH_DIR"
  chmod 700 "$SCRATCH_DIR"
  printf '%s/%s' "$SCRATCH_DIR" "$1"
}
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
# The field-evidence and production-gate-clearance rails are issued by the Worker
# BFF with the single ERPNEXT_API_KEY/SECRET pair, so both pin the integration user
# created in step 8.  Every other rail - customer acceptance, customer decision,
# QuickBooks, Facet design projection, and (since ELEC-56) fleet capture and work
# package - holds its own least-privilege identity and its own key pair.
#
# Fleet capture and work package moved off the shared bus user because that pair is
# a System Manager: one leaked key reached both rails and the whole site rather than
# one rail's narrow grant (ELEC-48 audit section 3).  Re-pinning them here is also
# what REVOKES the old access - the app compares the session user against the pin,
# so the bus pair now fails these two rails closed with `*_issuer_auth_mismatch`.
pin_service_identities() {
  log "pinning Worker BFF and service issuer site config on $SITE ($IDENTITY_DOMAIN)"
  bench --site "$SITE" set-config ironwrap_field_evidence_issuer_user "ironwrap-bus@$IDENTITY_DOMAIN"
  bench --site "$SITE" set-config ironwrap_fleet_capture_issuer_user "ironwrap-fleet-capture@$IDENTITY_DOMAIN"
  bench --site "$SITE" set-config ironwrap_work_package_issuer_user "ironwrap-work-package@$IDENTITY_DOMAIN"
  bench --site "$SITE" set-config ironwrap_production_gate_issuer_user "ironwrap-bus@$IDENTITY_DOMAIN"
  bench --site "$SITE" set-config ironwrap_customer_decision_service_user "ironwrap-customer-decision@$IDENTITY_DOMAIN"
  bench --site "$SITE" set-config ironwrap_quickbooks_reconciliation_issuer_user "ironwrap-quickbooks-issuer@$IDENTITY_DOMAIN"
  bench --site "$SITE" set-config ironwrap_facet_design_projection_service_user "ironwrap-facet-projection@$IDENTITY_DOMAIN"
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
#
# Every key-minting block below imports `generate_keys` by name instead of reaching
# for `frappe.core.doctype.user.user.generate_keys`.  The dotted path is not a real
# attribute of `frappe.core.doctype` - it only resolves once something has imported
# the User controller module in THIS interpreter, which `frappe.get_doc` happens to
# do as a side effect.  Every caller here creates the user first, so the attribute
# was always there by accident.  The moment PR #106 added `owner@ironwrap.local`
# below - a user `provision_operator_users` has already created in a SEPARATE
# `bench console` subprocess - the create branch was skipped, nothing imported the
# controller, and the bare dotted reference raised
# `AttributeError: module 'frappe.core.doctype' has no attribute 'user'`, taking
# every fresh local checkout down on its first boot (ELEC-132 defect A).  An
# explicit import cannot depend on who ran before it.
provision_broker_identity() {
  local email="$1" first_name="$2" creds_file="$3"
  local target="$BENCH_DIR/sites/$SITE/$creds_file"
  local raw; raw="$(site_scratch "${creds_file#.}_raw.json")"
  if [ -s "$target" ] && grep -q '^{' "$target" 2>/dev/null; then return 0; fi
  log "creating broker actor identity $email with API keys"
  bench --site "$SITE" console > "$raw" <<PYEOF
import frappe, json
from frappe.core.doctype.user.user import generate_keys
email = "$email"
if not frappe.db.exists("User", email):
    u = frappe.get_doc({"doctype": "User", "email": email, "first_name": "$first_name",
                        "send_welcome_email": 0, "roles": [{"role": "System Manager"}]})
    u.insert(ignore_permissions=True)
generate_keys(email)
u = frappe.get_doc("User", email)
frappe.db.commit()
print("CREDS:" + json.dumps({"api_key": u.api_key or "", "api_secret": u.get_password("api_secret") or ""}))
PYEOF
  grep -o 'CREDS:{.*}' "$raw" | sed 's/^CREDS://' > "$target"
  # Only once the secret is safely in the site directory. A failed grep aborts under `set -e`
  # before this line, which is exactly when the raw dump is still worth reading.
  rm -f "$raw"
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
  bench --site "$SITE" console >/dev/null <<PYEOF
import frappe
for email, first_name, ironwrap_role in [
    ("owner@$IDENTITY_DOMAIN", "Owner Approver", "IronWrap Owner"),
    ("crew@$IDENTITY_DOMAIN", "Field Crew", "IronWrap Field"),
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

# One dedicated, least-privilege Frappe issuer for a bounded capture rail.  Same file and
# console pattern as `provision_broker_identity` above, but the role is a parameter and is
# never System Manager: that is the whole point of the split.
provision_rail_issuer() {
  local email="$1" first_name="$2" role="$3" creds_file="$4"
  local target="$BENCH_DIR/sites/$SITE/$creds_file"
  local raw; raw="$(site_scratch "${creds_file#.}_raw.json")"
  if [ -s "$target" ] && grep -q '^{' "$target" 2>/dev/null; then return 0; fi
  log "creating least-privilege rail issuer $email ($role) with API keys"
  bench --site "$SITE" console > "$raw" <<PYEOF
import frappe, json
from frappe.core.doctype.user.user import generate_keys
from ironwrap_roofing.install import ensure_roles
email = "$email"
role = "$role"
# A volume provisioned before this role shipped does not have it yet, and on the stale-volume
# path the bench migrate that would create it runs AFTER this.  ensure_roles is the app's own
# idempotent reconciliation, so calling it here makes provisioning independent of that ordering
# instead of leaving the user role-less and the rail dead.
ensure_roles()
if not frappe.db.exists("User", email):
    u = frappe.get_doc({"doctype": "User", "email": email, "first_name": "$first_name",
                        "send_welcome_email": 0, "roles": [{"role": role}]})
    u.insert(ignore_permissions=True)
else:
    u = frappe.get_doc("User", email)
    if role not in {entry.role for entry in u.roles}:
        u.append("roles", {"role": role})
        u.save(ignore_permissions=True)
generate_keys(email)
u = frappe.get_doc("User", email)
frappe.db.commit()
print("CREDS:" + json.dumps({"api_key": u.api_key or "", "api_secret": u.get_password("api_secret") or ""}))
PYEOF
  grep -o 'CREDS:{.*}' "$raw" | sed 's/^CREDS://' > "$target"
  # Only once the secret is safely in the site directory. A failed grep aborts under `set -e`
  # before this line, which is exactly when the raw dump is still worth reading.
  rm -f "$raw"
}

# The two rails Frappe already scopes per issuer but the Worker used to authenticate with the
# broad bus pair (ELEC-48 audit section 3).  Each identity holds only the grants its own
# `_assert_worker_issuer` checks: fleet capture may create Asset Inspection and Asset Defect
# and read Fleet Asset; work package may read Work Package and create Work Package Event.
# Neither can reach the other's DocTypes, and neither is a System Manager.
#
# Called from the already-provisioned fast path as well as the fresh path, and always BEFORE
# `pin_service_identities`: those pins name these users on every start, so a volume built
# before this shipped would otherwise be pinned to identities that do not exist - a dead rail
# wearing a green pin, the exact ELEC-40 shape this split exists to close.
provision_rail_issuer_identities() {
  provision_rail_issuer "ironwrap-fleet-capture@$IDENTITY_DOMAIN" \
    "Fleet Capture Issuer" "IronWrap Fleet Capture Issuer" .fleet_capture_issuer_credentials
  provision_rail_issuer "ironwrap-work-package@$IDENTITY_DOMAIN" \
    "Work Package Issuer" "IronWrap Work Package Issuer" .work_package_issuer_credentials
  # The other four bounded rails have the same shape: one non-interactive user, one
  # least-privilege role, one key pair, one site-config pin.  They used to be four
  # copies of the same console heredoc with the identity spelled out in each, which is
  # why they could not follow a tenant's own domain.
  provision_rail_issuer "ironwrap-customer-acceptance@$IDENTITY_DOMAIN" \
    "Customer Acceptance Service" "IronWrap Customer Acceptance Service" .customer_acceptance_credentials
  provision_rail_issuer "ironwrap-customer-decision@$IDENTITY_DOMAIN" \
    "Customer Decision Service" "IronWrap Customer Decision Service" .customer_decision_credentials
  provision_rail_issuer "ironwrap-quickbooks-issuer@$IDENTITY_DOMAIN" \
    "QuickBooks Reconciliation Issuer" "IronWrap QuickBooks Reconciliation Issuer" \
    .quickbooks_reconciliation_issuer_credentials
  provision_rail_issuer "ironwrap-facet-projection@$IDENTITY_DOMAIN" \
    "Facet Design Projection Service" "IronWrap Facet Design Projection Service" \
    .facet_design_projection_credentials
}

provision_broker_identities() {
  provision_operator_users
  # The owner needs API keys, not just a login. Seeding a Verified Authority Record -
  # which every #105 release gate now requires - must be done as a holder of
  # `IronWrap Owner`; `ironwrap-bus@ironwrap.local`, the Worker's own least-privilege
  # integration identity, deliberately does not hold it and must not be widened to.
  # Before this, the only way to act as the owner over REST was to mint a key by hand
  # in a bench console (ELEC-128 run notes). Same file pattern as the broker actors, so
  # `predev`/runbook readers find it where they already look.
  provision_broker_identity "owner@$IDENTITY_DOMAIN" "Owner Approver" .owner_operator_credentials
  provision_broker_identity "lead-concierge@$IDENTITY_DOMAIN" "Lead Concierge" .lead_triage_broker_credentials
  provision_broker_identity "estimator-assistant@$IDENTITY_DOMAIN" "Estimator Assistant" .quote_revision_broker_credentials
  provision_broker_identity "production-controller@$IDENTITY_DOMAIN" "Production Controller" .production_schedule_broker_credentials
  provision_broker_identity "owner-operator@$IDENTITY_DOMAIN" "Owner Operator" .proposal_publication_broker_credentials
  # The Worker BFF's own integration identity.  A System Manager on purpose: it is the
  # single pair the field-evidence and production-gate rails authenticate with, which is
  # exactly why the six rails above hold their own narrower ones instead.
  provision_broker_identity "ironwrap-bus@$IDENTITY_DOMAIN" "IronWrap Bus" .integration_credentials
}

cd "$BENCH_DIR" 2>/dev/null || { mkdir -p "$BENCH_DIR"; cd "$BENCH_DIR"; }

# A bench provisioned before the marker became per-site has the bench-wide one and only the
# default site.  Adopt it once rather than re-running the whole fresh path on a working bench.
if [ -f "$LEGACY_STAMP" ] && [ "$SITE" = "$DEFAULT_SITE" ] && [ ! -f "$STAMP" ]; then
  log "adopting the pre-per-site marker for $SITE"
  mv "$LEGACY_STAMP" "$STAMP"
  [ -f "$IDENTITY_DOMAIN_FILE" ] || printf '%s\n' "$IDENTITY_DOMAIN" > "$IDENTITY_DOMAIN_FILE"
fi

# Every site this bench has already provisioned, newest marker last.  The app copy is
# bench-wide, so a resync changes the code under ALL of them, not just the one that
# triggered it.
provisioned_sites() {
  local marker
  for marker in "$BENCH_DIR/sites/".ironwrap_init_done.*; do
    [ -e "$marker" ] || continue
    printf '%s\n' "${marker##*.ironwrap_init_done.}"
  done
}

# Re-run one site's identity provisioning and pins on the domain that site was built with.
# `IDENTITY_DOMAIN` is global by design (every helper reads it), so this saves and restores it.
reprovision_site() {
  local site="$1" saved_site="$SITE" saved_domain="$IDENTITY_DOMAIN"
  SITE="$site"
  if [ -s "$BENCH_DIR/sites/$site/.ironwrap_identity_domain" ]; then
    IDENTITY_DOMAIN="$(cat "$BENCH_DIR/sites/$site/.ironwrap_identity_domain")"
  fi
  provision_rail_issuer_identities || log "WARNING - could not provision rail issuer identities on $site"
  provision_broker_identities || log "WARNING - could not provision broker actor identities on $site"
  pin_service_identities || log "WARNING - could not re-apply service identity pins on $site"
  SITE="$saved_site"
  IDENTITY_DOMAIN="$saved_domain"
}

if [ -f "$STAMP" ]; then
  log "already provisioned ($STAMP present) - re-applying service identity pins"
  # A pin failure here must not take down a bench that was already serving:
  # report it loudly and leave the stack up.
  reprovision_site "$SITE"

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
  # Every provisioned site, not just this run's: the app copy is bench-wide, so a site that
  # did not trigger the resync would otherwise keep serving DocType metadata for code that no
  # longer exists on disk - stale in the one way the hash comparison above cannot see.
  for site in $(provisioned_sites); do
    log "bench migrate on $site (applies DocType, Role and permission changes the resync brought in)"
    bench --site "$site" migrate
  done
  # Only now can a rail issuer be given a role the resync just brought in: the pre-resync
  # attempt above runs against the STALE app copy, whose ensure_roles has never heard of the
  # new role. Without this second call a stale volume needs a second start before its rails
  # work, and "heals on the next boot" is indistinguishable from "dead" to whoever boots it once.
  for site in $(provisioned_sites); do
    reprovision_site "$site"
  done
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
  # `bench new-site` makes the new site current.  Every script here passes --site
  # explicitly, but a hand-run `bench <command>` in this container would otherwise land on
  # the tenant clone instead of the site the operator is standing in front of.
  if [ "$SITE" != "$DEFAULT_SITE" ] && [ -d "sites/$DEFAULT_SITE" ]; then
    printf '%s\n' "$DEFAULT_SITE" > sites/currentsite.txt
  fi
fi

# 5. install the app on the site (runs install.py hooks + DocType sync) -------
if ! bench --site "$SITE" list-apps 2>/dev/null | grep -q ironwrap_roofing; then
  log "installing ironwrap_roofing on $SITE (committed DocTypes and policy hooks)"
  bench --site "$SITE" install-app ironwrap_roofing
fi

# 5b. migrate the freshly-installed site --------------------------------------
# `install-app` syncs the DocTypes it sees at install time, and the stale-volume
# path below has always ended with `bench migrate` - but the FRESH path never ran
# one, so a first boot could leave a newly-added DocType's metadata unmigrated
# while the app source was provably in sync. ELEC-128 lost time to exactly that:
# `White-Label Tenant` was absent from a freshly-provisioned site, and since
# `document_validation._locked_authority_records` reads `tabWhite-Label Tenant`
# to resolve ANY authority, every release gate on that site failed for a reason
# that had nothing to do with the code under test. A migrate here is idempotent
# and cheap; discovering its absence by hand is neither.
log "bench migrate (brings DocType metadata on the new site up to the app source)"
bench --site "$SITE" migrate

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
# Only the default site owns the bare `localhost` alias.  A second tenant site is reached
# on its own name (http://<site>:8000, which macOS and Linux both resolve to loopback for
# any *.localhost); repointing the alias here would silently move the FIRST tenant's Worker
# onto the second tenant's Frappe, which is the ELEC-112 finding-4 failure one layer down.
if [ "$SITE" = "$DEFAULT_SITE" ]; then
  ln -sfn "$SITE" "sites/localhost"
fi

# 8. every non-interactive identity this site needs ---------------------------
# Six bounded rails with their own least-privilege role and key pair, five broker actor
# logins, and the Worker BFF's System Manager pair.  Each writes its credentials into
# sites/$SITE/, so a second tenant site on this bench mints its own keys rather than
# sharing the first site's.
provision_broker_identities
provision_rail_issuer_identities

# 9. pinned service identities --------------------------------------------------
pin_service_identities

printf '%s\n' "$IDENTITY_DOMAIN" > "$IDENTITY_DOMAIN_FILE"
touch "$STAMP"
log "DONE - site '$SITE' ready (admin: Administrator / $ADMIN_PW)"
cat "sites/$SITE/.integration_credentials" 2>/dev/null || true
