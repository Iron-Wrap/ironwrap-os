import { z } from "zod";

/**
 * Contracts for the driver's own vehicle surface (IRO-54 / ELEC-87).
 *
 * The capture envelope is fixed by `workers-bus/src/fleet-actions.ts` and
 * re-asserted by the offline outbox, so nothing here re-invents it. What lives
 * here is what only a phone needs: the checklist a walk-around follows, and
 * the driver-facing English for a policy code that would otherwise reach a
 * roadside as `overdue_fleet_inspection`.
 */

const nullableText = z.string().nullable();

export const fleetPanelBlockerSchema = z.object({
  code: z.string().min(1),
  field: nullableText,
  message: z.string().min(1),
});

export const fleetPanelAssetSchema = z.object({
  id: z.string().min(1),
  fleet_asset_id: z.string().min(1),
  display_name: z.string().min(1),
  unit_number: nullableText,
  asset_kind: z.string().min(1),
  status: z.string().min(1),
  licence_plate: nullableText,
  meter_kind: nullableText,
  current_meter: z.number().nullable(),
  relationship: z.enum(["custody", "driver"]),
  last_inspection_at: nullableText,
  next_inspection_due: nullableText,
  last_pre_trip_at: nullableText,
  last_post_trip_at: nullableText,
  out_of_service_reason: nullableText,
  open_out_of_service_defects: z.number().int().nonnegative(),
  blockers: z.array(fleetPanelBlockerSchema),
});

export const fleetPanelResponseSchema = z.object({
  version: z.number(),
  source_updated_at: nullableText,
  read_model_generated_at: z.string().min(1),
  stale_fields: z.array(z.string()),
  permissions: z.array(z.string()),
  allowed_actions: z.array(z.string()),
  reference_date: nullableText,
  assets: z.array(fleetPanelAssetSchema),
});

export type FleetPanelBlocker = z.infer<typeof fleetPanelBlockerSchema>;
export type FleetPanelAsset = z.infer<typeof fleetPanelAssetSchema>;
export type FleetPanelResponse = z.infer<typeof fleetPanelResponseSchema>;

export const fleetInspectionKinds = ["pre_trip", "post_trip"] as const;
export type FleetInspectionKind = (typeof fleetInspectionKinds)[number];

export const fleetItemResults = ["Pass", "Fail", "Not Applicable"] as const;
export type FleetItemResult = (typeof fleetItemResults)[number];

export const fleetDefectSeverities = ["Minor", "Major", "Out of Service"] as const;
export type FleetDefectSeverity = (typeof fleetDefectSeverities)[number];

export const fleetItemResultLabels: Record<FleetItemResult, string> = {
  Pass: "OK",
  Fail: "Fault",
  "Not Applicable": "N/A",
};

export const fleetDefectSeverityLabels: Record<FleetDefectSeverity, string> = {
  Minor: "Minor — note it for the shop",
  Major: "Major — needs repair soon",
  "Out of Service": "Out of service — park it now",
};

/**
 * The walk-around, per asset kind.
 *
 * The domain has no inspection-template DocType: `record_asset_inspection`
 * accepts free-text check points and only fences their shape. Until a template
 * record exists, the list a driver actually walks lives here, where it is
 * versioned with the screen that renders it. Kept short on purpose — a
 * fifty-line checklist on a phone gets pencil-whipped, which is worse than a
 * ten-line one that gets read.
 *
 * Pre-trip and post-trip share a list: the driver walks the same walk, and the
 * capture's `inspection_type` is what makes the two different records.
 */
export const fleetCheckPoints: Record<string, readonly string[]> = {
  Vehicle: [
    "Brakes and air system",
    "Steering",
    "Tires and wheels",
    "Lights and reflectors",
    "Mirrors and glass",
    "Coupling and hitch",
    "Load security",
    "Fluid leaks",
    "Emergency equipment",
    "Horn, wipers and heater",
  ],
  Trailer: [
    "Tires and wheels",
    "Brakes and air lines",
    "Lights and reflectors",
    "Coupling and safety chains",
    "Frame and body",
    "Load security",
  ],
  Equipment: [
    "Guards and safety devices",
    "Controls and stop switch",
    "Fluid leaks",
    "Fluid and fuel levels",
    "Structure and mounts",
  ],
  Tool: ["Housing and guards", "Cord, hose or battery", "Controls and switch", "Blades or bits"],
};

const FALLBACK_CHECK_POINTS = [
  "Condition and damage",
  "Guards and safety devices",
  "Controls and switch",
] as const;

export function checkPointsForAsset(assetKind: string): readonly string[] {
  return fleetCheckPoints[assetKind] ?? FALLBACK_CHECK_POINTS;
}

/**
 * The release fence, said out loud.
 *
 * Frappe's `PolicyViolation` message is written for an operator reading a
 * Desk error; a driver standing beside a truck needs to know what is wrong and
 * who fixes it. The codes are the fence's own, so a new fence shows its raw
 * message rather than a wrong reassurance.
 */
