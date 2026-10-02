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

  it("keeps corrective evidence strict about keys, digests and evidence references", () => {
    const evidence = {
      detail: "Guardrail replaced and photographed",
      evidence_sha256: sha,
      evidence_refs_json: JSON.stringify([{ ref: "r2://synthetic/photo.jpg", sha256: sha }]),
    };
    expect(contracts.correctiveEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(contracts.correctiveEvidenceSchema.safeParse({ ...evidence, extra: true }).success).toBe(
      false,
    );
    expect(
      contracts.correctiveEvidenceSchema.safeParse({ ...evidence, evidence_refs_json: "[]" })
        .success,
    ).toBe(false);
    expect(
      contracts.correctiveEvidenceSchema.safeParse({ ...evidence, evidence_sha256: "not-a-digest" })
        .success,
    ).toBe(false);
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
