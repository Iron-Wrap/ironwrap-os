import { z } from "zod";

export const PUBLIC_ESTIMATE_DISCLAIMER =
  "This request does not produce an online price. An estimator must verify measurements, access, materials, and approved pricing before any quote, scope, schedule, material, or payment commitment.";

export const PUBLIC_ESTIMATE_SERVICES = [
  { id: "roofing", label: "Roof replacement" },
  { id: "metal_roofing", label: "Metal roofing" },
  { id: "siding", label: "Siding or cladding" },
  { id: "gutters", label: "Gutters" },
  { id: "soffit_fascia", label: "Soffit or fascia" },
] as const;

export const PUBLIC_ESTIMATE_BRANDS = {
  ironwrap: {
    displayName: "IronWrap Exteriors",
    shortName: "IronWrap",
    serviceArea: "Alberta roofing & exteriors",
  },
  iroof: {
    displayName: "iRoof Alberta",
    shortName: "iRoof",
    serviceArea: "Alberta roofing & exteriors",
  },
} as const;

export const publicEstimateBrandSchema = z.enum(["ironwrap", "iroof"]);

export const PUBLIC_ESTIMATE_DEFAULT_PROVINCE = "AB";

export const PUBLIC_ESTIMATE_PROVINCES = [
  { id: "AB", label: "Alberta" },
  { id: "BC", label: "British Columbia" },
  { id: "MB", label: "Manitoba" },
  { id: "NB", label: "New Brunswick" },
  { id: "NL", label: "Newfoundland and Labrador" },
  { id: "NS", label: "Nova Scotia" },
  { id: "NT", label: "Northwest Territories" },
  { id: "NU", label: "Nunavut" },
  { id: "ON", label: "Ontario" },
  { id: "PE", label: "Prince Edward Island" },
  { id: "QC", label: "Quebec" },
  { id: "SK", label: "Saskatchewan" },
  { id: "YT", label: "Yukon" },
] as const;

const publicEstimateProvinceCodes = PUBLIC_ESTIMATE_PROVINCES.map(({ id }) => id) as [
  (typeof PUBLIC_ESTIMATE_PROVINCES)[number]["id"],
  ...(typeof PUBLIC_ESTIMATE_PROVINCES)[number]["id"][],
];

export const publicEstimateServiceSchema = z.enum([
  "roofing",
  "metal_roofing",
  "siding",
  "gutters",
  "soffit_fascia",
]);

export const publicEstimateProvinceSchema = z.enum(publicEstimateProvinceCodes);

const optionalEmailSchema = z
  .string()
  .trim()
  .refine(
    (value) => value === "" || z.string().email().safeParse(value).success,
    "Enter a valid email address.",
  );

const optionalPhoneSchema = z
  .string()
  .trim()
  .refine(
    (value) => value === "" || /^\+?[\d()\s.-]{7,32}$/.test(value),
    "Enter a valid phone number.",
  );

export const publicEstimateFormSchema = z
  .object({
    name: z.string().trim().min(2, "Enter your full name.").max(100, "Name is too long."),
    email: optionalEmailSchema,
    phone: optionalPhoneSchema,
    address: z
      .string()
      .trim()
      .min(6, "Enter the project address.")
      .max(200, "Address is too long."),
    province: publicEstimateProvinceSchema,
    service: publicEstimateServiceSchema,
    contactConsent: z
      .boolean()
      .refine((value) => value, "Please confirm that we may contact you about this request."),
    privacyConsent: z
      .boolean()
      .refine(
        (value) => value,
        "Please confirm that we may use these details to review your request.",
      ),
  })
  .superRefine((values, context) => {
    if (values.email || values.phone) return;
    context.addIssue({
      code: "custom",
      path: ["email"],
      message: "Enter an email address or phone number so an estimator can reach you.",
    });
  });

export const publicEstimateConfigSchema = z.object({
  enabled: z.boolean(),
  turnstile_site_key: z.string().trim().min(1).nullable(),
  range_available: z.literal(false),
  disclaimer: z.string().trim().min(1),
  review_required: z.literal(true),
});

export const publicInstantEstimateRequestSchema = z.object({
  brand: publicEstimateBrandSchema,
  service: publicEstimateServiceSchema,
  contact: z.object({
    name: z.string().trim().min(2).max(100),
    email: optionalEmailSchema.optional(),
    phone: optionalPhoneSchema.optional(),
  }),
  property: z.object({
    address: z.string().trim().min(6).max(200),
    province: publicEstimateProvinceSchema,
  }),
  consent: z.object({
    contact: z.literal(true),
    privacy: z.literal(true),
  }),
  turnstile_token: z.string(),
  client_submission_id: z.string().regex(/^[a-z0-9][a-z0-9-]{15,127}$/i),
});

export const publicInstantEstimateResponseSchema = z.object({
  accepted: z.literal(true),
  envelope_id: z.string().min(1).optional(),
  range: z.null(),
  disclaimer: z.string().trim().min(1),
  review_required: z.literal(true),
  idempotent_replay: z.boolean().optional(),
});

export type PublicEstimateConfig = z.infer<typeof publicEstimateConfigSchema>;
export type PublicEstimateBrand = z.infer<typeof publicEstimateBrandSchema>;
export type PublicEstimateFormValues = z.infer<typeof publicEstimateFormSchema>;
export type PublicEstimateProvince = z.infer<typeof publicEstimateProvinceSchema>;
export type PublicInstantEstimateRequest = z.infer<typeof publicInstantEstimateRequestSchema>;
export type PublicInstantEstimateResponse = z.infer<typeof publicInstantEstimateResponseSchema>;

export function publicEstimateRequest(
  values: PublicEstimateFormValues,
  turnstileToken: string,
  clientSubmissionId: string,
  brand: PublicEstimateBrand = "ironwrap",
): PublicInstantEstimateRequest {
  return publicInstantEstimateRequestSchema.parse({
    brand,
    service: values.service,
    contact: {
      name: values.name,
      email: values.email || undefined,
      phone: values.phone || undefined,
    },
    property: { address: values.address, province: values.province },
    consent: { contact: true, privacy: true },
    turnstile_token: turnstileToken,
    client_submission_id: clientSubmissionId,
  });
}

/** Only a fixed marketing embed link may select a tenant brand; unknown values fall back safely. */
export function publicEstimateBrandFromSearch(search: string): PublicEstimateBrand {
  const candidate = new URLSearchParams(search).get("brand");
  return publicEstimateBrandSchema.safeParse(candidate).success
    ? publicEstimateBrandSchema.parse(candidate)
    : "ironwrap";
}
