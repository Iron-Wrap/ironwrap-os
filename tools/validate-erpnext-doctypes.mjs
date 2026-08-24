#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const doctypeRoot = "frappe-apps/ironwrap_roofing/ironwrap_roofing/ironwrap_roofing/doctype";
// Frappe-only IP posture: the app links to no ERPNext (GPL-3.0) DocTypes. The only
// non-custom Link target allowed is User, which lives in the MIT Frappe framework.
const frappeCoreTargets = new Set([
  "User",
]);
const canonicalIronWrapRoles = [
  "IronWrap Owner",
  "IronWrap Sales",
  "IronWrap Estimator",
  "IronWrap Production",
  "IronWrap Field",
  "IronWrap Finance",
  "IronWrap Closeout",
  "IronWrap Support",
];
const canonicalServiceRoles = [
  "IronWrap Customer Acceptance Service",
  "IronWrap QuickBooks Reconciliation Issuer",
  "IronWrap Facet Design Projection Service",
  "IronWrap Launch Proof Reader",
  "IronWrap Fleet Capture Issuer",
  "IronWrap Work Package Issuer",
];

const specs = [
  {
    name: "Lead Envelope",
    dir: "lead_envelope",
    idField: "envelope_id",
    requiredFields: [
      "envelope_id",
      "source",
      "contact_name",
      "contact_phone",
      "contact_email",
      "job_ref",
      "raw_key",
      "event_ts",
      "status",
      "intent_queue",
      "triage_status",
      "triaged_by",
      "triaged_at",
      "triage_summary",
      "payload_json",
      "jobnimbus_contact_id",
      "jobnimbus_job_id",
    ],
    fieldContracts: {
      triage_status: {
        fieldtype: "Select",
        options: "Unknown\nUntriaged\nTriaged",
        default: "Unknown",
      },
      triaged_by: { fieldtype: "Link", options: "User" },
      triaged_at: { fieldtype: "Datetime" },
      triage_summary: { fieldtype: "Small Text" },
    },
  },
  {
    name: "Roofing Customer",
    dir: "roofing_customer",
    idField: "customer_id",
    requiredFields: ["customer_id", "display_name", "customer_type", "first_name", "last_name", "phone", "email", "lead_envelope", "notes"],
  },
  {
    name: "Customer Quote",
    dir: "customer_quote",
    idField: "customer_quote_id",
    requiredFields: ["customer_quote_id", "roof_job", "customer", "status", "quote_total", "currency", "valid_until", "prepared_at", "approved_by", "approved_at", "scope_summary", "assumptions", "exclusions", "quote_summary_json", "notes"],
  },
  {
    name: "Supplier Profile",
    dir: "supplier_profile",
    idField: "supplier_id",
    requiredFields: ["supplier_id", "supplier_name", "active", "contact_name", "phone", "email", "address_line1", "city", "province", "notes"],
  },
  {
    name: "Authority Record",
    dir: "authority_record",
    idField: "authority_record_id",
    requiredFields: [
      "authority_record_id", "tenant", "subject_type", "subject_role", "authority_kind", "authority_scope",
      "scope_type", "scope_ref", "issuer_name", "issuer_jurisdiction", "issuer_reference", "source_version",
      "evidence_refs_json", "evidence_sha256", "effective_from", "expires_at", "version", "status",
    ],
    fieldContracts: {
      status: {
        fieldtype: "Select",
        options: "Unverified\nVerified\nContradictory\nExpired\nRevoked\nSuperseded",
        default: "Unverified",
      },
      version: { fieldtype: "Int", default: "1" },
    },
  },
  {
    name: "Roofing Property",
    dir: "roofing_property",
    idField: "property_key",
    requiredFields: ["property_key", "lead_envelope", "customer", "address_line1", "city", "province", "postal_code"],
  },
  {
    name: "Roof Job",
    dir: "roof_job",
    idField: "roof_job_id",
    requiredFields: [
      "roof_job_id",
      "job_number",
      "brand",
      "service_type",
      "job_status",
      "lead_envelope",
      "roofing_property",
      "customer",
      "quotation",
      "current_gate_state",
      "jobnimbus_contact_id",
      "jobnimbus_job_id",
      "qb_invoice_ref",
    ],
  },
  {
    name: "Measurement Value",
    dir: "measurement_value",
    child: true,
    requiredFields: ["metric", "value", "unit", "confidence", "source_ref", "needs_review"],
  },
  {
    name: "Measurement Report",
    dir: "measurement_report",
    idField: "measurement_id",
    requiredFields: ["measurement_id", "roof_job", "roofing_property", "provider", "source_file", "raw_key", "roof_graph_revision", "roof_graph_json", "review_status", "measurements"],
    fieldContracts: {
      roof_graph_revision: { fieldtype: "Data", read_only: 1 },
      roof_graph_json: { fieldtype: "Code", options: "JSON", read_only: 1 },
    },
  },
  {
    name: "Material Takeoff Item",
    dir: "material_takeoff_item",
    child: true,
    requiredFields: ["category", "item_name", "quantity", "unit", "waste_factor", "source_ref", "confidence", "needs_review", "calculation_digest", "policy_digest", "options_digest", "geometry_revision", "stock_mode", "waste_basis"],
  },
  {
    name: "Material Takeoff Policy",
    dir: "material_takeoff_policy",
    idField: "policy_id",
    requiredFields: ["policy_id", "tenant", "brand", "service_type", "material_system", "policy_version", "status", "effective_from", "effective_to", "policy_json", "source_evidence", "approved_by", "approved_at", "approval_note", "notes"],
  },
  {
    name: "Material Takeoff",
    dir: "material_takeoff",
    idField: "takeoff_id",
    requiredFields: ["takeoff_id", "roof_job", "measurement_report", "tenant", "material_system", "status", "prepared_at", "approved_by", "approved_at", "approval_note", "calculation_schema", "calculation_version", "geometry_revision", "source_raw_key", "source_raw_sha256", "takeoff_policy", "policy_version", "policy_source_evidence", "policy_source_sha256", "policy_digest", "options_digest", "calculation_digest", "stock_mode", "waste_basis", "options_json", "calculation_json", "review_reasons_json", "source_measurements_json", "assumptions", "exclusions", "items"],
  },
  {
    name: "Supplier Order Item",
    dir: "supplier_order_item",
    child: true,
    requiredFields: ["category", "item_name", "quantity", "unit", "source_ref", "status", "received_qty", "shortage_qty", "substitution_notes", "needs_review"],
  },
  {
    name: "Supplier Order",
    dir: "supplier_order",
    idField: "supplier_order_id",
    requiredFields: ["supplier_order_id", "roof_job", "material_takeoff", "supplier", "status", "prepared_at", "approved_by", "approved_at", "internal_transmission_id", "internal_transmitted_at", "supplier_acknowledgement_id", "supplier_acknowledged_at", "supplier_acknowledgement_evidence", "requested_delivery_date", "order_summary_json", "assumptions", "exclusions", "delivery_notes", "items"],
  },
  {
    name: "Instant Estimate Session",
    dir: "instant_estimate_session",
    idField: "estimate_session_id",
    requiredFields: ["estimate_session_id", "lead_envelope", "roof_job", "source", "service_type", "status", "range_low", "range_high", "estimate_total", "configurator_url", "confidence", "review_required", "assumptions", "exclusions", "selected_services_json", "material_choices_json", "payload_json"],
  },
  {
    name: "Reception Session",
    dir: "reception_session",
    idField: "session_id",
    requiredFields: ["session_id", "provider", "provider_project_id", "provider_agent_id", "provider_user_actor_id", "provider_conversation_id", "channel", "direction", "session_status", "outcome", "lead_envelope", "roofing_property", "roof_job", "contact_name", "contact_phone", "contact_email", "address_line1", "city", "province", "postal_code", "division", "service", "urgency", "handoff_status", "booking_status", "structured_summary", "transcript_pointer", "recording_pointer", "ai_disclosed", "recording_disclosed", "raw_key", "payload_hash", "structured_json", "started_at", "ended_at", "duration_seconds", "provider_updated_at"],
    fieldContracts: {
      structured_json: { fieldtype: "Code", options: "JSON", reqd: 1, read_only: 1 },
      payload_hash: { fieldtype: "Data", reqd: 1, read_only: 1 },
    },
  },
  {
    name: "Appointment Request",
    dir: "appointment_request",
    idField: "appointment_request_id",
    requiredFields: ["appointment_request_id", "reception_session", "lead_envelope", "roof_job", "request_status", "booking_mode", "provider", "provider_status", "contact_name", "contact_phone", "contact_email", "service", "division", "urgency", "preferred_windows_json", "timezone", "requested_at", "reviewed_by", "reviewed_at", "review_notes", "decision_by", "decision_at", "decision_notes", "confirmed_external_id", "confirmed_start", "confirmed_end", "cancelled_at", "raw_key", "payload_hash"],
    fieldContracts: {
      preferred_windows_json: { fieldtype: "Code", options: "JSON", reqd: 1 },
      payload_hash: { fieldtype: "Data", reqd: 1, read_only: 1 },
    },
  },
  {
    name: "Evidence Item",
    dir: "evidence_item",
    idField: "evidence_id",
    requiredFields: ["evidence_id", "roof_job", "lead_envelope", "evidence_type", "source_system", "source_uri", "r2_key", "drive_file_id", "customer_safe"],
  },
  {
    name: "Field Check-in",
    dir: "field_check_in",
    idField: "checkin_id",
    requiredFields: ["checkin_id", "roof_job", "job_number", "source_system", "submitted_at", "status", "photo_count", "evidence_ids_json", "notes", "drive_folder_url", "raw_key"],
  },
  {
    name: "Proposal Evidence Pack",
    dir: "proposal_evidence_pack",
    idField: "pack_id",
    requiredFields: ["pack_id", "roof_job", "quotation", "status", "evidence_summary_json", "assumptions", "exclusions", "customer_message"],
  },
  {
    name: "Payment Milestone",
    dir: "payment_milestone",
    idField: "payment_milestone_id",
    requiredFields: ["payment_milestone_id", "roof_job", "shop_order", "milestone_type", "status", "qb_entity_type", "qb_entity_id", "qb_operation", "realm_id", "event_ts", "raw_key", "raw_payload_hash", "notes"],
  },
  {
    name: "Job Cost Event",
    dir: "job_cost_event",
    idField: "job_cost_event_id",
    requiredFields: [
      "job_cost_event_id",
      "tenant",
      "roof_job",
      "event_kind",
      "category",
      "quantity",
      "unit",
      "amount_cents",
      "amount_basis",
      "currency",
      "occurred_at",
      "source_doctype",
      "source_name",
      "source_digest",
      "source_evidence",
      "accounting_state",
      "accounting_system",
      "accounting_entity_type",
      "accounting_entity_id",
      "accounting_digest",
      "accounting_posted_at",
      "reconciliation",
      "reversal_of",
      "reversal_reason",
      "actor_type",
      "actor_id",
      "authority_ref",
      "recorded_at",
      "approved_by",
      "approved_at",
      "approval_reference",
    ],
    fieldContracts: {
      amount_cents: { fieldtype: "Int", reqd: 1 },
      amount_basis: {
        fieldtype: "Select",
        options: "Net of Recoverable Tax\nIncludes Non-Recoverable Tax\nNo Tax",
        reqd: 1,
      },
      event_kind: { fieldtype: "Select", options: "cost\nreversal", reqd: 1 },
      reversal_of: { fieldtype: "Link", options: "Job Cost Event", unique: 1 },
      source_digest: { fieldtype: "Data", reqd: 1 },
    },
  },
  {
    name: "Production Gate State",
    dir: "production_gate_state",
    idField: "gate_id",
    requiredFields: ["gate_id", "roof_job", "gate", "state", "blocker_reason", "evidence_item", "waived_by", "waived_at", "waiver_reason"],
  },
  {
    name: "Hermes Run",
    dir: "hermes_run",
    idField: "run_id",
    requiredFields: [
      "run_id",
      "run_ts",
      "agent_role",
      "requested_by",
      "request_text",
      "target_doctype",
      "target_name",
      "lead_envelope",
      "roof_job",
      "linked_evidence",
      "capability_level",
      "tool_name",
      "tool_args_json",
      "dry_run_json",
      "policy_check_json",
      "policy_checked_at",
      "policy_checked_by",
      "approval_status",
      "approved_by",
      "approved_at",
      "before_target_ids",
      "after_target_ids",
      "result_status",
      "result_json",
      "error",
      "mutation_applied",
      "audit_event_id",
      "audit_incident_id",
      "request_correlation_id",
      "completed_at",
    ],
    fieldContracts: {
      policy_check_json: { fieldtype: "Code", options: "JSON" },
      policy_checked_at: { fieldtype: "Datetime", read_only: 1 },
      policy_checked_by: { fieldtype: "Link", options: "User", read_only: 1 },
      mutation_applied: { fieldtype: "Check", read_only: 1 },
      audit_event_id: { fieldtype: "Data", read_only: 1, unique: 1 },
      audit_incident_id: { fieldtype: "Data", read_only: 1 },
      request_correlation_id: { fieldtype: "Data", read_only: 1 },
      completed_at: { fieldtype: "Datetime", read_only: 1 },
    },
  },
  {
    name: "Completion Packet",
    dir: "completion_packet",
    idField: "completion_packet_id",
    requiredFields: [
      "completion_packet_id",
      "roof_job",
      "status",
      "prepared_at",
      "approved_by",
      "approved_at",
      "photo_evidence_json",
      "deficiency_list",
      "customer_signoff_ref",
      "warranty_ready",
      "evidence_summary_json",
      "assumptions",
      "exclusions",
      "notes",
    ],
  },
  {
    name: "Warranty Packet",
    dir: "warranty_packet",
    idField: "warranty_packet_id",
    requiredFields: [
      "warranty_packet_id",
      "roof_job",
      "completion_packet",
      "status",
      "prepared_at",
      "approved_by",
      "approved_at",
      "material_system",
      "warranty_terms",
      "coverage_start",
      "coverage_years",
      "exclusions",
      "evidence_summary_json",
      "notes",
    ],
  },
  {
    name: "Review Request",
    dir: "review_request",
    idField: "review_request_id",
    requiredFields: [
      "review_request_id",
      "roof_job",
      "completion_packet",
      "status",
      "channel",
      "prepared_at",
      "approved_by",
      "approved_at",
      "stop_conditions_json",
      "eligibility_notes",
      "consent_basis",
      "review_link",
      "notes",
    ],
  },
  {
    name: "Communication Event",
    dir: "communication_event",
    idField: "communication_event_id",
    requiredFields: [
      "communication_event_id",
      "roof_job",
      "lead_envelope",
      "channel",
      "direction",
      "template",
      "consent_basis",
      "policy_result",
      "policy_reasons_json",
      "quiet_hours_ok",
      "status",
      "body_preview",
      "recipient_ref",
      "event_ts",
      "approved_by",
      "approved_at",
      "notes",
    ],
  },
  {
    name: "Supplier Quote Item",
    dir: "supplier_quote_item",
    child: true,
    requiredFields: ["category", "item_name", "quantity", "unit", "unit_price", "line_total", "substitution", "source_ref", "needs_review"],
  },
  {
    name: "Supplier Quote",
    dir: "supplier_quote",
    idField: "supplier_quote_id",
    requiredFields: [
      "supplier_quote_id",
      "roof_job",
      "material_takeoff",
      "supplier",
      "status",
      "quoted_at",
      "valid_until",
      "prepared_at",
      "approved_by",
      "approved_at",
      "quote_total",
      "currency",
      "substitution_notes",
      "quote_summary_json",
      "assumptions",
      "exclusions",
      "items",
    ],
  },
  {
    name: "Market Watch Item",
    dir: "market_watch_item",
    idField: "watch_id",
    requiredFields: [
      "watch_id",
      "competitor",
      "title",
      "source_url",
      "risk_level",
      "status",
      "observed_at",
      "product_gate",
      "required_response",
      "decision_notes",
      "created_by_ref",
    ],
  },
  {
    name: "Price Book Rule",
    dir: "price_book_rule",
    idField: "price_rule_id",
    requiredFields: [
      "price_rule_id",
      "rule_name",
      "rule_type",
      "status",
      "service_type",
      "material_system",
      "unit",
      "unit_cost",
      "unit_price",
      "minimum_quantity",
      "currency",
      "source_ref",
      "rule_json",
      "effective_from",
      "effective_to",
      "assumptions",
      "exclusions",
      "approved_by",
      "approved_at",
      "approval_note",
      "notes",
    ],
  },
  {
    name: "Visual Property Model",
    dir: "visual_property_model",
    idField: "visual_model_id",
    requiredFields: [
      "visual_model_id",
      "roof_job",
      "roofing_property",
      "provider",
      "provider_model_id",
      "model_uri",
      "raw_key",
      "status",
      "confidence",
      "needs_review",
      "source_evidence",
      "roof_graph_measurement",
      "roof_graph_revision",
      "screenshots_json",
      "measurements_json",
      "captured_at",
      "approved_by",
      "approved_at",
      "approval_note",
      "notes",
    ],
    fieldContracts: {
      roof_graph_measurement: { fieldtype: "Link", options: "Measurement Report", read_only: 1 },
      roof_graph_revision: { fieldtype: "Data", read_only: 1 },
    },
  },
  {
    name: "Roof Area",
    dir: "roof_area",
    idField: "roof_area_id",
    requiredFields: [
      "roof_area_id",
      "roof_job",
      "roofing_property",
      "area_name",
      "status",
      "area_sqft",
      "pitch",
      "facet_count",
      "penetration_count",
      "edge_length_ft",
      "measurement_report",
      "visual_model",
      "source_ref",
      "needs_review",
      "approved_by",
      "approved_at",
      "approval_note",
      "notes",
    ],
  },
  {
    name: "Option Package",
    dir: "option_package",
    idField: "option_package_id",
    requiredFields: [
      "option_package_id",
      "roof_job",
      "package_name",
      "tier",
      "status",
      "material_system",
      "price_delta",
      "currency",
      "options_json",
      "scope_clause_ids_json",
      "warranty_summary",
      "payment_assumptions",
      "assumptions",
      "exclusions",
      "approved_by",
      "approved_at",
      "approval_note",
      "notes",
    ],
  },
  {
    name: "Scope Clause",
    dir: "scope_clause",
    idField: "scope_clause_id",
    requiredFields: [
      "scope_clause_id",
      "roof_job",
      "clause_type",
      "title",
      "clause_text",
      "version",
      "status",
      "source_ref",
      "customer_visible",
      "approved_by",
      "approved_at",
      "approval_note",
      "notes",
    ],
  },
  {
    name: "Automation Incident",
    dir: "automation_incident",
    idField: "incident_id",
    requiredFields: [
      "incident_id",
      "status",
      "severity",
      "source_system",
      "category",
      "summary",
      "details",
      "roof_job",
      "lead_envelope",
      "record_ref",
      "correlation_id",
      "detected_at",
      "retry_count",
      "assigned_to",
      "acknowledged_at",
      "resolution_notes",
      "resolved_by",
      "resolved_at",
      "notes",
    ],
  },
  {
    name: "White-Label Tenant",
    dir: "white_label_tenant",
    idField: "tenant_id",
    requiredFields: [
      "tenant_id",
      "status",
      "site_hostname",
      "legal_name",
      "primary_brand",
      "owner_user",
      "support_email",
      "data_residency",
      "isolation_model",
      "brand_config_json",
      "namespace_config_json",
      "policy_config_json",
      "approved_by",
      "approved_at",
      "approval_note",
      "activated_at",
      "notes",
    ],
  },
];

