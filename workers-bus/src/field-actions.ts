import type { AppEnv, AuthContext, WorkObjectScope } from "./app-types.ts";

export const MAX_FIELD_MEDIA_COUNT = 12;
export const MAX_FIELD_MEDIA_BYTES = 12 * 1024 * 1024;
export const MAX_FIELD_ACTION_MEDIA_BYTES = 24 * 1024 * 1024;
export const MAX_FIELD_REQUEST_BYTES =
  MAX_FIELD_ACTION_MEDIA_BYTES + 256 * 1024;
const MAX_FIELD_METADATA_BYTES = 16 * 1024;
const FIELD_ACTION_LEASE_MS = 90_000;
const FIELD_UPLOAD_WINDOW_MS = 60_000;
const FIELD_UPLOADS_PER_WINDOW = 8;

export const FIELD_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "audio/mpeg",
  "audio/mp4",
  "audio/webm",
  "audio/wav",
  "audio/x-wav",
]);

const PROOF_SLOTS = new Set([
  "Lead",
  "Measurement",
  "Estimate",
  "Contract",
  "Deposit",
  "Materials",
  "Safety",
  "Access",
  "Weather",
  "Crew",
  "Production",
  "Change Order",
  "Completion",
  "Warranty",
  "Payment",
  "Communication",
  "Other",
]);
const BLOCKER_CATEGORIES = new Set([
  "Safety",
  "Weather",
  "Access",
  "Material",
  "Crew",
  "Scope",
  "Customer",
  "Other",
]);

export interface FieldActionPayload {
  assignment_id: string;
  proof_slot: string;
  capture_started_at: string;
  capture_completed_at: string;
  notes: string | null;
  blocker: boolean;
  blocker_category: string | null;
  blocker_summary: string | null;
  latitude: number | null;
  longitude: number | null;
  location_accuracy_m: number | null;
  location_permission_state:
    "not_requested" | "granted" | "denied" | "unavailable" | "error";
  correction_of: string | null;
  correction_reason: string | null;
  evidence_correction_of: string | null;
  evidence_item_correction_of: string | null;
  work_package_release_attempt_id?: string | null;
  work_package_id?: string | null;
  work_package_version?: number | null;
  evidence_slot_id?: string | null;
  evidence_requirement?: string | null;
  evidence_source?: string | null;
  evidence_device_id?: string | null;
  evidence_freshness?: "Current" | "Stale" | "Unknown" | null;
  evidence_conflict_state?: "None" | "Detected" | "Resolved" | null;
  evidence_verification?: "Pending" | "Verified" | "Rejected" | null;
  evidence_disposition?:
    "Open" | "Accepted" | "Needs Correction" | "Superseded" | null;
  customer_safe_requested: boolean;
}

export interface FieldMediaInput {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  size: number;
  blob: Blob;
}

export interface FieldSubmission {
  deviceActionId: string;
  jobId: string;
  assignmentId: string;
  scope?: WorkObjectScope;
  payload: FieldActionPayload;
  media: FieldMediaInput[];
}

export interface FieldMediaReceipt {
  attachmentId: string;
  evidenceId: string;
  r2Key: string;
  checksum: string;
  contentType: string;
  contentLength: number;
}

export interface VerifiedFieldActionResponse {
  device_action_id: string;
  status: "verified";
  server_ref: string;
  cursor: string;
  checkin_id: string;
  media: Array<{
    attachment_id: string;
    evidence_id: string;
    checksum_sha256: string;
    content_length: number;
  }>;
}

/** Server-owned Work Package facts required before a typed field capture can start. */
export interface FieldEvidenceAuthorization {
  workPackageId: string;
  workPackageVersion: number;
  releaseAttemptId: string;
  scope: WorkObjectScope;
  slotId: string;
  requirement: string;
  source: string;
  deviceId: string;
  freshness: "Current" | "Stale" | "Unknown";
  conflictState: "None" | "Detected" | "Resolved";
  correctionOf: string | null;
  itemCorrectionOf: string | null;
}

export type FieldEvidenceAuthorizer = (
  submission: FieldSubmission,
  auth: AuthContext,
) => Promise<FieldEvidenceAuthorization>;

interface ClaimInput {
  deviceActionId: string;
  tenantId: string;
  userId: string;
  jobId: string;
  assignmentId: string;
  payloadHash: string;
  checkinId: string;
  now: string;
  token: string;
  leaseExpiresAt: string;
  workPackageId: string | null;
  workPackageVersion: number | null;
  evidenceSlotId: string | null;
  evidenceRequirement: string | null;
  evidenceSource: string | null;
  evidenceDeviceId: string | null;
  evidenceFreshness: "Current" | "Stale" | "Unknown" | null;
  evidenceConflictState: "None" | "Detected" | "Resolved" | null;
  evidenceVerification: "Pending" | "Verified" | "Rejected" | null;
  evidenceDisposition:
    "Open" | "Accepted" | "Needs Correction" | "Superseded" | null;
  evidenceCorrectionOf: string | null;
  evidenceItemCorrectionOf: string | null;
  workPackageReleaseAttemptId: string | null;
  correctionReason: string | null;
  workObjectType: string | null;
  workObjectId: string | null;
  physicalContextType: string | null;
  physicalContextId: string | null;
  captureStartedAt: string;
  captureCompletedAt: string;
}

type ClaimResult =
  | { state: "acquired" }
  | { state: "busy" }
  | { state: "conflict" }
  | { state: "verified"; response: VerifiedFieldActionResponse };

export interface FieldActionStore {
  claim(input: ClaimInput): Promise<ClaimResult>;
  renew(
    deviceActionId: string,
    token: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean>;
  getMedia(
    deviceActionId: string,
    attachmentId: string,
  ): Promise<FieldMediaReceipt | null>;
  recordMedia(
    deviceActionId: string,
    receipt: FieldMediaReceipt,
    now: string,
  ): Promise<FieldMediaReceipt>;
  markR2Stored(
    deviceActionId: string,
    manifestKey: string,
    now: string,
  ): Promise<void>;
  complete(
    deviceActionId: string,
    token: string,
    response: VerifiedFieldActionResponse,
    now: string,
  ): Promise<void>;
  fail(
    deviceActionId: string,
    token: string,
    errorCode: string,
    now: string,
  ): Promise<void>;
}

export interface ImmutableObjectStore {
  ensure(
    key: string,
    body: Blob | string,
    contentType: string,
    checksum: string,
  ): Promise<void>;
}

export interface ProcessFieldDependencies {
  store: FieldActionStore;
  objects: ImmutableObjectStore;
  authorizeTypedEvidence?: FieldEvidenceAuthorizer;
  now?: () => Date;
  randomId?: () => string;
}

export interface FieldWorkPackageEvidenceD1Row {
  eventId: string;
  evidenceItem: string;
  actorUser: string;
  actorUserId: string;
  actorRole: string;
  deviceActionId: string;
  occurredAt: string;
  slotId: string;
  requirement: string;
  source: string;
  deviceId: string;
  capturedAt: string;
  freshness: "Current" | "Stale" | "Unknown";
  conflictState: "None" | "Detected" | "Resolved";
  correctionOf: string | null;
  itemCorrectionOf: string | null;
  verification: "Pending" | "Verified" | "Rejected";
  disposition: "Open" | "Accepted" | "Needs Correction" | "Superseded";
  correctionReason: string | null;
  releaseAttemptId: string;
  workObjectType: string;
  workObjectId: string;
  physicalContextType: string;
  physicalContextId: string;
}

export class FieldActionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: string,
    status: number,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "FieldActionError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function handleFieldAction(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  jobId: string,
  assignmentId: string,
  scope?: WorkObjectScope,
  authorizeTypedEvidence?: FieldEvidenceAuthorizer,
): Promise<Response> {
  try {
    const rateLimit = await claimFieldUploadWindow(env, auth);
    if (!rateLimit.allowed) {
      throw new FieldActionError(
        "field_upload_rate_limited",
        429,
        "Too many field uploads are starting at once. Saved work remains queued for retry.",
        rateLimit.retryAfterSeconds,
      );
    }
    const submission = {
      ...(await parseFieldActionRequest(req, jobId, assignmentId)),
      ...(scope ? { scope } : {}),
    } satisfies FieldSubmission;
    const evidenceAuthorizer: FieldEvidenceAuthorizer =
      authorizeTypedEvidence ?? (async (candidate, candidateAuth) => {
        const { authorizeFieldEvidence } = await import("./work-package.ts");
        return await authorizeFieldEvidence(env, candidate, candidateAuth);
      });
    const response = await processFieldSubmission(submission, auth, {
      store: d1FieldActionStore(env),
      objects: r2ObjectStore(env.RAW),
      authorizeTypedEvidence: evidenceAuthorizer,
    });
    return fieldJson(response);
  } catch (error) {
    const failure =
      error instanceof FieldActionError
        ? error
        : new FieldActionError(
            "field_action_failed",
            502,
            "The field action could not be verified yet.",
            5,
          );
    const response = fieldJson(
      { error: failure.code, message: failure.message },
      failure.status,
    );
    if (failure.retryAfterSeconds)
      response.headers.set("retry-after", String(failure.retryAfterSeconds));
    return response;
  }
}

