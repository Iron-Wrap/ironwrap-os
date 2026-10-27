// field-actions-d1.test.ts - field check-ins against the real migration SQL.
//
// `field-actions.test.ts` proves the Worker's own logic against `MemoryFieldStore`, and that fake
// has no triggers. So it could not see that `0044_work_package_evidence_slots.sql`'s
// `field_actions_work_package_binding_shape` trigger aborted the INSERT for *every* ordinary field
// check-in: the Worker stamped the paired session device into `evidence_device_id`, which asserts
// "this row is Work Package evidence", and the trigger then demanded a released package the job did
// not have. `findActiveSession` only issues a `field` session when `device_id IS NOT NULL`, so
// there was no field session that escaped it.
//
// The abort surfaced as a bare `Error` out of an unguarded `store.claim(...)`, became a retryable
// 502, and `app/src/storage/outbox.ts` re-queued the identical bytes forever behind
// "Check-in saved / Waiting" - the offline differentiator failing silently (ELEC-205, ELEC-210).
//
// Every test here therefore runs the real `d1FieldActionStore` over real migration SQL in
// `node:sqlite`, behind a facade that fails in D1's error dialect rather than SQLite's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import {
  FieldActionError,
  classifyFieldActionFailure,
  d1FieldActionStore,
  handleFieldAction,
  processFieldSubmission,
  type FieldActionPayload,
  type FieldEvidenceAuthorizer,
  type FieldMediaReceipt,
  type FieldSubmission,
  type ImmutableObjectStore,
} from "../src/field-actions.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AuthContext,
} from "../src/app-types.ts";

const TENANT = "ironwrap";
const FIELD_USER = "appu_legacy_ops_0001";
const DEVICE = "paired-device-1";

/** Extended SQLite result codes D1 names in its wrapper; the low byte of each is `SQLITE_CONSTRAINT`. */
const SQLITE_EXTENDED_CONSTRAINT: Record<number, string> = {
  787: "SQLITE_CONSTRAINT_FOREIGNKEY",
  1299: "SQLITE_CONSTRAINT_NOTNULL",
  1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
  1811: "SQLITE_CONSTRAINT_TRIGGER",
  2067: "SQLITE_CONSTRAINT_UNIQUE",
};

/**
 * Real D1 never surfaces SQLite's bare text. It wraps every failure as
 * `D1_ERROR: <raised message>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`. A harness
 * that forwarded the plain message would let the whole "trigger abort answered as a retryable 502"
 * class ship green - which is exactly what happened here, and on the service-case lane before it.
 */
function asD1Error(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const errcode = (error as { errcode?: number }).errcode ?? 0;
  if ((errcode & 0xff) !== 19)
    return new Error(`D1_ERROR: ${error.message}: SQLITE_ERROR`);
  const extended = SQLITE_EXTENDED_CONSTRAINT[errcode];
  const detail = extended
    ? `SQLITE_CONSTRAINT (extended: ${extended})`
    : "SQLITE_CONSTRAINT";
  return new Error(`D1_ERROR: ${error.message}: ${detail}`);
}

function throughD1<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw asD1Error(error);
  }
}

