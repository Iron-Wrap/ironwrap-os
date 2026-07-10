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

The validated implemented-source inventory is **122 tools** across both servers: the bus contributes 7;
the Frappe server contributes **115 (71 reads, 22 dry-runs, 22 approved writes)**.

## Tool filtering per agent role

`hermes/agents/roles.json` is the source of truth for which MCP tools each of the eight
agent roles may call. Each role declares `reads`, `dry_run`, `approved_write`, and
`forbidden`. The eight per-role profiles under `hermes/agents/*.md` are derived from it.

`hermes/mcp-servers.json` `tool_filter` arrays are the UNION of each bucket across the roles
that use that server for host discovery only. The Frappe MCP server itself requires
`HERMES_AGENT_ROLE` and `HERMES_ACTOR_USER`, loads canonical `roles.json`, and registers only
that role's tools. Its Frappe API key pair must belong to exactly `HERMES_ACTOR_USER`, not a
shared service principal; Field Companion calls are additionally checked against an active assignment.
`tools/validate-hermes-config.mjs` validates the source/runtime contract against the implemented-source tool
inventory (see below).

## Mutation contract

Every write follows the same sequence, with no step skippable:

```text
read -> propose -> dry_run -> policy_check -> human_approval -> write -> audit_event
```

No tool can send a customer message or mutate accounting. Frappe approved writes require
`ERPNEXT_WRITE_ENABLED=true`, a role/actor-bound short-lived `dry_run_receipt`, and an
independently Ed25519-signed `approval_receipt` for the exact mutation, approver, actor, and
Frappe site. `HERMES_APPROVER_ID` binds the broker key to the required approver principal. The caller supplies a stable unique `run_id`; the first successful Hermes Run create
is the mutation claim, and any in-flight or failed claim fails closed instead of resuming. The bus
retains its separate `IRONWRAP_BUS_WRITE_ENABLED` plus `HERMES_WRITE_TOKEN` replay gate. Frappe
writes record Hermes Run rows; bus replay records envelope-scoped recovery and approval context.

Additional hard boundaries in the committed 46-DocType model:

- Crew Profile and Contract Acceptance are read-only. No Hermes tool signs, accepts, or
  rejects on a customer's behalf.
- Assignment, change-order draft, safety-plan, customer-decision, consent, and export-request
  corrections append/supersede history instead of silently overwriting it.
- Safety acknowledgement uses a locked Frappe append command, is device-bound and verified-evidence-backed,
  derives active assignment role server-side, and leaves generic child-table replacement unavailable.
- Reconciliation resolution changes only the reconciliation record; QuickBooks remains
  accounting truth. Tenant export creates only a Requested row, never an archive or key.

## Security model

- **Command approval**: mutations are `request_*` tools that draft or set review-gated
  status only; a human approves before any effect lands.
- **Runtime allowlists**: each Frappe MCP process is configured with one canonical role and registers
  only its exact `roles.json` tools. Anything outside is absent from that process.
- **Gateway user allowlist**: only allowlisted users reach the Hermes messaging/API gateway.
- **Field scope**: Field Companion reads and writes require an active direct or active-crew Job Assignment;
  its Roof Job response is a safe field projection.
- **Receipt gating**: Frappe writes are inert unless the write flag is true, the preview receipt matches
  current deterministic policy output, and a separate human approval signature matches the exact request.
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
- Reconcile digest: read payment mirrors and `list_integration_reconciliations_for_job`, then
  preview an evidence-backed resolution for a human to approve. The command never mutates accounting.

Background runs still obey the mutation contract: they may read and dry-run, but a Frappe write
needs the write-enable env var plus matching preview and human-approval receipts. Bus replay uses
its separate write token gate.

## Running the validator

```bash
node tools/validate-hermes-config.mjs
```

It parses the implemented tool inventory from both server sources, checks that every tool referenced
in `roles.json` exists, that reads are read-only, dry-runs are previews, approved-writes are
`request_*` mutations each paired with its dry-run counterpart in the same role, and that all
eight blueprint roles are present with no duplicate grants.
It also freezes the 122-tool inventory, enforces Contract Acceptance as read-only, checks
least-privilege boundaries for field/finance roles, and validates manifest union exactness.
