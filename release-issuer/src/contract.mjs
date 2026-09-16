/**
 * The independent-issuer request contract, exactly as the release enforcer sends it.
 *
 * `tools/release-promotion.mjs` builds the request, canonicalises it, sends it to
 * `/v2/independent-issuer`, and then re-validates the acknowledgement this service returns. If the
 * two sides disagree on a single field the admission job fails closed, so this module mirrors
 * `validateIndependentIssuerRequest` rather than trusting the body. `test/contract.test.mjs`
 * imports BOTH validators and asserts they agree, which is what keeps the mirror from drifting.
 *
 * Deliberately free of Node-only APIs: the same module runs inside the Worker and inside
 * `node --test`.
 */

export const INDEPENDENT_ISSUER_ROUTE = "/v2/independent-issuer";
export const INDEPENDENT_ISSUER_REQUEST_SCHEMA =
  "ironwrap_independent_issuer_request_v2";
export const INDEPENDENT_ISSUER_ACK_SCHEMA =
  "ironwrap_independent_issuer_ack_v1";
export const REVIEW_RECEIPT_PATH_PREFIX = ".release/reviews/";
export const REVIEW_RECEIPT_REF_PREFIX = "release-review/";
export const RELEASE_EVIDENCE_PATH_PREFIX = ".release/evidence/";
export const RELEASE_EVIDENCE_REF_PREFIX = "release-evidence/";

/** A request may never claim a window longer than ten minutes, or start more than a minute ahead. */
export const MAX_LIFETIME_MS = 10 * 60_000;
export const MAX_FUTURE_SKEW_MS = 60_000;
/** The whole JSON body the enforcer sends is far below this; anything larger is not our request. */
export const MAX_BODY_BYTES = 32 * 1024;

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const IDENTITY_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/;
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/;
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PHASE_RE = /^(?:review|release-evidence)$/;

/** Every refusal carries the enforcer's own code so both halves fail with the same vocabulary. */
export class IssuerError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "IssuerError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status = 400) {
  throw new IssuerError(code, status);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/** Byte-identical to the enforcer's canonical form, which is what the request digest is taken over. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function record(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function exactObjectKeys(value, expected, code) {
  record(value, code);
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  )
    fail(code);
  return value;
}

function canonicalTimestamp(value, code) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value)) fail(code);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  )
    fail(code);
  return milliseconds;
}

/**
 * The freshness window. A request that has already expired is refused even if everything else is
 * perfect: the whole point of the five-minute window is that an old trigger cannot be replayed into
 * a fresh acknowledgement.
 */
export function validateFreshness(request, now = Date.now) {
  const requestedAt = canonicalTimestamp(
    request.requested_at,
    "issuer_requested_at_invalid",
  );
  const expiresAt = canonicalTimestamp(
    request.expires_at,
    "issuer_expires_at_invalid",
  );
  const currentTime = now();
  if (!Number.isFinite(currentTime)) fail("issuer_clock_invalid", 500);
  if (expiresAt <= requestedAt) fail("issuer_request_time_order_invalid");
  if (expiresAt - requestedAt > MAX_LIFETIME_MS)
    fail("issuer_request_lifetime_invalid");
  if (requestedAt > currentTime + MAX_FUTURE_SKEW_MS)
    fail("issuer_request_future_invalid");
  if (expiresAt <= currentTime) fail("issuer_request_expired", 409);
  return { requestedAt, expiresAt };
}

/**
 * Mirrors `validateIndependentIssuerRequest` in `tools/release-promotion.mjs`.
 *
 * One deliberate asymmetry, found by fuzzing the two against each other: the enforcer tests several
 * fields with a bare regex (`requireCommit`, `requireHash`, the identity checks), so a non-string
 * that stringifies into shape — the number 12345 as an artifact name, a one-element array holding a
 * commit — passes there and is refused here. The property this service actually needs is
 * one-directional: it must never acknowledge anything the enforcer would reject. Being stricter in
 * the other direction costs nothing, because `issuer-request` builds every field from string CLI
 * arguments, and it keeps type confusion off a trust boundary. `test/contract.test.mjs` asserts
 * both halves: exact agreement on string-typed input, and the one-directional rule under fuzzing.
 */
