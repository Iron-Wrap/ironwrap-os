#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createHmac, verify as verifySignature } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  GOVERNED_TAKEOFF_CALCULATION_VERSION,
  takeoffFromGeometryWithPolicy,
} from "../../../workers-bus/src/takeoff.ts";
import {
  approvedArgs,
  digest,
  parseToolPayload,
  semanticPreview,
  signDryRunReceipt,
  verifyApprovalReceipt,
  verifyDryRunReceipt,
} from "./approval-contract.mjs";
import {
  buildCommunicationEventDraft,
  buildCommunicationEventDraftFromArgs,
  checkConsent,
  checkQuietHours,
} from "./communication-draft.mjs";
import {
  assertJobCostEventSources,
  buildJobCostEventCandidate,
  classifyJobCostEventReplay,
  JobCostEventInputSchema,
} from "./job-cost-event.mjs";

export {
  buildCommunicationEventDraft,
  buildCommunicationEventDraftFromArgs,
  checkConsent,
  checkQuietHours,
};
export {
  assertJobCostEventSources,
  buildJobCostEventCandidate,
  classifyJobCostEventReplay,
  JobCostEventInputSchema,
};

const DEFAULT_ROLE_POLICY_PATH = fileURLToPath(
  new URL("../../../hermes/agents/roles.json", import.meta.url),
);

const REQUEST_TO_DRY_RUN = Object.freeze({
  request_update_gate: "dry_run_update_gate",
  request_create_material_takeoff: "dry_run_material_takeoff",
  request_update_material_takeoff_status: "dry_run_update_material_takeoff_status",
  request_create_supplier_order: "dry_run_supplier_order",
  request_transition_supplier_order: "dry_run_supplier_order_transition",
  request_create_supplier_quote: "dry_run_supplier_quote",
  request_create_quote_revision: "dry_run_quote_revision",
  request_bind_quote_price_rules: "dry_run_bind_quote_price_rules",
  request_create_proposal_evidence_pack: "dry_run_proposal_evidence_pack",
  request_publish_proposal_evidence_pack: "dry_run_publish_proposal_evidence_pack",
  request_approve_controlled_item: "dry_run_approve_controlled_item",
  request_receive_material_lot: "dry_run_receive_material_lot",
  request_release_shop_order: "dry_run_release_shop_order",
  request_reserve_shop_order_materials: "dry_run_reserve_shop_order_materials",
  request_advance_shop_order_setup: "dry_run_advance_shop_order_setup",
  request_record_first_piece_outcome: "dry_run_record_first_piece_outcome",
  request_record_final_shop_quality: "dry_run_record_final_shop_quality",
  request_record_shop_handover: "dry_run_record_shop_handover",
  request_record_shop_billing_basis: "dry_run_record_shop_billing_basis",
  request_create_job_assignment: "dry_run_job_assignment",
  request_create_change_order: "dry_run_change_order",
  request_transition_change_order: "dry_run_change_order_transition",
  request_create_insurance_supplement: "dry_run_insurance_supplement",
  request_set_insurance_supplement_evidence: "dry_run_set_insurance_supplement_evidence",
  request_transition_insurance_supplement: "dry_run_insurance_supplement_transition",
  request_create_safety_plan: "dry_run_safety_plan",
  request_record_safety_acknowledgement: "dry_run_safety_acknowledgement",
  request_record_job_compliance: "dry_run_job_compliance_record",
  request_authority_record: "dry_run_authority_record",
  request_record_customer_decision: "dry_run_customer_decision",
  request_record_communication_consent: "dry_run_communication_consent",
  request_resolve_reconciliation: "dry_run_reconciliation_resolution",
  request_tenant_export: "dry_run_tenant_export",
  request_create_completion_packet: "dry_run_completion_packet",
  request_create_warranty_packet: "dry_run_warranty_packet",
  request_create_review_request: "dry_run_review_request",
  request_record_communication_event: "dry_run_communication_event",
  request_mark_lead_triaged: "dry_run_mark_lead_triaged",
  request_add_market_watch_item: "dry_run_market_watch_item",
  request_complete_work_package: "dry_run_complete_work_package",
});

const FIELD_RECORD_TOOL_REFERENCES = Object.freeze({
  get_field_check_in: ["Field Check-in", "checkin_id"],
  get_evidence_item: ["Evidence Item", "evidence_id"],
  get_job_assignment: ["Job Assignment", "assignment_id"],
  get_safety_plan: ["Safety Plan", "safety_plan_id"],
  get_job_compliance_record: ["Job Compliance Record", "compliance_record_id"],
  get_authority_record: ["Authority Record", "authority_record_id"],
  get_visual_property_model: ["Visual Property Model", "visual_model_id"],
  get_roof_area: ["Roof Area", "roof_area_id"],
});

const FIELD_ROOF_JOB_FIELDS = [
  "name",
  "roof_job_id",
  "job_number",
  "status",
  "job_type",
  "address_line1",
  "city",
  "province",
  "postal_code",
  "access_notes",
  "safety_notes",
  "scheduled_start",
  "scheduled_end",
  "modified",
];

const GateStateSchema = z.enum(["Blocked", "Ready", "Waived", "Done"]);
const GATE_EVIDENCE_STATES = new Set(["Ready", "Done"]);
const MaterialTakeoffStatusSchema = z.enum(["Needs Review", "Approved", "Rejected"]);
const PRODUCTION_SCHEDULING_GATES = Object.freeze([
  "Deposit",
  "Materials",
  "Safety",
  "Access",
  "Weather",
  "Crew",
]);
const SCHEDULABLE_PRODUCTION_GATE_STATES = new Set(["Ready", "Done", "Waived"]);
const PRODUCTION_SCHEDULE_PREVIEW_LIMIT = 25;

const GATE_FIELDS = [
  "name",
  "gate_id",
  "roof_job",
  "gate",
  "state",
  "blocker_reason",
  "evidence_item",
  "modified",
];

const PRODUCTION_SCHEDULE_PREVIEW_FIELDS = ["gate", "state"];

const HERMES_RUN_FIELDS = [
  "name",
  "run_id",
  "run_ts",
  "agent_role",
  "capability_level",
  "tool_name",
  "approval_status",
  "result_status",
  "roof_job",
  "lead_envelope",
  "modified",
];

const MEASUREMENT_REPORT_FIELDS = [
  "name",
  "measurement_id",
  "roof_job",
  "provider",
  "review_status",
  "approved_by",
  "approved_at",
  "roof_graph_revision",
  "modified",
];

const MATERIAL_TAKEOFF_POLICY_FIELDS = [
  "name",
  "policy_id",
  "tenant",
  "brand",
  "service_type",
  "material_system",
  "policy_version",
  "status",
  "effective_from",
  "effective_to",
  "source_evidence",
  "approved_by",
  "approved_at",
  "approval_note",
  "modified",
];

const MATERIAL_TAKEOFF_FIELDS = [
  "name",
  "takeoff_id",
  "roof_job",
  "measurement_report",
  "status",
  "prepared_at",
  "approved_by",
  "approved_at",
  "approval_note",
  "tenant",
  "material_system",
  "calculation_schema",
  "calculation_version",
  "geometry_revision",
  "source_raw_key",
  "source_raw_sha256",
  "takeoff_policy",
  "policy_version",
  "policy_source_evidence",
  "policy_source_sha256",
  "policy_digest",
  "options_digest",
  "calculation_digest",
  "stock_mode",
  "modified",
];

const SUPPLIER_ORDER_FIELDS = [
  "name",
  "supplier_order_id",
  "roof_job",
  "material_takeoff",
  "source_quote",
  "supplier",
  "status",
  "prepared_at",
  "approved_by",
  "approved_at",
  "internal_transmission_id",
  "internal_transmitted_at",
  "supplier_acknowledgement_id",
  "supplier_acknowledged_at",
  "supplier_acknowledgement_evidence",
  "requested_delivery_date",
  "received_at",
  "receipt_evidence_json",
  "modified",
];

const INSTANT_ESTIMATE_SESSION_FIELDS = [
  "name",
  "estimate_session_id",
  "lead_envelope",
  "roof_job",
  "service_type",
  "status",
  "range_low",
  "range_high",
  "estimate_total",
  "configurator_url",
  "review_required",
  "modified",
];

const EVIDENCE_ITEM_FIELDS = [
  "name",
  "evidence_id",
  "roof_job",
  "work_package",
  "work_package_version",
  "work_package_release_attempt_id",
  "evidence_slot_id",
  "evidence_requirement",
  "evidence_source",
  "evidence_device_id",
  "evidence_type",
  "source_uri",
  "r2_key",
  "drive_file_id",
  "customer_safe",
  "proof_slot",
  "sync_state",
  "content_checksum",
  "checksum_algorithm",
  "verified_at",
  "verification_source",
  "evidence_freshness",
  "evidence_conflict_state",
  "evidence_verification",
  "evidence_disposition",
  "correction_of",
  "correction_reason",
  "modified",
];

const WORK_PACKAGE_FIELDS = [
  "name",
  "work_package_id",
  "roof_job",
  "job_assignment",
  "work_object_type",
  "work_object_id",
  "physical_context_type",
  "physical_context_id",
  "version",
  "release_attempt_id",
  "status",
  "title",
  "objective",
  "boundaries",
  "prerequisites",
  "expected_result",
  "stop_conditions",
  "make_safe_procedure",
  "issued_at",
  "expires_at",
  "released_at",
  "completed_at",
  "assigned_workers",
  "supersedes",
  "correction_reason",
  "modified",
];

const WORK_PACKAGE_WORKER_FIELDS = [
  "sequence",
  "worker_user",
  "worker_role",
  "required",
];

const WORK_PACKAGE_EVENT_FIELDS = [
  "name",
  "work_package_event_id",
  "event_type",
  "work_package",
  "roof_job",
  "job_assignment",
  "work_object_type",
  "work_object_id",
  "physical_context_type",
  "physical_context_id",
  "work_package_version",
  "release_attempt_id",
  "actor_user",
  "actor_role",
  "device_action_id",
  "occurred_at",
  "evidence_item",
  "evidence_slot_id",
  "evidence_requirement",
  "evidence_source",
  "evidence_device_id",
  "evidence_captured_at",
  "evidence_freshness",
  "evidence_conflict_state",
  "evidence_correction_of",
  "evidence_item_correction_of",
  "evidence_review_of",
  "evidence_verification",
  "evidence_disposition",
  "correction_reason",
  "modified",
];

const FIELD_CHECK_IN_FIELDS = [
  "name",
  "checkin_id",
  "roof_job",
  "job_number",
  "source_system",
  "submitted_at",
  "status",
  "photo_count",
  "modified",
];

const PROPOSAL_EVIDENCE_PACK_FIELDS = [
  "name",
  "pack_id",
  "roof_job",
  "quotation",
  "status",
  "prepared_at",
  "approved_by",
  "modified",
];

const PAYMENT_MILESTONE_FIELDS = [
  "name",
  "payment_milestone_id",
  "roof_job",
  "milestone_type",
  "status",
  "qb_entity_type",
  "qb_entity_id",
  "event_ts",
  "modified",
];

const JOB_COST_EVENT_FIELDS = [
  "name",
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
  "authority_ref",
  "recorded_at",
  "approval_reference",
  "modified",
];

const COMPLETION_PACKET_FIELDS = [
  "name",
  "completion_packet_id",
  "roof_job",
  "status",
  "prepared_at",
  "approved_by",
  "approved_at",
  "warranty_ready",
  "customer_signoff_ref",
  "modified",
];

const WARRANTY_PACKET_FIELDS = [
  "name",
  "warranty_packet_id",
  "roof_job",
  "completion_packet",
  "status",
  "prepared_at",
  "approved_by",
  "approved_at",
  "material_system",
  "coverage_start",
  "coverage_years",
  "modified",
];

const REVIEW_REQUEST_FIELDS = [
  "name",
  "review_request_id",
  "roof_job",
  "completion_packet",
  "status",
  "channel",
  "prepared_at",
  "approved_by",
  "approved_at",
  "consent_basis",
  "review_link",
  "modified",
];

const COMMUNICATION_EVENT_FIELDS = [
  "name",
  "communication_event_id",
  "roof_job",
  "lead_envelope",
  "channel",
  "direction",
  "template",
  "consent_basis",
  "policy_result",
  "quiet_hours_ok",
  "status",
  "recipient_ref",
  "event_ts",
  "modified",
];

const LEAD_TRIAGE_FIELDS = [
  "name",
  "envelope_id",
  "source",
  "event_ts",
  "status",
  "intent_queue",
  "triage_status",
  "triaged_by",
  "triaged_at",
  "triage_summary",
  "contact_name",
  "contact_phone",
  "contact_email",
  "job_ref",
  "modified",
];

const SUPPLIER_QUOTE_FIELDS = [
  "name",
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
  "modified",
];

// Customer Quote reads are strict and intentionally exclude tax-policy JSON, payment truth,
// internal notes, and acceptance proof. Quote revision commands read the full source server-side
// only to build a blank, review-gated successor; none of those commercial fields are copied.
const CUSTOMER_QUOTE_FIELDS = [
  "name",
  "customer_quote_id",
  "roof_job",
  "customer",
  "quote_version",
  "status",
  "price_book_version",
  "pricing_effective_at",
  "quote_total",
  "currency",
  "valid_until",
  "prepared_at",
  "approved_by",
  "approved_at",
  "supersedes",
  "correction_reason",
  "modified",
];

const MARKET_WATCH_ITEM_FIELDS = [
  "name",
  "watch_id",
  "competitor",
  "title",
  "source_url",
  "risk_level",
  "status",
  "observed_at",
  "product_gate",
  "modified",
];

const PRICE_BOOK_RULE_FIELDS = [
  "name",
  "price_rule_id",
  "rule_name",
  "rule_type",
  "status",
  "service_type",
  "material_system",
  "unit",
  "unit_cost",
  "unit_price",
  "currency",
  "effective_from",
  "effective_to",
  "modified",
];

const PRICE_RULE_SNAPSHOT_FIELDS = [
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
  "effective_from",
  "effective_to",
  "assumptions",
  "exclusions",
  "approved_by",
  "approved_at",
];

const VISUAL_PROPERTY_MODEL_FIELDS = [
  "name",
  "visual_model_id",
  "roof_job",
  "roofing_property",
  "provider",
  "provider_model_id",
  "model_uri",
  "status",
  "confidence",
  "needs_review",
  "source_evidence",
  "captured_at",
  "modified",
];

const ROOF_AREA_FIELDS = [
  "name",
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
  "needs_review",
  "modified",
];

const OPTION_PACKAGE_FIELDS = [
  "name",
  "option_package_id",
  "roof_job",
  "package_name",
  "tier",
  "status",
  "material_system",
  "price_delta",
  "currency",
  "warranty_summary",
  "modified",
];

const SCOPE_CLAUSE_FIELDS = [
  "name",
  "scope_clause_id",
  "roof_job",
  "customer_quote",
  "clause_type",
  "title",
  "version",
  "status",
  "customer_visible",
  "modified",
];

const AUTOMATION_INCIDENT_FIELDS = [
  "name",
  "incident_id",
  "status",
  "severity",
  "source_system",
  "category",
  "summary",
  "roof_job",
  "lead_envelope",
  "record_ref",
  "correlation_id",
  "detected_at",
  "assigned_to",
  "resolved_at",
  "modified",
];

const WHITE_LABEL_TENANT_FIELDS = [
  "name",
  "tenant_id",
  "status",
  "site_hostname",
  "legal_name",
  "primary_brand",
  "owner_user",
  "support_email",
  "data_residency",
  "isolation_model",
  "activated_at",
  "modified",
];

const CREW_PROFILE_FIELDS = [
  "name",
  "crew_profile_id",
  "crew_name",
  "status",
  "crew_type",
  "primary_lead",
  "default_workflow_profile",
  "home_region",
  "timezone",
  "insurance_expiry",
  "wcb_expiry",
  "modified",
];

const JOB_ASSIGNMENT_FIELDS = [
  "name",
  "assignment_id",
  "roof_job",
  "assignment_type",
  "status",
  "crew_profile",
  "assigned_user",
  "scheduled_start",
  "scheduled_end",
  "assigned_by",
  "assigned_at",
  "accepted_at",
  "started_at",
  "completed_at",
  "blocker_reason",
  "supersedes",
  "modified",
];

const CHANGE_ORDER_FIELDS = [
  "name",
  "change_order_id",
  "roof_job",
  "customer_quote",
  "change_number",
  "version",
  "status",
  "title",
  "reason",
  "scope_delta",
  "currency",
  "subtotal",
  "tax_amount",
  "total_amount",
  "price_book_version",
  "tax_policy_snapshot_json",
  "items",
  "requested_by",
  "requested_at",
  "approved_by",
  "approved_at",
  "contract_acceptance",
  "accepted_at",
  "supersedes",
  "modified",
];

const CHANGE_ORDER_ITEM_FIELDS = [
  "item_type",
  "description",
  "quantity",
  "unit",
  "unit_price",
  "line_total",
  "tax_code",
  "source_ref",
  "customer_visible",
];

const INSURANCE_SUPPLEMENT_FIELDS = [
  "name",
  "insurance_supplement_id",
  "roof_job",
  "version",
  "status",
  "measurement_report",
  "invoice_required",
  "approved_at",
  "submitted_at",
  "carrier_response_at",
  "closed_at",
  "modified",
];

const INSURANCE_SUPPLEMENT_EVIDENCE_FIELDS = [
  "evidence_role",
];

const INSURANCE_EVIDENCE_TYPES = Object.freeze({
  "Carrier Scope": ["PDF", "Email", "Signed Document"],
  "Code/Manufacturer": ["PDF", "Email", "Signed Document"],
  Photo: ["Photo"],
  Invoice: ["Invoice"],
  Submission: ["PDF", "Email", "Signed Document"],
  "Carrier Response": ["PDF", "Email", "Signed Document"],
});

const SAFETY_PLAN_FIELDS = [
  "name",
  "safety_plan_id",
  "roof_job",
  "version",
  "status",
  "effective_date",
  "prepared_by",
  "prepared_at",
  "hazard_summary",
  "controls",
  "emergency_plan",
  "ppe_requirements",
  "weather_limits",
  "evidence_item",
  "acknowledgements",
  "approved_by",
  "approved_at",
  "supersedes",
  "modified",
];

const SAFETY_ACKNOWLEDGEMENT_FIELDS = [
  "name",
  "idx",
  "acknowledged_by",
  "acknowledged_at",
  "acknowledgement_method",
  "device_action_id",
  "evidence_item",
  "role_on_job",
  "notes",
];

const JOB_COMPLIANCE_RECORD_FIELDS = [
  "name",
  "compliance_record_id",
  "roof_job",
  "jurisdiction",
  "record_type",
  "authority_name",
  "external_reference",
  "authority_record",
  "status",
  "required_before_gate",
  "applied_at",
  "effective_date",
  "expiry_date",
  "inspected_at",
  "evidence_item",
  "owner_user",
  "due_date",
  "waived_by",
  "waived_at",
  "waiver_reason",
  "supersedes",
  "modified",
];

const AUTHORITY_RECORD_FIELDS = [
  "name",
  "authority_record_id",
  "tenant",
  "subject_type",
  "subject_role",
  "person_user",
  "organization",
  "authority_kind",
  "authority_scope",
  "scope_type",
  "scope_ref",
  "roof_job",
  "scope_json",
  "issuer_name",
  "issuer_jurisdiction",
  "issuer_reference",
  "source_version",
  "evidence_refs_json",
  "evidence_sha256",
  "issuer_readback_json",
  "effective_from",
  "expires_at",
  "version",
  "status",
  "state_digest_sha256",
  "verification_method",
  "verified_at",
  "verification_reference",
  "verified_by",
  "revoked_at",
  "revocation_reference",
  "revoked_by",
  "supersedes",
  "correction_reason",
  "exception_status",
  "exception_reason",
  "modified",
];

const AUTHORITY_MATERIAL_DIGEST_FIELDS = [
  "authority_record_id",
  "tenant",
  "subject_type",
  "subject_role",
  "person_user",
  "organization",
  "authority_kind",
  "authority_scope",
  "scope_type",
  "scope_ref",
  "roof_job",
  "scope_json",
  "issuer_name",
  "issuer_jurisdiction",
  "issuer_reference",
  "source_version",
  "evidence_refs_json",
  "evidence_sha256",
  "effective_from",
  "expires_at",
  "version",
  "status",
  "verification_method",
  "verified_at",
  "verification_reference",
  "verified_by",
  "revoked_at",
  "revocation_reference",
  "revoked_by",
  "supersedes",
  "correction_reason",
  "exception_status",
  "exception_reason",
];
const EXTERNAL_AUTHORITY_KINDS = new Set([
  "Trade Licence",
  "WCB Clearance",
  "Insurance Certificate",
  "Permit",
  "Inspection",
  "Manufacturer Certification",
  "Manufacturer Bulletin",
]);

const COMMUNICATION_CONSENT_FIELDS = [
  "name",
  "consent_id",
  "customer",
  "lead_envelope",
  "roof_job",
  "channel",
  "purpose",
  "status",
  "jurisdiction",
  "consent_basis",
  "source_system",
  "source_reference",
  "captured_by",
  "captured_at",
  "effective_from",
  "expires_at",
  "proof_evidence",
  "revoked_at",
  "supersedes",
  "modified",
];

const CUSTOMER_DECISION_FIELDS = [
  "name",
  "decision_id",
  "roof_job",
  "customer",
  "decision_type",
  "status",
  "decision_value",
  "decision_summary",
  "source_channel",
  "decided_at",
  "captured_by",
  "evidence_item",
  "option_package",
  "change_order",
  "supersedes",
  "modified",
];

const CONTRACT_ACCEPTANCE_FIELDS = [
  "name",
  "acceptance_id",
  "roof_job",
  "customer",
  "customer_quote",
  "change_order",
  "contract_version",
  "status",
  "accepted_at",
  "acceptance_method",
  "evidence_item",
  "terms_hash",
  "document_checksum",
  "source_system",
  "provider_reference",
  "supersedes",
  "modified",
];

const INTEGRATION_RECONCILIATION_FIELDS = [
  "name",
  "reconciliation_id",
  "roof_job",
  "system_name",
  "entity_type",
  "external_entity_id",
  "local_doctype",
  "local_name",
  "direction",
  "status",
  "detected_at",
  "source_version",
  "source_amount",
  "local_amount",
  "currency",
  "diff_json",
  "source_payload_hash",
  "local_payload_hash",
  "last_attempt_at",
  "attempt_count",
  "resolution_action",
  "resolved_by",
  "resolved_at",
  "resolution_evidence",
  "automation_incident",
  "supersedes",
  "modified",
];

const TENANT_EXPORT_RUN_FIELDS = [
  "name",
  "export_run_id",
  "tenant",
  "status",
  "requested_by",
  "requested_at",
  "started_at",
  "completed_at",
  "scope_json",
  "record_count",
  "evidence_count",
  "byte_count",
  "failure_reason",
  "supersedes",
  "modified",
];

export function configFromEnv(env = process.env) {
  const baseUrl = normalizeFrappeBaseUrl(env.ERPNEXT_BASE_URL, env.ERPNEXT_ALLOW_INSECURE_LOCAL === "true");
  const effectRuntimeUrl = env.IRONWRAP_EFFECT_RUNTIME_URL
    ? normalizeEffectRuntimeBaseUrl(env.IRONWRAP_EFFECT_RUNTIME_URL, env.ERPNEXT_ALLOW_INSECURE_LOCAL === "true")
    : null;
  const effectRuntimeToken = env.IRONWRAP_EFFECT_RUNTIME_TOKEN;
  const allowInsecureLocal = env.ERPNEXT_ALLOW_INSECURE_LOCAL === "true";
  const apiKey = env.ERPNEXT_API_KEY;
  const apiSecret = env.ERPNEXT_API_SECRET;
  const writeEnabled = env.ERPNEXT_WRITE_ENABLED === "true";
  const rolePolicy = loadRolePolicy(env.HERMES_ROLE_POLICY_PATH || DEFAULT_ROLE_POLICY_PATH);
  const agentRole = env.HERMES_AGENT_ROLE;
  const actorUser = env.HERMES_ACTOR_USER;
  const approverId = env.HERMES_APPROVER_ID;
  const tenantId = env.ERPNEXT_TENANT_ID;
  const runtimeRole = rolePolicy.roles?.[agentRole];
  if (!apiKey) throw new Error("ERPNEXT_API_KEY is required");
  if (!apiSecret) throw new Error("ERPNEXT_API_SECRET is required");
  if (!runtimeRole) throw new Error("HERMES_AGENT_ROLE must name a role in roles.json");
  if (!actorUser) throw new Error("HERMES_ACTOR_USER is required");
  if (!tenantId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tenantId)) {
    throw new Error("ERPNEXT_TENANT_ID is required and must be a stable tenant id");
  }
  if (writeEnabled && (!env.HERMES_DRY_RUN_SIGNING_KEY || env.HERMES_DRY_RUN_SIGNING_KEY.length < 32)) {
    throw new Error("HERMES_DRY_RUN_SIGNING_KEY must be at least 32 characters when writes are enabled");
  }
  const approvalPublicKey = env.HERMES_APPROVAL_PUBLIC_KEY_FILE
    ? readFileSync(env.HERMES_APPROVAL_PUBLIC_KEY_FILE, "utf8")
    : env.HERMES_APPROVAL_PUBLIC_KEY;
  if (writeEnabled && !approvalPublicKey) {
    throw new Error("HERMES_APPROVAL_PUBLIC_KEY_FILE or HERMES_APPROVAL_PUBLIC_KEY is required when writes are enabled");
  }
  if (writeEnabled && !approverId) {
    throw new Error("HERMES_APPROVER_ID is required when writes are enabled");
  }
  if (writeEnabled && (!effectRuntimeUrl || !effectRuntimeToken)) {
    throw new Error("IRONWRAP_EFFECT_RUNTIME_URL and IRONWRAP_EFFECT_RUNTIME_TOKEN are required when writes are enabled");
  }
  if (writeEnabled && env.IRONWRAP_EFFECT_RUNTIME_ENABLED === "false") {
    throw new Error("IRONWRAP_EFFECT_RUNTIME_ENABLED cannot disable the effect runtime when writes are enabled");
  }
  const requestTimeoutMs = parseRequestTimeout(env.ERPNEXT_REQUEST_TIMEOUT_MS);
  const authorityBusBaseUrl = env.IRONWRAP_AUTHORITY_BUS_URL
    ? normalizeAuthorityBusBaseUrl(env.IRONWRAP_AUTHORITY_BUS_URL, allowInsecureLocal)
    : undefined;
  const authorityIssuerPublicKeys = parseAuthorityIssuerPublicKeys(env.AUTHORITY_ISSUER_PUBLIC_KEYS_JSON);
  return {
    baseUrl,
    allowInsecureLocal,
    apiKey,
    apiSecret,
    writeEnabled,
    requestTimeoutMs,
    agentRole,
    agentRoleTitle: runtimeRole.title,
    actorUser,
    approverId,
    tenantId,
    effectRuntimeUrl,
    effectRuntimeToken,
    // A writable MCP must have a configured ledger boundary. The explicit flag is
    // retained for read-only/preview hosts, while write-enabled hosts are enabled
    // by configuration and cannot fall back to a direct provider mutation.
    effectRuntimeEnabled: writeEnabled && !!effectRuntimeUrl && !!effectRuntimeToken,
    allowedTools: roleTools(runtimeRole),
    dryRunSigningKey: env.HERMES_DRY_RUN_SIGNING_KEY,
    approvalPublicKey,
    authorityBusBaseUrl,
    authorityBusHmacKey: env.IRONWRAP_AUTHORITY_EXECUTOR_HMAC_KEY,
    authorityExecutorUserId: env.IRONWRAP_AUTHORITY_EXECUTOR_USER_ID,
    authorityFrappeActorUserId: env.IRONWRAP_AUTHORITY_FRAPPE_ACTOR_USER_ID ?? actorUser,
    authorityBusinessRole: env.IRONWRAP_AUTHORITY_BUSINESS_ROLE,
    authorityIssuerPublicKeys,
  };
}

function parseAuthorityIssuerPublicKeys(raw) {
  if (raw === undefined || raw === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AUTHORITY_ISSUER_PUBLIC_KEYS_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AUTHORITY_ISSUER_PUBLIC_KEYS_JSON must be an object");
  }
  return Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,139}$/.test(key) && typeof value === "string" && value.trim(),
  ));
}

function normalizeAuthorityBusBaseUrl(raw, allowInsecureLocal = false) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("IRONWRAP_AUTHORITY_BUS_URL must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("IRONWRAP_AUTHORITY_BUS_URL must not contain credentials, query, or fragment");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLocal && local && url.protocol === "http:")) {
    throw new Error("IRONWRAP_AUTHORITY_BUS_URL must use HTTPS (HTTP is allowed only for explicit local development)");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function loadRolePolicy(policyPath = DEFAULT_ROLE_POLICY_PATH) {
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (err) {
    throw new Error(`hermes_role_policy_unreadable:${String(err).slice(0, 180)}`);
  }
  if (!policy || typeof policy !== "object" || !policy.roles || typeof policy.roles !== "object") {
    throw new Error("hermes_role_policy_invalid");
  }
  return policy;
}

function roleTools(role) {
  return [...new Set([
    ...(role.reads ?? []),
    ...(role.dry_run ?? []),
    ...(role.approved_write ?? []),
  ])];
}

export async function erpRequest(config, method, path, body) {
  if (method !== "GET" && config.__externalEffectContext && config.effectRuntimeEnabled) {
    return await erpRequestThroughEffectRuntime(config, method, path, body, config.__externalEffectContext);
  }
  return await erpRequestDirect(config, method, path, body);
}

async function erpRequestDirect(config, method, path, body) {
  const timeoutMs = config.requestTimeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(config.baseUrl + path, {
      method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `token ${config.apiKey}:${config.apiSecret}`,
        "user-agent": "ironwrap-erpnext-roofing-mcp/0.2",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`erpnext_timeout_${timeoutMs}ms`);
    throw new Error(`erpnext_network_error: ${String(err).slice(0, 240)}`);
  } finally {
    clearTimeout(timer);
  }

  const responseText = await res.text();
  if (!res.ok) throw new Error(`erpnext_http_${res.status}: ${res.statusText || "request_failed"}`);
  if (!responseText) return {};
  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error(`erpnext_invalid_json_${res.status}`);
  }
}

async function erpRequestThroughEffectRuntime(config, method, path, body, context) {
  const now = new Date();
  const nowIso = now.toISOString();
  const deadlineAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  const request = { method, path, body: body ?? null };
  const action = `mcp.${context.toolName}`;
  const idempotencyKey = `mcp:${context.runId}:${digest(request)}`;
  const target = context.target;
  const envelope = {
    effect: {
      tenantId: config.tenantId,
      actor: { type: "agent", id: config.actorUser },
      taskId: context.runId,
      authority: {
        permitRef: `mcp:approval:${context.runId}`,
        policyRef: action,
        policyVersion: "v1",
      },
      aggregate: { type: target.doctype, id: target.name, version: 0 },
      intentId: context.runId,
      action,
      request,
      provider: "frappe",
      idempotencyKey,
      deadlineAt,
      expectedReadback: expectedReadbackForEffect(path, body, target),
      retryLimit: 0,
      compensationPlan: {},
      correlationId: context.runId,
      now: nowIso,
    },
    authority: {
      permitRef: `mcp:approval:${context.runId}`,
      policyRef: action,
      policyVersion: "v1",
      tenantId: config.tenantId,
      actorType: "agent",
      actorId: config.actorUser,
      expiresAt: deadlineAt,
      allowedActions: [action],
      maxAttempts: 1,
    },
  };
  const claimed = await effectRuntimeRequest(config, "/admin/effects/claim", envelope);
  const attemptId = claimed?.attempt?.attempt_id;
  const effectId = claimed?.effect?.effect_id;
  if (typeof attemptId !== "string" || typeof effectId !== "string") throw new Error("effect_claim_invalid");
  let providerResponse;
  let providerExternalId = target.name;
  let providerOutcome = "accepted";
  try {
    providerResponse = await erpRequestDirect(config, method, path, body);
    context.mutationApplied = true;
  } catch (error) {
    await effectRuntimeRequest(config, "/admin/effects/settle", {
      effectId,
      settlement: {
        attemptId,
        outcome: "unknown",
        detailCode: "mcp_provider_request_unknown",
        now: new Date().toISOString(),
      },
    }).catch(() => {});
    throw error;
  }
  const readback = await readbackForEffect(config, target);
  if (readback.status !== "match") providerOutcome = "unknown";
  const settled = await effectRuntimeRequest(config, "/admin/effects/settle", {
    effectId,
    settlement: {
      attemptId,
      outcome: providerOutcome,
      providerExternalId,
      providerResponse,
      readback,
      detailCode: providerOutcome === "unknown" ? "mcp_provider_readback_required" : null,
      now: new Date().toISOString(),
    },
  });
  if (settled?.effect?.state !== "succeeded") {
    throw new Error(settled?.effect?.result_code ?? "effect_outcome_unknown");
  }
  return providerResponse;
}

async function readbackForEffect(config, target) {
  try {
    const response = await erpRequestDirect(config, "GET", resourcePath(target.doctype, target.name));
    const data = response?.data;
    if (!data || typeof data !== "object" || Array.isArray(data) || data.name !== target.name) {
      return { status: "conflict", observed: data ?? {}, detailCode: "mcp_provider_readback_conflict" };
    }
    return { status: "match", providerExternalId: target.name, observed: data };
  } catch (error) {
    const message = String(error);
    if (message.includes("erpnext_http_404")) return { status: "not_found", detailCode: "mcp_provider_readback_not_found" };
    return { status: "unavailable", detailCode: "mcp_provider_readback_unavailable" };
  }
}

function expectedReadbackForEffect(path, body, target) {
  const expected = { name: target.name };
  // Method endpoints have command-specific projections and may not persist
  // request keys verbatim. Resource writes can safely bind their scalar
  // requested fields to the provider's authoritative record readback.
  if (!path.startsWith("/api/resource/") || !body || typeof body !== "object" || Array.isArray(body)) {
    return expected;
  }
  for (const [key, value] of Object.entries(body)) {
    if (["doctype", "name", "owner", "creation", "modified", "modified_by", "docstatus", "idx"].includes(key)) continue;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      expected[key] = value;
    }
  }
  return expected;
}

async function effectRuntimeRequest(config, path, body) {
  if (!config.effectRuntimeUrl || !config.effectRuntimeToken) throw new Error("effect_runtime_not_configured");
  const controller = new AbortController();
  const timeoutMs = config.requestTimeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${config.effectRuntimeUrl}${path}`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.effectRuntimeToken}`,
        "content-type": "application/json",
        "user-agent": "ironwrap-erpnext-roofing-mcp/iro38",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`effect_runtime_timeout_${timeoutMs}ms`);
    throw new Error(`effect_runtime_network_error:${String(error).slice(0, 180)}`);
  } finally {
    clearTimeout(timer);
  }
  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`effect_runtime_invalid_json_${response.status}`);
  }
  if (!response.ok) throw new Error(`effect_runtime_http_${response.status}:${JSON.stringify(parsed).slice(0, 240)}`);
  return parsed;
}

export function normalizeFrappeBaseUrl(raw, allowInsecureLocal = false) {
  if (!raw) throw new Error("ERPNEXT_BASE_URL is required");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ERPNEXT_BASE_URL must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("ERPNEXT_BASE_URL must not contain credentials, query, or fragment");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLocal && local && url.protocol === "http:")) {
    throw new Error("ERPNEXT_BASE_URL must use HTTPS (HTTP is allowed only for explicit local development)");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function normalizeEffectRuntimeBaseUrl(raw, allowInsecureLocal = false) {
  if (!raw) throw new Error("IRONWRAP_EFFECT_RUNTIME_URL is required");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("IRONWRAP_EFFECT_RUNTIME_URL must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("IRONWRAP_EFFECT_RUNTIME_URL must not contain credentials, query, or fragment");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLocal && local && url.protocol === "http:")) {
    throw new Error("IRONWRAP_EFFECT_RUNTIME_URL must use HTTPS (HTTP is allowed only for explicit local development)");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function parseRequestTimeout(raw) {
  if (raw === undefined || raw === "") return 10_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 60_000) {
    throw new Error("ERPNEXT_REQUEST_TIMEOUT_MS must be an integer from 1000 to 60000");
  }
  return value;
}

export async function erpGet(config, path) {
  return await erpRequest(config, "GET", path);
}

export async function attestFrappeServicePrincipal(config) {
  const response = await erpGet(config, "/api/method/frappe.auth.get_logged_user");
  const principal = response?.message;
  if (typeof principal !== "string" || !principal) {
    throw new Error("frappe_service_principal_invalid");
  }
  if (principal !== config.actorUser) {
    throw new Error("frappe_service_principal_mismatch");
  }
  return principal;
}

export async function erpPost(config, path, body) {
  return await erpRequest(config, "POST", path, body);
}

export async function erpPut(config, path, body) {
  return await erpRequest(config, "PUT", path, body);
}

function assertAuthorityExecutorConfigured(config) {
  if (!config.authorityBusBaseUrl) throw new Error("authority_executor_bus_url_required");
  if (typeof config.authorityBusHmacKey !== "string" || config.authorityBusHmacKey.length < 32) {
    throw new Error("authority_executor_hmac_key_required");
  }
  if (!config.authorityExecutorUserId) throw new Error("authority_executor_user_id_required");
  if (!config.authorityFrappeActorUserId) throw new Error("authority_frappe_actor_user_id_required");
  if (!config.authorityBusinessRole || !["IronWrap Owner", "IronWrap Production"].includes(config.authorityBusinessRole)) {
    throw new Error("authority_business_role_required");
  }
  if (config.authorityFrappeActorUserId !== config.actorUser) {
    throw new Error("authority_frappe_actor_user_mismatch");
  }
}

async function authorityBusRequest(config, method, path, body) {
  assertAuthorityExecutorConfigured(config);
  const rawBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", config.authorityBusHmacKey)
    .update(`${timestamp}\n${method}\n${path}\n${rawBody}`)
    .digest("hex");
  let response;
  try {
    response = await fetch(`${config.authorityBusBaseUrl}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(config.requestTimeoutMs ?? 10_000),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-ironwrap-authority-executor-timestamp": timestamp,
        "x-ironwrap-authority-executor-signature": signature,
        "user-agent": "ironwrap-erpnext-roofing-mcp/authority-executor",
      },
      body: rawBody,
    });
  } catch (err) {
    throw new Error(`authority_bus_network_error:${String(err).slice(0, 240)}`);
  }
  const responseText = await response.text();
  let payload = {};
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(`authority_bus_invalid_json_${response.status}`);
    }
  }
  if (!response.ok) {
    throw new Error(`authority_bus_http_${response.status}:${payload.error ?? response.statusText ?? "request_failed"}`);
  }
  return payload;
}

export function authorityMaterialMismatch(draft, material) {
  if (!material || material.tenant !== draft.tenant ||
      material.authority_record_id !== draft.authority_record_id ||
      Number(material.version) !== Number(draft.version) ||
      material.status !== draft.status) return "identity";
  for (const field of AUTHORITY_MATERIAL_DIGEST_FIELDS) {
    if (canonicalJson(material[field] ?? "") !== canonicalJson(draft[field] ?? "")) return field;
  }
  if (material.state_digest_sha256 !== authorityStateDigest(material)) return "state_digest_sha256";
  if (material.state_digest_sha256 !== authorityStateDigest(draft)) return "command_state_digest_sha256";
  if ((draft.issuer_readback_json ?? "") !== (material.issuer_readback_json ?? "")) {
    return "issuer_readback_json";
  }
  return null;
}

function requireAppliedAuthorityAction(action) {
  if (action?.status === "applied") return action;
  const preservedAction = action && typeof action === "object"
    ? action
    : { status: action?.status ?? "missing" };
  const evidence = {
    action_id: preservedAction.action_id ?? null,
    status: preservedAction.status ?? null,
    result_json: preservedAction.result_json ?? null,
    reconciliation_reason: preservedAction.reconciliation_reason ?? null,
  };
  const error = new Error(
    `authority_terminal_status_not_applied:${preservedAction.status ?? "missing"}:${JSON.stringify(preservedAction)}`,
  );
  error.code = "authority_terminal_status_not_applied";
  // Preserve the exact D1 terminal payload and its evidence on the thrown
  // error. The audit wrapper must fail the Hermes run, while callers and
  // incident handling can still retain the reconciliation receipt verbatim.
  error.d1_action = preservedAction;
  error.d1_evidence = evidence;
  throw error;
}

async function terminalizeAuthorityAction(config, actionId, command, issuerReceipt, material, reason = null) {
  const payload = await authorityBusRequest(
    config,
    "POST",
    `/internal/v1/authority-records/actions/${actionId}/terminal`,
    {
      action_id: actionId,
      command_json: JSON.stringify(command),
      issuer_receipt_json: issuerReceipt ? JSON.stringify(issuerReceipt) : null,
      material_readback_json: material ? JSON.stringify(material) : null,
      reconciliation_reason: material ? null : reason,
    },
  );
  return requireAppliedAuthorityAction(payload.action ?? payload);
}

export async function executeAuthorityRecordMutation(config, { args, draft, before, now }) {
  assertAuthorityExecutorConfigured(config);
  let issuerReceipt = null;
  if (draft.issuer_readback_json) {
    try {
      issuerReceipt = JSON.parse(draft.issuer_readback_json);
    } catch {
      throw new Error("authority_issuer_receipt_invalid");
    }
  }
  // Keep the issuer boundary at the executor as well as at the MCP tool
  // handler. No alternate caller may turn unsigned metadata into external
  // legal, regulatory, insurance, or manufacturer authority.
  assertIssuerReceiptForDraft(config, draft, issuerReceipt);
  const actionId = `authority:${args.run_id}`;
  const idempotencyKey = `authority:${args.run_id}`;
  const commandJson = JSON.stringify(draft);
  const requestFingerprintSha256 = digest({ command: draft, issuer_receipt: issuerReceipt });
  const claimedPayload = await authorityBusRequest(config, "POST", "/internal/v1/authority-records/actions", {
    action_id: actionId,
    authority_record_id: draft.authority_record_id,
    expected_version: Number.isInteger(draft.version) ? draft.version : null,
    idempotency_key: idempotencyKey,
    operation: args.authority_operation,
    request_fingerprint_sha256: requestFingerprintSha256,
    tenant_id: config.tenantId,
    actor_user_id: config.authorityExecutorUserId,
    frappe_actor_user_id: config.authorityFrappeActorUserId,
    business_role: config.authorityBusinessRole,
    command_json: commandJson,
    issuer_receipt_json: issuerReceipt ? JSON.stringify(issuerReceipt) : null,
  });
  const claimed = claimedPayload.action;
  if (!claimed) throw new Error("authority_executor_claim_missing");
  if (claimed.status !== "pending") {
    return {
      d1_action: claimed,
      replayed: true,
      mutation_response: null,
      material_readback: null,
    };
  }

  const write = args.authority_operation === "verify" && before
    ? () => erpPut(config, resourcePath("Authority Record", draft.authority_record_id), draft)
    : () => erpPost(config, "/api/resource/Authority%20Record", draft);
  let mutationResponse;
  let responseLost = false;
  try {
    mutationResponse = await write();
  } catch (err) {
    responseLost = true;
    let recovered;
    try {
      recovered = await readResourceOrNull(config, "Authority Record", draft.authority_record_id);
    } catch (readErr) {
      await terminalizeAuthorityAction(config, actionId, draft, issuerReceipt, null, "frappe_response_lost");
      throw new Error(`authority_frappe_response_lost:${String(err).slice(0, 180)}:${String(readErr).slice(0, 180)}`);
    }
    if (!recovered || authorityMaterialMismatch(draft, recovered)) {
      await terminalizeAuthorityAction(config, actionId, draft, issuerReceipt, null, "frappe_response_lost");
      throw new Error(`authority_frappe_response_lost:${String(err).slice(0, 240)}`);
    }
    const action = await terminalizeAuthorityAction(config, actionId, draft, issuerReceipt, recovered);
    return {
      d1_action: action,
      mutation_response: null,
      material_readback: recovered,
      response_lost_recovered: true,
    };
  }

  let material;
  try {
    material = await readResourceOrNull(config, "Authority Record", draft.authority_record_id);
  } catch (err) {
    await terminalizeAuthorityAction(config, actionId, draft, issuerReceipt, null, "frappe_readback_unavailable");
    throw new Error(`authority_frappe_readback_unavailable:${String(err).slice(0, 240)}`);
  }
  const mismatch = authorityMaterialMismatch(draft, material);
  if (mismatch) {
    await terminalizeAuthorityAction(config, actionId, draft, issuerReceipt, null, `frappe_readback_mismatch:${mismatch}`);
    throw new Error(`authority_frappe_readback_mismatch:${mismatch}`);
  }
  const action = await terminalizeAuthorityAction(config, actionId, draft, issuerReceipt, material);
  return {
    d1_action: action,
    mutation_response: mutationResponse,
    material_readback: material,
    response_lost_recovered: responseLost,
  };
}

export function resourcePath(doctype, name) {
  return `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`;
}

export function resourceListPath(doctype, { fields, filters, limit = 25, orderBy } = {}) {
  const params = new URLSearchParams();
  if (fields) params.set("fields", JSON.stringify(fields));
  if (filters) params.set("filters", JSON.stringify(filters));
  params.set("limit_page_length", String(limit));
  if (orderBy) params.set("order_by", orderBy);
  return `/api/resource/${encodeURIComponent(doctype)}?${params.toString()}`;
}

export function assertWriteApproved(config, args = {}) {
  if (!config.writeEnabled) throw new Error("erpnext_write_disabled");
  if (!config.dryRunSigningKey) throw new Error("hermes_dry_run_signing_key_required");
  if (!config.approvalPublicKey) throw new Error("hermes_approval_public_key_required");
  if (!args.dry_run_receipt) throw new Error("dry_run_receipt_required");
  if (!args.approval_receipt) throw new Error("approval_receipt_required");
}

export function buildGateUpdatePatch(nextState, reason, approvedBy, nowIso, evidenceItemId) {
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  const cleanEvidenceItemId = typeof evidenceItemId === "string" ? evidenceItemId.trim() : "";
  if ((nextState === "Blocked" || nextState === "Waived") && !cleanReason) {
    throw new Error("reason_required_for_gate_state");
  }
  if (GATE_EVIDENCE_STATES.has(nextState) && !cleanEvidenceItemId) {
    throw new Error("evidence_item_required_for_gate_state");
  }
  const patch = { state: nextState };
  if (nextState === "Blocked") {
    patch.blocker_reason = cleanReason;
    return patch;
  }
  patch.blocker_reason = "";
  if (nextState === "Waived") {
    patch.waiver_reason = cleanReason;
    if (approvedBy) patch.waived_by = approvedBy;
    if (nowIso) patch.waived_at = nowIso;
  }
  if (GATE_EVIDENCE_STATES.has(nextState)) patch.evidence_item = cleanEvidenceItemId;
  return patch;
}

export function buildMaterialTakeoffStatusPatch(nextStatus, reason, approvedBy, nowIso) {
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if ((nextStatus === "Approved" || nextStatus === "Rejected") && !cleanReason) {
    throw new Error("reason_required_for_takeoff_status");
  }
  const patch = {
    status: nextStatus,
    approval_note: cleanReason,
  };
  if (nextStatus === "Approved") {
    if (approvedBy) patch.approved_by = approvedBy;
    if (nowIso) patch.approved_at = nowIso;
    return patch;
  }
  patch.approved_by = "";
  patch.approved_at = "";
  return patch;
}

// A lead triage is a local operating annotation. It must never change the
// transport state which the bus owns, and it must never create/update a
// Communication Event (a separate, consent-gated record-only command).
export function buildLeadTriagePatch({ triageSummary, triagedBy, nowIso }) {
  const summary = typeof triageSummary === "string" ? triageSummary.trim() : "";
  if (!summary) throw new Error("lead_triage_summary_required");
  if (summary.length > 2000) throw new Error("lead_triage_summary_too_long");
  const approvedActor = typeof triagedBy === "string" ? triagedBy.trim() : "";
  if (!approvedActor) throw new Error("lead_triage_approved_actor_required");
  if (!Number.isFinite(Date.parse(nowIso))) throw new Error("lead_triage_server_time_invalid");
  return {
    triage_status: "Triaged",
    triaged_by: approvedActor,
    triaged_at: nowIso,
    triage_summary: summary,
  };
}

/**
 * A brokered local triage may start only from the explicit operational state.
 * Do not normalize missing/legacy values here: `Unknown` is a data-quality
 * state and must never be converted into a human-triage approval.
 */
export function assertLeadTriagePreparable(envelope, leadEnvelopeId) {
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    envelope.name !== leadEnvelopeId ||
    envelope.triage_status !== "Untriaged"
  ) {
    throw new Error("lead_triage_not_preparable");
  }
}

export function proposalPackIdForCustomerQuote(customerQuoteId) {
  if (!customerQuoteId) throw new Error("customer_quote_id_required");
  return `proposal:${customerQuoteId}`;
}

export function materialTakeoffIdForRoofJob(roofJobId) {
  return `takeoff:${roofJobId}`;
}

export function supplierOrderIdForTakeoff(takeoffId) {
  return `supplier:${takeoffId}`;
}

export function buildMaterialTakeoffDraft({
  roofJobId,
  takeoffId = materialTakeoffIdForRoofJob(roofJobId),
  tenantId,
  materialSystem,
  roofJob = {},
  measurementReport = {},
  takeoffPolicy,
  policyEvidence,
  nowIso,
  policyAuthority = "current_approved",
} = {}) {
  if (!roofJobId) throw new Error("roof_job_id_required");
  if (!tenantId) throw new Error("material_takeoff_tenant_required");
  if (!materialSystem) throw new Error("material_takeoff_material_system_required");
  if (!takeoffPolicy) throw new Error("material_takeoff_policy_required");
  if ((roofJob.name ?? roofJob.roof_job_id) !== roofJobId) throw new Error("material_takeoff_roof_job_mismatch");
  if (measurementReport.roof_job !== roofJobId) throw new Error("material_takeoff_measurement_roof_job_mismatch");

  const graph = parseGovernedRoofGraph(measurementReport);
  const { options, policyBinding, policyDigest } = parseApprovedTakeoffPolicy({
    takeoffPolicy,
    policyEvidence,
    tenantId,
    materialSystem,
    roofJob,
    nowIso,
    policyAuthority,
  });
  const computed = takeoffFromGeometryWithPolicy({
    points: graph.points,
    lines: graph.edges,
    facets: graph.facets,
    checks: graph.checks,
    needsReview: graph.needs_review,
    measurements: graph.measurements,
    sourceRefs: graph.source_refs,
  }, options);
  const measurementReportId = measurementReport.measurement_id ?? measurementReport.name ?? "";
  if (!measurementReportId) throw new Error("measurement_report_required");
  const optionsDigest = digest(options);
  const reviewReasons = materialTakeoffReviewReasons(graph, computed);
  const baseRows = materialTakeoffRows(computed, options, {
    geometryRevision: graph.revision,
    policyDigest,
    optionsDigest,
    needsReview: reviewReasons.length > 0,
  });
  const calculationEnvelope = {
    schema_version: GOVERNED_TAKEOFF_CALCULATION_VERSION,
    source: {
      measurement_report: measurementReportId,
      roof_job: roofJobId,
      geometry_schema_version: graph.schema_version,
      geometry_revision: graph.revision,
      raw_key: graph.source.raw_key,
      raw_sha256: graph.source.raw_sha256,
      provider: graph.source.provider,
    },
    policy: policyBinding,
    options,
    options_digest: optionsDigest,
    result: computed,
    rows: baseRows,
    review_reasons: reviewReasons,
  };
  const calculationDigest = digest(calculationEnvelope);
  const source = {
    roof_job: roofJobId,
    measurement_report: measurementReportId,
    provider: graph.source.provider,
    review_status: measurementReport.review_status ?? "",
    raw_key: graph.source.raw_key,
    raw_sha256: graph.source.raw_sha256,
    geometry_revision: graph.revision,
    geometry_measurements: graph.measurements,
    provider_measurements: measurementRowsFromReport(measurementReport),
  };

  return {
    takeoff_id: takeoffId,
    roof_job: roofJobId,
    measurement_report: measurementReportId,
    status: "Needs Review",
    ...(nowIso ? { prepared_at: nowIso } : {}),
    tenant: tenantId,
    material_system: materialSystem,
    calculation_schema: GOVERNED_TAKEOFF_CALCULATION_VERSION,
    calculation_version: GOVERNED_TAKEOFF_CALCULATION_VERSION,
    geometry_revision: graph.revision,
    source_raw_key: graph.source.raw_key,
    source_raw_sha256: graph.source.raw_sha256,
    takeoff_policy: takeoffPolicy.policy_id ?? takeoffPolicy.name,
    policy_version: Number(takeoffPolicy.policy_version),
    policy_source_evidence: policyBinding.source_evidence,
    policy_source_sha256: policyBinding.source_evidence_sha256,
    policy_digest: policyDigest,
    options_digest: optionsDigest,
    calculation_digest: calculationDigest,
    stock_mode: computed.panelNest.mode,
    waste_basis: computed.sourceRefs.panel_stock_ft,
    options_json: JSON.stringify(options, null, 2),
    calculation_json: JSON.stringify(calculationEnvelope, null, 2),
    review_reasons_json: JSON.stringify(reviewReasons),
    source_measurements_json: JSON.stringify(source, null, 2),
    assumptions: [
      `Draft quantities are computed by ${GOVERNED_TAKEOFF_CALCULATION_VERSION} from canonical roof geometry under an approved Material Takeoff Policy.`,
      "Source-declared/provider measurement values are retained as comparison evidence only and do not drive material quantities.",
      "Supplier availability, substitutions, packaging, field conditions, and any review reason require estimator resolution before approval.",
    ].join("\n"),
    exclusions: [
      "This takeoff does not create a final quote, supplier order, purchase order, delivery request, or invoice.",
      "No material quantity is approved until the estimator marks the takeoff approved.",
    ].join("\n"),
    items: baseRows.map((row) => ({ ...row, calculation_digest: calculationDigest })),
  };
}

export function assertMaterialTakeoffReplaySafe(existing, draft) {
  if (!existing) return;
  if (!["Draft", "Needs Review"].includes(existing.status)) {
    throw new Error("material_takeoff_existing_state_not_writable");
  }
  const required = [
    "tenant",
    "material_system",
    "measurement_report",
    "geometry_revision",
    "source_raw_sha256",
    "takeoff_policy",
    "policy_digest",
    "options_digest",
    "calculation_digest",
  ];
  if (required.some((field) => !existing[field])) {
    throw new Error("material_takeoff_legacy_state_requires_preflight");
  }
  if (required.some((field) => existing[field] !== draft[field])) {
    throw new Error("material_takeoff_existing_binding_mismatch");
  }
}

export function buildSupplierOrderDraft({
  materialTakeoff = {},
  supplierOrderId = supplierOrderIdForTakeoff(materialTakeoff.takeoff_id ?? materialTakeoff.name),
  supplier,
  requestedDeliveryDate,
  nowIso,
} = {}) {
  if (!materialTakeoff.takeoff_id && !materialTakeoff.name) throw new Error("material_takeoff_id_required");
  if (materialTakeoff.status !== "Approved") throw new Error("material_takeoff_approved_required");
  const items = supplierOrderRowsFromTakeoff(materialTakeoff);
  if (!items.length) throw new Error("material_takeoff_items_required");
  const takeoffId = materialTakeoff.takeoff_id ?? materialTakeoff.name;
  const summary = {
    roof_job: materialTakeoff.roof_job ?? "",
    material_takeoff: takeoffId,
    takeoff_status: materialTakeoff.status ?? "",
    generated_at: nowIso,
    item_count: items.length,
    items,
  };

  return {
    supplier_order_id: supplierOrderId,
    roof_job: materialTakeoff.roof_job,
    material_takeoff: takeoffId,
    ...(supplier ? { supplier } : {}),
    status: "Needs Review",
    ...(nowIso ? { prepared_at: nowIso } : {}),
    ...(requestedDeliveryDate ? { requested_delivery_date: requestedDeliveryDate } : {}),
    order_summary_json: JSON.stringify(summary, null, 2),
    assumptions: [
      "Supplier order draft is copied from an approved Material Takeoff for owner review.",
      "Supplier, delivery date, substitutions, and availability must be confirmed before ordering.",
    ].join("\n"),
    exclusions: [
      "This draft does not place an order, create a purchase order, reserve material, or contact a supplier.",
      "Receiving, shortages, substitutions, and invoice/payment status require separate approved updates.",
    ].join("\n"),
    delivery_notes: "",
    items: items.map(supplierOrderItemForTakeoffItem),
  };
}

const SUPPLIER_ORDER_TRANSITION_GRAPH = Object.freeze({
  Approved: ["Ordered", "Cancelled"],
  Ordered: ["Ordered", "Partially Received", "Received", "Shortage", "Cancelled"],
  "Partially Received": ["Partially Received", "Received", "Shortage"],
});
const SUPPLIER_ORDER_RECEIPT_STATUSES = new Set([
  "Partially Received",
  "Received",
  "Shortage",
]);

function supplierOrderIdentifier(value, errorCode) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 140) throw new Error(errorCode);
  return normalized;
}

function supplierOrderDecimal(value, errorCode) {
  if (typeof value === "boolean" || value === null || value === undefined) {
    throw new Error(errorCode);
  }
  const raw = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) throw new Error(errorCode);
  const [rawWhole, rawFraction = ""] = raw.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  const fraction = rawFraction.replace(/0+$/, "");
  return {
    significand: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
    text: fraction ? `${whole}.${fraction}` : whole,
  };
}

function supplierOrderDecimalAtScale(value, scale) {
  return value.significand * (10n ** BigInt(scale - value.scale));
}

function supplierOrderDecimalCompare(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return supplierOrderDecimalAtScale(left, scale) - supplierOrderDecimalAtScale(right, scale);
}

function supplierOrderDecimalAdd(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const significand = supplierOrderDecimalAtScale(left, scale) + supplierOrderDecimalAtScale(right, scale);
  const digits = significand.toString();
  const text = scale === 0
    ? digits
    : digits.length <= scale
      ? `0.${"0".repeat(scale - digits.length)}${digits}`
      : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const normalized = scale === 0 ? text : text.replace(/0+$/, "").replace(/\.$/, "");
  return supplierOrderDecimal(normalized, "supplier_order_quantity_invalid");
}

function supplierOrderReceiptEvidenceIds(before) {
  const raw = before?.receipt_evidence_json;
  if (!raw) return [];
  let contract;
  try {
    contract = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("supplier_order_receipt_evidence_invalid");
  }
  const ids = contract?.evidence_item_ids;
  if (!contract || Array.isArray(contract) || Object.keys(contract).length !== 1
    || !Array.isArray(ids) || !ids.length) {
    throw new Error("supplier_order_receipt_evidence_invalid");
  }
  const normalized = ids.map((id) => supplierOrderIdentifier(id, "supplier_order_receipt_evidence_invalid"));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("supplier_order_receipt_evidence_invalid");
  }
  return normalized;
}

function supplierOrderReceiptRows(beforeItems, itemReceipts) {
  const items = Array.isArray(beforeItems) ? beforeItems : [];
  if (!items.length || !Array.isArray(itemReceipts) || itemReceipts.length !== items.length) {
    throw new Error("supplier_order_receipt_items_incomplete");
  }
  const rowsByIndex = new Map();
  for (const row of itemReceipts) {
    const index = Number(row?.item_index);
    if (!Number.isInteger(index) || index < 1 || index > items.length || rowsByIndex.has(index)) {
      throw new Error("supplier_order_receipt_item_index_invalid");
    }
    rowsByIndex.set(index, row);
  }

  return items.map((item, offset) => {
    const requested = rowsByIndex.get(offset + 1);
    const ordered = supplierOrderDecimal(item?.quantity, "supplier_order_quantity_invalid");
    if (ordered.significand <= 0n) throw new Error("supplier_order_quantity_invalid");
    const previousReceived = supplierOrderDecimal(item?.received_qty ?? 0, "supplier_order_receipt_quantity_invalid");
    const previousShortage = supplierOrderDecimal(item?.shortage_qty ?? 0, "supplier_order_receipt_quantity_invalid");
    const received = supplierOrderDecimal(requested.received_qty, "supplier_order_receipt_quantity_invalid");
    const shortage = supplierOrderDecimal(requested.shortage_qty, "supplier_order_receipt_quantity_invalid");
    if (supplierOrderDecimalCompare(received, previousReceived) < 0n
      || supplierOrderDecimalCompare(shortage, previousShortage) < 0n) {
      throw new Error("supplier_order_receipt_not_monotonic");
    }
    if (supplierOrderDecimalCompare(supplierOrderDecimalAdd(received, shortage), ordered) > 0n) {
      throw new Error("supplier_order_quantity_overage");
    }
    return {
      ...item,
      received_qty: received.text,
      shortage_qty: shortage.text,
      status: shortage.significand > 0n
        ? "Shortage"
        : supplierOrderDecimalCompare(received, ordered) === 0n
          ? "Received"
          : "Ordered",
    };
  });
}

function assertSupplierOrderReceiptStatus(items, nextStatus) {
  let totalReceived = supplierOrderDecimal("0", "supplier_order_receipt_quantity_invalid");
  let totalShortage = supplierOrderDecimal("0", "supplier_order_receipt_quantity_invalid");
  let allAccountedFor = true;
  for (const item of items) {
    const ordered = supplierOrderDecimal(item.quantity, "supplier_order_quantity_invalid");
    const received = supplierOrderDecimal(item.received_qty, "supplier_order_receipt_quantity_invalid");
    const shortage = supplierOrderDecimal(item.shortage_qty, "supplier_order_receipt_quantity_invalid");
    totalReceived = supplierOrderDecimalAdd(totalReceived, received);
    totalShortage = supplierOrderDecimalAdd(totalShortage, shortage);
    allAccountedFor = allAccountedFor
      && supplierOrderDecimalCompare(supplierOrderDecimalAdd(received, shortage), ordered) === 0n;
  }
  if (nextStatus === "Partially Received" && (
    totalReceived.significand <= 0n || allAccountedFor
  )) {
    throw new Error("supplier_order_partial_receipt_invalid");
  }
  if (nextStatus === "Received" && (
    !allAccountedFor || totalShortage.significand !== 0n
  )) {
    throw new Error("supplier_order_received_quantity_mismatch");
  }
  if (nextStatus === "Shortage" && (
    !allAccountedFor || totalShortage.significand <= 0n
  )) {
    throw new Error("supplier_order_shortage_quantity_mismatch");
  }
}

/**
 * Produce the only Supplier Order lifecycle patch this MCP may write.  This
 * command is deliberately internal: Ordered records a locally audited handoff
 * fact, while acknowledgement and receipt facts reference already-verified
 * Evidence Items.  It has no supplier transport, credential, or provider call.
 */
export function buildSupplierOrderTransitionPatch(before = {}, args = {}, nowIso) {
  const current = before?.status;
  const nextStatus = args.next_status;
  if (!SUPPLIER_ORDER_TRANSITION_GRAPH[current]?.includes(nextStatus)) {
    throw new Error(`supplier_order_transition_invalid:${current ?? "missing"}->${nextStatus ?? "missing"}`);
  }
  const transmissionId = args.internal_transmission_id === undefined
    ? ""
    : supplierOrderIdentifier(args.internal_transmission_id, "supplier_order_transmission_id_invalid");
  const acknowledgementId = args.supplier_acknowledgement_id === undefined
    ? ""
    : supplierOrderIdentifier(args.supplier_acknowledgement_id, "supplier_order_acknowledgement_id_invalid");
  const acknowledgementEvidenceId = args.supplier_acknowledgement_evidence_item_id === undefined
    ? ""
    : supplierOrderIdentifier(args.supplier_acknowledgement_evidence_item_id, "supplier_order_acknowledgement_evidence_invalid");
  const hasAcknowledgement = Boolean(acknowledgementId || acknowledgementEvidenceId);
  if (hasAcknowledgement && (!acknowledgementId || !acknowledgementEvidenceId)) {
    throw new Error("supplier_order_acknowledgement_fields_required");
  }
  const hasReceiptInputs = args.receipt_evidence_item_ids !== undefined || args.item_receipts !== undefined;
  const recordedAt = nowIso ?? "Frappe server time at execution";

  if (nextStatus === "Cancelled") {
    if (transmissionId || hasAcknowledgement || hasReceiptInputs) {
      throw new Error("supplier_order_cancelled_transition_has_facts");
    }
    return { patch: { status: "Cancelled" }, idempotent: false, evidenceItemIds: [] };
  }

  if (current === "Approved") {
    if (nextStatus !== "Ordered" || !transmissionId) {
      throw new Error("supplier_order_internal_transmission_required");
    }
    if (hasAcknowledgement || hasReceiptInputs) {
      throw new Error("supplier_order_transmission_must_precede_acknowledgement_and_receipt");
    }
    return {
      patch: {
        status: "Ordered",
        internal_transmission_id: transmissionId,
        internal_transmitted_at: recordedAt,
        items: (Array.isArray(before.items) ? before.items : []).map((item) => ({
          ...item,
          status: "Ordered",
        })),
      },
      idempotent: false,
      evidenceItemIds: [],
    };
  }

  const recordedTransmissionId = supplierOrderIdentifier(
    before.internal_transmission_id,
    "supplier_order_internal_transmission_missing",
  );
  if (!before.internal_transmitted_at) throw new Error("supplier_order_internal_transmission_missing");

  if (nextStatus === "Ordered") {
    if (hasReceiptInputs) throw new Error("supplier_order_receipt_requires_receiving_status");
    if (!transmissionId && !hasAcknowledgement) throw new Error("supplier_order_transition_noop");
    if (transmissionId && transmissionId !== recordedTransmissionId) {
      throw new Error("supplier_order_transmission_conflict");
    }
    if (!hasAcknowledgement) {
      return { patch: {}, idempotent: true, evidenceItemIds: [] };
    }
    const existingAcknowledgementId = before.supplier_acknowledgement_id ?? "";
    const existingAcknowledgementEvidence = before.supplier_acknowledgement_evidence ?? "";
    if (existingAcknowledgementId || existingAcknowledgementEvidence || before.supplier_acknowledged_at) {
      if (existingAcknowledgementId === acknowledgementId
        && existingAcknowledgementEvidence === acknowledgementEvidenceId
        && before.supplier_acknowledged_at) {
        return {
          patch: {},
          idempotent: true,
          evidenceItemIds: [acknowledgementEvidenceId],
        };
      }
      throw new Error("supplier_order_acknowledgement_conflict");
    }
    return {
      patch: {
        supplier_acknowledgement_id: acknowledgementId,
        supplier_acknowledged_at: recordedAt,
        supplier_acknowledgement_evidence: acknowledgementEvidenceId,
      },
      idempotent: false,
      evidenceItemIds: [acknowledgementEvidenceId],
    };
  }

  if (transmissionId || hasAcknowledgement || !hasReceiptInputs
    || !Array.isArray(args.receipt_evidence_item_ids)
    || !Array.isArray(args.item_receipts)) {
    throw new Error("supplier_order_receipt_facts_required");
  }
  const newEvidenceIds = args.receipt_evidence_item_ids.map(
    (id) => supplierOrderIdentifier(id, "supplier_order_receipt_evidence_invalid"),
  );
  if (new Set(newEvidenceIds).size !== newEvidenceIds.length) {
    throw new Error("supplier_order_receipt_evidence_duplicate");
  }
  const existingEvidenceIds = supplierOrderReceiptEvidenceIds(before);
  if (newEvidenceIds.some((id) => existingEvidenceIds.includes(id))) {
    throw new Error("supplier_order_receipt_evidence_duplicate");
  }
  const items = supplierOrderReceiptRows(before.items, args.item_receipts);
  assertSupplierOrderReceiptStatus(items, nextStatus);
  return {
    patch: {
      status: nextStatus,
      ...(before.received_at ? {} : { received_at: recordedAt }),
      receipt_evidence_json: JSON.stringify({
        evidence_item_ids: [...existingEvidenceIds, ...newEvidenceIds],
      }),
      items,
    },
    idempotent: false,
    evidenceItemIds: [...existingEvidenceIds, ...newEvidenceIds],
  };
}

export function buildProposalEvidencePackDraft({
  roofJobId,
  customerQuote,
  measurements = [],
  evidence = [],
  nowIso,
} = {}) {
  if (!roofJobId) throw new Error("roof_job_id_required");
  const quotation = assertProposalQuotePreparable(customerQuote, roofJobId);
  const resolvedPackId = proposalPackIdForCustomerQuote(quotation);
  const measurementReports = measurements
    .filter((row) => row?.review_status === "Approved")
    .map((row) => ({
      measurement_id: row.measurement_id ?? row.name ?? "",
      provider: row.provider ?? "",
      review_status: "Approved",
      approved_at: row.approved_at ?? "",
    }))
    .filter((row) => row.measurement_id && row.provider && row.approved_at);
  if (!measurementReports.length) throw new Error("proposal_measurement_approved_required");

  const withheld = {
    not_customer_safe: 0,
    unverified_or_incomplete: 0,
    identity_missing: 0,
  };
  const eligibleEvidence = [];
  for (const row of evidence) {
    if (!isCheckedTrue(row?.customer_safe)) {
      withheld.not_customer_safe += 1;
      continue;
    }
    const evidenceId = row?.evidence_id ?? row?.name ?? "";
    if (!evidenceId) {
      withheld.identity_missing += 1;
      continue;
    }
    try {
      assertVerifiedEvidence(row, "proposal");
    } catch {
      withheld.unverified_or_incomplete += 1;
      continue;
    }
    eligibleEvidence.push({
      evidence_id: evidenceId,
      evidence_type: row.evidence_type ?? "",
      proof_slot: row.proof_slot ?? "",
    });
  }
  if (!eligibleEvidence.length) throw new Error("proposal_customer_safe_evidence_required");

  const summary = {
    roof_job: roofJobId,
    quotation,
    quote_version: customerQuote.quote_version ?? null,
    generated_at: nowIso,
    counts: {
      measurement_reports: measurementReports.length,
      eligible_evidence: eligibleEvidence.length,
      withheld_evidence: Object.values(withheld).reduce((total, count) => total + count, 0),
    },
    measurement_reports: measurementReports,
    eligible_evidence: eligibleEvidence,
    withheld_evidence: withheld,
  };

  return {
    pack_id: resolvedPackId,
    roof_job: roofJobId,
    quotation,
    status: "Draft",
    ...(nowIso ? { prepared_at: nowIso } : {}),
    evidence_summary_json: JSON.stringify(summary, null, 2),
    assumptions: [
      "Measurement and evidence links are draft inputs for estimator review.",
      "Customer-facing price, scope, options, and payment terms require human approval before send.",
    ].join("\n"),
    exclusions: [
      "This pack does not create a binding quote, accepted scope, material order, or payment request.",
      "Unsafe, missing, or ambiguous evidence must be resolved before proposal approval.",
    ].join("\n"),
  };
}

export function assertProposalQuotePreparable(customerQuote, roofJobId) {
  const quotation = customerQuote?.name ?? customerQuote?.customer_quote_id ?? "";
  if (!quotation) throw new Error("customer_quote_id_required");
  assertLinkedRoofJob(roofJobId, customerQuote, "customer_quote");
  if (!new Set(["Approved", "Accepted"]).has(customerQuote.status)) {
    throw new Error("customer_quote_not_approved");
  }
  if (!str(customerQuote.price_rule_snapshot_json)) {
    throw new Error("customer_quote_price_rule_snapshot_required");
  }
  return quotation;
}

function isCheckedTrue(value) {
  return value === true || value === 1 || value === "1";
}

export function completionPacketIdForRoofJob(roofJobId) {
  return `completion:${roofJobId}`;
}

export function warrantyPacketIdForRoofJob(roofJobId) {
  return `warranty:${roofJobId}`;
}

export function reviewRequestIdForRoofJob(roofJobId) {
  return `review:${roofJobId}`;
}

export function supplierQuoteIdForTakeoff(takeoffId) {
  return `quote:${takeoffId}`;
}

export function marketWatchIdFor(competitor, title) {
  return `watch:${slugify(`${competitor}:${title}`)}`;
}

export function buildCompletionPacketDraft({
  roofJobId,
  packetId = completionPacketIdForRoofJob(roofJobId),
  checkIns = [],
  evidence = [],
  nowIso,
} = {}) {
  if (!roofJobId) throw new Error("roof_job_id_required");
  const photoEvidence = evidence.filter((row) => (row?.evidence_type ?? "") === "Photo");
  if (!photoEvidence.length) throw new Error("completion_photo_evidence_required");
  const openCheckIns = checkIns.filter((row) => (row?.status ?? "") === "Needs Review");
  const summary = {
    roof_job: roofJobId,
    generated_at: nowIso,
    counts: {
      field_check_ins: checkIns.length,
      photo_evidence: photoEvidence.length,
      open_check_ins: openCheckIns.length,
    },
    field_check_ins: checkIns.map((row) => ({
      name: row.name,
      checkin_id: row.checkin_id ?? row.name,
      submitted_at: row.submitted_at ?? "",
      status: row.status ?? "",
      photo_count: row.photo_count ?? 0,
    })),
    photo_evidence: photoEvidence.map((row) => ({
      name: row.name,
      evidence_id: row.evidence_id ?? row.name,
      source_uri: row.source_uri ?? "",
      r2_key: row.r2_key ?? "",
      captured_at: row.captured_at ?? "",
    })),
  };

  return {
    completion_packet_id: packetId,
    roof_job: roofJobId,
    status: "Needs Review",
    ...(nowIso ? { prepared_at: nowIso } : {}),
    photo_evidence_json: JSON.stringify(summary.photo_evidence, null, 2),
    deficiency_list: openCheckIns.length
      ? openCheckIns.map((row) => `Unresolved field check-in: ${row.checkin_id ?? row.name}`).join("\n")
      : "",
    customer_signoff_ref: "",
    warranty_ready: 0,
    evidence_summary_json: JSON.stringify(summary, null, 2),
    assumptions: [
      "Completion evidence is drafted from field check-ins and photo evidence for owner review.",
      "Customer signoff, deficiency resolution, and warranty readiness require human approval.",
    ].join("\n"),
    exclusions: [
      "This packet does not close the job, issue a warranty, send an invoice, or request a review.",
      "Warranty readiness stays false until an owner approves the packet.",
    ].join("\n"),
    notes: "",
  };
}

export function buildWarrantyPacketDraft({
  completionPacket = {},
  packetId,
  materialSystem,
  warrantyTerms,
  coverageStart,
  coverageYears,
  nowIso,
} = {}) {
  const completionId = completionPacket.completion_packet_id ?? completionPacket.name;
  if (!completionId) throw new Error("completion_packet_id_required");
  if (completionPacket.status !== "Approved") throw new Error("completion_packet_approved_required");
  if (!completionPacket.warranty_ready) throw new Error("warranty_readiness_required");
  const roofJobId = completionPacket.roof_job;
  if (!roofJobId) throw new Error("roof_job_id_required");

  return {
    warranty_packet_id: packetId ?? warrantyPacketIdForRoofJob(roofJobId),
    roof_job: roofJobId,
    completion_packet: completionId,
    status: "Needs Review",
    ...(nowIso ? { prepared_at: nowIso } : {}),
    material_system: materialSystem ?? "",
    warranty_terms: warrantyTerms ?? "Warranty terms require owner approval before issue.",
    ...(coverageStart ? { coverage_start: coverageStart } : {}),
    ...(coverageYears !== undefined ? { coverage_years: coverageYears } : {}),
    exclusions: [
      "This draft does not issue a warranty or notify the customer.",
      "Coverage terms, dates, and material system require owner approval.",
    ].join("\n"),
    evidence_summary_json: JSON.stringify({
      completion_packet: completionId,
      roof_job: roofJobId,
      generated_at: nowIso,
      customer_signoff_ref: completionPacket.customer_signoff_ref ?? "",
    }, null, 2),
    notes: "",
  };
}

export function evaluateReviewStopConditions({
  completionPacket,
  paymentMilestones = [],
  consentBasis,
} = {}) {
  const reasons = [];
  if (!completionPacket || completionPacket.status !== "Approved") reasons.push("completion_packet_not_approved");
  if (!paymentMilestones.some((row) => (row?.milestone_type ?? "") === "Payment")) reasons.push("no_payment_evidence");
  if (paymentMilestones.some((row) => (row?.status ?? "") === "Needs Review")) reasons.push("payment_milestone_needs_review");
  if (!str(consentBasis)) reasons.push("no_customer_consent");
  return { eligible: reasons.length === 0, reasons };
}

export function buildReviewRequestDraft({
  roofJobId,
  requestId = reviewRequestIdForRoofJob(roofJobId),
  completionPacket,
  paymentMilestones = [],
  consentBasis,
  channel = "Google",
  reviewLink,
  nowIso,
} = {}) {
  if (!roofJobId) throw new Error("roof_job_id_required");
  const stop = evaluateReviewStopConditions({ completionPacket, paymentMilestones, consentBasis });

  return {
    review_request_id: requestId,
    roof_job: roofJobId,
    completion_packet: completionPacket?.completion_packet_id ?? completionPacket?.name ?? "",
    status: stop.eligible ? "Eligible" : "Blocked",
    channel,
    ...(nowIso ? { prepared_at: nowIso } : {}),
    stop_conditions_json: JSON.stringify({ evaluated_at: nowIso, ...stop }, null, 2),
    eligibility_notes: stop.eligible
      ? "All deterministic stop conditions are clear. Sending still requires human approval."
      : `Blocked by: ${stop.reasons.join(", ")}.`,
    consent_basis: str(consentBasis) ?? "",
    review_link: reviewLink ?? "",
    notes: "",
  };
}

export function buildSupplierQuoteDraft({
  materialTakeoff = {},
  supplierQuoteId = supplierQuoteIdForTakeoff(materialTakeoff.takeoff_id ?? materialTakeoff.name),
  supplier,
  quotedAt,
  validUntil,
  unitPrices = {},
  nowIso,
} = {}) {
  if (!materialTakeoff.takeoff_id && !materialTakeoff.name) throw new Error("material_takeoff_id_required");
  if (materialTakeoff.status !== "Approved") throw new Error("material_takeoff_approved_required");
  if (!str(validUntil)) throw new Error("valid_until_required");
  const rows = supplierOrderRowsFromTakeoff(materialTakeoff);
  if (!rows.length) throw new Error("material_takeoff_items_required");
  const takeoffId = materialTakeoff.takeoff_id ?? materialTakeoff.name;
  const items = rows.map((row) => {
    const unitPrice = Number(unitPrices[row.item_name]);
    const price = Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0;
    return {
      category: row.category,
      item_name: row.item_name,
      quantity: row.quantity,
      unit: row.unit,
      unit_price: price,
      line_total: Math.round(price * row.quantity * 100) / 100,
      substitution: "",
      source_ref: row.source_ref || row.item_name,
      needs_review: 1,
    };
  });
  const quoteTotal = Math.round(items.reduce((sum, row) => sum + row.line_total, 0) * 100) / 100;

  return {
    supplier_quote_id: supplierQuoteId,
    roof_job: materialTakeoff.roof_job,
    material_takeoff: takeoffId,
    ...(supplier ? { supplier } : {}),
    status: "Needs Review",
    ...(quotedAt ? { quoted_at: quotedAt } : {}),
    valid_until: validUntil,
    ...(nowIso ? { prepared_at: nowIso } : {}),
    quote_total: quoteTotal,
    currency: "CAD",
    substitution_notes: "",
    quote_summary_json: JSON.stringify({
      roof_job: materialTakeoff.roof_job ?? "",
      material_takeoff: takeoffId,
      generated_at: nowIso,
      valid_until: validUntil,
      item_count: items.length,
      quote_total: quoteTotal,
      items,
    }, null, 2),
    assumptions: [
      "Quote lines are copied from an approved Material Takeoff; prices default to 0 until entered.",
      "Supplier pricing, availability, substitutions, and validity require human confirmation.",
    ].join("\n"),
    exclusions: [
      "This draft does not place an order, reserve material, or commit a price to the customer.",
      "An expired valid_until date invalidates the quote for production readiness.",
    ].join("\n"),
    items,
  };
}

// A quote revision intentionally creates an empty commercial shell. The next approved
// pricing, tax, scope, payment, and customer-facing proposal must be rebuilt from current
// evidence; none of the superseded quote's commercial facts are carried forward here.
export function customerQuoteRevisionIdForRoofJob(roofJobId, quoteVersion) {
  if (!str(roofJobId)) throw new Error("roof_job_id_required");
  if (!Number.isSafeInteger(quoteVersion) || quoteVersion < 1) {
    throw new Error("customer_quote_version_invalid");
  }
  return `quote-revision:${slugify(`${roofJobId}:v${quoteVersion}`)}`;
}

export function buildCustomerQuoteRevisionDraft({
  sourceQuote = {},
  roofJobId,
  existingQuotes = [],
  correctionReason,
  nowIso,
} = {}) {
  if (!str(roofJobId)) throw new Error("roof_job_id_required");
  const sourceQuoteId = str(sourceQuote.customer_quote_id ?? sourceQuote.name);
  if (!sourceQuoteId) throw new Error("customer_quote_id_required");
  if (sourceQuote.status === "Accepted" || sourceQuote.contract_acceptance || sourceQuote.accepted_at) {
    throw new Error("accepted_quote_revision_requires_change_order");
  }
  if (!str(sourceQuote.roof_job)) throw new Error("customer_quote_roof_job_required");
  if (sourceQuote.roof_job !== roofJobId) throw new Error("customer_quote_roof_job_mismatch");
  const customer = str(sourceQuote.customer);
  if (!customer) throw new Error("customer_quote_customer_required");
  const reason = str(correctionReason);
  if (!reason) throw new Error("correction_reason_required");

  const versions = [sourceQuote, ...(Array.isArray(existingQuotes) ? existingQuotes : [])]
    .map((quote) => Number(quote?.quote_version))
    .filter((version) => Number.isSafeInteger(version) && version >= 1);
  if (!versions.length) throw new Error("customer_quote_version_required");
  const quoteVersion = Math.max(...versions) + 1;
  if (!Number.isSafeInteger(quoteVersion)) throw new Error("customer_quote_version_invalid");
  const customerQuoteId = customerQuoteRevisionIdForRoofJob(roofJobId, quoteVersion);
  if (customerQuoteId === sourceQuoteId) throw new Error("customer_quote_revision_requires_new_id");

  return {
    customer_quote_id: customerQuoteId,
    roof_job: roofJobId,
    customer,
    quote_version: quoteVersion,
    status: "Draft",
    supersedes: sourceQuoteId,
    correction_reason: reason,
    ...(nowIso ? { prepared_at: nowIso } : {}),
  };
}

export function buildQuotePriceRuleSnapshot({
  roofJobId,
  customerQuote = {},
  priceRules = [],
  nowIso,
} = {}) {
  if (!str(roofJobId)) throw new Error("roof_job_id_required");
  const customerQuoteId = str(customerQuote.customer_quote_id ?? customerQuote.name);
  if (!customerQuoteId) throw new Error("customer_quote_id_required");
  if (customerQuote.roof_job !== roofJobId) throw new Error("customer_quote_roof_job_mismatch");
  if (!new Set(["Draft", "Needs Review"]).has(customerQuote.status)) {
    throw new Error("customer_quote_price_rule_bind_state_invalid");
  }
  if (str(customerQuote.price_rule_snapshot_json)) {
    throw new Error("customer_quote_price_rule_snapshot_already_bound");
  }
  const quoteVersion = Number(customerQuote.quote_version);
  if (!Number.isSafeInteger(quoteVersion) || quoteVersion < 1) {
    throw new Error("customer_quote_version_required");
  }
  const priceBookVersion = str(customerQuote.price_book_version);
  if (!priceBookVersion) throw new Error("customer_quote_price_book_version_required");
  const pricingEffectiveAt = str(customerQuote.pricing_effective_at);
  const effectiveDate = priceRuleSnapshotDate(pricingEffectiveAt, "customer_quote_pricing_effective_at_required");
  const capturedAt = str(nowIso);
  if (!capturedAt) throw new Error("price_rule_snapshot_timestamp_required");
  if (!Array.isArray(priceRules) || !priceRules.length || priceRules.length > 50) {
    throw new Error("price_rule_snapshot_rules_required");
  }

  const seen = new Set();
  const rules = priceRules.map((rule) => {
    const priceRuleId = str(rule?.price_rule_id ?? rule?.name);
    if (!priceRuleId || seen.has(priceRuleId)) throw new Error("duplicate_price_rule_id");
    seen.add(priceRuleId);
    if (rule.status !== "Approved") throw new Error("price_rule_not_approved");
    const effectiveFrom = priceRuleSnapshotDate(rule.effective_from, "price_rule_effective_from_required");
    const effectiveTo = str(rule.effective_to);
    if (effectiveDate < effectiveFrom || (effectiveTo && effectiveDate > priceRuleSnapshotDate(effectiveTo, "price_rule_effective_to_invalid"))) {
      throw new Error("price_rule_not_effective_for_quote");
    }
    for (const field of ["rule_name", "rule_type", "unit", "source_ref", "assumptions", "exclusions", "approved_by", "approved_at"]) {
      if (!str(rule[field])) throw new Error(`price_rule_${field}_required`);
    }
    const ruleJson = parsePriceRuleSnapshotJson(rule.rule_json);
    return {
      price_rule_id: priceRuleId,
      ...Object.fromEntries(PRICE_RULE_SNAPSHOT_FIELDS
        .filter((field) => field !== "price_rule_id")
        .map((field) => [field, String(rule[field] ?? "")])),
      rule_json: ruleJson,
    };
  }).sort((left, right) => left.price_rule_id.localeCompare(right.price_rule_id));

  return {
    quote: {
      customer_quote_id: customerQuoteId,
      quote_version: quoteVersion,
      price_book_version: priceBookVersion,
      pricing_effective_at: pricingEffectiveAt,
    },
    captured_at: capturedAt,
    rules,
  };
}

function priceRuleSnapshotDate(value, errorCode) {
  const text = str(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}/.test(text)) throw new Error(errorCode);
  return text.slice(0, 10);
}

function parsePriceRuleSnapshotJson(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch {
    throw new Error("price_rule_json_invalid");
  }
}

export function buildMarketWatchItemDraft({
  watchId,
  competitor,
  title,
  sourceUrl,
  riskLevel = "Medium",
  productGate,
  requiredResponse,
  observedAt,
  nowIso,
} = {}) {
  if (!str(competitor)) throw new Error("competitor_required");
  if (!str(title)) throw new Error("title_required");
  if (!["Low", "Medium", "High"].includes(riskLevel)) throw new Error("risk_level_invalid");

  return {
    watch_id: watchId ?? marketWatchIdFor(competitor, title),
    competitor: competitor.trim(),
    title: title.trim(),
    source_url: sourceUrl ?? "",
    risk_level: riskLevel,
    status: "Open",
    observed_at: observedAt ?? nowIso,
    product_gate: productGate ?? "",
    required_response: requiredResponse ?? "",
    decision_notes: "",
    created_by_ref: "",
  };
}

const IdSchema = z.string().min(1).max(140);

export const LeadTriageInputSchema = z.object({
  lead_envelope_id: IdSchema,
  triage_summary: z.string().trim().min(1).max(2000),
}).strict();
export const ProposalEvidencePackPublicationInputSchema = z.object({
  proposal_evidence_pack_id: IdSchema,
}).strict();
const IsoDateTimeSchema = z.string().datetime({ offset: true });
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const AuthorityRequirementSchema = z.object({
  authority_record_id: IdSchema.optional(),
  subject_type: z.enum(["Person", "Organization"]),
  subject_role: z.enum(["Worker", "Subcontractor"]).optional(),
  subject_ref: IdSchema,
  authority_kind: z.enum([
    "Worker Competency",
    "Trade Licence",
    "WCB Clearance",
    "Insurance Certificate",
    "Permit",
    "Inspection",
    "Manufacturer Certification",
    "Manufacturer Bulletin",
  ]),
  authority_scope: z.string().trim().min(1).max(500).optional(),
  scope_type: z.enum(["Tenant", "Roof Job", "Assignment", "Work Package", "Shop", "Field", "Trade", "Manufacturer System"]),
  scope_ref: IdSchema,
  issuer_name: z.string().trim().min(2).max(200).optional(),
  issuer_jurisdiction: z.string().trim().min(2).max(160).optional(),
  issuer_reference: z.string().trim().min(3).max(240).optional(),
  source_version: z.string().trim().min(1).max(120).optional(),
  version: z.number().int().min(1).max(1000000).optional(),
  state_digest_sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
}).strict();

export const CustomerQuoteRevisionInputSchema = z.object({
  roof_job_id: IdSchema,
  customer_quote_id: IdSchema,
  correction_reason: z.string().trim().min(1).max(2000),
}).strict();

export const QuotePriceRuleSnapshotInputSchema = z.object({
  roof_job_id: IdSchema,
  customer_quote_id: IdSchema,
  price_rule_ids: z.array(IdSchema).min(1).max(50),
}).strict();

export const JobAssignmentInputSchema = z.object({
  assignment_id: IdSchema.optional(),
  roof_job_id: IdSchema,
  assignment_type: z.enum(["Inspection", "Estimate", "Production", "Quality", "Closeout", "Service"]),
  status: z.enum(["Proposed", "Assigned"]).optional(),
  crew_profile_id: IdSchema.optional(),
  assigned_user: IdSchema.optional(),
  scheduled_start: IsoDateTimeSchema.optional(),
  scheduled_end: IsoDateTimeSchema.optional(),
  authority_requirements: z.array(AuthorityRequirementSchema).min(1).max(20).optional(),
  assigned_by: IdSchema,
  supersedes: IdSchema.optional(),
  correction_reason: z.string().min(1).max(2000).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

const WorkPackageCompletionInputSchema = z.object({
  work_package_id: IdSchema,
  // Roof Job is the compatibility adapter. Universal callers identify the
  // immutable parent and physical context directly and must not invent a
  // Roof Job id for Shop/Service/Warehouse/Fleet/Facility work.
  roof_job_id: IdSchema.optional(),
  work_object_type: IdSchema.optional(),
  work_object_id: IdSchema.optional(),
  physical_context_type: IdSchema.optional(),
  physical_context_id: IdSchema.optional(),
  job_assignment_id: IdSchema,
  completion_authority_user: IdSchema,
  device_action_id: IdSchema,
  work_package_version: z.number().int().positive(),
  release_attempt_id: IdSchema,
}).strict();

const ChangeOrderItemInputSchema = z.object({
  item_type: z.enum(["Material", "Labour", "Equipment", "Allowance", "Tax", "Other"]),
  description: z.string().min(1).max(1000),
  quantity: z.number().positive().finite(),
  unit: z.string().min(1).max(40),
  unit_price: z.number().nonnegative().finite(),
  tax_code: z.string().max(80).optional(),
  source_ref: z.string().min(1).max(140),
  customer_visible: z.boolean().optional(),
}).strict();

export const ChangeOrderDraftInputSchema = z.object({
  change_order_id: IdSchema.optional(),
  roof_job_id: IdSchema,
  customer_quote_id: IdSchema.optional(),
  change_number: z.string().min(1).max(80),
  version: z.number().int().min(1).max(100).optional(),
  title: z.string().min(1).max(140),
  reason: z.string().min(1).max(2000),
  scope_delta: z.string().min(1).max(8000),
  currency: z.enum(["CAD", "USD"]).optional(),
  tax_amount: z.number().nonnegative().finite(),
  price_book_version: z.string().min(1).max(120),
  tax_policy_snapshot: z.record(z.unknown()).refine(
    (snapshot) => Object.keys(snapshot).length > 0,
    "tax_policy_snapshot_required",
  ),
  items: z.array(ChangeOrderItemInputSchema).min(1).max(100),
  requested_by: IdSchema,
  supersedes: IdSchema.optional(),
  correction_reason: z.string().min(1).max(2000).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

export const ChangeOrderTransitionInputSchema = z.object({
  change_order_id: IdSchema,
  roof_job_id: IdSchema,
  next_status: z.enum(["Draft", "Needs Review", "Approved", "Presented", "Superseded"]),
  reason: z.string().min(1).max(2000).optional(),
  evidence_item_id: IdSchema.optional(),
}).strict();

const SupplierOrderQuantitySchema = z.string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "supplier_order_quantity_invalid")
  .max(40);
const SupplierOrderReceiptItemInputSchema = z.object({
  item_index: z.number().int().min(1).max(1000),
  received_qty: SupplierOrderQuantitySchema,
  shortage_qty: SupplierOrderQuantitySchema,
}).strict();

export const SupplierOrderTransitionInputSchema = z.object({
  supplier_order_id: IdSchema,
  next_status: z.enum([
    "Ordered",
    "Partially Received",
    "Received",
    "Shortage",
    "Cancelled",
  ]),
  internal_transmission_id: IdSchema.optional(),
  supplier_acknowledgement_id: IdSchema.optional(),
  supplier_acknowledgement_evidence_item_id: IdSchema.optional(),
  receipt_evidence_item_ids: z.array(IdSchema).min(1).max(50).optional(),
  item_receipts: z.array(SupplierOrderReceiptItemInputSchema).min(1).max(1000).optional(),
}).strict();

const InsuranceSupplementEvidenceInputSchema = z.object({
  evidence_item_id: IdSchema,
  evidence_role: z.enum([
    "Carrier Scope",
    "Code/Manufacturer",
    "Photo",
    "Invoice",
    "Submission",
    "Carrier Response",
  ]),
}).strict();

export const InsuranceSupplementDraftInputSchema = z.object({
  insurance_supplement_id: IdSchema,
  roof_job_id: IdSchema,
  customer_quote_id: IdSchema.optional(),
  change_order_id: IdSchema.optional(),
  version: z.number().int().min(1).max(100).optional(),
  carrier_name: z.string().trim().min(1).max(140).optional(),
  claim_reference: z.string().trim().min(1).max(140).optional(),
  policy_reference: z.string().trim().min(1).max(140).optional(),
  date_of_loss: DateSchema.optional(),
  adjuster_reference: z.string().trim().min(1).max(140).optional(),
  supplement_basis: z.string().trim().min(1).max(8000).optional(),
  measurement_report_id: IdSchema.optional(),
  invoice_required: z.boolean().optional(),
  invoice_exception_reason: z.string().trim().min(1).max(2000).optional(),
  evidence: z.array(InsuranceSupplementEvidenceInputSchema).max(50).optional(),
  supersedes: IdSchema.optional(),
  correction_reason: z.string().trim().min(1).max(2000).optional(),
  notes: z.string().trim().max(2000).optional(),
}).strict();

export const InsuranceSupplementEvidenceUpdateInputSchema = z.object({
  insurance_supplement_id: IdSchema,
  roof_job_id: IdSchema,
  measurement_report_id: IdSchema.optional(),
  evidence: z.array(InsuranceSupplementEvidenceInputSchema).max(50),
}).strict();

export const InsuranceSupplementTransitionInputSchema = z.object({
  insurance_supplement_id: IdSchema,
  roof_job_id: IdSchema,
  next_status: z.enum([
    "Draft",
    "Needs Evidence",
    "Ready for Human Review",
    "Approved for Submission",
    "Submitted",
    "Carrier Response Recorded",
    "Closed",
    "Superseded",
  ]),
  reason: z.string().trim().min(1).max(2000).optional(),
  resolution_summary: z.string().trim().min(1).max(2000).optional(),
}).strict();

export const SafetyPlanInputSchema = z.object({
  safety_plan_id: IdSchema.optional(),
  roof_job_id: IdSchema,
  version: z.number().int().min(1).max(100).optional(),
  status: z.enum(["Draft", "Ready"]).optional(),
  effective_date: DateSchema.optional(),
  prepared_by: IdSchema,
  hazard_summary: z.string().min(1).max(8000),
  controls: z.string().min(1).max(8000),
  emergency_plan: z.string().min(1).max(8000),
  ppe_requirements: z.string().min(1).max(8000),
  weather_limits: z.string().min(1).max(8000),
  evidence_item_id: IdSchema.optional(),
  supersedes: IdSchema.optional(),
  correction_reason: z.string().min(1).max(2000).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

export const SafetyAcknowledgementInputSchema = z.object({
  safety_plan_id: IdSchema,
  roof_job_id: IdSchema,
  acknowledged_by: IdSchema,
  acknowledgement_method: z.enum([
    "QR Device Pairing",
    "E-signature",
    "In Person",
  ]),
  device_action_id: z.string().min(8).max(140),
  evidence_item_id: IdSchema,
  role_on_job: z.string().max(140).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

export const JobComplianceRecordInputSchema = z.object({
  compliance_record_id: IdSchema.optional(),
  roof_job_id: IdSchema,
  jurisdiction: z.string().min(1).max(140),
  record_type: z.enum(["Permit", "Licence", "Inspection", "HOA", "Utility", "Other"]),
  authority_name: z.string().min(1).max(140),
  external_reference: z.string().max(140).optional(),
  authority_record_id: IdSchema.optional(),
  status: z.enum(["Required", "Applied", "Approved", "Passed", "Failed", "Expired", "Waived", "Superseded"]),
  required_before_gate: z.enum(["Proposal", "Deposit", "Materials", "Safety", "Access", "Weather", "Crew", "Completion"]),
  applied_at: IsoDateTimeSchema.optional(),
  effective_date: DateSchema.optional(),
  expiry_date: DateSchema.optional(),
  inspected_at: IsoDateTimeSchema.optional(),
  evidence_item_id: IdSchema.optional(),
  owner_user: IdSchema,
  due_date: DateSchema.optional(),
  waiver_reason: z.string().min(1).max(2000).optional(),
  supersedes: IdSchema.optional(),
  correction_reason: z.string().min(1).max(2000).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

const IssuerReceiptInputSchema = z.object({
  receipt_id: IdSchema,
  tenant: IdSchema,
  authority_record_id: IdSchema,
  authority_version: z.number().int().min(1).max(1000000),
  issuer_name: z.string().trim().min(2).max(200),
  issuer_jurisdiction: z.string().trim().min(2).max(160),
  issuer_reference: z.string().trim().min(3).max(240),
  issuer_source_version: z.string().trim().min(1).max(120),
  verification_state: z.enum(["verified", "revoked", "contradictory", "unavailable"]),
  evidence_refs_json: z.string().min(2).max(20000),
  evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  state_digest_sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  issuer_key_id: IdSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{40,}$/),
}).strict();

export const AuthorityRecordInputSchema = z.object({
  authority_record_id: IdSchema,
  new_authority_record_id: IdSchema.optional(),
  authority_operation: z.enum(["record", "verify", "renew", "supersede", "revoke", "resolve_exception"]),
  subject_type: z.enum(["Person", "Organization"]).optional(),
  subject_role: z.enum(["Worker", "Subcontractor"]).optional(),
  person_user: IdSchema.optional(),
  organization: IdSchema.optional(),
  authority_kind: z.enum([
    "Worker Competency",
    "Trade Licence",
    "WCB Clearance",
    "Insurance Certificate",
    "Permit",
    "Inspection",
    "Manufacturer Certification",
    "Manufacturer Bulletin",
  ]).optional(),
  authority_scope: z.string().trim().min(1).max(500).optional(),
  scope_type: z.enum(["Tenant", "Roof Job", "Assignment", "Work Package", "Shop", "Field", "Trade", "Manufacturer System"]).optional(),
  scope_ref: IdSchema.optional(),
  roof_job_id: IdSchema.optional(),
  scope_json: z.record(z.string(), z.unknown()).optional(),
  issuer_name: z.string().trim().min(2).max(200).optional(),
  issuer_jurisdiction: z.string().trim().min(2).max(160).optional(),
  issuer_reference: z.string().trim().min(3).max(240).optional(),
  source_version: z.string().trim().min(1).max(120).optional(),
  evidence_refs: z.array(z.object({
    ref: z.string().trim().min(1).max(512),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  }).strict()).min(1).max(50).optional(),
  evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  effective_from: DateSchema.optional(),
  expires_at: DateSchema.optional(),
  version: z.number().int().min(1).max(1000000).optional(),
  verification_method: z.enum([
    "Internal Competency Assessment",
    "Issuer Portal Readback",
    "Signed Issuer Record",
    "Regulator Readback",
    "Manufacturer Portal Readback",
  ]).optional(),
  verification_reference: IdSchema.optional(),
  revoked_at: IsoDateTimeSchema.optional(),
  revocation_reference: IdSchema.optional(),
  exception_status: z.enum(["None", "Open", "Resolved", "Rejected"]).optional(),
  exception_reason: z.string().trim().min(1).max(2000).optional(),
  correction_reason: z.string().trim().min(1).max(2000).optional(),
  notes: z.string().max(2000).optional(),
  issuer_receipt: IssuerReceiptInputSchema.optional(),
}).strict();

export const CustomerDecisionInputSchema = z.object({
  decision_id: IdSchema.optional(),
  roof_job_id: IdSchema,
  customer_id: IdSchema,
  decision_type: z.enum(["Option Selection", "Scope Approval", "Change Order", "Material Selection", "Schedule", "Other"]),
  decision_value: z.string().min(1).max(140),
  decision_summary: z.string().min(1).max(2000),
  source_channel: z.string().min(1).max(140),
  decided_at: IsoDateTimeSchema,
  captured_by: IdSchema,
  evidence_item_id: IdSchema,
  option_package_id: IdSchema.optional(),
  change_order_id: IdSchema.optional(),
  supersedes: IdSchema.optional(),
  correction_reason: z.string().min(1).max(2000).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

const CommunicationConsentBaseShape = {
  consent_id: IdSchema.optional(),
  customer_id: IdSchema.optional(),
  lead_envelope_id: IdSchema.optional(),
  roof_job_id: IdSchema.optional(),
  channel: z.enum(["Email", "SMS", "Phone", "WhatsApp"]),
  purpose: z.enum(["Estimate Follow-up", "Job Updates", "Marketing", "Review Request", "Collections", "Other"]),
  jurisdiction: z.string().min(1).max(140),
  consent_basis: z.enum(["Express", "Written", "Contract", "Existing Business Relationship", "Other"]),
  source_system: z.string().min(1).max(140),
  source_reference: z.string().min(1).max(140),
  captured_by: IdSchema,
  captured_at: IsoDateTimeSchema,
  effective_from: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema.optional(),
  notes: z.string().max(2000).optional(),
};

export const CommunicationConsentInputSchema = z.discriminatedUnion("status", [
  z.object({
    ...CommunicationConsentBaseShape,
    status: z.literal("Granted"),
    proof_evidence_id: IdSchema,
    revoked_at: IsoDateTimeSchema.optional(),
    supersedes: IdSchema.optional(),
    correction_reason: z.string().min(1).max(2000).optional(),
  }).strict(),
  z.object({
    ...CommunicationConsentBaseShape,
    status: z.literal("Revoked"),
    proof_evidence_id: IdSchema.optional(),
    revoked_at: IsoDateTimeSchema,
    supersedes: IdSchema,
    correction_reason: z.string().min(1).max(2000),
  }).strict(),
  z.object({
    ...CommunicationConsentBaseShape,
    status: z.literal("Superseded"),
    proof_evidence_id: IdSchema.optional(),
    revoked_at: IsoDateTimeSchema.optional(),
    supersedes: IdSchema,
    correction_reason: z.string().min(1).max(2000),
  }).strict(),
  z.object({
    ...CommunicationConsentBaseShape,
    status: z.enum(["Denied", "Expired"]),
    proof_evidence_id: IdSchema.optional(),
    revoked_at: IsoDateTimeSchema.optional(),
    supersedes: IdSchema.optional(),
    correction_reason: z.string().min(1).max(2000).optional(),
  }).strict(),
]);

export const ReconciliationResolutionInputSchema = z.object({
  reconciliation_id: IdSchema,
  roof_job_id: IdSchema.optional(),
  next_status: z.enum(["Resolved", "Ignored"]),
  resolution_action: z.string().min(1).max(2000),
  resolution_evidence_id: IdSchema,
  notes: z.string().max(2000).optional(),
}).strict();

export const TenantExportInputSchema = z.object({
  export_run_id: IdSchema,
  tenant_id: IdSchema,
  scope: z.object({
    include: z.array(z.enum([
      "business_records",
      "evidence_manifest",
      "audit_records",
      "configuration",
    ])).min(1).max(4),
    format: z.literal("jsonl").optional(),
    include_binary_evidence: z.boolean().optional(),
  }).strict(),
  supersedes: IdSchema.optional(),
  correction_reason: z.string().min(1).max(2000).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

const ControlledItemCommandInputSchema = z.object({
  controlled_item_id: IdSchema,
}).strict();

const MaterialLotCommandInputSchema = z.object({
  material_lot_id: IdSchema,
}).strict();

const ShopOrderCommandInputSchema = z.object({
  shop_order_id: IdSchema,
}).strict();

const ShopOrderReservationInputSchema = z.object({
  shop_order_id: IdSchema,
  allocations_json: z.string().trim().min(2).max(20_000),
}).strict();

const ShopSetupOperationSchema = z.object({
  sequence: z.number().int().min(1).max(50),
  operation: z.string().trim().min(1).max(140).regex(/^[^\x00\r\n]+$/),
  machine_tooling: z.string().trim().min(1).max(2000).regex(/^[^\x00\r\n]+$/),
  operator: IdSchema.regex(/^[^\x00\r\n]+$/),
}).strict();

const ShopOrderSetupPayloadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("begin_setup"),
    operations: z.array(ShopSetupOperationSchema).min(1).max(50),
  }).strict(),
  z.object({
    action: z.literal("place_quality_hold"),
    reason: z.string().trim().min(1).max(2000).regex(/^[^\x00\r\n]+$/),
  }).strict(),
  z.object({
    action: z.literal("resume_setup"),
    operations: z.array(ShopSetupOperationSchema).min(1).max(50).optional(),
  }).strict(),
]);

const ShopOrderSetupInputSchema = z.object({
  shop_order_id: IdSchema,
  setup_payload_json: z.string().trim().min(2).max(20_000),
}).strict();

const ShopSnapshotHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const ControlledItemApprovalInputSchema = ControlledItemCommandInputSchema.extend({
  expected_snapshot_sha256: ShopSnapshotHashSchema,
}).strict();

const MaterialLotReceiptInputSchema = MaterialLotCommandInputSchema.extend({
  expected_snapshot_sha256: ShopSnapshotHashSchema,
}).strict();

const ShopOrderReleaseInputSchema = ShopOrderCommandInputSchema.extend({
  expected_snapshot_sha256: ShopSnapshotHashSchema,
}).strict();

const ShopOrderReservationWriteInputSchema = ShopOrderReservationInputSchema.extend({
  expected_snapshot_sha256: ShopSnapshotHashSchema,
}).strict();

const ShopOrderSetupWriteInputSchema = ShopOrderSetupInputSchema.extend({
  expected_snapshot_sha256: ShopSnapshotHashSchema,
}).strict();

const ShopCanonicalDecimalSchema = z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/);
const ShopFirstPieceMeasurementUnitSchema = z.string()
  .trim()
  .min(1)
  .max(140)
  .regex(/^[^\x00\r\n]+$/);

const ShopFirstPieceInspectionSchema = z.object({
  line_no: z.number().int().min(1).max(10_000),
  allocation_id: IdSchema.regex(/^[^\x00\r\n]+$/),
  operation_sequence: z.number().int().min(1).max(50),
  issued_quantity: ShopCanonicalDecimalSchema,
  measured_value: ShopCanonicalDecimalSchema,
  measurement_unit: ShopFirstPieceMeasurementUnitSchema,
  evidence_item: IdSchema.regex(/^[^\x00\r\n]+$/),
}).strict();

const ShopOrderFirstPiecePayloadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("pass_to_fabrication"),
    inspections: z.array(ShopFirstPieceInspectionSchema).min(1).max(200),
  }).strict(),
  z.object({
    action: z.literal("fail_to_quality_hold"),
    inspection: ShopFirstPieceInspectionSchema,
    reason: z.string().trim().min(1).max(4_000).regex(/^[^\x00\r\n]+$/),
  }).strict(),
]);

const ShopOrderFirstPieceInputSchema = z.object({
  shop_order_id: IdSchema,
  first_piece_payload_json: z.string().trim().min(2).max(1_000_000),
}).strict();

const ShopOrderFirstPieceWriteInputSchema = ShopOrderFirstPieceInputSchema.extend({
  expected_snapshot_sha256: ShopSnapshotHashSchema,
}).strict();

const ShopFinalQualityIdentifierSchema = z.string()
  .trim()
  .min(1)
  .max(140)
  .regex(/^[^\x00\r\n]+$/);
const ShopFinalQualityTextSchema = z.string()
  .trim()
  .min(1)
  .max(4_000)
  .regex(/^[^\x00\r\n]+$/);
const ShopFinalQualityOptionalIdentifierSchema = z.string()
  .trim()
  .max(140)
  .regex(/^[^\x00\r\n]*$/);
const ShopFinalQualityOptionalTextSchema = z.string()
  .trim()
  .max(4_000)
  .regex(/^[^\x00\r\n]*$/);

const ShopFinalQualityInspectionSchema = z.object({
  line_no: z.number().int().min(1).max(10_000),
  allocation_id: ShopFinalQualityIdentifierSchema,
  operation_sequence: z.number().int().min(1).max(50),
  measured_value: ShopCanonicalDecimalSchema,
  measurement_unit: ShopFirstPieceMeasurementUnitSchema,
  evidence_item: ShopFinalQualityIdentifierSchema,
}).strict();

const ShopFinalQualityYieldSchema = z.object({
  allocation_id: ShopFinalQualityIdentifierSchema,
  operation_sequence: z.number().int().min(1).max(50),
  input_quantity: ShopCanonicalDecimalSchema,
  finished_quantity: ShopCanonicalDecimalSchema,
  remnant_quantity: ShopCanonicalDecimalSchema,
  scrap_quantity: ShopCanonicalDecimalSchema,
  scrap_disposition: ShopFinalQualityOptionalTextSchema,
  evidence_item: ShopFinalQualityOptionalIdentifierSchema,
}).strict();

const ShopFinalQualityBundleSchema = z.object({
  bundle_id: ShopFinalQualityIdentifierSchema,
  line_no: z.number().int().min(1).max(10_000),
  material_lot: ShopFinalQualityIdentifierSchema,
  piece_identity: ShopFinalQualityIdentifierSchema,
  accepted_quantity: ShopCanonicalDecimalSchema,
  unit: ShopFinalQualityIdentifierSchema,
  label_text: ShopFinalQualityTextSchema,
  condition: ShopFinalQualityTextSchema,
}).strict();

const ShopOrderFinalQualityPayloadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("pass_to_ready"),
    inspections: z.array(ShopFinalQualityInspectionSchema).min(1).max(200),
    yields: z.array(ShopFinalQualityYieldSchema).min(1).max(200),
    bundles: z.array(ShopFinalQualityBundleSchema).min(1).max(200),
  }).strict(),
  z.object({
    action: z.literal("fail_to_quality_hold"),
    inspection: ShopFinalQualityInspectionSchema,
    reason: ShopFinalQualityTextSchema,
  }).strict(),
]);

const ShopOrderFinalQualityInputSchema = z.object({
  shop_order_id: IdSchema,
  final_quality_payload_json: z.string().trim().min(2).max(1_000_000),
}).strict();

const ShopOrderFinalQualityWriteInputSchema = ShopOrderFinalQualityInputSchema.extend({
  expected_snapshot_sha256: ShopSnapshotHashSchema,
}).strict();

const ShopOrderHandoverPayloadSchema = z.object({
  handed_over_to: ShopFinalQualityTextSchema,
  handoff_evidence: ShopFinalQualityIdentifierSchema,
}).strict();

const ShopOrderHandoverInputSchema = z.object({
  shop_order_id: IdSchema,
  handover_payload_json: z.string().trim().min(2).max(20_000),
}).strict();

const ShopOrderHandoverWriteInputSchema = ShopOrderHandoverInputSchema.extend({
  expected_snapshot_sha256: ShopSnapshotHashSchema,
}).strict();

const ShopOrderBillingBasisPayloadSchema = z.object({
  payment_milestone_id: ShopFinalQualityIdentifierSchema,
}).strict();

const ShopOrderBillingBasisInputSchema = z.object({
  shop_order_id: IdSchema,
  billing_basis_payload_json: z.string().trim().min(2).max(20_000),
}).strict();

const ShopOrderBillingBasisWriteInputSchema = ShopOrderBillingBasisInputSchema.extend({
  expected_snapshot_sha256: ShopSnapshotHashSchema,
}).strict();

export function approvedWriteInputSchema(baseSchema) {
  const approvalShape = {
    request_text: z.string().trim().min(1).max(4000),
    approved_by: z.string().min(1).max(140),
    run_id: z.string().min(8).max(128),
    dry_run_receipt: z.string().min(32).max(4096),
    approval_receipt: z.string().min(32).max(8192),
  };
  if (baseSchema instanceof z.ZodDiscriminatedUnion) {
    return z.discriminatedUnion(
      baseSchema.def.discriminator,
      baseSchema.options.map((option) => option.extend(approvalShape).strict()),
    );
  }
  return baseSchema.extend(approvalShape).strict();
}

export function jobAssignmentIdFor({
  roofJobId,
  assignmentType,
  crewProfileId,
  assignedUser,
  scheduledStart,
  supersedes,
}) {
  return `assignment:${slugify([
    roofJobId,
    assignmentType,
    crewProfileId ?? assignedUser,
    scheduledStart ?? "unscheduled",
    supersedes ?? "initial",
  ].join(":"))}`;
}

export function buildJobAssignmentDraft({
  assignmentId,
  roofJobId,
  assignmentType,
  status = "Assigned",
  crewProfileId,
  assignedUser,
  scheduledStart,
  scheduledEnd,
  authorityRequirements,
  assignedBy,
  supersedes,
  correctionReason,
  notes,
  nowIso,
} = {}) {
  if (!roofJobId) throw new Error("roof_job_id_required");
  if (Boolean(crewProfileId) === Boolean(assignedUser)) {
    throw new Error("assignment_requires_exactly_one_target");
  }
  if (scheduledEnd && !scheduledStart) throw new Error("scheduled_end_requires_start");
  if (scheduledStart && scheduledEnd && Date.parse(scheduledEnd) <= Date.parse(scheduledStart)) {
    throw new Error("assignment_schedule_invalid");
  }
  if (authorityRequirements !== undefined && (!Array.isArray(authorityRequirements) || authorityRequirements.length < 1 || authorityRequirements.length > 20)) {
    throw new Error("authority_requirements_invalid");
  }
  if (supersedes && !str(correctionReason)) throw new Error("correction_reason_required");
  return {
    assignment_id: assignmentId ?? jobAssignmentIdFor({
      roofJobId,
      assignmentType,
      crewProfileId,
      assignedUser,
      scheduledStart,
      supersedes,
    }),
    roof_job: roofJobId,
    assignment_type: assignmentType,
    status,
    ...(crewProfileId ? { crew_profile: crewProfileId } : {}),
    ...(assignedUser ? { assigned_user: assignedUser } : {}),
    ...(scheduledStart ? { scheduled_start: scheduledStart } : {}),
    ...(scheduledEnd ? { scheduled_end: scheduledEnd } : {}),
    ...(authorityRequirements ? { authority_requirements_json: JSON.stringify(authorityRequirements) } : {}),
    assigned_by: assignedBy,
    assigned_at: nowIso,
    ...(supersedes ? { supersedes, correction_reason: correctionReason.trim() } : {}),
    notes: notes ?? "",
  };
}

export function buildProductionScheduleGatePreview(draft, gateRows = [], { truncated = false } = {}) {
  const required = draft.assignment_type === "Production" && Boolean(draft.scheduled_start);
  if (!required) {
    return {
      required: false,
      state_eligible: true,
      reason: "production_schedule_gates_not_required",
      authoritative_enforcement: "frappe_document_policy",
    };
  }

  const rowsByGate = new Map();
  for (const row of gateRows) {
    if (!PRODUCTION_SCHEDULING_GATES.includes(row?.gate)) continue;
    const rows = rowsByGate.get(row.gate) ?? [];
    rows.push(row);
    rowsByGate.set(row.gate, rows);
  }
  const gates = PRODUCTION_SCHEDULING_GATES.map((gate) => {
    const rows = rowsByGate.get(gate) ?? [];
    if (rows.length === 0) return { gate, state: null };
    if (rows.length > 1) return { gate, state: null };
    const state = rows[0].state ?? null;
    return { gate, state };
  });
  const missingGates = PRODUCTION_SCHEDULING_GATES.filter(
    (gate) => (rowsByGate.get(gate) ?? []).length === 0,
  );
  const duplicateGates = PRODUCTION_SCHEDULING_GATES.filter(
    (gate) => (rowsByGate.get(gate) ?? []).length > 1,
  );
  const stateIneligibleGates = gates.filter(
    ({ gate, state }) => !missingGates.includes(gate)
      && !duplicateGates.includes(gate)
      && !SCHEDULABLE_PRODUCTION_GATE_STATES.has(state),
  );

  return {
    required: true,
    required_gates: PRODUCTION_SCHEDULING_GATES,
    allowed_states: [...SCHEDULABLE_PRODUCTION_GATE_STATES],
    gates,
    missing_gates: missingGates,
    duplicate_gates: duplicateGates,
    state_ineligible_gates: stateIneligibleGates,
    state_eligible: !truncated
      && missingGates.length === 0
      && duplicateGates.length === 0
      && stateIneligibleGates.length === 0,
    snapshot_truncated: truncated,
    authoritative_enforcement: "frappe_document_policy",
  };
}

export function buildChangeOrderDraft({
  changeOrderId,
  roofJobId,
  customerQuoteId,
  changeNumber,
  version = 1,
  title,
  reason,
  scopeDelta,
  currency = "CAD",
  taxAmount,
  priceBookVersion,
  taxPolicySnapshot,
  items = [],
  requestedBy,
  supersedes,
  correctionReason,
  notes,
  nowIso,
} = {}) {
  if (!roofJobId) throw new Error("roof_job_id_required");
  if (!items.length) throw new Error("change_order_items_required");
  if (!Number.isFinite(taxAmount) || taxAmount < 0) throw new Error("change_order_tax_invalid");
  if (!taxPolicySnapshot || Array.isArray(taxPolicySnapshot)
    || typeof taxPolicySnapshot !== "object" || !Object.keys(taxPolicySnapshot).length) {
    throw new Error("tax_policy_snapshot_required");
  }
  if (supersedes && !str(correctionReason)) throw new Error("correction_reason_required");
  const normalizedItems = items.map((item) => {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0
      || !Number.isFinite(item.unit_price) || item.unit_price < 0) {
      throw new Error("change_order_item_amount_invalid");
    }
    return {
      item_type: item.item_type,
      description: item.description.trim(),
      quantity: item.quantity,
      unit: item.unit.trim(),
      unit_price: item.unit_price,
      line_total: roundMoney(item.quantity * item.unit_price),
      tax_code: item.tax_code ?? "",
      source_ref: item.source_ref.trim(),
      customer_visible: item.customer_visible === false ? 0 : 1,
    };
  });
  const subtotal = roundMoney(normalizedItems.reduce((sum, item) => sum + item.line_total, 0));
  return {
    change_order_id: changeOrderId ?? `change:${slugify(`${roofJobId}:${changeNumber}:v${version}`)}`,
    roof_job: roofJobId,
    ...(customerQuoteId ? { customer_quote: customerQuoteId } : {}),
    change_number: changeNumber,
    version,
    status: "Draft",
    title: title.trim(),
    reason: reason.trim(),
    scope_delta: scopeDelta.trim(),
    currency,
    subtotal,
    tax_amount: roundMoney(taxAmount),
    total_amount: roundMoney(subtotal + taxAmount),
    price_book_version: priceBookVersion,
    tax_policy_snapshot_json: JSON.stringify(taxPolicySnapshot),
    items: normalizedItems,
    requested_by: requestedBy,
    requested_at: nowIso,
    ...(supersedes ? { supersedes, correction_reason: correctionReason.trim() } : {}),
    notes: notes ?? "",
  };
}

export function buildChangeOrderTransitionPatch(
  before = {},
  nextStatus,
  reason,
  approvedBy,
  nowIso,
  evidenceItemId,
) {
  if (["Accepted", "Rejected"].includes(nextStatus)) {
    throw new Error("customer_contract_transition_forbidden");
  }
  const current = before.status;
  const allowed = {
    Draft: ["Needs Review", "Superseded"],
    "Needs Review": ["Draft", "Approved", "Superseded"],
    Approved: ["Presented", "Superseded"],
    Presented: ["Superseded"],
  };
  if (!allowed[current]?.includes(nextStatus)) {
    throw new Error(`change_order_transition_invalid:${current ?? "missing"}->${nextStatus}`);
  }
  if (nextStatus === "Presented" && !evidenceItemId) {
    throw new Error("change_order_presentation_evidence_required");
  }
  if (["Draft", "Superseded"].includes(nextStatus) && !str(reason)) {
    throw new Error("change_order_transition_reason_required");
  }
  const patch = { status: nextStatus };
  if (nextStatus === "Approved") {
    patch.approved_by = approvedBy;
    patch.approved_at = nowIso;
  }
  if (nextStatus === "Draft") {
    patch.approved_by = "";
    patch.approved_at = "";
    patch.correction_reason = reason.trim();
  }
  if (nextStatus === "Superseded") patch.correction_reason = reason.trim();
  return patch;
}

function normalizeInsuranceSupplementEvidence(evidence = []) {
  const seen = new Set();
  return evidence.map(({ evidence_item_id: evidenceItemId, evidence_role: evidenceRole }) => {
    if (seen.has(evidenceItemId)) throw new Error("insurance_supplement_evidence_duplicate");
    seen.add(evidenceItemId);
    return {
      evidence_item: evidenceItemId,
      evidence_role: evidenceRole,
    };
  });
}

export function buildInsuranceSupplementDraft({
  insuranceSupplementId,
  roofJobId,
  customerQuoteId,
  changeOrderId,
  version = 1,
  carrierName,
  claimReference,
  policyReference,
  dateOfLoss,
  adjusterReference,
  supplementBasis,
  measurementReportId,
  invoiceRequired = true,
  invoiceExceptionReason,
  evidence,
  supersedes,
  correctionReason,
  notes,
} = {}) {
  if (!insuranceSupplementId) throw new Error("insurance_supplement_id_required");
  if (!roofJobId) throw new Error("roof_job_id_required");
  if (supersedes && !str(correctionReason)) throw new Error("correction_reason_required");
  return {
    insurance_supplement_id: insuranceSupplementId,
    roof_job: roofJobId,
    ...(customerQuoteId ? { customer_quote: customerQuoteId } : {}),
    ...(changeOrderId ? { change_order: changeOrderId } : {}),
    version,
    status: "Draft",
    ...(carrierName ? { carrier_name: carrierName.trim() } : {}),
    ...(claimReference ? { claim_reference: claimReference.trim() } : {}),
    ...(policyReference ? { policy_reference: policyReference.trim() } : {}),
    ...(dateOfLoss ? { date_of_loss: dateOfLoss } : {}),
    ...(adjusterReference ? { adjuster_reference: adjusterReference.trim() } : {}),
    ...(supplementBasis ? { supplement_basis: supplementBasis.trim() } : {}),
    ...(measurementReportId ? { measurement_report: measurementReportId } : {}),
    invoice_required: invoiceRequired === false ? 0 : 1,
    ...(invoiceExceptionReason
      ? { invoice_exception_reason: invoiceExceptionReason.trim() }
      : {}),
    evidence: normalizeInsuranceSupplementEvidence(evidence),
    ...(supersedes ? { supersedes, correction_reason: correctionReason.trim() } : {}),
    notes: notes ?? "",
  };
}

export function buildInsuranceSupplementEvidencePatch(
  before = {},
  { measurementReportId, evidence } = {},
) {
  if (!["Draft", "Needs Evidence", "Ready for Human Review"].includes(before.status)) {
    throw new Error("insurance_supplement_evidence_locked");
  }
  return {
    ...(measurementReportId ? { measurement_report: measurementReportId } : {}),
    evidence: normalizeInsuranceSupplementEvidence(evidence),
  };
}

export function buildInsuranceSupplementTransitionPatch(
  before = {},
  nextStatus,
  reason,
  approvedBy,
  nowIso,
  evidenceManifest,
  resolutionSummary,
) {
  const current = before.status;
  const allowed = {
    Draft: ["Needs Evidence", "Ready for Human Review", "Superseded"],
    "Needs Evidence": ["Draft", "Ready for Human Review", "Superseded"],
    "Ready for Human Review": ["Needs Evidence", "Approved for Submission", "Superseded"],
    "Approved for Submission": ["Submitted", "Superseded"],
    Submitted: ["Carrier Response Recorded", "Closed", "Superseded"],
    "Carrier Response Recorded": ["Closed", "Superseded"],
    Closed: ["Superseded"],
  };
  if (!allowed[current]?.includes(nextStatus)) {
    throw new Error(
      "insurance_supplement_transition_invalid:" + (current ?? "missing") + "->" + nextStatus,
    );
  }
  if (nextStatus === "Superseded" && !str(reason)) {
    throw new Error("insurance_supplement_transition_reason_required");
  }
  if (nextStatus === "Approved for Submission" && !evidenceManifest) {
    throw new Error("insurance_supplement_evidence_manifest_required");
  }
  if (nextStatus === "Closed" && !str(resolutionSummary)) {
    throw new Error("insurance_supplement_resolution_required");
  }
  const patch = { status: nextStatus };
  if (nextStatus === "Approved for Submission") {
    patch.evidence_manifest_json = JSON.stringify(evidenceManifest);
    if (approvedBy) patch.approved_by = approvedBy;
    if (nowIso) patch.approved_at = nowIso;
  }
  if (nextStatus === "Submitted" && nowIso) patch.submitted_at = nowIso;
  if (nextStatus === "Carrier Response Recorded" && nowIso) patch.carrier_response_at = nowIso;
  if (nextStatus === "Closed") {
    patch.resolution_summary = resolutionSummary.trim();
    if (nowIso) patch.closed_at = nowIso;
  }
  if (nextStatus === "Superseded") patch.correction_reason = reason.trim();
  return patch;
}

export function buildSafetyPlanDraft({
  safetyPlanId,
  roofJobId,
  version = 1,
  status = "Draft",
  effectiveDate,
  preparedBy,
  hazardSummary,
  controls,
  emergencyPlan,
  ppeRequirements,
  weatherLimits,
  evidenceItemId,
  supersedes,
  correctionReason,
  notes,
  nowIso,
} = {}) {
  if (!roofJobId) throw new Error("roof_job_id_required");
  if (status === "Ready" && !effectiveDate) throw new Error("safety_plan_effective_date_required");
  if (status === "Ready" && !evidenceItemId) throw new Error("safety_plan_evidence_required");
  if (supersedes && !str(correctionReason)) throw new Error("correction_reason_required");
  return {
    safety_plan_id: safetyPlanId ?? `safety:${slugify(`${roofJobId}:v${version}`)}`,
    roof_job: roofJobId,
    version,
    status,
    ...(effectiveDate ? { effective_date: effectiveDate } : {}),
    prepared_by: preparedBy,
    prepared_at: nowIso,
    hazard_summary: hazardSummary.trim(),
    controls: controls.trim(),
    emergency_plan: emergencyPlan.trim(),
    ppe_requirements: ppeRequirements.trim(),
    weather_limits: weatherLimits.trim(),
    ...(evidenceItemId ? { evidence_item: evidenceItemId } : {}),
    acknowledgements: [],
    ...(supersedes ? { supersedes, correction_reason: correctionReason.trim() } : {}),
    notes: notes ?? "",
  };
}

export function buildSafetyAcknowledgementPatch({
  safetyPlan = {},
  roofJobId,
  acknowledgedBy,
  acknowledgementMethod,
  deviceActionId,
  evidenceItemId,
  roleOnJob,
  notes,
  nowIso,
} = {}) {
  assertLinkedRoofJob(roofJobId, safetyPlan, "safety_plan");
  if (!evidenceItemId) throw new Error("safety_acknowledgement_evidence_required");
  if (!["QR Device Pairing", "E-signature", "In Person"].includes(acknowledgementMethod)) {
    throw new Error("safety_acknowledgement_method_invalid");
  }
  if (!["Ready", "Acknowledged"].includes(safetyPlan.status)) {
    throw new Error("safety_plan_ready_required");
  }
  const acknowledgements = Array.isArray(safetyPlan.acknowledgements)
    ? safetyPlan.acknowledgements.map((row) => pickAllowedFields(row, SAFETY_ACKNOWLEDGEMENT_FIELDS))
    : [];
  if (typeof deviceActionId !== "string" || deviceActionId.length < 8) {
    throw new Error("safety_acknowledgement_device_action_required");
  }
  if (deviceActionId.length > 140) throw new Error("safety_acknowledgement_device_action_too_long");
  const priorForUser = acknowledgements.find((row) => row.acknowledged_by === acknowledgedBy);
  if (priorForUser) {
    const exactReplay = priorForUser.device_action_id === deviceActionId
      && priorForUser.evidence_item === evidenceItemId
      && priorForUser.acknowledgement_method === acknowledgementMethod;
    if (!exactReplay) throw new Error("safety_acknowledgement_user_conflict");
  } else {
    const priorForDevice = acknowledgements.find((row) => row.device_action_id === deviceActionId);
    if (priorForDevice) throw new Error("safety_acknowledgement_device_conflict");
    acknowledgements.push({
      acknowledged_by: acknowledgedBy,
      acknowledged_at: nowIso,
      acknowledgement_method: acknowledgementMethod,
      ...(deviceActionId ? { device_action_id: deviceActionId } : {}),
      evidence_item: evidenceItemId,
      ...(roleOnJob ? { role_on_job: roleOnJob } : {}),
      notes: notes ?? "",
    });
  }
  return { status: "Acknowledged", acknowledgements };
}

export function buildComplianceRecordDraft({
  complianceRecordId,
  roofJobId,
  jurisdiction,
  recordType,
  authorityName,
  externalReference,
  authorityRecordId,
  status,
  requiredBeforeGate,
  appliedAt,
  effectiveDate,
  expiryDate,
  inspectedAt,
  evidenceItemId,
  ownerUser,
  dueDate,
  waiverReason,
  supersedes,
  correctionReason,
  notes,
  approvedBy,
  nowIso,
} = {}) {
  if (!roofJobId) throw new Error("roof_job_id_required");
  if (status === "Applied" && !appliedAt) throw new Error("compliance_applied_at_required");
  if (["Approved", "Passed", "Failed", "Expired"].includes(status) && !str(externalReference)) {
    throw new Error("compliance_external_reference_required");
  }
  if (["Passed", "Failed"].includes(status) && !inspectedAt) {
    throw new Error("compliance_inspected_at_required");
  }
  if (status === "Waived" && !str(waiverReason)) throw new Error("compliance_waiver_reason_required");
  if (["Approved", "Passed", "Failed", "Expired", "Waived"].includes(status) && !evidenceItemId) {
    throw new Error("compliance_evidence_required");
  }
  if (supersedes && !str(correctionReason)) throw new Error("correction_reason_required");
  return {
    compliance_record_id: complianceRecordId
      ?? `compliance:${slugify(`${roofJobId}:${recordType}:${authorityName}`)}`,
    roof_job: roofJobId,
    jurisdiction: jurisdiction.trim(),
    record_type: recordType,
    authority_name: authorityName.trim(),
    external_reference: externalReference ?? "",
    ...(authorityRecordId ? { authority_record: authorityRecordId } : {}),
    status,
    required_before_gate: requiredBeforeGate,
    ...(appliedAt ? { applied_at: appliedAt } : {}),
    ...(effectiveDate ? { effective_date: effectiveDate } : {}),
    ...(expiryDate ? { expiry_date: expiryDate } : {}),
    ...(inspectedAt ? { inspected_at: inspectedAt } : {}),
    ...(evidenceItemId ? { evidence_item: evidenceItemId } : {}),
    owner_user: ownerUser,
    ...(dueDate ? { due_date: dueDate } : {}),
    ...(status === "Waived" ? {
      waived_by: approvedBy,
      waived_at: nowIso,
      waiver_reason: waiverReason.trim(),
    } : {}),
    ...(supersedes ? { supersedes, correction_reason: correctionReason.trim() } : {}),
    notes: notes ?? "",
  };
}

export function assertComplianceTransition(currentStatus, nextStatus) {
  if (!currentStatus || currentStatus === nextStatus) return;
  const allowed = {
    Required: ["Applied", "Waived", "Superseded"],
    Applied: ["Approved", "Failed", "Expired", "Superseded"],
    Approved: ["Passed", "Failed", "Expired", "Superseded"],
    Passed: ["Expired", "Superseded"],
    Failed: ["Applied", "Superseded"],
    Expired: ["Applied", "Superseded"],
    Waived: ["Superseded"],
    Superseded: [],
  };
  if (!allowed[currentStatus]?.includes(nextStatus)) {
    throw new Error(`compliance_transition_invalid:${currentStatus}->${nextStatus}`);
  }
}

export function buildCustomerDecisionDraft({
  decisionId,
  roofJobId,
  customerId,
  decisionType,
  decisionValue,
  decisionSummary,
  sourceChannel,
  decidedAt,
  capturedBy,
  evidenceItemId,
  optionPackageId,
  changeOrderId,
  supersedes,
  correctionReason,
  notes,
} = {}) {
  if (!roofJobId) throw new Error("roof_job_id_required");
  if (!customerId) throw new Error("customer_id_required");
  if (!evidenceItemId) throw new Error("customer_decision_evidence_required");
  if (decisionType === "Option Selection" && !optionPackageId) {
    throw new Error("option_package_id_required");
  }
  if (decisionType === "Change Order" && !changeOrderId) throw new Error("change_order_id_required");
  if (supersedes && !str(correctionReason)) throw new Error("correction_reason_required");
  return {
    decision_id: decisionId ?? `decision:${slugify(`${roofJobId}:${decisionType}:${decidedAt}`)}`,
    roof_job: roofJobId,
    customer: customerId,
    decision_type: decisionType,
    status: "Recorded",
    decision_value: decisionValue.trim(),
    decision_summary: decisionSummary.trim(),
    source_channel: sourceChannel.trim(),
    decided_at: decidedAt,
    captured_by: capturedBy,
    evidence_item: evidenceItemId,
    ...(optionPackageId ? { option_package: optionPackageId } : {}),
    ...(changeOrderId ? { change_order: changeOrderId } : {}),
    ...(supersedes ? { supersedes, correction_reason: correctionReason.trim() } : {}),
    notes: notes ?? "",
  };
}

export function buildCommunicationConsentDraft({
  consentId,
  customerId,
  leadEnvelopeId,
  roofJobId,
  channel,
  purpose,
  status,
  jurisdiction,
  consentBasis,
  sourceSystem,
  sourceReference,
  capturedBy,
  capturedAt,
  effectiveFrom,
  expiresAt,
  proofEvidenceId,
  revokedAt,
  supersedes,
  correctionReason,
  notes,
} = {}) {
  if (!customerId && !leadEnvelopeId && !roofJobId) throw new Error("consent_subject_required");
  if (status === "Granted" && !proofEvidenceId) throw new Error("consent_proof_required");
  if (status === "Revoked") {
    if (!revokedAt) throw new Error("consent_revoked_at_required");
    if (!supersedes) throw new Error("consent_revocation_supersedes_required");
    if (!str(correctionReason)) throw new Error("correction_reason_required");
  }
  if (status === "Superseded" && !supersedes) {
    throw new Error("consent_superseded_link_required");
  }
  if (supersedes && !str(correctionReason)) throw new Error("correction_reason_required");
  return {
    consent_id: consentId ?? `consent:${slugify(`${customerId ?? leadEnvelopeId ?? roofJobId}:${channel}:${purpose}:${capturedAt}`)}`,
    ...(customerId ? { customer: customerId } : {}),
    ...(leadEnvelopeId ? { lead_envelope: leadEnvelopeId } : {}),
    ...(roofJobId ? { roof_job: roofJobId } : {}),
    channel,
    purpose,
    status,
    jurisdiction: jurisdiction.trim(),
    consent_basis: consentBasis,
    source_system: sourceSystem.trim(),
    source_reference: sourceReference.trim(),
    captured_by: capturedBy,
    captured_at: capturedAt,
    effective_from: effectiveFrom,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(proofEvidenceId ? { proof_evidence: proofEvidenceId } : {}),
    ...(revokedAt ? { revoked_at: revokedAt } : {}),
    ...(supersedes ? { supersedes, correction_reason: correctionReason.trim() } : {}),
    notes: notes ?? "Record-only consent evidence. This record does not send a message.",
  };
}

export function buildReconciliationResolutionPatch(before = {}, {
  nextStatus,
  resolutionAction,
  resolutionEvidenceId,
  resolvedBy,
  notes,
  nowIso,
} = {}) {
  if (!str(resolutionAction)) throw new Error("reconciliation_resolution_action_required");
  if (!resolutionEvidenceId) throw new Error("reconciliation_resolution_evidence_required");
  const allowed = {
    Pending: ["Ignored"],
    Mismatch: ["Resolved", "Ignored"],
  };
  if (!allowed[before.status]?.includes(nextStatus)) {
    throw new Error(`reconciliation_transition_invalid:${before.status ?? "missing"}->${nextStatus}`);
  }
  const attemptCount = Number(before.attempt_count ?? 0);
  if (!Number.isInteger(attemptCount) || attemptCount < 0) {
    throw new Error("reconciliation_attempt_count_invalid");
  }
  return {
    status: nextStatus,
    resolution_action: resolutionAction.trim(),
    resolution_evidence: resolutionEvidenceId,
    resolved_by: resolvedBy,
    resolved_at: nowIso,
    last_attempt_at: nowIso,
    attempt_count: attemptCount + 1,
    notes: notes ?? "Reconciliation record only. No accounting or external-system mutation was performed.",
  };
}

export function buildTenantExportRequestDraft({
  exportRunId,
  tenantId,
  scope,
  requestedBy,
  supersedes,
  correctionReason,
  notes,
  nowIso,
  runId,
} = {}) {
  if (supersedes && !str(correctionReason)) throw new Error("correction_reason_required");
  const allowedIncludes = new Set([
    "business_records",
    "evidence_manifest",
    "audit_records",
    "configuration",
  ]);
  if (!Array.isArray(scope?.include) || !scope.include.length
    || scope.include.some((value) => !allowedIncludes.has(value))) {
    throw new Error("tenant_export_scope_invalid");
  }
  if (scope.format !== undefined && scope.format !== "jsonl") {
    throw new Error("tenant_export_format_invalid");
  }
  const normalizedScope = {
    include: [...new Set(scope.include)].sort(),
    format: scope.format ?? "jsonl",
    include_binary_evidence: scope.include_binary_evidence ?? false,
    excludes: ["credentials", "session_tokens", "encryption_key_material"],
  };
  return {
    export_run_id: exportRunId ?? `export:${slugify(`${tenantId}:${runId}`)}`,
    tenant: tenantId,
    status: "Requested",
    requested_by: requestedBy,
    requested_at: nowIso,
    scope_json: JSON.stringify(normalizedScope),
    ...(supersedes ? { supersedes, correction_reason: correctionReason.trim() } : {}),
    notes: notes ?? "Export request only. A separate audited worker produces and encrypts the archive.",
  };
}

export function assertLinkedRoofJob(expectedRoofJob, record, label = "record") {
  if (!expectedRoofJob) throw new Error("roof_job_id_required");
  if (!record?.roof_job) throw new Error(`${label}_roof_job_missing`);
  if (record.roof_job !== expectedRoofJob) {
    throw new Error(`${label}_roof_job_mismatch:${record.roof_job}:${expectedRoofJob}`);
  }
}

export function assertRoofJobCustomer(roofJob, customerId) {
  if (!roofJob?.customer) throw new Error("roof_job_customer_missing");
  if (roofJob.customer !== customerId) {
    throw new Error(`roof_job_customer_mismatch:${roofJob.customer}:${customerId}`);
  }
}

export function assertConsentLineage(prior, args) {
  const checks = [
    ["customer", args.customer_id],
    ["lead_envelope", args.lead_envelope_id],
    ["roof_job", args.roof_job_id],
    ["channel", args.channel],
    ["purpose", args.purpose],
  ];
  for (const [field, expected] of checks) {
    if (expected && prior?.[field] !== expected) {
      throw new Error(`consent_lineage_mismatch:${field}`);
    }
  }
}

export function assertCorrectionVersion(next, prior, label) {
  const nextVersion = Number(next?.version);
  const priorVersion = Number(prior?.version);
  if (!Number.isInteger(nextVersion) || !Number.isInteger(priorVersion)
    || nextVersion <= priorVersion) {
    throw new Error(`${label}_version_must_increase`);
  }
}

function roundMoney(value) {
  if (!Number.isFinite(value)) throw new Error("money_value_invalid");
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function redactApprovalArgs(args) {
  const safeArgs = approvedArgs(args);
  delete safeArgs.__hermes_actor_user;
  if (Object.hasOwn(safeArgs, "insurance_supplement_id")) {
    const evidence = Array.isArray(safeArgs.evidence) ? safeArgs.evidence : [];
    if (Array.isArray(safeArgs.evidence)) {
      safeArgs.evidence = {
        evidence_count: evidence.length,
        evidence_roles: [...new Set(evidence.map((row) => row?.evidence_role).filter(Boolean))].sort(),
      };
    }
    for (const field of [
      "carrier_name",
      "claim_reference",
      "policy_reference",
      "date_of_loss",
      "adjuster_reference",
      "supplement_basis",
      "measurement_report_id",
      "invoice_exception_reason",
      "notes",
      "reason",
      "resolution_summary",
    ]) delete safeArgs[field];
    safeArgs.request_text = "[restricted insurance supplement approval request]";
    safeArgs.insurance_context = "redacted";
  }
  return safeArgs;
}

function resolveRuntimeConfig(config = {}) {
  const rolePolicy = config.rolePolicy ?? loadRolePolicy(config.rolePolicyPath ?? DEFAULT_ROLE_POLICY_PATH);
  const agentRole = config.agentRole ?? "owner-operator";
  const role = rolePolicy.roles?.[agentRole];
  if (!role) throw new Error("hermes_agent_role_unknown");
  const baseUrl = config.baseUrl
    ? normalizeFrappeBaseUrl(config.baseUrl, config.allowInsecureLocal === true)
    : config.baseUrl;
  const authorityBusBaseUrl = config.authorityBusBaseUrl
    ? normalizeAuthorityBusBaseUrl(config.authorityBusBaseUrl, config.allowInsecureLocal === true)
    : config.authorityBusBaseUrl;
  return {
    ...config,
    baseUrl,
    agentRole,
    agentRoleTitle: config.agentRoleTitle ?? role.title,
    actorUser: config.actorUser ?? "test-owner@example.com",
    approverId: config.approverId ?? "test-owner@example.com",
    allowedTools: config.allowedTools ?? roleTools(role),
    siteId: config.siteId ?? digest({ frappe_base_url: baseUrl ?? "" }),
    authorityBusBaseUrl,
    authorityIssuerPublicKeys: config.authorityIssuerPublicKeys ?? {},
  };
}

function createAuthorizedRegistrar(mcpServer, config) {
  const handlers = new Map();
  const allowedTools = new Set(config.allowedTools);
  const rawRegisterTool = mcpServer.registerTool.bind(mcpServer);

  return {
    registerTool(name, definition, handler) {
      handlers.set(name, handler);
      if (!allowedTools.has(name)) return;
      rawRegisterTool(name, definition, async (args) => {
        await authorizeToolInvocation(config, name, args);
        if (name.startsWith("dry_run_")) {
          return attachDryRunReceipt(config, name, args, await handler(args));
        }
        if (Object.hasOwn(REQUEST_TO_DRY_RUN, name)) {
          await assertApprovedWriteContract(config, name, args, handlers);
        }
        return handler({ ...args, __hermes_actor_user: config.actorUser });
      });
    },
  };
}

async function authorizeToolInvocation(config, toolName, args) {
  assertActorFieldsBound(config, args);
  if (config.agentRole !== "field-companion") return;
  const roofJobId = await roofJobForFieldTool(config, toolName, args);
  if (!roofJobId) throw new Error(`field_assignment_scope_missing_job:${toolName}`);
  await assertActorAssignedToRoofJob(config, roofJobId);
}

function assertActorFieldsBound(config, args = {}) {
  for (const field of ["acknowledged_by", "assigned_by", "captured_by", "prepared_by", "requested_by", "completion_authority_user"]) {
    if (args[field] !== undefined && args[field] !== config.actorUser) {
      throw new Error(`actor_field_mismatch:${field}`);
    }
  }
}

async function roofJobForFieldTool(config, toolName, args = {}) {
  if (args.roof_job_id) return args.roof_job_id;
  if (toolName === "get_roof_job") return args.roof_job_id;
  const reference = FIELD_RECORD_TOOL_REFERENCES[toolName];
  if (!reference) return null;
  const [doctype, idArg] = reference;
  const record = await readResource(config, doctype, args[idArg]);
  return record.roof_job ?? null;
}

async function assertActorAssignedToRoofJob(config, roofJobId) {
  const assignments = await listResources(config, "Job Assignment", {
    fields: ["name", "roof_job", "status", "assigned_user", "crew_profile"],
    filters: [["Job Assignment", "roof_job", "=", roofJobId]],
    limit: 100,
    orderBy: "modified desc",
  });
  const activeAssignments = assignments.filter((assignment) => ["Assigned", "Accepted", "In Progress"].includes(assignment.status));
  for (const assignment of activeAssignments) {
    if (assignment.assigned_user === config.actorUser) return;
    if (!assignment.crew_profile) continue;
    const crew = await readResource(config, "Crew Profile", assignment.crew_profile);
    const member = Array.isArray(crew.members)
      && crew.members.some((row) => row.crew_user === config.actorUser && Number(row.active) === 1);
    if (crew.status === "Active" && (crew.primary_lead === config.actorUser || member)) return;
  }
  throw new Error(`field_assignment_required:${roofJobId}`);
}

function dryRunArgs(args = {}) {
  const previewArgs = approvedArgs(args);
  delete previewArgs.request_text;
  delete previewArgs.approved_by;
  delete previewArgs.run_id;
  delete previewArgs.expected_snapshot_sha256;
  return previewArgs;
}

function attachDryRunReceipt(config, dryRunTool, args, result) {
  if (!config.dryRunSigningKey) return result;
  const writeTool = Object.entries(REQUEST_TO_DRY_RUN)
    .find(([, pairedDryRun]) => pairedDryRun === dryRunTool)?.[0];
  if (!writeTool) return result;
  const payload = parseToolPayload(result);
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const dryRunReceipt = signDryRunReceipt(config.dryRunSigningKey, {
    dry_run_tool: dryRunTool,
    write_tool: writeTool,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    args_digest: digest(dryRunArgs(args)),
    preview_digest: digest(semanticPreview(payload)),
    issued_at: new Date().toISOString(),
    expires_at: expiresAt,
  });
  return text({
    ...payload,
    approval_request: {
      write_tool: writeTool,
      dry_run_tool: dryRunTool,
      agent_role: config.agentRole,
      actor_user: config.actorUser,
      site_id: config.siteId,
      args_digest: digest(dryRunArgs(args)),
      preview_digest: digest(semanticPreview(payload)),
      dry_run_receipt: dryRunReceipt,
      expires_at: expiresAt,
      note: "A separately authenticated human approver must issue the matching approval_receipt for the exact approved-write arguments.",
    },
  });
}

async function assertApprovedWriteContract(config, writeTool, args, handlers) {
  if (!config.writeEnabled) throw new Error("erpnext_write_disabled");
  const dryRunTool = REQUEST_TO_DRY_RUN[writeTool];
  const dryRunHandler = handlers.get(dryRunTool);
  if (!dryRunHandler) throw new Error(`paired_dry_run_not_registered:${dryRunTool}`);
  if (!args.dry_run_receipt) throw new Error("dry_run_receipt_required");
  if (!args.approval_receipt) throw new Error("approval_receipt_required");
  if (args.approved_by !== config.approverId) throw new Error("approval_approver_identity_mismatch");
  const previewArgs = dryRunArgs(args);
  const currentPreview = parseToolPayload(await dryRunHandler(previewArgs));
  verifyDryRunReceipt(config.dryRunSigningKey, args.dry_run_receipt, {
    dry_run_tool: dryRunTool,
    write_tool: writeTool,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    args_digest: digest(previewArgs),
    preview_digest: digest(semanticPreview(currentPreview)),
  });
  verifyApprovalReceipt(config.approvalPublicKey, args.approval_receipt, {
    write_tool: writeTool,
    dry_run_receipt: args.dry_run_receipt,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    run_id: args.run_id,
    approved_by: config.approverId,
    args_digest: digest(approvedArgs(args)),
  });
}

export function buildServer(config) {
  config = resolveRuntimeConfig(config);
  const mcpServer = new McpServer({ name: "erpnext-roofing-mcp", version: "0.2.0" });
  const server = createAuthorizedRegistrar(mcpServer, config);

  server.registerTool(
    "get_roof_job",
    {
      title: "Get Roof Job",
      description: "Read one IronWrap Roof Job by roof_job_id/name. Field sessions receive the assignment-scoped safe projection only.",
      inputSchema: { roof_job_id: z.string().min(1) },
    },
    async ({ roof_job_id }) => {
      const job = await readResource(config, "Roof Job", roof_job_id);
      return text(config.agentRole === "field-companion"
        ? { data: sanitizeResource(job, FIELD_ROOF_JOB_FIELDS) }
        : { data: job });
    },
  );

  server.registerTool(
    "get_lead_envelope",
    {
      title: "Get Lead Envelope",
      description: "Read one IronWrap OS Lead Envelope by envelope_id/name.",
      inputSchema: { envelope_id: z.string().min(1) },
    },
    async ({ envelope_id }) => text(await erpGet(config, resourcePath("Lead Envelope", envelope_id))),
  );

  server.registerTool(
    "list_untriaged_lead_envelopes",
    {
      title: "List Untriaged Lead Envelopes",
      description: "Read bounded Lead Envelope rows whose local operating triage is not yet Triaged. Bus transport status remains read-only context.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
      }).strict(),
    },
    async ({ limit = 25 }) => text({
      data: await listResources(config, "Lead Envelope", {
        fields: LEAD_TRIAGE_FIELDS,
        filters: [["Lead Envelope", "triage_status", "!=", "Triaged"]],
        limit,
        orderBy: "event_ts desc",
      }),
    }),
  );

  server.registerTool(
    "list_communication_events_for_lead",
    {
      title: "List Communication Events For Lead",
      description: "Read bounded Communication Event history for one exact Lead Envelope. This is history only and never sends a message.",
      inputSchema: z.object({
        lead_envelope_id: IdSchema,
        limit: z.number().int().min(1).max(100).optional(),
      }).strict(),
    },
    async ({ lead_envelope_id, limit = 25 }) => text({
      data: await listResources(config, "Communication Event", {
        fields: COMMUNICATION_EVENT_FIELDS,
        filters: [["Communication Event", "lead_envelope", "=", lead_envelope_id]],
        limit,
        orderBy: "event_ts desc",
      }),
    }),
  );

  server.registerTool(
    "dry_run_mark_lead_triaged",
    {
      title: "Dry Run Mark Lead Triaged",
      description: "Preview one local Lead Envelope triage annotation without changing bus transport status or any Communication Event.",
      inputSchema: LeadTriageInputSchema,
    },
    async ({ lead_envelope_id, triage_summary }) => {
      const before = await readResource(config, "Lead Envelope", lead_envelope_id);
      assertLeadTriagePreparable(before, lead_envelope_id);
      const patch = buildLeadTriagePatch({
        triageSummary: triage_summary,
        triagedBy: config.approverId,
        nowIso: new Date().toISOString(),
      });
      return text({
        would_write: false,
        required_tool: "request_mark_lead_triaged",
        target: { doctype: "Lead Envelope", name: lead_envelope_id },
        before: summarizeLeadTriage(before),
        patch,
        transport_status_unchanged: before.status ?? "",
        communication_events_mutated: false,
      });
    },
  );

  server.registerTool(
    "request_mark_lead_triaged",
    {
      title: "Request Mark Lead Triaged",
      description: "Approved-write: mark one Lead Envelope triaged with an approved local summary and record a Hermes Run audit row. It never changes bus transport status or Communication Events.",
      inputSchema: approvedWriteInputSchema(LeadTriageInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const before = await readResource(config, "Lead Envelope", args.lead_envelope_id);
      assertLeadTriagePreparable(before, args.lead_envelope_id);
      const patch = buildLeadTriagePatch({
        triageSummary: args.triage_summary,
        triagedBy: args.approved_by,
        nowIso: now,
      });
      const dryRun = {
        target: { doctype: "Lead Envelope", name: args.lead_envelope_id },
        before: summarizeLeadTriage(before),
        patch,
        transport_status_unchanged: before.status ?? "",
        communication_events_mutated: false,
      };
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_mark_lead_triaged",
        target: { doctype: "Lead Envelope", name: args.lead_envelope_id },
        leadEnvelope: args.lead_envelope_id,
        dryRun,
        beforeSummary: summarizeLeadTriage(before),
        // The command derives the immutable triaged_at timestamp in Frappe.
        // Record its returned value rather than the preview's local timestamp.
        afterSummary: (result) => summarizeLeadTriageCommandResult(before, result),
        // A generic Lead Envelope PUT cannot transition triage. The narrow
        // Frappe command locks and verifies the already-created Approved Run.
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.lead_triage_api.mark_lead_triaged",
          {
            lead_envelope_id: args.lead_envelope_id,
            hermes_run_id: args.run_id,
          },
        ),
        responseExtra: {
          updated: true,
          lead_envelope_id: args.lead_envelope_id,
          communication_events_mutated: false,
        },
      }));
    },
  );

  server.registerTool(
    "list_job_gates",
    {
      title: "List Job Gates",
      description: "Read production gate states for one Roof Job.",
      inputSchema: { roof_job_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ roof_job_id, limit = 25 }) => text(await erpGet(config, resourceListPath("Production Gate State", {
      fields: GATE_FIELDS,
      filters: [["Production Gate State", "roof_job", "=", roof_job_id]],
      limit,
      orderBy: "modified desc",
    }))),
  );

  server.registerTool(
    "list_blocked_jobs",
    {
      title: "List Blocked Jobs",
      description: "Read blocked Production Gate State rows across Roof Jobs.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit = 25 }) => text(await erpGet(config, resourceListPath("Production Gate State", {
      fields: GATE_FIELDS,
      filters: [["Production Gate State", "state", "=", "Blocked"]],
      limit,
      orderBy: "modified desc",
    }))),
  );

  server.registerTool(
    "get_hermes_run",
    {
      title: "Get Hermes Run",
      description: "Read one Hermes Run audit record by run_id/name.",
      inputSchema: { run_id: z.string().min(1) },
    },
    async ({ run_id }) => text(await erpGet(config, resourcePath("Hermes Run", run_id))),
  );

  server.registerTool(
    "list_hermes_runs_for_job",
    {
      title: "List Hermes Runs For Job",
      description: "Read Hermes Run audit records linked to one Roof Job.",
      inputSchema: { roof_job_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ roof_job_id, limit = 25 }) => text(await erpGet(config, resourceListPath("Hermes Run", {
      fields: HERMES_RUN_FIELDS,
      filters: [["Hermes Run", "roof_job", "=", roof_job_id]],
      limit,
      orderBy: "modified desc",
    }))),
  );

  server.registerTool(
    "get_measurement_report",
    {
      title: "Get Measurement Report",
      description: "Read one IronWrap OS Measurement Report by measurement_id/name.",
      inputSchema: { measurement_id: z.string().min(1) },
    },
    async ({ measurement_id }) => text(await erpGet(config, resourcePath("Measurement Report", measurement_id))),
  );

  server.registerTool(
    "list_measurement_reports_for_job",
    {
      title: "List Measurement Reports For Job",
      description: "Read Measurement Report rows linked to one Roof Job.",
      inputSchema: { roof_job_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ roof_job_id, limit = 25 }) => text(await erpGet(config, resourceListPath("Measurement Report", {
      fields: MEASUREMENT_REPORT_FIELDS,
      filters: [["Measurement Report", "roof_job", "=", roof_job_id]],
      limit,
      orderBy: "modified desc",
    }))),
  );

  server.registerTool(
    "get_material_takeoff",
    {
      title: "Get Material Takeoff",
      description: "Read one IronWrap OS Material Takeoff by takeoff_id/name.",
      inputSchema: { takeoff_id: z.string().min(1) },
    },
    async ({ takeoff_id }) => text(await erpGet(config, resourcePath("Material Takeoff", takeoff_id))),
  );

  server.registerTool(
    "list_material_takeoffs_for_job",
    {
      title: "List Material Takeoffs For Job",
      description: "Read Material Takeoff rows linked to one Roof Job.",
      inputSchema: { roof_job_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ roof_job_id, limit = 25 }) => text(await erpGet(config, resourceListPath("Material Takeoff", {
      fields: MATERIAL_TAKEOFF_FIELDS,
      filters: [["Material Takeoff", "roof_job", "=", roof_job_id]],
      limit,
      orderBy: "modified desc",
    }))),
  );

  server.registerTool(
    "get_supplier_order",
    {
      title: "Get Supplier Order",
      description: "Read one IronWrap OS Supplier Order by supplier_order_id/name.",
      inputSchema: { supplier_order_id: z.string().min(1) },
    },
    async ({ supplier_order_id }) => text(await erpGet(config, resourcePath("Supplier Order", supplier_order_id))),
  );

  server.registerTool(
    "list_supplier_orders_for_job",
    {
      title: "List Supplier Orders For Job",
      description: "Read Supplier Order rows linked to one Roof Job.",
      inputSchema: { roof_job_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ roof_job_id, limit = 25 }) => text(await erpGet(config, resourceListPath("Supplier Order", {
      fields: SUPPLIER_ORDER_FIELDS,
      filters: [["Supplier Order", "roof_job", "=", roof_job_id]],
      limit,
      orderBy: "modified desc",
    }))),
  );

  server.registerTool(
    "get_instant_estimate_session",
    {
      title: "Get Instant Estimate Session",
      description: "Read one IronWrap OS Instant Estimate Session by estimate_session_id/name.",
      inputSchema: { estimate_session_id: z.string().min(1) },
    },
    async ({ estimate_session_id }) => text(await erpGet(config, resourcePath("Instant Estimate Session", estimate_session_id))),
  );

  server.registerTool(
    "list_instant_estimate_sessions_for_job",
    {
      title: "List Instant Estimate Sessions For Job",
      description: "Read Instant Estimate Session rows linked to one Roof Job.",
      inputSchema: { roof_job_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ roof_job_id, limit = 25 }) => text(await erpGet(config, resourceListPath("Instant Estimate Session", {
      fields: INSTANT_ESTIMATE_SESSION_FIELDS,
      filters: [["Instant Estimate Session", "roof_job", "=", roof_job_id]],
      limit,
      orderBy: "modified desc",
    }))),
  );

  server.registerTool(
    "get_evidence_item",
    {
      title: "Get Evidence Item",
      description: "Read one IronWrap OS Evidence Item by evidence_id/name.",
      inputSchema: { evidence_id: z.string().min(1) },
    },
    async ({ evidence_id }) => text(await erpGet(config, resourcePath("Evidence Item", evidence_id))),
  );

  server.registerTool(
    "list_evidence_for_job",
    {
      title: "List Evidence For Job",
      description: "Read Evidence Item rows linked to one Roof Job.",
      inputSchema: { roof_job_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ roof_job_id, limit = 25 }) => text(await erpGet(config, resourceListPath("Evidence Item", {
      fields: EVIDENCE_ITEM_FIELDS,
      filters: [["Evidence Item", "roof_job", "=", roof_job_id]],
      limit,
      orderBy: "modified desc",
    }))),
  );

  server.registerTool(
    "get_field_check_in",
    {
      title: "Get Field Check-in",
      description: "Read one IronWrap OS Field Check-in by checkin_id/name.",
      inputSchema: { checkin_id: z.string().min(1) },
    },
    async ({ checkin_id }) => text(await erpGet(config, resourcePath("Field Check-in", checkin_id))),
  );

  server.registerTool(
    "list_field_check_ins_for_job",
    {
      title: "List Field Check-ins For Job",
      description: "Read Field Check-in rows linked to one Roof Job.",
      inputSchema: { roof_job_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ roof_job_id, limit = 25 }) => text(await erpGet(config, resourceListPath("Field Check-in", {
      fields: FIELD_CHECK_IN_FIELDS,
      filters: [["Field Check-in", "roof_job", "=", roof_job_id]],
      limit,
      orderBy: "submitted_at desc",
    }))),
  );

  server.registerTool(
    "get_proposal_evidence_pack",
    {
      title: "Get Proposal Evidence Pack",
      description: "Read one IronWrap OS Proposal Evidence Pack by pack_id/name.",
      inputSchema: { pack_id: z.string().min(1) },
    },
    async ({ pack_id }) => text(await erpGet(config, resourcePath("Proposal Evidence Pack", pack_id))),
  );

  server.registerTool(
    "list_proposal_evidence_packs_for_job",
    {
      title: "List Proposal Evidence Packs For Job",
      description: "Read Proposal Evidence Pack rows linked to one Roof Job.",
      inputSchema: { roof_job_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ roof_job_id, limit = 25 }) => text(await erpGet(config, resourceListPath("Proposal Evidence Pack", {
      fields: PROPOSAL_EVIDENCE_PACK_FIELDS,
      filters: [["Proposal Evidence Pack", "roof_job", "=", roof_job_id]],
      limit,
      orderBy: "modified desc",
    }))),
  );

  server.registerTool(
    "get_payment_milestone",
    {
      title: "Get Payment Milestone",
      description: "Read one IronWrap OS Payment Milestone by payment_milestone_id/name.",
      inputSchema: { payment_milestone_id: z.string().min(1) },
    },
    async ({ payment_milestone_id }) => text(await erpGet(config, resourcePath("Payment Milestone", payment_milestone_id))),
  );

  server.registerTool(
    "list_payment_milestones_for_job",
    {
      title: "List Payment Milestones For Job",
      description: "Read Payment Milestone rows linked to one Roof Job.",
      inputSchema: { roof_job_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ roof_job_id, limit = 25 }) => text(await erpGet(config, resourceListPath("Payment Milestone", {
      fields: PAYMENT_MILESTONE_FIELDS,
      filters: [["Payment Milestone", "roof_job", "=", roof_job_id]],
      limit,
      orderBy: "event_ts desc",
    }))),
  );

  server.registerTool(
    "dry_run_material_takeoff",
    {
      title: "Dry Run Material Takeoff",
      description: "Preview a governed geometry-derived Material Takeoff under an approved tenant policy without writing.",
      inputSchema: {
        roof_job_id: z.string().min(1),
        material_system: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        measurement_report_id: z.string().min(1).optional(),
        takeoff_policy_id: z.string().min(1).optional(),
        takeoff_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ roof_job_id, material_system, measurement_report_id, takeoff_policy_id, takeoff_id, limit = 25 }) => {
      const plan = await prepareMaterialTakeoffWriteFromErp(config, roof_job_id, {
        materialSystem: material_system,
        measurementReportId: measurement_report_id,
        takeoffPolicyId: takeoff_policy_id,
        takeoffId: takeoff_id,
        limit,
      });
      const { draft, measurementReport } = plan;
      return text({
        would_write: false,
        operation: plan.operation,
        target_mutation: plan.targetMutation,
        required_tool: "request_create_material_takeoff",
        target: { doctype: "Material Takeoff", name: draft.takeoff_id },
        source: {
          measurement_report: measurementReport.measurement_id ?? measurementReport.name,
          geometry_revision: draft.geometry_revision,
          takeoff_policy: draft.takeoff_policy,
          policy_digest: draft.policy_digest,
          item_count: draft.items.length,
        },
        draft,
      });
    },
  );

  server.registerTool(
    "request_create_material_takeoff",
    {
      title: "Request Create Material Takeoff",
      description: "Approved-write: create or replay one governed geometry-derived Material Takeoff and record a Hermes Run audit row.",
      inputSchema: {
        roof_job_id: z.string().min(1),
        material_system: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
        measurement_report_id: z.string().min(1).optional(),
        takeoff_policy_id: z.string().min(1).optional(),
        takeoff_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        run_id: z.string().min(8).max(128),
        dry_run_receipt: z.string().min(32).max(4096),
        approval_receipt: z.string().min(32).max(8192),
      },
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const plan = await prepareMaterialTakeoffWriteFromErp(config, args.roof_job_id, {
        materialSystem: args.material_system,
        measurementReportId: args.measurement_report_id,
        takeoffPolicyId: args.takeoff_policy_id,
        takeoffId: args.takeoff_id,
        limit: args.limit ?? 25,
        nowIso: now,
      });
      const { before, draft, measurementReport, operation } = plan;
      const dryRun = {
        target: { doctype: "Material Takeoff", name: draft.takeoff_id },
        operation,
        target_mutation: plan.targetMutation,
        source: {
          measurement_report: measurementReport.measurement_id ?? measurementReport.name,
          geometry_revision: draft.geometry_revision,
          takeoff_policy: draft.takeoff_policy,
          policy_digest: draft.policy_digest,
          item_count: draft.items.length,
        },
        draft,
      };
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_create_material_takeoff",
        target: { doctype: "Material Takeoff", name: draft.takeoff_id },
        roofJob: args.roof_job_id,
        dryRun,
        beforeSummary: summarizeMaterialTakeoff(before),
        afterSummary: operation === "replay"
          ? summarizeMaterialTakeoff(before)
          : summarizeMaterialTakeoff({ ...draft, name: draft.takeoff_id }),
        targetMutation: plan.targetMutation,
        execute: operation === "replay"
          ? async () => before
          : upsertDraftExecutor(config, "Material Takeoff", draft.takeoff_id, draft, null),
        responseExtra: {
          upserted: operation === "create",
          target_replayed: operation === "replay",
          target_mutated: plan.targetMutation,
          operation,
          material_takeoff_id: draft.takeoff_id,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_update_material_takeoff_status",
    {
      title: "Dry Run Update Material Takeoff Status",
      description: "Preview a Material Takeoff review-status update without writing.",
      inputSchema: {
        takeoff_id: z.string().min(1),
        next_status: MaterialTakeoffStatusSchema,
        reason: z.string().max(2000).optional(),
      },
    },
    async ({ takeoff_id, next_status, reason }) => {
      const before = await readResource(config, "Material Takeoff", takeoff_id);
      const patch = buildMaterialTakeoffStatusPatch(next_status, reason);
      return text({
        would_write: false,
        required_tool: "request_update_material_takeoff_status",
        target: { doctype: "Material Takeoff", name: takeoff_id },
        before: summarizeMaterialTakeoff(before),
        patch,
      });
    },
  );

  server.registerTool(
    "request_update_material_takeoff_status",
    {
      title: "Request Update Material Takeoff Status",
      description: "Approved-write: update one Material Takeoff review status and record a Hermes Run audit row.",
      inputSchema: {
        takeoff_id: z.string().min(1),
        next_status: MaterialTakeoffStatusSchema,
        reason: z.string().max(2000).optional(),
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        run_id: z.string().min(8).max(128),
        dry_run_receipt: z.string().min(32).max(4096),
        approval_receipt: z.string().min(32).max(8192),
      },
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const before = await readResource(config, "Material Takeoff", args.takeoff_id);
      const patch = buildMaterialTakeoffStatusPatch(args.next_status, args.reason, args.approved_by, now);
      const dryRun = {
        target: { doctype: "Material Takeoff", name: args.takeoff_id },
        before: summarizeMaterialTakeoff(before),
        patch,
      };
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_update_material_takeoff_status",
        target: { doctype: "Material Takeoff", name: args.takeoff_id },
        roofJob: before.roof_job,
        dryRun,
        beforeSummary: summarizeMaterialTakeoff(before),
        afterSummary: summarizeMaterialTakeoff({ ...before, ...patch }),
        execute: () => erpPut(config, resourcePath("Material Takeoff", args.takeoff_id), patch),
        responseExtra: { updated: true, material_takeoff_id: args.takeoff_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_supplier_order",
    {
      title: "Dry Run Supplier Order",
      description: "Preview a review-gated Supplier Order draft from an approved Material Takeoff without writing.",
      inputSchema: {
        material_takeoff_id: z.string().min(1),
        supplier_order_id: z.string().min(1).optional(),
        supplier: z.string().min(1).optional(),
        requested_delivery_date: z.string().min(1).optional(),
      },
    },
    async ({ material_takeoff_id, supplier_order_id, supplier, requested_delivery_date }) => {
      const { draft, materialTakeoff } = await buildSupplierOrderDraftFromErp(config, material_takeoff_id, {
        supplierOrderId: supplier_order_id,
        supplier,
        requestedDeliveryDate: requested_delivery_date,
      });
      return text({
        would_write: false,
        required_tool: "request_create_supplier_order",
        target: { doctype: "Supplier Order", name: draft.supplier_order_id },
        source: {
          material_takeoff: materialTakeoff.takeoff_id ?? materialTakeoff.name,
          item_count: draft.items.length,
        },
        draft,
      });
    },
  );

  server.registerTool(
    "request_create_supplier_order",
    {
      title: "Request Create Supplier Order",
      description: "Approved-write: create or update one internal Supplier Order draft and record a Hermes Run audit row.",
      inputSchema: {
        material_takeoff_id: z.string().min(1),
        supplier_order_id: z.string().min(1).optional(),
        supplier: z.string().min(1).optional(),
        requested_delivery_date: z.string().min(1).optional(),
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        run_id: z.string().min(8).max(128),
        dry_run_receipt: z.string().min(32).max(4096),
        approval_receipt: z.string().min(32).max(8192),
      },
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const { draft, materialTakeoff } = await buildSupplierOrderDraftFromErp(config, args.material_takeoff_id, {
        supplierOrderId: args.supplier_order_id,
        supplier: args.supplier,
        requestedDeliveryDate: args.requested_delivery_date,
        nowIso: now,
      });
      const before = await readResourceOrNull(config, "Supplier Order", draft.supplier_order_id);
      const operation = before ? "update" : "create";
      const dryRun = {
        target: { doctype: "Supplier Order", name: draft.supplier_order_id },
        operation,
        source: {
          material_takeoff: materialTakeoff.takeoff_id ?? materialTakeoff.name,
          item_count: draft.items.length,
        },
        draft,
      };
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_create_supplier_order",
        target: { doctype: "Supplier Order", name: draft.supplier_order_id },
        roofJob: draft.roof_job,
        dryRun,
        beforeSummary: summarizeSupplierOrder(before),
        afterSummary: summarizeSupplierOrder({ ...(before ?? {}), ...draft, name: draft.supplier_order_id }),
        execute: upsertDraftExecutor(config, "Supplier Order", draft.supplier_order_id, draft, before),
        responseExtra: { upserted: true, operation, supplier_order_id: draft.supplier_order_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_supplier_order_transition",
    {
      title: "Dry Run Supplier Order Lifecycle Transition",
      description: "Preview a signed internal Supplier Order lifecycle fact. Ordered records internal transmission only; this tool never contacts a supplier.",
      inputSchema: SupplierOrderTransitionInputSchema,
    },
    async (args) => {
      const before = await readResource(config, "Supplier Order", args.supplier_order_id);
      const transition = buildSupplierOrderTransitionPatch(before, args);
      await assertSupplierOrderTransitionEvidence(config, before, transition.evidenceItemIds);
      return text(supplierOrderTransitionPreview(before, args, transition));
    },
  );

  server.registerTool(
    "request_transition_supplier_order",
    {
      title: "Request Supplier Order Lifecycle Transition",
      description: "Approved-write: record a signed internal Supplier Order lifecycle fact and Hermes audit row. It only writes Frappe records and never contacts a supplier.",
      inputSchema: approvedWriteInputSchema(SupplierOrderTransitionInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const before = await readResource(config, "Supplier Order", args.supplier_order_id);
      const transition = buildSupplierOrderTransitionPatch(before, args, now);
      await assertSupplierOrderTransitionEvidence(config, before, transition.evidenceItemIds);
      const dryRun = supplierOrderTransitionPreview(before, args, transition);
      const after = { ...before, ...transition.patch };
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_transition_supplier_order",
        target: { doctype: "Supplier Order", name: args.supplier_order_id },
        roofJob: before.roof_job,
        linkedEvidence: transition.evidenceItemIds[0],
        dryRun,
        beforeSummary: summarizeSupplierOrder(before),
        afterSummary: summarizeSupplierOrder(after),
        execute: () => transition.idempotent
          ? Promise.resolve({ data: summarizeSupplierOrder(before), idempotent: true })
          : erpPut(config, resourcePath("Supplier Order", args.supplier_order_id), transition.patch),
        responseExtra: {
          updated: !transition.idempotent,
          idempotent: transition.idempotent,
          supplier_order_id: args.supplier_order_id,
          external_supplier_contact: false,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_approve_controlled_item",
    {
      title: "Dry Run Approve Controlled Item",
      description: "Preview approval of one Draft Controlled Item without writing.",
      inputSchema: ControlledItemCommandInputSchema,
    },
    async ({ controlled_item_id }) => {
      const item = await readResource(config, "Controlled Item", controlled_item_id);
      assertControlledItemReadyForApproval(item, controlled_item_id);
      return text({
        would_write: false,
        required_tool: "request_approve_controlled_item",
        target: { doctype: "Controlled Item", name: controlled_item_id },
        before: summarizeControlledItem(item),
        expected_snapshot_sha256: digest(controlledItemSnapshot(item)),
        approval: {
          status: "Approved",
          approved_at: "Frappe server time at execution",
        },
      });
    },
  );

  server.registerTool(
    "request_approve_controlled_item",
    {
      title: "Request Approve Controlled Item",
      description: "Approved-write: approve one Draft Controlled Item and record a Hermes Run audit row.",
      inputSchema: approvedWriteInputSchema(ControlledItemApprovalInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const item = await readResource(config, "Controlled Item", args.controlled_item_id);
      assertControlledItemReadyForApproval(item, args.controlled_item_id);
      const dryRun = {
        target: { doctype: "Controlled Item", name: args.controlled_item_id },
        before: summarizeControlledItem(item),
        expected_snapshot_sha256: digest(controlledItemSnapshot(item)),
        approval: {
          status: "Approved",
          approved_by: args.approved_by,
          approved_at: "Frappe server time at execution",
        },
      };
      assertSignedShopSnapshot(args, dryRun);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_approve_controlled_item",
        target: { doctype: "Controlled Item", name: args.controlled_item_id },
        dryRun,
        beforeSummary: summarizeControlledItem(item),
        afterSummary: {
          ...summarizeControlledItem(item),
          status: "Approved",
        },
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.shop_fabrication_api.approve_controlled_item",
          {
            controlled_item_id: args.controlled_item_id,
            hermes_run_id: args.run_id,
          },
        ),
        responseExtra: { approved: true, controlled_item_id: args.controlled_item_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_receive_material_lot",
    {
      title: "Dry Run Receive Material Lot",
      description: "Preview receipt of one Draft Material Lot without writing.",
      inputSchema: MaterialLotCommandInputSchema,
    },
    async ({ material_lot_id }) => text(await buildReceiveMaterialLotPreview(config, material_lot_id)),
  );

  server.registerTool(
    "request_receive_material_lot",
    {
      title: "Request Receive Material Lot",
      description: "Approved-write: receive one Draft Material Lot and record a Hermes Run audit row.",
      inputSchema: approvedWriteInputSchema(MaterialLotReceiptInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const lot = await readResource(config, "Material Lot", args.material_lot_id);
      const dryRun = await buildReceiveMaterialLotPreview(config, args.material_lot_id);
      assertSignedShopSnapshot(args, dryRun);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_receive_material_lot",
        target: { doctype: "Material Lot", name: args.material_lot_id },
        roofJob: lot.roof_job,
        dryRun,
        beforeSummary: summarizeMaterialLot(lot),
        afterSummary: (result) => result?.material_lot ?? {},
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.shop_fabrication_api.receive_material_lot",
          {
            material_lot_id: args.material_lot_id,
            hermes_run_id: args.run_id,
          },
        ),
        responseExtra: { received: true, material_lot_id: args.material_lot_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_release_shop_order",
    {
      title: "Dry Run Release Shop Order",
      description: "Preview release of one Draft Shop Order without writing.",
      inputSchema: ShopOrderCommandInputSchema,
    },
    async ({ shop_order_id }) => text(await buildReleaseShopOrderPreview(config, shop_order_id)),
  );

  server.registerTool(
    "request_release_shop_order",
    {
      title: "Request Release Shop Order",
      description: "Approved-write: release one Draft Shop Order and record a Hermes Run audit row.",
      inputSchema: approvedWriteInputSchema(ShopOrderReleaseInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const order = await readResource(config, "Shop Order", args.shop_order_id);
      const dryRun = await buildReleaseShopOrderPreview(config, args.shop_order_id);
      assertSignedShopSnapshot(args, dryRun);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_release_shop_order",
        target: { doctype: "Shop Order", name: args.shop_order_id },
        roofJob: order.roof_job,
        dryRun,
        beforeSummary: summarizeShopOrder(order),
        afterSummary: (result) => result?.shop_order ?? {},
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.shop_fabrication_api.release_shop_order",
          {
            shop_order_id: args.shop_order_id,
            hermes_run_id: args.run_id,
          },
        ),
        responseExtra: { released: true, shop_order_id: args.shop_order_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_reserve_shop_order_materials",
    {
      title: "Dry Run Reserve Shop Order Materials",
      description: "Preview exact material reservations for one released Shop Order without writing.",
      inputSchema: ShopOrderReservationInputSchema,
    },
    async ({ shop_order_id, allocations_json }) => text(
      await buildReserveShopOrderPreview(config, shop_order_id, allocations_json),
    ),
  );

  server.registerTool(
    "request_reserve_shop_order_materials",
    {
      title: "Request Reserve Shop Order Materials",
      description: "Approved-write: reserve exact Material Lot quantities for one released Shop Order and record a Hermes Run audit row.",
      inputSchema: approvedWriteInputSchema(ShopOrderReservationWriteInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const order = await readResource(config, "Shop Order", args.shop_order_id);
      const dryRun = await buildReserveShopOrderPreview(config, args.shop_order_id, args.allocations_json);
      assertSignedShopSnapshot(args, dryRun);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_reserve_shop_order_materials",
        target: { doctype: "Shop Order", name: args.shop_order_id },
        roofJob: order.roof_job,
        dryRun,
        beforeSummary: summarizeShopOrder(order),
        afterSummary: (result) => ({
          shop_order: result?.shop_order ?? {},
          material_lots: Array.isArray(result?.material_lots) ? result.material_lots : [],
        }),
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.shop_fabrication_api.reserve_shop_order_materials",
          {
            shop_order_id: args.shop_order_id,
            hermes_run_id: args.run_id,
          },
        ),
        responseExtra: { reserved: true, shop_order_id: args.shop_order_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_advance_shop_order_setup",
    {
      title: "Dry Run Advance Shop Order Setup",
      description: "Preview one bounded shop setup or early-quality transition without writing.",
      inputSchema: ShopOrderSetupInputSchema,
    },
    async ({ shop_order_id, setup_payload_json }) => text(
      await buildAdvanceShopOrderSetupPreview(config, shop_order_id, setup_payload_json),
    ),
  );

  server.registerTool(
    "request_advance_shop_order_setup",
    {
      title: "Request Advance Shop Order Setup",
      description: "Approved-write: perform one signed shop setup or early-quality transition and record a Hermes Run audit row.",
      inputSchema: approvedWriteInputSchema(ShopOrderSetupWriteInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const order = await readResource(config, "Shop Order", args.shop_order_id);
      const dryRun = await buildAdvanceShopOrderSetupPreview(
        config,
        args.shop_order_id,
        args.setup_payload_json,
      );
      assertSignedShopSnapshot(args, dryRun);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_advance_shop_order_setup",
        target: { doctype: "Shop Order", name: args.shop_order_id },
        roofJob: order.roof_job,
        dryRun,
        beforeSummary: summarizeShopOrder(order),
        afterSummary: (result) => result?.shop_order ?? {},
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.shop_fabrication_api.advance_shop_order_setup",
          {
            shop_order_id: args.shop_order_id,
            hermes_run_id: args.run_id,
          },
        ),
        responseExtra: {
          advanced: true,
          shop_order_id: args.shop_order_id,
          setup_action: dryRun.setup.action,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_record_first_piece_outcome",
    {
      title: "Dry Run Record First Piece Outcome",
      description: "Preview one signed first-piece inspection outcome without writing.",
      inputSchema: ShopOrderFirstPieceInputSchema,
    },
    async ({ shop_order_id, first_piece_payload_json }) => text(
      await buildRecordFirstPieceOutcomePreview(config, shop_order_id, first_piece_payload_json),
    ),
  );

  server.registerTool(
    "request_record_first_piece_outcome",
    {
      title: "Request Record First Piece Outcome",
      description: "Approved-write: record one signed first-piece outcome and transition the Shop Order to fabrication or Quality Hold.",
      inputSchema: approvedWriteInputSchema(ShopOrderFirstPieceWriteInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const order = await readResource(config, "Shop Order", args.shop_order_id);
      const dryRun = await buildRecordFirstPieceOutcomePreview(
        config,
        args.shop_order_id,
        args.first_piece_payload_json,
      );
      assertSignedShopSnapshot(args, dryRun);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_record_first_piece_outcome",
        target: { doctype: "Shop Order", name: args.shop_order_id },
        roofJob: order.roof_job,
        dryRun,
        beforeSummary: summarizeShopOrder(order),
        afterSummary: (result) => {
          const outcome = result?.message ?? result ?? {};
          return {
            shop_order: outcome.shop_order ?? {},
            ...(outcome.material_lot ? { material_lot: outcome.material_lot } : {}),
            ...(outcome.nonconformance ? { nonconformance: outcome.nonconformance } : {}),
          };
        },
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.shop_fabrication_api.record_first_piece_outcome",
          {
            shop_order_id: args.shop_order_id,
            hermes_run_id: args.run_id,
          },
        ),
        responseExtra: {
          first_piece_recorded: true,
          shop_order_id: args.shop_order_id,
          first_piece_action: dryRun.first_piece.action,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_record_final_shop_quality",
    {
      title: "Dry Run Record Final Shop Quality",
      description: "Preview one signed final shop-quality outcome without writing.",
      inputSchema: ShopOrderFinalQualityInputSchema,
    },
    async ({ shop_order_id, final_quality_payload_json }) => text(
      await buildRecordFinalShopQualityPreview(config, shop_order_id, final_quality_payload_json),
    ),
  );

  server.registerTool(
    "request_record_final_shop_quality",
    {
      title: "Request Record Final Shop Quality",
      description: "Approved-write: record signed final QC, reconcile yield and bundles, and transition the Shop Order to Ready or Quality Hold.",
      inputSchema: approvedWriteInputSchema(ShopOrderFinalQualityWriteInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const order = await readResource(config, "Shop Order", args.shop_order_id);
      const dryRun = await buildRecordFinalShopQualityPreview(
        config,
        args.shop_order_id,
        args.final_quality_payload_json,
      );
      assertSignedShopSnapshot(args, dryRun);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_record_final_shop_quality",
        target: { doctype: "Shop Order", name: args.shop_order_id },
        roofJob: order.roof_job,
        dryRun,
        beforeSummary: summarizeShopOrder(order),
        afterSummary: (result) => {
          const outcome = result?.message ?? result ?? {};
          return {
            shop_order: outcome.shop_order ?? {},
            ...(Array.isArray(outcome.remnant_lots) ? { remnant_lots: outcome.remnant_lots } : {}),
            ...(outcome.material_lot ? { material_lot: outcome.material_lot } : {}),
            ...(outcome.nonconformance ? { nonconformance: outcome.nonconformance } : {}),
          };
        },
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.shop_fabrication_api.record_final_shop_quality",
          {
            shop_order_id: args.shop_order_id,
            hermes_run_id: args.run_id,
          },
        ),
        responseExtra: {
          final_quality_recorded: true,
          shop_order_id: args.shop_order_id,
          final_quality_action: dryRun.final_quality.action,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_record_shop_handover",
    {
      title: "Dry Run Record Shop Handover",
      description: "Preview one evidence-backed custody handover without writing.",
      inputSchema: ShopOrderHandoverInputSchema,
    },
    async ({ shop_order_id, handover_payload_json }) => text(
      await buildRecordShopHandoverPreview(config, shop_order_id, handover_payload_json),
    ),
  );

  server.registerTool(
    "request_record_shop_handover",
    {
      title: "Request Record Shop Handover",
      description: "Approved-write: record custody evidence for every prepared bundle and transition the Shop Order to Handed Over.",
      inputSchema: approvedWriteInputSchema(ShopOrderHandoverWriteInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const order = await readResource(config, "Shop Order", args.shop_order_id);
      const dryRun = await buildRecordShopHandoverPreview(
        config,
        args.shop_order_id,
        args.handover_payload_json,
      );
      assertSignedShopSnapshot(args, dryRun);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_record_shop_handover",
        target: { doctype: "Shop Order", name: args.shop_order_id },
        roofJob: order.roof_job,
        dryRun,
        beforeSummary: summarizeShopOrder(order),
        afterSummary: (result) => (result?.message ?? result ?? {}).shop_order ?? {},
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.shop_fabrication_api.record_shop_handover",
          {
            shop_order_id: args.shop_order_id,
            hermes_run_id: args.run_id,
          },
        ),
        responseExtra: {
          handover_recorded: true,
          shop_order_id: args.shop_order_id,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_record_shop_billing_basis",
    {
      title: "Dry Run Record Shop Billing Basis",
      description: "Preview binding one handed-over Shop Order to its existing provider invoice mirror without writing.",
      inputSchema: ShopOrderBillingBasisInputSchema,
    },
    async ({ shop_order_id, billing_basis_payload_json }) => text(
      await buildRecordShopBillingBasisPreview(
        config,
        shop_order_id,
        billing_basis_payload_json,
      ),
    ),
  );

  server.registerTool(
    "request_record_shop_billing_basis",
    {
      title: "Request Record Shop Billing Basis",
      description: "Approved-write: bind a handed-over Shop Order to one existing QuickBooks Invoice mirror and transition it to Invoice Ready.",
      inputSchema: approvedWriteInputSchema(ShopOrderBillingBasisWriteInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const order = await readResource(config, "Shop Order", args.shop_order_id);
      const dryRun = await buildRecordShopBillingBasisPreview(
        config,
        args.shop_order_id,
        args.billing_basis_payload_json,
      );
      assertSignedShopSnapshot(args, dryRun);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_record_shop_billing_basis",
        target: { doctype: "Shop Order", name: args.shop_order_id },
        roofJob: order.roof_job,
        dryRun,
        beforeSummary: summarizeShopOrder(order),
        afterSummary: (result) => {
          const outcome = result?.message ?? result ?? {};
          return {
            shop_order: outcome.shop_order ?? {},
            payment_milestone: outcome.payment_milestone ?? {},
          };
        },
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.shop_fabrication_api.record_shop_billing_basis",
          {
            shop_order_id: args.shop_order_id,
            hermes_run_id: args.run_id,
          },
        ),
        responseExtra: {
          billing_basis_recorded: true,
          shop_order_id: args.shop_order_id,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_proposal_evidence_pack",
    {
      title: "Dry Run Proposal Evidence Pack",
      description: "Preview the draft Proposal Evidence Pack assembled from job evidence without writing.",
      inputSchema: {
        roof_job_id: z.string().min(1),
        customer_quote_id: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ roof_job_id, customer_quote_id, limit = 25 }) => {
      const { draft, measurements, evidence } = await buildProposalDraftFromErp(config, roof_job_id, {
        customerQuoteId: customer_quote_id,
        limit,
      });
      const before = await readResourceOrNull(config, "Proposal Evidence Pack", draft.pack_id);
      assertProposalPackWritable(before, draft);
      return text({
        would_write: false,
        required_tool: "request_create_proposal_evidence_pack",
        target: { doctype: "Proposal Evidence Pack", name: draft.pack_id },
        source_counts: { measurement_reports: measurements.length, evidence_items: evidence.length },
        draft,
      });
    },
  );

  server.registerTool(
    "request_create_proposal_evidence_pack",
    {
      title: "Request Create Proposal Evidence Pack",
      description: "Approved-write: create or update one draft Proposal Evidence Pack and record a Hermes Run audit row.",
      inputSchema: {
        roof_job_id: z.string().min(1),
        customer_quote_id: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        run_id: z.string().min(8).max(128),
        dry_run_receipt: z.string().min(32).max(4096),
        approval_receipt: z.string().min(32).max(8192),
      },
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const { draft, measurements, evidence } = await buildProposalDraftFromErp(config, args.roof_job_id, {
        customerQuoteId: args.customer_quote_id,
        limit: args.limit ?? 25,
        nowIso: now,
      });
      const before = await readResourceOrNull(config, "Proposal Evidence Pack", draft.pack_id);
      assertProposalPackWritable(before, draft);
      const operation = before ? "update" : "create";
      const dryRun = {
        target: { doctype: "Proposal Evidence Pack", name: draft.pack_id },
        operation,
        source_counts: { measurement_reports: measurements.length, evidence_items: evidence.length },
        draft,
      };
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_create_proposal_evidence_pack",
        target: { doctype: "Proposal Evidence Pack", name: draft.pack_id },
        roofJob: args.roof_job_id,
        dryRun,
        beforeSummary: summarizeProposalPack(before),
        afterSummary: summarizeProposalPack({ ...(before ?? {}), ...draft, name: draft.pack_id }),
        execute: upsertDraftExecutor(config, "Proposal Evidence Pack", draft.pack_id, draft, before),
        responseExtra: { upserted: true, operation, proposal_evidence_pack_id: draft.pack_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_publish_proposal_evidence_pack",
    {
      title: "Dry Run Publish Proposal Evidence Pack",
      description: "Preview one Draft Proposal Evidence Pack publication to the existing private customer portal without sending, linking, signing, or accepting anything.",
      inputSchema: ProposalEvidencePackPublicationInputSchema,
    },
    async ({ proposal_evidence_pack_id }) => {
      const before = await readResource(config, "Proposal Evidence Pack", proposal_evidence_pack_id);
      assertProposalPackPublishable(before, proposal_evidence_pack_id);
      const quote = await readResource(config, "Customer Quote", before.quotation);
      assertProposalQuotePreparable(quote, before.roof_job);
      return text({
        would_write: false,
        required_tool: "request_publish_proposal_evidence_pack",
        ...proposalPublicationPreview(before, config.approverId),
      });
    },
  );

  server.registerTool(
    "request_publish_proposal_evidence_pack",
    {
      title: "Request Publish Proposal Evidence Pack",
      description: "Approved-write: publish one reviewed Draft Proposal Evidence Pack to the existing private customer portal and record a Hermes Run. It never sends, links, renders, signs, accepts, charges, or changes the quote.",
      inputSchema: approvedWriteInputSchema(ProposalEvidencePackPublicationInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const before = await readResource(config, "Proposal Evidence Pack", args.proposal_evidence_pack_id);
      assertProposalPackPublishable(before, args.proposal_evidence_pack_id);
      const quote = await readResource(config, "Customer Quote", before.quotation);
      assertProposalQuotePreparable(quote, before.roof_job);
      const dryRun = proposalPublicationPreview(before, args.approved_by);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_publish_proposal_evidence_pack",
        target: { doctype: "Proposal Evidence Pack", name: args.proposal_evidence_pack_id },
        roofJob: before.roof_job,
        dryRun,
        beforeSummary: summarizeProposalPack(before),
        afterSummary: (result) => summarizeProposalPublicationCommandResult(before, result),
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.proposal_delivery_api.publish_proposal_evidence_pack",
          {
            proposal_evidence_pack_id: args.proposal_evidence_pack_id,
            hermes_run_id: args.run_id,
          },
        ),
        responseExtra: {
          published: true,
          proposal_evidence_pack_id: args.proposal_evidence_pack_id,
          customer_delivery_mutated: false,
          customer_portal_link_issued: false,
          contract_acceptance_mutated: false,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_update_gate",
    {
      title: "Dry Run Update Gate",
      description: "Preview one Production Gate State update without writing.",
      inputSchema: {
        gate_id: z.string().min(1),
        next_state: GateStateSchema,
        reason: z.string().max(2000).optional(),
        evidence_item_id: IdSchema.optional(),
      },
    },
    async ({ gate_id, next_state, reason, evidence_item_id }) => {
      const before = await readResource(config, "Production Gate State", gate_id);
      const patch = buildGateUpdatePatch(next_state, reason, undefined, undefined, evidence_item_id);
      await assertGateEvidenceForState(config, next_state, patch.evidence_item, before.roof_job);
      return text({
        would_write: false,
        required_tool: "request_update_gate",
        target: { doctype: "Production Gate State", name: gate_id },
        before: summarizeGate(before),
        patch,
      });
    },
  );

  server.registerTool(
    "request_update_gate",
    {
      title: "Request Update Gate",
      description: "Approved-write: update one Production Gate State and record a Hermes Run audit row.",
      inputSchema: {
        gate_id: z.string().min(1),
        next_state: GateStateSchema,
        reason: z.string().max(2000).optional(),
        evidence_item_id: IdSchema.optional(),
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        run_id: z.string().min(8).max(128),
        dry_run_receipt: z.string().min(32).max(4096),
        approval_receipt: z.string().min(32).max(8192),
      },
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const before = await readResource(config, "Production Gate State", args.gate_id);
      const patch = buildGateUpdatePatch(
        args.next_state,
        args.reason,
        args.approved_by,
        now,
        args.evidence_item_id,
      );
      await assertGateEvidenceForState(
        config,
        args.next_state,
        patch.evidence_item,
        before.roof_job,
      );
      const dryRun = {
        target: { doctype: "Production Gate State", name: args.gate_id },
        before: summarizeGate(before),
        patch,
      };
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_update_gate",
        target: { doctype: "Production Gate State", name: args.gate_id },
        roofJob: before.roof_job,
        leadEnvelope: before.lead_envelope,
        linkedEvidence: patch.evidence_item ?? before.evidence_item,
        dryRun,
        beforeSummary: summarizeGate(before),
        afterSummary: summarizeGate({ ...before, ...patch }),
        execute: () => erpPut(config, resourcePath("Production Gate State", args.gate_id), patch),
        responseExtra: { updated: true, gate_id: args.gate_id },
      }));
    },
  );

  registerReadPair(server, config, {
    doctype: "Completion Packet",
    idArg: "completion_packet_id",
    getName: "get_completion_packet",
    listName: "list_completion_packets_for_job",
    fields: COMPLETION_PACKET_FIELDS,
  });
  registerReadPair(server, config, {
    doctype: "Warranty Packet",
    idArg: "warranty_packet_id",
    getName: "get_warranty_packet",
    listName: "list_warranty_packets_for_job",
    fields: WARRANTY_PACKET_FIELDS,
  });
  registerReadPair(server, config, {
    doctype: "Review Request",
    idArg: "review_request_id",
    getName: "get_review_request",
    listName: "list_review_requests_for_job",
    fields: REVIEW_REQUEST_FIELDS,
  });
  registerReadPair(server, config, {
    doctype: "Communication Event",
    idArg: "communication_event_id",
    getName: "get_communication_event",
    listName: "list_communication_events_for_job",
    fields: COMMUNICATION_EVENT_FIELDS,
    orderBy: "event_ts desc",
  });
  registerReadPair(server, config, {
    doctype: "Supplier Quote",
    idArg: "supplier_quote_id",
    getName: "get_supplier_quote",
    listName: "list_supplier_quotes_for_job",
    fields: SUPPLIER_QUOTE_FIELDS,
  });
  registerStrictJobReadPair(server, config, {
    doctype: "Customer Quote",
    idArg: "customer_quote_id",
    getName: "get_customer_quote",
    listName: "list_customer_quotes_for_job",
    fields: CUSTOMER_QUOTE_FIELDS,
  });
  registerReadPair(server, config, {
    doctype: "Visual Property Model",
    idArg: "visual_model_id",
    getName: "get_visual_property_model",
    listName: "list_visual_property_models_for_job",
    fields: VISUAL_PROPERTY_MODEL_FIELDS,
  });
  registerReadPair(server, config, {
    doctype: "Roof Area",
    idArg: "roof_area_id",
    getName: "get_roof_area",
    listName: "list_roof_areas_for_job",
    fields: ROOF_AREA_FIELDS,
  });
  registerReadPair(server, config, {
    doctype: "Option Package",
    idArg: "option_package_id",
    getName: "get_option_package",
    listName: "list_option_packages_for_job",
    fields: OPTION_PACKAGE_FIELDS,
  });
  registerReadPair(server, config, {
    doctype: "Scope Clause",
    idArg: "scope_clause_id",
    getName: "get_scope_clause",
    listName: "list_scope_clauses_for_job",
    fields: SCOPE_CLAUSE_FIELDS,
  });

  server.registerTool(
    "get_crew_profile",
    {
      title: "Get Crew Profile",
      description: "Read one allowlisted Crew Profile. Member, safety-contact phone, and free-form note fields are not exposed.",
      inputSchema: z.object({ crew_profile_id: IdSchema }).strict(),
    },
    async ({ crew_profile_id }) => text({
      data: sanitizeResource(await readResource(config, "Crew Profile", crew_profile_id), CREW_PROFILE_FIELDS),
    }),
  );

  server.registerTool(
    "list_crew_profiles",
    {
      title: "List Crew Profiles",
      description: "Read a bounded site-local Crew Profile list, optionally filtered by lifecycle status.",
      inputSchema: z.object({
        status: z.enum(["Active", "Inactive", "Suspended"]).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      }).strict(),
    },
    async ({ status, limit = 25 }) => text({
      data: (await listResources(config, "Crew Profile", {
        fields: CREW_PROFILE_FIELDS,
        ...(status ? { filters: [["Crew Profile", "status", "=", status]] } : {}),
        limit,
        orderBy: "modified desc",
      })).map((row) => sanitizeResource(row, CREW_PROFILE_FIELDS)),
    }),
  );

  registerStrictJobReadPair(server, config, {
    doctype: "Job Assignment",
    idArg: "assignment_id",
    getName: "get_job_assignment",
    listName: "list_job_assignments_for_job",
    fields: JOB_ASSIGNMENT_FIELDS,
    orderBy: "assigned_at desc",
  });
  registerStrictJobReadPair(server, config, {
    doctype: "Work Package",
    idArg: "work_package_id",
    getName: "get_work_package",
    listName: "list_work_packages_for_job",
    fields: WORK_PACKAGE_FIELDS,
    childFields: { assigned_workers: WORK_PACKAGE_WORKER_FIELDS },
  });
  registerStrictJobReadPair(server, config, {
    doctype: "Work Package Event",
    idArg: "event_id",
    getName: "get_work_package_event",
    listName: "list_work_package_events_for_job",
    fields: WORK_PACKAGE_EVENT_FIELDS,
    orderBy: "occurred_at asc",
  });
  server.registerTool(
    "dry_run_complete_work_package",
    {
      title: "Dry Run Complete Work Package",
      description: "Preview the bounded online completion command. Frappe rechecks every acknowledgement, phased hold, evidence, correction, and authority gate at execution time.",
      inputSchema: WorkPackageCompletionInputSchema,
    },
    async (args) => text(await buildCompleteWorkPackagePreview(config, args)),
  );
  server.registerTool(
    "request_complete_work_package",
    {
      title: "Request Complete Work Package",
      description: "Approved-write: invoke the immutable Work Package completion command. It never bypasses the Frappe lifecycle gates or permits offline completion.",
      inputSchema: approvedWriteInputSchema(WorkPackageCompletionInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const before = await readResource(config, "Work Package", args.work_package_id);
      const dryRun = await buildCompleteWorkPackagePreview(config, args);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_complete_work_package",
        target: { doctype: "Work Package", name: args.work_package_id },
        roofJob: args.roof_job_id,
        dryRun,
        beforeSummary: summarizeRecord(before, [
          "name",
          "work_package_id",
          "roof_job",
          "work_object_type",
          "work_object_id",
          "physical_context_type",
          "physical_context_id",
          "job_assignment",
          "version",
          "release_attempt_id",
          "status",
        ]),
        afterSummary: (result) => {
          const outcome = result?.message ?? result ?? {};
          return {
            work_package: outcome.work_package ?? {},
            event: outcome.event ?? {},
          };
        },
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.work_package_api.complete_work_package",
          {
            work_package_id: args.work_package_id,
            ...(args.roof_job_id ? { roof_job_id: args.roof_job_id } : {}),
            ...(normalizeWorkPackageScopeArgs(args) ?? {}),
            job_assignment_id: args.job_assignment_id,
            actor_user: args.completion_authority_user,
            device_action_id: args.device_action_id,
            work_package_version: args.work_package_version,
            release_attempt_id: args.release_attempt_id,
          },
        ),
        responseExtra: {
          completed: true,
          work_package_id: args.work_package_id,
          release_attempt_id: args.release_attempt_id,
        },
      }));
    },
  );
  registerStrictJobReadPair(server, config, {
    doctype: "Change Order",
    idArg: "change_order_id",
    getName: "get_change_order",
    listName: "list_change_orders_for_job",
    fields: CHANGE_ORDER_FIELDS,
    childFields: { items: CHANGE_ORDER_ITEM_FIELDS },
  });
  registerStrictJobReadPair(server, config, {
    doctype: "Insurance Supplement",
    idArg: "insurance_supplement_id",
    getName: "get_insurance_supplement",
    listName: "list_insurance_supplements_for_job",
    fields: INSURANCE_SUPPLEMENT_FIELDS,
    childFields: { evidence: INSURANCE_SUPPLEMENT_EVIDENCE_FIELDS },
  });
  registerStrictJobReadPair(server, config, {
    doctype: "Safety Plan",
    idArg: "safety_plan_id",
    getName: "get_safety_plan",
    listName: "list_safety_plans_for_job",
    fields: SAFETY_PLAN_FIELDS,
    childFields: { acknowledgements: SAFETY_ACKNOWLEDGEMENT_FIELDS },
  });
  registerStrictJobReadPair(server, config, {
    doctype: "Job Compliance Record",
    idArg: "compliance_record_id",
    getName: "get_job_compliance_record",
    listName: "list_job_compliance_records_for_job",
    fields: JOB_COMPLIANCE_RECORD_FIELDS,
  });
  server.registerTool(
    "get_authority_record",
    {
      title: "Get Authority Record",
      description: "Read one tenant-bound, individually versioned Authority Record with issuer and evidence identity.",
      inputSchema: z.object({ authority_record_id: IdSchema }).strict(),
    },
    async ({ authority_record_id }) => {
      const record = await readResource(config, "Authority Record", authority_record_id);
      if (record.tenant !== config.tenantId) throw new Error("authority_record_tenant_mismatch");
      return text({ data: sanitizeResource(record, AUTHORITY_RECORD_FIELDS) });
    },
  );
  server.registerTool(
    "list_authority_records_for_job",
    {
      title: "List Authority Records For Job",
      description: "Read bounded tenant-scoped Authority Record versions linked to one Roof Job.",
      inputSchema: z.object({ roof_job_id: IdSchema, limit: z.number().int().min(1).max(100).optional() }).strict(),
    },
    async ({ roof_job_id, limit = 25 }) => text({
      data: (await listResources(config, "Authority Record", {
        fields: AUTHORITY_RECORD_FIELDS,
        filters: [
          ["Authority Record", "tenant", "=", config.tenantId],
          ["Authority Record", "roof_job", "=", roof_job_id],
        ],
        limit,
        orderBy: "modified desc",
      })).map((row) => sanitizeResource(row, AUTHORITY_RECORD_FIELDS)),
    }),
  );
  registerStrictJobReadPair(server, config, {
    doctype: "Communication Consent",
    idArg: "consent_id",
    getName: "get_communication_consent",
    listName: "list_communication_consents_for_job",
    fields: COMMUNICATION_CONSENT_FIELDS,
    orderBy: "captured_at desc",
  });
  registerStrictJobReadPair(server, config, {
    doctype: "Customer Decision",
    idArg: "decision_id",
    getName: "get_customer_decision",
    listName: "list_customer_decisions_for_job",
    fields: CUSTOMER_DECISION_FIELDS,
    orderBy: "decided_at desc",
  });

  // Contract Acceptance is intentionally read-only. Hermes cannot sign, accept,
  // decline, void, or otherwise impersonate a customer.
  registerStrictJobReadPair(server, config, {
    doctype: "Contract Acceptance",
    idArg: "acceptance_id",
    getName: "get_contract_acceptance",
    listName: "list_contract_acceptances_for_job",
    fields: CONTRACT_ACCEPTANCE_FIELDS,
    orderBy: "accepted_at desc",
  });
  registerStrictJobReadPair(server, config, {
    doctype: "Integration Reconciliation",
    idArg: "reconciliation_id",
    getName: "get_integration_reconciliation",
    listName: "list_integration_reconciliations_for_job",
    fields: INTEGRATION_RECONCILIATION_FIELDS,
    orderBy: "detected_at desc",
  });

  server.registerTool(
    "get_job_cost_event",
    {
      title: "Get Job Cost Event",
      description: "Read one tenant-bound immutable actual-cost fact without actor or approver identity fields.",
      inputSchema: z.object({ job_cost_event_id: IdSchema }).strict(),
    },
    async ({ job_cost_event_id }) => {
      const record = await readResource(config, "Job Cost Event", job_cost_event_id);
      if (record.tenant !== config.tenantId) {
        throw new Error("job_cost_event_tenant_mismatch");
      }
      return text({ data: sanitizeResource(record, JOB_COST_EVENT_FIELDS) });
    },
  );

  server.registerTool(
    "list_job_cost_events_for_job",
    {
      title: "List Job Cost Events For Job",
      description: "Read a bounded tenant-and-job scoped list of immutable actual-cost facts.",
      inputSchema: z.object({
        roof_job_id: IdSchema,
        limit: z.number().int().min(1).max(100).optional(),
      }).strict(),
    },
    async ({ roof_job_id, limit = 25 }) => text({
      data: (await listResources(config, "Job Cost Event", {
        fields: JOB_COST_EVENT_FIELDS,
        filters: [
          ["Job Cost Event", "tenant", "=", config.tenantId],
          ["Job Cost Event", "roof_job", "=", roof_job_id],
        ],
        limit,
        orderBy: "occurred_at desc",
      })).map((row) => sanitizeResource(row, JOB_COST_EVENT_FIELDS)),
    }),
  );

  server.registerTool(
    "dry_run_job_cost_event",
    {
      title: "Dry Run Job Cost Event",
      description: "Prepare a source-verified immutable actual-cost candidate for manual Finance/Owner insertion. This tool has no write companion and never mutates accounting or customer state.",
      inputSchema: JobCostEventInputSchema,
    },
    async (args) => text(await buildJobCostEventPreviewFromErp(config, args)),
  );

  server.registerTool(
    "get_tenant_export_run",
    {
      title: "Get Tenant Export Run",
      description: "Read one allowlisted Tenant Export Run without archive keys or encryption-key references.",
      inputSchema: z.object({ export_run_id: IdSchema }).strict(),
    },
    async ({ export_run_id }) => text({
      data: sanitizeResource(await readResource(config, "Tenant Export Run", export_run_id), TENANT_EXPORT_RUN_FIELDS),
    }),
  );

  server.registerTool(
    "list_tenant_export_runs_for_tenant",
    {
      title: "List Tenant Export Runs For Tenant",
      description: "Read a bounded export-run list for one exact site-local tenant.",
      inputSchema: z.object({
        tenant_id: IdSchema,
        limit: z.number().int().min(1).max(25).optional(),
      }).strict(),
    },
    async ({ tenant_id, limit = 25 }) => text({
      data: (await listResources(config, "Tenant Export Run", {
        fields: TENANT_EXPORT_RUN_FIELDS,
        filters: [["Tenant Export Run", "tenant", "=", tenant_id]],
        limit,
        orderBy: "requested_at desc",
      })).map((row) => sanitizeResource(row, TENANT_EXPORT_RUN_FIELDS)),
    }),
  );

  server.registerTool(
    "get_price_book_rule",
    {
      title: "Get Price Book Rule",
      description: "Read one owned Price Book Rule by price_rule_id/name.",
      inputSchema: { price_rule_id: z.string().min(1) },
    },
    async ({ price_rule_id }) => text(await erpGet(config, resourcePath("Price Book Rule", price_rule_id))),
  );

  server.registerTool(
    "list_price_book_rules",
    {
      title: "List Price Book Rules",
      description: "Read approved/review pricing rules, optionally filtered by status and service type.",
      inputSchema: {
        status: z.enum(["Draft", "Needs Review", "Approved", "Retired"]).optional(),
        service_type: z.string().min(1).max(140).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ status, service_type, limit = 25 }) => {
      const filters = [];
      if (status) filters.push(["Price Book Rule", "status", "=", status]);
      if (service_type) filters.push(["Price Book Rule", "service_type", "=", service_type]);
      return text(await erpGet(config, resourceListPath("Price Book Rule", {
        fields: PRICE_BOOK_RULE_FIELDS,
        ...(filters.length ? { filters } : {}),
        limit,
        orderBy: "effective_from desc",
      })));
    },
  );

  server.registerTool(
    "get_automation_incident",
    {
      title: "Get Automation Incident",
      description: "Read one owned Automation Incident by incident_id/name.",
      inputSchema: { incident_id: z.string().min(1) },
    },
    async ({ incident_id }) => text(await erpGet(config, resourcePath("Automation Incident", incident_id))),
  );

  server.registerTool(
    "list_automation_incidents",
    {
      title: "List Automation Incidents",
      description: "Read incident recovery truth, optionally filtered by status or severity.",
      inputSchema: {
        status: z.enum(["Open", "Acknowledged", "Resolved", "Closed"]).optional(),
        severity: z.enum(["Low", "Medium", "High", "Critical"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ status, severity, limit = 25 }) => {
      const filters = [];
      if (status) filters.push(["Automation Incident", "status", "=", status]);
      if (severity) filters.push(["Automation Incident", "severity", "=", severity]);
      return text(await erpGet(config, resourceListPath("Automation Incident", {
        fields: AUTOMATION_INCIDENT_FIELDS,
        ...(filters.length ? { filters } : {}),
        limit,
        orderBy: "detected_at desc",
      })));
    },
  );

  server.registerTool(
    "get_white_label_tenant",
    {
      title: "Get White-Label Tenant",
      description: "Read one site-local White-Label Tenant configuration by tenant_id/name.",
      inputSchema: { tenant_id: z.string().min(1) },
    },
    async ({ tenant_id }) => text(await erpGet(config, resourcePath("White-Label Tenant", tenant_id))),
  );

  server.registerTool(
    "list_white_label_tenants",
    {
      title: "List White-Label Tenants",
      description: "Read site-local tenant lifecycle metadata. Site isolation still limits a production site to one Active tenant.",
      inputSchema: {
        status: z.enum(["Draft", "Provisioning", "Active", "Suspended", "Retired"]).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ status, limit = 10 }) => text(await erpGet(config, resourceListPath("White-Label Tenant", {
      fields: WHITE_LABEL_TENANT_FIELDS,
      ...(status ? { filters: [["White-Label Tenant", "status", "=", status]] } : {}),
      limit,
      orderBy: "modified desc",
    }))),
  );

  server.registerTool(
    "list_market_watch_items",
    {
      title: "List Market Watch Items",
      description: "Read Market Watch Item rows, optionally filtered by status.",
      inputSchema: {
        status: z.enum(["Open", "Covered", "Exceeded", "Responding", "Dismissed"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ status, limit = 25 }) => text(await erpGet(config, resourceListPath("Market Watch Item", {
      fields: MARKET_WATCH_ITEM_FIELDS,
      ...(status ? { filters: [["Market Watch Item", "status", "=", status]] } : {}),
      limit,
      orderBy: "modified desc",
    }))),
  );

  server.registerTool(
    "check_consent",
    {
      title: "Check Consent",
      description: "Deterministic CASL-style consent check for one channel and consent basis. Read-only.",
      inputSchema: {
        channel: z.enum(["SMS", "Email", "Call", "Portal"]),
        consent_basis: z.string().optional(),
      },
    },
    async ({ channel, consent_basis }) => text(checkConsent({ channel, consentBasis: consent_basis })),
  );

  server.registerTool(
    "check_quiet_hours",
    {
      title: "Check Quiet Hours",
      description: "Deterministic quiet-hours check for an outbound customer communication. Read-only.",
      inputSchema: {
        now_utc_iso: z.string().min(1).optional(),
        timezone_offset_minutes: z.number().int().min(-720).max(840).optional(),
        start_hour: z.number().int().min(0).max(23).optional(),
        end_hour: z.number().int().min(1).max(24).optional(),
      },
    },
    async ({ now_utc_iso, timezone_offset_minutes, start_hour, end_hour }) => text(checkQuietHours({
      nowUtcIso: now_utc_iso ?? new Date().toISOString(),
      timezoneOffsetMinutes: timezone_offset_minutes,
      startHour: start_hour,
      endHour: end_hour,
    })),
  );

  server.registerTool(
    "dry_run_job_assignment",
    {
      title: "Dry Run Job Assignment",
      description: "Preview one append-only Job Assignment without writing. Corrections must supersede the prior assignment.",
      inputSchema: JobAssignmentInputSchema,
    },
    async (args) => {
      const now = new Date().toISOString();
      const draft = jobAssignmentDraftFromArgs(args, now);
      if (args.crew_profile_id) {
        const crew = await readResource(config, "Crew Profile", args.crew_profile_id);
        if (crew.status !== "Active") throw new Error("active_crew_profile_required");
      }
      if (args.supersedes) {
        const prior = await assertLinkedResourceForJob(
          config,
          "Job Assignment",
          args.supersedes,
          args.roof_job_id,
          "superseded_assignment",
        );
        if ((prior.assignment_id ?? prior.name) === draft.assignment_id) {
          throw new Error("assignment_correction_requires_new_id");
        }
      }
      const before = await readResourceOrNull(config, "Job Assignment", draft.assignment_id);
      const productionScheduleGatePreview = await previewProductionScheduleGatePreview(config, draft);
      return text({
        would_write: false,
        required_tool: "request_create_job_assignment",
        target: { doctype: "Job Assignment", name: draft.assignment_id },
        append_only: true,
        blocked_existing: Boolean(before),
        ...(before ? { blocked_reason: "assignment_append_only" } : {}),
        draft,
        production_schedule_gate_preview: productionScheduleGatePreview,
      });
    },
  );

  server.registerTool(
    "request_create_job_assignment",
    {
      title: "Request Create Job Assignment",
      description: "Approved-write: append one Job Assignment and record a Hermes Run. Existing assignments are never silently overwritten.",
      inputSchema: approvedWriteInputSchema(JobAssignmentInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id;
      const draft = jobAssignmentDraftFromArgs(args, now);
      if (args.crew_profile_id) {
        const crew = await readResource(config, "Crew Profile", args.crew_profile_id);
        if (crew.status !== "Active") throw new Error("active_crew_profile_required");
      }
      if (args.supersedes) {
        const prior = await assertLinkedResourceForJob(
          config,
          "Job Assignment",
          args.supersedes,
          args.roof_job_id,
          "superseded_assignment",
        );
        if ((prior.assignment_id ?? prior.name) === draft.assignment_id) {
          throw new Error("assignment_correction_requires_new_id");
        }
      }
      const before = await readResourceOrNull(config, "Job Assignment", draft.assignment_id);
      // This is a diagnostic snapshot for the audit trail, not a write gate. The
      // Frappe validation hook reads the current rows immediately when it receives
      // the mutation, closing the preview-to-write race.
      const productionScheduleGatePreview = await previewProductionScheduleGatePreview(config, draft);
      const dryRun = {
        target: { doctype: "Job Assignment", name: draft.assignment_id },
        operation: before ? "blocked_existing" : "create",
        append_only: true,
        draft,
        production_schedule_gate_preview: productionScheduleGatePreview,
      };
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_create_job_assignment",
        target: { doctype: "Job Assignment", name: draft.assignment_id },
        roofJob: args.roof_job_id,
        dryRun,
        beforeSummary: summarizeRecord(before, ["name", "assignment_id", "roof_job", "status", "supersedes"]),
        afterSummary: summarizeRecord(draft, ["assignment_id", "roof_job", "status", "supersedes"]),
        execute: createOnlyExecutor(
          config,
          "Job Assignment",
          before,
          draft,
          "assignment_append_only",
        ),
        responseExtra: { created: true, assignment_id: draft.assignment_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_change_order",
    {
      title: "Dry Run Change Order",
      description: "Preview one append-only Change Order draft with computed totals. It never presents, accepts, rejects, or sends a contract.",
      inputSchema: ChangeOrderDraftInputSchema,
    },
    async (args) => {
      const now = new Date().toISOString();
      const draft = changeOrderDraftFromArgs(args, now);
      if (args.customer_quote_id) {
        await assertLinkedResourceForJob(
          config,
          "Customer Quote",
          args.customer_quote_id,
          args.roof_job_id,
          "customer_quote",
        );
      }
      if (args.supersedes) {
        const prior = await assertLinkedResourceForJob(
          config,
          "Change Order",
          args.supersedes,
          args.roof_job_id,
          "superseded_change_order",
        );
        if ((prior.change_order_id ?? prior.name) === draft.change_order_id) {
          throw new Error("change_order_correction_requires_new_id");
        }
        assertCorrectionVersion(draft, prior, "change_order_correction");
      }
      const before = await readResourceOrNull(config, "Change Order", draft.change_order_id);
      return text({
        would_write: false,
        required_tool: "request_create_change_order",
        target: { doctype: "Change Order", name: draft.change_order_id },
        append_only: true,
        blocked_existing: Boolean(before),
        ...(before ? { blocked_reason: "change_order_append_only" } : {}),
        draft,
      });
    },
  );

  server.registerTool(
    "request_create_change_order",
    {
      title: "Request Create Change Order",
      description: "Approved-write: append one Change Order draft and audit it. It cannot accept, reject, sign, or send for a customer.",
      inputSchema: approvedWriteInputSchema(ChangeOrderDraftInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id;
      const draft = changeOrderDraftFromArgs(args, now);
      if (args.customer_quote_id) {
        await assertLinkedResourceForJob(
          config,
          "Customer Quote",
          args.customer_quote_id,
          args.roof_job_id,
          "customer_quote",
        );
      }
      if (args.supersedes) {
        const prior = await assertLinkedResourceForJob(
          config,
          "Change Order",
          args.supersedes,
          args.roof_job_id,
          "superseded_change_order",
        );
        if ((prior.change_order_id ?? prior.name) === draft.change_order_id) {
          throw new Error("change_order_correction_requires_new_id");
        }
        assertCorrectionVersion(draft, prior, "change_order_correction");
      }
      const before = await readResourceOrNull(config, "Change Order", draft.change_order_id);
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_create_change_order",
        target: { doctype: "Change Order", name: draft.change_order_id },
        roofJob: args.roof_job_id,
        dryRun: {
          target: { doctype: "Change Order", name: draft.change_order_id },
          operation: before ? "blocked_existing" : "create",
          append_only: true,
          draft,
        },
        beforeSummary: summarizeRecord(before, ["name", "change_order_id", "roof_job", "version", "status"]),
        afterSummary: summarizeRecord(draft, ["change_order_id", "roof_job", "version", "status", "total_amount"]),
        execute: createOnlyExecutor(
          config,
          "Change Order",
          before,
          draft,
          "change_order_append_only",
        ),
        responseExtra: { created: true, change_order_id: draft.change_order_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_change_order_transition",
    {
      title: "Dry Run Change Order Transition",
      description: "Preview one internal Change Order review transition. Customer accept/reject transitions are forbidden.",
      inputSchema: ChangeOrderTransitionInputSchema,
    },
    async ({ change_order_id, roof_job_id, next_status, reason, evidence_item_id }) => {
      const before = await readResource(config, "Change Order", change_order_id);
      assertLinkedRoofJob(roof_job_id, before, "change_order");
      const patch = buildChangeOrderTransitionPatch(
        before,
        next_status,
        reason,
        undefined,
        undefined,
        evidence_item_id,
      );
      if (evidence_item_id) {
        await assertLinkedResourceForJob(
          config,
          "Evidence Item",
          evidence_item_id,
          roof_job_id,
          "change_order_transition_evidence",
          { proofSlots: ["Change Order"], evidenceTypes: ["Signed Document", "Email"] },
        );
      }
      return text({
        would_write: false,
        required_tool: "request_transition_change_order",
        target: { doctype: "Change Order", name: change_order_id },
        before: summarizeRecord(before, ["name", "change_order_id", "roof_job", "status"]),
        patch,
      });
    },
  );

  server.registerTool(
    "request_transition_change_order",
    {
      title: "Request Transition Change Order",
      description: "Approved-write: move one Change Order through internal review states only. Customer acceptance and rejection are impossible here.",
      inputSchema: approvedWriteInputSchema(ChangeOrderTransitionInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const before = await readResource(config, "Change Order", args.change_order_id);
      assertLinkedRoofJob(args.roof_job_id, before, "change_order");
      const patch = buildChangeOrderTransitionPatch(
        before,
        args.next_status,
        args.reason,
        args.approved_by,
        now,
        args.evidence_item_id,
      );
      if (args.evidence_item_id) {
        await assertLinkedResourceForJob(
          config,
          "Evidence Item",
          args.evidence_item_id,
          args.roof_job_id,
          "change_order_transition_evidence",
          { proofSlots: ["Change Order"], evidenceTypes: ["Signed Document", "Email"] },
        );
      }
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_transition_change_order",
        target: { doctype: "Change Order", name: args.change_order_id },
        roofJob: args.roof_job_id,
        linkedEvidence: args.evidence_item_id,
        dryRun: {
          target: { doctype: "Change Order", name: args.change_order_id },
          before: summarizeRecord(before, ["name", "change_order_id", "roof_job", "status"]),
          patch,
        },
        beforeSummary: summarizeRecord(before, ["name", "change_order_id", "roof_job", "status"]),
        afterSummary: summarizeRecord({ ...before, ...patch }, [
          "name",
          "change_order_id",
          "roof_job",
          "status",
          "approved_by",
          "approved_at",
        ]),
        execute: () => erpPut(config, resourcePath("Change Order", args.change_order_id), patch),
        responseExtra: { updated: true, change_order_id: args.change_order_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_insurance_supplement",
    {
      title: "Dry Run Insurance Supplement",
      description: "Preview one append-only restricted insurance supplement evidence record. It never determines coverage, submits to a carrier, or contacts anyone.",
      inputSchema: InsuranceSupplementDraftInputSchema,
    },
    async (args) => {
      const draft = insuranceSupplementDraftFromArgs(args);
      const verifiedEvidence = await assertInsuranceSupplementSources(config, draft);
      const before = await readResourceOrNull(config, "Insurance Supplement", draft.insurance_supplement_id);
      return text({
        would_write: false,
        required_tool: "request_create_insurance_supplement",
        target: { doctype: "Insurance Supplement", name: draft.insurance_supplement_id },
        append_only: true,
        blocked_existing: Boolean(before),
        ...(before ? { blocked_reason: "insurance_supplement_append_only" } : {}),
        draft: summarizeInsuranceSupplement(draft),
        source: {
          customer_quote_linked: Boolean(draft.customer_quote),
          change_order_linked: Boolean(draft.change_order),
          measurement_report_linked: Boolean(draft.measurement_report),
          ...summarizeInsuranceEvidenceRows(verifiedEvidence),
        },
      });
    },
  );

  server.registerTool(
    "request_create_insurance_supplement",
    {
      title: "Request Create Insurance Supplement",
      description: "Approved-write: append one restricted insurance supplement Draft and audit it. It cannot make a carrier determination or submit evidence externally.",
      inputSchema: approvedWriteInputSchema(InsuranceSupplementDraftInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const draft = insuranceSupplementDraftFromArgs(args);
      const verifiedEvidence = await assertInsuranceSupplementSources(config, draft);
      const before = await readResourceOrNull(config, "Insurance Supplement", draft.insurance_supplement_id);
      const safeDraft = summarizeInsuranceSupplement(draft);
      const dryRun = {
        target: { doctype: "Insurance Supplement", name: draft.insurance_supplement_id },
        operation: before ? "blocked_existing" : "create",
        append_only: true,
        draft: safeDraft,
        source: {
          customer_quote_linked: Boolean(draft.customer_quote),
          change_order_linked: Boolean(draft.change_order),
          measurement_report_linked: Boolean(draft.measurement_report),
          ...summarizeInsuranceEvidenceRows(verifiedEvidence),
        },
      };
      const now = new Date().toISOString();
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_create_insurance_supplement",
        target: { doctype: "Insurance Supplement", name: draft.insurance_supplement_id },
        roofJob: args.roof_job_id,
        dryRun,
        beforeSummary: summarizeInsuranceSupplement(before),
        afterSummary: safeDraft,
        execute: async () => ({
          data: summarizeInsuranceSupplement(
            (await createOnlyExecutor(
              config,
              "Insurance Supplement",
              before,
              draft,
              "insurance_supplement_append_only",
            )())?.data,
          ),
        }),
        responseExtra: { created: true, insurance_supplement_id: draft.insurance_supplement_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_set_insurance_supplement_evidence",
    {
      title: "Dry Run Set Insurance Supplement Evidence",
      description: "Preview a replacement evidence set for a Draft, Needs Evidence, or Ready for Human Review supplement. It never changes claim facts or submits evidence.",
      inputSchema: InsuranceSupplementEvidenceUpdateInputSchema,
    },
    async (args) => {
      const before = await readResource(config, "Insurance Supplement", args.insurance_supplement_id);
      assertLinkedRoofJob(args.roof_job_id, before, "insurance_supplement");
      const patch = buildInsuranceSupplementEvidencePatch(before, {
        measurementReportId: args.measurement_report_id,
        evidence: args.evidence,
      });
      if (patch.measurement_report) {
        await assertLinkedResourceForJob(
          config,
          "Measurement Report",
          patch.measurement_report,
          args.roof_job_id,
          "insurance_supplement_measurement",
        );
      }
      const verifiedEvidence = await assertInsuranceSupplementEvidence(
        config,
        args.roof_job_id,
        patch.evidence,
      );
      return text({
        would_write: false,
        required_tool: "request_set_insurance_supplement_evidence",
        target: { doctype: "Insurance Supplement", name: args.insurance_supplement_id },
        before: summarizeInsuranceSupplement(before),
        patch: {
          measurement_report_linked: Boolean(patch.measurement_report),
          ...summarizeInsuranceEvidenceRows(verifiedEvidence),
        },
      });
    },
  );

  server.registerTool(
    "request_set_insurance_supplement_evidence",
    {
      title: "Request Set Insurance Supplement Evidence",
      description: "Approved-write: replace the verified evidence references on an editable insurance supplement and audit the change. It never submits evidence externally.",
      inputSchema: approvedWriteInputSchema(InsuranceSupplementEvidenceUpdateInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const before = await readResource(config, "Insurance Supplement", args.insurance_supplement_id);
      assertLinkedRoofJob(args.roof_job_id, before, "insurance_supplement");
      const patch = buildInsuranceSupplementEvidencePatch(before, {
        measurementReportId: args.measurement_report_id,
        evidence: args.evidence,
      });
      if (patch.measurement_report) {
        await assertLinkedResourceForJob(
          config,
          "Measurement Report",
          patch.measurement_report,
          args.roof_job_id,
          "insurance_supplement_measurement",
        );
      }
      const verifiedEvidence = await assertInsuranceSupplementEvidence(
        config,
        args.roof_job_id,
        patch.evidence,
      );
      const safeBefore = summarizeInsuranceSupplement(before);
      const safeAfter = summarizeInsuranceSupplement({ ...before, ...patch });
      const dryRun = {
        target: { doctype: "Insurance Supplement", name: args.insurance_supplement_id },
        before: safeBefore,
        patch: {
          measurement_report_linked: Boolean(patch.measurement_report),
          ...summarizeInsuranceEvidenceRows(verifiedEvidence),
        },
      };
      const now = new Date().toISOString();
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_set_insurance_supplement_evidence",
        target: { doctype: "Insurance Supplement", name: args.insurance_supplement_id },
        roofJob: args.roof_job_id,
        dryRun,
        beforeSummary: safeBefore,
        afterSummary: safeAfter,
        execute: async () => ({
          data: summarizeInsuranceSupplement(
            (await erpPut(
              config,
              resourcePath("Insurance Supplement", args.insurance_supplement_id),
              patch,
            ))?.data,
          ),
        }),
        responseExtra: { updated: true, insurance_supplement_id: args.insurance_supplement_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_insurance_supplement_transition",
    {
      title: "Dry Run Insurance Supplement Transition",
      description: "Preview an internal insurance evidence state transition. Submitted and response states only record a verified human artifact; no carrier decision or external send occurs.",
      inputSchema: InsuranceSupplementTransitionInputSchema,
    },
    async (args) => {
      const before = await readResource(config, "Insurance Supplement", args.insurance_supplement_id);
      assertLinkedRoofJob(args.roof_job_id, before, "insurance_supplement");
      const evidenceManifest = await insuranceEvidenceManifestFromRecord(config, before);
      const patch = buildInsuranceSupplementTransitionPatch(
        before,
        args.next_status,
        args.reason,
        undefined,
        undefined,
        args.next_status === "Approved for Submission" ? evidenceManifest : undefined,
        args.resolution_summary,
      );
      return text({
        would_write: false,
        required_tool: "request_transition_insurance_supplement",
        target: { doctype: "Insurance Supplement", name: args.insurance_supplement_id },
        before: summarizeInsuranceSupplement(before),
        patch: summarizeInsuranceSupplement({ ...before, ...patch }),
        verified_evidence: summarizeInsuranceEvidenceRows(
          before.evidence ?? [],
        ),
      });
    },
  );

  server.registerTool(
    "request_transition_insurance_supplement",
    {
      title: "Request Transition Insurance Supplement",
      description: "Approved-write: record a reviewed internal insurance evidence state transition and audit it. It cannot submit to a carrier, decide coverage, or alter commercial amounts.",
      inputSchema: approvedWriteInputSchema(InsuranceSupplementTransitionInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const before = await readResource(config, "Insurance Supplement", args.insurance_supplement_id);
      assertLinkedRoofJob(args.roof_job_id, before, "insurance_supplement");
      const evidenceManifest = await insuranceEvidenceManifestFromRecord(config, before);
      const patch = buildInsuranceSupplementTransitionPatch(
        before,
        args.next_status,
        args.reason,
        args.approved_by,
        now,
        args.next_status === "Approved for Submission" ? evidenceManifest : undefined,
        args.resolution_summary,
      );
      const safeBefore = summarizeInsuranceSupplement(before);
      const safeAfter = summarizeInsuranceSupplement({ ...before, ...patch });
      const dryRun = {
        target: { doctype: "Insurance Supplement", name: args.insurance_supplement_id },
        before: safeBefore,
        patch: safeAfter,
        verified_evidence: summarizeInsuranceEvidenceRows(before.evidence ?? []),
      };
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_transition_insurance_supplement",
        target: { doctype: "Insurance Supplement", name: args.insurance_supplement_id },
        roofJob: args.roof_job_id,
        dryRun,
        beforeSummary: safeBefore,
        afterSummary: safeAfter,
        execute: async () => ({
          data: summarizeInsuranceSupplement(
            (await erpPut(
              config,
              resourcePath("Insurance Supplement", args.insurance_supplement_id),
              patch,
            ))?.data,
          ),
        }),
        responseExtra: { updated: true, insurance_supplement_id: args.insurance_supplement_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_safety_plan",
    {
      title: "Dry Run Safety Plan",
      description: "Preview one append-only Safety Plan. Ready plans require evidence and approval; corrections supersede history.",
      inputSchema: SafetyPlanInputSchema,
    },
    async (args) => {
      const now = new Date().toISOString();
      const draft = safetyPlanDraftFromArgs(args, now);
      if (args.evidence_item_id) {
        await assertLinkedResourceForJob(
          config,
          "Evidence Item",
          args.evidence_item_id,
          args.roof_job_id,
          "safety_plan_evidence",
          { proofSlots: ["Safety"] },
        );
      }
      if (args.supersedes) {
        const prior = await assertLinkedResourceForJob(
          config,
          "Safety Plan",
          args.supersedes,
          args.roof_job_id,
          "superseded_safety_plan",
        );
        if ((prior.safety_plan_id ?? prior.name) === draft.safety_plan_id) {
          throw new Error("safety_plan_correction_requires_new_id");
        }
        assertCorrectionVersion(draft, prior, "safety_plan_correction");
      }
      const before = await readResourceOrNull(config, "Safety Plan", draft.safety_plan_id);
      return text({
        would_write: false,
        required_tool: "request_create_safety_plan",
        target: { doctype: "Safety Plan", name: draft.safety_plan_id },
        append_only: true,
        blocked_existing: Boolean(before),
        ...(before ? { blocked_reason: "safety_plan_append_only" } : {}),
        draft,
      });
    },
  );

  server.registerTool(
    "request_create_safety_plan",
    {
      title: "Request Create Safety Plan",
      description: "Approved-write: append one Draft or evidence-backed Ready Safety Plan and record a Hermes Run.",
      inputSchema: approvedWriteInputSchema(SafetyPlanInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const draft = safetyPlanDraftFromArgs(args, now);
      if (draft.status === "Ready") {
        draft.approved_by = args.approved_by;
        draft.approved_at = now;
      }
      if (args.evidence_item_id) {
        await assertLinkedResourceForJob(
          config,
          "Evidence Item",
          args.evidence_item_id,
          args.roof_job_id,
          "safety_plan_evidence",
          { proofSlots: ["Safety"] },
        );
      }
      if (args.supersedes) {
        const prior = await assertLinkedResourceForJob(
          config,
          "Safety Plan",
          args.supersedes,
          args.roof_job_id,
          "superseded_safety_plan",
        );
        if ((prior.safety_plan_id ?? prior.name) === draft.safety_plan_id) {
          throw new Error("safety_plan_correction_requires_new_id");
        }
        assertCorrectionVersion(draft, prior, "safety_plan_correction");
      }
      const before = await readResourceOrNull(config, "Safety Plan", draft.safety_plan_id);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_create_safety_plan",
        target: { doctype: "Safety Plan", name: draft.safety_plan_id },
        roofJob: args.roof_job_id,
        linkedEvidence: args.evidence_item_id,
        dryRun: {
          target: { doctype: "Safety Plan", name: draft.safety_plan_id },
          operation: before ? "blocked_existing" : "create",
          append_only: true,
          draft,
        },
        beforeSummary: summarizeRecord(before, ["name", "safety_plan_id", "roof_job", "version", "status"]),
        afterSummary: summarizeRecord(draft, ["safety_plan_id", "roof_job", "version", "status", "evidence_item"]),
        execute: createOnlyExecutor(
          config,
          "Safety Plan",
          before,
          draft,
          "safety_plan_append_only",
        ),
        responseExtra: { created: true, safety_plan_id: draft.safety_plan_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_safety_acknowledgement",
    {
      title: "Dry Run Safety Acknowledgement",
      description: "Preview one evidence-backed safety acknowledgement. The Frappe atomic command derives the actor's role from the locked active assignment; only QR pairing, e-signature, or in-person evidence is accepted.",
      inputSchema: SafetyAcknowledgementInputSchema,
    },
    async (args) => {
      const now = new Date().toISOString();
      const [safetyPlan] = await Promise.all([
        readResource(config, "Safety Plan", args.safety_plan_id),
        assertLinkedResourceForJob(
          config,
          "Evidence Item",
          args.evidence_item_id,
          args.roof_job_id,
          "safety_acknowledgement_evidence",
          safetyAcknowledgementEvidencePolicy(args.acknowledgement_method),
        ),
      ]);
      const patch = buildSafetyAcknowledgementPatch({
        safetyPlan,
        roofJobId: args.roof_job_id,
        acknowledgedBy: args.acknowledged_by,
        acknowledgementMethod: args.acknowledgement_method,
        deviceActionId: args.device_action_id,
        evidenceItemId: args.evidence_item_id,
        roleOnJob: undefined,
        notes: args.notes,
        nowIso: now,
      });
      return text({
        would_write: false,
        required_tool: "request_record_safety_acknowledgement",
        target: { doctype: "Safety Plan", name: args.safety_plan_id },
        before: summarizeRecord(safetyPlan, ["name", "safety_plan_id", "roof_job", "status"]),
        patch,
      });
    },
  );

  server.registerTool(
    "request_record_safety_acknowledgement",
    {
      title: "Request Record Safety Acknowledgement",
      description: "Approved-write: invoke the atomic Frappe acknowledgement command. It locks the plan, derives active assignment role, rejects generic child-table replacement, and audits the result.",
      inputSchema: approvedWriteInputSchema(SafetyAcknowledgementInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const [safetyPlan] = await Promise.all([
        readResource(config, "Safety Plan", args.safety_plan_id),
        assertLinkedResourceForJob(
          config,
          "Evidence Item",
          args.evidence_item_id,
          args.roof_job_id,
          "safety_acknowledgement_evidence",
          safetyAcknowledgementEvidencePolicy(args.acknowledgement_method),
        ),
      ]);
      const patch = buildSafetyAcknowledgementPatch({
        safetyPlan,
        roofJobId: args.roof_job_id,
        acknowledgedBy: args.acknowledged_by,
        acknowledgementMethod: args.acknowledgement_method,
        deviceActionId: args.device_action_id,
        evidenceItemId: args.evidence_item_id,
        roleOnJob: undefined,
        notes: args.notes,
        nowIso: now,
      });
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_record_safety_acknowledgement",
        target: { doctype: "Safety Plan", name: args.safety_plan_id },
        roofJob: args.roof_job_id,
        linkedEvidence: args.evidence_item_id,
        dryRun: {
          target: { doctype: "Safety Plan", name: args.safety_plan_id },
          before: summarizeRecord(safetyPlan, ["name", "safety_plan_id", "roof_job", "status"]),
          patch,
        },
        beforeSummary: {
          ...summarizeRecord(safetyPlan, ["name", "safety_plan_id", "roof_job", "status"]),
          acknowledgement_count: Array.isArray(safetyPlan.acknowledgements)
            ? safetyPlan.acknowledgements.length
            : 0,
        },
        afterSummary: {
          ...summarizeRecord({ ...safetyPlan, ...patch }, [
            "name",
            "safety_plan_id",
            "roof_job",
            "status",
          ]),
          acknowledgement_count: patch.acknowledgements.length,
        },
        execute: () => erpPost(
          config,
          "/api/method/ironwrap_roofing.safety_acknowledgement_api.append_safety_acknowledgement",
          {
            safety_plan_id: args.safety_plan_id,
            roof_job_id: args.roof_job_id,
            actor_user: config.actorUser,
            acknowledgement_method: args.acknowledgement_method,
            device_action_id: args.device_action_id,
            evidence_item_id: args.evidence_item_id,
            notes: args.notes ?? "",
          },
        ),
        responseExtra: {
          appended: true,
          safety_plan_id: args.safety_plan_id,
          acknowledgement_count: patch.acknowledgements.length,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_authority_record",
    {
      title: "Dry Run Authority Record",
      description: "Preview one tenant-scoped Authority Record record, verification, renewal, revocation, or exception resolution without writing.",
      inputSchema: AuthorityRecordInputSchema,
    },
    async (args) => {
      const before = args.authority_operation === "record"
        ? null
        : await readResourceOrNull(config, "Authority Record", args.authority_record_id);
      const draft = authorityRecordDraftFromArgs(config, args, before, new Date().toISOString());
      if (args.roof_job_id && draft.roof_job && draft.roof_job !== args.roof_job_id) {
        throw new Error("authority_record_roof_job_mismatch");
      }
      assertIssuerReceiptForDraft(config, draft, args.issuer_receipt);
      return text({
        would_write: false,
        required_tool: "request_authority_record",
        target: { doctype: "Authority Record", name: draft.authority_record_id },
        operation: args.authority_operation,
        before: summarizeRecord(before, [
          "name", "authority_record_id", "tenant", "authority_kind", "scope_type", "scope_ref", "version", "status",
          "issuer_name", "issuer_jurisdiction", "issuer_reference", "evidence_sha256", "supersedes",
        ]),
        draft: summarizeRecord(draft, AUTHORITY_RECORD_FIELDS),
      });
    },
  );

  server.registerTool(
    "request_authority_record",
    {
      title: "Request Authority Record Mutation",
      description: "Approved-write: record or change one tenant-scoped Authority Record while preserving issuer evidence, immutable version history, and Hermes audit proof.",
      inputSchema: approvedWriteInputSchema(AuthorityRecordInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const before = args.authority_operation === "record"
        ? null
        : await readResourceOrNull(config, "Authority Record", args.authority_record_id);
      const draft = authorityRecordDraftFromArgs(config, args, before, now);
      if (args.roof_job_id && draft.roof_job && draft.roof_job !== args.roof_job_id) {
        throw new Error("authority_record_roof_job_mismatch");
      }
      assertIssuerReceiptForDraft(config, draft, args.issuer_receipt);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_authority_record",
        target: { doctype: "Authority Record", name: draft.authority_record_id },
        roofJob: draft.roof_job || undefined,
        dryRun: {
          target: { doctype: "Authority Record", name: draft.authority_record_id },
          operation: args.authority_operation,
          before: summarizeRecord(before, ["name", "authority_record_id", "version", "status"]),
          draft: summarizeRecord(draft, AUTHORITY_RECORD_FIELDS),
        },
        beforeSummary: summarizeRecord(before, [
          "name", "authority_record_id", "version", "status", "issuer_reference", "evidence_sha256",
        ]),
        afterSummary: summarizeRecord(draft, [
          "authority_record_id", "tenant", "authority_kind", "scope_type", "scope_ref", "version", "status",
          "issuer_reference", "evidence_sha256", "supersedes", "exception_status",
        ]),
        execute: () => executeAuthorityRecordMutation(config, { args, draft, before, now }),
        responseExtra: {
          upserted: true,
          operation: args.authority_operation,
          authority_record_id: draft.authority_record_id,
          version: draft.version,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_job_compliance_record",
    {
      title: "Dry Run Job Compliance Record",
      description: "Preview one evidence-gated Job Compliance Record create or legal status transition without writing.",
      inputSchema: JobComplianceRecordInputSchema,
    },
    async (args) => {
      const now = new Date().toISOString();
      const draft = complianceDraftFromArgs(args, now);
      if (args.evidence_item_id) {
        await assertLinkedResourceForJob(
          config,
          "Evidence Item",
          args.evidence_item_id,
          args.roof_job_id,
          "compliance_evidence",
          { proofSlots: ["Access", "Safety", "Materials", "Completion", "Other"] },
        );
      }
      if (args.supersedes) {
        const prior = await assertLinkedResourceForJob(
          config,
          "Job Compliance Record",
          args.supersedes,
          args.roof_job_id,
          "superseded_compliance_record",
        );
        if ((prior.compliance_record_id ?? prior.name) === draft.compliance_record_id) {
          throw new Error("compliance_correction_requires_new_id");
        }
      }
      const before = await readResourceOrNull(
        config,
        "Job Compliance Record",
        draft.compliance_record_id,
      );
      if (before) {
        assertLinkedRoofJob(args.roof_job_id, before, "compliance_record");
        assertComplianceTransition(before.status, draft.status);
        assertImmutableFields(
          before,
          draft,
          ["roof_job", "jurisdiction", "record_type", "authority_name", "required_before_gate"],
          "compliance_record",
        );
      }
      return text({
        would_write: false,
        required_tool: "request_record_job_compliance",
        target: { doctype: "Job Compliance Record", name: draft.compliance_record_id },
        operation: before ? "update_status" : "create",
        before: summarizeRecord(before, [
          "name",
          "compliance_record_id",
          "roof_job",
          "status",
          "required_before_gate",
        ]),
        draft,
      });
    },
  );

  server.registerTool(
    "request_record_job_compliance",
    {
      title: "Request Record Job Compliance",
      description: "Approved-write: create or transition one evidence-gated compliance record and record a Hermes Run.",
      inputSchema: approvedWriteInputSchema(JobComplianceRecordInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const draft = complianceDraftFromArgs(args, now);
      if (args.evidence_item_id) {
        await assertLinkedResourceForJob(
          config,
          "Evidence Item",
          args.evidence_item_id,
          args.roof_job_id,
          "compliance_evidence",
          { proofSlots: ["Access", "Safety", "Materials", "Completion", "Other"] },
        );
      }
      if (args.supersedes) {
        const prior = await assertLinkedResourceForJob(
          config,
          "Job Compliance Record",
          args.supersedes,
          args.roof_job_id,
          "superseded_compliance_record",
        );
        if ((prior.compliance_record_id ?? prior.name) === draft.compliance_record_id) {
          throw new Error("compliance_correction_requires_new_id");
        }
      }
      const before = await readResourceOrNull(
        config,
        "Job Compliance Record",
        draft.compliance_record_id,
      );
      if (before) {
        assertLinkedRoofJob(args.roof_job_id, before, "compliance_record");
        assertComplianceTransition(before.status, draft.status);
        assertImmutableFields(
          before,
          draft,
          ["roof_job", "jurisdiction", "record_type", "authority_name", "required_before_gate"],
          "compliance_record",
        );
      }
      const operation = before ? "update_status" : "create";
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_record_job_compliance",
        target: { doctype: "Job Compliance Record", name: draft.compliance_record_id },
        roofJob: args.roof_job_id,
        linkedEvidence: args.evidence_item_id,
        dryRun: {
          target: { doctype: "Job Compliance Record", name: draft.compliance_record_id },
          operation,
          before: summarizeRecord(before, [
            "name",
            "compliance_record_id",
            "roof_job",
            "status",
            "required_before_gate",
          ]),
          draft,
        },
        beforeSummary: summarizeRecord(before, [
          "name",
          "compliance_record_id",
          "roof_job",
          "status",
          "required_before_gate",
        ]),
        afterSummary: summarizeRecord(draft, [
          "compliance_record_id",
          "roof_job",
          "status",
          "required_before_gate",
          "evidence_item",
        ]),
        execute: before
          ? () => erpPut(config, resourcePath("Job Compliance Record", draft.compliance_record_id), draft)
          : () => erpPost(config, "/api/resource/Job%20Compliance%20Record", draft),
        responseExtra: {
          upserted: true,
          operation,
          compliance_record_id: draft.compliance_record_id,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_customer_decision",
    {
      title: "Dry Run Customer Decision",
      description: "Preview an append-only evidence-backed Customer Decision record. It cannot sign or accept a contract.",
      inputSchema: CustomerDecisionInputSchema,
    },
    async (args) => {
      const draft = customerDecisionDraftFromArgs(args);
      assertRoofJobCustomer(
        await readResource(config, "Roof Job", args.roof_job_id),
        args.customer_id,
      );
      await assertLinkedResourceForJob(
        config,
        "Evidence Item",
        args.evidence_item_id,
        args.roof_job_id,
        "customer_decision_evidence",
        customerDecisionEvidencePolicy(args.decision_type),
      );
      if (args.option_package_id) {
        await assertLinkedResourceForJob(
          config,
          "Option Package",
          args.option_package_id,
          args.roof_job_id,
          "option_package",
        );
      }
      if (args.change_order_id) {
        await assertLinkedResourceForJob(
          config,
          "Change Order",
          args.change_order_id,
          args.roof_job_id,
          "change_order",
        );
      }
      if (args.supersedes) {
        const prior = await assertLinkedResourceForJob(
          config,
          "Customer Decision",
          args.supersedes,
          args.roof_job_id,
          "superseded_customer_decision",
        );
        if ((prior.decision_id ?? prior.name) === draft.decision_id) {
          throw new Error("customer_decision_correction_requires_new_id");
        }
      }
      const before = await readResourceOrNull(config, "Customer Decision", draft.decision_id);
      return text({
        would_write: false,
        required_tool: "request_record_customer_decision",
        target: { doctype: "Customer Decision", name: draft.decision_id },
        append_only: true,
        blocked_existing: Boolean(before),
        ...(before ? { blocked_reason: "customer_decision_append_only" } : {}),
        draft,
      });
    },
  );

  server.registerTool(
    "request_record_customer_decision",
    {
      title: "Request Record Customer Decision",
      description: "Approved-write: append evidence of a decision already made by a customer. It cannot accept, decline, or sign for them.",
      inputSchema: approvedWriteInputSchema(CustomerDecisionInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const draft = customerDecisionDraftFromArgs(args);
      assertRoofJobCustomer(
        await readResource(config, "Roof Job", args.roof_job_id),
        args.customer_id,
      );
      await assertLinkedResourceForJob(
        config,
        "Evidence Item",
        args.evidence_item_id,
        args.roof_job_id,
        "customer_decision_evidence",
        customerDecisionEvidencePolicy(args.decision_type),
      );
      if (args.option_package_id) {
        await assertLinkedResourceForJob(
          config,
          "Option Package",
          args.option_package_id,
          args.roof_job_id,
          "option_package",
        );
      }
      if (args.change_order_id) {
        await assertLinkedResourceForJob(
          config,
          "Change Order",
          args.change_order_id,
          args.roof_job_id,
          "change_order",
        );
      }
      if (args.supersedes) {
        const prior = await assertLinkedResourceForJob(
          config,
          "Customer Decision",
          args.supersedes,
          args.roof_job_id,
          "superseded_customer_decision",
        );
        if ((prior.decision_id ?? prior.name) === draft.decision_id) {
          throw new Error("customer_decision_correction_requires_new_id");
        }
      }
      const before = await readResourceOrNull(config, "Customer Decision", draft.decision_id);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_record_customer_decision",
        target: { doctype: "Customer Decision", name: draft.decision_id },
        roofJob: args.roof_job_id,
        linkedEvidence: args.evidence_item_id,
        dryRun: {
          target: { doctype: "Customer Decision", name: draft.decision_id },
          operation: before ? "blocked_existing" : "create",
          append_only: true,
          draft,
        },
        beforeSummary: summarizeRecord(before, [
          "name",
          "decision_id",
          "roof_job",
          "status",
          "evidence_item",
        ]),
        afterSummary: summarizeRecord(draft, [
          "decision_id",
          "roof_job",
          "status",
          "decision_type",
          "evidence_item",
        ]),
        execute: createOnlyExecutor(
          config,
          "Customer Decision",
          before,
          draft,
          "customer_decision_append_only",
        ),
        responseExtra: { created: true, decision_id: draft.decision_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_communication_consent",
    {
      title: "Dry Run Communication Consent",
      description: "Preview one append-only consent evidence record. No customer communication is sent.",
      inputSchema: CommunicationConsentInputSchema,
    },
    async (args) => {
      const draft = communicationConsentDraftFromArgs(args);
      if (args.roof_job_id && args.customer_id) {
        assertRoofJobCustomer(
          await readResource(config, "Roof Job", args.roof_job_id),
          args.customer_id,
        );
      }
      if (args.proof_evidence_id) {
        if (args.roof_job_id) {
          await assertLinkedResourceForJob(
            config,
            "Evidence Item",
            args.proof_evidence_id,
            args.roof_job_id,
            "consent_evidence",
            consentEvidencePolicy(args),
          );
        } else {
          await assertVerifiedEvidenceResource(
            config,
            args.proof_evidence_id,
            "consent_evidence",
            consentEvidencePolicy(args),
          );
        }
      }
      if (args.supersedes) {
        const prior = await readResource(config, "Communication Consent", args.supersedes);
        assertConsentLineage(prior, args);
        if ((prior.consent_id ?? prior.name) === draft.consent_id) {
          throw new Error("communication_consent_correction_requires_new_id");
        }
      }
      const before = await readResourceOrNull(config, "Communication Consent", draft.consent_id);
      return text({
        would_write: false,
        required_tool: "request_record_communication_consent",
        target: { doctype: "Communication Consent", name: draft.consent_id },
        append_only: true,
        sends_message: false,
        blocked_existing: Boolean(before),
        ...(before ? { blocked_reason: "communication_consent_append_only" } : {}),
        draft,
      });
    },
  );

  server.registerTool(
    "request_record_communication_consent",
    {
      title: "Request Record Communication Consent",
      description: "Approved-write: append one consent evidence record and audit it. This tool never sends a message.",
      inputSchema: approvedWriteInputSchema(CommunicationConsentInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const draft = communicationConsentDraftFromArgs(args);
      if (args.roof_job_id && args.customer_id) {
        assertRoofJobCustomer(
          await readResource(config, "Roof Job", args.roof_job_id),
          args.customer_id,
        );
      }
      if (args.proof_evidence_id) {
        if (args.roof_job_id) {
          await assertLinkedResourceForJob(
            config,
            "Evidence Item",
            args.proof_evidence_id,
            args.roof_job_id,
            "consent_evidence",
            consentEvidencePolicy(args),
          );
        } else {
          await assertVerifiedEvidenceResource(
            config,
            args.proof_evidence_id,
            "consent_evidence",
            consentEvidencePolicy(args),
          );
        }
      }
      if (args.supersedes) {
        const prior = await readResource(config, "Communication Consent", args.supersedes);
        assertConsentLineage(prior, args);
        if ((prior.consent_id ?? prior.name) === draft.consent_id) {
          throw new Error("communication_consent_correction_requires_new_id");
        }
      }
      const before = await readResourceOrNull(config, "Communication Consent", draft.consent_id);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_record_communication_consent",
        target: { doctype: "Communication Consent", name: draft.consent_id },
        roofJob: args.roof_job_id,
        leadEnvelope: args.lead_envelope_id,
        linkedEvidence: args.proof_evidence_id,
        dryRun: {
          target: { doctype: "Communication Consent", name: draft.consent_id },
          operation: before ? "blocked_existing" : "create",
          append_only: true,
          sends_message: false,
          draft,
        },
        beforeSummary: summarizeRecord(before, [
          "name",
          "consent_id",
          "roof_job",
          "channel",
          "purpose",
          "status",
        ]),
        afterSummary: summarizeRecord(draft, [
          "consent_id",
          "roof_job",
          "channel",
          "purpose",
          "status",
          "proof_evidence",
        ]),
        execute: createOnlyExecutor(
          config,
          "Communication Consent",
          before,
          draft,
          "communication_consent_append_only",
        ),
        responseExtra: { created: true, consent_id: draft.consent_id, sends_message: false },
      }));
    },
  );

  server.registerTool(
    "dry_run_reconciliation_resolution",
    {
      title: "Dry Run Reconciliation Resolution",
      description: "Preview an evidence-backed reconciliation resolution record. No accounting or external system is mutated.",
      inputSchema: ReconciliationResolutionInputSchema,
    },
    async (args) => {
      const reconciliation = await readResource(
        config,
        "Integration Reconciliation",
        args.reconciliation_id,
      );
      if (args.roof_job_id) {
        assertLinkedRoofJob(args.roof_job_id, reconciliation, "integration_reconciliation");
      }
      if (reconciliation.roof_job) {
        await assertLinkedResourceForJob(
          config,
          "Evidence Item",
          args.resolution_evidence_id,
          reconciliation.roof_job,
          "reconciliation_resolution_evidence",
          { proofSlots: ["Payment"], evidenceTypes: ["Invoice", "PDF", "Email"] },
        );
      } else {
        await assertVerifiedEvidenceResource(
          config,
          args.resolution_evidence_id,
          "reconciliation_resolution_evidence",
          { proofSlots: ["Payment"], evidenceTypes: ["Invoice", "PDF", "Email"] },
        );
      }
      const patch = buildReconciliationResolutionPatch(reconciliation, {
        nextStatus: args.next_status,
        resolutionAction: args.resolution_action,
        resolutionEvidenceId: args.resolution_evidence_id,
        resolvedBy: "dry-run",
        notes: args.notes,
        nowIso: new Date().toISOString(),
      });
      return text({
        would_write: false,
        required_tool: "request_resolve_reconciliation",
        target: {
          doctype: "Integration Reconciliation",
          name: args.reconciliation_id,
        },
        accounting_mutation: false,
        external_system_mutation: false,
        before: summarizeRecord(reconciliation, [
          "name",
          "reconciliation_id",
          "roof_job",
          "system_name",
          "entity_type",
          "status",
        ]),
        patch,
      });
    },
  );

  server.registerTool(
    "request_resolve_reconciliation",
    {
      title: "Request Resolve Reconciliation",
      description: "Approved-write: record an evidence-backed reconciliation resolution and Hermes Run. No accounting or external system is mutated.",
      inputSchema: approvedWriteInputSchema(ReconciliationResolutionInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const reconciliation = await readResource(
        config,
        "Integration Reconciliation",
        args.reconciliation_id,
      );
      if (args.roof_job_id) {
        assertLinkedRoofJob(args.roof_job_id, reconciliation, "integration_reconciliation");
      }
      if (reconciliation.roof_job) {
        await assertLinkedResourceForJob(
          config,
          "Evidence Item",
          args.resolution_evidence_id,
          reconciliation.roof_job,
          "reconciliation_resolution_evidence",
          { proofSlots: ["Payment"], evidenceTypes: ["Invoice", "PDF", "Email"] },
        );
      } else {
        await assertVerifiedEvidenceResource(
          config,
          args.resolution_evidence_id,
          "reconciliation_resolution_evidence",
          { proofSlots: ["Payment"], evidenceTypes: ["Invoice", "PDF", "Email"] },
        );
      }
      const patch = buildReconciliationResolutionPatch(reconciliation, {
        nextStatus: args.next_status,
        resolutionAction: args.resolution_action,
        resolutionEvidenceId: args.resolution_evidence_id,
        resolvedBy: args.approved_by,
        notes: args.notes,
        nowIso: now,
      });
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_resolve_reconciliation",
        target: {
          doctype: "Integration Reconciliation",
          name: args.reconciliation_id,
        },
        roofJob: reconciliation.roof_job,
        linkedEvidence: args.resolution_evidence_id,
        dryRun: {
          target: {
            doctype: "Integration Reconciliation",
            name: args.reconciliation_id,
          },
          operation: "record_resolution",
          accounting_mutation: false,
          external_system_mutation: false,
          before: summarizeRecord(reconciliation, [
            "name",
            "reconciliation_id",
            "roof_job",
            "system_name",
            "entity_type",
            "status",
          ]),
          patch,
        },
        beforeSummary: summarizeRecord(reconciliation, [
          "name",
          "reconciliation_id",
          "roof_job",
          "system_name",
          "entity_type",
          "status",
          "attempt_count",
        ]),
        afterSummary: summarizeRecord({ ...reconciliation, ...patch }, [
          "name",
          "reconciliation_id",
          "roof_job",
          "system_name",
          "entity_type",
          "status",
          "attempt_count",
          "resolution_evidence",
        ]),
        execute: () => erpPut(
          config,
          resourcePath("Integration Reconciliation", args.reconciliation_id),
          patch,
        ),
        responseExtra: {
          updated: true,
          reconciliation_id: args.reconciliation_id,
          accounting_mutation: false,
          external_system_mutation: false,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_tenant_export",
    {
      title: "Dry Run Tenant Export Request",
      description: "Preview an append-only Tenant Export Run request. This tool does not build or expose an archive.",
      inputSchema: TenantExportInputSchema,
    },
    async (args) => {
      const tenant = await readResource(config, "White-Label Tenant", args.tenant_id);
      if ((tenant.tenant_id ?? tenant.name) !== args.tenant_id) {
        throw new Error("tenant_export_tenant_mismatch");
      }
      if (args.supersedes) {
        const prior = await readResource(config, "Tenant Export Run", args.supersedes);
        if (prior.tenant !== args.tenant_id) throw new Error("tenant_export_supersedes_tenant_mismatch");
        if ((prior.export_run_id ?? prior.name) === args.export_run_id) {
          throw new Error("tenant_export_correction_requires_new_id");
        }
      }
      const draft = buildTenantExportRequestDraft({
        exportRunId: args.export_run_id,
        tenantId: args.tenant_id,
        scope: args.scope,
        requestedBy: "dry-run",
        supersedes: args.supersedes,
        correctionReason: args.correction_reason,
        notes: args.notes,
        nowIso: new Date().toISOString(),
        runId: "dry-run-preview",
      });
      const before = await readResourceOrNull(config, "Tenant Export Run", draft.export_run_id);
      return text({
        would_write: false,
        required_tool: "request_tenant_export",
        target: { doctype: "Tenant Export Run", name: draft.export_run_id },
        append_only: true,
        archive_created: false,
        blocked_existing: Boolean(before),
        ...(before ? { blocked_reason: "tenant_export_request_append_only" } : {}),
        draft,
      });
    },
  );

  server.registerTool(
    "request_tenant_export",
    {
      title: "Request Tenant Export",
      description: "Approved-write: append one audited Tenant Export Run in Requested state. A separate worker must produce the encrypted archive.",
      inputSchema: approvedWriteInputSchema(TenantExportInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const tenant = await readResource(config, "White-Label Tenant", args.tenant_id);
      if ((tenant.tenant_id ?? tenant.name) !== args.tenant_id) {
        throw new Error("tenant_export_tenant_mismatch");
      }
      if (args.supersedes) {
        const prior = await readResource(config, "Tenant Export Run", args.supersedes);
        if (prior.tenant !== args.tenant_id) throw new Error("tenant_export_supersedes_tenant_mismatch");
        if ((prior.export_run_id ?? prior.name) === args.export_run_id) {
          throw new Error("tenant_export_correction_requires_new_id");
        }
      }
      const draft = buildTenantExportRequestDraft({
        exportRunId: args.export_run_id,
        tenantId: args.tenant_id,
        scope: args.scope,
        requestedBy: args.approved_by,
        supersedes: args.supersedes,
        correctionReason: args.correction_reason,
        notes: args.notes,
        nowIso: now,
        runId: args.run_id,
      });
      const before = await readResourceOrNull(config, "Tenant Export Run", draft.export_run_id);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_tenant_export",
        target: { doctype: "Tenant Export Run", name: draft.export_run_id },
        dryRun: {
          target: { doctype: "Tenant Export Run", name: draft.export_run_id },
          operation: before ? "blocked_existing" : "create_request",
          append_only: true,
          archive_created: false,
          draft,
        },
        beforeSummary: summarizeRecord(before, [
          "name",
          "export_run_id",
          "tenant",
          "status",
          "requested_at",
        ]),
        afterSummary: summarizeRecord(draft, [
          "export_run_id",
          "tenant",
          "status",
          "requested_at",
          "supersedes",
        ]),
        execute: createOnlyExecutor(
          config,
          "Tenant Export Run",
          before,
          draft,
          "tenant_export_request_append_only",
        ),
        responseExtra: {
          created: true,
          export_run_id: draft.export_run_id,
          archive_created: false,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_completion_packet",
    {
      title: "Dry Run Completion Packet",
      description: "Preview a review-gated Completion Packet assembled from field check-ins and photo evidence without writing.",
      inputSchema: {
        roof_job_id: z.string().min(1),
        completion_packet_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ roof_job_id, completion_packet_id, limit = 25 }) => {
      const { draft, checkIns, evidence } = await buildCompletionPacketDraftFromErp(config, roof_job_id, {
        packetId: completion_packet_id,
        limit,
      });
      return text({
        would_write: false,
        required_tool: "request_create_completion_packet",
        target: { doctype: "Completion Packet", name: draft.completion_packet_id },
        source_counts: { field_check_ins: checkIns.length, evidence_items: evidence.length },
        draft,
      });
    },
  );

  server.registerTool(
    "request_create_completion_packet",
    {
      title: "Request Create Completion Packet",
      description: "Approved-write: create or update one review-gated Completion Packet and record a Hermes Run audit row.",
      inputSchema: {
        roof_job_id: z.string().min(1),
        completion_packet_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        run_id: z.string().min(8).max(128),
        dry_run_receipt: z.string().min(32).max(4096),
        approval_receipt: z.string().min(32).max(8192),
      },
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const { draft, checkIns, evidence } = await buildCompletionPacketDraftFromErp(config, args.roof_job_id, {
        packetId: args.completion_packet_id,
        limit: args.limit ?? 25,
        nowIso: now,
      });
      const before = await readResourceOrNull(config, "Completion Packet", draft.completion_packet_id);
      const operation = before ? "update" : "create";
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_create_completion_packet",
        target: { doctype: "Completion Packet", name: draft.completion_packet_id },
        roofJob: args.roof_job_id,
        dryRun: {
          target: { doctype: "Completion Packet", name: draft.completion_packet_id },
          operation,
          source_counts: { field_check_ins: checkIns.length, evidence_items: evidence.length },
          draft,
        },
        beforeSummary: summarizeCompletionPacket(before),
        afterSummary: summarizeCompletionPacket({ ...(before ?? {}), ...draft, name: draft.completion_packet_id }),
        // The field role is scoped by a mutable Job Assignment. Re-check it in
        // the executor, immediately before the mutation, so a revocation after
        // the request-level authorization cannot produce a completion packet.
        execute: fieldAssignmentBoundUpsertExecutor(
          config,
          args.roof_job_id,
          "Completion Packet",
          draft.completion_packet_id,
          draft,
          before,
        ),
        responseExtra: { upserted: true, operation, completion_packet_id: draft.completion_packet_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_warranty_packet",
    {
      title: "Dry Run Warranty Packet",
      description: "Preview a Warranty Packet draft from an approved, warranty-ready Completion Packet without writing.",
      inputSchema: {
        completion_packet_id: z.string().min(1),
        warranty_packet_id: z.string().min(1).optional(),
        material_system: z.string().max(200).optional(),
        warranty_terms: z.string().max(4000).optional(),
        coverage_start: z.string().optional(),
        coverage_years: z.number().int().min(0).max(100).optional(),
      },
    },
    async ({ completion_packet_id, warranty_packet_id, material_system, warranty_terms, coverage_start, coverage_years }) => {
      const completionPacket = await readResource(config, "Completion Packet", completion_packet_id);
      const draft = buildWarrantyPacketDraft({
        completionPacket,
        packetId: warranty_packet_id,
        materialSystem: material_system,
        warrantyTerms: warranty_terms,
        coverageStart: coverage_start,
        coverageYears: coverage_years,
      });
      return text({
        would_write: false,
        required_tool: "request_create_warranty_packet",
        target: { doctype: "Warranty Packet", name: draft.warranty_packet_id },
        draft,
      });
    },
  );

  server.registerTool(
    "request_create_warranty_packet",
    {
      title: "Request Create Warranty Packet",
      description: "Approved-write: create or update one Warranty Packet draft and record a Hermes Run audit row.",
      inputSchema: {
        completion_packet_id: z.string().min(1),
        warranty_packet_id: z.string().min(1).optional(),
        material_system: z.string().max(200).optional(),
        warranty_terms: z.string().max(4000).optional(),
        coverage_start: z.string().optional(),
        coverage_years: z.number().int().min(0).max(100).optional(),
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        run_id: z.string().min(8).max(128),
        dry_run_receipt: z.string().min(32).max(4096),
        approval_receipt: z.string().min(32).max(8192),
      },
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const completionPacket = await readResource(config, "Completion Packet", args.completion_packet_id);
      const draft = buildWarrantyPacketDraft({
        completionPacket,
        packetId: args.warranty_packet_id,
        materialSystem: args.material_system,
        warrantyTerms: args.warranty_terms,
        coverageStart: args.coverage_start,
        coverageYears: args.coverage_years,
        nowIso: now,
      });
      const before = await readResourceOrNull(config, "Warranty Packet", draft.warranty_packet_id);
      const operation = before ? "update" : "create";
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_create_warranty_packet",
        target: { doctype: "Warranty Packet", name: draft.warranty_packet_id },
        roofJob: draft.roof_job,
        dryRun: { target: { doctype: "Warranty Packet", name: draft.warranty_packet_id }, operation, draft },
        beforeSummary: summarizeWarrantyPacket(before),
        afterSummary: summarizeWarrantyPacket({ ...(before ?? {}), ...draft, name: draft.warranty_packet_id }),
        execute: upsertDraftExecutor(config, "Warranty Packet", draft.warranty_packet_id, draft, before),
        responseExtra: { upserted: true, operation, warranty_packet_id: draft.warranty_packet_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_review_request",
    {
      title: "Dry Run Review Request",
      description: "Preview a Review Request with deterministic stop conditions (completion, payment evidence, consent) without writing.",
      inputSchema: {
        roof_job_id: z.string().min(1),
        review_request_id: z.string().min(1).optional(),
        consent_basis: z.string().optional(),
        channel: z.enum(["Google", "Email", "SMS", "Other"]).optional(),
        review_link: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ roof_job_id, review_request_id, consent_basis, channel, review_link, limit = 25 }) => {
      const { draft, completionPacket, paymentMilestones } = await buildReviewRequestDraftFromErp(config, roof_job_id, {
        requestId: review_request_id,
        consentBasis: consent_basis,
        channel,
        reviewLink: review_link,
        limit,
      });
      return text({
        would_write: false,
        required_tool: "request_create_review_request",
        target: { doctype: "Review Request", name: draft.review_request_id },
        source: {
          completion_packet: completionPacket?.completion_packet_id ?? completionPacket?.name ?? null,
          payment_milestone_count: paymentMilestones.length,
        },
        draft,
      });
    },
  );

  server.registerTool(
    "request_create_review_request",
    {
      title: "Request Create Review Request",
      description: "Approved-write: record one Review Request (Eligible or Blocked, never Sent) and record a Hermes Run audit row.",
      inputSchema: {
        roof_job_id: z.string().min(1),
        review_request_id: z.string().min(1).optional(),
        consent_basis: z.string().optional(),
        channel: z.enum(["Google", "Email", "SMS", "Other"]).optional(),
        review_link: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        run_id: z.string().min(8).max(128),
        dry_run_receipt: z.string().min(32).max(4096),
        approval_receipt: z.string().min(32).max(8192),
      },
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const { draft, completionPacket, paymentMilestones } = await buildReviewRequestDraftFromErp(config, args.roof_job_id, {
        requestId: args.review_request_id,
        consentBasis: args.consent_basis,
        channel: args.channel,
        reviewLink: args.review_link,
        limit: args.limit ?? 25,
        nowIso: now,
      });
      const before = await readResourceOrNull(config, "Review Request", draft.review_request_id);
      const operation = before ? "update" : "create";
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_create_review_request",
        target: { doctype: "Review Request", name: draft.review_request_id },
        roofJob: args.roof_job_id,
        dryRun: {
          target: { doctype: "Review Request", name: draft.review_request_id },
          operation,
          source: {
            completion_packet: completionPacket?.completion_packet_id ?? completionPacket?.name ?? null,
            payment_milestone_count: paymentMilestones.length,
          },
          draft,
        },
        beforeSummary: summarizeReviewRequest(before),
        afterSummary: summarizeReviewRequest({ ...(before ?? {}), ...draft, name: draft.review_request_id }),
        execute: upsertDraftExecutor(config, "Review Request", draft.review_request_id, draft, before),
        responseExtra: { upserted: true, operation, review_request_id: draft.review_request_id, review_status: draft.status },
      }));
    },
  );

  server.registerTool(
    "dry_run_communication_event",
    {
      title: "Dry Run Communication Event",
      description: "Preview a policy-gated Communication Event record (consent plus quiet hours) without writing. Never sends anything.",
      inputSchema: communicationEventInputSchema(),
    },
    async (args) => {
      const draft = await buildCommunicationEventDraftFromArgs(args);
      return text({
        would_write: false,
        required_tool: "request_record_communication_event",
        target: { doctype: "Communication Event", name: draft.communication_event_id },
        policy_result: draft.policy_result,
        draft,
      });
    },
  );

  server.registerTool(
    "request_record_communication_event",
    {
      title: "Request Record Communication Event",
      description: "Approved-write: record one policy-gated Communication Event (Draft or Blocked, never Sent) and record a Hermes Run audit row. Sending remains a human action.",
      inputSchema: {
        ...communicationEventInputSchema(),
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        run_id: z.string().min(8).max(128),
        dry_run_receipt: z.string().min(32).max(4096),
        approval_receipt: z.string().min(32).max(8192),
      },
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const draft = await buildCommunicationEventDraftFromArgs(args, now);
      const before = await readResourceOrNull(config, "Communication Event", draft.communication_event_id);
      const operation = before ? "update" : "create";
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_record_communication_event",
        target: { doctype: "Communication Event", name: draft.communication_event_id },
        roofJob: draft.roof_job,
        leadEnvelope: draft.lead_envelope,
        dryRun: {
          target: { doctype: "Communication Event", name: draft.communication_event_id },
          operation,
          policy_result: draft.policy_result,
          draft,
        },
        beforeSummary: summarizeCommunicationEvent(before),
        afterSummary: summarizeCommunicationEvent({ ...(before ?? {}), ...draft, name: draft.communication_event_id }),
        execute: upsertDraftExecutor(config, "Communication Event", draft.communication_event_id, draft, before),
        responseExtra: {
          upserted: true,
          operation,
          communication_event_id: draft.communication_event_id,
          policy_result: draft.policy_result,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_supplier_quote",
    {
      title: "Dry Run Supplier Quote",
      description: "Preview a review-gated Supplier Quote draft from an approved Material Takeoff without writing.",
      inputSchema: supplierQuoteInputSchema(),
    },
    async (args) => {
      const { draft, materialTakeoff } = await buildSupplierQuoteDraftFromErp(config, args);
      return text({
        would_write: false,
        required_tool: "request_create_supplier_quote",
        target: { doctype: "Supplier Quote", name: draft.supplier_quote_id },
        source: {
          material_takeoff: materialTakeoff.takeoff_id ?? materialTakeoff.name,
          item_count: draft.items.length,
          quote_total: draft.quote_total,
        },
        draft,
      });
    },
  );

  server.registerTool(
    "request_create_supplier_quote",
    {
      title: "Request Create Supplier Quote",
      description: "Approved-write: create or update one review-gated Supplier Quote and record a Hermes Run audit row.",
      inputSchema: {
        ...supplierQuoteInputSchema(),
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        run_id: z.string().min(8).max(128),
        dry_run_receipt: z.string().min(32).max(4096),
        approval_receipt: z.string().min(32).max(8192),
      },
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const { draft, materialTakeoff } = await buildSupplierQuoteDraftFromErp(config, args, now);
      const before = await readResourceOrNull(config, "Supplier Quote", draft.supplier_quote_id);
      const operation = before ? "update" : "create";
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_create_supplier_quote",
        target: { doctype: "Supplier Quote", name: draft.supplier_quote_id },
        roofJob: draft.roof_job,
        dryRun: {
          target: { doctype: "Supplier Quote", name: draft.supplier_quote_id },
          operation,
          source: {
            material_takeoff: materialTakeoff.takeoff_id ?? materialTakeoff.name,
            item_count: draft.items.length,
            quote_total: draft.quote_total,
          },
          draft,
        },
        beforeSummary: summarizeSupplierQuote(before),
        afterSummary: summarizeSupplierQuote({ ...(before ?? {}), ...draft, name: draft.supplier_quote_id }),
        execute: upsertDraftExecutor(config, "Supplier Quote", draft.supplier_quote_id, draft, before),
        responseExtra: { upserted: true, operation, supplier_quote_id: draft.supplier_quote_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_bind_quote_price_rules",
    {
      title: "Dry Run Bind Quote Price Rules",
      description: "Preview one immutable Price Book Rule snapshot for a Draft or Needs Review Customer Quote without writing.",
      inputSchema: QuotePriceRuleSnapshotInputSchema,
    },
    async (args) => {
      const { customerQuote, snapshot } = await buildQuotePriceRuleSnapshotFromErp(
        config,
        args,
        new Date().toISOString(),
      );
      return text({
        would_write: false,
        required_tool: "request_bind_quote_price_rules",
        target: { doctype: "Customer Quote", name: customerQuote.name ?? customerQuote.customer_quote_id },
        before: summarizeCustomerQuote(customerQuote),
        patch: { price_rule_snapshot_bound: true },
        source: summarizeQuotePriceRuleSnapshot(snapshot),
      });
    },
  );

  server.registerTool(
    "request_bind_quote_price_rules",
    {
      title: "Request Bind Quote Price Rules",
      description: "Approved-write: bind one immutable verified Price Book Rule snapshot to a Draft or Needs Review Customer Quote and audit it.",
      inputSchema: approvedWriteInputSchema(QuotePriceRuleSnapshotInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const { customerQuote, snapshot, patch } = await buildQuotePriceRuleSnapshotFromErp(config, args, now);
      const targetName = customerQuote.name ?? customerQuote.customer_quote_id;
      const beforeSummary = summarizeCustomerQuote(customerQuote);
      const dryRun = {
        target: { doctype: "Customer Quote", name: targetName },
        before: beforeSummary,
        patch: { price_rule_snapshot_bound: true },
        source: summarizeQuotePriceRuleSnapshot(snapshot),
      };
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_bind_quote_price_rules",
        target: { doctype: "Customer Quote", name: targetName },
        roofJob: args.roof_job_id,
        dryRun,
        beforeSummary,
        afterSummary: { ...beforeSummary, price_rule_snapshot_bound: true },
        execute: () => erpPut(config, resourcePath("Customer Quote", targetName), patch),
        responseExtra: {
          updated: true,
          customer_quote_id: targetName,
          price_rule_count: snapshot.rules.length,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_quote_revision",
    {
      title: "Dry Run Quote Revision",
      description: "Preview one append-only, non-commercial Customer Quote revision shell. It never copies price, tax, scope, payment, approval, acceptance, or customer-facing terms.",
      inputSchema: CustomerQuoteRevisionInputSchema,
    },
    async (args) => {
      const { draft, sourceQuote, existingQuotes } = await buildCustomerQuoteRevisionDraftFromErp(config, args);
      await assertQuoteRevisionTargetAbsent(config, draft.customer_quote_id);
      return text({
        would_write: false,
        required_tool: "request_create_quote_revision",
        target: { doctype: "Customer Quote", name: draft.customer_quote_id },
        append_only: true,
        source: summarizeCustomerQuote(sourceQuote),
        observed_quote_count: existingQuotes.length,
        draft,
      });
    },
  );

  server.registerTool(
    "request_create_quote_revision",
    {
      title: "Request Create Quote Revision",
      description: "Approved-write: append one blank Customer Quote revision shell and audit it. It cannot reprice, present, approve, accept, sign, or send a quote.",
      inputSchema: approvedWriteInputSchema(CustomerQuoteRevisionInputSchema),
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const { draft, sourceQuote, existingQuotes } = await buildCustomerQuoteRevisionDraftFromErp(config, args, now);
      await assertQuoteRevisionTargetAbsent(config, draft.customer_quote_id);
      return text(await executeAuditedWrite(config, {
        runId: args.run_id,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_create_quote_revision",
        target: { doctype: "Customer Quote", name: draft.customer_quote_id },
        roofJob: args.roof_job_id,
        dryRun: {
          target: { doctype: "Customer Quote", name: draft.customer_quote_id },
          operation: "create",
          append_only: true,
          source: summarizeCustomerQuote(sourceQuote),
          observed_quote_count: existingQuotes.length,
          draft,
        },
        beforeSummary: null,
        afterSummary: summarizeCustomerQuote({ ...draft, name: draft.customer_quote_id }),
        execute: createOnlyExecutor(
          config,
          "Customer Quote",
          null,
          draft,
          "quote_revision_append_only",
        ),
        responseExtra: {
          created: true,
          customer_quote_id: draft.customer_quote_id,
          quote_version: draft.quote_version,
          supersedes: draft.supersedes,
        },
      }));
    },
  );

  server.registerTool(
    "dry_run_market_watch_item",
    {
      title: "Dry Run Market Watch Item",
      description: "Preview a Market Watch Item (competitor change and required response) without writing.",
      inputSchema: marketWatchInputSchema(),
    },
    async (args) => {
      const draft = buildMarketWatchItemDraft(marketWatchDraftArgs(args));
      return text({
        would_write: false,
        required_tool: "request_add_market_watch_item",
        target: { doctype: "Market Watch Item", name: draft.watch_id },
        draft,
      });
    },
  );

  server.registerTool(
    "request_add_market_watch_item",
    {
      title: "Request Add Market Watch Item",
      description: "Approved-write: create or update one Market Watch Item and record a Hermes Run audit row.",
      inputSchema: {
        ...marketWatchInputSchema(),
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        run_id: z.string().min(8).max(128),
        dry_run_receipt: z.string().min(32).max(4096),
        approval_receipt: z.string().min(32).max(8192),
      },
    },
    async (args) => {
      assertWriteApproved(config, args);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const draft = buildMarketWatchItemDraft({ ...marketWatchDraftArgs(args), nowIso: now });
      const before = await readResourceOrNull(config, "Market Watch Item", draft.watch_id);
      const operation = before ? "update" : "create";
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: config.agentRoleTitle,
        toolName: "request_add_market_watch_item",
        target: { doctype: "Market Watch Item", name: draft.watch_id },
        dryRun: { target: { doctype: "Market Watch Item", name: draft.watch_id }, operation, draft },
        beforeSummary: summarizeMarketWatchItem(before),
        afterSummary: summarizeMarketWatchItem({ ...(before ?? {}), ...draft, name: draft.watch_id }),
        execute: upsertDraftExecutor(config, "Market Watch Item", draft.watch_id, draft, before),
        responseExtra: { upserted: true, operation, watch_id: draft.watch_id },
      }));
    },
  );

  return mcpServer;
}

// Registers the standard get-by-id plus list-for-job read pair for one DocType.
function registerReadPair(server, config, { doctype, idArg, getName, listName, fields, orderBy = "modified desc" }) {
  server.registerTool(
    getName,
    {
      title: `Get ${doctype}`,
      description: `Read one IronWrap OS ${doctype} by ${idArg}/name.`,
      inputSchema: { [idArg]: z.string().min(1) },
    },
    async (args) => text(await erpGet(config, resourcePath(doctype, args[idArg]))),
  );
  server.registerTool(
    listName,
    {
      title: `List ${doctype}s For Job`,
      description: `Read ${doctype} rows linked to one Roof Job.`,
      inputSchema: { roof_job_id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ roof_job_id, limit = 25 }) => text(await erpGet(config, resourceListPath(doctype, {
      fields,
      filters: [[doctype, "roof_job", "=", roof_job_id]],
      limit,
      orderBy,
    }))),
  );
}

// New operating-model reads are stricter than the legacy read helpers: inputs reject
// unknown keys, list reads require one exact Roof Job, and output is reduced to the
// declared field allowlist (including nested child-row allowlists where needed).
function registerStrictJobReadPair(server, config, {
  doctype,
  idArg,
  getName,
  listName,
  fields,
  childFields = {},
  orderBy = "modified desc",
}) {
  const listFields = fields.filter((field) => !Object.hasOwn(childFields, field));
  server.registerTool(
    getName,
    {
      title: `Get ${doctype}`,
      description: `Read one allowlisted IronWrap OS ${doctype} by ${idArg}/name.`,
      inputSchema: z.object({ [idArg]: IdSchema }).strict(),
    },
    async (args) => text({
      data: sanitizeResource(await readResource(config, doctype, args[idArg]), fields, childFields),
    }),
  );
  server.registerTool(
    listName,
    {
      title: `List ${doctype}s For Job`,
      description: `Read a bounded allowlisted ${doctype} list for one exact Roof Job.`,
      inputSchema: z.object({
        roof_job_id: IdSchema,
        limit: z.number().int().min(1).max(100).optional(),
      }).strict(),
    },
    async ({ roof_job_id, limit = 25 }) => text({
      data: (await listResources(config, doctype, {
        fields: listFields,
        filters: [[doctype, "roof_job", "=", roof_job_id]],
        limit,
        orderBy,
      })).map((row) => sanitizeResource(row, listFields)),
    }),
  );
}

function sanitizeResource(record, fields, childFields = {}) {
  const clean = pickAllowedFields(record, fields);
  for (const [field, rowFields] of Object.entries(childFields)) {
    clean[field] = Array.isArray(record?.[field])
      ? record[field].map((row) => pickAllowedFields(row, rowFields))
      : [];
  }
  return clean;
}

function pickAllowedFields(record, fields) {
  const clean = {};
  for (const field of fields) {
    if (record && Object.hasOwn(record, field)) clean[field] = record[field];
  }
  return clean;
}

function communicationEventInputSchema() {
  return {
    channel: z.enum(["SMS", "Email", "Call", "Portal"]),
    direction: z.enum(["Outbound", "Inbound"]).optional(),
    roof_job_id: z.string().min(1).optional(),
    lead_envelope_id: z.string().min(1).optional(),
    communication_event_id: z.string().min(1).optional(),
    template: z.string().max(200).optional(),
    consent_basis: z.string().max(100).optional(),
    body_preview: z.string().max(4000).optional(),
    recipient_ref: z.string().min(1),
    now_utc_iso: z.string().min(1).optional(),
    timezone_offset_minutes: z.number().int().min(-720).max(840).optional(),
    quiet_start_hour: z.number().int().min(0).max(23).optional(),
    quiet_end_hour: z.number().int().min(1).max(24).optional(),
  };
}

function supplierQuoteInputSchema() {
  return {
    material_takeoff_id: z.string().min(1),
    supplier_quote_id: z.string().min(1).optional(),
    supplier: z.string().min(1).optional(),
    quoted_at: z.string().optional(),
    valid_until: z.string().min(1),
    unit_prices: z.record(z.string(), z.number().min(0)).optional(),
  };
}

function marketWatchInputSchema() {
  return {
    watch_id: z.string().min(1).optional(),
    competitor: z.string().min(1),
    title: z.string().min(1),
    source_url: z.string().optional(),
    risk_level: z.enum(["Low", "Medium", "High"]).optional(),
    product_gate: z.string().max(200).optional(),
    required_response: z.string().max(4000).optional(),
    observed_at: z.string().optional(),
  };
}

function marketWatchDraftArgs(args) {
  return {
    watchId: args.watch_id,
    competitor: args.competitor,
    title: args.title,
    sourceUrl: args.source_url,
    riskLevel: args.risk_level,
    productGate: args.product_gate,
    requiredResponse: args.required_response,
    observedAt: args.observed_at,
  };
}

function jobAssignmentDraftFromArgs(args, nowIso) {
  return buildJobAssignmentDraft({
    assignmentId: args.assignment_id,
    roofJobId: args.roof_job_id,
    assignmentType: args.assignment_type,
    status: args.status,
    crewProfileId: args.crew_profile_id,
    assignedUser: args.assigned_user,
    scheduledStart: args.scheduled_start,
    scheduledEnd: args.scheduled_end,
    authorityRequirements: args.authority_requirements,
    assignedBy: args.assigned_by,
    supersedes: args.supersedes,
    correctionReason: args.correction_reason,
    notes: args.notes,
    nowIso,
  });
}

function changeOrderDraftFromArgs(args, nowIso) {
  return buildChangeOrderDraft({
    changeOrderId: args.change_order_id,
    roofJobId: args.roof_job_id,
    customerQuoteId: args.customer_quote_id,
    changeNumber: args.change_number,
    version: args.version,
    title: args.title,
    reason: args.reason,
    scopeDelta: args.scope_delta,
    currency: args.currency,
    taxAmount: args.tax_amount,
    priceBookVersion: args.price_book_version,
    taxPolicySnapshot: args.tax_policy_snapshot,
    items: args.items,
    requestedBy: args.requested_by,
    supersedes: args.supersedes,
    correctionReason: args.correction_reason,
    notes: args.notes,
    nowIso,
  });
}

function insuranceSupplementDraftFromArgs(args) {
  return buildInsuranceSupplementDraft({
    insuranceSupplementId: args.insurance_supplement_id,
    roofJobId: args.roof_job_id,
    customerQuoteId: args.customer_quote_id,
    changeOrderId: args.change_order_id,
    version: args.version,
    carrierName: args.carrier_name,
    claimReference: args.claim_reference,
    policyReference: args.policy_reference,
    dateOfLoss: args.date_of_loss,
    adjusterReference: args.adjuster_reference,
    supplementBasis: args.supplement_basis,
    measurementReportId: args.measurement_report_id,
    invoiceRequired: args.invoice_required,
    invoiceExceptionReason: args.invoice_exception_reason,
    evidence: args.evidence,
    supersedes: args.supersedes,
    correctionReason: args.correction_reason,
    notes: args.notes,
  });
}

async function assertInsuranceSupplementEvidence(config, roofJobId, rows) {
  const seen = new Set();
  const verified = [];
  for (const row of rows ?? []) {
    const evidenceItemId = row?.evidence_item ?? row?.evidence_item_id;
    const evidenceRole = row?.evidence_role;
    if (!evidenceItemId || !INSURANCE_EVIDENCE_TYPES[evidenceRole]) {
      throw new Error("insurance_supplement_evidence_invalid");
    }
    if (seen.has(evidenceItemId)) throw new Error("insurance_supplement_evidence_duplicate");
    seen.add(evidenceItemId);
    const evidence = await assertLinkedResourceForJob(
      config,
      "Evidence Item",
      evidenceItemId,
      roofJobId,
      "insurance_supplement",
      { evidenceTypes: INSURANCE_EVIDENCE_TYPES[evidenceRole] },
    );
    verified.push({ evidence_item_id: evidenceItemId, evidence_role: evidenceRole, evidence });
  }
  return verified;
}

async function assertInsuranceSupplementSources(config, draft) {
  if (draft.customer_quote) {
    await assertLinkedResourceForJob(
      config,
      "Customer Quote",
      draft.customer_quote,
      draft.roof_job,
      "insurance_supplement_customer_quote",
    );
  }
  if (draft.change_order) {
    await assertLinkedResourceForJob(
      config,
      "Change Order",
      draft.change_order,
      draft.roof_job,
      "insurance_supplement_change_order",
    );
  }
  if (draft.measurement_report) {
    await assertLinkedResourceForJob(
      config,
      "Measurement Report",
      draft.measurement_report,
      draft.roof_job,
      "insurance_supplement_measurement",
    );
  }
  if (draft.supersedes) {
    const prior = await assertLinkedResourceForJob(
      config,
      "Insurance Supplement",
      draft.supersedes,
      draft.roof_job,
      "insurance_supplement_correction",
    );
    if ((prior.insurance_supplement_id ?? prior.name) === draft.insurance_supplement_id) {
      throw new Error("insurance_supplement_correction_requires_new_id");
    }
    assertCorrectionVersion(draft, prior, "insurance_supplement_correction");
  }
  return await assertInsuranceSupplementEvidence(config, draft.roof_job, draft.evidence);
}

async function insuranceEvidenceManifestFromRecord(config, supplement) {
  const verified = await assertInsuranceSupplementEvidence(
    config,
    supplement.roof_job,
    supplement.evidence,
  );
  return {
    roof_job: supplement.roof_job,
    measurement_report: supplement.measurement_report ?? "",
    evidence: verified
      .map(({ evidence_item_id: evidenceItemId, evidence_role: evidenceRole, evidence }) => ({
        evidence_item_id: evidenceItemId,
        evidence_role: evidenceRole,
        evidence_type: evidence.evidence_type,
        content_checksum: evidence.content_checksum,
        checksum_algorithm: evidence.checksum_algorithm,
        verified_at: evidence.verified_at,
        verification_source: evidence.verification_source,
      }))
      .sort((left, right) =>
        left.evidence_role.localeCompare(right.evidence_role)
        || left.evidence_item_id.localeCompare(right.evidence_item_id),
      ),
  };
}

function summarizeInsuranceEvidenceRows(rows = []) {
  return {
    evidence_count: rows.length,
    evidence_roles: [...new Set(rows.map((row) => row.evidence_role))].sort(),
  };
}

function safetyPlanDraftFromArgs(args, nowIso) {
  return buildSafetyPlanDraft({
    safetyPlanId: args.safety_plan_id,
    roofJobId: args.roof_job_id,
    version: args.version,
    status: args.status,
    effectiveDate: args.effective_date,
    preparedBy: args.prepared_by,
    hazardSummary: args.hazard_summary,
    controls: args.controls,
    emergencyPlan: args.emergency_plan,
    ppeRequirements: args.ppe_requirements,
    weatherLimits: args.weather_limits,
    evidenceItemId: args.evidence_item_id,
    supersedes: args.supersedes,
    correctionReason: args.correction_reason,
    notes: args.notes,
    nowIso,
  });
}

function complianceDraftFromArgs(args, nowIso) {
  return buildComplianceRecordDraft({
    complianceRecordId: args.compliance_record_id,
    roofJobId: args.roof_job_id,
    jurisdiction: args.jurisdiction,
    recordType: args.record_type,
    authorityName: args.authority_name,
    externalReference: args.external_reference,
    authorityRecordId: args.authority_record_id,
    status: args.status,
    requiredBeforeGate: args.required_before_gate,
    appliedAt: args.applied_at,
    effectiveDate: args.effective_date,
    expiryDate: args.expiry_date,
    inspectedAt: args.inspected_at,
    evidenceItemId: args.evidence_item_id,
    ownerUser: args.owner_user,
    dueDate: args.due_date,
    waiverReason: args.waiver_reason,
    supersedes: args.supersedes,
    correctionReason: args.correction_reason,
    notes: args.notes,
    approvedBy: args.approved_by,
    nowIso,
  });
}

export function authorityRecordDraftFromArgs(config, args, before, nowIso) {
  const operation = args.authority_operation;
  // Frappe stores Datetime fields as MariaDB-compatible UTC text.  Build the
  // command in that exact representation so its state digest survives the
  // material Frappe readback instead of failing on an ISO-vs-DATETIME format
  // difference after a successful write.
  const frappeNow = frappeDatetimeIso(nowIso);
  const requireValue = (value, field) => {
    if (value === undefined || value === null || value === "") throw new Error(`authority_${field}_required`);
    return value;
  };
  if (before && before.tenant && before.tenant !== config.tenantId) {
    throw new Error("authority_record_tenant_mismatch");
  }
  if (operation !== "record" && !before) throw new Error("authority_record_not_found");
  const priorVersion = Number(before?.version ?? 0);
  const append = ["renew", "supersede", "revoke", "resolve_exception"].includes(operation);
  const version = append ? priorVersion + 1 : (before ? priorVersion : 1);
  const recordId = append
    ? (args.new_authority_record_id ?? `${args.authority_record_id}:v${version}`)
    : args.authority_record_id;
  const base = before ? { ...before } : {};
  delete base.name;
  delete base.modified;
  delete base.state_digest_sha256;
  delete base.new_authority_record_id;
  delete base.authority_operation;
  const draft = {
    ...base,
    authority_record_id: recordId,
    tenant: config.tenantId,
    version,
  };
  if (operation === "record") {
    for (const field of [
      "subject_type", "subject_role", "authority_kind", "authority_scope", "scope_type", "scope_ref",
      "issuer_name", "issuer_jurisdiction", "issuer_reference", "source_version",
      "evidence_sha256", "effective_from", "expires_at",
    ]) requireValue(args[field], field);
    if (args.subject_type === "Person") requireValue(args.person_user, "person_user");
    if (args.subject_type === "Organization") requireValue(args.organization, "organization");
    if (!args.evidence_refs?.length) throw new Error("authority_evidence_refs_required");
    Object.assign(draft, {
      subject_type: args.subject_type,
      subject_role: args.subject_role,
      person_user: args.person_user ?? "",
      organization: args.organization ?? "",
      authority_kind: args.authority_kind,
      authority_scope: args.authority_scope,
      scope_type: args.scope_type,
      scope_ref: args.scope_ref,
      roof_job: args.roof_job_id ?? "",
      scope_json: args.scope_json ? JSON.stringify(args.scope_json) : "",
      issuer_name: args.issuer_name,
      issuer_jurisdiction: args.issuer_jurisdiction,
      issuer_reference: args.issuer_reference,
      source_version: args.source_version,
      evidence_refs_json: JSON.stringify(args.evidence_refs),
      evidence_sha256: args.evidence_sha256,
      issuer_readback_json: "",
      effective_from: args.effective_from,
      expires_at: args.expires_at,
      status: "Unverified",
      verification_method: "",
      verified_at: "",
      verification_reference: "",
      verified_by: "",
      revoked_at: "",
      revocation_reference: "",
      revoked_by: "",
      supersedes: "",
      correction_reason: "",
      exception_status: "None",
      exception_reason: "",
      notes: args.notes ?? "",
    });
    return draft;
  }
  if (append) {
    if (!args.correction_reason) throw new Error("authority_correction_reason_required");
    draft.supersedes = before.authority_record_id ?? before.name;
    draft.correction_reason = args.correction_reason;
    draft.subject_type = args.subject_type ?? before.subject_type;
    draft.subject_role = args.subject_role ?? before.subject_role;
    draft.person_user = args.person_user ?? before.person_user ?? "";
    draft.organization = args.organization ?? before.organization ?? "";
    draft.authority_kind = args.authority_kind ?? before.authority_kind;
    draft.authority_scope = args.authority_scope ?? before.authority_scope;
    draft.scope_type = args.scope_type ?? before.scope_type;
    draft.scope_ref = args.scope_ref ?? before.scope_ref;
    draft.roof_job = args.roof_job_id ?? before.roof_job ?? "";
    draft.scope_json = args.scope_json ? JSON.stringify(args.scope_json) : before.scope_json ?? "";
    draft.issuer_name = args.issuer_name ?? before.issuer_name;
    draft.issuer_jurisdiction = args.issuer_jurisdiction ?? before.issuer_jurisdiction;
    draft.issuer_reference = args.issuer_reference ?? before.issuer_reference;
    draft.source_version = args.source_version ?? before.source_version;
    draft.evidence_refs_json = args.evidence_refs ? JSON.stringify(args.evidence_refs) : before.evidence_refs_json;
    draft.evidence_sha256 = args.evidence_sha256 ?? before.evidence_sha256;
    draft.effective_from = args.effective_from ?? before.effective_from;
    draft.expires_at = args.expires_at ?? before.expires_at;
  }
  if (operation === "revoke") {
    draft.status = "Revoked";
    draft.verification_method = "";
    draft.verified_at = "";
    draft.verification_reference = "";
    draft.verified_by = "";
    draft.revoked_at = args.revoked_at ? frappeDatetimeIso(args.revoked_at) : frappeNow;
    draft.revocation_reference = requireValue(args.revocation_reference, "revocation_reference");
    draft.revoked_by = config.actorUser;
    draft.exception_status = "None";
    draft.exception_reason = "";
  } else {
    draft.status = "Verified";
    draft.verification_method = requireValue(args.verification_method, "verification_method");
    if (EXTERNAL_AUTHORITY_KINDS.has(draft.authority_kind) && draft.verification_method === "Internal Competency Assessment") {
      throw new Error("authority_external_issuer_readback_required");
    }
    draft.verified_at = frappeNow;
    draft.verification_reference = requireValue(args.verification_reference, "verification_reference");
    draft.verified_by = config.actorUser;
    draft.revoked_at = "";
    draft.revocation_reference = "";
    draft.revoked_by = "";
    draft.exception_status = operation === "resolve_exception" ? "Resolved" : "None";
    draft.exception_reason = "";
  }
  return draft;
}

export function authorityStateDigest(record) {
  return digest(Object.fromEntries(
    AUTHORITY_MATERIAL_DIGEST_FIELDS.map((field) => [field, record[field] ?? ""]),
  ));
}

function authorityReadbackExpectedState(status) {
  if (status === "Verified") return "verified";
  if (status === "Revoked") return "revoked";
  if (status === "Contradictory") return "contradictory";
  return "unavailable";
}

export function assertIssuerReceiptForDraft(config, draft, receipt) {
  const requiresIssuer = EXTERNAL_AUTHORITY_KINDS.has(draft.authority_kind)
    && draft.status !== "Unverified";
  if (!requiresIssuer) {
    if (receipt) throw new Error("authority_issuer_receipt_not_applicable");
    draft.issuer_readback_json = "";
    return null;
  }
  if (!receipt) throw new Error("authority_issuer_receipt_required");
  if (receipt.tenant !== draft.tenant ||
      receipt.authority_record_id !== draft.authority_record_id ||
      receipt.authority_version !== Number(draft.version) ||
      receipt.issuer_name !== draft.issuer_name ||
      receipt.issuer_jurisdiction !== draft.issuer_jurisdiction ||
      receipt.issuer_reference !== draft.issuer_reference ||
      receipt.issuer_source_version !== draft.source_version ||
      String(receipt.evidence_sha256).toLowerCase() !== String(draft.evidence_sha256).toLowerCase() ||
      receipt.verification_state !== authorityReadbackExpectedState(draft.status)) {
    throw new Error("authority_issuer_receipt_mismatch");
  }
  let receiptEvidence;
  let draftEvidence;
  try {
    receiptEvidence = JSON.parse(receipt.evidence_refs_json);
    draftEvidence = JSON.parse(draft.evidence_refs_json);
  } catch {
    throw new Error("authority_issuer_evidence_invalid");
  }
  if (canonicalJson(receiptEvidence) !== canonicalJson(draftEvidence)) {
    throw new Error("authority_issuer_evidence_mismatch");
  }
  const expectedDigest = authorityStateDigest(draft);
  if (receipt.state_digest_sha256.toLowerCase() !== expectedDigest) {
    throw new Error("authority_issuer_state_digest_mismatch");
  }
  const publicKey = config.authorityIssuerPublicKeys?.[receipt.issuer_key_id];
  if (!publicKey) throw new Error("authority_issuer_public_key_required");
  const { signature, ...unsignedReceipt } = receipt;
  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(canonicalJson(unsignedReceipt)),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new Error("authority_issuer_signature_invalid");
  draft.issuer_readback_json = JSON.stringify(receipt);
  return receipt;
}

function customerDecisionDraftFromArgs(args) {
  return buildCustomerDecisionDraft({
    decisionId: args.decision_id,
    roofJobId: args.roof_job_id,
    customerId: args.customer_id,
    decisionType: args.decision_type,
    decisionValue: args.decision_value,
    decisionSummary: args.decision_summary,
    sourceChannel: args.source_channel,
    decidedAt: args.decided_at,
    capturedBy: args.captured_by,
    evidenceItemId: args.evidence_item_id,
    optionPackageId: args.option_package_id,
    changeOrderId: args.change_order_id,
    supersedes: args.supersedes,
    correctionReason: args.correction_reason,
    notes: args.notes,
  });
}

function communicationConsentDraftFromArgs(args) {
  return buildCommunicationConsentDraft({
    consentId: args.consent_id,
    customerId: args.customer_id,
    leadEnvelopeId: args.lead_envelope_id,
    roofJobId: args.roof_job_id,
    channel: args.channel,
    purpose: args.purpose,
    status: args.status,
    jurisdiction: args.jurisdiction,
    consentBasis: args.consent_basis,
    sourceSystem: args.source_system,
    sourceReference: args.source_reference,
    capturedBy: args.captured_by,
    capturedAt: args.captured_at,
    effectiveFrom: args.effective_from,
    expiresAt: args.expires_at,
    proofEvidenceId: args.proof_evidence_id,
    revokedAt: args.revoked_at,
    supersedes: args.supersedes,
    correctionReason: args.correction_reason,
    notes: args.notes,
  });
}

async function assertLinkedResourceForJob(config, doctype, name, roofJobId, label, evidencePolicy = {}) {
  if (!name) return null;
  const record = await readResource(config, doctype, name);
  assertLinkedRoofJob(roofJobId, record, label);
  if (doctype === "Evidence Item") assertVerifiedEvidence(record, label, evidencePolicy);
  return record;
}

async function buildJobCostEventPreviewFromErp(config, args, nowIso = new Date().toISOString()) {
  const candidate = buildJobCostEventCandidate(args, {
    tenantId: config.tenantId,
    actorUser: config.actorUser,
    approverId: config.approverId,
    nowIso,
  });
  const [tenant, roofJob, sourceRecord, evidence, existing] = await Promise.all([
    readResource(config, "White-Label Tenant", candidate.tenant),
    readResource(config, "Roof Job", candidate.roof_job),
    readResource(config, candidate.source_doctype, candidate.source_name),
    readResource(config, "Evidence Item", candidate.source_evidence),
    readResourceOrNull(config, "Job Cost Event", candidate.job_cost_event_id),
  ]);
  const [reversalTarget, reversalRows, reconciliation] = await Promise.all([
    candidate.reversal_of
      ? readResource(config, "Job Cost Event", candidate.reversal_of)
      : Promise.resolve(null),
    candidate.reversal_of
      ? listResources(config, "Job Cost Event", {
          fields: ["name", "job_cost_event_id", "reversal_of"],
          filters: [["Job Cost Event", "reversal_of", "=", candidate.reversal_of]],
          limit: 2,
          orderBy: "occurred_at desc",
        })
      : Promise.resolve([]),
    candidate.reconciliation
      ? readResource(config, "Integration Reconciliation", candidate.reconciliation)
      : Promise.resolve(null),
  ]);
  const existingReversals = reversalRows.filter(
    (row) => (row.job_cost_event_id ?? row.name) !== candidate.job_cost_event_id,
  );
  assertJobCostEventSources(candidate, {
    tenant,
    roofJob,
    sourceRecord,
    evidence,
    reversalTarget,
    existingReversals,
    reconciliation,
  });
  const replayState = classifyJobCostEventReplay(candidate, existing);
  if (replayState === "id_conflict") throw new Error("job_cost_event_id_conflict");

  return {
    would_write: false,
    write_tool_available: false,
    customer_mutated: false,
    accounting_mutated: false,
    target: { doctype: "Job Cost Event", name: candidate.job_cost_event_id },
    append_only: true,
    replay_state: replayState,
    blocked_existing: replayState === "identical_replay",
    candidate,
    verified_source: {
      doctype: candidate.source_doctype,
      name: candidate.source_name,
      evidence_item_id: candidate.source_evidence,
      sha256: candidate.source_digest,
    },
    accounting_semantics: {
      state: candidate.accounting_state,
      posted_requires_exact_terminal_reconciliation: true,
      revenue_recognized: false,
      cash_collected: false,
      tax_included: false,
    },
    human_gate: {
      action: replayState === "identical_replay" ? "none" : "manual_frappe_insert",
      required_current_frappe_user: config.approverId,
      approval_reference: candidate.approval_reference,
      note: "The current Frappe Finance/Owner must independently review and insert this candidate; this MCP has no Job Cost Event write tool.",
    },
  };
}

export async function assertGateEvidenceForState(config, nextState, evidenceItemId, roofJobId) {
  if (!GATE_EVIDENCE_STATES.has(nextState)) return null;
  if (!evidenceItemId) throw new Error("evidence_item_required_for_gate_state");
  return await assertLinkedResourceForJob(
    config,
    "Evidence Item",
    evidenceItemId,
    roofJobId,
    "gate_readiness",
  );
}

async function assertVerifiedEvidenceResource(config, evidenceId, label, evidencePolicy = {}) {
  const evidence = await readResource(config, "Evidence Item", evidenceId);
  assertVerifiedEvidence(evidence, label, evidencePolicy);
  return evidence;
}

export function assertVerifiedEvidence(evidence, label, {
  proofSlots = [],
  evidenceTypes = [],
} = {}) {
  if (evidence?.sync_state !== "Verified") throw new Error(`${label}_evidence_not_verified`);
  if (evidence?.checksum_algorithm !== "SHA-256"
    || !/^[a-f0-9]{64}$/.test(String(evidence?.content_checksum ?? ""))) {
    throw new Error(`${label}_evidence_checksum_invalid`);
  }
  if (!evidence?.verified_at || !evidence?.verification_source) {
    throw new Error(`${label}_evidence_verification_provenance_required`);
  }
  if (!evidence?.source_uri && !evidence?.r2_key && !evidence?.drive_file_id) {
    throw new Error(`${label}_evidence_source_required`);
  }
  if (!evidence?.proof_slot) throw new Error(`${label}_evidence_proof_slot_required`);
  if (proofSlots.length && !proofSlots.includes(evidence.proof_slot)) {
    throw new Error(`${label}_evidence_proof_slot_invalid`);
  }
  if (evidenceTypes.length && !evidenceTypes.includes(evidence.evidence_type)) {
    throw new Error(`${label}_evidence_type_invalid`);
  }
}

function assertShopHandoverEvidence(evidence) {
  assertVerifiedEvidence(evidence, "shop_handover", {
    proofSlots: ["Production"],
    evidenceTypes: ["Photo", "Signed Document"],
  });
  if (evidence?.source_system !== "ironwrap-pwa" || !evidence?.device_action_id) {
    throw new Error("shop_handover_evidence_provenance_invalid");
  }
  const contentLength = Number(evidence?.content_length);
  if (
    !evidence?.r2_key
    || !evidence?.captured_at
    || !evidence?.content_type
    || !Number.isInteger(contentLength)
    || contentLength <= 0
  ) {
    throw new Error("shop_handover_evidence_provenance_invalid");
  }
}

function customerDecisionEvidencePolicy(decisionType) {
  if (decisionType === "Scope Approval") {
    return { proofSlots: ["Contract"], evidenceTypes: ["Signed Document", "Email"] };
  }
  if (decisionType === "Change Order") {
    return { proofSlots: ["Change Order"], evidenceTypes: ["Signed Document", "Email"] };
  }
  return {
    proofSlots: ["Communication", "Contract"],
    evidenceTypes: ["Signed Document", "Email", "Voice Note"],
  };
}

function consentEvidencePolicy(args) {
  return {
    proofSlots: args.consent_basis === "Contract" ? ["Contract", "Communication"] : ["Communication"],
    evidenceTypes: ["Signed Document", "Email", "Voice Note"],
  };
}

function safetyAcknowledgementEvidencePolicy(method) {
  if (method === "QR Device Pairing") {
    return { proofSlots: ["Safety"], evidenceTypes: ["Photo"] };
  }
  if (method === "E-signature") {
    return { proofSlots: ["Safety"], evidenceTypes: ["Signed Document"] };
  }
  return { proofSlots: ["Safety"], evidenceTypes: ["Photo", "Field Note", "PDF", "Signed Document"] };
}

function createOnlyExecutor(config, doctype, before, draft, errorCode) {
  return async () => {
    if (before) throw new Error(errorCode);
    return await erpPost(config, `/api/resource/${encodeURIComponent(doctype)}`, draft);
  };
}

function summarizeRecord(record, fields) {
  if (!record) return null;
  return pickAllowedFields(record, fields);
}

function assertImmutableFields(before, next, fields, label) {
  if (!before) return;
  const changed = fields.filter((field) => before[field] !== next[field]);
  if (changed.length) throw new Error(`${label}_identity_immutable:${changed.join(",")}`);
}

async function readResource(config, doctype, name) {
  const res = await erpGet(config, resourcePath(doctype, name));
  return res.data ?? {};
}

async function readResourceOrNull(config, doctype, name) {
  try {
    return await readResource(config, doctype, name);
  } catch (err) {
    if (String(err).startsWith("Error: erpnext_http_404:")) return null;
    throw err;
  }
}

async function listResources(config, doctype, options) {
  const res = await erpGet(config, resourceListPath(doctype, options));
  return Array.isArray(res.data) ? res.data : [];
}

async function previewProductionScheduleGatePreview(config, draft) {
  const notRequired = buildProductionScheduleGatePreview(draft);
  if (!notRequired.required) return notRequired;
  const gateRows = await listResources(config, "Production Gate State", {
    fields: PRODUCTION_SCHEDULE_PREVIEW_FIELDS,
    filters: [["Production Gate State", "roof_job", "=", draft.roof_job]],
    limit: PRODUCTION_SCHEDULE_PREVIEW_LIMIT,
    orderBy: "modified desc",
  });
  return buildProductionScheduleGatePreview(draft, gateRows, {
    truncated: gateRows.length >= PRODUCTION_SCHEDULE_PREVIEW_LIMIT,
  });
}

async function buildCompleteWorkPackagePreview(config, args) {
  const packageRow = await readResource(config, "Work Package", args.work_package_id);
  const packageName = packageRow?.name ?? args.work_package_id;
  const packageIdentity = packageRow?.work_package_id;
  if (packageIdentity && packageIdentity !== args.work_package_id) {
    throw new Error("work_package_completion_target_mismatch");
  }
  const typedScope = normalizeWorkPackageScopeArgs(args);
  if (typedScope) {
    if (args.roof_job_id && args.roof_job_id !== typedScope.work_object_id) {
      throw new Error("work_package_completion_scope_mismatch");
    }
    for (const [field, expected] of Object.entries(typedScope)) {
      if (packageRow?.[field] !== expected) {
        throw new Error(`work_package_completion_${field}_mismatch`);
      }
    }
    if (packageRow?.roof_job) {
      throw new Error("work_package_completion_non_roof_scope_mismatch");
    }
  } else {
    if (!args.roof_job_id) throw new Error("work_package_scope_required");
    if (packageRow?.roof_job && packageRow.roof_job !== args.roof_job_id) {
      throw new Error("work_package_completion_roof_job_mismatch");
    }
  }
  if (packageRow?.job_assignment && packageRow.job_assignment !== args.job_assignment_id) {
    throw new Error("work_package_completion_assignment_mismatch");
  }
  if (packageRow?.version != null && Number(packageRow.version) !== args.work_package_version) {
    throw new Error("work_package_completion_version_mismatch");
  }
  if (packageRow?.release_attempt_id && packageRow.release_attempt_id !== args.release_attempt_id) {
    throw new Error("work_package_completion_release_attempt_mismatch");
  }
  const eventRows = await listResources(config, "Work Package Event", {
    fields: WORK_PACKAGE_EVENT_FIELDS,
    filters: [["Work Package Event", "work_package", "=", packageName]],
    limit: 100,
    orderBy: "occurred_at asc",
  });
  return {
    would_write: false,
    online_only: true,
    command: "complete_work_package",
    target: { doctype: "Work Package", name: packageName },
    package: {
      status: packageRow?.status ?? null,
      version: packageRow?.version ?? null,
      release_attempt_id: packageRow?.release_attempt_id ?? null,
      work_object_type: packageRow?.work_object_type ?? null,
      work_object_id: packageRow?.work_object_id ?? null,
      physical_context_type: packageRow?.physical_context_type ?? null,
      physical_context_id: packageRow?.physical_context_id ?? null,
    },
    requested: {
      work_package_id: args.work_package_id,
      ...(args.roof_job_id ? { roof_job_id: args.roof_job_id } : {}),
      ...(typedScope ?? {}),
      job_assignment_id: args.job_assignment_id,
      completion_authority_user: args.completion_authority_user,
      device_action_id: args.device_action_id,
      work_package_version: args.work_package_version,
      release_attempt_id: args.release_attempt_id,
    },
    current_event_count: eventRows.length,
    current_event_types: [...new Set(eventRows.map((row) => row.event_type).filter(Boolean))].sort(),
    note: "Frappe rechecks roster, release attempt, holds, evidence, reviews, and independent authority at execution time; this preview is not completion proof.",
  };
}

function normalizeWorkPackageScopeArgs(args = {}) {
  const fields = [
    "work_object_type",
    "work_object_id",
    "physical_context_type",
    "physical_context_id",
  ];
  const supplied = fields.filter((field) => args[field] !== undefined);
  if (supplied.length === 0) return null;
  if (supplied.length !== fields.length) {
    throw new Error("work_package_scope_incomplete");
  }
  return Object.fromEntries(fields.map((field) => [field, args[field]]));
}

async function finalizeHermesRun(config, runId, patch) {
  try {
    await erpPut(config, resourcePath("Hermes Run", runId), patch);
    return null;
  } catch (err) {
    return String(err).slice(0, 500);
  }
}

// Shared approved-write flow: audit row BEFORE the mutation, execute, finalize the audit,
// mark the run failed on error. A caller-supplied run_id is a single-use mutation claim:
// only the request which successfully creates its Hermes Run may execute. Later retries
// either receive the completed result or fail closed, never resume an uncertain mutation.
/** MariaDB DATETIME columns reject ISO-8601 "T…Z" text; convert to Frappe's "YYYY-MM-DD HH:MM:SS". */
function frappeDatetimeIso(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace("T", " ").slice(0, 19);
}

export async function executeAuditedWrite(config, {
  runId,
  now,
  args,
  agentRole,
  toolName,
  target,
  roofJob,
  leadEnvelope,
  linkedEvidence,
  dryRun,
  beforeSummary,
  afterSummary,
  targetMutation = true,
  execute,
  responseExtra = {},
}) {
  const safeArgs = redactApprovalArgs(args);
  let existingRun = await readResourceOrNull(config, "Hermes Run", runId);
  if (existingRun) {
    assertHermesRunIdentity(existingRun, { runId, agentRole, toolName, target, safeArgs });
    if (existingRun.approval_status === "Executed" && existingRun.result_status === "OK") {
      return {
        run_id: runId,
        ...responseExtra,
        replayed: true,
        audit_finalized: true,
        result: parseStoredJson(existingRun.result_json),
      };
    }
    if (existingRun.approval_status === "Audit Failed" && Number(existingRun.mutation_applied) === 1) {
      throw new Error(
        `run_id_mutation_already_applied_audit_failed:${runId}:incident=${existingRun.audit_incident_id ?? "unknown"}`,
      );
    }
    throw new Error(`run_id_claimed_not_replayable:${runId}:${existingRun.approval_status ?? "unknown"}`);
  }

  const auditDraft = {
    run_id: runId,
    run_ts: frappeDatetimeIso(now),
    agent_role: agentRole,
    requested_by: args.__hermes_actor_user ?? args.approved_by,
    request_text: args.request_text,
    target_doctype: target.doctype,
    target_name: target.name,
    ...(roofJob ? { roof_job: roofJob } : {}),
    ...(leadEnvelope ? { lead_envelope: leadEnvelope } : {}),
    ...(linkedEvidence ? { linked_evidence: linkedEvidence } : {}),
    capability_level: "Approved-write",
    tool_name: toolName,
    tool_args_json: JSON.stringify(safeArgs),
    // The resource-side mutation commands independently verify this capability.
    // Keep receipts outside tool_args_json so ordinary audit projections never
    // confuse signed authority with mutable business arguments.
    dry_run_receipt: args.dry_run_receipt,
    approval_receipt: args.approval_receipt,
    dry_run_json: JSON.stringify(dryRun),
    policy_check_json: JSON.stringify({
      allowed: true,
      checks: ["tool_input_schema", "deterministic_builder", "signed_dry_run_receipt", "signed_human_approval_receipt", "doctype_validate_hook"],
      target,
    }),
    policy_checked_at: frappeDatetimeIso(now),
    policy_checked_by: args.__hermes_actor_user ?? args.approved_by,
    approval_status: "Approved",
    approved_by: args.approved_by,
    approved_at: frappeDatetimeIso(now),
    // Frappe Select fields default to their first option when omitted; an
    // implicit result_status="OK" trips the domain policy's result_json rule
    // for a run that has not executed yet. Send the explicit empty value.
    result_status: "",
    before_target_ids: JSON.stringify(beforeSummary),
    request_correlation_id: runId,
    mutation_applied: 0,
  };

  if (!existingRun) {
    try {
      await erpPost(config, "/api/resource/Hermes%20Run", auditDraft);
    } catch (err) {
      // The unique run_id creation is the atomic mutation claim. A losing concurrent
      // caller may replay a completed run but must never continue an in-flight one.
      if (!String(err).includes("erpnext_http_409")) throw err;
      existingRun = await readResourceOrNull(config, "Hermes Run", runId);
      if (!existingRun) throw err;
      assertHermesRunIdentity(existingRun, { runId, agentRole, toolName, target, safeArgs });
      if (existingRun.approval_status === "Executed" && existingRun.result_status === "OK") {
        return {
          run_id: runId,
          ...responseExtra,
          replayed: true,
          audit_finalized: true,
          result: parseStoredJson(existingRun.result_json),
        };
      }
      if (existingRun.approval_status === "Audit Failed" && Number(existingRun.mutation_applied) === 1) {
        throw new Error(
          `run_id_mutation_already_applied_audit_failed:${runId}:incident=${existingRun.audit_incident_id ?? "unknown"}`,
        );
      }
      throw new Error(`run_id_claimed_not_replayable:${runId}:${existingRun.approval_status ?? "unknown"}`);
    }
  }

  let mutationApplied = false;
  try {
    const externalEffectContext = {
      runId,
      toolName,
      target,
      mutationApplied: false,
    };
    const previousExternalEffectContext = config.__externalEffectContext;
    let result;
    try {
      config.__externalEffectContext = externalEffectContext;
      result = await execute();
    } catch (error) {
      mutationApplied = externalEffectContext.mutationApplied;
      throw error;
    } finally {
      if (previousExternalEffectContext === undefined) delete config.__externalEffectContext;
      else config.__externalEffectContext = previousExternalEffectContext;
    }
    mutationApplied = targetMutation || externalEffectContext.mutationApplied;
    const resolvedAfterSummary = typeof afterSummary === "function"
      ? afterSummary(result)
      : afterSummary;
    const completedAt = frappeDatetimeIso(new Date().toISOString());
    const auditError = await finalizeHermesRun(config, runId, {
      approval_status: "Executed",
      result_status: "OK",
      after_target_ids: JSON.stringify(resolvedAfterSummary),
      result_json: JSON.stringify(result),
      mutation_applied: mutationApplied ? 1 : 0,
      audit_event_id: `audit:${runId}`,
      request_correlation_id: runId,
      completed_at: completedAt,
    });
    if (auditError) {
      if (!mutationApplied) {
        throw new Error(`audit_finalize_failed_no_target_mutation:${runId}:${auditError}`);
      }
      const expectedIncidentId = `incident:audit:${runId}`;
      const incidentId = await recordAuditFinalizationIncident(config, {
        runId,
        now,
        roofJob,
        toolName,
        target,
        auditError,
      });
      await erpPut(config, resourcePath("Hermes Run", runId), {
        approval_status: "Audit Failed",
        result_status: "Error",
        after_target_ids: JSON.stringify(resolvedAfterSummary),
        result_json: JSON.stringify(result),
        error: auditError,
        mutation_applied: 1,
        audit_incident_id: incidentId ?? expectedIncidentId,
        request_correlation_id: runId,
        completed_at: completedAt,
      }).catch(() => {});
      throw new Error(
        `audit_finalize_failed:${runId}:incident=${incidentId ?? expectedIncidentId}:${auditError}`,
      );
    }
    return {
      run_id: runId,
      ...responseExtra,
      replayed: false,
      audit_finalized: true,
      result,
    };
  } catch (err) {
    if (!mutationApplied) {
      const failurePatch = {
        approval_status: "Failed",
        result_status: "Error",
        error: String(err).slice(0, 500),
        completed_at: frappeDatetimeIso(new Date().toISOString()),
        mutation_applied: 0,
      };
      if (err?.d1_action) {
        failurePatch.result_json = JSON.stringify({
          authority_terminal_action: err.d1_action,
          authority_terminal_evidence: err.d1_evidence ?? null,
        });
      }
      await erpPut(config, resourcePath("Hermes Run", runId), {
        ...failurePatch,
      }).catch(() => {});
    }
    throw err;
  }
}

function assertHermesRunIdentity(existing, { runId, agentRole, toolName, target, safeArgs }) {
  const mismatches = [];
  if (existing.run_id && existing.run_id !== runId) mismatches.push("run_id");
  if (existing.agent_role && existing.agent_role !== agentRole) mismatches.push("agent_role");
  if (existing.tool_name && existing.tool_name !== toolName) mismatches.push("tool_name");
  if (existing.target_doctype && existing.target_doctype !== target.doctype) mismatches.push("target_doctype");
  if (existing.target_name && existing.target_name !== target.name) mismatches.push("target_name");
  if (existing.tool_args_json && canonicalJson(parseStoredJson(existing.tool_args_json)) !== canonicalJson(safeArgs)) {
    mismatches.push("tool_args");
  }
  if (mismatches.length) throw new Error(`run_id_conflict:${runId}:${mismatches.join(",")}`);
}

async function recordAuditFinalizationIncident(config, {
  runId,
  now,
  roofJob,
  toolName,
  target,
  auditError,
}) {
  const incidentId = `incident:audit:${runId}`;
  const draft = buildAuditFinalizationIncidentDraft({
    incidentId,
    runId,
    now,
    roofJob,
    toolName,
    target,
    auditError,
  });
  try {
    const before = await readResourceOrNull(config, "Automation Incident", incidentId);
    if (before) await erpPut(config, resourcePath("Automation Incident", incidentId), draft);
    else await erpPost(config, "/api/resource/Automation%20Incident", draft);
    return incidentId;
  } catch {
    return null;
  }
}

export function buildAuditFinalizationIncidentDraft({
  incidentId,
  runId,
  now,
  roofJob,
  toolName,
  target,
  auditError,
}) {
  return {
    incident_id: incidentId,
    severity: "High",
    status: "Open",
    source_system: "erpnext-roofing-mcp",
    category: "Audit Finalization",
    summary: `Approved write completed but Hermes Run ${runId} could not be finalized`,
    details: JSON.stringify({ tool_name: toolName, target, audit_error: auditError }).slice(0, 4000),
    ...(roofJob ? { roof_job: roofJob } : {}),
    record_ref: `Hermes Run:${runId}`,
    correlation_id: runId,
    detected_at: frappeDatetimeIso(now),
  };
}

function parseStoredJson(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Shared upsert executor for request_create_* tools that write a full draft document.
function upsertDraftExecutor(config, doctype, name, draft, before) {
  return before
    ? () => erpPut(config, resourcePath(doctype, name), draft)
    : () => erpPost(config, `/api/resource/${encodeURIComponent(doctype)}`, draft);
}

function fieldAssignmentBoundUpsertExecutor(config, roofJobId, doctype, name, draft, before) {
  const execute = upsertDraftExecutor(config, doctype, name, draft, before);
  return async () => {
    if (config.agentRole === "field-companion") {
      await assertActorAssignedToRoofJob(config, roofJobId);
    }
    return await execute();
  };
}

async function buildProposalDraftFromErp(config, roofJobId, {
  customerQuoteId,
  limit = 25,
  nowIso,
} = {}) {
  const customerQuote = await readResource(config, "Customer Quote", customerQuoteId);
  assertProposalQuotePreparable(customerQuote, roofJobId);
  const [measurements, evidence] = await Promise.all([
    listResources(config, "Measurement Report", {
      fields: MEASUREMENT_REPORT_FIELDS,
      filters: [["Measurement Report", "roof_job", "=", roofJobId]],
      limit,
      orderBy: "modified desc",
    }),
    listResources(config, "Evidence Item", {
      fields: EVIDENCE_ITEM_FIELDS,
      filters: [["Evidence Item", "roof_job", "=", roofJobId]],
      limit,
      orderBy: "modified desc",
    }),
  ]);
  const draft = buildProposalEvidencePackDraft({
    roofJobId,
    customerQuote,
    measurements,
    evidence,
    nowIso,
  });
  return { draft, measurements, evidence, customerQuote };
}

function assertProposalPackWritable(before, draft) {
  if (!before) return;
  if (before.status !== "Draft") throw new Error("proposal_evidence_pack_not_draft");
  assertImmutableFields(before, draft, ["roof_job", "quotation"], "proposal_evidence_pack");
}

export function assertProposalPackPublishable(pack, proposalEvidencePackId) {
  if (!pack || pack.name !== proposalEvidencePackId || pack.pack_id !== proposalEvidencePackId) {
    throw new Error("proposal_evidence_pack_identity_mismatch");
  }
  if (pack.status !== "Draft") throw new Error("proposal_evidence_pack_not_draft");
  if (!str(pack.roof_job) || !str(pack.quotation)) {
    throw new Error("proposal_evidence_pack_anchor_missing");
  }
}

function snapshotText(value) {
  return value == null ? "" : String(value);
}

function snapshotValues(record, fields) {
  return Object.fromEntries(fields.map((field) => [field, snapshotText(record?.[field])]));
}

function parseShopAllocationsJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("shop_allocations_json_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length < 1) {
    throw new Error("shop_allocations_json_invalid");
  }
  const expectedKeys = ["allocation_id", "line_no", "material_lot", "reserved_quantity", "unit"];
  const seen = new Set();
  return parsed.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`shop_allocation_invalid:${index + 1}`);
    }
    const keys = Object.keys(row).sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`shop_allocation_invalid:${index + 1}`);
    }
    const allocationId = str(row.allocation_id);
    const materialLot = str(row.material_lot);
    const unit = str(row.unit);
    const lineNo = Number(row.line_no);
    const reservedQuantity = Number(row.reserved_quantity);
    if (!allocationId || !materialLot || !unit) {
      throw new Error(`shop_allocation_invalid:${index + 1}`);
    }
    if (!Number.isInteger(lineNo) || lineNo < 1) {
      throw new Error(`shop_allocation_line_invalid:${index + 1}`);
    }
    if (!Number.isFinite(reservedQuantity) || reservedQuantity <= 0) {
      throw new Error(`shop_allocation_quantity_invalid:${index + 1}`);
    }
    if (seen.has(allocationId)) {
      throw new Error("shop_allocation_duplicate_id");
    }
    seen.add(allocationId);
    return {
      allocation_id: allocationId,
      line_no: lineNo,
      material_lot: materialLot,
      reserved_quantity: snapshotText(row.reserved_quantity),
      unit,
    };
  });
}

function parseShopSetupPayloadJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("shop_setup_payload_invalid");
  }
  const result = ShopOrderSetupPayloadSchema.safeParse(parsed);
  if (!result.success) throw new Error("shop_setup_payload_invalid");
  const payload = result.data;
  if (payload.operations) {
    for (const [index, operation] of payload.operations.entries()) {
      if (operation.sequence !== index + 1) {
        throw new Error("shop_setup_operation_sequence_invalid");
      }
    }
  }
  return payload;
}

function parseShopFirstPiecePayloadJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("shop_first_piece_payload_invalid");
  }
  const result = ShopOrderFirstPiecePayloadSchema.safeParse(parsed);
  if (!result.success) throw new Error("shop_first_piece_payload_invalid");
  return result.data;
}

function parseShopFinalQualityPayloadJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("shop_final_quality_payload_invalid");
  }
  const result = ShopOrderFinalQualityPayloadSchema.safeParse(parsed);
  if (!result.success) throw new Error("shop_final_quality_payload_invalid");

  const inspection = (row) => ({
    ...row,
    measured_value: parseFirstPieceDecimal(row.measured_value, {
      allowZero: true,
      errorCode: "shop_final_quality_payload_invalid",
    }).text,
  });
  const yieldRow = (row) => {
    const input = parseFirstPieceDecimal(row.input_quantity, {
      allowZero: false,
      errorCode: "shop_final_quality_payload_invalid",
    });
    const finished = parseFirstPieceDecimal(row.finished_quantity, {
      allowZero: true,
      errorCode: "shop_final_quality_payload_invalid",
    });
    const remnant = parseFirstPieceDecimal(row.remnant_quantity, {
      allowZero: true,
      errorCode: "shop_final_quality_payload_invalid",
    });
    const scrap = parseFirstPieceDecimal(row.scrap_quantity, {
      allowZero: true,
      errorCode: "shop_final_quality_payload_invalid",
    });
    if (scrap.significand === 0n) {
      if (row.scrap_disposition || row.evidence_item) {
        throw new Error("shop_final_quality_payload_invalid");
      }
    } else if (!row.scrap_disposition || !row.evidence_item) {
      throw new Error("shop_final_quality_payload_invalid");
    }
    return {
      ...row,
      input_quantity: input.text,
      finished_quantity: finished.text,
      remnant_quantity: remnant.text,
      scrap_quantity: scrap.text,
    };
  };
  const bundle = (row) => ({
    ...row,
    accepted_quantity: parseFirstPieceDecimal(row.accepted_quantity, {
      allowZero: false,
      errorCode: "shop_final_quality_payload_invalid",
    }).text,
  });

  if (result.data.action === "fail_to_quality_hold") {
    return { ...result.data, inspection: inspection(result.data.inspection) };
  }
  const inspections = result.data.inspections.map(inspection);
  const yields = result.data.yields.map(yieldRow);
  const bundles = result.data.bundles.map(bundle);
  if (
    new Set(inspections.map((row) => row.line_no)).size !== inspections.length
    || new Set(inspections.map((row) => row.allocation_id)).size !== inspections.length
    || new Set(yields.map((row) => row.allocation_id)).size !== yields.length
    || new Set(bundles.map((row) => row.bundle_id)).size !== bundles.length
  ) {
    throw new Error("shop_final_quality_payload_invalid");
  }
  return { ...result.data, inspections, yields, bundles };
}

function parseShopHandoverPayloadJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("shop_handover_payload_invalid");
  }
  const result = ShopOrderHandoverPayloadSchema.safeParse(parsed);
  if (!result.success) throw new Error("shop_handover_payload_invalid");
  return result.data;
}

function parseShopBillingBasisPayloadJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("shop_billing_basis_payload_invalid");
  }
  const result = ShopOrderBillingBasisPayloadSchema.safeParse(parsed);
  if (!result.success) throw new Error("shop_billing_basis_payload_invalid");
  return result.data;
}

function controlledItemSnapshot(item) {
  return {
    controlled_item: snapshotValues(item, ["name", "controlled_item_id", "status", "modified"]),
  };
}

function materialLotSnapshot(lot) {
  return {
    material_lot: snapshotValues(lot, [
      "name",
      "material_lot_id",
      "roof_job",
      "controlled_item",
      "source_kind",
      "supplier_order",
      "source_shop_order",
      "source_evidence",
      "condition_status",
      "received_quantity",
      "unit",
      "status",
      "available_quantity",
      "reserved_quantity",
      "consumed_quantity",
      "modified",
    ]),
  };
}

function shopOrderSnapshot(order, lots = []) {
  const snapshot = {
    shop_order: snapshotValues(order, [
      "name",
      "shop_order_id",
      "roof_job",
      "material_takeoff",
      "supplier_order",
      "work_package",
      "status",
      "modified",
    ]),
  };
  if (lots.length) {
    snapshot.material_lots = lots.map((lot) => snapshotValues(lot, [
      "name",
      "material_lot_id",
      "roof_job",
      "controlled_item",
      "unit",
      "status",
      "available_quantity",
      "reserved_quantity",
      "consumed_quantity",
      "modified",
    ]));
  }
  return snapshot;
}

function shopOrderSetupSnapshot(order) {
  const snapshot = shopOrderSnapshot(order);
  Object.assign(snapshot.shop_order, snapshotValues(order, [
    "setup_started_at",
    "fabrication_started_at",
    "quality_hold_reason",
  ]));
  snapshot.operations = (Array.isArray(order.operations) ? order.operations : []).map((operation) => snapshotValues(operation, [
    "sequence",
    "operation",
    "machine_tooling",
    "operator",
    "status",
    "started_at",
    "completed_at",
    "notes",
  ]));
  return snapshot;
}

function shopOrderFirstPieceSnapshot(order, lots = [], evidence = [], sources = {}, inspectorAuthority = {}) {
  const snapshot = shopOrderSetupSnapshot(order);
  snapshot.lines = (Array.isArray(order.lines) ? order.lines : []).map((line) => snapshotValues(line, [
    "line_no",
    "controlled_item",
    "requested_quantity",
    "accepted_quantity",
    "billable_quantity",
    "unit",
    "dimensions",
    "tolerance",
    "orientation",
    "invoice_basis",
    "needs_review",
  ]));
  snapshot.material_allocations = (Array.isArray(order.material_allocations) ? order.material_allocations : []).map((allocation) => snapshotValues(allocation, [
    "allocation_id",
    "line_no",
    "material_lot",
    "reserved_quantity",
    "issued_quantity",
    "unit",
    "status",
    "needs_review",
  ]));
  snapshot.inspections = (Array.isArray(order.inspections) ? order.inspections : []).map((inspection) => snapshotValues(inspection, [
    "inspection_type",
    "line_no",
    "allocation_id",
    "operation_sequence",
    "result",
    "nominal_value",
    "measured_value",
    "tolerance_value",
    "measurement_unit",
    "measured_result",
    "inspected_by",
    "inspected_at",
    "evidence_item",
    "needs_review",
  ]));
  snapshot.material_lots = lots.map((lot) => snapshotValues(lot, [
    "name",
    "material_lot_id",
    "roof_job",
    "controlled_item",
    "unit",
    "status",
    "available_quantity",
    "reserved_quantity",
    "consumed_quantity",
    "modified",
  ]));
  snapshot.evidence = evidence.map((item) => snapshotValues(item, [
    "name",
    "evidence_id",
    "roof_job",
    "evidence_type",
    "proof_owner",
    "proof_slot",
    "source_system",
    "r2_key",
    "content_checksum",
    "checksum_algorithm",
    "content_type",
    "content_length",
    "capture_actor",
    "captured_at",
    "sync_state",
    "verified_at",
    "verification_source",
    "device_action_id",
    "modified",
  ]));
  snapshot.source_records = {
    material_takeoff: snapshotValues(sources.materialTakeoff, ["name", "roof_job", "status", "modified"]),
    supplier_order: snapshotValues(sources.supplierOrder, ["name", "roof_job", "status", "modified"]),
    work_package: snapshotValues(sources.workPackage, [
      "name",
      "work_package_id",
      "roof_job",
      "job_assignment",
      "safety_plan",
      "version",
      "status",
      "expires_at",
      "acknowledged_by",
      "acknowledged_at",
      "started_at",
      "modified",
    ]),
  };
  snapshot.inspector_authority = {
    authenticated_user: snapshotText(inspectorAuthority.authenticatedUser),
    job_assignment: snapshotValues(inspectorAuthority.jobAssignment, [
      "name",
      "assignment_id",
      "roof_job",
      "assignment_type",
      "status",
      "crew_profile",
      "assigned_user",
      "scheduled_start",
      "supersedes",
      "modified",
    ]),
    crew_profile: snapshotValues(inspectorAuthority.crewProfile, [
      "name",
      "crew_profile_id",
      "status",
      "crew_type",
      "competency_status",
      "competency_checked_at",
      "competency_expiry",
      "equipment_status",
      "equipment_checked_at",
      "equipment_expiry",
      "wcb_status",
      "wcb_checked_at",
      "wcb_expiry",
      "active_stop",
      "active_stop_at",
      "active_stop_reason",
      "modified",
    ]),
    assignment_role: snapshotText(inspectorAuthority.assignmentRole),
  };
  return snapshot;
}

function shopOrderFinalQualitySnapshot(order, lots = [], evidence = [], sources = {}, inspectorAuthority = {}) {
  const snapshot = shopOrderFirstPieceSnapshot(order, lots, evidence, sources, inspectorAuthority);
  Object.assign(snapshot.shop_order, snapshotValues(order, [
    "ready_at",
    "handed_over_to",
    "handed_over_at",
    "handoff_evidence",
    "invoice_payment_milestone",
    "invoice_ready_at",
  ]));
  snapshot.yields = (Array.isArray(order.yields) ? order.yields : []).map((row) => snapshotValues(row, [
    "allocation_id",
    "operation_sequence",
    "input_quantity",
    "finished_quantity",
    "remnant_quantity",
    "remnant_lot",
    "scrap_quantity",
    "scrap_disposition",
    "evidence_item",
  ]));
  snapshot.bundles = (Array.isArray(order.bundles) ? order.bundles : []).map((row) => snapshotValues(row, [
    "bundle_id",
    "line_no",
    "material_lot",
    "piece_identity",
    "accepted_quantity",
    "unit",
    "label_text",
    "handoff_status",
    "handed_over_to",
    "handed_over_at",
    "handoff_evidence",
    "condition",
    "needs_review",
  ]));
  return snapshot;
}

function shopOrderHandoverSnapshot(order, evidence = [], sources = {}) {
  const snapshot = shopOrderSnapshot(order);
  Object.assign(snapshot.shop_order, snapshotValues(order, [
    "ready_at",
    "handed_over_to",
    "handed_over_at",
    "handoff_evidence",
    "invoice_payment_milestone",
    "invoice_ready_at",
  ]));
  snapshot.bundles = (Array.isArray(order.bundles) ? order.bundles : []).map((row) => snapshotValues(row, [
    "bundle_id",
    "line_no",
    "material_lot",
    "piece_identity",
    "accepted_quantity",
    "unit",
    "label_text",
    "handoff_status",
    "handed_over_to",
    "handed_over_at",
    "handoff_evidence",
    "condition",
    "needs_review",
  ]));
  snapshot.evidence = evidence.map((item) => snapshotValues(item, [
    "name",
    "evidence_id",
    "roof_job",
    "sync_state",
    "modified",
  ]));
  snapshot.source_records = Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [
      name,
      snapshotValues(source, ["name", "roof_job", "status", "modified"]),
    ]),
  );
  return snapshot;
}

function paymentMilestoneSnapshot(paymentMilestone) {
  return snapshotValues(paymentMilestone, [
    "name",
    "payment_milestone_id",
    "roof_job",
    "shop_order",
    "milestone_type",
    "status",
    "qb_entity_type",
    "qb_entity_id",
    "raw_key",
    "modified",
  ]);
}

function shopOrderBillingBasisSnapshot(order, paymentMilestone, handoffEvidence, sources) {
  const snapshot = shopOrderHandoverSnapshot(order, [handoffEvidence], sources);
  snapshot.payment_milestone = paymentMilestoneSnapshot(paymentMilestone);
  return snapshot;
}

function summarizeControlledItem(item) {
  return {
    controlled_item_id: item.controlled_item_id ?? item.name,
    status: item.status ?? "",
    source_ref: item.source_ref ?? "",
    modified: item.modified ?? "",
  };
}

function summarizeMaterialLot(lot) {
  return {
    material_lot_id: lot.material_lot_id ?? lot.name,
    roof_job: lot.roof_job ?? "",
    controlled_item: lot.controlled_item ?? "",
    source_kind: lot.source_kind ?? "",
    supplier_order: lot.supplier_order ?? "",
    source_shop_order: lot.source_shop_order ?? "",
    status: lot.status ?? "",
    available_quantity: snapshotText(lot.available_quantity),
    reserved_quantity: snapshotText(lot.reserved_quantity),
    consumed_quantity: snapshotText(lot.consumed_quantity),
    modified: lot.modified ?? "",
  };
}

function summarizeShopOrder(order) {
  return {
    shop_order_id: order.shop_order_id ?? order.name,
    roof_job: order.roof_job ?? "",
    material_takeoff: order.material_takeoff ?? "",
    supplier_order: order.supplier_order ?? "",
    work_package: order.work_package ?? "",
    status: order.status ?? "",
    line_count: Array.isArray(order.lines) ? order.lines.length : 0,
    allocation_count: Array.isArray(order.material_allocations) ? order.material_allocations.length : 0,
    modified: order.modified ?? "",
  };
}

function assertControlledItemReadyForApproval(item, controlledItemId) {
  if (!item || item.name !== controlledItemId || item.controlled_item_id !== controlledItemId) {
    throw new Error("controlled_item_identity_mismatch");
  }
  if (item.status !== "Draft") throw new Error("controlled_item_not_draft");
}

function assertMaterialLotReadyForReceipt(lot, materialLotId) {
  if (!lot || lot.name !== materialLotId || lot.material_lot_id !== materialLotId) {
    throw new Error("material_lot_identity_mismatch");
  }
  if (lot.status !== "Draft") throw new Error("material_lot_not_draft");
}

function assertShopOrderReadyForRelease(order, shopOrderId) {
  if (!order || order.name !== shopOrderId || order.shop_order_id !== shopOrderId) {
    throw new Error("shop_order_identity_mismatch");
  }
  if (order.status !== "Draft") throw new Error("shop_order_not_draft");
}

function assertShopOrderReadyForReservation(order, shopOrderId) {
  if (!order || order.name !== shopOrderId || order.shop_order_id !== shopOrderId) {
    throw new Error("shop_order_identity_mismatch");
  }
  if (order.status !== "Released") throw new Error("shop_order_not_released");
}

function assertShopOrderReadyForSetupAction(order, shopOrderId, payload) {
  if (!order || order.name !== shopOrderId || order.shop_order_id !== shopOrderId) {
    throw new Error("shop_order_identity_mismatch");
  }
  const hasRoute = Array.isArray(order.operations) && order.operations.length > 0;
  if (payload.action === "begin_setup") {
    if (order.status !== "Reserved") throw new Error("shop_order_not_reservable_for_setup");
    if (hasRoute) throw new Error("shop_setup_route_already_exists");
    return;
  }
  if (payload.action === "place_quality_hold") {
    if (!["Reserved", "Setup / First Piece"].includes(order.status)) {
      throw new Error("shop_order_not_holdable_during_setup");
    }
    return;
  }
  if (order.status !== "Quality Hold") throw new Error("shop_order_not_resumable_to_setup");
  if (hasRoute && payload.operations) throw new Error("shop_setup_route_already_exists");
  if (!hasRoute && !payload.operations) throw new Error("shop_setup_route_required");
}

function assertShopOrderReadyForFirstPieceOutcome(order, shopOrderId) {
  if (!order || order.name !== shopOrderId || order.shop_order_id !== shopOrderId) {
    throw new Error("shop_order_identity_mismatch");
  }
  if (order.status !== "Setup / First Piece") {
    throw new Error("shop_order_not_ready_for_first_piece");
  }
}

function assertShopOrderReadyForFinalQuality(order, shopOrderId) {
  if (!order || order.name !== shopOrderId || order.shop_order_id !== shopOrderId) {
    throw new Error("shop_order_identity_mismatch");
  }
  if (order.status !== "In Fabrication") {
    throw new Error("shop_order_not_ready_for_final_quality");
  }
}

function assertShopOrderReadyForHandover(order, shopOrderId) {
  if (!order || order.name !== shopOrderId || order.shop_order_id !== shopOrderId) {
    throw new Error("shop_order_identity_mismatch");
  }
  if (order.status !== "Ready") throw new Error("shop_order_not_ready_for_handover");
  const bundles = Array.isArray(order.bundles) ? order.bundles : [];
  if (!bundles.length || bundles.some((bundle) => (
    bundle.handoff_status !== "Prepared"
    || bundle.handed_over_to
    || bundle.handed_over_at
    || bundle.handoff_evidence
  ))) {
    throw new Error("shop_handover_bundle_state_invalid");
  }
  if (order.handed_over_to || order.handed_over_at || order.handoff_evidence) {
    throw new Error("shop_handover_already_recorded");
  }
}

function assertShopOrderReadyForBillingBasis(order, shopOrderId) {
  if (!order || order.name !== shopOrderId || order.shop_order_id !== shopOrderId) {
    throw new Error("shop_order_identity_mismatch");
  }
  if (order.status !== "Handed Over") {
    throw new Error("shop_order_not_ready_for_billing_basis");
  }
  if (order.invoice_payment_milestone || order.invoice_ready_at) {
    throw new Error("shop_billing_basis_already_recorded");
  }
}

function assertShopBillingBasis(order, paymentMilestone) {
  if (
    !paymentMilestone
    || paymentMilestone.roof_job !== order.roof_job
    || paymentMilestone.shop_order !== order.shop_order_id
  ) {
    throw new Error("shop_billing_basis_lineage_mismatch");
  }
  if (!["Webhook Seen", "Needs Review", "Matched"].includes(paymentMilestone.status)) {
    throw new Error("shop_billing_basis_unverified");
  }
  if (
    paymentMilestone.milestone_type !== "Invoice"
    || paymentMilestone.qb_entity_type !== "Invoice"
    || !paymentMilestone.qb_entity_id
    || !paymentMilestone.raw_key
  ) {
    throw new Error("shop_billing_basis_unverified");
  }
}

const FirstPieceDimensionPattern = /^([0-9]+(?:\.[0-9]+)?) ([A-Za-z][A-Za-z0-9/_-]{0,31})$/;
const FirstPieceTolerancePattern = /^(?:±|\+\/-) ([0-9]+(?:\.[0-9]+)?) ([A-Za-z][A-Za-z0-9/_-]{0,31})$/;

function parseFirstPieceDecimal(value, { allowZero, errorCode }) {
  if (typeof value !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    throw new Error(errorCode);
  }
  const [rawWhole, rawFraction = ""] = value.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  const fraction = rawFraction.replace(/0+$/, "");
  const significand = BigInt(`${whole}${fraction}`);
  if (allowZero ? significand < 0n : significand <= 0n) {
    throw new Error(errorCode);
  }
  return {
    significand,
    scale: fraction.length,
    text: fraction ? `${whole}.${fraction}` : whole,
  };
}

function parseFirstPieceStoredDecimal(value, { allowZero, errorCode }) {
  if (typeof value === "boolean" || value == null) throw new Error(errorCode);
  return parseFirstPieceDecimal(String(value), { allowZero, errorCode });
}

function firstPieceDecimalAtScale(value, scale) {
  return value.significand * (10n ** BigInt(scale - value.scale));
}

function firstPieceWithinTolerance(measuredValue, nominalValue, toleranceValue) {
  const scale = Math.max(measuredValue.scale, nominalValue.scale, toleranceValue.scale);
  const difference = firstPieceDecimalAtScale(measuredValue, scale)
    - firstPieceDecimalAtScale(nominalValue, scale);
  const absoluteDifference = difference < 0n ? -difference : difference;
  return absoluteDifference <= firstPieceDecimalAtScale(toleranceValue, scale);
}

function parseFirstPieceMeasurementSpec(line) {
  const dimensions = typeof line?.dimensions === "string"
    ? line.dimensions.match(FirstPieceDimensionPattern)
    : null;
  const tolerance = typeof line?.tolerance === "string"
    ? line.tolerance.match(FirstPieceTolerancePattern)
    : null;
  if (!dimensions || !tolerance || dimensions[2].toLowerCase() !== tolerance[2].toLowerCase()) {
    throw new Error("shop_first_piece_measurement_spec_invalid");
  }
  return {
    nominalValue: parseFirstPieceDecimal(dimensions[1], {
      allowZero: false,
      errorCode: "shop_first_piece_measurement_spec_invalid",
    }),
    toleranceValue: parseFirstPieceDecimal(tolerance[1], {
      allowZero: false,
      errorCode: "shop_first_piece_measurement_spec_invalid",
    }),
    measurementUnit: dimensions[2].toLowerCase(),
  };
}

function assertFirstPieceInspectionRows(order, payload, actorUser) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const allocations = Array.isArray(order.material_allocations) ? order.material_allocations : [];
  const operations = Array.isArray(order.operations) ? order.operations : [];
  if (!lines.length || !allocations.length || !operations.length) {
    throw new Error("shop_first_piece_context_missing");
  }
  const linesByNumber = new Map(lines.map((line) => [Number(line.line_no), line]));
  const allocationsById = new Map(allocations.map((allocation) => [String(allocation.allocation_id), allocation]));
  const operationsBySequence = new Map(operations.map((operation) => [Number(operation.sequence), operation]));
  const requestedInspections = payload.action === "pass_to_fabrication"
    ? payload.inspections
    : [payload.inspection];
  const seenLines = new Set();
  const seenAllocations = new Set();
  const inspections = [];

  for (const allocation of allocations) {
    if (allocation.status !== "Reserved") {
      throw new Error("shop_first_piece_allocation_not_reserved");
    }
    const issuedQuantity = parseFirstPieceStoredDecimal(allocation.issued_quantity, {
      allowZero: true,
      errorCode: "shop_first_piece_allocation_quantity_invalid",
    });
    if (issuedQuantity.significand !== 0n) {
      throw new Error("shop_first_piece_allocation_already_issued");
    }
  }

  for (const inspection of requestedInspections) {
    const line = linesByNumber.get(inspection.line_no);
    if (!line) throw new Error("shop_first_piece_line_invalid");
    const allocation = allocationsById.get(inspection.allocation_id);
    if (!allocation) throw new Error("shop_first_piece_allocation_invalid");
    if (Number(allocation.line_no) !== inspection.line_no) {
      throw new Error("shop_first_piece_allocation_line_mismatch");
    }
    const operation = operationsBySequence.get(inspection.operation_sequence);
    if (!operation) throw new Error("shop_first_piece_operation_invalid");
    if (!new Set(["In Progress", "Complete"]).has(operation.status) || !operation.started_at) {
      throw new Error("shop_first_piece_operation_not_started");
    }
    if (operation.operator === actorUser) {
      throw new Error("shop_first_piece_inspector_not_independent");
    }
    if (seenLines.has(inspection.line_no)) {
      throw new Error("shop_first_piece_duplicate_line");
    }
    if (seenAllocations.has(inspection.allocation_id)) {
      throw new Error("shop_first_piece_duplicate_allocation");
    }
    seenLines.add(inspection.line_no);
    seenAllocations.add(inspection.allocation_id);
    const measurement = parseFirstPieceMeasurementSpec(line);
    if (inspection.measurement_unit.toLowerCase() !== measurement.measurementUnit) {
      throw new Error("shop_first_piece_measurement_unit_mismatch");
    }
    const issuedQuantity = parseFirstPieceDecimal(inspection.issued_quantity, {
      allowZero: false,
      errorCode: "shop_first_piece_issued_quantity_invalid",
    });
    const measuredValue = parseFirstPieceDecimal(inspection.measured_value, {
      allowZero: true,
      errorCode: "shop_first_piece_measured_value_invalid",
    });
    if (firstPieceWithinTolerance(measuredValue, measurement.nominalValue, measurement.toleranceValue)
      !== (payload.action === "pass_to_fabrication")) {
      throw new Error("shop_first_piece_tolerance_result_mismatch");
    }
    inspections.push({
      ...inspection,
      issued_quantity: issuedQuantity.text,
      nominal_value: measurement.nominalValue.text,
      measured_value: measuredValue.text,
      tolerance_value: measurement.toleranceValue.text,
      measurement_unit: measurement.measurementUnit,
      measured_result: `${measuredValue.text} ${measurement.measurementUnit}; nominal ${measurement.nominalValue.text} +/- ${measurement.toleranceValue.text} ${measurement.measurementUnit}`,
    });
  }

  if (payload.action === "pass_to_fabrication" && (
    seenLines.size !== linesByNumber.size
    || [...linesByNumber.keys()].some((lineNo) => !seenLines.has(lineNo))
  )) {
    throw new Error("shop_first_piece_passes_incomplete");
  }
  return { linesByNumber, allocations, inspections };
}

function assertFirstPieceMaterialLots(order, linesByNumber, allocations, inspections, lots) {
  const lotsById = new Map();
  for (const lot of lots) {
    lotsById.set(String(lot.name ?? ""), lot);
    lotsById.set(String(lot.material_lot_id ?? ""), lot);
  }
  for (const allocation of allocations) {
    const materialLotId = String(allocation.material_lot ?? "");
    const lot = lotsById.get(materialLotId);
    const line = linesByNumber.get(Number(allocation.line_no));
    if (!lot || !line || (lot.material_lot_id && lot.material_lot_id !== materialLotId)) {
      throw new Error("shop_first_piece_lot_mismatch");
    }
    if (lot.roof_job !== order.roof_job
      || lot.controlled_item !== line.controlled_item
      || allocation.unit !== line.unit
      || lot.unit !== line.unit) {
      throw new Error("shop_first_piece_lot_mismatch");
    }
    if (lot.status !== "Reserved") throw new Error("shop_first_piece_lot_not_reserved");
  }
  const issuedByLot = new Map();
  for (const inspection of inspections) {
    const allocation = allocations.find(({ allocation_id }) => allocation_id === inspection.allocation_id);
    const lotId = String(allocation?.material_lot ?? "");
    const prior = issuedByLot.get(lotId) ?? { significand: 0n, scale: 0 };
    const issued = parseFirstPieceDecimal(inspection.issued_quantity, {
      allowZero: false,
      errorCode: "shop_first_piece_issued_quantity_invalid",
    });
    const allocationReserved = parseFirstPieceStoredDecimal(allocation?.reserved_quantity, {
      allowZero: false,
      errorCode: "shop_first_piece_allocation_quantity_invalid",
    });
    if (firstPieceDecimalAtScale(issued, Math.max(issued.scale, allocationReserved.scale))
      > firstPieceDecimalAtScale(allocationReserved, Math.max(issued.scale, allocationReserved.scale))) {
      throw new Error("shop_first_piece_issue_exceeds_reservation");
    }
    const scale = Math.max(prior.scale, issued.scale);
    issuedByLot.set(lotId, {
      significand: firstPieceDecimalAtScale(prior, scale) + firstPieceDecimalAtScale(issued, scale),
      scale,
    });
  }
  for (const [lotId, issuedQuantity] of issuedByLot) {
    const lot = lotsById.get(lotId);
    const lotReserved = parseFirstPieceStoredDecimal(lot?.reserved_quantity, {
      allowZero: false,
      errorCode: "shop_first_piece_lot_reservation_invalid",
    });
    const scale = Math.max(issuedQuantity.scale, lotReserved.scale);
    if (firstPieceDecimalAtScale(issuedQuantity, scale)
      > firstPieceDecimalAtScale(lotReserved, scale)) {
      throw new Error("shop_first_piece_issue_exceeds_lot_reservation");
    }
  }
}

function assertFinalQualityInspectionRows(order, payload, actorUser) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const allocations = Array.isArray(order.material_allocations) ? order.material_allocations : [];
  const operations = Array.isArray(order.operations) ? order.operations : [];
  if (!lines.length || !allocations.length || !operations.length) {
    throw new Error("shop_final_quality_context_missing");
  }
  if (
    (Array.isArray(order.yields) && order.yields.length)
    || (Array.isArray(order.bundles) && order.bundles.length)
    || (Array.isArray(order.inspections) && order.inspections.some(
      (row) => row.inspection_type === "Final",
    ))
  ) {
    throw new Error("shop_final_quality_already_recorded");
  }
  const linesByNumber = new Map(lines.map((line) => [Number(line.line_no), line]));
  const allocationsById = new Map(allocations.map((allocation) => [String(allocation.allocation_id), allocation]));
  const operationsBySequence = new Map(operations.map((operation) => [Number(operation.sequence), operation]));
  const firstPiecePasses = new Set((Array.isArray(order.inspections) ? order.inspections : [])
    .filter((row) => row.inspection_type === "First Piece" && row.result === "Pass")
    .map((row) => Number(row.line_no)));
  if ([...linesByNumber.keys()].some((lineNo) => !firstPiecePasses.has(lineNo))) {
    throw new Error("shop_final_quality_missing_first_piece_pass");
  }
  for (const allocation of allocations) {
    const issued = parseFirstPieceStoredDecimal(allocation.issued_quantity, {
      allowZero: true,
      errorCode: "shop_final_quality_allocation_quantity_invalid",
    });
    const reserved = parseFirstPieceStoredDecimal(allocation.reserved_quantity, {
      allowZero: false,
      errorCode: "shop_final_quality_allocation_quantity_invalid",
    });
    if (allocation.status !== "Issued" || issued.significand <= 0n || firstPieceDecimalCompare(issued, reserved) > 0n) {
      throw new Error("shop_final_quality_allocation_not_issued");
    }
  }
  const requestedInspections = payload.action === "pass_to_ready"
    ? payload.inspections
    : [payload.inspection];
  const inspections = [];
  for (const row of requestedInspections) {
    const line = linesByNumber.get(row.line_no);
    const allocation = allocationsById.get(row.allocation_id);
    const operation = operationsBySequence.get(row.operation_sequence);
    if (!line || !allocation || !operation || Number(allocation.line_no) !== row.line_no) {
      throw new Error("shop_final_quality_reference_invalid");
    }
    if (operation.status !== "Complete" || !operation.completed_at) {
      throw new Error("shop_final_quality_operation_incomplete");
    }
    if (operation.operator === actorUser) {
      throw new Error("shop_final_quality_inspector_not_independent");
    }
    const measurement = parseFirstPieceMeasurementSpec(line);
    if (row.measurement_unit.toLowerCase() !== measurement.measurementUnit) {
      throw new Error("shop_final_quality_measurement_unit_mismatch");
    }
    const measured = parseFirstPieceDecimal(row.measured_value, {
      allowZero: true,
      errorCode: "shop_final_quality_measured_value_invalid",
    });
    if (firstPieceWithinTolerance(measured, measurement.nominalValue, measurement.toleranceValue)
      !== (payload.action === "pass_to_ready")) {
      throw new Error("shop_final_quality_tolerance_result_mismatch");
    }
    inspections.push({
      ...row,
      nominal_value: measurement.nominalValue.text,
      measured_value: measured.text,
      tolerance_value: measurement.toleranceValue.text,
      measurement_unit: measurement.measurementUnit,
      measured_result: `${measured.text} ${measurement.measurementUnit}; nominal ${measurement.nominalValue.text} +/- ${measurement.toleranceValue.text} ${measurement.measurementUnit}`,
    });
  }
  if (payload.action === "pass_to_ready" && (
    inspections.length !== linesByNumber.size
    || [...linesByNumber.keys()].some((lineNo) => !inspections.some((row) => row.line_no === lineNo))
  )) {
    throw new Error("shop_final_quality_passes_incomplete");
  }
  return { linesByNumber, allocations, allocationsById, operations, operationsBySequence, inspections };
}

function assertFinalQualityMaterialLots(order, linesByNumber, allocations, lots) {
  const lotsById = new Map();
  for (const lot of lots) {
    lotsById.set(String(lot.name ?? ""), lot);
    lotsById.set(String(lot.material_lot_id ?? ""), lot);
  }
  const allocationLotsByLine = new Map();
  for (const allocation of allocations) {
    const materialLotId = String(allocation.material_lot ?? "");
    const lot = lotsById.get(materialLotId);
    const lineNo = Number(allocation.line_no);
    const line = linesByNumber.get(lineNo);
    if (!lot || !line || (lot.material_lot_id && lot.material_lot_id !== materialLotId)
      || !["Reserved", "Available", "Consumed"].includes(lot.status)
      || lot.roof_job !== order.roof_job
      || lot.controlled_item !== line.controlled_item
      || allocation.unit !== line.unit
      || lot.unit !== line.unit) {
      throw new Error("shop_final_quality_lot_mismatch");
    }
    const lineLots = allocationLotsByLine.get(lineNo) ?? new Set();
    lineLots.add(materialLotId);
    allocationLotsByLine.set(lineNo, lineLots);
  }
  return { lotsById, allocationLotsByLine };
}

function finalQualityDifferenceWithin(left, right, tolerance) {
  const scale = Math.max(left.scale, right.scale, tolerance.scale);
  const difference = firstPieceDecimalAtScale(left, scale) - firstPieceDecimalAtScale(right, scale);
  const absoluteDifference = difference < 0n ? -difference : difference;
  return absoluteDifference <= firstPieceDecimalAtScale(tolerance, scale);
}

function validateFinalQualityOutput(payload, state) {
  if (payload.action !== "pass_to_ready") return { yields: [], bundles: [] };
  const allocationIds = new Set(state.allocations.map((allocation) => String(allocation.allocation_id)));
  if (payload.yields.length !== allocationIds.size
    || payload.yields.some((row) => !allocationIds.has(row.allocation_id))) {
    throw new Error("shop_final_quality_yields_incomplete");
  }
  const issueDeltaByLot = new Map();
  const finishedByLine = new Map();
  const conservationTolerance = parseFirstPieceDecimal("0.01", {
    allowZero: true,
    errorCode: "shop_final_quality_yield_mismatch",
  });
  for (const row of payload.yields) {
    const allocation = state.allocationsById.get(row.allocation_id);
    const operation = state.operationsBySequence.get(row.operation_sequence);
    if (!allocation || !operation || operation.status !== "Complete" || !operation.completed_at) {
      throw new Error("shop_final_quality_reference_invalid");
    }
    const input = parseFirstPieceDecimal(row.input_quantity, {
      allowZero: false,
      errorCode: "shop_final_quality_yield_mismatch",
    });
    const finished = parseFirstPieceDecimal(row.finished_quantity, {
      allowZero: true,
      errorCode: "shop_final_quality_yield_mismatch",
    });
    const remnant = parseFirstPieceDecimal(row.remnant_quantity, {
      allowZero: true,
      errorCode: "shop_final_quality_yield_mismatch",
    });
    const scrap = parseFirstPieceDecimal(row.scrap_quantity, {
      allowZero: true,
      errorCode: "shop_final_quality_yield_mismatch",
    });
    if (!finalQualityDifferenceWithin(input, firstPieceDecimalAdd(firstPieceDecimalAdd(finished, remnant), scrap), conservationTolerance)) {
      throw new Error("shop_final_quality_yield_mismatch");
    }
    const reserved = parseFirstPieceStoredDecimal(allocation.reserved_quantity, {
      allowZero: false,
      errorCode: "shop_final_quality_yield_mismatch",
    });
    const issued = parseFirstPieceStoredDecimal(allocation.issued_quantity, {
      allowZero: true,
      errorCode: "shop_final_quality_yield_mismatch",
    });
    if (firstPieceDecimalCompare(input, reserved) !== 0n || firstPieceDecimalCompare(issued, input) > 0n) {
      throw new Error("shop_final_quality_yield_mismatch");
    }
    const lotId = String(allocation.material_lot ?? "");
    const nextDelta = firstPieceDecimalAdd(
      issueDeltaByLot.get(lotId) ?? firstPieceDecimalValue(0n, 0),
      firstPieceDecimalSubtract(input, issued),
    );
    issueDeltaByLot.set(lotId, nextDelta);
    const lineNo = Number(allocation.line_no);
    finishedByLine.set(
      lineNo,
      firstPieceDecimalAdd(finishedByLine.get(lineNo) ?? firstPieceDecimalValue(0n, 0), finished),
    );
  }
  for (const [lotId, issueDelta] of issueDeltaByLot) {
    const lot = state.lotsById.get(lotId);
    const reserved = parseFirstPieceStoredDecimal(lot?.reserved_quantity, {
      allowZero: true,
      errorCode: "shop_final_quality_lot_reservation_invalid",
    });
    if (firstPieceDecimalCompare(issueDelta, reserved) > 0n) {
      throw new Error("shop_final_quality_issue_exceeds_reservation");
    }
  }
  const bundledByLine = new Map();
  for (const bundle of payload.bundles) {
    const line = state.linesByNumber.get(bundle.line_no);
    if (!line || !state.allocationLotsByLine.get(bundle.line_no)?.has(bundle.material_lot) || bundle.unit !== line.unit) {
      throw new Error("shop_final_quality_bundle_invalid");
    }
    const accepted = parseFirstPieceDecimal(bundle.accepted_quantity, {
      allowZero: false,
      errorCode: "shop_final_quality_bundle_invalid",
    });
    bundledByLine.set(
      bundle.line_no,
      firstPieceDecimalAdd(bundledByLine.get(bundle.line_no) ?? firstPieceDecimalValue(0n, 0), accepted),
    );
  }
  for (const [lineNo, line] of state.linesByNumber) {
    const accepted = parseFirstPieceStoredDecimal(line.accepted_quantity, {
      allowZero: false,
      errorCode: "shop_final_quality_finished_mismatch",
    });
    const finished = finishedByLine.get(lineNo) ?? firstPieceDecimalValue(0n, 0);
    const bundled = bundledByLine.get(lineNo) ?? firstPieceDecimalValue(0n, 0);
    if (firstPieceDecimalCompare(finished, accepted) !== 0n) {
      throw new Error("shop_final_quality_finished_mismatch");
    }
    if (firstPieceDecimalCompare(bundled, accepted) !== 0n) {
      throw new Error("shop_final_quality_bundle_mismatch");
    }
  }
  return { yields: payload.yields, bundles: payload.bundles };
}

function firstPieceDecimalValue(significand, scale) {
  const digits = significand.toString();
  if (scale === 0) return { significand, scale, text: digits };
  const text = digits.length <= scale
    ? `0.${"0".repeat(scale - digits.length)}${digits}`
    : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return {
    significand,
    scale,
    text: text.replace(/0+$/, "").replace(/\.$/, ""),
  };
}

function firstPieceDecimalAdd(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return firstPieceDecimalValue(
    firstPieceDecimalAtScale(left, scale) + firstPieceDecimalAtScale(right, scale),
    scale,
  );
}

function firstPieceDecimalSubtract(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const difference = firstPieceDecimalAtScale(left, scale) - firstPieceDecimalAtScale(right, scale);
  if (difference < 0n) throw new Error("shop_first_piece_lot_balance_invalid");
  return firstPieceDecimalValue(difference, scale);
}

function firstPieceDecimalCompare(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return firstPieceDecimalAtScale(left, scale) - firstPieceDecimalAtScale(right, scale);
}

function firstPieceInventoryEffects(action, allocations, inspections, lots) {
  const lotsById = new Map();
  for (const lot of lots) {
    lotsById.set(String(lot.name ?? ""), lot);
    lotsById.set(String(lot.material_lot_id ?? ""), lot);
  }
  const issuedByLot = new Map();
  const allocationEffects = inspections.map((inspection) => {
    const allocation = allocations.find(({ allocation_id }) => allocation_id === inspection.allocation_id);
    const materialLotId = String(allocation?.material_lot ?? "");
    const issued = parseFirstPieceDecimal(inspection.issued_quantity, {
      allowZero: false,
      errorCode: "shop_first_piece_issued_quantity_invalid",
    });
    issuedByLot.set(
      materialLotId,
      firstPieceDecimalAdd(issuedByLot.get(materialLotId) ?? firstPieceDecimalValue(0n, 0), issued),
    );
    return {
      allocation_id: inspection.allocation_id,
      material_lot: materialLotId,
      issued_quantity: issued.text,
      status: "Issued",
    };
  });
  const failedAllocationId = action === "fail_to_quality_hold"
    ? inspections[0]?.allocation_id
    : null;
  const failedLotId = failedAllocationId
    ? String(allocations.find(({ allocation_id }) => allocation_id === failedAllocationId)?.material_lot ?? "")
    : null;
  const materialLots = [...issuedByLot.entries()].map(([materialLotId, issued]) => {
    const lot = lotsById.get(materialLotId);
    if (!lot) throw new Error("shop_first_piece_lot_mismatch");
    const available = parseFirstPieceStoredDecimal(lot.available_quantity, {
      allowZero: true,
      errorCode: "shop_first_piece_lot_balance_invalid",
    });
    const reserved = parseFirstPieceStoredDecimal(lot.reserved_quantity, {
      allowZero: false,
      errorCode: "shop_first_piece_lot_balance_invalid",
    });
    const consumed = parseFirstPieceStoredDecimal(lot.consumed_quantity, {
      allowZero: true,
      errorCode: "shop_first_piece_lot_balance_invalid",
    });
    const received = parseFirstPieceStoredDecimal(lot.received_quantity, {
      allowZero: false,
      errorCode: "shop_first_piece_lot_balance_invalid",
    });
    const nextReserved = firstPieceDecimalSubtract(reserved, issued);
    const nextConsumed = firstPieceDecimalAdd(consumed, issued);
    let status;
    if (materialLotId === failedLotId) status = "Quarantined";
    else if (firstPieceDecimalCompare(nextReserved, firstPieceDecimalValue(0n, 0)) > 0n) status = "Reserved";
    else if (firstPieceDecimalCompare(available, firstPieceDecimalValue(0n, 0)) > 0n) status = "Available";
    else if (firstPieceDecimalCompare(nextConsumed, received) === 0n) status = "Consumed";
    else throw new Error("shop_first_piece_lot_balance_invalid");
    return {
      name: lot.name ?? materialLotId,
      material_lot_id: lot.material_lot_id ?? materialLotId,
      status,
      available_quantity: available.text,
      reserved_quantity: nextReserved.text,
      consumed_quantity: nextConsumed.text,
    };
  });
  return { allocationEffects, materialLots, failedLotId };
}

function assertFirstPieceEvidence(order, evidence, evidenceIds, actorUser) {
  for (const [index, item] of evidence.entries()) {
    const evidenceId = evidenceIds[index];
    if (!item || (item.name !== evidenceId && item.evidence_id !== evidenceId)) {
      throw new Error("shop_first_piece_evidence_identity_mismatch");
    }
    assertLinkedRoofJob(order.roof_job, item, "shop_first_piece");
    if (item.proof_slot !== "Production" || !["Photo", "Measurement Report"].includes(item.evidence_type)) {
      throw new Error("shop_first_piece_evidence_semantic_invalid");
    }
    if (item.sync_state !== "Verified") throw new Error("shop_first_piece_evidence_not_verified");
    if (item.capture_actor !== actorUser || item.proof_owner !== actorUser) {
      throw new Error("shop_first_piece_evidence_actor_mismatch");
    }
    if (item.source_system !== "ironwrap-pwa" || !item.device_action_id
      || !item.r2_key || !item.captured_at || !item.verified_at
      || !item.verification_source || !item.content_type) {
      throw new Error("shop_first_piece_evidence_provenance_invalid");
    }
    if (item.checksum_algorithm !== "SHA-256"
      || !/^[0-9a-f]{64}$/.test(String(item.content_checksum ?? ""))) {
      throw new Error("shop_first_piece_evidence_provenance_invalid");
    }
    if (!Number.isInteger(Number(item.content_length)) || Number(item.content_length) <= 0) {
      throw new Error("shop_first_piece_evidence_provenance_invalid");
    }
  }
}

async function readFirstPieceInspectorAuthority(config, shopOrderId) {
  const response = await erpPost(
    config,
    "/api/method/ironwrap_roofing.shop_fabrication_api.preview_first_piece_authority",
    { shop_order_id: shopOrderId },
  );
  const authority = response?.message;
  if (
    !authority
    || authority.authenticated_user !== config.actorUser
    || !authority.work_package?.name
    || !authority.job_assignment?.name
    || !authority.crew_profile?.name
    || !authority.assignment_role
  ) {
    throw new Error("shop_first_piece_authority_not_found");
  }
  return {
    authenticatedUser: authority.authenticated_user,
    workPackage: authority.work_package,
    jobAssignment: authority.job_assignment,
    crewProfile: authority.crew_profile,
    assignmentRole: authority.assignment_role,
  };
}

function assertSignedShopSnapshot(args, preview) {
  if (args.expected_snapshot_sha256 !== preview.expected_snapshot_sha256) {
    throw new Error("shop_command_stale_snapshot");
  }
}

function assertShopSourceRecord(source, { doctype, name, roofJob, allowedStatuses }) {
  if (!source || source.name !== name) throw new Error(`shop_source_not_found:${doctype}`);
  if (source.roof_job !== roofJob || !allowedStatuses.has(source.status)) {
    throw new Error(`shop_source_not_ready:${doctype}`);
  }
}

async function buildReceiveMaterialLotPreview(config, materialLotId) {
  const lot = await readResource(config, "Material Lot", materialLotId);
  assertMaterialLotReadyForReceipt(lot, materialLotId);
  const controlledItem = await readResource(config, "Controlled Item", lot.controlled_item);
  if (controlledItem.status !== "Approved") throw new Error("material_lot_item_not_approved");
  let source = null;
  if (lot.source_kind === "Supplier Receipt") {
    source = await readResource(config, "Supplier Order", lot.supplier_order);
    assertShopSourceRecord(source, {
      doctype: "Supplier Order",
      name: lot.supplier_order,
      roofJob: lot.roof_job,
      allowedStatuses: new Set(["Partially Received", "Received"]),
    });
  } else if (lot.source_kind === "Shop Remnant") {
    source = await readResource(config, "Shop Order", lot.source_shop_order);
    assertShopSourceRecord(source, {
      doctype: "Shop Order",
      name: lot.source_shop_order,
      roofJob: lot.roof_job,
      allowedStatuses: new Set(["Ready", "Handed Over", "Invoice Ready", "Closed"]),
    });
  }
  const preview = {
    would_write: false,
    required_tool: "request_receive_material_lot",
    target: { doctype: "Material Lot", name: materialLotId },
    before: summarizeMaterialLot(lot),
    controlled_item: summarizeControlledItem(controlledItem),
    expected_snapshot_sha256: digest(materialLotSnapshot(lot)),
    receiving: {
      status: lot.condition_status === "Quarantined" ? "Quarantined" : "Available",
      received_at: "Frappe server time at execution",
    },
  };
  if (source) {
    preview.source = {
      doctype: lot.source_kind === "Supplier Receipt" ? "Supplier Order" : "Shop Order",
      name: source.name,
      roof_job: source.roof_job ?? "",
      status: source.status ?? "",
    };
  }
  return preview;
}

async function buildReleaseShopOrderPreview(config, shopOrderId) {
  const order = await readResource(config, "Shop Order", shopOrderId);
  assertShopOrderReadyForRelease(order, shopOrderId);
  const [materialTakeoff, supplierOrder, workPackage] = await Promise.all([
    readResource(config, "Material Takeoff", order.material_takeoff),
    readResource(config, "Supplier Order", order.supplier_order),
    readResource(config, "Work Package", order.work_package),
  ]);
  assertShopSourceRecord(materialTakeoff, {
    doctype: "Material Takeoff",
    name: order.material_takeoff,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Approved"]),
  });
  assertShopSourceRecord(supplierOrder, {
    doctype: "Supplier Order",
    name: order.supplier_order,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Partially Received", "Received"]),
  });
  assertShopSourceRecord(workPackage, {
    doctype: "Work Package",
    name: order.work_package,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Released", "Acknowledged", "In Progress"]),
  });
  return {
    would_write: false,
    required_tool: "request_release_shop_order",
    target: { doctype: "Shop Order", name: shopOrderId },
    before: summarizeShopOrder(order),
    sources: {
      material_takeoff: { name: materialTakeoff.name, roof_job: materialTakeoff.roof_job ?? "", status: materialTakeoff.status ?? "" },
      supplier_order: { name: supplierOrder.name, roof_job: supplierOrder.roof_job ?? "", status: supplierOrder.status ?? "" },
      work_package: { name: workPackage.name, roof_job: workPackage.roof_job ?? "", status: workPackage.status ?? "" },
    },
    expected_snapshot_sha256: digest(shopOrderSnapshot(order)),
    release: {
      status: "Released",
      released_at: "Frappe server time at execution",
    },
  };
}

async function buildReserveShopOrderPreview(config, shopOrderId, allocationsJson) {
  const allocations = parseShopAllocationsJson(allocationsJson);
  const order = await readResource(config, "Shop Order", shopOrderId);
  assertShopOrderReadyForReservation(order, shopOrderId);
  const [materialTakeoff, supplierOrder, workPackage] = await Promise.all([
    readResource(config, "Material Takeoff", order.material_takeoff),
    readResource(config, "Supplier Order", order.supplier_order),
    readResource(config, "Work Package", order.work_package),
  ]);
  assertShopSourceRecord(materialTakeoff, {
    doctype: "Material Takeoff",
    name: order.material_takeoff,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Approved"]),
  });
  assertShopSourceRecord(supplierOrder, {
    doctype: "Supplier Order",
    name: order.supplier_order,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Partially Received", "Received"]),
  });
  assertShopSourceRecord(workPackage, {
    doctype: "Work Package",
    name: order.work_package,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Released", "Acknowledged", "In Progress"]),
  });
  const materialLotIds = [...new Set(allocations.map((row) => row.material_lot))].sort();
  const lots = await Promise.all(materialLotIds.map((materialLotId) => readResource(config, "Material Lot", materialLotId)));
  return {
    would_write: false,
    required_tool: "request_reserve_shop_order_materials",
    target: { doctype: "Shop Order", name: shopOrderId },
    before: summarizeShopOrder(order),
    allocations,
    source_statuses: {
      material_takeoff: materialTakeoff.status ?? "",
      supplier_order: supplierOrder.status ?? "",
      work_package: workPackage.status ?? "",
    },
    material_lots: lots.map((lot) => summarizeMaterialLot(lot)),
    expected_snapshot_sha256: digest(shopOrderSnapshot(order, lots)),
    reservation: {
      status: "Reserved",
      reserved_at: "Frappe server time at execution",
    },
  };
}

async function buildAdvanceShopOrderSetupPreview(config, shopOrderId, setupPayloadJson) {
  const payload = parseShopSetupPayloadJson(setupPayloadJson);
  const order = await readResource(config, "Shop Order", shopOrderId);
  assertShopOrderReadyForSetupAction(order, shopOrderId, payload);
  const [materialTakeoff, supplierOrder, workPackage] = await Promise.all([
    readResource(config, "Material Takeoff", order.material_takeoff),
    readResource(config, "Supplier Order", order.supplier_order),
    readResource(config, "Work Package", order.work_package),
  ]);
  assertShopSourceRecord(materialTakeoff, {
    doctype: "Material Takeoff",
    name: order.material_takeoff,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Approved"]),
  });
  assertShopSourceRecord(supplierOrder, {
    doctype: "Supplier Order",
    name: order.supplier_order,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Partially Received", "Received"]),
  });
  assertShopSourceRecord(workPackage, {
    doctype: "Work Package",
    name: order.work_package,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Released", "Acknowledged", "In Progress"]),
  });
  const operations = payload.operations ?? order.operations ?? [];
  const toStatus = payload.action === "place_quality_hold" ? "Quality Hold" : "Setup / First Piece";
  return {
    would_write: false,
    required_tool: "request_advance_shop_order_setup",
    target: { doctype: "Shop Order", name: shopOrderId },
    before: summarizeShopOrder(order),
    source_statuses: {
      material_takeoff: materialTakeoff.status ?? "",
      supplier_order: supplierOrder.status ?? "",
      work_package: workPackage.status ?? "",
    },
    expected_snapshot_sha256: digest(shopOrderSetupSnapshot(order)),
    setup: {
      action: payload.action,
      from_status: order.status,
      to_status: toStatus,
      ...(payload.action === "place_quality_hold"
        ? { reason: payload.reason }
        : {
            operations: operations.map(({ sequence, operation, machine_tooling, operator }) => ({
              sequence,
              operation,
              machine_tooling,
              operator,
            })),
          }),
    },
  };
}

async function buildRecordFirstPieceOutcomePreview(config, shopOrderId, firstPiecePayloadJson) {
  const payload = parseShopFirstPiecePayloadJson(firstPiecePayloadJson);
  const order = await readResource(config, "Shop Order", shopOrderId);
  assertShopOrderReadyForFirstPieceOutcome(order, shopOrderId);
  const { linesByNumber, allocations, inspections } = assertFirstPieceInspectionRows(
    order,
    payload,
    config.actorUser,
  );
  const materialLotIds = [...new Set(allocations.map((allocation) => String(allocation.material_lot ?? "")))].sort();
  if (materialLotIds.some((materialLotId) => !materialLotId)) {
    throw new Error("shop_first_piece_lot_mismatch");
  }
  const evidenceIds = [...new Set(inspections.map((inspection) => inspection.evidence_item))].sort();
  const [materialTakeoff, supplierOrder, lots, evidence] = await Promise.all([
    readResource(config, "Material Takeoff", order.material_takeoff),
    readResource(config, "Supplier Order", order.supplier_order),
    Promise.all(materialLotIds.map((materialLotId) => readResource(config, "Material Lot", materialLotId))),
    Promise.all(evidenceIds.map((evidenceId) => readResource(config, "Evidence Item", evidenceId))),
  ]);
  assertShopSourceRecord(materialTakeoff, {
    doctype: "Material Takeoff",
    name: order.material_takeoff,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Approved"]),
  });
  assertShopSourceRecord(supplierOrder, {
    doctype: "Supplier Order",
    name: order.supplier_order,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Partially Received", "Received"]),
  });
  const inspectorAuthority = await readFirstPieceInspectorAuthority(config, shopOrderId);
  const workPackage = inspectorAuthority.workPackage;
  assertShopSourceRecord(workPackage, {
    doctype: "Work Package",
    name: order.work_package,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Released", "Acknowledged", "In Progress"]),
  });
  assertFirstPieceMaterialLots(order, linesByNumber, allocations, inspections, lots);
  assertFirstPieceEvidence(order, evidence, evidenceIds, config.actorUser);
  const toStatus = payload.action === "pass_to_fabrication" ? "In Fabrication" : "Quality Hold";
  const result = payload.action === "pass_to_fabrication" ? "Pass" : "Fail";
  const inventoryEffects = firstPieceInventoryEffects(
    payload.action,
    allocations,
    inspections,
    lots,
  );
  const failedLot = inventoryEffects.materialLots.find(
    (lot) => lot.material_lot_id === inventoryEffects.failedLotId || lot.name === inventoryEffects.failedLotId,
  );
  return {
    would_write: false,
    required_tool: "request_record_first_piece_outcome",
    target: { doctype: "Shop Order", name: shopOrderId },
    before: summarizeShopOrder(order),
    source_statuses: {
      material_takeoff: materialTakeoff.status ?? "",
      supplier_order: supplierOrder.status ?? "",
      work_package: workPackage.status ?? "",
    },
    expected_snapshot_sha256: digest(shopOrderFirstPieceSnapshot(order, lots, evidence, {
      materialTakeoff,
      supplierOrder,
      workPackage,
    }, inspectorAuthority)),
    first_piece: {
      action: payload.action,
      from_status: order.status,
      to_status: toStatus,
      inspections: inspections.map((inspection) => ({
        inspection_type: "First Piece",
        line_no: inspection.line_no,
        allocation_id: inspection.allocation_id,
        operation_sequence: inspection.operation_sequence,
        result,
        nominal_value: inspection.nominal_value,
        measured_value: inspection.measured_value,
        tolerance_value: inspection.tolerance_value,
        measurement_unit: inspection.measurement_unit,
        measured_result: inspection.measured_result,
        inspected_by: config.actorUser,
        inspected_at: "Frappe server time at execution",
        evidence_item: inspection.evidence_item,
        needs_review: result === "Pass" ? 0 : 1,
      })),
      ...(payload.action === "pass_to_fabrication"
        ? { fabrication_started_at: "Frappe server time at execution" }
        : { reason: payload.reason, quality_hold_reason: payload.reason }),
    },
    effects: {
      shop_order: {
        shop_order_id: order.shop_order_id ?? order.name,
        status: toStatus,
      },
      material_allocations: inventoryEffects.allocationEffects,
      material_lots: inventoryEffects.materialLots,
      ...(payload.action === "fail_to_quality_hold" ? {
        nonconformance: {
          action: "create",
          nonconformance_id: "derived from the approved Hermes Run ID at execution",
          status: "Contained",
          shop_order: order.name,
          material_lot: failedLot?.name ?? inventoryEffects.failedLotId,
          evidence_item: inspections[0].evidence_item,
          containment: `Material Lot ${failedLot?.material_lot_id ?? inventoryEffects.failedLotId} quarantined; Shop Order placed on Quality Hold.`,
        },
      } : {}),
    },
  };
}

async function buildRecordFinalShopQualityPreview(config, shopOrderId, finalQualityPayloadJson) {
  const payload = parseShopFinalQualityPayloadJson(finalQualityPayloadJson);
  const order = await readResource(config, "Shop Order", shopOrderId);
  assertShopOrderReadyForFinalQuality(order, shopOrderId);
  const state = assertFinalQualityInspectionRows(order, payload, config.actorUser);
  const materialLotIds = [...new Set(state.allocations.map((allocation) => String(allocation.material_lot ?? "")))].sort();
  if (materialLotIds.some((materialLotId) => !materialLotId)) {
    throw new Error("shop_final_quality_lot_mismatch");
  }
  const evidenceIds = [...new Set([
    ...state.inspections.map((inspection) => inspection.evidence_item),
    ...(payload.action === "pass_to_ready"
      ? payload.yields.filter((row) => row.scrap_quantity !== "0").map((row) => row.evidence_item)
      : []),
  ])].sort();
  const [materialTakeoff, supplierOrder, lots, evidence] = await Promise.all([
    readResource(config, "Material Takeoff", order.material_takeoff),
    readResource(config, "Supplier Order", order.supplier_order),
    Promise.all(materialLotIds.map((materialLotId) => readResource(config, "Material Lot", materialLotId))),
    Promise.all(evidenceIds.map((evidenceId) => readResource(config, "Evidence Item", evidenceId))),
  ]);
  assertShopSourceRecord(materialTakeoff, {
    doctype: "Material Takeoff",
    name: order.material_takeoff,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Approved"]),
  });
  assertShopSourceRecord(supplierOrder, {
    doctype: "Supplier Order",
    name: order.supplier_order,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Partially Received", "Received"]),
  });
  const inspectorAuthority = await readFirstPieceInspectorAuthority(config, shopOrderId);
  const workPackage = inspectorAuthority.workPackage;
  assertShopSourceRecord(workPackage, {
    doctype: "Work Package",
    name: order.work_package,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Released", "Acknowledged", "In Progress"]),
  });
  const materialState = assertFinalQualityMaterialLots(order, state.linesByNumber, state.allocations, lots);
  assertFirstPieceEvidence(order, evidence, evidenceIds, config.actorUser);
  if (payload.action === "pass_to_ready" && state.operations.some(
    (operation) => operation.status !== "Complete" || !operation.completed_at,
  )) {
    throw new Error("shop_final_quality_operation_incomplete");
  }
  const output = validateFinalQualityOutput(payload, { ...state, ...materialState });
  const toStatus = payload.action === "pass_to_ready" ? "Ready" : "Quality Hold";
  const result = payload.action === "pass_to_ready" ? "Pass" : "Fail";
  const finalInspections = state.inspections.map((inspection) => ({
    inspection_type: "Final",
    line_no: inspection.line_no,
    allocation_id: inspection.allocation_id,
    operation_sequence: inspection.operation_sequence,
    result,
    nominal_value: inspection.nominal_value,
    measured_value: inspection.measured_value,
    tolerance_value: inspection.tolerance_value,
    measurement_unit: inspection.measurement_unit,
    measured_result: inspection.measured_result,
    inspected_by: config.actorUser,
    inspected_at: "Frappe server time at execution",
    evidence_item: inspection.evidence_item,
    needs_review: result === "Pass" ? 0 : 1,
  }));
  const finalYields = output.yields.map((row) => ({
    allocation_id: row.allocation_id,
    operation_sequence: row.operation_sequence,
    input_quantity: row.input_quantity,
    finished_quantity: row.finished_quantity,
    remnant_quantity: row.remnant_quantity,
    remnant_lot: row.remnant_quantity === "0"
      ? ""
      : "derived from the approved Hermes Run ID at execution",
    scrap_quantity: row.scrap_quantity,
    scrap_disposition: row.scrap_disposition,
    evidence_item: row.evidence_item,
  }));
  const finalBundles = output.bundles.map((bundle) => ({
    bundle_id: bundle.bundle_id,
    line_no: bundle.line_no,
    material_lot: bundle.material_lot,
    piece_identity: bundle.piece_identity,
    accepted_quantity: bundle.accepted_quantity,
    unit: bundle.unit,
    label_text: bundle.label_text,
    handoff_status: "Prepared",
    handed_over_to: "",
    handed_over_at: "",
    handoff_evidence: "",
    condition: bundle.condition,
    needs_review: 0,
  }));
  const expectedSnapshotSha256 = digest(shopOrderFinalQualitySnapshot(order, lots, evidence, {
    materialTakeoff,
    supplierOrder,
    workPackage,
  }, inspectorAuthority));
  return {
    would_write: false,
    required_tool: "request_record_final_shop_quality",
    target: { doctype: "Shop Order", name: shopOrderId },
    before: summarizeShopOrder(order),
    source_statuses: {
      material_takeoff: materialTakeoff.status ?? "",
      supplier_order: supplierOrder.status ?? "",
      work_package: workPackage.status ?? "",
    },
    expected_snapshot_sha256: expectedSnapshotSha256,
    next_status: toStatus,
    approval_request: {
      write_tool: "request_record_final_shop_quality",
      target: { doctype: "Shop Order", name: shopOrderId },
      expected_snapshot_sha256: expectedSnapshotSha256,
    },
    final_quality: {
      action: payload.action,
      from_status: order.status,
      to_status: toStatus,
      final_inspections: finalInspections,
      yields: finalYields,
      bundles: finalBundles,
      ...(payload.action === "fail_to_quality_hold"
        ? { reason: payload.reason, quality_hold_reason: payload.reason }
        : { ready_at: "Frappe server time at execution" }),
    },
  };
}

async function buildRecordShopHandoverPreview(config, shopOrderId, handoverPayloadJson) {
  const payload = parseShopHandoverPayloadJson(handoverPayloadJson);
  const order = await readResource(config, "Shop Order", shopOrderId);
  assertShopOrderReadyForHandover(order, shopOrderId);
  const [materialTakeoff, supplierOrder, workPackage, handoffEvidence] = await Promise.all([
    readResource(config, "Material Takeoff", order.material_takeoff),
    readResource(config, "Supplier Order", order.supplier_order),
    readResource(config, "Work Package", order.work_package),
    readResource(config, "Evidence Item", payload.handoff_evidence),
  ]);
  assertShopSourceRecord(materialTakeoff, {
    doctype: "Material Takeoff",
    name: order.material_takeoff,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Approved"]),
  });
  assertShopSourceRecord(supplierOrder, {
    doctype: "Supplier Order",
    name: order.supplier_order,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Partially Received", "Received"]),
  });
  assertShopSourceRecord(workPackage, {
    doctype: "Work Package",
    name: order.work_package,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Released", "Acknowledged", "In Progress"]),
  });
  if (handoffEvidence.roof_job !== order.roof_job) {
    throw new Error("shop_handover_evidence_job_mismatch");
  }
  assertShopHandoverEvidence(handoffEvidence);
  const sources = {
    material_takeoff: materialTakeoff,
    supplier_order: supplierOrder,
    work_package: workPackage,
  };
  const expectedSnapshotSha256 = digest(
    shopOrderHandoverSnapshot(order, [handoffEvidence], sources),
  );
  return {
    would_write: false,
    required_tool: "request_record_shop_handover",
    target: { doctype: "Shop Order", name: shopOrderId },
    before: summarizeShopOrder(order),
    source_statuses: {
      material_takeoff: materialTakeoff.status ?? "",
      supplier_order: supplierOrder.status ?? "",
      work_package: workPackage.status ?? "",
    },
    expected_snapshot_sha256: expectedSnapshotSha256,
    next_status: "Handed Over",
    approval_request: {
      write_tool: "request_record_shop_handover",
      target: { doctype: "Shop Order", name: shopOrderId },
      expected_snapshot_sha256: expectedSnapshotSha256,
    },
    handover: {
      from_status: order.status,
      to_status: "Handed Over",
      handed_over_to: payload.handed_over_to,
      handoff_evidence: handoffEvidence.evidence_id ?? handoffEvidence.name,
      bundles: order.bundles.map((bundle) => ({
        bundle_id: bundle.bundle_id,
        line_no: bundle.line_no,
        accepted_quantity: snapshotText(bundle.accepted_quantity),
        unit: bundle.unit,
        handoff_status: "Handed Over",
      })),
    },
  };
}

async function buildRecordShopBillingBasisPreview(config, shopOrderId, billingBasisPayloadJson) {
  const payload = parseShopBillingBasisPayloadJson(billingBasisPayloadJson);
  const order = await readResource(config, "Shop Order", shopOrderId);
  assertShopOrderReadyForBillingBasis(order, shopOrderId);
  const [materialTakeoff, supplierOrder, workPackage, handoffEvidence, paymentMilestone] = await Promise.all([
    readResource(config, "Material Takeoff", order.material_takeoff),
    readResource(config, "Supplier Order", order.supplier_order),
    readResource(config, "Work Package", order.work_package),
    readResource(config, "Evidence Item", order.handoff_evidence),
    readResource(config, "Payment Milestone", payload.payment_milestone_id),
  ]);
  assertShopSourceRecord(materialTakeoff, {
    doctype: "Material Takeoff",
    name: order.material_takeoff,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Approved"]),
  });
  assertShopSourceRecord(supplierOrder, {
    doctype: "Supplier Order",
    name: order.supplier_order,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Partially Received", "Received"]),
  });
  assertShopSourceRecord(workPackage, {
    doctype: "Work Package",
    name: order.work_package,
    roofJob: order.roof_job,
    allowedStatuses: new Set(["Released", "Acknowledged", "In Progress"]),
  });
  if (handoffEvidence.roof_job !== order.roof_job) {
    throw new Error("shop_handover_evidence_job_mismatch");
  }
  assertShopHandoverEvidence(handoffEvidence);
  assertShopBillingBasis(order, paymentMilestone);
  const sources = {
    material_takeoff: materialTakeoff,
    supplier_order: supplierOrder,
    work_package: workPackage,
  };
  const expectedSnapshotSha256 = digest(
    shopOrderBillingBasisSnapshot(order, paymentMilestone, handoffEvidence, sources),
  );
  return {
    would_write: false,
    required_tool: "request_record_shop_billing_basis",
    target: { doctype: "Shop Order", name: shopOrderId },
    before: summarizeShopOrder(order),
    source_statuses: {
      material_takeoff: materialTakeoff.status ?? "",
      supplier_order: supplierOrder.status ?? "",
      work_package: workPackage.status ?? "",
    },
    expected_snapshot_sha256: expectedSnapshotSha256,
    next_status: "Invoice Ready",
    approval_request: {
      write_tool: "request_record_shop_billing_basis",
      target: { doctype: "Shop Order", name: shopOrderId },
      expected_snapshot_sha256: expectedSnapshotSha256,
    },
    billing_basis: {
      from_status: order.status,
      to_status: "Invoice Ready",
      payment_milestone_id: paymentMilestone.payment_milestone_id ?? paymentMilestone.name,
      qb_entity_id: paymentMilestone.qb_entity_id,
      status: paymentMilestone.status,
    },
  };
}

function proposalPublicationPreview(pack, approvedBy) {
  return {
    target: { doctype: "Proposal Evidence Pack", name: pack.name },
    before: summarizeProposalPack(pack),
    publication: {
      status: "Approved",
      approved_by: approvedBy,
      approved_at: "Frappe server time at execution",
    },
    customer_portal: {
      visible_after_publication: true,
      portal_link_issued: false,
      human_portal_link_issuance_required: true,
    },
    customer_delivery_mutated: false,
    contract_acceptance_mutated: false,
    customer_quote_mutated: false,
  };
}

export async function buildMaterialTakeoffDraftFromErp(config, roofJobId, {
  materialSystem,
  measurementReportId,
  takeoffPolicyId,
  takeoffId,
  limit = 25,
  nowIso,
  policyAuthority = "current_approved",
} = {}) {
  if (!materialSystem) throw new Error("material_takeoff_material_system_required");
  const effectiveAt = nowIso ?? new Date().toISOString();
  const [tenant, roofJob] = await Promise.all([
    readResource(config, "White-Label Tenant", config.tenantId),
    readResource(config, "Roof Job", roofJobId),
  ]);
  if ((tenant.tenant_id ?? tenant.name) !== config.tenantId || tenant.status !== "Active") {
    throw new Error("material_takeoff_tenant_not_active");
  }
  if ((roofJob.roof_job_id ?? roofJob.name) !== roofJobId || !roofJob.brand || !roofJob.service_type) {
    throw new Error("material_takeoff_roof_job_invalid");
  }

  let reportName = measurementReportId;
  let measurementReport;
  if (!reportName) {
    const reports = await listResources(config, "Measurement Report", {
      fields: MEASUREMENT_REPORT_FIELDS,
      filters: [["Measurement Report", "roof_job", "=", roofJobId]],
      limit: limit + 1,
      orderBy: "parsed_at desc",
    });
    if (!reports.length) throw new Error("measurement_report_required");
    const truncated = reports.length > limit;
    const candidate = selectUniqueGovernedMeasurementReport(reports.slice(0, limit), {
      roofJobId,
      truncated,
    });
    reportName = candidate.measurement_id ?? candidate.name;
    if (!reportName) throw new Error("measurement_report_required");
  }
  measurementReport ??= await readResource(config, "Measurement Report", reportName);
  const takeoffPolicy = takeoffPolicyId
    ? await readResource(config, "Material Takeoff Policy", takeoffPolicyId)
    : await selectEffectiveTakeoffPolicy(config, {
      tenantId: config.tenantId,
      brand: roofJob.brand,
      serviceType: roofJob.service_type,
      materialSystem,
      effectiveAt,
    });
  const policyEvidence = await readResource(config, "Evidence Item", takeoffPolicy.source_evidence);
  const draft = buildMaterialTakeoffDraft({
    roofJobId,
    tenantId: config.tenantId,
    materialSystem,
    roofJob,
    takeoffId,
    measurementReport,
    takeoffPolicy,
    policyEvidence,
    nowIso: effectiveAt,
    policyAuthority,
  });
  return { draft, measurementReport, roofJob, takeoffPolicy };
}

export function selectUniqueGovernedMeasurementReport(candidates, { roofJobId, truncated }) {
  if (!Array.isArray(candidates)) throw new Error("material_takeoff_measurement_selection_invalid");
  const eligible = candidates.filter((candidate) => (
    candidate
    && typeof candidate === "object"
    && candidate.roof_job === roofJobId
    && candidate.roof_graph_revision
  ));
  if (eligible.length > 1) throw new Error("material_takeoff_measurement_ambiguous");
  // A sentinel row means uniqueness is unknowable inside the bounded window,
  // even when one eligible report appeared before the sentinel.
  if (truncated) throw new Error("material_takeoff_measurement_window_truncated");
  if (eligible.length === 0) throw new Error("material_takeoff_roof_graph_required");
  return eligible[0];
}

export async function prepareMaterialTakeoffWriteFromErp(config, roofJobId, {
  materialSystem,
  measurementReportId,
  takeoffPolicyId,
  takeoffId = materialTakeoffIdForRoofJob(roofJobId),
  limit = 25,
  nowIso = new Date().toISOString(),
} = {}) {
  if (!materialSystem) throw new Error("material_takeoff_material_system_required");
  const before = await readResourceOrNull(config, "Material Takeoff", takeoffId);
  if (!before) {
    const built = await buildMaterialTakeoffDraftFromErp(config, roofJobId, {
      materialSystem,
      measurementReportId,
      takeoffPolicyId,
      takeoffId,
      limit,
      nowIso,
      policyAuthority: "current_approved",
    });
    return { ...built, before: null, operation: "create", targetMutation: true };
  }

  assertMaterialTakeoffHistoricalReplayRequest(before, {
    roofJobId,
    takeoffId,
    tenantId: config.tenantId,
    materialSystem,
    measurementReportId,
    takeoffPolicyId,
  });
  const built = await buildMaterialTakeoffDraftFromErp(config, roofJobId, {
    materialSystem: before.material_system,
    measurementReportId: before.measurement_report,
    takeoffPolicyId: before.takeoff_policy,
    takeoffId,
    limit,
    nowIso: before.prepared_at,
    policyAuthority: "historical_replay",
  });
  assertMaterialTakeoffReplaySafe(before, built.draft);
  return { ...built, before, operation: "replay", targetMutation: false };
}

function assertMaterialTakeoffHistoricalReplayRequest(before, {
  roofJobId,
  takeoffId,
  tenantId,
  materialSystem,
  measurementReportId,
  takeoffPolicyId,
}) {
  if (!before || !["Draft", "Needs Review"].includes(before.status)) {
    throw new Error("material_takeoff_existing_state_not_writable");
  }
  const required = [
    "prepared_at",
    "roof_job",
    "tenant",
    "material_system",
    "measurement_report",
    "takeoff_policy",
    "geometry_revision",
    "source_raw_sha256",
    "policy_digest",
    "options_digest",
    "calculation_digest",
  ];
  if (required.some((field) => !before[field]) || !Number.isFinite(Date.parse(before.prepared_at))) {
    throw new Error("material_takeoff_legacy_state_requires_preflight");
  }
  const existingId = before.takeoff_id ?? before.name;
  if (
    existingId !== takeoffId
    || before.roof_job !== roofJobId
    || before.tenant !== tenantId
    || before.material_system !== materialSystem
    || (measurementReportId !== undefined && measurementReportId !== before.measurement_report)
    || (takeoffPolicyId !== undefined && takeoffPolicyId !== before.takeoff_policy)
  ) {
    throw new Error("material_takeoff_existing_binding_mismatch");
  }
}

async function selectEffectiveTakeoffPolicy(config, {
  tenantId,
  brand,
  serviceType,
  materialSystem,
  effectiveAt,
}) {
  const rows = await listResources(config, "Material Takeoff Policy", {
    fields: MATERIAL_TAKEOFF_POLICY_FIELDS,
    filters: [
      ["Material Takeoff Policy", "tenant", "=", tenantId],
      ["Material Takeoff Policy", "brand", "=", brand],
      ["Material Takeoff Policy", "service_type", "=", serviceType],
      ["Material Takeoff Policy", "material_system", "=", materialSystem],
      ["Material Takeoff Policy", "status", "=", "Approved"],
    ],
    // Fetch one beyond the bounded authority window so a large policy set can
    // never be mistaken for a unique result because Frappe truncated the list.
    limit: 101,
    orderBy: "policy_version desc",
  });
  const policyId = selectUniqueEffectiveTakeoffPolicyId(rows, effectiveAt);
  return readResource(config, "Material Takeoff Policy", policyId);
}

export function selectUniqueEffectiveTakeoffPolicyId(rows, effectiveAt) {
  if (!Array.isArray(rows)) throw new Error("material_takeoff_policy_selection_invalid");
  if (rows.length >= 101) throw new Error("material_takeoff_policy_selection_window_exceeded");
  const at = Date.parse(effectiveAt);
  if (!Number.isFinite(at)) throw new Error("material_takeoff_policy_effective_window_invalid");
  const effective = rows.filter((row) => {
    const from = Date.parse(row.effective_from ?? "");
    const to = row.effective_to
      ? Date.parse(`${String(row.effective_to).slice(0, 10)}T23:59:59.999Z`)
      : null;
    return Number.isFinite(from) && at >= from && (to === null || (Number.isFinite(to) && at <= to));
  });
  if (effective.length === 0) throw new Error("material_takeoff_policy_required");
  if (effective.length > 1) throw new Error("material_takeoff_policy_ambiguous");
  const policyId = effective[0].policy_id ?? effective[0].name;
  if (!policyId) throw new Error("material_takeoff_policy_id_invalid");
  return policyId;
}

async function buildSupplierOrderDraftFromErp(config, materialTakeoffId, {
  supplierOrderId,
  supplier,
  requestedDeliveryDate,
  nowIso,
} = {}) {
  const materialTakeoff = await readResource(config, "Material Takeoff", materialTakeoffId);
  const draft = buildSupplierOrderDraft({
    materialTakeoff,
    supplierOrderId,
    supplier,
    requestedDeliveryDate,
    nowIso,
  });
  return { draft, materialTakeoff };
}

async function buildSupplierQuoteDraftFromErp(config, args, nowIso) {
  const materialTakeoff = await readResource(config, "Material Takeoff", args.material_takeoff_id);
  const draft = buildSupplierQuoteDraft({
    materialTakeoff,
    supplierQuoteId: args.supplier_quote_id,
    supplier: args.supplier,
    quotedAt: args.quoted_at,
    validUntil: args.valid_until,
    unitPrices: args.unit_prices ?? {},
    nowIso,
  });
  return { draft, materialTakeoff };
}

async function buildCustomerQuoteRevisionDraftFromErp(config, args, nowIso) {
  const sourceQuote = await readResource(config, "Customer Quote", args.customer_quote_id);
  const existingQuotes = await listResources(config, "Customer Quote", {
    fields: CUSTOMER_QUOTE_FIELDS,
    filters: [["Customer Quote", "roof_job", "=", args.roof_job_id]],
    limit: 100,
    orderBy: "modified desc",
  });
  // Version identity must be derived from the complete job history. A job with an unusually
  // large quote history is review work, not a reason to silently choose from a truncated page.
  if (existingQuotes.length >= 100) throw new Error("customer_quote_version_window_exceeded");
  const draft = buildCustomerQuoteRevisionDraft({
    sourceQuote,
    roofJobId: args.roof_job_id,
    existingQuotes,
    correctionReason: args.correction_reason,
    nowIso,
  });
  return { draft, sourceQuote, existingQuotes };
}

async function buildQuotePriceRuleSnapshotFromErp(config, args, nowIso) {
  const customerQuote = await readResource(config, "Customer Quote", args.customer_quote_id);
  const priceRules = await Promise.all(
    args.price_rule_ids.map((priceRuleId) => readResource(config, "Price Book Rule", priceRuleId)),
  );
  const snapshot = buildQuotePriceRuleSnapshot({
    roofJobId: args.roof_job_id,
    customerQuote,
    priceRules,
    nowIso,
  });
  return {
    customerQuote,
    snapshot,
    patch: { price_rule_snapshot_json: JSON.stringify(snapshot, null, 2) },
  };
}

async function assertQuoteRevisionTargetAbsent(config, customerQuoteId) {
  const existing = await readResourceOrNull(config, "Customer Quote", customerQuoteId);
  if (existing) throw new Error("quote_revision_append_only");
}

async function buildCompletionPacketDraftFromErp(config, roofJobId, { packetId, limit = 25, nowIso } = {}) {
  const [checkIns, evidence] = await Promise.all([
    listResources(config, "Field Check-in", {
      fields: FIELD_CHECK_IN_FIELDS,
      filters: [["Field Check-in", "roof_job", "=", roofJobId]],
      limit,
      orderBy: "submitted_at desc",
    }),
    listResources(config, "Evidence Item", {
      fields: EVIDENCE_ITEM_FIELDS,
      filters: [["Evidence Item", "roof_job", "=", roofJobId]],
      limit,
      orderBy: "modified desc",
    }),
  ]);
  const draft = buildCompletionPacketDraft({ roofJobId, packetId, checkIns, evidence, nowIso });
  return { draft, checkIns, evidence };
}

async function buildReviewRequestDraftFromErp(config, roofJobId, {
  requestId,
  consentBasis,
  channel,
  reviewLink,
  limit = 25,
  nowIso,
} = {}) {
  const [completionPackets, paymentMilestones] = await Promise.all([
    listResources(config, "Completion Packet", {
      fields: COMPLETION_PACKET_FIELDS,
      filters: [["Completion Packet", "roof_job", "=", roofJobId]],
      limit,
      orderBy: "modified desc",
    }),
    listResources(config, "Payment Milestone", {
      fields: PAYMENT_MILESTONE_FIELDS,
      filters: [["Payment Milestone", "roof_job", "=", roofJobId]],
      limit,
      orderBy: "event_ts desc",
    }),
  ]);
  const completionPacket = completionPackets.find((row) => row.status === "Approved") ?? completionPackets[0] ?? null;
  const draft = buildReviewRequestDraft({
    roofJobId,
    requestId,
    completionPacket,
    paymentMilestones,
    consentBasis,
    channel,
    reviewLink,
    nowIso,
  });
  return { draft, completionPacket, paymentMilestones };
}

function summarizeGate(gate) {
  return {
    name: gate.name,
    gate_id: gate.gate_id,
    roof_job: gate.roof_job,
    gate: gate.gate,
    state: gate.state,
    blocker_reason: gate.blocker_reason ?? "",
    waiver_reason: gate.waiver_reason ?? "",
    evidence_item: gate.evidence_item ?? "",
  };
}

function summarizeMaterialTakeoff(takeoff) {
  if (!takeoff) return null;
  return {
    name: takeoff.name,
    takeoff_id: takeoff.takeoff_id,
    roof_job: takeoff.roof_job,
    measurement_report: takeoff.measurement_report ?? "",
    status: takeoff.status,
    prepared_at: takeoff.prepared_at ?? "",
    approved_by: takeoff.approved_by ?? "",
    approved_at: takeoff.approved_at ?? "",
    approval_note: takeoff.approval_note ?? "",
  };
}

function summarizeSupplierOrder(order) {
  if (!order) return null;
  return {
    name: order.name,
    supplier_order_id: order.supplier_order_id,
    roof_job: order.roof_job,
    material_takeoff: order.material_takeoff ?? "",
    supplier: order.supplier ?? "",
    status: order.status,
    prepared_at: order.prepared_at ?? "",
    internal_transmission_id: order.internal_transmission_id ?? "",
    internal_transmitted_at: order.internal_transmitted_at ?? "",
    supplier_acknowledgement_id: order.supplier_acknowledgement_id ?? "",
    supplier_acknowledged_at: order.supplier_acknowledged_at ?? "",
    supplier_acknowledgement_evidence: order.supplier_acknowledgement_evidence ?? "",
    received_at: order.received_at ?? "",
  };
}

function supplierOrderTransitionPreview(before, args, transition) {
  return {
    would_write: !transition.idempotent,
    required_tool: "request_transition_supplier_order",
    target: { doctype: "Supplier Order", name: args.supplier_order_id },
    before: summarizeSupplierOrder(before),
    patch: transition.patch,
    verified_evidence_item_ids: transition.evidenceItemIds,
    semantics: {
      ordered: "internal_transmission_only",
      supplier_acknowledgement: "evidence_backed_recorded_fact_only",
      external_supplier_contact: false,
      provider_adapter_called: false,
    },
  };
}

async function assertSupplierOrderTransitionEvidence(config, before, evidenceItemIds) {
  await Promise.all(evidenceItemIds.map((evidenceItemId) => assertLinkedResourceForJob(
    config,
    "Evidence Item",
    evidenceItemId,
    before.roof_job,
    "supplier_order_transition",
    { proofSlots: ["Materials"] },
  )));
}

function summarizeProposalPack(pack) {
  if (!pack) return null;
  return {
    name: pack.name,
    pack_id: pack.pack_id,
    roof_job: pack.roof_job,
    quotation: pack.quotation ?? "",
    status: pack.status,
    prepared_at: pack.prepared_at ?? "",
  };
}

function summarizeCompletionPacket(packet) {
  if (!packet) return null;
  return {
    name: packet.name,
    completion_packet_id: packet.completion_packet_id,
    roof_job: packet.roof_job,
    status: packet.status,
    warranty_ready: packet.warranty_ready ?? 0,
    customer_signoff_ref: packet.customer_signoff_ref ?? "",
    prepared_at: packet.prepared_at ?? "",
  };
}

function summarizeWarrantyPacket(packet) {
  if (!packet) return null;
  return {
    name: packet.name,
    warranty_packet_id: packet.warranty_packet_id,
    roof_job: packet.roof_job,
    completion_packet: packet.completion_packet ?? "",
    status: packet.status,
    material_system: packet.material_system ?? "",
    coverage_years: packet.coverage_years ?? 0,
    prepared_at: packet.prepared_at ?? "",
  };
}

function summarizeReviewRequest(request) {
  if (!request) return null;
  return {
    name: request.name,
    review_request_id: request.review_request_id,
    roof_job: request.roof_job,
    completion_packet: request.completion_packet ?? "",
    status: request.status,
    channel: request.channel ?? "",
    consent_basis: request.consent_basis ?? "",
    prepared_at: request.prepared_at ?? "",
  };
}

function summarizeCommunicationEvent(event) {
  if (!event) return null;
  return {
    name: event.name,
    communication_event_id: event.communication_event_id,
    roof_job: event.roof_job ?? "",
    lead_envelope: event.lead_envelope ?? "",
    channel: event.channel,
    direction: event.direction ?? "",
    policy_result: event.policy_result,
    status: event.status,
    event_ts: event.event_ts ?? "",
  };
}

function summarizeLeadTriage(envelope) {
  if (!envelope) return null;
  return {
    name: envelope.name,
    envelope_id: envelope.envelope_id,
    source: envelope.source ?? "",
    event_ts: envelope.event_ts ?? "",
    // The bus owns this state. It is audit/read context, never part of a triage patch.
    transport_status: envelope.status ?? "",
    triage_status: envelope.triage_status ?? "Unknown",
    triaged_by: envelope.triaged_by ?? "",
    triaged_at: envelope.triaged_at ?? "",
    triage_summary: envelope.triage_summary ?? "",
  };
}

function summarizeLeadTriageCommandResult(before, result) {
  const payload = result?.message ?? result ?? {};
  const leadEnvelope = payload?.lead_envelope;
  // Frappe's command returns only the immutable triage decision. Preserve the
  // existing owned transport context while using its server-derived timestamp.
  return summarizeLeadTriage({
    ...before,
    ...(leadEnvelope && typeof leadEnvelope === "object" ? leadEnvelope : {}),
  });
}

function summarizeProposalPublicationCommandResult(before, result) {
  const payload = result?.message ?? result ?? {};
  const pack = payload?.proposal_evidence_pack;
  return summarizeProposalPack({
    ...before,
    ...(pack && typeof pack === "object" ? pack : {}),
  });
}

function summarizeSupplierQuote(quote) {
  if (!quote) return null;
  return {
    name: quote.name,
    supplier_quote_id: quote.supplier_quote_id,
    roof_job: quote.roof_job,
    material_takeoff: quote.material_takeoff ?? "",
    supplier: quote.supplier ?? "",
    status: quote.status,
    valid_until: quote.valid_until ?? "",
    quote_total: quote.quote_total ?? 0,
  };
}

function summarizeCustomerQuote(quote) {
  if (!quote) return null;
  return {
    name: quote.name,
    customer_quote_id: quote.customer_quote_id,
    roof_job: quote.roof_job,
    customer: quote.customer,
    quote_version: quote.quote_version,
    status: quote.status,
    price_book_version: quote.price_book_version ?? "",
    pricing_effective_at: quote.pricing_effective_at ?? "",
    quote_total: quote.quote_total ?? null,
    currency: quote.currency ?? "",
    valid_until: quote.valid_until ?? "",
    supersedes: quote.supersedes ?? "",
    modified: quote.modified ?? "",
  };
}

function summarizeInsuranceSupplement(supplement) {
  if (!supplement) return null;
  const evidence = Array.isArray(supplement.evidence) ? supplement.evidence : [];
  return {
    name: supplement.name,
    insurance_supplement_id: supplement.insurance_supplement_id,
    roof_job: supplement.roof_job,
    version: supplement.version,
    status: supplement.status,
    measurement_report_bound: Boolean(supplement.measurement_report),
    invoice_required: Number(supplement.invoice_required ?? 1) !== 0,
    evidence_manifest_bound: Boolean(supplement.evidence_manifest_json),
    evidence_count: evidence.length,
    evidence_roles: [...new Set(evidence.map((row) => row?.evidence_role).filter(Boolean))].sort(),
    approved_at: supplement.approved_at ?? "",
    submitted_at: supplement.submitted_at ?? "",
    carrier_response_at: supplement.carrier_response_at ?? "",
    closed_at: supplement.closed_at ?? "",
    modified: supplement.modified ?? "",
  };
}

function summarizeQuotePriceRuleSnapshot(snapshot) {
  return {
    quote: snapshot.quote,
    rule_count: snapshot.rules.length,
    rules: snapshot.rules.map((rule) => ({
      price_rule_id: rule.price_rule_id,
      rule_name: rule.rule_name,
      rule_type: rule.rule_type,
      effective_from: rule.effective_from,
      effective_to: rule.effective_to,
    })),
  };
}

function summarizeMarketWatchItem(item) {
  if (!item) return null;
  return {
    name: item.name,
    watch_id: item.watch_id,
    competitor: item.competitor,
    title: item.title,
    risk_level: item.risk_level,
    status: item.status,
    product_gate: item.product_gate ?? "",
  };
}

function supplierOrderRowsFromTakeoff(takeoff) {
  const rows = Array.isArray(takeoff.items) ? takeoff.items : [];
  return rows
    .map((raw) => {
      const row = raw ?? {};
      return {
        category: String(row.category ?? "").trim(),
        item_name: String(row.item_name ?? "").trim(),
        quantity: Number(row.quantity),
        unit: String(row.unit ?? "").trim(),
        source_ref: String(row.source_ref ?? row.item_name ?? "").trim(),
      };
    })
    .filter((row) => row.item_name && Number.isFinite(row.quantity));
}

function supplierOrderItemForTakeoffItem(row) {
  return {
    category: row.category,
    item_name: row.item_name,
    quantity: row.quantity,
    unit: row.unit,
    source_ref: row.source_ref || row.item_name,
    status: "Draft",
    received_qty: 0,
    shortage_qty: 0,
    substitution_notes: "",
    needs_review: 1,
  };
}

function measurementRowsFromReport(report) {
  const rows = Array.isArray(report.measurements) ? report.measurements : [];
  return rows
    .map((raw) => {
      const row = raw ?? {};
      return {
        metric: String(row.metric ?? "").trim(),
        value: Number(row.value),
        unit: String(row.unit ?? "").trim(),
        confidence: String(row.confidence ?? "").trim(),
        source_ref: String(row.source_ref ?? row.metric ?? "").trim(),
        needs_review: Boolean(row.needs_review),
      };
    })
    .filter((row) => row.metric && Number.isFinite(row.value));
}

const TAKEOFF_HASH = /^[a-f0-9]{64}$/;
const TAKEOFF_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function parseGovernedRoofGraph(measurementReport) {
  let graph;
  try {
    graph = JSON.parse(measurementReport.roof_graph_json);
  } catch {
    throw new Error("material_takeoff_roof_graph_required");
  }
  if (!graph || typeof graph !== "object" || Array.isArray(graph) || graph.schema_version !== "roof_graph/v1") {
    throw new Error("material_takeoff_roof_graph_invalid");
  }
  if (!TAKEOFF_HASH.test(graph.revision ?? "") || measurementReport.roof_graph_revision !== graph.revision) {
    throw new Error("material_takeoff_geometry_revision_mismatch");
  }
  if (
    !graph.source
    || graph.source.raw_sha256 !== graph.revision
    || !TAKEOFF_HASH.test(graph.source.raw_sha256 ?? "")
    || !String(graph.source.raw_key ?? "").trim()
    || !String(graph.source.provider ?? "").trim()
  ) {
    throw new Error("material_takeoff_roof_graph_source_invalid");
  }
  if (
    !Array.isArray(graph.points)
    || graph.points.length === 0
    || !Array.isArray(graph.edges)
    || graph.edges.length === 0
    || !Array.isArray(graph.facets)
    || graph.facets.length === 0
    || !Array.isArray(graph.checks)
    || typeof graph.needs_review !== "boolean"
    || !graph.measurements
    || typeof graph.measurements !== "object"
    || Array.isArray(graph.measurements)
    || !graph.source_refs
    || typeof graph.source_refs !== "object"
    || Array.isArray(graph.source_refs)
  ) {
    throw new Error("material_takeoff_roof_graph_invalid");
  }
  return graph;
}

function parseApprovedTakeoffPolicy({
  takeoffPolicy,
  policyEvidence,
  tenantId,
  materialSystem,
  roofJob,
  nowIso,
  policyAuthority,
}) {
  const policyId = takeoffPolicy.policy_id ?? takeoffPolicy.name;
  if (!TAKEOFF_ID.test(policyId ?? "")) throw new Error("material_takeoff_policy_id_invalid");
  const historicalReplay = policyAuthority === "historical_replay";
  if (policyAuthority !== "current_approved" && !historicalReplay) {
    throw new Error("material_takeoff_policy_authority_invalid");
  }
  if (
    (historicalReplay && !["Approved", "Retired"].includes(takeoffPolicy.status))
    || (!historicalReplay && takeoffPolicy.status !== "Approved")
  ) {
    throw new Error("material_takeoff_policy_approved_required");
  }
  if (takeoffPolicy.tenant !== tenantId) throw new Error("material_takeoff_policy_tenant_mismatch");
  if (takeoffPolicy.brand !== roofJob.brand) throw new Error("material_takeoff_policy_brand_mismatch");
  if (takeoffPolicy.service_type !== roofJob.service_type) throw new Error("material_takeoff_policy_service_mismatch");
  if (takeoffPolicy.material_system !== materialSystem) throw new Error("material_takeoff_policy_material_system_mismatch");
  const policyVersion = Number(takeoffPolicy.policy_version);
  if (!Number.isInteger(policyVersion) || policyVersion < 1) throw new Error("material_takeoff_policy_version_invalid");
  if (
    !String(takeoffPolicy.approved_by ?? "").trim()
    || !Number.isFinite(Date.parse(takeoffPolicy.approved_at ?? ""))
    || !String(takeoffPolicy.approval_note ?? "").trim()
  ) {
    throw new Error("material_takeoff_policy_approval_invalid");
  }
  const effectiveAt = Date.parse(nowIso ?? "");
  const effectiveFrom = Date.parse(takeoffPolicy.effective_from ?? "");
  const effectiveTo = takeoffPolicy.effective_to
    ? Date.parse(`${String(takeoffPolicy.effective_to).slice(0, 10)}T23:59:59.999Z`)
    : null;
  if (!Number.isFinite(effectiveAt) || !Number.isFinite(effectiveFrom)) {
    throw new Error("material_takeoff_policy_effective_window_invalid");
  }
  if (effectiveAt < effectiveFrom || (effectiveTo !== null && (!Number.isFinite(effectiveTo) || effectiveAt > effectiveTo))) {
    throw new Error("material_takeoff_policy_not_effective");
  }

  if (
    !policyEvidence
    || policyEvidence.name !== takeoffPolicy.source_evidence
    || policyEvidence.sync_state !== "Verified"
    || policyEvidence.checksum_algorithm !== "SHA-256"
    || !TAKEOFF_HASH.test(policyEvidence.content_checksum ?? "")
    || !Number.isFinite(Date.parse(policyEvidence.verified_at ?? ""))
    || !String(policyEvidence.verification_source ?? "").trim()
  ) {
    throw new Error("material_takeoff_policy_evidence_invalid");
  }

  let payload;
  try {
    payload = JSON.parse(takeoffPolicy.policy_json);
  } catch {
    throw new Error("material_takeoff_policy_json_invalid");
  }
  assertExactTakeoffKeys(payload, ["calculation_version", "options", "schema_version"], "material_takeoff_policy_json_invalid");
  if (
    payload.schema_version !== "material_takeoff_policy/v1"
    || payload.calculation_version !== GOVERNED_TAKEOFF_CALCULATION_VERSION
  ) {
    throw new Error("material_takeoff_policy_schema_invalid");
  }
  const raw = payload.options;
  assertExactTakeoffKeys(raw, [
    "clip_spacing_ft",
    "coil_allowances",
    "coverage_width_ft",
    "fastener_item_ids",
    "length_increment_ft",
    "max_panel_length_ft",
    "min_reusable_offcut_ft",
    "mode",
    "panel_item_id",
    "screws_per_clip",
    "stock_lengths_ft",
    "trim_lap_ft",
    "trim_profiles",
    "trim_screw_spacing_ft",
    "trim_stock_ft",
  ], "material_takeoff_policy_options_invalid");
  assertExactTakeoffKeys(raw.coil_allowances, ["scrap_factor", "setup_ft", "tail_ft"], "material_takeoff_policy_coil_allowances_invalid");
  assertExactTakeoffKeys(raw.fastener_item_ids, ["clip", "clip_screw", "trim_screw"], "material_takeoff_policy_fasteners_invalid");
  const options = {
    panelProfileId: raw.panel_item_id,
    coverageWidthFt: raw.coverage_width_ft,
    lengthIncrementFt: raw.length_increment_ft,
    maxPanelLengthFt: raw.max_panel_length_ft,
    mode: raw.mode,
    stockLengthsFt: raw.stock_lengths_ft,
    minReusableOffcutFt: raw.min_reusable_offcut_ft,
    coilSetupAllowanceFt: raw.coil_allowances.setup_ft,
    coilTailAllowanceFt: raw.coil_allowances.tail_ft,
    coilScrapFactor: raw.coil_allowances.scrap_factor,
    trimStockFt: raw.trim_stock_ft,
    trimLapFt: raw.trim_lap_ft,
    trimProfiles: raw.trim_profiles,
    clipSpacingFt: raw.clip_spacing_ft,
    screwsPerClip: raw.screws_per_clip,
    trimScrewSpacingFt: raw.trim_screw_spacing_ft,
    fastenerItemIds: {
      clip: raw.fastener_item_ids.clip,
      clipScrew: raw.fastener_item_ids.clip_screw,
      trimScrew: raw.fastener_item_ids.trim_screw,
    },
  };
  const policyBinding = {
    id: policyId,
    tenant: tenantId,
    brand: takeoffPolicy.brand,
    service_type: takeoffPolicy.service_type,
    material_system: materialSystem,
    version: policyVersion,
    effective_from: takeoffPolicy.effective_from,
    effective_to: takeoffPolicy.effective_to || null,
    source_evidence: policyEvidence.name,
    source_evidence_sha256: policyEvidence.content_checksum,
    source_evidence_verified_at: policyEvidence.verified_at,
    source_evidence_verification_source: policyEvidence.verification_source,
    approved_by: takeoffPolicy.approved_by,
    approved_at: takeoffPolicy.approved_at,
    policy_payload: payload,
  };
  return { options, policyBinding, policyDigest: digest(policyBinding) };
}

function assertExactTakeoffKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) throw new Error(code);
}

function materialTakeoffReviewReasons(graph, computed) {
  const reasons = [];
  if (graph.needs_review) reasons.push("geometry_needs_review");
  for (const check of computed.checks.filter((entry) => !entry.ok)) {
    reasons.push(`computed_check:${check.check}:${check.target}`);
  }
  if (computed.totals.panelCount === 0) reasons.push("panel_schedule_empty");
  if (computed.totals.skippedFacets > 0) reasons.push("facet_schedule_incomplete");
  if (computed.panelNest.unplaced.length > 0) reasons.push("panel_cuts_unplaced");
  if (computed.needsReview && reasons.length === 0) reasons.push("takeoff_engine_needs_review");
  return [...new Set(reasons)].sort();
}

function materialTakeoffRows(computed, options, binding) {
  const common = {
    policy_digest: binding.policyDigest,
    options_digest: binding.optionsDigest,
    geometry_revision: binding.geometryRevision,
    stock_mode: computed.panelNest.mode,
    needs_review: binding.needsReview ? 1 : 0,
    confidence: "computed-governed",
  };
  const rows = [{
    ...common,
    category: "Panel Material",
    item_name: options.panelProfileId,
    quantity: computed.panelNest.stockFt,
    unit: "ft",
    waste_factor: roundTakeoffPercent(computed.panelNest.wastePct),
    waste_basis: computed.sourceRefs.panel_stock_ft,
    source_ref: `roof_graph:${binding.geometryRevision}#panel_cuts`,
  }];
  for (const trim of computed.trims) {
    rows.push({
      ...common,
      category: "Trim Material",
      item_name: trim.profile,
      quantity: trim.stockFt,
      unit: "ft",
      waste_factor: roundTakeoffPercent(trim.wastePct),
      waste_basis: `${trim.sticks} x ${computed.sourceRefs[`trim_${trim.profile}_ft`] ?? "governed trim schedule"}`,
      source_ref: `roof_graph:${binding.geometryRevision}#trim:${trim.profile}`,
    });
  }
  for (const [itemName, quantity, sourceKey] of [
    [options.fastenerItemIds.clip, computed.fasteners.clips, "clips"],
    [options.fastenerItemIds.clipScrew, computed.fasteners.clipScrews, "clips"],
    [options.fastenerItemIds.trimScrew, computed.fasteners.trimScrews, "trim_screws"],
  ]) {
    rows.push({
      ...common,
      category: "Fastener",
      item_name: itemName,
      quantity,
      unit: "each",
      waste_factor: 0,
      waste_basis: computed.sourceRefs[sourceKey],
      source_ref: `roof_graph:${binding.geometryRevision}#fastener:${itemName}`,
    });
  }
  return rows;
}

function roundTakeoffPercent(value) {
  return Math.round(value * 10_000 * 100) / 10_000;
}

function newRunId() {
  return `hr_${crypto.randomUUID()}`;
}

function text(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  await attestFrappeServicePrincipal(config);
  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
