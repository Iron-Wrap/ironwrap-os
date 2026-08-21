import { validAppCsrf } from "./app-auth.ts";
import { fleetAssetForFieldActor } from "./app-read-models.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import { FieldActionError } from "./field-actions.ts";
import {
  assertCollisionNotTelematicsAuthorized,
  canTransitionFleetCollision,
  collisionIndexKey,
  collisionRecordKey,
  FLEET_COLLISION_KIND,
  FLEET_COLLISION_STATES,
  parseFleetCollisionId,
  type FleetCollisionId,
  type FleetCollisionRecord,
  type FleetCollisionSeverity,
  type FleetCollisionState,
} from "./fleet-collision.ts";
import {
  assertFleetPhotosStored,
  parseFleetPhotoEvidenceRefs,
} from "./fleet-photo-evidence.ts";

const MAX_COLLISION_BYTES = 16 * 1024;
const MAX_DESCRIPTION = 1_200;

export interface FleetCollisionIndex {
  collision_ids: FleetCollisionId[];
}

export async function handleFleetCollisionCollection(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedAssetName: string,
): Promise<Response> {
  const scoped = await scopedFleetAsset(req, env, auth, encodedAssetName, req.method !== "GET");
  if (scoped instanceof Response) return scoped;
  if (req.method === "GET") {
    const collisions = await listCollisions(env.RAW, scoped.scopeDigest);
    return json({ collisions });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const created = await createCollision(req, env, auth, scoped.assetName, scoped.scopeDigest);
    return json({ collision: created }, 201);
  } catch (error) {
    return collisionError(error);
  }
}

export async function handleFleetCollisionTransition(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedAssetName: string,
  encodedCollisionId: string,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const scoped = await scopedFleetAsset(req, env, auth, encodedAssetName, true);
  if (scoped instanceof Response) return scoped;
  const collisionId = parseFleetCollisionId(decodeSegment(encodedCollisionId) ?? "");
  if (!collisionId) return json({ error: "not_found" }, 404);
  try {
    const updated = await transitionCollision(req, env, auth, scoped.scopeDigest, collisionId);
    return json({ collision: updated });
  } catch (error) {
    return collisionError(error);
  }
}

