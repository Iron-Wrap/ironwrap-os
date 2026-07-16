import type { AppEnv } from "./app-types.ts";
import { frappeBaseUrl, frappeRequestTimeout, listFrappeResource } from "./frappe-read.ts";

export interface PersistFieldMediaInput {
  evidenceId: string;
  deviceActionId: string;
  jobId: string;
  evidenceType: "Photo" | "Voice Note";
  proofSlot: string;
  r2Key: string;
  checksum: string;
  contentType: string;
  contentLength: number;
  capturedAt: string;
  captureActor: string;
  latitude: number | null;
  longitude: number | null;
  locationAccuracyM: number | null;
  summary: string | null;
  customerSafe: boolean;
  correctionOf: string | null;
  correctionReason: string | null;
}

export interface PersistFieldCheckInInput {
  checkinId: string;
  deviceActionId: string;
  jobId: string;
  assignmentId: string;
  captureActor: string;
  captureStartedAt: string;
  captureCompletedAt: string;
  submittedAt: string;
  latitude: number | null;
  longitude: number | null;
  locationAccuracyM: number | null;
  photoCount: number;
  evidenceIds: string[];
  blocker: boolean;
  blockerCategory: string | null;
  blockerSummary: string | null;
  voiceEvidenceId: string | null;
  correctionOf: string | null;
  correctionReason: string | null;
  notes: string | null;
  manifestKey: string;
}

export interface FieldFrappeWriter {
  persistEvidence(input: PersistFieldMediaInput): Promise<{ name: string }>;
  persistCheckIn(input: PersistFieldCheckInInput): Promise<{ name: string }>;
}

export function frappeFieldWriter(env: AppEnv): FieldFrappeWriter {
  return {
    async persistEvidence(input) {
      if (input.correctionOf) {
        await assertCorrectionTarget(env, "Evidence Item", input.correctionOf, input.jobId);
      }
      const existing = await listFrappeResource(env, "Evidence Item", [["Evidence Item", "evidence_id", "=", input.evidenceId]], 1);
      const existingName = text(existing[0]?.name);
      if (existingName) {
        assertExistingEvidence(existing[0]!, input);
        return { name: existingName };
      }
      return await createVerifiedFieldEvidence(
        env,
        compact({
          evidence_id: input.evidenceId,
          device_action_id: input.deviceActionId,
          roof_job: input.jobId,
          evidence_type: input.evidenceType,
          proof_slot: input.proofSlot,
          r2_key: input.r2Key,
          content_checksum: input.checksum,
          checksum_algorithm: "SHA-256",
          content_type: input.contentType,
          content_length: input.contentLength,
          capture_actor: input.captureActor,
          captured_at: frappeDatetime(input.capturedAt),
          latitude: input.latitude,
          longitude: input.longitude,
          location_accuracy_m: input.locationAccuracyM,
          correction_of: input.correctionOf,
          correction_reason: input.correctionReason,
          customer_safe: input.customerSafe ? 1 : 0,
          summary: input.summary,
        }),
      );
    },
    async persistCheckIn(input) {
      if (input.correctionOf) {
        await assertCorrectionTarget(env, "Field Check-in", input.correctionOf, input.jobId);
      }
      const existing = await listFrappeResource(env, "Field Check-in", [["Field Check-in", "checkin_id", "=", input.checkinId]], 1);
      const existingName = text(existing[0]?.name);
      if (existingName) {
        assertExistingCheckIn(existing[0]!, input);
        return { name: existingName };
      }
      return await createFrappeResource(
        env,
        "Field Check-in",
        compact({
          checkin_id: input.checkinId,
          device_action_id: input.deviceActionId,
          roof_job: input.jobId,
          job_assignment: input.assignmentId,
          source_system: "ironwrap-pwa",
          capture_actor: input.captureActor,
          capture_started_at: frappeDatetime(input.captureStartedAt),
          capture_completed_at: frappeDatetime(input.captureCompletedAt),
          submitted_at: frappeDatetime(input.submittedAt),
          status: "Received",
          sync_state: "Verified",
          verified_at: frappeDatetime(new Date().toISOString()),
          latitude: input.latitude,
          longitude: input.longitude,
          location_accuracy_m: input.locationAccuracyM,
          photo_count: input.photoCount,
          evidence_ids_json: JSON.stringify(input.evidenceIds),
          blocker_flag: input.blocker ? 1 : 0,
          blocker_category: input.blockerCategory,
          blocker_summary: input.blockerSummary,
          voice_evidence: input.voiceEvidenceId,
          correction_of: input.correctionOf,
          correction_reason: input.correctionReason,
          notes: input.notes,
          raw_key: input.manifestKey,
        }),
      );
    },
  };
}

