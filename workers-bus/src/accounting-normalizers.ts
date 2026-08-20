// accounting-normalizers.ts - the normalized comparison fact sets of contract section 5.2.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md slice S3. Reconciliation is defined as an equality
// between two SHA-256 hashes (section 5.1), so the only thing that decides whether money
// reconciles is which provider fields are hashed. That decision lives here, as data, once.
//
// Two descriptors per entity, deliberately separate:
//
//   * `COMPARISON_FIELDS` - hashed into `observed_sha256`. Anything absent from it is ignored, so
//     `SyncToken`, `MetaData.LastUpdatedTime` and display names can churn without manufacturing a
//     false mismatch (section 5.2).
//   * `SETTLEMENT_FIELDS` - read for the cumulative settlement invariant, never hashed. `Balance`
//     is the reason the two lists differ: section 5.4 requires an invoice to reach `reconciled`
//     only when `Balance == 0`, and hashing a balance that legitimately changes as payments land
//     would turn every partial payment into a mismatch.
//
// `test/accounting-normalizers.test.ts` records the paths each function actually touches through a
// Proxy and asserts the read set equals its descriptor, in both directions. That is the contract
// conformance check section 9 asks for: it catches a normalizer that quietly depends on an
// undocumented field, and a descriptor that documents a field nobody reads.
//
// Path note. Section 5.2 writes an invoice line's item and tax code as `Line[].ItemRef.value` and
// `Line[].TaxCodeRef.value`; Intuit nests both inside the line's detail object
// (`SalesItemLineDetail`, `JournalEntryLineDetail`). The descriptors below pin the real provider
// paths for the facts the contract names - same facts, the shape Intuit actually returns, which is
// what the synthetic fixtures have to look like to be worth anything.

import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export const ACCOUNTING_ENTITY_TYPES = [
  "Invoice", "Payment", "CreditMemo", "RefundReceipt", "JournalEntry", "TimeActivity", "TaxRate",
] as const;

export type AccountingEntityType = (typeof ACCOUNTING_ENTITY_TYPES)[number];

export class AccountingNormalizerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "AccountingNormalizerError";
  }
}

/**
 * The hashed fact set per entity, in contract section 5.2 order. A `[]` segment iterates an array
 * and collects the remainder of the path from every element.
 */
export const COMPARISON_FIELDS: Readonly<Record<AccountingEntityType, readonly string[]>> = {
  Invoice: [
    "Id", "CustomerRef.value", "CurrencyRef.value", "TxnDate", "DueDate", "TotalAmt",
    "TxnTaxDetail.TotalTax", "Line[].DetailType", "Line[].Amount",
    "Line[].SalesItemLineDetail.ItemRef.value", "Line[].SalesItemLineDetail.TaxCodeRef.value",
  ],
  Payment: [
    "Id", "CustomerRef.value", "CurrencyRef.value", "TxnDate", "TotalAmt", "UnappliedAmt",
    "Line[].Amount", "Line[].LinkedTxn[].TxnId", "Line[].LinkedTxn[].TxnType",
  ],
  // "as Invoice, plus RemainingCredit".
  CreditMemo: [
    "Id", "CustomerRef.value", "CurrencyRef.value", "TxnDate", "DueDate", "TotalAmt",
    "TxnTaxDetail.TotalTax", "Line[].DetailType", "Line[].Amount",
    "Line[].SalesItemLineDetail.ItemRef.value", "Line[].SalesItemLineDetail.TaxCodeRef.value",
    "RemainingCredit",
  ],
  RefundReceipt: [
    "Id", "CustomerRef.value", "TxnDate", "TotalAmt", "DepositToAccountRef.value", "Line[].Amount",
  ],
  JournalEntry: [
    "Id", "TxnDate", "Line[].Amount", "Line[].JournalEntryLineDetail.PostingType",
    "Line[].JournalEntryLineDetail.AccountRef.value",
  ],
  TimeActivity: [
    "Id", "EmployeeRef.value", "TxnDate", "Hours", "Minutes", "CustomerRef.value",
  ],
  TaxRate: [
    "Id", "RateValue", "EffectiveTaxRate[].RateValue", "EffectiveTaxRate[].EffectiveDate",
    "EffectiveTaxRate[].EndDate",
  ],
};

/**
 * The unhashed facts the settlement invariant reads (section 5.4).
 *
 * Empty for the entity types that carry no settlement target: a journal entry, a time activity and
 * a tax rate are settled by existing. `extractSettlementFacts` reads nothing at all from them, and
 * the conformance test asserts that in both directions.
 */
export const SETTLEMENT_FIELDS: Readonly<Record<AccountingEntityType, readonly string[]>> = {
  Invoice: ["TotalAmt", "Balance"],
  Payment: [
    "TotalAmt", "UnappliedAmt", "Line[].Amount", "Line[].LinkedTxn[].TxnId",
    "Line[].LinkedTxn[].TxnType",
  ],
  CreditMemo: ["TotalAmt"],
  RefundReceipt: ["TotalAmt"],
  JournalEntry: [],
  TimeActivity: [],
  TaxRate: [],
};

