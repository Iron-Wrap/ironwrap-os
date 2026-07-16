#!/usr/bin/env bash
# Nightly Frappe-only site backup. A newly created backup set is archived,
# encrypted locally with an offline age recipient, uploaded to R2, verified,
# and only then subjected to retention cleanup.
set -euo pipefail
set +x
umask 077

if (( $# != 0 )); then
  echo "error: this command accepts no arguments; use environment variables" >&2
  exit 64
fi

required_env=(
  FRAPPE_SITE
  BACKEND_CONTAINER
  R2_BACKUP_BUCKET
  RCLONE_CONFIG_R2_TYPE
  RCLONE_CONFIG_R2_PROVIDER
  RCLONE_CONFIG_R2_ACCESS_KEY_ID
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
  RCLONE_CONFIG_R2_ENDPOINT
  BACKUP_AGE_RECIPIENT
  IRONWRAP_OS_IMAGE
)
for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" || "${!name}" == *'<'* || "${!name}" == *'>'* ]]; then
    echo "error: required backup environment is missing or placeholder: $name" >&2
    exit 1
  fi
done

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
if [[ ! "$FRAPPE_SITE" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]; then
  echo "error: FRAPPE_SITE must be a lowercase fully qualified hostname" >&2
  exit 1
fi
if [[ ! "$BACKEND_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "error: BACKEND_CONTAINER has an unsafe format" >&2
  exit 1
fi
if [[ ! "$R2_BACKUP_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ || "$R2_BACKUP_BUCKET" == *..* ]]; then
  echo "error: R2_BACKUP_BUCKET has an unsafe format" >&2
  exit 1
fi
if [[ ! "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || (( RETENTION_DAYS < 7 || RETENTION_DAYS > 365 )); then
  echo "error: BACKUP_RETENTION_DAYS must be an integer from 7 through 365" >&2
  exit 1
fi
if [[ ! "$BACKUP_AGE_RECIPIENT" =~ ^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$ ]]; then
  echo "error: BACKUP_AGE_RECIPIENT must be one valid age public recipient" >&2
  exit 1
fi
if [[ "$RCLONE_CONFIG_R2_TYPE" != "s3" || "$RCLONE_CONFIG_R2_PROVIDER" != "Cloudflare" ]]; then
  echo "error: the R2 rclone remote must use the s3 type and Cloudflare provider" >&2
  exit 1
fi
if [[ ! "$RCLONE_CONFIG_R2_ENDPOINT" =~ ^https://[a-z0-9-]+\.r2\.cloudflarestorage\.com/?$ ]]; then
  echo "error: RCLONE_CONFIG_R2_ENDPOINT must be an HTTPS Cloudflare R2 endpoint" >&2
  exit 1
fi
if [[ ! "$IRONWRAP_OS_IMAGE" =~ ^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ || \
      "$IRONWRAP_OS_IMAGE" == *':latest@'* || "$IRONWRAP_OS_IMAGE" == *//* || "$IRONWRAP_OS_IMAGE" == *..* ]]; then
  echo "error: IRONWRAP_OS_IMAGE must be the deployed image pinned by digest" >&2
  exit 1
fi

for command_name in age basename comm date docker flock mktemp rclone sha256sum sort tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required backup command is unavailable: $command_name" >&2
    exit 1
  fi
done
if ! docker inspect "$BACKEND_CONTAINER" >/dev/null 2>&1; then
  echo "error: BACKEND_CONTAINER is not available" >&2
  exit 1
fi

BACKUP_DIR="/home/frappe/frappe-bench/sites/$FRAPPE_SITE/private/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_ID="$STAMP-$$-$RANDOM"
WORK_DIR="$(mktemp -d -t ironwrap-backup.XXXXXXXX)"
remote="R2:$R2_BACKUP_BUCKET/$FRAPPE_SITE/$RUN_ID"
remote_started=0
remote_complete=0
cleanup() {
  status=$?
  trap - EXIT
  if (( remote_started == 1 && remote_complete == 0 )); then
    if ! rclone purge "$remote" >/dev/null 2>&1; then
      echo "warning: an incomplete remote backup prefix could not be removed; it has no completion marker" >&2
    fi
  fi
  rm -rf -- "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

exec 9>"${TMPDIR:-/tmp}/ironwrap-backup-$FRAPPE_SITE.lock"
if ! flock -n 9; then
  echo "error: another backup is already running for this site" >&2
  exit 1
fi

before="$WORK_DIR/before.txt"
after="$WORK_DIR/after.txt"
created="$WORK_DIR/created.txt"
snapshot="$WORK_DIR/snapshot"
publish="$WORK_DIR/publish"
mkdir -p "$snapshot" "$publish"

docker exec "$BACKEND_CONTAINER" find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' \
  | LC_ALL=C sort -u > "$before"
docker exec "$BACKEND_CONTAINER" bench --site "$FRAPPE_SITE" backup --with-files
docker exec "$BACKEND_CONTAINER" find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' \
  | LC_ALL=C sort -u > "$after"
comm -13 "$before" "$after" > "$created"

if [[ ! -s "$created" ]]; then
  echo "error: bench reported success but produced no new backup artifacts" >&2
  exit 1
fi
database_file=""
site_config_file=""
public_files_file=""
private_files_file=""
while IFS= read -r filename; do
  if [[ ! "$filename" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "error: bench produced a backup filename with an unsafe format" >&2
    exit 1
  fi
  case "$filename" in
    *-database.sql.gz)
      [[ -z "$database_file" ]] || { echo "error: bench produced duplicate database backups" >&2; exit 1; }
      database_file="$filename"
      ;;
    *-site_config_backup.json)
      [[ -z "$site_config_file" ]] || { echo "error: bench produced duplicate site configuration backups" >&2; exit 1; }
      site_config_file="$filename"
      ;;
    *-private-files.tar)
      [[ -z "$private_files_file" ]] || { echo "error: bench produced duplicate private-file backups" >&2; exit 1; }
      private_files_file="$filename"
      ;;
    *-files.tar)
      [[ -z "$public_files_file" ]] || { echo "error: bench produced duplicate public-file backups" >&2; exit 1; }
      public_files_file="$filename"
      ;;
    *)
      echo "error: bench produced an unexpected or non-restorable backup artifact" >&2
      exit 1
      ;;
  esac
done < "$created"
if [[ -z "$database_file" || -z "$site_config_file" || -z "$public_files_file" || -z "$private_files_file" ]]; then
  echo "error: the new Frappe backup set is incomplete" >&2
  exit 1
fi
backup_prefix="${database_file%-database.sql.gz}"
if [[ "${site_config_file%-site_config_backup.json}" != "$backup_prefix" || \
      "${public_files_file%-files.tar}" != "$backup_prefix" || \
      "${private_files_file%-private-files.tar}" != "$backup_prefix" ]]; then
  echo "error: backup artifacts do not belong to one atomic Frappe backup set" >&2
  exit 1
fi

while IFS= read -r filename; do
  docker cp "$BACKEND_CONTAINER:$BACKUP_DIR/$filename" "$snapshot/$filename"
  if [[ ! -f "$snapshot/$filename" || ! -s "$snapshot/$filename" ]]; then
    echo "error: a new backup artifact is missing or empty after docker cp" >&2
    exit 1
  fi
done < "$created"

manifest="$snapshot/IRONWRAP-BACKUP-MANIFEST.txt"
{
  printf 'schema_version=1\n'
  printf 'created_utc=%s\n' "$STAMP"
  printf 'site=%s\n' "$FRAPPE_SITE"
  printf 'format=frappe-v15-bench-backup\n'
  printf 'encrypted=true\n'
  printf 'image=%s\n' "$IRONWRAP_OS_IMAGE"
  printf 'database_file=%s\n' "$database_file"
  printf 'site_config_file=%s\n' "$site_config_file"
  printf 'public_files_file=%s\n' "$public_files_file"
  printf 'private_files_file=%s\n' "$private_files_file"
} > "$manifest"
printf '%s\n' 'IRONWRAP-BACKUP-MANIFEST.txt' >> "$created"

archive="$WORK_DIR/ironwrap-$FRAPPE_SITE-$STAMP.tar.gz"
tar -C "$snapshot" --create --gzip --file "$archive" --verbatim-files-from --files-from "$created"
encrypted="$publish/$(basename "$archive").age"
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted" "$archive"
(cd "$publish" && sha256sum "$(basename "$encrypted")" > "$(basename "$encrypted").sha256")
(cd "$publish" && sha256sum --check "$(basename "$encrypted").sha256" >/dev/null)

remote_started=1
rclone copy "$publish" "$remote" --immutable --transfers 1 --checkers 2
rclone check "$publish" "$remote" --one-way --checkers 2

# A restore process must ignore every prefix without this marker. R2 object
# writes are atomic, so publishing the marker last commits the verified set.
completion_marker="$WORK_DIR/IRONWRAP-BACKUP-COMPLETE"
{
  printf 'schema_version=1\n'
  printf 'created_utc=%s\n' "$STAMP"
  printf 'archive=%s\n' "$(basename "$encrypted")"
  printf 'checksum=%s\n' "$(basename "$encrypted").sha256"
} > "$completion_marker"
rclone copyto "$completion_marker" "$remote/IRONWRAP-BACKUP-COMPLETE" --immutable
remote_complete=1

# Retention runs only after the encrypted object, checksum, and atomic
# completion marker have all been published successfully. Remove completion
# markers first, then keep the encrypted data for an additional hour. A restore
# can therefore never observe a committed marker whose archive was already
# deleted at the retention boundary.
MARKER_RETENTION_HOURS=$((RETENTION_DAYS * 24))
DATA_RETENTION_HOURS=$((MARKER_RETENTION_HOURS + 1))
rclone delete "R2:$R2_BACKUP_BUCKET/$FRAPPE_SITE/" \
  --min-age "${MARKER_RETENTION_HOURS}h" \
  --include '**/IRONWRAP-BACKUP-COMPLETE' \
  --exclude '*'
rclone delete "R2:$R2_BACKUP_BUCKET/$FRAPPE_SITE/" \
  --min-age "${DATA_RETENTION_HOURS}h" \
  --include '**/*.age' \
  --include '**/*.sha256' \
  --exclude '*'
rclone rmdirs "R2:$R2_BACKUP_BUCKET/$FRAPPE_SITE/" --leave-root

echo "ok: encrypted restore-ready Frappe backup committed and verified; retention ${RETENTION_DAYS}d"
