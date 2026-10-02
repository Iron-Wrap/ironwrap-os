import { z } from "zod";

import { API_PATHS } from "../lib/api-paths";
import { publicRequest } from "./public-estimate-request";

// The shell needs this read without constructing the estimate form and submission schemas.
/**
 * A brand is whatever the Worker says it accepts, named by whatever the owner set in the company
 * profile. It used to be a two-value enum hard-coded here (`ironwrap`, `iroof`), which meant every
 * other tenant's customers were rejected with `400 invalid_request` on a page headed with someone
 * else's brand name (ELEC-158 B2).
 */
export const publicEstimateBrandSchema = z.string().trim().min(1).max(80);

// Built on first parse: every shell imports this read, but nothing parses it before first paint.
export const publicEstimateBrandDescriptorSchema = z.lazy(() =>
  z.object({
    id: publicEstimateBrandSchema,
    display_name: z.string().min(1),
    short_name: z.string().min(1),
    service_area: z.string(),
  }),
);

export const publicEstimateConfigSchema = z.lazy(() =>
  z.object({
    enabled: z.boolean(),
    turnstile_site_key: z.string().trim().min(1).nullable(),
    range_available: z.literal(false),
    disclaimer: z.string().trim().min(1),
    review_required: z.literal(true),
    brands: z.array(publicEstimateBrandDescriptorSchema),
    default_brand: publicEstimateBrandSchema.nullable(),
    logo_url: z.string().min(1).nullable(),
  }),
);

export type PublicEstimateConfig = z.infer<typeof publicEstimateConfigSchema>;
export type PublicEstimateBrand = z.infer<typeof publicEstimateBrandSchema>;
export type PublicEstimateBrandDescriptor = z.infer<typeof publicEstimateBrandDescriptorSchema>;

/**
 * The config request no longer names a brand: the server states which brands it accepts, and the
 * page picks from that list. Asking for a brand before knowing the list is what let the frontend
 * send one the Worker would reject (ELEC-158 B2).
 */
export async function loadPublicEstimateConfig(
  fetcher: typeof fetch = fetch,
): Promise<PublicEstimateConfig> {
  return publicRequest(API_PATHS.publicInstantEstimateConfig, publicEstimateConfigSchema, {
    fetcher,
  });
}