const extendedContracts = {
  "Evidence Item": {
    requiredFields: ["device_action_id", "proof_owner", "proof_slot", "content_checksum", "checksum_algorithm", "content_type", "content_length", "capture_actor", "captured_at", "latitude", "longitude", "location_accuracy_m", "sync_state", "verified_at", "verification_source", "correction_of", "correction_reason", "work_package", "work_package_version", "work_package_release_attempt_id", "evidence_slot_id", "evidence_requirement", "evidence_source", "evidence_device_id", "evidence_freshness", "evidence_conflict_state", "evidence_verification", "evidence_disposition"],
    fieldContracts: {
      device_action_id: { fieldtype: "Data", unique: 1 },
      content_checksum: { fieldtype: "Data" },
      sync_state: { fieldtype: "Select", reqd: 1 },
    },
  },
  "Field Check-in": {
    requiredFields: ["device_action_id", "job_assignment", "crew_profile", "capture_actor", "capture_started_at", "capture_completed_at", "sync_state", "verified_at", "latitude", "longitude", "location_accuracy_m", "blocker_flag", "blocker_category", "blocker_summary", "voice_evidence", "correction_of", "correction_reason"],
    fieldContracts: { device_action_id: { fieldtype: "Data", unique: 1 } },
  },
  "Production Gate State": {
    requiredFields: ["owner_user", "assigned_at", "due_at"],
  },
  "Roof Job": {
    requiredFields: ["workflow_profile", "locale_policy_version", "locale_policy_snapshot_json"],
    fieldContracts: { locale_policy_snapshot_json: { fieldtype: "Code", options: "JSON" } },
  },
  "Customer Quote": {
    requiredFields: ["quote_version", "price_book_version", "pricing_effective_at", "subtotal", "tax_amount", "tax_code", "tax_rate", "tax_policy_snapshot_json", "deposit_amount", "amount_due", "amount_paid", "balance_due", "payment_status", "payment_due_date", "payment_truth_source", "payment_truth_at", "contract_acceptance", "supersedes", "correction_reason"],
    fieldContracts: { tax_policy_snapshot_json: { fieldtype: "Code", options: "JSON" } },
  },
  "Payment Milestone": {
    requiredFields: ["milestone_version", "currency", "subtotal", "tax_amount", "total_amount", "amount_due", "amount_paid", "balance_due", "due_date", "payment_status", "price_book_version", "tax_code", "tax_rate", "tax_policy_snapshot_json", "truth_source", "truth_at", "supersedes", "correction_reason"],
    fieldContracts: { tax_policy_snapshot_json: { fieldtype: "Code", options: "JSON" } },
  },
};

