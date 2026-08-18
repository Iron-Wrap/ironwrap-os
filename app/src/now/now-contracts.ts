import { z } from "zod";

import {
  quickBooksBlockerCodes,
  quickBooksIntentIdSchema,
  quickBooksIntentStates,
  quickBooksNextSteps,
  quickBooksRejectionReasons,
} from "../accounting/quickbooks-contracts";

const nonEmptyTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Text must not be empty.",
});

const staticNowHrefSchema = z.enum([
  "/owner",
  "/facet-designs",
  "/sales",
  "/production",
  "/approvals",
  "/today",
  "/accounting/quickbooks",
  "/settings",
]);

const jobNowHrefSchema = z.string().superRefine((href, context) => {
  if (!href.startsWith("/jobs/")) {
    context.addIssue({ code: "custom", message: "Now links must use an allowed app route." });
    return;
  }

  const encodedId = href.slice("/jobs/".length);
  try {
    const jobId = decodeURIComponent(encodedId);
    if (!jobId || jobId === "." || jobId === ".." || encodeURIComponent(jobId) !== encodedId) {
      throw new Error("non-canonical job id");
    }
  } catch {
    context.addIssue({ code: "custom", message: "Job links must contain one encoded job id." });
  }
});

const postizNowHrefSchema = z.string().superRefine((href, context) => {
  const prefix = "/marketing/postiz/";
  if (!href.startsWith(prefix)) {
    context.addIssue({ code: "custom", message: "Now links must use an allowed app route." });
    return;
  }

  const encodedId = href.slice(prefix.length);
  try {
    const intentId = decodeURIComponent(encodedId);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(intentId) ||
      encodeURIComponent(intentId) !== encodedId
    ) {
      throw new Error("non-canonical intent id");
    }
  } catch {
    context.addIssue({
      code: "custom",
      message: "Postiz links must contain one encoded intent id.",
    });
  }
});

const quickBooksFinalInvoiceHrefSchema = z.string().superRefine((href, context) => {
  const prefix = "/accounting/quickbooks/final-invoices/";
  if (!href.startsWith(prefix)) {
    context.addIssue({ code: "custom", message: "Now links must use an allowed app route." });
    return;
  }

  const encodedId = href.slice(prefix.length);
  try {
    const intentId = decodeURIComponent(encodedId);
    if (
      !quickBooksIntentIdSchema.safeParse(intentId).success ||
      encodeURIComponent(intentId) !== encodedId
    ) {
      throw new Error("non-canonical intent id");
    }
  } catch {
    context.addIssue({
      code: "custom",
      message: "QuickBooks links must contain one encoded final-invoice intent id.",
    });
  }
});

export const nowHrefSchema = z.union([
  staticNowHrefSchema,
  jobNowHrefSchema,
  postizNowHrefSchema,
  quickBooksFinalInvoiceHrefSchema,
]);

const actionFields = {
  id: nonEmptyTextSchema,
  label: nonEmptyTextSchema,
  reason: nonEmptyTextSchema,
  citation_ids: z.array(nonEmptyTextSchema),
};

const navigateActionSchema = z
  .object({
    ...actionFields,
    kind: z.literal("navigate"),
    href: nowHrefSchema,
  })
  .strict();

const refreshActionSchema = z
  .object({
    ...actionFields,
    kind: z.literal("refresh"),
    href: z.null(),
  })
  .strict();

export const nowActionSchema = z.discriminatedUnion("kind", [
  navigateActionSchema,
  refreshActionSchema,
]);

const nowCitationSchema = z
  .object({
    id: nonEmptyTextSchema,
    label: nonEmptyTextSchema,
    source: z.literal("owned_read_model"),
    href: nowHrefSchema,
  })
  .strict();

const nowCardSchema = z
  .object({
    id: nonEmptyTextSchema,
    tone: z.enum(["critical", "warning", "neutral", "positive"]),
    eyebrow: nonEmptyTextSchema,
    title: nonEmptyTextSchema,
    detail: nonEmptyTextSchema,
    action: nowActionSchema.nullable(),
    citations: z.array(nowCitationSchema),
  })
  .strict();

const quickBooksNowActionSchema = z
  .object({
    label: z.literal("Review final invoice"),
    href: quickBooksFinalInvoiceHrefSchema,
  })
  .strict();

