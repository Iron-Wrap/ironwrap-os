#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/.runtime-logs"
mkdir -p "$LOG_DIR"

ERPNEXT_STUB_PORT="${ERPNEXT_STUB_PORT:-19090}"
ERPNEXT_STUB_USER="${ERPNEXT_STUB_USER:-owner@example.com}"
HERMES_BUS_PORT="${HERMES_BUS_PORT:-8787}"

PIDS=()
NAMES=()
STARTED=()

start_service() {
  local name="$1"
  local workdir="$2"
  local logfile="$3"
  shift 3

  echo "Starting: $name"
  (
    cd "$workdir"
    "$@"
  ) >>"$logfile" 2>&1 &

  local pid=$!
  PIDS+=("$pid")
  NAMES+=("$name")
  STARTED+=("$name:$pid")
  LAST_STARTED_PID="$pid"
  echo "$name pid=$pid"
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local pid="$3"

  for _ in $(seq 1 50); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "ERROR: $name exited before readiness. See $LOG_DIR/$name.log."
      return 1
    fi
    if curl --fail --silent --max-time 1 "$url" >/dev/null 2>&1; then
      echo "$name ready"
      return 0
    fi
    sleep 0.1
  done

  echo "ERROR: $name did not become ready. See $LOG_DIR/$name.log."
  return 1
}

check_required_services() {
  local i pid name status

  for i in "${!PIDS[@]}"; do
    pid="${PIDS[$i]}"
    name="${NAMES[$i]}"
    if kill -0 "$pid" 2>/dev/null; then
      continue
    fi
    if wait "$pid"; then
      status=0
    else
      status=$?
    fi
    echo "ERROR: required service $name exited unexpectedly with status $status. See $LOG_DIR/$name.log."
    return 1
  done
}

cleanup() {
  echo
  echo "Stopping local runtime services..."
  # The brokers record their own pids, so stop them by name rather than relying on
  # a signal reaching through the wrapper subshell.
  bash "$ROOT_DIR/deploy/local/start-approval-brokers.sh" stop 2>/dev/null || true
  for i in "${!PIDS[@]}"; do
    pid="${PIDS[$i]}"
    name="${NAMES[$i]}"
    if kill -0 "$pid" 2>/dev/null; then
      echo "  stopping $name ($pid)"
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}

is_port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
  else
    if netstat -an 2>/dev/null | grep -q "\.$port .*LISTEN"; then
      return 0
    fi
    return 1
  fi
}

find_free_port() {
  local port="$1"
  for _ in $(seq 0 19); do
    if ! is_port_in_use "$port"; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
  done
  return 1
}

HERMES_BUS_PORT="$(find_free_port "$HERMES_BUS_PORT")" || {
  echo "ERROR: Could not find a free local bus port near $HERMES_BUS_PORT after 20 attempts."
  exit 1
}
HERMES_BUS_BASE_URL="${HERMES_BUS_BASE_URL:-http://localhost:$HERMES_BUS_PORT}"

trap cleanup EXIT INT TERM

echo "Logging to: $LOG_DIR"

# Local ERPNext stub (single endpoint for actor attestation + permissive resource reads)
start_service "erpnext-stub" "$ROOT_DIR" "$LOG_DIR/erpnext-stub.log" \
  env ERPNEXT_STUB_PORT="$ERPNEXT_STUB_PORT" ERPNEXT_STUB_USER="$ERPNEXT_STUB_USER" \
    node "$ROOT_DIR/deploy/local/erpnext-stub.mjs"
wait_for_http "erpnext-stub" \
  "http://127.0.0.1:$ERPNEXT_STUB_PORT/api/method/frappe.auth.get_logged_user" \
  "$LAST_STARTED_PID"

# Workers bus runtime. The port this script picked has to reach predev too, or the
# origin it writes into .dev.vars (APP_PUBLIC_ORIGIN and its allowlist) would name a
# port the Worker is not listening on.
export IRONWRAP_LOCAL_WORKER_PORT="$HERMES_BUS_PORT"
start_service "workers-bus" "$ROOT_DIR/workers-bus" "$LOG_DIR/workers-bus.log" \
  npm run dev

# Field/office app runtime
start_service "app" "$ROOT_DIR/app" "$LOG_DIR/app.log" \
  npm run dev -- --host 0.0.0.0

