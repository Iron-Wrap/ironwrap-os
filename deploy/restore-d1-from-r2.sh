#!/usr/bin/env bash
# Verify one explicitly selected D1 backup locally. A remote restore is an
# opt-in drill to a distinct, empty, explicitly confirmed D1 database only.
set -euo pipefail
set +x
umask 077

if (( $# != 0 )); then
  echo "error: this command accepts no arguments; mode, configuration, and secrets are environment-only" >&2
  exit 64
fi
d1_backup_api_token="${D1_BACKUP_API_TOKEN:-}"
d1_restore_api_token="${D1_RESTORE_API_TOKEN:-}"
unset CLOUDFLARE_API_TOKEN D1_BACKUP_API_TOKEN D1_RESTORE_API_TOKEN
set +a

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
WRANGLER="$REPO_ROOT/workers-bus/node_modules/.bin/wrangler"
LOCK_FILE="$REPO_ROOT/workers-bus/package-lock.json"
EXPECTED_ACCOUNT_ID="7ee5775bc1ba46f05c5a65235b60e939"
EXPECTED_DATABASE_NAME="ironwrap-bus"
EXPECTED_DATABASE_ID="f0674848-13df-4422-9896-8ba2719663b8"
REQUIRED_TABLES="app_action_throttles,app_auth_audit,app_auth_throttles,app_device_pairings,app_devices,app_magic_links,app_sessions,app_users,approval_request_events,approval_requests,audit_log,customer_portal_acceptance_challenges,customer_portal_acceptance_events,customer_portal_acceptance_intents,customer_portal_access_throttles,customer_portal_links,dead_letter,dedup_claims,dev_outbox,envelopes,facet_customer_approval_events,facet_customer_approval_projection_attempts,facet_design_event_identity_registry,facet_design_events,facet_design_evidence_associations,facet_design_ingest_nonce_registry,facet_design_ingest_nonces,facet_design_projection_attempts,field_action_media,field_actions,field_work_package_actions,governed_transition_outbox,governed_transition_outbox_events,governed_transitions,heartbeat,lead_ack_receipts,measurement_deltas,measurement_intake_receipts,newo_control_actions,newo_event_receipts,newo_reconciliation_runs,newo_sessions,newo_slot_reservations,production_schedule_approval_request_events,production_schedule_approval_requests,public_estimate_rate_limits,quickbooks_projection_outbox,quickbooks_webhook_receipts,quote_revision_approval_request_events,quote_revision_approval_requests,replay_requests,source_counts"
REQUIRED_TABLE_COUNT=52
# A recoverable export must retain both source-count validation and append-only
# receipt evidence, bound to their intended tables.
REQUIRED_TRIGGER_BINDINGS="append_approval_request_created_event=approval_requests,append_approval_request_reconciliation_event=approval_requests,append_approval_request_transition_event=approval_requests,append_governed_transition_outbox_intent_event=governed_transition_outbox,append_governed_transition_outbox_state_event=governed_transition_outbox,append_production_schedule_approval_created_event=production_schedule_approval_requests,append_production_schedule_approval_reconciliation_event=production_schedule_approval_requests,append_production_schedule_approval_transition_event=production_schedule_approval_requests,append_quote_revision_approval_created_event=quote_revision_approval_requests,append_quote_revision_approval_reconciliation_event=quote_revision_approval_requests,append_quote_revision_approval_transition_event=quote_revision_approval_requests,customer_portal_acceptance_challenge_immutable=customer_portal_acceptance_challenges,customer_portal_acceptance_challenges_append_only_delete=customer_portal_acceptance_challenges,customer_portal_acceptance_consume_challenge=customer_portal_acceptance_intents,customer_portal_acceptance_events_append_only_delete=customer_portal_acceptance_events,customer_portal_acceptance_events_append_only_update=customer_portal_acceptance_events,customer_portal_acceptance_immutable_intent=customer_portal_acceptance_intents,customer_portal_acceptance_intents_append_only_delete=customer_portal_acceptance_intents,customer_portal_acceptance_record_frappe_attempt=customer_portal_acceptance_intents,customer_portal_acceptance_record_state_event=customer_portal_acceptance_intents,customer_portal_acceptance_valid_transition=customer_portal_acceptance_intents,enforce_approval_request_reconciliation=approval_requests,enforce_approval_request_transition=approval_requests,enforce_governed_transition_outbox_update=governed_transition_outbox,enforce_production_schedule_approval_reconciliation=production_schedule_approval_requests,enforce_production_schedule_approval_transition=production_schedule_approval_requests,enforce_quote_revision_approval_reconciliation=quote_revision_approval_requests,enforce_quote_revision_approval_transition=quote_revision_approval_requests,enqueue_governed_transition_from_approval_claim=approval_requests,facet_customer_approval_events_append_only_delete=facet_customer_approval_events,facet_customer_approval_events_append_only_update=facet_customer_approval_events,facet_customer_approval_events_register_identity=facet_customer_approval_events,facet_customer_approval_projection_attempts_append_only_delete=facet_customer_approval_projection_attempts,facet_customer_approval_projection_attempts_append_only_update=facet_customer_approval_projection_attempts,facet_design_event_identity_registry_append_only_delete=facet_design_event_identity_registry,facet_design_event_identity_registry_append_only_update=facet_design_event_identity_registry,facet_design_events_append_only_delete=facet_design_events,facet_design_events_append_only_update=facet_design_events,facet_design_events_register_identity=facet_design_events,facet_design_evidence_associations_append_only_delete=facet_design_evidence_associations,facet_design_evidence_associations_append_only_update=facet_design_evidence_associations,facet_design_evidence_associations_validate_insert=facet_design_evidence_associations,facet_design_ingest_nonce_registry_append_only_delete=facet_design_ingest_nonce_registry,facet_design_ingest_nonce_registry_append_only_update=facet_design_ingest_nonce_registry,facet_design_ingest_nonces_append_only_delete=facet_design_ingest_nonces,facet_design_ingest_nonces_append_only_update=facet_design_ingest_nonces,facet_design_projection_attempts_append_only_delete=facet_design_projection_attempts,facet_design_projection_attempts_append_only_update=facet_design_projection_attempts,prevent_approval_request_binding_rewrite=approval_requests,prevent_approval_request_delete=approval_requests,prevent_approval_request_event_delete=approval_request_events,prevent_approval_request_event_update=approval_request_events,prevent_governed_transition_delete=governed_transitions,prevent_governed_transition_outbox_delete=governed_transition_outbox,prevent_governed_transition_outbox_event_delete=governed_transition_outbox_events,prevent_governed_transition_outbox_event_update=governed_transition_outbox_events,prevent_governed_transition_update=governed_transitions,prevent_lead_ack_receipts_delete=lead_ack_receipts,prevent_lead_ack_receipts_update=lead_ack_receipts,prevent_production_schedule_approval_binding_rewrite=production_schedule_approval_requests,prevent_production_schedule_approval_delete=production_schedule_approval_requests,prevent_production_schedule_approval_event_delete=production_schedule_approval_request_events,prevent_production_schedule_approval_event_update=production_schedule_approval_request_events,prevent_quote_revision_approval_binding_rewrite=quote_revision_approval_requests,prevent_quote_revision_approval_delete=quote_revision_approval_requests,prevent_quote_revision_approval_event_delete=quote_revision_approval_request_events,prevent_quote_revision_approval_event_update=quote_revision_approval_request_events,project_governed_transition_outbox_reconciliation=approval_requests,project_governed_transition_outbox_terminal=approval_requests,renew_approval_execution_lease_from_governed_outbox_claim=governed_transition_outbox,validate_source_count_insert=source_counts,validate_source_count_update=source_counts"
REQUIRED_TRIGGER_COUNT=72
MAX_REMOTE_READ_COMMAND_LENGTH=16384
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
  local trigger_spec trigger_name expected_prefix expected_abort normalized_sql serialized_semantics
  local -a required_approval_trigger_semantics

  serialized_semantics="${REQUIRED_APPROVAL_TRIGGER_SEMANTICS//),/);}"
  IFS=';' read -r -a required_approval_trigger_semantics < <(printf '%s\n' "$serialized_semantics")
  if (( ${#required_approval_trigger_semantics[@]} != 20 )); then
    echo "error: $label approval-ledger trigger contract is internally inconsistent" >&2
    return 1
  fi
  for trigger_spec in "${required_approval_trigger_semantics[@]}"; do
    IFS='|' read -r trigger_name expected_prefix expected_abort <<< "$trigger_spec"
    if [[ -z "$trigger_name" || -z "$expected_prefix" || -z "$expected_abort" ]] || \
        ! normalized_sql="$(sqlite3 "$database" "SELECT lower(replace(replace(replace(replace(sql, char(10), ''), char(13), ''), char(9), ''), ' ', '')) FROM sqlite_master WHERE type='trigger' AND name='$trigger_name';")"; then
      echo "error: $label approval-ledger trigger contract is malformed: $trigger_name" >&2
      return 1
    fi
    if [[ "$normalized_sql" != *"$expected_prefix"* || "$normalized_sql" != *"$expected_abort"* ]]; then
      echo "error: $label does not enforce immutable approval-ledger trigger semantics: $trigger_name" >&2
      return 1
    fi
  done
}
mode="${D1_RESTORE_MODE:-verify}"

if [[ "$mode" != "verify" && "$mode" != "remote" ]]; then
  echo "error: D1_RESTORE_MODE must equal verify or remote" >&2
  exit 1
fi
required_env=(
  D1_PRODUCTION_ACCOUNT_ID
  D1_PRODUCTION_DATABASE_NAME
  D1_PRODUCTION_DATABASE_ID
  D1_R2_BACKUP_BUCKET
  D1_RESTORE_R2_COMPLETED_PREFIX
  D1_RESTORE_AGE_IDENTITY_FILE
  RCLONE_CONFIG_R2_TYPE
  RCLONE_CONFIG_R2_PROVIDER
  RCLONE_CONFIG_R2_ACCESS_KEY_ID
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
  RCLONE_CONFIG_R2_ENDPOINT
)
if [[ "$mode" == "remote" ]]; then
  required_env+=(
    D1_RESTORE_TARGET_ACCOUNT_ID
    D1_RESTORE_TARGET_DATABASE_NAME
    D1_RESTORE_TARGET_DATABASE_ID
    D1_RESTORE_CONFIRMATION
  )
fi
for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" || "${!name}" == *'<'* || "${!name}" == *'>'* || \
        "${!name}" == *$'\n'* || "${!name}" == *$'\r'* ]]; then
    echo "error: required D1 restore environment is missing, placeholder, or malformed: $name" >&2
    exit 1
  fi
done
if [[ "$D1_PRODUCTION_ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" || \
      "$D1_PRODUCTION_DATABASE_NAME" != "$EXPECTED_DATABASE_NAME" || \
      "$D1_PRODUCTION_DATABASE_ID" != "$EXPECTED_DATABASE_ID" ]]; then
  echo "error: D1 source coordinates do not match the committed production database" >&2
  exit 1
fi
if [[ "$RCLONE_CONFIG_R2_TYPE" != "s3" || "$RCLONE_CONFIG_R2_PROVIDER" != "Cloudflare" || \
      ! "$RCLONE_CONFIG_R2_ENDPOINT" =~ ^https://[a-z0-9-]+\.r2\.cloudflarestorage\.com/?$ ]]; then
  echo "error: the R2 restore remote must be a credential-free Cloudflare s3 endpoint" >&2
  exit 1
fi
if [[ ! "$D1_R2_BACKUP_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ || \
      "$D1_R2_BACKUP_BUCKET" == *..* ]]; then
  echo "error: D1_R2_BACKUP_BUCKET has an unsafe format" >&2
  exit 1
fi
expected_prefix="d1/$D1_PRODUCTION_DATABASE_NAME/"
if [[ "$D1_RESTORE_R2_COMPLETED_PREFIX" != "$expected_prefix"* || \
      "$D1_RESTORE_R2_COMPLETED_PREFIX" == *..* || \
      "$D1_RESTORE_R2_COMPLETED_PREFIX" == *//* || \
      "$D1_RESTORE_R2_COMPLETED_PREFIX" == */ ]]; then
  echo "error: D1_RESTORE_R2_COMPLETED_PREFIX must select one exact production D1 backup run" >&2
  exit 1
fi
run_id="${D1_RESTORE_R2_COMPLETED_PREFIX#"$expected_prefix"}"
if [[ "$run_id" == */* || ! "$run_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+$ ]]; then
  echo "error: D1_RESTORE_R2_COMPLETED_PREFIX does not identify one supported completed run" >&2
  exit 1
fi
if [[ "$D1_RESTORE_AGE_IDENTITY_FILE" != /* || ! -f "$D1_RESTORE_AGE_IDENTITY_FILE" || \
      -L "$D1_RESTORE_AGE_IDENTITY_FILE" || ! -r "$D1_RESTORE_AGE_IDENTITY_FILE" ]]; then
  echo "error: D1_RESTORE_AGE_IDENTITY_FILE must be an absolute readable regular non-symlink file" >&2
  exit 1
fi
identity_mode=""
if identity_mode="$(stat -f '%Lp' "$D1_RESTORE_AGE_IDENTITY_FILE" 2>/dev/null)"; then
  :
elif identity_mode="$(stat -c '%a' "$D1_RESTORE_AGE_IDENTITY_FILE" 2>/dev/null)"; then
  :
else
  echo "error: unable to verify D1 age identity file permissions" >&2
  exit 1
fi
if [[ "$identity_mode" != "400" && "$identity_mode" != "600" && \
      "$identity_mode" != "0400" && "$identity_mode" != "0600" ]]; then
  echo "error: D1_RESTORE_AGE_IDENTITY_FILE must have exact mode 0400 or 0600" >&2
  exit 1
fi

for command_name in age flock mktemp node rclone sha256sum sqlite3 stat tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required D1 restore command is unavailable: $command_name" >&2
    exit 1
  fi
done

if [[ "$mode" == "remote" ]]; then
  if [[ ! -x "$WRANGLER" || ! -f "$LOCK_FILE" ]]; then
    echo "error: install the workers-bus locked dependencies with npm ci --ignore-scripts before a remote D1 drill" >&2
    exit 1
  fi
  locked_wrangler="$(node -e 'const l=require(process.argv[1]); const v=l.packages?.["node_modules/wrangler"]?.version; if(typeof v!=="string") process.exit(1); process.stdout.write(v)' "$LOCK_FILE")"
  runtime_wrangler="$($WRANGLER --version | awk 'match($0,/[0-9]+\.[0-9]+\.[0-9]+/){print substr($0,RSTART,RLENGTH); exit}')"
  if [[ ! "$locked_wrangler" =~ ^4\.[0-9]+\.[0-9]+$ || "$runtime_wrangler" != "$locked_wrangler" ]]; then
    echo "error: remote D1 drill requires the exact Wrangler 4 version locked by workers-bus/package-lock.json" >&2
    exit 1
  fi
  if [[ "$D1_RESTORE_TARGET_ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]]; then
    echo "error: remote D1 drill target must be bound to the committed Cloudflare account" >&2
    exit 1
  fi
  if [[ ! "$D1_RESTORE_TARGET_DATABASE_NAME" =~ ^ironwrap-restore-drill-[a-z0-9-]{1,40}$ || \
        ! "$D1_RESTORE_TARGET_DATABASE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
    echo "error: remote D1 drill target name or UUID is unsafe" >&2
    exit 1
  fi
  if [[ "$D1_RESTORE_TARGET_DATABASE_NAME" == "$D1_PRODUCTION_DATABASE_NAME" || \
        "$D1_RESTORE_TARGET_DATABASE_ID" == "$D1_PRODUCTION_DATABASE_ID" ]]; then
    echo "error: the production D1 database can never be a restore target" >&2
    exit 1
  fi
  expected_confirmation="RESTORE_D1:$D1_RESTORE_TARGET_DATABASE_NAME@$D1_RESTORE_TARGET_DATABASE_ID"
  if [[ "$D1_RESTORE_CONFIRMATION" != "$expected_confirmation" ]]; then
    echo "error: remote D1 confirmation is not bound to the exact non-production target" >&2
    exit 1
  fi
  if [[ ! "$d1_backup_api_token" =~ ^[^[:space:]]{24,}$ || \
        ! "$d1_restore_api_token" =~ ^[^[:space:]]{24,}$ || \
        "$d1_backup_api_token" == "$d1_restore_api_token" || \
        "$d1_backup_api_token" == "$RCLONE_CONFIG_R2_ACCESS_KEY_ID" || \
        "$d1_backup_api_token" == "$RCLONE_CONFIG_R2_SECRET_ACCESS_KEY" || \
        "$d1_restore_api_token" == "$RCLONE_CONFIG_R2_ACCESS_KEY_ID" || \
        "$d1_restore_api_token" == "$RCLONE_CONFIG_R2_SECRET_ACCESS_KEY" || \
        "$RCLONE_CONFIG_R2_ACCESS_KEY_ID" == "$RCLONE_CONFIG_R2_SECRET_ACCESS_KEY" ]]; then
    echo "error: D1 backup, D1 restore, and R2 backup authorities must be valid and pairwise distinct" >&2
    exit 1
  fi
elif [[ -n "${D1_RESTORE_CONFIRMATION:-}" ]]; then
  echo "error: D1_RESTORE_CONFIRMATION must remain unset in local verification mode" >&2
  exit 1
fi

lock_suffix="verify"
if [[ "$mode" == "remote" ]]; then lock_suffix="$D1_RESTORE_TARGET_DATABASE_ID"; fi
exec 9>"${TMPDIR:-/tmp}/ironwrap-d1-restore-$lock_suffix.lock"
if ! flock -n 9; then
  echo "error: another D1 restore verification/drill is already running for this target" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d -t ironwrap-d1-restore.XXXXXXXX)"
cleanup() {
  status=$?
  trap - EXIT
  d1_backup_api_token=""
  d1_restore_api_token=""
  rm -rf -- "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

remote="R2:$D1_R2_BACKUP_BUCKET/$D1_RESTORE_R2_COMPLETED_PREFIX"
marker="$WORK_DIR/IRONWRAP-D1-BACKUP-COMPLETE"
if ! rclone cat "$remote/IRONWRAP-D1-BACKUP-COMPLETE" > "$marker"; then
  echo "error: selected D1 backup has no readable completion marker" >&2
  exit 1
fi

marker_schema=""; marker_created=""; marker_name=""; marker_id=""; marker_archive=""; marker_checksum=""; marker_count=0
while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
  if [[ -z "$key" || -z "$value" || "$value" == *$'\r'* || "$value" == *$'\n'* ]]; then
    echo "error: D1 completion marker is malformed" >&2
    exit 1
  fi
  case "$key" in
    schema_version) [[ -z "$marker_schema" ]] || exit 1; marker_schema="$value" ;;
    created_utc) [[ -z "$marker_created" ]] || exit 1; marker_created="$value" ;;
    database_name) [[ -z "$marker_name" ]] || exit 1; marker_name="$value" ;;
    database_id) [[ -z "$marker_id" ]] || exit 1; marker_id="$value" ;;
    archive) [[ -z "$marker_archive" ]] || exit 1; marker_archive="$value" ;;
    checksum) [[ -z "$marker_checksum" ]] || exit 1; marker_checksum="$value" ;;
    *) echo "error: D1 completion marker contains an unexpected field" >&2; exit 1 ;;
  esac
  marker_count=$((marker_count + 1))
done < "$marker"
if [[ "$marker_count" != 6 || "$marker_schema" != "1" || \
      ! "$marker_created" =~ ^[0-9]{8}T[0-9]{6}Z$ || \
      "$marker_name" != "$D1_PRODUCTION_DATABASE_NAME" || \
      "$marker_id" != "$D1_PRODUCTION_DATABASE_ID" || \
      "$marker_archive" != "ironwrap-d1-$D1_PRODUCTION_DATABASE_NAME-$marker_created.tar.gz.age" || \
      "$marker_checksum" != "$marker_archive.sha256" ]]; then
  echo "error: D1 completion marker does not describe the exact production database backup" >&2
  exit 1
fi

download="$WORK_DIR/download"
mkdir -m 700 "$download"
encrypted="$download/$marker_archive"
checksum="$download/$marker_checksum"
rclone copyto "$remote/$marker_archive" "$encrypted" --immutable
rclone copyto "$remote/$marker_checksum" "$checksum" --immutable
if [[ ! -s "$encrypted" || ! -s "$checksum" ]]; then
  echo "error: completed D1 archive or checksum is missing or empty" >&2
  exit 1
fi
checksum_line="$(<"$checksum")"
if [[ ! "$checksum_line" =~ ^[0-9a-f]{64}[[:space:]][[:space:]]${marker_archive}$ ]]; then
  echo "error: D1 checksum document is malformed or names a different archive" >&2
  exit 1
fi
(cd "$download" && sha256sum --check "$marker_checksum" >/dev/null)

archive="$WORK_DIR/${marker_archive%.age}"
age --decrypt --identity "$D1_RESTORE_AGE_IDENTITY_FILE" --output "$archive" "$encrypted"
if [[ ! -s "$archive" ]]; then
  echo "error: decrypted D1 backup package is missing or empty" >&2
  exit 1
fi

entries="$WORK_DIR/archive-entries.txt"
verbose_entries="$WORK_DIR/archive-entries-verbose.txt"
tar -tzf "$archive" > "$entries"
tar -tvzf "$archive" > "$verbose_entries"
entry_count=0
while IFS= read -r entry || [[ -n "$entry" ]]; do
  if [[ -z "$entry" || "$entry" == */* || "$entry" == .* || "$entry" == -* || \
        ! "$entry" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "error: D1 archive contains traversal or unsafe paths" >&2
    exit 1
  fi
  case "$entry" in
    IRONWRAP-D1-BACKUP-MANIFEST.txt|ironwrap-d1-*.sql) ;;
    *) echo "error: D1 archive contains an unexpected file" >&2; exit 1 ;;
  esac
  entry_count=$((entry_count + 1))
done < "$entries"
if (( entry_count != 2 || $(sort "$entries" | uniq | wc -l | tr -d ' ') != 2 )); then
  echo "error: D1 archive must contain exactly one manifest and one SQL export" >&2
  exit 1
fi
verbose_count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "${line:0:1}" != "-" ]]; then
    echo "error: D1 archive links, directories, and non-regular entries are forbidden" >&2
    exit 1
  fi
  verbose_count=$((verbose_count + 1))
done < "$verbose_entries"
if (( verbose_count != 2 )); then
  echo "error: D1 archive metadata and entry list disagree" >&2
  exit 1
fi

package="$WORK_DIR/package"
mkdir -m 700 "$package"
tar -xzf "$archive" -C "$package"
find "$package" -mindepth 1 -maxdepth 1 -type f -exec chmod 600 {} +
if [[ "$(find "$package" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" != "2" || \
      -n "$(find "$package" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ]]; then
  echo "error: extracted D1 package contains an unexpected object" >&2
  exit 1
fi

manifest="$package/IRONWRAP-D1-BACKUP-MANIFEST.txt"
manifest_schema=""; manifest_created=""; manifest_account=""; manifest_name=""; manifest_id=""
manifest_format=""; manifest_wrangler=""; sql_file=""; manifest_sql_sha=""; manifest_tables=""; manifest_count=0
while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
  if [[ -z "$key" || -z "$value" || "$value" == *$'\r'* || "$value" == *$'\n'* ]]; then
    echo "error: D1 restore manifest is malformed" >&2
    exit 1
  fi
  case "$key" in
    schema_version) [[ -z "$manifest_schema" ]] || exit 1; manifest_schema="$value" ;;
    created_utc) [[ -z "$manifest_created" ]] || exit 1; manifest_created="$value" ;;
    account_id) [[ -z "$manifest_account" ]] || exit 1; manifest_account="$value" ;;
    database_name) [[ -z "$manifest_name" ]] || exit 1; manifest_name="$value" ;;
    database_id) [[ -z "$manifest_id" ]] || exit 1; manifest_id="$value" ;;
    format) [[ -z "$manifest_format" ]] || exit 1; manifest_format="$value" ;;
    wrangler_version) [[ -z "$manifest_wrangler" ]] || exit 1; manifest_wrangler="$value" ;;
    sql_file) [[ -z "$sql_file" ]] || exit 1; sql_file="$value" ;;
    sql_sha256) [[ -z "$manifest_sql_sha" ]] || exit 1; manifest_sql_sha="$value" ;;
    required_tables) [[ -z "$manifest_tables" ]] || exit 1; manifest_tables="$value" ;;
    *) echo "error: D1 restore manifest contains an unexpected field" >&2; exit 1 ;;
  esac
  manifest_count=$((manifest_count + 1))