for (const spec of specs) {
  const extension = extendedContracts[spec.name];
  if (!extension) continue;
  spec.requiredFields.push(...extension.requiredFields);
  spec.fieldContracts = { ...(spec.fieldContracts ?? {}), ...(extension.fieldContracts ?? {}) };
}

specs.push(
  {
    name: "Crew Member", dir: "crew_member", child: true,
    requiredFields: ["crew_user", "crew_role", "active", "mobile_phone", "joined_on", "left_on", "certification_summary", "notes"],
  },
  {
    name: "Change Order Item", dir: "change_order_item", child: true,
    requiredFields: ["item_type", "description", "quantity", "unit", "unit_price", "line_total", "tax_code", "source_ref", "customer_visible"],
  },
  {
    name: "Safety Acknowledgement", dir: "safety_acknowledgement", child: true,
    requiredFields: ["acknowledged_by", "acknowledged_at", "acknowledgement_method", "device_action_id", "evidence_item", "role_on_job", "notes"],
  },
  {
    name: "Crew Profile", dir: "crew_profile", idField: "crew_profile_id",
    requiredFields: ["crew_profile_id", "crew_name", "status", "crew_type", "primary_lead", "default_workflow_profile", "home_region", "timezone", "members", "safety_contact_name", "safety_contact_phone", "insurance_expiry", "wcb_expiry", "notes"],
  },
  {
    name: "Job Assignment", dir: "job_assignment", idField: "assignment_id",
    requiredFields: ["assignment_id", "roof_job", "work_object_type", "work_object_id", "physical_context_type", "physical_context_id", "assignment_type", "status", "crew_profile", "assigned_user", "authority_user", "authority_role", "assigned_workers", "scheduled_start", "scheduled_end", "assigned_by", "assigned_at", "accepted_at", "started_at", "completed_at", "blocker_reason", "supersedes", "correction_reason", "notes"],
  },
  {
    name: "Change Order", dir: "change_order", idField: "change_order_id",
    requiredFields: ["change_order_id", "roof_job", "customer_quote", "change_number", "version", "status", "title", "reason", "scope_delta", "currency", "subtotal", "tax_amount", "total_amount", "price_book_version", "tax_policy_snapshot_json", "items", "requested_by", "requested_at", "approved_by", "approved_at", "contract_acceptance", "accepted_at", "supersedes", "correction_reason", "notes"],
    fieldContracts: { tax_policy_snapshot_json: { fieldtype: "Code", options: "JSON" } },
  },
  {
    name: "Insurance Supplement Evidence", dir: "insurance_supplement_evidence", child: true,
    requiredFields: ["evidence_item", "evidence_role"],
  },
  {
    name: "Insurance Supplement", dir: "insurance_supplement", idField: "insurance_supplement_id",
    requiredFields: ["insurance_supplement_id", "roof_job", "customer_quote", "change_order", "version", "status", "carrier_name", "claim_reference", "policy_reference", "date_of_loss", "adjuster_reference", "supplement_basis", "measurement_report", "invoice_required", "invoice_exception_reason", "evidence", "evidence_manifest_json", "approved_by", "approved_at", "submitted_at", "carrier_response_at", "resolution_summary", "closed_at", "supersedes", "correction_reason", "notes"],
    fieldContracts: {
      evidence_manifest_json: { fieldtype: "Code", options: "JSON", read_only: 1 },
    },
  },
  {
    name: "Safety Plan", dir: "safety_plan", idField: "safety_plan_id",
    requiredFields: ["safety_plan_id", "roof_job", "version", "status", "effective_date", "prepared_by", "prepared_at", "hazard_summary", "controls", "emergency_plan", "ppe_requirements", "weather_limits", "evidence_item", "acknowledgements", "approved_by", "approved_at", "supersedes", "correction_reason", "notes"],
  },
  {
    name: "Work Package Step", dir: "work_package_step", child: true,
    requiredFields: ["sequence", "instruction", "required_evidence", "acceptance_criteria"],
  },
  {
    name: "Work Package Hold Point", dir: "work_package_hold_point", child: true,
    requiredFields: ["sequence", "hold_point", "release_authority", "required_evidence", "acceptance_criteria"],
  },
  {
    name: "Work Package Worker", dir: "work_package_worker", child: true,
    requiredFields: ["sequence", "worker_user", "worker_role", "required"],
  },
  {
    name: "Work Package", dir: "work_package", idField: "work_package_id",
    requiredFields: ["work_package_id", "roof_job", "job_assignment", "safety_plan", "work_object_type", "work_object_id", "physical_context_type", "physical_context_id", "version", "status", "title", "objective", "boundaries", "prerequisites", "expected_result", "stop_conditions", "make_safe_procedure", "issued_at", "expires_at", "released_by", "released_at", "release_attempt_id", "acknowledged_by", "acknowledged_at", "acknowledgement_device_action_id", "started_at", "blocked_by", "blocked_at", "blocked_device_action_id", "blocker_reason", "completed_at", "assigned_workers", "steps", "hold_points", "supersedes", "correction_reason"],
  },
  {
    name: "Work Package Event", dir: "work_package_event", idField: "work_package_event_id",
    requiredFields: ["work_package_event_id", "event_type", "work_package", "roof_job", "job_assignment", "work_package_version", "release_attempt_id", "actor_user", "actor_role", "device_action_id", "occurred_at", "payload_hash", "hold_point_sequence", "evidence_item", "blocker_reason", "evidence_slot_id", "evidence_requirement", "evidence_source", "evidence_device_id", "evidence_captured_at", "evidence_freshness", "evidence_conflict_state", "evidence_correction_of", "evidence_item_correction_of", "evidence_review_of", "evidence_verification", "evidence_disposition", "correction_reason"],
  },
  {
    name: "Job Compliance Record", dir: "job_compliance_record", idField: "compliance_record_id",
    requiredFields: ["compliance_record_id", "roof_job", "jurisdiction", "record_type", "authority_name", "external_reference", "status", "required_before_gate", "applied_at", "effective_date", "expiry_date", "inspected_at", "evidence_item", "owner_user", "due_date", "waived_by", "waived_at", "waiver_reason", "supersedes", "correction_reason", "notes"],
  },
  {
    name: "Communication Consent", dir: "communication_consent", idField: "consent_id",
    requiredFields: ["consent_id", "customer", "lead_envelope", "roof_job", "channel", "purpose", "status", "jurisdiction", "consent_basis", "source_system", "source_reference", "captured_by", "captured_at", "effective_from", "expires_at", "proof_evidence", "revoked_at", "supersedes", "correction_reason", "notes"],
  },
  {
    name: "Customer Decision", dir: "customer_decision", idField: "decision_id",
    requiredFields: ["decision_id", "roof_job", "customer", "decision_type", "status", "decision_value", "decision_summary", "source_channel", "decided_at", "captured_by", "evidence_item", "option_package", "change_order", "supersedes", "correction_reason", "notes"],
  },
  {
    name: "Contract Acceptance", dir: "contract_acceptance", idField: "acceptance_id",
    requiredFields: ["acceptance_id", "roof_job", "customer", "customer_quote", "change_order", "contract_version", "status", "signer_name", "signer_email", "signer_ip", "accepted_at", "acceptance_method", "evidence_item", "terms_hash", "document_checksum", "source_system", "provider_reference", "captured_by", "supersedes", "correction_reason", "notes"],
  },
  {
    name: "Integration Reconciliation", dir: "integration_reconciliation", idField: "reconciliation_id",
    requiredFields: ["reconciliation_id", "roof_job", "system_name", "entity_type", "external_entity_id", "local_doctype", "local_name", "direction", "status", "detected_at", "raw_key", "source_version", "source_amount", "local_amount", "currency", "diff_json", "source_payload_hash", "local_payload_hash", "last_attempt_at", "attempt_count", "resolution_action", "resolved_by", "resolved_at", "resolution_evidence", "automation_incident", "supersedes", "correction_reason", "notes"],
    fieldContracts: { diff_json: { fieldtype: "Code", options: "JSON" } },
  },
  {
    name: "Tenant Export Run", dir: "tenant_export_run", idField: "export_run_id",
    requiredFields: ["export_run_id", "tenant", "status", "requested_by", "requested_at", "started_at", "completed_at", "scope_json", "manifest_key", "manifest_checksum", "archive_key", "archive_checksum", "record_count", "evidence_count", "byte_count", "encryption_key_ref", "failure_reason", "supersedes", "correction_reason", "notes"],
    fieldContracts: {
      scope_json: { fieldtype: "Code", options: "JSON", reqd: 1 },
      manifest_key: { fieldtype: "Data", read_only: 1 },
      archive_key: { fieldtype: "Data", read_only: 1 },
      encryption_key_ref: { fieldtype: "Data", read_only: 1 },
    },
  },
  {
    name: "Controlled Item", dir: "controlled_item", idField: "controlled_item_id",
    requiredFields: ["controlled_item_id", "status", "revision", "item_kind", "unit", "profile", "gauge", "coating", "colour", "dimension_spec", "tolerance", "lot_required", "certificate_required", "source_ref", "approved_by", "approved_at", "approval_note"],
  },
  {
    name: "Material Lot", dir: "material_lot", idField: "material_lot_id",
    requiredFields: ["material_lot_id", "roof_job", "controlled_item", "source_kind", "supplier_order", "source_shop_order", "source_evidence", "lot_number", "certificate_reference", "condition_status", "received_quantity", "available_quantity", "reserved_quantity", "consumed_quantity", "unit", "received_at", "status"],
  },
  {
    name: "Service Case",
    dir: "service_case",
    idField: "service_case_id",
    requiredFields: [
      "service_case_id", "roofing_customer", "roofing_property", "roof_job", "warranty_packet",
      "roof_area", "origin_work_package", "status", "severity", "symptom_code", "reported_channel",
      "reported_at", "communication_consent", "intake_evidence", "response_due_at",
      "triage_category", "responsibility", "triaged_by", "triaged_at", "root_cause_code",
      "corrective_action_code", "service_work_package", "remedy_verified_by", "remedy_verified_at",
      "remedy_evidence", "customer_accepted_at", "customer_acceptance", "recurrence_of_case",
      "warranty_reserve_amount", "recovery_counterparty", "recovered_amount", "closure_reason",
      "closed_at", "notes",
    ],
    fieldContracts: {
      status: {
        fieldtype: "Select",
        options: "Intake\nTriaged\nDiagnosed\nRemedy Issued\nRemedy Verified\nCustomer Accepted\nDisputed\nClosed\nReopened",
      },
      severity: { fieldtype: "Select", options: "Emergency\nUrgent\nStandard\nMonitor" },
      communication_consent: { fieldtype: "Link", options: "Communication Consent" },
      service_work_package: { fieldtype: "Link", options: "Work Package" },
      recurrence_of_case: { fieldtype: "Link", options: "Service Case" },
    },
  },
  {
    name: "Nonconformance", dir: "nonconformance", idField: "nonconformance_id",
    requiredFields: ["nonconformance_id", "shop_order", "material_lot", "status", "detected_at", "reported_by", "description", "evidence_item", "containment", "disposition", "disposition_by", "disposition_at", "closed_by", "closed_at", "closure_evidence"],
  },
  {
    name: "Shop Order Line", dir: "shop_order_line", child: true,
    requiredFields: ["line_no", "controlled_item", "requested_quantity", "accepted_quantity", "billable_quantity", "unit", "dimensions", "tolerance", "orientation", "invoice_basis", "needs_review"],
  },
  {
    name: "Shop Material Allocation", dir: "shop_material_allocation", child: true,
    requiredFields: ["allocation_id", "line_no", "material_lot", "reserved_quantity", "issued_quantity", "unit", "status", "needs_review"],
  },
  {
    name: "Shop Operation", dir: "shop_operation", child: true,
    requiredFields: ["sequence", "operation", "machine_tooling", "operator", "status", "started_at", "completed_at", "notes"],
  },
  {
    name: "Shop Yield", dir: "shop_yield", child: true,
    requiredFields: ["allocation_id", "operation_sequence", "input_quantity", "finished_quantity", "remnant_quantity", "remnant_lot", "scrap_quantity", "scrap_disposition", "evidence_item"],
  },
  {
    name: "Shop Inspection", dir: "shop_inspection", child: true,
    requiredFields: ["inspection_type", "line_no", "allocation_id", "operation_sequence", "result", "measured_result", "inspected_by", "inspected_at", "evidence_item", "needs_review"],
  },
  {
    name: "Shop Bundle", dir: "shop_bundle", child: true,
    requiredFields: ["bundle_id", "line_no", "material_lot", "piece_identity", "accepted_quantity", "unit", "label_text", "handoff_status", "handed_over_to", "handed_over_at", "handoff_evidence", "condition", "needs_review"],
  },
  {
    name: "Shop Order", dir: "shop_order", idField: "shop_order_id",
    requiredFields: ["shop_order_id", "roof_job", "material_takeoff", "supplier_order", "work_package", "status", "released_by", "released_at", "reserved_at", "setup_started_at", "fabrication_started_at", "quality_hold_reason", "ready_at", "handed_over_to", "handed_over_at", "handoff_evidence", "invoice_payment_milestone", "invoice_ready_at", "closed_at", "lines", "material_allocations", "operations", "yields", "inspections", "bundles"],
  },
  {
    name: "Fleet Asset", dir: "fleet_asset", idField: "fleet_asset_id",
    requiredFields: ["fleet_asset_id", "asset_kind", "status", "display_name", "unit_number", "version", "make", "model", "model_year", "vin_or_serial", "licence_plate", "registration_expiry", "insurance_expiry", "required_licence_class", "meter_kind", "current_meter", "current_meter_at", "payload_capacity_kg", "gvwr_kg", "inspection_authority_source", "last_inspection", "last_inspection_at", "next_inspection_due", "next_service_due_date", "next_service_due_meter", "calibration_required", "next_calibration_due", "custody_holder_type", "custody_crew_profile", "custody_user", "custody_since", "custody_event", "out_of_service_reason", "out_of_service_at", "home_region", "notes", "supersedes", "correction_reason"],
    fieldContracts: {
      asset_kind: { fieldtype: "Select", options: "Vehicle\nTrailer\nEquipment\nTool", reqd: 1 },
      status: { fieldtype: "Select", options: "Draft\nActive\nOut of Service\nRetired", default: "Draft", reqd: 1 },
      inspection_authority_source: {
        fieldtype: "Select",
        options: "Physical Inspection\nTelematics",
        default: "Physical Inspection",
      },
    },
  },
  {
    name: "Driver Authority", dir: "driver_authority", idField: "driver_authority_id",
    requiredFields: ["driver_authority_id", "driver_user", "status", "version", "authority_source", "licence_class", "licence_reference", "licence_issuer", "licence_expiry", "medical_expiry", "endorsements", "restriction_summary", "abstract_checked_at", "abstract_evidence", "verified_by", "verified_at", "suspended_reason", "suspended_at", "notes", "supersedes", "correction_reason"],
    fieldContracts: {
      driver_user: { fieldtype: "Link", options: "User", reqd: 1 },
      authority_source: {
        fieldtype: "Select",
        options: "Physical Document\nTelematics",
        default: "Physical Document",
        reqd: 1,
      },
    },
  },
  {
    name: "Asset Inspection Item", dir: "asset_inspection_item", child: true,
    requiredFields: ["sequence", "check_point", "result", "severity", "observation", "evidence_item"],
  },
  {
    name: "Asset Inspection", dir: "asset_inspection", idField: "asset_inspection_id",
    requiredFields: ["asset_inspection_id", "fleet_asset", "inspection_type", "status", "result", "roof_job", "job_assignment", "cargo_load", "performed_by", "performed_at", "device_action_id", "raw_key", "source_system", "capture_actor", "evidence_item", "meter_reading", "telematics_reference", "telematics_observed_at", "defect_count", "items", "next_inspection_due", "sync_state", "verified_at", "notes", "supersedes", "correction_reason"],
    fieldContracts: {
      device_action_id: { fieldtype: "Data", unique: 1 },
      inspection_type: {
        fieldtype: "Select",
        options: "Pre-Trip\nPost-Trip\nPeriodic\nReturn To Service",
        reqd: 1,
      },
      items: { fieldtype: "Table", options: "Asset Inspection Item" },
      sync_state: { fieldtype: "Select", reqd: 1 },
    },
  },
  {
    name: "Asset Defect", dir: "asset_defect", idField: "asset_defect_id",
    requiredFields: ["asset_defect_id", "fleet_asset", "asset_inspection", "status", "severity", "out_of_service", "detected_at", "reported_by", "device_action_id", "raw_key", "description", "evidence_item", "containment", "maintenance_order", "repaired_by", "repaired_at", "repair_evidence", "return_to_service_inspection", "closed_by", "closed_at", "cancelled_reason", "notes"],
    fieldContracts: {
      device_action_id: { fieldtype: "Data", unique: 1 },
      severity: { fieldtype: "Select", options: "Minor\nMajor\nOut of Service", reqd: 1 },
      out_of_service: { fieldtype: "Check", default: "0" },
    },
  },
  {
    name: "Maintenance Order", dir: "maintenance_order", idField: "maintenance_order_id",
    requiredFields: ["maintenance_order_id", "fleet_asset", "order_kind", "status", "asset_defect", "due_date", "due_meter", "scheduled_for", "provider_kind", "provider_name", "work_summary", "started_at", "performed_by", "completed_at", "meter_at_completion", "completion_evidence", "certificate_reference", "certificate_expiry", "next_due_date", "next_due_meter", "return_to_service_inspection", "cancelled_reason", "notes"],
    fieldContracts: {
      order_kind: { fieldtype: "Select", options: "Preventive\nCorrective\nCalibration", reqd: 1 },
    },
  },
  {
    name: "Asset Usage Log", dir: "asset_usage_log", idField: "asset_usage_log_id",
    requiredFields: ["asset_usage_log_id", "fleet_asset", "entry_kind", "source", "status", "authoritative", "roof_job", "cargo_load", "recorded_by", "recorded_at", "device_action_id", "meter_reading", "previous_meter_reading", "distance_km", "duration_hours", "fuel_volume_l", "fuel_cost", "evidence_item", "provider_reference", "notes", "supersedes", "correction_reason"],
    fieldContracts: {
      device_action_id: { fieldtype: "Data", unique: 1 },
      source: { fieldtype: "Select", options: "Physical\nTelematics", default: "Physical", reqd: 1 },
      authoritative: { fieldtype: "Check", default: "0" },
    },
  },
  {
    name: "Cargo Load Line", dir: "cargo_load_line", child: true,
    requiredFields: ["line_no", "line_kind", "controlled_item", "material_lot", "tool_asset", "shop_bundle_id", "description", "unit", "planned_quantity", "loaded_quantity", "delivered_quantity", "returned_quantity", "weight_kg", "scan_reference", "condition", "needs_review", "evidence_item"],
  },
  {
    name: "Cargo Load", dir: "cargo_load", idField: "cargo_load_id",
    requiredFields: ["cargo_load_id", "roof_job", "fleet_asset", "trailer_asset", "job_assignment", "work_package", "driver_authority", "driver_user", "status", "version", "custody_holder_type", "custody_crew_profile", "custody_user", "planned_weight_kg", "loaded_weight_kg", "securement_confirmed", "pre_trip_inspection", "post_trip_inspection", "loaded_by", "loaded_at", "departed_at", "delivered_at", "delivery_evidence", "returned_at", "return_evidence", "reconciled_by", "reconciled_at", "reconciliation_note", "device_action_id", "lines", "cancelled_reason", "notes", "supersedes", "correction_reason"],
    fieldContracts: {
      device_action_id: { fieldtype: "Data", unique: 1 },
      status: {
        fieldtype: "Select",
        options: "Draft\nLoaded\nIn Transit\nDelivered\nReturned\nReconciled\nCancelled",
        default: "Draft",
        reqd: 1,
      },
      lines: { fieldtype: "Table", options: "Cargo Load Line" },
      securement_confirmed: { fieldtype: "Check", default: "0" },
    },
  },
  {
    name: "Asset Custody Event", dir: "asset_custody_event", idField: "asset_custody_event_id",
    requiredFields: ["asset_custody_event_id", "fleet_asset", "event_type", "status", "occurred_at", "recorded_by", "device_action_id", "from_holder_type", "from_crew_profile", "from_user", "to_holder_type", "to_crew_profile", "to_user", "roof_job", "cargo_load", "condition", "evidence_item", "notes", "supersedes", "correction_reason"],
    fieldContracts: {
      device_action_id: { fieldtype: "Data", unique: 1 },
      event_type: {
        fieldtype: "Select",
        options: "Issue\nTransfer\nReturn\nLost\nRecovered",
        reqd: 1,
      },
    },
  },
);

