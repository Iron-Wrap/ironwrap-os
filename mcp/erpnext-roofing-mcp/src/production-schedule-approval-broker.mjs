import {
  createPublicKey,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  approvedArgs,
  canonicalJson,
  digest,
  parseToolPayload,
  semanticPreview,
  signApprovalReceipt,
  verifyDryRunReceipt,
} from "./approval-contract.mjs";
import { configFromEnv } from "./server.mjs";
import {
  createNonceStore,
  hmacBase64Url,
  internalRequestSigningInput,
  internalResponseSigningInput,
  sha256Hex,
  verifyInternalRequest,
} from "./quote-revision-approval-broker.mjs";

export {
  createNonceStore,
  hmacBase64Url,
  internalRequestSigningInput,
  internalResponseSigningInput,
  sha256Hex,
  verifyInternalRequest,
};

const MAX_BODY_BYTES = 32 * 1024;
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_APPROVAL_LIFETIME_MS = 5 * 60_000;

export const PRODUCTION_SCHEDULE_PREVIEW_PATH = "/v1/production-schedule/preview";
export const PRODUCTION_SCHEDULE_EXECUTE_PATH = "/v1/production-schedule/execute";
export const PRODUCTION_SCHEDULE_WRITE_TOOL = "request_create_job_assignment";
export const PRODUCTION_SCHEDULE_DRY_RUN_TOOL = "dry_run_job_assignment";
export const PRODUCTION_SCHEDULE_CREW_ROSTER_TOOL = "get_crew_authority_roster";
const PRODUCTION_SCHEDULE_AGENT_ROLE = "production-controller";
const PRODUCTION_SCHEDULING_GATES = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"];
const SCHEDULABLE_GATE_STATES = ["Ready", "Done", "Waived"];

const FULL_PREVIEW_KEYS = [
  "would_write", "required_tool", "target", "append_only", "blocked_existing", "blocked_reason", "draft",
  "production_schedule_gate_preview",
];
const FULL_GATE_KEYS = [
  "required", "required_gates", "allowed_states", "gates", "missing_gates", "duplicate_gates",
  "state_ineligible_gates", "state_eligible", "snapshot_truncated", "authoritative_enforcement",
];
const SAFE_PREVIEW_KEYS = [
  "would_write", "append_only", "target", "assignment", "production_schedule_gate_preview",
];
const SAFE_ASSIGNMENT_KEYS = [
  "assignment_id", "roof_job_id", "crew_profile_id", "scheduled_start", "scheduled_end",
  "supersedes_assignment_id", "correction_reason",
];

/**
 * Sealed production-schedule authority. The Worker supplies only an approval
 * request; this process owns the role, actor, site, tools, signing key, and
 * append-only shape of every Job Assignment write.
 */
export function createProductionScheduleApprovalBroker({ config, invokeMcp, now = () => Date.now(), nonceStore }) {
  assertProductionScheduleBrokerRuntime(config);
  const nonces = nonceStore ?? createNonceStore({ now, ttlMs: config.maxClockSkewMs ?? MAX_CLOCK_SKEW_MS });
  const maxClockSkewMs = config.maxClockSkewMs ?? MAX_CLOCK_SKEW_MS;
  const maxBodyBytes = config.maxBodyBytes ?? MAX_BODY_BYTES;

  return {
    async handle(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || ![PRODUCTION_SCHEDULE_PREVIEW_PATH, PRODUCTION_SCHEDULE_EXECUTE_PATH].includes(path)) {
        return json({ error: "not_found" }, 404);
      }
      const inbound = await verifyInternalRequest(request, config, {
        now,
        nonceStore: nonces,
        maxClockSkewMs,
        maxBodyBytes,
      });
      if (!inbound.ok) return json({ error: inbound.error }, inbound.status);
      const respond = (status, body) => signedJson(status, body, config, inbound.binding, now);
      if (!inbound.body) return respond(400, { error: "invalid_json" });

      if (path === PRODUCTION_SCHEDULE_PREVIEW_PATH) {
        try {
          return respond(200, await previewProductionSchedule(inbound.body, config, invokeMcp, now));
        } catch (error) {
          return respond(422, { error: safeBrokerError(error, "broker_production_schedule_preview_rejected") });
        }
      }

      try {
        return respond(200, await executeProductionSchedule(inbound.body, config, invokeMcp, now));
      } catch (error) {
        return respond(200, {
          outcome: {
            state: "failed",
            hermes_run_id: null,
            result_json: null,
            error_code: safeBrokerError(error, "broker_production_schedule_contract_invalid"),
          },
        });
      }
    },
  };
}

