import assert from "node:assert/strict";
import { test } from "node:test";

import { FieldActionError } from "../src/field-actions.ts";
import {
  assertFleetPhotosStored,
  parseFleetPhotoEvidenceRefs,
} from "../src/fleet-photo-evidence.ts";

const PHOTO = {
  attachment_id: "photo-fleet-0001",
  file_name: "chamber.jpg",
  content_type: "image/jpeg" as const,
  sha256: "ab".repeat(32),
  r2_key: "fleet/v1/scopedigest24charsxx/photo/asset-truck-1/photo-fleet-0001.bin",
};

test("fleet photo refs are bounded JSON, never raw bytes", () => {
  assert.deepEqual(parseFleetPhotoEvidenceRefs([PHOTO]), [PHOTO]);
  assert.throws(
    () => parseFleetPhotoEvidenceRefs([]),
    (error: unknown) => error instanceof FieldActionError && error.code === "invalid_fleet_action",
  );
  assert.throws(
    () => parseFleetPhotoEvidenceRefs([{ ...PHOTO, r2_key: "field/v1/photo.bin" }]),
    (error: unknown) => error instanceof FieldActionError && error.code === "invalid_fleet_action",
  );
});

test("missing or mismatched stored photos fail closed", async () => {
  await assert.rejects(
    assertFleetPhotosStored({ head: async () => null }, [PHOTO]),
    (error: unknown) => error instanceof FieldActionError && error.code === "fleet_photo_missing",
  );
  await assert.rejects(
    assertFleetPhotosStored(
      { head: async () => ({ customMetadata: { sha256: "cd".repeat(32) } }) },
      [PHOTO],
    ),
    (error: unknown) => error instanceof FieldActionError && error.code === "fleet_photo_mismatch",
  );
  await assertFleetPhotosStored(
    { head: async () => ({ customMetadata: { sha256: PHOTO.sha256 } }) },
    [PHOTO],
  );
});
