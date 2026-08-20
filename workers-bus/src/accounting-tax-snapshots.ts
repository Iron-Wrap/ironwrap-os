// accounting-tax-snapshots.ts - versioned tax snapshots, staleness, and drift (slice S2).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 5.4, "tax rate change mid-project". The whole
// slice exists to make one failure case impossible to get wrong:
//
//   * every tax-bearing intent binds a snapshot at derivation, and the snapshot is immutable;
//   * a rate change creates a NEW snapshot - already-submitted intents keep theirs, because that
//     is what was posted and it is correct;
//   * an un-submitted intent whose snapshot is no longer current is blocked `candidate_changed`
//     and must be re-derived and re-approved;
//   * a submission preflight compares the bound rate against the provider's own TaxCode/TaxRate,
//     and a difference blocks with `tax_rate_drift` and opens an exception. The local snapshot is
//     never silently rewritten to match QuickBooks.
//
// Nothing here calls a provider. The preflight consumes an already-normalized TaxRate fact set,
// which `accounting-provider-read.ts` produces through the S0 auth port and an injected fetcher,
// so this module stays pure and every rule above is testable without a socket.

import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import {
  rateDecimal,
  rateUnitsFromDecimal,
  type NormalizedEntityFacts,
} from "./accounting-normalizers.ts";
import {
  intentSubjectRef,
  raiseAccountingException,
  type AccountingExceptionRecord,
} from "./accounting-exceptions.ts";
import { blockAccountingIntent, readAccountingIntent } from "./accounting-intents.ts";

/**
 * The blocker a stale snapshot raises. Deliberately PR #43's existing vocabulary rather than a new
 * word for the same thing: a candidate whose bound facts moved must be re-derived and re-approved,
 * and the PWA already knows how to render that blocker.
 */
export const TAX_SNAPSHOT_STALE_BLOCKER = "candidate_changed";
export const TAX_RATE_DRIFT_BLOCKER = "tax_rate_drift";

export class AccountingTaxSnapshotError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "AccountingTaxSnapshotError";
  }
}

export interface TaxPolicySnapshotRecord {
  snapshot_id: string;
  tenant_id: string;
  jurisdiction: string;
  tax_code: string;
  provider_tax_code_id: string | null;
  rate_percent: string;
  effective_from: string;
  effective_to: string | null;
  source_ref: string;
  snapshot_sha256: string;
  version: number;
  created_at: string;
}

export interface RecordTaxPolicySnapshotInput {
  tenantId: string;
  jurisdiction: string;
  taxCode: string;
  providerTaxCodeId?: string | null;
  /** Percent with up to four decimal places: `5`, `"5"`, and `"5.0000"` are the same rate. */
  ratePercent: string | number;
  effectiveFrom: string;
  effectiveTo?: string | null;
  sourceRef: string;
}

/**
 * Record one snapshot of a rate. Idempotent on the bound facts: the same rate read twice from the
 * same source is one snapshot, not two versions of the same number.
 */
export async function recordTaxPolicySnapshot(
  env: AppEnv,
  input: RecordTaxPolicySnapshotInput,
  now: Date = new Date(),
): Promise<TaxPolicySnapshotRecord> {
  const ratePercent = rateDecimal(input.ratePercent);
  if (ratePercent === null || ratePercent.startsWith("-")) {
    throw new AccountingTaxSnapshotError("tax_policy_snapshot_rate_invalid");
  }
  const facts = {
    jurisdiction: input.jurisdiction,
    taxCode: input.taxCode,
    ratePercent,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    sourceRef: input.sourceRef,
  };
  const snapshotSha256 = await sha256Hex(canonicalJson(facts));

  const existing = await readTaxPolicySnapshotByHash(env, input.tenantId, snapshotSha256);
  if (existing) return existing;

  const highest = await env.DB.prepare(
    `SELECT MAX(version) AS version FROM tax_policy_snapshots
      WHERE tenant_id = ? AND jurisdiction = ? AND tax_code = ?`,
  ).bind(input.tenantId, input.jurisdiction, input.taxCode).first<{ version: number | null }>();
  const version = (highest?.version ?? 0) + 1;

  await env.DB.prepare(
    `INSERT INTO tax_policy_snapshots (
       snapshot_id, tenant_id, jurisdiction, tax_code, provider_tax_code_id, rate_percent,
       effective_from, effective_to, source_ref, snapshot_sha256, version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `tax-snap:${input.jurisdiction}:${input.taxCode}:v${version}`, input.tenantId,
    input.jurisdiction, input.taxCode, input.providerTaxCodeId ?? null, ratePercent,
    input.effectiveFrom, input.effectiveTo ?? null, input.sourceRef, snapshotSha256, version,
    now.toISOString(),
  ).run();

  const stored = await readTaxPolicySnapshotByHash(env, input.tenantId, snapshotSha256);
  if (!stored) throw new AccountingTaxSnapshotError("tax_policy_snapshot_write_failed");
  return stored;
}

export async function readTaxPolicySnapshot(
  env: AppEnv,
  tenantId: string,
  snapshotId: string,
): Promise<TaxPolicySnapshotRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM tax_policy_snapshots WHERE tenant_id = ? AND snapshot_id = ?`,
  ).bind(tenantId, snapshotId).first<TaxPolicySnapshotRecord>();
}

