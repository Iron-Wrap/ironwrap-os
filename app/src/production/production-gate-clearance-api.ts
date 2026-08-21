import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  productionGateClearanceResponseSchema,
  type ClearableProductionGate,
  type ProductionGateClearanceResponse,
} from "./production-gate-clearance-contracts";

export async function clearProductionGate(
  session: AuthenticatedSession,
  input: {
    roofJobId: string;
    gate: ClearableProductionGate;
    basis: "office_waiver" | "deposit_settlement";
    reason?: string;
  },
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ProductionGateClearanceResponse> {
  return await apiRequest({
    path: API_PATHS.productionGateClearance(input.roofJobId, input.gate),
    schema: productionGateClearanceResponseSchema,
    method: "POST",
    // A settlement clearance carries no prose at all: the Worker states it from the
    // money-lane record, so there is nothing here for a caller to contradict.
    body:
      input.basis === "deposit_settlement"
        ? { basis: input.basis }
        : { basis: input.basis, reason: input.reason ?? "" },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

export function newProductionGateClearanceKey(): string {
  return `production-gate-clearance:${crypto.randomUUID()}`;
}