# AI team runtime (agent-host): polls the local Worker for signals and serves /health and /ready
# on loopback. Opt in with IRONWRAP_LOCAL_AGENT_HOST=on. It starts without provider sign-ins and
# reports them missing; see agent-host/README.md for the local sign-in steps.
if [[ "${IRONWRAP_LOCAL_AGENT_HOST:-off}" == "on" ]]; then
  AGENT_HOST_PORT="$(find_free_port "${AGENT_HOST_PORT:-8790}")" || {
    echo "ERROR: Could not find a free local agent-host port after 20 attempts."
    exit 1
  }
  # The Worker's local agent token comes from the .dev.vars predev writes; wait briefly for it.
  local_agent_token="${AGENT_HOST_WORKER_TOKEN:-}"
  for _ in $(seq 1 50); do
    [[ -n "$local_agent_token" || -f "$ROOT_DIR/workers-bus/.dev.vars" ]] && break
    sleep 0.1
  done
  if [[ -z "$local_agent_token" ]]; then
    local_agent_token="$(sed -n 's/^AGENT_HOST_TOKEN=//p' "$ROOT_DIR/workers-bus/.dev.vars" 2>/dev/null | head -n 1)"
  fi
  # Scoped to the agent host alone: assigned for this one call, never exported to the brokers.
  AGENT_HOST_PORT="$AGENT_HOST_PORT" \
  AGENT_HOST_STATE_DIR="${AGENT_HOST_STATE_DIR:-$LOG_DIR/agent-host-state}" \
  AGENT_HOST_WORKER_URL="$HERMES_BUS_BASE_URL" \
  AGENT_HOST_ALLOW_INSECURE_LOCAL=true \
  AGENT_HOST_WORKER_TOKEN="${local_agent_token:-local-agent-host-token}" \
    start_service "agent-host" "$ROOT_DIR/agent-host" "$LOG_DIR/agent-host.log" \
      node src/host/main.ts
  unset local_agent_token
  wait_for_http "agent-host" "http://127.0.0.1:$AGENT_HOST_PORT/health" "$LAST_STARTED_PID"
fi

# MCP servers use stdio, so their client owns their process and pipe lifecycle.
# Launching them as background services gives them closed stdin and makes them
# exit cleanly before any client can connect.

# Approval brokers (proposal publication + production schedule)
# These are the only path to steps 5 and 6 of the six-step workflow. They talk to
# the REAL local Frappe stack, not the stub above, because they perform approved
# writes to operating records. The helper waits for deploy/local/predev.mjs (run by
# the workers-bus dev server started above) to write their env files, so ordering
# here is not a race. Set IRONWRAP_LOCAL_APPROVAL_BROKERS=off to skip them.
if [[ "${IRONWRAP_LOCAL_APPROVAL_BROKERS:-on}" == "off" ]]; then
  echo "Skipping approval brokers (IRONWRAP_LOCAL_APPROVAL_BROKERS=off): steps 5 and 6 will be unreachable."
else
  start_service "approval-brokers" "$ROOT_DIR" "$LOG_DIR/approval-brokers.log" \
    env IRONWRAP_EFFECT_RUNTIME_URL="$HERMES_BUS_BASE_URL" \
      bash "$ROOT_DIR/deploy/local/start-approval-brokers.sh" --foreground
fi

echo

check_required_services || exit 1
echo "All services started."
echo "- bus:       $HERMES_BUS_BASE_URL"
echo "- app:       http://localhost:5173"
echo "- stub ERP:  http://127.0.0.1:$ERPNEXT_STUB_PORT"
echo "- brokers:   http://127.0.0.1:9104 (proposal publication), http://127.0.0.1:9103 (production schedule)"
if [[ "${IRONWRAP_LOCAL_AGENT_HOST:-off}" == "on" ]]; then
  echo "- agent:     http://127.0.0.1:$AGENT_HOST_PORT/health"
fi
echo "- MCPs:      spawned on demand by their stdio clients"
echo "- logs:     $LOG_DIR"
echo "- stop with Ctrl-C (trap will terminate all child processes)."

echo

while true; do
  sleep 0.2
  check_required_services || exit 1
done
