import {
  AUTH_CONTEXT_HEADER,
  AUTH_EXCHANGE_HEADER,
  AUTH_RECEIPT_HEADER,
  decodeV2,
  encodeV2,
  exactKeys,
  parseCanonicalV2,
  requestFingerprintV2,
  subjectDigestV2,
  validateExchange,
  validateReceipt,
  type AuthExchangeV2,
} from "../../shared/auth-protocol-v2.mjs";
import {
  enrollmentOpen,
  recheckAuthProtocol,
  unconfirmedAuthResponse,
  type AuthProtocolAdmission,
} from "./auth-protocol-control.ts";
import {
  beginEnrollmentV2,
  findFencedSessionV2,
  findGrantV2,
  readAuthContextV2,
  transitionAuthV2,
  type AuthContextRowV2,
  type FencedSessionV2,
} from "./auth-protocol-store.ts";
import {
  APP_DEVICE_PROOF_HEADER,
  APP_SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  permissionsForRole,
  type AppEnv,
  type AuthContext,
} from "./app-types.ts";
import {
  allowProtocolConsume,
  authRequestContext,
  configuredTenantId,
  csrfTokenFor,
  expiredSessionCookie,
  protocolContextHashFor,
  protocolSessionCookie,
  protocolTokenHashFor,
  randomToken,
  requestMagicLink,
  sessionHashFor,
  sessionPayload,
  sha256Hex,
  validAppCsrf,
  validProtocolDeviceProof,
} from "./app-auth.ts";

interface Wire {
  exchange: AuthExchangeV2;
  context: string;
  tenant: string;
  fingerprint: string;
}
type ActualOutcome = {
  auth?: AuthContext;
  context: AuthContextRowV2 | null;
  status: string;
  reason: string;
};

