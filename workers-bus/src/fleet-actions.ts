import type { AppEnv, AuthContext } from "./app-types.ts";
import { vehicleSafetyStops } from "./safety-lifecycle.ts";
import {
  FieldActionError,
  r2ObjectStore,
  type ImmutableObjectStore,
} from "./field-actions.ts";
import {
  assertFleetPhotosStored,
  parseFleetPhotoEvidenceRefs,
  type FleetPhotoEvidenceRef,
  type FleetPhotoHead,
} from "./fleet-photo-evidence.ts";

const MAX_FLEET_ACTION_BYTES = 32 * 1024;
const MAX_FLEET_TEXT_LENGTH = 1_200;
const MAX_INSPECTION_ITEMS = 60;
const FLEET_ACTION_LEASE_MS = 90_000;

export type FleetActionKind =
  "pre_trip_inspection" | "post_trip_inspection" | "defect_report";

const INSPECTION_TYPE_BY_KIND = {
  pre_trip_inspection: "Pre-Trip",
  post_trip_inspection: "Post-Trip",
} as const;

export type InspectionItemResult = "Pass" | "Fail" | "Not Applicable";
export type FleetDefectSeverity = "Minor" | "Major" | "Out of Service";

export interface FleetInspectionItem {
  sequence: number;
  check_point: string;
  result: InspectionItemResult;
  severity: "None" | FleetDefectSeverity;
  observation?: string;
}

export interface FleetInspectionPayload {
  fleet_asset_id: string;
  performed_at: string;
  meter_reading?: number;
  items: FleetInspectionItem[];
  /**
   * A provider telematics reference may travel with the capture as supporting
   * evidence. It never substitutes for the authenticated physical inspector.
   */
  telematics_reference?: string;
}

export interface FleetDefectPayload {
  fleet_asset_id: string;
  detected_at: string;
  severity: FleetDefectSeverity;
  description: string;
  asset_inspection_id?: string;
  photo_evidence?: FleetPhotoEvidenceRef[];
}

export type FleetActionPayload = FleetInspectionPayload | FleetDefectPayload;

export interface FleetActionSubmission {
  deviceActionId: string;
  fleetAssetId: string;
  kind: FleetActionKind;
  payload: FleetActionPayload;
}

export interface VerifiedFleetActionResponse {
  device_action_id: string;
  status: "verified";
  server_ref: string;
  cursor: string;
}

interface FleetActionIdentity {
  deviceActionId: string;
  tenantId: string;
  userId: string;
  fleetAssetId: string;
  kind: FleetActionKind;
  payloadHash: string;
}

interface ClaimInput extends FleetActionIdentity {
  now: string;
  token: string;
  leaseExpiresAt: string;
}

type ClaimResult =
  | { state: "acquired" }
  | { state: "busy" }
  | { state: "conflict" }
  | { state: "verified"; response: VerifiedFleetActionResponse };

