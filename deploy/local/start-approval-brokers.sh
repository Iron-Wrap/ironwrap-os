#!/usr/bin/env bash
# Start the two approval brokers that steps 5 and 6 of the six-step workflow run
# through, against the local Frappe stack (development only, never production).
#
# Publishing a proposal (step 5) and scheduling production (step 6) are approved
# writes: the Worker never touches Frappe for them, it calls a private broker that
# holds the Hermes signing material and its own operator identity. Nothing scripted
# started those brokers before this file existed, so a local capstone traverse had
# to hand-write two env files and hand-create a Frappe user first (ELEC-95).
#
#   deploy/local/predev.mjs  writes deploy/local/keys/<broker>.env (throwaway values)
#   this script              turns those files into two running processes
#
# Usage:
#   deploy/local/start-approval-brokers.sh [start|stop|status] [--foreground]
#
# start       start both brokers in the background, wait until each answers, print status
# --foreground  same, but stay attached and stop both children on Ctrl-C or SIGTERM
# stop        stop whatever this script started
# status      report which brokers are answering
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEYS_DIR="$ROOT_DIR/deploy/local/keys"
LOG_DIR="$ROOT_DIR/.runtime-logs"
MCP_DIR="$ROOT_DIR/mcp/erpnext-roofing-mcp"
# Follows the same IRONWRAP_LOCAL_FRAPPE_PORT a second stack exports for compose and
# predev, so one variable moves the whole stack instead of three that must agree.
FRAPPE_URL="${IRONWRAP_LOCAL_FRAPPE_URL:-http://localhost:${IRONWRAP_LOCAL_FRAPPE_PORT:-8000}}"
WAIT_SECONDS="${IRONWRAP_BROKER_WAIT_SECONDS:-180}"
# Set by a caller that runs the Worker somewhere other than the predev default
# (start-local-runtime.sh picks its own free bus port).
EFFECT_RUNTIME_URL_OVERRIDE="${IRONWRAP_EFFECT_RUNTIME_URL:-}"

# name : broker entrypoint : port variable in its env file
BROKERS=(
  "proposal-publication:proposal-publication-approval-broker.mjs:PROPOSAL_PUBLICATION_BROKER_PORT"
  "production-schedule:production-schedule-approval-broker.mjs:PRODUCTION_SCHEDULE_BROKER_PORT"
)

MODE="start"
FOREGROUND="false"
for arg in "$@"; do
  case "$arg" in
    start|stop|status) MODE="$arg" ;;
    --foreground) FOREGROUND="true" ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[approval-brokers] %s\n' "$*"; }
fail() { printf '[approval-brokers] ERROR: %s\n' "$*" >&2; exit 1; }

field() { echo "$1" | cut -d: -f"$2"; }
env_file() { echo "$KEYS_DIR/$1-broker.env"; }
pid_file() { echo "$LOG_DIR/$1-broker.pid"; }
log_file() { echo "$LOG_DIR/$1-broker.log"; }

broker_port() {
  local name="$1" var="$2"
  awk -F= -v key="$var" '$1 == key { print $2 }' "$(env_file "$name")" | tr -d '\r' | head -n1
}

broker_answers() {
  curl -sS -o /dev/null --max-time 2 "http://127.0.0.1:$1/" >/dev/null 2>&1
}

stop_brokers() {
  for spec in "${BROKERS[@]}"; do
    local name pid
    name="$(field "$spec" 1)"
    pid="$(cat "$(pid_file "$name")" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "stopping $name broker (pid $pid)"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$(pid_file "$name")"
  done
}

report_status() {
  local any_down="false"
  for spec in "${BROKERS[@]}"; do
    local name port
    name="$(field "$spec" 1)"
    port="$(broker_port "$name" "$(field "$spec" 3)" 2>/dev/null || true)"
    if [ -n "$port" ] && broker_answers "$port"; then
      log "$name broker: answering on http://127.0.0.1:$port"
    else
      log "$name broker: NOT answering${port:+ on http://127.0.0.1:$port}"
      any_down="true"
    fi
  done
  [ "$any_down" = "false" ]
}