export async function claimFieldUploadWindow(
  env: AppEnv,
  auth: AuthContext,
  now = new Date(),
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const windowStartedAt = now.toISOString();
  const windowExpiresAt = new Date(
    now.getTime() + FIELD_UPLOAD_WINDOW_MS,
  ).toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO app_action_throttles
       (tenant_id, user_id, scope, window_started_at, window_expires_at, attempts, updated_at)
     VALUES (?, ?, 'field_upload', ?, ?, 1, ?)
     ON CONFLICT(tenant_id, user_id, scope) DO UPDATE SET
       window_started_at = CASE
         WHEN app_action_throttles.window_expires_at <= excluded.window_started_at
         THEN excluded.window_started_at ELSE app_action_throttles.window_started_at END,
       window_expires_at = CASE
         WHEN app_action_throttles.window_expires_at <= excluded.window_started_at
         THEN excluded.window_expires_at ELSE app_action_throttles.window_expires_at END,
       attempts = CASE
         WHEN app_action_throttles.window_expires_at <= excluded.window_started_at
         THEN 1 ELSE app_action_throttles.attempts + 1 END,
       updated_at = excluded.updated_at
     RETURNING attempts, window_expires_at`,
  )
    .bind(
      auth.session.tenant_id,
      auth.session.user_id,
      windowStartedAt,
      windowExpiresAt,
      windowStartedAt,
    )
    .first<{ attempts: number; window_expires_at: string }>();
  if (!row) throw new Error("field_upload_throttle_failed");
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((Date.parse(row.window_expires_at) - now.getTime()) / 1_000),
  );
  return {
    allowed: Number(row.attempts) <= FIELD_UPLOADS_PER_WINDOW,
    retryAfterSeconds,
  };
}

export async function parseFieldActionRequest(
  req: Request,
  jobId: string,
  assignmentId: string,
): Promise<FieldSubmission> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FIELD_REQUEST_BYTES)
    throw payloadTooLarge();
  if (
    !req.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("multipart/form-data;")
  ) {
    throw new FieldActionError(
      "multipart_required",
      415,
      "Field actions require multipart form data.",
    );
  }
  let form: FormData;
  try {
    form = await boundedFormData(req);
  } catch (error) {
    if (error instanceof FieldActionError) throw error;
    throw new FieldActionError(
      "invalid_multipart",
      400,
      "The saved field action could not be read.",
    );
  }
  const metadataValue = form.get("metadata");
  if (
    typeof metadataValue !== "string" ||
    byteLength(metadataValue) > MAX_FIELD_METADATA_BYTES
  ) {
    throw new FieldActionError(
      "invalid_metadata",
      400,
      "Field action metadata is missing or too large.",
    );
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataValue) as unknown;
  } catch {
    throw new FieldActionError(
      "invalid_metadata",
      400,
      "Field action metadata is not valid JSON.",
    );
  }
  const parsed = parseMetadata(metadata, assignmentId);
  const files = form.getAll("attachments");
  if (files.length !== parsed.attachments.length) {
    throw new FieldActionError(
      "attachment_mismatch",
      400,
      "Saved attachment metadata does not match the uploaded files.",
    );
  }
  if (files.length > MAX_FIELD_MEDIA_COUNT) {
    throw new FieldActionError(
      "too_many_attachments",
      413,
      `Send at most ${MAX_FIELD_MEDIA_COUNT} files per saved action.`,
    );
  }
  const media = await Promise.all(
    files.map(async (entry, index) => {
      if (typeof entry === "string")
        throw new FieldActionError(
          "attachment_missing",
          400,
          "A saved attachment is missing.",
        );
      const expected = parsed.attachments[index]!;
      const mimeType = entry.type.toLowerCase();
      if (
        !FIELD_MEDIA_TYPES.has(mimeType) ||
        mimeType !== expected.mimeType.toLowerCase()
      ) {
        throw new FieldActionError(
          "media_type_not_allowed",
          415,
          "Only supported photo and voice-note formats are accepted.",
        );
      }
      if (
        entry.size < 1 ||
        entry.size > MAX_FIELD_MEDIA_BYTES ||
        entry.size !== expected.size
      )
        throw payloadTooLarge();
      if (safeFileName(entry.name) !== expected.fileName) {
        throw new FieldActionError(
          "attachment_mismatch",
          400,
          "Attachment names do not match the saved action.",
        );
      }
      if (!(await mediaSignatureMatches(entry, mimeType))) {
        throw new FieldActionError(
          "media_signature_invalid",
          415,
          "The file content does not match its declared photo or voice-note format.",
        );
      }
      return {
        attachmentId: expected.attachmentId,
        fileName: expected.fileName,
        mimeType,
        size: entry.size,
        blob: entry,
      };
    }),
  );
  if (
    media.reduce((sum, item) => sum + item.size, 0) >
    MAX_FIELD_ACTION_MEDIA_BYTES
  )
    throw payloadTooLarge();
  return {
    deviceActionId: parsed.deviceActionId,
    jobId,
    assignmentId,
    payload: parsed.payload,
    media,
  };
}

async function boundedFormData(req: Request): Promise<FormData> {
  if (!req.body) throw invalidMetadata();
  let total = 0;
  const contentType = req.headers.get("content-type");
  if (!contentType) throw invalidMetadata();
  const bounded = req.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > MAX_FIELD_REQUEST_BYTES) throw payloadTooLarge();
        controller.enqueue(chunk);
      },
    }),
  );
  return await new Response(bounded, {
    headers: { "content-type": contentType },
  }).formData();
}

export async function mediaSignatureMatches(
  blob: Blob,
  mimeType: string,
): Promise<boolean> {
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  if (mimeType === "image/jpeg")
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    );
  }
  if (mimeType === "image/webp")
    return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (mimeType === "image/heic" || mimeType === "image/heif") {
    return (
      ascii(4, 8) === "ftyp" &&
      new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]).has(
        ascii(8, 12),
      )
    );
  }
  if (mimeType === "audio/mpeg") {
    return (
      ascii(0, 3) === "ID3" ||
      (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
    );
  }
  if (mimeType === "audio/mp4") return ascii(4, 8) === "ftyp";
  if (mimeType === "audio/webm") {
    return (
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    );
  }
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav") {
    return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
  }
  return false;
}

export async function processFieldSubmission(
  submission: FieldSubmission,
  auth: AuthContext,
  dependencies: ProcessFieldDependencies,
): Promise<VerifiedFieldActionResponse> {
  validateSubmission(submission);
  // Treat a slot-only payload as typed as well.  The HTTP parser rejects this
  // shape, but callers can construct FieldSubmission objects directly (for
  // example an older offline queue or an internal adapter).  Those callers
  // must receive the same fail-closed evidence contract rather than falling
  // through to a generic Field Check-in.
  const typedEvidence =
    submission.payload.work_package_id != null ||
    submission.payload.evidence_slot_id != null;
  const hasCorrectionOf = hasNonEmptyValue(submission.payload.correction_of);
  const hasEvidenceCorrectionOf = hasNonEmptyValue(
    submission.payload.evidence_correction_of,
  );
  const hasEvidenceItemCorrectionOf = hasNonEmptyValue(
    submission.payload.evidence_item_correction_of,
  );
  const hasCorrectionReason = hasNonEmptyValue(
    submission.payload.correction_reason,
  );
  if (!typedEvidence && hasCorrectionOf !== hasCorrectionReason)
    throw invalidMetadata();
  if (hasEvidenceCorrectionOf !== hasEvidenceItemCorrectionOf)
    throw invalidMetadata();
  if (
    hasEvidenceCorrectionOf &&
    hasEvidenceCorrectionOf !== hasCorrectionReason
  )
    throw invalidMetadata();
  if (hasCorrectionOf && (hasEvidenceCorrectionOf || hasEvidenceItemCorrectionOf))
    throw invalidMetadata();
  if (!typedEvidence && (hasEvidenceCorrectionOf || hasEvidenceItemCorrectionOf))
    throw invalidMetadata();
  if (typedEvidence && hasCorrectionOf) throw invalidMetadata();
  if (typedEvidence && hasCorrectionReason !== hasEvidenceCorrectionOf)
    throw invalidMetadata();
  if (typedEvidence) {
    // Technical verification is derived only after the Worker has verified the
    // immutable R2 receipts.  A field payload may carry the compatibility value
    // `Verified`/`Open`, but it cannot select a business disposition or forge a
    // different verification result.
    if (
      submission.payload.evidence_verification != null &&
      submission.payload.evidence_verification !== "Verified"
    ) {
      throw new FieldActionError(
        "evidence_verification_forbidden",
        400,
        "Technical evidence verification is derived by the Worker.",
      );
    }
    if (
      submission.payload.evidence_disposition != null &&
      submission.payload.evidence_disposition !== "Open"
    ) {
      throw new FieldActionError(
        "evidence_disposition_forbidden",
        400,
        "Field evidence starts Open; an authorized review command sets its disposition.",
      );
    }
    // Normalize the trusted values before hashing, persisting, or replaying so
    // callers that construct a typed submission internally cannot bypass the
    // same contract enforced by parsePayload at the HTTP boundary.
    submission = {
      ...submission,
      payload: {
        ...submission.payload,
        evidence_verification: "Verified",
        evidence_disposition: "Open",
      },
    };
  }
  if (typedEvidence && submission.media.length === 0) {
    throw new FieldActionError(
      "evidence_attachment_required",
      400,
      "A typed evidence slot must include at least one captured attachment.",
    );
  }
  if (typedEvidence && !submission.payload.work_package_release_attempt_id) {
    throw new FieldActionError(
      "evidence_release_attempt_missing",
      409,
      "Refresh this Work Package before capturing evidence for its current release attempt.",
    );
  }
  if (
    typedEvidence &&
    submission.payload.evidence_correction_of &&
    submission.media.length !== 1
  ) {
    throw new FieldActionError(
      "evidence_correction_attachment_count",
      400,
      "A correction must contain exactly one attachment so its replacement identity is unambiguous.",
    );
  }
  if (
    typedEvidence &&
    (!auth.session.device_id ||
      (submission.payload.evidence_device_id !== null &&
        submission.payload.evidence_device_id !== undefined &&
        submission.payload.evidence_device_id !== auth.session.device_id))
  ) {
    throw new FieldActionError(
      "evidence_device_mismatch",
      409,
      "The evidence device binding is stale. Reconnect and refresh this package before retrying.",
    );
  }
  if (typedEvidence) {
    if (!dependencies.authorizeTypedEvidence) {
      throw new FieldActionError(
        "field_evidence_authorization_unavailable",
        503,
        "The current Work Package evidence authorization is unavailable. Refresh the package before retrying.",
        5,
      );
    }
    let authorization: FieldEvidenceAuthorization;
    try {
      authorization = await dependencies.authorizeTypedEvidence(
        submission,
        auth,
      );
    } catch (error) {
      if (error instanceof FieldActionError) throw error;
      throw new FieldActionError(
        "field_evidence_authorization_unavailable",
        503,
        "The current Work Package evidence authorization is unavailable. Refresh the package before retrying.",
        5,
      );
    }
    submission = applyTypedEvidenceAuthorization(submission, authorization);
  }
  submission = {
    ...submission,
    scope: normalizeSubmissionScope(submission.scope, submission.jobId, typedEvidence),
  };
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
  const prepared = await Promise.all(
    submission.media.map(async (media) => ({
      ...media,
      checksum: await sha256Blob(media.blob),
      evidenceId: await deterministicId(
        "evi",
        `${submission.deviceActionId}:${media.attachmentId}`,
      ),
    })),
  );
  prepared.sort((left, right) =>
    left.attachmentId.localeCompare(right.attachmentId),
  );
  const payloadHash = await sha256Text(
    stableStringify({
      job_id: submission.jobId,
      assignment_id: submission.assignmentId,
      scope: submission.scope ?? null,
      payload: submission.payload,
      media: prepared.map(({ blob: _blob, ...item }) => item),
    }),
  );
  const checkinId = await deterministicId("fci", submission.deviceActionId);
  const scopeDigest = (
    await sha256Text(
      `${auth.session.tenant_id}:${stableStringify(
        submission.scope ?? { job_id: submission.jobId },
      )}`,
    )
  ).slice(0, 24);
  const started = now();
  const token = randomId();
  const claim = await dependencies.store.claim({
    deviceActionId: submission.deviceActionId,
    tenantId: auth.session.tenant_id,
    userId: auth.session.user_id,
    jobId: submission.jobId,
    assignmentId: submission.assignmentId,
    payloadHash,
    checkinId,
    now: started.toISOString(),
    token,
    leaseExpiresAt: new Date(
      started.getTime() + FIELD_ACTION_LEASE_MS,
    ).toISOString(),
    workPackageId: submission.payload.work_package_id ?? null,
    workPackageVersion: submission.payload.work_package_version ?? null,
    evidenceSlotId: submission.payload.evidence_slot_id ?? null,
    evidenceRequirement: submission.payload.evidence_requirement ?? null,
    evidenceSource: submission.payload.evidence_source ?? null,
    evidenceDeviceId:
      auth.session.device_id ?? submission.payload.evidence_device_id ?? null,
    evidenceFreshness: submission.payload.evidence_freshness ?? null,
    evidenceConflictState: submission.payload.evidence_conflict_state ?? null,
    evidenceVerification: submission.payload.evidence_verification ?? null,
    evidenceDisposition: submission.payload.evidence_disposition ?? null,
    evidenceCorrectionOf: submission.payload.evidence_correction_of,
    evidenceItemCorrectionOf: submission.payload.evidence_item_correction_of,
    workPackageReleaseAttemptId:
      submission.payload.work_package_release_attempt_id ?? null,
    correctionReason: submission.payload.correction_reason,
    workObjectType: submission.scope?.workObjectType ?? null,
    workObjectId: submission.scope?.workObjectId ?? null,
    physicalContextType: submission.scope?.physicalContextType ?? null,
    physicalContextId: submission.scope?.physicalContextId ?? null,
    captureStartedAt: submission.payload.capture_started_at,
    captureCompletedAt: submission.payload.capture_completed_at,
  });
  if (claim.state === "verified") return claim.response;
  if (claim.state === "conflict") {
    throw new FieldActionError(
      "idempotency_conflict",
      409,
      "This device action id is already bound to different saved content.",
    );
  }
  if (claim.state === "busy") {
    throw new FieldActionError(
      "action_in_progress",
      503,
      "This saved action is already being verified.",
      3,
    );
  }

  try {
    const receipts: FieldMediaReceipt[] = [];
    for (const media of prepared) {
      await renewLease(
        dependencies.store,
        submission.deviceActionId,
        token,
        now,
      );
      const r2Key = mediaKey(
        scopeDigest,
        checkinId,
        media.evidenceId,
        media.mimeType,
      );
      const expected: FieldMediaReceipt = {
        attachmentId: media.attachmentId,
        evidenceId: media.evidenceId,
        r2Key,
        checksum: media.checksum,
        contentType: media.mimeType,
        contentLength: media.size,
      };
      const existing = await dependencies.store.getMedia(
        submission.deviceActionId,
        media.attachmentId,
      );
      if (existing) {
        assertReceiptMatches(existing, expected);
        receipts.push(existing);
        continue;
      }
      await dependencies.objects.ensure(
        r2Key,
        media.blob,
        media.mimeType,
        media.checksum,
      );
      receipts.push(
        await dependencies.store.recordMedia(
          submission.deviceActionId,
          expected,
          now().toISOString(),
        ),
      );
    }

    const manifest = stableStringify({
      version: 1,
      tenant_id: auth.session.tenant_id,
      user_id: auth.session.user_id,
      job_id: submission.jobId,
      assignment_id: submission.assignmentId,
      scope: submission.scope ?? null,
      device_action_id: submission.deviceActionId,
      payload: submission.payload,
      media: receipts,
    });
    const manifestKey = manifestObjectKey(scopeDigest, checkinId);
    await renewLease(dependencies.store, submission.deviceActionId, token, now);
    await dependencies.objects.ensure(
      manifestKey,
      manifest,
      "application/json",
      await sha256Text(manifest),
    );
    await dependencies.store.markR2Stored(
      submission.deviceActionId,
      manifestKey,
      now().toISOString(),
    );

    const persistedReceipts = receipts;
    await renewLease(dependencies.store, submission.deviceActionId, token, now);
    const response: VerifiedFieldActionResponse = {
      device_action_id: submission.deviceActionId,
      status: "verified",
      server_ref: checkinId,
      cursor: checkinId,
      checkin_id: checkinId,
      media: persistedReceipts.map((item) => ({
        attachment_id: item.attachmentId,
        evidence_id: item.evidenceId,
        checksum_sha256: item.checksum,
        content_length: item.contentLength,
      })),
    };
    await renewLease(dependencies.store, submission.deviceActionId, token, now);
    await dependencies.store.complete(
      submission.deviceActionId,
      token,
      response,
      now().toISOString(),
    );
    return response;
  } catch (error) {
    const code =
      error instanceof FieldActionError ? error.code : safeErrorCode(error);
    await dependencies.store
      .fail(submission.deviceActionId, token, code, now().toISOString())
      .catch(() => {});
    throw error instanceof FieldActionError
      ? error
      : new FieldActionError(
          code,
          502,
          "The action remains queued until D1 and R2 verify it.",
          5,
        );
  }
}

function d1FieldActionStore(env: AppEnv): FieldActionStore {
  return {
    async claim(input) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO field_actions
         (device_action_id, tenant_id, user_id, job_id, assignment_id, action_kind, payload_hash,
           status, checkin_id, processing_token, lease_expires_at, created_at, updated_at,
           work_package_id, work_package_version, evidence_slot_id, evidence_requirement,
           evidence_source, evidence_device_id, evidence_freshness, evidence_conflict_state,
           evidence_verification, evidence_disposition, evidence_correction_of,
           evidence_item_correction_of, work_package_release_attempt_id, correction_reason,
           work_object_type, work_object_id, physical_context_type, physical_context_id,
           capture_started_at, capture_completed_at)
         VALUES (?, ?, ?, ?, ?, 'field_checkin', ?, 'processing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          input.deviceActionId,
          input.tenantId,
          input.userId,
          input.jobId,
          input.assignmentId,
          input.payloadHash,
          input.checkinId,
          input.token,
          input.leaseExpiresAt,
          input.now,
          input.now,
          input.workPackageId,
          input.workPackageVersion,
          input.evidenceSlotId,
          input.evidenceRequirement,
          input.evidenceSource,
          input.evidenceDeviceId,
          input.evidenceFreshness,
          input.evidenceConflictState,
          input.evidenceVerification,
          input.evidenceDisposition,
          input.evidenceCorrectionOf,
          input.evidenceItemCorrectionOf,
          input.workPackageReleaseAttemptId,
          input.correctionReason,
          input.workObjectType,
          input.workObjectId,
          input.physicalContextType,
          input.physicalContextId,
          input.captureStartedAt,
          input.captureCompletedAt,
        )
        .run();
      let row = await fieldActionRow(env, input.deviceActionId);
      if (!row) throw new Error("field_action_claim_missing");
      if (
        row.tenant_id !== input.tenantId ||
        row.user_id !== input.userId ||
        row.payload_hash !== input.payloadHash ||
        row.job_id !== input.jobId ||
        row.assignment_id !== input.assignmentId ||
        !sameNullable(row.work_package_id, input.workPackageId) ||
        !sameNullableNumber(
          row.work_package_version,
          input.workPackageVersion,
        ) ||
        !sameNullable(row.evidence_slot_id, input.evidenceSlotId) ||
        !sameNullable(row.evidence_requirement, input.evidenceRequirement) ||
        !sameNullable(row.evidence_source, input.evidenceSource) ||
        !sameNullable(row.evidence_device_id, input.evidenceDeviceId) ||
        !sameNullable(row.evidence_freshness, input.evidenceFreshness) ||
        !sameNullable(
          row.evidence_conflict_state,
          input.evidenceConflictState,
        ) ||
        !sameNullable(row.evidence_verification, input.evidenceVerification) ||
        !sameNullable(row.evidence_disposition, input.evidenceDisposition) ||
        !sameNullable(row.evidence_correction_of, input.evidenceCorrectionOf) ||
        !sameNullable(
          row.evidence_item_correction_of,
          input.evidenceItemCorrectionOf,
        ) ||
        !sameNullable(
          row.work_package_release_attempt_id,
          input.workPackageReleaseAttemptId,
        ) ||
        !sameNullable(row.correction_reason, input.correctionReason)
        || (row.work_object_type !== null &&
          !sameNullable(row.work_object_type, input.workObjectType))
        || (row.work_object_id !== null &&
          !sameNullable(row.work_object_id, input.workObjectId))
        || (row.physical_context_type !== null &&
          !sameNullable(row.physical_context_type, input.physicalContextType))
        || (row.physical_context_id !== null &&
          !sameNullable(row.physical_context_id, input.physicalContextId))
        || (row.capture_started_at !== null &&
          row.capture_started_at !== input.captureStartedAt)
        || (row.capture_completed_at !== null &&
          row.capture_completed_at !== input.captureCompletedAt)
      ) {
        return { state: "conflict" };
      }
      if (row.status === "verified") {
        const parsed = parseStoredResponse(row.response_json);
        if (!parsed) throw new Error("field_action_verified_response_invalid");
        return { state: "verified", response: parsed };
      }
      if (row.processing_token === input.token) return { state: "acquired" };
      const reclaimable =
        row.status === "retryable_error" ||
        !row.lease_expires_at ||
        row.lease_expires_at <= input.now;
      if (!reclaimable) return { state: "busy" };
      await env.DB.prepare(
        `UPDATE field_actions
         SET status = 'processing', processing_token = ?, lease_expires_at = ?, updated_at = ?, last_error = NULL
         WHERE device_action_id = ? AND payload_hash = ? AND status != 'verified'
           AND (status = 'retryable_error' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
        .bind(
          input.token,
          input.leaseExpiresAt,
          input.now,
          input.deviceActionId,
          input.payloadHash,
          input.now,
        )
        .run();
      row = await fieldActionRow(env, input.deviceActionId);
      return row?.processing_token === input.token
        ? { state: "acquired" }
        : { state: "busy" };
    },
    async renew(deviceActionId, token, now, leaseExpiresAt) {
      const result = await env.DB.prepare(
        `UPDATE field_actions SET lease_expires_at = ?, updated_at = ?
         WHERE device_action_id = ? AND processing_token = ? AND status != 'verified'`,
      )
        .bind(leaseExpiresAt, now, deviceActionId, token)
        .run();
      return Number(result.meta.changes ?? 0) === 1;
    },
    async getMedia(deviceActionId, attachmentId) {
      const row = await env.DB.prepare(
        `SELECT attachment_id, evidence_id, r2_key, checksum_sha256, content_type, content_length
         FROM field_action_media WHERE device_action_id = ? AND attachment_id = ?`,
      )
        .bind(deviceActionId, attachmentId)
        .first<FieldMediaRow>();
      return row ? mediaReceipt(row) : null;
    },
    async recordMedia(deviceActionId, receipt, now) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO field_action_media
          (device_action_id, attachment_id, evidence_id, r2_key, checksum_sha256, content_type,
           content_length, r2_stored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          deviceActionId,
          receipt.attachmentId,
          receipt.evidenceId,
          receipt.r2Key,
          receipt.checksum,
          receipt.contentType,
          receipt.contentLength,
          now,
        )
        .run();
      const existing = await this.getMedia(
        deviceActionId,
        receipt.attachmentId,
      );
      if (!existing) throw new Error("field_media_receipt_missing");
      assertReceiptMatches(existing, receipt);
      return existing;
    },
    async markR2Stored(deviceActionId, manifestKey, now) {
      await env.DB.prepare(
        `UPDATE field_actions SET status = 'r2_stored', manifest_key = COALESCE(manifest_key, ?), updated_at = ?
         WHERE device_action_id = ? AND status != 'verified'`,
      )
        .bind(manifestKey, now, deviceActionId)
        .run();
    },
    async complete(deviceActionId, token, response, now) {
      const result = await env.DB.prepare(
        `UPDATE field_actions
         SET status = 'verified', response_json = ?, verified_at = ?, updated_at = ?,
             processing_token = NULL, lease_expires_at = NULL, last_error = NULL
         WHERE device_action_id = ? AND processing_token = ? AND status != 'verified'`,
      )
        .bind(JSON.stringify(response), now, now, deviceActionId, token)
        .run();
      if (Number(result.meta.changes ?? 0) !== 1)
        throw new Error("field_action_lease_lost");
    },
    async fail(deviceActionId, token, errorCode, now) {
      await env.DB.prepare(
        `UPDATE field_actions
         SET status = 'retryable_error', last_error = ?, updated_at = ?, processing_token = NULL, lease_expires_at = NULL
         WHERE device_action_id = ? AND processing_token = ? AND status != 'verified'`,
      )
        .bind(errorCode.slice(0, 240), now, deviceActionId, token)
        .run();
    },
  };
}

