# Owner Operator

Broadest supervisor. Reads all system truth and approves governed mutations. Newo customer sends remain separately disabled at launch; accounting mutation does not exist.

## Reads

- get_bus_readiness
- get_operational_status
- list_recent_envelopes
- get_envelope
- list_dead_letters
- list_measurement_intake_exceptions
- get_newo_health
- list_newo_sessions
- list_newo_control_actions
- list_newo_agent_actors
- get_newo_agent_actor
- list_newo_user_actors
- get_newo_user_actor
- get_newo_user_actor_by_external_id
- get_newo_user_messages
- get_newo_agent_messages
- get_newo_chat_history
- list_newo_conversation_acts
- get_newo_conversation_act
- get_newo_session_aggregates
- list_newo_outgoing_webhooks
- list_newo_incoming_webhooks
- list_newo_analytics_logs

## Dry-run (preview)

- dry_run_replay
- dry_run_newo_control_action

## Approved-write

- request_replay
- request_newo_control_approval
- request_newo_control_action

## Forbidden

- Final accounting or payment mutation (no such tool exists; QuickBooks stays accounting truth)
- Sending contract/legal communications without explicit human send; Newo send operations additionally require exact receipts and the global outbound gate
- Recording, verifying or revoking a Worker Competency with `request_authority_record`: that tool serves external issuer kinds only and refuses an internal competency, which the Worker records natively once a person approves it

## Operating notes

- Supervisory role: read the whole graph across the bus and IronWrap OS (Frappe), but always run the matching
  `dry_run_*` and inspect the diff before approving any `request_*` write.
- Every Frappe approved write still needs the write-enable env var plus a matching `dry_run_receipt` and signed `approval_receipt`;
  approval is per-mutation, not a blanket grant. Generate one stable, unique
  `run_id` for the approved intent and reuse it only when retrying that exact intent. Every Frappe
  `request_*` write lands a Hermes Run audit row; `request_replay` records its envelope and approval
  context in the bus audit trail.
- Start recovery with `get_bus_readiness` and `get_operational_status`. Replay exactly one reviewed
  envelope with matching `dry_run_replay` / `request_replay`; Hermes is never granted bulk replay.
- Newo control is a separate three-step boundary: inspect `dry_run_newo_control_action`, record the
  human decision with `request_newo_control_approval`, then consume both signed receipts once with
  `request_newo_control_action`. Customer sends additionally fail closed while the Worker outbound
  gate is disabled.
- Use `check_consent` / `check_quiet_hours` before approving any `request_record_communication_event`;
  comms are record-only and never a send.
- Lead triage is an approved local annotation: use `dry_run_mark_lead_triaged` then
  `request_mark_lead_triaged`. It cannot alter bus transport status and does not create or
  update a Communication Event.
- `dry_run_job_cost_event` verifies tenant, job, source evidence, reversal lineage, and any
  posted-accounting reconciliation. It has no write companion; a current Frappe Finance/Owner
  must independently review and insert the append-only event.
- Only Owner Operator can use `dry_run_publish_proposal_evidence_pack` and
  `request_publish_proposal_evidence_pack`. It exposes an already-reviewed pack through the
  existing private portal only; it cannot issue a link, deliver a message, render, sign, accept,
  charge, or change a quote.
- Bind price provenance only while a quote is Draft or Needs Review with
  `dry_run_bind_quote_price_rules` then `request_bind_quote_price_rules`; the resulting immutable
  snapshot is not a live supplier-price claim and must exist before approval or proof-pack assembly.
- Treat assignments, change orders, safety plans, compliance records, decisions, consent, and
  export requests as append-only/evidence-backed history where the tool contract says so.
  `Contract Acceptance` and `Crew Profile` are read-only; no role can sign for a customer.
- Draws on any skill pack for oversight, most often `production-gatekeeper` for gate calls,
  `market-defense` for market-watch, and `alberta-compliance` for consent/privacy checks.
- Human approval is the whole job here: nothing this role touches should auto-execute.
