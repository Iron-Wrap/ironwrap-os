#!/usr/bin/env bash
# Verify an explicitly selected, completed R2 backup or restore it into a
# labelled, isolated Frappe drill target. Configuration is environment-only so
# identities, object paths, and target names never enter this command's argv.
set -euo pipefail
set +x
umask 077

mode="verify"
if (( $# == 1 )); then
  case "$1" in
    --verify) mode="verify" ;;
    --restore) mode="restore" ;;
    *)
      echo "error: only the fixed --verify or --restore mode flag is accepted" >&2
      exit 64
      ;;
  esac
elif (( $# != 0 )); then
  echo "error: only one fixed mode flag is accepted; use environment variables for configuration" >&2
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
  IRONWRAP_OS_IMAGE
  RESTORE_R2_COMPLETED_PREFIX
  RESTORE_AGE_IDENTITY_FILE
  RESTORE_TARGET_SITE
  RESTORE_TARGET_CONTAINER
)
for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" || "${!name}" == *'<'* || "${!name}" == *'>'* ]]; then
    echo "error: required restore environment is missing or placeholder: $name" >&2
    exit 1
  fi
done

valid_site='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
valid_container='^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
if [[ ! "$FRAPPE_SITE" =~ $valid_site || ! "$RESTORE_TARGET_SITE" =~ $valid_site ]]; then
  echo "error: source and target sites must be lowercase fully qualified hostnames" >&2
  exit 1
fi
if [[ ! "$BACKEND_CONTAINER" =~ $valid_container || ! "$RESTORE_TARGET_CONTAINER" =~ $valid_container ]]; then
  echo "error: source and target containers must have safe names" >&2
  exit 1
fi
if [[ "$RESTORE_TARGET_SITE" == "$FRAPPE_SITE" ]]; then
  echo "error: the recorded production site can never be a restore target" >&2
  exit 1
fi
if [[ "$RESTORE_TARGET_CONTAINER" == "$BACKEND_CONTAINER" ]]; then
  echo "error: the recorded production container can never be a restore target" >&2
  exit 1
fi
if [[ ! "$R2_BACKUP_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ || "$R2_BACKUP_BUCKET" == *..* ]]; then
  echo "error: R2_BACKUP_BUCKET has an unsafe format" >&2
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

# A restore never discovers "latest". The operator must bind it to one exact,
# marker-bearing prefix created by backup-to-r2.sh.
if [[ "$RESTORE_R2_COMPLETED_PREFIX" == /* || "$RESTORE_R2_COMPLETED_PREFIX" == */ || \
      "$RESTORE_R2_COMPLETED_PREFIX" == *..* || "$RESTORE_R2_COMPLETED_PREFIX" == *//* || \
      "$RESTORE_R2_COMPLETED_PREFIX" != "$FRAPPE_SITE"/* ]]; then
  echo "error: RESTORE_R2_COMPLETED_PREFIX must select one exact run under the recorded production site" >&2
  exit 1
fi
run_id="${RESTORE_R2_COMPLETED_PREFIX#*/}"
if [[ "$run_id" == */* || ! "$run_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+$ ]]; then
  echo "error: RESTORE_R2_COMPLETED_PREFIX does not identify one valid completed backup run" >&2
  exit 1
fi
if [[ "$RESTORE_AGE_IDENTITY_FILE" != /* || ! -f "$RESTORE_AGE_IDENTITY_FILE" || \
      -L "$RESTORE_AGE_IDENTITY_FILE" || ! -r "$RESTORE_AGE_IDENTITY_FILE" ]]; then
  echo "error: RESTORE_AGE_IDENTITY_FILE must be an absolute, readable, regular non-symlink file" >&2
  exit 1
fi
identity_mode=""
if identity_mode="$(stat -f '%Lp' "$RESTORE_AGE_IDENTITY_FILE" 2>/dev/null)"; then
  :
elif identity_mode="$(stat -c '%a' "$RESTORE_AGE_IDENTITY_FILE" 2>/dev/null)"; then
  :
else
  echo "error: unable to verify age identity file permissions" >&2
  exit 1
fi
if [[ "$identity_mode" != "400" && "$identity_mode" != "600" && \
      "$identity_mode" != "0400" && "$identity_mode" != "0600" ]]; then
  echo "error: RESTORE_AGE_IDENTITY_FILE must have exact mode 0400 or 0600" >&2
  exit 1
fi

for command_name in age docker find flock mktemp python3 rclone sha256sum sort stat tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required restore command is unavailable: $command_name" >&2
    exit 1
  fi
done

if ! docker inspect "$RESTORE_TARGET_CONTAINER" >/dev/null 2>&1; then
  echo "error: RESTORE_TARGET_CONTAINER is not available" >&2
  exit 1
fi
target_label="$(docker inspect --format '{{ index .Config.Labels "com.ironwrap.restore-target" }}' "$RESTORE_TARGET_CONTAINER")"
if [[ "$target_label" != "true" ]]; then
  echo "error: target container lacks the required com.ironwrap.restore-target=true isolation label" >&2
  exit 1
fi
target_image="$(docker inspect --format '{{.Config.Image}}' "$RESTORE_TARGET_CONTAINER")"
if [[ "$target_image" != "$IRONWRAP_OS_IMAGE" ]]; then
  echo "error: target container image does not match the pinned production image" >&2
  exit 1
fi
target_network_json="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$RESTORE_TARGET_CONTAINER")"
target_networks=()
while IFS= read -r target_network || [[ -n "$target_network" ]]; do
  target_networks+=("$target_network")
done < <(python3 -c \
  'import json,sys; value=json.loads(sys.argv[1]); [print(name) for name in sorted(value) if isinstance(name,str)]' \
  "$target_network_json")
if (( ${#target_networks[@]} == 0 )); then
  echo "error: isolated restore target has no declared internal database network" >&2
  exit 1
fi
for network in "${target_networks[@]}"; do
  if [[ "$(docker network inspect --format '{{.Internal}}' "$network")" != "true" ]]; then
    echo "error: every restore-target Docker network must be internal with no external route" >&2
    exit 1
  fi
done
if [[ -n "$(docker port "$RESTORE_TARGET_CONTAINER")" ]]; then
  echo "error: restore target must not publish host ports" >&2
  exit 1
fi
target_site_dir="/home/frappe/frappe-bench/sites/$RESTORE_TARGET_SITE"
target_site_config="$target_site_dir/site_config.json"
if ! docker exec "$RESTORE_TARGET_CONTAINER" test -f "$target_site_config"; then
  echo "error: isolated target site is not initialized" >&2
  exit 1
fi
target_config_status="$(docker exec "$RESTORE_TARGET_CONTAINER" python3 -c \
  'import json,os,sys; site=json.load(open(sys.argv[1])); common_path=os.path.join(os.path.dirname(os.path.dirname(sys.argv[1])),"common_site_config.json"); common=json.load(open(common_path)) if os.path.isfile(common_path) else {}; name=site.get("db_name"); root=site.get("root_password") or common.get("root_password"); print((name if isinstance(name,str) else "")+"|"+("root-ready" if isinstance(root,str) and len(root)>=16 else "root-missing"))' \
  "$target_site_config")"
target_db_name="${target_config_status%%|*}"
target_root_status="${target_config_status#*|}"
if [[ -z "$target_db_name" || ! "$target_db_name" =~ ^[A-Za-z0-9_-]{1,128}$ || "$target_root_status" != "root-ready" ]]; then
  echo "error: isolated target site must have a safe database binding and a non-interactive target-only root credential" >&2
  exit 1
fi

if [[ "$mode" == "restore" ]]; then
  expected_confirmation="RESTORE:$RESTORE_TARGET_SITE@$RESTORE_TARGET_CONTAINER"
  if [[ "${RESTORE_CONFIRMATION:-}" != "$expected_confirmation" ]]; then
    echo "error: destructive confirmation is missing or is not bound to this exact target" >&2
    exit 1
  fi
elif [[ -n "${RESTORE_CONFIRMATION:-}" ]]; then
  echo "error: RESTORE_CONFIRMATION must remain unset in verification mode" >&2
  exit 1
fi

exec 9>"${TMPDIR:-/tmp}/ironwrap-restore-$RESTORE_TARGET_SITE.lock"
if ! flock -n 9; then
  echo "error: another restore drill is already running for this target" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d -t ironwrap-restore.XXXXXXXX)"
container_stage=""
cleanup() {
  status=$?
  trap - EXIT
  if [[ -n "$container_stage" ]]; then
    docker exec "$RESTORE_TARGET_CONTAINER" rm -rf -- "$container_stage" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

remote="R2:$R2_BACKUP_BUCKET/$RESTORE_R2_COMPLETED_PREFIX"
marker="$WORK_DIR/IRONWRAP-BACKUP-COMPLETE"
if ! rclone cat "$remote/IRONWRAP-BACKUP-COMPLETE" > "$marker"; then
  echo "error: the selected backup has no readable completion marker" >&2
  exit 1
fi

marker_schema=""
marker_created=""
marker_archive=""
marker_checksum=""
marker_count=0
while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
  if [[ -z "$key" || -z "$value" || "$value" == *$'\r'* || "$value" == *$'\n'* ]]; then
    echo "error: completion marker is malformed" >&2
    exit 1
  fi
  case "$key" in
    schema_version) [[ -z "$marker_schema" ]] || exit 1; marker_schema="$value" ;;
    created_utc) [[ -z "$marker_created" ]] || exit 1; marker_created="$value" ;;
    archive) [[ -z "$marker_archive" ]] || exit 1; marker_archive="$value" ;;
    checksum) [[ -z "$marker_checksum" ]] || exit 1; marker_checksum="$value" ;;
    *) echo "error: completion marker contains an unexpected field" >&2; exit 1 ;;
  esac
  marker_count=$((marker_count + 1))
done < "$marker"
if [[ "$marker_count" != 4 || "$marker_schema" != "1" || \
      ! "$marker_created" =~ ^[0-9]{8}T[0-9]{6}Z$ || \
      "$marker_archive" != "ironwrap-$FRAPPE_SITE-$marker_created.tar.gz.age" || \
      "$marker_checksum" != "$marker_archive.sha256" ]]; then
  echo "error: completion marker does not describe one supported immutable backup" >&2
  exit 1
fi

download="$WORK_DIR/download"
mkdir -m 700 "$download"
encrypted="$download/$marker_archive"
checksum="$download/$marker_checksum"
rclone copyto "$remote/$marker_archive" "$encrypted" --immutable
rclone copyto "$remote/$marker_checksum" "$checksum" --immutable
if [[ ! -s "$encrypted" || ! -s "$checksum" ]]; then
  echo "error: completed backup archive or checksum is missing or empty" >&2
  exit 1
fi
checksum_line="$(<"$checksum")"
if [[ ! "$checksum_line" =~ ^[0-9a-f]{64}[[:space:]][[:space:]]${marker_archive}$ ]]; then
  echo "error: remote checksum document is malformed or names a different archive" >&2
  exit 1
fi
(cd "$download" && sha256sum --check "$marker_checksum" >/dev/null)

archive="$WORK_DIR/${marker_archive%.age}"
age --decrypt --identity "$RESTORE_AGE_IDENTITY_FILE" --output "$archive" "$encrypted"
if [[ ! -s "$archive" ]]; then
  echo "error: decrypted backup package is missing or empty" >&2
  exit 1
fi

entries="$WORK_DIR/archive-entries.txt"
verbose_entries="$WORK_DIR/archive-entries-verbose.txt"
tar -tzf "$archive" > "$entries"
tar -tvzf "$archive" > "$verbose_entries"
entry_count=0
# Newline-sentinelled exact-membership set (bash 3.2 has no associative arrays).
seen_entries=$'\n'
while IFS= read -r entry || [[ -n "$entry" ]]; do
  if [[ -z "$entry" || "$entry" == */* || "$entry" == .* || "$entry" == -* || \
        ! "$entry" =~ ^[A-Za-z0-9._-]+$ || "$seen_entries" == *$'\n'"$entry"$'\n'* ]]; then
    echo "error: archive contains traversal, duplicate, or unsafe paths" >&2
    exit 1
  fi
  case "$entry" in
    IRONWRAP-BACKUP-MANIFEST.txt|*-database.sql.gz|*-site_config_backup.json|*-private-files.tar|*-files.tar) ;;
    *) echo "error: archive contains an unexpected file" >&2; exit 1 ;;
  esac
  seen_entries+="$entry"$'\n'
  entry_count=$((entry_count + 1))
done < "$entries"
if (( entry_count != 5 )); then
  echo "error: archive must contain exactly the manifest and four restore artifacts" >&2
  exit 1
fi
verbose_count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "${line:0:1}" != "-" ]]; then
    echo "error: archive links, directories, and non-regular entries are forbidden" >&2
    exit 1
  fi
  verbose_count=$((verbose_count + 1))