export function productionScheduleApprovalBrokerConfigFromEnv(env = process.env) {
  const runtime = configFromEnv(env);
  const privateKeyPath = requiredText(
    env.HERMES_APPROVAL_PRIVATE_KEY_FILE,
    "HERMES_APPROVAL_PRIVATE_KEY_FILE",
  );
  const privateKey = readFileSync(privateKeyPath, "utf8");
  const tenantId = requiredText(
    env.PRODUCTION_SCHEDULE_BROKER_TENANT_ID,
    "PRODUCTION_SCHEDULE_BROKER_TENANT_ID",
  );
  const sharedSecret = requiredText(
    env.PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET,
    "PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET",
  );
  const keyId = requiredText(env.PRODUCTION_SCHEDULE_BROKER_KEY_ID, "PRODUCTION_SCHEDULE_BROKER_KEY_ID");
  if (sharedSecret.length < 32) throw new Error("production_schedule_broker_shared_secret_too_short");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error("production_schedule_broker_key_id_invalid");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(tenantId)) throw new Error("production_schedule_broker_tenant_invalid");
  if (!runtime.writeEnabled || runtime.agentRole !== PRODUCTION_SCHEDULE_AGENT_ROLE) {
    throw new Error("production_schedule_broker_requires_production_controller_write_runtime");
  }
  if (!runtime.allowedTools.includes(PRODUCTION_SCHEDULE_DRY_RUN_TOOL) ||
      !runtime.allowedTools.includes(PRODUCTION_SCHEDULE_WRITE_TOOL)) {
    throw new Error("production_schedule_broker_role_tools_missing");
  }
  const privatePublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const configuredPublic = createPublicKey(runtime.approvalPublicKey).export({ type: "spki", format: "der" });
  if (privatePublic.length !== configuredPublic.length || !timingSafeEqual(privatePublic, configuredPublic)) {
    throw new Error("production_schedule_broker_keypair_mismatch");
  }
  return {
    tenantId,
    keyId,
    sharedSecret,
    approvalPrivateKey: privateKey,
    dryRunSigningKey: runtime.dryRunSigningKey,
    approverId: runtime.approverId,
    actorUser: runtime.actorUser,
    agentRole: runtime.agentRole,
    siteId: digest({ frappe_base_url: runtime.baseUrl }),
    mcpEnv: productionScheduleMcpChildEnvironment(env, runtime),
    requestTimeoutMs: runtime.requestTimeoutMs,
    maxClockSkewMs: parseBoundedMs(
      env.PRODUCTION_SCHEDULE_BROKER_MAX_CLOCK_SKEW_MS,
      MAX_CLOCK_SKEW_MS,
      10_000,
      120_000,
    ),
    maxApprovalLifetimeMs: parseBoundedMs(
      env.PRODUCTION_SCHEDULE_BROKER_MAX_APPROVAL_LIFETIME_MS,
      MAX_APPROVAL_LIFETIME_MS,
      30_000,
      10 * 60_000,
    ),
  };
}

export function createStdioMcpInvoker(config) {
  const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
  return async (name, args) => {
    const client = new Client(
      { name: "ironwrap-production-schedule-approval-broker", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: config.mcpEnv,
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      return await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: config.requestTimeoutMs });
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  };
}

async function previewProductionSchedule(body, config, invokeMcp, now) {
  const parsed = parsePreviewInput(body, config);
  const input = {
    ...parsed,
    authorityRequirements: await loadCrewAuthorityRequirements(parsed, config, invokeMcp),
  };
  const current = await loadProductionSchedulePreview(input, config, invokeMcp, now);
  const writeArgs = writeArgsFromInput(input, config);
  const writeArgsJson = canonicalJson(writeArgs);
  const argsDigest = digest(approvedArgs(writeArgs));
  const previewJson = canonicalJson(current.preview);
  const intentFingerprint = digest({
    request_kind: "production_schedule",
    tenant_id: input.tenantId,
    requested_by_user_id: input.requestedByUserId,
    requested_by_frappe_user: input.requestedByFrappeUser,
    write_tool: PRODUCTION_SCHEDULE_WRITE_TOOL,
    dry_run_tool: PRODUCTION_SCHEDULE_DRY_RUN_TOOL,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    target: { doctype: "Job Assignment", name: current.targetName },
    assignment: {
      roof_job_id: input.roofJobId,
      crew_profile_id: input.crewProfileId,
      scheduled_start: input.scheduledStart,
      scheduled_end: input.scheduledEnd,
      supersedes_assignment_id: input.supersedesAssignmentId,
      correction_reason: input.correctionReason,
    },
    approved_intent: {
      ...writeArgs,
      approved_by: config.approverId,
    },
    args_digest: argsDigest,
    preview_digest: current.previewDigest,
    receipt_preview_digest: current.receiptPreviewDigest,
  });
  return {
    approval_request_id: input.approvalRequestId,
    tenant_id: input.tenantId,
    packet: {
      request_kind: "production_schedule",
      write_tool: PRODUCTION_SCHEDULE_WRITE_TOOL,
      dry_run_tool: PRODUCTION_SCHEDULE_DRY_RUN_TOOL,
      agent_role: config.agentRole,
      actor_user: config.actorUser,
      site_id: config.siteId,
      target: { doctype: "Job Assignment", name: current.targetName },
      roof_job_id: input.roofJobId,
      crew_profile_id: input.crewProfileId,
      scheduled_start: input.scheduledStart,
      scheduled_end: input.scheduledEnd,
      supersedes_assignment_id: input.supersedesAssignmentId,
      correction_reason: input.correctionReason,
      request_text: input.requestText,
      write_args_json: writeArgsJson,
      preview_json: previewJson,
      args_digest: argsDigest,
      preview_digest: current.previewDigest,
      receipt_preview_digest: current.receiptPreviewDigest,
      dry_run_receipt: current.dryRunReceipt,
      expires_at: current.expiresAt,
      run_id: input.runId,
      intent_fingerprint: intentFingerprint,
    },
  };
}

