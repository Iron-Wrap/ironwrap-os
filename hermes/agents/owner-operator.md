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
- get_roof_job
- get_lead_envelope
- list_untriaged_lead_envelopes
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
- get_customer_quote
- list_customer_quotes_for_job
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
- list_communication_events_for_lead
- get_price_book_rule
- list_price_book_rules
- get_visual_property_model
- list_visual_property_models_for_job
- get_roof_area
- list_roof_areas_for_job
- get_option_package
- list_option_packages_for_job
- get_scope_clause
- list_scope_clauses_for_job
- get_crew_profile
- list_crew_profiles
- get_job_assignment
- list_job_assignments_for_job
- get_change_order
- list_change_orders_for_job
- get_insurance_supplement
- list_insurance_supplements_for_job
- get_safety_plan
- list_safety_plans_for_job
- get_job_compliance_record
- list_job_compliance_records_for_job
- get_communication_consent
- list_communication_consents_for_job
- get_customer_decision
- list_customer_decisions_for_job
- get_contract_acceptance
- list_contract_acceptances_for_job
- get_integration_reconciliation
- list_integration_reconciliations_for_job
- get_tenant_export_run
- list_tenant_export_runs_for_tenant
- get_automation_incident
- list_automation_incidents
- get_white_label_tenant
- list_white_label_tenants
- list_market_watch_items
- check_consent
- check_quiet_hours
- get_hermes_run
- list_hermes_runs_for_job

## Dry-run (preview)

- dry_run_replay
- dry_run_newo_control_action
- dry_run_update_gate
- dry_run_material_takeoff
- dry_run_update_material_takeoff_status
- dry_run_supplier_order
- dry_run_approve_controlled_item
- dry_run_receive_material_lot
- dry_run_release_shop_order
- dry_run_reserve_shop_order_materials
- dry_run_advance_shop_order_setup
- dry_run_record_first_piece_outcome
- dry_run_record_final_shop_quality
- dry_run_supplier_quote
- dry_run_quote_revision
- dry_run_bind_quote_price_rules
- dry_run_proposal_evidence_pack
- dry_run_publish_proposal_evidence_pack
- dry_run_job_assignment
- dry_run_change_order
- dry_run_change_order_transition
- dry_run_insurance_supplement
- dry_run_set_insurance_supplement_evidence
- dry_run_insurance_supplement_transition
- dry_run_safety_plan
- dry_run_safety_acknowledgement
- dry_run_job_compliance_record
- dry_run_customer_decision
- dry_run_communication_consent
- dry_run_reconciliation_resolution
- dry_run_tenant_export
- dry_run_completion_packet
- dry_run_warranty_packet
- dry_run_review_request
- dry_run_communication_event
- dry_run_mark_lead_triaged
- dry_run_market_watch_item

## Approved-write

- request_replay
- request_newo_control_approval
- request_newo_control_action
- request_update_gate
- request_create_material_takeoff
- request_update_material_takeoff_status
- request_create_supplier_order
- request_approve_controlled_item
- request_receive_material_lot
- request_release_shop_order
- request_reserve_shop_order_materials
- request_advance_shop_order_setup
- request_record_first_piece_outcome
- request_record_final_shop_quality
- request_create_supplier_quote
- request_create_quote_revision
- request_bind_quote_price_rules
- request_create_proposal_evidence_pack
- request_publish_proposal_evidence_pack
- request_create_job_assignment
- request_create_change_order
- request_transition_change_order
- request_create_insurance_supplement
- request_set_insurance_supplement_evidence
- request_transition_insurance_supplement
- request_create_safety_plan
- request_record_safety_acknowledgement
- request_record_job_compliance
- request_record_customer_decision
- request_record_communication_consent
- request_resolve_reconciliation
- request_tenant_export
- request_create_completion_packet
- request_create_warranty_packet
- request_create_review_request
- request_record_communication_event
- request_mark_lead_triaged
- request_add_market_watch_item

## Forbidden

- Final accounting or payment mutation (no such tool exists; QuickBooks stays accounting truth)
- Sending contract/legal communications without explicit human send; Newo send operations additionally require exact receipts and the global outbound gate

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
