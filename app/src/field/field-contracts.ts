import { z } from "zod";

import { MAX_AREA_LABEL, MAX_FIELD_MEASUREMENT_FEET } from "./field-measurement-input";

const nullableText = z.string().nullable();
// Construct packet validators on first parse so Today bootstrap only initializes its own
// contract. Parsing remains synchronous, including cached packets and nested work packages.
const workPackageSchema = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    status: z.enum(["Released", "Acknowledged", "In Progress", "Blocked"]),
    title: z.string().min(1),
    objective: z.string().min(1),
    boundaries: z.string().min(1),
    prerequisites: z.string().min(1),
    expected_result: z.string().min(1),
    stop_conditions: z.string().min(1),
    make_safe_procedure: z.string().min(1),
    issued_at: z.string().min(1),
    expires_at: z.string().min(1),
    released_at: z.string().min(1),
    work_object_type: z.string().min(1).default("Roof Job"),
    work_object_id: z.string().min(1).default("unknown"),
    physical_context_type: z.string().min(1).default("Roof Site"),
    physical_context_id: z.string().min(1).default("unknown"),
    release_attempt_id: nullableText,
    supersession: z
      .object({
        prior_id: z.string().min(1),
        reason: z.string().min(1),
        changed_steps: z.array(z.number().int().positive()),
        changed_hold_points: z.array(z.number().int().positive()),
      })
      .nullable(),
    acknowledgement: z.object({
      current_user_acknowledged: z.boolean(),
      acknowledged_at: nullableText,
      workers: z
        .array(
          z.object({
            worker_user: z.string().min(1),
            worker_role: z.string().min(1),
            required: z.boolean(),
            acknowledged: z.boolean(),
            acknowledged_at: nullableText,
          }),
        )
        .optional()
        .default([]),
    }),
    evidence_slots: z
      .array(
        z.object({
          event_id: z.string().min(1),
          evidence_item: z.string().min(1),
          slot_id: z.string().min(1),
          requirement: z.string().min(1),
          source: z.string().min(1),
          actor_user: z.string().min(1),
          device_id: z.string().min(1),
          captured_at: z.string().min(1),
          freshness: z.enum(["Current", "Stale", "Unknown"]),
          conflict_state: z.enum(["None", "Detected", "Resolved"]),
          correction_of: nullableText,
          evidence_item_correction_of: nullableText,
          review_reason: nullableText,
          verification: z.enum(["Pending", "Verified", "Rejected"]),
          disposition: z.enum(["Open", "Accepted", "Needs Correction", "Superseded"]),
          correction_reason: nullableText,
          superseded: z.boolean(),
        }),
      )
      .optional()
      .default([]),
    steps: z.array(
      z.object({
        sequence: z.number().int().positive(),
        instruction: z.string().min(1),
        required_evidence: z.string().min(1),
        acceptance_criteria: z.string().min(1),
      }),
    ),
    hold_points: z.array(
      z.object({
        sequence: z.number().int().positive(),
        hold_point: z.string().min(1),
        release_phase: z.enum(["Pre-start", "In-process", "Completion"]).default("Pre-start"),
        release_authority: z.string().min(1),
        required_evidence: z.string().min(1),
        acceptance_criteria: z.string().min(1),
        released: z.boolean(),
      }),
    ),
  }),
);

/**
 * One crew reading the Worker verified and filed with its receipt: an observation for office
 * review, never approved geometry, takeoff or price. A correction is a new reading that names the
 * one it replaces (`correction_of`); the replaced one carries `superseded_by`. The limits are the
 * Worker's own (`workers-bus/src/field-measurements.ts`), and the stored total must equal its parts.
 */