export interface FieldWorkPackageEvidenceD1Query {
  tenantId: string;
  workPackageId: string;
  jobId: string;
  assignmentId: string;
  version: number;
  releaseAttemptId: string;
  scope: WorkObjectScope;
}

interface FieldWorkPackageEvidenceD1DbRow {
  device_action_id: string;
  user_id: string;
  actor_user: string | null;
  actor_role: string | null;
  created_at: string;
  work_package_id: string;
  work_package_version: number;
  evidence_slot_id: string;
  evidence_requirement: string;
  evidence_source: string;
  evidence_device_id: string;
  evidence_freshness: string;
  evidence_conflict_state: string;
  evidence_verification: string;
  evidence_disposition: string;
  evidence_correction_of: string | null;
  evidence_item_correction_of: string | null;
  work_package_release_attempt_id: string;
  correction_reason: string | null;
  work_object_type: string;
  work_object_id: string;
  physical_context_type: string;
  physical_context_id: string;
  capture_completed_at: string | null;
  evidence_id: string;
}

/** Read typed field evidence from the canonical D1 action/media receipts. */
export async function listFieldWorkPackageEvidenceFromD1(
  env: AppEnv,
  input: FieldWorkPackageEvidenceD1Query,
): Promise<FieldWorkPackageEvidenceD1Row[] | null> {
  let result: { results?: FieldWorkPackageEvidenceD1DbRow[] };
  try {
    result = await env.DB.prepare(
      `SELECT a.device_action_id, a.user_id,
              COALESCE(NULLIF(u.email_normalized, ''), a.user_id) AS actor_user,
              COALESCE(NULLIF(u.access_role, ''), u.role) AS actor_role,
              a.created_at, a.work_package_id, a.work_package_version,
              a.evidence_slot_id, a.evidence_requirement, a.evidence_source,
              a.evidence_device_id, a.evidence_freshness, a.evidence_conflict_state,
              a.evidence_verification, a.evidence_disposition,
              a.evidence_correction_of, a.evidence_item_correction_of,
              a.work_package_release_attempt_id, a.correction_reason,
              a.work_object_type, a.work_object_id, a.physical_context_type,
              a.physical_context_id, a.capture_completed_at, m.evidence_id
         FROM field_actions a
         JOIN field_action_media m ON m.device_action_id = a.device_action_id
         LEFT JOIN app_users u ON u.user_id = a.user_id AND u.tenant_id = a.tenant_id
        WHERE a.tenant_id = ? AND a.status = 'verified'
          AND a.manifest_key IS NOT NULL AND m.r2_stored_at IS NOT NULL
          AND a.job_id = ? AND a.assignment_id = ?
          AND a.work_package_id = ? AND a.work_package_version = ?
          AND a.work_package_release_attempt_id = ?
          AND a.work_object_type = ? AND a.work_object_id = ?
          AND a.physical_context_type = ? AND a.physical_context_id = ?
        ORDER BY a.created_at ASC, a.device_action_id ASC, m.attachment_id ASC`,
    )
      .bind(
        input.tenantId,
        input.jobId,
        input.assignmentId,
        input.workPackageId,
        input.version,
        input.releaseAttemptId,
        input.scope.workObjectType,
        input.scope.workObjectId,
        input.scope.physicalContextType,
        input.scope.physicalContextId,
      )
      .all<FieldWorkPackageEvidenceD1DbRow>();
  } catch (error) {
    // A pre-0071 deployment may not have the additive scope/timestamp columns
    // yet; retain the explicit compatibility projection only for that known
    // schema state. Operational D1/read failures must propagate so callers do
    // not silently authorize or project a Frappe-only view.
    if (isMissingFieldEvidenceSchema(error)) return null;
    throw error;
  }
  return (result.results ?? []).map((row) => {
    const evidenceId = requiredD1Text(row.evidence_id, "evidence_id");
    if (!/^evi_[0-9a-f]{32}$/.test(evidenceId))
      throw new Error("field_evidence_evidence_id_invalid");
    const occurredAt = requiredD1Text(row.created_at, "created_at");
    const capturedAt = row.capture_completed_at ?? occurredAt;
    return {
      eventId: workPackageEvidenceDeviceActionId(evidenceId),
      evidenceItem: evidenceId,
      actorUser: requiredD1Text(row.actor_user, "actor_user"),
      actorUserId: requiredD1Text(row.user_id, "user_id"),
      actorRole: requiredD1Text(row.actor_role, "actor_role"),
      deviceActionId: workPackageEvidenceDeviceActionId(evidenceId),
      occurredAt,
      slotId: requiredD1Text(row.evidence_slot_id, "evidence_slot_id"),
      requirement: requiredD1Text(
        row.evidence_requirement,
        "evidence_requirement",
      ),
      source: requiredD1Text(row.evidence_source, "evidence_source"),
      deviceId: requiredD1Text(row.evidence_device_id, "evidence_device_id"),
      capturedAt: requiredD1Text(capturedAt, "capture_completed_at"),
      freshness: requiredD1Enum(
        row.evidence_freshness,
        ["Current", "Stale", "Unknown"],
        "evidence_freshness",
      ),
      conflictState: requiredD1Enum(
        row.evidence_conflict_state,
        ["None", "Detected", "Resolved"],
        "evidence_conflict_state",
      ),
      correctionOf: row.evidence_correction_of,
      itemCorrectionOf: row.evidence_item_correction_of,
      verification: requiredD1Enum(
        row.evidence_verification,
        ["Pending", "Verified", "Rejected"],
        "evidence_verification",
      ),
      disposition: requiredD1Enum(
        row.evidence_disposition,
        ["Open", "Accepted", "Needs Correction", "Superseded"],
        "evidence_disposition",
      ),
      correctionReason: row.correction_reason,
      releaseAttemptId: requiredD1Text(
        row.work_package_release_attempt_id,
        "work_package_release_attempt_id",
      ),
      workObjectType: requiredD1Text(row.work_object_type, "work_object_type"),
      workObjectId: requiredD1Text(row.work_object_id, "work_object_id"),
      physicalContextType: requiredD1Text(
        row.physical_context_type,
        "physical_context_type",
      ),
      physicalContextId: requiredD1Text(
        row.physical_context_id,
        "physical_context_id",
      ),
    } satisfies FieldWorkPackageEvidenceD1Row;
  });
}

