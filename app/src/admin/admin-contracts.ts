import { z } from "zod";

import { appRoles } from "../lib/roles";

export function companyProfileQueryKey(tenantId: string) {
  return ["company-profile", tenantId] as const;
}

export function appUsersQueryKey(tenantId: string) {
  return ["app-users", tenantId] as const;
}

export function setupProgressQueryKey(tenantId: string) {
  return ["setup-progress", tenantId] as const;
}

export const companyBrandLabelSchema = z.object({
  display_name: z.string(),
  short_name: z.string(),
  service_area: z.string(),
});

export const companyLogoSchema = z.object({
  content_type: z.string().min(1),
  byte_size: z.number(),
  version: z.string().min(1),
  updated_at: z.string(),
});

export const companyProfileSchema = z.object({
  tenant_id: z.string().min(1),
  profile_version: z.number().int().nonnegative(),
  is_default: z.boolean(),
  company_name: z.string(),
  brand_name: z.string(),
  service_area: z.string(),
  phone: z.string(),
  email: z.string(),
  website: z.string(),
  address_line1: z.string(),
  address_line2: z.string(),
  city: z.string(),
  region: z.string(),
  postal_code: z.string(),
  country: z.string(),
  brand_labels: z.record(z.string(), companyBrandLabelSchema),
  time_zone: z.string(),
  currency: z.string(),
  week_start: z.enum(["sunday", "monday", "saturday"]),
  logo_ref: z.string().nullable(),
  logo: companyLogoSchema.nullable(),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_user_id: z.string().nullable(),
});

export const publicBrandSchema = companyBrandLabelSchema.extend({ id: z.string().min(1) });

export const companyProfileResponseSchema = z.object({
  version: z.literal(1),
  read_model_generated_at: z.string(),
  allowed_actions: z.array(z.string()),
  profile: companyProfileSchema,
  defaults: companyProfileSchema,
  missing_fields: z.array(z.string()),
  week_starts: z.array(z.enum(["sunday", "monday", "saturday"])),
  logo_url: z.string().nullable(),
  logo_limits: z.object({
    max_bytes: z.number(),
    content_types: z.array(z.string()),
  }),
  public_brands: z.array(publicBrandSchema),
  // What the customer portal shows from the saved contact, computed by the Worker with the same
  // rule as the portal. Absent from older Workers; null when customers see neither.
  public_contact_preview: z
    .object({ phone: z.string().nullable(), email: z.string().nullable() })
    .nullable()
    .optional(),
});

const setupStepStatusSchema = z.enum(["done", "in_progress", "skipped", "later"]);
const setupStepSchema = z.object({
  id: z.enum(["company", "people", "crew_phones", "money_and_intake", "notifications"]),
  title: z.string(),
  status: setupStepStatusSchema,
  detail: z.string(),
  requirements: z.array(
    z.object({
      id: z.string(),
      met: z.boolean(),
      applicable: z.boolean(),
      detail: z.string(),
    }),
  ),
});

export const setupProgressResponseSchema = z.object({
  version: z.literal(1),
  read_model_generated_at: z.string(),
  allowed_actions: z.array(z.string()),
  progress: z.object({
    generated_at: z.string(),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    percent_complete: z.number().min(0).max(100),
    steps: z.array(setupStepSchema),
  }),
});

export const appUserSchema = z.object({
  user_id: z.string().min(1),
  email: z.string().min(1),
  display_name: z.string().min(1),
  role: z.enum(appRoles),
  active: z.boolean(),
  /** Every role or access change names the version it was decided on. */
  access_version: z.number().int().min(1),
  updated_at: z.string(),
  is_self: z.boolean(),
});

export const appUserListResponseSchema = z.object({
  version: z.literal(1),
  users: z.array(appUserSchema),
});