done < "$verbose_entries"
if (( verbose_count != entry_count )); then
  echo "error: archive metadata and entry list disagree" >&2
  exit 1
fi

package="$WORK_DIR/package"
mkdir -m 700 "$package"
tar -xzf "$archive" -C "$package"
chmod 700 "$package"
find "$package" -mindepth 1 -maxdepth 1 -type f -exec chmod 600 {} +
if [[ "$(find "$package" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" != "5" || \
      -n "$(find "$package" -mindepth 1 -maxdepth 1 ! -type f -print -quit)" ]]; then
  echo "error: extracted package contains an unexpected object" >&2
  exit 1
fi

manifest="$package/IRONWRAP-BACKUP-MANIFEST.txt"
manifest_schema=""
manifest_created=""
manifest_site=""
manifest_format=""
manifest_encrypted=""
manifest_image=""
database_file=""
site_config_file=""
public_files_file=""
private_files_file=""
manifest_count=0
while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
  if [[ -z "$key" || -z "$value" || "$value" == *$'\r'* || "$value" == *$'\n'* ]]; then
    echo "error: restore manifest is malformed" >&2
    exit 1
  fi
  case "$key" in
    schema_version) [[ -z "$manifest_schema" ]] || exit 1; manifest_schema="$value" ;;
    created_utc) [[ -z "$manifest_created" ]] || exit 1; manifest_created="$value" ;;
    site) [[ -z "$manifest_site" ]] || exit 1; manifest_site="$value" ;;
    format) [[ -z "$manifest_format" ]] || exit 1; manifest_format="$value" ;;
    encrypted) [[ -z "$manifest_encrypted" ]] || exit 1; manifest_encrypted="$value" ;;
    image) [[ -z "$manifest_image" ]] || exit 1; manifest_image="$value" ;;
    database_file) [[ -z "$database_file" ]] || exit 1; database_file="$value" ;;
    site_config_file) [[ -z "$site_config_file" ]] || exit 1; site_config_file="$value" ;;
    public_files_file) [[ -z "$public_files_file" ]] || exit 1; public_files_file="$value" ;;
    private_files_file) [[ -z "$private_files_file" ]] || exit 1; private_files_file="$value" ;;
    *) echo "error: restore manifest contains an unexpected field" >&2; exit 1 ;;
  esac
  manifest_count=$((manifest_count + 1))
