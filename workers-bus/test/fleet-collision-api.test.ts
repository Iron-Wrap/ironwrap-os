import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { AppEnv, AuthContext } from "../src/app-types.ts";
import { FieldActionError } from "../src/field-actions.ts";
import {
  createCollision,
  handleFleetCollisionCollection,
  listCollisions,
  transitionCollision,
} from "../src/fleet-collision-api.ts";
import {
  collisionRecordKey,
  type FleetCollisionId,
} from "../src/fleet-collision.ts";

const collisionId = "fc_devicefleet0001aaaa" as FleetCollisionId;
const tenantId = "tenant-example";
const assetId = "vehicle-example";
const scopeDigest = createHash("sha256")
  .update(`${tenantId}:${assetId}`)
  .digest("hex")
  .slice(0, 24);

class MemoryR2 {
  readonly objects = new Map<string, { body: string; etag: string }>();
  private revision = 0;
  pageSize = 100;
  refuseNextCas = false;
  listCalls = 0;

  async get(key: string) {
    const object = this.objects.get(key);
    return object ? { etag: object.etag, text: async () => object.body } : null;
  }

  async put(
    key: string,
    body: string,
    options?: { onlyIf?: Headers | { etagMatches?: string } },
  ) {
    const existing = this.objects.get(key);
    if (options?.onlyIf instanceof Headers
      && options.onlyIf.get("If-None-Match") === "*"
      && existing) return null;
    if (options?.onlyIf && !(options.onlyIf instanceof Headers)
      && (this.refuseNextCas || existing?.etag !== options.onlyIf.etagMatches)) {
      this.refuseNextCas = false;
      return null;
    }
    const object = { body, etag: `etag-${++this.revision}` };
    this.objects.set(key, object);
    return { key, etag: object.etag };
  }

  async list(options: { prefix: string; limit: number; cursor?: string }) {
    this.listCalls++;
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix) && key > (options.cursor ?? ""))
      .sort();
    const selected = keys.slice(0, Math.min(options.limit, this.pageSize));
    const truncated = selected.length < keys.length;
    return {
      objects: selected.map((key) => ({ key })),
      truncated,
      cursor: truncated ? selected.at(-1) : undefined,
      delimitedPrefixes: [],
    };
  }
}

function fixture(bucket: MemoryR2, fleetAssetId = assetId) {
  return {
    env: {
      RAW: bucket,
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => ({ tenant_id: tenantId, fleet_asset_id: fleetAssetId }) }),
        }),
      },
    } as unknown as AppEnv,
    auth: {
      rawSessionToken: "s".repeat(43),
      session: {
        tenant_id: tenantId,
        user_id: "driver-example",
        role: "field",
        frappe_user_id: "driver@example.invalid",
      },
    } as unknown as AuthContext,
  };
}

function report(description = "The van struck a post while parking.", id: FleetCollisionId = collisionId) {
  return new Request("https://example.invalid/collisions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      collision_id: id,
      occurred_at: "2026-01-01T10:00:00.000Z",
      severity: "Minor",
      description,
    }),
  });
}

test("an unindexed collision is listed and an exact retry keeps the same record", async () => {
  const bucket = new MemoryR2();
  const { env, auth } = fixture(bucket);
  const created = await createCollision(report(), env, auth, assetId, scopeDigest);
  assert.equal(bucket.objects.size, 1);
  assert.deepEqual([...bucket.objects.keys()], [collisionRecordKey(scopeDigest, collisionId)]);

  const page = await listCollisions(bucket as unknown as R2Bucket, scopeDigest, tenantId, assetId);
  assert.deepEqual(page, { collisions: [created], next_cursor: null });

  const replay = await createCollision(report(), env, auth, assetId, scopeDigest);
  assert.deepEqual(replay, created);
  assert.equal(bucket.objects.size, 1);
  await assert.rejects(
    createCollision(report("A different event used the same id."), env, auth, assetId, scopeDigest),
    (error) => error instanceof FieldActionError && error.code === "idempotency_conflict",
  );
  assert.deepEqual(await listCollisions(bucket as unknown as R2Bucket, scopeDigest, tenantId, assetId), page);
});

test("collision pages use R2's cursor and do not hide an old index-only key", async () => {
  const bucket = new MemoryR2();
  bucket.pageSize = 1;
  const { env, auth } = fixture(bucket);
  const created = await createCollision(report(), env, auth, assetId, scopeDigest);
  bucket.objects.set(`fleet/v1/${scopeDigest}/collision/index.json`, {
    body: JSON.stringify({ collision_ids: [] }),
    etag: "old-index",
  });

  const first = await listCollisions(bucket as unknown as R2Bucket, scopeDigest, tenantId, assetId);
  assert.deepEqual(first.collisions, [created]);
  assert.ok(first.next_cursor);
  const second = await listCollisions(
    bucket as unknown as R2Bucket,
    scopeDigest,
    tenantId,
    assetId,
    first.next_cursor,
  );
  assert.deepEqual(second, { collisions: [], next_cursor: null });
});