export async function handleActiveAuthProtocol(
  req: Request,
  env: AppEnv,
  admission: AuthProtocolAdmission,
  ctx: ExecutionContext,
  authenticated: (auth: AuthContext) => Promise<Response>,
  invite: () => Promise<Response>,
): Promise<Response> {
  let wire: Wire;
  try {
    const secret = req.headers.get(AUTH_CONTEXT_HEADER);
    const tenant = configuredTenantId(env);
    if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret) || !tenant)
      throw new Error("auth_context_required");
    const exchange = validateExchange(
      decodeV2(req.headers.get(AUTH_EXCHANGE_HEADER) ?? "", 1024),
    );
    wire = {
      exchange,
      tenant,
      context: await protocolContextHashFor(env, tenant, secret),
      fingerprint: await requestFingerprintV2(req, exchange.exchangeId),
    };
  } catch {
    return json({ error: "auth_protocol_required" }, 400);
  }
  const url = new URL(req.url);
  try {
    let row = await readAuthContextV2(
      env,
      wire.tenant,
      admission.head.issuer,
      wire.context,
    );
    const metadata = async (
      status: string,
      reason = status,
      httpStatus = 409,
    ) => {
      if (
        status === "cookie_required" &&
        (!row || row.current_session_hash === null)
      ) {
        status = !row || row.generation === 0 ? "unregistered" : "signed_out";
        if (reason === "cookie_required") reason = status;
      }
      return finish(
        req,
        env,
        admission,
        wire,
        json(
          { error: reason, auth_context: metadataBody(admission, row, status) },
          httpStatus,
        ),
        { context: row, status, reason },
      );
    };
    if (wire.exchange.kind === "discovery") {
      if (req.method !== "GET" || url.pathname !== "/api/v1/session")
        return metadata("refused", "operation_mismatch", 400);
      return metadata("issuer_required", "discovery", 200);
    }
    if (wire.exchange.issuer !== admission.head.issuer)
      return metadata("issuer_changed");
    if (req.method === "POST" && url.pathname === "/api/v1/session") {
      const body = await protocolBody(req);
      if (body.operation === "begin_enrollment") {
        exactKeys(body, ["operation", "intentId"]);
        if (wire.exchange.kind !== "begin_enrollment" || !id(body.intentId))
          return metadata("refused", "operation_mismatch", 400);
        if (!enrollmentOpen(env, admission))
          return metadata("enrollment_closed");
        const intent = await beginEnrollmentV2(env, {
          admission,
          tenant: wire.tenant,
          context: wire.context,
          base: wire.exchange.baseGeneration,
          intent: body.intentId as string,
          challenge: randomToken(),
          now: new Date().toISOString(),
        });
        row = await readAuthContextV2(
          env,
          wire.tenant,
          admission.head.issuer,
          wire.context,
        );
        if (!intent) return metadata("generation_conflict");
        return finish(
          req,
          env,
          admission,
          wire,
          json({
            auth_context: metadataBody(admission, row, "unregistered"),
            intentId: intent.intent_id,
            challenge: intent.challenge,
            issueFloor: intent.issue_floor,
          }),
          {
            context: row,
            status: row?.generation === 0 ? "unregistered" : "current_metadata",
            reason: "enrollment_begun",
          },
        );
      }
      exactKeys(body, ["operation"]);
      if (body.operation !== "recover" || wire.exchange.kind !== "recovery")
        return metadata("refused", "operation_mismatch", 400);
      const checked = await authenticate(req, env, admission, wire);
      if (!checked.ok)
        return metadata(
          checked.reason,
          checked.reason,
          checked.reason === "device_proof_required" ? 401 : 409,
        );
      if (!validAppCsrf(req, checked.auth))
        return metadata("refused", "csrf_failed", 403);
      if (
        checked.session.auth_context_generation !== wire.exchange.baseGeneration
      )
        return metadata("generation_conflict");
      return transitionReply(
        req,
        env,
        admission,
        wire,
        checked.session,
        "recovery",
      );
    }
    const consume =
      req.method === "POST" &&
      [
        "/api/v1/auth/magic-link/consume",
        "/api/v1/auth/device-pairing/consume",
      ].includes(url.pathname);
    if (consume) {
      const kind = url.pathname.includes("magic-link") ? "magic" : "pair";
      if (wire.exchange.kind !== `${kind}_consume`)
        return metadata("refused", "operation_mismatch", 400);
      if (!enrollmentOpen(env, admission)) return metadata("enrollment_closed");
      const body = await protocolBody(req);
      exactKeys(
        body,
        kind === "magic"
          ? ["token", "intentId", "challenge"]
          : ["token", "device_proof", "intentId", "challenge"],
      );
      if (
        !token(body.token) ||
        !id(body.intentId) ||
        !token(body.challenge) ||
        (kind === "pair" && !token(body.device_proof))
      )
        return metadata("refused", "invalid_or_expired_grant", 401);
      if (!(await allowProtocolConsume(req, env, kind)))
        return metadata("refused", "invalid_or_expired_grant", 401);
      const grant = await findGrantV2(
        env,
        admission,
        kind,
        await protocolTokenHashFor(
          env,
          admission.head.issuer,
          kind,
          body.token as string,
        ),
        wire.tenant,
      );
      if (!grant) return metadata("refused", "invalid_or_expired_grant", 401);
      const rawToken = randomToken();
      const now = new Date().toISOString();
      const expiresAt = new Date(
        Date.now() + SESSION_TTL_SECONDS * 1000,
      ).toISOString();
      const sessionHash = await sessionHashFor(
        env,
        rawToken,
        admission.head.issuer,
      );
      await transitionAuthV2(env, {
        admission,
        tenant: wire.tenant,
        context: wire.context,
        base: wire.exchange.baseGeneration,
        kind,
        user: grant,
        grant,
        intent: body.intentId as string,
        challenge: body.challenge as string,
        newSessionHash: sessionHash,
        deviceId: kind === "pair" ? `appd_${crypto.randomUUID()}` : null,
        deviceProofHash:
          kind === "pair" ? await sha256Hex(body.device_proof as string) : null,
        now,
        expiresAt,
        request: await authRequestContext(req, env),
      });
      const session = await findFencedSessionV2(
        env,
        admission,
        wire.tenant,
        wire.context,
        sessionHash,
      );
      if (
        !session ||
        session.auth_context_generation !== wire.exchange.baseGeneration + 1
      )
        return metadata("generation_conflict");
      const auth = await authFor(env, admission, session, rawToken);
      const response = json(await sessionPayload(auth, env));
      response.headers.set(
        "set-cookie",
        protocolSessionCookie(rawToken, expiresAt),
      );
      return finish(req, env, admission, wire, response, {
        auth,
        context: await readAuthContextV2(
          env,
          wire.tenant,
          admission.head.issuer,
          wire.context,
        ),
        status: "current",
        reason: "grant_consumed",
      });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/v1/auth/magic-link/request"
    ) {
      if (wire.exchange.kind !== "magic_issue")
        return metadata("refused", "operation_mismatch", 400);
      await protocolBody(req.clone());
      const response = await requestMagicLink(req, env, ctx, {
        protocol: admission,
      });
      return finish(req, env, admission, wire, response, {
        context: row,
        status: "current_metadata",
        reason: "grant_request",
      });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/v1/auth/invites/accept"
    ) {
      if (wire.exchange.kind !== "magic_issue")
        return metadata("refused", "operation_mismatch", 400);
      await protocolBody(req.clone());
      return finish(req, env, admission, wire, await invite(), {
        context: row,
        status: "current_metadata",
        reason: "invite_result",
      });
    }
    const checked = await authenticate(req, env, admission, wire);
    if (!checked.ok)
      return metadata(
        checked.reason,
        checked.reason,
        checked.reason === "device_proof_required" ? 401 : 409,
      );
    if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") {
      if (wire.exchange.kind !== "logout")
        return metadata("refused", "operation_mismatch", 400);
      if (!validAppCsrf(req, checked.auth))
        return metadata("refused", "csrf_failed", 403);
      if (
        checked.session.auth_context_generation !== wire.exchange.baseGeneration
      )
        return metadata("generation_conflict");
      return transitionReply(
        req,
        env,
        admission,
        wire,
        checked.session,
        "logout",
      );
    }
    if (!["read", "pair_issue"].includes(wire.exchange.kind))
      return metadata("refused", "operation_mismatch", 400);
    if (
      checked.session.auth_context_generation !==
        wire.exchange.baseGeneration &&
      !(req.method === "GET" && url.pathname === "/api/v1/session")
    )
      return metadata("generation_conflict");
    return finish(
      req,
      env,
      admission,
      wire,
      await authenticated(checked.auth),
      {
        auth: checked.auth,
        context: row,
        status: "current",
        reason: "authenticated",
      },
    );
  } catch {
    // A committed batch followed by an exception/control loss is unconfirmed. No cookie,
    // successful receipt, private bytes or invented rollback escapes this boundary.
    return unconfirmedAuthResponse("auth_protocol_unconfirmed");
  }
}

