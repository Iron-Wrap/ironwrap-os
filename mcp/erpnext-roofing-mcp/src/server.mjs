#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const GateStateSchema = z.enum(["Blocked", "Ready", "Waived", "Done"]);
const MaterialTakeoffStatusSchema = z.enum(["Needs Review", "Approved", "Rejected"]);

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
  "source_file",
  "report_url",
  "raw_key",
  "parsed_at",
  "review_status",
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
  "lead_envelope",
  "evidence_type",
  "source_system",
  "source_uri",
  "r2_key",
  "customer_safe",
  "captured_at",
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

export function configFromEnv(env = process.env) {
  const baseUrl = env.ERPNEXT_BASE_URL?.replace(/\/+$/, "");
  const apiKey = env.ERPNEXT_API_KEY;
  const apiSecret = env.ERPNEXT_API_SECRET;
  const writeEnabled = env.ERPNEXT_WRITE_ENABLED === "true";
  const writeToken = env.HERMES_WRITE_TOKEN;
  if (!baseUrl) throw new Error("ERPNEXT_BASE_URL is required");
  if (!apiKey) throw new Error("ERPNEXT_API_KEY is required");
  if (!apiSecret) throw new Error("ERPNEXT_API_SECRET is required");
  return { baseUrl, apiKey, apiSecret, writeEnabled, writeToken };
}

