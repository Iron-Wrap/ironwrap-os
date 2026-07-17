#!/usr/bin/env bash
# Render the exact upstream Frappe topology with IronWrap's image overlay.
# This is non-mutating: it validates only a clean, pinned checkout and the
# Docker Compose model; it never starts containers or prints configuration.
set -euo pipefail
set +x

if (( $# != 0 )); then
  echo "error: this command accepts no arguments; use environment variables" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/deploy/runtime-lock.json"
OVERLAY="$ROOT/deploy/frappe-compose.override.yml"
: "${FRAPPE_DOCKER_DIR:?FRAPPE_DOCKER_DIR must name the pinned frappe_docker checkout}"
: "${IRONWRAP_OS_IMAGE:?IRONWRAP_OS_IMAGE must be a digest-pinned release image}"

for command_name in docker git node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command is unavailable: $command_name" >&2
    exit 1
  fi
done
if [[ ! -r "$LOCK" || ! -r "$OVERLAY" || ! -d "$FRAPPE_DOCKER_DIR/.git" ]]; then
  echo "error: deployment lock, overlay, or pinned frappe_docker checkout is unavailable" >&2
  exit 1
fi
if ! node - "$IRONWRAP_OS_IMAGE" <<'NODE'
const image = process.argv[2] ?? "";
if (!/^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/.test(image) ||
    image.includes("//") || image.includes("..")) {
  process.exit(1);
}
NODE
then
  echo "error: IRONWRAP_OS_IMAGE must be a registry-qualified sha256 image digest" >&2
  exit 1
fi

if ! FRAPPE_DOCKER_COMMIT="$(node - "$LOCK" <<'NODE'
const fs = require("node:fs");
try {
  const lock = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const commit = lock.components?.frappe_docker?.git_commit;
  if (lock.schema_version !== 1 || lock.policy?.architecture !== "frappe-only" ||
      lock.policy?.erpnext !== "forbidden" || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
    process.exit(1);
  }
  process.stdout.write(commit);
} catch {
  process.exit(1);
}
NODE
)"; then
  echo "error: deploy/runtime-lock.json does not carry a valid Frappe-only frappe_docker commit" >&2
  exit 1
fi
if [[ "$(git -C "$FRAPPE_DOCKER_DIR" rev-parse --show-toplevel)" != "$(cd "$FRAPPE_DOCKER_DIR" && pwd -P)" ]] || \
   [[ "$(git -C "$FRAPPE_DOCKER_DIR" rev-parse HEAD)" != "$FRAPPE_DOCKER_COMMIT" ]] || \
   [[ -n "$(git -C "$FRAPPE_DOCKER_DIR" status --porcelain=v1 --untracked-files=all --ignore-submodules=none)" ]]; then
  echo "error: frappe_docker must be a clean checkout at the exact runtime-lock commit" >&2
  exit 1
fi

for relative in compose.yaml overrides/compose.mariadb.yaml overrides/compose.redis.yaml; do
  if [[ ! -r "$FRAPPE_DOCKER_DIR/$relative" ]]; then
    echo "error: pinned frappe_docker checkout is missing $relative" >&2
    exit 1
  fi
done

compose=(
  compose
  --project-directory "$FRAPPE_DOCKER_DIR"
  -f "$FRAPPE_DOCKER_DIR/compose.yaml"
  -f "$FRAPPE_DOCKER_DIR/overrides/compose.mariadb.yaml"
  -f "$FRAPPE_DOCKER_DIR/overrides/compose.redis.yaml"
  -f "$OVERLAY"
)
# The pinned upstream compose retains this interpolation in an unused common
# anchor. Supply a benign parser-only value so validation stays silent while
# the IronWrap overlay still replaces every actual app-process image.
if ! ERPNEXT_VERSION="unused" docker "${compose[@]}" config --quiet; then
  echo "error: locked Frappe compose topology does not render with the IronWrap overlay" >&2
  exit 1
fi
if ! rendered="$(ERPNEXT_VERSION="unused" docker "${compose[@]}" config --format json)"; then
  echo "error: locked Frappe compose topology could not render for image verification" >&2
  exit 1
fi
if ! printf '%s' "$rendered" | node -e '
const fs = require("node:fs");
const expected = process.argv[1];
try {
  const rendered = JSON.parse(fs.readFileSync(0, "utf8"));
  const names = ["configurator", "backend", "frontend", "websocket", "queue-short", "queue-long", "scheduler"];
  if (!names.every((name) => rendered.services?.[name]?.image === expected && rendered.services[name].platform === "linux/amd64")) {
    process.exit(1);
  }
} catch {
  process.exit(1);
}
' "$IRONWRAP_OS_IMAGE"; then
  echo "error: every Frappe app process must resolve to the same x86_64 IronWrap image digest" >&2
  exit 1
fi

echo "READY: pinned Frappe compose topology resolves every app process to the IronWrap image digest"
