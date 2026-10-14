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

const envelope = {
  version: 1,
  source_updated_at: null,
  read_model_generated_at: "2026-09-29T12:00:00.000Z",
  stale_fields: [],
  permissions: [],
  allowed_actions: [],
};

function workObject() {
  return {
    ...envelope,
    work_object: {
      workObjectType: "Roof Job",
      workObjectId: "JOB-TEST",
      physicalContextType: "Roof Site",
      physicalContextId: "SITE-TEST",
    },
    assignment: null,
    work_package: {
      id: "WP-TEST",
      version: 1,
      status: "Released",
      title: "Synthetic roof package",
      objective: "Inspect the synthetic test area",
      boundaries: "Test area only",
      prerequisites: "Review the issued controls",
      expected_result: "Inspection recorded",
      stop_conditions: "Stop if controls cannot be followed",
      make_safe_procedure: "Withdraw to the designated safe area",
      issued_at: "2026-09-29T12:00:00.000Z",
      expires_at: "2026-09-30T12:00:00.000Z",
      released_at: "2026-09-29T12:00:00.000Z",
      release_attempt_id: null,
      supersession: null,
      acknowledgement: { current_user_acknowledged: false, acknowledged_at: null },
      steps: [
        {
          sequence: 1,
          instruction: "Inspect the test area",
          required_evidence: "Inspection record",
          acceptance_criteria: "Complete record",
        },
      ],
      hold_points: [
        {
          sequence: 1,
          hold_point: "Check the controls",
          release_authority: "Production",
          required_evidence: "Control check",
          acceptance_criteria: "Controls verified",
          released: false,
        },
      ],
    },
  };
}

let contracts: typeof import("./field-contracts");

beforeEach(async () => {
  vi.resetModules();
  constructedShapes.length = 0;
  contracts = await import("./field-contracts");
});

describe("field response validation", () => {
  it("does not construct packet validators for Today and constructs them once when needed", () => {
    const hasField = (field: string) => constructedShapes.some((shape) => shape.includes(field));
    expect(hasField("stop_conditions")).toBe(false);
    expect(hasField("roof_job_id")).toBe(false);
    expect(hasField("workObjectType")).toBe(false);
    expect(hasField("proof_slot")).toBe(false);

    expect(
      contracts.todayResponseSchema.parse({ ...envelope, date: "2026-09-29", jobs: [] }),
    ).toEqual({ ...envelope, date: "2026-09-29", jobs: [], work_objects: [] });
    expect(hasField("stop_conditions")).toBe(false);
    expect(hasField("roof_job_id")).toBe(false);

    expect(contracts.workObjectResponseSchema.safeParse(workObject()).success).toBe(true);
    expect(hasField("stop_conditions")).toBe(true);
    expect(hasField("workObjectType")).toBe(true);
    expect(hasField("roof_job_id")).toBe(false);
    const constructions = constructedShapes.length;
    expect(contracts.workObjectResponseSchema.safeParse(workObject()).success).toBe(true);
    expect(constructedShapes).toHaveLength(constructions);
  });

  it("retains synchronous nested work-package validation and defaults", () => {
    const parsed = contracts.workObjectResponseSchema.parse(workObject());
    expect(parsed.work_package?.acknowledgement.workers).toEqual([]);
    expect(parsed.work_package?.evidence_slots).toEqual([]);
    expect(parsed.work_package?.hold_points[0]?.release_phase).toBe("Pre-start");

    const invalid = workObject();
    invalid.work_package.steps[0]!.sequence = 0;
    invalid.work_package.hold_points[0]!.release_authority = "";
    const result = contracts.workObjectResponseSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Malformed work package was accepted");
    expect(result.error.issues.map((issue) => issue.path)).toEqual([
      ["work_package", "steps", 0, "sequence"],
      ["work_package", "hold_points", 0, "release_authority"],
    ]);
    expect(() => contracts.workObjectResponseSchema.parse(invalid)).toThrow();
  });

  it("keeps absent legacy work packages readable without inventing authority", () => {
    const { work_package: _workPackage, ...legacy } = workObject();
    expect(contracts.workObjectResponseSchema.parse(legacy).work_package).toBeNull();
    expect(
      contracts.workObjectResponseSchema.parse({ ...legacy, work_package: null }).work_package,
    ).toBeNull();
    expect(
      contracts.workObjectResponseSchema.safeParse({ ...legacy, work_package: {} }).success,
    ).toBe(false);
  });

  it("validates proof items on first use instead of accepting a malformed nested blocker", () => {
    const item = {
      id: "EV-TEST",
      type: null,
      proof_slot: null,
      occurred_at: null,
      summary: null,
      customer_safe: null,
      source: null,
      sync_state: null,
      blocker: false,
    };
    const page = { ...envelope, items: [item], next_cursor: null };
    expect(contracts.proofPageResponseSchema.parse(page)).toEqual(page);
    const result = contracts.proofPageResponseSchema.safeParse({
      ...page,
      items: [{ ...item, blocker: "false" }],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Malformed proof was accepted");
    expect(result.error.issues[0]?.path).toEqual(["items", 0, "blocker"]);
  });

  it("reads the saved office contact with the customer portal's rules, and only those", () => {
    for (const office_contact of [
      undefined,
      null,
      { phone: "+14035550100", email: "office@example.invalid" },
      { phone: null, email: "first..last@example.invalid" },
      { phone: "+14035550100", email: null },
    ]) {
      expect(
        contracts.workObjectResponseSchema.safeParse({ ...workObject(), office_contact }).success,
      ).toBe(true);
    }
    // A malformed contact is dropped and marked unavailable; the work plan itself still reads.
    for (const office_contact of [
      { phone: "403-555-0100", email: null },
      { phone: null, email: "not-an-email" },
      { phone: null, email: null, staff_name: "Pat" },
      { phone: "+14035550100" },
      "+14035550100",
    ]) {
      const result = contracts.workObjectResponseSchema.safeParse({
        ...workObject(),
        office_contact,
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("A malformed office contact hid the work plan");
      expect(result.data.office_contact).toBeUndefined();
      expect(result.data.stale_fields).toContain("office_contact.unavailable");
    }
  });
});