async function executeProductionSchedule(body, config, invokeMcp, now) {
  const record = await parseExecutionInput(body, config, now, invokeMcp);
  // A fresh dry run is the source, append-only target, and current-gate fence.
  // The protected stored receipt still binds the actual write.
  let current;
  try {
    current = await loadProductionSchedulePreview(record, config, invokeMcp, now);
  } catch {
    throw new Error("broker_production_schedule_source_stale");
  }
  if (current.previewDigest !== record.previewDigest ||
      current.receiptPreviewDigest !== record.receiptPreviewDigest ||
      current.targetName !== record.targetName) {
    throw new Error("broker_production_schedule_source_stale");
  }

  const approvalReceipt = signApprovalReceipt(config.approvalPrivateKey, {
    write_tool: PRODUCTION_SCHEDULE_WRITE_TOOL,
    dry_run_receipt: record.dryRunReceipt,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    run_id: record.runId,
    approved_by: config.approverId,
    args_digest: record.argsDigest,
    issued_at: new Date(now()).toISOString(),
    expires_at: boundedApprovalExpiry(
      record.expiresAt,
      now,
      config.maxApprovalLifetimeMs ?? MAX_APPROVAL_LIFETIME_MS,
    ),
  });

  try {
    const result = await invokeMcp(PRODUCTION_SCHEDULE_WRITE_TOOL, {
      ...record.writeArgs,
      dry_run_receipt: record.dryRunReceipt,
      approval_receipt: approvalReceipt,
    });
    const safeResult = safeExecutedResult(parseToolPayload(result), record);
    return {
      outcome: {
        state: "executed",
        hermes_run_id: record.runId,
        result_json: canonicalJson(safeResult),
        error_code: null,
      },
    };
  } catch (error) {
    const message = String(error).toLowerCase();
    if (message.includes("audit_failed") || message.includes("audit_finalization")) {
      return {
        outcome: {
          state: "audit_failed",
          hermes_run_id: record.runId,
          result_json: null,
          error_code: "audit_finalization_failed",
        },
      };
    }
    // Hermes Run is the durable idempotency fence. Once a write starts, return
    // uncertainty instead of risking a second physical assignment creation.
    return {
      outcome: {
        state: "execution_uncertain",
        hermes_run_id: record.runId,
        result_json: null,
        error_code: "broker_mcp_call_ambiguous",
      },
    };
  }
}

async function loadProductionSchedulePreview(input, config, invokeMcp, now) {
  const baseArgs = dryRunArgsFromInput(input, config);
  const payload = parseToolPayload(await invokeMcp(PRODUCTION_SCHEDULE_DRY_RUN_TOOL, baseArgs));
  const approval = requiredObject(payload.approval_request, "broker_production_schedule_dry_run_receipt_missing");
  const fullPreview = { ...payload };
  delete fullPreview.approval_request;
  const { safePreview, targetName } = assertProductionScheduleDryRunPreview(fullPreview, input, config);
  const dryRunReceipt = requiredText(approval.dry_run_receipt, "broker_production_schedule_dry_run_receipt_missing");
  const expiresAt = requiredFutureIso(approval.expires_at, now, "broker_production_schedule_dry_run_expired");
  const receiptPreviewDigest = digest(semanticPreview(fullPreview));
  const previewDigest = digest(semanticPreview(safePreview));
  assertOnlyKeys(approval, [
    "write_tool", "dry_run_tool", "agent_role", "actor_user", "site_id", "args_digest", "preview_digest",
    "dry_run_receipt", "expires_at", "note",
  ]);
  assertExact(approval.write_tool, PRODUCTION_SCHEDULE_WRITE_TOOL, "broker_production_schedule_dry_run_tool_mismatch");
  assertExact(approval.dry_run_tool, PRODUCTION_SCHEDULE_DRY_RUN_TOOL, "broker_production_schedule_dry_run_tool_mismatch");
  assertExact(approval.agent_role, config.agentRole, "broker_production_schedule_dry_run_role_mismatch");
  assertExact(approval.actor_user, config.actorUser, "broker_production_schedule_dry_run_actor_mismatch");
  assertExact(approval.site_id, config.siteId, "broker_production_schedule_dry_run_site_mismatch");
  assertExact(approval.args_digest, digest(baseArgs), "broker_production_schedule_dry_run_args_digest_mismatch");
  assertExact(
    approval.preview_digest,
    receiptPreviewDigest,
    "broker_production_schedule_dry_run_preview_digest_mismatch",
  );
  verifyDryRunReceipt(config.dryRunSigningKey, dryRunReceipt, {
    dry_run_tool: PRODUCTION_SCHEDULE_DRY_RUN_TOOL,
    write_tool: PRODUCTION_SCHEDULE_WRITE_TOOL,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    args_digest: digest(baseArgs),
    preview_digest: receiptPreviewDigest,
  });
  return { targetName, preview: safePreview, previewDigest, receiptPreviewDigest, dryRunReceipt, expiresAt };
}

function parsePreviewInput(body, config) {
  assertOnlyKeys(body, [
    "approval_request_id", "tenant_id", "run_id", "roof_job_id", "crew_profile_id", "scheduled_start",
    "scheduled_end", "supersedes_assignment_id", "correction_reason", "request_text", "requested_by_user_id",
    "requested_by_frappe_user",
  ]);
  const tenantId = idText(body.tenant_id, "broker_production_schedule_tenant_invalid");
  assertExact(tenantId, config.tenantId, "broker_production_schedule_tenant_mismatch");
  return parseAssignmentInput(body, "broker_production_schedule", {
    approvalRequestId: idText(body.approval_request_id, "broker_production_schedule_approval_request_id_invalid"),
    tenantId,
    runId: boundedText(body.run_id, 8, 128, "broker_production_schedule_run_id_invalid"),
    requestedByUserId: idText(body.requested_by_user_id, "broker_production_schedule_requested_by_invalid"),
    requestedByFrappeUser: boundedText(
      body.requested_by_frappe_user,
      3,
      140,
      "broker_production_schedule_requested_frappe_user_invalid",
    ),
  });
}

