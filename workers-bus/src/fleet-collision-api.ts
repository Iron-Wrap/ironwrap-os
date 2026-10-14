import { validAppCsrf } from "./app-auth.ts";
import { fleetAssetForFieldActor } from "./app-read-models.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import { FieldActionError } from "./field-actions.ts";
import {
  assertCollisionNotTelematicsAuthorized,
  canTransitionFleetCollision,
  collisionRecordPrefix,
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

const COLLISION_PAGE_SIZE = 100;
const MAX_R2_CURSOR_BYTES = 2048;
const COLLISION_CURSOR_VERSION = "v1";

export async function handleFleetCollisionCollection(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedAssetName: string,
): Promise<Response> {
  const scoped = await scopedFleetAsset(req, env, auth, encodedAssetName, req.method !== "GET");
  if (scoped instanceof Response) return scoped;
  try {
    if (req.method === "GET") {
      const cursor = new URL(req.url).searchParams.get("cursor");
      const r2Cursor = cursor === null ? undefined : await decodeCollisionCursor(auth, scoped.scopeDigest, cursor);
      const page = await listCollisions(
        env.RAW,
        scoped.scopeDigest,
        auth.session.tenant_id,
        scoped.assetName,
        r2Cursor,
      );
      return json({ collisions: page.collisions,
        next_cursor: page.next_cursor === null ? null : await encodeCollisionCursor(auth, scoped.scopeDigest, page.next_cursor) });
    }
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
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
    const updated = await transitionCollision(
      req,
      env,
      auth,
      scoped.assetName,
      scoped.scopeDigest,
      collisionId,
    );
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

export async function createCollision(
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
  const written = await env.RAW.put(key, JSON.stringify(record), {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: { contentType: "application/json" },
  });
  if (written !== null) return record;
  const existing = await readRecord(env.RAW, key);
  if (!existing || !sameCollisionFacts(existing.record, record)) {
    throw new FieldActionError(
      "idempotency_conflict",
      409,
      "This collision id is already bound to a different report.",
    );
  }
  return existing.record;
}

export async function transitionCollision(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  fleetAssetId: string,
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
  if (existing.record.collision_id !== collisionId
    || existing.record.tenant_id !== auth.session.tenant_id
    || existing.record.fleet_asset_id !== fleetAssetId) {
    throw new FieldActionError(
      "fleet_collision_storage_mismatch",
      502,
      "A stored collision could not be read safely.",
    );
  }
  if (!canTransitionFleetCollision(existing.record.state, to)) {
    throw new FieldActionError(
      "invalid_fleet_collision_transition",
      409,
      "This collision cannot move to that state.",
    );
  }
  const updated: FleetCollisionRecord = {
    ...existing.record,
    state: to,
    updated_at: new Date().toISOString(),
  };
  const written = await env.RAW.put(key, JSON.stringify(updated), {
    onlyIf: { etagMatches: existing.etag },
    httpMetadata: { contentType: "application/json" },
  });
  if (written === null) {
    throw new FieldActionError(
      "fleet_collision_state_changed",
      409,
      "This collision changed. Reload it before choosing its next state.",
    );
  }
  return updated;
}

export async function listCollisions(
  bucket: R2Bucket,
  scopeDigest: string,
  tenantId: string,
  assetName: string,
  cursor?: string,
): Promise<{ collisions: FleetCollisionRecord[]; next_cursor: string | null }> {
  const prefix = collisionRecordPrefix(scopeDigest);
  const page = await bucket.list({ prefix, limit: COLLISION_PAGE_SIZE, cursor });
  const collisions: FleetCollisionRecord[] = [];
  for (const object of page.objects) {
    const suffix = object.key.slice(prefix.length);
    if (!suffix.endsWith("/record.json")) continue;
    const collisionId = parseFleetCollisionId(suffix.slice(0, -"/record.json".length));
    if (!collisionId || collisionRecordKey(scopeDigest, collisionId) !== object.key) continue;
    const stored = await readRecord(bucket, object.key);
    if (!stored || stored.record.collision_id !== collisionId
      || stored.record.tenant_id !== tenantId
      || stored.record.fleet_asset_id !== assetName) {
      throw new FieldActionError(
        "fleet_collision_storage_mismatch",
        502,
        "A stored collision could not be read safely.",
      );
    }
    collisions.push(stored.record);
  }
  if (page.truncated && !page.cursor) {
    throw new FieldActionError(
      "fleet_collision_storage_mismatch",
      502,
      "More collisions could not be listed safely.",
    );
  }
  return { collisions, next_cursor: page.truncated ? page.cursor ?? null : null };
}

/** Keep R2's opaque token scoped to the current vehicle and signed-in session. */
async function encodeCollisionCursor(auth: AuthContext, scopeDigest: string, cursor: string): Promise<string> {
  const bytes = new TextEncoder().encode(cursor);
  if (bytes.length === 0 || bytes.length > MAX_R2_CURSOR_BYTES) {
    throw new FieldActionError("fleet_collision_storage_mismatch", 502, "The next collision page could not be saved safely.");
  }
  const encoded = base64Url(bytes);
  const signature = await cursorSignature(auth, scopeDigest, encoded);
  return `${COLLISION_CURSOR_VERSION}.${encoded}.${signature}`;
}

async function decodeCollisionCursor(auth: AuthContext, scopeDigest: string, value: string): Promise<string> {
  if (value.length === 0 || value.length > 3072) throw invalidCollisionCursor();
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== COLLISION_CURSOR_VERSION ||
      !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? "") || !/^[0-9a-f]{64}$/.test(parts[2] ?? "")) {
    throw invalidCollisionCursor();
  }
  const bytes = fromBase64Url(parts[1]!);
  if (bytes.length === 0 || bytes.length > MAX_R2_CURSOR_BYTES || base64Url(bytes) !== parts[1]) {
    throw invalidCollisionCursor();
  }
  const signature = Uint8Array.from(parts[2]!.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  const key = await cursorKey(auth);
  const valid = await crypto.subtle.verify("HMAC", key, signature,
    new TextEncoder().encode(`${COLLISION_CURSOR_VERSION}:${scopeDigest}:${parts[1]}`));
  if (!valid) throw invalidCollisionCursor();
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw invalidCollisionCursor(); }
}

async function cursorSignature(auth: AuthContext, scopeDigest: string, encoded: string): Promise<string> {
  const key = await cursorKey(auth);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(`${COLLISION_CURSOR_VERSION}:${scopeDigest}:${encoded}`)));
  return Array.from(signed, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cursorKey(auth: AuthContext): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(auth.rawSessionToken),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  try {
    const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch { throw invalidCollisionCursor(); }
}

function invalidCollisionCursor(): FieldActionError {
  return new FieldActionError("fleet_collision_cursor_invalid", 400,
    "This list position is no longer valid. Reload collisions from the start.");
}

async function readRecord(
  bucket: R2Bucket,
  key: string,
): Promise<{ record: FleetCollisionRecord; etag: string } | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    const parsed: unknown = JSON.parse(await object.text());
    if (isCollisionRecord(parsed)) return { record: parsed, etag: object.etag };
  } catch {
    // A malformed stored record must not be treated as an absent report.
  }
  throw new FieldActionError(
    "fleet_collision_storage_mismatch",
    502,
    "A stored collision could not be read safely.",
  );
}

function sameCollisionFacts(existing: FleetCollisionRecord, next: FleetCollisionRecord): boolean {
  return existing.collision_id === next.collision_id
    && existing.tenant_id === next.tenant_id
    && existing.fleet_asset_id === next.fleet_asset_id
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
    && typeof record.tenant_id === "string"
    && record.tenant_id.length > 0
    && typeof record.fleet_asset_id === "string"
    && record.fleet_asset_id.length > 0
    && (record.severity === "Minor" || record.severity === "Major" || record.severity === "Out of Service")
    && typeof record.occurred_at === "string"
    && typeof record.description === "string"
    && record.description.length >= 3
    && Array.isArray(record.photo_evidence)
    && record.photo_evidence.every((photo) => !!photo && typeof photo === "object"
      && typeof photo.attachment_id === "string"
      && typeof photo.file_name === "string"
      && typeof photo.content_type === "string"
      && typeof photo.sha256 === "string"
      && typeof photo.r2_key === "string")
    && (record.telematics_reference === null || typeof record.telematics_reference === "string")
    && typeof record.created_at === "string"
    && typeof record.updated_at === "string"
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