done < "$manifest"
if (( manifest_count != 10 )) || [[ "$manifest_schema" != "1" || \
      "$manifest_created" != "$marker_created" || "$manifest_account" != "$D1_PRODUCTION_ACCOUNT_ID" || \
      "$manifest_name" != "$D1_PRODUCTION_DATABASE_NAME" || "$manifest_id" != "$D1_PRODUCTION_DATABASE_ID" || \
      "$manifest_format" != "cloudflare-d1-sql-export" || ! "$manifest_wrangler" =~ ^4\.[0-9]+\.[0-9]+$ || \
      "$manifest_tables" != "$REQUIRED_TABLES" || \
      "$sql_file" != "ironwrap-d1-$D1_PRODUCTION_DATABASE_NAME-$marker_created.sql" || \
      ! "$manifest_sql_sha" =~ ^[0-9a-f]{64}$ || ! -s "$package/$sql_file" ]]; then
  echo "error: D1 restore manifest does not match the exact source database contract" >&2
  exit 1
fi
actual_sql_sha="$(sha256sum "$package/$sql_file" | awk '{print $1}')"
if [[ "$actual_sql_sha" != "$manifest_sql_sha" ]]; then
  echo "error: D1 SQL export hash does not match its encrypted manifest" >&2
  exit 1