export interface FleetActionStore {
  find(
    identity: FleetActionIdentity,
  ): Promise<
    | { state: "matching" }
    | { state: "verified"; response: VerifiedFleetActionResponse }
    | { state: "mismatch" }
    | null
  >;
  claim(input: ClaimInput): Promise<ClaimResult>;
  renew(
    tenantId: string,
    deviceActionId: string,
    token: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<boolean>;
  markR2Stored(
    tenantId: string,
    deviceActionId: string,
    token: string,
    manifestKey: string,
    now: string,
  ): Promise<void>;
  complete(
    tenantId: string,
    deviceActionId: string,
    token: string,
    response: VerifiedFleetActionResponse,
    now: string,
  ): Promise<void>;
  fail(
    tenantId: string,
    deviceActionId: string,
    token: string,
    errorCode: string,
    now: string,
  ): Promise<void>;
}

export interface PersistFleetActionInput {
  kind: FleetActionKind;
  tenantId: string;
  fleetAssetId: string;
  actorUserId: string;
  deviceActionId: string;
  manifestKey: string;
  payloadHash: string;
  recordedAt: string;
  payload: FleetActionPayload;
}

export interface FleetActionWriter {
  persistAction(
    input: PersistFleetActionInput,
  ): Promise<{ recordName: string; assetName: string }>;
}

export interface ProcessFleetActionDependencies {
  store: FleetActionStore;
  objects: ImmutableObjectStore;
  writer: FleetActionWriter;
  raw?: FleetPhotoHead;
  now?: () => Date;
  randomId?: () => string;
}

/**
 * Pre-trip, post-trip, and defect captures share this single JSON envelope.
 *
 * The device action id is the idempotency boundary, so a driver who loses
 * connectivity mid-submit can replay the identical capture until the Worker
 * confirms it verified; the same id bound to different facts is a conflict,
 * never a silent overwrite. D1 independently re-checks the asset, inspector,
 * custody, evidence binding, and lifecycle rule inside the same write.
 */
export async function handleFleetAction(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  fleetAssetId: string,
  kind: FleetActionKind,
): Promise<Response> {
  try {
    const submission = await parseFleetActionRequest(req, fleetAssetId, kind);
    const response = await processFleetAction(submission, auth, {
      store: d1FleetActionStore(env),
      objects: r2ObjectStore(env.RAW),
      writer: d1FleetActionWriter(env),
      raw: env.RAW,
    });
    return fleetJson(response);
  } catch (error) {
    const failure =
      error instanceof FieldActionError
        ? error
        : new FieldActionError(
            "fleet_action_failed",
            502,
            "The fleet action could not be verified yet.",
            5,
          );
    const response = fleetJson(
      { ...failure.details, error: failure.code, message: failure.message },
      failure.status,
    );
    if (failure.retryAfterSeconds)
      response.headers.set("retry-after", String(failure.retryAfterSeconds));
    return response;
  }
}

export async function parseFleetActionRequest(
  req: Request,
  fleetAssetId: string,
  kind: FleetActionKind,
): Promise<FleetActionSubmission> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FLEET_ACTION_BYTES)
    throw fleetPayloadTooLarge();
  if (
    !req.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw invalidFleetAction();
  }
  let source: string;
  try {
    source = await req.text();
  } catch {
    throw invalidFleetAction();
  }
  if (byteLength(source) > MAX_FLEET_ACTION_BYTES) throw fleetPayloadTooLarge();
  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch {
    throw invalidFleetAction();
  }
  if (
    !isRecord(decoded) ||
    !exactKeys(decoded, ["device_action_id", "payload"])
  )
    throw invalidFleetAction();
  const deviceActionId = boundedId(decoded.device_action_id, 8, 80);
  assertActionHeader(req.headers.get("x-device-action-id"), deviceActionId);
  assertActionHeader(req.headers.get("idempotency-key"), deviceActionId);
  if (!isRecord(decoded.payload)) throw invalidFleetAction();
  const assetId = boundedId(fleetAssetId, 1, 140);
  const payload =
    kind === "defect_report"
      ? parseDefectPayload(decoded.payload, assetId)
      : parseInspectionPayload(decoded.payload, assetId);
  return { deviceActionId, fleetAssetId: assetId, kind, payload };
}

function parseInspectionPayload(
  value: Record<string, unknown>,
  fleetAssetId: string,
): FleetInspectionPayload {
  if (
    !optionalKeys(
      value,
      ["fleet_asset_id", "performed_at", "items"],
      ["meter_reading", "telematics_reference"],
    )
  ) {
    throw invalidFleetAction();
  }
  if (boundedId(value.fleet_asset_id, 1, 140) !== fleetAssetId)
    throw invalidFleetAction();
  if (
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > MAX_INSPECTION_ITEMS
  ) {
    throw invalidFleetAction();
  }
  const items = value.items.map((row, index) =>
    parseInspectionItem(row, index + 1),
  );
  const payload: FleetInspectionPayload = {
    fleet_asset_id: fleetAssetId,
    performed_at: isoTimestamp(value.performed_at),
    items,
  };
  if (value.meter_reading !== undefined)
    payload.meter_reading = nonNegativeNumber(value.meter_reading);
  if (value.telematics_reference !== undefined) {
    payload.telematics_reference = boundedText(
      value.telematics_reference,
      1,
      140,
    );
  }
  return payload;
}