function isMissingFieldEvidenceSchema(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /(?:no such (?:column|table)|unknown column)/i.test(message);
}

function requiredD1Text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`field_evidence_${field}_missing`);
  return value.trim();
}

function requiredD1Enum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const normalized = requiredD1Text(value, field);
  if (!allowed.includes(normalized as T))
    throw new Error(`field_evidence_${field}_invalid`);
  return normalized as T;
}

async function renewLease(
  store: FieldActionStore,
  deviceActionId: string,
  token: string,
  now: () => Date,
): Promise<void> {
  const current = now();
  const renewed = await store.renew(
    deviceActionId,
    token,
    current.toISOString(),
    new Date(current.getTime() + FIELD_ACTION_LEASE_MS).toISOString(),
  );
  if (!renewed)
    throw new FieldActionError(
      "action_lease_lost",
      503,
      "Another retry now owns this saved action.",
      3,
    );
}

interface FieldActionRow {
  device_action_id: string;
  tenant_id: string;
  user_id: string;
  job_id: string;
  assignment_id: string;
  payload_hash: string;
  status: string;
  processing_token: string | null;
  lease_expires_at: string | null;
  response_json: string | null;
  work_package_id: string | null;
  work_package_version: number | null;
  evidence_slot_id: string | null;
  evidence_requirement: string | null;
  evidence_source: string | null;
  evidence_device_id: string | null;
  evidence_freshness: string | null;
  evidence_conflict_state: string | null;
  evidence_verification: string | null;
  evidence_disposition: string | null;
  evidence_correction_of: string | null;
  evidence_item_correction_of: string | null;
  work_package_release_attempt_id: string | null;
  correction_reason: string | null;
  work_object_type: string | null;
  work_object_id: string | null;
  physical_context_type: string | null;
  physical_context_id: string | null;
  capture_started_at: string | null;
  capture_completed_at: string | null;
}

