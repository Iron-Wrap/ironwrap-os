import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  frappeFieldAuthorization,
  frappeFieldWriter,
  type PersistFieldCheckInInput,
  type PersistFieldMediaInput,
  type PersistWorkPackageEvidenceInput,
} from "../src/frappe-field.ts";
import type { AppEnv } from "../src/app-types.ts";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec(readFileSync(new URL("../migrations/0042_external_effect_runtime.sql", import.meta.url), "utf8"));
  }

  // The effect runtime claims an attempt through env.DB.batch; a sequential
  // run is equivalent for a synchronous test double.
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = this.raw.prepare(sql);
        return {
          first: async <T>() => (statement.get(...args) ?? null) as T | null,
          all: async <T>() => ({ results: statement.all(...args) as T[] }),
          run: async () => {
            const result = statement.run(...args);
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }
}

function testEnv(): AppEnv {
  return {
    DB: new SqliteD1() as never,
    EFFECT_RUNTIME_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "bus-key",
    ERPNEXT_API_SECRET: "bus-secret",
    // Only the work_package_api half of this writer uses the dedicated pair; the
    // field-evidence half deliberately stays on the bus credential above.
    WORK_PACKAGE_FRAPPE_API_KEY: "work-package-key",
    WORK_PACKAGE_FRAPPE_API_SECRET: "work-package-secret",
    APP_FRAPPE_REQUEST_TIMEOUT_MS: "8000",
  } as AppEnv;
}

const evidenceInput: PersistFieldMediaInput = {
  evidenceId: "evi_0123456789abcdef",
  deviceActionId: "fem_0123456789abcdef",
  jobId: "JOB-A",
  evidenceType: "Photo",
  proofSlot: "Production",
  r2Key: "field/v1/scope/checkin/media/evidence.jpg",
  checksum: "a".repeat(64),
  contentType: "image/jpeg",
  contentLength: 1024,
  capturedAt: "2026-07-10T10:00:00.000Z",
  captureActor: "crew@example.com",
  latitude: null,
  longitude: null,
  locationAccuracyM: null,
  summary: "Deck complete",
  customerSafe: false,
  correctionOf: null,
  correctionReason: null,
};

const checkInInput: PersistFieldCheckInInput = {
  checkinId: "fci_0123456789abcdef",
  deviceActionId: "device-action-123",
  jobId: "JOB-A",
  assignmentId: "ASSIGN-A",
  captureActor: "crew@example.com",
  captureStartedAt: "2026-07-10T10:00:00.000Z",
  captureCompletedAt: "2026-07-10T10:05:00.000Z",
  submittedAt: "2026-07-10T10:06:00.000Z",
  latitude: null,
  longitude: null,
  locationAccuracyM: null,
  photoCount: 1,
  evidenceIds: [evidenceInput.evidenceId],
  blocker: false,
  blockerCategory: null,
  blockerSummary: null,
  voiceEvidenceId: null,
  correctionOf: null,
  correctionReason: null,
  notes: "Deck complete",
  manifestKey: "field/v1/scope/checkin/manifest.json",
};

test("an existing Evidence Item must match every immutable replay identity", async () => {
  await withFetch(
    async () =>
      Response.json({
        data: [
          {
            name: "EVIDENCE-1",
            evidence_id: evidenceInput.evidenceId,
            device_action_id: evidenceInput.deviceActionId,
            roof_job: "JOB-B",
            evidence_type: evidenceInput.evidenceType,
            proof_slot: evidenceInput.proofSlot,
            source_system: "ironwrap-pwa",
            r2_key: evidenceInput.r2Key,
            content_checksum: evidenceInput.checksum,
            content_type: evidenceInput.contentType,
            content_length: evidenceInput.contentLength,
            capture_actor: evidenceInput.captureActor,
            customer_safe: 0,
            correction_of: null,
            sync_state: "Verified",
          },
        ],
      }),
    async () => {
      await assert.rejects(frappeFieldWriter(testEnv()).persistEvidence(evidenceInput), /frappe_field_identity_conflict/);
    },
  );
});

test("a field correction cannot link to another job", async () => {
  await withFetch(
    async () =>
      Response.json({
        data: [
          {
            name: "EVIDENCE-OLD",
            roof_job: "JOB-B",
            sync_state: "Verified",
            correction_of: null,
          },
        ],
      }),
    async () => {
      await assert.rejects(
        frappeFieldWriter(testEnv()).persistEvidence({
          ...evidenceInput,
          correctionOf: "EVIDENCE-OLD",
          correctionReason: "Correcting the deck photo",
        }),
        /frappe_field_correction_invalid/,
      );
    },
  );
});

