/**
 * The independently permissioned release issuer (IRO-219).
 *
 * The release admission job cannot promote anything until a principal that is NOT the release
 * pipeline acknowledges the exact source under review. This Worker is that principal. It does one
 * thing: it accepts a canonical, fresh, correctly-addressed trigger and writes a durable
 * acknowledgement naming the run id the eventual GO receipt must carry.
 *
 * What it deliberately does NOT do, because doing it here would collapse the separation the whole
 * gate exists for: it signs nothing, it mints no findings, it publishes no receipt, and it holds
 * neither the review private key nor any deployment credential. A human or agent acting as the
 * reviewer reads the acknowledgement, judges the source, and publishes a signed GO with
 * `release-promotion.mjs review-sign` / `review-publish`.
 *
 * Deploy it to its own Cloudflare Worker, under an API token with no authority over the
 * ironwrap-bus Workers, D1, or R2. Sharing a token would put the reviewer and the released system
 * under one custodian again.
 */

import {
  INDEPENDENT_ISSUER_ROUTE,
  IssuerError,
  MAX_BODY_BYTES,
  acknowledgementFor,
  canonicalJson,
  secretEquals,
  sha256Hex,
  validateIndependentIssuerRequest,
} from "./contract.mjs";

const ACK_ROUTE =
  /^\/v2\/independent-issuer\/acknowledgements\/([0-9a-f]{40})$/;
/** Matches the enforcer's own floor for a service credential (`SERVICE_ADAPTER_MIN_TOKEN_LENGTH`). */
const MIN_TRIGGER_TOKEN_LENGTH = 32;