export function validateIndependentIssuerRequest(request, now = Date.now) {
  exactObjectKeys(
    request,
    [
      "schema",
      "phase",
      "repository",
      "pr_number",
      "base_commit",
      "head_commit",
      "source_commit",
      "source_git_tree",
      "source_tree_sha256",
      "diff_sha256",
      "ci_run_id",
      "candidate_artifact",
      "publication",
      "receipt_key",
      "requested_at",
      "expires_at",
      "requested_by",
      "expected_issuer",
    ],
    "issuer_request_shape_invalid",
  );
  exactObjectKeys(
    request.candidate_artifact,
    ["actions_run_id", "actions_run_attempt", "name", "content_digest"],
    "issuer_request_artifact_invalid",
  );
  exactObjectKeys(
    request.publication,
    ["ref", "path"],
    "issuer_request_publication_invalid",
  );
  exactObjectKeys(
    request.receipt_key,
    ["public_key_sha256", "key_version"],
    "issuer_request_key_invalid",
  );
  exactObjectKeys(
    request.expected_issuer,
    ["principal", "task_id"],
    "issuer_request_expected_invalid",
  );

  if (
    request.schema !== INDEPENDENT_ISSUER_REQUEST_SCHEMA ||
    typeof request.phase !== "string" ||
    !PHASE_RE.test(request.phase) ||
    typeof request.repository !== "string" ||
    !REPOSITORY_RE.test(request.repository) ||
    !Number.isSafeInteger(request.pr_number) ||
    request.pr_number < 1
  ) {
    fail("issuer_request_invalid");
  }
  for (const value of [
    request.base_commit,
    request.head_commit,
    request.source_commit,
    request.source_git_tree,
  ]) {
    if (typeof value !== "string" || !COMMIT_RE.test(value))
      fail("issuer_request_commit_invalid");
  }

  const reviewPhase = request.phase === "review";
  const expectedRef = `${reviewPhase ? REVIEW_RECEIPT_REF_PREFIX : RELEASE_EVIDENCE_REF_PREFIX}${request.source_commit}`;
  const expectedPath = `${reviewPhase ? REVIEW_RECEIPT_PATH_PREFIX : RELEASE_EVIDENCE_PATH_PREFIX}${request.source_commit}.json`;
  if (
    request.publication.ref !== expectedRef ||
    request.publication.path !== expectedPath
  ) {
    fail("issuer_request_publication_invalid");
  }

  for (const value of [
    request.source_tree_sha256,
    request.diff_sha256,
    request.candidate_artifact.content_digest,
    request.receipt_key.public_key_sha256,
  ]) {
    if (typeof value !== "string" || !SHA256_RE.test(value))
      fail("issuer_request_digest_invalid");
  }
  for (const value of [
    request.ci_run_id,
    request.candidate_artifact.actions_run_id,
    request.candidate_artifact.actions_run_attempt,
  ]) {
    if (!POSITIVE_INTEGER_RE.test(String(value)))
      fail("issuer_request_run_invalid");
  }
  if (
    typeof request.candidate_artifact.name !== "string" ||
    !ARTIFACT_NAME_RE.test(request.candidate_artifact.name) ||
    typeof request.requested_by !== "string" ||
    !IDENTITY_RE.test(request.requested_by) ||
    typeof request.expected_issuer.principal !== "string" ||
    !IDENTITY_RE.test(request.expected_issuer.principal) ||
    // Separation of duties, on the wire: whoever asks for the review may not be the reviewer.
    request.requested_by === request.expected_issuer.principal
  ) {
    fail("issuer_request_identity_invalid");
  }
  for (const value of [
    request.expected_issuer.task_id,
    request.receipt_key.key_version,
  ]) {
    if (typeof value !== "string" || !EXECUTION_ID_RE.test(value))
      fail("issuer_request_execution_invalid");
  }
  validateFreshness(request, now);
  return request;
}

/**
 * The run id a later receipt must carry.
 *
 * Derived from the request digest rather than minted at random, for two reasons: an exact replay
 * returns the same acknowledgement without a second ledger write, and the reviewer who signs the
 * GO receipt can reproduce the value instead of copying it out of a log. `review-wait` refuses any
 * receipt whose `reviewer_run_id` differs from the acknowledged one.
 */
export function issuerRunIdFor(requestDigest) {
  return `issuer-run-${requestDigest.slice(0, 32)}`;
}

export function acknowledgementFor(request, { requestDigest, acceptedAt }) {
  return {
    schema: INDEPENDENT_ISSUER_ACK_SCHEMA,
    status: "accepted",
    phase: request.phase,
    repository: request.repository,
    source_commit: request.source_commit,
    request_digest: requestDigest,
    issuer_principal: request.expected_issuer.principal,
    issuer_task_id: request.expected_issuer.task_id,
    issuer_run_id: issuerRunIdFor(requestDigest),
    key_version: request.receipt_key.key_version,
    accepted_at: acceptedAt,
  };
}

/** Constant-time comparison; Workers have no `timingSafeEqual`. */
export function secretEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}
