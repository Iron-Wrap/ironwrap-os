import { sha256Hex } from "./app-auth.ts";
import { r2ObjectStore } from "./field-actions.ts";
import {
  FACET_V2_RECEIPT_SCHEMA,
  canonicalJson,
  parseFacetV2CustomerDecisionEvent,
  signFacetV2Receipt,
  verifyFacetV2Delivery,
  type FacetV2CustomerDecisionEvent,
  type FacetV2Receipt,
  type FacetV2StaticRoute,
  type FacetV2VerificationKey,
  type SignedFacetV2Receipt,
} from "./facet-design-v2-protocol.ts";
import {
  resolveFacetV2AuthorityLink,
  type FacetV2AuthorityLink,
} from "./facet-v2-authority.ts";

const POLICY_VERSION = "ironwrap-facet-consumer-v2";
const MAX_BODY_BYTES = 512 * 1024;
const RECONCILE_BATCH_SIZE = 25;

interface FacetV2ConsumerConfig {
  routes: readonly FacetV2StaticRoute[];
  keys: readonly FacetV2VerificationKey[];
}

interface StoredDecisionIdentity {
  event_id: string;
  event_body_sha256: string;
  decision_kind: "approved" | "corrected" | "superseded" | "withdrawn";
  customer_party_ref: string;
  external_customer_identity_link_id: string;
  oidc_issuer: string;
  oidc_subject_sha256: string;
  occurred_at: string;
}

interface StoredReceiptEnvelope {
  receipt_json: string;
  receipt_sha256: string;
  signature_algorithm: "HMAC-SHA256";
  signature_key_id: string;
  signature_key_version: number;
  signature_value: string;
}

interface StoredIntakeReplay {
  intake_id: string;
  event_id: string;
  event_body_sha256: string;
}

interface UnassociatedIntake {
  intake_id: string;
  event_id: string;
  event_body_sha256: string;
  raw_key: string;
}

type DecisionDisposition =
  | { kind: "new" }
  | {
    kind: "duplicate";
    receiptResult: "duplicate" | "reconciled";
    detailCode: "exact_event_replay" | "exact_reconciled_event_replay";
  }
  | { kind: "rejected"; detailCode: string };

/**
 * Authenticated raw-first Facet v2 intake. The bounded request stays in
 * memory until its transport signature and canonical v2 body are verified;
 * only then does immutable R2 evidence precede every D1 effect. Legacy v1
 * and the old bearer-capability v2 contract are intentionally unreachable.
 */
