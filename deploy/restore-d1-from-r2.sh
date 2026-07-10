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
REQUIRED_TABLES="envelopes,audit_log,dead_letter,source_counts,heartbeat,quickbooks_webhook_receipts,dedup_claims,replay_requests,field_actions,field_action_media,app_users,app_magic_links,app_sessions,app_auth_throttles,app_auth_audit,app_action_throttles,app_device_pairings,app_devices"
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
IFS=',' read -r -a required_tables <<< "$REQUIRED_TABLES"
local_counts="$WORK_DIR/local-table-counts.txt"
: > "$local_counts"
for table_name in "${required_tables[@]}"; do
  present="$(sqlite3 "$verification_db" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$table_name';")"
  if [[ "$present" != "1" ]]; then
    echo "error: restored D1 export is missing required core/auth table: $table_name" >&2
    exit 1
  fi
  row_count="$(sqlite3 "$verification_db" "SELECT COUNT(*) FROM \"$table_name\";")"
  if [[ ! "$row_count" =~ ^[0-9]+$ ]]; then
    echo "error: restored D1 export returned an invalid row count for: $table_name" >&2
    exit 1
  fi
  printf '%s=%s\n' "$table_name" "$row_count" >> "$local_counts"
done

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
preflight_sql="$WORK_DIR/target-preflight.sql"
printf "%s\n" "SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';" > "$preflight_sql"
preflight_json="$WORK_DIR/target-preflight.json"
CLOUDFLARE_API_TOKEN="$d1_restore_api_token" "$WRANGLER" d1 execute "$D1_RESTORE_TARGET_DATABASE_NAME" --remote \
  --config "$target_config" --file "$preflight_sql" --json > "$preflight_json"
preflight_count="$(node -e 'const d=require(process.argv[1]); const a=Array.isArray(d)?d:[d]; if(!a.length||a.some(x=>x?.success!==true))process.exit(1); const n=a[0]?.results?.[0]?.table_count; if(!Number.isInteger(n))process.exit(1); process.stdout.write(String(n))' "$preflight_json")"
if [[ "$preflight_count" != "0" ]]; then
  echo "error: remote D1 restore target must be an empty dedicated drill database" >&2
  exit 1
fi

CLOUDFLARE_API_TOKEN="$d1_restore_api_token" "$WRANGLER" d1 execute "$D1_RESTORE_TARGET_DATABASE_NAME" --remote \
  --config "$target_config" --file "$package/$sql_file" >/dev/null
verify_sql="$WORK_DIR/target-verify.sql"
{
  first=1
  for table_name in "${required_tables[@]}"; do
    if (( first == 0 )); then printf ' UNION ALL '; fi
    printf "SELECT '%s' AS table_name, COUNT(*) AS row_count FROM \"%s\"" "$table_name" "$table_name"
    first=0
  done
  printf ';\n'
} > "$verify_sql"
verify_json="$WORK_DIR/target-verify.json"
CLOUDFLARE_API_TOKEN="$d1_restore_api_token" "$WRANGLER" d1 execute "$D1_RESTORE_TARGET_DATABASE_NAME" --remote \
  --config "$target_config" --file "$verify_sql" --json > "$verify_json"
if ! node -e '
  const fs=require("fs");
  const payload=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const batches=Array.isArray(payload)?payload:[payload];
  if(!batches.length||batches.some((entry)=>entry?.success!==true)) process.exit(1);
  const rows=batches.flatMap((entry)=>Array.isArray(entry.results)?entry.results:[]);
  const expected=new Map(fs.readFileSync(process.argv[2],"utf8").trim().split("\n").filter(Boolean).map((line)=>{
    const at=line.indexOf("="); return [line.slice(0,at),Number(line.slice(at+1))];
  }));
  const actual=new Map();
  for(const row of rows){
    if(typeof row?.table_name!=="string"||!Number.isInteger(row?.row_count)||row.row_count<0||actual.has(row.table_name)) process.exit(1);
    actual.set(row.table_name,row.row_count);
  }
  if(actual.size!==expected.size) process.exit(1);
  for(const [name,count] of expected){ if(actual.get(name)!==count) process.exit(1); }
' "$verify_json" "$local_counts"; then
  echo "error: remote D1 restore table row counts differ from the locally verified export" >&2
  exit 1
fi

echo "ok: D1 export restored and verified in the exact confirmed non-production drill database"