export const fleetBlockerText: Record<string, string> = {
  unsafe_fleet_asset:
    "This one is not in service. Only the shop and the office can put it back on the road.",
  unverified_fleet_asset: "The office cannot confirm this record. Ask them to check it.",
  telematics_cannot_authorize_asset:
    "Its record is set to accept tracker data instead of a real inspection. Someone has to inspect it in person and the office has to switch it back.",
  overdue_fleet_inspection:
    "Its inspection is out of date. Record a pre-trip that passes and it comes current again.",
  overdue_fleet_maintenance:
    "Its service is overdue. The shop has to book it in before it goes out.",
  overdue_fleet_calibration:
    "Its calibration is overdue. The shop has to recalibrate it before it goes out.",
  expired_fleet_registration: "Its registration has expired. The office has to renew it.",
  expired_fleet_insurance: "Its insurance has expired. The office has to renew it.",
  open_out_of_service_defect:
    "An out-of-service defect is still open on it. It stays parked until the repair is signed off.",
  unverified_driver_authority:
    "Your driver record could not be found. The office has to set it up before you drive this.",
  inactive_driver_authority:
    "Your driver record is not active. The office has to reinstate it before you drive this.",
  telematics_cannot_authorize_driver:
    "Your driver record is set to accept tracker data instead of your licence. The office has to fix it.",
  expired_driver_licence: "Your licence has expired. It has to be renewed before you drive this.",
  expired_driver_medical: "Your medical has expired. It has to be renewed before you drive this.",
  unlicensed_fleet_driver: "You do not hold the licence class this one needs.",
};

export function fleetBlockerMessage(blocker: FleetPanelBlocker): string {
  return fleetBlockerText[blocker.code] ?? blocker.message;
}

/**
 * The same job for a refused capture. A driver who has just finished a
 * walk-around must not be handed `field_upload_rate_limited`.
 */
export const fleetRefusalText: Record<string, string> = {
  not_found:
    "This one is not yours to report on right now. Custody or your load may have changed — check with dispatch.",
  fleet_asset_not_found:
    "This one is not yours to report on right now. Custody or your load may have changed — check with dispatch.",
  fleet_asset_retired: "This one has been retired. Nothing more can be recorded against it.",
  fleet_actor_not_enabled:
    "Your account is not active for fleet work. Ask the office to enable it.",
  field_role_required: "Only a field account can record this.",
  csrf_failed: "This device needs to sign in again before it can send work.",
  field_upload_rate_limited:
    "Too many uploads are starting at once. Your work is saved on this device and goes up on its own.",
  action_in_progress: "This one is still being sent. Give it a moment.",
  idempotency_conflict:
    "This capture is already recorded with different details. Keep it saved and ask the office to look at both.",
  fleet_capture_replay_conflict:
    "This capture is already recorded with different details. Keep it saved and ask the office to look at both.",
  invalid_fleet_action:
    "This capture was not accepted as recorded. Start it again and check every entry.",
  fleet_invalid_input:
    "This capture was not accepted as recorded. Start it again and check every entry.",
  fleet_payload_too_large: "This capture is too long. Shorten the notes and send it again.",
  fleet_photo_missing: "The photo is not stored yet. Take it again when you have signal.",
  fleet_photo_mismatch: "The stored photo does not match this capture. Take it again.",
  unsupported_fleet_photo_type: "That photo type is not accepted. Use a JPEG, PNG, or HEIC.",
  invalid_fleet_collision: "The collision report was not accepted. Check every entry.",
  invalid_fleet_collision_transition: "This collision cannot move to that state.",
  fleet_collision_physical_reporter_required:
    "A person has to report the collision. Tracker data is not enough.",
  telematics_cannot_authorize_collision:
    "Tracker data cannot authorize a collision. A person has to report it.",
};

export function fleetRefusalMessage(code: string | undefined, fallback: string): string {
  return (code && fleetRefusalText[code]) ?? fallback;
}

export function isFleetOutboxKind(kind: string): boolean {
  return (
    kind === "fleet_pre_trip_inspection" ||
    kind === "fleet_post_trip_inspection" ||
    kind === "fleet_defect_report"
  );
}

export const fleetInspectionEndpoint = (fleetAssetId: string, kind: FleetInspectionKind): string =>
  `/api/v1/fleet/assets/${encodeURIComponent(fleetAssetId)}/${
    kind === "pre_trip" ? "pre-trip" : "post-trip"
  }-inspections`;

export const fleetDefectEndpoint = (fleetAssetId: string): string =>
  `/api/v1/fleet/assets/${encodeURIComponent(fleetAssetId)}/defects`;

export const fleetPhotoUploadEndpoint = (fleetAssetId: string): string =>
  `/api/v1/fleet/assets/${encodeURIComponent(fleetAssetId)}/photo-evidence`;

export const fleetCollisionEndpoint = (fleetAssetId: string): string =>
  `/api/v1/fleet/assets/${encodeURIComponent(fleetAssetId)}/collisions`;

export const fleetPhotoEvidenceSchema = z
  .object({
    attachment_id: z.string().min(8).max(80),
    file_name: z.string().min(1).max(180),
    content_type: z.enum(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    r2_key: z.string().min(16).max(240),
  })
  .strict();

export const fleetPhotoUploadResponseSchema = z
  .object({
    photo_evidence: fleetPhotoEvidenceSchema,
  })
  .strict();

export const fleetCollisionSchema = z
  .object({
    collision_id: z.string().regex(/^fc_[A-Za-z0-9._:-]{8,60}$/),
    kind: z.literal("vehicle_collision"),
    state: z.enum(["reported", "investigating", "repairing", "closed", "cancelled"]),
    severity: z.enum(fleetDefectSeverities),
    description: z.string().min(3),
    telematics_reference: z.string().nullable(),
  })
  .passthrough();

export const fleetCollisionResponseSchema = z
  .object({
    collision: fleetCollisionSchema,
  })
  .strict();

export const fleetVerifiedActionSchema = z
  .object({
    device_action_id: z.string().min(8),
    status: z.literal("verified"),
    server_ref: z.string().min(1),
    cursor: z.string().min(1),
  })
  .strict();

export type FleetPhotoEvidenceRef = z.infer<typeof fleetPhotoEvidenceSchema>;
export type FleetCollisionRecord = z.infer<typeof fleetCollisionSchema>;

export function newFleetCollisionId(): string {
  return `fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