export async function handleFacetDesignIngest(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST" || String(env.FACET_V2_INGEST_ENABLED) !== "true") {
    return facetJson({ error: "not_found" }, 404);
  }
  const config = facetV2ConsumerConfig(env);
  if (!config) return facetJson({ error: "facet_v2_ingest_unavailable" }, 503);

  const raw = await readRawJson(req);
  if (!raw.ok) return facetJson({ error: raw.error }, raw.status);
  const verified = await verifyFacetV2Delivery(req, raw.text, config);
  if (!verified.ok) return facetJson({ error: verified.code }, verified.status);
  const key = config.keys.find((candidate) =>
    candidate.keyId === verified.value.headers.keyId &&
    candidate.keyVersion === verified.value.headers.keyVersion
  );
  if (!key) return facetJson({ error: "event_key_unknown" }, 401);
  const event = await parseFacetV2CustomerDecisionEvent(verified.value.event);
  if (!event) return facetJson({ error: "invalid_event_body" }, 400);
  const bodySha256 = verified.value.bodySha256;
  const rawKey = `facet-design/v2/raw/${bodySha256}.json`;

  // Authentication and canonical schema validation happen in memory. This
  // remains the first durable write for every accepted or signed-rejected
  // intake, so no D1 effect can outlive missing raw evidence.
  try {
    await r2ObjectStore(env.RAW).ensure(rawKey, raw.text, "application/json", bodySha256);
  } catch {
    return facetJson({ error: "facet_v2_raw_store_unavailable" }, 503);
  }

  const nonceSha256 = await sha256Hex([
    verified.value.headers.issuer,
    verified.value.headers.keyId,
    String(verified.value.headers.keyVersion),
    verified.value.headers.nonce,
  ].join("\n"));
  const replay = await intakeByNonce(env, nonceSha256);
  if (replay) {
    if (
      replay.event_id !== verified.value.headers.eventId ||
      replay.event_body_sha256 !== bodySha256
    ) return facetJson({ error: "event_nonce_conflict" }, 409);
    const receipt = await signedReceiptForIntake(
      env,
      replay.intake_id,
      replay.event_id,
      replay.event_body_sha256,
      key,
    );
    return receipt
      ? facetJson(receipt, receiptStatus(receipt))
      : facetJson({ error: "facet_v2_receipt_integrity_unavailable" }, 503);
  }

  const receivedAt = new Date().toISOString();
  const intakeId = `facet-v2-intake:${crypto.randomUUID()}`;
  const authority = await resolveFacetV2AuthorityLink(env, event);
  if (!authority) {
    const signed = await signedReceipt(event, bodySha256, key, {
      result: "accepted_unassociated",
      detailCode: "awaiting_exact_project_identity_association",
      occurredAt: receivedAt,
      idempotentReplay: false,
    });
    try {
      await appendIntakeAndReceipt(env, {
        intakeId,
        event,
        bodySha256,
        rawKey,
        rawBytes: raw.bytes,
        verified: verified.value.headers,
        nonceSha256,
        result: "accepted_unassociated",
        detailCode: "awaiting_exact_project_identity_association",
        receivedAt,
        signed,
      });
      return facetJson(signed, 202);
    } catch {
      return await concurrentNonceReplayResponse(env, nonceSha256, event, bodySha256, key) ??
        facetJson({ error: "facet_v2_intake_conflict" }, 409);
    }
  }

  const disposition = await decisionDisposition(env, event, bodySha256);
  if (disposition.kind === "duplicate") {
    const signed = await signedReceipt(event, bodySha256, key, {
      result: disposition.receiptResult,
      detailCode: disposition.detailCode,
      occurredAt: receivedAt,
      idempotentReplay: true,
    });
    try {
      await appendIntakeAndReceipt(env, {
        intakeId,
        event,
        bodySha256,
        rawKey,
        rawBytes: raw.bytes,
        verified: verified.value.headers,
        nonceSha256,
        result: "duplicate",
        detailCode: disposition.detailCode,
        receivedAt,
        signed,
      });
      return facetJson(signed, 200);
    } catch {
      return await concurrentNonceReplayResponse(env, nonceSha256, event, bodySha256, key) ??
        facetJson({ error: "facet_v2_intake_conflict" }, 409);
    }
  }
  if (disposition.kind === "rejected") {
    const signed = await signedReceipt(event, bodySha256, key, {
      result: "rejected",
      detailCode: disposition.detailCode,
      occurredAt: receivedAt,
      idempotentReplay: false,
    });
    try {
      await appendIntakeAndReceipt(env, {
        intakeId,
        event,
        bodySha256,
        rawKey,
        rawBytes: raw.bytes,
        verified: verified.value.headers,
        nonceSha256,
        result: "rejected",
        detailCode: disposition.detailCode,
        receivedAt,
        signed,
      });
      return facetJson(signed, 409);
    } catch {
      return await concurrentNonceReplayResponse(env, nonceSha256, event, bodySha256, key) ??
        facetJson({ error: "facet_v2_intake_conflict" }, 409);
    }
  }

  const signed = await signedReceipt(event, bodySha256, key, {
    result: "accepted_associated",
    detailCode: "exact_identity_project_association_verified",
    occurredAt: receivedAt,
    idempotentReplay: false,
  });
  try {
    await appendAcceptedDecision(env, {
      intakeId,
      event,
      authority,
      bodySha256,
      rawKey,
      rawBytes: raw.bytes,
      verified: verified.value.headers,
      nonceSha256,
      receivedAt,
      signed,
    });
  } catch {
    const sameNonce = await concurrentNonceReplayResponse(
      env,
      nonceSha256,
      event,
      bodySha256,
      key,
    );
    if (sameNonce) return sameNonce;
    const raced = await decisionDisposition(env, event, bodySha256);
    if (raced.kind === "duplicate") {
      const replaySigned = await signedReceipt(event, bodySha256, key, {
        result: raced.receiptResult,
        detailCode: raced.detailCode,
        occurredAt: receivedAt,
        idempotentReplay: true,
      });
      try {
        await appendIntakeAndReceipt(env, {
          intakeId,
          event,
          bodySha256,
          rawKey,
          rawBytes: raw.bytes,
          verified: verified.value.headers,
          nonceSha256,
          result: "duplicate",
          detailCode: raced.detailCode,
          receivedAt,
          signed: replaySigned,
        });
        return facetJson(replaySigned, 200);
      } catch {
        return await concurrentNonceReplayResponse(
          env,
          nonceSha256,
          event,
          bodySha256,
          key,
        ) ?? facetJson({ error: "facet_v2_intake_conflict" }, 409);
      }
    }
    return facetJson({ error: "facet_v2_intake_conflict" }, 409);
  }
  return facetJson(signed, 202);
}