interface FieldMediaRow {
  attachment_id: string;
  evidence_id: string;
  r2_key: string;
  checksum_sha256: string;
  content_type: string;
  content_length: number;
}

async function fieldActionRow(
  env: AppEnv,
  deviceActionId: string,
): Promise<FieldActionRow | null> {
  return await env.DB.prepare(
    `SELECT device_action_id, tenant_id, user_id, job_id, assignment_id, payload_hash, status, processing_token,
            lease_expires_at, response_json, work_package_id, work_package_version, evidence_slot_id,
            evidence_requirement, evidence_source, evidence_device_id, evidence_freshness,
            evidence_conflict_state, evidence_verification, evidence_disposition,
            evidence_correction_of, evidence_item_correction_of,
            work_package_release_attempt_id, correction_reason,
            work_object_type, work_object_id, physical_context_type, physical_context_id,
            capture_started_at, capture_completed_at
     FROM field_actions WHERE device_action_id = ?`,
  )
    .bind(deviceActionId)
    .first<FieldActionRow>();
}

function mediaReceipt(row: FieldMediaRow): FieldMediaReceipt {
  return {
    attachmentId: row.attachment_id,
    evidenceId: row.evidence_id,
    r2Key: row.r2_key,
    checksum: row.checksum_sha256,
    contentType: row.content_type,
    contentLength: Number(row.content_length),
  };
}

