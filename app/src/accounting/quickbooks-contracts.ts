import { z } from "zod";

const boundedText = (min: number, max: number) => z.string().trim().min(min).max(max);
const safeId = boundedText(1, 160).regex(/^[A-Za-z0-9:_-]+$/);
export const quickBooksIntentIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{16,160}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const moneySchema = z.string().regex(/^(?:0|[1-9]\d{0,8})\.\d{2}$/);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const isoDateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid calendar date.");

export const quickBooksIntentStates = [
  "connection_required",
  "blocked",
  "pending_review",
  "rejected",
  "submission_pending",
  "submitted",
  "matched",
  "failed",
  "reconciliation_required",
] as const;

export const quickBooksActions = [
  "connect",
  "approve",
  "reject",
  "reconcile",
  "remove_from_ironwrap",
  "refresh",
] as const;

export const quickBooksBlockerCodes = [
  "oauth_connection_required",
  "realm_mismatch",
  "customer_mapping_missing",
  "item_mapping_missing",
  "tax_mapping_missing",
  "terms_mapping_missing",
  "commercial_policy_hold",
  "candidate_invalid",
  "candidate_changed",
  "provider_response_uncertain",
  "provider_readback_drift",
  "provider_invoice_missing",
  "frappe_bind_pending",
  "frappe_resolver_pending",
] as const;

export const quickBooksNextSteps = [
  "connect_quickbooks",
  "fix_frappe_mapping",
  "resolve_commercial_policy",
  "refresh_candidate",
  "reconcile_provider_invoice",
  "retry_frappe_projection",
] as const;

export const quickBooksRejectionReasons = [
  "evidence_incomplete",
  "commercial_values_disputed",
  "duplicate_or_already_billed",
  "mapping_requires_correction",
  "not_ready_to_invoice",
] as const;

const quickBooksCitationSchema = z
  .object({
    id: safeId,
    label: z.enum(["completion_packet", "accepted_quote", "accepted_change", "commercial_policy"]),
    source: z.enum(["Frappe", "R2"]),
    source_ref: boundedText(3, 320),
    sha256: sha256Schema,
  })
  .strict()
  .superRefine((citation, context) => {
    const valid =
      citation.source === "Frappe"
        ? /^Frappe:[A-Za-z][A-Za-z ]{1,63}:[A-Za-z0-9:_-]{1,160}$/.test(citation.source_ref)
        : /^R2:[A-Za-z0-9][A-Za-z0-9/_.:-]{1,317}$/.test(citation.source_ref);
    if (!valid) {
      context.addIssue({
        code: "custom",
        path: ["source_ref"],
        message: "Citation source reference is not a bounded owned-record reference.",
      });
    }
    if (
      citation.source === "R2" &&
      (citation.source_ref.includes("..") ||
        citation.source_ref.includes("//") ||
        citation.source_ref.slice(3).startsWith("/") ||
        citation.source_ref.endsWith("/"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["source_ref"],
        message: "R2 citation reference is not a canonical owned key.",
      });
    }
  });

const quickBooksLineSchema = z
  .object({
    description_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/),
    amount: moneySchema,
  })
  .strict();