function json(body, status = 200) {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function refusal(error) {
  if (error instanceof IssuerError)
    return json({ error: error.code }, error.status);
  throw error;
}

function bearer(request) {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Configuration is authority here, so it is checked rather than echoed: a trigger that names a
 * different repository, requester, reviewer, task or key version than this deployment was stood up
 * for is refused instead of acknowledged. Without this, a valid-looking request from anywhere
 * holding the token could mint an acknowledgement for any repository.
 */
function assertConfiguredScope(request, env) {
  const expected = {
    repository: env.ISSUER_REPOSITORY,
    requested_by: env.ISSUER_REQUESTER_IDENTITY,
    principal: env.ISSUER_PRINCIPAL,
    key_version: env.ISSUER_KEY_VERSION,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new IssuerError(`issuer_configuration_missing:${field}`, 503);
    }
  }
  const tasks = String(env.ISSUER_TASK_IDS ?? "")
    .split(",")
    .map((task) => task.trim())
    .filter(Boolean);
  if (tasks.length === 0)
    throw new IssuerError("issuer_configuration_missing:task_ids", 503);

  if (request.repository !== expected.repository)
    throw new IssuerError("issuer_request_repository_drift", 403);
  if (request.requested_by !== expected.requested_by)
    throw new IssuerError("issuer_request_requester_drift", 403);
  if (request.expected_issuer.principal !== expected.principal) {
    throw new IssuerError("issuer_request_principal_drift", 403);
  }
  if (!tasks.includes(request.expected_issuer.task_id))
    throw new IssuerError("issuer_request_task_drift", 403);
  if (request.receipt_key.key_version !== expected.key_version) {
    throw new IssuerError("issuer_request_key_version_drift", 403);
  }
}

async function readCanonicalRequest(httpRequest) {
  const declared = Number(httpRequest.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    throw new IssuerError("issuer_request_too_large", 413);
  const body = await httpRequest.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new IssuerError("issuer_request_too_large", 413);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new IssuerError("issuer_request_unreadable", 400);
  }
}

async function ledgerRow(env, requestDigest) {
  return await env.LEDGER.prepare(
    "SELECT acknowledgement_json, expires_at FROM independent_issuer_acknowledgements WHERE request_digest = ?",
  )
    .bind(requestDigest)
    .first();
}

/**
 * One acknowledgement per exact request, forever.
 *
 * The insert is conditional and the read that follows is authoritative, so two concurrent triggers
 * for the same request converge on one row rather than racing to mint two run ids. A replay of a
 * request whose window has closed is refused: the enforcer treats an expired trigger as no trigger,
 * and re-acknowledging it here would hand back a fresh-looking receipt binding for stale source.
 */
async function acknowledge(env, request, requestDigest, now) {
  const existing = await ledgerRow(env, requestDigest);
  if (existing) {
    if (Date.parse(existing.expires_at) <= now)
      throw new IssuerError("issuer_request_expired", 409);
    return {
      acknowledgement: JSON.parse(existing.acknowledgement_json),
      replayed: true,
    };
  }
  const acknowledgement = acknowledgementFor(request, {
    requestDigest,
    acceptedAt: new Date(now).toISOString(),
  });
  await env.LEDGER.prepare(
    `INSERT OR IGNORE INTO independent_issuer_acknowledgements
       (request_digest, repository, phase, source_commit, issuer_principal, issuer_task_id,
        issuer_run_id, key_version, requested_at, expires_at, accepted_at, acknowledgement_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      requestDigest,
      request.repository,
      request.phase,
      request.source_commit,
      acknowledgement.issuer_principal,
      acknowledgement.issuer_task_id,
      acknowledgement.issuer_run_id,
      acknowledgement.key_version,
      request.requested_at,
      request.expires_at,
      acknowledgement.accepted_at,
      JSON.stringify(acknowledgement),
    )
    .run();
  // Read back rather than trust the write: a concurrent trigger may have won the insert, and the
  // row that exists is the one the reviewer will be held to.
  const stored = await ledgerRow(env, requestDigest);
  if (!stored) throw new IssuerError("issuer_ledger_unavailable", 503);
  return {
    acknowledgement: JSON.parse(stored.acknowledgement_json),
    replayed: false,
  };
}

/** The reviewer's read: which run id must the GO receipt for this commit carry? */
async function readAcknowledgements(env, sourceCommit) {
  const rows = await env.LEDGER.prepare(
    `SELECT acknowledgement_json FROM independent_issuer_acknowledgements
      WHERE source_commit = ? ORDER BY accepted_at ASC`,
  )
    .bind(sourceCommit)
    .all();
  return (rows?.results ?? []).map((row) =>
    JSON.parse(row.acknowledgement_json),
  );
}

export async function handle(httpRequest, env, now = Date.now) {
  const url = new URL(httpRequest.url);
  const acknowledgementRead = url.pathname.match(ACK_ROUTE);
  if (url.pathname !== INDEPENDENT_ISSUER_ROUTE && !acknowledgementRead)
    return json({ error: "not_found" }, 404);
  // A deployment that never received its token must refuse everyone, not accept everyone: an
  // empty configured token would otherwise match an absent Authorization header exactly.
  const configuredToken = String(env.ISSUER_TRIGGER_TOKEN ?? "");
  if (configuredToken.length < MIN_TRIGGER_TOKEN_LENGTH) {
    return json({ error: "issuer_configuration_missing:trigger_token" }, 503);
  }
  if (!secretEquals(bearer(httpRequest), configuredToken)) {
    return json({ error: "issuer_unauthorized" }, 401);
  }

  try {
    if (acknowledgementRead) {
      if (httpRequest.method !== "GET")
        return json({ error: "method_not_allowed" }, 405);
      return json({
        acknowledgements: await readAcknowledgements(
          env,
          acknowledgementRead[1],
        ),
      });
    }
    if (httpRequest.method !== "POST")
      return json({ error: "method_not_allowed" }, 405);

    const request = await readCanonicalRequest(httpRequest);
    validateIndependentIssuerRequest(request, () => now());
    assertConfiguredScope(request, env);
    // Taken over the canonical form, not the received bytes: the enforcer computes its expected
    // digest the same way, so a body that arrives re-ordered still agrees instead of failing.
    const requestDigest = await sha256Hex(canonicalJson(request));
    const { acknowledgement } = await acknowledge(
      env,
      request,
      requestDigest,
      now(),
    );
    return json({ acknowledgement });
  } catch (error) {
    return refusal(error);
  }
}

export default {
  async fetch(request, env) {
    return await handle(request, env, Date.now);
  },
};
