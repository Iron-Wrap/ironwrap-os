import type { AppEnv } from "./app-types.ts";
import { externalEvidenceMarkerPresent } from "./evidence-privacy-ledger.ts";

export type EvidenceDispositionState = "destroying" | "failed" | "destroyed" | "quarantined";

/** An old D1 restore cannot make a receipt available while its external marker survives. */
export async function evidenceDispositionState(
  env: AppEnv,
  tenantId: string,
  receiptId: string,
): Promise<EvidenceDispositionState | null> {
  const row = await env.DB.prepare(
    "SELECT state FROM evidence_upload_dispositions WHERE tenant_id = ? AND receipt_id = ?",
  ).bind(tenantId, receiptId).first<{ state: EvidenceDispositionState }>();
  if (row) return row.state;
  return await externalEvidenceMarkerPresent(env, tenantId, receiptId) ? "quarantined" : null;
}