/**
 * Re-check raw-first unassociated evidence after an exact link is established.
 * The original intake is never rewritten; reconciliation appends the trusted
 * decision and a new signed receipt.
 */
export async function reconcileFacetV2UnassociatedIntakes(
  env: Env,
  now = new Date(),
): Promise<number> {
  if (String(env.FACET_V2_INGEST_ENABLED) !== "true") return 0;
  const config = facetV2ConsumerConfig(env);
  if (!config) throw new Error("facet_v2_ingest_not_configured");
  const receiptKey = activeReceiptSigningKey(config.keys, now.getTime());
  if (!receiptKey) return 0;
  const rows = await env.DB.prepare(
    `SELECT intake.intake_id, intake.event_id, intake.event_body_sha256, intake.raw_key
       FROM facet_v2_raw_intakes AS intake
       WHERE intake.result = 'accepted_unassociated'
         AND NOT EXISTS (
           SELECT 1 FROM facet_v2_customer_decisions AS decision
           WHERE decision.event_id = intake.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM facet_v2_consumer_receipts AS receipt
           WHERE receipt.intake_id = intake.intake_id AND receipt.result = 'reconciled'
         )
       ORDER BY intake.received_at ASC
       LIMIT ?`,
  ).bind(RECONCILE_BATCH_SIZE).all<UnassociatedIntake>();
  let reconciled = 0;
  for (const row of rows.results ?? []) {
    const object = await env.RAW.get(row.raw_key);
    if (!object) continue;
    const raw = await object.text();
    if (await sha256Hex(raw) !== row.event_body_sha256) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const event = await parseFacetV2CustomerDecisionEvent(parsed);
    if (!event || event.event_id !== row.event_id || canonicalJson(event) !== raw) continue;
    const authority = await resolveFacetV2AuthorityLink(env, event);
    if (!authority) continue;
    const disposition = await decisionDisposition(env, event, row.event_body_sha256);
    if (disposition.kind !== "new") continue;
    const signed = await signedReceipt(event, row.event_body_sha256, receiptKey, {
      result: "reconciled",
      detailCode: "exact_association_reconciled_from_raw_intake",
      occurredAt: now.toISOString(),
      idempotentReplay: false,
    });
    try {
      await env.DB.batch([
        decisionInsert(env, {
          event,
          authority,
          bodySha256: row.event_body_sha256,
          rawKey: row.raw_key,
          rawBytes: new TextEncoder().encode(raw).byteLength,
          receivedAt: now.toISOString(),
        }),
        receiptInsert(env, row.intake_id, event.event_id, row.event_body_sha256, signed),
      ]);
      reconciled += 1;
    } catch {
      // A concurrent exact reconciliation wins; conflicting state remains held.
    }
  }
  return reconciled;
}

export function facetV2ConsumerConfig(env: Env): FacetV2ConsumerConfig | null {
  const routes = facetV2StaticRoutes(env);
  const keysRaw = String(env.FACET_V2_KEYS_JSON ?? "").trim();
  if (!routes || !keysRaw) return null;
  try {
    const keyValues = JSON.parse(keysRaw) as unknown;
    if (!Array.isArray(keyValues) || !keyValues.length || keyValues.length > 16) return null;
    const keys = keyValues.map(parseKey);
    if (keys.some((key) => !key)) return null;
    const keyIdentities = new Set(keys.map((key) => key && `${key.keyId}\n${key.keyVersion}`));
    if (keyIdentities.size !== keys.length) return null;
    return {
      routes,
      keys: keys as FacetV2VerificationKey[],
    };
  } catch {
    return null;
  }
}