async function parseExecutionInput(body, config, now, invokeMcp) {
  assertOnlyKeys(body, ["approval_request"]);
  const record = requiredObject(body.approval_request, "broker_production_schedule_execution_record_invalid");
  assertOnlyKeys(record, [
    "approval_request_id", "tenant_id", "request_kind", "write_tool", "dry_run_tool", "agent_role",
    "actor_user", "site_id", "target_doctype", "target_name", "roof_job_id", "crew_profile_id",
    "scheduled_start", "scheduled_end", "supersedes_assignment_id", "correction_reason", "request_text",
    "write_args_json", "preview_json", "args_digest", "preview_digest", "receipt_preview_digest",
    "dry_run_receipt", "expires_at", "run_id", "approved_by_frappe_user", "decision_idempotency_key",
  ]);
  assertExact(record.tenant_id, config.tenantId, "broker_production_schedule_execution_tenant_mismatch");
  assertExact(record.request_kind, "production_schedule", "broker_production_schedule_execution_kind_mismatch");
  assertExact(record.write_tool, PRODUCTION_SCHEDULE_WRITE_TOOL, "broker_production_schedule_execution_tool_mismatch");
  assertExact(record.dry_run_tool, PRODUCTION_SCHEDULE_DRY_RUN_TOOL, "broker_production_schedule_execution_tool_mismatch");
  assertExact(record.agent_role, config.agentRole, "broker_production_schedule_execution_role_mismatch");
  assertExact(record.actor_user, config.actorUser, "broker_production_schedule_execution_actor_mismatch");
  assertExact(record.site_id, config.siteId, "broker_production_schedule_execution_site_mismatch");
  assertExact(record.target_doctype, "Job Assignment", "broker_production_schedule_execution_target_mismatch");
  const parsed = parseAssignmentInput(record, "broker_production_schedule_execution", {
    approvalRequestId: idText(
      record.approval_request_id,
      "broker_production_schedule_execution_request_id_invalid",
    ),
    tenantId: config.tenantId,
    runId: boundedText(record.run_id, 8, 128, "broker_production_schedule_execution_run_id_invalid"),
    requestedByUserId: "approved",
    requestedByFrappeUser: "approved",
  });
  // Compiled from the roster as it is NOW, not as the approval remembers it. The
  // byte-for-byte comparison below is what turns a roster change since approval into
  // a refusal.
  const input = {
    ...parsed,
    authorityRequirements: await loadCrewAuthorityRequirements(parsed, config, invokeMcp),
  };
  const targetName = idText(record.target_name, "broker_production_schedule_execution_target_name_invalid");
  const expiresAt = requiredFutureIso(record.expires_at, now, "broker_production_schedule_execution_expired");
  assertExact(
    record.approved_by_frappe_user,
    config.approverId,
    "broker_production_schedule_execution_approver_mismatch",
  );
  boundedText(record.decision_idempotency_key, 8, 140, "broker_production_schedule_execution_decision_invalid");
  const argsDigest = hexDigest(record.args_digest, "broker_production_schedule_execution_args_digest_invalid");
  const previewDigest = hexDigest(record.preview_digest, "broker_production_schedule_execution_preview_digest_invalid");
  const receiptPreviewDigest = hexDigest(
    record.receipt_preview_digest,
    "broker_production_schedule_execution_receipt_preview_digest_invalid",
  );
  if (receiptPreviewDigest === previewDigest) throw new Error("broker_production_schedule_execution_receipt_digest_invalid");
  const dryRunReceipt = boundedText(
    record.dry_run_receipt,
    32,
    8192,
    "broker_production_schedule_execution_dry_run_receipt_invalid",
  );
  const writeArgs = parseCanonicalObject(record.write_args_json, "broker_production_schedule_execution_args_invalid");
  const preview = parseCanonicalObject(record.preview_json, "broker_production_schedule_execution_preview_invalid");
  if (Object.hasOwn(preview, "approval_request")) {
    throw new Error("broker_production_schedule_execution_preview_capability_present");
  }
  const invariants = assertSafeProductionSchedulePreview(preview, input, targetName);
  const expectedWriteArgs = writeArgsFromInput(input, config);
  if (canonicalJson(writeArgs) !== canonicalJson(expectedWriteArgs)) {
    throw new Error("broker_production_schedule_execution_args_mismatch");
  }
  assertExact(
    argsDigest,
    digest(approvedArgs(expectedWriteArgs)),
    "broker_production_schedule_execution_args_digest_mismatch",
  );
  assertExact(
    previewDigest,
    digest(semanticPreview(preview)),
    "broker_production_schedule_execution_preview_digest_mismatch",
  );
  verifyDryRunReceipt(config.dryRunSigningKey, dryRunReceipt, {
    dry_run_tool: PRODUCTION_SCHEDULE_DRY_RUN_TOOL,
    write_tool: PRODUCTION_SCHEDULE_WRITE_TOOL,
    agent_role: config.agentRole,
    actor_user: config.actorUser,
    site_id: config.siteId,
    args_digest: digest(dryRunArgsFromInput(input, config)),
    preview_digest: receiptPreviewDigest,
  });
  return {
    ...input,
    targetName: invariants.targetName,
    expiresAt,
    argsDigest,
    previewDigest,
    receiptPreviewDigest,
    dryRunReceipt,
    writeArgs: expectedWriteArgs,
  };
}

