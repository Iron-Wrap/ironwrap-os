// accounting-authority-policy.ts - where a money intent's ceiling comes from.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 6, migration
// `0064_accounting_authority_policy.sql`. ELEC-73 finding 2: the derive route accepted
// `authority_max_amount` from the request body, so the money plane's only ceiling check compared
// the caller's total against the caller's own ceiling. Section 6 calls the ceiling the control that
// gates hardest. This module makes it server-owned.
//
// Two rules, and they are the whole module:
//
//   * **A kind-specific ceiling wins over the tenant default.** A refund and a deposit invoice are
//     not the same risk (section 6 gates refunds by owner authority alone above the ceiling), so
//     the schema allows narrowing one kind without moving the rest.
//   * **No row means the platform default, never "unlimited".** A tenant nobody has configured is
//     the most likely tenant to be wrong about, so the absent case fails closed.
//
// The ceiling is read at derivation and copied onto the intent row (`authority_max_amount`), which
// is what makes it explainable later: an intent derived last month is still judged by the ceiling
// that was in force when it was derived, not by whatever the tenant's ceiling is today.

import type { AppEnv } from "./app-types.ts";
import type { AccountingIntentKind } from "./accounting-intents.ts";

/**
 * The ceiling for a tenant that has recorded no policy of its own.
 *
 * Deliberately a number that covers ordinary residential roofing work and refuses everything
 * larger until a human raises it on purpose: a default nobody notices is a default that gates
 * nothing. IronWrap Exteriors' own deposit and progress invoices sit well inside it, and a
 * commercial job that does not will refuse with `effect_policy_amount_ceiling_exceeded` rather
 * than dispatch - a visible refusal an owner can answer with a policy row.
 */
export const DEFAULT_ACCOUNTING_AUTHORITY_MAX_AMOUNT = "25000.00";

/** The tenant-wide row's `kind`, versus a row that narrows one intent kind. */
export const ACCOUNTING_AUTHORITY_POLICY_ANY_KIND = "*" as const;

export interface AccountingAuthorityPolicyRecord {
  policy_id: string;
  tenant_id: string;
  kind: string;
  max_amount: string;
  policy_version: string;
  effective_from: string;
  source_ref: string;
  recorded_by_user_id: string | null;
  recorded_at: string;
}

export interface AccountingAuthorityCeiling {
  /** Positive, two decimal places. Compared as a magnitude, always (section 6). */
  maxAmount: string;
  /** `platform_default` when the tenant has recorded no in-force policy row. */
  source: "tenant_policy" | "platform_default";
  /** The policy row's version, or null for the platform default. */
  policyVersion: string | null;
}

/**
 * The ceiling in force for one tenant and kind on one date.
 *
 * Newest in-force row wins, kind-specific before tenant-wide. `effective_from` is compared as a
 * date string, which is exact for `YYYY-MM-DD` and the same comparison
 * `accounting-tax-snapshots.ts` already makes for snapshot windows.
 */
export async function readAccountingAuthorityCeiling(
  env: AppEnv,
  input: { tenantId: string; kind: AccountingIntentKind; onDate: string },
): Promise<AccountingAuthorityCeiling> {
  const row = await env.DB.prepare(
    `SELECT max_amount, policy_version
       FROM accounting_authority_policies
      WHERE tenant_id = ? AND kind IN (?, ?) AND effective_from <= ?
      ORDER BY CASE WHEN kind = ? THEN 0 ELSE 1 END, effective_from DESC, recorded_at DESC
      LIMIT 1`,
  ).bind(
    input.tenantId, input.kind, ACCOUNTING_AUTHORITY_POLICY_ANY_KIND, input.onDate, input.kind,
  ).first<{ max_amount: string; policy_version: string }>();

  if (!row) {
    return {
      maxAmount: DEFAULT_ACCOUNTING_AUTHORITY_MAX_AMOUNT,
      source: "platform_default",
      policyVersion: null,
    };
  }
  return { maxAmount: row.max_amount, source: "tenant_policy", policyVersion: row.policy_version };
}

/**
 * Record one ceiling version.
 *
 * Idempotent on `(tenant, kind, version)` because the table is append-only: raising a ceiling is a
 * new *version*, and re-running the same write must not need a second row to say the same thing.
 */
export async function recordAccountingAuthorityPolicy(
  env: AppEnv,
  input: {
    tenantId: string;
    kind: AccountingIntentKind | typeof ACCOUNTING_AUTHORITY_POLICY_ANY_KIND;
    maxAmount: string;
    policyVersion: string;
    effectiveFrom: string;
    sourceRef: string;
    recordedByUserId?: string | null;
  },
  now: Date = new Date(),
): Promise<AccountingAuthorityPolicyRecord> {
  await env.DB.prepare(
    `INSERT INTO accounting_authority_policies (
       policy_id, tenant_id, kind, max_amount, policy_version, effective_from, source_ref,
       recorded_by_user_id, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, kind, policy_version) DO NOTHING`,
  ).bind(
    crypto.randomUUID(), input.tenantId, input.kind, input.maxAmount, input.policyVersion,
    input.effectiveFrom, input.sourceRef, input.recordedByUserId ?? null, now.toISOString(),
  ).run();

  const stored = await env.DB.prepare(
    `SELECT * FROM accounting_authority_policies
      WHERE tenant_id = ? AND kind = ? AND policy_version = ?`,
  ).bind(input.tenantId, input.kind, input.policyVersion)
    .first<AccountingAuthorityPolicyRecord>();
  if (!stored) throw new Error("accounting_authority_policy_write_failed");
  return stored;
}
