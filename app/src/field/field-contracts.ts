import { z } from "zod";

const nullableText = z.string().nullable();
const workPackageSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(["Released", "Acknowledged", "In Progress"]),
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
  acknowledgement: z.object({
    current_user_acknowledged: z.boolean(),
    acknowledged_at: nullableText,
  }),
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
      release_authority: z.string().min(1),
      required_evidence: z.string().min(1),
      acceptance_criteria: z.string().min(1),
      released: z.boolean(),
    }),
  ),
});
const envelopeSchema = z.object({
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
});

export const proofStreamItemSchema = z.object({
  id: z.string().min(1),
  type: nullableText,
  proof_slot: nullableText,
  occurred_at: nullableText,
  summary: nullableText,
  customer_safe: z.boolean().nullable(),
  source: nullableText,
  sync_state: nullableText,
  blocker: z.boolean(),
});

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
    }),
  ),
});

export const jobResponseSchema = envelopeSchema.extend({
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
});

export const proofPageResponseSchema = envelopeSchema.extend({
  items: z.array(proofStreamItemSchema),
  next_cursor: nullableText,
});

export type TodayResponse = z.infer<typeof todayResponseSchema>;
export type JobResponse = z.infer<typeof jobResponseSchema>;
export type ProofStreamItem = z.infer<typeof proofStreamItemSchema>;
export type ProofPageResponse = z.infer<typeof proofPageResponseSchema>;
