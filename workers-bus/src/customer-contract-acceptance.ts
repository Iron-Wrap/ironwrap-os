import {
  appPublicOrigin,
  authRequestContext,
  configuredTenantId,
  devOutboxCapture,
  randomToken,
  sha256Hex,
  validateAppOrigin,
} from "./app-auth.ts";
import {
  customerAcceptanceBackendConfigured,
  customerAcceptanceBackendEnabled,
} from "./customer-acceptance-config.ts";
import {
  findActiveCustomerPortalLink,
  type CustomerPortalLinkRecord,
} from "./customer-portal-store.ts";
import { r2ObjectStore } from "./field-actions.ts";
import { sendGmail } from "./google.ts";
import { ensureCommercialDepositDerivation } from "./commercial-deposit.ts";
import type { AppEnv, AuthRequestContext } from "./app-types.ts";

const MAX_BODY_BYTES = 2_048;
const CHALLENGE_TTL_MS = 15 * 60 * 1_000;
const NATIVE_COMMIT_LEASE_MS = 90 * 1_000;
const ACCEPTANCE_RECOVERY_WINDOW = 100;
const ACCEPTANCE_RECEIPT_CONTENT_TYPE = "application/json";

type ChallengeState = "pending_delivery" | "sent" | "consumed" | "invalidated";
type IntentState =
  "receipt_pending" | "receipt_stored" | "accepted" | "uncertain" | "rejected";

interface PreparedContract {
  email: string;
  emailHash: string;
  displayName: string;
  roofJobId: string;
  customerId: string;
  quoteId: string;
  quoteVersion: number;
  proposalPackId: string;
  termsHash: string;
  termsJson: string;
}

interface NativeContract extends PreparedContract {
  quoteRevisionId: string;
  proposalRevisionId: string;
  publicationEventId: string;
}

interface NativeContractRow {
  email: string;
  display_name: string;
  roof_job_id: string;
  customer_id: string;
  quote_revision_id: string;
  quote_id: string;
  quote_version: number;
  proposal_revision_id: string;
  proposal_pack_id: string;
  quote_terms_json: string;
  proposal_terms_json: string;
  quote_terms_hash: string;
  proposal_terms_hash: string;
  publication_event_id: string;
}

interface AcceptanceChallenge {
  challenge_id: string;
  token_hash: string;
  tenant_id: string;
  portal_link_id: string;
  roof_job_id: string;
  customer_id: string;
  email_hash: string;
  quote_id: string;
  quote_version: number;
  proposal_pack_id: string;
  terms_hash: string;
  terms_json: string;
  state: ChallengeState;
  created_at: string;
  expires_at: string;
  sent_at: string | null;
  provider_message_id: string | null;
  consumed_at: string | null;
  invalidated_at: string | null;
}

interface AcceptanceIntent {
  acceptance_id: string;
  idempotency_key_hash: string;
  request_fingerprint: string;
  challenge_id: string;
  tenant_id: string;
  portal_link_id: string;
  roof_job_id: string;
  customer_id: string;
  email_hash: string;
  quote_id: string;
  quote_version: number;
  proposal_pack_id: string;
  terms_hash: string;
  terms_json: string;
  signer_name: string;
  signer_ip_hash: string;
  accepted_at: string;
  receipt_key: string;
  receipt_hash: string | null;
  receipt_content_length: number | null;
  state: IntentState;
  frappe_attempted_at: string | null;
  frappe_attempt_lease_expires_at: string | null;
  result_json: string | null;
  response_status: number | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

type ClaimIntentResult =
  | { kind: "claimed"; intent: AcceptanceIntent }
  | { kind: "existing"; intent: AcceptanceIntent }
  | { kind: "conflict" }
  | { kind: "challenge_missing" }
  | { kind: "challenge_used" };

class AcceptanceLedgerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "AcceptanceLedgerError";
  }
}

export async function handleCustomerPortalAcceptanceChallenge(
  req: Request,
  env: AppEnv,
): Promise<Response> {
  if (req.method !== "POST" || !customerAcceptanceEnabled(env))
    return portalNotFound();
  if (!customerAcceptanceConfigured(env)) return portalUnavailable();
  if (!trustedPortalOrigin(req, env)) return portalNotFound();

  const request = await parseExactJson(req, ["token"]);
  if (!request || !validToken(request.token)) return portalNotFound();
  const tenantId = configuredTenantId(env);
  if (!tenantId) return portalUnavailable();

  const now = new Date();
  let link: CustomerPortalLinkRecord | null;
  try {
    link = await findActiveCustomerPortalLink(
      env,
      await sha256Hex(request.token),
      tenantId,
      now.toISOString(),
    );
  } catch {
    return portalUnavailable();
  }
  if (!link) return portalNotFound();

  const challengeId = `acceptance_challenge_${crypto.randomUUID()}`;
  let prepared: PreparedContract;
  try {
    const contract = await prepareContract(
      env,
      {
        tenant_id: tenantId,
        roof_job_id: link.roof_job_id,
        customer_id: link.customer_id,
      },
      now.toISOString(),
      now.toISOString().slice(0, 10),
    );
    if (!contract) return portalUnavailable();
    prepared = contract;
  } catch {
    return portalUnavailable();
  }

  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();
  const rawChallengeToken = randomToken();
  try {
    const context = await authRequestContext(req, env);
    await replaceAcceptanceChallenge(env, {
      challengeId,
      tokenHash: await sha256Hex(rawChallengeToken),
      tenantId,
      link,
      prepared,
      request: context,
      createdAt: now.toISOString(),
      expiresAt,
    });
    const delivery = await sendChallengeEmail(
      env,
      prepared,
      rawChallengeToken,
      expiresAt,
    );
    const sent = await markChallengeSent(
      env,
      challengeId,
      delivery.providerMessageId,
      new Date().toISOString(),
    );
    if (!sent) throw new Error("acceptance_challenge_delivery_ledger_failed");
  } catch {
    await invalidateAcceptanceChallenge(
      env,
      challengeId,
      new Date().toISOString(),
    ).catch(() => {});
    return acceptanceJson({ error: "acceptance_challenge_unavailable" }, 502);
  }
  return acceptanceJson({ status: "challenge_sent", expires_at: expiresAt });
}

