import { sha256Hex } from "./app-auth.ts";
import { appUserIdentities, type AppEnv } from "./app-types.ts";
import { isReservedEvidenceUploadReference } from "./evidence-upload-reference.ts";

/**
 * Owned safety spine: individually issued equipment, physical safety
 * occurrences, regulatory notification, corrective action, and the readiness
 * verdict that Work Package and schedule release consume.
 *
 * Two rules shape every function here.
 *
 * Reporting a hazard, reporting an equipment defect, and making an area safe
 * are worker rights. They take no authority argument, they are reachable with
 * no current work package, and nothing in this module can refuse them for an
 * active tenant user. Inspection, rescue command, regulatory notification,
 * independent verification, and release each require the exact current role.
 *
 * Records are additive. State advances through explicit transitions and each
 * transition appends an immutable event; nothing here deletes safety evidence.
 */

export const SAFETY_EQUIPMENT_KINDS = [
  "fall_arrest_harness",
  "lanyard",
  "anchor",
  "ladder",
  "respirator",
  "hearing_protection",
  "eye_protection",
  "hand_protection",
  "head_protection",
  "gas_detector",
  "fire_extinguisher",
  "first_aid_kit",
  "rescue_kit",
] as const;

export const SAFETY_OCCURRENCE_KINDS = [
  "injury",
  "near_miss",
  "hazard",
  "environmental",
  "emergency",
] as const;

export const SAFETY_SCOPE_TYPES = [
  "tenant",
  "roof_job",
  "work_package",
  "shop",
  "vehicle",
] as const;

export const SAFETY_SEVERITIES = [
  "low",
  "moderate",
  "high",
  "critical",
] as const;

export const SAFETY_NOTIFICATION_KINDS = [
  "regulatory",
  "insurer",
  "client",
  "manufacturer",
  "emergency_services",
] as const;

export const SAFETY_READINESS_CONSUMERS = [
  "work_package_release",
  "schedule_release",
  "field_panel",
  "audit",
] as const;

/** Roles that may inspect, quarantine, retire, or issue equipment. */
const EQUIPMENT_AUTHORITY_ROLES = new Set([
  "owner",
  "ops",
  "production",
  "shop",
]);
/**
 * Roles that may command a rescue, declare control, release a stop, or verify closure. The crew
 * stop release on a Work Package (work-package-stop-release.ts) admits the same roles.
 */
export const RESPONSE_AUTHORITY_ROLES = new Set(["owner", "ops", "production"]);
/** Roles that may record a regulatory or external notification. */
const NOTIFICATION_AUTHORITY_ROLES = new Set(["owner", "ops"]);

export type SafetyEquipmentKind = (typeof SAFETY_EQUIPMENT_KINDS)[number];
export type SafetyOccurrenceKind = (typeof SAFETY_OCCURRENCE_KINDS)[number];
export type SafetyScopeType = (typeof SAFETY_SCOPE_TYPES)[number];
export type SafetySeverity = (typeof SAFETY_SEVERITIES)[number];
export type SafetyNotificationKind = (typeof SAFETY_NOTIFICATION_KINDS)[number];
export type SafetyReadinessConsumer =
  (typeof SAFETY_READINESS_CONSUMERS)[number];

export type SafetyEquipmentStatus =
  "in_service" | "quarantined" | "defective" | "replaced" | "retired";

export type SafetyOccurrenceState =
  "reported" | "made_safe" | "investigating" | "controlled" | "closed";

export type SafetyCorrectiveActionState =
  "open" | "evidence_submitted" | "verified" | "closed" | "rejected";

export type SafetyBlockerCode =
  | "safety_stop_active"
  | "safety_event_uncontrolled"
  | "safety_equipment_unserviceable"
  | "safety_notification_outstanding"
  | "safety_corrective_action_overdue";

export interface SafetyScopeRef {
  type: SafetyScopeType;
  id: string;
}

export interface SafetyEvidence {
  refsJson: string;
  sha256: string;
}

export interface SafetyEquipmentRecord {
  equipment_id: string;
  tenant_id: string;
  equipment_kind: SafetyEquipmentKind;
  serial_number: string;
  version: number;
  status: SafetyEquipmentStatus;
  assigned_user_id: string | null;
  assigned_at: string | null;
  inspection_interval_days: number;
  last_inspection_at: string | null;
  last_inspection_result: "pass" | "fail" | null;
  inspection_due_at: string | null;
  replaced_by_equipment_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SafetyOccurrenceRecord {
  occurrence_id: string;
  tenant_id: string;
  occurrence_kind: SafetyOccurrenceKind;
  severity: SafetySeverity;
  version: number;
  state: SafetyOccurrenceState;
  stop_active: number;
  rescue_required: number;
  rescue_completed_at: string | null;
  scope_type: SafetyScopeType;
  scope_id: string;
  reported_by_user_id: string;
  reported_at: string;
  summary: string;
  report_fingerprint_sha256: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Who lifted the stop (0165); null while it is active, and for a stop lifted before 0165. */
  released_by_user_id: string | null;
}

export interface SafetyNotificationRecord {
  notification_id: string;
  tenant_id: string;
  occurrence_id: string;
  authority_name: string;
  authority_jurisdiction: string;
  notification_kind: SafetyNotificationKind;
  required: number;
  state: "pending" | "submitted" | "acknowledged" | "not_required";
  due_at: string | null;
  submitted_at: string | null;
  submitted_by_user_id: string | null;
  external_reference: string | null;
  acknowledged_at: string | null;
  determination_reason: string;
  created_at: string;
  updated_at: string;
}

export interface SafetyCorrectiveActionRecord {
  corrective_action_id: string;
  tenant_id: string;
  occurrence_id: string;
  version: number;
  state: SafetyCorrectiveActionState;
  risk_level: SafetySeverity;
  owner_user_id: string;
  assigned_by_user_id: string;
  due_at: string;
  description: string;
  recurrence_of_id: string | null;
  evidence_refs_json: string | null;
  evidence_sha256: string | null;
  evidence_captured_by_user_id: string | null;
  evidence_submitted_at: string | null;
  verified_by_user_id: string | null;
  verified_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SafetyBlocker {
  code: SafetyBlockerCode;
  subject_type:
    "occurrence" | "equipment" | "notification" | "corrective_action";
  subject_id: string;
  detail: string;
  /** On a `safety_stop_active` blocker for a stop that holds a job: the facts a screen shows. */
  stop?: SafetyHoldingStop;
}

/**
 * An active stop that holds a job, as every crew read and refusal shows it.
 *
 * - `scope: "job"`: the stop names this job, or a Work Package of this job (any version,
 *   Superseded included).
 * - `scope: "tenant"`: the stop holds every job of the tenant: it is tenant-wide, or it names a job
 *   or Work Package this tenant does not have, which may be a typo for any of its jobs.
 */
export interface SafetyHoldingStop {
  occurrence_id: string;
  scope: "job" | "tenant";
  /** When the stop was raised (the occurrence's `reported_at`). */
  reported_at: string;
  /** The raiser's own words, as recorded. */
  summary: string;
  raiser_display_name: string | null;
}

export interface SafetyReadiness {
  ready: boolean;
  blockers: SafetyBlocker[];
  scopes: SafetyScopeRef[];
  evaluated_at: string;
}

export class SafetyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "SafetyError";
    this.code = code;
    this.status = status;
  }
}

const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,139}$/;
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$/;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,139}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{11,159}$/;

interface SafetyActor {
  userId: string;
  role: string;
}

/**
 * Resolves the caller's effective, currently active role. `access_role` is the
 * effective application role introduced by 0038; the legacy `role` column is a
 * narrower authentication class and must never be read on its own.
 */
export async function safetyActor(
  env: AppEnv,
  tenantId: string,
  userId: string,
): Promise<SafetyActor> {
  if (!TENANT_ID.test(tenantId) || !USER_ID.test(userId)) {
    throw new SafetyError(
      "safety_actor_unknown",
      403,
      "This safety actor is not recognized.",
    );
  }
  const row = await env.DB.prepare(
    `SELECT user_id, COALESCE(access_role, role) AS effective_role
       FROM app_users
      WHERE tenant_id = ? AND user_id = ? AND active = 1
      LIMIT 1`,
  )
    .bind(tenantId, userId)
    .first<{ user_id: string; effective_role: string }>();
  if (!row) {
    throw new SafetyError(
      "safety_actor_unknown",
      403,
      "This safety actor is not recognized.",
    );
  }
  return { userId: row.user_id, role: row.effective_role };
}

function requireRole(
  actor: SafetyActor,
  allowed: Set<string>,
  code: string,
  message: string,
): void {
  if (!allowed.has(actor.role)) throw new SafetyError(code, 403, message);
}

export interface ReportSafetyOccurrenceInput {
  occurrenceId: string;
  tenantId: string;
  occurrenceKind: SafetyOccurrenceKind;
  severity: SafetySeverity;
  scope: SafetyScopeRef;
  reportedByUserId: string;
  reportedAt: string;
  summary: string;
  rescueRequired: boolean;
  evidence: SafetyEvidence | null;
  capturedOffline: boolean;
  deviceActionId: string | null;
  now: string;
}

export type ReportSafetyOccurrenceResult =
  | { kind: "reported"; occurrence: SafetyOccurrenceRecord }
  | { kind: "duplicate"; occurrence: SafetyOccurrenceRecord };

/**
 * Reporting is an intrinsic worker right: this takes no authority argument and
 * refuses only an unknown or deactivated identity. Two offline devices that
 * describe the same physical event at the same instant converge on one
 * occurrence instead of two.
 */
