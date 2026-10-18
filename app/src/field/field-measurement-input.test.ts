// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  EMPTY_MEASUREMENT,
  MAX_AREA_LABEL,
  MAX_FIELD_MEASUREMENT_FEET,
  readMeasurement,
  type MeasurementDraft,
} from "./field-measurement-input";

const draft = (overrides: Partial<MeasurementDraft>): MeasurementDraft => ({
  ...EMPTY_MEASUREMENT,
  areaLabel: "south eave",
  ...overrides,
});

describe("a crew tape reading as typed", () => {
  it("reads feet, inches and eighths into the reading the Worker accepts", () => {
    expect(readMeasurement(draft({ feet: "42", inches: "7", eighths: "3" }))).toEqual({
      ok: true,
      value: { feet: 42, inches: 7, eighths: 3, area_label: "south eave" },
    });
    // Blank feet is zero feet; a reading under a foot is still a reading.
    expect(readMeasurement(draft({ feet: " ", inches: "11", eighths: "0" }))).toEqual({
      ok: true,
      value: { feet: 0, inches: 11, eighths: 0, area_label: "south eave" },
    });
    expect(readMeasurement(draft({ feet: "", inches: "", eighths: "1" }))).toMatchObject({
      ok: true,
      value: { feet: 0, inches: 0, eighths: 1 },
    });
  });

  it("takes each part up to the Worker's limit and refuses one past it", () => {
    expect(
      readMeasurement(
        draft({ feet: String(MAX_FIELD_MEASUREMENT_FEET), inches: "11", eighths: "7" }),
      ),
    ).toMatchObject({
      ok: true,
      value: { feet: MAX_FIELD_MEASUREMENT_FEET, inches: 11, eighths: 7 },
    });
    expect(readMeasurement(draft({ feet: String(MAX_FIELD_MEASUREMENT_FEET + 1) }))).toEqual({
      ok: false,
      message: "Feet must be a whole number, like 42.",
      field: "measurement-feet",
    });
    expect(readMeasurement(draft({ feet: "1", inches: "12" }))).toEqual({
      ok: false,
      message: "Inches must be a whole number from 0 to 11.",
      field: "measurement-inches",
    });
    expect(readMeasurement(draft({ feet: "1", eighths: "8" }))).toEqual({
      ok: false,
      message: "Eighths must be a whole number from 0 to 7.",
      field: "measurement-eighths",
    });
  });

  it("never sends an empty reading", () => {
    expect(readMeasurement(draft({ feet: "0", inches: "0", eighths: "0" }))).toEqual({
      ok: false,
      message: "Enter the reading: feet, inches, or an eighth.",
      field: "measurement-feet",
    });
    expect(readMeasurement(draft({ feet: "000" }))).toMatchObject({ ok: false });
  });

  it("refuses a part that is not a whole number", () => {
    for (const feet of ["4.5", "-1", "42ft", "1e3", "0x10", "４２"]) {
      expect(readMeasurement(draft({ feet })), feet).toMatchObject({
        ok: false,
        field: "measurement-feet",
      });
    }
    for (const inches of ["x", "1.5", "-0"]) {
      expect(readMeasurement(draft({ feet: "1", inches })), inches).toMatchObject({
        ok: false,
        field: "measurement-inches",
      });
    }
    expect(readMeasurement(draft({ feet: "1", eighths: "half" }))).toMatchObject({
      ok: false,
      field: "measurement-eighths",
    });
  });

  it("cleans the place name the way the Worker keeps it", () => {
    expect(
      readMeasurement(draft({ areaLabel: "  north \t ridge\n cap ", feet: "3" })),
    ).toMatchObject({ ok: true, value: { area_label: "north ridge cap" } });
    // Compatibility forms fold first: full-width letters and a ligature become plain letters.
    expect(readMeasurement(draft({ areaLabel: "ｗｅｓｔ ﬂashing", feet: "3" }))).toMatchObject({
      ok: true,
      value: { area_label: "west flashing" },
    });
  });

  it("refuses a place name that is missing, too long once cleaned, or hides a character", () => {
    expect(readMeasurement(draft({ areaLabel: " \n ", feet: "3" }))).toEqual({
      ok: false,
      message: "Say where you measured, like south eave.",
      field: "measurement-area",
    });
    expect(
      readMeasurement(draft({ areaLabel: "a".repeat(MAX_AREA_LABEL), feet: "3" })),
    ).toMatchObject({ ok: true });
    expect(
      readMeasurement(draft({ areaLabel: "a".repeat(MAX_AREA_LABEL + 1), feet: "3" })),
    ).toMatchObject({ ok: false, field: "measurement-area" });
    // 120 characters as typed, 122 once the ligature unfolds: the Worker would refuse it.
    expect(
      readMeasurement(draft({ areaLabel: `${"a".repeat(MAX_AREA_LABEL - 1)}ﬃ`, feet: "3" })),
    ).toMatchObject({ ok: false, field: "measurement-area" });
    for (const hidden of ["south​eave", "\u0007eave", "eave‮"]) {
      expect(readMeasurement(draft({ areaLabel: hidden, feet: "3" })), hidden).toEqual({
        ok: false,
        message: "Retype where you measured. It has a hidden character in it.",
        field: "measurement-area",
      });
    }
  });
});