const fieldMeasurementCaptureShape = () =>
  z.object({
    checkin_id: z.string().min(1),
    device_action_id: z.string().min(1),
    assignment_id: z.string().min(1),
    measurement: z
      .object({
        feet: z.number().int().min(0).max(MAX_FIELD_MEASUREMENT_FEET),
        inches: z.number().int().min(0).max(11),
        eighths: z.number().int().min(0).max(7),
        area_label: z.string().min(1).max(MAX_AREA_LABEL),
        total_eighth_inches: z.number().int().min(1),
      })
      .refine(
        (value) => value.total_eighth_inches === value.feet * 96 + value.inches * 8 + value.eighths,
      ),
    captured_at: z.string().min(1),
    recorded_by: z.string().min(1),
    /** Optional while an older Worker is in use; null when the user record is gone. */
    recorded_by_name: nullableText.optional(),
    device_id: z.string().min(1),
    correction_of: nullableText,
    correction_reason: nullableText,
    superseded_by: nullableText,
    work_package_id: nullableText,
    work_package_version: z.number().int().nullable(),
    evidence_slot_id: nullableText,
    evidence_item_correction_of: nullableText,
    work_package_release_attempt_id: nullableText,
    /** `field.measurement.correct` only for the paired crew member's own current reading. */
    allowed_actions: z.array(z.string()).optional(),
    /** What a fix of this reading must name: the reading itself, or its proof event and item. */
    correction_target: z
      .union([
        z.object({ correction_of: z.string().min(1) }),
        z.object({
          evidence_correction_of: z.string().min(1),
          evidence_item_correction_of: z.string().min(1),
        }),
      ])
      .nullable()
      .optional(),
  });

export const fieldMeasurementCaptureSchema = z.lazy(fieldMeasurementCaptureShape);

/**
 * Crew readings are a side list on the job, the work plan and its history. A list that does not
 * parse is dropped and marked the way the Worker marks a failed native read, so it never hides
 * the job or plan it rides on. An older Worker sends none: an empty list, nothing marked.
 */
export function keepValidFieldMeasurements<
  T extends {
    field_measurements?: unknown;
    field_measurements_more?: unknown;
    stale_fields: string[];
  },
>(
  read: T,
): Omit<T, "field_measurements" | "field_measurements_more"> & {
  field_measurements?: FieldMeasurementCapture[];
  field_measurements_more?: boolean;
} {
  const items = z
    .array(fieldMeasurementCaptureSchema)
    .optional()
    .safeParse(read.field_measurements);
  const more = z.boolean().optional().safeParse(read.field_measurements_more);
  if (items.success && more.success) {
    return {
      ...read,
      field_measurements: items.data ?? [],
      field_measurements_more: more.data ?? false,
    };
  }
  return {
    ...read,
    field_measurements: [],
    field_measurements_more: false,
    stale_fields: [...new Set([...read.stale_fields, "field_measurements.native_unavailable"])],
  };
}

/**
 * The company contact the owner saved, as the crew job and work-object reads carry it. The same
 * rules as the customer portal's `company_contact` (`portal/portal-contracts.ts`): a dialable
 * E.164 number and the Worker's own email acceptance rule. Optional while an older Worker is
 * still in use; `null` when the owner saved none. Built on first use, like the packet validators.
 */
const officeContactShape = () =>
  z
    .object({
      phone: z
        .string()
        .regex(/^\+[1-9]\d{6,14}$/)
        .nullable(),
      email: z
        .string()
        .regex(/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i)
        .nullable(),
    })
    .strict()
    .nullable();

export const officeContactSchema = z.lazy(officeContactShape);

/** The last office contact this phone read, kept so screens with no contact of their own can call. */
export const savedOfficeContactSchema = z.lazy(() =>
  z.object({ contact: officeContactShape(), synced_at: z.string().min(1) }),
);

/** A live read this phone could not keep, so it will not open without signal. */
export const NOT_SAVED_ON_DEVICE = "offline.not_saved";

/**
 * The office contact is optional to the crew. A malformed one is dropped and marked unavailable,
 * the way the Worker marks a failed profile read, so it never hides a valid job or work plan or
 * sends the phone back to an older packet. Safety and work-package fields stay strict.
 */
function keepValidOfficeContact<T extends { office_contact?: unknown; stale_fields: string[] }>(
  read: T,
): Omit<T, "office_contact"> & { office_contact?: OfficeContact } {
  const contact = officeContactSchema.optional().safeParse(read.office_contact);
  if (contact.success) return { ...read, office_contact: contact.data };
  return {
    ...read,
    office_contact: undefined,
    stale_fields: [...new Set([...read.stale_fields, "office_contact.unavailable"])],
  };
}