const appRoot = "frappe-apps/ironwrap_roofing/ironwrap_roofing";
const doctypePath = join(root, doctypeRoot);
const expectedDirs = specs.map((spec) => spec.dir).sort();
const discoveredDirs = readdirSync(doctypePath, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((dir) => existsSync(join(doctypePath, dir, `${dir}.json`)))
  .sort();

assert.equal(specs.length, 79, "the product contract must contain exactly 79 DocTypes");
assert.equal(specs.filter((spec) => spec.child).length, 19, "expected nineteen child-table DocTypes");
assert.equal(specs.filter((spec) => !spec.child).length, 60, "expected 60 top-level DocTypes");
assert.equal(new Set(specs.map((spec) => spec.name)).size, specs.length, "duplicate DocType name in validator");
assert.equal(new Set(expectedDirs).size, specs.length, "duplicate DocType directory in validator");
assert.deepEqual(discoveredDirs, expectedDirs, "on-disk DocTypes must exactly match the 79-type product contract");

const pythonContracts = readPythonContracts();
assert.deepEqual(
  [...pythonContracts.roles].sort(),
  [...canonicalIronWrapRoles].sort(),
  "access_control.py must declare the canonical eight IronWrap roles",
);
assert.deepEqual(
  [...pythonContracts.allRoles].sort(),
  [...canonicalIronWrapRoles, ...canonicalServiceRoles].sort(),
  "access_control.py must declare the exact canonical and service roles",
);

const docs = new Map(specs.map((spec) => [spec.name, readDoc(spec.dir)]));
const localDoctypes = new Set(docs.keys());
const topLevelNames = specs.filter((spec) => !spec.child).map((spec) => spec.name).sort();
assert.deepEqual(
  [...pythonContracts.matrixNames].sort(),
  topLevelNames,
  "access_control.py must define least-privilege access for every top-level DocType",
);

const controllerKinds = new Set();

for (const spec of specs) {
  const doc = docs.get(spec.name);
  const fields = new Map(doc.fields.map((field) => [field.fieldname, field]));

  assert.equal(doc.doctype, "DocType");
  assert.equal(doc.name, spec.name);
  assert.equal(doc.module, "IronWrap Roofing");
  assert.equal(doc.istable ? 1 : 0, spec.child ? 1 : 0, `${spec.name} istable mismatch`);
  assert.equal(fields.size, doc.fields.length, `${spec.name} has duplicate field names`);
  assert.deepEqual(
    [...new Set(doc.field_order)].sort(),
    [...fields.keys()].sort(),
    `${spec.name} fields and field_order must describe the same contract`,
  );

  if (spec.idField) {
    assert.equal(doc.autoname, `field:${spec.idField}`, `${spec.name} autoname`);
    assert.equal(doc.naming_rule, "By fieldname", `${spec.name} naming_rule`);
    assert.equal(fields.get(spec.idField)?.unique, 1, `${spec.name}.${spec.idField} must be unique`);
    assert.equal(fields.get(spec.idField)?.reqd, 1, `${spec.name}.${spec.idField} must be required`);
  }

  for (const name of spec.requiredFields) {
    assert.ok(fields.has(name), `${spec.name} missing field: ${name}`);
    assert.ok(doc.field_order.includes(name), `${spec.name} field_order missing: ${name}`);
  }

  for (const [fieldName, contract] of Object.entries(spec.fieldContracts ?? {})) {
    const field = fields.get(fieldName);
    assert.ok(field, `${spec.name} missing contracted field: ${fieldName}`);
    for (const [property, expected] of Object.entries(contract)) {
      assert.equal(
        field[property],
        expected,
        `${spec.name}.${fieldName}.${property} contract mismatch`,
      );
    }
  }

  for (const field of doc.fields) {
    if (field.fieldtype !== "Link" && field.fieldtype !== "Table") continue;
    const target = field.options;
    assert.ok(target, `${spec.name}.${field.fieldname} missing link/table target`);
    assert.ok(localDoctypes.has(target) || frappeCoreTargets.has(target), `${spec.name}.${field.fieldname} unknown target: ${target} (only owned DocTypes and MIT Frappe core targets are allowed)`);
  }

  validatePermissions(spec, doc);
  validateController(spec, fields);
}

assert.deepEqual(
  [...controllerKinds].sort(),
  [...pythonContracts.identityKinds].sort(),
  "domain_policy.py identity policies must exactly cover the top-level DocType controllers",
);

validateRuntimeWiring();

function readDoc(dir) {
  const path = join(root, doctypeRoot, dir, `${dir}.json`);
  assert.ok(existsSync(path), `missing DocType JSON: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function readPythonContracts() {
  const accessControlPath = join(root, appRoot, "access_control.py");
  const domainPolicyPath = join(root, appRoot, "domain_policy.py");
  assert.ok(existsSync(accessControlPath), `missing access-control contract: ${accessControlPath}`);
  assert.ok(existsSync(domainPolicyPath), `missing domain-policy contract: ${domainPolicyPath}`);

  const source = String.raw`
import json
import runpy
import sys

access = runpy.run_path(sys.argv[1])
domain = runpy.run_path(sys.argv[2])
matrix = access["DOCTYPE_ROLE_MATRIX"]
print(json.dumps({
    "roles": access["IRONWRAP_ROLES"],
    "all_roles": access["ALL_IRONWRAP_ROLES"],
    "matrix_names": list(matrix),
    "expected_permissions": {
        name: access["expected_permissions"](name) for name in matrix
    },
    "identity_kinds": list(domain["IDENTITY_FIELDS"]),
    "identity_fields": domain["IDENTITY_FIELDS"],
}))
`;

  let output;
  try {
    output = execFileSync("python3", ["-c", source, accessControlPath, domainPolicyPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error.message;
    assert.fail(`unable to load Python production contracts: ${detail}`);
  }
  const parsed = JSON.parse(output);
  return {
    roles: parsed.roles,
    allRoles: parsed.all_roles,
    matrixNames: parsed.matrix_names,
    expectedPermissions: parsed.expected_permissions,
    identityKinds: parsed.identity_kinds,
    identityFields: parsed.identity_fields,
  };
}

function normalizedPermissions(rows) {
  return rows
    .map((row) => Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))))
    .sort((left, right) => left.role.localeCompare(right.role));
}

function validatePermissions(spec, doc) {
  const permissions = doc.permissions ?? [];
  if (spec.child) {
    assert.deepEqual(permissions, [], `${spec.name} child tables must not grant direct access`);
    return;
  }

  const expected = pythonContracts.expectedPermissions[spec.name];
  assert.ok(expected, `${spec.name} missing from access_control.py permission contract`);
  assert.deepEqual(
    normalizedPermissions(permissions),
    normalizedPermissions(expected),
    `${spec.name} permissions diverge from access_control.py`,
  );

  const allowedRoles = new Set([
    "System Manager",
    ...canonicalIronWrapRoles,
    ...canonicalServiceRoles,
  ]);
  const roles = permissions.map((row) => row.role);
  assert.equal(new Set(roles).size, roles.length, `${spec.name} has duplicate permission roles`);
  assert.ok(roles.includes("System Manager"), `${spec.name} must retain System Manager access`);
  assert.ok(roles.includes("IronWrap Owner"), `${spec.name} must retain owner-operator access`);
  for (const row of permissions) {
    assert.ok(allowedRoles.has(row.role), `${spec.name} grants non-canonical role ${row.role}`);
    assert.notEqual(row.delete, 1, `${spec.name} must never grant delete to ${row.role}`);
    if (row.role !== "System Manager") {
      assert.notEqual(row.export, 1, `${spec.name} must not grant export to ${row.role}`);
      assert.notEqual(row.import, 1, `${spec.name} must not grant import to ${row.role}`);
      assert.notEqual(row.share, 1, `${spec.name} must not grant share to ${row.role}`);
    }
  }
}

function validateController(spec, fields) {
  const path = join(root, doctypeRoot, spec.dir, `${spec.dir}.py`);
  assert.ok(existsSync(path), `missing DocType controller: ${path}`);
  const source = readFileSync(path, "utf8");
  const sharedImport = /from\s+ironwrap_roofing\.document_validation\s+import\s+validate_business_document/;
  const sharedCall = new RegExp(
    `validate_business_document\\s*\\(\\s*self\\s*,\\s*["']${spec.dir}["']\\s*\\)`,
  );

  if (spec.child) {
    assert.ok(!sharedCall.test(source), `${spec.name} child validation belongs to its owning parent`);
    return;
  }

  assert.match(source, sharedImport, `${spec.name} controller must import shared validation`);
  assert.match(source, /def\s+validate\s*\(\s*self\s*\)/, `${spec.name} controller must validate before save`);
  assert.match(source, sharedCall, `${spec.name} controller must validate with kind ${spec.dir}`);
  assert.equal(
    [...source.matchAll(/validate_business_document\s*\(/g)].length,
    1,
    `${spec.name} controller must call shared validation exactly once`,
  );
  if (spec.dir === "lead_envelope") {
    assert.match(
      source,
      /validate_lead_envelope_triage_mutation\s*\(\s*self\s*\)/,
      "Lead Envelope controller must reject generic triage mutations before shared policy validation",
    );
  }
  assert.ok(pythonContracts.identityKinds.includes(spec.dir), `${spec.name} has no identity policy`);
  for (const fieldName of pythonContracts.identityFields[spec.dir] ?? []) {
    assert.ok(fields.has(fieldName), `${spec.name} identity policy references missing field ${fieldName}`);
  }
  controllerKinds.add(spec.dir);
}

function validateRuntimeWiring() {
  const paths = {
    accessControl: join(root, appRoot, "access_control.py"),
    documentValidation: join(root, appRoot, "document_validation.py"),
    domainPolicy: join(root, appRoot, "domain_policy.py"),
    hooks: join(root, appRoot, "hooks.py"),
    install: join(root, appRoot, "install.py"),
  };
  for (const [name, path] of Object.entries(paths)) {
    assert.ok(existsSync(path), `missing ${name} runtime contract: ${path}`);
  }

  const hooks = readFileSync(paths.hooks, "utf8");
  const hookContracts = {
    before_install: "ironwrap_roofing.install.before_install",
    after_install: "ironwrap_roofing.install.after_install",
    before_migrate: "ironwrap_roofing.install.before_migrate",
    after_migrate: "ironwrap_roofing.install.after_migrate",
  };
  for (const [hook, target] of Object.entries(hookContracts)) {
    const assignment = new RegExp(`^${hook}\\s*=\\s*["']${target}["']\\s*$`, "m");
    assert.match(hooks, assignment, `${hook} must reconcile IronWrap roles through ${target}`);
  }
  assert.match(hooks, /doc_events\s*=\s*\{/, "hooks.py must register delete protection");
  assert.match(
    hooks,
    /"on_trash"\s*:\s*"ironwrap_roofing\.document_validation\.deny_business_document_delete"/,
    "every owned top-level record must deny delete at runtime",
  );

  const install = readFileSync(paths.install, "utf8");
  assert.match(
    install,
    /from\s+ironwrap_roofing\.access_control\s+import\s+ALL_IRONWRAP_ROLES,\s+IRONWRAP_ROLES/,
  );
  assert.match(install, /def\s+ensure_roles\s*\(\s*\)/, "install.py must expose idempotent role reconciliation");
  assert.match(install, /def\s+reconcile_site_contract\s*\(\s*\)/, "install.py must expose site-contract reconciliation");
  assert.match(install, /for\s+role_name\s+in\s+ALL_IRONWRAP_ROLES/, "role reconciliation must cover every canonical and service role");
  assert.match(install, /def\s+before_install\s*\(\s*\)/, "install.py must expose before_install");
  assert.match(install, /def\s+before_migrate\s*\(\s*\)/, "install.py must expose before_migrate");
  assert.match(install, /def\s+after_install\s*\(\s*\)/, "install.py must expose after_install");
  assert.match(install, /def\s+after_migrate\s*\(\s*\)/, "install.py must expose after_migrate");
  assert.equal(
    [...install.matchAll(/^\s+reconcile_site_contract\(\)\s*$/gm)].length,
    3,
    "initial install and both migration phases must run site-contract reconciliation",
  );

  const adapter = readFileSync(paths.documentValidation, "utf8");
  assert.match(adapter, /from\s+ironwrap_roofing\.domain_policy\s+import\s+PolicyViolation,\s+validate_record/);
  assert.match(adapter, /def\s+validate_business_document\s*\(/, "shared Frappe validation adapter is missing");
  assert.match(adapter, /def\s+deny_business_document_delete\s*\(/, "append-only delete guard is missing");
}

const childCount = specs.filter((spec) => spec.child).length;
console.log(
  `ok ${specs.length} IronWrap Frappe DocTypes validated (${specs.length - childCount} top-level + ${childCount} child)`,
);
