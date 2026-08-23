import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  commercialLeadTriageDecisionResponseSchema,
  newLeadResponseSchema,
  salesResponseSchema,
  type CommercialLeadTriageDecisionResponse,
  type CommercialLeadTriageInput,
  type NewLeadInput,
  type NewLeadResponse,
  type SalesResponse,
} from "./sales-contracts";

export async function loadSales(fetcher: typeof fetch = fetch): Promise<SalesResponse> {
  return await apiRequest({
    path: API_PATHS.sales,
    schema: salesResponseSchema,
    fetcher,
  });
}

export function newCommercialLeadTriageKey(): string {
  return `commercial-lead-triage:${crypto.randomUUID()}`;
}

export async function recordCommercialLeadTriage(
  session: AuthenticatedSession,
  input: CommercialLeadTriageInput,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<CommercialLeadTriageDecisionResponse> {
  return await apiRequest({
    path: API_PATHS.commercialLeadTriageDecisions,
    schema: commercialLeadTriageDecisionResponseSchema,
    method: "POST",
    body: {
      lead_id: input.leadId,
      expected_lead_version: input.expectedLeadVersion,
      lifecycle_status: input.lifecycleStatus,
      priority: input.priority,
      category: input.category,
      summary: input.summary,
      next_action: input.nextAction,
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

/**
 * Take a lead by hand. Blank fields are dropped rather than sent as empty strings: the route
 * rejects an unknown or malformed value, and "" is not the same statement as "not said yet".
 */
export async function createLead(
  session: AuthenticatedSession,
  input: NewLeadInput,
  fetcher: typeof fetch = fetch,
): Promise<NewLeadResponse> {
  const body: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const trimmed = value.trim();
    if (trimmed) body[key] = trimmed;
  }
  return await apiRequest({
    path: API_PATHS.salesLeads,
    schema: newLeadResponseSchema,
    method: "POST",
    body,
    csrfToken: session.csrf_token,
    fetcher,
  });
}