export async function reportSafetyOccurrence(
  env: AppEnv,
  input: ReportSafetyOccurrenceInput,
): Promise<ReportSafetyOccurrenceResult> {
  assertReportInput(input);
  const actor = await safetyActor(env, input.tenantId, input.reportedByUserId);
  // The id is derived from the device action, so a row under it is this raise's own first answer,
  // even when a defaulted summary would now read differently (a job number set in between).
  const recorded = await occurrenceById(env, input.tenantId, input.occurrenceId);
  if (recorded && recorded.reported_by_user_id === input.reportedByUserId) {
    return { kind: "duplicate", occurrence: recorded };
  }
  const fingerprint = await occurrenceFingerprint(input);
  const existing = await occurrenceByFingerprint(
    env,
    input.tenantId,
    fingerprint,
  );
  if (existing) return { kind: "duplicate", occurrence: existing };

  const inserted = await env.DB.prepare(
    `INSERT INTO safety_occurrences
       (occurrence_id, tenant_id, occurrence_kind, severity, version, state, stop_active,
        rescue_required, scope_type, scope_id, reported_by_user_id, reported_at, summary,
        report_fingerprint_sha256, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 'reported', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      input.occurrenceId,
      input.tenantId,
      input.occurrenceKind,
      input.severity,
      input.rescueRequired ? 1 : 0,
      input.scope.type,
      input.scope.id,
      input.reportedByUserId,
      input.reportedAt,
      input.summary,
      fingerprint,
      input.now,
      input.now,
    )
    .run();

  if (d1Changes(inserted) !== 1) {
    const raced = await occurrenceByFingerprint(
      env,
      input.tenantId,
      fingerprint,
    );
    if (!raced) {
      throw new SafetyError(
        "safety_occurrence_insert_failed",
        502,
        "The safety report could not be made durable.",
      );
    }
    return { kind: "duplicate", occurrence: raced };
  }

  await appendOccurrenceEventRow(env, {
    eventId: derivedEventId("soe", input.occurrenceId, 1, "reported"),
    tenantId: input.tenantId,
    occurrenceId: input.occurrenceId,
    occurrenceVersion: 1,
    eventKind: "reported",
    actorUserId: actor.userId,
    actorRole: actor.role,
    detail: input.summary,
    evidence: input.evidence,
    capturedOffline: input.capturedOffline,
    occurredAt: input.reportedAt,
    recordedAt: input.now,
    deviceActionId: input.deviceActionId,
  });

  const occurrence = await occurrenceById(
    env,
    input.tenantId,
    input.occurrenceId,
  );
  if (!occurrence) {
    throw new SafetyError(
      "safety_occurrence_insert_failed",
      502,
      "The safety report could not be made durable.",
    );
  }
  return { kind: "reported", occurrence };
}

export interface MakeSafeInput {
  tenantId: string;
  occurrenceId: string;
  actorUserId: string;
  /**
   * The person on site who confirmed the area is safe. Required when the recorder is not a field
   * worker (an office made-safe, P33), optional for a crew member; never the recorder.
   */
  confirmerUserId?: string | null;
  detail: string;
  evidence: SafetyEvidence | null;
  capturedOffline: boolean;
  deviceActionId: string | null;
  occurredAt: string;
  now: string;
}

/**
 * Making an area safe is a worker right. It advances `reported -> made_safe`
 * and never clears the stop; only an authorized release can do that. A person
 * who is not a field worker records it only with a named on-site confirmer:
 * an active user of the tenant who is not the recorder under any identity
 * (migration 0170 repeats this in D1).
 */
export async function recordMakeSafe(
  env: AppEnv,
  input: MakeSafeInput,
): Promise<SafetyOccurrenceRecord> {
  // A detail the journal would refuse is a definite refusal now, not a write
  // that rolls back on every retry.
  if (!journalDetail(input.detail)) {
    throw new SafetyError(
      "safety_occurrence_input_invalid",
      400,
      "Making an area safe needs a detail of 3 to 4000 characters.",
    );
  }
  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  const occurrence = await requireOccurrence(
    env,
    input.tenantId,
    input.occurrenceId,
  );
  if (occurrence.state !== "reported") {
    if (occurrence.state === "made_safe") return occurrence;
    throw new SafetyError(
      "safety_occurrence_state_invalid",
      409,
      "This occurrence is past the make-safe step.",
    );
  }
  const confirmerUserId = await onSiteConfirmer(env, input, actor);
  const nextVersion = occurrence.version + 1;
  await advanceOccurrence(
    env,
    occurrence,
    {
      version: nextVersion,
      state: "made_safe",
      stopActive: occurrence.stop_active,
      severity: occurrence.severity,
      rescueRequired: occurrence.rescue_required,
      rescueCompletedAt: occurrence.rescue_completed_at,
      closedAt: null,
      releasedByUserId: occurrence.released_by_user_id,
      now: input.now,
    },
    {
      eventId: derivedEventId(
        "soe",
        input.occurrenceId,
        nextVersion,
        "make_safe",
      ),
      tenantId: input.tenantId,
      occurrenceId: input.occurrenceId,
      occurrenceVersion: nextVersion,
      eventKind: "make_safe",
      actorUserId: actor.userId,
      actorRole: actor.role,
      detail: input.detail,
      evidence: input.evidence,
      capturedOffline: input.capturedOffline,
      occurredAt: input.occurredAt,
      recordedAt: input.now,
      deviceActionId: input.deviceActionId,
      confirmedByUserId: confirmerUserId,
    },
  );
  return await requireOccurrence(env, input.tenantId, input.occurrenceId);
}

/** The named on-site confirmer of a made-safe record, checked before anything is written. */
async function onSiteConfirmer(
  env: AppEnv,
  input: MakeSafeInput,
  actor: SafetyActor,
): Promise<string | null> {
  const named = input.confirmerUserId?.trim() || null;
  if (!named) {
    if (actor.role === "field") return null;
    throw new SafetyError(
      "safety_make_safe_confirmer_required",
      400,
      "Recording an area made safe from away from the site needs the person on site who confirmed it.",
    );
  }
  if (!USER_ID.test(named)) {
    throw new SafetyError(
      "safety_make_safe_confirmer_unknown",
      400,
      "The on-site confirmer must be an active person of this company.",
    );
  }
  const confirmer = await env.DB.prepare(
    `SELECT user_id FROM app_users WHERE tenant_id = ? AND user_id = ? AND active = 1`,
  )
    .bind(input.tenantId, named)
    .first<{ user_id: string }>();
  if (!confirmer) {
    throw new SafetyError(
      "safety_make_safe_confirmer_unknown",
      400,
      "The on-site confirmer must be an active person of this company.",
    );
  }
  const recorder = await userIdentities(env, input.tenantId, actor.userId);
  const confirmerIdentities = await userIdentities(env, input.tenantId, confirmer.user_id);
  if ([...confirmerIdentities].some((identity) => recorder.has(identity))) {
    throw new SafetyError(
      "safety_make_safe_confirmer_is_recorder",
      400,
      "The on-site confirmer is someone other than the person recording it.",
    );
  }
  return confirmer.user_id;
}

export type SafetyResponseCommand =
  | "rescue_dispatched"
  | "rescue_completed"
  | "investigation_opened"
  | "finding_recorded"
  | "controlled"
  | "released"
  | "closed";

export interface SafetyResponseInput {
  tenantId: string;
  occurrenceId: string;
  actorUserId: string;
  command: SafetyResponseCommand;
  detail: string;
  evidence: SafetyEvidence | null;
  now: string;
  /**
   * `released` only: whether the person signed in within the last 5 minutes (P33 step-up). The
   * route always says; `false` refuses the release with `recent_session_required` once every
   * other check has passed, so a person is asked to sign in again only for a release that would
   * otherwise go through.
   */
  sessionRecent?: boolean;
}

/**
 * Rescue command, investigation, control, stop release, and closure are
 * authority acts. A stop is released only once the event is controlled and any
 * required rescue has completed, and never by the person who raised it (owner
 * rule L06, with no exception for working alone: if nobody else can release it,
 * it stays active). Closure additionally requires every required notification
 * resolved and every high-risk corrective action closed.
 *
 * Every input is checked before anything is written, and the occurrence moves
 * in the same batch as the event that records the command.
 */
export async function recordSafetyResponse(
  env: AppEnv,
  input: SafetyResponseInput,
): Promise<SafetyOccurrenceRecord> {
  if (!journalDetail(input.detail)) {
    throw new SafetyError(
      "safety_command_invalid",
      400,
      "A safety command needs a detail of 3 to 4000 characters.",
    );
  }
  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  requireRole(
    actor,
    RESPONSE_AUTHORITY_ROLES,
    input.command === "rescue_dispatched" ||
      input.command === "rescue_completed"
      ? "safety_rescue_authority_required"
      : "safety_release_authority_required",
    "This safety command requires current production authority.",
  );
  const occurrence = await requireOccurrence(
    env,
    input.tenantId,
    input.occurrenceId,
  );
  if (input.command === "released") {
    // The same identity comparison as a Work Package stop release
    // (work-package-stop-release.ts); migration 0165 repeats it in D1.
    const raiser = await userIdentities(env, input.tenantId, occurrence.reported_by_user_id);
    const releaser = await userIdentities(env, input.tenantId, actor.userId);
    if ([...releaser].some((identity) => raiser.has(identity))) {
      throw new SafetyError(
        "safety_stop_release_by_raiser_forbidden",
        403,
        "The person who raised a safety stop can never release it.",
      );
    }
  }
  const next = nextOccurrenceShape(occurrence, input.command);
  const nextVersion = occurrence.version + 1;
  if (input.command === "closed") {
    await assertClosureAllowed(env, occurrence);
  }
  if (input.command === "released" && input.sessionRecent === false) {
    throw new SafetyError(
      "recent_session_required",
      403,
      "Releasing a safety stop asks you to sign in again if you signed in more than 5 minutes ago.",
    );
  }
  await advanceOccurrence(
    env,
    occurrence,
    {
      version: nextVersion,
      state: next.state,
      stopActive: next.stopActive,
      severity: occurrence.severity,
      rescueRequired: occurrence.rescue_required,
      rescueCompletedAt: next.rescueCompletedAt ?? occurrence.rescue_completed_at,
      closedAt: next.state === "closed" ? input.now : null,
      releasedByUserId:
        input.command === "released" ? actor.userId : occurrence.released_by_user_id,
      now: input.now,
    },
    {
      eventId: derivedEventId(
        "soe",
        input.occurrenceId,
        nextVersion,
        input.command,
      ),
      tenantId: input.tenantId,
      occurrenceId: input.occurrenceId,
      occurrenceVersion: nextVersion,
      eventKind: input.command,
      actorUserId: actor.userId,
      actorRole: actor.role,
      detail: input.detail,
      evidence: input.evidence,
      capturedOffline: false,
      occurredAt: input.now,
      recordedAt: input.now,
      deviceActionId: null,
    },
  );
  return await requireOccurrence(env, input.tenantId, input.occurrenceId);
}

/**
 * The event table's own rule, `length(trim(detail)) BETWEEN 3 AND 4000`, checked
 * before the write: SQLite's trim removes spaces only, its length counts
 * characters rather than UTF-16 units, and it stops counting at a NUL. The
 * spaces are trimmed by index, because a trailing-space regex backtracks
 * quadratically over a long inner run of spaces.
 */
function journalDetail(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\u0000")) return false;
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 32) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 32) end -= 1;
  const length = [...value.slice(start, end)].length;
  return length >= 3 && length <= 4000;
}

/** Every identity a user carries in this tenant, normalized as `appUserIdentities` does. */
async function userIdentities(
  env: AppEnv,
  tenantId: string,
  userId: string,
): Promise<Set<string>> {
  const identities = new Set([userId.trim().toLowerCase()]);
  const user = await env.DB.prepare(
    `SELECT user_id, email_normalized, frappe_user_id
       FROM app_users
      WHERE tenant_id = ? AND user_id = ?`,
  )
    .bind(tenantId, userId)
    .first<{ user_id: string; email_normalized: string; frappe_user_id: string | null }>();
  if (user) for (const identity of appUserIdentities(user)) identities.add(identity);
  return identities;
}

function nextOccurrenceShape(
  occurrence: SafetyOccurrenceRecord,
  command: SafetyResponseCommand,
): {
  state: SafetyOccurrenceState;
  stopActive: number;
  rescueCompletedAt?: string | null;
} {
  switch (command) {
    case "rescue_dispatched":
      if (occurrence.rescue_required !== 1) {
        throw new SafetyError(
          "safety_rescue_not_required",
          409,
          "This occurrence did not declare a rescue requirement.",
        );
      }
      return { state: occurrence.state, stopActive: occurrence.stop_active };
    case "rescue_completed":
      if (occurrence.rescue_required !== 1) {
        throw new SafetyError(
          "safety_rescue_not_required",
          409,
          "This occurrence did not declare a rescue requirement.",
        );
      }
      return {
        state: occurrence.state,
        stopActive: occurrence.stop_active,
        rescueCompletedAt: new Date().toISOString(),
      };
    case "investigation_opened":
      if (occurrence.state !== "made_safe") {
        throw new SafetyError(
          "safety_occurrence_state_invalid",
          409,
          "An investigation opens only after the area is made safe.",
        );
      }
      return { state: "investigating", stopActive: occurrence.stop_active };
    case "finding_recorded":
      if (occurrence.state !== "investigating") {
        throw new SafetyError(
          "safety_occurrence_state_invalid",
          409,
          "Findings belong to an open investigation.",
        );
      }
      return { state: "investigating", stopActive: occurrence.stop_active };
    case "controlled":
      if (occurrence.state !== "investigating") {
        throw new SafetyError(
          "safety_occurrence_state_invalid",
          409,
          "Control is declared from an open investigation.",
        );
      }
      return { state: "controlled", stopActive: occurrence.stop_active };
    case "released":
      // A second release would rename who lifted the stop; 0165 refuses that in D1 as well.
      if (occurrence.stop_active !== 1) {
        throw new SafetyError(
          "safety_stop_already_released",
          409,
          "This stop has already been released.",
        );
      }
      if (occurrence.state !== "controlled") {
        throw new SafetyError(
          "safety_stop_release_not_permitted",
          409,
          "A stop is released only after the event is controlled.",
        );
      }
      if (occurrence.rescue_required === 1 && !occurrence.rescue_completed_at) {
        throw new SafetyError(
          "safety_stop_release_not_permitted",
          409,
          "A required rescue has not been recorded as completed.",
        );
      }
      return { state: "controlled", stopActive: 0 };
    case "closed":
      if (occurrence.state !== "controlled") {
        throw new SafetyError(
          "safety_occurrence_state_invalid",
          409,
          "Only a controlled occurrence can be closed.",
        );
      }
      if (occurrence.stop_active === 1) {
        throw new SafetyError(
          "safety_stop_active",
          409,
          "Release the stop before closing this occurrence.",
        );
      }
      return { state: "closed", stopActive: 0 };
  }
}

async function assertClosureAllowed(
  env: AppEnv,
  occurrence: SafetyOccurrenceRecord,
): Promise<void> {
  const outstandingNotification = await env.DB.prepare(
    `SELECT notification_id FROM safety_notifications
      WHERE tenant_id = ? AND occurrence_id = ? AND required = 1 AND state = 'pending'
      LIMIT 1`,
  )
    .bind(occurrence.tenant_id, occurrence.occurrence_id)
    .first<{ notification_id: string }>();
  if (outstandingNotification) {
    throw new SafetyError(
      "safety_notification_outstanding",
      409,
      "A required notification for this occurrence is still unresolved.",
    );
  }
  const openAction = await env.DB.prepare(
    `SELECT corrective_action_id FROM safety_corrective_actions
      WHERE tenant_id = ? AND occurrence_id = ? AND state NOT IN ('closed', 'rejected')
      LIMIT 1`,
  )
    .bind(occurrence.tenant_id, occurrence.occurrence_id)
    .first<{ corrective_action_id: string }>();
  if (openAction) {
    throw new SafetyError(
      "safety_corrective_action_open",
      409,
      "A corrective action for this occurrence is still open.",
    );
  }
}

export interface IssueSafetyEquipmentInput {
  tenantId: string;
  equipmentId: string;
  equipmentKind: SafetyEquipmentKind;
  serialNumber: string;
  assignedUserId: string | null;
  inspectionIntervalDays: number;
  actorUserId: string;
  now: string;
}

export async function issueSafetyEquipment(
  env: AppEnv,
  input: IssueSafetyEquipmentInput,
): Promise<SafetyEquipmentRecord> {
  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  requireRole(
    actor,
    EQUIPMENT_AUTHORITY_ROLES,
    "safety_inspection_authority_required",
    "Issuing safety equipment requires current equipment authority.",
  );
  if (
    !OPAQUE_ID.test(input.equipmentId) ||
    !SAFETY_EQUIPMENT_KINDS.includes(input.equipmentKind) ||
    !boundedText(input.serialNumber, 1, 140) ||
    !Number.isInteger(input.inspectionIntervalDays) ||
    input.inspectionIntervalDays < 1 ||
    input.inspectionIntervalDays > 3650 ||
    (input.assignedUserId !== null && !USER_ID.test(input.assignedUserId)) ||
    !ISO_INSTANT.test(input.now)
  ) {
    throw new SafetyError(
      "safety_equipment_input_invalid",
      400,
      "Invalid safety-equipment input.",
    );
  }
  const existing = await equipmentById(env, input.tenantId, input.equipmentId);
  if (existing) return existing;
  await env.DB.prepare(
    `INSERT INTO safety_equipment
       (equipment_id, tenant_id, equipment_kind, serial_number, version, status,
        assigned_user_id, assigned_at, inspection_interval_days, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 'in_service', ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.equipmentId,
      input.tenantId,
      input.equipmentKind,
      input.serialNumber,
      input.assignedUserId,
      input.assignedUserId ? input.now : null,
      input.inspectionIntervalDays,
      input.now,
      input.now,
    )
    .run();
  await appendEquipmentEventRow(env, {
    eventId: derivedEventId("see", input.equipmentId, 1, "issue"),
    tenantId: input.tenantId,
    equipmentId: input.equipmentId,
    equipmentVersion: 1,
    eventKind: "issue",
    actorUserId: actor.userId,
    actorRole: actor.role,
    detail: input.assignedUserId
      ? `Issued to ${input.assignedUserId}`
      : "Added to unassigned stock",
    evidence: null,
    occurredAt: input.now,
    recordedAt: input.now,
    deviceActionId: null,
  });
  return await requireEquipment(env, input.tenantId, input.equipmentId);
}

export interface EquipmentInspectionInput {
  tenantId: string;
  equipmentId: string;
  actorUserId: string;
  result: "pass" | "fail";
  detail: string;
  evidence: SafetyEvidence | null;
  /** The equipment revision the inspector actually read before deciding. */
  expectedVersion: number;
  now: string;
}

/**
 * Inspection is competency-bound. A failed inspection quarantines the item
 * immediately; a passing inspection is the only way a quarantined item returns
 * to service, and it resets the next due date from the recorded interval.
 */
export async function recordEquipmentInspection(
  env: AppEnv,
  input: EquipmentInspectionInput,
): Promise<SafetyEquipmentRecord> {
  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  requireRole(
    actor,
    EQUIPMENT_AUTHORITY_ROLES,
    "safety_inspection_authority_required",
    "Inspecting safety equipment requires current equipment authority.",
  );
  const equipment = await requireEquipment(
    env,
    input.tenantId,
    input.equipmentId,
  );
  if (equipment.status === "retired" || equipment.status === "replaced") {
    throw new SafetyError(
      "safety_equipment_state_invalid",
      409,
      "This equipment is no longer in the fleet.",
    );
  }
  // A verdict is only valid against the record the inspector read. If someone else
  // quarantined or changed the item since, a "pass" from the stale screen must not
  // return it to service; the inspector has to read the new condition first.
  if (equipment.version !== input.expectedVersion) {
    throw new SafetyError(
      "safety_equipment_version_conflict",
      409,
      `This equipment changed since it was read (revision ${input.expectedVersion} read, revision ${equipment.version} on file). Read the current record before inspecting.`,
    );
  }
  const nextVersion = equipment.version + 1;
  const dueAt = new Date(
    Date.parse(input.now) +
      equipment.inspection_interval_days * 24 * 60 * 60 * 1000,
  ).toISOString();
  const nextStatus: SafetyEquipmentStatus =
    input.result === "pass" ? "in_service" : "quarantined";
  const updated = await env.DB.prepare(
    `UPDATE safety_equipment
        SET version = ?, status = ?, last_inspection_at = ?, last_inspection_result = ?,
            inspection_due_at = ?, updated_at = ?
      WHERE tenant_id = ? AND equipment_id = ? AND version = ?`,
  )
    .bind(
      nextVersion,
      nextStatus,
      input.now,
      input.result,
      dueAt,
      input.now,
      input.tenantId,
      input.equipmentId,
      equipment.version,
    )
    .run();
  if (d1Changes(updated) !== 1) {
    throw new SafetyError(
      "safety_equipment_version_conflict",
      409,
      "This equipment record changed while the inspection was recorded.",
    );
  }
  await appendEquipmentEventRow(env, {
    eventId: derivedEventId(
      "see",
      input.equipmentId,
      nextVersion,
      input.result === "pass" ? "inspection_pass" : "inspection_fail",
    ),
    tenantId: input.tenantId,
    equipmentId: input.equipmentId,
    equipmentVersion: nextVersion,
    eventKind: input.result === "pass" ? "inspection_pass" : "inspection_fail",
    actorUserId: actor.userId,
    actorRole: actor.role,
    detail: input.detail,
    evidence: input.evidence,
    occurredAt: input.now,
    recordedAt: input.now,
    deviceActionId: null,
  });
  return await requireEquipment(env, input.tenantId, input.equipmentId);
}

export interface EquipmentDefectInput {
  tenantId: string;
  equipmentId: string;
  actorUserId: string;
  detail: string;
  evidence: SafetyEvidence | null;
  deviceActionId: string | null;
  occurredAt: string;
  now: string;
}

/**
 * Reporting a defect is a worker right, and it takes the item out of service
 * immediately. Nobody needs an inspector's role to say a harness is damaged.
 */
export async function reportEquipmentDefect(
  env: AppEnv,
  input: EquipmentDefectInput,
): Promise<SafetyEquipmentRecord> {
  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  const equipment = await requireEquipment(
    env,
    input.tenantId,
    input.equipmentId,
  );
  if (equipment.status === "retired" || equipment.status === "replaced") {
    throw new SafetyError(
      "safety_equipment_state_invalid",
      409,
      "This equipment is no longer in the fleet.",
    );
  }
  if (equipment.status === "defective") return equipment;
  const nextVersion = equipment.version + 1;
  const updated = await env.DB.prepare(
    `UPDATE safety_equipment
        SET version = ?, status = 'defective', updated_at = ?
      WHERE tenant_id = ? AND equipment_id = ? AND version = ?`,
  )
    .bind(
      nextVersion,
      input.now,
      input.tenantId,
      input.equipmentId,
      equipment.version,
    )
    .run();
  if (d1Changes(updated) !== 1) {
    throw new SafetyError(
      "safety_equipment_version_conflict",
      409,
      "This equipment record changed while the defect was recorded.",
    );
  }
  await appendEquipmentEventRow(env, {
    eventId: derivedEventId(
      "see",
      input.equipmentId,
      nextVersion,
      "defect_reported",
    ),
    tenantId: input.tenantId,
    equipmentId: input.equipmentId,
    equipmentVersion: nextVersion,
    eventKind: "defect_reported",
    actorUserId: actor.userId,
    actorRole: actor.role,
    detail: input.detail,
    evidence: input.evidence,
    occurredAt: input.occurredAt,
    recordedAt: input.now,
    deviceActionId: input.deviceActionId,
  });
  return await requireEquipment(env, input.tenantId, input.equipmentId);
}

export interface ReplaceEquipmentInput {
  tenantId: string;
  equipmentId: string;
  replacementEquipmentId: string;
  replacementSerialNumber: string;
  actorUserId: string;
  detail: string;
  now: string;
}

export async function replaceSafetyEquipment(
  env: AppEnv,
  input: ReplaceEquipmentInput,
): Promise<{
  replaced: SafetyEquipmentRecord;
  replacement: SafetyEquipmentRecord;
}> {
  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  requireRole(
    actor,
    EQUIPMENT_AUTHORITY_ROLES,
    "safety_inspection_authority_required",
    "Replacing safety equipment requires current equipment authority.",
  );
  const equipment = await requireEquipment(
    env,
    input.tenantId,
    input.equipmentId,
  );
  if (equipment.status === "retired" || equipment.status === "replaced") {
    throw new SafetyError(
      "safety_equipment_state_invalid",
      409,
      "This equipment is no longer in the fleet.",
    );
  }
  const replacement = await issueSafetyEquipment(env, {
    tenantId: input.tenantId,
    equipmentId: input.replacementEquipmentId,
    equipmentKind: equipment.equipment_kind,
    serialNumber: input.replacementSerialNumber,
    assignedUserId: equipment.assigned_user_id,
    inspectionIntervalDays: equipment.inspection_interval_days,
    actorUserId: input.actorUserId,
    now: input.now,
  });
  const nextVersion = equipment.version + 1;
  const updated = await env.DB.prepare(
    `UPDATE safety_equipment
        SET version = ?, status = 'replaced', replaced_by_equipment_id = ?,
            assigned_user_id = NULL, assigned_at = NULL, updated_at = ?
      WHERE tenant_id = ? AND equipment_id = ? AND version = ?`,
  )
    .bind(
      nextVersion,
      input.replacementEquipmentId,
      input.now,
      input.tenantId,
      input.equipmentId,
      equipment.version,
    )
    .run();
  if (d1Changes(updated) !== 1) {
    throw new SafetyError(
      "safety_equipment_version_conflict",
      409,
      "This equipment record changed while the replacement was recorded.",
    );
  }
  await appendEquipmentEventRow(env, {
    eventId: derivedEventId(
      "see",
      input.equipmentId,
      nextVersion,
      "replacement",
    ),
    tenantId: input.tenantId,
    equipmentId: input.equipmentId,
    equipmentVersion: nextVersion,
    eventKind: "replacement",
    actorUserId: actor.userId,
    actorRole: actor.role,
    detail: input.detail,
    evidence: null,
    occurredAt: input.now,
    recordedAt: input.now,
    deviceActionId: null,
  });
  return {
    replaced: await requireEquipment(env, input.tenantId, input.equipmentId),
    replacement,
  };
}

export interface RecordSafetyNotificationInput {
  tenantId: string;
  notificationId: string;
  occurrenceId: string;
  authorityName: string;
  authorityJurisdiction: string;
  notificationKind: SafetyNotificationKind;
  required: boolean;
  dueAt: string | null;
  determinationReason: string;
  actorUserId: string;
  now: string;
}

/**
 * Declaring that an external authority must be told — and declaring that one
 * need not be — are both authority acts with a recorded reason. A pending
 * required notification blocks the affected scope until it is submitted.
 */
export async function recordSafetyNotification(
  env: AppEnv,
  input: RecordSafetyNotificationInput,
): Promise<SafetyNotificationRecord> {
  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  requireRole(
    actor,
    NOTIFICATION_AUTHORITY_ROLES,
    "safety_notification_authority_required",
    "Recording an external notification requires owner or operations authority.",
  );
  await requireOccurrence(env, input.tenantId, input.occurrenceId);
  if (
    !OPAQUE_ID.test(input.notificationId) ||
    !boundedText(input.authorityName, 2, 200) ||
    !boundedText(input.authorityJurisdiction, 2, 160) ||
    !SAFETY_NOTIFICATION_KINDS.includes(input.notificationKind) ||
    !boundedText(input.determinationReason, 3, 2000) ||
    (input.dueAt !== null && !ISO_INSTANT.test(input.dueAt))
  ) {
    throw new SafetyError(
      "safety_notification_input_invalid",
      400,
      "Invalid safety-notification input.",
    );
  }
  const existing = await notificationById(
    env,
    input.tenantId,
    input.notificationId,
  );
  if (existing) return existing;
  await env.DB.prepare(
    `INSERT INTO safety_notifications
       (notification_id, tenant_id, occurrence_id, authority_name, authority_jurisdiction,
        notification_kind, required, state, due_at, determination_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.notificationId,
      input.tenantId,
      input.occurrenceId,
      input.authorityName,
      input.authorityJurisdiction,
      input.notificationKind,
      input.required ? 1 : 0,
      input.required ? "pending" : "not_required",
      input.dueAt,
      input.determinationReason,
      input.now,
      input.now,
    )
    .run();
  return await requireNotification(env, input.tenantId, input.notificationId);
}

export interface SubmitSafetyNotificationInput {
  tenantId: string;
  notificationId: string;
  actorUserId: string;
  externalReference: string;
  evidence: SafetyEvidence | null;
  now: string;
}

export async function submitSafetyNotification(
  env: AppEnv,
  input: SubmitSafetyNotificationInput,
): Promise<SafetyNotificationRecord> {
  assertEvidence(input.evidence);
  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  requireRole(
    actor,
    NOTIFICATION_AUTHORITY_ROLES,
    "safety_notification_authority_required",
    "Submitting an external notification requires owner or operations authority.",
  );
  const notification = await requireNotification(
    env,
    input.tenantId,
    input.notificationId,
  );
  if (notification.state !== "pending") {
    if (notification.state === "submitted") return notification;
    throw new SafetyError(
      "safety_notification_state_invalid",
      409,
      "This notification is no longer pending.",
    );
  }
  if (!boundedText(input.externalReference, 1, 240)) {
    throw new SafetyError(
      "safety_notification_input_invalid",
      400,
      "An external reference from the authority is required.",
    );
  }
  const updated = await env.DB.prepare(
    `UPDATE safety_notifications
        SET state = 'submitted', submitted_at = ?, submitted_by_user_id = ?,
            external_reference = ?, evidence_refs_json = ?, evidence_sha256 = ?, updated_at = ?
      WHERE tenant_id = ? AND notification_id = ? AND state = 'pending'`,
  )
    .bind(
      input.now,
      actor.userId,
      input.externalReference,
      input.evidence?.refsJson ?? null,
      input.evidence?.sha256 ?? null,
      input.now,
      input.tenantId,
      input.notificationId,
    )
    .run();
  if (d1Changes(updated) !== 1) {
    throw new SafetyError(
      "safety_notification_state_invalid",
      409,
      "This notification is no longer pending.",
    );
  }
  return await requireNotification(env, input.tenantId, input.notificationId);
}

export interface AssignCorrectiveActionInput {
  tenantId: string;
  correctiveActionId: string;
  occurrenceId: string;
  riskLevel: SafetySeverity;
  ownerUserId: string;
  dueAt: string;
  description: string;
  recurrenceOfId: string | null;
  actorUserId: string;
  now: string;
}

export async function assignCorrectiveAction(
  env: AppEnv,
  input: AssignCorrectiveActionInput,
): Promise<SafetyCorrectiveActionRecord> {
  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  requireRole(
    actor,
    RESPONSE_AUTHORITY_ROLES,
    "safety_assignment_authority_required",
    "Assigning a corrective action requires current production authority.",
  );
  await requireOccurrence(env, input.tenantId, input.occurrenceId);
  await safetyActor(env, input.tenantId, input.ownerUserId);
  if (
    !OPAQUE_ID.test(input.correctiveActionId) ||
    !SAFETY_SEVERITIES.includes(input.riskLevel) ||
    !ISO_INSTANT.test(input.dueAt) ||
    !boundedText(input.description, 3, 4000) ||
    (input.recurrenceOfId !== null && !OPAQUE_ID.test(input.recurrenceOfId))
  ) {
    throw new SafetyError(
      "safety_corrective_action_input_invalid",
      400,
      "Invalid corrective-action input.",
    );
  }
  const existing = await correctiveActionById(
    env,
    input.tenantId,
    input.correctiveActionId,
  );
  if (existing) return existing;
  await env.DB.prepare(
    `INSERT INTO safety_corrective_actions
       (corrective_action_id, tenant_id, occurrence_id, version, state, risk_level,
        owner_user_id, assigned_by_user_id, due_at, description, recurrence_of_id,
        created_at, updated_at)
     VALUES (?, ?, ?, 1, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.correctiveActionId,
      input.tenantId,
      input.occurrenceId,
      input.riskLevel,
      input.ownerUserId,
      actor.userId,
      input.dueAt,
      input.description,
      input.recurrenceOfId,
      input.now,
      input.now,
    )
    .run();
  await appendCorrectiveActionEventRow(env, {
    eventId: derivedEventId("scae", input.correctiveActionId, 1, "assigned"),
    tenantId: input.tenantId,
    correctiveActionId: input.correctiveActionId,
    correctiveActionVersion: 1,
    eventKind: "assigned",
    actorUserId: actor.userId,
    actorRole: actor.role,
    detail: input.description,
    recordedAt: input.now,
  });
  return await requireCorrectiveAction(
    env,
    input.tenantId,
    input.correctiveActionId,
  );
}

export interface SubmitCorrectiveEvidenceInput {
  tenantId: string;
  correctiveActionId: string;
  actorUserId: string;
  evidence: SafetyEvidence;
  receiptsResolved?: boolean;
  detail: string;
  now: string;
}

export async function submitCorrectiveActionEvidence(
  env: AppEnv,
  input: SubmitCorrectiveEvidenceInput,
): Promise<SafetyCorrectiveActionRecord> {
  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  const action = await requireCorrectiveAction(
    env,
    input.tenantId,
    input.correctiveActionId,
  );
  if (action.state !== "open") {
    const event = await env.DB.prepare(
      `SELECT detail FROM safety_corrective_action_events
        WHERE tenant_id = ? AND corrective_action_id = ? AND event_kind = 'evidence_submitted'
        ORDER BY corrective_action_version DESC LIMIT 1`,
    )
      .bind(input.tenantId, input.correctiveActionId)
      .first<{ detail: string }>();
    // A lost response may be retried after verification or closure. Only the exact
    // original evidence and capturer can be acknowledged as that successful write.
    if (
      action.evidence_refs_json === input.evidence.refsJson &&
      action.evidence_sha256 === input.evidence.sha256 &&
      action.evidence_captured_by_user_id === actor.userId &&
      event?.detail === input.detail
    )
      return action;
    throw new SafetyError(
      "safety_corrective_evidence_conflict",
      409,
      "Different evidence is already on file. Read the current action before submitting again.",
    );
  }
  if (
    !SHA256.test(input.evidence.sha256) ||
    !validEvidenceRefsJson(input.evidence.refsJson, input.receiptsResolved === true)
  ) {
    throw new SafetyError(
      "safety_evidence_invalid",
      400,
      "Corrective-action evidence must carry hashed immutable references.",
    );
  }
  const nextVersion = action.version + 1;
  const updated = await env.DB.prepare(
    `UPDATE safety_corrective_actions
        SET version = ?, state = 'evidence_submitted', evidence_refs_json = ?, evidence_sha256 = ?,
            evidence_captured_by_user_id = ?, evidence_submitted_at = ?, updated_at = ?
      WHERE tenant_id = ? AND corrective_action_id = ? AND version = ? AND state = 'open'`,
  )
    .bind(
      nextVersion,
      input.evidence.refsJson,
      input.evidence.sha256,
      actor.userId,
      input.now,
      input.now,
      input.tenantId,
      input.correctiveActionId,
      action.version,
    )
    .run();
  if (d1Changes(updated) !== 1) {
    throw new SafetyError(
      "safety_corrective_action_state_invalid",
      409,
      "This corrective action changed while evidence was submitted.",
    );
  }
  await appendCorrectiveActionEventRow(env, {
    eventId: derivedEventId(
      "scae",
      input.correctiveActionId,
      nextVersion,
      "evidence_submitted",
    ),
    tenantId: input.tenantId,
    correctiveActionId: input.correctiveActionId,
    correctiveActionVersion: nextVersion,
    eventKind: "evidence_submitted",
    actorUserId: actor.userId,
    actorRole: actor.role,
    detail: input.detail,
    recordedAt: input.now,
  });
  return await requireCorrectiveAction(
    env,
    input.tenantId,
    input.correctiveActionId,
  );
}

export interface VerifyCorrectiveActionInput {
  tenantId: string;
  correctiveActionId: string;
  actorUserId: string;
  verdict: "verified" | "rejected";
  detail: string;
  now: string;
}

/**
 * Independent verification. The occurrence reporter, the action owner, and the
 * person who captured the closure evidence are all excluded here and again by
 * the D1 trigger, so a compromised caller cannot close its own loop.
 */
export async function verifyCorrectiveAction(
  env: AppEnv,
  input: VerifyCorrectiveActionInput,
): Promise<SafetyCorrectiveActionRecord> {
  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  requireRole(
    actor,
    RESPONSE_AUTHORITY_ROLES,
    "safety_verification_authority_required",
    "Verifying a corrective action requires current production authority.",
  );
  const action = await requireCorrectiveAction(
    env,
    input.tenantId,
    input.correctiveActionId,
  );
  if (action.state !== "evidence_submitted") {
    throw new SafetyError(
      "safety_corrective_action_state_invalid",
      409,
      "Only a corrective action with submitted evidence can be verified.",
    );
  }
  const occurrence = await requireOccurrence(
    env,
    input.tenantId,
    action.occurrence_id,
  );
  if (
    actor.userId === action.owner_user_id ||
    actor.userId === action.evidence_captured_by_user_id ||
    actor.userId === occurrence.reported_by_user_id
  ) {
    throw new SafetyError(
      "safety_verification_separation_required",
      403,
      "The reporter, owner, and evidence capturer cannot verify this closure.",
    );
  }
  const nextVersion = action.version + 1;
  const updated =
    input.verdict === "verified"
      ? await env.DB.prepare(
          `UPDATE safety_corrective_actions
              SET version = ?, state = 'verified', verified_by_user_id = ?, verified_at = ?, updated_at = ?
            WHERE tenant_id = ? AND corrective_action_id = ? AND version = ?
              AND state = 'evidence_submitted'`,
        )
          .bind(
            nextVersion,
            actor.userId,
            input.now,
            input.now,
            input.tenantId,
            input.correctiveActionId,
            action.version,
          )
          .run()
      : await env.DB.prepare(
          `UPDATE safety_corrective_actions
              SET version = ?, state = 'rejected', updated_at = ?
            WHERE tenant_id = ? AND corrective_action_id = ? AND version = ?
              AND state = 'evidence_submitted'`,
        )
          .bind(
            nextVersion,
            input.now,
            input.tenantId,
            input.correctiveActionId,
            action.version,
          )
          .run();
  if (d1Changes(updated) !== 1) {
    throw new SafetyError(
      "safety_corrective_action_state_invalid",
      409,
      "This corrective action changed while it was being verified.",
    );
  }
  await appendCorrectiveActionEventRow(env, {
    eventId: derivedEventId(
      "scae",
      input.correctiveActionId,
      nextVersion,
      input.verdict,
    ),
    tenantId: input.tenantId,
    correctiveActionId: input.correctiveActionId,
    correctiveActionVersion: nextVersion,
    eventKind: input.verdict,
    actorUserId: actor.userId,
    actorRole: actor.role,
    detail: input.detail,
    recordedAt: input.now,
  });
  return await requireCorrectiveAction(
    env,
    input.tenantId,
    input.correctiveActionId,
  );
}

export interface CloseCorrectiveActionInput {
  tenantId: string;
  correctiveActionId: string;
  actorUserId: string;
  detail: string;
  now: string;
}

export async function closeCorrectiveAction(
  env: AppEnv,
  input: CloseCorrectiveActionInput,
): Promise<SafetyCorrectiveActionRecord> {
  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  requireRole(
    actor,
    RESPONSE_AUTHORITY_ROLES,
    "safety_verification_authority_required",
    "Closing a corrective action requires current production authority.",
  );
  const action = await requireCorrectiveAction(
    env,
    input.tenantId,
    input.correctiveActionId,
  );
  if (action.state !== "verified") {
    if (action.state === "closed") return action;
    throw new SafetyError(
      "safety_corrective_action_state_invalid",
      409,
      "Only an independently verified corrective action can be closed.",
    );
  }
  const nextVersion = action.version + 1;
  const updated = await env.DB.prepare(
    `UPDATE safety_corrective_actions
        SET version = ?, state = 'closed', closed_at = ?, updated_at = ?
      WHERE tenant_id = ? AND corrective_action_id = ? AND version = ? AND state = 'verified'`,
  )
    .bind(
      nextVersion,
      input.now,
      input.now,
      input.tenantId,
      input.correctiveActionId,
      action.version,
    )
    .run();
  if (d1Changes(updated) !== 1) {
    throw new SafetyError(
      "safety_corrective_action_state_invalid",
      409,
      "This corrective action changed while it was being closed.",
    );
  }
  await appendCorrectiveActionEventRow(env, {
    eventId: derivedEventId(
      "scae",
      input.correctiveActionId,
      nextVersion,
      "closed",
    ),
    tenantId: input.tenantId,
    correctiveActionId: input.correctiveActionId,
    correctiveActionVersion: nextVersion,
    eventKind: "closed",
    actorUserId: actor.userId,
    actorRole: actor.role,
    detail: input.detail,
    recordedAt: input.now,
  });
  return await requireCorrectiveAction(
    env,
    input.tenantId,
    input.correctiveActionId,
  );
}

export interface EvaluateSafetyReadinessInput {
  tenantId: string;
  /**
   * The full scope chain. A work package inherits its job and the tenant, so
   * the caller passes every level it wants enforced rather than this module
   * guessing a hierarchy it cannot see.
   */
  scopes: SafetyScopeRef[];
  /** App user ids whose individually issued PPE gates this release. */
  subjectUserIds: string[];
  now: string;
}

/**
 * The single readiness verdict consumed by Work Package release, schedule
 * release, and the field panel. It fails closed: an unreadable input is a
 * blocker, never a pass.
 */
/** One equipment row, judged exactly as the release gate judges it.
 *  Extracted so the safety desk and `evaluateSafetyReadiness` cannot drift apart: a desk that
 *  called a item serviceable while the gate stopped the crew would be worse than no desk.
 *  `subject` is the leading noun phrase, because the gate only ever sees assigned equipment
 *  while the desk sees the whole tenant. Returns null when the item is serviceable. */
export function equipmentUnserviceableDetail(
  row: {
    equipment_kind: SafetyEquipmentKind;
    status: SafetyEquipmentStatus;
    inspection_due_at: string | null;
    last_inspection_result: "pass" | "fail" | null;
  },
  now: string,
  subject: string,
): string | null {
  if (row.status !== "in_service") return `${subject} is ${row.status}.`;
  // Never inspected and past-due are the same fact for a release gate:
  // there is no current evidence that this item is safe to use.
  if (!row.inspection_due_at || row.inspection_due_at <= now) {
    return row.inspection_due_at
      ? `${subject} inspection expired ${row.inspection_due_at}.`
      : `${subject} has no recorded inspection.`;
  }
  if (row.last_inspection_result === "fail")
    return `${subject} failed its last inspection.`;
  return null;
}

/** The gate stops work for an overdue corrective action only at high or critical risk.
 *  The desk shows every open action but must mark the blocking ones by this same rule. */
export function correctiveActionBlocks(
  row: {
    risk_level: SafetySeverity;
    state: SafetyCorrectiveActionState;
    due_at: string;
  },
  now: string,
): boolean {
  if (row.risk_level !== "high" && row.risk_level !== "critical") return false;
  if (row.state === "closed" || row.state === "rejected") return false;
  return row.due_at < now;
}

export async function evaluateSafetyReadiness(
  env: AppEnv,
  input: EvaluateSafetyReadinessInput,
): Promise<SafetyReadiness> {
  if (!TENANT_ID.test(input.tenantId) || !ISO_INSTANT.test(input.now)) {
    throw new SafetyError(
      "safety_readiness_input_invalid",
      400,
      "Invalid readiness input.",
    );
  }
  const scopes = input.scopes.filter(
    (scope) =>
      SAFETY_SCOPE_TYPES.includes(scope.type) && SCOPE_ID.test(scope.id),
  );
  if (scopes.length !== input.scopes.length) {
    throw new SafetyError(
      "safety_readiness_input_invalid",
      400,
      "Invalid readiness scope.",
    );
  }
  const subjects = input.subjectUserIds.filter((userId) =>
    USER_ID.test(userId),
  );
  if (subjects.length !== input.subjectUserIds.length) {
    throw new SafetyError(
      "safety_readiness_input_invalid",
      400,
      "Invalid readiness subject.",
    );
  }
  const blockers: SafetyBlocker[] = [];

  if (scopes.length > 0) {
    const scopeClause = scopes
      .map(() => "(scope_type = ? AND scope_id = ?)")
      .join(" OR ");
    const scopeBindings = scopes.flatMap((scope) => [scope.type, scope.id]);
    // The jobs this chain stands on: its job level, and the job of its Work Package level.
    const jobIds = await chainJobIds(env, input.tenantId, scopes);
    const holding = new Map(
      (await holdingStopRows(env, input.tenantId, jobIds)).map((row) => [row.occurrence_id, row]),
    );
    const occurrences = await env.DB.prepare(
      `SELECT occurrence_id, occurrence_kind, state, stop_active, severity
         FROM safety_occurrences
        WHERE tenant_id = ? AND (${scopeClause})
          AND (stop_active = 1 OR state NOT IN ('controlled', 'closed'))
        ORDER BY reported_at DESC
        LIMIT 200`,
    )
      .bind(input.tenantId, ...scopeBindings)
      .all<{
        occurrence_id: string;
        occurrence_kind: SafetyOccurrenceKind;
        state: SafetyOccurrenceState;
        stop_active: number;
        severity: SafetySeverity;
      }>();
    // A stop holds more than its exact scope: a tenant-wide or unresolved-scope stop holds every
    // job, and a Work Package stop holds its whole job. Those come first, then exact matches the
    // hold rule does not cover (a shop or vehicle stop asked about directly, or a lifted event that
    // is not controlled yet).
    const rows = [
      ...[...holding.values()].map((row) => ({ ...row, stop_active: 1 })),
      ...occurrences.results.filter((row) => !holding.has(row.occurrence_id)),
    ];
    for (const row of rows) {
      const hold = holding.get(row.occurrence_id);
      if (row.stop_active === 1) {
        blockers.push({
          code: "safety_stop_active",
          subject_type: "occurrence",
          subject_id: row.occurrence_id,
          detail: `An active ${row.occurrence_kind} stop is in force (${row.state}).`,
          ...(hold ? { stop: holdingStop(hold) } : {}),
        });
      } else {
        blockers.push({
          code: "safety_event_uncontrolled",
          subject_type: "occurrence",
          subject_id: row.occurrence_id,
          detail: `A ${row.severity} ${row.occurrence_kind} is not yet controlled (${row.state}).`,
        });
      }
    }

    const notifications = await env.DB.prepare(
      `SELECT notification.notification_id, notification.authority_name
         FROM safety_notifications AS notification
         JOIN safety_occurrences AS occurrence
           ON occurrence.occurrence_id = notification.occurrence_id
          AND occurrence.tenant_id = notification.tenant_id
        WHERE notification.tenant_id = ? AND notification.required = 1
          AND notification.state = 'pending'
          AND (${scopeClause.replace(/scope_type/g, "occurrence.scope_type").replace(/scope_id/g, "occurrence.scope_id")})
        LIMIT 100`,
    )
      .bind(input.tenantId, ...scopeBindings)
      .all<{ notification_id: string; authority_name: string }>();
    for (const row of notifications.results) {
      blockers.push({
        code: "safety_notification_outstanding",
        subject_type: "notification",
        subject_id: row.notification_id,
        detail: `A required notification to ${row.authority_name} is unresolved.`,
      });
    }

    const overdue = await env.DB.prepare(
      `SELECT action.corrective_action_id, action.risk_level, action.due_at
         FROM safety_corrective_actions AS action
         JOIN safety_occurrences AS occurrence
           ON occurrence.occurrence_id = action.occurrence_id
          AND occurrence.tenant_id = action.tenant_id
        WHERE action.tenant_id = ? AND action.risk_level IN ('high', 'critical')
          AND action.state NOT IN ('closed', 'rejected') AND action.due_at < ?
          AND (${scopeClause.replace(/scope_type/g, "occurrence.scope_type").replace(/scope_id/g, "occurrence.scope_id")})
        LIMIT 100`,
    )
      .bind(input.tenantId, input.now, ...scopeBindings)
      .all<{
        corrective_action_id: string;
        risk_level: SafetySeverity;
        due_at: string;
      }>();
    for (const row of overdue.results) {
      blockers.push({
        code: "safety_corrective_action_overdue",
        subject_type: "corrective_action",
        subject_id: row.corrective_action_id,
        detail: `A ${row.risk_level}-risk corrective action was due ${row.due_at}.`,
      });
    }
  }

  if (subjects.length > 0) {
    const placeholders = subjects.map(() => "?").join(", ");
    const equipment = await env.DB.prepare(
      `SELECT equipment_id, equipment_kind, status, inspection_due_at, last_inspection_result
         FROM safety_equipment
        WHERE tenant_id = ? AND assigned_user_id IN (${placeholders})
          AND status NOT IN ('replaced', 'retired')
        LIMIT 200`,
    )
      .bind(input.tenantId, ...subjects)
      .all<{
        equipment_id: string;
        equipment_kind: SafetyEquipmentKind;
        status: SafetyEquipmentStatus;
        inspection_due_at: string | null;
        last_inspection_result: "pass" | "fail" | null;
      }>();
    for (const row of equipment.results) {
      const detail = equipmentUnserviceableDetail(
        row,
        input.now,
        `Assigned ${row.equipment_kind}`,
      );
      if (!detail) continue;
      blockers.push({
        code: "safety_equipment_unserviceable",
        subject_type: "equipment",
        subject_id: row.equipment_id,
        detail,
      });
    }
  }

  return {
    ready: blockers.length === 0,
    blockers,
    scopes,
    evaluated_at: input.now,
  };
}

interface ActiveStopRow {
  occurrence_id: string;
  occurrence_kind: SafetyOccurrenceKind;
  state: SafetyOccurrenceState;
  severity: SafetySeverity;
  reported_at: string;
  summary: string;
  raiser_display_name: string | null;
  /** JSON array of the jobs this stop holds, or NULL when it holds every job of the tenant. */
  held_job_ids: string | null;
}

interface HoldingStopRow extends ActiveStopRow {
  hold: "job" | "tenant";
  held: string[];
}

/** More active stops than this in one tenant fails closed: the read throws, the gate blocks. */
const MAX_ACTIVE_STOPS = 500;

/**
 * Every active stop of the tenant that can hold a job, with the jobs it holds. The rule is A3's
 * Safety-gate predicate, read from the same tables:
 *
 * - a `tenant` stop holds every job, whatever its `scope_id`;
 * - a `roof_job` stop holds its job, or every job when `operating_roof_jobs` has no such job;
 * - a `work_package` stop holds the job of every version of that package, Superseded included,
 *   or every job when `work_packages` has no such package.
 *
 * Shop and vehicle stops hold no job. A lifted stop holds nothing.
 */
async function activeStopRows(env: AppEnv, tenantId: string): Promise<ActiveStopRow[]> {
  const rows = await env.DB.prepare(
    `SELECT occurrence.occurrence_id, occurrence.occurrence_kind, occurrence.state,
            occurrence.severity, occurrence.reported_at, occurrence.summary,
            raiser.display_name AS raiser_display_name,
            CASE
              WHEN occurrence.scope_type = 'roof_job' THEN (
                SELECT json_array(job.roof_job_id)
                  FROM operating_roof_jobs job
                 WHERE job.tenant_id = occurrence.tenant_id
                   AND job.roof_job_id = occurrence.scope_id
              )
              WHEN occurrence.scope_type = 'work_package' THEN (
                SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                            ELSE json_group_array(DISTINCT package.job_id) END
                  FROM work_packages package
                 WHERE package.tenant_id = occurrence.tenant_id
                   AND package.work_package_id = occurrence.scope_id
              )
              ELSE NULL
            END AS held_job_ids
       FROM safety_occurrences occurrence
       LEFT JOIN app_users raiser
         ON raiser.tenant_id = occurrence.tenant_id
        AND raiser.user_id = occurrence.reported_by_user_id
      WHERE occurrence.tenant_id = ? AND occurrence.stop_active = 1
        AND occurrence.scope_type IN ('tenant', 'roof_job', 'work_package')
      ORDER BY occurrence.reported_at ASC, occurrence.occurrence_id ASC
      LIMIT ?`,
  )
    .bind(tenantId, MAX_ACTIVE_STOPS + 1)
    .all<ActiveStopRow>();
  if (rows.results.length > MAX_ACTIVE_STOPS) {
    throw new Error("safety_active_stops_unbounded");
  }
  return rows.results;
}

/** The active stops that hold any of `jobIds`, and every stop that holds the whole tenant. */
async function holdingStopRows(
  env: AppEnv,
  tenantId: string,
  jobIds: readonly string[],
): Promise<HoldingStopRow[]> {
  const wanted = new Set(jobIds);
  return (await activeStopRows(env, tenantId)).flatMap((row): HoldingStopRow[] => {
    if (row.held_job_ids === null) return [{ ...row, hold: "tenant", held: [] }];
    const held = (JSON.parse(row.held_job_ids) as unknown[])
      .filter((id): id is string => typeof id === "string" && wanted.has(id));
    return held.length > 0 ? [{ ...row, hold: "job", held }] : [];
  });
}

function holdingStop(row: HoldingStopRow): SafetyHoldingStop {
  return {
    occurrence_id: row.occurrence_id,
    scope: row.hold,
    reported_at: row.reported_at,
    summary: row.summary,
    raiser_display_name: row.raiser_display_name,
  };
}

/** The jobs a readiness chain stands on: its `roof_job` level and the job of its package level. */
async function chainJobIds(
  env: AppEnv,
  tenantId: string,
  scopes: readonly SafetyScopeRef[],
): Promise<string[]> {
  const jobIds = new Set(
    scopes.filter((scope) => scope.type === "roof_job").map((scope) => scope.id),
  );
  const packageIds = scopes
    .filter((scope) => scope.type === "work_package")
    .map((scope) => scope.id);
  if (packageIds.length > 0) {
    const packages = await env.DB.prepare(
      `SELECT DISTINCT job_id FROM work_packages
        WHERE tenant_id = ? AND work_package_id IN (${packageIds.map(() => "?").join(", ")})`,
    )
      .bind(tenantId, ...packageIds)
      .all<{ job_id: string }>();
    for (const row of packages.results) jobIds.add(row.job_id);
  }
  return [...jobIds];
}

/**
 * For each job, the active stops that hold it, oldest first (by `reported_at`): the stops that name the job or one
 * of its Work Packages (`scope: "job"`), and the stops that hold every job of the tenant
 * (`scope: "tenant"`). Only this tenant's stops are read. Crew Today and job reads carry this, so
 * every phone on a held job sees the stop, not only the raiser's.
 */
export async function holdingSafetyStops(
  env: AppEnv,
  tenantId: string,
  jobIds: readonly string[],
): Promise<Map<string, SafetyHoldingStop[]>> {
  const byJob = new Map<string, SafetyHoldingStop[]>(jobIds.map((id) => [id, []]));
  if (jobIds.length === 0) return byJob;
  for (const row of await holdingStopRows(env, tenantId, jobIds)) {
    const targets = row.hold === "tenant" ? jobIds : row.held;
    for (const jobId of targets) byJob.get(jobId)?.push(holdingStop(row));
  }
  return byJob;
}

export interface RecordReadinessSnapshotInput {
  tenantId: string;
  snapshotId: string;
  scope: SafetyScopeRef;
  consumer: SafetyReadinessConsumer;
  readiness: SafetyReadiness;
  evaluatedByUserId: string;
  now: string;
}

/**
 * Durably records exactly what a release gate saw. The snapshot is immutable:
 * a later release cannot rewrite the record of an earlier refusal.
 */
export async function recordSafetyReadinessSnapshot(
  env: AppEnv,
  input: RecordReadinessSnapshotInput,
): Promise<string> {
  if (
    !OPAQUE_ID.test(input.snapshotId) ||
    !SAFETY_READINESS_CONSUMERS.includes(input.consumer) ||
    !SAFETY_SCOPE_TYPES.includes(input.scope.type) ||
    !SCOPE_ID.test(input.scope.id)
  ) {
    throw new SafetyError(
      "safety_readiness_input_invalid",
      400,
      "Invalid readiness snapshot.",
    );
  }
  const blockersJson = JSON.stringify(input.readiness.blockers);
  const codes = [
    ...new Set(input.readiness.blockers.map((blocker) => blocker.code)),
  ]
    .sort()
    .join(",");
  const digest = await sha256Hex(
    JSON.stringify({
      blockers: input.readiness.blockers,
      consumer: input.consumer,
      evaluated_at: input.now,
      ready: input.readiness.ready,
      scope_id: input.scope.id,
      scope_type: input.scope.type,
      tenant_id: input.tenantId,
    }),
  );
  await env.DB.prepare(
    `INSERT INTO safety_readiness_snapshots
       (snapshot_id, tenant_id, scope_type, scope_id, consumer, ready, blocker_codes,
        blockers_json, snapshot_sha256, evaluated_by_user_id, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      input.snapshotId,
      input.tenantId,
      input.scope.type,
      input.scope.id,
      input.consumer,
      input.readiness.ready ? 1 : 0,
      codes,
      blockersJson,
      digest,
      input.evaluatedByUserId,
      input.now,
    )
    .run();
  return digest;
}

export interface SafetyPanelProjection {
  version: 1;
  actor_role: string;
  assigned_equipment: Array<{
    equipment_id: string;
    equipment_kind: SafetyEquipmentKind;
    serial_number: string;
    status: SafetyEquipmentStatus;
    inspection_due_at: string | null;
  }>;
  open_occurrences: Array<{
    occurrence_id: string;
    occurrence_kind: SafetyOccurrenceKind;
    severity: SafetySeverity;
    state: SafetyOccurrenceState;
    stop_active: boolean;
    scope_type: SafetyScopeType;
    scope_id: string;
    summary: string;
    /** The raiser's name on their account, or null when the account cannot be read. */
    raised_by_display_name: string | null;
    /** When the stop was marked controlled, or null while it is not yet. */
    controlled_at: string | null;
    /** Whether this viewer may release this stop now (L06-aware; see `releaseUnavailableReason`). */
    can_release: boolean;
    release_unavailable_reason: SafetyReleaseUnavailableReason | null;
  }>;
  my_corrective_actions: Array<{
    corrective_action_id: string;
    state: SafetyCorrectiveActionState;
    risk_level: SafetySeverity;
    due_at: string;
    description: string;
  }>;
  /**
   * Capabilities the *current* actor holds. Reporting and make-safe are always
   * present because they are rights; the rest reflect the actor's exact role,
   * so the device never renders a control it cannot use.
   */
  allowed_actions: string[];
}

/**
 * The offline seed for the global safety panel. It is deliberately independent
 * of any current work package or assignment: a worker on an unassigned day must
 * still be able to open this and report.
 */
export async function safetyPanelProjection(
  env: AppEnv,
  tenantId: string,
  userId: string,
  personSession = false,
): Promise<SafetyPanelProjection> {
  const actor = await safetyActor(env, tenantId, userId);
  const viewer: SafetyStopViewer = {
    role: actor.role,
    identities: await userIdentities(env, tenantId, actor.userId),
    personSession,
  };
  const equipment = await env.DB.prepare(
    `SELECT equipment_id, equipment_kind, serial_number, status, inspection_due_at
       FROM safety_equipment
      WHERE tenant_id = ? AND assigned_user_id = ? AND status NOT IN ('replaced', 'retired')
      ORDER BY equipment_kind
      LIMIT 100`,
  )
    .bind(tenantId, userId)
    .all<{
      equipment_id: string;
      equipment_kind: SafetyEquipmentKind;
      serial_number: string;
      status: SafetyEquipmentStatus;
      inspection_due_at: string | null;
    }>();
  // The raiser's account rides along, so the name and the L06 comparison need no second read.
  const occurrences = await env.DB.prepare(
    `SELECT occurrence.occurrence_id, occurrence.occurrence_kind, occurrence.severity,
            occurrence.state, occurrence.stop_active, occurrence.rescue_required,
            occurrence.rescue_completed_at, occurrence.scope_type, occurrence.scope_id,
            occurrence.summary, occurrence.reported_by_user_id,
            raiser.display_name AS raiser_display_name,
            raiser.email_normalized AS raiser_email_normalized,
            raiser.frappe_user_id AS raiser_frappe_user_id,
            (SELECT controlled.occurred_at
               FROM safety_occurrence_events controlled
              WHERE controlled.tenant_id = occurrence.tenant_id
                AND controlled.occurrence_id = occurrence.occurrence_id
                AND controlled.event_kind = 'controlled'
              ORDER BY controlled.occurrence_version DESC
              LIMIT 1) AS controlled_at
       FROM safety_occurrences occurrence
       LEFT JOIN app_users raiser
         ON raiser.tenant_id = occurrence.tenant_id
        AND raiser.user_id = occurrence.reported_by_user_id
      WHERE occurrence.tenant_id = ? AND occurrence.state != 'closed'
      ORDER BY occurrence.reported_at DESC
      LIMIT 50`,
  )
    .bind(tenantId)
    .all<{
      occurrence_id: string;
      occurrence_kind: SafetyOccurrenceKind;
      severity: SafetySeverity;
      state: SafetyOccurrenceState;
      stop_active: number;
      rescue_required: number;
      rescue_completed_at: string | null;
      scope_type: SafetyScopeType;
      scope_id: string;
      summary: string;
      reported_by_user_id: string;
      raiser_display_name: string | null;
      raiser_email_normalized: string | null;
      raiser_frappe_user_id: string | null;
      controlled_at: string | null;
    }>();
  const actions = await env.DB.prepare(
    `SELECT corrective_action_id, state, risk_level, due_at, description
       FROM safety_corrective_actions
      WHERE tenant_id = ? AND owner_user_id = ? AND state NOT IN ('closed', 'rejected')
      ORDER BY due_at
      LIMIT 50`,
  )
    .bind(tenantId, userId)
    .all<{
      corrective_action_id: string;
      state: SafetyCorrectiveActionState;
      risk_level: SafetySeverity;
      due_at: string;
      description: string;
    }>();
  return {
    version: 1,
    actor_role: actor.role,
    assigned_equipment: equipment.results,
    open_occurrences: occurrences.results.map((row) => {
      const reason = releaseUnavailableReason(
        row,
        raiserIdentities(row.reported_by_user_id, {
          email_normalized: row.raiser_email_normalized,
          frappe_user_id: row.raiser_frappe_user_id,
        }),
        viewer,
      );
      return {
        occurrence_id: row.occurrence_id,
        occurrence_kind: row.occurrence_kind,
        severity: row.severity,
        state: row.state,
        stop_active: row.stop_active === 1,
        scope_type: row.scope_type,
        scope_id: row.scope_id,
        summary: row.summary,
        raised_by_display_name: row.raiser_display_name,
        controlled_at: row.controlled_at,
        can_release: reason === null,
        release_unavailable_reason: reason,
      };
    }),
    my_corrective_actions: actions.results,
    allowed_actions: [
      "safety.report_occurrence",
      "safety.make_safe",
      "safety.equipment_defect",
      "safety.rescue_request",
      ...(EQUIPMENT_AUTHORITY_ROLES.has(actor.role)
        ? ["safety.equipment_inspect"]
        : []),
      ...(RESPONSE_AUTHORITY_ROLES.has(actor.role)
        ? [
            "safety.rescue_command",
            "safety.release",
            "safety.verify_corrective_action",
          ]
        : []),
      ...(NOTIFICATION_AUTHORITY_ROLES.has(actor.role)
        ? ["safety.notify_authority"]
        : []),
    ],
  };
}

export async function listSafetyOccurrenceEvents(
  env: AppEnv,
  tenantId: string,
  occurrenceId: string,
  limit = 50,
): Promise<
  Array<{
    event_id: string;
    occurrence_version: number;
    event_kind: string;
    actor_user_id: string;
    actor_role: string;
    detail: string;
    captured_offline: number;
    occurred_at: string;
    recorded_at: string;
  }>
> {
  if (!TENANT_ID.test(tenantId) || !OPAQUE_ID.test(occurrenceId)) return [];
  const bounded = Number.isInteger(limit)
    ? Math.max(1, Math.min(200, limit))
    : 50;
  const rows = await env.DB.prepare(
    `SELECT event_id, occurrence_version, event_kind, actor_user_id, actor_role, detail,
            captured_offline, occurred_at, recorded_at
       FROM safety_occurrence_events
      WHERE tenant_id = ? AND occurrence_id = ?
      ORDER BY occurrence_version DESC, recorded_at DESC
      LIMIT ?`,
  )
    .bind(tenantId, occurrenceId, bounded)
    .all<{
      event_id: string;
      occurrence_version: number;
      event_kind: string;
      actor_user_id: string;
      actor_role: string;
      detail: string;
      captured_offline: number;
      occurred_at: string;
      recorded_at: string;
    }>();
  return rows.results;
}

export async function getSafetyOccurrence(
  env: AppEnv,
  tenantId: string,
  occurrenceId: string,
): Promise<SafetyOccurrenceRecord | null> {
  if (!TENANT_ID.test(tenantId) || !OPAQUE_ID.test(occurrenceId)) return null;
  return await occurrenceById(env, tenantId, occurrenceId);
}

/**
 * Why this viewer cannot release this stop right now, in the order the release checks run, or
 * null when they can. Only the release itself decides; this is the same rule read ahead of time so
 * a screen never offers a release the Worker will refuse, and never offers it to the raiser.
 *
 * - `stop_released`: the stop is no longer active.
 * - `person_session_required`: the viewer is not a person in their own signed-in session.
 * - `release_authority_required`: the viewer's role is not owner, ops or production.
 * - `raised_by_viewer`: the viewer raised the stop, under any identity either carries (L06).
 * - `not_controlled`: the stop has not been marked controlled yet.
 * - `rescue_not_completed`: a required rescue is not recorded as completed.
 */
export type SafetyReleaseUnavailableReason =
  | "stop_released"
  | "person_session_required"
  | "release_authority_required"
  | "raised_by_viewer"
  | "not_controlled"
  | "rescue_not_completed";

export interface SafetyStopViewer {
  role: string;
  identities: Set<string>;
  personSession: boolean;
}

export function releaseUnavailableReason(
  occurrence: Pick<
    SafetyOccurrenceRecord,
    "stop_active" | "state" | "rescue_required" | "rescue_completed_at"
  >,
  raiser: Set<string>,
  viewer: SafetyStopViewer,
): SafetyReleaseUnavailableReason | null {
  if (occurrence.stop_active !== 1) return "stop_released";
  if (!viewer.personSession) return "person_session_required";
  if (!RESPONSE_AUTHORITY_ROLES.has(viewer.role)) return "release_authority_required";
  if ([...viewer.identities].some((identity) => raiser.has(identity))) return "raised_by_viewer";
  if (occurrence.state !== "controlled") return "not_controlled";
  if (occurrence.rescue_required === 1 && !occurrence.rescue_completed_at) {
    return "rescue_not_completed";
  }
  return null;
}

/** The raiser's identities from an already-read account row, folded as `userIdentities` folds them. */
function raiserIdentities(
  userId: string,
  account: { email_normalized: string | null; frappe_user_id: string | null },
): Set<string> {
  const identities = new Set([userId.trim().toLowerCase()]);
  if (account.email_normalized !== null) {
    for (const identity of appUserIdentities({
      user_id: userId,
      email_normalized: account.email_normalized,
      frappe_user_id: account.frappe_user_id,
    })) {
      identities.add(identity);
    }
  }
  return identities;
}

/** One step a stop has taken: when it happened, who recorded it, and what they wrote. */
export interface SafetyLifecycleStep {
  at: string;
  by_user_id: string;
  by_display_name: string | null;
  detail: string;
}

/**
 * The visible steps of a stop, each null until it happens: raised, made safe, investigation opened,
 * controlled (the fix is in place and checked; the stop stays on), released (the stop is lifted)
 * and closed. Each step is the event that moved the occurrence there, so a stop lifted before 0165
 * still shows who released it.
 */
/** Made safe also names who confirmed it on site, when someone else recorded it (0170). */
export interface SafetyMadeSafeStep extends SafetyLifecycleStep {
  confirmed_by_user_id: string | null;
  confirmed_by_display_name: string | null;
}

export interface SafetyStopLifecycle {
  reported: SafetyLifecycleStep | null;
  made_safe: SafetyMadeSafeStep | null;
  investigating: SafetyLifecycleStep | null;
  controlled: SafetyLifecycleStep | null;
  released: SafetyLifecycleStep | null;
  closed: SafetyLifecycleStep | null;
}

const LIFECYCLE_STEP_BY_EVENT: Record<string, keyof SafetyStopLifecycle> = {
  reported: "reported",
  make_safe: "made_safe",
  investigation_opened: "investigating",
  controlled: "controlled",
  released: "released",
  closed: "closed",
};

/** A "Keep the stop" decision: history only, it changed nothing on the stop. */
export interface SafetyStopKeepDecision {
  keep_id: string;
  occurrence_id: string;
  occurrence_version: number;
  kept_by_user_id: string;
  kept_by_display_name: string | null;
  kept_by_role: string;
  reason: string;
  kept_at: string;
}

export interface SafetyOccurrenceDetail {
  version: 1;
  occurrence: SafetyOccurrenceRecord;
  raised_by_display_name: string | null;
  lifecycle: SafetyStopLifecycle;
  /** Every "Keep the stop" decision on this stop, newest first. */
  keep_decisions: SafetyStopKeepDecision[];
  can_release: boolean;
  release_unavailable_reason: SafetyReleaseUnavailableReason | null;
}

const KEEP_COLUMNS = `keep.keep_id, keep.occurrence_id, keep.occurrence_version,
  keep.kept_by_user_id, keeper.display_name AS kept_by_display_name, keep.kept_by_role,
  keep.reason, keep.kept_at`;

async function stopKeepDecisions(
  env: AppEnv,
  tenantId: string,
  occurrenceId: string,
): Promise<SafetyStopKeepDecision[]> {
  const rows = await env.DB.prepare(
    `SELECT ${KEEP_COLUMNS}
       FROM safety_stop_keep_decisions keep
       LEFT JOIN app_users keeper
         ON keeper.tenant_id = keep.tenant_id AND keeper.user_id = keep.kept_by_user_id
      WHERE keep.tenant_id = ? AND keep.occurrence_id = ?
      ORDER BY keep.kept_at DESC, keep.keep_id DESC
      LIMIT 50`,
  )
    .bind(tenantId, occurrenceId)
    .all<SafetyStopKeepDecision>();
  return rows.results.map((row) => ({ ...row }));
}

export interface KeepSafetyStopInput {
  tenantId: string;
  occurrenceId: string;
  actorUserId: string;
  /** The version the person reviewed; the decision is refused if the stop has moved since. */
  occurrenceVersion: number;
  reason: string;
  idempotencyKey: string;
}

/**
 * "Keep the stop" (P33): a person who may release this stop decides not to, and says why. It is
 * recorded to the stop's history only and changes nothing on the occurrence. The same checks as a
 * release decide who may record it: release authority, never the raiser under any identity, and
 * the stop still active at the version they reviewed. The record's time is D1's clock. A replay of
 * the same idempotency key with the same request returns the first answer; a different request
 * under that key is a conflict.
 */
export async function keepSafetyStop(
  env: AppEnv,
  input: KeepSafetyStopInput,
): Promise<{ replayed: boolean; keep: SafetyStopKeepDecision }> {
  if (
    !journalDetail(input.reason) ||
    !Number.isInteger(input.occurrenceVersion) ||
    input.occurrenceVersion < 1 ||
    input.occurrenceVersion > 1_000_000
  ) {
    throw new SafetyError(
      "safety_stop_keep_invalid",
      400,
      "Keeping a stop needs the version you reviewed and a reason of 3 to 4000 characters.",
    );
  }
  const requestSha256 = await sha256Hex(
    JSON.stringify({
      occurrence_id: input.occurrenceId,
      occurrence_version: input.occurrenceVersion,
      reason: input.reason,
      user_id: input.actorUserId,
    }),
  );
  const keepId = `ssk_${(await sha256Hex(`${input.tenantId}:${input.idempotencyKey}:stop-keep`)).slice(0, 32)}`;
  const replay = await keepById(env, input.tenantId, keepId);
  if (replay) return replayedKeep(env, input.tenantId, keepId, requestSha256);

  const actor = await safetyActor(env, input.tenantId, input.actorUserId);
  requireRole(
    actor,
    RESPONSE_AUTHORITY_ROLES,
    "safety_release_authority_required",
    "Keeping or releasing a safety stop requires current production authority.",
  );
  const occurrence = await requireOccurrence(env, input.tenantId, input.occurrenceId);
  const raiser = await userIdentities(env, input.tenantId, occurrence.reported_by_user_id);
  const keeper = await userIdentities(env, input.tenantId, actor.userId);
  if ([...keeper].some((identity) => raiser.has(identity))) {
    throw new SafetyError(
      "safety_stop_release_by_raiser_forbidden",
      403,
      "The person who raised a safety stop never decides its release.",
    );
  }
  if (occurrence.stop_active !== 1) {
    throw new SafetyError("safety_stop_already_released", 409, "This stop has already been released.");
  }
  if (occurrence.version !== input.occurrenceVersion) {
    throw new SafetyError(
      "safety_occurrence_version_conflict",
      409,
      "This stop changed after you reviewed it. Review it again.",
    );
  }
  try {
    await env.DB.prepare(
      `INSERT INTO safety_stop_keep_decisions
         (keep_id, tenant_id, idempotency_key, request_sha256, occurrence_id, occurrence_version,
          kept_by_user_id, kept_by_role, reason, kept_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
      .bind(keepId, input.tenantId, input.idempotencyKey, requestSha256, input.occurrenceId,
        input.occurrenceVersion, actor.userId, actor.role, input.reason)
      .run();
  } catch (error) {
    // A concurrent retry under the same key won; anything else is D1 refusing what changed.
    if (await keepById(env, input.tenantId, keepId)) {
      return replayedKeep(env, input.tenantId, keepId, requestSha256);
    }
    throw keepRefusal(error);
  }
  const stored = await keepById(env, input.tenantId, keepId);
  if (!stored) throw new Error("safety_stop_keep_readback_missing");
  const { request_sha256: _hash, ...keep } = stored;
  return { replayed: false, keep };
}

async function keepById(
  env: AppEnv,
  tenantId: string,
  keepId: string,
): Promise<(SafetyStopKeepDecision & { request_sha256: string }) | null> {
  const row = await env.DB.prepare(
    `SELECT ${KEEP_COLUMNS}, keep.request_sha256
       FROM safety_stop_keep_decisions keep
       LEFT JOIN app_users keeper
         ON keeper.tenant_id = keep.tenant_id AND keeper.user_id = keep.kept_by_user_id
      WHERE keep.tenant_id = ? AND keep.keep_id = ?`,
  )
    .bind(tenantId, keepId)
    .first<SafetyStopKeepDecision & { request_sha256: string }>();
  return row ? { ...row } : null;
}

async function replayedKeep(
  env: AppEnv,
  tenantId: string,
  keepId: string,
  requestSha256: string,
): Promise<{ replayed: boolean; keep: SafetyStopKeepDecision }> {
  const row = await keepById(env, tenantId, keepId);
  if (!row) throw new Error("safety_stop_keep_readback_missing");
  if (row.request_sha256 !== requestSha256) {
    throw new SafetyError(
      "idempotency_conflict",
      409,
      "This idempotency key was already used for a different decision.",
    );
  }
  const { request_sha256: _hash, ...keep } = row;
  return { replayed: true, keep };
}

/** D1's refusals of a keep decision, as the named codes the Worker gives the same facts. */
function keepRefusal(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const refusals: Array<[string, number, string]> = [
    ["safety_stop_release_by_raiser_forbidden", 403, "The person who raised a safety stop never decides its release."],
    ["safety_actor_unknown", 403, "This safety actor is not recognized."],
    ["safety_stop_already_released", 409, "This stop has already been released."],
    ["safety_occurrence_version_conflict", 409, "This stop changed after you reviewed it. Review it again."],
  ];
  const refusal = refusals.find(([code]) => message.includes(code));
  return refusal ? new SafetyError(refusal[0], refusal[1], refusal[2]) : error;
}

/**
 * The stop detail read: the raw occurrence, the raiser's name, every lifecycle step, and whether
 * this viewer may release it now. Any authenticated role may read any occurrence of the tenant.
 */
export async function safetyOccurrenceDetail(
  env: AppEnv,
  tenantId: string,
  viewerUserId: string,
  occurrenceId: string,
  personSession: boolean,
): Promise<SafetyOccurrenceDetail | null> {
  if (!TENANT_ID.test(tenantId) || !OPAQUE_ID.test(occurrenceId)) return null;
  const actor = await safetyActor(env, tenantId, viewerUserId);
  const occurrence = await occurrenceById(env, tenantId, occurrenceId);
  if (!occurrence) return null;
  const raiser = await env.DB.prepare(
    `SELECT display_name, email_normalized, frappe_user_id
       FROM app_users WHERE tenant_id = ? AND user_id = ?`,
  )
    .bind(tenantId, occurrence.reported_by_user_id)
    .first<{ display_name: string; email_normalized: string; frappe_user_id: string | null }>();
  const steps = await env.DB.prepare(
    `SELECT event.event_kind, event.occurred_at, event.actor_user_id, event.detail,
            actor.display_name AS actor_display_name, event.confirmed_by_user_id,
            confirmer.display_name AS confirmer_display_name
       FROM safety_occurrence_events event
       LEFT JOIN app_users actor
         ON actor.tenant_id = event.tenant_id AND actor.user_id = event.actor_user_id
       LEFT JOIN app_users confirmer
         ON confirmer.tenant_id = event.tenant_id AND confirmer.user_id = event.confirmed_by_user_id
      WHERE event.tenant_id = ? AND event.occurrence_id = ?
        AND event.event_kind IN ('reported', 'make_safe', 'investigation_opened', 'controlled',
          'released', 'closed')
      ORDER BY event.occurrence_version ASC, event.recorded_at ASC`,
  )
    .bind(tenantId, occurrenceId)
    .all<{
      event_kind: string;
      occurred_at: string;
      actor_user_id: string;
      detail: string;
      actor_display_name: string | null;
      confirmed_by_user_id: string | null;
      confirmer_display_name: string | null;
    }>();
  const lifecycle: SafetyStopLifecycle = {
    reported: null,
    made_safe: null,
    investigating: null,
    controlled: null,
    released: null,
    closed: null,
  };
  for (const row of steps.results) {
    const step = LIFECYCLE_STEP_BY_EVENT[row.event_kind];
    // Every transition is one-way, so each step happens once; the first record is the step.
    if (!step || lifecycle[step]) continue;
    const recorded: SafetyLifecycleStep = {
      at: row.occurred_at,
      by_user_id: row.actor_user_id,
      by_display_name: row.actor_display_name,
      detail: row.detail,
    };
    if (step === "made_safe") {
      lifecycle.made_safe = {
        ...recorded,
        confirmed_by_user_id: row.confirmed_by_user_id,
        confirmed_by_display_name: row.confirmed_by_user_id ? row.confirmer_display_name : null,
      };
    } else {
      lifecycle[step] = recorded;
    }
  }
  const reason = releaseUnavailableReason(
    occurrence,
    raiserIdentities(occurrence.reported_by_user_id, {
      email_normalized: raiser?.email_normalized ?? null,
      frappe_user_id: raiser?.frappe_user_id ?? null,
    }),
    {
      role: actor.role,
      identities: await userIdentities(env, tenantId, actor.userId),
      personSession,
    },
  );
  return {
    version: 1,
    occurrence,
    raised_by_display_name: raiser?.display_name ?? null,
    lifecycle,
    keep_decisions: await stopKeepDecisions(env, tenantId, occurrenceId),
    can_release: reason === null,
    release_unavailable_reason: reason,
  };
}

export async function getSafetyEquipment(
  env: AppEnv,
  tenantId: string,
  equipmentId: string,
): Promise<SafetyEquipmentRecord | null> {
  if (!TENANT_ID.test(tenantId) || !OPAQUE_ID.test(equipmentId)) return null;
  return await equipmentById(env, tenantId, equipmentId);
}

export async function safetyCorrectiveActionProjection(
  env: AppEnv,
  tenantId: string,
  userId: string,
  correctiveActionId: string,
) {
  const actor = await safetyActor(env, tenantId, userId);
  const action = await requireCorrectiveAction(
    env,
    tenantId,
    correctiveActionId,
  );
  const occurrence = await requireOccurrence(
    env,
    tenantId,
    action.occurrence_id,
  );
  const authority = RESPONSE_AUTHORITY_ROLES.has(actor.role);
  const independent =
    actor.userId !== action.owner_user_id &&
    actor.userId !== action.evidence_captured_by_user_id &&
    actor.userId !== occurrence.reported_by_user_id;
  return {
    version: 1 as const,
    corrective_action: action,
    allowed_actions: [
      ...(action.state === "open" ? ["submit_evidence" as const] : []),
      ...(action.state === "evidence_submitted" && authority && independent
        ? ["verify" as const, "reject" as const]
        : []),
      ...(action.state === "verified" && authority ? ["close" as const] : []),
    ],
    verification_unavailable_reason:
      action.state !== "evidence_submitted"
        ? null
        : !authority
          ? "Verifying a corrective action requires current production authority."
          : !independent
            ? "The reporter, owner, and evidence capturer cannot verify this closure."
            : null,
  };
}

export async function getSafetyCorrectiveAction(
  env: AppEnv,
  tenantId: string,
  correctiveActionId: string,
): Promise<SafetyCorrectiveActionRecord | null> {
  if (!TENANT_ID.test(tenantId) || !OPAQUE_ID.test(correctiveActionId))
    return null;
  return await correctiveActionById(env, tenantId, correctiveActionId);
}

/**
 * Stable identity for a physical event, so a duplicate offline report of the
 * same hazard by the same person at the same instant converges rather than
 * inflating the incident count.
 */
export async function occurrenceFingerprint(input: {
  tenantId: string;
  occurrenceKind: SafetyOccurrenceKind;
  scope: SafetyScopeRef;
  reportedByUserId: string;
  reportedAt: string;
  summary: string;
}): Promise<string> {
  return await sha256Hex(
    JSON.stringify({
      occurrence_kind: input.occurrenceKind,
      reported_at: input.reportedAt,
      reported_by_user_id: input.reportedByUserId,
      scope_id: input.scope.id,
      scope_type: input.scope.type,
      summary: input.summary.trim(),
      tenant_id: input.tenantId,
    }),
  );
}

interface AdvanceOccurrenceInput {
  version: number;
  state: SafetyOccurrenceState;
  stopActive: number;
  severity: SafetySeverity;
  rescueRequired: number;
  rescueCompletedAt: string | null;
  closedAt: string | null;
  releasedByUserId: string | null;
  now: string;
}

/**
 * Moves an occurrence one version forward in the same batch as the event that
 * records why. The event row goes first, and only while the occurrence still
 * holds the version this command read; then the occurrence leaves that version.
 * Both commit or neither does, so no transition stands without its journal
 * entry, and 0165 can require a lift's own `released` event before the stop drops.
 */
async function advanceOccurrence(
  env: AppEnv,
  occurrence: SafetyOccurrenceRecord,
  next: AdvanceOccurrenceInput,
  event: OccurrenceEventRow,
): Promise<void> {
  assertEvidence(event.evidence);
  let results: Array<{ meta?: { changes?: number } }>;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO safety_occurrence_events (${occurrenceEventColumns(event).columns})
         SELECT ${occurrenceEventColumns(event).placeholders}
          WHERE EXISTS (
            SELECT 1 FROM safety_occurrences
             WHERE tenant_id = ? AND occurrence_id = ? AND version = ?
          )`,
      ).bind(
        ...occurrenceEventValues(event),
        occurrence.tenant_id,
        occurrence.occurrence_id,
        occurrence.version,
      ),
      env.DB.prepare(
        `UPDATE safety_occurrences
            SET version = ?, state = ?, stop_active = ?, severity = ?, rescue_required = ?,
                rescue_completed_at = ?, closed_at = ?, released_by_user_id = ?, updated_at = ?
          WHERE tenant_id = ? AND occurrence_id = ? AND version = ?`,
      ).bind(
        next.version,
        next.state,
        next.stopActive,
        next.severity,
        next.rescueRequired,
        next.rescueCompletedAt,
        next.closedAt,
        next.releasedByUserId,
        next.now,
        occurrence.tenant_id,
        occurrence.occurrence_id,
        occurrence.version,
      ),
    ]);
  } catch (error) {
    throw guardRefusal(error);
  }
  // The insert is held to the same version as the update, so neither wrote when this is not 1.
  if (d1Changes(results[1] ?? {}) !== 1) {
    throw new SafetyError(
      "safety_occurrence_version_conflict",
      409,
      "This occurrence changed while the command was applied.",
    );
  }
}

/**
 * The two D1 refusals this batch can meet after the checks above passed, because
 * a person changed in between: 0165's raiser check, and 0047's event actor check,
 * which answers `safety_actor_unknown` for a person deactivated or moved to another
 * role. 0047's authority clauses compare the role recorded here, which always holds
 * authority, so they never fire on this batch. Anything else stays a store fault.
 *
 * Keep the raiser mapping. The Worker's comparison folds every identity with JS
 * `trim()` and `toLowerCase()`, a superset of D1's space-only `trim` and ASCII-only
 * `lower`, so D1 never refuses a raiser the Worker passed from the same rows. It
 * still does when an identity changes between the read and this batch. Without
 * the mapping, that refusal becomes a 502. The test "an identity that changes
 * after the Worker's check" in safety-stop-release.test.ts pins this.
 */
function guardRefusal(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const refusals: Array<[string, string]> = [
    ["safety_stop_release_by_raiser_forbidden", "The person who raised a safety stop can never release it."],
    ["safety_actor_unknown", "This safety actor is not recognized."],
  ];
  const refusal = refusals.find(([code]) => message.includes(code));
  return refusal ? new SafetyError(refusal[0], 403, refusal[1]) : error;
}

interface OccurrenceEventRow {
  eventId: string;
  tenantId: string;
  occurrenceId: string;
  occurrenceVersion: number;
  eventKind: string;
  actorUserId: string;
  actorRole: string;
  detail: string;
  evidence: SafetyEvidence | null;
  capturedOffline: boolean;
  occurredAt: string;
  recordedAt: string;
  deviceActionId: string | null;
  /** `make_safe` only: the named on-site confirmer (0170). */
  confirmedByUserId?: string | null;
}

const OCCURRENCE_EVENT_COLUMNS = `event_id, tenant_id, occurrence_id, occurrence_version,
  event_kind, actor_user_id, actor_role, detail, evidence_refs_json, evidence_sha256,
  captured_offline, occurred_at, recorded_at, device_action_id`;

/** The event columns this row writes: the confirmer column (0170) only when a confirmer is named. */
function occurrenceEventColumns(row: OccurrenceEventRow): { columns: string; placeholders: string } {
  const confirmed = row.confirmedByUserId != null;
  const count = confirmed ? 15 : 14;
  return {
    columns: confirmed ? `${OCCURRENCE_EVENT_COLUMNS}, confirmed_by_user_id` : OCCURRENCE_EVENT_COLUMNS,
    placeholders: Array.from({ length: count }, () => "?").join(", "),
  };
}

function occurrenceEventValues(row: OccurrenceEventRow): unknown[] {
  return [
    row.eventId,
    row.tenantId,
    row.occurrenceId,
    row.occurrenceVersion,
    row.eventKind,
    row.actorUserId,
    row.actorRole,
    row.detail,
    row.evidence?.refsJson ?? null,
    row.evidence?.sha256 ?? null,
    row.capturedOffline ? 1 : 0,
    row.occurredAt,
    row.recordedAt,
    row.deviceActionId,
    ...(row.confirmedByUserId != null ? [row.confirmedByUserId] : []),
  ];
}

async function appendOccurrenceEventRow(
  env: AppEnv,
  row: OccurrenceEventRow,
): Promise<void> {
  assertEvidence(row.evidence);
  await env.DB.prepare(
    `INSERT INTO safety_occurrence_events (${occurrenceEventColumns(row).columns})
     VALUES (${occurrenceEventColumns(row).placeholders})
     ON CONFLICT DO NOTHING`,
  )
    .bind(...occurrenceEventValues(row))
    .run();
}

interface EquipmentEventRow {
  eventId: string;
  tenantId: string;
  equipmentId: string;
  equipmentVersion: number;
  eventKind: string;
  actorUserId: string;
  actorRole: string;
  detail: string;
  evidence: SafetyEvidence | null;
  occurredAt: string;
  recordedAt: string;
  deviceActionId: string | null;
}

async function appendEquipmentEventRow(
  env: AppEnv,
  row: EquipmentEventRow,
): Promise<void> {
  assertEvidence(row.evidence);
  await env.DB.prepare(
    `INSERT INTO safety_equipment_events
       (event_id, tenant_id, equipment_id, equipment_version, event_kind, actor_user_id,
        actor_role, detail, evidence_refs_json, evidence_sha256, occurred_at, recorded_at,
        device_action_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      row.eventId,
      row.tenantId,
      row.equipmentId,
      row.equipmentVersion,
      row.eventKind,
      row.actorUserId,
      row.actorRole,
      row.detail,
      row.evidence?.refsJson ?? null,
      row.evidence?.sha256 ?? null,
      row.occurredAt,
      row.recordedAt,
      row.deviceActionId,
    )
    .run();
}

interface CorrectiveActionEventRow {
  eventId: string;
  tenantId: string;
  correctiveActionId: string;
  correctiveActionVersion: number;
  eventKind: string;
  actorUserId: string;
  actorRole: string;
  detail: string;
  recordedAt: string;
}

async function appendCorrectiveActionEventRow(
  env: AppEnv,
  row: CorrectiveActionEventRow,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO safety_corrective_action_events
       (event_id, tenant_id, corrective_action_id, corrective_action_version, event_kind,
        actor_user_id, actor_role, detail, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      row.eventId,
      row.tenantId,
      row.correctiveActionId,
      row.correctiveActionVersion,
      row.eventKind,
      row.actorUserId,
      row.actorRole,
      row.detail,
      row.recordedAt,
    )
    .run();
}

function assertEvidence(evidence: SafetyEvidence | null): void {
  if (!evidence) return;
  if (
    !SHA256.test(evidence.sha256) ||
    !validEvidenceRefsJson(evidence.refsJson)
  ) {
    throw new SafetyError(
      "safety_evidence_invalid",
      400,
      "Safety evidence must carry hashed immutable references.",
    );
  }
}

export function validEvidenceRefsJson(value: string, allowUploadedReceipts = false): boolean {
  if (typeof value !== "string" || value.length < 2 || value.length > 20_000)
    return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100)
      return false;
    return parsed.every((entry) => {
      if (!isRecord(entry)) return false;
      const ref = entry.ref;
      const sha256 = entry.sha256;
      if (
        typeof ref !== "string" ||
        typeof sha256 !== "string" ||
        !SHA256.test(sha256)
      ) {
        return false;
      }
      return (
        ref.trim().length >= 3 &&
        ref.trim().length <= 512 &&
        (isReservedEvidenceUploadReference(ref)
          ? allowUploadedReceipts && /^evidence-upload:\/\/evu_[0-9a-f]{64}$/.test(ref)
          : true) &&
        !/[\u0000-\u001f]/.test(ref)
      );
    });
  } catch {
    return false;
  }
}

function assertReportInput(input: ReportSafetyOccurrenceInput): void {
  if (
    !TENANT_ID.test(input.tenantId) ||
    !OPAQUE_ID.test(input.occurrenceId) ||
    !SAFETY_OCCURRENCE_KINDS.includes(input.occurrenceKind) ||
    !SAFETY_SEVERITIES.includes(input.severity) ||
    !SAFETY_SCOPE_TYPES.includes(input.scope.type) ||
    !SCOPE_ID.test(input.scope.id) ||
    !USER_ID.test(input.reportedByUserId) ||
    !ISO_INSTANT.test(input.reportedAt) ||
    !ISO_INSTANT.test(input.now) ||
    !boundedText(input.summary, 3, 4000) ||
    (input.deviceActionId !== null && !OPAQUE_ID.test(input.deviceActionId))
  ) {
    throw new SafetyError(
      "safety_occurrence_input_invalid",
      400,
      "Invalid safety-occurrence report.",
    );
  }
  assertEvidence(input.evidence);
}

async function occurrenceById(
  env: AppEnv,
  tenantId: string,
  occurrenceId: string,
): Promise<SafetyOccurrenceRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM safety_occurrences WHERE tenant_id = ? AND occurrence_id = ? LIMIT 1`,
  )
    .bind(tenantId, occurrenceId)
    .first<SafetyOccurrenceRecord>();
}

async function occurrenceByFingerprint(
  env: AppEnv,
  tenantId: string,
  fingerprint: string,
): Promise<SafetyOccurrenceRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM safety_occurrences
      WHERE tenant_id = ? AND report_fingerprint_sha256 = ? LIMIT 1`,
  )
    .bind(tenantId, fingerprint)
    .first<SafetyOccurrenceRecord>();
}

