// pricing.ts - price a verified takeoff into a reproducible commercial estimate.
//
// Approved pricing uses integer cents and basis points. Quantities are converted
// to exact decimal fractions before multiplication, then rounded half-up once at
// the named cent boundary. The historical dollar/percent shape remains accepted
// only for the Estimator Workbench read projection and is always marked for
// review; it is not an approved commercial input.

import type { TakeoffModel } from "./takeoff.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export interface PriceLine {
  kind: "panel" | "trim" | "fastener" | "labor";
  sku: string;
  description: string;
  qty: number;
  unit: string;
  /** Backward-compatible dollar projection. */
  rate: number;
  /** Canonical monetary values. */
  rateCents: number;
  amount: number;
  amountCents: number;
  /** Source of the measured/billable quantity. */
  quantitySourceRef: string;
  /** Source of the approved rate; null only for legacy read-only pricing. */
  rateSourceRef: string | null;
  /** Backward-compatible combined provenance projection. */
  sourceRef: string;
}

interface LegacyOrCentsRate {
  /** Legacy read-only dollars; approved policies reject this field. */
  rate?: number;
  /** Approved unit rate in integer cents. */
  rateCents?: number;
  /** Required for approved rates, including explicit zero-cent inclusions. */
  sourceRef?: string;
}

export interface ApprovedPricingPolicyV1 {
  schemaVersion: "ironwrap.pricing-policy.v1";
  /** Tenant binding prevents a policy approved on one Frappe site from crossing tenants. */
  tenantId: string;
  policyId: string;
  revision: number;
  /** Inclusive UTC instants. Callers must also provide the explicit pricedAt input. */
  effectiveAt: string;
  expiresAt: string;
  pricing: {
    method: "markup" | "gross_margin";
    rateBps: number;
  };
  /** Applied before contingency and pricing uplift. */
  freightCents: number;
  /** Applied to line cost plus freight. */
  contingencyRateBps: number;
  /** Applied after pricing uplift and before tax. */
  minimumChargeCents: number;
  /** Applied to the final pre-tax amount. */
  taxRateBps: number;
}

export interface PriceList {
  currency: string;
  panel: LegacyOrCentsRate & {
    sku: string;
    description?: string;
    /** Price panels by linear foot (cut list) or square foot (coverage). */
    unit: "lf" | "sqft";
  };
  /** Trim profile name (takeoff's) -> pricing. Missing profiles flag the estimate. */
  trims: Record<string, LegacyOrCentsRate & {
    sku: string;
    description?: string;
    unit?: "stick" | "lf";
  }>;
  fasteners?: Partial<Record<"clips" | "clipScrews" | "trimScrews", LegacyOrCentsRate & {
    sku: string;
    description?: string;
    per?: number;
  }>>;
  labor?: {
    sku: string;
    description?: string;
    /** Legacy read-only dollars. */
    ratePerSquare?: number;
    /** Approved rate in integer cents. */
    ratePerSquareCents?: number;
  };
  approvedPolicy?: ApprovedPricingPolicyV1;
  /** Legacy read-only percentage. Mutually exclusive with approvedPolicy. */
  markupPct?: number;
  /** Legacy read-only percentage. Mutually exclusive with approvedPolicy. */
  taxPct?: number;
}

export interface CommercialTruth {
  mode: "approved_policy" | "read_only_legacy";
  policyVersion: "ironwrap.pricing-policy.v1" | null;
  policyId: string | null;
  policyRevision: number | null;
  policySnapshotSha256: string | null;
  pricedAt: string | null;
  effectiveAt: string | null;
  expiresAt: string | null;
  pricingMethod: "markup" | "gross_margin";
  pricingRateBps: number;
  lineCostCents: number;
  freightCents: number;
  contingencyRateBps: number;
  contingencyCents: number;
  costCents: number;
  minimumChargeCents: number;
  minimumChargeAdjustmentCents: number;
  markupAmountCents: number;
  markupRateBps: number | null;
  grossMarginAmountCents: number;
  grossMarginRateBps: number;
  taxBaseCents: number;
  taxRateBps: number;
  taxCents: number;
  totalCents: number;
}

