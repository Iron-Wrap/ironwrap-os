# ironwrap-bus-mcp

Narrow Hermes surface over the owned Cloudflare Worker bus.

Read tools:

- `get_bus_readiness`: public dependency/config readiness, preserving structured HTTP 503 results.
- `get_operational_status`: authenticated heartbeat, queue, dead-letter, Frappe, replay-ledger,
  audit, and QuickBooks receipt state.
- `list_recent_envelopes`, `get_envelope`, and `list_dead_letters`: canonical operating truth.
- `list_measurement_intake_exceptions`: unmatched or retryable measurement reports, projected
  without idempotency/payload hash fields or processing leases; opaque operational ids remain for review.

Recovery is deliberately envelope-scoped in Hermes:

1. `dry_run_replay` proves the selected envelope is still `dead`.
2. A human approves one stable `run_id`, approver identity, and bounded reason.
3. `request_replay` sends that exact context to `POST /admin/replay`.
4. The Worker ledger makes a completed retry idempotent, conflicts a changed intent, and safely
   reclaims an exact failed/rolled-back attempt.

Bulk replay exists only in the Worker admin route with a hard confirmation string; this MCP never
exposes it.

Required environment:

```bash
IRONWRAP_BUS_BASE_URL=https://<worker-host>
IRONWRAP_ADMIN_TOKEN=...
IRONWRAP_BUS_WRITE_ENABLED=false
HERMES_WRITE_TOKEN=...
IRONWRAP_BUS_REQUEST_TIMEOUT_MS=10000
```

Production URLs must use HTTPS. Local HTTP requires a localhost hostname plus
`IRONWRAP_BUS_ALLOW_INSECURE_LOCAL=true`. Write requests are inert unless the write flag is true
and the caller supplies the matching approval token. Tokens stay in headers or MCP arguments and
are never sent in the Worker request body or audit record.

```bash
npm ci
npm test
```
