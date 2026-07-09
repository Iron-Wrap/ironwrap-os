#!/usr/bin/env bash
# Nightly Frappe site backup pushed to Cloudflare R2 (free tier). Run via cron
# on the VM, with the backup block from deploy/env.example exported.
#   15 9 * * * /home/ubuntu/ironwrap-ops/deploy/backup-to-r2.sh >> /var/log/ironwrap-backup.log 2>&1
# Requires: docker (frappe_docker running), rclone (env-configured remote "R2").
set -euo pipefail

: "${FRAPPE_SITE:?FRAPPE_SITE required}"
: "${BACKEND_CONTAINER:?BACKEND_CONTAINER required}"
: "${R2_BACKUP_BUCKET:?R2_BACKUP_BUCKET required}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

# 1) Take the backup (database + public/private files) inside the backend container.
docker exec "$BACKEND_CONTAINER" bench --site "$FRAPPE_SITE" backup --with-files

# 2) Copy the site's backup dir to R2, then prune old copies remotely.
BACKUP_DIR="/home/frappe/frappe-bench/sites/$FRAPPE_SITE/private/backups"
STAMP="$(date -u +%Y-%m-%d)"
docker cp "$BACKEND_CONTAINER:$BACKUP_DIR" "/tmp/ironwrap-backup-$STAMP"
rclone copy "/tmp/ironwrap-backup-$STAMP" "R2:$R2_BACKUP_BUCKET/$FRAPPE_SITE/" --transfers 2
rm -rf "/tmp/ironwrap-backup-$STAMP"
rclone delete "R2:$R2_BACKUP_BUCKET/$FRAPPE_SITE/" --min-age "${RETENTION_DAYS}d"

echo "ok: $FRAPPE_SITE backed up to R2:$R2_BACKUP_BUCKET ($STAMP), retention ${RETENTION_DAYS}d"