export async function readTaxPolicySnapshotByHash(
  env: AppEnv,
  tenantId: string,
  snapshotSha256: string,
): Promise<TaxPolicySnapshotRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM tax_policy_snapshots WHERE tenant_id = ? AND snapshot_sha256 = ?`,
  ).bind(tenantId, snapshotSha256).first<TaxPolicySnapshotRecord>();
}

/**
 * The snapshot in force for a code on a date.
 *
 * Supersession is ordering, not mutation: the newest snapshot whose window contains the date wins.
 * Closing an old window by UPDATE would edit a fact an already-submitted intent bound, and the
 * migration's immutability triggers refuse it outright.
 */
export async function currentTaxPolicySnapshot(
  env: AppEnv,
  input: { tenantId: string; jurisdiction: string; taxCode: string; onDate: string },
): Promise<TaxPolicySnapshotRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM tax_policy_snapshots
      WHERE tenant_id = ? AND jurisdiction = ? AND tax_code = ?
        AND effective_from <= ?
        AND (effective_to IS NULL OR effective_to > ?)
      ORDER BY effective_from DESC, version DESC
      LIMIT 1`,
  ).bind(input.tenantId, input.jurisdiction, input.taxCode, input.onDate, input.onDate)
    .first<TaxPolicySnapshotRecord>();
}

export interface AccountingIntentTaxBinding {
  binding_id: string;
  tenant_id: string;
  intent_id: string;
  snapshot_id: string;
  snapshot_sha256: string;
  jurisdiction: string;
  tax_code: string;
  bound_at: string;
}

/**
 * The single value an intent carries for a set of bound snapshots.
 *
 * `accounting_intents.tax_policy_snapshot_sha256` is one column and an intent may bind more than
 * one code (GST plus a provincial code), so the column holds the hash over the sorted set. Sorting
 * makes it order-independent: binding GST then PST and binding PST then GST are the same fact.
 */
export async function taxBindingSetSha256(snapshotSha256s: readonly string[]): Promise<string> {
  if (snapshotSha256s.length === 0) {
    throw new AccountingTaxSnapshotError("tax_mapping_missing");
  }
  return await sha256Hex(canonicalJson([...snapshotSha256s].sort()));
}

/**
 * Bind snapshots to an intent that has not been decided yet.
 *
 * The D1 trigger refuses a binding on an approved or submitted intent, so the bound tax facts are
 * exactly what a reviewer saw and exactly what was posted.
 */
export async function bindAccountingIntentTaxSnapshots(
  env: AppEnv,
  input: {
    tenantId: string;
    intentId: string;
    snapshots: readonly TaxPolicySnapshotRecord[];
  },
  now: Date = new Date(),
): Promise<AccountingIntentTaxBinding[]> {
  if (input.snapshots.length === 0) {
    throw new AccountingTaxSnapshotError("tax_mapping_missing");
  }
  const timestamp = now.toISOString();
  for (const snapshot of input.snapshots) {
    await env.DB.prepare(
      `INSERT INTO accounting_intent_tax_bindings (
         binding_id, tenant_id, intent_id, snapshot_id, snapshot_sha256, jurisdiction, tax_code,
         bound_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, intent_id, tax_code) DO NOTHING`,
    ).bind(
      crypto.randomUUID(), input.tenantId, input.intentId, snapshot.snapshot_id,
      snapshot.snapshot_sha256, snapshot.jurisdiction, snapshot.tax_code, timestamp,
    ).run();
  }
  return await listAccountingIntentTaxBindings(env, input.tenantId, input.intentId);
}