async function transitionReply(
  req: Request,
  env: AppEnv,
  a: AuthProtocolAdmission,
  wire: Wire,
  session: FencedSessionV2,
  kind: "recovery" | "logout",
): Promise<Response> {
  const rawToken = kind === "logout" ? null : randomToken();
  const hash = rawToken
    ? await sessionHashFor(env, rawToken, a.head.issuer)
    : null;
  const won = await transitionAuthV2(env, {
    admission: a,
    tenant: wire.tenant,
    context: wire.context,
    base: wire.exchange.baseGeneration,
    kind,
    user: session,
    oldSession: session,
    newSessionHash: hash,
    deviceId: session.device_id,
    deviceProofHash: session.device_proof_hash,
    now: new Date().toISOString(),
    expiresAt: session.session_expires_at,
    request: await authRequestContext(req, env),
  });
  const row = await readAuthContextV2(
    env,
    wire.tenant,
    a.head.issuer,
    wire.context,
  );
  if (!won)
    return finish(
      req,
      env,
      a,
      wire,
      json({ error: "generation_conflict" }, 409),
      {
        context: row,
        status: "generation_conflict",
        reason: "generation_conflict",
      },
    );
  if (kind === "logout") {
    const response = json({
      ok: true,
      auth_context: metadataBody(a, row, "signed_out"),
    });
    response.headers.set("set-cookie", expiredSessionCookie());
    return finish(req, env, a, wire, response, {
      context: row,
      status: "signed_out",
      reason: "logout",
    });
  }
  const current = await findFencedSessionV2(
    env,
    a,
    wire.tenant,
    wire.context,
    hash!,
  );
  if (!current) return unconfirmedAuthResponse("auth_protocol_unconfirmed");
  const next = await authFor(env, a, current, rawToken!);
  const response = json(await sessionPayload(next, env));
  response.headers.set(
    "set-cookie",
    protocolSessionCookie(rawToken!, session.session_expires_at),
  );
  return finish(req, env, a, wire, response, {
    auth: next,
    context: row,
    status: "current",
    reason: "recovered",
  });
}

async function authenticate(
  req: Request,
  env: AppEnv,
  a: AuthProtocolAdmission,
  wire: Wire,
): Promise<
  | { ok: true; auth: AuthContext; session: FencedSessionV2 }
  | { ok: false; reason: string }
