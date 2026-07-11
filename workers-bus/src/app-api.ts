import {
  appBffConfigured,
  authenticateAppRequest,
  consumeDevicePairing,
  consumeMagicLink,
  expiredSessionCookie,
  logoutAppSession,
  issueDevicePairing,
  listDevicePairings,
  listFieldPairingUsers,
  parseProvisionAppUser,
  provisionAppUser,
  requestMagicLink,
  randomToken,
  revokeDevicePairing,
  sessionPayload,
  unauthenticatedSessionPayload,
  validateAppOrigin,
  validAppCsrf,
} from "./app-auth.ts";
import {
  approvalProjection,
  claimApprovalExecution,
  createApprovalRequest,
  denyApprovalRequest,
  finalizeApprovalExecution,
  getApprovalRequestByPrepareKey,
  getCurrentApprovalRequest,
  listApprovalRequests,
  matchesApprovalPreparation,
  reconcileApprovalUncertainty,
} from "./approval-store.ts";
import {
  ApprovalBrokerError,
  approvalBrokerConfig,
  approvalDecisionConfig,
  executeLeadTriageApproval,
  previewLeadTriageApproval,
  sessionIsRecentForApproval,
} from "./approval-broker-client.ts";
import {
  activeAssignmentForJob,
  buildEstimatorWorkbenchReadModel,
  buildJobProofReadModel,
  buildJobReadModel,
  buildOwnerNowReadModel,
  buildSalesReadModel,
  buildTodayReadModel,
} from "./app-read-models.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import { handleFieldAction } from "./field-actions.ts";

const MAX_ADMIN_BODY_BYTES = 8 * 1024;

export async function handleAppApi(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const appEnv = env as AppEnv;
  if (String(appEnv.APP_BFF_ENABLED) !== "true") return appJson({ error: "app_bff_disabled" }, 503);
  if (!appBffConfigured(appEnv)) return appJson({ error: "app_bff_not_configured" }, 503);

  const url = new URL(req.url);
  const mutation = req.method === "POST";
  const origin = validateAppOrigin(req, appEnv, req.method === "OPTIONS" || mutation);
  if (!origin.ok) return appJson({ error: "origin_not_allowed" }, 403);
  if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), origin.origin);

  let response: Response;
  if (req.method === "POST" && url.pathname === "/api/v1/auth/magic-link/request") {
    response = await requestMagicLink(req, appEnv, ctx);
  } else if (req.method === "POST" && url.pathname === "/api/v1/auth/magic-link/consume") {
    response = await consumeMagicLink(req, appEnv);
  } else if (req.method === "POST" && url.pathname === "/api/v1/auth/device-pairing/consume") {
    response = await consumeDevicePairing(req, appEnv);
  } else {
    const auth = await authenticateAppRequest(req, appEnv);
    if (!auth) {
      if (req.method === "GET" && url.pathname === "/api/v1/session") {
        response = appJson(unauthenticatedSessionPayload(appEnv));
        response.headers.set("cache-control", "private, no-store");
        response.headers.set("set-cookie", expiredSessionCookie());
      } else {
        response = appJson({ error: "unauthorized" }, 401);
        response.headers.set("set-cookie", expiredSessionCookie());
      }
    } else {
      response = await handleAuthenticatedRoute(req, appEnv, auth);
    }
  }
  return withCors(response, origin.origin);
}

export async function handleAdminAppUserProvision(req: Request, env: Env): Promise<Response> {
  const appEnv = env as AppEnv;
  if (String(appEnv.APP_BFF_ENABLED) !== "true") return appJson({ error: "app_bff_disabled" }, 503);
  if (!appBffConfigured(appEnv)) return appJson({ error: "app_bff_not_configured" }, 503);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return appJson({ error: parsed.error }, parsed.status);
  const validated = parseProvisionAppUser(parsed.value, appEnv);
  if (!validated.ok) return appJson({ error: validated.error }, 400);
  const user = await provisionAppUser(appEnv, validated.value, req);
  return appJson({
    user: {
      user_id: user.user_id,
      tenant_id: user.tenant_id,
      email: user.email_normalized,
      display_name: user.display_name,
      role: user.role,
      frappe_user_id: user.frappe_user_id,
      active: user.active === 1,
      updated_at: user.updated_at,
    },
  });
}