test("new Field Companion evidence uses the trusted Frappe issuer command", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  await withFetch(
    async (input, init) => {
      requests.push({ url: String(input), init });
      if (init?.method === "GET" && String(input).endsWith("/api/resource/Evidence%20Item/EVIDENCE-ISSUED-1")) {
        return Response.json({ data: { name: "EVIDENCE-ISSUED-1" } });
      }
      if (init?.method === "GET") return Response.json({ data: [] });
      assert.equal(
        String(input),
        "https://frappe.example.com/api/method/ironwrap_roofing.field_evidence_api.record_verified_field_evidence",
      );
      assert.equal(init?.method, "POST");
      const outer = JSON.parse(String(init?.body)) as { evidence_json?: unknown };
      assert.equal(typeof outer.evidence_json, "string");
      const document = JSON.parse(String(outer.evidence_json)) as Record<string, unknown>;
      assert.deepEqual(document, {
        evidence_id: evidenceInput.evidenceId,
        device_action_id: evidenceInput.deviceActionId,
        roof_job: evidenceInput.jobId,
        evidence_type: evidenceInput.evidenceType,
        proof_slot: evidenceInput.proofSlot,
        r2_key: evidenceInput.r2Key,
        content_checksum: evidenceInput.checksum,
        checksum_algorithm: "SHA-256",
        content_type: evidenceInput.contentType,
        content_length: evidenceInput.contentLength,
        capture_actor: evidenceInput.captureActor,
        captured_at: "2026-07-10 10:00:00",
        customer_safe: 0,
        summary: evidenceInput.summary,
      });
      assert.equal(document.sync_state, undefined);
      assert.equal(document.verified_at, undefined);
      assert.equal(document.verification_source, undefined);
      return Response.json({ message: { name: "EVIDENCE-ISSUED-1" } });
    },
    async () => {
      assert.deepEqual(await frappeFieldWriter(testEnv()).persistEvidence(evidenceInput), {
        name: "EVIDENCE-ISSUED-1",
      });
    },
  );
  assert.equal(requests.length, 3);
  assert.match(requests[0]!.url, /\/api\/resource\/Evidence%20Item\?/);
});

