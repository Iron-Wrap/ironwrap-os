import { z } from "zod";

const frappeNameSchema = z.string().regex(/^[A-Za-z0-9._:-]{3,140}$/);
const portalLinkIdSchema = z
  .string()
  .regex(/^portal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const isoTimestampSchema = z.string().datetime({ offset: true });

export const customerPortalLinkSchema = z
  .object({
    id: portalLinkIdSchema,
    roof_job_id: frappeNameSchema,
    created_at: isoTimestampSchema,
    expires_at: isoTimestampSchema,
    revoked_at: isoTimestampSchema.nullable(),
    last_accessed_at: isoTimestampSchema.nullable(),
    access_count: z.number().int().nonnegative(),
  })
  .strict();

export const customerPortalLinksResponseSchema = z
  .object({ links: z.array(customerPortalLinkSchema) })
  .strict();

export const customerPortalIssueInputSchema = z
  .object({
    roofJobId: frappeNameSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();

export const customerPortalIssueResponseSchema = z
  .object({
    link: customerPortalLinkSchema,
    portal_url: z.string().url().max(4_096),
  })
  .strict();

export const customerPortalRevokeResponseSchema = z
  .object({
    ok: z.literal(true),
    link_id: portalLinkIdSchema,
    revoked_at: isoTimestampSchema,
  })
  .strict();

export type CustomerPortalLink = z.infer<typeof customerPortalLinkSchema>;
export type CustomerPortalIssueInput = z.infer<typeof customerPortalIssueInputSchema>;
export type CustomerPortalLinksResponse = z.infer<typeof customerPortalLinksResponseSchema>;
export type CustomerPortalIssueResponse = z.infer<typeof customerPortalIssueResponseSchema>;
