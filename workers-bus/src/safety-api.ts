import { personCookieSession, validAppCsrf } from "./app-auth.ts";
import { sessionIsRecentForApproval } from "./approval-broker-client.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import { assertCurrentEvidenceReader, evidenceFilesForDetail, evidenceReceiptsRequired, EvidenceUploadError, evidenceUploadFailure, isDisposedDomainLinkRefusal, linkedEvidenceFilesForRefs, resolveEvidenceUploads } from "./evidence-uploads.ts";
import {
  parseSafetyActionRequest,
  processSafetyDeviceAction,
  safetyActionDependencies,
} from "./safety-actions.ts";
import {
  assignCorrectiveAction,
  closeCorrectiveAction,
  evaluateSafetyReadiness,
  safetyCorrectiveActionProjection,
  getSafetyEquipment,
  addToSafetyStop,
  issueSafetyEquipment,
  keepSafetyStop,
  rescopeSafetyStop,
  listSafetyOccurrenceEvents,
  recordEquipmentInspection,
  recordSafetyNotification,
  recordSafetyReadinessSnapshot,
  recordSafetyResponse,
  replaceSafetyEquipment,
  safetyDeskProjection,
  safetyOccurrenceDetail,
  safetyPanelProjection,
  SafetyError,
  submitCorrectiveActionEvidence,
  submitSafetyNotification,
  verifyCorrectiveAction,
  validEvidenceRefsJson,
  SAFETY_EQUIPMENT_KINDS,
  SAFETY_NOTIFICATION_KINDS,
  SAFETY_SCOPE_TYPES,
  SAFETY_SEVERITIES,
  type SafetyEquipmentKind,
  type SafetyEvidence,
  type SafetyNotificationKind,
  type SafetyResponseCommand,
  type SafetyScopeRef,
  type SafetyScopeType,
  type SafetySeverity,
} from "./safety-lifecycle.ts";

/**
 * Browser and field-device surface for the safety spine.
 *
 * The route layer never decides authority. It validates shape, then hands the
 * command to the store, which resolves the caller's exact current role and
 * refuses anything it does not hold. That keeps one enforcement point for
 * rights, authority, and separation of duties instead of two that can drift.
 * The one fact only this layer can see is whether the request carries a
 * person's own cookie session; releasing a stop requires one, so no agent,
 * connector, or service credential ever lifts a stop.
 */

const MAX_BODY_BYTES = 32 * 1024;
/** P33 step-up: a release needs a sign-in no older than this (no passkey is claimed). */
const RELEASE_MAX_SESSION_AGE_SECONDS = 5 * 60;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,139}$/;
const SAFETY_RESPONSE_COMMANDS = [
  "rescue_dispatched",
  "rescue_completed",
  "investigation_opened",
  "finding_recorded",
  "controlled",
  "released",
  "closed",
] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function safetyFailure(error: unknown): Response {
  if (error instanceof EvidenceUploadError) return evidenceUploadFailure(error);
  if (isDisposedDomainLinkRefusal(error)) return json({ error: "evidence_disposition_blocks_domain_link" }, 409);
  if (error instanceof SafetyError) {
    return json({ error: error.code, message: error.message }, error.status);
  }
  return json({ error: "safety_store_unavailable" }, 502);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

async function body(
  req: Request,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: json({ error: "payload_too_large" }, 413) };
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, response: json({ error: "payload_too_large" }, 413) };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed)
      ? { ok: true, value: parsed }
      : { ok: false, response: json({ error: "invalid_json" }, 400) };
  } catch {
    return { ok: false, response: json({ error: "invalid_json" }, 400) };
  }
}

function pathPart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,139}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function evidenceField(value: Record<string, unknown>): SafetyEvidence | null {
  const refs = stringField(value.evidence_refs_json);
  const sha = stringField(value.evidence_sha256);
  return refs && sha ? { refsJson: refs, sha256: sha } : null;
}

/**
 * Scope chain for a readiness question. A work package inherits its job and the
 * tenant, so a tenant-wide stop reaches every package below it.
 */