test("typed Shop Order evidence keeps the parent/context envelope and omits Roof Job projection", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const env = testEnv();
  const typedEvidence: PersistFieldMediaInput = {
    ...evidenceInput,
    jobId: "SHOP-001",
    workObjectType: "Shop Order",
    workObjectId: "SHOP-001",
    physicalContextType: "Shop Floor",
    physicalContextId: "SHOP-FLOOR-1",
    workPackageId: "WORK-PACKAGE-SHOP-1",
    workPackageVersion: 4,
    workPackageReleaseAttemptId: "attempt-shop-1",
    evidenceSlotId: "step:1",
    evidenceRequirement: "Anchor inspection photo",
    evidenceSource: "field-companion",
    evidenceDeviceId: "paired-device-1",
    evidenceFreshness: "Current",
    evidenceConflictState: "None",
    evidenceVerification: "Verified",
    evidenceDisposition: "Open",
  };
  const typedEvent: PersistWorkPackageEvidenceInput = {
    workPackageId: "WORK-PACKAGE-SHOP-1",
    workPackageVersion: 4,
    jobId: "SHOP-001",
    workObjectType: "Shop Order",
    workObjectId: "SHOP-001",
    physicalContextType: "Shop Floor",
    physicalContextId: "SHOP-FLOOR-1",
    assignmentId: "ASSIGN-SHOP-1",
    actorUser: "crew@example.com",
    deviceActionId: "wpe_typed-evidence",
    evidenceSlotId: "step:1",
    evidenceRequirement: "Anchor inspection photo",
    evidenceSource: "field-companion",
    evidenceItemId: "EVIDENCE-SHOP-1",
    evidenceDeviceId: "paired-device-1",
    evidenceCapturedAt: "2026-07-10T10:05:00.000Z",
    evidenceFreshness: "Current",
    evidenceConflictState: "None",
    evidenceCorrectionOf: null,
    evidenceItemCorrectionOf: null,
    workPackageReleaseAttemptId: "attempt-shop-1",
    correctionReason: null,
    evidenceVerification: "Verified",
    evidenceDisposition: "Open",
  };
  await withFetch(
    async (input, init) => {
      requests.push({ url: String(input), init });
      if (init?.method === "GET") {
        if (String(input).includes("?")) return Response.json({ data: [] });
        return Response.json({
          data: { name: decodeURIComponent(String(input).split("/").pop() ?? "") },
        });
      }
      if (String(input).includes("field_evidence_api")) {
        const outer = JSON.parse(String(init?.body)) as { evidence_json: string };
        const document = JSON.parse(outer.evidence_json) as Record<string, unknown>;
        assert.equal(document.roof_job, undefined);
        assert.equal(document.work_object_type, undefined);
        assert.equal(document.work_package, "WORK-PACKAGE-SHOP-1");
        return Response.json({ message: { name: "EVIDENCE-SHOP-1" } });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.roof_job_id, undefined);
      assert.equal(body.work_object_type, "Shop Order");
      assert.equal(body.work_object_id, "SHOP-001");
      assert.equal(body.physical_context_type, "Shop Floor");
      assert.equal(body.physical_context_id, "SHOP-FLOOR-1");
      return Response.json({ message: { event: { name: "EVENT-SHOP-1" } } });
    },
    async () => {
      assert.deepEqual(await frappeFieldWriter(env).persistEvidence(typedEvidence), {
        name: "EVIDENCE-SHOP-1",
      });
      assert.deepEqual(
        await frappeFieldWriter(env).persistWorkPackageEvidence(typedEvent),
        { name: "EVENT-SHOP-1" },
      );
    },
  );
  assert.equal(requests.length, 5);
  // One writer, two rails. The work-package half carries the work-package issuer; the
  // field-evidence half stays on the bus pair, which is the rail it belongs to.
  const authorizationFor = (fragment: string) =>
    requests
      .filter((request) => request.url.includes(fragment))
      .map((request) => String((request.init?.headers as Record<string, string> | undefined)?.authorization ?? ""));
  // The work-package mutation AND its readback of the event it just wrote.
  assert.deepEqual(authorizationFor("work_package_api"), ["token work-package-key:work-package-secret"]);
  assert.deepEqual(authorizationFor("Work%20Package%20Event"), ["token work-package-key:work-package-secret"]);
  // The field-evidence rail is out of this split's scope and stays on the bus pair.
  assert.deepEqual(authorizationFor("field_evidence_api"), ["token bus-key:bus-secret"]);
  // The dedup list read and the readback of the item just written; both field-evidence.
  assert.deepEqual(authorizationFor("Evidence%20Item"), [
    "token bus-key:bus-secret",
    "token bus-key:bus-secret",
  ]);
});

test("the work-package half of the field writer refuses a shared bus credential", async () => {
  const env = { ...testEnv() } as Record<string, unknown>;
  env.WORK_PACKAGE_FRAPPE_API_KEY = "bus-key";
  env.WORK_PACKAGE_FRAPPE_API_SECRET = "bus-secret";
  let called = false;
  await withFetch(
    async () => {
      called = true;
      return Response.json({});
    },
    async () => {
      const event: PersistWorkPackageEvidenceInput = {
        workPackageId: "WORK-PACKAGE-SHOP-1",
        workPackageVersion: 4,
        jobId: "SHOP-001",
        assignmentId: "ASSIGN-SHOP-1",
        actorUser: "crew@example.com",
        deviceActionId: "wpe_shared-credential",
        evidenceSlotId: "step:1",
        evidenceRequirement: "Anchor inspection photo",
        evidenceSource: "field-companion",
        evidenceItemId: "EVIDENCE-SHOP-1",
        evidenceDeviceId: "paired-device-1",
        evidenceCapturedAt: "2026-07-10T10:05:00.000Z",
        evidenceFreshness: "Current",
        evidenceConflictState: "None",
        evidenceCorrectionOf: null,
        evidenceItemCorrectionOf: null,
        workPackageReleaseAttemptId: "attempt-shop-1",
        correctionReason: null,
        evidenceVerification: "Verified",
        evidenceDisposition: "Open",
      };
      await assert.rejects(
        frappeFieldWriter(env as never).persistWorkPackageEvidence!(event),
        /work_package_frappe_shared_credential_rejected/,
      );
    },
  );
  assert.equal(called, false);
});