function parseAssignmentInput(value, namespace, identity) {
  const roofJobId = idText(value.roof_job_id, `${namespace}_roof_job_id_invalid`);
  const crewProfileId = idText(value.crew_profile_id, `${namespace}_crew_profile_id_invalid`);
  const scheduledStart = requiredIso(value.scheduled_start, `${namespace}_scheduled_start_invalid`);
  const scheduledEnd = nullableIso(value.scheduled_end, `${namespace}_scheduled_end_invalid`);
  const supersedesAssignmentId = nullableId(
    value.supersedes_assignment_id,
    `${namespace}_supersedes_assignment_id_invalid`,
  );
  const correctionReason = nullableText(value.correction_reason, 1, 2000, `${namespace}_correction_reason_invalid`);
  const requestText = boundedText(value.request_text, 1, 4000, `${namespace}_request_text_invalid`);
  if (scheduledEnd && Date.parse(scheduledEnd) <= Date.parse(scheduledStart)) {
    throw new Error(`${namespace}_scheduled_end_invalid`);
  }
  if ((supersedesAssignmentId === null) !== (correctionReason === null)) {
    throw new Error(`${namespace}_correction_pair_required`);
  }
  return {
    ...identity,
    roofJobId,
    crewProfileId,
    scheduledStart,
    scheduledEnd,
    supersedesAssignmentId,
    correctionReason,
    requestText,
  };
}

/**
 * Compile the exact authority requirements this Job Assignment declares (IRO-43 x
 * IRO-50, ruled on ELEC-124).
 *
 * Nothing here decides a new authority rule.  `domain_policy._require_canonical_
 * authorities` has always demanded that a Production assignment with a crew name
 * which Authority Records must resolve as current, and the crew roster is already
 * trusted input at this exact point - it is the same Crew Profile the dry run reads
 * to refuse a non-Active crew.  What was missing was anyone to state the demand in
 * the individually-versioned form IRO-43 introduced, so the schedule rail refused
 * every Won job with `missing_authority_requirements`.  This states it.
 *
 * One row per ACTIVE member, `Worker Competency`, scoped to the ROOF JOB rather
 * than the assignment: a competency record is a fact about a worker on a job, so
 * one record covers every assignment and work package on it - the shape Work
 * Package's own call site (`domain_policy.py:2597`) needs too.  Assignment scope
 * would force re-issuing the same competency per assignment, which is not what a
 * versioned worker competency is for.
 *
 * Deliberately NOT compiled: WCB Clearance, Trade Licence, Permit, Inspection.
 * Those are already enforced independently by `_require_current_compliance_
 * authority` off Job Compliance Records, and there is no data on the crew to
 * resolve an Organization-subject requirement from anyway - inventing a
 * `subject_ref` for them would be guessing.
 *
 * Deterministic in roster order and stable under duplicates: the same roster always
 * compiles to the same bytes, which is what lets the preview/execute digest guard
 * below treat any change as roster drift rather than noise.
 */
export function compileCrewAuthorityRequirements(roster, roofJobId) {
  const members = Array.isArray(roster?.members) ? roster.members : [];
  const seen = new Set();
  const requirements = [];
  for (const member of members) {
    if (!isRecord(member)) continue;
    // Frappe Check fields arrive as 1/0, but a JSON caller may send true/false.
    const active = member.active === 1 || member.active === true;
    if (!active) continue;
    const subjectRef = typeof member.crew_user === "string" ? member.crew_user.trim() : "";
    if (!subjectRef || seen.has(subjectRef)) continue;
    seen.add(subjectRef);
    requirements.push({
      subject_type: "Person",
      subject_role: "Worker",
      subject_ref: subjectRef,
      authority_kind: "Worker Competency",
      scope_type: "Roof Job",
      scope_ref: roofJobId,
    });
  }
  return requirements;
}

/**
 * Read the roster and compile it, once per preview and once again per execute.
 *
 * The second read is the point.  `writeArgsFromInput` is recomputed at execution and
 * compared byte-for-byte against what the approver approved, so a roster that
 * changed in between - a member deactivated, a new installer added - compiles to a
 * different list and the write refuses with
 * `broker_production_schedule_execution_args_mismatch`.  That guard already existed;
 * putting the compiled list inside the args is what brings roster drift under it,
 * with no second mechanism to keep in step.
 */
async function loadCrewAuthorityRequirements(input, config, invokeMcp) {
  let payload;
  try {
    payload = parseToolPayload(await invokeMcp(PRODUCTION_SCHEDULE_CREW_ROSTER_TOOL, {
      crew_profile_id: input.crewProfileId,
    }));
  } catch {
    throw new Error("broker_production_schedule_crew_roster_unavailable");
  }
  const roster = requiredObject(payload?.data, "broker_production_schedule_crew_roster_invalid");
  if (!Array.isArray(roster.members)) {
    throw new Error("broker_production_schedule_crew_roster_invalid");
  }
  // An empty active roster is NOT refused here. It compiles to no requirements, the
  // field is omitted, and Frappe answers `missing_authority_requirements` from
  // `_requirement_rows` - the authority for that refusal belongs to the domain
  // policy, not to this broker, and duplicating it here would give the same fact two
  // owners that could drift apart.
  return compileCrewAuthorityRequirements(roster, input.roofJobId);
}

function dryRunArgsFromInput(input, config) {
  return {
    roof_job_id: input.roofJobId,
    assignment_type: "Production",
    status: "Assigned",
    crew_profile_id: input.crewProfileId,
    scheduled_start: input.scheduledStart,
    assigned_by: config.actorUser,
    notes: "",
    ...(input.scheduledEnd ? { scheduled_end: input.scheduledEnd } : {}),
    ...(input.authorityRequirements?.length
      ? { authority_requirements: input.authorityRequirements }
      : {}),
    ...(input.supersedesAssignmentId
      ? { supersedes: input.supersedesAssignmentId, correction_reason: input.correctionReason }
      : {}),
  };
}