export const quickBooksFinalInvoiceResponseSchema = z
  .object({
    version: z.literal(1),
    read_model_generated_at: isoDateTimeSchema,
    permissions: z
      .array(z.enum(["quickbooks:read", "quickbooks:review", "quickbooks:reconcile"]))
      .max(3),
    allowed_actions: z.array(z.enum(quickBooksActions)).max(quickBooksActions.length),
    connection: z
      .object({
        state: z.enum(["connected", "connection_required", "revoked", "reconciliation_required"]),
        realm_id: z
          .string()
          .regex(/^\d{1,32}$/)
          .nullable(),
        last_connected_at: isoDateTimeSchema.nullable(),
      })
      .strict(),
    intent: z
      .object({
        id: quickBooksIntentIdSchema,
        job_id: safeId,
        shop_order_id: safeId.nullable(),
        state: z.enum(quickBooksIntentStates),
        version: z.number().int().positive(),
        currency: z.literal("CAD"),
        amounts: z
          .object({
            subtotal: moneySchema,
            tax: moneySchema,
            already_invoiced: z.literal("0.00"),
            final_balance: moneySchema,
          })
          .strict(),
        tax: z
          .object({
            code: z.string().regex(/^[A-Z][A-Z0-9_-]{1,31}$/),
            rate: z.string().regex(/^(?:0|[1-9]\d{0,2})\.\d{4}$/),
          })
          .strict(),
        invoice_date: isoDateSchema,
        due_date: isoDateSchema,
        lines: z.array(quickBooksLineSchema).min(1).max(100),
        basis: z
          .object({
            basis_hash: sha256Schema,
            completion_id: safeId,
            completion_version: z.number().int().positive(),
            completion_hash: sha256Schema,
            quote_id: safeId,
            quote_version: z.number().int().positive(),
            quote_hash: sha256Schema,
            changes_hash: sha256Schema,
          })
          .strict(),
        blocker: z
          .object({
            code: z.enum(quickBooksBlockerCodes),
            next_step: z.enum(quickBooksNextSteps),
          })
          .strict()
          .nullable(),
        citations: z.array(quickBooksCitationSchema).min(1).max(20),
        rejection_reason: z.enum(quickBooksRejectionReasons).nullable(),
        provider: z
          .object({
            invoice_id: z.string().regex(/^\d{1,32}$/),
            submitted_at: isoDateTimeSchema.nullable(),
            matched_at: isoDateTimeSchema.nullable(),
          })
          .strict()
          .nullable(),
        created_at: isoDateTimeSchema,
        updated_at: isoDateTimeSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((payload, context) => {
    const { connection, intent } = payload;
    if (
      (connection.state === "connected") !==
      Boolean(connection.realm_id && connection.last_connected_at)
    ) {
      context.addIssue({
        code: "custom",
        path: ["connection"],
        message: "QuickBooks connection identity does not match its recorded state.",
      });
    }
    if (new Set(payload.permissions).size !== payload.permissions.length) {
      context.addIssue({ code: "custom", path: ["permissions"], message: "Duplicate permission." });
    }
    if (new Set(payload.allowed_actions).size !== payload.allowed_actions.length) {
      context.addIssue({ code: "custom", path: ["allowed_actions"], message: "Duplicate action." });
    }
    if (
      (payload.allowed_actions.includes("connect") &&
        !["connection_required", "revoked"].includes(connection.state)) ||
      (payload.allowed_actions.includes("remove_from_ironwrap") && connection.state !== "connected")
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowed_actions"],
        message: "QuickBooks actions do not match the recorded connection state.",
      });
    }
    const subtotal = cents(intent.amounts.subtotal);
    const tax = cents(intent.amounts.tax);
    const finalBalance = cents(intent.amounts.final_balance);
    const lineAmounts = intent.lines.map((line) => cents(line.amount));
    if (
      subtotal === null ||
      tax === null ||
      finalBalance === null ||
      lineAmounts.some((amount) => amount === null)
    ) {
      return;
    }
    const lineTotal = lineAmounts.reduce<bigint>((sum, amount) => sum + (amount ?? 0n), 0n);
    if (subtotal !== lineTotal || finalBalance !== subtotal + tax) {
      context.addIssue({
        code: "custom",
        path: ["intent", "amounts"],
        message: "Displayed final-balance amounts do not match the immutable candidate lines.",
      });
    }
    if (intent.due_date < intent.invoice_date) {
      context.addIssue({
        code: "custom",
        path: ["intent", "due_date"],
        message: "Due date cannot be earlier than the recorded invoice date.",
      });
    }
    if (intent.provider?.matched_at && !intent.provider.submitted_at) {
      context.addIssue({
        code: "custom",
        path: ["intent", "provider"],
        message: "A matched provider record must include its earlier submission readback.",
      });
    }
    if (intent.provider && !intent.provider.submitted_at) {
      context.addIssue({
        code: "custom",
        path: ["intent", "provider", "submitted_at"],
        message: "Provider identity requires authenticated submission readback.",
      });
    }
    if (intent.state === "submitted" && !intent.provider?.submitted_at) {
      context.addIssue({
        code: "custom",
        path: ["intent", "provider"],
        message: "Submitted state requires authenticated provider readback.",
      });
    }
    if (intent.state === "matched" && !intent.provider?.matched_at) {
      context.addIssue({
        code: "custom",
        path: ["intent", "provider"],
        message: "Matched state requires authenticated provider readback.",
      });
    }
    if (intent.state === "rejected" && !intent.rejection_reason) {
      context.addIssue({
        code: "custom",
        path: ["intent", "rejection_reason"],
        message: "Rejected state requires its bounded recorded reason.",
      });
    }
    if (intent.state === "blocked" && !intent.blocker) {
      context.addIssue({
        code: "custom",
        path: ["intent", "blocker"],
        message: "Blocked state requires a bounded blocker and next step.",
      });
    }
  });

export const quickBooksConnectionResponseSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["connected", "connection_required", "revoked", "reconciliation_required"]),
    connection_version: z.number().int().positive().nullable(),
    realm_id: z
      .string()
      .regex(/^\d{1,32}$/)
      .nullable(),
    last_connected_at: isoDateTimeSchema.nullable(),
    allowed_actions: z.array(z.enum(["connect", "remove_from_ironwrap", "refresh"])).max(3),
  })
  .strict()
  .superRefine((connection, context) => {
    if (
      (connection.state === "connected") !==
      Boolean(connection.realm_id && connection.last_connected_at)
    ) {
      context.addIssue({
        code: "custom",
        message: "QuickBooks connection identity does not match its recorded state.",
      });
    }
    if (
      (connection.state === "connection_required" && connection.connection_version !== null) ||
      (connection.state !== "connection_required" && connection.connection_version === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["connection_version"],
        message: "QuickBooks connection version does not match its recorded lifecycle state.",
      });
    }
    if (new Set(connection.allowed_actions).size !== connection.allowed_actions.length) {
      context.addIssue({
        code: "custom",
        path: ["allowed_actions"],
        message: "Duplicate connection action.",
      });
    }
    if (
      !connection.allowed_actions.includes("refresh") ||
      (connection.state === "connected" && connection.allowed_actions.includes("connect")) ||
      (connection.state === "reconciliation_required" &&
        connection.allowed_actions.includes("connect")) ||
      (connection.state !== "connected" &&
        connection.allowed_actions.includes("remove_from_ironwrap"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowed_actions"],
        message: "QuickBooks connection actions do not match the recorded state.",
      });
    }
  });