export function r2ObjectStore(bucket: R2Bucket): ImmutableObjectStore {
  return {
    async ensure(key, body, contentType, checksum) {
      const existing = await bucket.head(key);
      if (existing) {
        if (!r2ObjectMatches(existing, bodySize(body), checksum)) {
          throw new FieldActionError(
            "immutable_object_conflict",
            409,
            "Stored media does not match this saved action.",
          );
        }
        return;
      }
      await bucket.put(key, body, {
        httpMetadata: { contentType },
        customMetadata: { sha256: checksum, immutable: "true" },
        sha256: checksum,
        onlyIf: { etagDoesNotMatch: "*" },
      });
      const verified = await bucket.head(key);
      if (!verified || !r2ObjectMatches(verified, bodySize(body), checksum)) {
        throw new FieldActionError(
          "immutable_object_conflict",
          409,
          "Stored media does not match this saved action.",
        );
      }
    },
  };
}

function parseMetadata(
  value: unknown,
  assignmentId: string,
): {
  deviceActionId: string;
  payload: FieldActionPayload;
  attachments: Array<{
    attachmentId: string;
    fileName: string;
    mimeType: string;
    size: number;
  }>;
} {
  if (!isRecord(value)) throw invalidMetadata();
  const deviceActionId = boundedId(
    value.device_action_id,
    8,
    80,
    "device_action_id",
  );
  if (!isRecord(value.payload)) throw invalidMetadata();
  const payload = parsePayload(value.payload, assignmentId);
  if (!Array.isArray(value.attachments)) throw invalidMetadata();
  const attachments = value.attachments.map((item) => {
    if (!isRecord(item)) throw invalidMetadata();
    return {
      attachmentId: boundedId(item.attachmentId, 1, 80, "attachment_id"),
      fileName: safeFileName(item.fileName),
      mimeType: boundedText(item.mimeType, 3, 100, "mime_type").toLowerCase(),
      size: boundedInteger(
        item.size,
        1,
        MAX_FIELD_MEDIA_BYTES,
        "content_length",
      ),
    };
  });
  if (
    new Set(attachments.map((item) => item.attachmentId)).size !==
    attachments.length
  )
    throw invalidMetadata();
  return { deviceActionId, payload, attachments };
}