function writeArgsFromInput(input, config) {
  return {
    ...dryRunArgsFromInput(input, config),
    request_text: input.requestText,
    approved_by: config.approverId,
    run_id: input.runId,
  };
}

function assertProductionScheduleDryRunPreview(preview, input, config) {
  assertOnlyKeys(preview, FULL_PREVIEW_KEYS);
  assertExact(preview.would_write, false, "broker_production_schedule_preview_write_flag_invalid");
  assertExact(preview.required_tool, PRODUCTION_SCHEDULE_WRITE_TOOL, "broker_production_schedule_preview_tool_mismatch");
  assertExact(preview.append_only, true, "broker_production_schedule_preview_append_only_required");
  assertExact(preview.blocked_existing, false, "broker_production_schedule_preview_target_not_append_only");
  if (Object.hasOwn(preview, "blocked_reason")) {
    throw new Error("broker_production_schedule_preview_target_not_append_only");
  }
  const target = requiredObject(preview.target, "broker_production_schedule_preview_target_invalid");
  assertKeysExactly(target, ["doctype", "name"], "broker_production_schedule_preview_target_invalid");
  assertExact(target.doctype, "Job Assignment", "broker_production_schedule_preview_target_mismatch");
  const targetName = idText(target.name, "broker_production_schedule_preview_target_name_invalid");
  assertFullDraft(preview.draft, input, config, targetName);
  assertEligibleFullGatePreview(preview.production_schedule_gate_preview);
  return {
    targetName,
    safePreview: safePreview(input, targetName),
  };
}

function assertFullDraft(value, input, config, targetName) {
  const draft = requiredObject(value, "broker_production_schedule_preview_draft_invalid");
  assertKeysExactly(draft, [
    "assignment_id", "roof_job", "assignment_type", "status", "crew_profile", "scheduled_start", "assigned_by",
    "assigned_at", "notes",
    ...(input.scheduledEnd ? ["scheduled_end"] : []),
    // Present exactly when the compiler produced rows. An empty active roster omits
    // it here and is refused by Frappe's `missing_authority_requirements` at the
    // write, which is where that authority lives.
    ...(input.authorityRequirements?.length ? ["authority_requirements_json"] : []),
    ...(input.supersedesAssignmentId ? ["supersedes", "correction_reason"] : []),
  ], "broker_production_schedule_preview_draft_invalid");
  assertExact(draft.assignment_id, targetName, "broker_production_schedule_preview_target_mismatch");
  assertExact(draft.roof_job, input.roofJobId, "broker_production_schedule_preview_draft_roof_job_mismatch");
  assertExact(draft.assignment_type, "Production", "broker_production_schedule_preview_draft_type_invalid");
  assertExact(draft.status, "Assigned", "broker_production_schedule_preview_draft_status_invalid");
  assertExact(draft.crew_profile, input.crewProfileId, "broker_production_schedule_preview_draft_crew_mismatch");
  assertExact(draft.scheduled_start, input.scheduledStart, "broker_production_schedule_preview_draft_start_mismatch");
  assertExact(draft.assigned_by, config.actorUser, "broker_production_schedule_preview_draft_actor_mismatch");
  assertExact(draft.notes, "", "broker_production_schedule_preview_draft_notes_invalid");
  requiredIso(draft.assigned_at, "broker_production_schedule_preview_draft_assigned_at_invalid");
  if (input.authorityRequirements?.length) {
    // The server serialises the array it was handed; asserting the exact string is
    // how the broker proves the draft it is about to have approved declares the
    // authority IT compiled, not one the tool substituted.
    assertExact(
      draft.authority_requirements_json,
      JSON.stringify(input.authorityRequirements),
      "broker_production_schedule_preview_draft_authority_mismatch",
    );
  }
  if (input.scheduledEnd) {
    assertExact(draft.scheduled_end, input.scheduledEnd, "broker_production_schedule_preview_draft_end_mismatch");
  }
  if (input.supersedesAssignmentId) {
    assertExact(draft.supersedes, input.supersedesAssignmentId, "broker_production_schedule_preview_draft_supersedes_mismatch");
    assertExact(
      draft.correction_reason,
      input.correctionReason,
      "broker_production_schedule_preview_draft_correction_reason_mismatch",
    );
  }
}

function assertEligibleFullGatePreview(value) {
  const gate = requiredObject(value, "broker_production_schedule_gate_invalid");
  assertKeysExactly(gate, FULL_GATE_KEYS, "broker_production_schedule_gate_invalid");
  assertExact(gate.required, true, "broker_production_schedule_gate_required");
  assertExact(gate.state_eligible, true, "broker_production_schedule_gate_ineligible");
  assertExact(gate.snapshot_truncated, false, "broker_production_schedule_gate_ineligible");
  assertExact(
    gate.authoritative_enforcement,
    "frappe_document_policy",
    "broker_production_schedule_gate_authority_invalid",
  );
  assertExactStringArray(gate.required_gates, PRODUCTION_SCHEDULING_GATES, "broker_production_schedule_gate_invalid");
  assertExactStringArray(gate.allowed_states, SCHEDULABLE_GATE_STATES, "broker_production_schedule_gate_invalid");
  assertExactStringArray(gate.missing_gates, [], "broker_production_schedule_gate_ineligible");
  assertExactStringArray(gate.duplicate_gates, [], "broker_production_schedule_gate_ineligible");
  assertGateRows(gate.gates, PRODUCTION_SCHEDULING_GATES, "broker_production_schedule_gate_ineligible");
  assertExactArray(gate.state_ineligible_gates, [], "broker_production_schedule_gate_ineligible");
}

