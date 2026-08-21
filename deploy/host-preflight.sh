#!/usr/bin/env bash
# Fail-closed host prerequisite check. --install installs only OS packages;
# it never accepts or prints credentials, tokens, URLs, or placeholder values.
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/deploy/runtime-lock.json"
MODE="check"
if (( $# > 1 )); then
  echo "error: unsupported invocation; no configuration values are accepted as arguments" >&2
  exit 64
fi

if [[ ! -r "$LOCK" ]]; then
  echo "error: deploy/runtime-lock.json is unavailable" >&2
  exit 1
fi
if (( $# == 1 )); then
  case "$1" in
    --check) MODE="check" ;;
    --install) MODE="install" ;;
    *)
      echo "error: unsupported invocation; only --check or --install is accepted" >&2
      exit 64
      ;;
  esac
fi

if [[ ! -r /etc/os-release ]]; then
  echo "error: /etc/os-release is unavailable; only supported Ubuntu hosts are accepted" >&2
  exit 1
fi
# shellcheck disable=SC1091
source /etc/os-release
# Ubuntu and Debian both. Everything downstream assumes an apt/systemd host, so
# a genuinely different family still exits here rather than failing later in a
# confusing way -- but Debian is the same family, and frappe_docker is an
# ordinary compose topology that does not care which of the two carries it. The
# lock field is still named ubuntu_minimum; renaming it would break the CI
# contract assertion in tools/production-readiness.mjs that reads it by name.
if [[ "${ID:-}" == "ubuntu" ]]; then
  supported_release_pattern='^(22\.04|24\.04)$'
elif [[ "${ID:-}" == "debian" ]]; then
  supported_release_pattern='^(12|13)$'
else
  echo "error: production hosts must run Ubuntu 22.04/24.04 or Debian 12/13" >&2
  exit 1
fi
if [[ ! "${VERSION_ID:-}" =~ $supported_release_pattern ]]; then
  echo "error: unsupported ${ID} release ${VERSION_ID:-unknown}; production hosts must run Ubuntu 22.04/24.04 or Debian 12/13" >&2
  exit 1
fi

if [[ "$MODE" == "install" ]]; then
  if (( EUID != 0 )); then
    echo "error: --install must run as root; no privilege escalation is attempted" >&2
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  packages=(age ca-certificates curl docker.io git jq nodejs openssl rclone sqlite3 tar)
  if apt-cache show docker-compose-v2 >/dev/null 2>&1; then
    packages+=(docker-compose-v2)
  elif apt-cache show docker-compose-plugin >/dev/null 2>&1; then
    packages+=(docker-compose-plugin)
  else
    echo "error: no supported Docker Compose v2 package is available" >&2
    exit 1
  fi
  apt-get install -y --no-install-recommends "${packages[@]}"
  systemctl enable --now docker
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required to validate deploy/runtime-lock.json" >&2
  exit 1
fi
if ! jq -e '
  .schema_version == 1 and
  .policy.architecture == "d1-worker" and
  .policy.erpnext == "forbidden" and
  .policy.floating_references == "forbidden" and
  ((.components | keys | sort) == ["frappe", "frappe_docker", "hermes"]) and
  .host_requirements.ubuntu_minimum == "22.04" and
  (.host_requirements.cpu_cores_minimum | type == "number" and floor == . and . >= 2) and
  (.host_requirements.memory_gib_minimum | type == "number" and floor == . and . >= 8) and
  (.host_requirements.disk_gib_minimum | type == "number" and floor == . and . >= 80) and
  (.host_requirements.node_version_minimum | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
  ((.host_requirements.architectures | sort) == ["x86_64"])
' "$LOCK" >/dev/null 2>&1; then
  echo "error: runtime lock host policy is invalid or not D1/Worker" >&2
  exit 1
fi
HOST_LOCK=()
while IFS= read -r host_lock_line || [[ -n "$host_lock_line" ]]; do
  HOST_LOCK+=("$host_lock_line")
done < <(jq -r '
  .host_requirements.cpu_cores_minimum,
  .host_requirements.memory_gib_minimum,
  .host_requirements.disk_gib_minimum,
  .host_requirements.node_version_minimum,
  (.host_requirements.architectures | join(","))
' "$LOCK")
if (( ${#HOST_LOCK[@]} != 5 )); then
  echo "error: runtime lock host policy is incomplete" >&2
  exit 1
fi
CPU_MINIMUM="${HOST_LOCK[0]}"
MEMORY_GIB_MINIMUM="${HOST_LOCK[1]}"
# How much of the locked memory floor the kernel may reserve before the host is
# judged short. 5% covers the reservation observed on 8 GiB and 64 GiB hosts
# (3.2% and 2.1%); a host genuinely one tier down still fails.
MEMORY_KERNEL_RESERVATION_ALLOWANCE_PERCENT=95
DISK_GIB_MINIMUM="${HOST_LOCK[2]}"
NODE_VERSION_MINIMUM="${HOST_LOCK[3]}"
SUPPORTED_ARCHITECTURES=",${HOST_LOCK[4]},"

version_at_least() {
  local actual="$1" minimum="$2" index
  local -a actual_parts minimum_parts
  [[ "$actual" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$minimum" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS='.' read -r -a actual_parts <<< "$actual"
  IFS='.' read -r -a minimum_parts <<< "$minimum"
  for index in 0 1 2; do
    if (( 10#${actual_parts[index]} > 10#${minimum_parts[index]} )); then return 0; fi
    if (( 10#${actual_parts[index]} < 10#${minimum_parts[index]} )); then return 1; fi
  done
  return 0
}

if ! version_at_least "$NODE_VERSION_MINIMUM" "22.12.0"; then
  echo "error: runtime lock Node.js floor is below 22.12.0" >&2
  exit 1
fi

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }

arch="$(uname -m)"
if [[ "$SUPPORTED_ARCHITECTURES" == *",$arch,"* ]]; then pass "supported CPU architecture"; else fail "unsupported CPU architecture"; fi

cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '0')"
if [[ "$cpu_count" =~ ^[0-9]+$ ]] && (( cpu_count >= CPU_MINIMUM )); then pass "CPU capacity meets the runtime lock"; else fail "CPU capacity is below the runtime lock"; fi

# MemTotal is what the kernel has left after reserving its own memory, so it is
# always a few percent under what the host advertises: a machine sold with 8 GB
# reports about 7.76 GiB and could never satisfy a literal 8 GiB test. Comparing
# the two directly rejects every host bought exactly to the lock's floor, at any
# provider. Allow the reservation; the floor itself is unchanged.
memory_kib="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf '0')"
memory_floor_kib=$(( MEMORY_GIB_MINIMUM * 1024 * 1024 * MEMORY_KERNEL_RESERVATION_ALLOWANCE_PERCENT / 100 ))
if [[ "$memory_kib" =~ ^[0-9]+$ ]] && (( memory_kib >= memory_floor_kib )); then pass "memory capacity meets the runtime lock"; else fail "memory capacity is below the runtime lock"; fi

disk_kib="$(df -Pk / | awk 'NR == 2 {print $4}')"
if [[ "$disk_kib" =~ ^[0-9]+$ ]] && (( disk_kib >= DISK_GIB_MINIMUM * 1024 * 1024 )); then pass "disk capacity meets the runtime lock"; else fail "disk capacity is below the runtime lock"; fi

# cloudflared is intentionally not installed by --install: the supported
# Cloudflare package source must be selected by the operator before this
# fail-closed preflight runs.
for command_name in age cloudflared curl docker git jq node openssl rclone sha256sum sqlite3 tar; do
  if command -v "$command_name" >/dev/null 2>&1; then pass "$command_name available"; else fail "$command_name unavailable"; fi
done

if command -v node >/dev/null 2>&1; then
  node_version="$(node -p 'process.versions.node' 2>/dev/null || printf '0.0.0')"
  if version_at_least "$node_version" "$NODE_VERSION_MINIMUM"; then pass "Node.js meets the runtime lock"; else fail "Node.js is below the runtime lock"; fi
fi
if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then pass "Docker Compose v2 available"; else fail "Docker Compose v2 unavailable"; fi
  if docker info >/dev/null 2>&1; then pass "Docker daemon reachable"; else fail "Docker daemon unavailable to current user"; fi
fi

if command -v timedatectl >/dev/null 2>&1 && timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -Fxq yes; then
  pass "system clock synchronized"
else
  fail "system clock is not confirmed synchronized"
fi

if (( failures > 0 )); then
  printf 'NOT READY: %d host prerequisite check(s) failed\n' "$failures" >&2
  exit 1
fi
echo "READY: host prerequisites pass; no secrets were read or printed"