export async function erpRequest(config, method, path, body) {
  const res = await fetch(config.baseUrl + path, {
    method,
    headers: {
      accept: "application/json",
      authorization: `token ${config.apiKey}:${config.apiSecret}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`erpnext_http_${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json();
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

export function assertWriteApproved(config, approvalToken) {
  if (!config.writeEnabled) throw new Error("erpnext_write_disabled");
  if (!config.writeToken) throw new Error("hermes_write_token_required");
  if (approvalToken !== config.writeToken) throw new Error("approval_token_invalid");
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

export function proposalPackIdForRoofJob(roofJobId) {
  return `proposal:${roofJobId}`;
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
  packId = proposalPackIdForRoofJob(roofJobId),
  measurements = [],
  evidence = [],
  nowIso,
} = {}) {
  if (!roofJobId) throw new Error("roof_job_id_required");
  const measurementReports = measurements.map((row) => ({
    name: row.name,
    measurement_id: row.measurement_id ?? row.name,
    provider: row.provider ?? "",
    source_file: row.source_file ?? "",
    report_url: row.report_url ?? "",
    raw_key: row.raw_key ?? "",
    parsed_at: row.parsed_at ?? "",
    review_status: row.review_status ?? "",
  }));
  const evidenceItems = evidence.map((row) => ({
    name: row.name,
    evidence_id: row.evidence_id ?? row.name,
    evidence_type: row.evidence_type ?? "",
    source_system: row.source_system ?? "",
    source_uri: row.source_uri ?? "",
    r2_key: row.r2_key ?? "",
    customer_safe: Boolean(row.customer_safe),
    captured_at: row.captured_at ?? "",
    summary: row.summary ?? "",
  }));
  const summary = {
    roof_job: roofJobId,
    generated_at: nowIso,
    counts: {
      measurement_reports: measurementReports.length,
      evidence_items: evidenceItems.length,
    },
    measurement_reports: measurementReports,
    evidence_items: evidenceItems,
  };

  return {
    pack_id: packId,
    roof_job: roofJobId,
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
    customer_message: [
      "<p>We assembled the available measurement and project evidence for estimator review.</p>",
      "<p>The final proposal will confirm scope, options, exclusions, warranty, and payment terms after approval.</p>",
    ].join(""),
  };
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
  const { approval_token: _approvalToken, ...safeArgs } = args;
  return safeArgs;
}

export function buildServer(config) {
  const server = new McpServer({ name: "erpnext-roofing-mcp", version: "0.1.0" });

  server.registerTool(
    "get_roof_job",
    {
      title: "Get Roof Job",
      description: "Read one IronWrap Roof Job by roof_job_id/name.",
      inputSchema: { roof_job_id: z.string().min(1) },
    },
    async ({ roof_job_id }) => text(await erpGet(config, resourcePath("Roof Job", roof_job_id))),
  );

  server.registerTool(
    "get_lead_envelope",
    {
      title: "Get Lead Envelope",
      description: "Read one ERPNext Lead Envelope by envelope_id/name.",
      inputSchema: { envelope_id: z.string().min(1) },
    },
    async ({ envelope_id }) => text(await erpGet(config, resourcePath("Lead Envelope", envelope_id))),
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
      description: "Read one ERPNext Measurement Report by measurement_id/name.",
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
      description: "Read one ERPNext Material Takeoff by takeoff_id/name.",
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
      description: "Read one ERPNext Supplier Order by supplier_order_id/name.",
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
      description: "Read one ERPNext Instant Estimate Session by estimate_session_id/name.",
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
      description: "Read one ERPNext Evidence Item by evidence_id/name.",
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
      description: "Read one ERPNext Field Check-in by checkin_id/name.",
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
      description: "Read one ERPNext Proposal Evidence Pack by pack_id/name.",
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
      description: "Read one ERPNext Payment Milestone by payment_milestone_id/name.",
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
      description: "Preview a review-gated Material Takeoff from ERPNext Measurement Report values without writing to ERPNext.",
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
        approval_token: z.string().min(1),
        run_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      assertWriteApproved(config, args.approval_token);
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
        agentRole: "Estimator Assistant",
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
      description: "Preview a Material Takeoff review-status update without writing to ERPNext.",
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
        approval_token: z.string().min(1),
        run_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      assertWriteApproved(config, args.approval_token);
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
        agentRole: "Estimator Assistant",
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
      description: "Preview a review-gated Supplier Order draft from an approved Material Takeoff without writing to ERPNext.",
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
        approval_token: z.string().min(1),
        run_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      assertWriteApproved(config, args.approval_token);
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
        agentRole: "Production Controller",
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
      description: "Preview the draft Proposal Evidence Pack assembled from job evidence without writing to ERPNext.",
      inputSchema: {
        roof_job_id: z.string().min(1),
        pack_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ roof_job_id, pack_id, limit = 25 }) => {
      const { draft, measurements, evidence } = await buildProposalDraftFromErp(config, roof_job_id, { packId: pack_id, limit });
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
        pack_id: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        approval_token: z.string().min(1),
        run_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      assertWriteApproved(config, args.approval_token);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const { draft, measurements, evidence } = await buildProposalDraftFromErp(config, args.roof_job_id, {
        packId: args.pack_id,
        limit: args.limit ?? 25,
        nowIso: now,
      });
      const before = await readResourceOrNull(config, "Proposal Evidence Pack", draft.pack_id);
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
        agentRole: "Estimator Assistant",
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
      description: "Preview one Production Gate State update without writing to ERPNext.",
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
        approval_token: z.string().min(1),
        run_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      assertWriteApproved(config, args.approval_token);
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
        agentRole: "Production Controller",
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
    "dry_run_completion_packet",
    {
      title: "Dry Run Completion Packet",
      description: "Preview a review-gated Completion Packet assembled from field check-ins and photo evidence without writing to ERPNext.",
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
        approval_token: z.string().min(1),
        run_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      assertWriteApproved(config, args.approval_token);
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
        agentRole: "Field Companion",
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
        execute: upsertDraftExecutor(config, "Completion Packet", draft.completion_packet_id, draft, before),
        responseExtra: { upserted: true, operation, completion_packet_id: draft.completion_packet_id },
      }));
    },
  );

  server.registerTool(
    "dry_run_warranty_packet",
    {
      title: "Dry Run Warranty Packet",
      description: "Preview a Warranty Packet draft from an approved, warranty-ready Completion Packet without writing to ERPNext.",
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
        approval_token: z.string().min(1),
        run_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      assertWriteApproved(config, args.approval_token);
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
        agentRole: "Closeout Agent",
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
      description: "Preview a Review Request with deterministic stop conditions (completion, payment evidence, consent) without writing to ERPNext.",
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
        approval_token: z.string().min(1),
        run_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      assertWriteApproved(config, args.approval_token);
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
        agentRole: "Closeout Agent",
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
      description: "Preview a policy-gated Communication Event record (consent plus quiet hours) without writing to ERPNext. Never sends anything.",
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
        approval_token: z.string().min(1),
        run_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      assertWriteApproved(config, args.approval_token);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const draft = await buildCommunicationEventDraftFromArgs(args, now);
      const before = await readResourceOrNull(config, "Communication Event", draft.communication_event_id);
      const operation = before ? "update" : "create";
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: "Lead Concierge",
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
      description: "Preview a review-gated Supplier Quote draft from an approved Material Takeoff without writing to ERPNext.",
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
        approval_token: z.string().min(1),
        run_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      assertWriteApproved(config, args.approval_token);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const { draft, materialTakeoff } = await buildSupplierQuoteDraftFromErp(config, args, now);
      const before = await readResourceOrNull(config, "Supplier Quote", draft.supplier_quote_id);
      const operation = before ? "update" : "create";
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: "Production Controller",
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
    "dry_run_market_watch_item",
    {
      title: "Dry Run Market Watch Item",
      description: "Preview a Market Watch Item (competitor change and required response) without writing to ERPNext.",
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
        approval_token: z.string().min(1),
        run_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      assertWriteApproved(config, args.approval_token);
      const now = new Date().toISOString();
      const runId = args.run_id ?? newRunId();
      const draft = buildMarketWatchItemDraft({ ...marketWatchDraftArgs(args), nowIso: now });
      const before = await readResourceOrNull(config, "Market Watch Item", draft.watch_id);
      const operation = before ? "update" : "create";
      return text(await executeAuditedWrite(config, {
        runId,
        now,
        args,
        agentRole: "Owner Operator",
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

  return server;
}

// Registers the standard get-by-id plus list-for-job read pair for one DocType.
function registerReadPair(server, config, { doctype, idArg, getName, listName, fields, orderBy = "modified desc" }) {
  server.registerTool(
    getName,
    {
      title: `Get ${doctype}`,
      description: `Read one ERPNext ${doctype} by ${idArg}/name.`,
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

async function finalizeHermesRun(config, runId, patch) {
  try {
    await erpPut(config, resourcePath("Hermes Run", runId), patch);
    return null;
  } catch (err) {
    return String(err).slice(0, 500);
  }
}

// Shared approved-write flow: audit row BEFORE the mutation, execute, finalize the audit,
// mark the run failed on error. Every request_* tool funnels through here so the
// read -> dry_run -> approval -> write -> audit contract cannot drift per tool.
async function executeAuditedWrite(config, {
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
  await erpPost(config, "/api/resource/Hermes%20Run", {
    run_id: runId,
    run_ts: now,
    agent_role: agentRole,
    requested_by: args.approved_by,
    request_text: args.request_text,
    target_doctype: target.doctype,
    target_name: target.name,
    ...(roofJob ? { roof_job: roofJob } : {}),
    ...(leadEnvelope ? { lead_envelope: leadEnvelope } : {}),
    ...(linkedEvidence ? { linked_evidence: linkedEvidence } : {}),
    capability_level: "Approved-write",
    tool_name: toolName,
    tool_args_json: JSON.stringify(redactApprovalArgs(args)),
    dry_run_json: JSON.stringify(dryRun),
    approval_status: "Approved",
    approved_by: args.approved_by,
    approved_at: now,
    before_target_ids: JSON.stringify(beforeSummary),
  });

  try {
    const result = await execute();
    const auditError = await finalizeHermesRun(config, runId, {
      approval_status: "Executed",
      result_status: "OK",
      after_target_ids: JSON.stringify(afterSummary),
      result_json: JSON.stringify(result),
    });
    return {
      run_id: runId,
      ...responseExtra,
      audit_finalized: auditError === null,
      ...(auditError ? { audit_error: auditError } : {}),
      result,
    };
  } catch (err) {
    await erpPut(config, resourcePath("Hermes Run", runId), {
      approval_status: "Failed",
      result_status: "Error",
      error: String(err).slice(0, 500),
    }).catch(() => {});
    throw err;
  }
}

// Shared upsert executor for request_create_* tools that write a full draft document.
function upsertDraftExecutor(config, doctype, name, draft, before) {
  return before
    ? () => erpPut(config, resourcePath(doctype, name), draft)
    : () => erpPost(config, `/api/resource/${encodeURIComponent(doctype)}`, draft);
}

async function buildProposalDraftFromErp(config, roofJobId, { packId, limit = 25, nowIso } = {}) {
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
    packId,
    measurements,
    evidence,
    nowIso,
  });
  return { draft, measurements, evidence };
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
