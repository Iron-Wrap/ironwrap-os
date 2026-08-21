import { z } from "zod";

import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  quickBooksConnectResponseSchema,
  quickBooksConnectionResponseSchema,
  quickBooksFinalInvoiceResponseSchema,
  quickBooksIntentIdSchema,
  quickBooksRejectionReasons,
  type QuickBooksConnectResponse,
  type QuickBooksConnectionResponse,
  type QuickBooksFinalInvoiceResponse,
  type QuickBooksRejectionReason,
} from "./quickbooks-contracts";

const positiveVersionSchema = z.number().int().positive();
const quickBooksMappingInputSchema = z
  .object({
    roof_job_id: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9:_-]+$/),
    qbo_customer_id: z
      .string()
      .trim()
      .regex(/^\d{1,32}$/),
    qbo_item_id: z
      .string()
      .trim()
      .regex(/^\d{1,32}$/),
    qbo_tax_code_id: z
      .string()
      .trim()
      .regex(/^\d{1,32}$/),
    qbo_terms_id: z
      .string()
      .trim()
      .regex(/^\d{1,32}$/),
    jurisdiction: z
      .string()
      .trim()
      .min(2)
      .max(32)
      .regex(/^[A-Za-z0-9._:-]+$/),
    tax_code: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z0-9._:-]+$/),
    payment_terms_days: z.number().int().min(0).max(365),
    correction_reason: z.string().trim().min(3).max(1200).nullable().optional(),
  })
  .strict();
const rejectionReasonSchema = z.enum(quickBooksRejectionReasons);

export async function loadQuickBooksConnection(
  fetcher: typeof fetch = fetch,
): Promise<QuickBooksConnectionResponse> {
  return await apiRequest({
    path: API_PATHS.quickBooksConnection,
    schema: quickBooksConnectionResponseSchema,
    fetcher,
  });
}

export async function loadQuickBooksFinalInvoice(
  intentId: string,
  fetcher: typeof fetch = fetch,
): Promise<QuickBooksFinalInvoiceResponse> {
  const id = quickBooksIntentIdSchema.parse(intentId);
  return await apiRequest({
    path: API_PATHS.quickBooksFinalInvoice(id),
    schema: quickBooksFinalInvoiceResponseSchema,
    fetcher,
  });
}

export async function connectQuickBooks(
  session: AuthenticatedSession,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
  expectedOrigin = window.location.origin,
): Promise<QuickBooksConnectResponse> {
  return await apiRequest({
    path: API_PATHS.quickBooksConnect,
    schema: quickBooksConnectResponseSchema(expectedOrigin),
    method: "POST",
    body: { return_path: "/accounting/quickbooks" },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function approveQuickBooksFinalInvoice(
  session: AuthenticatedSession,
  intentId: string,
  version: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<QuickBooksFinalInvoiceResponse> {
  return await commandFinalInvoice(
    session,
    API_PATHS.quickBooksFinalInvoiceApprove(quickBooksIntentIdSchema.parse(intentId)),
    { version: positiveVersionSchema.parse(version) },
    idempotencyKey,
    fetcher,
  );
}

export async function rejectQuickBooksFinalInvoice(
  session: AuthenticatedSession,
  intentId: string,
  version: number,
  reasonCode: QuickBooksRejectionReason,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<QuickBooksFinalInvoiceResponse> {
  return await commandFinalInvoice(
    session,
    API_PATHS.quickBooksFinalInvoiceReject(quickBooksIntentIdSchema.parse(intentId)),
    {
      version: positiveVersionSchema.parse(version),
      reason_code: rejectionReasonSchema.parse(reasonCode),
    },
    idempotencyKey,
    fetcher,
  );
}

export async function reconcileQuickBooksFinalInvoice(
  session: AuthenticatedSession,
  intentId: string,
  version: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<QuickBooksFinalInvoiceResponse> {
  return await commandFinalInvoice(
    session,
    API_PATHS.quickBooksFinalInvoiceReconcile(quickBooksIntentIdSchema.parse(intentId)),
    { version: positiveVersionSchema.parse(version) },
    idempotencyKey,
    fetcher,
  );
}

export async function removeQuickBooksFromIronWrap(
  session: AuthenticatedSession,
  connectionVersion: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<QuickBooksConnectionResponse> {
  return await apiRequest({
    path: API_PATHS.quickBooksDisconnect,
    schema: quickBooksConnectionResponseSchema,
    method: "POST",
    body: { version: positiveVersionSchema.parse(connectionVersion) },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export async function saveQuickBooksFinalInvoiceMapping(
  session: AuthenticatedSession,
  input: z.input<typeof quickBooksMappingInputSchema>,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<QuickBooksConnectionResponse> {
  return await apiRequest({
    path: API_PATHS.quickBooksFinalInvoiceMappings,
    schema: quickBooksConnectionResponseSchema,
    method: "POST",
    body: quickBooksMappingInputSchema.parse(input),
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

async function commandFinalInvoice(
  session: AuthenticatedSession,
  path: string,
  body: { version: number; reason_code?: QuickBooksRejectionReason },
  idempotencyKey: string,
  fetcher: typeof fetch,
): Promise<QuickBooksFinalInvoiceResponse> {
  return await apiRequest({
    path,
    schema: quickBooksFinalInvoiceResponseSchema,
    method: "POST",
    body,
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export function newQuickBooksActionKey(action: string): string {
  return `quickbooks:${action}:${crypto.randomUUID()}`;
}