export const envelopeSchema = z.object({
  version: z.literal(1),
  source_updated_at: nullableText,
  read_model_generated_at: z.string().min(1),
  stale_fields: z.array(z.string()),
  permissions: z.array(z.string()),
  allowed_actions: z.array(z.string()),
});

export const assignmentSchema = z.object({
  id: z.string().min(1),
  assignment_id: nullableText,
  type: nullableText,
  status: nullableText,
  crew_profile: nullableText,
  scheduled_start: nullableText,
  scheduled_end: nullableText,
  blocker_reason: nullableText,
  modified: nullableText.optional(),
});

export const proofStreamItemSchema = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: nullableText,
    proof_slot: nullableText,
    occurred_at: nullableText,
    summary: nullableText,
    customer_safe: z.boolean().nullable(),
    source: nullableText,
    sync_state: nullableText,
    blocker: z.boolean(),
  }),
);

/**
 * A work stop that holds a job (Track C's read shape): "job" when it is on this job or one of its
 * plans, "tenant" when its job wasn't found, so it holds every job. An unknown scope reads as
 * "job", so a stop is never dropped.
 */
export const activeStopSchema = z.object({
  occurrence_id: z.string(),
  scope: z.enum(["job", "tenant"]).catch("job"),
  reported_at: z.string(),
  summary: z.string().nullable(),
  raiser_display_name: z.string().nullable(),
});

export type ActiveStop = z.infer<typeof activeStopSchema>;

/**
 * A run sheet's stops, read one by one: an entry the app cannot read still shows as a stop on this
 * job (its id kept when it has one), never dropped and never failing the whole run sheet.
 */
function readableStop(value: unknown, index: number): unknown {
  if (activeStopSchema.safeParse(value).success) return value;
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    occurrence_id:
      typeof raw.occurrence_id === "string" ? raw.occurrence_id : `unreadable_${String(index)}`,
    scope: raw.scope === "tenant" ? "tenant" : "job",
    reported_at: typeof raw.reported_at === "string" ? raw.reported_at : "",
    summary: typeof raw.summary === "string" ? raw.summary : null,
    raiser_display_name:
      typeof raw.raiser_display_name === "string" ? raw.raiser_display_name : null,
  };
}

const activeStopsSchema = z.preprocess(
  (value) => (Array.isArray(value) ? value.map(readableStop) : []),
  z.array(activeStopSchema),
);

export const todayResponseSchema = envelopeSchema.extend({
  date: z.string().min(1),
  jobs: z.array(
    z.object({
      id: z.string().min(1),
      job_number: nullableText,
      brand: nullableText,
      status: nullableText,
      address: nullableText,
      scheduled_start: nullableText,
      scheduled_end: nullableText,
      blocked_gate_count: z.number().int().nonnegative(),
      next_action: z.string().min(1),
      assignment: assignmentSchema.nullable(),
      // Absent on run sheets from before the Worker carried it; empty when no stop holds the job.
      active_stops: activeStopsSchema,
    }),
  ),
  work_objects: z
    .array(
      z.object({
        work_object_type: z.string().min(1),
        work_object_id: z.string().min(1),
        physical_context_type: z.string().min(1),
        physical_context_id: z.string().min(1),
        scheduled_start: nullableText,
        scheduled_end: nullableText,
        next_action: z.string().min(1),
        assignment: assignmentSchema.nullable(),
      }),
    )
    .default([]),
});

export const workObjectResponseSchema = z.lazy(() =>
  envelopeSchema
    .extend({
      work_object: z.object({
        workObjectType: z.string().min(1),
        workObjectId: z.string().min(1),
        physicalContextType: z.string().min(1),
        physicalContextId: z.string().min(1),
      }),
      assignment: assignmentSchema.nullable(),
      work_package: workPackageSchema.nullish().transform((value) => value ?? null),
      field_measurements: z.unknown().optional(),
      field_measurements_more: z.unknown().optional(),
      office_contact: z.unknown().optional(),
    })
    .transform(keepValidOfficeContact)
    .transform(keepValidFieldMeasurements),
);