export const appUserMutationResponseSchema = z.object({
  user: z.object({
    user_id: z.string().min(1),
    email: z.string().min(1),
    display_name: z.string().min(1),
    role: z.enum(appRoles),
    active: z.boolean(),
    /** The version this change produced; the next change to this person names it. */
    access_version: z.number().int().min(1),
  }),
});

const accessStateSchema = z.object({ role: z.enum(appRoles), active: z.boolean() });

/**
 * What a 409 `access_version_conflict` says moved since the refused change was decided: who made
 * the newest change (and whether it was the viewer, on another tab or device), the access before
 * and now, and the version to decide on next. The Worker sends no device: it cannot name one.
 */
export const accessConflictSchema = z.object({
  user_id: z.string().min(1),
  access_version: z.number().int().min(1),
  changed_at: z.string().nullable(),
  changed_by: z
    .object({
      user_id: z.string().min(1),
      display_name: z.string().nullable(),
      is_self_actor: z.boolean(),
    })
    .nullable(),
  change: z.object({ before: accessStateSchema.nullable(), after: accessStateSchema }),
});

export type CompanyProfile = z.infer<typeof companyProfileSchema>;
export type CompanyProfileResponse = z.infer<typeof companyProfileResponseSchema>;
export type PublicBrand = z.infer<typeof publicBrandSchema>;
export type SetupProgressResponse = z.infer<typeof setupProgressResponseSchema>;
export type SetupStep = z.infer<typeof setupStepSchema>;
export type AppUser = z.infer<typeof appUserSchema>;
export type AppUserListResponse = z.infer<typeof appUserListResponseSchema>;
export type AccessState = z.infer<typeof accessStateSchema>;
export type AccessConflict = z.infer<typeof accessConflictSchema>;

/** The exact body `PUT /api/v1/admin/company-profile` accepts; extra keys are rejected server-side. */
export interface CompanyProfileInput {
  company_name: string;
  brand_name: string;
  service_area: string;
  phone: string;
  email: string;
  website: string;
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  brand_labels: Record<string, z.infer<typeof companyBrandLabelSchema>>;
  time_zone: string;
  currency: string;
  week_start: "sunday" | "monday" | "saturday";
}

export function companyProfileInput(profile: CompanyProfile): CompanyProfileInput {
  return {
    company_name: profile.company_name,
    brand_name: profile.brand_name,
    service_area: profile.service_area,
    phone: profile.phone,
    email: profile.email,
    website: profile.website,
    address_line1: profile.address_line1,
    address_line2: profile.address_line2,
    city: profile.city,
    region: profile.region,
    postal_code: profile.postal_code,
    country: profile.country,
    brand_labels: profile.brand_labels,
    time_zone: profile.time_zone,
    currency: profile.currency,
    week_start: profile.week_start,
  };
}

/**
 * Server error codes, said the way the person reading them can act on. Anything unrecognised keeps
 * the server's own message rather than being flattened into "something went wrong".
 */
export const ADMIN_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_company_name: "Enter the company name.",
  invalid_brand_name: "Enter the short name customers see.",
  invalid_email: "Enter a valid email address.",
  invalid_website: "Enter the website as a full address, starting with https://.",
  invalid_phone: "Enter a valid phone number.",
  unsupported_logo_type: "Use a PNG, JPG, WEBP, or SVG file.",
  logo_too_large: "That file is too large. Use a logo under 512 KB.",
  logo_content_mismatch:
    "That file did not open as the image type it claims to be. Try exporting it again.",
  invalid_logo_data: "That file could not be read. Try another one.",
  office_role_required: "Only an owner or operations account can change this.",
  csrf_failed: "Your session moved on. Reload the page and try again.",
  contact_required: "Enter an email address or a phone number so someone can reach them.",
  invalid_name: "Enter the customer's full name.",
  invalid_role: "Choose a role for this person.",
  invalid_tenant: "That account belongs to a different company.",
  sales_lead_create_required: "Your role cannot add leads.",
};