/** Money fields. Read as exact two-place decimal strings, never as floats (section 7.2). */
const MONEY_LEAVES = new Set([
  "TotalAmt", "Amount", "Balance", "UnappliedAmt", "RemainingCredit", "TotalTax",
]);

/** Rate fields. Four decimal places, matching `tax_policy_snapshots.rate_percent`. */
const RATE_LEAVES = new Set(["RateValue"]);

export interface NormalizedEntityFacts {
  realmId: string;
  entityType: AccountingEntityType;
  entityId: string;
  /** Canonical, descriptor-shaped, deterministic. This is what gets hashed. */
  facts: Record<string, unknown>;
}

/**
 * Project one provider payload onto its comparison fact set.
 *
 * `realmId` is part of the identity every observation records (section 5.1), so it is carried on
 * the result and hashed alongside the fields: an identical invoice id in a different company is
 * not the same entity.
 */
export function normalizeProviderEntity(input: {
  realmId: string;
  entityType: AccountingEntityType;
  payload: unknown;
}): NormalizedEntityFacts {
  const fields = COMPARISON_FIELDS[input.entityType];
  if (!fields) throw new AccountingNormalizerError("provider_entity_type_unsupported");
  const facts = projectFields(input.payload, fields);
  const entityId = facts.Id;
  if (typeof entityId !== "string" || entityId.length === 0) {
    throw new AccountingNormalizerError("provider_entity_id_missing");
  }
  return { realmId: input.realmId, entityType: input.entityType, entityId, facts };
}

/**
 * The exact object both hashes are taken over.
 *
 * `deriveAccountingIntent` hashes whatever it is handed as `expected`, so an intent that wants to
 * be reconcilable has to bind THIS envelope - identity and facts together. Exporting the envelope
 * rather than leaving each caller to rebuild the same literal is what makes "expected and observed
 * are produced by one function" checkable instead of a comment.
 */
export function providerFactEnvelope(input: {
  realmId: string;
  entityType: AccountingEntityType;
  facts: Record<string, unknown>;
}): { realmId: string; entityType: AccountingEntityType; facts: Record<string, unknown> } {
  return { realmId: input.realmId, entityType: input.entityType, facts: input.facts };
}

/** The hash section 5.1 compares. Same canonical JSON helper the effect ledger already uses. */
export async function observedSha256(normalized: NormalizedEntityFacts): Promise<string> {
  return await sha256Hex(canonicalJson(providerFactEnvelope(normalized)));
}

/**
 * The expected hash for an intent, over the same envelope, so `expected_sha256` and
 * `observed_sha256` can only differ because the facts differ.
 */
export async function expectedSha256(input: {
  realmId: string;
  entityType: AccountingEntityType;
  /** The fact values the intent asserts should exist, keyed exactly like a comparison fact set. */
  facts: Record<string, unknown>;
}): Promise<string> {
  return await sha256Hex(canonicalJson(providerFactEnvelope(input)));
}

export interface SettlementLink {
  lineIndex: number;
  linkedTxnType: string;
  linkedTxnId: string;
  amountCents: number;
}

export interface SettlementFacts {
  totalCents: number | null;
  balanceCents: number | null;
  unappliedCents: number | null;
  links: readonly SettlementLink[];
}

/**
 * The unhashed inputs to the cumulative settlement invariant.
 *
 * Reads strictly what `SETTLEMENT_FIELDS` names for the entity type and nothing else, including
 * nothing at all for the types that carry no settlement target - so the conformance test can hold
 * this function to the same standard as the hashing normalizer.
 */
export function extractSettlementFacts(
  entityType: AccountingEntityType,
  payload: unknown,
): SettlementFacts {
  const record = asRecord(payload);
  switch (entityType) {
    case "Invoice":
      return {
        totalCents: centsFromDecimal(moneyDecimal(record?.["TotalAmt"])),
        balanceCents: centsFromDecimal(moneyDecimal(record?.["Balance"])),
        unappliedCents: null,
        links: [],
      };
    case "Payment":
      return {
        totalCents: centsFromDecimal(moneyDecimal(record?.["TotalAmt"])),
        balanceCents: null,
        unappliedCents: centsFromDecimal(moneyDecimal(record?.["UnappliedAmt"])),
        links: paymentSettlementLinks(record),
      };
    case "CreditMemo":
    case "RefundReceipt":
      return {
        totalCents: centsFromDecimal(moneyDecimal(record?.["TotalAmt"])),
        balanceCents: null,
        unappliedCents: null,
        links: [],
      };
    default:
      return { totalCents: null, balanceCents: null, unappliedCents: null, links: [] };
  }
}

/**
 * One link per settleable transaction a payment line applies to.
 *
 * A line that applies to more than one invoice carries no per-invoice split, so attributing the
 * line amount to each of them would invent settlement that was never observed. That is refused
 * rather than guessed: over-counting here would silently manufacture an over-payment exception.
 */