export async function handleCustomerPortalAcceptanceConfirm(
  req: Request,
  env: AppEnv,
): Promise<Response> {
  if (req.method !== "POST" || !customerAcceptanceEnabled(env))
    return portalNotFound();
  if (!customerAcceptanceConfigured(env)) return portalUnavailable();
  if (!trustedPortalOrigin(req, env)) return portalNotFound();

  const request = await parseExactJson(req, [
    "token",
    "signer_name",
    "accepted",
  ]);
  if (!request || !validToken(request.token)) return portalNotFound();
  if (request.accepted !== true || !validSignerName(request.signer_name)) {
    return acceptanceJson({ error: "invalid_acceptance_attestation" }, 400);
  }
  const idempotencyKey = req.headers.get("idempotency-key") ?? "";
  if (!validIdempotencyKey(idempotencyKey)) {
    return acceptanceJson({ error: "idempotency_key_required" }, 400);
  }
  if (!requestIp(req))
    return acceptanceJson({ error: "signer_ip_required" }, 400);

  const tenantId = configuredTenantId(env);
  if (!tenantId) return portalUnavailable();
  const now = new Date();
  let requestContext: AuthRequestContext;
  let claim: ClaimIntentResult;
  try {
    requestContext = await authRequestContext(req, env);
    claim = await claimAcceptanceIntent(env, {
      acceptanceId: `acceptance_${crypto.randomUUID()}`,
      idempotencyKeyHash: await sha256Hex(idempotencyKey),
      requestFingerprint: await sha256Hex(
        canonicalJson({
          accepted: true,
          signer_name: request.signer_name,
          token: request.token,
        }),
      ),
      tokenHash: await sha256Hex(request.token),
      signerName: request.signer_name,
      signerIpHash: requestContext.ip_hash,
      now: now.toISOString(),
    });
  } catch {
    return portalUnavailable();
  }
  if (claim.kind === "conflict")
    return acceptanceJson({ error: "acceptance_idempotency_conflict" }, 409);
  if (claim.kind === "challenge_used")
    return acceptanceJson({ error: "acceptance_challenge_used" }, 409);
  if (claim.kind === "challenge_missing") return portalNotFound();

  return await settleAcceptanceIntent(env, claim.intent, requestContext);
}

/**
 * `frappe_attempted_at`, its lease, and the `frappe_commit_attempted` event are retained schema
 * names. They now mark the bounded native D1 commit and never imply a Frappe/network operation.
 * The sweep only closes a legacy/incomplete lease; immutable receipts and events are retained.
 */
export async function reconcileCustomerContractAcceptanceAttempts(
  env: AppEnv,
  now = new Date(),
): Promise<void> {
  const nowValue = now.toISOString();
  const expired = await env.DB.prepare(
    `${acceptanceIntentSelect}
     WHERE state = 'receipt_stored' AND frappe_attempted_at IS NOT NULL
       AND frappe_attempt_lease_expires_at <= ?`,
  )
    .bind(nowValue)
    .all<AcceptanceIntent>();
  await Promise.all(
    (expired.results ?? []).map((intent) =>
      finalizeAcceptanceIntent(env, intent, {
        state: "uncertain",
        response: { status: "uncertain", acceptance_id: intent.acceptance_id },
        responseStatus: 202,
        errorCode: "native_commit_lease_expired",
        now: nowValue,
      }),
    ),
  );
  await env.DB.prepare(
    `UPDATE customer_portal_acceptance_challenges
     SET state = 'invalidated', invalidated_at = ?
     WHERE state IN ('pending_delivery', 'sent') AND expires_at <= ?`,
  )
    .bind(nowValue, nowValue)
    .run();
  const cursor = await env.DB.prepare(
    `SELECT last_tenant_id, last_acceptance_id
       FROM commercial_deposit_derivation_cursors WHERE cursor_name = 'scheduled-v1'`,
  ).first<{ last_tenant_id: string; last_acceptance_id: string }>();
  const tenantCursor = cursor?.last_tenant_id === env.APP_TENANT_ID
    ? cursor.last_acceptance_id
    : "";
  const after = await env.DB.prepare(
    `SELECT acceptance_id, tenant_id FROM customer_portal_acceptance_intents
      WHERE tenant_id = ? AND state = 'accepted' AND acceptance_id > ?
      ORDER BY acceptance_id LIMIT ?`,
  ).bind(env.APP_TENANT_ID, tenantCursor, ACCEPTANCE_RECOVERY_WINDOW)
    .all<{ acceptance_id: string; tenant_id: string }>();
  const acceptedRows = [...(after.results ?? [])];
  if (tenantCursor && acceptedRows.length < ACCEPTANCE_RECOVERY_WINDOW) {
    const wrapped = await env.DB.prepare(
      `SELECT acceptance_id, tenant_id FROM customer_portal_acceptance_intents
        WHERE tenant_id = ? AND state = 'accepted' AND acceptance_id <= ?
        ORDER BY acceptance_id LIMIT ?`,
    ).bind(
      env.APP_TENANT_ID,
      tenantCursor,
      ACCEPTANCE_RECOVERY_WINDOW - acceptedRows.length,
    ).all<{ acceptance_id: string; tenant_id: string }>();
    acceptedRows.push(...(wrapped.results ?? []));
  }
  await Promise.all(
    acceptedRows.map((row) =>
      ensureCommercialDepositDerivation(env, {
        tenantId: row.tenant_id,
        acceptanceId: row.acceptance_id,
      }, now).catch(() => null),
    ),
  );
  const lastAcceptance = acceptedRows.at(-1);
  if (lastAcceptance) {
    await env.DB.prepare(
      `INSERT INTO commercial_deposit_derivation_cursors (
         cursor_name, last_tenant_id, last_acceptance_id, updated_at
       ) VALUES ('scheduled-v1', ?, ?, ?)
       ON CONFLICT(cursor_name) DO UPDATE SET
         last_tenant_id = excluded.last_tenant_id,
         last_acceptance_id = excluded.last_acceptance_id,
         updated_at = excluded.updated_at`,
    ).bind(lastAcceptance.tenant_id, lastAcceptance.acceptance_id, nowValue).run();
  }
}