function parseInspectionItem(
  value: unknown,
  expectedSequence: number,
): FleetInspectionItem {
  if (
    !isRecord(value) ||
    !optionalKeys(
      value,
      ["sequence", "check_point", "result"],
      ["severity", "observation"],
    )
  ) {
    throw invalidFleetAction();
  }
  if (value.sequence !== expectedSequence) throw invalidFleetAction();
  const result = value.result;
  if (result !== "Pass" && result !== "Fail" && result !== "Not Applicable")
    throw invalidFleetAction();
  const severity = value.severity === undefined ? "None" : value.severity;
  if (
    severity !== "None" &&
    severity !== "Minor" &&
    severity !== "Major" &&
    severity !== "Out of Service"
  ) {
    throw invalidFleetAction();
  }
  // A failed check point without a severity would let a device downgrade a
  // real defect into a note, so the envelope refuses it before the D1 authority write.
  if (result === "Fail" && severity === "None") throw invalidFleetAction();
  if (result !== "Fail" && severity !== "None") throw invalidFleetAction();
  const item: FleetInspectionItem = {
    sequence: expectedSequence,
    check_point: boundedText(value.check_point, 1, 140),
    result,
    severity,
  };
  if (value.observation !== undefined) {
    item.observation = boundedText(value.observation, 1, MAX_FLEET_TEXT_LENGTH);
  }
  return item;
}

function parseDefectPayload(
  value: Record<string, unknown>,
  fleetAssetId: string,
): FleetDefectPayload {
  if (
    !optionalKeys(
      value,
      ["fleet_asset_id", "detected_at", "severity", "description"],
      ["asset_inspection_id", "photo_evidence"],
    )
  ) {
    throw invalidFleetAction();
  }
  if (boundedId(value.fleet_asset_id, 1, 140) !== fleetAssetId)
    throw invalidFleetAction();
  const severity = value.severity;
  if (
    severity !== "Minor" &&
    severity !== "Major" &&
    severity !== "Out of Service"
  ) {
    throw invalidFleetAction();
  }
  const payload: FleetDefectPayload = {
    fleet_asset_id: fleetAssetId,
    detected_at: isoTimestamp(value.detected_at),
    severity,
    description: boundedText(value.description, 1, MAX_FLEET_TEXT_LENGTH),
  };
  if (value.asset_inspection_id !== undefined) {
    payload.asset_inspection_id = boundedId(value.asset_inspection_id, 1, 140);
  }
  if (value.photo_evidence !== undefined) {
    payload.photo_evidence = parseFleetPhotoEvidenceRefs(value.photo_evidence);
  }
  return payload;
}

