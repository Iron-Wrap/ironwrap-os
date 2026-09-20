import { z } from "zod";

/**
 * The read contract for `GET /api/v1/jobs/:jobId/customer-history`
 * (`workers-bus/src/customer-job-history.ts`).
 *
 * Summaries of this customer's other jobs, including the finished ones every other job read in the
 * product stops short of. `openable` is the server's statement about the job route, not a guess
 * this client makes from the status text — so a row either links somewhere that works or does not
 * offer a link at all.
 */

export function customerJobHistoryPath(jobId: string): string {
  return `/api/v1/jobs/${encodeURIComponent(jobId)}/customer-history`;
}

export function customerJobHistoryQueryKey(
  tenantId: string,
  userId: string,
  jobId: string,
): readonly [string, string, string, string] {
  return ["customer-job-history", tenantId, userId, jobId] as const;
}

export const customerJobHistoryPropertySchema = z
  .object({
    property_id: z.string().min(1),
    address_line1: z.string().nullable(),
    city: z.string().nullable(),
    province: z.string().nullable(),
    postal_code: z.string().nullable(),
    structure_type: z.string().nullable(),
  })
  .passthrough();

export const customerJobHistoryEntrySchema = z
  .object({
    roof_job_id: z.string().min(1),
    job_number: z.string().nullable(),
    service_type: z.string().nullable(),
    job_status: z.string().nullable(),
    brand: z.string().nullable(),
    property: customerJobHistoryPropertySchema.nullable(),
    is_anchor: z.boolean(),
    openable: z.boolean(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
  })
  .passthrough();

export const customerJobHistoryResponseSchema = z
  .object({
    customer: z
      .object({
        customer_id: z.string().min(1),
        display_name: z.string().nullable(),
        lifecycle_status: z.string().nullable(),
      })
      .passthrough(),
    anchor_job_id: z.string().min(1),
    entries: z.array(customerJobHistoryEntrySchema),
    truncated: z.boolean(),
    generated_at: z.string().min(1),
  })
  .passthrough();

export type CustomerJobHistoryEntry = z.infer<typeof customerJobHistoryEntrySchema>;
export type CustomerJobHistoryResponse = z.infer<typeof customerJobHistoryResponseSchema>;

/** The address as one line, skipping the parts this property does not carry. */
export function propertyAddressLabel(property: CustomerJobHistoryEntry["property"]): string | null {
  if (!property) return null;
  const parts = [property.address_line1, property.city, property.province, property.postal_code]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}