async function settleAcceptanceIntent(
  env: AppEnv,
  initial: AcceptanceIntent,
  requestContext: AuthRequestContext,
): Promise<Response> {
  let intent = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const terminal = storedTerminalResponse(intent);
    if (terminal) {
      if (intent.state === "accepted") {
        await ensureCommercialDepositDerivation(env, {
          tenantId: intent.tenant_id,
          acceptanceId: intent.acceptance_id,
        }).catch(() => null);
      }
      return terminal;
    }
    if (intent.state === "receipt_pending") {
      if (intent.signer_ip_hash !== requestContext.ip_hash) {
        return acceptanceJson(
          { error: "acceptance_request_context_mismatch" },
          409,
        );
      }
      let receipt: Awaited<ReturnType<typeof receiptFor>>;
      try {
        receipt = await receiptFor(intent);
      } catch {
        return portalUnavailable();
      }
      try {
        await r2ObjectStore(env.RAW).ensure(
          intent.receipt_key,
          receipt.body,
          ACCEPTANCE_RECEIPT_CONTENT_TYPE,
          receipt.hash,
        );
      } catch {
        return acceptanceJson({ error: "acceptance_receipt_unavailable" }, 503);
      }
      const stored = await markReceiptStored(
        env,
        intent,
        receipt,
        new Date().toISOString(),
      );
      intent = (await getAcceptanceIntent(env, intent.acceptance_id)) ?? intent;
      if (stored || intent.state !== "receipt_pending") continue;
      return acceptanceJson({ error: "acceptance_receipt_unavailable" }, 503);
    }

    if (intent.state !== "receipt_stored") return portalUnavailable();
    const now = new Date();
    if (intent.frappe_attempted_at) {
      if (
        intent.frappe_attempt_lease_expires_at &&
        intent.frappe_attempt_lease_expires_at > now.toISOString()
      ) {
        const response = acceptanceJson(
          { error: "acceptance_in_progress" },
          503,
        );
        response.headers.set("retry-after", "3");
        return response;
      }
      const uncertain = await finalizeAcceptanceIntent(env, intent, {
        state: "uncertain",
        response: { status: "uncertain", acceptance_id: intent.acceptance_id },
        responseStatus: 202,
        errorCode: "native_commit_lease_expired",
        now: now.toISOString(),
      });
      return uncertain
        ? acceptanceJson(
            { status: "uncertain", acceptance_id: intent.acceptance_id },
            202,
          )
        : portalUnavailable();
    }
    if (intent.signer_ip_hash !== requestContext.ip_hash) {
      return acceptanceJson(
        { error: "acceptance_request_context_mismatch" },
        409,
      );
    }
    let challenge: AcceptanceChallenge | null;
    let contract: NativeContract | null;
    try {
      challenge = await getAcceptanceChallenge(env, intent.challenge_id);
      contract = challenge
        ? await prepareContract(
            env,
            {
              tenant_id: intent.tenant_id,
              roof_job_id: intent.roof_job_id,
              customer_id: intent.customer_id,
            },
            challenge.created_at,
            now.toISOString().slice(0, 10),
          )
        : null;
    } catch {
      return portalUnavailable();
    }
    if (!challenge || !contract || !sameContract(intent, contract)) {
      return await rejectNativeAcceptance(
        env,
        intent,
        "native_contract_changed",
        now,
      );
    }
    return await commitNativeAcceptance(
      env,
      intent,
      contract,
      challenge.created_at,
      now,
    );
  }
  return acceptanceJson({ error: "acceptance_in_progress" }, 503);
}

function customerAcceptanceConfigured(env: AppEnv): boolean {
  const runtime = env as unknown as Record<string, unknown>;
  const db = runtime.DB as { prepare?: unknown; batch?: unknown } | undefined;
  const raw = runtime.RAW as { head?: unknown; put?: unknown } | undefined;
  return (
    customerAcceptanceBackendConfigured(env) &&
    !!configuredTenantId(env) &&
    !!appPublicOrigin(env) &&
    (env.APP_AUTH_PEPPER?.trim().length ?? 0) >= 32 &&
    typeof db?.prepare === "function" &&
    typeof db.batch === "function" &&
    typeof raw?.head === "function" &&
    typeof raw.put === "function"
  );
}

function customerAcceptanceEnabled(env: AppEnv): boolean {
  return (
    String(env.APP_CUSTOMER_PORTAL_ENABLED) === "true" &&
    customerAcceptanceBackendEnabled(env)
  );
}

/** The portal CTA and challenge issuance share this exact native authority predicate. */
export async function customerContractAcceptanceAvailable(
  env: AppEnv,
  claim: { tenant_id: string; roof_job_id: string; customer_id: string },
  now = new Date(),
): Promise<boolean> {
  if (!customerAcceptanceEnabled(env) || !customerAcceptanceConfigured(env)) {
    return false;
  }
  const snapshotAt = now.toISOString();
  try {
    return !!(await prepareContract(
      env,
      claim,
      snapshotAt,
      snapshotAt.slice(0, 10),
    ));
  } catch {
    return false;
  }
}

function trustedPortalOrigin(req: Request, env: AppEnv): boolean {
  const configuredOrigin = appPublicOrigin(env);
  const origin = validateAppOrigin(req, env, true);
  return origin.ok && !!configuredOrigin && origin.origin === configuredOrigin;
}