export async function processFleetAction(
  submission: FleetActionSubmission,
  auth: AuthContext,
  dependencies: ProcessFleetActionDependencies,
): Promise<VerifiedFleetActionResponse> {
  validateSubmission(submission, auth);
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? (() => crypto.randomUUID());
  const identity = await actionIdentity(submission, auth);
  const existing = await dependencies.store.find(identity);
  if (existing?.state === "verified") return existing.response;
  if (existing?.state === "mismatch") throw fleetIdempotencyConflict();

  const started = now();
  const token = randomId();
  const claim = await dependencies.store.claim({
    ...identity,
    now: started.toISOString(),
    token,
    leaseExpiresAt: new Date(
      started.getTime() + FLEET_ACTION_LEASE_MS,
    ).toISOString(),
  });
  if (claim.state === "verified") return claim.response;
  if (claim.state === "conflict") throw fleetIdempotencyConflict();
  if (claim.state === "busy") {
    throw new FieldActionError(
      "action_in_progress",
      503,
      "This fleet action is already being verified.",
      3,
    );
  }

  try {
    if (submission.kind === "defect_report" && "photo_evidence" in submission.payload) {
      const photos = submission.payload.photo_evidence;
      if (photos) {
        if (!dependencies.raw) {
          throw new FieldActionError(
            "fleet_photo_missing",
            409,
            "Fleet photo evidence is not stored yet.",
          );
        }
        await assertFleetPhotosStored(dependencies.raw, photos);
      }
    }
    const scopeDigest = (
      await sha256Text(`${auth.session.tenant_id}:${submission.fleetAssetId}`)
    ).slice(0, 24);
    const manifest = stableStringify({
      version: 1,
      tenant_id: auth.session.tenant_id,
      user_id: auth.session.user_id,
      actor_user_id: auth.session.user_id,
      fleet_asset_id: submission.fleetAssetId,
      action_kind: submission.kind,
      device_action_id: submission.deviceActionId,
      payload: submission.payload,
    });
    const manifestKey = fleetManifestKey(
      scopeDigest,
      submission.kind,
      submission.deviceActionId,
    );
    await renewLease(
      dependencies.store,
      auth.session.tenant_id,
      submission.deviceActionId,
      token,
      now,
    );
    await dependencies.objects.ensure(
      manifestKey,
      manifest,
      "application/json",
      await sha256Text(manifest),
    );
    await dependencies.store.markR2Stored(
      auth.session.tenant_id,
      submission.deviceActionId,
      token,
      manifestKey,
      now().toISOString(),
    );

    await renewLease(
      dependencies.store,
      auth.session.tenant_id,
      submission.deviceActionId,
      token,
      now,
    );
    const persisted = await dependencies.writer.persistAction({
      kind: submission.kind,
      tenantId: auth.session.tenant_id,
      fleetAssetId: submission.fleetAssetId,
      actorUserId: auth.session.user_id,
      deviceActionId: submission.deviceActionId,
      manifestKey,
      payloadHash: identity.payloadHash,
      recordedAt: now().toISOString(),
      payload: submission.payload,
    });
    const response: VerifiedFleetActionResponse = {
      device_action_id: submission.deviceActionId,
      status: "verified",
      server_ref: persisted.recordName,
      cursor: persisted.assetName,
    };
    await renewLease(
      dependencies.store,
      auth.session.tenant_id,
      submission.deviceActionId,
      token,
      now,
    );
    await dependencies.store.complete(
      auth.session.tenant_id,
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
      .fail(
        auth.session.tenant_id,
        submission.deviceActionId,
        token,
        code,
        now().toISOString(),
      )
      .catch(() => {});
    throw error instanceof FieldActionError
      ? error
      : new FieldActionError(
          code,
          502,
          "The fleet action remains unverified until its evidence and native authority write both succeed.",
          5,
        );
  }
}

export function d1FleetActionWriter(env: AppEnv): FleetActionWriter {
  return {
    async persistAction(input) {
      const replay = await nativeFleetRecord(env, input);
      if (replay) return replay;
      // An active safety stop on this vehicle holds its use: no pre-trip takes it out (P33). A
      // post-trip and a defect report stay open. 0171 repeats the rule in D1.
      if (input.kind === "pre_trip_inspection") {
        const stops = await vehicleSafetyStops(env, input.tenantId, input.fleetAssetId);
        if (stops.length > 0) throw vehicleStopRefusal(stops);
      }
      try {
        const result =
          input.kind === "defect_report"
            ? await insertNativeFleetDefect(env, input)
            : await insertNativeFleetInspection(env, input);
        if (Number(result.meta.changes ?? 0) !== 1)
          throw new Error("fleet_native_write_missing");
      } catch (error) {
        const recovered = await nativeFleetRecord(env, input);
        if (recovered) return recovered;
        if (error instanceof Error && error.message.includes("fleet_vehicle_safety_stop_active")) {
          throw vehicleStopRefusal(await vehicleSafetyStops(env, input.tenantId, input.fleetAssetId));
        }
        throw nativeFleetWriteError(error);
      }
      return {
        recordName: nativeFleetRecordId(input.kind, input.deviceActionId),
        assetName: input.fleetAssetId,
      };
    },
  };
}

interface NativeInspectionRow {
  inspection_id: string;
  tenant_id: string;
  fleet_asset_id: string;
  user_id: string;
  inspection_type: string;
  performed_at: string;
  meter_reading_milli: number | null;
  telematics_reference: string | null;
  items_json: string;
  result: string;
  defect_count: number;
  out_of_service: number;
  next_inspection_due: string | null;
  manifest_key: string;
  payload_hash: string;
}

interface NativeDefectRow {
  defect_id: string;
  tenant_id: string;
  fleet_asset_id: string;
  user_id: string;
  source_inspection_id: string | null;
  severity: string;
  detected_at: string;
  description: string;
  manifest_key: string;
  payload_hash: string;
}

async function nativeFleetRecord(
  env: AppEnv,
  input: PersistFleetActionInput,
): Promise<{ recordName: string; assetName: string } | null> {
  if (input.kind === "defect_report") {
    const row = await env.DB.prepare(
      `SELECT defect_id, tenant_id, fleet_asset_id, user_id, source_inspection_id,
              severity, detected_at, description, manifest_key, payload_hash
         FROM fleet_defects WHERE tenant_id = ? AND device_action_id = ?`,
    )
      .bind(input.tenantId, input.deviceActionId)
      .first<NativeDefectRow>();
    if (!row) return null;
    const payload = input.payload as FleetDefectPayload;
    if (
      row.tenant_id !== input.tenantId ||
      row.fleet_asset_id !== input.fleetAssetId ||
      row.user_id !== input.actorUserId ||
      row.source_inspection_id !== (payload.asset_inspection_id ?? null) ||
      row.severity !== payload.severity ||
      row.detected_at !== payload.detected_at ||
      row.description !== payload.description ||
      row.manifest_key !== input.manifestKey ||
      row.payload_hash !== input.payloadHash
    ) {
      throw fleetIdempotencyConflict();
    }
    return { recordName: row.defect_id, assetName: row.fleet_asset_id };
  }

  const row = await env.DB.prepare(
    `SELECT inspection_id, tenant_id, fleet_asset_id, user_id, inspection_type,
            performed_at, meter_reading_milli, telematics_reference, items_json,
            result, defect_count, out_of_service, next_inspection_due,
            manifest_key, payload_hash
       FROM fleet_inspections WHERE tenant_id = ? AND device_action_id = ?`,
  )
    .bind(input.tenantId, input.deviceActionId)
    .first<NativeInspectionRow>();
  if (!row) return null;
  const expected = nativeInspection(input);
  if (
    row.tenant_id !== input.tenantId ||
    row.fleet_asset_id !== input.fleetAssetId ||
    row.user_id !== input.actorUserId ||
    row.inspection_type !== expected.inspectionType ||
    row.performed_at !== expected.payload.performed_at ||
    row.meter_reading_milli !== expected.meterReadingMilli ||
    row.telematics_reference !==
      (expected.payload.telematics_reference ?? null) ||
    row.items_json !== expected.itemsJson ||
    row.result !== expected.result ||
    row.defect_count !== expected.defectCount ||
    row.out_of_service !== expected.outOfService ||
    row.next_inspection_due !== expected.nextInspectionDue ||
    row.manifest_key !== input.manifestKey ||
    row.payload_hash !== input.payloadHash
  ) {
    throw fleetIdempotencyConflict();
  }
  return { recordName: row.inspection_id, assetName: row.fleet_asset_id };
}

async function insertNativeFleetInspection(
  env: AppEnv,
  input: PersistFleetActionInput,
) {
  const inspection = nativeInspection(input);
  return await env.DB.prepare(
    `INSERT INTO fleet_inspections
       (inspection_id, device_action_id, tenant_id, fleet_asset_id, user_id,
        inspection_type, performed_at, meter_reading_milli, telematics_reference,
        items_json, result, defect_count, out_of_service, next_inspection_due,
        manifest_key, payload_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      nativeFleetRecordId(input.kind, input.deviceActionId),
      input.deviceActionId,
      input.tenantId,
      input.fleetAssetId,
      input.actorUserId,
      inspection.inspectionType,
      inspection.payload.performed_at,
      inspection.meterReadingMilli,
      inspection.payload.telematics_reference ?? null,
      inspection.itemsJson,
      inspection.result,
      inspection.defectCount,
      inspection.outOfService,
      inspection.nextInspectionDue,
      input.manifestKey,
      input.payloadHash,
      input.recordedAt,
    )
    .run();
}

async function insertNativeFleetDefect(
  env: AppEnv,
  input: PersistFleetActionInput,
) {
  const payload = input.payload as FleetDefectPayload;
  if (payload.asset_inspection_id) {
    const source = await env.DB.prepare(
      `SELECT inspection_id FROM fleet_inspections
        WHERE inspection_id = ? AND tenant_id = ? AND fleet_asset_id = ?`,
    )
      .bind(payload.asset_inspection_id, input.tenantId, input.fleetAssetId)
      .first();
    if (!source) {
      throw new FieldActionError(
        "fleet_source_inspection_not_found",
        409,
        "The referenced native fleet inspection does not exist for this asset.",
      );
    }
  }
  return await env.DB.prepare(
    `INSERT INTO fleet_defects
       (defect_id, device_action_id, tenant_id, fleet_asset_id, user_id,
        source_inspection_id, severity, detected_at, description, manifest_key,
        payload_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      nativeFleetRecordId(input.kind, input.deviceActionId),
      input.deviceActionId,
      input.tenantId,
      input.fleetAssetId,
      input.actorUserId,
      payload.asset_inspection_id ?? null,
      payload.severity,
      payload.detected_at,
      payload.description,
      input.manifestKey,
      input.payloadHash,
      input.recordedAt,
    )
    .run();
}

function nativeInspection(input: PersistFleetActionInput) {
  const payload = input.payload as FleetInspectionPayload;
  const failed = payload.items.filter((item) => item.result === "Fail");
  const unsafe = failed.some(
    (item) => item.severity === "Major" || item.severity === "Out of Service",
  );
  const outOfService = failed.some((item) => item.severity === "Out of Service")
    ? 1
    : 0;
  const result =
    failed.length === 0 ? "Pass" : unsafe ? "Fail" : "Pass With Defects";
  return {
    payload,
    inspectionType:
      INSPECTION_TYPE_BY_KIND[
        input.kind as keyof typeof INSPECTION_TYPE_BY_KIND
      ],
    meterReadingMilli:
      payload.meter_reading === undefined
        ? null
        : Math.round(payload.meter_reading * 1_000),
    itemsJson: stableStringify(payload.items),
    result,
    defectCount: failed.length,
    outOfService,
    nextInspectionDue: result === "Fail" ? null : nextDay(payload.performed_at),
  };
}

function nativeFleetRecordId(
  kind: FleetActionKind,
  deviceActionId: string,
): string {
  return `${kind === "defect_report" ? "defect" : "inspection"}:${deviceActionId}`;
}

function nextDay(timestamp: string): string {
  const date = new Date(timestamp);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * A pre-trip inspection on a vehicle an active safety stop holds: 409 `{ error:
 * "fleet_vehicle_safety_stop_active", message, safety_stops: [{ occurrence_id, scope: "vehicle",
 * reported_at, summary, raiser_display_name }] }`.
 */
function vehicleStopRefusal(stops: Awaited<ReturnType<typeof vehicleSafetyStops>>): FieldActionError {
  return new FieldActionError(
    "fleet_vehicle_safety_stop_active",
    409,
    "A safety stop holds this vehicle. It stays parked until a person releases the stop.",
    undefined,
    false,
    { safety_stops: stops },
  );
}

function nativeFleetWriteError(error: unknown): Error {
  if (error instanceof FieldActionError) return error;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("fleet_vehicle_safety_stop_active")) {
    return vehicleStopRefusal([]);
  }
  if (message.includes("fleet_asset_not_found")) {
    return new FieldActionError(
      "fleet_asset_not_found",
      404,
      "The fleet asset was not found.",
    );
  }
  if (message.includes("fleet_meter_regression")) {
    return new FieldActionError(
      "fleet_meter_regression",
      409,
      "The meter reading is older than the native fleet record.",
    );
  }
  if (
    message.includes("fleet_inspection_action_binding_invalid") ||
    message.includes("fleet_defect_action_binding_invalid")
  ) {
    return new FieldActionError(
      "fleet_evidence_binding_invalid",
      409,
      "The fleet evidence receipt no longer owns this action.",
    );
  }
  return new Error("fleet_native_write_failed");
}

/**
 * Exported so the lease discipline of every D1 statement can be asserted
 * directly; production callers reach it only through `handleFleetAction`.
 */
export function d1FleetActionStore(env: AppEnv): FleetActionStore {
  return {
    async find(identity) {
      const row = await fleetActionRow(
        env,
        identity.tenantId,
        identity.deviceActionId,
      );
      if (!row) return null;
      if (!matchesIdentity(row, identity)) return { state: "mismatch" };
      if (row.status !== "verified") return { state: "matching" };
      const response = parseStoredResponse(row.response_json);
      if (!response) throw new Error("fleet_action_verified_response_invalid");
      return { state: "verified", response };
    },
    async claim(input) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO fleet_asset_actions
          (device_action_id, tenant_id, user_id, fleet_asset_id, action_kind,
           payload_hash, status, processing_token, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)`,
      )
        .bind(
          input.deviceActionId,
          input.tenantId,
          input.userId,
          input.fleetAssetId,
          input.kind,
          input.payloadHash,
          input.token,
          input.leaseExpiresAt,
          input.now,
          input.now,
        )
        .run();
      let row = await fleetActionRow(
        env,
        input.tenantId,
        input.deviceActionId,
      );
      if (!row) throw new Error("fleet_action_claim_missing");
      if (!matchesIdentity(row, input)) return { state: "conflict" };
      if (row.status === "verified") {
        const response = parseStoredResponse(row.response_json);
        if (!response)
          throw new Error("fleet_action_verified_response_invalid");
        return { state: "verified", response };
      }
      if (row.processing_token === input.token) return { state: "acquired" };
      const reclaimable =
        row.status === "retryable_error" ||
        !row.lease_expires_at ||
        row.lease_expires_at <= input.now;
      if (!reclaimable) return { state: "busy" };
      await env.DB.prepare(
        `UPDATE fleet_asset_actions
         SET status = 'processing', processing_token = ?, lease_expires_at = ?, updated_at = ?, last_error = NULL
         WHERE tenant_id = ? AND device_action_id = ? AND payload_hash = ? AND status != 'verified'
           AND (status = 'retryable_error' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
        .bind(
          input.token,
          input.leaseExpiresAt,
          input.now,
          input.tenantId,
          input.deviceActionId,
          input.payloadHash,
          input.now,
        )
        .run();
      row = await fleetActionRow(
        env,
        input.tenantId,
        input.deviceActionId,
      );
      return row?.processing_token === input.token
        ? { state: "acquired" }
        : { state: "busy" };
    },
    async renew(tenantId, deviceActionId, token, now, leaseExpiresAt) {
      const result = await env.DB.prepare(
        `UPDATE fleet_asset_actions SET lease_expires_at = ?, updated_at = ?
         WHERE tenant_id = ? AND device_action_id = ? AND processing_token = ? AND status != 'verified'`,
      )
        .bind(leaseExpiresAt, now, tenantId, deviceActionId, token)
        .run();
      return Number(result.meta.changes ?? 0) === 1;
    },
    async markR2Stored(tenantId, deviceActionId, token, manifestKey, now) {
      // Lease-guarded like renew/complete/fail: a superseded worker must never
      // write its own evidence status over the row the current owner holds.
      const result = await env.DB.prepare(
        `UPDATE fleet_asset_actions
         SET status = 'r2_stored', manifest_key = COALESCE(manifest_key, ?), updated_at = ?
         WHERE tenant_id = ? AND device_action_id = ? AND processing_token = ? AND status != 'verified'`,
      )
        .bind(manifestKey, now, tenantId, deviceActionId, token)
        .run();
      if (Number(result.meta.changes ?? 0) !== 1)
        throw new Error("fleet_action_lease_lost");
    },
    async complete(tenantId, deviceActionId, token, response, now) {
      const result = await env.DB.prepare(
        `UPDATE fleet_asset_actions
         SET status = 'verified', response_json = ?, verified_at = ?, updated_at = ?,
             processing_token = NULL, lease_expires_at = NULL, last_error = NULL
         WHERE tenant_id = ? AND device_action_id = ? AND processing_token = ? AND status != 'verified'`,
      )
        .bind(JSON.stringify(response), now, now, tenantId, deviceActionId, token)
        .run();
      if (Number(result.meta.changes ?? 0) !== 1)
        throw new Error("fleet_action_lease_lost");
    },
    async fail(tenantId, deviceActionId, token, errorCode, now) {
      await env.DB.prepare(
        `UPDATE fleet_asset_actions
         SET status = 'retryable_error', last_error = ?, updated_at = ?, processing_token = NULL, lease_expires_at = NULL
         WHERE tenant_id = ? AND device_action_id = ? AND processing_token = ? AND status != 'verified'`,
      )
        .bind(errorCode.slice(0, 240), now, tenantId, deviceActionId, token)
        .run();
    },
  };
}

interface FleetActionRow {
  device_action_id: string;
  tenant_id: string;
  user_id: string;
  fleet_asset_id: string;
  action_kind: string;
  payload_hash: string;
  status: string;
  processing_token: string | null;
  lease_expires_at: string | null;
  response_json: string | null;
}

async function fleetActionRow(
  env: AppEnv,
  tenantId: string,
  deviceActionId: string,
): Promise<FleetActionRow | null> {
  return await env.DB.prepare(
    `SELECT device_action_id, tenant_id, user_id, fleet_asset_id, action_kind,
            payload_hash, status, processing_token, lease_expires_at, response_json
     FROM fleet_asset_actions WHERE tenant_id = ? AND device_action_id = ?`,
  )
    .bind(tenantId, deviceActionId)
    .first<FleetActionRow>();
}

function matchesIdentity(
  row: FleetActionRow,
  input: FleetActionIdentity,
): boolean {
  return (
    row.tenant_id === input.tenantId &&
    row.user_id === input.userId &&
    row.fleet_asset_id === input.fleetAssetId &&
    row.action_kind === input.kind &&
    row.payload_hash === input.payloadHash
  );
}

async function actionIdentity(
  submission: FleetActionSubmission,
  auth: AuthContext,
): Promise<FleetActionIdentity> {
  return {
    deviceActionId: submission.deviceActionId,
    tenantId: auth.session.tenant_id,
    userId: auth.session.user_id,
    fleetAssetId: submission.fleetAssetId,
    kind: submission.kind,
    payloadHash: await sha256Text(
      stableStringify({
        fleet_asset_id: submission.fleetAssetId,
        action_kind: submission.kind,
        payload: submission.payload,
      }),
    ),
  };
}

async function renewLease(
  store: FleetActionStore,
  tenantId: string,
  deviceActionId: string,
  token: string,
  now: () => Date,
): Promise<void> {
  const current = now();
  const renewed = await store.renew(
    tenantId,
    deviceActionId,
    token,
    current.toISOString(),
    new Date(current.getTime() + FLEET_ACTION_LEASE_MS).toISOString(),
  );
  if (!renewed)
    throw new FieldActionError(
      "action_lease_lost",
      503,
      "Another retry now owns this fleet action.",
      3,
    );
}

function validateSubmission(
  submission: FleetActionSubmission,
  auth: AuthContext,
): void {
  boundedId(submission.deviceActionId, 8, 80);
  boundedId(submission.fleetAssetId, 1, 140);
  if (auth.session.role !== "field") {
    throw new FieldActionError(
      "field_role_required",
      403,
      "A field role is required for fleet actions.",
    );
  }
  if (submission.payload.fleet_asset_id !== submission.fleetAssetId)
    throw invalidFleetAction();
}

function parseStoredResponse(
  value: string | null,
): VerifiedFleetActionResponse | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<VerifiedFleetActionResponse>;
    return parsed.status === "verified" &&
      typeof parsed.device_action_id === "string" &&
      typeof parsed.server_ref === "string" &&
      typeof parsed.cursor === "string"
      ? (parsed as VerifiedFleetActionResponse)
      : null;
  } catch {
    return null;
  }
}

