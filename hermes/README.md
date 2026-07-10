# Hermes Runtime for IronWrap OS

Hermes is the operating brain for IronWrap OS, not the database. It reads broadly across
system truth and writes only through narrow, review-gated command tools. The proprietary
IronWrap OS Frappe app (roofing operating core) and the IronWrap bus stay the record of truth; Hermes never holds primary
state and never mutates a system of record with a free-form write.

## Layer role

- Hermes plans, drafts, and proposes. It composes MCP tool calls to read job/lead/evidence
  state and to draft mutations.
- Every mutation is a `request_*` command tool that only drafts a record or sets a
  review-gated status. No tool sends a customer message and no tool mutates accounting.
- Truth lives downstream: IronWrap OS (Frappe) for the roofing operating core, the bus for envelope and
  dead-letter truth, QuickBooks for accounting. Hermes reflects them; it does not replace them.

## MCP servers

Two MCP servers are wired in `hermes/mcp-servers.json` (launch command, args, per-server
`tool_filter`, and env var names):

- `mcp/ironwrap-bus-mcp/src/server.mjs`: readiness and operational truth
  (`get_bus_readiness`, `get_operational_status`), envelope/dead-letter reads, and approved,
  envelope-scoped recovery (`dry_run_replay` / `request_replay`). Bulk replay is not exposed.
- `mcp/erpnext-roofing-mcp/src/server.mjs`: IronWrap OS Frappe operating core with reads,
  deterministic policy checks (`check_consent`, `check_quiet_hours`), dry-run previews, and
  review-gated `request_*` writes. Its legacy name is retained for deployment compatibility.

## Tool filtering per agent role

`hermes/agents/roles.json` is the source of truth for which MCP tools each of the eight
agent roles may call. Each role declares `reads`, `dry_run`, `approved_write`, and
`forbidden`. The eight per-role profiles under `hermes/agents/*.md` are derived from it.

`hermes/mcp-servers.json` `tool_filter` arrays are the UNION of each bucket across the roles
that use that server; the per-role narrowing is enforced from `roles.json`, not from the
manifest. `tools/validate-hermes-config.mjs` validates `roles.json` against the live tool
inventory parsed from both server sources and enforces the safety contract at config level
(see below).

## Mutation contract

Every write follows the same sequence, with no step skippable:

```text
read -> propose -> dry_run -> policy_check -> human_approval -> write -> audit_event
```

No tool can send a customer message or mutate accounting. Every approved write requires
`ERPNEXT_WRITE_ENABLED=true` (or `IRONWRAP_BUS_WRITE_ENABLED=true` for the bus) plus the
`HERMES_WRITE_TOKEN` passed as `approval_token`. The caller supplies a stable unique `run_id` for
the approved intent: exact retries reuse it; different intents never do. Frappe writes record a
Hermes Run row, while bus replay records envelope-scoped recovery and approval context in its audit log.

## Security model

- **Command approval**: mutations are `request_*` tools that draft or set review-gated
  status only; a human approves before any effect lands.
- **Allowlists**: each agent role is confined to the exact tools in its `roles.json` entry.
  Anything outside the allowlist is unavailable to that role.
- **Gateway user allowlist**: only allowlisted users reach the Hermes messaging/API gateway.
- **MCP tool filtering**: the `tool_filter` in `hermes/mcp-servers.json` scopes each server
  to the union of role-granted tools; the server never exposes a god tool.
- **Write-token gating**: approved writes are inert unless the server write-enable env var is
  true AND `HERMES_WRITE_TOKEN` is supplied as `approval_token`.
- **Per-tenant isolation**: one Hermes profile per contractor (isolated site / profile /
  namespace). The Support/Admin role explicitly forbids cross-tenant access.

## Memory boundary

Do NOT use Hermes memory as a CRM or system of record. Hermes memory is working context only.
IronWrap OS (Frappe) and the bus are truth; if a fact matters, it belongs in a record there, reached
through a read tool, not in agent memory.

## Cron / background usage

Hermes supports cron/background jobs. Good candidates are read-and-draft digests that never
auto-send:

- Nightly market-watch: read `list_market_watch_items`, draft gaps via
  `dry_run_market_watch_item`, surface for human review.
- Reconcile digest: read `list_payment_milestones_for_job` mirrors and summarize unmatched
  items for the Finance Reconciler to action.

Background runs still obey the mutation contract: they may read and dry-run, but any write
requires the write-enable env var plus `HERMES_WRITE_TOKEN` and a human approval.

## Running the validator

```bash
node tools/validate-hermes-config.mjs
```

It parses the live tool inventory from both server sources, checks that every tool referenced
in `roles.json` exists, that reads are read-only, dry-runs are previews, approved-writes are
`request_*` mutations each paired with its dry-run counterpart in the same role, and that all
eight blueprint roles are present with no duplicate grants.