export const jobResponseSchema = z.lazy(() =>
  envelopeSchema
    .extend({
      field_measurements: z.unknown().optional(),
      field_measurements_more: z.unknown().optional(),
      office_contact: z.unknown().optional(),
      job: z.object({
        id: z.string().min(1),
        roof_job_id: nullableText,
        job_number: nullableText,
        brand: nullableText,
        service_type: nullableText,
        status: nullableText,
        address: nullableText,
        current_gate_state: nullableText,
      }),
      assignment: assignmentSchema.nullable(),
      gates: z.array(
        z.object({
          id: z.string().min(1),
          name: nullableText,
          state: nullableText,
          blocker_reason: nullableText,
          owner: nullableText,
          due_at: nullableText,
        }),
      ),
      packet: z.object({
        scope_clauses: z.array(
          z.object({
            id: z.string().min(1),
            type: nullableText,
            title: nullableText,
            text: nullableText,
            version: nullableText,
          }),
        ),
        measurements: z.array(
          z.object({
            id: z.string().min(1),
            provider: nullableText,
            review_status: nullableText,
            parsed_at: nullableText,
          }),
        ),
        materials: z.object({
          takeoffs: z.array(
            z.object({ id: z.string().min(1), status: nullableText, prepared_at: nullableText }),
          ),
          supplier_orders: z.array(
            z.object({
              id: z.string().min(1),
              status: nullableText,
              requested_delivery_date: nullableText,
              delivery_notes: nullableText,
            }),
          ),
        }),
        change_orders: z.array(
          z.object({
            id: z.string().min(1),
            number: nullableText,
            version: z.number().nullable(),
            status: nullableText,
            title: nullableText,
            scope_delta: nullableText,
          }),
        ),
        safety_plan: z
          .object({
            id: z.string().min(1),
            version: z.number().nullable(),
            status: nullableText,
            effective_date: nullableText,
            hazard_summary: nullableText,
            controls: nullableText,
            emergency_plan: nullableText,
            ppe_requirements: nullableText,
            weather_limits: nullableText,
          })
          .nullable(),
        contact: z
          .object({
            display_name: nullableText,
            phone: nullableText,
            access_instructions: nullableText,
          })
          .nullable(),
        // Older packets remain readable from IndexedDB after an app upgrade. A missing
        // package is never treated as a release or permission to start work.
        work_package: workPackageSchema.nullish().transform((value) => value ?? null),
      }),
      proof_stream: z.array(proofStreamItemSchema),
      proof_page: z.object({ next_cursor: nullableText, page_size: z.number().int().positive() }),
      required_proof: z.array(
        z.object({
          id: z.string().min(1),
          slot: z.string().min(1),
          label: z.string().min(1),
          state: z.string().min(1),
          blocker_reason: nullableText,
        }),
      ),
    })
    .transform(keepValidOfficeContact)
    .transform(keepValidFieldMeasurements),
);

export const proofPageResponseSchema = z.lazy(() =>
  envelopeSchema.extend({
    items: z.array(proofStreamItemSchema),
    next_cursor: nullableText,
  }),
);

/** One page of a job's crew readings, newest first, from the read-only history route. */
export const fieldMeasurementPageSchema = z.lazy(() =>
  envelopeSchema.extend({
    items: z.array(fieldMeasurementCaptureShape()),
    page_size: z.number().int().positive(),
    next_cursor: nullableText,
  }),
);

export type TodayResponse = z.infer<typeof todayResponseSchema>;
export type WorkObjectResponse = z.infer<typeof workObjectResponseSchema>;
export type JobResponse = z.infer<typeof jobResponseSchema>;
export type ProofStreamItem = z.infer<typeof proofStreamItemSchema>;
export type ProofPageResponse = z.infer<typeof proofPageResponseSchema>;
export type FieldMeasurementCapture = z.infer<typeof fieldMeasurementCaptureSchema>;
export type FieldMeasurementPage = z.infer<typeof fieldMeasurementPageSchema>;
export type OfficeContact = z.infer<typeof officeContactSchema>;
export type SavedOfficeContact = z.infer<typeof savedOfficeContactSchema>;