async function prepareContract(
  env: AppEnv,
  claim: { tenant_id: string; roof_job_id: string; customer_id: string },
  snapshotAt: string,
  validOn: string,
): Promise<NativeContract | null> {
  if (
    !Number.isFinite(Date.parse(snapshotAt)) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(validOn)
  )
    return null;
  const rows = await env.DB.prepare(
    `SELECT customer.contact_email AS email, customer.display_name,
            job.roof_job_id, customer.customer_id,
            quote.quote_revision_id, quote.customer_quote_id AS quote_id,
            quote.revision_number AS quote_version,
            proposal.proposal_revision_id, proposal.proposal_pack_id,
            quote.terms_json AS quote_terms_json,
            proposal.terms_json AS proposal_terms_json,
            quote.terms_hash AS quote_terms_hash,
            proposal.terms_hash AS proposal_terms_hash,
            publication.publication_event_id
       FROM operating_customers customer
       JOIN operating_roof_jobs job
         ON job.tenant_id = customer.tenant_id AND job.customer_id = customer.customer_id
       JOIN operating_leads lead
         ON lead.tenant_id = job.tenant_id
        AND lead.lead_id = job.lead_id
       JOIN commercial_quote_revisions quote
         ON quote.tenant_id = customer.tenant_id AND quote.roof_job_id = job.roof_job_id
        AND quote.customer_id = customer.customer_id
       JOIN commercial_proposal_revisions proposal
         ON proposal.tenant_id = quote.tenant_id
        AND proposal.quote_revision_id = quote.quote_revision_id
        AND proposal.roof_job_id = quote.roof_job_id
        AND proposal.customer_id = quote.customer_id
       JOIN commercial_proposal_publication_events publication
         ON publication.tenant_id = proposal.tenant_id
        AND publication.proposal_pack_id = proposal.proposal_pack_id
        AND publication.proposal_revision_id = proposal.proposal_revision_id
      WHERE customer.tenant_id = ? AND customer.customer_id = ? AND job.roof_job_id = ?
        AND customer.lifecycle_status != 'archived' AND job.job_status != 'cancelled'
       AND quote.status = 'approved' AND quote.valid_until >= ?
        AND (
          lead.lifecycle_status = 'qualified'
          OR (
            lead.lifecycle_status = 'converted'
            AND quote.revision_number > 1
            AND quote.supersedes_quote_revision_id IS NOT NULL
          )
        )
        AND quote.terms_hash = proposal.terms_hash
        AND quote.revision_number = (
          SELECT MAX(current.revision_number) FROM commercial_quote_revisions current
           WHERE current.tenant_id = quote.tenant_id
             AND current.customer_quote_id = quote.customer_quote_id
        )
        AND proposal.revision_number = (
          SELECT MAX(current.revision_number) FROM commercial_proposal_revisions current
           WHERE current.tenant_id = proposal.tenant_id
             AND current.proposal_pack_id = proposal.proposal_pack_id
        )
        AND publication.publication_version = (
          SELECT MAX(current.publication_version)
            FROM commercial_proposal_publication_events current
           WHERE current.tenant_id = publication.tenant_id
             AND current.proposal_pack_id = publication.proposal_pack_id
        )
        AND publication.state = 'published'
        AND quote.created_at <= ? AND proposal.created_at <= ? AND publication.occurred_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM commercial_quote_revisions changed
           WHERE changed.tenant_id = customer.tenant_id
             AND changed.roof_job_id = job.roof_job_id
             AND changed.customer_id = customer.customer_id
             AND changed.created_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_revisions changed
           WHERE changed.tenant_id = customer.tenant_id
             AND changed.roof_job_id = job.roof_job_id
             AND changed.customer_id = customer.customer_id
             AND changed.created_at > ?
        )
        AND NOT EXISTS (
          SELECT 1
            FROM commercial_proposal_publication_events changed
            JOIN commercial_proposal_revisions changed_proposal
              ON changed_proposal.tenant_id = changed.tenant_id
             AND changed_proposal.proposal_revision_id = changed.proposal_revision_id
           WHERE changed.tenant_id = customer.tenant_id
             AND changed_proposal.roof_job_id = job.roof_job_id
             AND changed_proposal.customer_id = customer.customer_id
             AND changed.occurred_at > ?
        )
      ORDER BY quote.customer_quote_id, proposal.proposal_pack_id
      LIMIT 2`,
  )
    .bind(
      claim.tenant_id,
      claim.customer_id,
      claim.roof_job_id,
      validOn,
      snapshotAt,
      snapshotAt,
      snapshotAt,
      snapshotAt,
      snapshotAt,
      snapshotAt,
    )
    .all<NativeContractRow>();
  if ((rows.results ?? []).length !== 1) return null;
  const row = rows.results![0]!;
  const email = validEmail(row.email) ? row.email : null;
  const displayName = boundedText(row.display_name, 1, 160);
  const roofJobId = boundedText(row.roof_job_id, 3, 140);
  const customerId = boundedText(row.customer_id, 3, 140);
  const quoteRevisionId = boundedText(row.quote_revision_id, 12, 160);
  const quoteId = boundedText(row.quote_id, 3, 140);
  const quoteVersion = boundedInteger(row.quote_version, 1, 1_000_000);
  const proposalRevisionId = boundedText(row.proposal_revision_id, 12, 160);
  const proposalPackId = boundedText(row.proposal_pack_id, 3, 140);
  const publicationEventId = boundedText(row.publication_event_id, 20, 120);
  const termsHash =
    /^[0-9a-f]{64}$/.test(row.quote_terms_hash) &&
    row.quote_terms_hash === row.proposal_terms_hash
      ? row.quote_terms_hash
      : null;
  let quoteTerms: unknown;
  let proposalTerms: unknown;
  try {
    quoteTerms = JSON.parse(row.quote_terms_json) as unknown;
    proposalTerms = JSON.parse(row.proposal_terms_json) as unknown;
  } catch {
    return null;
  }
  const termsJson = isRecord(quoteTerms) ? canonicalJson(quoteTerms) : "";
  if (
    !email ||
    !displayName ||
    roofJobId !== claim.roof_job_id ||
    customerId !== claim.customer_id ||
    !quoteRevisionId ||
    !quoteId ||
    !quoteVersion ||
    !proposalRevisionId ||
    !proposalPackId ||
    !publicationEventId ||
    !termsHash ||
    !isRecord(proposalTerms) ||
    canonicalJson(proposalTerms) !== termsJson ||
    termsJson.length > 48_000 ||
    (await sha256Hex(termsJson)) !== termsHash
  )
    return null;
  return {
    email,
    emailHash: await sha256Hex(email.toLowerCase()),
    displayName,
    roofJobId,
    customerId,
    quoteRevisionId,
    quoteId,
    quoteVersion,
    proposalRevisionId,
    proposalPackId,
    publicationEventId,
    termsHash,
    termsJson,
  };
}