const quickBooksNowCardSchema = z
  .object({
    kind: z.literal("quickbooks_final_invoice"),
    id: nonEmptyTextSchema,
    tone: z.enum(["attention", "blocked", "critical", "muted"]),
    eyebrow: z.literal("QuickBooks final invoice"),
    title: nonEmptyTextSchema,
    detail: nonEmptyTextSchema,
    job_id: z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/),
    currency: z.literal("CAD"),
    final_balance: z.string().regex(/^(?:0|[1-9]\d{0,8})\.\d{2}$/),
    invoice_state: z.enum(quickBooksIntentStates),
    blocker_code: z.enum(quickBooksBlockerCodes).nullable(),
    rejection_reason: z.enum(quickBooksRejectionReasons).nullable(),
    next_step: z.enum(quickBooksNextSteps),
    action: quickBooksNowActionSchema,
    citations: z.array(nowCitationSchema).max(2),
  })
  .strict()
  .superRefine((card, context) => {
    let decodedIntentId: string;
    try {
      const intentId = card.action.href.slice("/accounting/quickbooks/final-invoices/".length);
      decodedIntentId = decodeURIComponent(intentId);
    } catch {
      return;
    }
    if (
      card.id !== `qbo-final-invoice:${decodedIntentId}` ||
      card.title !== `Final invoice ${card.invoice_state.replaceAll("_", " ")}` ||
      card.detail !== `${card.currency} ${card.final_balance}` ||
      card.citations.some((citation) => citation.href !== card.action.href)
    ) {
      context.addIssue({
        code: "custom",
        message: "QuickBooks Now card is not bound to its exact final-invoice intent.",
      });
    }
  });

const trustedNowCardSchema = z.union([nowCardSchema, quickBooksNowCardSchema]);

const nowSectionSchema = z
  .object({
    id: nonEmptyTextSchema,
    title: nonEmptyTextSchema,
    summary: nonEmptyTextSchema,
    cards: z.array(trustedNowCardSchema),
  })
  .strict();

const nowSourceSchema = z
  .object({
    id: z.enum(["owner", "postiz", "facet", "sales", "production", "quickbooks_final_invoices"]),
    state: z.enum(["current", "limited", "unavailable"]),
    read_model_generated_at: nonEmptyTextSchema.nullable(),
    stale_fields: z.array(nonEmptyTextSchema),
  })
  .strict();

export const nowResponseSchema = z
  .object({
    version: z.literal(1),
    role: z.enum(["owner", "ops", "sales", "production", "accounting"]),
    read_model_generated_at: nonEmptyTextSchema,
    permissions: z.array(nonEmptyTextSchema),
    allowed_actions: z.array(nonEmptyTextSchema),
    sources: z.array(nowSourceSchema),
    ui: z
      .object({
        schema_version: z.literal(1),
        state: z.enum(["ready", "empty", "limited"]),
        title: nonEmptyTextSchema,
        explanation: nonEmptyTextSchema,
        sync_label: nonEmptyTextSchema,
        primary_action: nowActionSchema.nullable(),
        sections: z.array(nowSectionSchema),
      })
      .strict(),
  })
  .strict()
  .superRefine((payload, context) => {
    const citationIds = new Set(
      payload.ui.sections.flatMap((section) =>
        section.cards.flatMap((card) => card.citations.map((citation) => citation.id)),
      ),
    );
    const actions = [
      payload.ui.primary_action,
      ...payload.ui.sections.flatMap((section) =>
        section.cards.flatMap((card) => ("kind" in card ? [] : [card.action])),
      ),
    ].filter((action) => action !== null);

    for (const action of actions) {
      for (const citationId of action.citation_ids) {
        if (!citationIds.has(citationId)) {
          context.addIssue({
            code: "custom",
            message: `Action citation ${citationId} is not present in this bounded read.`,
            path: ["ui"],
          });
        }
      }
    }
  });

export type NowAction = z.infer<typeof nowActionSchema>;
export type NowCard = z.infer<typeof trustedNowCardSchema>;
export type QuickBooksNowCard = z.infer<typeof quickBooksNowCardSchema>;
export type NowResponse = z.infer<typeof nowResponseSchema>;