export async function listAccountingIntentTaxBindings(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<AccountingIntentTaxBinding[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM accounting_intent_tax_bindings
      WHERE tenant_id = ? AND intent_id = ? ORDER BY tax_code`,
  ).bind(tenantId, intentId).all<AccountingIntentTaxBinding>();
  return rows.results ?? [];
}

/**
 * The intent's single bound hash must be the hash over the bindings that actually exist.
 *
 * D1 cannot check this - it has no SHA-256 - so it is checked here and asserted by a test. Without
 * it a caller could record a hash over one snapshot set and bind a different one, and every
 * staleness and drift check afterwards would be comparing the wrong pair while looking correct.
 */
export async function assertAccountingIntentTaxBindingIntegrity(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<void> {
  const intent = await readAccountingIntent(env, tenantId, intentId);
  if (!intent) throw new AccountingTaxSnapshotError("accounting_intent_missing");
  const bindings = await listAccountingIntentTaxBindings(env, tenantId, intentId);
  if (intent.tax_policy_snapshot_sha256 === null) {
    if (bindings.length > 0) {
      throw new AccountingTaxSnapshotError("accounting_intent_tax_binding_mismatch");
    }
    return;
  }
  if (bindings.length === 0) throw new AccountingTaxSnapshotError("tax_mapping_missing");
  const expected = await taxBindingSetSha256(bindings.map((row) => row.snapshot_sha256));
  if (expected !== intent.tax_policy_snapshot_sha256) {
    throw new AccountingTaxSnapshotError("accounting_intent_tax_binding_mismatch");
  }
}

/** States in which an intent's bound snapshot set may still be re-derived (section 5.4). */
const RE_DERIVABLE_STATES: readonly string[] = [
  "draft", "blocked", "pending_review", "submission_pending",
];

export interface TaxSnapshotStalenessReport {
  stale: boolean;
  /** Present only when `stale`. The intent must be re-derived and re-approved before submission. */
  blockerCode: typeof TAX_SNAPSHOT_STALE_BLOCKER | null;
  entries: Array<{
    taxCode: string;
    jurisdiction: string;
    boundSnapshotId: string;
    boundSnapshotSha256: string;
    currentSnapshotId: string | null;
    currentSnapshotSha256: string | null;
    stale: boolean;
  }>;
}

/**
 * Is this intent's bound tax still the tax in force?
 *
 * An already-submitted intent is never stale. It bound the rate that was posted, and re-deriving it
 * would be rewriting history to match today - exactly what section 5.1 forbids.
 */
export async function assessTaxSnapshotStaleness(
  env: AppEnv,
  input: { tenantId: string; intentId: string; onDate: string },
): Promise<TaxSnapshotStalenessReport> {
  const intent = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!intent) throw new AccountingTaxSnapshotError("accounting_intent_missing");
  const bindings = await listAccountingIntentTaxBindings(env, input.tenantId, input.intentId);
  const reDerivable = RE_DERIVABLE_STATES.includes(intent.state);

  const entries: TaxSnapshotStalenessReport["entries"] = [];
  for (const binding of bindings) {
    const current = await currentTaxPolicySnapshot(env, {
      tenantId: input.tenantId,
      jurisdiction: binding.jurisdiction,
      taxCode: binding.tax_code,
      onDate: input.onDate,
    });
    entries.push({
      taxCode: binding.tax_code,
      jurisdiction: binding.jurisdiction,
      boundSnapshotId: binding.snapshot_id,
      boundSnapshotSha256: binding.snapshot_sha256,
      currentSnapshotId: current?.snapshot_id ?? null,
      currentSnapshotSha256: current?.snapshot_sha256 ?? null,
      stale: reDerivable && current !== null && current.snapshot_sha256 !== binding.snapshot_sha256,
    });
  }

  const stale = entries.some((entry) => entry.stale);
  return { stale, blockerCode: stale ? TAX_SNAPSHOT_STALE_BLOCKER : null, entries };
}

export interface TaxRateDriftReport {
  drifted: boolean;
  entries: Array<{
    taxCode: string;
    boundRatePercent: string;
    providerRatePercent: string | null;
    providerTaxRateId: string | null;
    drifted: boolean;
  }>;
  exception: AccountingExceptionRecord | null;
}

/**
 * Compare the bound snapshots against the provider's own rates.
 *
 * `providerRates` are normalized TaxRate fact sets - what `readProviderEntity` returned through the
 * auth port - keyed by the tax code they were read for. A provider rate that differs from the bound
 * one blocks the intent and opens `tax_rate_drift`; the snapshot is not touched, because the
 * provider disagreeing with a statute is an accounting event for a human, not a number to
 * overwrite (section 5.4).
 */
export async function detectTaxRateDrift(
  env: AppEnv,
  input: {
    tenantId: string;
    intentId: string;
    providerRates: ReadonlyMap<string, NormalizedEntityFacts>;
  },
  now: Date = new Date(),
): Promise<TaxRateDriftReport> {
  const intent = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!intent) throw new AccountingTaxSnapshotError("accounting_intent_missing");
  const bindings = await listAccountingIntentTaxBindings(env, input.tenantId, input.intentId);

  const entries: TaxRateDriftReport["entries"] = [];
  for (const binding of bindings) {
    const snapshot = await readTaxPolicySnapshot(env, input.tenantId, binding.snapshot_id);
    if (!snapshot) throw new AccountingTaxSnapshotError("tax_policy_snapshot_missing");
    const observed = input.providerRates.get(binding.tax_code);
    const providerRate = observed ? rateDecimalFromFacts(observed) : null;
    entries.push({
      taxCode: binding.tax_code,
      boundRatePercent: snapshot.rate_percent,
      providerRatePercent: providerRate,
      providerTaxRateId: observed?.entityId ?? null,
      drifted: providerRate !== null
        && rateUnitsFromDecimal(providerRate) !== rateUnitsFromDecimal(snapshot.rate_percent),
    });
  }

  const drifted = entries.filter((entry) => entry.drifted);
  if (drifted.length === 0) return { drifted: false, entries, exception: null };

  const { exception } = await raiseAccountingException(env, {
    tenantId: input.tenantId,
    subjectRef: intentSubjectRef(input.intentId),
    intentId: input.intentId,
    reasonCode: "tax_rate_drift",
    detail: {
      realmId: intent.realm_id,
      rates: drifted.map((entry) => ({
        taxCode: entry.taxCode,
        boundRatePercent: entry.boundRatePercent,
        providerRatePercent: entry.providerRatePercent,
        providerTaxRateId: entry.providerTaxRateId,
      })),
      // The local snapshot stands. The remedy is a human decision, not a rewrite.
      remedies: ["accepted_as_posted", "superseded_by_new_intent"],
    },
  }, now);

  return { drifted: true, entries, exception };
}

/**
 * The submission preflight of section 5.4: block a stale candidate, block a drifted rate, and let
 * everything else through. Returns the blocker rather than throwing, because "this intent may not
 * be submitted yet" is an ordinary answer the Money Desk renders, not an exceptional one.
 */
export async function preflightAccountingIntentTax(
  env: AppEnv,
  input: {
    tenantId: string;
    intentId: string;
    onDate: string;
    providerRates: ReadonlyMap<string, NormalizedEntityFacts>;
  },
  now: Date = new Date(),
): Promise<{
  ok: boolean;
  blockerCode: string | null;
  staleness: TaxSnapshotStalenessReport;
  drift: TaxRateDriftReport;
}> {
  const staleness = await assessTaxSnapshotStaleness(env, {
    tenantId: input.tenantId,
    intentId: input.intentId,
    onDate: input.onDate,
  });
  const drift = await detectTaxRateDrift(env, {
    tenantId: input.tenantId,
    intentId: input.intentId,
    providerRates: input.providerRates,
  }, now);

  // Drift is reported first: a provider that disagrees with the bound rate is an exception the
  // accountant must see even when the candidate also needs re-deriving for another reason.
  const blockerCode = drift.drifted
    ? TAX_RATE_DRIFT_BLOCKER
    : staleness.stale
      ? TAX_SNAPSHOT_STALE_BLOCKER
      : null;
  if (blockerCode) {
    await blockAccountingIntent(env, {
      tenantId: input.tenantId,
      intentId: input.intentId,
      blocker: {
        code: blockerCode,
        nextStep: blockerCode === TAX_RATE_DRIFT_BLOCKER
          ? "Reconcile the provider tax rate with the bound snapshot"
          : "Re-derive this candidate against the current tax snapshot",
      },
    }, now);
  }

  return { ok: blockerCode === null, blockerCode, staleness, drift };
}

/** The rate the provider currently charges, read from a normalized TaxRate fact set. */
function rateDecimalFromFacts(facts: NormalizedEntityFacts): string | null {
  const value = facts.facts["RateValue"];
  return typeof value === "string" ? value : null;
}