function sameContract(
  intent: AcceptanceIntent,
  contract: NativeContract,
): boolean {
  return (
    intent.roof_job_id === contract.roofJobId &&
    intent.customer_id === contract.customerId &&
    intent.email_hash === contract.emailHash &&
    intent.quote_id === contract.quoteId &&
    Number(intent.quote_version) === contract.quoteVersion &&
    intent.proposal_pack_id === contract.proposalPackId &&
    intent.terms_hash === contract.termsHash &&
    intent.terms_json === contract.termsJson
  );
}

async function commitNativeAcceptance(
  env: AppEnv,
  intent: AcceptanceIntent,
  contract: NativeContract,
  challengeCreatedAt: string,
  now: Date,
): Promise<Response> {
  const receipt = await receiptFor(intent);
  if (
    intent.receipt_hash !== receipt.hash ||
    intent.receipt_content_length !== receipt.length
  ) {
    return portalUnavailable();
  }
  const attemptedAt = now.toISOString();
  const leaseExpiresAt = new Date(
    now.getTime() + NATIVE_COMMIT_LEASE_MS,
  ).toISOString();
  const accepted = {
    status: "accepted" as const,
    acceptance_id: intent.acceptance_id,
  };
  const rejected = { error: "acceptance_rejected" };
  const bindingId = `commercial-acceptance:${await sha256Hex(
    `${intent.tenant_id}:${await sha256Hex(intent.acceptance_id)}`,
  )}`;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE customer_portal_acceptance_intents
         SET frappe_attempted_at = ?, frappe_attempt_lease_expires_at = ?, updated_at = ?
         WHERE acceptance_id = ? AND state = 'receipt_stored' AND frappe_attempted_at IS NULL`,
      ).bind(attemptedAt, leaseExpiresAt, attemptedAt, intent.acceptance_id),
      env.DB.prepare(
        `UPDATE customer_portal_acceptance_intents
         SET state = 'accepted', frappe_attempt_lease_expires_at = NULL, result_json = ?,
             response_status = 200, error_code = NULL, completed_at = ?, updated_at = ?
         WHERE acceptance_id = ? AND state = 'receipt_stored' AND frappe_attempted_at = ?
           AND EXISTS (
             SELECT 1
               FROM operating_customers customer
               JOIN operating_roof_jobs job
                 ON job.tenant_id = customer.tenant_id AND job.customer_id = customer.customer_id
               JOIN operating_leads lead
                 ON lead.tenant_id = job.tenant_id
                AND lead.lead_id = job.lead_id
               JOIN commercial_quote_revisions quote
                 ON quote.tenant_id = customer.tenant_id AND quote.roof_job_id = job.roof_job_id
                AND quote.customer_id = customer.customer_id
               JOIN commercial_proposal_revisions proposal
                 ON proposal.tenant_id = quote.tenant_id
                AND proposal.quote_revision_id = quote.quote_revision_id
               JOIN commercial_proposal_publication_events publication
                 ON publication.tenant_id = proposal.tenant_id
                AND publication.proposal_revision_id = proposal.proposal_revision_id
              WHERE customer.tenant_id = ? AND customer.customer_id = ? AND job.roof_job_id = ?
                AND lower(trim(customer.contact_email)) = ?
                AND customer.lifecycle_status != 'archived' AND job.job_status != 'cancelled'
                AND quote.quote_revision_id = ? AND quote.customer_quote_id = ?
                AND quote.revision_number = ? AND quote.status = 'approved' AND quote.valid_until >= ?
                AND (
                  lead.lifecycle_status = 'qualified'
                  OR (
                    lead.lifecycle_status = 'converted'
                    AND quote.revision_number > 1
                    AND quote.supersedes_quote_revision_id IS NOT NULL
                  )
                )
                AND proposal.proposal_revision_id = ? AND proposal.proposal_pack_id = ?
                AND publication.publication_event_id = ? AND publication.state = 'published'
                AND quote.terms_hash = ? AND proposal.terms_hash = ?
                AND quote.revision_number = (
                  SELECT MAX(current.revision_number) FROM commercial_quote_revisions current
                   WHERE current.tenant_id = quote.tenant_id
                     AND current.customer_quote_id = quote.customer_quote_id
                )
                AND proposal.revision_number = (
                  SELECT MAX(current.revision_number) FROM commercial_proposal_revisions current
                   WHERE current.tenant_id = proposal.tenant_id
                     AND current.proposal_pack_id = proposal.proposal_pack_id
                )
                AND publication.publication_version = (
                  SELECT MAX(current.publication_version)
                    FROM commercial_proposal_publication_events current
                   WHERE current.tenant_id = publication.tenant_id
                     AND current.proposal_pack_id = publication.proposal_pack_id
                )
                AND quote.created_at <= ? AND proposal.created_at <= ?
                AND publication.occurred_at <= ?
                AND NOT EXISTS (
                  SELECT 1 FROM commercial_quote_revisions changed
                   WHERE changed.tenant_id = customer.tenant_id
                     AND changed.roof_job_id = job.roof_job_id
                     AND changed.customer_id = customer.customer_id
                     AND changed.created_at > ?
                )
                AND NOT EXISTS (
                  SELECT 1 FROM commercial_proposal_revisions changed
                   WHERE changed.tenant_id = customer.tenant_id
                     AND changed.roof_job_id = job.roof_job_id
                     AND changed.customer_id = customer.customer_id
                     AND changed.created_at > ?
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM commercial_proposal_publication_events changed
                    JOIN commercial_proposal_revisions changed_proposal
                      ON changed_proposal.tenant_id = changed.tenant_id
                     AND changed_proposal.proposal_revision_id = changed.proposal_revision_id
                   WHERE changed.tenant_id = customer.tenant_id
                     AND changed_proposal.roof_job_id = job.roof_job_id
                     AND changed_proposal.customer_id = customer.customer_id
                     AND changed.occurred_at > ?
                )
           )`,
      ).bind(
        canonicalJson(accepted),
        attemptedAt,
        attemptedAt,
        intent.acceptance_id,
        attemptedAt,
        intent.tenant_id,
        intent.customer_id,
        intent.roof_job_id,
        contract.email.toLowerCase(),
        contract.quoteRevisionId,
        contract.quoteId,
        contract.quoteVersion,
        now.toISOString().slice(0, 10),
        contract.proposalRevisionId,
        contract.proposalPackId,
        contract.publicationEventId,
        contract.termsHash,
        contract.termsHash,
        challengeCreatedAt,
        challengeCreatedAt,
        challengeCreatedAt,
        challengeCreatedAt,
        challengeCreatedAt,
        challengeCreatedAt,
      ),
      env.DB.prepare(
        `INSERT INTO commercial_acceptance_bindings (
           acceptance_binding_id, acceptance_id, tenant_id, quote_revision_id,
           proposal_revision_id, roof_job_id, customer_id, terms_hash, receipt_hash,
           accepted_at, bound_at
         )
         SELECT ?, acceptance_id, tenant_id, ?, ?, roof_job_id, customer_id, terms_hash,
                receipt_hash, accepted_at, ?
           FROM customer_portal_acceptance_intents
          WHERE acceptance_id = ? AND state = 'accepted'
            AND NOT EXISTS (
              SELECT 1 FROM commercial_acceptance_bindings binding
               WHERE binding.acceptance_id = customer_portal_acceptance_intents.acceptance_id
            )`,
      ).bind(
        bindingId,
        contract.quoteRevisionId,
        contract.proposalRevisionId,
        attemptedAt,
        intent.acceptance_id,
      ),
      env.DB.prepare(
        `UPDATE customer_portal_acceptance_intents
         SET state = 'rejected', frappe_attempt_lease_expires_at = NULL, result_json = ?,
             response_status = 409, error_code = 'native_contract_changed', completed_at = ?,
             updated_at = ?
         WHERE acceptance_id = ? AND state = 'receipt_stored' AND frappe_attempted_at = ?`,
      ).bind(
        canonicalJson(rejected),
        attemptedAt,
        attemptedAt,
        intent.acceptance_id,
        attemptedAt,
      ),
    ]);
  } catch {
    // D1 may commit and lose the response; the immutable intent + binding are the readback.
  }
  return await nativeTerminalResponse(env, intent.acceptance_id, contract);
}

async function rejectNativeAcceptance(
  env: AppEnv,
  intent: AcceptanceIntent,
  code: string,
  now: Date,
): Promise<Response> {
  const attemptedAt = now.toISOString();
  const rejected = { error: "acceptance_rejected" };
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE customer_portal_acceptance_intents
         SET frappe_attempted_at = ?, frappe_attempt_lease_expires_at = ?, updated_at = ?
         WHERE acceptance_id = ? AND state = 'receipt_stored' AND frappe_attempted_at IS NULL`,
      ).bind(
        attemptedAt,
        new Date(now.getTime() + NATIVE_COMMIT_LEASE_MS).toISOString(),
        attemptedAt,
        intent.acceptance_id,
      ),
      env.DB.prepare(
        `UPDATE customer_portal_acceptance_intents
         SET state = 'rejected', frappe_attempt_lease_expires_at = NULL, result_json = ?,
             response_status = 409, error_code = ?, completed_at = ?, updated_at = ?
         WHERE acceptance_id = ? AND state = 'receipt_stored' AND frappe_attempted_at = ?`,
      ).bind(
        canonicalJson(rejected),
        code,
        attemptedAt,
        attemptedAt,
        intent.acceptance_id,
        attemptedAt,
      ),
    ]);
  } catch {
    // A concurrent replay may already have committed the terminal state.
  }
  const current = await getAcceptanceIntent(env, intent.acceptance_id);
  return current
    ? (storedTerminalResponse(current) ?? portalUnavailable())
    : portalUnavailable();
}

