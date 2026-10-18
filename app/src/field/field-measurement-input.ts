/** What the crew types for one tape reading, before it is checked. */
export type MeasurementDraft = { areaLabel: string; feet: string; inches: string; eighths: string };

export const EMPTY_MEASUREMENT: MeasurementDraft = {
  areaLabel: "",
  feet: "",
  inches: "0",
  eighths: "0",
};

/**
 * The Worker's limits (`workers-bus/src/field-measurements.ts`), so a reading it would refuse is
 * caught on the phone with a plain reason instead of after the crew has left.
 */
export const MAX_FIELD_MEASUREMENT_FEET = 100_000;
export const MAX_AREA_LABEL = 120;

type MeasurementField =
  "measurement-area" | "measurement-feet" | "measurement-inches" | "measurement-eighths";

/**
 * The reading the Worker accepts, or the one plain thing to fix. Whole feet, 0–11 inches and
 * 0–7 eighths, never all zero, and a place name. The name is cleaned the way the Worker cleans it
 * (compatibility forms folded, spaces collapsed) and refused if a hidden character is left, so
 * the name sent is the name the Worker keeps.
 */
export function readMeasurement(
  draft: MeasurementDraft,
):
  | { ok: true; value: { feet: number; inches: number; eighths: number; area_label: string } }
  | { ok: false; message: string; field: MeasurementField } {
  const areaLabel = draft.areaLabel.normalize("NFKC").trim().replace(/\s+/gu, " ");
  const area = "measurement-area" as const;
  if (!areaLabel)
    return { ok: false, message: "Say where you measured, like south eave.", field: area };
  if (areaLabel.length > MAX_AREA_LABEL)
    return {
      ok: false,
      message: `Keep where you measured under ${MAX_AREA_LABEL} letters.`,
      field: area,
    };
  if (/[\p{Cc}\p{Cf}]/u.test(areaLabel))
    return {
      ok: false,
      message: "Retype where you measured. It has a hidden character in it.",
      field: area,
    };
  const feet = wholeNumber(draft.feet, MAX_FIELD_MEASUREMENT_FEET);
  if (feet === null)
    return {
      ok: false,
      message: "Feet must be a whole number, like 42.",
      field: "measurement-feet",
    };
  const inches = wholeNumber(draft.inches, 11);
  if (inches === null)
    return {
      ok: false,
      message: "Inches must be a whole number from 0 to 11.",
      field: "measurement-inches",
    };
  const eighths = wholeNumber(draft.eighths, 7);
  if (eighths === null)
    return {
      ok: false,
      message: "Eighths must be a whole number from 0 to 7.",
      field: "measurement-eighths",
    };
  if (feet === 0 && inches === 0 && eighths === 0)
    return {
      ok: false,
      message: "Enter the reading: feet, inches, or an eighth.",
      field: "measurement-feet",
    };
  return { ok: true, value: { feet, inches, eighths, area_label: areaLabel } };
}

/** A blank entry counts as 0; anything else must be digits no larger than `max`. */
function wholeNumber(text: string, max: number): number | null {
  const value = text.trim() || "0";
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number <= max ? number : null;
}
