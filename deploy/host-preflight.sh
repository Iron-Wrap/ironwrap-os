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
if [[ "${ID:-}" != "ubuntu" || ! "${VERSION_ID:-}" =~ ^(22\.04|24\.04)$ ]]; then
  echo "error: production hosts must run Ubuntu 22.04 or 24.04" >&2
  exit 1
fi

if [[ "$MODE" == "install" ]]; then
  if (( EUID != 0 )); then
    echo "error: --install must run as root; no privilege escalation is attempted" >&2
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  packages=(age ca-certificates curl docker.io git jq nodejs openssl rclone)
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
  .policy.architecture == "frappe-only" and
  .policy.erpnext == "forbidden" and
  .policy.floating_references == "forbidden" and
  ((.components | keys | sort) == ["frappe", "frappe_docker", "hermes"]) and
  .host_requirements.ubuntu_minimum == "22.04" and
  (.host_requirements.cpu_cores_minimum | type == "number" and floor == . and . >= 2) and
  (.host_requirements.memory_gib_minimum | type == "number" and floor == . and . >= 8) and
  (.host_requirements.disk_gib_minimum | type == "number" and floor == . and . >= 80) and
  (.host_requirements.node_major_minimum | type == "number" and floor == . and . >= 20) and
  ((.host_requirements.architectures | sort) == ["aarch64", "x86_64"])
' "$LOCK" >/dev/null 2>&1; then
  echo "error: runtime lock host policy is invalid or not Frappe-only" >&2
  exit 1
fi
readarray -t HOST_LOCK < <(jq -r '
  .host_requirements.cpu_cores_minimum,
  .host_requirements.memory_gib_minimum,
  .host_requirements.disk_gib_minimum,
  .host_requirements.node_major_minimum,
  (.host_requirements.architectures | join(","))
' "$LOCK")
if (( ${#HOST_LOCK[@]} != 5 )); then
  echo "error: runtime lock host policy is incomplete" >&2
  exit 1
fi
CPU_MINIMUM="${HOST_LOCK[0]}"
MEMORY_GIB_MINIMUM="${HOST_LOCK[1]}"
DISK_GIB_MINIMUM="${HOST_LOCK[2]}"
NODE_MAJOR_MINIMUM="${HOST_LOCK[3]}"
SUPPORTED_ARCHITECTURES=",${HOST_LOCK[4]},"

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }

arch="$(uname -m)"
if [[ "$SUPPORTED_ARCHITECTURES" == *",$arch,"* ]]; then pass "supported CPU architecture"; else fail "unsupported CPU architecture"; fi

cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '0')"
if [[ "$cpu_count" =~ ^[0-9]+$ ]] && (( cpu_count >= CPU_MINIMUM )); then pass "CPU capacity meets the runtime lock"; else fail "CPU capacity is below the runtime lock"; fi

memory_kib="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf '0')"
if [[ "$memory_kib" =~ ^[0-9]+$ ]] && (( memory_kib >= MEMORY_GIB_MINIMUM * 1024 * 1024 )); then pass "memory capacity meets the runtime lock"; else fail "memory capacity is below the runtime lock"; fi

disk_kib="$(df -Pk / | awk 'NR == 2 {print $4}')"
if [[ "$disk_kib" =~ ^[0-9]+$ ]] && (( disk_kib >= DISK_GIB_MINIMUM * 1024 * 1024 )); then pass "disk capacity meets the runtime lock"; else fail "disk capacity is below the runtime lock"; fi

for command_name in age curl docker git jq node openssl rclone sha256sum tar; do
  if command -v "$command_name" >/dev/null 2>&1; then pass "$command_name available"; else fail "$command_name unavailable"; fi
done

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"
  if [[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= NODE_MAJOR_MINIMUM )); then pass "Node.js meets the runtime lock"; else fail "Node.js is below the runtime lock"; fi
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