test("an exact existing Field Check-in replay is accepted without a second write", async () => {
  let calls = 0;
  await withFetch(
    async (_input, init) => {
      calls += 1;
      assert.equal(init?.method, "GET");
      return Response.json({
        data: [
          {
            name: "FIELD-CHECKIN-1",
            checkin_id: checkInInput.checkinId,
            device_action_id: checkInInput.deviceActionId,
            roof_job: checkInInput.jobId,
            job_assignment: checkInInput.assignmentId,
            source_system: "ironwrap-pwa",
            capture_actor: checkInInput.captureActor,
            sync_state: "Verified",
            raw_key: checkInInput.manifestKey,
            evidence_ids_json: JSON.stringify(checkInInput.evidenceIds),
            correction_of: null,
          },
        ],
      });
    },
    async () => {
      assert.deepEqual(await frappeFieldWriter(testEnv()).persistCheckIn(checkInInput), {
        name: "FIELD-CHECKIN-1",
      });
    },
  );
  assert.equal(calls, 1);
});

test("runtime-governed Field evidence is read back and replays without a second provider write", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const runtimeEnv = {
    ...testEnv(),
    APP_TENANT_ID: "ironwrap",
    EFFECT_RUNTIME_ENABLED: "true",
    DB: new SqliteD1(),
  } as AppEnv;
  await withFetch(
    async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      requests.push({ url, method });
      if (method === "GET" && url.endsWith("/api/resource/Evidence%20Item/EVIDENCE-ISSUED-1")) {
        return Response.json({ data: { name: "EVIDENCE-ISSUED-1" } });
      }
      if (method === "GET") return Response.json({ data: [] });
      if (method === "POST") return Response.json({ message: { name: "EVIDENCE-ISSUED-1" } });
      throw new Error(`unexpected_method:${method}`);
    },
    async () => {
      assert.deepEqual(await frappeFieldWriter(runtimeEnv).persistEvidence(evidenceInput), {
        name: "EVIDENCE-ISSUED-1",
      });
      assert.deepEqual(await frappeFieldWriter(runtimeEnv).persistEvidence(evidenceInput), {
        name: "EVIDENCE-ISSUED-1",
      });
    },
  );
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(
    Number((runtimeEnv.DB as unknown as SqliteD1).raw.prepare("SELECT COUNT(*) AS count FROM external_effects WHERE state = 'succeeded'").get().count),
    1,
  );
});

async function withFetch(replacement: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

// The routing above is proved through the writer's real fetches. These call the authorizer
// directly, because that is the contract `tools/validate-rail-credential-isolation.mjs` executes
// (ELEC-143): reading the branch as text cannot tell a live one from an unreachable one, so the
// isolation guarantee is pinned to what this function RETURNS, here and in the validator.
const WORK_PACKAGE_PATH =
  "/api/method/ironwrap_roofing.work_package_api.capture_work_package_evidence";
const FIELD_EVIDENCE_PATH =
  "/api/method/ironwrap_roofing.field_evidence_api.record_verified_field_evidence";

test("the field writer's authorizer hands each rail its own identity", () => {
  const env = testEnv();
  assert.equal(
    frappeFieldAuthorization(env, WORK_PACKAGE_PATH),
    "token work-package-key:work-package-secret",
  );
  // The field-evidence rail is out of this split's scope and legitimately keeps the bus pair.
  assert.equal(frappeFieldAuthorization(env, FIELD_EVIDENCE_PATH), "token bus-key:bus-secret");
  assert.equal(
    frappeFieldAuthorization(env, "/api/resource/Field%20Check-in"),
    "token bus-key:bus-secret",
  );
});

test("the work-package rail fails closed rather than degrading to the bus pair", () => {
  // An unset binding must be a visible outage, not a silent widening back to a System Manager:
  // that is the difference between a rotation window and a privilege escalation.
  const env = { ...testEnv() } as Record<string, unknown>;
  delete env.WORK_PACKAGE_FRAPPE_API_KEY;
  delete env.WORK_PACKAGE_FRAPPE_API_SECRET;
  assert.throws(
    () => frappeFieldAuthorization(env as never, WORK_PACKAGE_PATH),
    /work_package_frappe_not_configured/,
  );
  // The rail it shares the module with is unaffected by the other rail's outage.
  assert.equal(
    frappeFieldAuthorization(env as never, FIELD_EVIDENCE_PATH),
    "token bus-key:bus-secret",
  );
});