function paymentSettlementLinks(record: Record<string, unknown> | null): SettlementLink[] {
  const links: SettlementLink[] = [];
  asArray(record?.["Line"]).forEach((line, lineIndex) => {
    const lineRecord = asRecord(line);
    const amountCents = centsFromDecimal(moneyDecimal(lineRecord?.["Amount"]));
    const settleable = asArray(lineRecord?.["LinkedTxn"])
      .map((entry) => asRecord(entry))
      .filter((entry) => typeof entry?.["TxnType"] === "string");
    if (settleable.filter((entry) => entry?.["TxnType"] === "Invoice").length > 1) {
      throw new AccountingNormalizerError("provider_payment_line_ambiguous");
    }
    for (const entry of settleable) {
      const txnId = entry?.["TxnId"];
      if (typeof txnId !== "string" || amountCents === null) continue;
      links.push({
        lineIndex,
        linkedTxnType: String(entry?.["TxnType"]),
        linkedTxnId: txnId,
        amountCents,
      });
    }
  });
  return links;
}

/**
 * Exact two-place decimal from whatever the provider sent.
 *
 * Refuses anything that cannot be represented exactly rather than rounding: a rounded cent in an
 * accounting comparison is a mismatch that never surfaces, which is worse than a loud refusal.
 */
export function moneyDecimal(value: unknown): string | null {
  return fixedDecimal(value, 2, "provider_amount_invalid");
}

/** Exact four-place decimal, the shape `tax_policy_snapshots.rate_percent` stores. */
export function rateDecimal(value: unknown): string | null {
  return fixedDecimal(value, 4, "provider_rate_invalid");
}

/** Integer cents from a two-place decimal string. Exact: the string always has two places. */
export function centsFromDecimal(value: string | null): number | null {
  if (value === null) return null;
  return Number.parseInt(value.replace(".", ""), 10);
}

/** Two-place decimal string from integer cents, including the sign. */
export function decimalFromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const magnitude = Math.abs(cents);
  return `${sign}${Math.trunc(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
}

/** Integer ten-thousandths from a four-place rate string, for exact rate comparison. */
export function rateUnitsFromDecimal(value: string): number {
  return Number.parseInt(value.replace(".", ""), 10);
}

function fixedDecimal(value: unknown, places: number, errorCode: string): string | null {
  if (value === null || value === undefined) return null;
  const scale = 10 ** places;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AccountingNormalizerError(errorCode);
    const scaled = value * scale;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6 || !Number.isSafeInteger(rounded)) {
      throw new AccountingNormalizerError(errorCode);
    }
    return formatScaled(rounded, places);
  }
  if (typeof value === "string") {
    const match = value.match(/^(-?)(\d+)(?:\.(\d+))?$/);
    if (!match) throw new AccountingNormalizerError(errorCode);
    const fraction = match[3] ?? "";
    if (fraction.length > places) throw new AccountingNormalizerError(errorCode);
    const scaled = Number.parseInt(`${match[2]}${fraction.padEnd(places, "0")}`, 10);
    if (!Number.isSafeInteger(scaled)) throw new AccountingNormalizerError(errorCode);
    return formatScaled(match[1] === "-" ? -scaled : scaled, places);
  }
  throw new AccountingNormalizerError(errorCode);
}

function formatScaled(scaled: number, places: number): string {
  const sign = scaled < 0 ? "-" : "";
  const magnitude = String(Math.abs(scaled)).padStart(places + 1, "0");
  return `${sign}${magnitude.slice(0, -places)}.${magnitude.slice(-places)}`;
}

/**
 * Read exactly the descriptor's paths and nothing else.
 *
 * Every path becomes a key in the result whether or not the payload carries it, so a fact set has
 * one deterministic shape per entity type: an absent field is an explicit `null`, not a key that
 * silently disappears and changes the hash for a reason nobody can see.
 */
function projectFields(payload: unknown, fields: readonly string[]): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const field of fields) facts[field] = readPath(payload, field.split("."));
  return facts;
}

function readPath(value: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) return leafValue(value, "");
  const [head, ...rest] = segments;
  if (head.endsWith("[]")) {
    const array = asArray(asRecord(value)?.[head.slice(0, -2)]);
    return array.map((element) => readPath(element, rest));
  }
  const next = asRecord(value)?.[head];
  if (rest.length === 0) return leafValue(next, head);
  return readPath(next, rest);
}

function leafValue(value: unknown, name: string): unknown {
  if (value === undefined) return null;
  if (MONEY_LEAVES.has(name)) return moneyDecimal(value);
  if (RATE_LEAVES.has(name)) return rateDecimal(value);
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  // A comparison leaf is a scalar by construction; an object here means the descriptor and the
  // provider disagree about the shape, which is exactly what the conformance test exists to catch.
  throw new AccountingNormalizerError("provider_entity_shape_invalid");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