async function requireOccurrence(
  env: AppEnv,
  tenantId: string,
  occurrenceId: string,
): Promise<SafetyOccurrenceRecord> {
  const occurrence = await occurrenceById(env, tenantId, occurrenceId);
  if (!occurrence) {
    throw new SafetyError(
      "safety_occurrence_not_found",
      404,
      "That safety occurrence is unknown.",
    );
  }
  return occurrence;
}

async function equipmentById(
  env: AppEnv,
  tenantId: string,
  equipmentId: string,
): Promise<SafetyEquipmentRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM safety_equipment WHERE tenant_id = ? AND equipment_id = ? LIMIT 1`,
  )
    .bind(tenantId, equipmentId)
    .first<SafetyEquipmentRecord>();
}

async function requireEquipment(
  env: AppEnv,
  tenantId: string,
  equipmentId: string,
): Promise<SafetyEquipmentRecord> {
  const equipment = await equipmentById(env, tenantId, equipmentId);
  if (!equipment) {
    throw new SafetyError(
      "safety_equipment_not_found",
      404,
      "That safety equipment is unknown.",
    );
  }
  return equipment;
}

async function notificationById(
  env: AppEnv,
  tenantId: string,
  notificationId: string,
): Promise<SafetyNotificationRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM safety_notifications WHERE tenant_id = ? AND notification_id = ? LIMIT 1`,
  )
    .bind(tenantId, notificationId)
    .first<SafetyNotificationRecord>();
}

