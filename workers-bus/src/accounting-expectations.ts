// accounting-expectations.ts - the stored form of what a money intent expects to find at the
// provider.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md sections 5.1 and 5.2, migration
// `0063_accounting_dispatch_evidence.sql`. Two problems, one table.
//
// **A dispatcher needs the envelope, not the hash.** `accounting_intents` stores
// `expected_sha256` and throws the envelope away, and `submitAccountingIntent` refuses to dispatch
// without the exact envelope that hash was taken over. Only the caller that had just built it
// could dispatch - which is why, before this module, the only caller was a test (ELEC-71). The
// stored envelope is what lets a background job dispatch an intent a human approved an hour ago.
//
// **A create cannot know its own id.** Section 5.2 puts the provider's `Id` inside the hashed
// comparison fact set and Intuit assigns it, so an intent for an entity IronWrap is about to
// create could never bind a reconcilable expectation at derivation: the id would have to be
// guessed. `0058`'s own CHECK closes the other exit - a row in `reconciled` must have
// `observed_sha256 = expected_sha256`, and `expected_sha256` is immutable - so completing the
// expectation after the fact is not available either.
//
// So such an intent binds an **identity-free** expectation (`localFactEnvelope`), and the
// observation it is judged against is hashed on that same basis. `omits_identity` records which
// basis an intent bound, once, at derivation, rather than leaving every reader to re-parse the
// envelope and guess.
//
// This does not leave identity unchecked. Section 5.1 has two halves - the fact hashes agree, and
// "provider identity ... equals the identity recorded on the settled effect attempt" - and
// `accounting-reconciliation.ts` enforces the second directly, comparing realm, entity type and
// entity id before it looks at a hash at all. Hashing the id as well stated that check twice and
// made the create case impossible; stating it once makes both real.
//
// Backward compatible by construction: an intent that bound a complete envelope, which is every
// intent that exists today, has `omits_identity = 0` and is compared exactly as before.

import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import type { AppEnv } from "./app-types.ts";
// Type-only, and deliberately so: `accounting-intents.ts` calls this module at derivation, so a
// value import back into it would be a runtime cycle. A type import is erased and cannot be one.
import type { AccountingIntentRecord } from "./accounting-intents.ts";
import type { AccountingObservationRecord } from "./accounting-reconciliation.ts";

export class AccountingExpectationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "AccountingExpectationError";
  }
}

export interface AccountingIntentExpectationRecord {
  expectation_id: string;
  tenant_id: string;
  intent_id: string;
  envelope_json: string;
  expected_sha256: string;
  omits_identity: number;
  bound_at: string;
}

/**
 * Record the envelope an intent's `expected_sha256` was taken over.
 *
 * Idempotent on `(tenant, intent)`: `deriveAccountingIntent` is itself idempotent on the basis
 * hash and returns the stored row rather than failing, so a re-derivation must re-write nothing.
 */
export async function recordAccountingIntentExpectation(
  env: AppEnv,
  input: { tenantId: string; intentId: string; envelope: unknown },
  now: Date = new Date(),
): Promise<AccountingIntentExpectationRecord> {
  const envelopeJson = canonicalJson(input.envelope);
  const expectedSha256 = await sha256Hex(envelopeJson);
  await env.DB.prepare(
    `INSERT INTO accounting_intent_expectations (
       expectation_id, tenant_id, intent_id, envelope_json, expected_sha256, omits_identity,
       bound_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, intent_id) DO NOTHING`,
  ).bind(
    crypto.randomUUID(), input.tenantId, input.intentId, envelopeJson, expectedSha256,
    envelopeOmitsIdentity(input.envelope) ? 1 : 0, now.toISOString(),
  ).run();

  const stored = await readAccountingIntentExpectation(env, input.tenantId, input.intentId);
  if (!stored) throw new AccountingExpectationError("accounting_intent_expectation_write_failed");
  return stored;
}

export async function readAccountingIntentExpectation(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<AccountingIntentExpectationRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM accounting_intent_expectations WHERE tenant_id = ? AND intent_id = ?`,
  ).bind(tenantId, intentId).first<AccountingIntentExpectationRecord>();
}

/**
 * The envelope `submitAccountingIntent` has to be handed, parsed back from storage.
 *
 * Null when the intent predates this table, which the dispatcher reports as `expectation_unbound`
 * rather than guessing: dispatching money against an expectation nobody bound would be worse than
 * leaving it in the queue for a human to look at.
 */
export async function readDerivedExpectationEnvelope(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<unknown | null> {
  const row = await readAccountingIntentExpectation(env, tenantId, intentId);
  if (!row) return null;
  try {
    return JSON.parse(row.envelope_json) as unknown;
  } catch {
    return null;
  }
}

/** True when this intent bound an identity-free expectation, so its entity is one IronWrap creates. */
export async function expectationOmitsIdentity(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<boolean> {
  const row = await readAccountingIntentExpectation(env, tenantId, intentId);
  return row?.omits_identity === 1;
}

/**
 * Hash one observation on the same basis as the intent's expectation.
 *
 * The observation row's own `observed_sha256` for an intent that bound a complete envelope, and
 * the same fact set minus `Id` for one that bound an identity-free expectation. The stored
 * observation is never modified: it is evidence of what the provider returned, and evidence is not
 * trimmed to make a comparison come out.
 */
export async function comparableObservedSha256(
  env: AppEnv,
  intent: AccountingIntentRecord,
  observation: AccountingObservationRecord,
): Promise<string> {
  return await observedSha256OnBasis(
    observation,
    await expectationOmitsIdentity(env, intent.tenant_id, intent.intent_id),
  );
}

/** The same hash, for a caller that has already read which basis the expectation bound. */
export async function observedSha256OnBasis(
  observation: AccountingObservationRecord,
  omitsIdentity: boolean,
): Promise<string> {
  if (!omitsIdentity) return observation.observed_sha256;
  let facts: Record<string, unknown>;
  try {
    const parsed = JSON.parse(observation.facts_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return observation.observed_sha256;
    }
    facts = { ...(parsed as Record<string, unknown>) };
  } catch {
    return observation.observed_sha256;
  }
  delete facts.Id;
  // The same envelope shape `providerFactEnvelope` produces, so the two hashes are taken over one
  // structure and can only differ because the facts differ.
  return await sha256Hex(canonicalJson({
    realmId: observation.realm_id,
    entityType: observation.entity_type,
    facts,
  }));
}

/** An envelope binds no identity when its fact set names no `Id`. */
function envelopeOmitsIdentity(envelope: unknown): boolean {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;
  const facts = (envelope as Record<string, unknown>).facts;
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return false;
  return (facts as Record<string, unknown>).Id === undefined;
}