async function migrationNames(): Promise<string[]> {
  return (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

/** The whole app schema behind a D1-shaped facade that fails the way D1 fails. */
class FieldActionTestD1 {
  readonly raw = new DatabaseSync(":memory:");

  static async create(): Promise<FieldActionTestD1> {
    const db = new FieldActionTestD1();
    db.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of await migrationNames()) {
      // `0038_app_access_roles.sql` backfills `access_role` from existing rows, so the field actor
      // has to exist before it runs - the same ordering `app-migration.test.ts` uses.
      if (migration === "0038_app_access_roles.sql") db.seedFieldUser();
      db.raw.exec(
        await readFile(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
    return db;
  }

  private seedFieldUser(): void {
    this.raw
      .prepare(
        `INSERT INTO app_users
          (user_id, tenant_id, email_normalized, display_name, role, active,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ops', 1, ?, ?, ?)`,
      )
      .run(
        FIELD_USER,
        TENANT,
        "crew@example.com",
        "Crew",
        "owner@example.com",
        "2026-08-28T09:00:00.000Z",
        "2026-08-28T09:00:00.000Z",
      );
  }

  private totalChanges(): number {
    return Number(
      (
        this.raw.prepare("SELECT total_changes() AS total").get() as {
          total: number;
        }
      ).total,
    );
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = throughD1(() => this.raw.prepare(sql));
        return {
          first: async <T>(column?: string) =>
            throughD1(() => {
              const row = statement.get(...(args as never[])) as
                | Record<string, unknown>
                | undefined;
              if (!row) return null;
              return (column === undefined ? row : row[column]) as T | null;
            }),
          all: async <T>() =>
            throughD1(() => ({
              success: true as const,
              results: statement.all(...(args as never[])) as T[],
              meta: { changes: 0 },
            })),
          run: async () =>
            throughD1(() => {
              const before = this.totalChanges();
              statement.run(...(args as never[]));
              return {
                success: true as const,
                results: [] as [],
                meta: { changes: this.totalChanges() - before },
              };
            }),
        };
      },
    };
  }

  row(deviceActionId: string): Record<string, unknown> | undefined {
    return this.raw
      .prepare("SELECT * FROM field_actions WHERE device_action_id = ?")
      .get(deviceActionId) as Record<string, unknown> | undefined;
  }

  mediaCount(deviceActionId: string): number {
    return Number(
      (
        this.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM field_action_media WHERE device_action_id = ?",
          )
          .get(deviceActionId) as { count: number }
      ).count,
    );
  }
}

class MemoryObjects implements ImmutableObjectStore {
  readonly objects = new Map<string, string>();
  async ensure(key: string, _body: Blob | string, _type: string, checksum: string) {
    this.objects.set(key, checksum);
  }
}

/**
 * A real field session. `findActiveSession` refuses to issue a `field` session without a paired
 * device, so `device_id` is never null in production - the exact fact the in-memory suite's
 * `device_id: "paired-device-1"` had no way to prove mattered.
 */
function fieldAuth(): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole("field"),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2026-08-28T09:00:00.000Z",
      session_expires_at: "2026-08-29T09:00:00.000Z",
      revoked_at: null,
      user_id: FIELD_USER,
      tenant_id: TENANT,
      email_normalized: "crew@example.com",
      display_name: "Crew",
      role: "field",
      device_id: DEVICE,
      device_proof_hash: null,
      frappe_user_id: "crew@example.com",
      active: 1,
      created_by: "owner@example.com",
      created_at: "2026-08-28T09:00:00.000Z",
      updated_at: "2026-08-28T09:00:00.000Z",
    },
  };
}

function payload(overrides: Partial<FieldActionPayload> = {}): FieldActionPayload {
  return {
    assignment_id: "ASSIGN-A",
    proof_slot: "Access",
    capture_started_at: "2026-08-28T10:00:00.000Z",
    capture_completed_at: "2026-08-28T10:02:00.000Z",
    notes: null,
    blocker: false,
    blocker_category: null,
    blocker_summary: null,
    latitude: null,
    longitude: null,
    location_accuracy_m: null,
    location_permission_state: "not_requested",
    correction_of: null,
    correction_reason: null,
    evidence_correction_of: null,
    evidence_item_correction_of: null,
    customer_safe_requested: false,
    ...overrides,
  };
}

/** The blocker a crew member files when they are standing on site and cannot start. */
function blockerPayload(overrides: Partial<FieldActionPayload> = {}): FieldActionPayload {
  return payload({
    blocker: true,
    blocker_category: "Access",
    blocker_summary: "Gate is locked and no site contact is answering.",
    notes: "Cannot start. Waiting at the gate.",
    ...overrides,
  });
}

function photo(index = 0) {
  const blob = new Blob([`photo-${index}`], { type: "image/jpeg" });
  return {
    attachmentId: `attachment-${index}`,
    fileName: `gate-${index}.jpg`,
    mimeType: "image/jpeg",
    size: blob.size,
    blob,
  };
}

function submission(
  deviceActionId: string,
  overrides: Partial<FieldSubmission> = {},
): FieldSubmission {
  return {
    deviceActionId,
    jobId: "JOB-UNRELEASED",
    assignmentId: "ASSIGN-A",
    payload: payload(),
    media: [],
    ...overrides,
  };
}

async function harness() {
  const db = await FieldActionTestD1.create();
  const env = { DB: db } as unknown as AppEnv;
  return { db, store: d1FieldActionStore(env), objects: new MemoryObjects() };
}