async function scopedFleetAsset(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedAssetName: string,
  mutating: boolean,
): Promise<{ assetName: string; scopeDigest: string } | Response> {
  if (auth.session.role !== "field") return json({ error: "field_role_required" }, 403);
  if (mutating && !validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const assetName = decodeSegment(encodedAssetName);
  if (!assetName) return json({ error: "not_found" }, 404);
  const asset = await fleetAssetForFieldActor(env, auth, assetName);
  if (!asset) return json({ error: "not_found" }, 404);
  return {
    assetName,
    scopeDigest: (await sha256Text(`${auth.session.tenant_id}:${assetName}`)).slice(0, 24),
  };
}

async function createCollision(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  fleetAssetId: string,
  scopeDigest: string,
): Promise<FleetCollisionRecord> {
  const reporter = auth.session.frappe_user_id?.trim() ?? "";
  const body = await readJson(req);
  if (!exactKeys(body, [
    "collision_id",
    "occurred_at",
    "severity",
    "description",
  ], ["photo_evidence", "telematics_reference"])) {
    throw invalidCollision();
  }
  const collisionId = parseFleetCollisionId(text(body.collision_id));
  if (!collisionId) throw invalidCollision();
  const telematics = body.telematics_reference === undefined
    ? null
    : boundedText(body.telematics_reference, 1, 140);
  assertCollisionNotTelematicsAuthorized(reporter, telematics);
  const photos = body.photo_evidence === undefined
    ? []
    : parseFleetPhotoEvidenceRefs(body.photo_evidence);
  if (photos.length > 0) await assertFleetPhotosStored(env.RAW, photos);
  const now = new Date().toISOString();
  const record: FleetCollisionRecord = {
    collision_id: collisionId,
    tenant_id: auth.session.tenant_id,
    fleet_asset_id: fleetAssetId,
    kind: FLEET_COLLISION_KIND,
    state: "reported",
    severity: collisionSeverity(body.severity),
    occurred_at: isoTimestamp(body.occurred_at),
    reported_by: reporter,
    description: boundedText(body.description, 3, MAX_DESCRIPTION),
    photo_evidence: photos,
    telematics_reference: telematics,
    created_at: now,
    updated_at: now,
  };
  const key = collisionRecordKey(scopeDigest, collisionId);
  const existing = await readRecord(env.RAW, key);
  if (existing) {
    if (!sameCollisionFacts(existing, record)) {
      throw new FieldActionError(
        "idempotency_conflict",
        409,
        "This collision id is already bound to a different report.",
      );
    }
    return existing;
  }
  await putJson(env.RAW, key, record);
  await addToIndex(env.RAW, scopeDigest, collisionId);
  return record;
}

async function transitionCollision(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  scopeDigest: string,
  collisionId: FleetCollisionId,
): Promise<FleetCollisionRecord> {
  const reporter = auth.session.frappe_user_id?.trim() ?? "";
  if (!reporter) {
    throw new FieldActionError(
      "fleet_collision_physical_reporter_required",
      403,
      "A physical reporter is required to change a collision.",
    );
  }
  const body = await readJson(req);
  if (!exactKeys(body, ["to"], [])) throw invalidCollision();
  const to = body.to;
  if (!isCollisionState(to)) throw invalidCollision();
  const key = collisionRecordKey(scopeDigest, collisionId);
  const existing = await readRecord(env.RAW, key);
  if (!existing) {
    throw new FieldActionError("not_found", 404, "This collision was not found.");
  }
  if (!canTransitionFleetCollision(existing.state, to)) {
    throw new FieldActionError(
      "invalid_fleet_collision_transition",
      409,
      "This collision cannot move to that state.",
    );
  }
  const updated: FleetCollisionRecord = {
    ...existing,
    state: to,
    updated_at: new Date().toISOString(),
  };
  await putJson(env.RAW, key, updated);
  return updated;
}

async function listCollisions(
  bucket: R2Bucket,
  scopeDigest: string,
): Promise<FleetCollisionRecord[]> {
  const index = await readIndex(bucket, scopeDigest);
  const records: FleetCollisionRecord[] = [];
  for (const collisionId of index.collision_ids) {
    const record = await readRecord(bucket, collisionRecordKey(scopeDigest, collisionId));
    if (record) records.push(record);
  }
  return records;
}

async function readRecord(bucket: R2Bucket, key: string): Promise<FleetCollisionRecord | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    const parsed: unknown = JSON.parse(await object.text());
    return isCollisionRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readIndex(bucket: R2Bucket, scopeDigest: string): Promise<FleetCollisionIndex> {
  const object = await bucket.get(collisionIndexKey(scopeDigest));
  if (!object) return { collision_ids: [] };
  try {
    const parsed: unknown = JSON.parse(await object.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { collision_ids: [] };
    const ids = (parsed as { collision_ids?: unknown }).collision_ids;
    if (!Array.isArray(ids)) return { collision_ids: [] };
    return {
      collision_ids: ids.flatMap((id) => {
        const parsedId = typeof id === "string" ? parseFleetCollisionId(id) : null;
        return parsedId ? [parsedId] : [];
      }),
    };
  } catch {
    return { collision_ids: [] };
  }
}

async function addToIndex(
  bucket: R2Bucket,
  scopeDigest: string,
  collisionId: FleetCollisionId,
): Promise<void> {
  const index = await readIndex(bucket, scopeDigest);
  if (index.collision_ids.includes(collisionId)) return;
  await putJson(bucket, collisionIndexKey(scopeDigest), {
    collision_ids: [...index.collision_ids, collisionId],
  } satisfies FleetCollisionIndex);
}

async function putJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

function sameCollisionFacts(existing: FleetCollisionRecord, next: FleetCollisionRecord): boolean {
  return existing.fleet_asset_id === next.fleet_asset_id
    && existing.kind === next.kind
    && existing.severity === next.severity
    && existing.occurred_at === next.occurred_at
    && existing.reported_by === next.reported_by
    && existing.description === next.description
    && existing.telematics_reference === next.telematics_reference
    && JSON.stringify(existing.photo_evidence) === JSON.stringify(next.photo_evidence);
}

function isCollisionRecord(value: unknown): value is FleetCollisionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<FleetCollisionRecord>;
  return parseFleetCollisionId(String(record.collision_id ?? "")) !== null
    && record.kind === FLEET_COLLISION_KIND
    && isCollisionState(record.state)
    && typeof record.reported_by === "string"
    && record.reported_by.trim().length > 0;
}

function isCollisionState(value: unknown): value is FleetCollisionState {
  return typeof value === "string"
    && FLEET_COLLISION_STATES.some((state) => state === value);
}

function collisionSeverity(value: unknown): FleetCollisionSeverity {
  if (value === "Minor" || value === "Major" || value === "Out of Service") return value;
  throw invalidCollision();
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_COLLISION_BYTES) {
    throw new FieldActionError("fleet_action_too_large", 413, "The collision report is too large.");
  }
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw invalidCollision();
  }
  const source = await req.text();
  if (new TextEncoder().encode(source).byteLength > MAX_COLLISION_BYTES) {
    throw new FieldActionError("fleet_action_too_large", 413, "The collision report is too large.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(source) as unknown;
  } catch {
    throw invalidCollision();
  }
  if (!isJsonRecord(decoded)) throw invalidCollision();
  return decoded;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = new Set(Object.keys(value));
  if (required.some((key) => !keys.has(key))) return false;
  const allowed = new Set([...required, ...optional]);
  return [...keys].every((key) => allowed.has(key));
}

function isoTimestamp(value: unknown): string {
  const parsed = boundedText(value, 20, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(parsed)) throw invalidCollision();
  if (Number.isNaN(Date.parse(parsed))) throw invalidCollision();
  return parsed;
}

function boundedText(value: unknown, min: number, max: number): string {
  if (typeof value !== "string") throw invalidCollision();
  const parsed = value.trim();
  if (parsed.length < min || parsed.length > max) throw invalidCollision();
  return parsed;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 140 && !decoded.includes("/") ? decoded : null;
  } catch {
    return null;
  }
}

function invalidCollision(): FieldActionError {
  return new FieldActionError("invalid_fleet_collision", 400, "The collision report is invalid.");
}

function collisionError(error: unknown): Response {
  const failure = error instanceof FieldActionError
    ? error
    : error instanceof Error && error.message === "fleet_collision_physical_reporter_required"
      ? new FieldActionError(
        "fleet_collision_physical_reporter_required",
        403,
        "A physical reporter is required to record a collision.",
      )
      : error instanceof Error && error.message === "telematics_cannot_authorize_collision"
        ? new FieldActionError(
          "telematics_cannot_authorize_collision",
          403,
          "Tracker data cannot authorize a collision.",
        )
        : new FieldActionError("fleet_collision_failed", 502, "The collision could not be recorded.");
  return json({ error: failure.code, message: failure.message }, failure.status);
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
