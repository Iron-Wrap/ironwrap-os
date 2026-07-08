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

const INSTANT_ESTIMATE_SESSION_FIELDS = [
  "name",
  "estimate_session_id",
  "lead_envelope",
  "roof_job",
  "service_type",
  "status",
  "range_low",
  "range_high",
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
      await erpPost(config, "/api/resource/Hermes%20Run", {
        run_id: runId,
        run_ts: now,
        agent_role: "Estimator Assistant",
        requested_by: args.approved_by,
        request_text: args.request_text,
        target_doctype: "Material Takeoff",
        target_name: draft.takeoff_id,
        roof_job: args.roof_job_id,
        capability_level: "Approved-write",
        tool_name: "request_create_material_takeoff",
        tool_args_json: JSON.stringify(redactApprovalArgs(args)),
        dry_run_json: JSON.stringify(dryRun),
        approval_status: "Approved",
        approved_by: args.approved_by,
        approved_at: now,
        before_target_ids: JSON.stringify(summarizeMaterialTakeoff(before)),
      });

      try {
        const result = before
          ? await erpPut(config, resourcePath("Material Takeoff", draft.takeoff_id), draft)
          : await erpPost(config, "/api/resource/Material%20Takeoff", draft);
        const after = { ...(before ?? {}), ...draft, name: draft.takeoff_id };
        await erpPut(config, resourcePath("Hermes Run", runId), {
          approval_status: "Executed",
          result_status: "OK",
          after_target_ids: JSON.stringify(summarizeMaterialTakeoff(after)),
          result_json: JSON.stringify(result),
        });
        return text({
          run_id: runId,
          upserted: true,
          operation,
          material_takeoff_id: draft.takeoff_id,
          result,
        });
      } catch (err) {
        await erpPut(config, resourcePath("Hermes Run", runId), {
          approval_status: "Failed",
          result_status: "Error",
          error: String(err).slice(0, 500),
        }).catch(() => {});
        throw err;
      }
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
      await erpPost(config, "/api/resource/Hermes%20Run", {
        run_id: runId,
        run_ts: now,
        agent_role: "Estimator Assistant",
        requested_by: args.approved_by,
        request_text: args.request_text,
        target_doctype: "Material Takeoff",
        target_name: args.takeoff_id,
        roof_job: before.roof_job,
        capability_level: "Approved-write",
        tool_name: "request_update_material_takeoff_status",
        tool_args_json: JSON.stringify(redactApprovalArgs(args)),
        dry_run_json: JSON.stringify(dryRun),
        approval_status: "Approved",
        approved_by: args.approved_by,
        approved_at: now,
        before_target_ids: JSON.stringify(summarizeMaterialTakeoff(before)),
      });

      try {
        const result = await erpPut(config, resourcePath("Material Takeoff", args.takeoff_id), patch);
        const after = { ...before, ...patch };
        await erpPut(config, resourcePath("Hermes Run", runId), {
          approval_status: "Executed",
          result_status: "OK",
          after_target_ids: JSON.stringify(summarizeMaterialTakeoff(after)),
          result_json: JSON.stringify(result),
        });
        return text({ run_id: runId, updated: true, material_takeoff_id: args.takeoff_id, result });
      } catch (err) {
        await erpPut(config, resourcePath("Hermes Run", runId), {
          approval_status: "Failed",
          result_status: "Error",
          error: String(err).slice(0, 500),
        }).catch(() => {});
        throw err;
      }
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
      await erpPost(config, "/api/resource/Hermes%20Run", {
        run_id: runId,
        run_ts: now,
        agent_role: "Estimator Assistant",
        requested_by: args.approved_by,
        request_text: args.request_text,
        target_doctype: "Proposal Evidence Pack",
        target_name: draft.pack_id,
        roof_job: args.roof_job_id,
        capability_level: "Approved-write",
        tool_name: "request_create_proposal_evidence_pack",
        tool_args_json: JSON.stringify(redactApprovalArgs(args)),
        dry_run_json: JSON.stringify(dryRun),
        approval_status: "Approved",
        approved_by: args.approved_by,
        approved_at: now,
        before_target_ids: JSON.stringify(summarizeProposalPack(before)),
      });

      try {
        const result = before
          ? await erpPut(config, resourcePath("Proposal Evidence Pack", draft.pack_id), draft)
          : await erpPost(config, "/api/resource/Proposal%20Evidence%20Pack", draft);
        const after = { ...(before ?? {}), ...draft, name: draft.pack_id };
        await erpPut(config, resourcePath("Hermes Run", runId), {
          approval_status: "Executed",
          result_status: "OK",
          after_target_ids: JSON.stringify(summarizeProposalPack(after)),
          result_json: JSON.stringify(result),
        });
        return text({
          run_id: runId,
          upserted: true,
          operation,
          proposal_evidence_pack_id: draft.pack_id,
          result,
        });
      } catch (err) {
        await erpPut(config, resourcePath("Hermes Run", runId), {
          approval_status: "Failed",
          result_status: "Error",
          error: String(err).slice(0, 500),
        }).catch(() => {});
        throw err;
      }
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
      await erpPost(config, "/api/resource/Hermes%20Run", {
        run_id: runId,
        run_ts: now,
        agent_role: "Production Controller",
        requested_by: args.approved_by,
        request_text: args.request_text,
        target_doctype: "Production Gate State",
        target_name: args.gate_id,
        lead_envelope: before.lead_envelope,
        roof_job: before.roof_job,
        linked_evidence: before.evidence_item,
        capability_level: "Approved-write",
        tool_name: "request_update_gate",
        tool_args_json: JSON.stringify(redactApprovalArgs(args)),
        dry_run_json: JSON.stringify(dryRun),
        approval_status: "Approved",
        approved_by: args.approved_by,
        approved_at: now,
        before_target_ids: JSON.stringify(summarizeGate(before)),
      });

      try {
        const result = await erpPut(config, resourcePath("Production Gate State", args.gate_id), patch);
        const after = { ...before, ...patch };
        await erpPut(config, resourcePath("Hermes Run", runId), {
          approval_status: "Executed",
          result_status: "OK",
          after_target_ids: JSON.stringify(summarizeGate(after)),
          result_json: JSON.stringify(result),
        });
        return text({ run_id: runId, updated: true, gate_id: args.gate_id, result });
      } catch (err) {
        await erpPut(config, resourcePath("Hermes Run", runId), {
          approval_status: "Failed",
          result_status: "Error",
          error: String(err).slice(0, 500),
        }).catch(() => {});
        throw err;
      }
    },
  );

  return server;
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
  if (!reportName) {
    const reports = await listResources(config, "Measurement Report", {
      fields: MEASUREMENT_REPORT_FIELDS,
      filters: [["Measurement Report", "roof_job", "=", roofJobId]],
      limit,
      orderBy: "parsed_at desc",
    });
    if (!reports.length) throw new Error("measurement_report_required");
    reportName = reports[0].measurement_id ?? reports[0].name;
  }
  const measurementReport = await readResource(config, "Measurement Report", reportName);
  const draft = buildMaterialTakeoffDraft({
    roofJobId,
    takeoffId,
    measurementReport,
    nowIso,
  });
  return { draft, measurementReport };
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