test("a note-only blocker report on a job with no Work Package is accepted and durable in D1", async () => {
  const { db, store, objects } = await harness();
  const response = await processFieldSubmission(
    submission("checkin-note-only-0001", { payload: blockerPayload() }),
    fieldAuth(),
    { store, objects },
  );

  assert.equal(response.status, "verified");
  const row = db.row("checkin-note-only-0001");
  assert.equal(row?.status, "verified");
  // The row carries no binding at all, which is what makes it legal without a Work Package.
  assert.equal(row?.work_package_id, null);
  assert.equal(
    row?.evidence_device_id,
    null,
    "an ordinary check-in must not assert a Work Package evidence binding",
  );
});

test("the crew member's photo survives a check-in on a job with no Work Package", async () => {
  const { db, store, objects } = await harness();
  const response = await processFieldSubmission(
    submission("checkin-with-photo-0001", {
      payload: blockerPayload(),
      media: [photo(0), photo(1)],
    }),
    fieldAuth(),
    { store, objects },
  );

  assert.equal(response.status, "verified");
  assert.equal(response.media.length, 2);
  assert.equal(db.mediaCount("checkin-with-photo-0001"), 2);
  assert.equal(objects.objects.size, 3, "two media objects plus the manifest");
  assert.equal(db.row("checkin-with-photo-0001")?.status, "verified");
});

test("a capture asserting a Work Package binding with no package is refused terminally, before any write", async () => {
  const { db, store, objects } = await harness();
  const error = await processFieldSubmission(
    submission("checkin-unbindable-0001", {
      payload: payload({ evidence_device_id: DEVICE }),
      media: [photo(0)],
    }),
    fieldAuth(),
    { store, objects },
  ).catch((thrown: unknown) => thrown);

  assert.ok(error instanceof FieldActionError);
  assert.equal(error.code, "field_action_evidence_requires_work_package");
  assert.equal(error.status, 422);
  assert.equal(error.retryable, false);
  assert.equal(error.retryAfterSeconds, undefined);
  assert.equal(db.row("checkin-unbindable-0001"), undefined);
  assert.equal(objects.objects.size, 0, "a refused capture writes no R2 object");
});

test("a binding-shape abort that reaches D1 is classified terminal, never a retryable 502", async () => {
  const { db, store, objects } = await harness();
  // Bypass the pre-flight guard the way a future caller or an older queued shape could, and let
  // 0044's trigger be the thing that refuses: the classification must not depend on the guard.
  const leaky = {
    ...store,
    claim: (input: Parameters<typeof store.claim>[0]) =>
      store.claim({ ...input, evidenceSource: "field-companion" }),
  };
  const error = await processFieldSubmission(
    submission("checkin-trigger-abort-0001", { payload: blockerPayload() }),
    fieldAuth(),
    { store: leaky, objects },
  ).catch((thrown: unknown) => thrown);

  assert.ok(error instanceof FieldActionError);
  assert.equal(error.code, "field_action_evidence_requires_work_package");
  assert.equal(error.status, 422);
  assert.equal(error.retryable, false);
  assert.equal(db.row("checkin-trigger-abort-0001"), undefined);
});

test("a transient store fault stays retryable so the offline queue keeps its purpose", async () => {
  const { store, objects } = await harness();
  const broken = {
    ...store,
    claim: async () => {
      throw new Error("D1_ERROR: network connection lost: SQLITE_ERROR");
    },
  };
  const error = await processFieldSubmission(
    submission("checkin-transient-0001", { payload: blockerPayload() }),
    fieldAuth(),
    { store: broken, objects },
  ).catch((thrown: unknown) => thrown);

  assert.ok(error instanceof FieldActionError);
  assert.equal(error.status, 502);
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSeconds, 5);
});

