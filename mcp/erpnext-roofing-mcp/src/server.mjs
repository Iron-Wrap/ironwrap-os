#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  approvedArgs,
  digest,
  parseToolPayload,
  semanticPreview,
  signDryRunReceipt,
  verifyApprovalReceipt,
  verifyDryRunReceipt,
} from "./approval-contract.mjs";

const DEFAULT_ROLE_POLICY_PATH = fileURLToPath(
  new URL("../../../hermes/agents/roles.json", import.meta.url),
);

const REQUEST_TO_DRY_RUN = Object.freeze({
  request_update_gate: "dry_run_update_gate",
  request_create_material_takeoff: "dry_run_material_takeoff",
  request_update_material_takeoff_status: "dry_run_update_material_takeoff_status",
  request_create_supplier_order: "dry_run_supplier_order",
  request_create_supplier_quote: "dry_run_supplier_quote",
  request_create_quote_revision: "dry_run_quote_revision",
  request_bind_quote_price_rules: "dry_run_bind_quote_price_rules",
  request_create_proposal_evidence_pack: "dry_run_proposal_evidence_pack",
  request_create_job_assignment: "dry_run_job_assignment",
  request_create_change_order: "dry_run_change_order",
  request_transition_change_order: "dry_run_change_order_transition",
  request_create_insurance_supplement: "dry_run_insurance_supplement",
  request_set_insurance_supplement_evidence: "dry_run_set_insurance_supplement_evidence",
  request_transition_insurance_supplement: "dry_run_insurance_supplement_transition",
  request_create_safety_plan: "dry_run_safety_plan",
  request_record_safety_acknowledgement: "dry_run_safety_acknowledgement",
  request_record_job_compliance: "dry_run_job_compliance_record",
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
});