async function assertCorrectionTarget(
  env: AppEnv,
  doctype: "Evidence Item" | "Field Check-in",
  targetName: string,
  jobId: string,
): Promise<void> {
  const rows = await listFrappeResource(env, doctype, [[doctype, "name", "=", targetName]], 1);
  const target = rows[0];
  if (
    !target ||
    text(target.name) !== targetName ||
    text(target.roof_job) !== jobId ||
    text(target.sync_state) !== "Verified" ||
    text(target.correction_of) === targetName
  ) {
    throw new Error("frappe_field_correction_invalid");
  }
}

function assertExistingEvidence(row: Record<string, unknown>, input: PersistFieldMediaInput): void {
  if (
    text(row.evidence_id) !== input.evidenceId ||
    text(row.device_action_id) !== input.deviceActionId ||
    text(row.roof_job) !== input.jobId ||
    text(row.evidence_type) !== input.evidenceType ||
    text(row.proof_slot) !== input.proofSlot ||
    text(row.source_system) !== "ironwrap-pwa" ||
    text(row.r2_key) !== input.r2Key ||
    text(row.content_checksum) !== input.checksum ||
    text(row.content_type) !== input.contentType ||
    Number(row.content_length) !== input.contentLength ||
    text(row.capture_actor) !== input.captureActor ||
    booleanValue(row.customer_safe) !== input.customerSafe ||
    text(row.sync_state) !== "Verified" ||
    text(row.correction_of) !== input.correctionOf
  ) {
    throw new Error("frappe_field_identity_conflict");
  }
}

function assertExistingCheckIn(row: Record<string, unknown>, input: PersistFieldCheckInInput): void {
  let evidenceIds: unknown;
  try {
    evidenceIds = JSON.parse(text(row.evidence_ids_json) ?? "null") as unknown;
  } catch {
    throw new Error("frappe_field_identity_conflict");
  }
  if (
    text(row.checkin_id) !== input.checkinId ||
    text(row.device_action_id) !== input.deviceActionId ||
    text(row.roof_job) !== input.jobId ||
    text(row.job_assignment) !== input.assignmentId ||
    text(row.source_system) !== "ironwrap-pwa" ||
    text(row.capture_actor) !== input.captureActor ||
    text(row.sync_state) !== "Verified" ||
    text(row.raw_key) !== input.manifestKey ||
    JSON.stringify(evidenceIds) !== JSON.stringify(input.evidenceIds) ||
    text(row.correction_of) !== input.correctionOf
  ) {
    throw new Error("frappe_field_identity_conflict");
  }
}

async function createFrappeResource(
  env: AppEnv,
  doctype: "Field Check-in",
  document: Record<string, unknown>,
): Promise<{ name: string }> {
  const decoded = await postFrappeJson(
    env,
    `/api/resource/${encodeURIComponent(doctype)}`,
    document,
  ) as { data?: { name?: unknown } };
  const name = text(decoded?.data?.name);
  if (!name) throw new Error("frappe_field_invalid_shape");
  return { name };
}

async function createVerifiedFieldEvidence(
  env: AppEnv,
  document: Record<string, unknown>,
): Promise<{ name: string }> {
  const decoded = await postFrappeJson(
    env,
    "/api/method/ironwrap_roofing.field_evidence_api.record_verified_field_evidence",
    { evidence_json: JSON.stringify(document) },
  ) as { message?: { name?: unknown } };
  const name = text(decoded?.message?.name);
  if (!name) throw new Error("frappe_field_invalid_shape");
  return { name };
}

async function postFrappeJson(
  env: AppEnv,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (!env.ERPNEXT_API_KEY || !env.ERPNEXT_API_SECRET) throw new Error("frappe_field_not_configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), frappeRequestTimeout(env.APP_FRAPPE_REQUEST_TIMEOUT_MS));
  try {
    const response = await fetch(`${frappeBaseUrl(env)}${path}`, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`,
        "content-type": "application/json",
        "user-agent": "ironwrap-bff/1.0",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`frappe_field_http_${response.status}`);
    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("frappe_field_timeout");
    if (error instanceof Error && error.message.startsWith("frappe_field_")) throw error;
    throw new Error("frappe_field_network_error");
  } finally {
    clearTimeout(timer);
  }
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}

function frappeDatetime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("frappe_field_invalid_datetime");
  return parsed.toISOString().replace("T", " ").slice(0, 19);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}
