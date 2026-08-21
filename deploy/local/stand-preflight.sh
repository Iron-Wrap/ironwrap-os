#!/usr/bin/env bash
# Fail-closed prerequisite check for the DEVELOPMENT/PROOF stand in deploy/local/.
#
# This is not the production gate and must never be used as one. Production
# admission is deploy/runtime-lock.json enforced by deploy/host-preflight.sh:
# Ubuntu 22.04/24.04, x86_64 only, 2 cores, 8 GiB, 80 GiB. Those files are not
# read for thresholds here and are not modified by this script; the only thing
# this script does with the production lock is assert that it is still intact.
#
# The floor below is measured, not assumed. See deploy/local/stand-floor.json
# for the run it came from.
set -euo pipefail
set +x

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FLOOR="$HERE/stand-floor.json"
PRODUCTION_LOCK="$ROOT/deploy/runtime-lock.json"

# Same stance as the production preflight: this script takes no configuration
# from its caller. Thresholds live in stand-floor.json and nowhere else.
if (( $# > 1 )); then
  echo "error: unsupported invocation; no configuration values are accepted as arguments" >&2
  exit 64
fi
if (( $# == 1 )) && [[ "$1" != "--check" ]]; then
  echo "error: unsupported invocation; only --check is accepted" >&2
  exit 64
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required to validate deploy/local/stand-floor.json" >&2
  exit 1
fi
if [[ ! -r "$FLOOR" ]]; then
  echo "error: deploy/local/stand-floor.json is unavailable" >&2
  exit 1
fi

# The dev floor is self-defending in the same spirit as the production lock:
# it may be lowered only within stated bounds, so it cannot silently become
# "anything goes".
if ! jq -e '
  .schema_version == 1 and
  (.host_requirements.cpu_cores_minimum    | type == "number" and floor == . and . >= 1) and
  (.host_requirements.memory_gib_minimum   | type == "number" and floor == . and . >= 2) and
  (.host_requirements.disk_gib_minimum     | type == "number" and floor == . and . >= 20) and
  ((.host_requirements.architectures | length) > 0) and
  ((.host_requirements.distributions | length) > 0)
' "$FLOOR" >/dev/null 2>&1; then
  echo "error: deploy/local/stand-floor.json is missing or below the permitted development floor" >&2
  exit 1
fi

# Refuse to run in a tree where production policy has been weakened. This script
# exists BECAUSE the production contract is strict; if that stopped being true,
# the separation this file relies on is gone and the operator must know.
if [[ -r "$PRODUCTION_LOCK" ]]; then
  if ! jq -e '
    ((.host_requirements.architectures | sort) == ["x86_64"]) and
    (.host_requirements.memory_gib_minimum >= 8) and
    (.policy.architecture == "d1-worker")
  ' "$PRODUCTION_LOCK" >/dev/null 2>&1; then
    echo "error: deploy/runtime-lock.json no longer states the strict production floor;" >&2
    echo "       the development stand refuses to run against a weakened production contract" >&2
    exit 1
  fi
else
  echo "error: deploy/runtime-lock.json is unavailable; cannot confirm production policy is intact" >&2
  exit 1
fi

CPU_MINIMUM="$(jq -r '.host_requirements.cpu_cores_minimum' "$FLOOR")"
MEMORY_GIB_MINIMUM="$(jq -r '.host_requirements.memory_gib_minimum' "$FLOOR")"
DISK_GIB_MINIMUM="$(jq -r '.host_requirements.disk_gib_minimum' "$FLOOR")"
SUPPORTED_ARCHITECTURES=",$(jq -r '.host_requirements.architectures | join(",")' "$FLOOR"),"
SUPPORTED_DISTRIBUTIONS="$(jq -r '.host_requirements.distributions | join(",")' "$FLOOR")"

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }
warn() { printf 'WARN  %s\n' "$1"; }

echo "IronWrap development stand preflight (deploy/local/)"
echo "This is NOT the production gate. Production remains x86_64 + Ubuntu, 2 cores, 8 GiB, 80 GiB."
echo

if [[ ! -r /etc/os-release ]]; then
  echo "error: /etc/os-release is unavailable" >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
distribution="${ID:-unknown} ${VERSION_ID:-unknown}"
if [[ ",$SUPPORTED_DISTRIBUTIONS," == *",$distribution,"* ]]; then
  pass "supported distribution ($distribution)"
else
  fail "unsupported distribution ($distribution); the stand supports: $SUPPORTED_DISTRIBUTIONS"
fi

arch="$(uname -m)"
if [[ "$SUPPORTED_ARCHITECTURES" == *",$arch,"* ]]; then
  pass "supported CPU architecture ($arch)"
else
  fail "unsupported CPU architecture ($arch)"
fi

cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '0')"
if [[ "$cpu_count" =~ ^[0-9]+$ ]] && (( cpu_count >= CPU_MINIMUM )); then
  pass "CPU capacity meets the stand floor ($cpu_count >= $CPU_MINIMUM)"
else
  fail "CPU capacity is below the stand floor ($cpu_count < $CPU_MINIMUM)"
fi

# MemTotal is always a few percent below the memory a host advertises, because
# the kernel reserves its own. The stand floor is set well clear of that gap;
# the production floor is not, which is why an "8 GB" box fails it.
memory_kib="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf '0')"
if [[ "$memory_kib" =~ ^[0-9]+$ ]] && (( memory_kib >= MEMORY_GIB_MINIMUM * 1024 * 1024 )); then
  pass "memory capacity meets the stand floor ($((memory_kib / 1024 / 1024)) GiB >= $MEMORY_GIB_MINIMUM GiB)"
else
  fail "memory capacity is below the stand floor ($((memory_kib / 1024 / 1024)) GiB < $MEMORY_GIB_MINIMUM GiB)"
fi

disk_kib="$(df -Pk "$ROOT" | awk 'NR == 2 {print $4}')"
if [[ "$disk_kib" =~ ^[0-9]+$ ]] && (( disk_kib >= DISK_GIB_MINIMUM * 1024 * 1024 )); then
  pass "disk capacity meets the stand floor ($((disk_kib / 1024 / 1024)) GiB free >= $DISK_GIB_MINIMUM GiB)"
else
  fail "disk capacity is below the stand floor ($((disk_kib / 1024 / 1024)) GiB free < $DISK_GIB_MINIMUM GiB)"
fi

# The stand needs far less than production: no age, cloudflared or rclone,
# because it neither tunnels ingress nor writes encrypted backups to R2.
for command_name in curl docker git jq openssl tar; do
  if command -v "$command_name" >/dev/null 2>&1; then pass "$command_name available"; else fail "$command_name unavailable"; fi
done

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then pass "Docker Compose v2 available"; else fail "Docker Compose v2 unavailable"; fi
  if docker info >/dev/null 2>&1; then pass "Docker daemon reachable by the current user"; else fail "Docker daemon unavailable to the current user"; fi
fi

# Node is not needed to run the Frappe stack itself, only for predev.mjs and
# the Worker dev server. Missing Node is a limitation, not a failed stand.
if command -v node >/dev/null 2>&1; then
  pass "Node.js available ($(node -p 'process.versions.node' 2>/dev/null || echo unknown))"
else
  warn "Node.js unavailable; the Frappe stack still runs, but predev.mjs and 'wrangler dev' will not"
fi

echo
if (( failures > 0 )); then
  echo "development stand preflight FAILED with $failures problem(s)" >&2
  exit 1
fi
echo "development stand preflight passed"
echo "bring the stack up with:"
echo "  docker compose -f deploy/local/docker-compose.yml --profile frappe up -d"