export function facetV2StaticRoutes(
  env: Pick<Env, "FACET_V2_ROUTES_JSON">,
): FacetV2StaticRoute[] | null {
  const routesRaw = String(env.FACET_V2_ROUTES_JSON ?? "").trim();
  if (!routesRaw) return null;
  try {
    const routeValues = JSON.parse(routesRaw) as unknown;
    if (!Array.isArray(routeValues) || !routeValues.length || routeValues.length > 32)
      return null;
    const routes = routeValues.map(parseRoute);
    if (routes.some((route) => !route)) return null;
    const exact = routes as FacetV2StaticRoute[];
    const identities = new Set(exact.map((route) => canonicalJson(route)));
    return identities.size === exact.length ? exact : null;
  } catch {
    return null;
  }
}

function parseRoute(value: unknown): FacetV2StaticRoute | null {
  if (!isRecord(value) || !sameKeys(value, [
    "version", "issuer", "source_product", "source_environment", "source_tenant_id",
    "destination_tenant_id", "destination_url",
  ])) return null;
  if (
    value.version !== 1 || value.source_product !== "facet" ||
    !safeIdentifier(value.issuer) || !safeIdentifier(value.source_environment) ||
    !uuid(value.source_tenant_id) || !safeIdentifier(value.destination_tenant_id) ||
    !publicHttpsUrl(value.destination_url)
  ) return null;
  return {
    version: 1,
    issuer: value.issuer,
    sourceProduct: "facet",
    sourceEnvironment: value.source_environment,
    sourceTenantId: value.source_tenant_id,
    destinationTenantId: value.destination_tenant_id,
    destinationUrl: value.destination_url,
  };
}

function parseKey(value: unknown): FacetV2VerificationKey | null {
  if (!isRecord(value) || !sameKeys(value, [
    "key_id", "key_version", "secret", "not_before_ms", "not_after_ms",
  ])) return null;
  if (
    !keyId(value.key_id) || !Number.isSafeInteger(value.key_version) || Number(value.key_version) < 1 ||
    typeof value.secret !== "string" || value.secret.length < 32 ||
    !Number.isSafeInteger(value.not_before_ms) || !Number.isSafeInteger(value.not_after_ms) ||
    Number(value.not_after_ms) <= Number(value.not_before_ms)
  ) return null;
  return {
    keyId: value.key_id,
    keyVersion: Number(value.key_version),
    secret: value.secret,
    notBeforeMs: Number(value.not_before_ms),
    notAfterMs: Number(value.not_after_ms),
  };
}