test("the authenticated collection route returns a private page and refuses other roles", async () => {
  const bucket = new MemoryR2();
  const { env, auth } = fixture(bucket);
  const created = await createCollision(report(), env, auth, assetId, scopeDigest);
  const first = await handleFleetCollisionCollection(
    new Request(`https://example.invalid/api/v1/fleet/assets/${assetId}/collisions`),
    env,
    auth,
    assetId,
  );
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await first.json(), { collisions: [created], next_cursor: null });

  const office = {
    session: { ...auth.session, role: "office" },
  } as AuthContext;
  const denied = await handleFleetCollisionCollection(
    new Request(`https://example.invalid/api/v1/fleet/assets/${assetId}/collisions`),
    env,
    office,
    assetId,
  );
  assert.equal(denied.status, 403);
});

test("list cursors are session and vehicle scoped; malformed input never reaches R2", async () => {
  const bucket = new MemoryR2(); bucket.pageSize = 1;
  const { env, auth } = fixture(bucket);
  const otherId = "fc_devicefleet0002bbbb" as FleetCollisionId;
  await createCollision(report(), env, auth, assetId, scopeDigest);
  await createCollision(report("The van struck a second post.", otherId), env, auth, assetId, scopeDigest);
  const url = `https://example.invalid/api/v1/fleet/assets/${assetId}/collisions`;
  const first = await handleFleetCollisionCollection(new Request(url), env, auth, assetId);
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { collisions: Array<{ collision_id: string }>; next_cursor: string };
  assert.equal(firstBody.collisions.length, 1);
  assert.match(firstBody.next_cursor, /^v1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  const second = await handleFleetCollisionCollection(
    new Request(`${url}?cursor=${encodeURIComponent(firstBody.next_cursor)}`), env, auth, assetId);
  assert.equal(second.status, 200);
  const secondBody = await second.json() as { collisions: Array<{ collision_id: string }>; next_cursor: string | null };
  assert.equal(secondBody.collisions.length, 1);
  assert.notEqual(secondBody.collisions[0]!.collision_id, firstBody.collisions[0]!.collision_id);
  assert.equal(secondBody.next_cursor, null);

  const calls = bucket.listCalls;
  for (const [cursor, actor] of [
    ["not-an-r2-cursor", auth],
    [firstBody.next_cursor.slice(0, -1) + (firstBody.next_cursor.endsWith("0") ? "1" : "0"), auth],
    [firstBody.next_cursor, { ...auth, rawSessionToken: "t".repeat(43) }],
  ] as const) {
    const response = await handleFleetCollisionCollection(
      new Request(`${url}?cursor=${encodeURIComponent(cursor)}`), env, actor, assetId);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: string }).error, "fleet_collision_cursor_invalid");
  }
  const otherAsset = "vehicle-other";
  const other = fixture(bucket, otherAsset);
  const crossVehicle = await handleFleetCollisionCollection(
    new Request(`https://example.invalid/api/v1/fleet/assets/${otherAsset}/collisions?cursor=${encodeURIComponent(firstBody.next_cursor)}`),
    other.env, other.auth, otherAsset);
  assert.equal(crossVehicle.status, 400);
  assert.equal((await crossVehicle.json() as { error: string }).error, "fleet_collision_cursor_invalid");
  assert.equal(bucket.listCalls, calls);
});

test("a stale transition is refused without overwriting the stored collision", async () => {
  const bucket = new MemoryR2();
  const { env, auth } = fixture(bucket);
  await createCollision(report(), env, auth, assetId, scopeDigest);
  bucket.refuseNextCas = true;
  await assert.rejects(
    transitionCollision(
      new Request("https://example.invalid/collisions/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "investigating" }),
      }),
      env,
      auth,
      assetId,
      scopeDigest,
      collisionId,
    ),
    (error) => error instanceof FieldActionError && error.code === "fleet_collision_state_changed",
  );
  const page = await listCollisions(bucket as unknown as R2Bucket, scopeDigest, tenantId, assetId);
  assert.equal(page.collisions[0]?.state, "reported");
});

test("malformed stored collision fails closed instead of being overwritten or omitted", async () => {
  const bucket = new MemoryR2();
  const { env, auth } = fixture(bucket);
  bucket.objects.set(collisionRecordKey(scopeDigest, collisionId), {
    body: "{broken",
    etag: "old-corrupt",
  });
  await assert.rejects(
    createCollision(report(), env, auth, assetId, scopeDigest),
    (error) => error instanceof FieldActionError && error.code === "fleet_collision_storage_mismatch",
  );
  await assert.rejects(
    listCollisions(bucket as unknown as R2Bucket, scopeDigest, tenantId, assetId),
    (error) => error instanceof FieldActionError && error.code === "fleet_collision_storage_mismatch",
  );
});
