import { describe, expect, it } from "vitest";

import { receiptIdFor } from "./evidence-test-harness";
import {
  EVIDENCE_MAX_BYTES,
  describeEvidenceFile,
  evidenceFileRefSchema,
  evidenceFilesSchema,
  evidenceScopeKey,
  formatFileSize,
  isUploadKey,
  isUploadableScope,
  newEvidenceUploadKey,
} from "./evidence-types";

const file = (overrides: Record<string, unknown> = {}) => ({
  receipt_id: receiptIdFor(1),
  file_name: "south-eave.jpg",
  content_type: "image/jpeg",
  byte_size: 2_200_000,
  ...overrides,
});

describe("evidence_files as the detail reads list them", () => {
  it("reads a list of strictly shaped files", () => {
    expect(evidenceFilesSchema.parse([file(), file({ receipt_id: receiptIdFor(2) })])).toHaveLength(
      2,
    );
  });

  it("reads an absent list, for a Worker that does not send one yet", () => {
    expect(evidenceFilesSchema.parse(undefined)).toBeUndefined();
  });

  it("reads an empty list, which is how older evidence that was only a digest arrives", () => {
    expect(evidenceFilesSchema.parse([])).toEqual([]);
  });

  it.each([
    ["a receipt id that is not one", { receipt_id: "a".repeat(64) }],
    ["a receipt id with the wrong length", { receipt_id: `evu_${"a".repeat(63)}` }],
    ["an extra field", { sha256: "a".repeat(64) }],
    ["a missing name", { file_name: "" }],
    ["a name that is too long", { file_name: "n".repeat(181) }],
    ["a type the Worker never stores", { content_type: "image/gif" }],
    ["a size of zero", { byte_size: 0 }],
    ["a fractional size", { byte_size: 10.5 }],
    ["a size above the limit", { byte_size: EVIDENCE_MAX_BYTES + 1 }],
    ["a size that is text", { byte_size: "2200000" }],
  ])("refuses a file with %s", (_label, overrides) => {
    expect(evidenceFileRefSchema.safeParse(file(overrides)).success).toBe(false);
    expect(evidenceFilesSchema.safeParse([file(), file(overrides)]).success).toBe(false);
  });

  it("refuses a file with a field missing", () => {
    const { byte_size: _size, ...incomplete } = file();
    expect(evidenceFileRefSchema.safeParse(incomplete).success).toBe(false);
  });
});

describe("describeEvidenceFile and formatFileSize", () => {
  it("says what a file is and how big in plain words", () => {
    expect(describeEvidenceFile({ content_type: "image/jpeg", byte_size: 2_200_000 })).toBe(
      "Photo · 2.1 MB",
    );
    expect(describeEvidenceFile({ content_type: "image/heic", byte_size: 4_194_304 })).toBe(
      "Photo · 4.0 MB",
    );
    expect(describeEvidenceFile({ content_type: "application/pdf", byte_size: 348_160 })).toBe(
      "PDF · 340 KB",
    );
  });

  it("sizes a small file in bytes and never as zero", () => {
    expect(formatFileSize(512)).toBe("under 1 KB");
    expect(formatFileSize(1)).toBe("under 1 KB");
    expect(formatFileSize(1_025)).toBe("1 KB");
  });
});

describe("upload keys and scopes", () => {
  it("mints a key the Worker accepts, a different one each time", () => {
    const keys = new Set(Array.from({ length: 20 }, newEvidenceUploadKey));
    expect(keys.size).toBe(20);
    for (const key of keys) expect(isUploadKey(key)).toBe(true);
  });

  it("only accepts keys of 8 to 120 safe characters", () => {
    expect(isUploadKey("short")).toBe(false);
    expect(isUploadKey("-starts-with-a-dash")).toBe(false);
    expect(isUploadKey("has space in it")).toBe(false);
    expect(isUploadKey("a".repeat(121))).toBe(false);
    expect(isUploadKey("a".repeat(120))).toBe(true);
  });

  it("holds back a scope the Worker could not accept", () => {
    const scope = {
      purpose: "service_intake",
      targetId: "JOB-1",
      action: "open",
      operationId: "",
    } as const;
    expect(isUploadableScope(scope)).toBe(true);
    expect(isUploadableScope({ ...scope, targetId: "JO" })).toBe(false);
    expect(isUploadableScope({ ...scope, targetId: "JOB 1" })).toBe(false);
    expect(isUploadableScope({ ...scope, operationId: "no good!" })).toBe(false);
    expect(isUploadableScope(null)).toBe(false);
    expect(evidenceScopeKey(null)).toBe("");
    expect(evidenceScopeKey(scope)).not.toBe(evidenceScopeKey({ ...scope, targetId: "JOB-2" }));
  });
});
