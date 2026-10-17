import { describe, expect, it } from "vitest";

import { receiptIdFor } from "../evidence/evidence-test-harness";
import { appliedCommandResponse } from "./inventory-fixtures";
import { inventoryCommandDetailResponseSchema } from "./inventory-contracts";

const { command } = appliedCommandResponse("inventory:command:test");
const detail = { version: 1, command };
const file = {
  receipt_id: receiptIdFor(1),
  file_name: "issue.jpg",
  content_type: "image/jpeg",
  byte_size: 2048,
};

describe("the stock command detail read", () => {
  it("reads evidence_files as optional, with strictly shaped items", () => {
    expect(
      inventoryCommandDetailResponseSchema.parse({
        ...detail,
        evidence_files: [],
        evidence_files_unavailable: true,
      }).evidence_files_unavailable,
    ).toBe(true);
    expect(
      inventoryCommandDetailResponseSchema.parse({ ...detail, evidence_files: [file] })
        .evidence_files,
    ).toEqual([file]);
    // Exactly as a healthy #362 read sends it: the list beside its marker.
    expect(
      inventoryCommandDetailResponseSchema.parse({
        ...detail,
        evidence_files: [file],
        evidence_files_unavailable: false,
      }),
    ).toMatchObject({ evidence_files: [file], evidence_files_unavailable: false });
    expect(inventoryCommandDetailResponseSchema.parse(detail).evidence_files).toBeUndefined();
    expect(
      inventoryCommandDetailResponseSchema.parse({ ...detail, evidence_files: [] }).evidence_files,
    ).toEqual([]);
    for (const bad of [
      { ...file, receipt_id: "not-a-receipt" },
      { ...file, extra: "field" },
      { ...file, content_type: "application/zip" },
      { ...file, byte_size: 9 * 1024 * 1024 },
      { receipt_id: file.receipt_id },
    ]) {
      expect(
        inventoryCommandDetailResponseSchema.safeParse({ ...detail, evidence_files: [bad] })
          .success,
      ).toBe(false);
    }
  });

  it("still needs the command itself", () => {
    expect(inventoryCommandDetailResponseSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(
      inventoryCommandDetailResponseSchema.safeParse({ version: 2, command, evidence_files: [] })
        .success,
    ).toBe(false);
  });
});