async function nativeTerminalResponse(
  env: AppEnv,
  acceptanceId: string,
  contract: NativeContract,
): Promise<Response> {
  const current = await getAcceptanceIntent(env, acceptanceId);
  if (!current) return portalUnavailable();
  if (current.state !== "accepted")
    return storedTerminalResponse(current) ?? portalUnavailable();
  const binding = await env.DB.prepare(
    `SELECT quote_revision_id, proposal_revision_id, receipt_hash
       FROM commercial_acceptance_bindings
      WHERE tenant_id = ? AND acceptance_id = ? LIMIT 1`,
  )
    .bind(current.tenant_id, acceptanceId)
    .first<{
      quote_revision_id: string;
      proposal_revision_id: string;
      receipt_hash: string;
    }>();
  if (
    !binding ||
    binding.quote_revision_id !== contract.quoteRevisionId ||
    binding.proposal_revision_id !== contract.proposalRevisionId ||
    binding.receipt_hash !== current.receipt_hash
  )
    return portalUnavailable();
  await ensureCommercialDepositDerivation(env, {
    tenantId: current.tenant_id,
    acceptanceId,
  }).catch(() => null);
  return storedTerminalResponse(current) ?? portalUnavailable();
}

async function sendChallengeEmail(
  env: AppEnv,
  prepared: PreparedContract,
  rawToken: string,
  expiresAt: string,
): Promise<{ providerMessageId: string }> {
  const origin = appPublicOrigin(env);
  if (!origin) throw new Error("acceptance_email_origin_unavailable");
  const href = `${origin}/contract-accept#token=${encodeURIComponent(rawToken)}`;
  const greeting = escapeHtml(prepared.displayName);
  const expiry = escapeHtml(
    new Date(expiresAt).toLocaleString("en-CA", {
      timeZone: "America/Edmonton",
    }),
  );
  // Same local-only escape hatch the magic-link rail uses (app-auth.devOutboxCapture):
  // APP_ALLOW_INSECURE_LOCAL is "false" in every deployed environment, so a deployed
  // Worker always falls through to Gmail. Without this the acceptance half of the
  // customer portal could not be driven end to end on a local stack at all.
  if (
    await devOutboxCapture(env, "contract_acceptance", prepared.email, href)
  ) {
    return { providerMessageId: `dev-outbox:${crypto.randomUUID()}` };
  }
  return await sendGmail(
    env,
    prepared.email,
    "Confirm your contract acceptance",
    `<p>Hello ${greeting},</p><p><a href="${escapeHtml(href)}">Review and confirm your contract acceptance</a>.</p><p>This single-use link expires ${expiry}.</p>`,
  );
}