function fleetManifestKey(
  scopeDigest: string,
  kind: FleetActionKind,
  deviceActionId: string,
): string {
  return `fleet/v1/${scopeDigest}/${kind}/${deviceActionId}/manifest.json`;
}

function assertActionHeader(
  value: string | null,
  deviceActionId: string,
): void {
  if (value !== null && value.trim() !== deviceActionId)
    throw invalidFleetAction();
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return optionalKeys(value, allowed, []);
}

function optionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = new Set(Object.keys(value));
  if (required.some((key) => !keys.has(key))) return false;
  const allowed = new Set([...required, ...optional]);
  return [...keys].every((key) => allowed.has(key));
}

function boundedId(value: unknown, min: number, max: number): string {
  const parsed = boundedText(value, min, max);
  if (!/^[A-Za-z0-9._:-]+$/.test(parsed)) throw invalidFleetAction();
  return parsed;
}

function boundedText(value: unknown, min: number, max: number): string {
  if (typeof value !== "string") throw invalidFleetAction();
  const parsed = value.trim();
  if (parsed.length < min || parsed.length > max) throw invalidFleetAction();
  return parsed;
}

function isoTimestamp(value: unknown): string {
  const parsed = boundedText(value, 20, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(parsed))
    throw invalidFleetAction();
  if (Number.isNaN(Date.parse(parsed))) throw invalidFleetAction();
  return parsed;
}

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw invalidFleetAction();
  const scaled = value * 1_000;
  if (
    !Number.isSafeInteger(Math.round(scaled)) ||
    Math.abs(scaled - Math.round(scaled)) > 1e-6
  ) {
    throw invalidFleetAction();
  }
  return value;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

function safeErrorCode(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "fleet_action_failed";
  return /^[a-z0-9_]{3,80}$/.test(message) ? message : "fleet_action_failed";
}

function invalidFleetAction(): FieldActionError {
  return new FieldActionError(
    "invalid_fleet_action",
    400,
    "The fleet action is invalid.",
  );
}

function fleetIdempotencyConflict(): FieldActionError {
  return new FieldActionError(
    "idempotency_conflict",
    409,
    "This device action id is already bound to a different fleet action.",
  );
}

function fleetPayloadTooLarge(): FieldActionError {
  return new FieldActionError(
    "fleet_action_too_large",
    413,
    "The fleet action is too large.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fleetJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
