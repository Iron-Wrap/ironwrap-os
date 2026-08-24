import { z } from "zod";

export const capabilityIds = [
  "email_delivery",
  "magic_link",
  "facet_association",
  "quickbooks",
  "measurement_ocr",
  "supplier_rail",
  "communications_rail",
  "cloudflare_worker",
  "pwa",
  "d1",
  "r2",
  "queues",
  "backup_restore",
  "observability",
  "newo",
  "postiz",
  "public_estimator",
] as const;

export const readinessProfileKeys = [
  "core",
  "commercial_closure",
  "field_closure",
  "accounting_closure",
  "reference_journey",
] as const;

const timestamp = z.string().min(20).max(64);
const blocker = z.string().min(1).max(300);

const manifestSchema = z
  .object({
    id: z.string().min(1).max(200),
    version: z.number().int().positive(),
    provider: z.string().min(1).max(120),
    realm: z.string().min(1).max(240),
    direction: z.enum(["inbound", "outbound", "bidirectional", "internal"]),
    owner_user_id: z.string().min(1).max(200),
    source_repository: z.string().min(1).max(240),
    source_commit: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

const capabilitySchema = z
  .object({
    id: z.enum(capabilityIds),
    required: z.boolean(),
    state: z.enum(["ready", "blocked"]),
    last_proof_at: timestamp.nullable(),
    proof_expires_at: timestamp.nullable(),
    fallback: z.string().min(1).max(1200).nullable(),
    blockers: z.array(blocker).max(50),
    manifest: manifestSchema.nullable(),
  })
  .strict();

export const integrationReadinessResponseSchema = z
  .object({
    version: z.literal(1),
    tenant_id: z.string().min(2).max(64),
    read_model_generated_at: timestamp,
    allowed_actions: z.tuple([z.literal("integrations.readiness.read")]),
    configuration_mutations_available: z.literal(false),
    profile: z
      .object({
        key: z.enum(readinessProfileKeys),
        version: z.number().int().positive().nullable(),
        state: z.enum(["ready", "blocked"]),
        blockers: z.array(blocker).max(50),
        dependencies: z
          .array(
            z
              .object({
                key: z.enum(["core", "commercial_closure", "field_closure", "accounting_closure"]),
                minimum_version: z.number().int().positive(),
                state: z.enum(["ready", "blocked"]),
              })
              .strict(),
          )
          .max(12),
      })
      .strict(),
    capabilities: z.array(capabilitySchema).max(capabilityIds.length),
    verdict: z.enum(["ready", "blocked"]),
  })
  .strict();

export type IntegrationReadinessResponse = z.infer<typeof integrationReadinessResponseSchema>;
export type IntegrationCapability = z.infer<typeof capabilitySchema>;