export async function handleAuthenticatedRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/api/v1/session") {
    const response = appJson(sessionPayload(auth, env));
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
  if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") {
    return await logoutAppSession(req, env, auth);
  }
  if (req.method === "GET" && url.pathname === "/api/v1/approvals") {
    if (!officeRole(auth)) return privateAppJson({ error: "office_role_required" }, 403);
    try {
      const approvals = await listApprovalRequests(
        env,
        auth.session.tenant_id,
        new Date().toISOString(),
        parsedListLimit(url.searchParams.get("limit")),
      );
      return privateAppJson(approvalReadEnvelope(env, auth, { approvals: approvals.map(approvalProjection) }));
    } catch {
      return privateAppJson({ error: "approval_store_unavailable" }, 502);
    }
  }
  if (req.method === "POST" && url.pathname === "/api/v1/approvals/lead-triage") {
    return await prepareLeadTriageApproval(req, env, auth);
  }
  const approvalDecisionMatch = url.pathname.match(/^\/api\/v1\/approvals\/([^/]+)\/(approve|reject|reconcile)$/);
  if (req.method === "POST" && approvalDecisionMatch) {
    const requestId = decodedApprovalRequestId(approvalDecisionMatch[1]);
    if (!requestId) return privateAppJson({ error: "not_found" }, 404);
    if (approvalDecisionMatch[2] === "approve") return await approveLeadTriageApproval(req, env, auth, requestId);
    if (approvalDecisionMatch[2] === "reject") return await rejectLeadTriageApproval(req, env, auth, requestId);
    return await reconcileLeadTriageApproval(req, env, auth, requestId);
  }
  const approvalDetailMatch = url.pathname.match(/^\/api\/v1\/approvals\/([^/]+)$/);
  if (req.method === "GET" && approvalDetailMatch) {
    if (!officeRole(auth)) return privateAppJson({ error: "office_role_required" }, 403);
    const requestId = decodedApprovalRequestId(approvalDetailMatch[1]);
    if (!requestId) return privateAppJson({ error: "not_found" }, 404);
    try {
      const approval = await getCurrentApprovalRequest(env, auth.session.tenant_id, requestId, new Date().toISOString());
      return approval
        ? privateAppJson(approvalReadEnvelope(env, auth, { approval: approvalProjection(approval) }))
        : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson({ error: "approval_store_unavailable" }, 502);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/v1/field-users") {
    if (auth.session.role !== "owner" && auth.session.role !== "ops") {
      return appJson({ error: "office_role_required" }, 403);
    }
    return appJson({ users: await listFieldPairingUsers(env, auth) });
  }
  if (url.pathname === "/api/v1/device-pairings") {
    if (auth.session.role !== "owner" && auth.session.role !== "ops") {
      return appJson({ error: "office_role_required" }, 403);
    }
    if (req.method === "GET") return appJson({ devices: await listDevicePairings(env, auth) });
    if (req.method === "POST") {
      const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
      if (!parsed.ok) return appJson({ error: parsed.error }, parsed.status);
      if (!isRecord(parsed.value) || Object.keys(parsed.value).some((key) => key !== "field_user_id")) {
        return appJson({ error: "unexpected_field" }, 400);
      }
      const fieldUserId = typeof parsed.value.field_user_id === "string" ? parsed.value.field_user_id : "";
      const result = await issueDevicePairing(req, env, auth, fieldUserId);
      return result.ok ? appJson({
        pairing_url: result.pairing_url,
        expires_at: result.expires_at,
        field_user: result.field_user,
      }) : appJson({ error: result.error }, result.status);
    }
  }
  const revokeMatch = url.pathname.match(/^\/api\/v1\/device-pairings\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revokeMatch) {
    const deviceId = decodedPathSegment(revokeMatch[1]);
    if (!deviceId) return appJson({ error: "not_found" }, 404);
    const result = await revokeDevicePairing(req, env, auth, deviceId);
    return result.ok
      ? appJson({ ok: true, device_id: result.device_id, revoked_at: result.revoked_at })
      : appJson({ error: result.error }, result.status);
  }
  if (req.method === "GET" && url.pathname === "/api/v1/today") {
    try {
      return appJson(await buildTodayReadModel(env, auth));
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const proofMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/proof$/);
  if (req.method === "GET" && proofMatch) {
    const jobName = decodedPathSegment(proofMatch[1]);
    if (!jobName) return appJson({ error: "not_found" }, 404);
    try {
      const model = await buildJobProofReadModel(env, auth, jobName, url.searchParams.get("cursor"));
      return model ? appJson(model) : appJson({ error: "not_found" }, 404);
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const checkInMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/check-ins$/);
  if (req.method === "POST" && checkInMatch) {
    if (auth.session.role !== "field") return appJson({ error: "field_role_required" }, 403);
    if (!validAppCsrf(req, auth)) return appJson({ error: "csrf_failed" }, 403);
    const jobName = decodedPathSegment(checkInMatch[1]);
    if (!jobName) return appJson({ error: "not_found" }, 404);
    try {
      const assignment = await activeAssignmentForJob(env, auth, jobName);
      const assignmentName = typeof assignment?.name === "string" ? assignment.name : null;
      if (!assignmentName) return appJson({ error: "not_found" }, 404);
      return await handleFieldAction(req, env, auth, jobName, assignmentName);
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
  const estimatorJobMatch = url.pathname.match(/^\/api\/v1\/estimator\/jobs\/([^/]+)$/);
  if (req.method === "GET" && estimatorJobMatch) {
    if (auth.session.role !== "owner" && auth.session.role !== "ops") {
      return privateAppJson({ error: "office_role_required" }, 403);
    }
    const jobName = decodedPathSegment(estimatorJobMatch[1]);
    if (!jobName) return privateAppJson({ error: "not_found" }, 404);
    try {
      const model = await buildEstimatorWorkbenchReadModel(env, auth, jobName);
      return model ? privateAppJson(model) : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  if (req.method === "GET" && jobMatch) {
    const jobName = decodedPathSegment(jobMatch[1]);
    if (!jobName) return appJson({ error: "not_found" }, 404);
    try {
      const model = await buildJobReadModel(env, auth, jobName);
      return model ? appJson(model) : appJson({ error: "not_found" }, 404);
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/v1/owner/now") {
    if (auth.session.role !== "owner" && auth.session.role !== "ops") {
      return appJson({ error: "forbidden" }, 403);
    }
    try {
      return privateAppJson(await buildOwnerNowReadModel(env, auth));
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/v1/sales") {
    if (auth.session.role !== "owner" && auth.session.role !== "ops") {
      return privateAppJson({ error: "office_role_required" }, 403);
    }
    try {
      return privateAppJson(await buildSalesReadModel(env, auth));
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  return appJson({ error: "not_found" }, 404);
}

async function prepareLeadTriageApproval(req: Request, env: AppEnv, auth: AuthContext): Promise<Response> {
  if (!officeRole(auth)) return privateAppJson({ error: "office_role_required" }, 403);
  if (!validAppCsrf(req, auth)) return privateAppJson({ error: "csrf_failed" }, 403);
  const prepareIdempotencyKey = idempotencyKey(req);
  if (!prepareIdempotencyKey) return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseLeadTriagePreparation(parsed.value);
  if (!input) return privateAppJson({ error: "invalid_approval_request" }, 400);
  const requestedByFrappeUser = auth.session.frappe_user_id?.trim() ?? "";
  if (!requestedByFrappeUser) return privateAppJson({ error: "frappe_identity_required" }, 403);

  try {
    const existing = await getApprovalRequestByPrepareKey(env, auth.session.tenant_id, prepareIdempotencyKey);
    if (existing) {
      return matchesApprovalPreparation(existing, {
        requestedByUserId: auth.session.user_id,
        leadEnvelopeId: input.leadEnvelopeId,
        triageSummary: input.triageSummary,
        requestText: input.requestText,
      })
        ? privateAppJson({ approval: approvalProjection(existing), replayed: true })
        : privateAppJson({ error: "idempotency_conflict", approval: approvalProjection(existing) }, 409);
    }
  } catch {
    return privateAppJson({ error: "approval_store_unavailable" }, 502);
  }

  if (!approvalBrokerConfig(env)) return privateAppJson({ error: "approval_broker_not_configured" }, 503);
  const approvalRequestId = `approval:${randomToken()}`;
  const runId = `run:lead-triage:${randomToken()}`;
  let packet;
  try {
    packet = await previewLeadTriageApproval(env, {
      approvalRequestId,
      tenantId: auth.session.tenant_id,
      runId,
      leadEnvelopeId: input.leadEnvelopeId,
      triageSummary: input.triageSummary,
      requestText: input.requestText,
      requestedByUserId: auth.session.user_id,
      requestedByFrappeUser,
    });
  } catch (error) {
    return privateAppJson({ error: brokerPrepareError(error) }, brokerPrepareStatus(error));
  }

  try {
    const created = await createApprovalRequest(env, {
      id: approvalRequestId,
      tenantId: auth.session.tenant_id,
      prepareIdempotencyKey,
      intentFingerprint: packet.intentFingerprint,
      agentRole: packet.agentRole,
      actorUser: packet.actorUser,
      siteId: packet.siteId,
      leadEnvelopeId: packet.leadEnvelopeId,
      requestText: packet.requestText,
      writeArgsJson: packet.writeArgsJson,
      previewJson: packet.previewJson,
      argsDigest: packet.argsDigest,
      previewDigest: packet.previewDigest,
      dryRunReceipt: packet.dryRunReceipt,
      expiresAt: packet.expiresAt,
      requestedByUserId: auth.session.user_id,
      requestedByFrappeUser,
      runId: packet.runId,
      now: new Date().toISOString(),
    });
    if (created.kind === "conflict") {
      return privateAppJson({ error: "idempotency_conflict", approval: approvalProjection(created.request) }, 409);
    }
    return privateAppJson(
      { approval: approvalProjection(created.request), replayed: created.kind === "replayed" },
      created.kind === "created" ? 201 : 200,
    );
  } catch {
    return privateAppJson({ error: "approval_store_unavailable" }, 502);
  }
}

async function approveLeadTriageApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const identity = approvalBrokerDecisionIdentity(env, auth);
  if (!identity.ok) return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth)) return privateAppJson({ error: "csrf_failed" }, 403);
  const decisionIdempotencyKey = idempotencyKey(req);
  if (!decisionIdempotencyKey) return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const expectedVersion = parseExpectedVersion(parsed.value);
  if (expectedVersion === null) return privateAppJson({ error: "invalid_approval_decision" }, 400);

  const now = new Date();
  let claimed;
  try {
    claimed = await claimApprovalExecution(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion,
      decisionIdempotencyKey,
      approvedByUserId: auth.session.user_id,
      approvedByFrappeUser: identity.frappeUserId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + identity.config.executionLeaseSeconds * 1000).toISOString(),
    });
  } catch {
    return privateAppJson({ error: "approval_store_unavailable" }, 502);
  }
  if (claimed.kind !== "claimed") return approvalDecisionResultResponse(claimed);

  let outcome;
  try {
    outcome = await executeLeadTriageApproval(env, claimed.request);
  } catch (error) {
    return await finalizeBrokerFailure(env, auth, claimed.request, decisionIdempotencyKey, error);
  }
  try {
    const finalized = await finalizeApprovalExecution(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      decisionIdempotencyKey,
      state: outcome.state,
      hermesRunId: outcome.hermesRunId,
      resultJson: outcome.resultJson,
      errorCode: outcome.errorCode,
      now: new Date().toISOString(),
    });
    if (finalized.kind === "lost_claim") {
      return finalized.request
        ? privateAppJson({ error: "approval_state_changed", approval: approvalProjection(finalized.request) }, 409)
        : privateAppJson({ error: "not_found" }, 404);
    }
    const status = outcome.state === "executed" ? 200 : outcome.state === "execution_uncertain" ? 502 : 422;
    return privateAppJson({ approval: approvalProjection(finalized.request) }, status);
  } catch {
    // The broker may have completed a Frappe write, but the terminal D1 event
    // could not be recorded. Keep the lease; the sweep turns it into explicit
    // reconciliation work instead of inviting a second write.
    return privateAppJson({ error: "execution_finalization_unavailable" }, 502);
  }
}

async function finalizeBrokerFailure(
  env: AppEnv,
  auth: AuthContext,
  request: Parameters<typeof executeLeadTriageApproval>[1],
  decisionIdempotencyKey: string,
  error: unknown,
): Promise<Response> {
  const errorCode = error instanceof ApprovalBrokerError && error.code === "approval_broker_unavailable"
    ? "broker_unavailable"
    : "broker_response_unverified";
  try {
    const finalized = await finalizeApprovalExecution(env, {
      tenantId: auth.session.tenant_id,
      requestId: request.approval_request_id,
      decisionIdempotencyKey,
      state: "execution_uncertain",
      hermesRunId: request.run_id,
      errorCode,
      now: new Date().toISOString(),
    });
    if (finalized.kind === "finalized") {
      return privateAppJson({
        error: "execution_uncertain",
        approval: approvalProjection(finalized.request),
      }, 502);
    }
    return finalized.request
      ? privateAppJson({ error: "approval_state_changed", approval: approvalProjection(finalized.request) }, 409)
      : privateAppJson({ error: "not_found" }, 404);
  } catch {
    return privateAppJson({ error: "execution_finalization_unavailable" }, 502);
  }
}

async function rejectLeadTriageApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const identity = approvalDecisionIdentity(env, auth);
  if (!identity.ok) return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth)) return privateAppJson({ error: "csrf_failed" }, 403);
  const decisionIdempotencyKey = idempotencyKey(req);
  if (!decisionIdempotencyKey) return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const decision = parseRejectionDecision(parsed.value);
  if (!decision) return privateAppJson({ error: "invalid_approval_decision" }, 400);
  try {
    const denied = await denyApprovalRequest(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion: decision.version,
      decisionIdempotencyKey,
      approvedByUserId: auth.session.user_id,
      approvedByFrappeUser: identity.frappeUserId,
      rejectionReason: decision.reason,
      now: new Date().toISOString(),
    });
    if (denied.kind === "denied") return privateAppJson({ approval: approvalProjection(denied.request) });
    return approvalDecisionResultResponse(denied);
  } catch {
    return privateAppJson({ error: "approval_store_unavailable" }, 502);
  }
}

