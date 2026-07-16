import assert from "node:assert/strict";
import { test } from "node:test";

import { frappeFieldWriter, type PersistFieldCheckInInput, type PersistFieldMediaInput } from "../src/frappe-field.ts";
import type { AppEnv } from "../src/app-types.ts";

const env = {
  ERPNEXT_BASE_URL: "https://frappe.example.com",
  ERPNEXT_API_KEY: "key",
  ERPNEXT_API_SECRET: "secret",
  APP_FRAPPE_REQUEST_TIMEOUT_MS: "8000",
} as AppEnv;

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
      await assert.rejects(frappeFieldWriter(env).persistEvidence(evidenceInput), /frappe_field_identity_conflict/);
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
        frappeFieldWriter(env).persistEvidence({
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
      assert.deepEqual(await frappeFieldWriter(env).persistEvidence(evidenceInput), {
        name: "EVIDENCE-ISSUED-1",
      });
    },
  );
  assert.equal(requests.length, 2);
  assert.match(requests[0]!.url, /\/api\/resource\/Evidence%20Item\?/);
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
      assert.deepEqual(await frappeFieldWriter(env).persistCheckIn(checkInInput), {
        name: "FIELD-CHECKIN-1",
      });
    },
  );
  assert.equal(calls, 1);
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