const FIELD_RECORD_TOOL_REFERENCES = Object.freeze({
  get_field_check_in: ["Field Check-in", "checkin_id"],
  get_evidence_item: ["Evidence Item", "evidence_id"],
  get_job_assignment: ["Job Assignment", "assignment_id"],
  get_safety_plan: ["Safety Plan", "safety_plan_id"],
  get_job_compliance_record: ["Job Compliance Record", "compliance_record_id"],
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
  "modified",
];

const SUPPLIER_ORDER_FIELDS = [
  "name",
  "supplier_order_id",
  "roof_job",
  "material_takeoff",
  "supplier",
  "status",
  "prepared_at",
  "approved_by",
  "approved_at",
  "requested_delivery_date",
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
  const apiKey = env.ERPNEXT_API_KEY;
  const apiSecret = env.ERPNEXT_API_SECRET;
  const writeEnabled = env.ERPNEXT_WRITE_ENABLED === "true";
  const rolePolicy = loadRolePolicy(env.HERMES_ROLE_POLICY_PATH || DEFAULT_ROLE_POLICY_PATH);
  const agentRole = env.HERMES_AGENT_ROLE;
  const actorUser = env.HERMES_ACTOR_USER;
  const approverId = env.HERMES_APPROVER_ID;
  const runtimeRole = rolePolicy.roles?.[agentRole];
  if (!apiKey) throw new Error("ERPNEXT_API_KEY is required");
  if (!apiSecret) throw new Error("ERPNEXT_API_SECRET is required");
  if (!runtimeRole) throw new Error("HERMES_AGENT_ROLE must name a role in roles.json");
  if (!actorUser) throw new Error("HERMES_ACTOR_USER is required");
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
  const requestTimeoutMs = parseRequestTimeout(env.ERPNEXT_REQUEST_TIMEOUT_MS);
  return {
    baseUrl,
    apiKey,
    apiSecret,
    writeEnabled,
    requestTimeoutMs,
    agentRole,
    agentRoleTitle: runtimeRole.title,
    actorUser,
    approverId,
    allowedTools: roleTools(runtimeRole),
    dryRunSigningKey: env.HERMES_DRY_RUN_SIGNING_KEY,
    approvalPublicKey,
  };
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

export async function erpPost(config, path, body) {
  return await erpRequest(config, "POST", path, body);
}

export async function erpPut(config, path, body) {
  return await erpRequest(config, "PUT", path, body);
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

export function buildGateUpdatePatch(nextState, reason, approvedBy, nowIso) {
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if ((nextState === "Blocked" || nextState === "Waived") && !cleanReason) {
    throw new Error("reason_required_for_gate_state");
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
  measurementReport = {},
  nowIso,
} = {}) {
  if (!roofJobId) throw new Error("roof_job_id_required");
  const measurements = measurementRowsFromReport(measurementReport);
  if (!measurements.length) throw new Error("measurement_values_required");
  const measurementReportId = measurementReport.measurement_id ?? measurementReport.name ?? "";
  const source = {
    roof_job: roofJobId,
    measurement_report: measurementReportId,
    provider: measurementReport.provider ?? "",
    review_status: measurementReport.review_status ?? "",
    generated_at: nowIso,
    measurements,
  };

  return {
    takeoff_id: takeoffId,
    roof_job: roofJobId,
    measurement_report: measurementReportId,
    status: "Needs Review",
    ...(nowIso ? { prepared_at: nowIso } : {}),
    source_measurements_json: JSON.stringify(source, null, 2),
    assumptions: [
      "Draft takeoff rows are copied from parsed measurement evidence for estimator review.",
      "Waste, accessories, substitutions, supplier availability, and install details require human approval.",
    ].join("\n"),
    exclusions: [
      "This takeoff does not create a final quote, supplier order, purchase order, delivery request, or invoice.",
      "No material quantity is approved until the estimator marks the takeoff approved.",
    ].join("\n"),
    items: measurements.map(takeoffItemForMeasurement),
  };
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

export function checkConsent({ channel, consentBasis } = {}) {
  const basis = (consentBasis ?? "").trim().toLowerCase();
  const express = basis === "express";
  const ebr = basis === "existing_business_relationship" || basis === "ebr";
  const reasons = [];
  if (channel === "Portal") return { allowed: true, channel, consent_basis: basis, reasons };
  if (!basis) reasons.push("consent_basis_missing");
  else if (channel === "SMS" && !express) reasons.push("sms_requires_express_consent");
  else if (!express && !ebr) reasons.push("consent_basis_insufficient");
  return { allowed: reasons.length === 0, channel, consent_basis: basis, reasons };
}

export function checkQuietHours({
  nowUtcIso,
  timezoneOffsetMinutes = -360,
  startHour = 9,
  endHour = 20,
} = {}) {
  const ts = Date.parse(nowUtcIso ?? "");
  if (!Number.isFinite(ts)) throw new Error("now_utc_iso_required");
  const localHour = new Date(ts + timezoneOffsetMinutes * 60_000).getUTCHours();
  return {
    ok: localHour >= startHour && localHour < endHour,
    local_hour: localHour,
    start_hour: startHour,
    end_hour: endHour,
  };
}

export function buildCommunicationEventDraft({
  eventId,
  roofJobId,
  leadEnvelopeId,
  channel,
  direction = "Outbound",
  template,
  consentBasis,
  bodyPreview,
  recipientRef,
  nowUtcIso,
  timezoneOffsetMinutes,
  startHour,
  endHour,
} = {}) {
  if (!channel) throw new Error("channel_required");
  if (!roofJobId && !leadEnvelopeId) throw new Error("roof_job_or_lead_envelope_required");
  if (!str(recipientRef)) throw new Error("recipient_ref_required");
  const consent = checkConsent({ channel, consentBasis });
  const quiet = direction === "Outbound"
    ? checkQuietHours({ nowUtcIso, timezoneOffsetMinutes, startHour, endHour })
    : { ok: true, local_hour: null };
  const reasons = [...consent.reasons, ...(quiet.ok ? [] : ["quiet_hours_blocked"])];
  const allowed = reasons.length === 0;

  return {
    communication_event_id: eventId ?? `comm:${slugify([channel, recipientRef, nowUtcIso].join(":"))}`,
    ...(roofJobId ? { roof_job: roofJobId } : {}),
    ...(leadEnvelopeId ? { lead_envelope: leadEnvelopeId } : {}),
    channel,
    direction,
    template: template ?? "",
    consent_basis: consent.consent_basis,
    policy_result: allowed ? "Allowed" : "Blocked",
    policy_reasons_json: JSON.stringify({ evaluated_at: nowUtcIso, allowed, reasons, quiet }, null, 2),
    quiet_hours_ok: quiet.ok ? 1 : 0,
    status: allowed ? "Draft" : "Blocked",
    body_preview: bodyPreview ?? "",
    recipient_ref: recipientRef,
    event_ts: nowUtcIso,
    notes: "Policy-gated draft record. No message is sent by this tool.",
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
const IsoDateTimeSchema = z.string().datetime({ offset: true });
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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
  assigned_by: IdSchema,
  supersedes: IdSchema.optional(),
  correction_reason: z.string().min(1).max(2000).optional(),
  notes: z.string().max(2000).optional(),
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

export function approvedWriteInputSchema(baseSchema) {
  const approvalShape = {
    request_text: z.string().min(1).max(4000),
    approved_by: z.string().min(1).max(140),
    run_id: z.string().min(8).max(128),
    dry_run_receipt: z.string().min(32).max(4096),
    approval_receipt: z.string().min(32).max(8192),
  };
  if (baseSchema instanceof z.ZodDiscriminatedUnion) {
    return z.discriminatedUnion(
      baseSchema.discriminator,
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
  return {
    ...config,
    agentRole,
    agentRoleTitle: config.agentRoleTitle ?? role.title,
    actorUser: config.actorUser ?? "test-owner@example.com",
    approverId: config.approverId ?? "test-owner@example.com",
    allowedTools: config.allowedTools ?? roleTools(role),
    siteId: config.siteId ?? digest({ frappe_base_url: config.baseUrl ?? "" }),
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
  for (const field of ["acknowledged_by", "assigned_by", "captured_by", "prepared_by", "requested_by"]) {
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
      description: "Preview a review-gated Material Takeoff from IronWrap OS Measurement Report values without writing.",
      inputSchema: {
        roof_job_id: z.string().min(1),
        measurement_report_id: z.string().min(1).optional(),
        takeoff_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ roof_job_id, measurement_report_id, takeoff_id, limit = 25 }) => {
      const { draft, measurementReport } = await buildMaterialTakeoffDraftFromErp(config, roof_job_id, {
        measurementReportId: measurement_report_id,
        takeoffId: takeoff_id,
        limit,
      });
      return text({
        would_write: false,
        required_tool: "request_create_material_takeoff",
        target: { doctype: "Material Takeoff", name: draft.takeoff_id },
        source: {
          measurement_report: measurementReport.measurement_id ?? measurementReport.name,
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
      description: "Approved-write: create or update one review-gated Material Takeoff and record a Hermes Run audit row.",
      inputSchema: {
        roof_job_id: z.string().min(1),
        measurement_report_id: z.string().min(1).optional(),
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
      const { draft, measurementReport } = await buildMaterialTakeoffDraftFromErp(config, args.roof_job_id, {
        measurementReportId: args.measurement_report_id,
        takeoffId: args.takeoff_id,
        limit: args.limit ?? 25,
        nowIso: now,
      });
      const before = await readResourceOrNull(config, "Material Takeoff", draft.takeoff_id);
      const operation = before ? "update" : "create";
      const dryRun = {
        target: { doctype: "Material Takeoff", name: draft.takeoff_id },
        operation,
        source: {
          measurement_report: measurementReport.measurement_id ?? measurementReport.name,
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
        afterSummary: summarizeMaterialTakeoff({ ...(before ?? {}), ...draft, name: draft.takeoff_id }),
        execute: upsertDraftExecutor(config, "Material Takeoff", draft.takeoff_id, draft, before),
        responseExtra: { upserted: true, operation, material_takeoff_id: draft.takeoff_id },
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
    "dry_run_update_gate",
    {
      title: "Dry Run Update Gate",
      description: "Preview one Production Gate State update without writing.",
      inputSchema: {
        gate_id: z.string().min(1),
        next_state: GateStateSchema,
        reason: z.string().max(2000).optional(),
      },
    },
    async ({ gate_id, next_state, reason }) => {
      const before = await readResource(config, "Production Gate State", gate_id);
      const patch = buildGateUpdatePatch(next_state, reason);
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
      const patch = buildGateUpdatePatch(args.next_state, args.reason, args.approved_by, now);
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
        linkedEvidence: before.evidence_item,
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

async function buildCommunicationEventDraftFromArgs(args, nowIso) {
  return buildCommunicationEventDraft({
    eventId: args.communication_event_id,
    roofJobId: args.roof_job_id,
    leadEnvelopeId: args.lead_envelope_id,
    channel: args.channel,
    direction: args.direction,
    template: args.template,
    consentBasis: args.consent_basis,
    bodyPreview: args.body_preview,
    recipientRef: args.recipient_ref,
    nowUtcIso: args.now_utc_iso ?? nowIso ?? new Date().toISOString(),
    timezoneOffsetMinutes: args.timezone_offset_minutes,
    startHour: args.quiet_start_hour,
    endHour: args.quiet_end_hour,
  });
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
    || !/^[a-f0-9]{64}$/i.test(String(evidence?.content_checksum ?? ""))) {
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
    run_ts: now,
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
    dry_run_json: JSON.stringify(dryRun),
    policy_check_json: JSON.stringify({
      allowed: true,
      checks: ["tool_input_schema", "deterministic_builder", "signed_dry_run_receipt", "signed_human_approval_receipt", "doctype_validate_hook"],
      target,
    }),
    policy_checked_at: now,
    policy_checked_by: args.__hermes_actor_user ?? args.approved_by,
    approval_status: "Approved",
    approved_by: args.approved_by,
    approved_at: now,
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
    const result = await execute();
    mutationApplied = true;
    const resolvedAfterSummary = typeof afterSummary === "function"
      ? afterSummary(result)
      : afterSummary;
    const completedAt = new Date().toISOString();
    const auditError = await finalizeHermesRun(config, runId, {
      approval_status: "Executed",
      result_status: "OK",
      after_target_ids: JSON.stringify(resolvedAfterSummary),
      result_json: JSON.stringify(result),
      mutation_applied: 1,
      audit_event_id: `audit:${runId}`,
      request_correlation_id: runId,
      completed_at: completedAt,
    });
    if (auditError) {
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
      await erpPut(config, resourcePath("Hermes Run", runId), {
        approval_status: "Failed",
        result_status: "Error",
        error: String(err).slice(0, 500),
        completed_at: new Date().toISOString(),
        mutation_applied: 0,
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
    detected_at: now,
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

async function buildMaterialTakeoffDraftFromErp(config, roofJobId, {
  measurementReportId,
  takeoffId,
  limit = 25,
  nowIso,
} = {}) {
  let reportName = measurementReportId;
  let measurementReport;
  if (!reportName) {
    const reports = await listResources(config, "Measurement Report", {
      fields: MEASUREMENT_REPORT_FIELDS,
      filters: [["Measurement Report", "roof_job", "=", roofJobId]],
      limit,
      orderBy: "parsed_at desc",
    });
    if (!reports.length) throw new Error("measurement_report_required");
    for (const row of reports) {
      const candidateName = row.measurement_id ?? row.name;
      if (!candidateName) continue;
      const candidate = await readResource(config, "Measurement Report", candidateName);
      if (measurementRowsFromReport(candidate).length) {
        measurementReport = candidate;
        break;
      }
    }
    if (!measurementReport) throw new Error("measurement_values_required");
  }
  measurementReport ??= await readResource(config, "Measurement Report", reportName);
  const draft = buildMaterialTakeoffDraft({
    roofJobId,
    takeoffId,
    measurementReport,
    nowIso,
  });
  return { draft, measurementReport };
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
  };
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

function takeoffItemForMeasurement(row) {
  const category = takeoffCategory(row.metric, row.unit);
  return {
    category,
    item_name: takeoffItemName(row.metric, category),
    quantity: row.value,
    unit: row.unit,
    waste_factor: takeoffWasteFactor(category),
    source_ref: row.source_ref || row.metric,
    confidence: row.confidence,
    needs_review: 1,
  };
}

function takeoffCategory(metric, unit) {
  const text = `${metric} ${unit}`.toLowerCase();
  if (text.includes("sqft") || text.includes("square") || text.includes("area")) return "Roof Surface";
  if (text.includes("ft") || text.includes("perimeter") || text.includes("eave") || text.includes("rake") || text.includes("ridge") || text.includes("valley") || text.includes("edge")) {
    return "Linear Metal";
  }
  return "Measurement";
}

function takeoffItemName(metric, category) {
  if (category === "Roof Surface") return `Roof surface from ${metric}`;
  if (category === "Linear Metal") return `Linear metal from ${metric}`;
  return `Measurement input: ${metric}`;
}

function takeoffWasteFactor(category) {
  if (category === "Roof Surface") return 10;
  if (category === "Linear Metal") return 5;
  return 0;
}

function newRunId() {
  return `hr_${crypto.randomUUID()}`;
}

function text(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildServer(configFromEnv());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