async function reconcileLeadTriageApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const identity = approvalDecisionIdentity(env, auth);
  if (!identity.ok) return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth)) return privateAppJson({ error: "csrf_failed" }, 403);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const reconciliation = parseReconciliation(parsed.value);
  if (!reconciliation) return privateAppJson({ error: "invalid_reconciliation" }, 400);
  try {
    const result = await reconcileApprovalUncertainty(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion: reconciliation.version,
      reconciledByUserId: auth.session.user_id,
      reconciledByFrappeUser: identity.frappeUserId,
      outcome: reconciliation.outcome,
      evidence: reconciliation.evidence,
      now: new Date().toISOString(),
    });
    if (result.kind === "reconciled") return privateAppJson({ approval: approvalProjection(result.request) });
    if (result.kind === "already_reconciled") {
      return privateAppJson({ approval: approvalProjection(result.request), replayed: true });
    }
    if (result.kind === "missing") return privateAppJson({ error: "not_found" }, 404);
    if (result.kind === "not_uncertain") {
      return privateAppJson({ error: "approval_not_uncertain", approval: approvalProjection(result.request) }, 409);
    }
    return privateAppJson({ error: "approval_version_conflict", approval: approvalProjection(result.request) }, 409);
  } catch {
    return privateAppJson({ error: "approval_store_unavailable" }, 502);
  }
}

