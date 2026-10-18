import { z } from "zod";

/**
 * The crew read of `GET /api/v1/field-item-resolutions` (`workers-bus/src/field-item-resolutions.ts`):
 * an office person's answer for an item this phone holds as unconfirmed. Strict on purpose: a
 * shape the phone does not recognise is ignored, and the item keeps today's guidance.
 */
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const fieldItemResolutionKinds = [
  "field_checkin",
  "work_package_acknowledgement",
  "work_package_stop",
  "inventory_command",
  "inventory_scan",
  "safety_action",
  "fleet_pre_trip_inspection",
  "fleet_post_trip_inspection",
  "fleet_defect_report",
  "schema_field_value",
] as const;

export const fieldItemResolutionSchema = z
  .object({
    resolution_id: z.string().regex(/^fir_[0-9a-f]{64}$/),
    device_action_id: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
    item_kind: z.enum(fieldItemResolutionKinds),
    payload_sha256: sha256.nullable(),
    resolution: z.enum(["arrived", "not_arrived", "duplicate"]),
    linked_record: z
      .object({
        type: z.string().min(1).max(80),
        id: z.string().regex(/^[A-Za-z0-9._:-]{1,220}$/),
      })
      .strict()
      .nullable(),
    resolved_at: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Nothing is stored for an item that did not arrive; an item that arrived names its record.
    const notArrived = value.resolution === "not_arrived";
    if (
      notArrived !== (value.payload_sha256 === null) ||
      notArrived !== (value.linked_record === null)
    )
      ctx.addIssue({ code: "custom", path: ["resolution"], message: "Inconsistent answer" });
  });

export const fieldItemResolutionsResponseSchema = z
  .object({
    version: z.literal(1),
    resolutions: z.array(fieldItemResolutionSchema).max(100),
  })
  .strict();

export type FieldItemResolution = z.infer<typeof fieldItemResolutionSchema>;