function parsePayload(
  value: Record<string, unknown>,
  assignmentId: string,
): FieldActionPayload {
  const suppliedAssignment = boundedText(
    value.assignment_id,
    1,
    140,
    "assignment_id",
  );
  if (suppliedAssignment !== assignmentId) {
    throw new FieldActionError(
      "assignment_changed",
      409,
      "The active job assignment changed. Refresh the job packet before retrying.",
    );
  }
  const proofSlot = boundedText(value.proof_slot, 2, 40, "proof_slot");
  if (!PROOF_SLOTS.has(proofSlot)) throw invalidMetadata();
  const captureStarted = isoDatetime(
    value.capture_started_at,
    "capture_started_at",
  );
  const captureCompleted = isoDatetime(
    value.capture_completed_at,
    "capture_completed_at",
  );
  if (Date.parse(captureCompleted) < Date.parse(captureStarted))
    throw invalidMetadata();
  const blocker = value.blocker === true;
  const blockerCategory = optionalText(value.blocker_category, 40);
  const blockerSummary = optionalText(value.blocker_summary, 1000);
  if (
    blocker &&
    (!blockerCategory ||
      !BLOCKER_CATEGORIES.has(blockerCategory) ||
      !blockerSummary)
  )
    throw invalidMetadata();
  const correctionOf = optionalId(value.correction_of, 140);
  const evidenceCorrectionOf = optionalId(value.evidence_correction_of, 140);
  const evidenceItemCorrectionOf = optionalId(
    value.evidence_item_correction_of,
    140,
  );
  const correctionReason = optionalText(value.correction_reason, 1000);
  if (
    !evidenceCorrectionOf &&
    Boolean(correctionOf) !== Boolean(correctionReason)
  )
    throw invalidMetadata();
  if ((correctionOf || evidenceCorrectionOf) && !correctionReason)
    throw invalidMetadata();
  const locationPermissionState = boundedText(
    value.location_permission_state,
    5,
    20,
    "location_permission_state",
  );
  if (
    !["not_requested", "granted", "denied", "unavailable", "error"].includes(
      locationPermissionState,
    )
  )
    throw invalidMetadata();
  const latitude = optionalNumber(value.latitude, -90, 90);
  const longitude = optionalNumber(value.longitude, -180, 180);
  const locationAccuracyM = optionalNumber(
    value.location_accuracy_m,
    0,
    100_000,
  );
  if (
    locationPermissionState === "granted" &&
    (latitude === null || longitude === null || locationAccuracyM === null)
  )
    throw invalidMetadata();
  if (
    locationPermissionState !== "granted" &&
    (latitude !== null || longitude !== null || locationAccuracyM !== null)
  )
    throw invalidMetadata();
  const workPackageId = optionalId(value.work_package_id, 140);
  const evidenceSlotId = optionalId(value.evidence_slot_id, 140);
  const typedEvidence = workPackageId !== null || evidenceSlotId !== null;
  if (typedEvidence && (!workPackageId || !evidenceSlotId))
    throw invalidMetadata();
  if (typedEvidence && !optionalId(value.work_package_release_attempt_id, 140))
    throw invalidMetadata();
  if (Boolean(evidenceCorrectionOf) !== Boolean(evidenceItemCorrectionOf))
    throw invalidMetadata();
  if (evidenceCorrectionOf && !typedEvidence) throw invalidMetadata();
  if (typedEvidence && evidenceCorrectionOf && !correctionReason)
    throw invalidMetadata();
  if (typedEvidence && !evidenceCorrectionOf && correctionReason)
    throw invalidMetadata();
  if (typedEvidence && correctionOf) throw invalidMetadata();
  if (evidenceItemCorrectionOf && !typedEvidence) throw invalidMetadata();
  const workPackageVersion = optionalPositiveInteger(
    value.work_package_version,
  );
  const evidenceRequirement = optionalText(value.evidence_requirement, 2_000);
  const evidenceSource = optionalText(value.evidence_source, 140);
  const evidenceDeviceId = optionalId(value.evidence_device_id, 140);
  if (
    typedEvidence &&
    (!workPackageVersion || !evidenceRequirement || !evidenceSource)
  ) {
    throw invalidMetadata();
  }
  const evidenceFreshness = typedEvidence
    ? evidenceEnum(
        value.evidence_freshness,
        ["Current", "Stale", "Unknown"] as const,
        "Current",
      )
    : null;
  const evidenceConflictState = typedEvidence
    ? evidenceEnum(
        value.evidence_conflict_state,
        ["None", "Detected", "Resolved"] as const,
        "None",
      )
    : null;
  const evidenceVerification = typedEvidence
    ? evidenceEnum(
        value.evidence_verification,
        ["Pending", "Verified", "Rejected"] as const,
        "Verified",
      )
    : null;
  const evidenceDisposition = typedEvidence
    ? evidenceEnum(
        value.evidence_disposition,
        ["Open", "Accepted", "Needs Correction", "Superseded"] as const,
        "Open",
      )
    : null;
  if (typedEvidence && evidenceVerification !== "Verified")
    throw invalidMetadata();
  if (typedEvidence && evidenceDisposition !== "Open") throw invalidMetadata();
  return {
    assignment_id: suppliedAssignment,
    proof_slot: proofSlot,
    capture_started_at: captureStarted,
    capture_completed_at: captureCompleted,
    notes: optionalText(value.notes, 2000),
    blocker,
    blocker_category: blocker ? blockerCategory : null,
    blocker_summary: blocker ? blockerSummary : null,
    latitude,
    longitude,
    location_accuracy_m: locationAccuracyM,
    location_permission_state:
      locationPermissionState as FieldActionPayload["location_permission_state"],
    correction_of: correctionOf,
    correction_reason: correctionReason,
    evidence_correction_of: evidenceCorrectionOf,
    evidence_item_correction_of: evidenceItemCorrectionOf,
    work_package_release_attempt_id: typedEvidence
      ? optionalId(value.work_package_release_attempt_id, 140)
      : null,
    work_package_id: workPackageId,
    work_package_version: typedEvidence ? workPackageVersion : null,
    evidence_slot_id: evidenceSlotId,
    evidence_requirement: typedEvidence ? evidenceRequirement : null,
    evidence_source: typedEvidence ? evidenceSource : null,
    evidence_device_id: evidenceDeviceId,
    evidence_freshness: evidenceFreshness,
    evidence_conflict_state: evidenceConflictState,
    evidence_verification: evidenceVerification,
    evidence_disposition: evidenceDisposition,
    customer_safe_requested: value.customer_safe_requested === true,
  };
}

function validateSubmission(
  submission: FieldSubmission,
): void {
  boundedId(submission.deviceActionId, 8, 80, "device_action_id");
  boundedText(submission.jobId, 1, 140, "job_id");
  if (submission.payload.assignment_id !== submission.assignmentId)
    throw invalidMetadata();
  if (submission.media.length > MAX_FIELD_MEDIA_COUNT) throw payloadTooLarge();
  if (
    submission.media.reduce((sum, item) => sum + item.size, 0) >
    MAX_FIELD_ACTION_MEDIA_BYTES
  )
    throw payloadTooLarge();
  for (const media of submission.media) {
    boundedId(media.attachmentId, 1, 80, "attachment_id");
    if (
      !FIELD_MEDIA_TYPES.has(media.mimeType) ||
      media.size !== media.blob.size ||
      media.size < 1 ||
      media.size > MAX_FIELD_MEDIA_BYTES
    ) {
      throw new FieldActionError(
        "media_type_or_size_not_allowed",
        415,
        "Only bounded photo and voice-note files are accepted.",
      );
    }
  }
}

function applyTypedEvidenceAuthorization(
  submission: FieldSubmission,
  authorization: FieldEvidenceAuthorization,
): FieldSubmission {
  const payload = submission.payload;
  if (payload.work_package_id !== authorization.workPackageId) {
    throw new FieldActionError(
      "work_package_not_available",
      409,
      "The saved evidence targets a Work Package that is not current for this assignment.",
    );
  }
  if (payload.work_package_version !== authorization.workPackageVersion) {
    throw new FieldActionError(
      "work_package_version_conflict",
      409,
      "The saved evidence targets a stale Work Package version.",
    );
  }
  if (
    payload.work_package_release_attempt_id !== authorization.releaseAttemptId
  ) {
    throw new FieldActionError(
      "work_package_release_attempt_conflict",
      409,
      "The saved evidence targets a stale Work Package release attempt.",
    );
  }
  if (payload.evidence_slot_id !== authorization.slotId) {
    throw new FieldActionError(
      "work_package_evidence_slot_not_found",
      409,
      "The saved evidence slot is not declared by the current Work Package.",
    );
  }
  if (payload.evidence_requirement !== authorization.requirement) {
    throw new FieldActionError(
      "work_package_evidence_requirement_conflict",
      409,
      "The saved evidence requirement does not match the frozen Work Package slot.",
    );
  }
  if (payload.evidence_source !== authorization.source) {
    throw new FieldActionError(
      "evidence_source_mismatch",
      409,
      "The saved evidence source is not authorized for this field capture.",
    );
  }
  if (
    payload.evidence_device_id != null &&
    payload.evidence_device_id !== authorization.deviceId
  ) {
    throw new FieldActionError(
      "evidence_device_mismatch",
      409,
      "The evidence device binding is stale. Reconnect and refresh this package before retrying.",
    );
  }
  if (
    payload.evidence_freshness != null &&
    payload.evidence_freshness !== authorization.freshness
  ) {
    throw new FieldActionError(
      "evidence_freshness_mismatch",
      409,
      "The saved evidence freshness is not authorized by the current capture contract.",
    );
  }
  if (
    payload.evidence_conflict_state != null &&
    payload.evidence_conflict_state !== authorization.conflictState
  ) {
    throw new FieldActionError(
      "evidence_conflict_state_mismatch",
      409,
      "The saved evidence conflict state is not authorized by the current capture contract.",
    );
  }
  if (payload.evidence_correction_of !== authorization.correctionOf) {
    throw new FieldActionError(
      "work_package_evidence_correction_mismatch",
      409,
      "The saved evidence correction does not target the current evidence lineage.",
    );
  }
  if (
    payload.evidence_item_correction_of !== authorization.itemCorrectionOf
  ) {
    throw new FieldActionError(
      "work_package_evidence_correction_mismatch",
      409,
      "The saved Evidence Item correction does not target the current evidence lineage.",
    );
  }
  if (
    submission.scope &&
    !sameWorkObjectScope(submission.scope, authorization.scope)
  ) {
    throw new FieldActionError(
      "work_object_scope_mismatch",
      409,
      "The saved evidence scope does not match the current Work Package.",
    );
  }
  return {
    ...submission,
    scope: authorization.scope,
    payload: {
      ...payload,
      evidence_device_id: authorization.deviceId,
      evidence_freshness: authorization.freshness,
      evidence_conflict_state: authorization.conflictState,
      evidence_verification: "Verified",
      evidence_disposition: "Open",
    },
  };
}