function officeRole(auth: AuthContext): boolean {
  return auth.session.role === "owner" || auth.session.role === "ops";
}

function approvalDecisionIdentity(
  env: AppEnv,
  auth: AuthContext,
): { ok: true; config: NonNullable<ReturnType<typeof approvalDecisionConfig>>; frappeUserId: string } |
  { ok: false; error: string; status: number } {
  if (auth.session.role !== "owner") return { ok: false, error: "owner_role_required", status: 403 };
  const config = approvalDecisionConfig(env);
  if (!config) return { ok: false, error: "approval_approver_not_configured", status: 503 };
  const frappeUserId = auth.session.frappe_user_id?.trim() ?? "";
  if (!frappeUserId || frappeUserId !== config.approverId) {
    return { ok: false, error: "configured_approver_required", status: 403 };
  }
  if (!sessionIsRecentForApproval(auth.session.session_created_at, config)) {
    return { ok: false, error: "recent_session_required", status: 403 };
  }
  return { ok: true, config, frappeUserId };
}

function approvalBrokerDecisionIdentity(
  env: AppEnv,
  auth: AuthContext,
): { ok: true; config: NonNullable<ReturnType<typeof approvalBrokerConfig>>; frappeUserId: string } |
  { ok: false; error: string; status: number } {
  const decision = approvalDecisionIdentity(env, auth);
  if (!decision.ok) return decision;
  const config = approvalBrokerConfig(env);
  if (!config) return { ok: false, error: "approval_broker_not_configured", status: 503 };
  return { ok: true, config, frappeUserId: decision.frappeUserId };
}

