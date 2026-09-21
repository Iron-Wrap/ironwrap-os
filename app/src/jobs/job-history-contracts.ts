import { z } from "zod";

import { envelopeSchema, proofStreamItemSchema } from "../field/field-contracts";

/**
 * The read contract for `GET /api/v1/jobs/:jobId/history` (`buildJobHistoryReadModel`).
 *
 * A job has two readings. `GET /api/v1/jobs/:jobId` is the work plan, and it refuses anything that
 * is not live, because the work package, the assignment and the actions stop existing when the work
 * does. This is the other one: what happened. It authorizes nothing — `allowed_actions` comes back
 * empty by construction — and nothing rendered from it may be a control.
 */

export function jobHistoryPath(jobId: string, cursor?: string | null): string {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return `/api/v1/jobs/${encodeURIComponent(jobId)}/history${query}`;
}

export function jobHistoryQueryKey(
  tenantId: string,
  userId: string,
  jobId: string,
): readonly [string, string, string, string] {
  return ["job-history", tenantId, userId, jobId] as const;
}

export const jobHistoryResponseSchema = envelopeSchema.extend({
  job: z
    .object({
      id: z.string().min(1),
      roof_job_id: z.string().nullable(),
      job_number: z.string().nullable(),
      brand: z.string().nullable(),
      service_type: z.string().nullable(),
      status: z.string().nullable(),
      address: z.string().nullable(),
      current_gate_state: z.string().nullable(),
    })
    .passthrough(),
  customer: z
    .object({ display_name: z.string().nullable(), phone: z.string().nullable() })
    .passthrough()
    .nullable(),
  gates: z.array(
    z
      .object({
        id: z.string().min(1),
        name: z.string().nullable(),
        state: z.string().nullable(),
        blocker_reason: z.string().nullable(),
        owner: z.string().nullable(),
        due_at: z.string().nullable(),
      })
      .passthrough(),
  ),
  proof: z.object({
    items: z.array(proofStreamItemSchema),
    next_cursor: z.string().nullable(),
  }),
  openable: z.boolean(),
  /** The evidence read could not run. An empty stream then means "unknown", not "nothing done". */
  proof_unavailable: z.boolean(),
});

export type JobHistoryResponse = z.infer<typeof jobHistoryResponseSchema>;