done < "$manifest"
if (( manifest_count != 10 )) || [[ "$manifest_schema" != "1" || \
      "$manifest_created" != "$marker_created" || "$manifest_site" != "$FRAPPE_SITE" || \
      "$manifest_format" != "frappe-v15-bench-backup" || "$manifest_encrypted" != "true" || \
      "$manifest_image" != "$IRONWRAP_OS_IMAGE" ]]; then
  echo "error: restore manifest schema, source site, timestamp, format, or image does not match" >&2
  exit 1
fi
for filename in "$database_file" "$site_config_file" "$public_files_file" "$private_files_file"; do
  if [[ ! "$filename" =~ ^[A-Za-z0-9._-]+$ || "$seen_entries" != *$'\n'"$filename"$'\n'* || \
        ! -f "$package/$filename" || ! -s "$package/$filename" ]]; then
    echo "error: restore manifest references a missing, unsafe, or empty artifact" >&2
    exit 1
  fi
done
backup_prefix="${database_file%-database.sql.gz}"
if [[ "$database_file" != "$backup_prefix-database.sql.gz" || \
      "$site_config_file" != "$backup_prefix-site_config_backup.json" || \
      "$public_files_file" != "$backup_prefix-files.tar" || \
      "$private_files_file" != "$backup_prefix-private-files.tar" ]]; then
  echo "error: restore artifacts are not one atomic Frappe backup set" >&2
  exit 1
