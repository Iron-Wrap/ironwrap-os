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

describe("crew tape readings on a work plan read", () => {
  const total = (feet: number, inches: number, eighths: number) => feet * 96 + inches * 8 + eighths;
  function reading(overrides: Record<string, unknown> = {}) {
    return {
      checkin_id: "CHK-TEST-1",
      device_action_id: "device-action-0001",
      assignment_id: "ASSIGN-TEST",
      measurement: {
        feet: 42,
        inches: 7,
        eighths: 3,
        area_label: "south eave",
        total_eighth_inches: total(42, 7, 3),
      },
      captured_at: "2026-09-29T12:30:00.000Z",
      recorded_by: "appu_field_test",
      recorded_by_name: "Synthetic Crew",
      device_id: "device-test-1",
      correction_of: null,
      correction_reason: null,
      superseded_by: null,
      work_package_id: null,
      work_package_version: null,
      evidence_slot_id: null,
      evidence_item_correction_of: null,
      work_package_release_attempt_id: null,
      allowed_actions: ["field.measurement.correct"],
      correction_target: { correction_of: "CHK-TEST-1" },
      ...overrides,
    };
  }
  const read = (extra: Record<string, unknown>) =>
    contracts.workObjectResponseSchema.parse({ ...workObject(), ...extra });

  it("reads the readings and whether the office holds more than this list", () => {
    const parsed = read({ field_measurements: [reading()], field_measurements_more: true });
    expect(parsed.field_measurements).toEqual([reading()]);
    expect(parsed.field_measurements_more).toBe(true);
    expect(parsed.stale_fields).toEqual([]);
  });

  it("reads an older Worker's plan with no readings as an empty list, nothing marked", () => {
    const parsed = read({});
    expect(parsed.field_measurements).toEqual([]);
    expect(parsed.field_measurements_more).toBe(false);
    expect(parsed.stale_fields).toEqual([]);
  });

  it("takes every reading the Worker can store, at its limits", () => {
    const longest = {
      feet: 100_000,
      inches: 11,
      eighths: 7,
      area_label: "a".repeat(120),
      total_eighth_inches: total(100_000, 11, 7),
    };
    const smallest = { feet: 0, inches: 0, eighths: 1, area_label: "x", total_eighth_inches: 1 };
    const { recorded_by_name: _name, ...olderWorker } = reading();
    const items = [
      reading({ measurement: longest }),
      reading({ measurement: smallest, correction_target: null, allowed_actions: [] }),
      reading({
        correction_target: {
          evidence_correction_of: "EVT-TEST-1",
          evidence_item_correction_of: "ITEM-TEST-1",
        },
      }),
      reading({ recorded_by_name: null, superseded_by: "CHK-TEST-2", correction_target: null }),
      olderWorker,
    ];
    const parsed = read({ field_measurements: items });
    expect(parsed.field_measurements).toHaveLength(items.length);
    expect(parsed.stale_fields).toEqual([]);
  });

  it("drops a list it cannot vouch for and marks it, but keeps the work plan", () => {
    const broken: Array<[string, Record<string, unknown>]> = [
      [
        "inches past 11",
        {
          field_measurements: [
            reading({
              measurement: {
                ...reading().measurement,
                inches: 12,
                total_eighth_inches: total(42, 12, 3),
              },
            }),
          ],
        },
      ],
      [
        "eighths past 7",
        {
          field_measurements: [
            reading({
              measurement: {
                ...reading().measurement,
                eighths: 8,
                total_eighth_inches: total(42, 7, 8),
              },
            }),
          ],
        },
      ],
      [
        "feet past the Worker's limit",
        {
          field_measurements: [
            reading({
              measurement: {
                ...reading().measurement,
                feet: 100_001,
                total_eighth_inches: total(100_001, 7, 3),
              },
            }),
          ],
        },
      ],
      [
        "a total that disagrees with its parts",
        {
          field_measurements: [
            reading({ measurement: { ...reading().measurement, total_eighth_inches: 1 } }),
          ],
        },
      ],
      [
        "an empty reading",
        {
          field_measurements: [
            reading({
              measurement: {
                feet: 0,
                inches: 0,
                eighths: 0,
                area_label: "x",
                total_eighth_inches: 0,
              },
            }),
          ],
        },
      ],
      [
        "a place name past 120",
        {
          field_measurements: [
            reading({ measurement: { ...reading().measurement, area_label: "a".repeat(121) } }),
          ],
        },
      ],
      [
        "fractional feet",
        { field_measurements: [reading({ measurement: { ...reading().measurement, feet: 4.5 } })] },
      ],
      ["a reading with no check-in", { field_measurements: [reading({ checkin_id: "" })] }],
      ["a fix target naming nothing", { field_measurements: [reading({ correction_target: {} })] }],
      ["a list that is not a list", { field_measurements: "south eave 42 ft" }],
      [
        "a more flag that is not a flag",
        { field_measurements: [reading()], field_measurements_more: "yes" },
      ],
    ];
    for (const [label, extra] of broken) {
      const result = contracts.workObjectResponseSchema.safeParse({ ...workObject(), ...extra });
      expect(result.success, label).toBe(true);
      if (!result.success) throw new Error(`${label} hid the work plan`);
      expect(result.data.field_measurements, label).toEqual([]);
      expect(result.data.field_measurements_more, label).toBe(false);
      expect(result.data.stale_fields, label).toEqual(["field_measurements.native_unavailable"]);
      expect(result.data.work_package?.id, label).toBe("WP-TEST");
    }
  });

  it("reads a history page whole or not at all", () => {
    const page = {
      ...envelope,
      items: [reading(), reading({ checkin_id: "CHK-TEST-0", superseded_by: "CHK-TEST-1" })],
      page_size: 100,
      next_cursor: "WyIyMDI2LTA5LTI5VDEyOjMwOjAwLjAwMFoiXQ",
    };
    expect(contracts.fieldMeasurementPageSchema.parse(page).items).toHaveLength(2);
    expect(
      contracts.fieldMeasurementPageSchema.safeParse({
        ...page,
        items: [reading({ measurement: { ...reading().measurement, inches: 12 } })],
      }).success,
    ).toBe(false);
    expect(contracts.fieldMeasurementPageSchema.safeParse({ ...page, page_size: 0 }).success).toBe(
      false,
    );
  });
});

describe("active stops on the crew reads", () => {
  const stop = {
    occurrence_id: "wpe_stop_1",
    scope: "job",
    reported_at: "2026-09-29T13:40:00.000Z",
    summary: "Ice on the north slope",
    raiser_display_name: null,
  };

  it("reads an older cached read with no holding list as unknown", () => {
    const result = contracts.workObjectResponseSchema.safeParse(workObject());
    expect(result.success && result.data.active_stops).toBeNull();
  });

  it("never drops a stop: an unknown scope reads as a job stop", () => {
    const result = contracts.workObjectResponseSchema.safeParse({
      ...workObject(),
      active_stops: [stop, { ...stop, occurrence_id: "occ_2", scope: "site" }],
    });
    expect(result.success && result.data.active_stops?.map((item) => item.scope)).toEqual([
      "job",
      "job",
    ]);
  });

  it("keeps an unknown summary and raiser as null", () => {
    const result = contracts.activeStopSchema.safeParse({ ...stop, summary: null });
    expect(result.success && result.data).toEqual({ ...stop, summary: null });
  });
});
