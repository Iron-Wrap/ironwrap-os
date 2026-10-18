import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import {
  approvedPricingPolicySnapshot,
  verifyPricingAuthority,
  type PriceList,
  type VerifiedPricingAuthority,
} from "./pricing.ts";

const AUTHORITY_CONTRACT = canonicalJson({
  operation: "bind_canonical_pricing_snapshot",
  schema_version: "ironwrap.price-policy-authority.v1",
});
export class PricingCatalogError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 409) {
    super(code);
    this.name = "PricingCatalogError";
    this.code = code;
    this.status = status;
  }
}
export function pricingCatalogEnabled(env: AppEnv): boolean {
  return env.APP_PRICING_CATALOG_ENABLED === "true";
}
export interface CatalogActor {
  tenantId: string;
  userId: string;
  role: string;
}
export interface CatalogRevision {
  revision_id: string;
  tenant_id: string;
  label: string;
  policy_id: string;
  policy_revision: number;
  currency: string;
  snapshot_json: string;
  snapshot_sha256: string;
  effective_at: string;
  expires_at: string;
  origin: "manual" | "environment";
  actor_id: string;
  actor_role: string;
  actor_email: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  created_at: string;
}
export interface CatalogActivation {
  activation_id: string;
  tenant_id: string;
  revision_id: string;
  version: number;
  prior_activation_id: string | null;
  reviewed_sha256: string;
  actor_id: string;
  actor_role: string;
  actor_email: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  approved_at: string;
}
export interface CatalogHead {
  tenant_id: string;
  version: number;
  activation_id: string | null;
}
export type CatalogCreateInput =
  | { label: string; price_list: unknown }
  | { label: string; source: "environment" };
export interface CatalogActivateInput {
  revision_id: string;
  reviewed_sha256: string;
  expected_version: number;
}