export interface PricedEstimate {
  currency: string;
  lines: PriceLine[];
  /** Backward-compatible dollar projections, all derived from canonical cents. */
  subtotal: number;
  cost: number;
  freight: number;
  contingency: number;
  minimumCharge: number;
  minimumChargeAdjustment: number;
  markup: number;
  markupRatePct: number | null;
  grossMargin: number;
  grossMarginRatePct: number;
  taxBase: number;
  taxRatePct: number;
  tax: number;
  total: number;
  expiresAt: string | null;
  commercial: CommercialTruth;
  /** Trim profiles present in the takeoff but absent from the price list. */
  unpricedProfiles: string[];
  needsReview: boolean;
  sourceRefs: Record<string, string>;
}

export interface PricingContext {
  /** Required for approved policy evaluation; never inferred from wall-clock time. */
  pricedAt?: string;
  /** Created only by verifyPricingAuthority after persisted Frappe evidence matches. */
  authority?: VerifiedPricingAuthority;
}

/** Bounded Frappe read projection used to verify one composite policy anchor. */
export interface PricingAuthorityRule {
  name?: unknown;
  status?: unknown;
  rule_type?: unknown;
  currency?: unknown;
  source_ref?: unknown;
  rule_json?: unknown;
  effective_from?: unknown;
  effective_to?: unknown;
  approved_by?: unknown;
  approved_at?: unknown;
  pricing_policy_id?: unknown;
  pricing_policy_revision?: unknown;
  pricing_policy_snapshot_json?: unknown;
  pricing_policy_snapshot_sha256?: unknown;
}

/**
 * Runtime authority token. Its shape is intentionally visible for audit output,
 * but priceTakeoff accepts only instances minted into this module's private WeakSet.
 */
export interface VerifiedPricingAuthority {
  readonly policyId: string;
  readonly policyRevision: number;
  readonly tenantId: string;
  readonly pricedAt: string;
  readonly canonicalSnapshot: string;
  readonly snapshotSha256: string;
  readonly priceRuleName: string;
}

type UnknownRecord = Record<string, unknown>;
type Fraction = { numerator: bigint; denominator: bigint };

const MONEY_SCALE = 100n;
const BPS_SCALE = 10_000n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_APPROVED_PRICING_SNAPSHOT_BYTES = 64 * 1024;
const APPROVED_POLICY_KEYS = [
  "schemaVersion",
  "tenantId",
  "policyId",
  "revision",
  "effectiveAt",
  "expiresAt",
  "pricing",
  "freightCents",
  "contingencyRateBps",
  "minimumChargeCents",
  "taxRateBps",
] as const;
const APPROVED_PRICE_LIST_KEYS = [
  "currency",
  "panel",
  "trims",
  "fasteners",
  "labor",
  "approvedPolicy",
] as const;
const POLICY_AUTHORITY_RULE_CONTRACT = {
  schema_version: "ironwrap.price-policy-authority.v1",
  operation: "bind_canonical_pricing_snapshot",
} as const;
const verifiedPricingAuthorities = new WeakSet<object>();