fi

# Source site_config is validated only to prove package integrity and isolation.
# It is never copied into the target; the target keeps its own pre-created config.
source_db_name="$(python3 -c \
  'import json,sys; value=json.load(open(sys.argv[1])); name=value.get("db_name"); print(name if isinstance(name,str) else "")' \
  "$package/$site_config_file")"
if [[ -z "$source_db_name" || ! "$source_db_name" =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
  echo "error: source site configuration has an invalid database binding" >&2
  exit 1
fi
if [[ "$source_db_name" == "$target_db_name" ]]; then
  echo "error: target database binding is not isolated from the source backup" >&2
  exit 1
fi
sanitized_key_file="$package/IRONWRAP-RESTORE-ENCRYPTION-KEY.json"
if ! python3 -c \
  'import json,os,sys; source=json.load(open(sys.argv[1])); key=source.get("encryption_key"); isinstance(key,str) and len(key)>=24 and "\n" not in key and "\r" not in key or sys.exit(1); fd=os.open(sys.argv[2],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.write(fd,json.dumps({"encryption_key":key},separators=(",", ":")).encode()+b"\n"); os.close(fd)' \
  "$package/$site_config_file" "$sanitized_key_file"; then
  echo "error: source site configuration lacks a valid Frappe encryption key" >&2
  exit 1
fi

if [[ "$mode" == "verify" ]]; then
  echo "ok: completed backup cryptographically verified for isolated target; no restore mutation performed"
  exit 0
fi

container_stage="$(docker exec "$RESTORE_TARGET_CONTAINER" mktemp -d -p /tmp ironwrap-restore.XXXXXXXX)"
if [[ ! "$container_stage" =~ ^/tmp/ironwrap-restore\.[A-Za-z0-9]+$ ]]; then
  echo "error: isolated target returned an unsafe staging directory" >&2
  exit 1
fi
for filename in "$database_file" "$public_files_file" "$private_files_file" "$(basename "$sanitized_key_file")"; do
  docker cp "$package/$filename" "$RESTORE_TARGET_CONTAINER:$container_stage/$filename"
done
docker exec "$RESTORE_TARGET_CONTAINER" bench --site "$RESTORE_TARGET_SITE" restore \
  "$container_stage/$database_file" \
  --with-public-files "$container_stage/$public_files_file" \
  --with-private-files "$container_stage/$private_files_file"
docker exec "$RESTORE_TARGET_CONTAINER" python3 -c \
  'import json,os,sys,tempfile; target,key_path=sys.argv[1:3]; current=json.load(open(target)); incoming=json.load(open(key_path)); key=incoming.get("encryption_key"); isinstance(key,str) and len(key)>=24 or sys.exit(1); directory=os.path.dirname(target); fd,tmp=tempfile.mkstemp(dir=directory,prefix=".site_config.",text=True); os.fchmod(fd,0o600); os.write(fd,(json.dumps({**current,"encryption_key":key},indent=2,sort_keys=True)+"\n").encode()); os.close(fd); os.replace(tmp,target)' \
  "$target_site_config" "$container_stage/$(basename "$sanitized_key_file")"
docker exec "$RESTORE_TARGET_CONTAINER" bench --site "$RESTORE_TARGET_SITE" migrate

echo "ok: isolated restore and migration completed; only the source encryption key was merged into target-owned site configuration"
