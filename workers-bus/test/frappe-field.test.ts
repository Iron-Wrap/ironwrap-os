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