test("typed Work Package evidence still persists its complete binding through real D1", async () => {
  const { db, store, objects } = await harness();
  const authorizeTypedEvidence: FieldEvidenceAuthorizer = async () => ({
    workPackageId: "WORK-PACKAGE-A",
    workPackageVersion: 4,
    releaseAttemptId: "attempt-a",
    scope: {
      workObjectType: "Roof Job",
      workObjectId: "JOB-RELEASED",
      physicalContextType: "Roof Site",
      physicalContextId: "JOB-RELEASED",
    },
    slotId: "step:1",
    requirement: "Anchor inspection photo",
    source: "field-companion",
    deviceId: DEVICE,
    freshness: "Current",
    conflictState: "None",
    correctionOf: null,
    itemCorrectionOf: null,
  });
  const response = await processFieldSubmission(
    submission("checkin-typed-bound-0001", {
      jobId: "JOB-RELEASED",
      payload: payload({
        work_package_id: "WORK-PACKAGE-A",
        work_package_version: 4,
        work_package_release_attempt_id: "attempt-a",
        evidence_slot_id: "step:1",
        evidence_requirement: "Anchor inspection photo",
        evidence_source: "field-companion",
        evidence_device_id: DEVICE,
        evidence_freshness: "Current",
        evidence_conflict_state: "None",
        evidence_verification: "Verified",
        evidence_disposition: "Open",
      }),
      media: [photo(0)],
    }),
    fieldAuth(),
    { store, objects, authorizeTypedEvidence },
  );

  assert.equal(response.status, "verified");
  const row = db.row("checkin-typed-bound-0001");
  assert.equal(row?.work_package_id, "WORK-PACKAGE-A");
  assert.equal(row?.work_package_version, 4);
  assert.equal(row?.evidence_slot_id, "step:1");
  assert.equal(row?.evidence_device_id, DEVICE);
  assert.equal(row?.evidence_verification, "Verified");
  assert.equal(row?.evidence_disposition, "Open");
});

test("classification reads D1's wrapper, not SQLite's bare text, in both dialects", async () => {
  const wrapped = classifyFieldActionFailure(
    new Error(
      "D1_ERROR: field_action_work_package_binding_invalid: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
    ),
  );
  assert.equal(wrapped.code, "field_action_evidence_requires_work_package");
  assert.equal(wrapped.retryable, false);

  const bare = classifyFieldActionFailure(
    new Error("field_action_work_package_binding_invalid: constraint failed"),
  );
  assert.equal(bare.code, "field_action_evidence_requires_work_package");
  assert.equal(bare.retryable, false);

  // A CHECK refusal is still terminal, but it keeps its own identity.
  const check = classifyFieldActionFailure(
    new Error(
      "D1_ERROR: CHECK constraint failed: length(device_action_id) BETWEEN 8 AND 80: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)",
    ),
  );
  assert.equal(check.status, 409);
  assert.equal(check.retryable, false);
  assert.equal(
    check.code,
    "field_action_rejected",
    "SQLite's own machinery is not a rule code the crew can be told about",
  );

  // A rule-code-looking token with no constraint marker is a genuine fault, not a business answer.
  const fault = classifyFieldActionFailure(new Error("no such table: field_actions"));
  assert.equal(fault.status, 502);
  assert.equal(fault.retryable, true);

  // A FieldActionError already carries its classification and must pass through untouched.
  const passthrough = new FieldActionError("idempotency_conflict", 409, "…");
  assert.equal(classifyFieldActionFailure(passthrough), passthrough);
  assert.equal(passthrough.retryable, false);
});

test("an unverified media receipt is durable, so the retry replays instead of re-uploading", async () => {
  const { db, store, objects } = await harness();
  let failures = 0;
  const flaky: ImmutableObjectStore = {
    async ensure(key, body, type, checksum) {
      if (key.endsWith(".json") && failures === 0) {
        failures += 1;
        throw new Error("R2 PUT failed");
      }
      await objects.ensure(key, body, type, checksum);
    },
  };
  const input = submission("checkin-replay-0001", {
    payload: blockerPayload(),
    media: [photo(0)],
  });

  const error = await processFieldSubmission(input, fieldAuth(), {
    store,
    objects: flaky,
  }).catch((thrown: unknown) => thrown);
  assert.ok(error instanceof FieldActionError);
  assert.equal(error.status, 502);
  assert.equal(error.retryable, true);
  assert.equal(db.row("checkin-replay-0001")?.status, "retryable_error");

  const verified = await processFieldSubmission(input, fieldAuth(), {
    store,
    objects: flaky,
  });
  assert.equal(verified.status, "verified");
  assert.equal(db.mediaCount("checkin-replay-0001"), 1);
  assert.equal(db.row("checkin-replay-0001")?.status, "verified");
});