function fail(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`);
}

function asRecord(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as UnknownRecord;
}

function rejectUnknownKeys(value: UnknownRecord, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(path, `unknown keys: ${unknown.sort().join(", ")}`);
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) fail(path, "must be a non-empty string");
  return value;
}

function requireIdentifier(value: unknown, path: string): string {
  const identifier = requireText(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(identifier)) {
    fail(path, "must be a bounded identifier");
  }
  return identifier;
}

function requireCurrency(value: unknown): string {
  const currency = requireText(value, "priceList.currency");
  if (!/^[A-Z]{3}$/.test(currency)) fail("priceList.currency", "must be a three-letter uppercase currency code");
  return currency;
}

function requireNonnegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(path, "must be a finite nonnegative number");
  }
  return value;
}

function requireNonnegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(path, "must be a nonnegative safe integer");
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, path: string): number {
  const result = requireNonnegativeSafeInteger(value, path);
  if (result === 0) fail(path, "must be greater than zero");
  return result;
}

function requireInstant(value: unknown, path: string): string {
  const instant = requireText(value, path);
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== instant) {
    fail(path, "must be a canonical UTC instant such as 2026-08-13T12:00:00.000Z");
  }
  return instant;
}

function decimalFraction(value: number, path: string): Fraction {
  requireNonnegativeNumber(value, path);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(value.toString().toLowerCase());
  if (!match) fail(path, "must have a deterministic decimal representation");
  const fractionDigits = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  let numerator = BigInt(`${match[1]}${fractionDigits}`);
  const scale = fractionDigits.length - exponent;
  if (scale <= 0) {
    numerator *= 10n ** BigInt(-scale);
    return { numerator, denominator: 1n };
  }
  return { numerator, denominator: 10n ** BigInt(scale) };
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function safeInteger(value: bigint, path: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) fail(path, "exceeds safe integer cents");
  return Number(value);
}

function dollarsToCents(value: number, path: string): number {
  const fraction = decimalFraction(value, path);
  const scaled = fraction.numerator * MONEY_SCALE;
  if (scaled % fraction.denominator !== 0n) {
    fail(path, "must not contain fractions of a cent");
  }
  return safeInteger(scaled / fraction.denominator, path);
}

function percentageToBps(value: number | undefined, path: string): number {
  if (value === undefined) return 0;
  const fraction = decimalFraction(value, path);
  const scaled = fraction.numerator * 100n;
  if (scaled % fraction.denominator !== 0n) {
    fail(path, "must not contain fractions of a basis point");
  }
  return safeInteger(scaled / fraction.denominator, path);
}

function multiplyCents(rateCents: number, quantity: number, path: string): number {
  const fraction = decimalFraction(quantity, `${path}.qty`);
  return safeInteger(
    roundHalfUp(BigInt(rateCents) * fraction.numerator, fraction.denominator),
    `${path}.amountCents`,
  );
}

function applyBps(baseCents: number, rateBps: number, path: string): number {
  return safeInteger(
    roundHalfUp(BigInt(baseCents) * BigInt(rateBps), BPS_SCALE),
    path,
  );
}

function addCents(values: number[], path: string): number {
  return safeInteger(values.reduce((sum, value) => sum + BigInt(value), 0n), path);
}

function dollars(cents: number): number {
  return cents / 100;
}

function actualRateBps(amountCents: number, baseCents: number): number | null {
  if (baseCents === 0) return amountCents === 0 ? 0 : null;
  return safeInteger(
    roundHalfUp(BigInt(amountCents) * BPS_SCALE, BigInt(baseCents)),
    "commercial.rateBps",
  );
}

function rateCents(
  config: UnknownRecord,
  legacyField: string,
  centsField: string,
  approved: boolean,
  path: string,
): number {
  const legacy = config[legacyField];
  const cents = config[centsField];
  if (legacy !== undefined && cents !== undefined) fail(path, "dollar and cent rates are ambiguous");
  if (approved) {
    if (legacy !== undefined) fail(`${path}.${legacyField}`, "approved pricing requires integer cents");
    return requireNonnegativeSafeInteger(cents, `${path}.${centsField}`);
  }
  if (cents !== undefined) return requireNonnegativeSafeInteger(cents, `${path}.${centsField}`);
  return dollarsToCents(requireNonnegativeNumber(legacy, `${path}.${legacyField}`), `${path}.${legacyField}`);
}

function validateRateObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  approved: boolean,
  legacyField = "rate",
  centsField = "rateCents",
): { record: UnknownRecord; cents: number; sourceRef: string | null } {
  const record = asRecord(value, path);
  if (approved) rejectUnknownKeys(record, allowedKeys, path);
  if (approved) requireIdentifier(record.sku, `${path}.sku`);
  else requireText(record.sku, `${path}.sku`);
  if (record.description !== undefined && typeof record.description !== "string") {
    fail(`${path}.description`, "must be a string");
  }
  return {
    record,
    cents: rateCents(record, legacyField, centsField, approved, path),
    sourceRef: approved
      ? requireIdentifier(record.sourceRef, `${path}.sourceRef`)
      : typeof record.sourceRef === "string" && record.sourceRef.trim()
        ? record.sourceRef
        : null,
  };
}

function validateApprovedPolicy(value: unknown, pricedAtInput: unknown): {
  policy: ApprovedPricingPolicyV1;
  pricedAt: string;
} {
  const policy = asRecord(value, "priceList.approvedPolicy");
  rejectUnknownKeys(policy, APPROVED_POLICY_KEYS, "priceList.approvedPolicy");
  if (policy.schemaVersion !== "ironwrap.pricing-policy.v1") {
    fail("priceList.approvedPolicy.schemaVersion", "unsupported pricing policy version");
  }
  const tenantId = requireIdentifier(policy.tenantId, "priceList.approvedPolicy.tenantId");
  const policyId = requireIdentifier(policy.policyId, "priceList.approvedPolicy.policyId");
  const revision = requirePositiveSafeInteger(
    policy.revision,
    "priceList.approvedPolicy.revision",
  );
  const pricing = asRecord(policy.pricing, "priceList.approvedPolicy.pricing");
  rejectUnknownKeys(pricing, ["method", "rateBps"], "priceList.approvedPolicy.pricing");
  if (pricing.method !== "markup" && pricing.method !== "gross_margin") {
    fail("priceList.approvedPolicy.pricing.method", "must be markup or gross_margin");
  }
  const rateBps = requireNonnegativeSafeInteger(
    pricing.rateBps,
    "priceList.approvedPolicy.pricing.rateBps",
  );
  if (pricing.method === "gross_margin" && rateBps >= 10_000) {
    fail("priceList.approvedPolicy.pricing.rateBps", "gross margin must be below 10000 bps");
  }
  const effectiveAt = requireInstant(policy.effectiveAt, "priceList.approvedPolicy.effectiveAt");
  const expiresAt = requireInstant(policy.expiresAt, "priceList.approvedPolicy.expiresAt");
  const pricedAt = requireInstant(pricedAtInput, "pricingContext.pricedAt");
  if (effectiveAt > expiresAt) fail("priceList.approvedPolicy", "effectiveAt must not follow expiresAt");
  if (pricedAt < effectiveAt || pricedAt > expiresAt) {
    fail("pricingContext.pricedAt", "approved pricing policy is not effective at this instant");
  }
  return {
    policy: {
      schemaVersion: "ironwrap.pricing-policy.v1",
      tenantId,
      policyId,
      revision,
      effectiveAt,
      expiresAt,
      pricing: { method: pricing.method, rateBps },
      freightCents: requireNonnegativeSafeInteger(policy.freightCents, "priceList.approvedPolicy.freightCents"),
      contingencyRateBps: requireNonnegativeSafeInteger(
        policy.contingencyRateBps,
        "priceList.approvedPolicy.contingencyRateBps",
      ),
      minimumChargeCents: requireNonnegativeSafeInteger(
        policy.minimumChargeCents,
        "priceList.approvedPolicy.minimumChargeCents",
      ),
      taxRateBps: requireNonnegativeSafeInteger(policy.taxRateBps, "priceList.approvedPolicy.taxRateBps"),
    },
    pricedAt,
  };
}

function validateApprovedPricingCandidate(
  list: PriceList,
  pricedAtInput: unknown,
): {
  canonicalSnapshot: string;
  currency: string;
  policy: ApprovedPricingPolicyV1;
  pricedAt: string;
} {
  const priceList = asRecord(list, "priceList");
  rejectUnknownKeys(priceList, APPROVED_PRICE_LIST_KEYS, "priceList");
  const currency = requireCurrency(priceList.currency);
  const approved = validateApprovedPolicy(priceList.approvedPolicy, pricedAtInput);
  const panel = validateRateObject(
    priceList.panel,
    "priceList.panel",
    ["sku", "unit", "rate", "rateCents", "sourceRef"],
    true,
  );
  if (panel.record.unit !== "lf" && panel.record.unit !== "sqft") {
    fail("priceList.panel.unit", "must be lf or sqft");
  }
  const trims = asRecord(priceList.trims, "priceList.trims");
  if (Object.keys(trims).length > 128) fail("priceList.trims", "must contain at most 128 profiles");
  for (const profile of Object.keys(trims).sort()) {
    requireIdentifier(profile, `priceList.trims.${profile}`);
    const trim = validateRateObject(
      trims[profile],
      `priceList.trims.${profile}`,
      ["sku", "unit", "rate", "rateCents", "sourceRef"],
      true,
    );
    if (trim.record.unit !== undefined && trim.record.unit !== "stick" && trim.record.unit !== "lf") {
      fail(`priceList.trims.${profile}.unit`, "must be stick or lf");
    }
  }
  if (priceList.fasteners !== undefined) {
    const fasteners = asRecord(priceList.fasteners, "priceList.fasteners");
    rejectUnknownKeys(fasteners, ["clips", "clipScrews", "trimScrews"], "priceList.fasteners");
    for (const key of ["clips", "clipScrews", "trimScrews"] as const) {
      if (fasteners[key] === undefined) continue;
      const fastener = validateRateObject(
        fasteners[key],
        `priceList.fasteners.${key}`,
        ["sku", "per", "rate", "rateCents", "sourceRef"],
        true,
      );
      if (fastener.record.per !== undefined) {
        requirePositiveSafeInteger(fastener.record.per, `priceList.fasteners.${key}.per`);
      }
    }
  }
  if (priceList.labor !== undefined) {
    validateRateObject(
      priceList.labor,
      "priceList.labor",
      ["sku", "ratePerSquare", "ratePerSquareCents", "sourceRef"],
      true,
      "ratePerSquare",
      "ratePerSquareCents",
    );
  }
  const canonicalSnapshot = canonicalJson(priceList);
  if (new TextEncoder().encode(canonicalSnapshot).byteLength > MAX_APPROVED_PRICING_SNAPSHOT_BYTES) {
    fail("priceList", "approved pricing snapshot exceeds 64 KiB");
  }
  return {
    canonicalSnapshot,
    currency,
    policy: approved.policy,
    pricedAt: approved.pricedAt,
  };
}

/** Produce the exact bytes and digest a human approves and Frappe persists. */
export async function approvedPricingPolicySnapshot(
  list: PriceList,
  pricedAt: string,
): Promise<{
  canonicalSnapshot: string;
  snapshotSha256: string;
  tenantId: string;
  policyId: string;
  policyRevision: number;
}> {
  const candidate = validateApprovedPricingCandidate(list, pricedAt);
  return {
    canonicalSnapshot: candidate.canonicalSnapshot,
    snapshotSha256: await sha256Hex(candidate.canonicalSnapshot),
    tenantId: candidate.policy.tenantId,
    policyId: candidate.policy.policyId,
    policyRevision: candidate.policy.revision,
  };
}

/** Parse only after validating the complete closed candidate; this does not authorize it. */
export function approvedPricingPolicyIdentity(
  list: PriceList,
  pricedAt: string,
): { tenantId: string; policyId: string; policyRevision: number } {
  const candidate = validateApprovedPricingCandidate(list, pricedAt);
  return {
    tenantId: candidate.policy.tenantId,
    policyId: candidate.policy.policyId,
    policyRevision: candidate.policy.revision,
  };
}

function exactJsonObject(raw: unknown): UnknownRecord | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return canonicalJson(parsed) === raw ? parsed as UnknownRecord : null;
  } catch {
    return null;
  }
}

function ruleDate(value: unknown): string | null {
  const date = typeof value === "string" ? value.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
    ? date
    : null;
}

function frappeUtcInstant(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return null;
  }
  const instant = `${value.replace(" ", "T")}.000Z`;
  const parsed = new Date(instant);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === instant ? instant : null;
}

function validFrappeApprover(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 254 || /\s/.test(value)) return false;
  return value === "Administrator" || /^[^@]+@[^@]+\.[^@]+$/.test(value);
}

/**
 * Mint an authority token only from one exact, current, human-approved Frappe
 * policy anchor whose canonical snapshot bytes and SHA match the candidate.
 */
export async function verifyPricingAuthority(
  list: PriceList,
  rules: readonly PricingAuthorityRule[],
  context: { pricedAt: string; tenantId: string },
): Promise<VerifiedPricingAuthority | null> {
  let candidate: ReturnType<typeof validateApprovedPricingCandidate>;
  try {
    candidate = validateApprovedPricingCandidate(list, context.pricedAt);
  } catch {
    return null;
  }
  if (candidate.policy.tenantId !== context.tenantId || rules.length !== 1) return null;
  const [rule] = rules;
  const snapshot = exactJsonObject(rule.pricing_policy_snapshot_json);
  const ruleContract = exactJsonObject(rule.rule_json);
  const snapshotSha256 = typeof rule.pricing_policy_snapshot_sha256 === "string"
    ? rule.pricing_policy_snapshot_sha256
    : "";
  const effectiveFrom = ruleDate(rule.effective_from);
  const effectiveTo = ruleDate(rule.effective_to);
  const pricedDate = candidate.pricedAt.slice(0, 10);
  const approvedAt = frappeUtcInstant(rule.approved_at);
  const revision = typeof rule.pricing_policy_revision === "number"
    ? rule.pricing_policy_revision
    : Number(rule.pricing_policy_revision);
  const snapshotDigest = await sha256Hex(candidate.canonicalSnapshot);
  if (
    rule.status !== "Approved" ||
    rule.rule_type !== "Pricing Policy" ||
    rule.currency !== candidate.currency ||
    typeof rule.source_ref !== "string" || !rule.source_ref.trim() ||
    !validFrappeApprover(rule.approved_by) ||
    approvedAt === null || approvedAt > candidate.pricedAt ||
    rule.pricing_policy_id !== candidate.policy.policyId ||
    !Number.isSafeInteger(revision) || revision !== candidate.policy.revision ||
    snapshot === null || rule.pricing_policy_snapshot_json !== candidate.canonicalSnapshot ||
    snapshotSha256 !== snapshotDigest || !/^[0-9a-f]{64}$/.test(snapshotSha256) ||
    ruleContract === null ||
    canonicalJson(ruleContract) !== canonicalJson(POLICY_AUTHORITY_RULE_CONTRACT) ||
    effectiveFrom !== candidate.policy.effectiveAt.slice(0, 10) ||
    effectiveTo !== candidate.policy.expiresAt.slice(0, 10) ||
    pricedDate < effectiveFrom || pricedDate > effectiveTo
  ) return null;
  const name = typeof rule.name === "string" && rule.name.trim() ? rule.name : null;
  if (!name) return null;
  const authority = Object.freeze({
    policyId: candidate.policy.policyId,
    policyRevision: candidate.policy.revision,
    tenantId: candidate.policy.tenantId,
    pricedAt: candidate.pricedAt,
    canonicalSnapshot: candidate.canonicalSnapshot,
    snapshotSha256,
    priceRuleName: name,
  });
  verifiedPricingAuthorities.add(authority);
  return authority;
}

/** Multiply verified takeoff quantities by a tenant price list. Pure and replayable. */
export function priceTakeoff(
  takeoff: TakeoffModel,
  list: PriceList,
  context: PricingContext = {},
): PricedEstimate {
  const priceList = asRecord(list, "priceList");
  const approved = priceList.approvedPolicy !== undefined;
  rejectUnknownKeys(
    priceList,
    approved
      ? APPROVED_PRICE_LIST_KEYS
      : ["currency", "panel", "trims", "fasteners", "labor", "markupPct", "taxPct"],
    "priceList",
  );
  const currency = requireCurrency(priceList.currency);
  const approvedResult = approved
    ? validateApprovedPricingCandidate(list, context.pricedAt)
    : null;
  const policy = approvedResult?.policy;
  const authority = context.authority;
  if (approved && (
    !authority ||
    !verifiedPricingAuthorities.has(authority) ||
    authority.tenantId !== policy?.tenantId ||
    authority.policyId !== policy?.policyId ||
    authority.policyRevision !== policy?.revision ||
    authority.pricedAt !== approvedResult?.pricedAt ||
    authority.canonicalSnapshot !== approvedResult?.canonicalSnapshot
  )) {
    fail("pricingContext.authority", "approved pricing requires exact verified persisted authority");
  }

  const panel = validateRateObject(
    priceList.panel,
    "priceList.panel",
    ["sku", "description", "unit", "rate", "rateCents", "sourceRef"],
    approved,
  );
  if (panel.record.unit !== "lf" && panel.record.unit !== "sqft") {
    fail("priceList.panel.unit", "must be lf or sqft");
  }
  const trims = asRecord(priceList.trims, "priceList.trims");
  const fasteners = priceList.fasteners === undefined
    ? undefined
    : asRecord(priceList.fasteners, "priceList.fasteners");
  if (fasteners) rejectUnknownKeys(fasteners, ["clips", "clipScrews", "trimScrews"], "priceList.fasteners");

  const lines: PriceLine[] = [];
  const sourceRefs: Record<string, string> = {};
  const pushLine = (
    kind: PriceLine["kind"],
    sku: string,
    description: string,
    qty: number,
    unit: string,
    unitRateCents: number,
    quantitySourceRef: string,
    rateSourceRef: string | null,
  ): void => {
    const amountCents = multiplyCents(unitRateCents, qty, `lines.${sku}`);
    lines.push({
      kind,
      sku,
      description,
      qty,
      unit,
      rate: dollars(unitRateCents),
      rateCents: unitRateCents,
      amount: dollars(amountCents),
      amountCents,
      quantitySourceRef,
      rateSourceRef,
      sourceRef: rateSourceRef
        ? `${quantitySourceRef} @ ${rateSourceRef}`
        : quantitySourceRef,
    });
  };

  const panelQty = panel.record.unit === "lf"
    ? requireNonnegativeNumber(takeoff.totals.panelFt, "takeoff.totals.panelFt")
    : requireNonnegativeNumber(takeoff.totals.panelAreaSqft, "takeoff.totals.panelAreaSqft");
  pushLine(
    "panel",
    String(panel.record.sku),
    typeof panel.record.description === "string" ? panel.record.description : "Roof panels",
    panelQty,
    String(panel.record.unit),
    panel.cents,
    panel.record.unit === "lf" ? "takeoff.totals.panelFt" : "takeoff.totals.panelAreaSqft",
    panel.sourceRef,
  );

  const unpricedProfiles: string[] = [];
  for (const trim of takeoff.trims) {
    const priced = trims[trim.profile];
    if (!priced) {
      if (approved && (trim.sticks > 0 || trim.totalFt > 0)) {
        fail(`priceList.trims.${trim.profile}`, "approved pricing requires an explicit rate for every nonzero trim category");
      }
      unpricedProfiles.push(trim.profile);
      continue;
    }
    const validated = validateRateObject(
      priced,
      `priceList.trims.${trim.profile}`,
      ["sku", "description", "unit", "rate", "rateCents", "sourceRef"],
      approved,
    );
    const unit = validated.record.unit ?? "stick";
    if (unit !== "stick" && unit !== "lf") fail(`priceList.trims.${trim.profile}.unit`, "must be stick or lf");
    const qty = requireNonnegativeNumber(
      unit === "stick" ? trim.sticks : trim.totalFt,
      `takeoff.trims.${trim.profile}.${unit === "stick" ? "sticks" : "totalFt"}`,
    );
    pushLine(
      "trim",
      String(validated.record.sku),
      typeof validated.record.description === "string"
        ? validated.record.description
        : `${trim.profile} trim`,
      qty,
      unit,
      validated.cents,
      `takeoff.trims[${trim.profile}].${unit === "stick" ? "sticks" : "totalFt"}`,
      validated.sourceRef,
    );
  }

  for (const key of ["clips", "clipScrews", "trimScrews"] as const) {
    const count = requireNonnegativeSafeInteger(takeoff.fasteners[key], `takeoff.fasteners.${key}`);
    const priced = fasteners?.[key];
    if (!priced) {
      if (approved && count > 0) {
        fail(`priceList.fasteners.${key}`, "approved pricing requires an explicit rate for every nonzero fastener category");
      }
      continue;
    }
    const validated = validateRateObject(
      priced,
      `priceList.fasteners.${key}`,
      ["sku", "description", "per", "rate", "rateCents", "sourceRef"],
      approved,
    );
    const per = validated.record.per === undefined
      ? 1
      : requirePositiveSafeInteger(validated.record.per, `priceList.fasteners.${key}.per`);
    const qty = Math.ceil(count / per);
    pushLine(
      "fastener",
      String(validated.record.sku),
      typeof validated.record.description === "string" ? validated.record.description : key,
      qty,
      per === 1 ? "ea" : `pack of ${per}`,
      validated.cents,
      `takeoff.fasteners.${key}`,
      validated.sourceRef,
    );
  }

  const panelArea = requireNonnegativeNumber(takeoff.totals.panelAreaSqft, "takeoff.totals.panelAreaSqft");
  if (approved && panelArea > 0 && priceList.labor === undefined) {
    fail("priceList.labor", "approved pricing requires an explicit rate for nonzero labor quantity");
  }
  if (priceList.labor !== undefined) {
    const labor = validateRateObject(
      priceList.labor,
      "priceList.labor",
      ["sku", "description", "ratePerSquare", "ratePerSquareCents", "sourceRef"],
      approved,
      "ratePerSquare",
      "ratePerSquareCents",
    );
    const squares = Math.round((panelArea / 100) * 100) / 100;
    pushLine(
      "labor",
      String(labor.record.sku),
      typeof labor.record.description === "string" ? labor.record.description : "Install labor",
      squares,
      "square",
      labor.cents,
      "takeoff.totals.panelAreaSqft / 100",
      labor.sourceRef,
    );
  }

  const lineCostCents = addCents(lines.map((line) => line.amountCents), "commercial.lineCostCents");
  const pricingMethod = policy?.pricing.method ?? "markup";
  const pricingRateBps = policy?.pricing.rateBps ?? percentageToBps(list.markupPct, "priceList.markupPct");
  const freightCents = policy?.freightCents ?? 0;
  const contingencyRateBps = policy?.contingencyRateBps ?? 0;
  const landedCostCents = addCents([lineCostCents, freightCents], "commercial.landedCostCents");
  const contingencyCents = applyBps(landedCostCents, contingencyRateBps, "commercial.contingencyCents");
  const costCents = addCents([landedCostCents, contingencyCents], "commercial.costCents");
  const pricedBeforeMinimumCents = pricingMethod === "markup"
    ? addCents(
      [costCents, applyBps(costCents, pricingRateBps, "commercial.policyMarkupCents")],
      "commercial.pricedBeforeMinimumCents",
    )
    : safeInteger(
      roundHalfUp(BigInt(costCents) * BPS_SCALE, BPS_SCALE - BigInt(pricingRateBps)),
      "commercial.pricedBeforeMinimumCents",
    );
  const minimumChargeCents = policy?.minimumChargeCents ?? 0;
  const taxBaseCents = Math.max(pricedBeforeMinimumCents, minimumChargeCents);
  const minimumChargeAdjustmentCents = taxBaseCents - pricedBeforeMinimumCents;
  const markupAmountCents = taxBaseCents - costCents;
  const markupRateBps = actualRateBps(markupAmountCents, costCents);
  const grossMarginRateBps = taxBaseCents === 0
    ? 0
    : safeInteger(
      roundHalfUp(BigInt(markupAmountCents) * BPS_SCALE, BigInt(taxBaseCents)),
      "commercial.grossMarginRateBps",
    );
  const taxRateBps = policy?.taxRateBps ?? percentageToBps(list.taxPct, "priceList.taxPct");
  const taxCents = applyBps(taxBaseCents, taxRateBps, "commercial.taxCents");
  const totalCents = addCents([taxBaseCents, taxCents], "commercial.totalCents");

  const commercial: CommercialTruth = {
    mode: approved ? "approved_policy" : "read_only_legacy",
    policyVersion: approved ? "ironwrap.pricing-policy.v1" : null,
    policyId: policy?.policyId ?? null,
    policyRevision: policy?.revision ?? null,
    policySnapshotSha256: authority?.snapshotSha256 ?? null,
    pricedAt: approvedResult?.pricedAt ?? null,
    effectiveAt: policy?.effectiveAt ?? null,
    expiresAt: policy?.expiresAt ?? null,
    pricingMethod,
    pricingRateBps,
    lineCostCents,
    freightCents,
    contingencyRateBps,
    contingencyCents,
    costCents,
    minimumChargeCents,
    minimumChargeAdjustmentCents,
    markupAmountCents,
    markupRateBps,
    grossMarginAmountCents: markupAmountCents,
    grossMarginRateBps,
    taxBaseCents,
    taxRateBps,
    taxCents,
    totalCents,
  };

  sourceRefs.subtotal = `sum(${lines.length} rounded line amounts)`;
  sourceRefs.freight = approved ? "approvedPolicy.freightCents" : "legacy zero";
  sourceRefs.contingency = `(line cost + freight) x ${contingencyRateBps} bps`;
  sourceRefs.cost = "line cost + freight + contingency";
  sourceRefs.markup = `${pricingMethod} policy ${pricingRateBps} bps, then minimum charge`;
  sourceRefs.tax = `final pre-tax amount x ${taxRateBps} bps`;

  return {
    currency,
    lines,
    subtotal: dollars(lineCostCents),
    cost: dollars(costCents),
    freight: dollars(freightCents),
    contingency: dollars(contingencyCents),
    minimumCharge: dollars(minimumChargeCents),
    minimumChargeAdjustment: dollars(minimumChargeAdjustmentCents),
    markup: dollars(markupAmountCents),
    markupRatePct: markupRateBps === null ? null : markupRateBps / 100,
    grossMargin: dollars(markupAmountCents),
    grossMarginRatePct: grossMarginRateBps / 100,
    taxBase: dollars(taxBaseCents),
    taxRatePct: taxRateBps / 100,
    tax: dollars(taxCents),
    total: dollars(totalCents),
    expiresAt: policy?.expiresAt ?? null,
    commercial,
    unpricedProfiles,
    needsReview: takeoff.needsReview || unpricedProfiles.length > 0 || !approved,
    sourceRefs,
  };
}
