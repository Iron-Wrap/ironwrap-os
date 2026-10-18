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

/** The one title the Worker gives every final-invoice card (`now-read-model.ts` quickBooksCard). */
const QUICKBOOKS_FINAL_INVOICE_TITLE = "Final invoice needs a check";

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
      card.title !== QUICKBOOKS_FINAL_INVOICE_TITLE ||
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

export const decisionKindSchema = z.enum([
  "lead_triage",
  "quote_revision",
  "proposal_publication",
  "production_schedule",
  "postiz",
  "quickbooks_final_invoice",
]);

const approvalDecisionStateSchema = z.enum([
  "pending",
  "executing",
  "failed",
  "audit_failed",
  "execution_uncertain",
]);

const decisionItemFields = {
  key: nonEmptyTextSchema,
  id: z.string().trim().min(1).max(180),
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(4_000),
  job_id: z.string().trim().min(1).max(160).nullable(),
  updated_at: nonEmptyTextSchema,
  expires_at: nonEmptyTextSchema.nullable(),
  review_href: nonEmptyTextSchema,
};

export const decisionItemSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...decisionItemFields,
        id: z.string().regex(/^approval:[A-Za-z0-9_-]{16,64}$/),
        kind: z.literal("lead_triage"),
        native_state: approvalDecisionStateSchema,
      })
      .strict(),
    z
      .object({
        ...decisionItemFields,
        id: z.string().regex(/^quote-revision-approval:[A-Za-z0-9_-]{16,64}$/),
        kind: z.literal("quote_revision"),
        native_state: approvalDecisionStateSchema,
      })
      .strict(),
    z
      .object({
        ...decisionItemFields,
        id: z.string().regex(/^proposal-publication-approval:[A-Za-z0-9_-]{16,64}$/),
        kind: z.literal("proposal_publication"),
        native_state: approvalDecisionStateSchema,
      })
      .strict(),
    z
      .object({
        ...decisionItemFields,
        id: z
          .string()
          .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        kind: z.literal("postiz"),
        native_state: z.enum([
          "connection_required",
          "pending_review",
          "submission_pending",
          "submitted",
          "reconciliation_required",
          "stop_submitted",
          "stop_reconciliation_required",
        ]),
      })
      .strict(),
    z
      .object({
        ...decisionItemFields,
        id: quickBooksIntentIdSchema,
        kind: z.literal("quickbooks_final_invoice"),
        native_state: z.enum([
          "connection_required",
          "blocked",
          "pending_review",
          "submission_pending",
          "submitted",
          "failed",
          "reconciliation_required",
        ]),
      })
      .strict(),
  ])
  .superRefine((item, context) => {
    const encodedId = encodeURIComponent(item.id);
    const href =
      item.kind === "lead_triage"
        ? `/approvals?review=${encodedId}`
        : item.kind === "quote_revision"
          ? `/quote-revision-approvals/${encodedId}`
          : item.kind === "proposal_publication"
            ? `/estimator/jobs/${encodeURIComponent(item.job_id ?? "")}`
            : item.kind === "postiz"
              ? `/marketing/postiz/${encodedId}`
              : `/accounting/quickbooks/final-invoices/${encodedId}`;
    if (
      item.key !== `${item.kind}:${item.id}` ||
      item.review_href !== href ||
      item.job_id === "." ||
      item.job_id === ".." ||
      (["quote_revision", "proposal_publication", "quickbooks_final_invoice"].includes(item.kind) &&
        !item.job_id)
    ) {
      context.addIssue({
        code: "custom",
        message: "Decision identity and review route must agree.",
      });
    }
  });

const decisionSourceSchema = z
  .object({
    kind: decisionKindSchema,
    state: z.enum(["current", "limited", "unavailable", "retired"]),
    loaded_count: z.number().int().min(0).max(25),
    has_more: z.boolean().nullable(),
    next_cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,1024}$/)
      .nullable(),
    read_model_generated_at: nonEmptyTextSchema.nullable(),
  })
  .strict();

export const decisionsReadModelSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["ready", "empty", "limited"]),
    sources: z.array(decisionSourceSchema).max(6),
    items: z.array(decisionItemSchema).max(125),
  })
  .strict()
  .superRefine((model, context) => {
    const kinds = new Set(model.sources.map((source) => source.kind));
    const keys = new Set(model.items.map((item) => item.key));
    if (
      kinds.size !== model.sources.length ||
      keys.size !== model.items.length ||
      model.items.some((item) => !kinds.has(item.kind))
    ) {
      context.addIssue({
        code: "custom",
        message: "Decision rows and sources must be unique and bound.",
      });
    }
    for (const source of model.sources) {
      const count = model.items.filter((item) => item.kind === source.kind).length;
      const readable = source.state === "current" || source.state === "limited";
      if (
        source.loaded_count !== count ||
        (source.has_more === true) !== (source.next_cursor !== null) ||
        (source.kind === "production_schedule") !== (source.state === "retired") ||
        (readable
          ? source.read_model_generated_at === null ||
            source.has_more !== (source.state === "limited")
          : count !== 0 || source.has_more !== null || source.read_model_generated_at !== null)
      ) {
        context.addIssue({
          code: "custom",
          message: "Decision source coverage must describe the loaded rows.",
        });
      }
    }
    const state = model.sources.some(
      (source) => source.state === "limited" || source.state === "unavailable",
    )
      ? "limited"
      : model.items.length > 0
        ? "ready"
        : "empty";
    if (state !== model.state) {
      context.addIssue({
        code: "custom",
        message: "Missing decisions cannot be reported as an empty or complete inbox.",
      });
    }
  });

export type DecisionKind = z.infer<typeof decisionKindSchema>;
export type DecisionItem = z.infer<typeof decisionItemSchema>;
export type DecisionsReadModel = z.infer<typeof decisionsReadModelSchema>;

export const nowResponseSchema = z
  .object({
    version: z.literal(1),
    role: z.enum(["owner", "ops", "sales", "production", "accounting"]),
    read_model_generated_at: nonEmptyTextSchema,
    permissions: z.array(nonEmptyTextSchema),
    allowed_actions: z.array(nonEmptyTextSchema),
    sources: z.array(nowSourceSchema),
    // Absent on older clients/fixtures; callers must show unavailable, never an empty inbox.
    decisions: decisionsReadModelSchema.optional(),
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
