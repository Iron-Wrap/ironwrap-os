import type { AppEnv, WorkObjectScope } from "./app-types.ts";

export const MAX_FIELD_MEASUREMENT_FEET = 100_000;
export const MAX_FIELD_MEASUREMENT_AREA_LABEL = 120;
export const FIELD_MEASUREMENT_READ_LIMIT = 100;

export interface FieldMeasurementCursor {
  createdAt: string;
  deviceActionId: string;
}

/** A bounded keyset cursor; it never grants access to the job or tenant in the request. */
export function parseFieldMeasurementCursor(
  value: string | null,
): FieldMeasurementCursor | null | undefined {
  if (value === null) return null;
  if (value.length < 4 || value.length > 300 || !/^[A-Za-z0-9_-]+$/.test(value))
    return undefined;
  try {
    const decoded: unknown = JSON.parse(
      atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (!Array.isArray(decoded) || decoded.length !== 2) return undefined;
    const [createdAt, deviceActionId] = decoded;
    if (
      typeof createdAt !== "string" ||
      typeof deviceActionId !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
      !Number.isFinite(Date.parse(createdAt)) ||
      new Date(createdAt).toISOString() !== createdAt ||
      !/^[A-Za-z0-9._:-]{8,80}$/.test(deviceActionId)
    )
      return undefined;
    return { createdAt, deviceActionId };
  } catch {
    return undefined;
  }
}

function fieldMeasurementCursor(row: MeasurementRow): string {
  return btoa(JSON.stringify([row.created_at, row.device_action_id]))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** A crew observation, never an accepted geometry or takeoff revision. */
export interface FieldMeasurementInput {
  feet: number;
  inches: number;
  eighths: number;
  area_label: string;
}

export interface FieldMeasurementValue extends FieldMeasurementInput {
  total_eighth_inches: number;
}

export interface FieldMeasurementCapture {
  checkin_id: string;
  device_action_id: string;
  assignment_id: string;
  measurement: FieldMeasurementValue;
  captured_at: string;
  recorded_by: string;
  recorded_by_name: string | null;
  device_id: string;
  correction_of: string | null;
  correction_reason: string | null;
  superseded_by: string | null;
  work_package_id: string | null;
  work_package_version: number | null;
  evidence_slot_id: string | null;
  evidence_item_correction_of: string | null;
  work_package_release_attempt_id: string | null;
}

export function parseFieldMeasurement(value: unknown): FieldMeasurementInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_field_measurement");
  const v = value as Record<string, unknown>;
  const keys = ["feet", "inches", "eighths", "area_label"];
  if (
    Object.keys(v).length !== keys.length ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw new Error("invalid_field_measurement");
  const integer = (n: unknown, max: number): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;
  if (
    !integer(v.feet, MAX_FIELD_MEASUREMENT_FEET) ||
    !integer(v.inches, 11) ||
    !integer(v.eighths, 7)
  )
    throw new Error("invalid_field_measurement");
  if (typeof v.area_label !== "string" || v.area_label.length > 512)
    throw new Error("invalid_field_measurement");
  const areaLabel = v.area_label.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    !areaLabel ||
    areaLabel.length > MAX_FIELD_MEASUREMENT_AREA_LABEL ||
    /[\p{Cc}\p{Cf}]/u.test(areaLabel)
  )
    throw new Error("invalid_field_measurement");
  const measurement = {
    feet: v.feet,
    inches: v.inches,
    eighths: v.eighths,
    area_label: areaLabel,
  };
  if (fieldMeasurementValue(measurement).total_eighth_inches === 0)
    throw new Error("invalid_field_measurement");
  return measurement;
}

export function fieldMeasurementValue(
  input: FieldMeasurementInput,
): FieldMeasurementValue {
  return {
    ...input,
    total_eighth_inches: input.feet * 96 + input.inches * 8 + input.eighths,
  };
}

interface MeasurementRow {
  created_at: string;
  checkin_id: string;
  device_action_id: string;
  assignment_id: string;
  measurement_area_label: string;
  measurement_feet: number;
  measurement_inches: number;
  measurement_eighths: number;
  measurement_total_eighth_inches: number;
  capture_completed_at: string;
  user_id: string;
  recorded_by_name: string | null;
  measurement_device_id: string;
  measurement_correction_of: string | null;
  correction_reason: string | null;
  superseded_by: string | null;
  work_package_id: string | null;
  work_package_version: number | null;
  evidence_slot_id: string | null;
  evidence_item_correction_of: string | null;
  work_package_release_attempt_id: string | null;
}

/** Only verified, manifested captures appear; legacy notes are never parsed or backfilled. */
export async function listFieldMeasurementsFromD1(
  env: AppEnv,
  input: {
    tenantId: string;
    jobId: string;
    scope?: WorkObjectScope;
    cursor?: FieldMeasurementCursor | null;
  },
): Promise<{
  items: FieldMeasurementCapture[];
  more: boolean;
  nextCursor: string | null;
} | null> {
  const scope = input.scope;
  const args: unknown[] = [input.tenantId, input.jobId];
  if (scope)
    args.push(
      scope.workObjectType,
      scope.workObjectId,
      scope.physicalContextType,
      scope.physicalContextId,
    );
  if (input.cursor)
    args.push(
      input.cursor.createdAt,
      input.cursor.createdAt,
      input.cursor.deviceActionId,
    );
  args.push(FIELD_MEASUREMENT_READ_LIMIT + 1);
  let rows: MeasurementRow[];
  try {
    const result = await env.DB.prepare(
      `SELECT a.created_at, a.checkin_id, a.device_action_id, a.assignment_id, a.measurement_area_label,
          a.measurement_feet, a.measurement_inches, a.measurement_eighths,
          a.measurement_total_eighth_inches, a.capture_completed_at, a.user_id,
          u.display_name AS recorded_by_name,
          a.measurement_device_id, a.measurement_correction_of, a.correction_reason,
          a.work_package_id, a.work_package_version, a.evidence_slot_id,
          a.evidence_item_correction_of, a.work_package_release_attempt_id,
          (SELECT s.checkin_id FROM field_actions s
            WHERE s.tenant_id = a.tenant_id AND s.measurement_correction_of = a.checkin_id
              AND s.status = 'verified' AND s.manifest_key IS NOT NULL) AS superseded_by
         FROM field_actions a
         LEFT JOIN app_users u ON u.user_id = a.user_id AND u.tenant_id = a.tenant_id
        WHERE a.tenant_id = ? AND a.job_id = ? AND a.measurement_area_label IS NOT NULL
          AND a.status = 'verified' AND a.manifest_key IS NOT NULL
          ${scope ? "AND a.work_object_type = ? AND a.work_object_id = ? AND a.physical_context_type = ? AND a.physical_context_id = ?" : ""}
          ${input.cursor ? "AND (a.created_at < ? OR (a.created_at = ? AND a.device_action_id < ?))" : ""}
        ORDER BY a.created_at DESC, a.device_action_id DESC LIMIT ?`,
    )
      .bind(...args)
      .all<MeasurementRow>();
    rows = result.results ?? [];
  } catch (error) {
    if (
      error instanceof Error &&
      /(?:no such (?:column|table)|unknown column)/i.test(error.message)
    )
      return null;
    throw error;
  }
  const page = rows.slice(0, FIELD_MEASUREMENT_READ_LIMIT);
  const more = rows.length > FIELD_MEASUREMENT_READ_LIMIT;
  return {
    items: page.map((row) => {
      const measurement = fieldMeasurementValue(
        parseFieldMeasurement({
          feet: row.measurement_feet,
          inches: row.measurement_inches,
          eighths: row.measurement_eighths,
          area_label: row.measurement_area_label,
        }),
      );
      if (
        measurement.total_eighth_inches !== row.measurement_total_eighth_inches
      )
        throw new Error("field_measurement_storage_mismatch");
      return {
        checkin_id: row.checkin_id,
        device_action_id: row.device_action_id,
        assignment_id: row.assignment_id,
        measurement,
        captured_at: row.capture_completed_at,
        recorded_by: row.user_id,
        recorded_by_name: row.recorded_by_name,
        device_id: row.measurement_device_id,
        correction_of: row.measurement_correction_of,
        correction_reason: row.correction_reason,
        superseded_by: row.superseded_by,
        work_package_id: row.work_package_id,
        work_package_version: row.work_package_version,
        evidence_slot_id: row.evidence_slot_id,
        evidence_item_correction_of: row.evidence_item_correction_of,
        work_package_release_attempt_id: row.work_package_release_attempt_id,
      };
    }),
    more,
    nextCursor: more ? fieldMeasurementCursor(page[page.length - 1]) : null,
  };
}