function fail(code: string, status = 409): never {
  throw new PricingCatalogError(code, status);
}
function db(env: AppEnv) {
  if (!env.DB) fail("pricing_catalog_unavailable", 503);
  return env.DB;
}
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail("pricing_catalog_input_invalid", 400);
  return value as Record<string, unknown>;
}
export function parseCatalogCreate(value: unknown): CatalogCreateInput {
  const v = closed(value, ["label", "price_list", "source"]);
  if (
    typeof v.label !== "string" ||
    v.label !== v.label.trim() ||
    !v.label ||
    v.label.length > 120 ||
    /\p{Cc}/u.test(v.label)
  )
    fail("pricing_catalog_label_invalid", 400);
  if (v.source === "environment" && v.price_list === undefined)
    return { label: v.label, source: "environment" };
  if (v.source !== undefined || !v.price_list)
    fail("pricing_catalog_input_invalid", 400);
  return { label: v.label, price_list: v.price_list };
}
export function parseCatalogActivate(value: unknown): CatalogActivateInput {
  const v = closed(value, [
    "revision_id",
    "reviewed_sha256",
    "expected_version",
  ]);
  if (
    typeof v.revision_id !== "string" ||
    !/^pricingrev:[0-9a-f-]{36}$/.test(v.revision_id) ||
    typeof v.reviewed_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(v.reviewed_sha256) ||
    !Number.isSafeInteger(v.expected_version) ||
    Number(v.expected_version) < 0
  )
    fail("pricing_catalog_input_invalid", 400);
  return v as unknown as CatalogActivateInput;
}
async function keyHash(actor: CatalogActor, key: string): Promise<string> {
  if (!/^[A-Za-z0-9._:-]{16,240}$/.test(key))
    fail("pricing_catalog_idempotency_required", 400);
  return sha256Hex(
    canonicalJson({ tenant: actor.tenantId, actor: actor.userId, key }),
  );
}
async function fingerprint(
  actor: CatalogActor,
  action: string,
  input: unknown,
) {
  return sha256Hex(
    canonicalJson({
      schema: "ironwrap.pricing-catalog-command.v1",
      actor,
      action,
      input,
    }),
  );
}
async function actorRecord(env: AppEnv, actor: CatalogActor) {
  if (!["owner", "ops"].includes(actor.role))
    fail("pricing_catalog_actor_forbidden", 403);
  const user = await db(env)
    .prepare(
      `SELECT user_id,email_normalized,COALESCE(access_role,role) role,active FROM app_users WHERE tenant_id=? AND user_id=?`,
    )
    .bind(actor.tenantId, actor.userId)
    .first<{
      user_id: string;
      email_normalized: string;
      role: string;
      active: number;
    }>();
  if (!user || user.active !== 1 || user.role !== actor.role)
    fail("pricing_catalog_actor_forbidden", 403);
  return user;
}
export async function readCatalogHead(
  env: AppEnv,
  tenantId: string,
): Promise<CatalogHead> {
  // A retained later approval makes an older restored projection unusable for
  // new imports. Frozen imports still resolve their exact immutable activation.
  const state = await db(env)
    .prepare(
      `SELECT h.*,a.activation_id AS latest_activation_id,a.version AS latest_version
       FROM pricing_catalog_heads h LEFT JOIN pricing_catalog_activations a
         ON a.tenant_id=h.tenant_id AND a.version=(SELECT MAX(version)
           FROM pricing_catalog_activations WHERE tenant_id=h.tenant_id)
       WHERE h.tenant_id=?`,
    )
    .bind(tenantId)
    .first<
      CatalogHead & {
        latest_activation_id: string | null;
        latest_version: number | null;
      }
    >();
  if (
    state &&
    (state.version === 0
      ? state.activation_id !== null || state.latest_activation_id !== null
      : state.version !== state.latest_version ||
        state.activation_id !== state.latest_activation_id)
  )
    fail("pricing_catalog_authority_invalid", 503);
  const head: CatalogHead | null = state
    ? {
        tenant_id: state.tenant_id,
        version: state.version,
        activation_id: state.activation_id,
      }
    : null;
  if (!head || head.version === 0) {
    // A lost head must not turn a restored approved catalog into an empty one.
    // An unactivated revision is valid only when its version-zero head exists.
    const orphan = await db(env)
      .prepare(
        `SELECT 1 found FROM pricing_catalog_activations WHERE tenant_id=?
         UNION ALL
         SELECT 1 found FROM pricing_catalog_revisions WHERE tenant_id=? AND ?=1
         LIMIT 1`,
      )
      .bind(tenantId, tenantId, head ? 0 : 1)
      .first();
    if (orphan) fail("pricing_catalog_authority_invalid", 503);
  }
  return head ?? { tenant_id: tenantId, version: 0, activation_id: null };
}
export async function readCatalogRevision(
  env: AppEnv,
  tenantId: string,
  id: string,
) {
  return db(env)
    .prepare(
      "SELECT * FROM pricing_catalog_revisions WHERE tenant_id=? AND revision_id=?",
    )
    .bind(tenantId, id)
    .first<CatalogRevision>();
}
async function readActivation(env: AppEnv, tenantId: string, id: string) {
  return db(env)
    .prepare(
      "SELECT * FROM pricing_catalog_activations WHERE tenant_id=? AND activation_id=?",
    )
    .bind(tenantId, id)
    .first<CatalogActivation>();
}
async function validateSnapshot(
  value: unknown,
  tenantId: string,
  pricedAt?: string,
) {
  try {
    const list = value as PriceList;
    const snapshot = await approvedPricingPolicySnapshot(
      list,
      pricedAt ?? list?.approvedPolicy?.effectiveAt ?? "",
    );
    if (snapshot.tenantId !== tenantId)
      fail("pricing_catalog_tenant_mismatch", 403);
    return { list, ...snapshot };
  } catch (error) {
    if (error instanceof PricingCatalogError) throw error;
    fail("pricing_catalog_snapshot_invalid", 400);
  }
}
async function validatedRevision(
  row: CatalogRevision,
  tenantId: string,
  pricedAt?: string,
) {
  let value: unknown;
  try {
    value = JSON.parse(row.snapshot_json);
  } catch {
    fail("pricing_catalog_snapshot_corrupt", 503);
  }
  const snapshot = await validateSnapshot(value, tenantId, pricedAt);
  if (
    row.tenant_id !== tenantId ||
    snapshot.canonicalSnapshot !== row.snapshot_json ||
    snapshot.snapshotSha256 !== row.snapshot_sha256 ||
    snapshot.policyId !== row.policy_id ||
    snapshot.policyRevision !== row.policy_revision ||
    snapshot.list.currency !== row.currency ||
    snapshot.list.approvedPolicy!.effectiveAt !== row.effective_at ||
    snapshot.list.approvedPolicy!.expiresAt !== row.expires_at
  )
    fail("pricing_catalog_snapshot_corrupt", 503);
  return snapshot;
}
async function replay<T extends { command_fingerprint: string }>(
  env: AppEnv,
  table: "pricing_catalog_revisions" | "pricing_catalog_activations",
  actor: CatalogActor,
  hash: string,
  fingerprint: string,
): Promise<T | null> {
  const row = await db(env)
    .prepare(
      `SELECT * FROM ${table} WHERE tenant_id=? AND idempotency_key_hash=?`,
    )
    .bind(actor.tenantId, hash)
    .first<T>();
  if (row && row.command_fingerprint !== fingerprint)
    fail("pricing_catalog_idempotency_conflict");
  return row;
}
export async function createCatalogRevision(
  env: AppEnv,
  actor: CatalogActor,
  input: CatalogCreateInput,
  key: string,
  now = new Date(),
) {
  const user = await actorRecord(env, actor);
  const hash = await keyHash(actor, key),
    fp = await fingerprint(actor, "create", input);
  const original = await replay<CatalogRevision>(
    env,
    "pricing_catalog_revisions",
    actor,
    hash,
    fp,
  );
  if (original) return { replayed: true, revision: original };
  await readCatalogHead(env, actor.tenantId);
  let candidate: unknown;
  if ("source" in input) {
    const raw = (env as { ESTIMATOR_PRICE_LIST_JSON?: string })
      .ESTIMATOR_PRICE_LIST_JSON;
    if (!raw || new TextEncoder().encode(raw).length > 65536)
      fail("pricing_catalog_environment_unavailable", 400);
    try {
      candidate = JSON.parse(raw);
    } catch {
      fail("pricing_catalog_snapshot_invalid", 400);
    }
  } else candidate = input.price_list;
  const s = await validateSnapshot(candidate, actor.tenantId);
  const p = s.list.approvedPolicy!,
    id = `pricingrev:${crypto.randomUUID()}`;
  try {
    await db(env).batch([
      db(env)
        .prepare(
          "INSERT INTO pricing_catalog_heads(tenant_id,version,activation_id) SELECT ?,0,NULL WHERE NOT EXISTS (SELECT 1 FROM pricing_catalog_heads WHERE tenant_id=?)",
        )
        .bind(actor.tenantId, actor.tenantId),
      db(env)
        .prepare(
          `INSERT INTO pricing_catalog_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          id,
          actor.tenantId,
          input.label,
          s.policyId,
          s.policyRevision,
          s.list.currency,
          s.canonicalSnapshot,
          s.snapshotSha256,
          p.effectiveAt,
          p.expiresAt,
          "source" in input ? "environment" : "manual",
          actor.userId,
          actor.role,
          user.email_normalized,
          fp,
          hash,
          now.toISOString(),
        ),
    ]);
  } catch (error) {
    const saved = await replay<CatalogRevision>(
      env,
      "pricing_catalog_revisions",
      actor,
      hash,
      fp,
    );
    if (saved) return { replayed: true, revision: saved };
    sqlError(error);
  }
  return {
    replayed: false,
    revision: (await readCatalogRevision(env, actor.tenantId, id))!,
  };
}
export async function activateCatalogRevision(
  env: AppEnv,
  actor: CatalogActor,
  input: CatalogActivateInput,
  key: string,
  now = new Date(),
) {
  const user = await actorRecord(env, actor);
  const hash = await keyHash(actor, key),
    fp = await fingerprint(actor, "activate", input);
  const original = await replay<CatalogActivation>(
    env,
    "pricing_catalog_activations",
    actor,
    hash,
    fp,
  );
  // A lost response recovers this exact receipt even after another activation or expiry.
  if (original) return { replayed: true, activation: original };
  const revision = await readCatalogRevision(
    env,
    actor.tenantId,
    input.revision_id,
  );
  if (!revision) fail("pricing_catalog_revision_not_found", 404);
  await validatedRevision(revision, actor.tenantId);
  if (input.reviewed_sha256 !== revision.snapshot_sha256)
    fail("pricing_catalog_review_mismatch");
  const instant = now.toISOString();
  if (instant < revision.effective_at || instant > revision.expires_at)
    fail("pricing_catalog_not_effective");
  const head = await readCatalogHead(env, actor.tenantId);
  if (head.version !== input.expected_version)
    fail("pricing_catalog_head_conflict");
  const id = `pricingactivation:${crypto.randomUUID()}`;
  try {
    await db(env)
      .prepare(
        "INSERT INTO pricing_catalog_activations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        actor.tenantId,
        input.revision_id,
        input.expected_version + 1,
        head.activation_id,
        input.reviewed_sha256,
        actor.userId,
        actor.role,
        user.email_normalized,
        fp,
        hash,
        instant,
      )
      .run();
  } catch (error) {
    const saved = await replay<CatalogActivation>(
      env,
      "pricing_catalog_activations",
      actor,
      hash,
      fp,
    );
    if (saved) return { replayed: true, activation: saved };
    if (
      (await readCatalogHead(env, actor.tenantId)).version !==
      input.expected_version
    )
      fail("pricing_catalog_head_conflict");
    sqlError(error);
  }
  return {
    replayed: false,
    activation: (await readActivation(env, actor.tenantId, id))!,
  };
}
function sqlError(error: unknown): never {
  const message = String(error);
  for (const [code, status] of [
    ["pricing_catalog_actor_forbidden", 403],
    ["pricing_catalog_head_conflict", 409],
    ["pricing_catalog_review_mismatch", 409],
  ] as const)
    if (message.includes(code)) fail(code, status);
  if (
    message.includes("pricing_catalog_immutable") ||
    message.includes("UNIQUE")
  )
    fail("pricing_catalog_revision_conflict");
  fail("pricing_catalog_unavailable", 503);
}
export function catalogRevisionView(r: CatalogRevision) {
  const { tenant_id: _tenant, idempotency_key_hash: _key, ...view } = r;
  return view;
}
export function catalogActivationView(a: CatalogActivation) {
  const { tenant_id: _tenant, idempotency_key_hash: _key, ...view } = a;
  return view;
}
export async function readPricingCatalog(
  env: AppEnv,
  tenantId: string,
  cursor?: string,
  activationBefore?: number,
) {
  const head = await readCatalogHead(env, tenantId);
  const boundary = cursor
    ? await readCatalogRevision(env, tenantId, cursor)
    : null;
  if (cursor && !boundary) fail("pricing_catalog_cursor_invalid", 400);
  const revisions = (
    await db(env)
      .prepare(
        `SELECT * FROM pricing_catalog_revisions WHERE tenant_id=? AND (? IS NULL OR created_at<? OR (created_at=? AND revision_id<?)) ORDER BY created_at DESC,revision_id DESC LIMIT 51`,
      )
      .bind(
        tenantId,
        boundary?.created_at ?? null,
        boundary?.created_at ?? null,
        boundary?.created_at ?? null,
        boundary?.revision_id ?? null,
      )
      .all<CatalogRevision>()
  ).results;
  for (const r of revisions) await validatedRevision(r, tenantId);
  const activations = (
    await db(env)
      .prepare(
        "SELECT * FROM pricing_catalog_activations WHERE tenant_id=? AND version<? ORDER BY version DESC LIMIT 51",
      )
      .bind(tenantId, activationBefore ?? Number.MAX_SAFE_INTEGER)
      .all<CatalogActivation>()
  ).results;
  const activeReceipt = head.activation_id
    ? await readActivation(env, tenantId, head.activation_id)
    : null;
  const active = activeReceipt
    ? await readCatalogRevision(env, tenantId, activeReceipt.revision_id)
    : null;
  if (
    (head.version === 0 && head.activation_id !== null) ||
    (head.version > 0 &&
      (!activeReceipt ||
        !active ||
        activeReceipt.version !== head.version ||
        activeReceipt.reviewed_sha256 !== active.snapshot_sha256))
  )
    fail("pricing_catalog_authority_invalid", 503);
  if (active) await validatedRevision(active, tenantId);
  return {
    version: 1,
    head,
    active_revision: active ? catalogRevisionView(active) : null,
    revisions: revisions.slice(0, 50).map(catalogRevisionView),
    activations: activations.slice(0, 50).map(catalogActivationView),
    next_revision_cursor:
      revisions.length > 50 ? revisions[49].revision_id : null,
    next_activation_before:
      activations.length > 50 ? activations[49].version : null,
  };
}
function catalogRule(
  r: CatalogRevision,
  a: CatalogActivation,
  pricedAt: string,
): Record<string, unknown> {
  return {
    name: a.activation_id,
    status: "Approved",
    rule_type: "Pricing Policy",
    currency: r.currency,
    source_ref: `pricing-catalog:${r.revision_id}:${a.activation_id}`,
    rule_json: AUTHORITY_CONTRACT,
    effective_from: r.effective_at.slice(0, 10),
    effective_to: r.expires_at.slice(0, 10),
    approved_by: a.actor_email,
    approved_at: a.approved_at.slice(0, 19).replace("T", " "),
    pricing_policy_id: r.policy_id,
    pricing_policy_revision: r.policy_revision,
    pricing_policy_snapshot_json: r.snapshot_json,
    pricing_policy_snapshot_sha256: r.snapshot_sha256,
    catalog_revision_id: r.revision_id,
    catalog_activation_id: a.activation_id,
    catalog_head_version: a.version,
    catalog_priced_at: pricedAt,
    catalog_approved_at: a.approved_at,
    modified: a.approved_at,
  };
}
/** Fresh imports select current, effective, explicitly approved D1 authority. */
export async function selectCatalogPricingForImport(
  env: AppEnv,
  tenantId: string,
  now: Date,
) {
  const h = await readCatalogHead(env, tenantId);
  if (!h.activation_id) return null;
  const a = await readActivation(env, tenantId, h.activation_id);
  const r = a ? await readCatalogRevision(env, tenantId, a.revision_id) : null;
  const instant = now.toISOString();
  if (
    !a ||
    !r ||
    a.version !== h.version ||
    a.reviewed_sha256 !== r.snapshot_sha256 ||
    a.approved_at > instant
  )
    fail("pricing_catalog_authority_invalid", 503);
  if (instant < r.effective_at || instant > r.expires_at)
    fail("pricing_catalog_not_effective");
  const snapshot = await validatedRevision(r, tenantId, instant);
  const rule = catalogRule(r, a, instant);
  const authority = await verifyPricingAuthority(snapshot.list, [rule], {
    tenantId,
    pricedAt: instant,
  });
  if (!authority) fail("pricing_catalog_authority_invalid", 503);
  return { list: snapshot.list, rule, authority, pricedAt: instant };
}
/** Read exact pinned revision/receipt, evaluated at import time, never the active head. */
export async function resolveFrozenCatalogPricing(
  env: AppEnv,
  tenantId: string,
  rule: Record<string, unknown>,
  estimatorRevisionId: string | null,
): Promise<{
  list: PriceList;
  authority: VerifiedPricingAuthority;
  pricedAt: string;
} | null> {
  if (!rule.catalog_revision_id) return null;
  const r = await readCatalogRevision(
    env,
    tenantId,
    String(rule.catalog_revision_id),
  );
  const a = await readActivation(
    env,
    tenantId,
    String(rule.catalog_activation_id),
  );
  const pricedAt = String(rule.catalog_priced_at);
  if (
    !r ||
    !a ||
    a.revision_id !== r.revision_id ||
    a.reviewed_sha256 !== r.snapshot_sha256 ||
    a.approved_at > pricedAt ||
    canonicalJson(rule) !== canonicalJson(catalogRule(r, a, pricedAt))
  )
    fail("pricing_catalog_authority_invalid", 503);
  const pin = await db(env)
    .prepare(
      "SELECT 1 found FROM estimator_pricing_catalog_pins WHERE tenant_id=? AND revision_id=? AND activation_id=? AND snapshot_sha256=? AND priced_at=? AND estimator_revision_id=?",
    )
    .bind(
      tenantId,
      r.revision_id,
      a.activation_id,
      r.snapshot_sha256,
      pricedAt,
      estimatorRevisionId,
    )
    .first();
  if (!pin) fail("pricing_catalog_pin_missing", 503);
  const snapshot = await validatedRevision(r, tenantId, pricedAt);
  const authority = await verifyPricingAuthority(snapshot.list, [rule], {
    tenantId,
    pricedAt,
  });
  if (!authority) fail("pricing_catalog_authority_invalid", 503);
  return { list: snapshot.list, authority, pricedAt };
}

/** Keep an older native import readable from its own immutable payload after cutover. */
export async function resolveFrozenLegacyPricing(
  tenantId: string,
  rule: Record<string, unknown>,
  estimatorCreatedAt: string | null,
): Promise<{
  list: PriceList;
  authority: VerifiedPricingAuthority;
  pricedAt: string;
}> {
  if (
    !estimatorCreatedAt ||
    typeof rule.source_ref !== "string" ||
    !rule.source_ref.startsWith("native-owner-import:") ||
    rule.modified !== estimatorCreatedAt ||
    typeof rule.pricing_policy_snapshot_json !== "string"
  )
    fail("pricing_catalog_legacy_authority_invalid", 503);
  let list: PriceList;
  try {
    list = JSON.parse(rule.pricing_policy_snapshot_json) as PriceList;
    const snapshot = await approvedPricingPolicySnapshot(
      list,
      estimatorCreatedAt,
    );
    if (
      snapshot.tenantId !== tenantId ||
      snapshot.canonicalSnapshot !== rule.pricing_policy_snapshot_json ||
      snapshot.snapshotSha256 !== rule.pricing_policy_snapshot_sha256
    )
      fail("pricing_catalog_legacy_authority_invalid", 503);
  } catch {
    fail("pricing_catalog_legacy_authority_invalid", 503);
  }
  const authority = await verifyPricingAuthority(list, [rule], {
    tenantId,
    pricedAt: estimatorCreatedAt,
  });
  if (!authority) fail("pricing_catalog_legacy_authority_invalid", 503);
  return { list, authority, pricedAt: estimatorCreatedAt };
}