// --- the wire contract `ironwrap-app-engineer` builds the client half against ---

function multipartCheckIn(
  deviceActionId: string,
  body: FieldActionPayload,
  attachmentCount = 0,
): Request {
  const form = new FormData();
  const attachments = Array.from({ length: attachmentCount }, (_, index) => {
    // A real JPEG signature: `parseFieldActionRequest` validates the magic bytes,
    // not the declared MIME type.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, index]);
    const blob = new Blob([bytes], { type: "image/jpeg" });
    form.append("attachments", blob, `gate-${index}.jpg`);
    return {
      attachmentId: `attachment-${index}`,
      fileName: `gate-${index}.jpg`,
      mimeType: "image/jpeg",
      size: blob.size,
    };
  });
  form.set(
    "metadata",
    JSON.stringify({ device_action_id: deviceActionId, payload: body, attachments }),
  );
  return new Request("https://app.example.com/api/v1/jobs/JOB-UNRELEASED/check-ins", {
    method: "POST",
    body: form,
  });
}

/**
 * An R2 stand-in that answers the post-write HEAD the way R2 does - size,
 * `customMetadata.sha256`, and a server-computed `checksums.sha256` - because
 * `r2ObjectStore` verifies its own write and refuses anything else.
 */
function memoryBucket() {
  const stored = new Map<string, { size: number; sha256: string }>();
  return {
    stored,
    head: async (key: string) => {
      const object = stored.get(key);
      if (!object) return null;
      return {
        size: object.size,
        customMetadata: { sha256: object.sha256 },
        checksums: {
          sha256: Uint8Array.from(
            object.sha256.match(/../g)!.map((byte) => Number.parseInt(byte, 16)),
          ).buffer,
        },
      };
    },
    put: async (
      key: string,
      body: Blob | string,
      options: { customMetadata: { sha256: string } },
    ) => {
      stored.set(key, {
        size: typeof body === "string" ? new TextEncoder().encode(body).length : body.size,
        sha256: options.customMetadata.sha256,
      });
      return { key };
    },
  };
}

async function routeHarness() {
  const db = await FieldActionTestD1.create();
  const bucket = memoryBucket();
  const env = { DB: db, RAW: bucket } as unknown as AppEnv;
  return { db, env, bucket };
}

test("the route accepts a note-only blocker report and answers verified", async () => {
  const { db, env } = await routeHarness();
  const response = await handleFieldAction(
    multipartCheckIn("route-note-only-0001", blockerPayload()),
    env,
    fieldAuth(),
    "JOB-UNRELEASED",
    "ASSIGN-A",
  );

  assert.equal(response.status, 200);
  assert.equal(
    (await response.json<{ status: string }>()).status,
    "verified",
  );
  assert.equal(db.row("route-note-only-0001")?.status, "verified");
});

test("the route states terminal vs retryable in the body so the outbox never guesses", async () => {
  const { db, env } = await routeHarness();
  const refused = await handleFieldAction(
    multipartCheckIn(
      "route-unbindable-0001",
      payload({ evidence_device_id: DEVICE }),
    ),
    env,
    fieldAuth(),
    "JOB-UNRELEASED",
    "ASSIGN-A",
  );

  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), {
    error: "field_action_evidence_requires_work_package",
    message:
      "Production has not issued a job plan for this job yet, so this proof cannot go on a plan step. Ask production to issue the job plan, then add the proof again.",
    retryable: false,
  });
  assert.equal(
    refused.headers.get("retry-after"),
    null,
    "a terminal refusal must not advertise a retry",
  );
  assert.equal(db.row("route-unbindable-0001"), undefined);

  // The rate limiter is the retryable half of the same contract: same shape,
  // opposite classification, and it keeps its retry-after.
  let limited: Response | undefined;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    limited = await handleFieldAction(
      multipartCheckIn(`route-throttled-000${attempt}`, blockerPayload()),
      env,
      fieldAuth(),
      "JOB-UNRELEASED",
      "ASSIGN-A",
    );
  }
  assert.equal(limited?.status, 429);
  const body = await limited!.json<{ error: string; retryable: boolean }>();
  assert.equal(body.error, "field_upload_rate_limited");
  assert.equal(body.retryable, true);
  assert.ok(Number(limited!.headers.get("retry-after")) > 0);
});