> {
  const cookie = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${APP_SESSION_COOKIE}=`))
    ?.slice(APP_SESSION_COOKIE.length + 1);
  if (!token(cookie)) return { ok: false, reason: "cookie_required" };
  const session = await findFencedSessionV2(
    env,
    a,
    wire.tenant,
    wire.context,
    await sessionHashFor(env, cookie!, a.head.issuer),
  );
  if (!session) return { ok: false, reason: "cookie_required" };
  if (session.role === "field") {
    const proof = req.headers.get(APP_DEVICE_PROOF_HEADER);
    if (
      !token(proof) ||
      !session.device_proof_hash ||
      !(await validProtocolDeviceProof(proof!, session.device_proof_hash))
    )
      return { ok: false, reason: "device_proof_required" };
  }
  return { ok: true, session, auth: await authFor(env, a, session, cookie!) };
}

async function authFor(
  env: AppEnv,
  a: AuthProtocolAdmission,
  session: FencedSessionV2,
  raw: string,
): Promise<AuthContext> {
  return {
    session,
    rawSessionToken: raw,
    csrfToken: await csrfTokenFor(env, raw),
    permissions: permissionsForRole(session.role),
    authProtocol: {
      v: 2,
      issuer: session.auth_issuer,
      contextId: session.auth_context_hash,
      generation: session.auth_context_generation,
      activationId: a.head.activationId,
      producerQualificationReceiptHash: a.head.qualificationReceiptHash,
    },
  };
}

async function finish(
  req: Request,
  env: AppEnv,
  a: AuthProtocolAdmission,
  wire: Wire,
  response: Response,
  outcome: ActualOutcome,
): Promise<Response> {
  try {
    await recheckAuthProtocol(env, a);
    const current = await readAuthContextV2(
      env,
      wire.tenant,
      a.head.issuer,
      wire.context,
    );
    if (
      current?.generation !== outcome.context?.generation ||
      current?.current_session_hash !== outcome.context?.current_session_hash
    )
      return unconfirmedAuthResponse("auth_protocol_unconfirmed");
    let subject: string | null = null;
    if (outcome.auth) {
      const live = await findFencedSessionV2(
        env,
        a,
        wire.tenant,
        wire.context,
        outcome.auth.session.session_hash,
      );
      if (
        !live ||
        live.auth_context_generation !==
          outcome.auth.authProtocol?.generation ||
        live.role !== outcome.auth.session.role ||
        live.updated_at !== outcome.auth.session.updated_at ||
        live.device_proof_hash !== outcome.auth.session.device_proof_hash
      )
        return unconfirmedAuthResponse("auth_protocol_unconfirmed");
      subject = await subjectDigestV2(
        await sessionPayload(outcome.auth, env),
        live.role === "field" ? live.device_proof_hash : null,
      );
    }
    const receipt = validateReceipt({
      v: 2,
      actualProducerVersion: a.actualVersion,
      controlRevision: a.head.controlRevision,
      activationId: a.head.activationId,
      producerQualificationReceiptHashOrNull: a.head.qualificationReceiptHash,
      actualIssuer: a.head.issuer,
      databaseIdentity: a.head.databaseIdentity,
      kind: outcome.auth
        ? "authenticated"
        : [
              "discovery",
              "enrollment_begun",
              "issuer_changed",
              "logout",
              "grant_request",
              "invite_result",
            ].includes(outcome.reason)
          ? "metadata"
          : "refused",
      status: outcome.status,
      reason: outcome.reason,
      actualContextIdOrNull: current?.context_hash ?? null,
      actualGenerationOrNull: current?.generation ?? null,
      authenticatedSubjectDigestOrNull: subject,
      exchangeId: wire.exchange.exchangeId,
      requestFingerprint: wire.fingerprint,
    });
    const headers = new Headers(response.headers);
    headers.set(AUTH_RECEIPT_HEADER, encodeV2(receipt));
    headers.set("cache-control", "private, no-store");
    if (!outcome.auth && outcome.reason !== "logout")
      headers.delete("set-cookie");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return unconfirmedAuthResponse("auth_protocol_unconfirmed");
  }
}
function metadataBody(
  a: AuthProtocolAdmission,
  row: AuthContextRowV2 | null,
  status: string,
) {
  return {
    v: 2,
    issuer: a.head.issuer,
    contextId: row?.context_hash ?? null,
    generation: row?.generation ?? null,
    status,
    activationId: a.head.activationId,
    producerQualificationReceiptHash: a.head.qualificationReceiptHash,
  };
}
async function protocolBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.body) throw new Error("auth_body_required");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) throw new Error("auth_body_too_large");
      chunks.push(value);
    }
  } finally {
    // A request clone is a tee: awaiting cancellation can wait for its still-unread
    // original branch. Cancel without blocking the refusal or consuming more bytes.
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
  const value = parseCanonicalV2(raw, 4096);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("auth_body_invalid");
  return value as Record<string, unknown>;
}
function token(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
function id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}