case "$MODE" in
  stop) stop_brokers; exit 0 ;;
  status) if report_status; then exit 0; else exit 1; fi ;;
esac

mkdir -p "$LOG_DIR"

# `npm run dev` in workers-bus writes the env files as part of predev, so a caller
# that starts both at once legitimately arrives here first. Wait rather than fail.
missing="false"
for spec in "${BROKERS[@]}"; do
  [ -f "$(env_file "$(field "$spec" 1)")" ] || missing="true"
done
if [ "$missing" = "true" ]; then
  log "waiting up to ${WAIT_SECONDS}s for deploy/local/keys/*-broker.env (written by predev)"
  waited=0
  while [ "$missing" = "true" ] && [ "$waited" -lt "$WAIT_SECONDS" ]; do
    sleep 2
    waited=$((waited + 2))
    missing="false"
    for spec in "${BROKERS[@]}"; do
      [ -f "$(env_file "$(field "$spec" 1)")" ] || missing="true"
    done
  done
fi
if [ "$missing" = "true" ]; then
  fail "no broker env files in deploy/local/keys/. Run 'npm run dev' in workers-bus once (it runs deploy/local/predev.mjs), then retry."
fi

log "waiting for the local Frappe stack on $FRAPPE_URL"
waited=0
until curl -sf --max-time 3 "$FRAPPE_URL/api/method/ping" 2>/dev/null | grep -q pong; do
  waited=$((waited + 2))
  [ "$waited" -lt "$WAIT_SECONDS" ] || fail "Frappe did not answer on $FRAPPE_URL. Start it with: docker compose -f deploy/local/docker-compose.yml up -d"
  sleep 2
done

if [ ! -d "$MCP_DIR/node_modules" ]; then
  log "installing erpnext-roofing-mcp dependencies (first run only)"
  npm ci --prefix "$MCP_DIR"
fi

CHILD_PIDS=()
for spec in "${BROKERS[@]}"; do
  name="$(field "$spec" 1)"
  entrypoint="$(field "$spec" 2)"
  port="$(broker_port "$name" "$(field "$spec" 3)")"
  [ -n "$port" ] || fail "$(env_file "$name") does not set $(field "$spec" 3)"

  if broker_answers "$port"; then
    log "$name broker already answering on http://127.0.0.1:$port - leaving it alone"
    continue
  fi

  log "starting $name broker on http://127.0.0.1:$port"
  (
    set -a
    # shellcheck disable=SC1090
    . "$(env_file "$name")"
    set +a
    [ -n "$EFFECT_RUNTIME_URL_OVERRIDE" ] && export IRONWRAP_EFFECT_RUNTIME_URL="$EFFECT_RUNTIME_URL_OVERRIDE"
    cd "$MCP_DIR"
    exec node "src/$entrypoint"
  ) >>"$(log_file "$name")" 2>&1 &
  pid=$!
  echo "$pid" > "$(pid_file "$name")"
  CHILD_PIDS+=("$pid")

  waited=0
  until broker_answers "$port"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "--- last 20 lines of $(log_file "$name") ---" >&2
      tail -n 20 "$(log_file "$name")" >&2 || true
      fail "$name broker exited during start-up"
    fi
    waited=$((waited + 1))
    [ "$waited" -lt 30 ] || fail "$name broker did not answer on port $port within 30s"
    sleep 1
  done
  log "$name broker ready (pid $pid, log $(log_file "$name"))"
done

report_status || true

if [ "$FOREGROUND" = "true" ]; then
  trap 'stop_brokers; exit 0' INT TERM
  log "attached - Ctrl-C stops both brokers"
  for pid in "${CHILD_PIDS[@]:-}"; do
    [ -n "$pid" ] && wait "$pid" 2>/dev/null || true
  done
  # Nothing of ours is running (both were already up when this ran); stay alive so
  # a supervising script's lifecycle still matches the brokers it asked for.
  while [ "${#CHILD_PIDS[@]}" -eq 0 ]; do sleep 5; done
fi