async function decisionDisposition(
  env: Env,
  event: FacetV2CustomerDecisionEvent,
  bodySha256: string,
): Promise<DecisionDisposition> {
  const existing = await env.DB.prepare(
    `SELECT event_id, event_body_sha256, decision_kind, customer_party_ref,
            external_customer_identity_link_id, oidc_issuer, oidc_subject_sha256, occurred_at
       FROM facet_v2_customer_decisions WHERE event_id = ? LIMIT 1`,
  ).bind(event.event_id).first<StoredDecisionIdentity>();
  if (existing) {
    if (existing.event_body_sha256 !== bodySha256)
      return { kind: "rejected", detailCode: "event_id_body_conflict" };
    const reconciled = await env.DB.prepare(
      `SELECT 1 AS present FROM facet_v2_consumer_receipts
       WHERE event_id = ? AND event_body_sha256 = ? AND result = 'reconciled'
       LIMIT 1`,
    ).bind(event.event_id, bodySha256).first<{ present: number }>();
    return reconciled
      ? {
        kind: "duplicate",
        receiptResult: "reconciled",
        detailCode: "exact_reconciled_event_replay",
      }
      : {
        kind: "duplicate",
        receiptResult: "duplicate",
        detailCode: "exact_event_replay",
      };
  }
  const latest = await env.DB.prepare(
    `SELECT decision.event_id, decision.event_body_sha256, decision.decision_kind,
            decision.customer_party_ref, decision.external_customer_identity_link_id,
            decision.oidc_issuer, decision.oidc_subject_sha256, decision.occurred_at
       FROM facet_v2_customer_decisions AS decision
       WHERE decision.destination_tenant_id = ? AND decision.facet_project_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM facet_v2_customer_decisions AS child
           WHERE child.previous_event_id = decision.event_id
         )
       LIMIT 2`,
  ).bind(event.destination.tenant_id, event.facet_project_id).all<StoredDecisionIdentity>();
  const chainHeads = latest.results ?? [];
  if (chainHeads.length > 1)
    return { kind: "rejected", detailCode: "decision_chain_collision" };
  const previous = chainHeads[0] ?? null;
  if (event.approval.decision === "approved") {
    return previous
      ? { kind: "rejected", detailCode: "initial_decision_already_exists" }
      : { kind: "new" };
  }
  if (!previous || previous.event_id !== event.approval.previous_event_id)
    return { kind: "rejected", detailCode: "decision_predecessor_mismatch" };
  if (
    previous.customer_party_ref !== event.approval.actor.customer_party_ref ||
    previous.external_customer_identity_link_id !== event.approval.actor.external_identity_link_id ||
    previous.oidc_issuer !== event.approval.actor.oidc_issuer ||
    previous.oidc_subject_sha256 !== event.approval.actor.oidc_subject_sha256
  ) return { kind: "rejected", detailCode: "decision_customer_identity_mismatch" };
  if (previous.decision_kind === "withdrawn")
    return { kind: "rejected", detailCode: "withdrawn_chain_is_terminal" };
  if (Date.parse(event.occurred_at) <= Date.parse(previous.occurred_at))
    return { kind: "rejected", detailCode: "decision_time_not_monotonic" };
  return { kind: "new" };
}

async function signedReceipt(
  event: FacetV2CustomerDecisionEvent,
  bodySha256: string,
  key: FacetV2VerificationKey,
  input: {
    result: FacetV2Receipt["result"];
    detailCode: string;
    occurredAt: string;
    idempotentReplay: boolean;
  },
): Promise<SignedFacetV2Receipt> {
  return await signFacetV2Receipt({
    schema: FACET_V2_RECEIPT_SCHEMA,
    receipt_id: crypto.randomUUID(),
    event_id: event.event_id,
    event_body_sha256: bodySha256,
    frozen_evidence_sha256: event.approval.manifest_sha256,
    design_revision: event.design_revision,
    decision_kind: event.approval.decision,
    approval_receipt_sha256: event.approval.receipt_sha256,
    actor_identity_assurance: "oidc",
    destination_tenant_id: event.destination.tenant_id,
    result: input.result,
    policy_version: POLICY_VERSION,
    occurred_at: input.occurredAt,
    detail_code: input.detailCode,
    idempotent_replay: input.idempotentReplay,
  }, key);
}

async function appendAcceptedDecision(
  env: Env,
  input: IntakeInput & {
    authority: FacetV2AuthorityLink;
    signed: SignedFacetV2Receipt;
  },
): Promise<void> {
  await env.DB.batch([
    intakeInsert(env, {
      ...input,
      result: "accepted_associated",
      detailCode: "exact_identity_project_association_verified",
    }),
    decisionInsert(env, input),
    receiptInsert(env, input.intakeId, input.event.event_id, input.bodySha256, input.signed),
  ]);
}

async function appendIntakeAndReceipt(
  env: Env,
  input: IntakeInput & {
    result: "accepted_unassociated" | "rejected" | "duplicate";
    detailCode: string;
    signed: SignedFacetV2Receipt;
  },
): Promise<void> {
  await env.DB.batch([
    intakeInsert(env, input),
    receiptInsert(env, input.intakeId, input.event.event_id, input.bodySha256, input.signed),
  ]);
}

interface IntakeInput {
  intakeId: string;
  event: FacetV2CustomerDecisionEvent;
  bodySha256: string;
  rawKey: string;
  rawBytes: number;
  verified: {
    issuer: string;
    product: string;
    environment: string;
    destinationTenantId: string;
    keyId: string;
    keyVersion: number;
    issuedAt: string;
    expiresAt: string;
  };
  nonceSha256: string;
  receivedAt: string;
}