function sameWorkObjectScope(
  left: WorkObjectScope,
  right: WorkObjectScope,
): boolean {
  return (
    left.workObjectType === right.workObjectType &&
    left.workObjectId === right.workObjectId &&
    left.physicalContextType === right.physicalContextType &&
    left.physicalContextId === right.physicalContextId
  );
}

function normalizeSubmissionScope(
  scope: WorkObjectScope | undefined,
  jobId: string,
  typedEvidence: boolean,
): WorkObjectScope | undefined {
  if (!scope) {
    return typedEvidence
      ? {
          workObjectType: "Roof Job",
          workObjectId: jobId,
          physicalContextType: "Roof Site",
          physicalContextId: jobId,
        }
      : undefined;
  }
  const normalized = {
    workObjectType: boundedText(scope.workObjectType, 1, 140, "work_object_type"),
    workObjectId: boundedId(scope.workObjectId, 1, 140, "work_object_id"),
    physicalContextType: boundedText(
      scope.physicalContextType,
      1,
      140,
      "physical_context_type",
    ),
    physicalContextId: boundedId(
      scope.physicalContextId,
      1,
      140,
      "physical_context_id",
    ),
  } satisfies WorkObjectScope;
  if (normalized.workObjectId !== jobId) {
    throw new FieldActionError(
      "work_object_scope_mismatch",
      409,
      "The saved evidence scope does not match the active work object.",
    );
  }
  return normalized;
}

function assertReceiptMatches(
  actual: FieldMediaReceipt,
  expected: FieldMediaReceipt,
): void {
  if (
    actual.evidenceId !== expected.evidenceId ||
    actual.r2Key !== expected.r2Key ||
    actual.checksum !== expected.checksum ||
    actual.contentType !== expected.contentType ||
    actual.contentLength !== expected.contentLength
  ) {
    throw new FieldActionError(
      "media_receipt_conflict",
      409,
      "A prior media receipt does not match this saved action.",
    );
  }
}

function parseStoredResponse(
  value: string | null,
): VerifiedFieldActionResponse | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<VerifiedFieldActionResponse>;
    return parsed.status === "verified" &&
      typeof parsed.device_action_id === "string" &&
      typeof parsed.server_ref === "string" &&
      /^fci_[0-9a-f]{32}$/.test(parsed.server_ref) &&
      parsed.cursor === parsed.server_ref &&
      parsed.checkin_id === parsed.server_ref &&
      Array.isArray(parsed.media)
      ? (parsed as VerifiedFieldActionResponse)
      : null;
  } catch {
    return null;
  }
}

function mediaKey(
  scopeDigest: string,
  checkinId: string,
  evidenceId: string,
  mimeType: string,
): string {
  return `field/v1/${scopeDigest}/${checkinId}/media/${evidenceId}.${extensionForMime(mimeType)}`;
}

function manifestObjectKey(scopeDigest: string, checkinId: string): string {
  return `field/v1/${scopeDigest}/${checkinId}/manifest.json`;
}

function workPackageEvidenceDeviceActionId(evidenceId: string): string {
  return `wpe_${evidenceId.replace(/^evi_/, "")}`;
}

function extensionForMime(mimeType: string): string {
  return (
    (
      {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/heic": "heic",
        "image/heif": "heif",
        "audio/mpeg": "mp3",
        "audio/mp4": "m4a",
        "audio/webm": "webm",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
      } as Record<string, string>
    )[mimeType] ?? "bin"
  );
}

function safeFileName(value: unknown): string {
  const name = boundedText(value, 1, 180, "file_name").normalize("NFKC");
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    /[\u0000-\u001f]/.test(name)
  )
    throw invalidMetadata();
  return name;
}

async function deterministicId(prefix: string, value: string): Promise<string> {
  return `${prefix}_${(await sha256Text(value)).slice(0, 32)}`;
}

async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return hex(new Uint8Array(digest));
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function bodySize(body: Blob | string): number {
  return typeof body === "string" ? byteLength(body) : body.size;
}

export function r2ObjectMatches(
  object: R2Object,
  expectedSize: number,
  checksum: string,
): boolean {
  const serverChecksum = object.checksums?.sha256;
  return (
    object.size === expectedSize &&
    object.customMetadata?.sha256 === checksum &&
    serverChecksum instanceof ArrayBuffer &&
    hex(new Uint8Array(serverChecksum)) === checksum
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedId(
  value: unknown,
  min: number,
  max: number,
  field: string,
): string {
  const parsed = boundedText(value, min, max, field);
  if (!/^[A-Za-z0-9._:-]+$/.test(parsed)) throw invalidMetadata();
  return parsed;
}

function optionalId(value: unknown, max: number): string | null {
  return value === null || value === undefined || value === ""
    ? null
    : boundedId(value, 1, max, "id");
}

function boundedText(
  value: unknown,
  min: number,
  max: number,
  _field: string,
): string {
  if (typeof value !== "string") throw invalidMetadata();
  const parsed = value.trim();
  if (parsed.length < min || parsed.length > max) throw invalidMetadata();
  return parsed;
}

function optionalText(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return boundedText(value, 1, max, "text");
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  _field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw invalidMetadata();
  return value;
}

function optionalNumber(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw invalidMetadata();
  return value;
}

function sameNullable(actual: unknown, expected: string | null): boolean {
  const normalized =
    typeof actual === "string" && actual.trim() ? actual.trim() : null;
  return normalized === expected;
}

function sameNullableNumber(actual: unknown, expected: number | null): boolean {
  if (expected === null)
    return actual === null || actual === undefined || actual === "";
  return Number(actual) === expected;
}

function hasNonEmptyValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value != null;
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 1_000_000
  ) {
    throw invalidMetadata();
  }
  return value;
}

function evidenceEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw invalidMetadata();
  return value as T;
}

function isoDatetime(value: unknown, field: string): string {
  const parsed = boundedText(value, 20, 40, field);
  const time = Date.parse(parsed);
  if (Number.isNaN(time)) throw invalidMetadata();
  return new Date(time).toISOString();
}

function invalidMetadata(): FieldActionError {
  return new FieldActionError(
    "invalid_metadata",
    400,
    "The saved field action metadata is invalid.",
  );
}

function payloadTooLarge(): FieldActionError {
  return new FieldActionError(
    "payload_too_large",
    413,
    "Split field media into smaller saved actions and retry.",
  );
}

function safeErrorCode(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "field_action_failed";
  return /^[a-z0-9_]{3,80}$/.test(message) ? message : "field_action_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fieldJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
