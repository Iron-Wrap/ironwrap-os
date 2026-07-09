# Owner Operator

Broadest supervisor. Reads all system truth, approves any drafted mutation. Cannot send legal/contract communications or mutate accounting because no such tool exists.

## Reads

- list_recent_envelopes
- get_envelope
- list_dead_letters
- get_roof_job
- get_lead_envelope
- list_job_gates
- list_blocked_jobs
- get_measurement_report
- list_measurement_reports_for_job
- get_material_takeoff
- list_material_takeoffs_for_job
- get_supplier_order
- list_supplier_orders_for_job
- get_supplier_quote
- list_supplier_quotes_for_job
- get_instant_estimate_session
- list_instant_estimate_sessions_for_job
- get_evidence_item
- list_evidence_for_job
- get_field_check_in
- list_field_check_ins_for_job
- get_proposal_evidence_pack
- list_proposal_evidence_packs_for_job
- get_payment_milestone
- list_payment_milestones_for_job
- get_completion_packet
- list_completion_packets_for_job
- get_warranty_packet
- list_warranty_packets_for_job
- get_review_request
- list_review_requests_for_job
- get_communication_event
- list_communication_events_for_job
- list_market_watch_items
- check_consent
- check_quiet_hours
- get_hermes_run
- list_hermes_runs_for_job

## Dry-run (preview)

- dry_run_replay
- dry_run_update_gate
- dry_run_material_takeoff
- dry_run_update_material_takeoff_status
- dry_run_supplier_order
- dry_run_supplier_quote
- dry_run_proposal_evidence_pack
- dry_run_completion_packet
- dry_run_warranty_packet
- dry_run_review_request
- dry_run_communication_event
- dry_run_market_watch_item

## Approved-write

- request_replay
- request_update_gate
- request_create_material_takeoff
- request_update_material_takeoff_status
- request_create_supplier_order
- request_create_supplier_quote
- request_create_proposal_evidence_pack
- request_create_completion_packet
- request_create_warranty_packet
- request_create_review_request
- request_record_communication_event
- request_add_market_watch_item

## Forbidden

- Final accounting or payment mutation (no such tool exists; QuickBooks stays accounting truth)
- Sending contract/legal communications without explicit human send (comms tools are record-only)

## Operating notes

- Supervisory role: read the whole graph across bus and ERPNext, but always run the matching
  `dry_run_*` and inspect the diff before approving any `request_*` write.
- Every approved write still needs the write-enable env var plus `HERMES_WRITE_TOKEN` as
  `approval_token`; approval is per-mutation, not a blanket grant. Every ERPNext `request_*` write
  lands a Hermes Run audit row; the one bus write (`request_replay`) is audited by the bus
  dead-letter/reconcile trail instead.
- Use `check_consent` / `check_quiet_hours` before approving any `request_record_communication_event`;
  comms are record-only and never a send.
- Draws on any skill pack for oversight, most often `production-gatekeeper` for gate calls,
  `market-defense` for market-watch, and `alberta-compliance` for consent/privacy checks.
- Human approval is the whole job here: nothing this role touches should auto-execute.
