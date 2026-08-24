import { z } from "zod";

const safeOperatorSearchHrefSchema = z
  .string()
  .min(1)
  .refine(
    (href) =>
      href.startsWith("/") &&
      !href.startsWith("//") &&
      !href.includes("\\") &&
      !href.includes("?") &&
      !href.includes("#"),
    "Search destinations must be same-origin paths.",
  );

export const operatorSearchResultSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    detail: z.string().nullable(),
    href: safeOperatorSearchHrefSchema,
    matched_field: z.string().min(1),
  })
  .strict();

export const operatorSearchGroupSchema = z
  .object({
    group: z.enum(["jobs", "leads", "customers", "go_to"]),
    label: z.string().min(1),
    limit: z.number().int().positive(),
    matched_fields: z.array(z.string()),
    results: z.array(operatorSearchResultSchema),
    more_results: z.boolean(),
  })
  .strict();

export const operatorSearchReadModelSchema = z
  .object({
    version: z.literal(1),
    source_updated_at: z.string().min(1).nullable(),
    read_model_generated_at: z.string().min(1),
    stale_fields: z.array(z.string()),
    permissions: z.array(z.string()),
    allowed_actions: z.array(z.string()),
    query: z.string(),
    query_class: z.enum(["email", "numeric", "text"]).nullable(),
    outcome: z.enum(["results", "no_matches", "query_too_short"]),
    groups: z.array(operatorSearchGroupSchema),
  })
  .strict();

export type OperatorSearchReadModel = z.infer<typeof operatorSearchReadModelSchema>;
export type OperatorSearchGroup = OperatorSearchReadModel["groups"][number];
export type OperatorSearchResult = OperatorSearchGroup["results"][number];
