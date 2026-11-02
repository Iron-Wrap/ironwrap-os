// deposit-policy-fixture.ts - record a tenant's deposit policy the way its owner's route does.
//
// Since migration 0155 a tenant with no deposit-policy revision is OD-01: its contracts carry no
// deposit and are paid on completion, and a contract with a deposit is refused. A fixture whose
// contracts carry a deposit (MD-13) records the owner's `md13_deposit` revision first, with the
// same insert `POST /api/v1/owner/deposit-policy` makes; D1 checks it exactly as it checks theirs.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function recordDepositPolicy(
  db: DatabaseSync,
  input: {
    tenantId: string;
    /** An active owner of the tenant (`access_role = 'owner'`), not the QA seed owner. */
    ownerUserId: string;
    policy?: "md13_deposit" | "od01_payment_on_completion";
    at?: string;
  },
): void {
  const policy = input.policy ?? "md13_deposit";
  const { next } = db.prepare(
    `SELECT COALESCE(MAX(revision), 0) + 1 AS next
       FROM tenant_deposit_policy_revisions WHERE tenant_id = ?`,
  ).get(input.tenantId) as { next: number };
  const keyHash = sha256(`fixture-deposit-policy:${input.tenantId}:${next}:${policy}`);
  db.prepare(
    `INSERT INTO tenant_deposit_policy_revisions (
       revision_id, tenant_id, revision, policy, reason, set_by_user_id, set_by_role,
       request_sha256, idempotency_key_hash, set_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, ?, ?)`,
  ).run(
    `tdp_${sha256(`${input.tenantId}:${keyHash}`).slice(0, 40)}`,
    input.tenantId,
    next,
    policy,
    policy === "md13_deposit"
      ? "Synthetic fixture: contracts carry a deposit (MD-13)."
      : "Synthetic fixture: payment on completion (OD-01).",
    input.ownerUserId,
    sha256(`fixture-request:${keyHash}`),
    keyHash,
    input.at ?? new Date().toISOString(),
  );
}