async function requireNotification(
  env: AppEnv,
  tenantId: string,
  notificationId: string,
): Promise<SafetyNotificationRecord> {
  const notification = await notificationById(env, tenantId, notificationId);
  if (!notification) {
    throw new SafetyError(
      "safety_notification_not_found",
      404,
      "That safety notification is unknown.",
    );
  }
  return notification;
}

async function correctiveActionById(
  env: AppEnv,
  tenantId: string,
  correctiveActionId: string,
): Promise<SafetyCorrectiveActionRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM safety_corrective_actions
      WHERE tenant_id = ? AND corrective_action_id = ? LIMIT 1`,
  )
    .bind(tenantId, correctiveActionId)
    .first<SafetyCorrectiveActionRecord>();
}

async function requireCorrectiveAction(
  env: AppEnv,
  tenantId: string,
  correctiveActionId: string,
): Promise<SafetyCorrectiveActionRecord> {
  const action = await correctiveActionById(env, tenantId, correctiveActionId);
  if (!action) {
    throw new SafetyError(
      "safety_corrective_action_not_found",
      404,
      "That corrective action is unknown.",
    );
  }
  return action;
}

/**
 * Event ids are derived, not random, so a retried command re-inserts the same
 * row instead of appending a second copy of the same fact.
 */
function derivedEventId(
  prefix: string,
  aggregateId: string,
  version: number,
  kind: string,
): string {
  const slug = `${prefix}_${aggregateId}_${version}_${kind}`.replace(
    /[^A-Za-z0-9._:-]/g,
    "-",
  );
  const id = slug.length > 160 ? slug.slice(0, 160) : slug;
  if (!EVENT_ID.test(id)) {
    throw new SafetyError(
      "safety_event_identity_invalid",
      400,
      "Invalid safety event identity.",
    );
  }
  return id;
}

function boundedText(
  value: unknown,
  min: number,
  max: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= min &&
    value.trim().length <= max &&
    !/[\u0000-\u001f]/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function d1Changes(result: { meta?: { changes?: number } }): number {
  return Number(result.meta?.changes ?? 0);
}

/** How far ahead the desk warns about an inspection that has not expired yet.
 *  Desk-only: the release gate stops work at expiry, never before it. */
export const SAFETY_INSPECTION_EXPIRING_DAYS = 30;

export interface SafetyDeskEquipment {
  equipment_id: string;
  equipment_kind: SafetyEquipmentKind;
  serial_number: string;
  status: SafetyEquipmentStatus;
  assigned_user_id: string | null;
  inspection_due_at: string | null;
  last_inspection_result: "pass" | "fail" | null;
  /** "unserviceable" is exactly what stops a release; "expiring" never is. */
  verdict: "serviceable" | "unserviceable" | "expiring";
  /** The release gate's own sentence, so the desk cannot describe it differently. */
  detail: string | null;
  days_left: number | null;
}

export interface SafetyDeskCorrectiveAction {
  corrective_action_id: string;
  occurrence_id: string;
  state: SafetyCorrectiveActionState;
  risk_level: SafetySeverity;
  owner_user_id: string;
  due_at: string;
  description: string;
  /** True only when this action is what the release gate refuses on. */
  blocking: boolean;
  days_left: number;
}

export interface SafetyDeskProjection {
  version: 1;
  read_model_generated_at: string;
  expiring_within_days: number;
  actor_role: string;
  /** null, not [], when this role may not read the rail: "none on file" and
   *  "you may not see this" are different answers and must not look alike. */
  equipment: SafetyDeskEquipment[] | null;
  corrective_actions: SafetyDeskCorrectiveAction[] | null;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/** The whole company's safety equipment and corrective actions, judged by the release gate's
 *  own rules. Read-only: every state change on these rails goes through its own command. */
export async function safetyDeskProjection(
  env: AppEnv,
  tenantId: string,
  userId: string,
  now: string,
): Promise<SafetyDeskProjection> {
  if (!ISO_INSTANT.test(now)) {
    throw new SafetyError(
      "safety_desk_input_invalid",
      400,
      "Invalid desk input.",
    );
  }
  const actor = await safetyActor(env, tenantId, userId);
  const mayReadEquipment = EQUIPMENT_AUTHORITY_ROLES.has(actor.role);
  const mayReadActions = RESPONSE_AUTHORITY_ROLES.has(actor.role);
  if (!mayReadEquipment && !mayReadActions) {
    throw new SafetyError(
      "safety_desk_role_required",
      403,
      "Reading the safety desk requires equipment or response authority.",
    );
  }

  let equipment: SafetyDeskEquipment[] | null = null;
  if (mayReadEquipment) {
    const rows = await env.DB.prepare(
      `SELECT equipment_id, equipment_kind, serial_number, status, assigned_user_id,
              inspection_due_at, last_inspection_result
         FROM safety_equipment
        WHERE tenant_id = ? AND status NOT IN ('replaced', 'retired')
        ORDER BY equipment_kind, serial_number
        LIMIT 500`,
    )
      .bind(tenantId)
      .all<{
        equipment_id: string;
        equipment_kind: SafetyEquipmentKind;
        serial_number: string;
        status: SafetyEquipmentStatus;
        assigned_user_id: string | null;
        inspection_due_at: string | null;
        last_inspection_result: "pass" | "fail" | null;
      }>();
    equipment = rows.results.map((row) => {
      const detail = equipmentUnserviceableDetail(
        row,
        now,
        `${row.equipment_kind} ${row.serial_number}`,
      );
      const daysLeft = row.inspection_due_at
        ? daysBetween(now, row.inspection_due_at)
        : null;
      if (detail) {
        return {
          ...row,
          verdict: "unserviceable" as const,
          detail,
          days_left: daysLeft,
        };
      }
      const expiring =
        daysLeft !== null && daysLeft <= SAFETY_INSPECTION_EXPIRING_DAYS;
      return {
        ...row,
        verdict: expiring ? ("expiring" as const) : ("serviceable" as const),
        detail: expiring
          ? `${row.equipment_kind} ${row.serial_number} inspection is due ${row.inspection_due_at}.`
          : null,
        days_left: daysLeft,
      };
    });
  }

  let correctiveActions: SafetyDeskCorrectiveAction[] | null = null;
  if (mayReadActions) {
    const rows = await env.DB.prepare(
      `SELECT corrective_action_id, occurrence_id, state, risk_level, owner_user_id,
              due_at, description
         FROM safety_corrective_actions
        WHERE tenant_id = ? AND state NOT IN ('closed', 'rejected')
        ORDER BY due_at
        LIMIT 200`,
    )
      .bind(tenantId)
      .all<{
        corrective_action_id: string;
        occurrence_id: string;
        state: SafetyCorrectiveActionState;
        risk_level: SafetySeverity;
        owner_user_id: string;
        due_at: string;
        description: string;
      }>();
    correctiveActions = rows.results.map((row) => ({
      ...row,
      blocking: correctiveActionBlocks(row, now),
      days_left: daysBetween(now, row.due_at),
    }));
  }

  return {
    version: 1,
    read_model_generated_at: now,
    expiring_within_days: SAFETY_INSPECTION_EXPIRING_DAYS,
    actor_role: actor.role,
    equipment,
    corrective_actions: correctiveActions,
  };
}
