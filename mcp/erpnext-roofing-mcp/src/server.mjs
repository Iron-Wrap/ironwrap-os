#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const GateStateSchema = z.enum(["Blocked", "Ready", "Waived", "Done"]);

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