function assertSafeProductionSchedulePreview(preview, input, targetName) {
  assertKeysExactly(preview, SAFE_PREVIEW_KEYS, "broker_production_schedule_safe_preview_invalid");
  assertExact(preview.would_write, false, "broker_production_schedule_safe_preview_write_flag_invalid");
  assertExact(preview.append_only, true, "broker_production_schedule_safe_preview_append_only_required");
  const target = requiredObject(preview.target, "broker_production_schedule_safe_preview_target_invalid");
  assertKeysExactly(target, ["doctype", "name"], "broker_production_schedule_safe_preview_target_invalid");
  assertExact(target.doctype, "Job Assignment", "broker_production_schedule_safe_preview_target_mismatch");
  assertExact(target.name, targetName, "broker_production_schedule_safe_preview_target_mismatch");
  const assignment = requiredObject(preview.assignment, "broker_production_schedule_safe_preview_assignment_invalid");
  assertKeysExactly(assignment, SAFE_ASSIGNMENT_KEYS, "broker_production_schedule_safe_preview_assignment_invalid");
  assertExact(assignment.assignment_id, targetName, "broker_production_schedule_safe_preview_assignment_mismatch");
  assertExact(assignment.roof_job_id, input.roofJobId, "broker_production_schedule_safe_preview_assignment_mismatch");
  assertExact(assignment.crew_profile_id, input.crewProfileId, "broker_production_schedule_safe_preview_assignment_mismatch");
  assertExact(assignment.scheduled_start, input.scheduledStart, "broker_production_schedule_safe_preview_assignment_mismatch");
  assertExact(assignment.scheduled_end, input.scheduledEnd, "broker_production_schedule_safe_preview_assignment_mismatch");
  assertExact(
    assignment.supersedes_assignment_id,
    input.supersedesAssignmentId,
    "broker_production_schedule_safe_preview_assignment_mismatch",
  );
  assertExact(
    assignment.correction_reason,
    input.correctionReason,
    "broker_production_schedule_safe_preview_assignment_mismatch",
  );
  const gate = requiredObject(
    preview.production_schedule_gate_preview,
    "broker_production_schedule_safe_preview_gate_invalid",
  );
  assertKeysExactly(gate, ["required", "state_eligible"], "broker_production_schedule_safe_preview_gate_invalid");
  assertExact(gate.required, true, "broker_production_schedule_safe_preview_gate_invalid");
  assertExact(gate.state_eligible, true, "broker_production_schedule_safe_preview_gate_invalid");
  return { targetName };
}

function safePreview(input, targetName) {
  return {
    would_write: false,
    append_only: true,
    target: { doctype: "Job Assignment", name: targetName },
    assignment: {
      assignment_id: targetName,
      roof_job_id: input.roofJobId,
      crew_profile_id: input.crewProfileId,
      scheduled_start: input.scheduledStart,
      scheduled_end: input.scheduledEnd,
      supersedes_assignment_id: input.supersedesAssignmentId,
      correction_reason: input.correctionReason,
    },
    production_schedule_gate_preview: { required: true, state_eligible: true },
  };
}

function safeExecutedResult(payload, record) {
  if (!isRecord(payload) || payload.created !== true || payload.audit_finalized !== true ||
      typeof payload.replayed !== "boolean") {
    throw new Error("broker_production_schedule_execution_result_invalid");
  }
  assertExact(payload.run_id, record.runId, "broker_production_schedule_execution_run_mismatch");
  assertExact(payload.assignment_id, record.targetName, "broker_production_schedule_execution_assignment_mismatch");
  return {
    run_id: record.runId,
    assignment_id: record.targetName,
    roof_job_id: record.roofJobId,
    crew_profile_id: record.crewProfileId,
    scheduled_start: record.scheduledStart,
    scheduled_end: record.scheduledEnd,
    supersedes_assignment_id: record.supersedesAssignmentId,
    created: true,
    audit_finalized: true,
    replayed: payload.replayed,
    append_only: true,
    assigned_user_mutated: false,
    crew_notified: false,
    customer_notified: false,
    accounting_mutated: false,
  };
}

function signedJson(status, body, config, binding, now) {
  const responseText = JSON.stringify(body);
  const responseTimestamp = String(now());
  const signature = hmacBase64Url(config.sharedSecret, internalResponseSigningInput({
    keyId: binding.keyId,
    status,
    path: binding.path,
    requestTimestamp: binding.timestamp,
    nonce: binding.nonce,
    requestBodyHash: binding.bodyHash,
    responseTimestamp,
    responseBodyHash: sha256Hex(responseText),
  }));
  return new Response(responseText, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-ironwrap-internal-version": "1",
      "x-ironwrap-internal-key-id": binding.keyId,
      "x-ironwrap-internal-timestamp": responseTimestamp,
      "x-ironwrap-internal-request-timestamp": binding.timestamp,
      "x-ironwrap-internal-nonce": binding.nonce,
      "x-ironwrap-internal-signature": signature,
    },
  });
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function assertProductionScheduleBrokerRuntime(config) {
  if (!config || config.agentRole !== PRODUCTION_SCHEDULE_AGENT_ROLE) {
    throw new Error("production_schedule_broker_requires_production_controller_write_runtime");
  }
  if (!config.approvalPrivateKey || !config.dryRunSigningKey || !config.approverId || !config.actorUser || !config.siteId) {
    throw new Error("production_schedule_broker_config_incomplete");
  }
}