function scopeChain(
  tenantId: string,
  scope: SafetyScopeRef,
  jobId: string | null,
): SafetyScopeRef[] {
  const chain: SafetyScopeRef[] = [{ type: "tenant", id: tenantId }];
  if (jobId && scope.type !== "roof_job")
    chain.push({ type: "roof_job", id: jobId });
  if (scope.type !== "tenant") chain.push(scope);
  return chain;
}

/**
 * Whether a read comes from a person's own signed-in session, which only this layer can see; a
 * stop's `can_release` needs it. A session lookup that fails answers no, so the read still serves
 * (the panel is the crew's offline seed) and never offers a release the Worker would refuse.
 */
async function readerIsPerson(env: AppEnv, auth: AuthContext): Promise<boolean> {
  try {
    return (await personCookieSession(env, auth)) !== null;
  } catch {
    return false;
  }
}

export async function handleSafetyRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/v1/safety")) return null;
  const tenantId = auth.session.tenant_id;
  const userId = auth.session.user_id;
  const now = new Date().toISOString();

  if (req.method === "GET" && url.pathname === "/api/v1/safety/panel") {
    try {
      return json({
        version: 1,
        panel: await safetyPanelProjection(env, tenantId, userId,
          await readerIsPerson(env, auth)),
      });
    } catch (error) {
      return safetyFailure(error);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/v1/safety/desk") {
    try {
      return json(await safetyDeskProjection(env, tenantId, userId, now));
    } catch (error) {
      return safetyFailure(error);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/v1/safety/readiness") {
    const scopeType = url.searchParams.get("scope_type") ?? "tenant";
    const scopeId = url.searchParams.get("scope_id") ?? tenantId;
    const jobId = url.searchParams.get("job_id");
    if (!SAFETY_SCOPE_TYPES.includes(scopeType as SafetyScopeType)) {
      return json({ error: "safety_readiness_input_invalid" }, 400);
    }
    try {
      const readiness = await evaluateSafetyReadiness(env, {
        tenantId,
        scopes: scopeChain(
          tenantId,
          { type: scopeType as SafetyScopeType, id: scopeId },
          jobId,
        ),
        subjectUserIds: [userId],
        now,
      });
      return json({ version: 1, readiness });
    } catch (error) {
      return safetyFailure(error);
    }
  }

  const occurrenceDetail = url.pathname.match(
    /^\/api\/v1\/safety\/occurrences\/([^/]+)$/,
  );
  if (req.method === "GET" && occurrenceDetail) {
    const occurrenceId = pathPart(occurrenceDetail[1] ?? "");
    if (!occurrenceId) return json({ error: "not_found" }, 404);
    try {
      const detail = await safetyOccurrenceDetail(env, tenantId, userId, occurrenceId,
        await readerIsPerson(env, auth));
      return detail ? json(detail) : json({ error: "not_found" }, 404);
    } catch (error) {
      return safetyFailure(error);
    }
  }

  const occurrenceEvents = url.pathname.match(
    /^\/api\/v1\/safety\/occurrences\/([^/]+)\/events$/,
  );
  if (req.method === "GET" && occurrenceEvents) {
    const occurrenceId = pathPart(occurrenceEvents[1] ?? "");
    if (!occurrenceId) return json({ error: "not_found" }, 404);
    try {
      return json({
        version: 1,
        occurrence_id: occurrenceId,
        events: await listSafetyOccurrenceEvents(env, tenantId, occurrenceId),
      });
    } catch (error) {
      return safetyFailure(error);
    }
  }

  const equipmentDetail = url.pathname.match(
    /^\/api\/v1\/safety\/equipment\/([^/]+)$/,
  );
  if (req.method === "GET" && equipmentDetail) {
    const equipmentId = pathPart(equipmentDetail[1] ?? "");
    if (!equipmentId) return json({ error: "not_found" }, 404);
    try {
      const equipment = await getSafetyEquipment(env, tenantId, equipmentId);
      return equipment
        ? json({ version: 1, equipment })
        : json({ error: "not_found" }, 404);
    } catch (error) {
      return safetyFailure(error);
    }
  }

  const correctiveDetail = url.pathname.match(
    /^\/api\/v1\/safety\/corrective-actions\/([^/]+)$/,
  );
  if (req.method === "GET" && correctiveDetail) {
    const actionId = pathPart(correctiveDetail[1] ?? "");
    if (!actionId) return json({ error: "not_found" }, 404);
    try {
      await assertCurrentEvidenceReader(env, auth);
      const projection = await safetyCorrectiveActionProjection(env, tenantId, userId, actionId);
      const action = projection.corrective_action;
      const evidence = await evidenceFilesForDetail(() => linkedEvidenceFilesForRefs(env,
        tenantId, action.evidence_refs_json,
        { purpose: "corrective_action", targetId: actionId, action: "submit", operationId: "" }));
      return json({ ...projection, ...evidence });
    } catch (error) {
      return safetyFailure(error);
    }
  }

  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);

  // The worker rights rail. No role is consulted; a stop, a hazard report, a
  // condemned harness, and a rescue call are reachable by every active user and
  // survive an offline device.
  if (url.pathname === "/api/v1/safety/actions") {
    try {
      const submission = await parseSafetyActionRequest(req);
      const response = await processSafetyDeviceAction(
        env,
        auth,
        submission,
        safetyActionDependencies(env),
      );
      return json(response);
    } catch (error) {
      return safetyFailure(error);
    }
  }

  const parsed = await body(req);
  if (!parsed.ok) return parsed.response;

  if (url.pathname === "/api/v1/safety/equipment") {
    if (
      !exactKeys(parsed.value, [
        "assigned_user_id",
        "equipment_id",
        "equipment_kind",
        "inspection_interval_days",
        "serial_number",
      ])
    ) {
      return json({ error: "safety_equipment_input_invalid" }, 400);
    }
    const equipmentKind = parsed.value.equipment_kind;
    if (
      typeof equipmentKind !== "string" ||
      !SAFETY_EQUIPMENT_KINDS.includes(equipmentKind as SafetyEquipmentKind)
    ) {
      return json({ error: "safety_equipment_input_invalid" }, 400);
    }
    try {
      const equipment = await issueSafetyEquipment(env, {
        tenantId,
        equipmentId: stringField(parsed.value.equipment_id) ?? "",
        equipmentKind: equipmentKind as SafetyEquipmentKind,
        serialNumber: stringField(parsed.value.serial_number) ?? "",
        assignedUserId: stringField(parsed.value.assigned_user_id),
        inspectionIntervalDays: Number(parsed.value.inspection_interval_days),
        actorUserId: userId,
        now,
      });
      return json({ version: 1, equipment }, 201);
    } catch (error) {
      return safetyFailure(error);
    }
  }

  const inspection = url.pathname.match(
    /^\/api\/v1\/safety\/equipment\/([^/]+)\/inspections$/,
  );
  if (inspection) {
    const equipmentId = pathPart(inspection[1] ?? "");
    if (!equipmentId) return json({ error: "not_found" }, 404);
    const result = parsed.value.result;
    const expectedVersion = parsed.value.expected_version;
    if (
      !["detail", "result", "expected_version"].every(
        (key) => key in parsed.value,
      ) ||
      (result !== "pass" && result !== "fail") ||
      typeof expectedVersion !== "number" ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1
    ) {
      return json({ error: "safety_equipment_input_invalid" }, 400);
    }
    try {
      const equipment = await recordEquipmentInspection(env, {
        tenantId,
        equipmentId,
        actorUserId: userId,
        result,
        detail: stringField(parsed.value.detail) ?? "",
        evidence: evidenceField(parsed.value),
        expectedVersion,
        now,
      });
      return json({ version: 1, equipment });
    } catch (error) {
      return safetyFailure(error);
    }
  }

  const replacement = url.pathname.match(
    /^\/api\/v1\/safety\/equipment\/([^/]+)\/replacement$/,
  );
  if (replacement) {
    const equipmentId = pathPart(replacement[1] ?? "");
    if (!equipmentId) return json({ error: "not_found" }, 404);
    if (
      !exactKeys(parsed.value, [
        "detail",
        "replacement_equipment_id",
        "replacement_serial_number",
      ])
    ) {
      return json({ error: "safety_equipment_input_invalid" }, 400);
    }
    try {
      const result = await replaceSafetyEquipment(env, {
        tenantId,
        equipmentId,
        replacementEquipmentId:
          stringField(parsed.value.replacement_equipment_id) ?? "",
        replacementSerialNumber:
          stringField(parsed.value.replacement_serial_number) ?? "",
        actorUserId: userId,
        detail: stringField(parsed.value.detail) ?? "",
        now,
      });
      return json({ version: 1, ...result }, 201);
    } catch (error) {
      return safetyFailure(error);
    }
  }

  const command = url.pathname.match(
    /^\/api\/v1\/safety\/occurrences\/([^/]+)\/commands$/,
  );
  if (command) {
    const occurrenceId = pathPart(command[1] ?? "");
    if (!occurrenceId) return json({ error: "not_found" }, 404);
    const requested = parsed.value.command;
    if (
      typeof requested !== "string" ||
      !SAFETY_RESPONSE_COMMANDS.includes(requested as SafetyResponseCommand) ||
      !("detail" in parsed.value)
    ) {
      return json({ error: "safety_command_invalid" }, 400);
    }
    // A release cites photos by id, and the Worker reads their checksums; it never takes refs.
    const evidenceIds = parsed.value.evidence_ids;
    if (
      requested === "released" &&
      ("evidence_refs_json" in parsed.value ||
        "evidence_sha256" in parsed.value ||
        (evidenceIds !== undefined && !Array.isArray(evidenceIds)))
    ) {
      return json({ error: "safety_command_invalid" }, 400);
    }
    if (requested !== "released" && evidenceIds !== undefined) {
      return json({ error: "safety_command_invalid" }, 400);
    }
    try {
      const person = requested === "released" ? await personCookieSession(env, auth) : null;
      if (requested === "released" && !person) {
        throw new SafetyError(
          "safety_stop_release_person_required",
          403,
          "Releasing a safety stop needs a person's own signed-in session.",
        );
      }
      const occurrence = await recordSafetyResponse(env, {
        tenantId,
        occurrenceId,
        actorUserId: userId,
        command: requested as SafetyResponseCommand,
        detail: stringField(parsed.value.detail) ?? "",
        evidence: evidenceField(parsed.value),
        now,
        ...(requested === "released"
          ? { evidenceIds: Array.isArray(evidenceIds) ? (evidenceIds as string[]) : [] }
          : {}),
        // The existing session-age check, on the live session row's sign-in time.
        ...(person
          ? {
              sessionRecent: sessionIsRecentForApproval(person.sessionCreatedAt, {
                maxSessionAgeSeconds: RELEASE_MAX_SESSION_AGE_SECONDS,
              }),
            }
          : {}),
      });
      return json({ version: 1, occurrence });
    } catch (error) {
      return safetyFailure(error);
    }
  }

  // "Keep the stop" (P33): the release decision's other answer, recorded to history only.
  const keep = url.pathname.match(/^\/api\/v1\/safety\/occurrences\/([^/]+)\/keep$/);
  if (keep) {
    const occurrenceId = pathPart(keep[1] ?? "");
    if (!occurrenceId) return json({ error: "not_found" }, 404);
    const idempotencyKey = req.headers.get("idempotency-key")?.trim() ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return json({ error: "idempotency_key_required" }, 400);
    }
    if (
      !exactKeys(parsed.value, ["occurrence_version", "reason"]) ||
      typeof parsed.value.reason !== "string" ||
      typeof parsed.value.occurrence_version !== "number"
    ) {
      return json({ error: "safety_stop_keep_invalid" }, 400);
    }
    try {
      if (!(await personCookieSession(env, auth))) {
        throw new SafetyError(
          "safety_stop_release_person_required",
          403,
          "Keeping or releasing a safety stop needs a person's own signed-in session.",
        );
      }
      const result = await keepSafetyStop(env, {
        tenantId,
        occurrenceId,
        actorUserId: userId,
        occurrenceVersion: parsed.value.occurrence_version,
        reason: parsed.value.reason,
        idempotencyKey,
      });
      return json({ version: 1, keep: result.keep }, result.replayed ? 200 : 201);
    } catch (error) {
      return safetyFailure(error);
    }
  }

  // Add a note or verified photos to an open stop (P33). The stop stays in force.
  const addition = url.pathname.match(/^\/api\/v1\/safety\/occurrences\/([^/]+)\/additions$/);
  if (addition) {
    const occurrenceId = pathPart(addition[1] ?? "");
    if (!occurrenceId) return json({ error: "not_found" }, 404);
    const idempotencyKey = req.headers.get("idempotency-key")?.trim() ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return json({ error: "idempotency_key_required" }, 400);
    }
    const note = parsed.value.note;
    const ids = parsed.value.evidence_ids;
    if (
      Object.keys(parsed.value).some((key) => key !== "note" && key !== "evidence_ids") ||
      (note !== undefined && note !== null && typeof note !== "string") ||
      (ids !== undefined && !Array.isArray(ids))
    ) {
      return json({ error: "safety_stop_addition_invalid" }, 400);
    }
    try {
      if (!(await personCookieSession(env, auth))) {
        throw new SafetyError(
          "safety_stop_addition_person_required",
          403,
          "Adding to a safety stop needs a person's own signed-in session.",
        );
      }
      const result = await addToSafetyStop(env, {
        tenantId,
        occurrenceId,
        actorUserId: userId,
        note: typeof note === "string" ? note : null,
        evidenceIds: Array.isArray(ids) ? (ids as string[]) : [],
        idempotencyKey,
      });
      return json({ version: 1, addition: result.addition }, result.replayed ? 200 : 201);
    } catch (error) {
      return safetyFailure(error);
    }
  }

  // Put a stop that names a job or job plan that doesn't exist onto the one it meant.
  const rescope = url.pathname.match(/^\/api\/v1\/safety\/occurrences\/([^/]+)\/scope$/);
  if (rescope) {
    const occurrenceId = pathPart(rescope[1] ?? "");
    if (!occurrenceId) return json({ error: "not_found" }, 404);
    const idempotencyKey = req.headers.get("idempotency-key")?.trim() ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return json({ error: "idempotency_key_required" }, 400);
    }
    if (
      !exactKeys(parsed.value, ["occurrence_version", "reason", "scope_id", "scope_type"]) ||
      typeof parsed.value.occurrence_version !== "number" ||
      typeof parsed.value.reason !== "string" ||
      typeof parsed.value.scope_id !== "string" ||
      (parsed.value.scope_type !== "roof_job" && parsed.value.scope_type !== "work_package")
    ) {
      return json({ error: "safety_stop_rescope_invalid" }, 400);
    }
    try {
      if (!(await personCookieSession(env, auth))) {
        throw new SafetyError(
          "safety_stop_rescope_person_required",
          403,
          "Putting a stop on its job needs a person's own signed-in session.",
        );
      }
      const result = await rescopeSafetyStop(env, {
        tenantId,
        occurrenceId,
        actorUserId: userId,
        occurrenceVersion: parsed.value.occurrence_version,
        scope: { type: parsed.value.scope_type, id: parsed.value.scope_id },
        reason: parsed.value.reason,
        idempotencyKey,
      });
      return json(
        { version: 1, correction: result.correction, occurrence: result.occurrence },
        result.replayed ? 200 : 201,
      );
    } catch (error) {
      return safetyFailure(error);
    }
  }

  if (url.pathname === "/api/v1/safety/notifications") {
    if (
      !exactKeys(parsed.value, [
        "authority_jurisdiction",
        "authority_name",
        "determination_reason",
        "due_at",
        "notification_id",
        "notification_kind",
        "occurrence_id",
        "required",
      ])
    ) {
      return json({ error: "safety_notification_input_invalid" }, 400);
    }
    const notificationKind = parsed.value.notification_kind;
    if (
      typeof notificationKind !== "string" ||
      !SAFETY_NOTIFICATION_KINDS.includes(
        notificationKind as SafetyNotificationKind,
      ) ||
      typeof parsed.value.required !== "boolean"
    ) {
      return json({ error: "safety_notification_input_invalid" }, 400);
    }
    try {
      const notification = await recordSafetyNotification(env, {
        tenantId,
        notificationId: stringField(parsed.value.notification_id) ?? "",
        occurrenceId: stringField(parsed.value.occurrence_id) ?? "",
        authorityName: stringField(parsed.value.authority_name) ?? "",
        authorityJurisdiction:
          stringField(parsed.value.authority_jurisdiction) ?? "",
        notificationKind: notificationKind as SafetyNotificationKind,
        required: parsed.value.required,
        dueAt: stringField(parsed.value.due_at),
        determinationReason:
          stringField(parsed.value.determination_reason) ?? "",
        actorUserId: userId,
        now,
      });
      return json({ version: 1, notification }, 201);
    } catch (error) {
      return safetyFailure(error);
    }
  }

  const submission = url.pathname.match(
    /^\/api\/v1\/safety\/notifications\/([^/]+)\/submission$/,
  );
  if (submission) {
    const notificationId = pathPart(submission[1] ?? "");
    if (!notificationId) return json({ error: "not_found" }, 404);
    try {
      const notification = await submitSafetyNotification(env, {
        tenantId,
        notificationId,
        actorUserId: userId,
        externalReference: stringField(parsed.value.external_reference) ?? "",
        evidence: evidenceField(parsed.value),
        now,
      });
      return json({ version: 1, notification });
    } catch (error) {
      return safetyFailure(error);
    }
  }

  if (url.pathname === "/api/v1/safety/corrective-actions") {
    if (
      !exactKeys(parsed.value, [
        "corrective_action_id",
        "description",
        "due_at",
        "occurrence_id",
        "owner_user_id",
        "recurrence_of_id",
        "risk_level",
      ])
    ) {
      return json({ error: "safety_corrective_action_input_invalid" }, 400);
    }
    const riskLevel = parsed.value.risk_level;
    if (
      typeof riskLevel !== "string" ||
      !SAFETY_SEVERITIES.includes(riskLevel as SafetySeverity)
    ) {
      return json({ error: "safety_corrective_action_input_invalid" }, 400);
    }
    try {
      const action = await assignCorrectiveAction(env, {
        tenantId,
        correctiveActionId:
          stringField(parsed.value.corrective_action_id) ?? "",
        occurrenceId: stringField(parsed.value.occurrence_id) ?? "",
        riskLevel: riskLevel as SafetySeverity,
        ownerUserId: stringField(parsed.value.owner_user_id) ?? "",
        dueAt: stringField(parsed.value.due_at) ?? "",
        description: stringField(parsed.value.description) ?? "",
        recurrenceOfId: stringField(parsed.value.recurrence_of_id),
        actorUserId: userId,
        now,
      });
      return json({ version: 1, corrective_action: action }, 201);
    } catch (error) {
      return safetyFailure(error);
    }
  }

  const correctiveEvidence = url.pathname.match(
    /^\/api\/v1\/safety\/corrective-actions\/([^/]+)\/evidence$/,
  );
  if (correctiveEvidence) {
    const actionId = pathPart(correctiveEvidence[1] ?? "");
    if (!actionId) return json({ error: "not_found" }, 404);
    const receiptBased = parsed.value.evidence_receipt_ids !== undefined || evidenceReceiptsRequired(env);
    if (receiptBased && !exactKeys(parsed.value, ["evidence_receipt_ids", "detail"])) return json({ error: "evidence_receipts_required" }, 400);
    const legacy = receiptBased ? null : evidenceField(parsed.value);
    if (!receiptBased && (!legacy || !validEvidenceRefsJson(legacy.refsJson))) {
      return json({ error: "safety_evidence_invalid" }, 400);
    }
    try {
      const evidence = receiptBased ? await resolveEvidenceUploads(env, auth, {
        purpose: "corrective_action", targetId: actionId, action: "submit", operationId: "",
      }, parsed.value.evidence_receipt_ids) : legacy!;
      const action = await submitCorrectiveActionEvidence(env, {
        tenantId,
        correctiveActionId: actionId,
        actorUserId: userId,
        evidence,
        receiptsResolved: receiptBased,
        detail: stringField(parsed.value.detail) ?? "",
        now,
      });
      return json({ version: 1, corrective_action: action });
    } catch (error) {
      return safetyFailure(error);
    }
  }

  const verification = url.pathname.match(
    /^\/api\/v1\/safety\/corrective-actions\/([^/]+)\/verification$/,
  );
  if (verification) {
    const actionId = pathPart(verification[1] ?? "");
    if (!actionId) return json({ error: "not_found" }, 404);
    const verdict = parsed.value.verdict;
    if (verdict !== "verified" && verdict !== "rejected") {
      return json({ error: "safety_verification_invalid" }, 400);
    }
    try {
      const action = await verifyCorrectiveAction(env, {
        tenantId,
        correctiveActionId: actionId,
        actorUserId: userId,
        verdict,
        detail: stringField(parsed.value.detail) ?? "",
        now,
      });
      return json({ version: 1, corrective_action: action });
    } catch (error) {
      return safetyFailure(error);
    }
  }

  const closure = url.pathname.match(
    /^\/api\/v1\/safety\/corrective-actions\/([^/]+)\/closure$/,
  );
  if (closure) {
    const actionId = pathPart(closure[1] ?? "");
    if (!actionId) return json({ error: "not_found" }, 404);
    try {
      const action = await closeCorrectiveAction(env, {
        tenantId,
        correctiveActionId: actionId,
        actorUserId: userId,
        detail: stringField(parsed.value.detail) ?? "",
        now,
      });
      return json({ version: 1, corrective_action: action });
    } catch (error) {
      return safetyFailure(error);
    }
  }

  // Recording what a release gate saw is an operational act, not a browser one:
  // the snapshot is written by the gate itself in safety-release-gate.ts.
  if (url.pathname === "/api/v1/safety/readiness-snapshots") {
    if (
      !exactKeys(parsed.value, [
        "consumer",
        "scope_id",
        "scope_type",
        "snapshot_id",
      ])
    ) {
      return json({ error: "safety_readiness_input_invalid" }, 400);
    }
    const scopeType = parsed.value.scope_type;
    if (
      typeof scopeType !== "string" ||
      !SAFETY_SCOPE_TYPES.includes(scopeType as SafetyScopeType)
    ) {
      return json({ error: "safety_readiness_input_invalid" }, 400);
    }
    const scope: SafetyScopeRef = {
      type: scopeType as SafetyScopeType,
      id: stringField(parsed.value.scope_id) ?? "",
    };
    try {
      const readiness = await evaluateSafetyReadiness(env, {
        tenantId,
        scopes: scopeChain(tenantId, scope, null),
        subjectUserIds: [userId],
        now,
      });
      const digest = await recordSafetyReadinessSnapshot(env, {
        tenantId,
        snapshotId: stringField(parsed.value.snapshot_id) ?? "",
        scope,
        consumer: parsed.value.consumer as "audit",
        readiness,
        evaluatedByUserId: userId,
        now,
      });
      return json({ version: 1, readiness, snapshot_sha256: digest }, 201);
    } catch (error) {
      return safetyFailure(error);
    }
  }

  return json({ error: "not_found" }, 404);
}