export function quickBooksConnectResponseSchema(expectedOrigin = window.location.origin) {
  return z
    .object({
      version: z.literal(1),
      connect_url: boundedText(1, 4_096),
      return_path: z.literal("/accounting/quickbooks"),
      expires_at: isoDateTimeSchema,
      callback_origin: boundedText(1, 2_048),
      redirect_uri: boundedText(1, 2_048),
    })
    .strict()
    .superRefine((response, context) => {
      if (!validQuickBooksOAuthResponse(response, expectedOrigin)) {
        context.addIssue({
          code: "custom",
          path: ["connect_url"],
          message: "Untrusted QuickBooks OAuth handoff URL.",
        });
      }
    });
}

function validQuickBooksOAuthResponse(
  response: {
    connect_url: string;
    callback_origin: string;
    redirect_uri: string;
  },
  expectedOrigin: string,
): boolean {
  try {
    const appOrigin = new URL(expectedOrigin);
    const local = appOrigin.hostname === "localhost";
    if (
      appOrigin.origin !== expectedOrigin ||
      (appOrigin.protocol !== "https:" && !(appOrigin.protocol === "http:" && local))
    )
      return false;
    if (response.callback_origin !== appOrigin.origin) return false;
    const exactRedirect = `${appOrigin.origin}/oauth/quickbooks/callback`;
    if (response.redirect_uri !== exactRedirect) return false;

    const url = new URL(response.connect_url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "appcenter.intuit.com" ||
      url.port ||
      url.pathname !== "/connect/oauth2" ||
      url.username ||
      url.password ||
      url.hash
    )
      return false;
    const allowedKeys = ["client_id", "redirect_uri", "response_type", "scope", "state"];
    const keys = [...url.searchParams.keys()];
    if (
      keys.length !== allowedKeys.length ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !allowedKeys.includes(key))
    )
      return false;
    return (
      /^[A-Za-z0-9._-]{1,256}$/.test(url.searchParams.get("client_id") ?? "") &&
      /^[A-Za-z0-9._~-]{16,512}$/.test(url.searchParams.get("state") ?? "") &&
      url.searchParams.get("response_type") === "code" &&
      url.searchParams.get("scope") === "com.intuit.quickbooks.accounting" &&
      url.searchParams.get("redirect_uri") === exactRedirect
    );
  } catch {
    return false;
  }
}

function cents(value: string): bigint | null {
  return /^(?:0|[1-9]\d{0,11})\.\d{2}$/.test(value) ? BigInt(value.replace(".", "")) : null;
}

export type QuickBooksAction = (typeof quickBooksActions)[number];
export type QuickBooksRejectionReason = (typeof quickBooksRejectionReasons)[number];
export type QuickBooksFinalInvoiceResponse = z.infer<typeof quickBooksFinalInvoiceResponseSchema>;
export type QuickBooksConnectionResponse = z.infer<typeof quickBooksConnectionResponseSchema>;
export type QuickBooksConnectResponse = z.infer<ReturnType<typeof quickBooksConnectResponseSchema>>;