function approvalDecisionResultResponse(
  result: Exclude<Awaited<ReturnType<typeof claimApprovalExecution>>, { kind: "claimed" }> |
    Exclude<Awaited<ReturnType<typeof denyApprovalRequest>>, { kind: "denied" }>,
): Response {
  if (result.kind === "missing") return privateAppJson({ error: "not_found" }, 404);
  if (result.kind === "expired") return privateAppJson({ error: "approval_expired", approval: approvalProjection(result.request) }, 410);
  if (result.kind === "version_conflict") {
    return privateAppJson({ error: "approval_version_conflict", approval: approvalProjection(result.request) }, 409);
  }
  if (result.kind === "replayed") {
    const status = result.request.state === "executing" ? 202 : 200;
    return privateAppJson({ approval: approvalProjection(result.request), replayed: true }, status);
  }
  return privateAppJson({ error: "approval_already_decided", approval: approvalProjection(result.request) }, 409);
}

function approvalReadEnvelope(
  env: AppEnv,
  auth: AuthContext,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: 1,
    read_model_generated_at: new Date().toISOString(),
    permissions: auth.permissions,
    allowed_actions: approvalAllowedActions(env, auth),
    ...body,
  };
}

function approvalAllowedActions(env: AppEnv, auth: AuthContext): string[] {
  if (!officeRole(auth)) return [];
  const actions = ["approval.read"];
  const config = approvalBrokerConfig(env);
  if (config && auth.session.frappe_user_id?.trim()) actions.push("approval.prepare");
  if (approvalDecisionIdentity(env, auth).ok) actions.push("approval.reject");
  if (approvalDecisionIdentity(env, auth).ok) actions.push("approval.reconcile");
  if (approvalBrokerDecisionIdentity(env, auth).ok) actions.push("approval.approve");
  return actions;
}

