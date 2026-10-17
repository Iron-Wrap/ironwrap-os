import { beforeEach, describe, expect, it, vi } from "vitest";

const constructedShapes = vi.hoisted(() => [] as string[][]);

vi.mock("zod", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zod")>();
  return {
    ...actual,
    z: {
      ...actual.z,
      object: new Proxy(actual.z.object, {
        apply(target, receiver, args) {
          constructedShapes.push(Object.keys(args[0]));
          return Reflect.apply(target, receiver, args);
        },
      }),
    },
  };
});

const panel = {
  version: 1,
  actor_role: "field",
  assigned_equipment: [
    {
      equipment_id: "EQ-TEST",
      equipment_kind: "Harness",
      serial_number: "SN-TEST",
      status: "in_service",
      inspection_due_at: null,
    },
  ],
  open_occurrences: [],
  my_corrective_actions: [],
  allowed_actions: ["report_occurrence"],
};

const correctiveAction = {
  corrective_action_id: "CA-TEST",
  occurrence_id: "OCC-TEST",
  version: 1,
  state: "open",
  risk_level: "high",
  owner_user_id: "appu_test",
  description: "Replace the synthetic guardrail",
  due_at: "2026-10-02T12:00:00.000Z",
  evidence_refs_json: null,
  evidence_sha256: null,
  evidence_captured_by_user_id: null,
  evidence_submitted_at: null,
  verified_by_user_id: null,
  verified_at: null,
  closed_at: null,
};

const sha = "a".repeat(64);

let contracts: typeof import("./safety-contracts");

beforeEach(async () => {
  vi.resetModules();
  constructedShapes.length = 0;
  contracts = await import("./safety-contracts");
});

describe("safety contracts", () => {
  it("builds no validator while the boot bundle loads and each one once on first parse", () => {
    expect(constructedShapes).toEqual([]);

    expect(contracts.safetyPanelResponseSchema.parse({ version: 1, panel })).toEqual({
      version: 1,
      panel,
    });
    const constructions = constructedShapes.length;
    expect(constructions).toBeGreaterThan(0);
    const built = (field: string) => constructedShapes.some((shape) => shape.includes(field));
    expect(built("owner_user_id")).toBe(false);
    expect(built("inspection_interval_days")).toBe(false);
    expect(built("evidence_refs_json")).toBe(false);

    expect(contracts.safetyPanelSchema.safeParse(panel).success).toBe(true);
    expect(contracts.safetyPanelResponseSchema.safeParse({ version: 1, panel }).success).toBe(true);
    expect(constructedShapes).toHaveLength(constructions);
  });

  it("still rejects a panel with an unknown equipment status", () => {
    const result = contracts.safetyPanelSchema.safeParse({
      ...panel,
      assigned_equipment: [{ ...panel.assigned_equipment[0], status: "unknown" }],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Malformed safety panel was accepted");
    expect(result.error.issues[0]?.path).toEqual(["assigned_equipment", 0, "status"]);
  });

  it("keeps corrective evidence to what the person writes, or a whole typed reference", () => {
    const evidence = { detail: "Guardrail replaced and photographed" };
    expect(contracts.correctiveEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(contracts.correctiveEvidenceSchema.safeParse({ ...evidence, extra: true }).success).toBe(
      false,
    );
    // The files travel as receipt ids added when the request is sent, never inside it. The safety
    // desk that still types a reference sends its digest and references together; half of that
    // pair is refused here instead of reaching the Worker.
    const refs = JSON.stringify([{ ref: "r2://synthetic/photo.jpg", sha256: sha }]);
    const typed = { ...evidence, evidence_sha256: sha, evidence_refs_json: refs };
    expect(contracts.correctiveEvidenceSchema.parse(typed)).toEqual(typed);
    for (const partial of [
      { evidence_sha256: sha },
      { evidence_refs_json: refs },
      { evidence_receipt_ids: ["evu_" + "a".repeat(64)] },
    ]) {
      expect(
        contracts.correctiveEvidenceSchema.safeParse({ ...evidence, ...partial }).success,
      ).toBe(false);
    }
    for (const broken of [
      { ...typed, evidence_sha256: "not-a-digest" },
      { ...typed, evidence_refs_json: "[]" },
    ]) {
      expect(contracts.correctiveEvidenceSchema.safeParse(broken).success).toBe(false);
    }
    expect(contracts.correctiveEvidenceSchema.safeParse({ detail: "  no " }).success).toBe(false);
  });

  it("reads evidence_files on the corrective action detail as optional, with strictly shaped items", () => {
    const detail = {
      version: 1,
      corrective_action: correctiveAction,
      allowed_actions: ["submit_evidence"],
      verification_unavailable_reason: null,
    };
    const file = {
      receipt_id: `evu_${"a".repeat(64)}`,
      file_name: "tie-off.jpg",
      content_type: "image/jpeg",
      byte_size: 2048,
    };
    // Present, absent and empty all read; an absent list is not turned into an empty one.
    expect(
      contracts.correctiveActionDetailSchema.parse({ ...detail, evidence_files: [file] })
        .evidence_files,
    ).toEqual([file]);
    // Exactly as a healthy #362 read sends it: the list beside its marker.
    expect(
      contracts.correctiveActionDetailSchema.parse({
        ...detail,
        evidence_files: [file],
        evidence_files_unavailable: false,
      }),
    ).toMatchObject({ evidence_files: [file], evidence_files_unavailable: false });
    expect(contracts.correctiveActionDetailSchema.parse(detail).evidence_files).toBeUndefined();
    expect(
      contracts.correctiveActionDetailSchema.parse({
        ...detail,
        evidence_files: [],
        evidence_files_unavailable: true,
      }).evidence_files_unavailable,
    ).toBe(true);
    expect(
      contracts.correctiveActionDetailSchema.parse({ ...detail, evidence_files: [] })
        .evidence_files,
    ).toEqual([]);
    // An item that is not exactly a file refuses the whole read rather than showing half of it.
    for (const bad of [
      { ...file, receipt_id: "a".repeat(64) },
      { ...file, extra: true },
      { ...file, content_type: "text/html" },
      { ...file, byte_size: 0 },
      { ...file, file_name: "" },
      "tie-off.jpg",
    ]) {
      expect(
        contracts.correctiveActionDetailSchema.safeParse({ ...detail, evidence_files: [bad] })
          .success,
      ).toBe(false);
    }
  });

  it("keeps the corrective action detail a superset of the plain response", () => {
    const response = { version: 1, corrective_action: correctiveAction };
    expect(contracts.correctiveActionResponseSchema.parse(response)).toEqual(response);
    const detail = {
      ...response,
      allowed_actions: ["submit_evidence"],
      verification_unavailable_reason: null,
    };
    expect(contracts.correctiveActionDetailSchema.parse(detail)).toEqual(detail);
    expect(
      contracts.correctiveActionDetailSchema.safeParse({ ...detail, allowed_actions: ["approve"] })
        .success,
    ).toBe(false);
    expect(contracts.correctiveActionDetailSchema.safeParse(response).success).toBe(false);
  });
});
