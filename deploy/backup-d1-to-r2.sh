#!/usr/bin/env bash
# Export the exact production D1 database, prove the SQL in an isolated SQLite
# database, encrypt it locally, and atomically commit it to the backup R2 bucket.
set -euo pipefail
set +x
umask 077

if (( $# != 0 )); then
  echo "error: this command accepts no arguments; configuration and secrets are environment-only" >&2
  exit 64
fi
d1_backup_api_token="${D1_BACKUP_API_TOKEN:-}"
unset CLOUDFLARE_API_TOKEN D1_BACKUP_API_TOKEN
set +a

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
WRANGLER="$REPO_ROOT/workers-bus/node_modules/.bin/wrangler"
LOCK_FILE="$REPO_ROOT/workers-bus/package-lock.json"

# These are the production ownership coordinates committed in
# workers-bus/wrangler.jsonc. A backup must never discover or accept another
# source database at runtime.
EXPECTED_ACCOUNT_ID="7ee5775bc1ba46f05c5a65235b60e939"
EXPECTED_DATABASE_NAME="ironwrap-bus"
EXPECTED_DATABASE_ID="f0674848-13df-4422-9896-8ba2719663b8"
REQUIRED_TABLES="envelopes,audit_log,dead_letter,source_counts,heartbeat,quickbooks_webhook_receipts,dedup_claims,replay_requests,field_actions,field_action_media,app_users,app_magic_links,app_sessions,app_auth_throttles,app_auth_audit,app_action_throttles,app_device_pairings,app_devices,lead_ack_receipts,approval_requests,approval_request_events,quote_revision_approval_requests,quote_revision_approval_request_events,customer_portal_links,customer_portal_access_throttles,measurement_intake_receipts,production_schedule_approval_requests,production_schedule_approval_request_events,public_estimate_rate_limits,governed_transitions,governed_transition_outbox,governed_transition_outbox_events"
REQUIRED_TABLE_COUNT=32
# Name and target table are both release-state invariants. A backup that has the
# rows but not these safeguards is not a recoverable production backup.
REQUIRED_TRIGGER_BINDINGS="validate_source_count_insert=source_counts,validate_source_count_update=source_counts,prevent_lead_ack_receipts_update=lead_ack_receipts,prevent_lead_ack_receipts_delete=lead_ack_receipts,prevent_approval_request_binding_rewrite=approval_requests,enforce_approval_request_transition=approval_requests,enforce_approval_request_reconciliation=approval_requests,append_approval_request_created_event=approval_requests,append_approval_request_transition_event=approval_requests,append_approval_request_reconciliation_event=approval_requests,prevent_approval_request_event_update=approval_request_events,prevent_approval_request_event_delete=approval_request_events,prevent_approval_request_delete=approval_requests,prevent_quote_revision_approval_binding_rewrite=quote_revision_approval_requests,enforce_quote_revision_approval_transition=quote_revision_approval_requests,enforce_quote_revision_approval_reconciliation=quote_revision_approval_requests,append_quote_revision_approval_created_event=quote_revision_approval_requests,append_quote_revision_approval_transition_event=quote_revision_approval_requests,append_quote_revision_approval_reconciliation_event=quote_revision_approval_requests,prevent_quote_revision_approval_event_update=quote_revision_approval_request_events,prevent_quote_revision_approval_event_delete=quote_revision_approval_request_events,prevent_quote_revision_approval_delete=quote_revision_approval_requests,prevent_production_schedule_approval_binding_rewrite=production_schedule_approval_requests,enforce_production_schedule_approval_transition=production_schedule_approval_requests,enforce_production_schedule_approval_reconciliation=production_schedule_approval_requests,append_production_schedule_approval_created_event=production_schedule_approval_requests,append_production_schedule_approval_transition_event=production_schedule_approval_requests,append_production_schedule_approval_reconciliation_event=production_schedule_approval_requests,prevent_production_schedule_approval_event_update=production_schedule_approval_request_events,prevent_production_schedule_approval_event_delete=production_schedule_approval_request_events,prevent_production_schedule_approval_delete=production_schedule_approval_requests,prevent_governed_transition_update=governed_transitions,prevent_governed_transition_delete=governed_transitions,enforce_governed_transition_outbox_update=governed_transition_outbox,prevent_governed_transition_outbox_delete=governed_transition_outbox,append_governed_transition_outbox_intent_event=governed_transition_outbox,append_governed_transition_outbox_state_event=governed_transition_outbox,prevent_governed_transition_outbox_event_update=governed_transition_outbox_events,prevent_governed_transition_outbox_event_delete=governed_transition_outbox_events,enqueue_governed_transition_from_approval_claim=approval_requests,project_governed_transition_outbox_terminal=approval_requests,project_governed_transition_outbox_reconciliation=approval_requests,renew_approval_execution_lease_from_governed_outbox_claim=governed_transition_outbox"
REQUIRED_TRIGGER_COUNT=43
REQUIRED_RECEIPT_TRIGGER_SEMANTICS="prevent_lead_ack_receipts_update=beforeupdateonlead_ack_receipts,prevent_lead_ack_receipts_delete=beforedeleteonlead_ack_receipts"
RECEIPT_IMMUTABILITY_ABORT="raise(abort,'lead_ack_receipts_immutable')"
REQUIRED_APPROVAL_TRIGGER_SEMANTICS="prevent_approval_request_binding_rewrite|beforeupdateonapproval_requests|raise(abort,'approval_request_binding_immutable'),prevent_approval_request_event_update|beforeupdateonapproval_request_events|raise(abort,'approval_request_events_immutable'),prevent_approval_request_event_delete|beforedeleteonapproval_request_events|raise(abort,'approval_request_events_immutable'),prevent_approval_request_delete|beforedeleteonapproval_requests|raise(abort,'approval_requests_append_only'),prevent_quote_revision_approval_binding_rewrite|beforeupdateonquote_revision_approval_requests|raise(abort,'quote_revision_approval_binding_immutable'),prevent_quote_revision_approval_event_update|beforeupdateonquote_revision_approval_request_events|raise(abort,'quote_revision_approval_events_immutable'),prevent_quote_revision_approval_event_delete|beforedeleteonquote_revision_approval_request_events|raise(abort,'quote_revision_approval_events_immutable'),prevent_quote_revision_approval_delete|beforedeleteonquote_revision_approval_requests|raise(abort,'quote_revision_approvals_append_only'),prevent_production_schedule_approval_binding_rewrite|beforeupdateonproduction_schedule_approval_requests|raise(abort,'production_schedule_approval_binding_immutable'),prevent_production_schedule_approval_event_update|beforeupdateonproduction_schedule_approval_request_events|raise(abort,'production_schedule_approval_events_immutable'),prevent_production_schedule_approval_event_delete|beforedeleteonproduction_schedule_approval_request_events|raise(abort,'production_schedule_approval_events_immutable'),prevent_production_schedule_approval_delete|beforedeleteonproduction_schedule_approval_requests|raise(abort,'production_schedule_approvals_append_only'),prevent_governed_transition_update|beforeupdateongoverned_transitions|raise(abort,'governed_transitions_immutable'),prevent_governed_transition_delete|beforedeleteongoverned_transitions|raise(abort,'governed_transitions_append_only'),enforce_governed_transition_outbox_update|beforeupdateongoverned_transition_outbox|raise(abort,'governed_transition_outbox_binding_immutable'),enforce_governed_transition_outbox_update|beforeupdateongoverned_transition_outbox|raise(abort,'governed_transition_outbox_invalid_uncertain_transition'),enforce_governed_transition_outbox_update|beforeupdateongoverned_transition_outbox|raise(abort,'governed_transition_outbox_terminal'),prevent_governed_transition_outbox_delete|beforedeleteongoverned_transition_outbox|raise(abort,'governed_transition_outbox_append_only'),prevent_governed_transition_outbox_event_update|beforeupdateongoverned_transition_outbox_events|raise(abort,'governed_transition_outbox_events_immutable'),prevent_governed_transition_outbox_event_delete|beforedeleteongoverned_transition_outbox_events|raise(abort,'governed_transition_outbox_events_append_only')"

verify_receipt_trigger_semantics() {
  local database="$1"
  local label="$2"
  local trigger_spec trigger_name expected_prefix normalized_sql
  local -a required_receipt_trigger_semantics

  IFS=',' read -r -a required_receipt_trigger_semantics <<< "$REQUIRED_RECEIPT_TRIGGER_SEMANTICS"
  for trigger_spec in "${required_receipt_trigger_semantics[@]}"; do
    trigger_name="${trigger_spec%%=*}"
    expected_prefix="${trigger_spec#*=}"
    normalized_sql="$(sqlite3 "$database" "SELECT lower(replace(replace(replace(replace(sql, char(10), ''), char(13), ''), char(9), ''), ' ', '')) FROM sqlite_master WHERE type='trigger' AND name='$trigger_name';")"
    if [[ "$normalized_sql" != *"$expected_prefix"* || "$normalized_sql" != *"$RECEIPT_IMMUTABILITY_ABORT"* ]]; then
      echo "error: $label does not enforce immutable receipt trigger semantics: $trigger_name" >&2
      return 1
    fi
  done
}

verify_approval_trigger_semantics() {
  local database="$1"
  local label="$2"
  local trigger_spec trigger_name expected_prefix expected_abort normalized_sql
  local -a required_approval_trigger_semantics

  IFS=',' read -r -a required_approval_trigger_semantics <<< "$REQUIRED_APPROVAL_TRIGGER_SEMANTICS"
  for trigger_spec in "${required_approval_trigger_semantics[@]}"; do
    IFS='|' read -r trigger_name expected_prefix expected_abort <<< "$trigger_spec"
    normalized_sql="$(sqlite3 "$database" "SELECT lower(replace(replace(replace(replace(sql, char(10), ''), char(13), ''), char(9), ''), ' ', '')) FROM sqlite_master WHERE type='trigger' AND name='$trigger_name';")"
    if [[ "$normalized_sql" != *"$expected_prefix"* || "$normalized_sql" != *"$expected_abort"* ]]; then
      echo "error: $label does not enforce immutable approval-ledger trigger semantics: $trigger_name" >&2
      return 1
    fi
  done
}

required_env=(
  D1_PRODUCTION_ACCOUNT_ID
  D1_PRODUCTION_DATABASE_NAME
  D1_PRODUCTION_DATABASE_ID
  D1_R2_BACKUP_BUCKET
  D1_BACKUP_RETENTION_DAYS
  BACKUP_AGE_RECIPIENT
  RCLONE_CONFIG_R2_TYPE
  RCLONE_CONFIG_R2_PROVIDER
  RCLONE_CONFIG_R2_ACCESS_KEY_ID
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
  RCLONE_CONFIG_R2_ENDPOINT
)
for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" || "${!name}" == *'<'* || "${!name}" == *'>'* || \
        "${!name}" == *$'\n'* || "${!name}" == *$'\r'* ]]; then
    echo "error: required D1 backup environment is missing, placeholder, or malformed: $name" >&2
    exit 1
  fi
done

if [[ "$D1_PRODUCTION_ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" || \
      "$D1_PRODUCTION_DATABASE_NAME" != "$EXPECTED_DATABASE_NAME" || \
      "$D1_PRODUCTION_DATABASE_ID" != "$EXPECTED_DATABASE_ID" ]]; then
  echo "error: D1 source coordinates do not match the committed production database" >&2
  exit 1
fi
if [[ ! "$d1_backup_api_token" =~ ^[^[:space:]]{24,}$ ]]; then
  echo "error: D1_BACKUP_API_TOKEN is missing or malformed" >&2
  exit 1
fi
if [[ "$d1_backup_api_token" == "$RCLONE_CONFIG_R2_ACCESS_KEY_ID" || \
      "$d1_backup_api_token" == "$RCLONE_CONFIG_R2_SECRET_ACCESS_KEY" || \
      "$RCLONE_CONFIG_R2_ACCESS_KEY_ID" == "$RCLONE_CONFIG_R2_SECRET_ACCESS_KEY" ]]; then
  echo "error: Cloudflare D1 API and R2 backup credentials must be separated by purpose" >&2
  exit 1
fi
if [[ "$RCLONE_CONFIG_R2_TYPE" != "s3" || "$RCLONE_CONFIG_R2_PROVIDER" != "Cloudflare" ]]; then
  echo "error: the R2 backup remote must use the s3 type and Cloudflare provider" >&2
  exit 1
fi
if [[ ! "$RCLONE_CONFIG_R2_ENDPOINT" =~ ^https://[a-z0-9-]+\.r2\.cloudflarestorage\.com/?$ ]]; then
  echo "error: RCLONE_CONFIG_R2_ENDPOINT must be a credential-free Cloudflare R2 HTTPS endpoint" >&2
  exit 1
fi
if [[ ! "$D1_R2_BACKUP_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ || \
      "$D1_R2_BACKUP_BUCKET" == *..* ]]; then
  echo "error: D1_R2_BACKUP_BUCKET has an unsafe format" >&2
  exit 1
fi
if [[ ! "$D1_BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ || \
      "$D1_BACKUP_RETENTION_DAYS" -lt 7 || "$D1_BACKUP_RETENTION_DAYS" -gt 365 ]]; then
  echo "error: D1_BACKUP_RETENTION_DAYS must be an integer from 7 through 365" >&2
  exit 1
fi
if [[ ! "$BACKUP_AGE_RECIPIENT" =~ ^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$ ]]; then
  echo "error: BACKUP_AGE_RECIPIENT must be one valid age public recipient" >&2
  exit 1
fi

for command_name in age flock mktemp node rclone sha256sum sqlite3 tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required D1 backup command is unavailable: $command_name" >&2
    exit 1
  fi
done
if [[ ! -x "$WRANGLER" || ! -f "$LOCK_FILE" ]]; then
  echo "error: install the workers-bus locked dependencies with npm ci --ignore-scripts before D1 backup" >&2
  exit 1
fi
locked_wrangler="$(node -e 'const l=require(process.argv[1]); const v=l.packages?.["node_modules/wrangler"]?.version; if(typeof v!=="string") process.exit(1); process.stdout.write(v)' "$LOCK_FILE")"
runtime_wrangler="$($WRANGLER --version | awk 'match($0,/[0-9]+\.[0-9]+\.[0-9]+/){print substr($0,RSTART,RLENGTH); exit}')"
if [[ ! "$locked_wrangler" =~ ^4\.[0-9]+\.[0-9]+$ || "$runtime_wrangler" != "$locked_wrangler" ]]; then
  echo "error: D1 backup requires the exact Wrangler 4 version locked by workers-bus/package-lock.json" >&2
  exit 1
fi

exec 9>"${TMPDIR:-/tmp}/ironwrap-d1-backup.lock"
if ! flock -n 9; then
  echo "error: another D1 backup is already running" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d -t ironwrap-d1-backup.XXXXXXXX)"
remote_started=0
remote_complete=0
remote=""
cleanup() {
  status=$?
  trap - EXIT
  if (( remote_started == 1 && remote_complete == 0 )) && [[ -n "$remote" ]]; then
    if ! rclone purge "$remote" >/dev/null 2>&1; then
      echo "error: incomplete markerless D1 backup prefix could not be purged; quarantine it until retention permits deletion" >&2
    fi
  fi
  d1_backup_api_token=""
  rm -rf -- "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_ID="$STAMP-$$-$RANDOM"
remote="R2:$D1_R2_BACKUP_BUCKET/d1/$D1_PRODUCTION_DATABASE_NAME/$RUN_ID"
config="$WORK_DIR/wrangler.d1-backup.json"
sql_file="ironwrap-d1-$D1_PRODUCTION_DATABASE_NAME-$STAMP.sql"
export_sql="$WORK_DIR/$sql_file"
cat > "$config" <<EOF
{
  "name": "ironwrap-d1-backup",
  "account_id": "$D1_PRODUCTION_ACCOUNT_ID",
  "compatibility_date": "2026-06-28",
  "d1_databases": [{
    "binding": "BACKUP_SOURCE",
    "database_name": "$D1_PRODUCTION_DATABASE_NAME",
    "database_id": "$D1_PRODUCTION_DATABASE_ID"
  }]
}
EOF

CLOUDFLARE_API_TOKEN="$d1_backup_api_token" "$WRANGLER" d1 export "$D1_PRODUCTION_DATABASE_NAME" \
  --remote --config "$config" --output "$export_sql" >/dev/null
if [[ ! -s "$export_sql" ]]; then
  echo "error: Wrangler produced an empty D1 export" >&2
  exit 1
fi

verification_db="$WORK_DIR/verification.sqlite3"
if ! sqlite3 -bail "$verification_db" < "$export_sql"; then
  echo "error: D1 export cannot be imported into an isolated SQLite database" >&2
  exit 1
fi
if [[ "$(sqlite3 "$verification_db" 'PRAGMA integrity_check;')" != "ok" ]]; then
  echo "error: isolated SQLite integrity check failed" >&2
  exit 1
fi
IFS=',' read -r -a required_tables <<< "$REQUIRED_TABLES"
if (( ${#required_tables[@]} != REQUIRED_TABLE_COUNT )); then
  echo "error: D1 backup required-table contract is internally inconsistent" >&2
  exit 1
fi
for table_name in "${required_tables[@]}"; do
  present="$(sqlite3 "$verification_db" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$table_name';")"
  if [[ "$present" != "1" ]]; then
    echo "error: D1 export is missing required production table: $table_name" >&2
    exit 1
  fi
done
IFS=',' read -r -a required_trigger_bindings <<< "$REQUIRED_TRIGGER_BINDINGS"
if (( ${#required_trigger_bindings[@]} != REQUIRED_TRIGGER_COUNT )); then
  echo "error: D1 backup required-trigger contract is internally inconsistent" >&2
  exit 1
fi
for trigger_binding in "${required_trigger_bindings[@]}"; do
  trigger_name="${trigger_binding%%=*}"
  trigger_table="${trigger_binding#*=}"
  present="$(sqlite3 "$verification_db" "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='$trigger_name' AND tbl_name='$trigger_table';")"
  if [[ "$present" != "1" ]]; then
    echo "error: D1 export is missing required invariant trigger: $trigger_name on $trigger_table" >&2
    exit 1
  fi
done
if ! verify_receipt_trigger_semantics "$verification_db" "D1 export"; then
  exit 1
fi
if ! verify_approval_trigger_semantics "$verification_db" "D1 export"; then
  exit 1
fi

package="$WORK_DIR/package"
publish="$WORK_DIR/publish"
mkdir -m 700 "$package" "$publish"
cp "$export_sql" "$package/$sql_file"
sql_sha256="$(sha256sum "$package/$sql_file" | awk '{print $1}')"
manifest="$package/IRONWRAP-D1-BACKUP-MANIFEST.txt"
{
  printf 'schema_version=1\n'
  printf 'created_utc=%s\n' "$STAMP"
  printf 'account_id=%s\n' "$D1_PRODUCTION_ACCOUNT_ID"
  printf 'database_name=%s\n' "$D1_PRODUCTION_DATABASE_NAME"
  printf 'database_id=%s\n' "$D1_PRODUCTION_DATABASE_ID"
  printf 'format=cloudflare-d1-sql-export\n'
  printf 'wrangler_version=%s\n' "$locked_wrangler"
  printf 'sql_file=%s\n' "$sql_file"
  printf 'sql_sha256=%s\n' "$sql_sha256"
  printf 'required_tables=%s\n' "$REQUIRED_TABLES"
} > "$manifest"

archive="$WORK_DIR/ironwrap-d1-$D1_PRODUCTION_DATABASE_NAME-$STAMP.tar.gz"
tar --create --gzip --file "$archive" --directory "$package" \
  IRONWRAP-D1-BACKUP-MANIFEST.txt "$sql_file"
encrypted="$publish/$(basename "$archive").age"
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted" "$archive"
(cd "$publish" && sha256sum "$(basename "$encrypted")" > "$(basename "$encrypted").sha256")
(cd "$publish" && sha256sum --check "$(basename "$encrypted").sha256" >/dev/null)

remote_started=1
rclone copy "$publish" "$remote" --immutable --transfers 1 --checkers 2
rclone check "$publish" "$remote" --one-way --checkers 2

completion_marker="$WORK_DIR/IRONWRAP-D1-BACKUP-COMPLETE"
{
  printf 'schema_version=1\n'
  printf 'created_utc=%s\n' "$STAMP"
  printf 'database_name=%s\n' "$D1_PRODUCTION_DATABASE_NAME"
  printf 'database_id=%s\n' "$D1_PRODUCTION_DATABASE_ID"
  printf 'archive=%s\n' "$(basename "$encrypted")"
  printf 'checksum=%s\n' "$(basename "$encrypted").sha256"
} > "$completion_marker"
rclone copyto "$completion_marker" "$remote/IRONWRAP-D1-BACKUP-COMPLETE" --immutable
remote_complete=1

# Expiry is two-phase: make a generation undiscoverable by deleting its marker,
# then retain ciphertext/checksum for one extra hour before removing data.
MARKER_RETENTION_HOURS=$((D1_BACKUP_RETENTION_DAYS * 24))
DATA_RETENTION_HOURS=$((MARKER_RETENTION_HOURS + 1))
rclone delete "R2:$D1_R2_BACKUP_BUCKET/d1/$D1_PRODUCTION_DATABASE_NAME/" \
  --min-age "${MARKER_RETENTION_HOURS}h" \
  --include '**/IRONWRAP-D1-BACKUP-COMPLETE' \
  --exclude '*'
rclone delete "R2:$D1_R2_BACKUP_BUCKET/d1/$D1_PRODUCTION_DATABASE_NAME/" \
  --min-age "${DATA_RETENTION_HOURS}h" \
  --include '**/*.age' \
  --include '**/*.sha256' \
  --exclude '*'
rclone rmdirs "R2:$D1_R2_BACKUP_BUCKET/d1/$D1_PRODUCTION_DATABASE_NAME/" --leave-root

echo "ok: exact production D1 export validated, encrypted, committed, and remotely verified; prefix=d1/$D1_PRODUCTION_DATABASE_NAME/$RUN_ID"
