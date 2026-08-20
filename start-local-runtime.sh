#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/.runtime-logs"
mkdir -p "$LOG_DIR"

ERPNEXT_STUB_PORT="${ERPNEXT_STUB_PORT:-19090}"
ERPNEXT_STUB_USER="${ERPNEXT_STUB_USER:-owner@example.com}"
HERMES_BUS_ROLE="${HERMES_BUS_ROLE:-owner-operator}"
HERMES_ERP_ROLE="${HERMES_ERP_ROLE:-owner-operator}"
HERMES_BUS_PORT="${HERMES_BUS_PORT:-8787}"
HERMES_BUS_ALLOW_INSECURE_LOCAL="${HERMES_BUS_ALLOW_INSECURE_LOCAL:-true}"
ERPNEXT_BASE_URL="${ERPNEXT_BASE_URL:-http://127.0.0.1:$ERPNEXT_STUB_PORT}"
ERPNEXT_ALLOW_INSECURE_LOCAL="${ERPNEXT_ALLOW_INSECURE_LOCAL:-true}"
ERPNEXT_API_KEY="${ERPNEXT_API_KEY:-dummy}"
ERPNEXT_API_SECRET="${ERPNEXT_API_SECRET:-dummy}"

WORKERS_DEV_VARS="$ROOT_DIR/workers-bus/.dev.vars"
if [[ -n "${IRONWRAP_ADMIN_TOKEN:-}" ]]; then
  BUS_ADMIN_TOKEN="$IRONWRAP_ADMIN_TOKEN"
elif [[ -f "$WORKERS_DEV_VARS" && -r "$WORKERS_DEV_VARS" ]]; then
  BUS_ADMIN_TOKEN="$(awk -F= '/^ADMIN_TOKEN=/{print $2}' "$WORKERS_DEV_VARS" | tr -d '\r' | head -n1)"
else
  BUS_ADMIN_TOKEN=""
fi

if [[ -z "$BUS_ADMIN_TOKEN" ]]; then
  echo "ERROR: IRONWRAP_ADMIN_TOKEN not set and workers-bus/.dev.vars does not provide ADMIN_TOKEN."
  echo "Set IRONWRAP_ADMIN_TOKEN or populate workers-bus/.dev.vars with ADMIN_TOKEN."
  exit 1
fi

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
  echo "$name pid=$pid"
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
  env ERPNEXT_STUB_PORT="$ERPNEXT_STUB_PORT" ERPNEXT_STUB_USER="$ERPNEXT_STUB_USER" node - <<'NODE'
const http = require('node:http');
const port = Number(process.env.ERPNEXT_STUB_PORT || '19090');
const actor = process.env.ERPNEXT_STUB_USER || 'owner@example.com';

const server = http.createServer((req, res) => {
  if (req.url === '/api/method/frappe.auth.get_logged_user') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: actor }));
    return;
  }

  if (req.url.startsWith('/api/resource')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`stub ERPNext server on http://127.0.0.1:${port}`);
});
NODE

# Workers bus runtime
start_service "workers-bus" "$ROOT_DIR/workers-bus" "$LOG_DIR/workers-bus.log" \
  npm run dev -- --port "$HERMES_BUS_PORT"

# Field/office app runtime
start_service "app" "$ROOT_DIR/app" "$LOG_DIR/app.log" \
  npm run dev -- --host 0.0.0.0

# IronWrap bus MCP
start_service "ironwrap-bus-mcp" "$ROOT_DIR/mcp/ironwrap-bus-mcp" "$LOG_DIR/ironwrap-bus-mcp.log" \
  env IRONWRAP_BUS_BASE_URL="$HERMES_BUS_BASE_URL" \
    IRONWRAP_BUS_ALLOW_INSECURE_LOCAL="$HERMES_BUS_ALLOW_INSECURE_LOCAL" \
    IRONWRAP_ADMIN_TOKEN="$BUS_ADMIN_TOKEN" \
    HERMES_AGENT_ROLE="$HERMES_BUS_ROLE" \
    npm start

# Frappe/ERPNext MCP (local-read-safe mode)
start_service "erpnext-roofing-mcp" "$ROOT_DIR/mcp/erpnext-roofing-mcp" "$LOG_DIR/erpnext-roofing-mcp.log" \
  env ERPNEXT_BASE_URL="$ERPNEXT_BASE_URL" \
    ERPNEXT_ALLOW_INSECURE_LOCAL="$ERPNEXT_ALLOW_INSECURE_LOCAL" \
    ERPNEXT_API_KEY="$ERPNEXT_API_KEY" \
    ERPNEXT_API_SECRET="$ERPNEXT_API_SECRET" \
    HERMES_AGENT_ROLE="$HERMES_ERP_ROLE" \
    HERMES_ACTOR_USER="$ERPNEXT_STUB_USER" \
    HERMES_APPROVER_ID="${HERMES_APPROVER_ID:-$ERPNEXT_STUB_USER}" \
    npm start

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

echo "All services started."
echo "- bus:       $HERMES_BUS_BASE_URL"
echo "- app:       http://localhost:5173"
echo "- stub ERP:  http://127.0.0.1:$ERPNEXT_STUB_PORT"
echo "- brokers:   http://127.0.0.1:9104 (proposal publication), http://127.0.0.1:9103 (production schedule)"
echo "- logs:     $LOG_DIR"
echo "- stop with Ctrl-C (trap will terminate all child processes)."

echo

while true; do
  sleep 9999
done