function productionScheduleMcpChildEnvironment(env, runtime) {
  const allow = [
    "ERPNEXT_BASE_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET", "ERPNEXT_REQUEST_TIMEOUT_MS",
    "ERPNEXT_ALLOW_INSECURE_LOCAL",
    "HERMES_ROLE_POLICY_PATH", "HERMES_DRY_RUN_SIGNING_KEY", "HERMES_APPROVAL_PUBLIC_KEY_FILE",
    "HERMES_APPROVAL_PUBLIC_KEY",
  ];
  const child = {};
  for (const key of allow) if (typeof env[key] === "string" && env[key]) child[key] = env[key];
  child.ERPNEXT_WRITE_ENABLED = "true";
  child.HERMES_AGENT_ROLE = PRODUCTION_SCHEDULE_AGENT_ROLE;
  child.HERMES_ACTOR_USER = runtime.actorUser;
  child.HERMES_APPROVER_ID = runtime.approverId;
  child.PATH = process.env.PATH ?? "/usr/bin:/bin";
  return child;
}

function boundedApprovalExpiry(expiresAt, now, maxLifetimeMs) {
  const expiresMs = Date.parse(expiresAt);
  const current = now();
  if (!Number.isFinite(expiresMs) || expiresMs <= current) {
    throw new Error("broker_production_schedule_execution_expired");
  }
  return new Date(Math.min(expiresMs, current + maxLifetimeMs)).toISOString();
}

function parseCanonicalObject(value, errorCode) {
  if (typeof value !== "string" || value.length < 2 || value.length > 16_000) throw new Error(errorCode);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(errorCode);
  }
  if (!isRecord(parsed) || canonicalJson(parsed) !== value) throw new Error(errorCode);
  return parsed;
}

function requiredFutureIso(value, now, errorCode) {
  if (typeof value !== "string") throw new Error(errorCode);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= now()) throw new Error(errorCode);
  return new Date(parsed).toISOString();
}

function requiredIso(value, errorCode) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(errorCode);
  return new Date(value).toISOString();
}

function nullableIso(value, errorCode) {
  return value === null ? null : requiredIso(value, errorCode);
}

function nullableId(value, errorCode) {
  return value === null ? null : idText(value, errorCode);
}

function nullableText(value, min, max, errorCode) {
  return value === null ? null : boundedText(value, min, max, errorCode);
}

function parseBoundedMs(raw, fallback, min, max) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error("production_schedule_broker_timeout_invalid");
  }
  return value;
}

function requiredText(value, errorCode) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${errorCode}_required`);
  return value.trim();
}

function hexDigest(value, errorCode) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(errorCode);
  return value;
}

function idText(value, errorCode) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,140}$/.test(value)) throw new Error(errorCode);
  return value;
}

function boundedText(value, min, max, errorCode) {
  if (typeof value !== "string") throw new Error(errorCode);
  const text = value.trim();
  if (text.length < min || text.length > max) throw new Error(errorCode);
  return text;
}

function assertOnlyKeys(value, allowed) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("broker_production_schedule_unexpected_field");
  }
}

function assertKeysExactly(value, expected, errorCode) {
  if (!isRecord(value) || Object.keys(value).length !== expected.length ||
      expected.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(errorCode);
  }
}

function assertExactStringArray(value, expected, errorCode) {
  if (!Array.isArray(value) || value.length !== expected.length ||
      value.some((entry, index) => entry !== expected[index])) {
    throw new Error(errorCode);
  }
}

function assertExactArray(value, expected, errorCode) {
  if (!Array.isArray(value) || value.length !== expected.length) throw new Error(errorCode);
}

function assertGateRows(value, gates, errorCode) {
  if (!Array.isArray(value) || value.length !== gates.length) throw new Error(errorCode);
  for (const [index, row] of value.entries()) {
    assertKeysExactly(row, ["gate", "state"], errorCode);
    if (row.gate !== gates[index] || !SCHEDULABLE_GATE_STATES.includes(row.state)) throw new Error(errorCode);
  }
}

function requiredObject(value, errorCode) {
  if (!isRecord(value)) throw new Error(errorCode);
  return value;
}

function assertExact(value, expected, errorCode) {
  if (value !== expected) throw new Error(errorCode);
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeBrokerError(error, fallback) {
  const message = String(error?.message ?? error).toLowerCase();
  const match = message.match(/\b(broker_[a-z0-9_:-]{2,119})\b/);
  return match?.[1] ?? fallback;
}

async function runHttpProductionScheduleBroker() {
  const config = productionScheduleApprovalBrokerConfigFromEnv();
  const broker = createProductionScheduleApprovalBroker({ config, invokeMcp: createStdioMcpInvoker(config) });
  const host = process.env.PRODUCTION_SCHEDULE_BROKER_LISTEN_HOST ?? "127.0.0.1";
  const port = Number(process.env.PRODUCTION_SCHEDULE_BROKER_PORT ?? "8790");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("production_schedule_broker_port_invalid");
  }
  const server = createServer(async (request, response) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "payload_too_large" }));
        return;
      }
      chunks.push(chunk);
    }
    // undici rejects a body on GET/HEAD; a stray probe must never crash the broker.
    const method = request.method ?? "GET";
    const inbound = new Request(`http://${host}:${port}${request.url ?? "/"}`, {
      method,
      headers: request.headers,
      body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks).toString("utf8"),
    });
    try {
      const outbound = await broker.handle(inbound);
      response.writeHead(outbound.status, Object.fromEntries(outbound.headers));
      response.end(await outbound.text());
    } catch {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "broker_internal_error" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) await runHttpProductionScheduleBroker();