function intakeInsert(
  env: Env,
  input: IntakeInput & {
    result: "accepted_associated" | "accepted_unassociated" | "rejected" | "duplicate";
    detailCode: string;
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO facet_v2_raw_intakes
     (intake_id, event_id, event_body_sha256, raw_key, raw_sha256, raw_content_length,
      issuer, source_product, source_environment, source_tenant_id, destination_tenant_id,
      delivery_key_id, delivery_key_version, issued_at_ms, expires_at_ms, nonce_sha256,
      result, detail_code, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.intakeId,
    input.event.event_id,
    input.bodySha256,
    input.rawKey,
    input.bodySha256,
    input.rawBytes,
    input.verified.issuer,
    input.verified.product,
    input.verified.environment,
    input.event.source.tenant_id,
    input.verified.destinationTenantId,
    input.verified.keyId,
    input.verified.keyVersion,
    Number(input.verified.issuedAt),
    Number(input.verified.expiresAt),
    input.nonceSha256,
    input.result,
    input.detailCode,
    input.receivedAt,
  );
}

function decisionInsert(
  env: Pick<Env, "DB">,
  input: {
    event: FacetV2CustomerDecisionEvent;
    authority: FacetV2AuthorityLink;
    bodySha256: string;
    rawKey: string;
    rawBytes: number;
    receivedAt: string;
  },
): D1PreparedStatement {
  const { event, authority } = input;
  return env.DB.prepare(
    `INSERT INTO facet_v2_customer_decisions
     (event_id, event_type, schema_version, event_body_sha256, issuer, source_product,
      source_environment, source_tenant_id, destination_tenant_id, brand_id,
      facet_project_id, external_project_link_id, producer_identity_link_id,
      association_sha256, roof_job_id, customer_quote_id, customer_party_ref,
      external_customer_identity_link_id, oidc_issuer, oidc_subject_sha256,
      identity_assurance, attestation_version, decision_kind, previous_event_id,
      reason_sha256, approval_receipt_id, approval_receipt_sha256, design_revision_id,
      design_revision_sha256, frozen_evidence_sha256, raw_key, raw_sha256,
      raw_content_length, occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    event.event_id,
    event.event_type,
    event.schema_version,
    input.bodySha256,
    event.source.issuer,
    event.source.product,
    event.source.environment,
    event.source.tenant_id,
    event.destination.tenant_id,
    event.brand_id,
    event.facet_project_id,
    authority.externalProjectLinkId,
    authority.producerIdentityLinkId,
    authority.associationSha256,
    authority.roofJobId,
    authority.customerQuoteId,
    event.approval.actor.customer_party_ref,
    event.approval.actor.external_identity_link_id,
    event.approval.actor.oidc_issuer,
    event.approval.actor.oidc_subject_sha256,
    event.approval.actor.identity_assurance,
    event.approval.attestation_version,
    event.approval.decision,
    event.approval.previous_event_id,
    event.approval.reason_sha256,
    event.approval.receipt_id,
    event.approval.receipt_sha256,
    event.design_revision.id,
    event.design_revision.sha256,
    event.approval.manifest_sha256,
    input.rawKey,
    input.bodySha256,
    input.rawBytes,
    event.occurred_at,
    input.receivedAt,
  );
}

function receiptInsert(
  env: Pick<Env, "DB">,
  intakeId: string,
  eventId: string,
  bodySha256: string,
  signed: SignedFacetV2Receipt,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO facet_v2_consumer_receipts
     (receipt_id, intake_id, event_id, event_body_sha256, result, detail_code,
      receipt_json, receipt_sha256, signature_algorithm, signature_key_id,
      signature_key_version, signature_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    signed.receipt.receipt_id,
    intakeId,
    eventId,
    bodySha256,
    signed.receipt.result,
    signed.receipt.detail_code,
    canonicalJson(signed.receipt),
    signed.receipt_sha256,
    signed.signature.algorithm,
    signed.signature.key_id,
    signed.signature.key_version,
    signed.signature.value,
    signed.receipt.occurred_at,
  );
}

async function intakeByNonce(env: Env, nonceSha256: string): Promise<StoredIntakeReplay | null> {
  return await env.DB.prepare(
    `SELECT intake_id, event_id, event_body_sha256
       FROM facet_v2_raw_intakes WHERE nonce_sha256 = ? LIMIT 1`,
  ).bind(nonceSha256).first<StoredIntakeReplay>();
}

async function signedReceiptForIntake(
  env: Env,
  intakeId: string,
  eventId: string,
  bodySha256: string,
  key: FacetV2VerificationKey,
): Promise<SignedFacetV2Receipt | null> {
  const stored = await env.DB.prepare(
    `SELECT receipt_json, receipt_sha256, signature_algorithm, signature_key_id,
            signature_key_version, signature_value
       FROM facet_v2_consumer_receipts
       WHERE intake_id = ?
         AND signature_key_id = ? AND signature_key_version = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).bind(intakeId, key.keyId, key.keyVersion).first<StoredReceiptEnvelope>();
  return await verifiedStoredReceipt(stored, eventId, bodySha256, key);
}

async function verifiedStoredReceipt(
  stored: StoredReceiptEnvelope | null,
  eventId: string,
  bodySha256: string,
  key: FacetV2VerificationKey,
): Promise<SignedFacetV2Receipt | null> {
  if (!stored) return null;
  try {
    const receipt = JSON.parse(stored.receipt_json) as FacetV2Receipt;
    if (canonicalJson(receipt) !== stored.receipt_json) return null;
    const expected = await signFacetV2Receipt(receipt, key);
    if (
      receipt.event_id !== eventId || receipt.event_body_sha256 !== bodySha256 ||
      stored.signature_algorithm !== "HMAC-SHA256" ||
      stored.signature_key_id !== key.keyId ||
      Number(stored.signature_key_version) !== key.keyVersion ||
      !constantTimeEqual(stored.receipt_sha256, expected.receipt_sha256) ||
      !constantTimeEqual(stored.signature_value, expected.signature.value)
    ) return null;
    return {
      receipt,
      receipt_sha256: stored.receipt_sha256,
      signature: {
        algorithm: stored.signature_algorithm,
        key_id: stored.signature_key_id,
        key_version: Number(stored.signature_key_version),
        value: stored.signature_value,
      },
    };
  } catch {
    return null;
  }
}

async function concurrentNonceReplayResponse(
  env: Env,
  nonceSha256: string,
  event: FacetV2CustomerDecisionEvent,
  bodySha256: string,
  key: FacetV2VerificationKey,
): Promise<Response | null> {
  const replay = await intakeByNonce(env, nonceSha256);
  if (!replay || replay.event_id !== event.event_id || replay.event_body_sha256 !== bodySha256)
    return null;
  const signed = await signedReceiptForIntake(
    env,
    replay.intake_id,
    event.event_id,
    bodySha256,
    key,
  );
  return signed ? facetJson(signed, receiptStatus(signed)) : null;
}

function activeReceiptSigningKey(
  keys: readonly FacetV2VerificationKey[],
  nowMs: number,
): FacetV2VerificationKey | null {
  return [...keys]
    .filter((key) => key.notBeforeMs <= nowMs && key.notAfterMs >= nowMs)
    .sort((left, right) =>
      right.notBeforeMs - left.notBeforeMs || right.keyVersion - left.keyVersion ||
      right.keyId.localeCompare(left.keyId)
    )[0] ?? null;
}

function receiptStatus(signed: SignedFacetV2Receipt): number {
  if (signed.receipt.result === "rejected") return 409;
  if (
    signed.receipt.result === "accepted_associated" ||
    signed.receipt.result === "accepted_unassociated"
  ) return 202;
  return 200;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function readRawJson(req: Request): Promise<
  { ok: true; text: string; bytes: number } |
  { ok: false; error: "content_type_required" | "payload_too_large" | "invalid_event_body"; status: 400 | 413 | 415 }
> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return { ok: false, error: "content_type_required", status: 415 };
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    return { ok: false, error: "payload_too_large", status: 413 };
  try {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES)
      return { ok: false, error: "payload_too_large", status: 413 };
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      bytes: bytes.byteLength,
    };
  } catch {
    return { ok: false, error: "invalid_event_body", status: 400 };
  }
}

function publicHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !url.search &&
      !url.hash && !!host && host !== "localhost" && !host.endsWith(".localhost") &&
      !host.endsWith(".local") && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(":");
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(value);
}

function keyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/.test(value);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function facetJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