fi

verification_db="$WORK_DIR/verification.sqlite3"
if ! sqlite3 -bail "$verification_db" < "$package/$sql_file"; then
  echo "error: D1 SQL export cannot be imported into an isolated SQLite database" >&2
  exit 1
fi
if [[ "$(sqlite3 "$verification_db" 'PRAGMA integrity_check;')" != "ok" ]]; then
  echo "error: restored D1 SQLite integrity check failed" >&2
  exit 1
fi
IFS=',' read -r -a required_tables < <(printf '%s\n' "$REQUIRED_TABLES")
if (( ${#required_tables[@]} != REQUIRED_TABLE_COUNT )); then
  echo "error: D1 restore required-table contract is internally inconsistent" >&2
  exit 1
fi
local_counts="$WORK_DIR/local-table-counts.txt"
: > "$local_counts"
for table_name in "${required_tables[@]}"; do
  present="$(sqlite3 "$verification_db" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$table_name';")"
  if [[ "$present" != "1" ]]; then
    echo "error: restored D1 export is missing required production table: $table_name" >&2
    exit 1
  fi
  row_count="$(sqlite3 "$verification_db" "SELECT COUNT(*) FROM \"$table_name\";")"
  if [[ ! "$row_count" =~ ^[0-9]+$ ]]; then
    echo "error: restored D1 export returned an invalid row count for: $table_name" >&2
    exit 1
  fi
  printf '%s=%s\n' "$table_name" "$row_count" >> "$local_counts"
done
IFS=',' read -r -a required_trigger_bindings < <(printf '%s\n' "$REQUIRED_TRIGGER_BINDINGS")
if (( ${#required_trigger_bindings[@]} != REQUIRED_TRIGGER_COUNT )); then
  echo "error: D1 restore required-trigger contract is internally inconsistent" >&2
  exit 1
fi
local_trigger_bindings="$WORK_DIR/local-trigger-inventory.txt"
: > "$local_trigger_bindings"
for trigger_binding in "${required_trigger_bindings[@]}"; do
  trigger_name="${trigger_binding%%=*}"
  trigger_table="${trigger_binding#*=}"
  present="$(sqlite3 "$verification_db" "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='$trigger_name' AND tbl_name='$trigger_table';")"
  if [[ "$present" != "1" ]]; then
    echo "error: restored D1 export is missing required invariant trigger: $trigger_name on $trigger_table" >&2
    exit 1
  fi
  printf '%s=%s\n' "$trigger_name" "$trigger_table" >> "$local_trigger_bindings"
done
if ! verify_receipt_trigger_semantics "$verification_db" "restored D1 export"; then
  exit 1
fi
if ! verify_approval_trigger_semantics "$verification_db" "restored D1 export"; then
  exit 1
fi

if [[ "$mode" == "verify" ]]; then
  echo "ok: selected D1 backup cryptographically and structurally verified locally; no remote mutation performed"
  exit 0
fi

target_config="$WORK_DIR/wrangler.d1-restore-target.json"
cat > "$target_config" <<EOF
{
  "name": "ironwrap-d1-restore-drill",
  "account_id": "$D1_RESTORE_TARGET_ACCOUNT_ID",
  "compatibility_date": "2026-06-28",
  "d1_databases": [{
    "binding": "RESTORE_TARGET",
    "database_name": "$D1_RESTORE_TARGET_DATABASE_NAME",
    "database_id": "$D1_RESTORE_TARGET_DATABASE_ID"
  }]
}
EOF
preflight_statement="SELECT SUM(CASE WHEN type='table' AND name='_cf_KV' THEN 1 ELSE 0 END) AS cloudflare_internal_table_count, SUM(CASE WHEN name NOT LIKE 'sqlite_%' AND NOT (type='table' AND name='_cf_KV') THEN 1 ELSE 0 END) AS unexpected_object_count FROM sqlite_master;"
if (( ${#preflight_statement} > MAX_REMOTE_READ_COMMAND_LENGTH )); then
  echo "error: D1 restore preflight command exceeds its bounded transport contract" >&2
  exit 1
fi
preflight_json="$WORK_DIR/target-preflight.json"
CLOUDFLARE_API_TOKEN="$d1_restore_api_token" "$WRANGLER" d1 execute "$D1_RESTORE_TARGET_DATABASE_NAME" --remote \
  --config "$target_config" --command "$preflight_statement" --json > "$preflight_json"
if ! node -e '
  const fs=require("fs");
  const payload=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(!Array.isArray(payload)||payload.length!==1) process.exit(1);
  const entry=payload[0];
  if(entry?.success!==true||entry?.meta?.changes!==0||entry?.meta?.changed_db!==false||!Array.isArray(entry.results)||entry.results.length!==1) process.exit(1);
  const row=entry.results[0];
  if(row?.cloudflare_internal_table_count!==1||row?.unexpected_object_count!==0) process.exit(1);
' "$preflight_json"; then
  echo "error: remote D1 restore target must be an empty dedicated drill database containing only the exact Cloudflare _cf_KV platform table" >&2
  exit 1
fi

CLOUDFLARE_API_TOKEN="$d1_restore_api_token" "$WRANGLER" d1 execute "$D1_RESTORE_TARGET_DATABASE_NAME" --remote \
  --config "$target_config" --file "$package/$sql_file" >/dev/null
verify_json="$WORK_DIR/target-verify.json"
printf '[\n' > "$verify_json"
table_index=0
for table_name in "${required_tables[@]}"; do
  table_verify_json="$WORK_DIR/target-verify-$table_index.json"
  table_verify_statement="SELECT '$table_name' AS table_name, COUNT(*) AS row_count FROM \"$table_name\";"
  if (( ${#table_verify_statement} > MAX_REMOTE_READ_COMMAND_LENGTH )); then
    echo "error: D1 restore table verification command exceeds its bounded transport contract" >&2
    exit 1
  fi
  CLOUDFLARE_API_TOKEN="$d1_restore_api_token" "$WRANGLER" d1 execute "$D1_RESTORE_TARGET_DATABASE_NAME" --remote \
    --config "$target_config" --command "$table_verify_statement" --json > "$table_verify_json"
  if (( table_index > 0 )); then printf ',\n' >> "$verify_json"; fi
  cat "$table_verify_json" >> "$verify_json"
  table_index=$((table_index + 1))
done
printf '\n]\n' >> "$verify_json"
if ! node -e '
  const fs=require("fs");
  const payload=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const expected=new Map(fs.readFileSync(process.argv[2],"utf8").trim().split("\n").filter(Boolean).map((line)=>{
    const at=line.indexOf("="); return [line.slice(0,at),Number(line.slice(at+1))];
  }));
  if(!Array.isArray(payload)||payload.length!==expected.size) process.exit(1);
  const actual=new Map();
  for(const batch of payload){
    if(!Array.isArray(batch)||batch.length!==1) process.exit(1);
    const entry=batch[0];
    if(entry?.success!==true||entry?.meta?.changes!==0||entry?.meta?.changed_db!==false||!Array.isArray(entry.results)||entry.results.length!==1) process.exit(1);
    const row=entry.results[0];
    if(typeof row?.table_name!=="string"||!Number.isSafeInteger(row?.row_count)||row.row_count<0||actual.has(row.table_name)) process.exit(1);
    actual.set(row.table_name,row.row_count);
  }
  if(actual.size!==expected.size) process.exit(1);
  for(const [name,count] of expected){ if(actual.get(name)!==count) process.exit(1); }
' "$verify_json" "$local_counts"; then
  echo "error: remote D1 restore table row counts differ from the locally verified export" >&2
  exit 1
fi

trigger_verify_sql="$WORK_DIR/target-trigger-verify.sql"
{
  first=1
  printf "SELECT name AS trigger_name, tbl_name AS table_name, sql AS trigger_sql FROM sqlite_master WHERE type='trigger' AND name IN ("
  for trigger_binding in "${required_trigger_bindings[@]}"; do
    trigger_name="${trigger_binding%%=*}"
    if (( first == 0 )); then printf ','; fi
    printf "'%s'" "$trigger_name"
    first=0
  done
  printf ') ORDER BY name;\n'
} > "$trigger_verify_sql"
trigger_verify_statement="$(< "$trigger_verify_sql")"
if (( ${#trigger_verify_statement} > MAX_REMOTE_READ_COMMAND_LENGTH )); then
  echo "error: D1 restore trigger verification command exceeds its bounded transport contract" >&2
  exit 1
fi
trigger_verify_json="$WORK_DIR/target-trigger-verify.json"
CLOUDFLARE_API_TOKEN="$d1_restore_api_token" "$WRANGLER" d1 execute "$D1_RESTORE_TARGET_DATABASE_NAME" --remote \
  --config "$target_config" --command "$trigger_verify_statement" --json > "$trigger_verify_json"
if ! node -e '
  const fs=require("fs");
  const payload=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(!Array.isArray(payload)||payload.length!==1) process.exit(1);
  const entry=payload[0];
  if(entry?.success!==true||entry?.meta?.changes!==0||entry?.meta?.changed_db!==false||!Array.isArray(entry.results)) process.exit(1);
  const rows=entry.results;
  const immutableSemantics=new Map([
    ["prevent_lead_ack_receipts_update",["beforeupdateonlead_ack_receipts","raise(abort,'lead_ack_receipts_immutable')"]],
    ["prevent_lead_ack_receipts_delete",["beforedeleteonlead_ack_receipts","raise(abort,'lead_ack_receipts_immutable')"]],
    ["prevent_approval_request_binding_rewrite",["beforeupdateonapproval_requests","raise(abort,'approval_request_binding_immutable')"]],
    ["prevent_approval_request_event_update",["beforeupdateonapproval_request_events","raise(abort,'approval_request_events_immutable')"]],
    ["prevent_approval_request_event_delete",["beforedeleteonapproval_request_events","raise(abort,'approval_request_events_immutable')"]],
    ["prevent_approval_request_delete",["beforedeleteonapproval_requests","raise(abort,'approval_requests_append_only')"]],
    ["prevent_quote_revision_approval_binding_rewrite",["beforeupdateonquote_revision_approval_requests","raise(abort,'quote_revision_approval_binding_immutable')"]],
    ["prevent_quote_revision_approval_event_update",["beforeupdateonquote_revision_approval_request_events","raise(abort,'quote_revision_approval_events_immutable')"]],
    ["prevent_quote_revision_approval_event_delete",["beforedeleteonquote_revision_approval_request_events","raise(abort,'quote_revision_approval_events_immutable')"]],
    ["prevent_quote_revision_approval_delete",["beforedeleteonquote_revision_approval_requests","raise(abort,'quote_revision_approvals_append_only')"]],
    ["prevent_production_schedule_approval_binding_rewrite",["beforeupdateonproduction_schedule_approval_requests","raise(abort,'production_schedule_approval_binding_immutable')"]],
    ["prevent_production_schedule_approval_event_update",["beforeupdateonproduction_schedule_approval_request_events","raise(abort,'production_schedule_approval_events_immutable')"]],
    ["prevent_production_schedule_approval_event_delete",["beforedeleteonproduction_schedule_approval_request_events","raise(abort,'production_schedule_approval_events_immutable')"]],
    ["prevent_production_schedule_approval_delete",["beforedeleteonproduction_schedule_approval_requests","raise(abort,'production_schedule_approvals_append_only')"]],
    ["prevent_governed_transition_update",["beforeupdateongoverned_transitions","raise(abort,'governed_transitions_immutable')"]],
    ["prevent_governed_transition_delete",["beforedeleteongoverned_transitions","raise(abort,'governed_transitions_append_only')"]],
    ["enforce_governed_transition_outbox_update",["beforeupdateongoverned_transition_outbox","raise(abort,'governed_transition_outbox_binding_immutable')","raise(abort,'governed_transition_outbox_invalid_uncertain_transition')","raise(abort,'governed_transition_outbox_terminal')"]],
    ["prevent_governed_transition_outbox_delete",["beforedeleteongoverned_transition_outbox","raise(abort,'governed_transition_outbox_append_only')"]],
    ["prevent_governed_transition_outbox_event_update",["beforeupdateongoverned_transition_outbox_events","raise(abort,'governed_transition_outbox_events_immutable')"]],
    ["prevent_governed_transition_outbox_event_delete",["beforedeleteongoverned_transition_outbox_events","raise(abort,'governed_transition_outbox_events_append_only')"]],
  ]);
  const expected=new Map(fs.readFileSync(process.argv[2],"utf8").trim().split("\n").filter(Boolean).map((line)=>{
    const at=line.indexOf("=");
    const name=line.slice(0,at); const table=line.slice(at+1);
    if(at<1||!table) process.exit(1);
    return [name,table];
  }));
  const actual=new Map();
  for(const row of rows){
    if(typeof row?.trigger_name!=="string"||typeof row?.table_name!=="string"||typeof row?.trigger_sql!=="string"||!row.trigger_name||!row.table_name||actual.has(row.trigger_name)) process.exit(1);
    const expectedSemantic=immutableSemantics.get(row.trigger_name);
    if(expectedSemantic){
      const normalized=row.trigger_sql.toLowerCase().replace(/\s+/g,"");
      if(!expectedSemantic.every((expected)=>normalized.includes(expected))) process.exit(1);
    }
    actual.set(row.trigger_name,row.table_name);
  }
  if(actual.size!==expected.size) process.exit(1);
  for(const [name,table] of expected){ if(actual.get(name)!==table) process.exit(1); }
' "$trigger_verify_json" "$local_trigger_bindings"; then
  echo "error: remote D1 restore trigger inventory or receipt semantics differ from the locally verified export" >&2
  exit 1
fi

echo "ok: D1 export restored and verified in the exact confirmed non-production drill database"