function parseLeadTriagePreparation(value: unknown): {
  leadEnvelopeId: string;
  triageSummary: string;
  requestText: string;
} | null {
  if (!isRecord(value) || !onlyKeys(value, ["lead_envelope_id", "triage_summary", "request_text"])) return null;
  const leadEnvelopeId = idText(value.lead_envelope_id, 1, 140);
  const triageSummary = boundedText(value.triage_summary, 1, 2_000);
  const requestText = boundedText(value.request_text, 1, 4_000);
  return leadEnvelopeId && triageSummary && requestText ? { leadEnvelopeId, triageSummary, requestText } : null;
}

function parseExpectedVersion(value: unknown): number | null {
  if (!isRecord(value) || !onlyKeys(value, ["version"])) return null;
  return validVersion(value.version);
}

function parseRejectionDecision(value: unknown): { version: number; reason: string } | null {
  if (!isRecord(value) || !onlyKeys(value, ["version", "reason"])) return null;
  const version = validVersion(value.version);
  const reason = boundedText(value.reason, 3, 1_000);
  return version && reason ? { version, reason } : null;
}

function parseReconciliation(value: unknown): {
  version: number;
  outcome: "executed" | "not_executed" | "inconclusive";
  evidence: string;
} | null {
  if (!isRecord(value) || !onlyKeys(value, ["version", "outcome", "evidence"])) return null;
  const version = validVersion(value.version);
  const outcome = value.outcome === "executed" || value.outcome === "not_executed" || value.outcome === "inconclusive"
    ? value.outcome
    : null;
  const evidence = boundedText(value.evidence, 3, 1_000);
  return version && outcome && evidence ? { version, outcome, evidence } : null;
}

function validVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647
    ? value
    : null;
}

function idempotencyKey(req: Request): string | null {
  const value = req.headers.get("idempotency-key")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{8,140}$/.test(value) ? value : null;
}

function decodedApprovalRequestId(value: string): string | null {
  const decoded = decodedPathSegment(value);
  return decoded && /^approval:[A-Za-z0-9_-]{16,64}$/.test(decoded) ? decoded : null;
}

function parsedListLimit(value: string | null): number {
  if (value === null || value === "") return 50;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 50;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function idText(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" && new RegExp(`^[A-Za-z0-9._:-]{${min},${max}}$`).test(value) ? value : null;
}

function boundedText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= min && text.length <= max ? text : null;
}

function brokerPrepareError(error: unknown): string {
  if (error instanceof ApprovalBrokerError && error.code === "approval_broker_not_configured") return error.code;
  return "approval_broker_unavailable";
}

function brokerPrepareStatus(error: unknown): number {
  return error instanceof ApprovalBrokerError && error.code === "approval_broker_not_configured" ? 503 : 502;
}

function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "Content-Type, X-CSRF-Token, X-IronWrap-Device-Proof, X-Device-Action-Id, Idempotency-Key, X-Request-ID, X-Correlation-ID",
  );
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function decodedPathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readJson(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> {
  if (Number(req.headers.get("content-length") ?? "0") > maxBytes) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  const text = await req.text();
  if (text.length > maxBytes) return { ok: false, error: "payload_too_large", status: 413 };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
}

function appJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function privateAppJson(body: unknown, status = 200): Response {
  const response = appJson(body, status);
  response.headers.set("cache-control", "private, no-store");
  return response;
}