async function replaceAcceptanceChallenge(
  env: AppEnv,
  input: {
    challengeId: string;
    tokenHash: string;
    tenantId: string;
    link: CustomerPortalLinkRecord;
    prepared: PreparedContract;
    request: AuthRequestContext;
    createdAt: string;
    expiresAt: string;
  },
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE customer_portal_acceptance_challenges
       SET state = 'invalidated', invalidated_at = ?
       WHERE portal_link_id = ? AND state IN ('pending_delivery', 'sent')`,
    ).bind(input.createdAt, input.link.link_id),
    env.DB.prepare(
      `INSERT INTO customer_portal_acceptance_challenges
         (challenge_id, token_hash, tenant_id, portal_link_id, roof_job_id, customer_id,
          email_hash, quote_id, quote_version, proposal_pack_id, terms_hash, terms_json,
          request_ip_hash, request_user_agent_hash, state, created_at, expires_at, sent_at,
          provider_message_id, consumed_at, invalidated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_delivery', ?, ?, NULL, NULL, NULL, NULL)`,
    ).bind(
      input.challengeId,
      input.tokenHash,
      input.tenantId,
      input.link.link_id,
      input.link.roof_job_id,
      input.link.customer_id,
      input.prepared.emailHash,
      input.prepared.quoteId,
      input.prepared.quoteVersion,
      input.prepared.proposalPackId,
      input.prepared.termsHash,
      input.prepared.termsJson,
      input.request.ip_hash,
      input.request.user_agent_hash,
      input.createdAt,
      input.expiresAt,
    ),
  ]);
}

async function markChallengeSent(
  env: AppEnv,
  challengeId: string,
  providerMessageId: string,
  sentAt: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE customer_portal_acceptance_challenges
     SET state = 'sent', sent_at = ?, provider_message_id = ?
     WHERE challenge_id = ? AND state = 'pending_delivery'`,
  )
    .bind(sentAt, providerMessageId, challengeId)
    .run();
  return d1Changes(result) === 1;
}

async function invalidateAcceptanceChallenge(
  env: AppEnv,
  challengeId: string,
  now: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE customer_portal_acceptance_challenges
     SET state = 'invalidated', invalidated_at = ?
     WHERE challenge_id = ? AND state IN ('pending_delivery', 'sent')`,
  )
    .bind(now, challengeId)
    .run();
}

async function claimAcceptanceIntent(
  env: AppEnv,
  input: {
    acceptanceId: string;
    idempotencyKeyHash: string;
    requestFingerprint: string;
    tokenHash: string;
    signerName: string;
    signerIpHash: string;
    now: string;
  },
): Promise<ClaimIntentResult> {
  const receiptKey = `customer-contract-acceptance/v1/${input.acceptanceId}.json`;
  const inserted = await env.DB.prepare(
    `INSERT INTO customer_portal_acceptance_intents
       (acceptance_id, idempotency_key_hash, request_fingerprint, challenge_id, tenant_id,
        portal_link_id, roof_job_id, customer_id, email_hash, quote_id, quote_version, proposal_pack_id,
        terms_hash, terms_json, signer_name, signer_ip_hash, accepted_at,
        receipt_key, receipt_hash, receipt_content_length, state, frappe_attempted_at,
        frappe_attempt_lease_expires_at, result_json, response_status, error_code, created_at,
        updated_at, completed_at)
     SELECT ?, ?, ?, challenge_id, tenant_id, portal_link_id, roof_job_id, customer_id, email_hash,
            quote_id, quote_version, proposal_pack_id, terms_hash, terms_json,
            ?, ?, ?, ?, NULL, NULL, 'receipt_pending', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
     FROM customer_portal_acceptance_challenges AS challenge
     WHERE challenge.token_hash = ? AND challenge.state = 'sent' AND challenge.expires_at > ?
       AND EXISTS (
         SELECT 1 FROM customer_portal_links AS link
         WHERE link.link_id = challenge.portal_link_id AND link.tenant_id = challenge.tenant_id
           AND link.roof_job_id = challenge.roof_job_id AND link.customer_id = challenge.customer_id
           AND link.revoked_at IS NULL AND link.expires_at > ?
       )
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      input.acceptanceId,
      input.idempotencyKeyHash,
      input.requestFingerprint,
      input.signerName,
      input.signerIpHash,
      input.now,
      receiptKey,
      input.now,
      input.now,
      input.tokenHash,
      input.now,
      input.now,
    )
    .run();
  const existing = await getAcceptanceIntentByIdempotency(
    env,
    input.idempotencyKeyHash,
  );
  if (existing) {
    if (existing.request_fingerprint !== input.requestFingerprint)
      return { kind: "conflict" };
    return d1Changes(inserted) > 0
      ? { kind: "claimed", intent: existing }
      : { kind: "existing", intent: existing };
  }
  const challenge = await getAcceptanceChallengeByTokenHash(
    env,
    input.tokenHash,
  );
  return challenge?.state === "consumed"
    ? { kind: "challenge_used" }
    : { kind: "challenge_missing" };
}

async function markReceiptStored(
  env: AppEnv,
  intent: AcceptanceIntent,
  receipt: { hash: string; length: number },
  now: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE customer_portal_acceptance_intents
     SET receipt_hash = ?, receipt_content_length = ?, state = 'receipt_stored', updated_at = ?
     WHERE acceptance_id = ? AND state = 'receipt_pending'`,
  )
    .bind(receipt.hash, receipt.length, now, intent.acceptance_id)
    .run();
  return d1Changes(result) > 0;
}

async function finalizeAcceptanceIntent(
  env: AppEnv,
  intent: AcceptanceIntent,
  input: {
    state: "accepted" | "uncertain" | "rejected";
    response: Record<string, string>;
    responseStatus: number;
    errorCode: string | null;
    now: string;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE customer_portal_acceptance_intents
     SET state = ?, frappe_attempt_lease_expires_at = NULL, result_json = ?, response_status = ?,
         error_code = ?, completed_at = ?, updated_at = ?
     WHERE acceptance_id = ? AND state = 'receipt_stored' AND frappe_attempted_at IS NOT NULL`,
  )
    .bind(
      input.state,
      canonicalJson(input.response),
      input.responseStatus,
      input.errorCode,
      input.now,
      input.now,
      intent.acceptance_id,
    )
    .run();
  return d1Changes(result) > 0;
}

async function getAcceptanceIntent(
  env: AppEnv,
  acceptanceId: string,
): Promise<AcceptanceIntent | null> {
  return await env.DB.prepare(
    `${acceptanceIntentSelect} WHERE acceptance_id = ? LIMIT 1`,
  )
    .bind(acceptanceId)
    .first<AcceptanceIntent>();
}

async function getAcceptanceIntentByIdempotency(
  env: AppEnv,
  idempotencyKeyHash: string,
): Promise<AcceptanceIntent | null> {
  return await env.DB.prepare(
    `${acceptanceIntentSelect} WHERE idempotency_key_hash = ? LIMIT 1`,
  )
    .bind(idempotencyKeyHash)
    .first<AcceptanceIntent>();
}

async function getAcceptanceChallengeByTokenHash(
  env: AppEnv,
  tokenHash: string,
): Promise<AcceptanceChallenge | null> {
  return await env.DB.prepare(
    `SELECT challenge_id, token_hash, tenant_id, portal_link_id, roof_job_id, customer_id, email_hash,
            quote_id, quote_version, proposal_pack_id, terms_hash, terms_json,
            state, created_at, expires_at, sent_at, provider_message_id, consumed_at, invalidated_at
     FROM customer_portal_acceptance_challenges WHERE token_hash = ? LIMIT 1`,
  )
    .bind(tokenHash)
    .first<AcceptanceChallenge>();
}

async function getAcceptanceChallenge(
  env: AppEnv,
  challengeId: string,
): Promise<AcceptanceChallenge | null> {
  return await env.DB.prepare(
    `SELECT challenge_id, token_hash, tenant_id, portal_link_id, roof_job_id, customer_id, email_hash,
            quote_id, quote_version, proposal_pack_id, terms_hash, terms_json,
            state, created_at, expires_at, sent_at, provider_message_id, consumed_at, invalidated_at
       FROM customer_portal_acceptance_challenges WHERE challenge_id = ? LIMIT 1`,
  )
    .bind(challengeId)
    .first<AcceptanceChallenge>();
}

const acceptanceIntentSelect = `SELECT acceptance_id, idempotency_key_hash, request_fingerprint,
  challenge_id, tenant_id, portal_link_id, roof_job_id, customer_id, email_hash, quote_id, quote_version,
  proposal_pack_id, terms_hash, terms_json, signer_name, signer_ip_hash,
  accepted_at, receipt_key, receipt_hash, receipt_content_length, state, frappe_attempted_at,
  frappe_attempt_lease_expires_at, result_json, response_status, error_code, created_at, updated_at,
  completed_at FROM customer_portal_acceptance_intents`;

async function receiptFor(
  intent: AcceptanceIntent,
): Promise<{ body: string; hash: string; length: number }> {
  let terms: unknown;
  try {
    terms = JSON.parse(intent.terms_json) as unknown;
  } catch {
    throw new AcceptanceLedgerError("acceptance_terms_ledger_invalid");
  }
  if (
    !isRecord(terms) ||
    (await sha256Hex(canonicalJson(terms))) !== intent.terms_hash
  ) {
    throw new AcceptanceLedgerError("acceptance_terms_ledger_mismatch");
  }
  const body = canonicalJson({
    version: 1,
    kind: "customer_contract_acceptance",
    acceptance_id: intent.acceptance_id,
    challenge_id: intent.challenge_id,
    portal_link_id: intent.portal_link_id,
    tenant_id: intent.tenant_id,
    roof_job_id: intent.roof_job_id,
    customer_id: intent.customer_id,
    email_hash: intent.email_hash,
    quote_id: intent.quote_id,
    quote_version: Number(intent.quote_version),
    proposal_pack_id: intent.proposal_pack_id,
    terms,
    terms_hash: intent.terms_hash,
    signer_name: intent.signer_name,
    signer_ip_hash: intent.signer_ip_hash,
    accepted: true,
    accepted_at: intent.accepted_at,
  });
  return {
    body,
    hash: await sha256Hex(body),
    length: new TextEncoder().encode(body).byteLength,
  };
}

function storedTerminalResponse(intent: AcceptanceIntent): Response | null {
  if (
    !(["accepted", "uncertain", "rejected"] as string[]).includes(intent.state)
  )
    return null;
  if (!intent.result_json || !intent.response_status)
    return portalUnavailable();
  try {
    const body = JSON.parse(intent.result_json) as unknown;
    if (!isRecord(body)) return portalUnavailable();
    if (
      intent.state === "accepted" &&
      body.status === "accepted" &&
      body.acceptance_id === intent.acceptance_id
    )
      return acceptanceJson(body, 200);
    if (
      intent.state === "uncertain" &&
      body.status === "uncertain" &&
      body.acceptance_id === intent.acceptance_id
    )
      return acceptanceJson(body, 202);
    if (intent.state === "rejected" && body.error === "acceptance_rejected") {
      return acceptanceJson(body, intent.response_status);
    }
  } catch {
    // A corrupt ledger must not become a retryable native commit.
  }
  return portalUnavailable();
}

async function parseExactJson(
  req: Request,
  keys: readonly string[],
): Promise<Record<string, unknown> | null> {
  if (
    !req.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return null;
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return null;
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !sameKeys(value, keys)) return null;
    return value;
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("non_finite_json_number");
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("unsupported_json_value");
  return encoded;
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value);
}

function validSignerName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 160 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function boundedText(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" &&
    value === value.trim() &&
    value.length >= min &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

function requestIp(req: Request): string | null {
  const value = (req.headers.get("cf-connecting-ip") ?? "").trim();
  return value && value.length <= 64 && /^[0-9A-Fa-f:.]+$/.test(value)
    ? value
    : null;
}

function d1Changes(result: { meta?: { changes?: number } }): number {
  return Number(result.meta?.changes ?? 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

function portalNotFound(): Response {
  return acceptanceJson({ error: "not_found" }, 404);
}

function portalUnavailable(): Response {
  return acceptanceJson({ error: "portal_unavailable" }, 503);
}

function acceptanceJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
