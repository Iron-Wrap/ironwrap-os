import { handleAccountingRoute, type AccountingRouteDeps } from "./accounting-api.ts";
import {
  appBffConfigured,
  authenticateAppRequest,
  consumeDevicePairing,
  consumeMagicLink,
  expiredSessionCookie,
  parseFirstOwnerBootstrap,
  logoutAppSession,
  bootstrapFirstOwner,
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
  getApprovalRequest,
  getApprovalRequestByPrepareKey,
  getCurrentApprovalRequest,
  listApprovalRequests,
  matchesApprovalPreparation,
  reconcileApprovalUncertainty,
} from "./approval-store.ts";
import {
  claimGovernedTransitionOutbox,
  claimNextPendingGovernedTransitionOutbox,
} from "./transition-kernel.ts";
import {
  ApprovalBrokerError,
  approvalBrokerConfig,
  approvalDecisionConfig,
  executeLeadTriageApproval,
  previewLeadTriageApproval,
  sessionIsRecentForApproval,
} from "./approval-broker-client.ts";
import {
  QuoteRevisionApprovalBrokerError,
  executeQuoteRevisionApproval,
  previewQuoteRevisionApproval,
  quoteRevisionApprovalBrokerConfig,
} from "./quote-revision-approval-broker-client.ts";
import {
  ProposalPublicationApprovalBrokerError,
  executeProposalPublicationApproval,
  previewProposalPublicationApproval,
  proposalPublicationApprovalBrokerConfig,
} from "./proposal-publication-approval-broker-client.ts";
import {
  ProductionScheduleApprovalBrokerError,
  executeProductionScheduleApproval,
  previewProductionScheduleApproval,
  productionScheduleApprovalBrokerConfig,
} from "./production-schedule-approval-broker-client.ts";
import {
  productionScheduleApprovalDecisionConfig,
  sessionIsRecentForProductionScheduleApproval,
} from "./production-schedule-approval-authority.ts";
import {
  claimQuoteRevisionApprovalExecution,
  createQuoteRevisionApprovalRequest,
  denyQuoteRevisionApprovalRequest,
  finalizeQuoteRevisionApprovalExecution,
  getCurrentQuoteRevisionApprovalRequest,
  getQuoteRevisionApprovalRequestByPrepareKey,
  listQuoteRevisionApprovalRequests,
  matchesQuoteRevisionApprovalPreparation,
  quoteRevisionApprovalProjection,
  reconcileQuoteRevisionApprovalUncertainty,
} from "./quote-revision-approval-store.ts";
import {
  claimProposalPublicationApprovalExecution,
  createProposalPublicationApprovalRequest,
  denyProposalPublicationApprovalRequest,
  finalizeProposalPublicationApprovalExecution,
  getCurrentProposalPublicationApprovalRequest,
  getProposalPublicationApprovalRequestByPrepareKey,
  listProposalPublicationApprovalRequests,
  matchesProposalPublicationApprovalPreparation,
  proposalPublicationApprovalProjection,
  reconcileProposalPublicationApprovalUncertainty,
} from "./proposal-publication-approval-store.ts";
import {
  claimProductionScheduleApprovalExecution,
  createProductionScheduleApprovalRequest,
  denyProductionScheduleApprovalRequest,
  finalizeProductionScheduleApprovalExecution,
  getCurrentProductionScheduleApprovalRequest,
  getProductionScheduleApprovalRequest,
  getProductionScheduleApprovalRequestByPrepareKey,
  listProductionScheduleApprovalRequests,
  matchesProductionScheduleApprovalPreparation,
  productionScheduleApprovalProjection,
  reconcileProductionScheduleApprovalUncertainty,
} from "./production-schedule-approval-store.ts";
import {
  activeAssignmentForJob,
  activeAssignmentForWorkObject,
  buildEstimatorWorkbenchReadModel,
  buildJobProofReadModel,
  buildJobReadModel,
  buildOwnerNowReadModel,
  buildProductionRunwayReadModel,
  buildSalesReadModel,
  buildTodayReadModel,
  buildUniversalWorkPackageReadModel,
  fleetAssetForFieldActor,
} from "./app-read-models.ts";
import { buildNowReadModel } from "./now-read-model.ts";
import { handleCustomerPortalLinks } from "./customer-portal.ts";
import { handleServiceCaseRoute } from "./service-cases.ts";
import {
  APP_API_VERSION,
  type AppEnv,
  type AuthContext,
  type WorkObjectScope,
} from "./app-types.ts";
import { claimFieldUploadWindow, handleFieldAction } from "./field-actions.ts";
import { handleFleetAction, type FleetActionKind } from "./fleet-actions.ts";
import { buildFleetPanelReadModel } from "./fleet-panel.ts";
import { handleWorkPackageAction, type WorkPackageActionKind } from "./work-package-actions.ts";
import { hasPhysicalAssignmentAuthority } from "./work-package.ts";
import { handleAuthorityRecordRoute } from "./authority-record-api.ts";
import { handleSafetyRoute } from "./safety-api.ts";
import { safetyReleaseGate } from "./safety-release-gate.ts";
import { handleInventoryRoute } from "./inventory-control-api.ts";
import { handleProposalDocAction } from "./proposal-doc-action.ts";
import {
  listMeasurementIntakeExceptions,
  projectMeasurementIntakeOwnerException,
} from "./measurement-intake-store.ts";
import { buildNewoOperationsReadModel } from "./newo-operations-read-model.ts";
import { buildOwnerRuntimeReadModel } from "./operations.ts";
import {
  listFacetV2IntakeExceptions,
  listFacetV2WorkflowEvidence,
} from "./facet-v2-evidence.ts";
import { issueFacetLaunch } from "./facet-launch.ts";
import {
  handleHermesDesktopNativeRoute,
  handleHermesDesktopPairingIssue,
  isHermesDesktopNativeRoute,
} from "./hermes-desktop.ts";
import {
  POSTIZ_PROVIDERS,
  approvePostizIntent,
  getPostizIntent,
  postizIntentEnvelope,
  reconcilePostizIntent,
  rejectPostizIntent,
  requestPostizConnect,
  stopPostizIntent,
  type PostizProvider,
} from "./postiz.ts";
import {
  QUICKBOOKS_REJECTION_REASONS,
  approveQuickBooksFinalInvoice,
  getQuickBooksFinalInvoice,
  quickBooksConnectionEnvelope,
  quickBooksFinalInvoiceEnvelope,
  rejectQuickBooksFinalInvoice,
  removeQuickBooksFromIronWrap,
  requestQuickBooksConnect,
  requestQuickBooksFinalInvoiceReconciliation,
  validQuickBooksIntentId,
  type QuickBooksRejectionReason,
} from "./quickbooks-final-invoice.ts";

const MAX_ADMIN_BODY_BYTES = 8 * 1024;

export async function handleAppApi(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const appEnv = env as AppEnv;
  if (String(appEnv.APP_BFF_ENABLED) !== "true")
    return unavailableAppRoute();
  if (!appBffConfigured(appEnv))
    return unavailableAppRoute();

  // Native desktop requests prove their own short-lived bearer + device
  // binding and intentionally do not depend on a browser Origin header.
  if (isHermesDesktopNativeRoute(req))
    return await handleHermesDesktopNativeRoute(req, appEnv);

  const url = new URL(req.url);
  const mutation = req.method === "POST";
  const origin = validateAppOrigin(
    req,
    appEnv,
    req.method === "OPTIONS" || mutation,
  );
  if (!origin.ok) return appJson({ error: "origin_not_allowed" }, 403);
  if (req.method === "OPTIONS")
    return withCors(new Response(null, { status: 204 }), origin.origin);

  let response: Response;
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/auth/magic-link/request"
  ) {
    response = await requestMagicLink(req, appEnv, ctx);
  } else if (
    req.method === "POST" &&
    url.pathname === "/api/v1/auth/magic-link/consume"
  ) {
    response = await consumeMagicLink(req, appEnv);
  } else if (
    req.method === "POST" &&
    url.pathname === "/api/v1/auth/device-pairing/consume"
  ) {
    response = await consumeDevicePairing(req, appEnv);
  } else {
    const auth = await authenticateAppRequest(req, appEnv);
    if (!auth) {
      if (
        req.method === "GET" &&
        (url.pathname === "/api/v1/session" ||
          url.pathname === "/api/v1/field/bootstrap")
      ) {
        response = url.pathname === "/api/v1/field/bootstrap"
          ? privateAppJson({
              version: APP_API_VERSION,
              session: unauthenticatedSessionPayload(appEnv),
            })
          : privateAppJson(unauthenticatedSessionPayload(appEnv));
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

export async function handleAdminAppUserProvision(
  req: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  if (!officeRole(auth))
    return privateAppJson({ error: "office_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const appEnv = env as AppEnv;
  if (String(appEnv.APP_BFF_ENABLED) !== "true")
    return appJson({ error: "app_bff_disabled" }, 503);
  if (!appBffConfigured(appEnv))
    return appJson({ error: "app_bff_not_configured" }, 503);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return appJson({ error: parsed.error }, parsed.status);
  const validated = parseProvisionAppUser(parsed.value, appEnv);
  if (!validated.ok) return appJson({ error: validated.error }, 400);
  const user = await provisionAppUser(appEnv, {
    ...validated.value,
    provisioned_by: auth.session.email_normalized,
  }, req);
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

export async function handleAdminFirstOwnerBootstrap(
  req: Request,
  env: Env,
): Promise<Response> {
  const appEnv = env as AppEnv;
  if (String(appEnv.APP_FIRST_OWNER_BOOTSTRAP_ENABLED) !== "true") {
    return appJson({ error: "first_owner_bootstrap_disabled" }, 403);
  }
  if (String(appEnv.APP_BFF_ENABLED) !== "true") {
    return appJson({ error: "app_bff_disabled" }, 503);
  }
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return appJson({ error: parsed.error }, parsed.status);
  const validated = parseFirstOwnerBootstrap(parsed.value, appEnv);
  if (!validated.ok) return appJson({ error: validated.error }, 400);
  const user = await bootstrapFirstOwner(appEnv, validated.value, req);
  if (!user) return appJson({ error: "first_owner_bootstrap_completed" }, 409);
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

/**
 * Seams the authenticated routes take from outside `env`, all optional and all unset in production.
 *
 * One entry so far: the money desk's provider-observation binding, so a route that reaches
 * QuickBooks can be driven against a synthetic Intuit double without the test dropping out of the
 * real router, the real permission set and the real CSRF check on the way in.
 */
export interface AppRouteDeps {
  accounting?: AccountingRouteDeps;
}

export async function handleAuthenticatedRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  deps: AppRouteDeps = {},
): Promise<Response> {
  const url = new URL(req.url);
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/hermes/desktop-pairings"
  ) {
    return await handleHermesDesktopPairingIssue(req, env, auth);
  }
  if (req.method === "POST" && url.pathname === "/api/v1/admin/app-users") {
    return await handleAdminAppUserProvision(req, env, auth);
  }
  if (req.method === "GET" && url.pathname === "/api/v1/session") {
    const response = appJson(sessionPayload(auth, env));
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
  if (req.method === "GET" && url.pathname === "/api/v1/field/bootstrap") {
    if (!hasPermission(auth, "today:read"))
      return privateAppJson({ error: "today_read_required" }, 403);
    try {
      return privateAppJson({
        version: APP_API_VERSION,
        session: sessionPayload(auth, env),
        today: await buildTodayReadModel(env, auth),
      });
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") {
    return await logoutAppSession(req, env, auth);
  }
  if (url.pathname.startsWith("/api/v1/authority-records")) {
    const authorityResponse = await handleAuthorityRecordRoute(req, env, auth);
    if (authorityResponse) return authorityResponse;
  }
  // The safety rail is intentionally reachable by every authenticated role,
  // including a field worker with no current assignment. Authority, separation
  // of duties, and rights are enforced inside the store, not by this router.
  if (url.pathname.startsWith("/api/v1/safety")) {
    const safetyResponse = await handleSafetyRoute(req, env, auth);
    if (safetyResponse) return safetyResponse;
  }
  if (url.pathname.startsWith("/api/v1/inventory")) {
    const inventoryResponse = await handleInventoryRoute(req, env, auth);
    if (inventoryResponse) return inventoryResponse;
  }
  if (req.method === "GET" && url.pathname === "/api/v1/now") {
    if (!hasPermission(auth, "now:read"))
      return privateAppJson({ error: "office_role_required" }, 403);
    return privateAppJson(await buildNowReadModel(env, auth));
  }
  // The money desk owns `/api/v1/accounting` outright (IRO-52 slice S8). It is checked before the
  // QuickBooks connection routes below because those live under `/api/v1/quickbooks/` and the two
  // path spaces are deliberately separate: one is the provider connection, the other is the money.
  if (
    url.pathname === "/api/v1/accounting" ||
    url.pathname.startsWith("/api/v1/accounting/")
  ) {
    return await handleAccountingRoute(req, env, auth, deps.accounting ?? {});
  }
  if (url.pathname === "/api/v1/quickbooks/connection") {
    return req.method === "GET"
      ? await handleQuickBooksConnectionRead(env, auth)
      : privateAppJson({ error: "not_found" }, 404);
  }
  if (url.pathname === "/api/v1/quickbooks/connect") {
    return req.method === "POST"
      ? await handleQuickBooksConnect(req, env, auth)
      : privateAppJson({ error: "not_found" }, 404);
  }
  if (url.pathname === "/api/v1/quickbooks/disconnect") {
    return req.method === "POST"
      ? await handleQuickBooksDisconnect(req, env, auth)
      : privateAppJson({ error: "not_found" }, 404);
  }
  const quickBooksFinalInvoiceRoute = url.pathname.match(
    /^\/api\/v1\/quickbooks\/final-invoices\/([^/]+)(?:\/(approve|reject|reconcile))?$/,
  );
  if (quickBooksFinalInvoiceRoute) {
    const intentId = decodedQuickBooksIntentId(quickBooksFinalInvoiceRoute[1] ?? "");
    if (!intentId) return privateAppJson({ error: "not_found" }, 404);
    const action = quickBooksFinalInvoiceRoute[2] as
      | "approve" | "reject" | "reconcile" | undefined;
    if (req.method === "GET" && !action)
      return await handleQuickBooksFinalInvoiceRead(env, auth, intentId);
    if (req.method === "POST" && action)
      return await handleQuickBooksFinalInvoiceCommand(req, env, auth, intentId, action);
    return privateAppJson({ error: "not_found" }, 404);
  }
  if (url.pathname === "/api/v1/postiz/connect") {
    return req.method === "POST"
      ? await handlePostizConnect(req, env, auth)
      : privateAppJson({ error: "not_found" }, 404);
  }
  const postizIntentRoute = url.pathname.match(
    /^\/api\/v1\/postiz\/intents\/([^/]+)(?:\/(approve|reject|stop|reconcile))?$/,
  );
  if (postizIntentRoute) {
    const intentId = decodedPostizIntentId(postizIntentRoute[1] ?? "");
    if (!intentId) return privateAppJson({ error: "not_found" }, 404);
    const action = postizIntentRoute[2] as
      | "approve"
      | "reject"
      | "stop"
      | "reconcile"
      | undefined;
    if (req.method === "GET" && !action)
      return await handlePostizIntentRead(env, auth, intentId);
    if (req.method === "POST" && action)
      return await handlePostizIntentCommand(req, env, auth, intentId, action);
    return privateAppJson({ error: "not_found" }, 404);
  }
  if (url.pathname.startsWith("/api/v1/customer-portal/links")) {
    return await handleCustomerPortalLinks(req, env, auth);
  }
  // The complaint/warranty/service lifecycle owns its own path space; the module behind it holds
  // the authority checks and the store, exactly as the customer-portal rail above does.
  if (
    url.pathname === "/api/v1/service-cases" ||
    url.pathname.startsWith("/api/v1/service-cases/")
  ) {
    return await handleServiceCaseRoute(req, env, auth);
  }
  if (
    req.method === "GET" &&
    url.pathname === "/api/v1/facet-design-evidence"
  ) {
    if (!hasPermission(auth, "facet:read"))
      return privateAppJson({ error: "facet_read_required" }, 403);
    try {
      const limit = parsedListLimit(url.searchParams.get("limit"));
      const [evidence, intakeExceptions] = await Promise.all([
        listFacetV2WorkflowEvidence(env, auth.session.tenant_id, limit),
        listFacetV2IntakeExceptions(env, auth.session.tenant_id, limit),
      ]);
      return privateAppJson({
        version: 2,
        read_model_generated_at: new Date().toISOString(),
        permissions: auth.permissions,
        allowed_actions: ["facet_design.read"],
        evidence,
        intake_exceptions: intakeExceptions,
      });
    } catch {
      return privateAppJson(
        { error: "facet_v2_evidence_store_unavailable" },
        502,
      );
    }
  }
  if (url.pathname.startsWith("/api/v1/facet-design-evidence/"))
    return privateAppJson({ error: "not_found" }, 404);
  if (
    req.method === "GET" &&
    url.pathname === "/api/v1/quote-revision-approvals"
  ) {
    if (!hasPermission(auth, "approvals:read"))
      return privateAppJson({ error: "office_role_required" }, 403);
    try {
      const approvals = await listQuoteRevisionApprovalRequests(
        env,
        auth.session.tenant_id,
        new Date().toISOString(),
        parsedListLimit(url.searchParams.get("limit")),
      );
      return privateAppJson(
        quoteRevisionApprovalReadEnvelope(env, auth, {
          approvals: approvals.map(quoteRevisionApprovalProjection),
        }),
      );
    } catch {
      return privateAppJson(
        { error: "quote_revision_approval_store_unavailable" },
        502,
      );
    }
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/quote-revision-approvals"
  ) {
    return await prepareQuoteRevisionApproval(req, env, auth);
  }
  // Human-triggered proposal Doc generation into the job's Drive folder.
  if (req.method === "POST" && url.pathname === "/api/v1/estimator/proposal-doc") {
    return await handleProposalDocAction(req, env, auth);
  }
  const quoteRevisionDecisionMatch = url.pathname.match(
    /^\/api\/v1\/quote-revision-approvals\/([^/]+)\/(approve|reject|reconcile)$/,
  );
  if (req.method === "POST" && quoteRevisionDecisionMatch) {
    const requestId = decodedQuoteRevisionApprovalId(
      quoteRevisionDecisionMatch[1],
    );
    if (!requestId) return privateAppJson({ error: "not_found" }, 404);
    if (quoteRevisionDecisionMatch[2] === "approve") {
      return await approveQuoteRevisionApproval(req, env, auth, requestId);
    }
    if (quoteRevisionDecisionMatch[2] === "reject") {
      return await rejectQuoteRevisionApproval(req, env, auth, requestId);
    }
    return await reconcileQuoteRevisionApproval(req, env, auth, requestId);
  }
  const quoteRevisionDetailMatch = url.pathname.match(
    /^\/api\/v1\/quote-revision-approvals\/([^/]+)$/,
  );
  if (req.method === "GET" && quoteRevisionDetailMatch) {
    if (!hasPermission(auth, "approvals:read"))
      return privateAppJson({ error: "office_role_required" }, 403);
    const requestId = decodedQuoteRevisionApprovalId(
      quoteRevisionDetailMatch[1],
    );
    if (!requestId) return privateAppJson({ error: "not_found" }, 404);
    try {
      const approval = await getCurrentQuoteRevisionApprovalRequest(
        env,
        auth.session.tenant_id,
        requestId,
        new Date().toISOString(),
      );
      return approval
        ? privateAppJson(
            quoteRevisionApprovalReadEnvelope(env, auth, {
              approval: quoteRevisionApprovalProjection(approval),
            }),
          )
        : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson(
        { error: "quote_revision_approval_store_unavailable" },
        502,
      );
    }
  }
  // Owner-facing proposal publication. This is the second door onto exactly the
  // owner-operator publication command the MCP surface already exposes: same tool
  // pair, same signed dry-run/approval receipts, same Frappe bounded command. It
  // exists because an owner can issue a customer portal link but, until now, could
  // not publish the proposal that link is meant to show.
  if (
    req.method === "GET" &&
    url.pathname === "/api/v1/proposal-publication-approvals"
  ) {
    if (!hasPermission(auth, "approvals:read"))
      return privateAppJson({ error: "office_role_required" }, 403);
    const roofJobId = url.searchParams.get("roof_job_id");
    if (roofJobId !== null && !idText(roofJobId, 1, 140))
      return privateAppJson({ error: "invalid_roof_job_id" }, 400);
    try {
      const approvals = await listProposalPublicationApprovalRequests(
        env,
        auth.session.tenant_id,
        new Date().toISOString(),
        parsedListLimit(url.searchParams.get("limit")),
        roofJobId ?? undefined,
      );
      return privateAppJson(
        proposalPublicationApprovalReadEnvelope(env, auth, {
          approvals: approvals.map(proposalPublicationApprovalProjection),
        }),
      );
    } catch {
      return privateAppJson(
        { error: "proposal_publication_approval_store_unavailable" },
        502,
      );
    }
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/proposal-publication-approvals"
  ) {
    return await prepareProposalPublicationApproval(req, env, auth);
  }
  const proposalPublicationDecisionMatch = url.pathname.match(
    /^\/api\/v1\/proposal-publication-approvals\/([^/]+)\/(approve|reject|reconcile)$/,
  );
  if (req.method === "POST" && proposalPublicationDecisionMatch) {
    const requestId = decodedProposalPublicationApprovalId(
      proposalPublicationDecisionMatch[1],
    );
    if (!requestId) return privateAppJson({ error: "not_found" }, 404);
    if (proposalPublicationDecisionMatch[2] === "approve") {
      return await approveProposalPublicationApproval(req, env, auth, requestId);
    }
    if (proposalPublicationDecisionMatch[2] === "reject") {
      return await rejectProposalPublicationApproval(req, env, auth, requestId);
    }
    return await reconcileProposalPublicationApproval(req, env, auth, requestId);
  }
  const proposalPublicationDetailMatch = url.pathname.match(
    /^\/api\/v1\/proposal-publication-approvals\/([^/]+)$/,
  );
  if (req.method === "GET" && proposalPublicationDetailMatch) {
    if (!hasPermission(auth, "approvals:read"))
      return privateAppJson({ error: "office_role_required" }, 403);
    const requestId = decodedProposalPublicationApprovalId(
      proposalPublicationDetailMatch[1],
    );
    if (!requestId) return privateAppJson({ error: "not_found" }, 404);
    try {
      const approval = await getCurrentProposalPublicationApprovalRequest(
        env,
        auth.session.tenant_id,
        requestId,
        new Date().toISOString(),
      );
      return approval
        ? privateAppJson(
            proposalPublicationApprovalReadEnvelope(env, auth, {
              approval: proposalPublicationApprovalProjection(approval),
            }),
          )
        : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson(
        { error: "proposal_publication_approval_store_unavailable" },
        502,
      );
    }
  }
  if (
    req.method === "GET" &&
    url.pathname === "/api/v1/production-schedule-approvals"
  ) {
    if (auth.session.role !== "owner")
      return privateAppJson({ error: "owner_role_required" }, 403);
    try {
      const approvals = await listProductionScheduleApprovalRequests(
        env,
        auth.session.tenant_id,
        new Date().toISOString(),
        parsedListLimit(url.searchParams.get("limit")),
      );
      return privateAppJson(
        productionScheduleApprovalReadEnvelope(env, auth, {
          approvals: approvals.map(productionScheduleApprovalProjection),
        }),
      );
    } catch {
      return privateAppJson(
        { error: "production_schedule_approval_store_unavailable" },
        502,
      );
    }
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/production-schedule-approvals"
  ) {
    return await prepareProductionScheduleApproval(req, env, auth);
  }
  const productionScheduleDecisionMatch = url.pathname.match(
    /^\/api\/v1\/production-schedule-approvals\/([^/]+)\/(approve|reject|reconcile)$/,
  );
  if (req.method === "POST" && productionScheduleDecisionMatch) {
    const requestId = decodedProductionScheduleApprovalId(
      productionScheduleDecisionMatch[1],
    );
    if (!requestId) return privateAppJson({ error: "not_found" }, 404);
    if (productionScheduleDecisionMatch[2] === "approve") {
      return await approveProductionScheduleApproval(req, env, auth, requestId);
    }
    if (productionScheduleDecisionMatch[2] === "reject") {
      return await rejectProductionScheduleApproval(req, env, auth, requestId);
    }
    return await reconcileProductionScheduleApproval(req, env, auth, requestId);
  }
  const productionScheduleDetailMatch = url.pathname.match(
    /^\/api\/v1\/production-schedule-approvals\/([^/]+)$/,
  );
  if (req.method === "GET" && productionScheduleDetailMatch) {
    if (auth.session.role !== "owner")
      return privateAppJson({ error: "owner_role_required" }, 403);
    const requestId = decodedProductionScheduleApprovalId(
      productionScheduleDetailMatch[1],
    );
    if (!requestId) return privateAppJson({ error: "not_found" }, 404);
    try {
      const approval = await getCurrentProductionScheduleApprovalRequest(
        env,
        auth.session.tenant_id,
        requestId,
        new Date().toISOString(),
      );
      return approval
        ? privateAppJson(
            productionScheduleApprovalReadEnvelope(env, auth, {
              approval: productionScheduleApprovalProjection(approval),
            }),
          )
        : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson(
        { error: "production_schedule_approval_store_unavailable" },
        502,
      );
    }
  }
  if (req.method === "GET" && url.pathname === "/api/v1/approvals") {
    if (!hasPermission(auth, "approvals:read"))
      return privateAppJson({ error: "office_role_required" }, 403);
    try {
      const approvals = await listApprovalRequests(
        env,
        auth.session.tenant_id,
        new Date().toISOString(),
        parsedListLimit(url.searchParams.get("limit")),
      );
      return privateAppJson(
        approvalReadEnvelope(env, auth, {
          approvals: approvals.map(approvalProjection),
        }),
      );
    } catch {
      return privateAppJson({ error: "approval_store_unavailable" }, 502);
    }
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/approvals/lead-triage"
  ) {
    return await prepareLeadTriageApproval(req, env, auth);
  }
  const approvalDecisionMatch = url.pathname.match(
    /^\/api\/v1\/approvals\/([^/]+)\/(approve|reject|reconcile)$/,
  );
  if (req.method === "POST" && approvalDecisionMatch) {
    const requestId = decodedApprovalRequestId(approvalDecisionMatch[1]);
    if (!requestId) return privateAppJson({ error: "not_found" }, 404);
    if (approvalDecisionMatch[2] === "approve")
      return await approveLeadTriageApproval(req, env, auth, requestId);
    if (approvalDecisionMatch[2] === "reject")
      return await rejectLeadTriageApproval(req, env, auth, requestId);
    return await reconcileLeadTriageApproval(req, env, auth, requestId);
  }
  const approvalDetailMatch = url.pathname.match(
    /^\/api\/v1\/approvals\/([^/]+)$/,
  );
  if (req.method === "GET" && approvalDetailMatch) {
    if (!hasPermission(auth, "approvals:read"))
      return privateAppJson({ error: "office_role_required" }, 403);
    const requestId = decodedApprovalRequestId(approvalDetailMatch[1]);
    if (!requestId) return privateAppJson({ error: "not_found" }, 404);
    try {
      const approval = await getCurrentApprovalRequest(
        env,
        auth.session.tenant_id,
        requestId,
        new Date().toISOString(),
      );
      return approval
        ? privateAppJson(
            approvalReadEnvelope(env, auth, {
              approval: approvalProjection(approval),
            }),
          )
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
    if (req.method === "GET")
      return appJson({ devices: await listDevicePairings(env, auth) });
    if (req.method === "POST") {
      const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
      if (!parsed.ok) return appJson({ error: parsed.error }, parsed.status);
      if (
        !isRecord(parsed.value) ||
        Object.keys(parsed.value).some((key) => key !== "field_user_id")
      ) {
        return appJson({ error: "unexpected_field" }, 400);
      }
      const fieldUserId =
        typeof parsed.value.field_user_id === "string"
          ? parsed.value.field_user_id
          : "";
      const result = await issueDevicePairing(req, env, auth, fieldUserId);
      return result.ok
        ? appJson({
            pairing_url: result.pairing_url,
            expires_at: result.expires_at,
            field_user: result.field_user,
          })
        : appJson({ error: result.error }, result.status);
    }
  }
  const revokeMatch = url.pathname.match(
    /^\/api\/v1\/device-pairings\/([^/]+)\/revoke$/,
  );
  if (req.method === "POST" && revokeMatch) {
    const deviceId = decodedPathSegment(revokeMatch[1]);
    if (!deviceId) return appJson({ error: "not_found" }, 404);
    const result = await revokeDevicePairing(req, env, auth, deviceId);
    return result.ok
      ? appJson({
          ok: true,
          device_id: result.device_id,
          revoked_at: result.revoked_at,
        })
      : appJson({ error: result.error }, result.status);
  }
  if (req.method === "GET" && url.pathname === "/api/v1/today") {
    if (!hasPermission(auth, "today:read"))
      return privateAppJson({ error: "today_read_required" }, 403);
    try {
      return appJson(await buildTodayReadModel(env, auth));
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const proofMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/proof$/);
  if (req.method === "GET" && proofMatch) {
    if (!canReadJobs(auth))
      return privateAppJson({ error: "job_read_required" }, 403);
    const jobName = decodedPathSegment(proofMatch[1]);
    if (!jobName) return appJson({ error: "not_found" }, 404);
    try {
      const model = await buildJobProofReadModel(
        env,
        auth,
        jobName,
        url.searchParams.get("cursor"),
      );
      return model ? appJson(model) : appJson({ error: "not_found" }, 404);
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const checkInMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/check-ins$/,
  );
  if (req.method === "POST" && checkInMatch) {
    if (auth.session.role !== "field")
      return appJson({ error: "field_role_required" }, 403);
    if (!validAppCsrf(req, auth)) return appJson({ error: "csrf_failed" }, 403);
    const jobName = decodedPathSegment(checkInMatch[1]);
    if (!jobName) return appJson({ error: "not_found" }, 404);
    try {
      const assignment = await activeAssignmentForJob(env, auth, jobName);
      const assignmentName =
        typeof assignment?.name === "string" ? assignment.name : null;
      if (!assignmentName) return appJson({ error: "not_found" }, 404);
      return await handleFieldAction(req, env, auth, jobName, assignmentName);
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const universalCheckInMatch = url.pathname.match(
    /^\/api\/v1\/work-objects\/([^/]+)\/([^/]+)\/physical-contexts\/([^/]+)\/([^/]+)\/check-ins$/,
  );
  if (req.method === "POST" && universalCheckInMatch) {
    if (auth.session.role !== "field")
      return appJson({ error: "field_role_required" }, 403);
    if (!validAppCsrf(req, auth)) return appJson({ error: "csrf_failed" }, 403);
    const scope = decodeWorkObjectScope(universalCheckInMatch);
    if (!scope) return appJson({ error: "not_found" }, 404);
    try {
      const assignment = await activeAssignmentForWorkObject(env, auth, scope);
      const assignmentName =
        typeof assignment?.name === "string" ? assignment.name : null;
      if (!assignmentName) return appJson({ error: "not_found" }, 404);
      return await handleFieldAction(
        req,
        env,
        auth,
        scope.workObjectId,
        assignmentName,
        scope,
      );
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const workPackageAcknowledgementMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/work-package\/acknowledgements$/,
  );
  if (req.method === "POST" && workPackageAcknowledgementMatch) {
    return await handleFieldWorkPackageRoute(
      req,
      env,
      auth,
      workPackageAcknowledgementMatch[1],
      "acknowledge",
    );
  }
  const workPackageStopMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/work-package\/stop-work$/,
  );
  if (req.method === "POST" && workPackageStopMatch) {
    return await handleFieldWorkPackageRoute(req, env, auth, workPackageStopMatch[1], "stop_work");
  }
  const workPackageStartMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/work-package\/start$/,
  );
  if (req.method === "POST" && workPackageStartMatch) {
    // Start is intentionally direct/online-only. The PWA does not add this
    // route to its offline outbox, while the device action id still makes a
    // lost response safe to retry over the active connection.
    return await handleFieldWorkPackageRoute(req, env, auth, workPackageStartMatch[1], "start_work");
  }
  if (req.method === "GET" && url.pathname === "/api/v1/fleet/panel") {
    // The read half of the capture rail, and the only fleet read a field
    // session gets. It is field-only for the same reason the capture routes
    // are: an office role has the Desk, and widening this would turn a
    // driver's own vehicle list into a fleet directory.
    if (auth.session.role !== "field") return appJson({ error: "field_role_required" }, 403);
    try {
      return appJson(await buildFleetPanelReadModel(env, auth));
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const fleetInspectionMatch = url.pathname.match(
    /^\/api\/v1\/fleet\/assets\/([^/]+)\/(pre-trip|post-trip)-inspections$/,
  );
  if (req.method === "POST" && fleetInspectionMatch) {
    return await handleFleetAssetRoute(
      req,
      env,
      auth,
      fleetInspectionMatch[1],
      fleetInspectionMatch[2] === "pre-trip" ? "pre_trip_inspection" : "post_trip_inspection",
    );
  }
  const fleetDefectMatch = url.pathname.match(
    /^\/api\/v1\/fleet\/assets\/([^/]+)\/defects$/,
  );
  if (req.method === "POST" && fleetDefectMatch) {
    return await handleFleetAssetRoute(req, env, auth, fleetDefectMatch[1], "defect_report");
  }
  const workPackageCompleteMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/work-package\/complete$/,
  );
  if (req.method === "POST" && workPackageCompleteMatch) {
    return await handleProductionWorkPackageRoute(
      req,
      env,
      auth,
      workPackageCompleteMatch[1],
      "complete_work",
    );
  }
  const universalWorkPackageMatch = url.pathname.match(
    /^\/api\/v1\/work-objects\/([^/]+)\/([^/]+)\/physical-contexts\/([^/]+)\/([^/]+)\/work-package\/(acknowledgements|stop-work|start|complete)$/,
  );
  if (universalWorkPackageMatch) {
    const scope = decodeWorkObjectScope(universalWorkPackageMatch);
    if (!scope) return appJson({ error: "not_found" }, 404);
    const routeKind = universalWorkPackageMatch[5];
    const kind =
      routeKind === "acknowledgements"
        ? "acknowledge"
        : routeKind === "stop-work"
          ? "stop_work"
          : routeKind === "start"
            ? "start_work"
            : "complete_work";
    if (req.method !== "POST") return appJson({ error: "method_not_allowed" }, 405);
    if (kind === "complete_work") {
      return await handleProductionWorkPackageRoute(
        req,
        env,
        auth,
        scope.workObjectId,
        kind,
        scope,
      );
    }
    return await handleFieldWorkPackageRoute(
      req,
      env,
      auth,
      scope.workObjectId,
      kind,
      scope,
    );
  }
  const universalWorkObjectMatch = url.pathname.match(
    /^\/api\/v1\/work-objects\/([^/]+)\/([^/]+)\/physical-contexts\/([^/]+)\/([^/]+)$/,
  );
  if (req.method === "GET" && universalWorkObjectMatch) {
    if (!canReadJobs(auth))
      return privateAppJson({ error: "job_read_required" }, 403);
    const scope = decodeWorkObjectScope(universalWorkObjectMatch);
    if (!scope) return appJson({ error: "not_found" }, 404);
    try {
      const model = await buildUniversalWorkPackageReadModel(env, auth, scope);
      return model ? appJson(model) : appJson({ error: "not_found" }, 404);
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
  const facetLaunchMatch = url.pathname.match(
    /^\/api\/v1\/estimator\/jobs\/([^/]+)\/facet-launches$/,
  );
  if (req.method === "POST" && facetLaunchMatch) {
    const jobName = decodedPathSegment(facetLaunchMatch[1]);
    return jobName
      ? await handleFacetLaunch(req, env, auth, jobName)
      : privateAppJson({ error: "not_found" }, 404);
  }
  const estimatorJobMatch = url.pathname.match(
    /^\/api\/v1\/estimator\/jobs\/([^/]+)$/,
  );
  if (req.method === "GET" && estimatorJobMatch) {
    if (!hasPermission(auth, "estimator:read")) {
      return privateAppJson({ error: "office_role_required" }, 403);
    }
    const jobName = decodedPathSegment(estimatorJobMatch[1]);
    if (!jobName) return privateAppJson({ error: "not_found" }, 404);
    try {
      const model = await buildEstimatorWorkbenchReadModel(env, auth, jobName);
      return model
        ? privateAppJson(model)
        : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  if (req.method === "GET" && jobMatch) {
    if (!canReadJobs(auth))
      return privateAppJson({ error: "job_read_required" }, 403);
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
  if (
    req.method === "GET" &&
    url.pathname === "/api/v1/owner/measurement-intake-exceptions"
  ) {
    if (!officeRole(auth))
      return privateAppJson({ error: "office_role_required" }, 403);
    try {
      // This deployment is selected to one configured tenant, and authenticateAppRequest only
      // admits sessions for that same configured tenant. Keep this narrow browser projection
      // separate from the ADMIN_TOKEN diagnostics endpoint: no raw pointer, hashes, leases,
      // Frappe ids, or provider error detail crosses into the app session.
      const measurements = await listMeasurementIntakeExceptions(
        env,
        parsedListLimit(url.searchParams.get("limit")),
      );
      return privateAppJson({
        measurements: measurements.map(projectMeasurementIntakeOwnerException),
      });
    } catch {
      return privateAppJson(
        { error: "measurement_intake_exception_store_unavailable" },
        502,
      );
    }
  }
  if (req.method === "GET" && url.pathname === "/api/v1/owner/runtime") {
    if (!officeRole(auth))
      return privateAppJson({ error: "office_role_required" }, 403);
    try {
      // This is an explicit, server-side owner/ops read. It deliberately omits
      // raw pointers, audit entries, provider responses, and admin credentials.
      return privateAppJson(await buildOwnerRuntimeReadModel(env));
    } catch {
      return privateAppJson({ error: "owner_runtime_unavailable" }, 502);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/v1/newo/operations") {
    if (!officeRole(auth))
      return privateAppJson({ error: "office_role_required" }, 403);
    try {
      // The app session is already bound to this deployment's configured tenant. This
      // projection deliberately excludes caller identity, content, raw pointers, hashes,
      // provider responses, and control arguments.
      return privateAppJson(await buildNewoOperationsReadModel(env));
    } catch {
      return privateAppJson({ error: "newo_operations_unavailable" }, 502);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/v1/production") {
    if (!hasPermission(auth, "production:read")) {
      return privateAppJson({ error: "office_role_required" }, 403);
    }
    try {
      return privateAppJson(await buildProductionRunwayReadModel(env, auth));
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/v1/sales") {
    if (!hasPermission(auth, "sales:read")) {
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

async function handleFacetLaunch(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
): Promise<Response> {
  if (!hasPermission(auth, "facet:launch") || auth.session.role !== "owner")
    return privateAppJson({ error: "facet_launch_owner_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const requestIdempotencyKey = idempotencyKey(req);
  if (!requestIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, 1_024);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value) || Object.keys(parsed.value).length !== 0)
    return privateAppJson({ error: "invalid_facet_launch_request" }, 400);
  try {
    const result = await issueFacetLaunch(env, {
      tenantId: auth.session.tenant_id,
      jobName,
      actorUserId: auth.session.user_id,
      actorRole: auth.session.role,
      idempotencyKey: requestIdempotencyKey,
    });
    if (result.kind === "rejected")
      return privateAppJson({ error: result.code }, result.status);
    return privateAppJson({
      version: 1,
      read_model_generated_at: new Date().toISOString(),
      permissions: auth.permissions,
      allowed_actions: ["facet_launch.create"],
      launch: result.launch,
      ...(result.kind === "replayed" ? { replayed: true } : {}),
    }, result.kind === "created" ? 201 : 200);
  } catch {
    return privateAppJson({ error: "facet_launch_unavailable" }, 502);
  }
}

async function handleQuickBooksConnectionRead(
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!hasPermission(auth, "quickbooks:read"))
    return privateAppJson({ error: "quickbooks_read_required" }, 403);
  try {
    return privateAppJson(await quickBooksConnectionEnvelope(
      env,
      auth.session.tenant_id,
      auth.session.role,
    ));
  } catch {
    return privateAppJson({ error: "quickbooks_store_unavailable" }, 502);
  }
}

async function handleQuickBooksConnect(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (auth.session.role !== "owner")
    return privateAppJson({ error: "owner_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const key = quickBooksIdempotencyKey(req);
  if (!key) return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, 1_024);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const returnPath = quickBooksConnectBody(parsed.value);
  if (!returnPath)
    return privateAppJson({ error: "invalid_quickbooks_connect_request" }, 400);
  try {
    const result = await requestQuickBooksConnect(env, {
      tenantId: auth.session.tenant_id,
      actorUserId: auth.session.user_id,
      returnPath,
      idempotencyKey: key,
    });
    return result.kind === "rejected"
      ? privateAppJson({ error: result.code }, result.status)
      : privateAppJson({ version: 1, ...result.value }, 201);
  } catch {
    return privateAppJson({ error: "quickbooks_store_unavailable" }, 502);
  }
}

async function handleQuickBooksDisconnect(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (auth.session.role !== "owner")
    return privateAppJson({ error: "owner_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const key = quickBooksIdempotencyKey(req);
  if (!key) return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, 1_024);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const version = quickBooksVersionBody(parsed.value);
  if (!version)
    return privateAppJson({ error: "invalid_quickbooks_disconnect_request" }, 400);
  try {
    const result = await removeQuickBooksFromIronWrap(env, {
      tenantId: auth.session.tenant_id,
      actorUserId: auth.session.user_id,
      expectedVersion: version,
      idempotencyKey: key,
    });
    return result.kind === "rejected"
      ? privateAppJson({ error: result.code }, result.status)
      : privateAppJson(await quickBooksConnectionEnvelope(
          env,
          auth.session.tenant_id,
          auth.session.role,
        ));
  } catch {
    return privateAppJson({ error: "quickbooks_store_unavailable" }, 502);
  }
}

async function handleQuickBooksFinalInvoiceRead(
  env: AppEnv,
  auth: AuthContext,
  intentId: string,
): Promise<Response> {
  if (!hasPermission(auth, "quickbooks:read"))
    return privateAppJson({ error: "quickbooks_read_required" }, 403);
  try {
    const intent = await getQuickBooksFinalInvoice(env, auth.session.tenant_id, intentId);
    return intent
      ? privateAppJson(await quickBooksFinalInvoiceEnvelope(env, intent, auth.session.role))
      : privateAppJson({ error: "not_found" }, 404);
  } catch {
    return privateAppJson({ error: "quickbooks_store_unavailable" }, 502);
  }
}

async function handleQuickBooksFinalInvoiceCommand(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  intentId: string,
  action: "approve" | "reject" | "reconcile",
): Promise<Response> {
  const requiredPermission = action === "reconcile" ? "quickbooks:reconcile" : "quickbooks:review";
  if (!hasPermission(auth, requiredPermission))
    return privateAppJson({ error: `${requiredPermission.replace(":", "_")}_required` }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const key = quickBooksIdempotencyKey(req);
  if (!key) return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, 1_024);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const command = action === "reject"
    ? quickBooksRejectBody(parsed.value)
    : quickBooksExpectedVersionBody(parsed.value);
  if (!command)
    return privateAppJson({ error: "invalid_quickbooks_final_invoice_command" }, 400);
  try {
    const common = {
      tenantId: auth.session.tenant_id,
      intentId,
      actorRole: auth.session.role,
      expectedVersion: typeof command === "number" ? command : command.version,
      idempotencyKey: key,
    };
    const result = action === "approve"
      ? await approveQuickBooksFinalInvoice(env, {
          ...common,
          actorUserId: auth.session.user_id,
        })
      : action === "reject"
        ? await rejectQuickBooksFinalInvoice(env, {
            ...common,
            actorUserId: auth.session.user_id,
            reasonCode: (command as { version: number; reasonCode: QuickBooksRejectionReason }).reasonCode,
          })
        : await requestQuickBooksFinalInvoiceReconciliation(env, {
            ...common,
            actorUserId: auth.session.user_id,
          });
    return result.kind === "rejected"
      ? privateAppJson({ error: result.code }, result.status)
      : privateAppJson(await quickBooksFinalInvoiceEnvelope(env, result.value, auth.session.role),
          action === "approve" || action === "reconcile" ? 202 : 200);
  } catch {
    return privateAppJson({ error: "quickbooks_store_unavailable" }, 502);
  }
}

async function handlePostizIntentRead(
  env: AppEnv,
  auth: AuthContext,
  intentId: string,
): Promise<Response> {
  if (auth.session.role !== "owner")
    return privateAppJson({ error: "owner_role_required" }, 403);
  try {
    const intent = await getPostizIntent(env, auth.session.tenant_id, intentId);
    return intent
      ? privateAppJson(postizIntentEnvelope(env, intent))
      : privateAppJson({ error: "not_found" }, 404);
  } catch {
    return privateAppJson({ error: "postiz_store_unavailable" }, 502);
  }
}

async function handlePostizConnect(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (auth.session.role !== "owner")
    return privateAppJson({ error: "owner_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const key = postizIdempotencyKey(req);
  if (!key) return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const provider = postizProviderBody(parsed.value);
  if (!provider) return privateAppJson({ error: "invalid_postiz_connect_request" }, 400);
  try {
    const result = await requestPostizConnect(env, {
      tenantId: auth.session.tenant_id,
      actorUserId: auth.session.user_id,
      provider,
      idempotencyKey: key,
    });
    return result.kind === "rejected"
      ? privateAppJson({ error: result.code }, result.status)
      : privateAppJson({
          version: 1,
          connect_url: result.connectUrl,
          callback_origin: result.callbackOrigin,
          provider: result.provider,
        }, 201);
  } catch {
    return privateAppJson({ error: "postiz_store_unavailable" }, 502);
  }
}

async function handlePostizIntentCommand(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  intentId: string,
  action: "approve" | "reject" | "stop" | "reconcile",
): Promise<Response> {
  if (auth.session.role !== "owner")
    return privateAppJson({ error: "owner_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const key = postizIdempotencyKey(req);
  if (!key) return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const expectedVersion = postizExpectedVersionBody(parsed.value);
  if (!expectedVersion)
    return privateAppJson({ error: "invalid_postiz_intent_command" }, 400);
  try {
    const common = {
      tenantId: auth.session.tenant_id,
      intentId,
      expectedVersion,
      idempotencyKey: key,
    };
    const result = action === "approve"
      ? await approvePostizIntent(env, { ...common, actorUserId: auth.session.user_id })
      : action === "reject"
        ? await rejectPostizIntent(env, { ...common, actorUserId: auth.session.user_id })
        : action === "stop"
          ? await stopPostizIntent(env, { ...common, actorUserId: auth.session.user_id })
          : await reconcilePostizIntent(env, { ...common, triggerKind: "manual" });
    return result.kind === "rejected"
      ? privateAppJson({ error: result.code }, result.status)
      : privateAppJson(postizIntentEnvelope(env, result.intent));
  } catch {
    return privateAppJson({ error: "postiz_store_unavailable" }, 502);
  }
}

async function handleFleetAssetRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedAssetName: string | undefined,
  kind: FleetActionKind,
): Promise<Response> {
  if (auth.session.role !== "field") return appJson({ error: "field_role_required" }, 403);
  if (!validAppCsrf(req, auth)) return appJson({ error: "csrf_failed" }, 403);
  const assetName = decodedPathSegment(encodedAssetName ?? "");
  if (!assetName) return appJson({ error: "not_found" }, 404);
  // Fleet captures share the field upload budget: one bounded window per field
  // user covers every kind of evidence a device can start, so the capture rail
  // cannot be used to escape the throttle the photo rail already applies.
  const rateLimit = await claimFieldUploadWindow(env, auth);
  if (!rateLimit.allowed) {
    const limited = appJson(
      {
        error: "field_upload_rate_limited",
        message: "Too many field uploads are starting at once. Saved work remains queued for retry.",
      },
      429,
    );
    limited.headers.set("retry-after", String(rateLimit.retryAfterSeconds));
    return limited;
  }
  try {
    // Do not trust a fleet asset identifier from the browser. The BFF proves
    // the authenticated field user holds or drives this asset; the Frappe
    // service command repeats that scope check under its own asset lock.
    // Whether the asset is inspectable and accepts this capture stays a Frappe
    // decision taken under that lock.
    const asset = await fleetAssetForFieldActor(env, auth, assetName);
    if (!asset) return appJson({ error: "not_found" }, 404);
    return await handleFleetAction(req, env, auth, assetName, kind);
  } catch {
    return appJson({ error: "upstream_unavailable" }, 502);
  }
}

async function handleFieldWorkPackageRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedJobName: string | undefined,
  kind: WorkPackageActionKind,
  scope?: WorkObjectScope,
): Promise<Response> {
  if (auth.session.role !== "field") return appJson({ error: "field_role_required" }, 403);
  if (!validAppCsrf(req, auth)) return appJson({ error: "csrf_failed" }, 403);
  const jobName = scope?.workObjectId ?? decodedPathSegment(encodedJobName ?? "");
  if (!jobName) return appJson({ error: "not_found" }, 404);
  try {
    // Do not trust a job or assignment identifier from the browser. The BFF
    // derives an active assignment for the authenticated, paired field user;
    // the Frappe service command repeats that scope check under its own lock.
    const assignment = scope
      ? await activeAssignmentForWorkObject(env, auth, scope)
      : await activeAssignmentForJob(env, auth, jobName);
    if (typeof assignment?.name !== "string") return appJson({ error: "not_found" }, 404);
    return await handleWorkPackageAction(
      req,
      env,
      auth,
      jobName,
      assignment,
      kind,
      scope,
    );
  } catch {
    return appJson({ error: "upstream_unavailable" }, 502);
  }
}

async function handleProductionWorkPackageRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedJobName: string | undefined,
  kind: WorkPackageActionKind,
  scope?: WorkObjectScope,
): Promise<Response> {
  if (
    auth.session.role !== "owner" &&
    auth.session.role !== "ops" &&
    auth.session.role !== "production"
  )
    return privateAppJson({ error: "production_role_required" }, 403);
  if (!validAppCsrf(req, auth)) return privateAppJson({ error: "csrf_failed" }, 403);
  const jobName = scope?.workObjectId ?? decodedPathSegment(encodedJobName ?? "");
  if (!jobName) return privateAppJson({ error: "not_found" }, 404);
  try {
    const assignment = scope
      ? await activeAssignmentForWorkObject(env, auth, scope)
      : await activeAssignmentForJob(env, auth, jobName);
    if (typeof assignment?.name !== "string")
      return privateAppJson({ error: "not_found" }, 404);
    if (
      scope &&
      !hasPhysicalAssignmentAuthority(
        assignment,
        auth.session.frappe_user_id,
        auth.session.role,
      )
    ) {
      return privateAppJson(
        { error: "work_package_completion_authority_required" },
        403,
      );
    }
    return await handleWorkPackageAction(
      req,
      env,
      auth,
      jobName,
      assignment,
      kind,
      scope,
    );
  } catch {
    return privateAppJson({ error: "upstream_unavailable" }, 502);
  }
}

async function prepareQuoteRevisionApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!hasPermission(auth, "approvals:prepare"))
    return privateAppJson({ error: "office_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const prepareIdempotencyKey = idempotencyKey(req);
  if (!prepareIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseQuoteRevisionApprovalPreparation(parsed.value);
  if (!input)
    return privateAppJson(
      { error: "invalid_quote_revision_approval_request" },
      400,
    );
  return await prepareQuoteRevisionApprovalRequest(
    env,
    auth,
    prepareIdempotencyKey,
    input,
  );
}

async function prepareQuoteRevisionApprovalRequest(
  env: AppEnv,
  auth: AuthContext,
  prepareIdempotencyKey: string,
  input: NonNullable<ReturnType<typeof parseQuoteRevisionApprovalPreparation>>,
): Promise<Response> {
  const requestedByFrappeUser = auth.session.frappe_user_id?.trim() ?? "";
  if (!requestedByFrappeUser)
    return privateAppJson({ error: "frappe_identity_required" }, 403);
  const requestText = quoteRevisionRequestText(input.correctionReason);

  try {
    const existing = await getQuoteRevisionApprovalRequestByPrepareKey(
      env,
      auth.session.tenant_id,
      prepareIdempotencyKey,
    );
    if (existing) {
      return matchesQuoteRevisionApprovalPreparation(existing, {
        requestedByUserId: auth.session.user_id,
        roofJobId: input.roofJobId,
        sourceCustomerQuoteId: input.customerQuoteId,
        correctionReason: input.correctionReason,
        requestText,
      })
        ? privateAppJson({
            approval: quoteRevisionApprovalProjection(existing),
            replayed: true,
          })
        : privateAppJson(
            {
              error: "idempotency_conflict",
              approval: quoteRevisionApprovalProjection(existing),
            },
            409,
          );
    }
  } catch {
    return privateAppJson(
      { error: "quote_revision_approval_store_unavailable" },
      502,
    );
  }

  if (!quoteRevisionApprovalBrokerConfig(env) || !approvalDecisionConfig(env)) {
    return privateAppJson(
      { error: "quote_revision_broker_not_configured" },
      503,
    );
  }
  const approvalRequestId = `quote-revision-approval:${randomToken()}`;
  const runId = `run:quote-revision:${randomToken()}`;
  let packet;
  try {
    packet = await previewQuoteRevisionApproval(env, {
      approvalRequestId,
      tenantId: auth.session.tenant_id,
      runId,
      roofJobId: input.roofJobId,
      customerQuoteId: input.customerQuoteId,
      correctionReason: input.correctionReason,
      requestText,
      requestedByUserId: auth.session.user_id,
      requestedByFrappeUser,
    });
  } catch (error) {
    return privateAppJson(
      { error: quoteRevisionBrokerPrepareError(error) },
      quoteRevisionBrokerPrepareStatus(error),
    );
  }

  try {
    const created = await createQuoteRevisionApprovalRequest(env, {
      id: approvalRequestId,
      tenantId: auth.session.tenant_id,
      prepareIdempotencyKey,
      intentFingerprint: packet.intentFingerprint,
      actorUser: packet.actorUser,
      siteId: packet.siteId,
      roofJobId: packet.roofJobId,
      sourceCustomerQuoteId: packet.sourceCustomerQuoteId,
      sourceQuoteVersion: packet.sourceQuoteVersion,
      sourceQuoteStatus: packet.sourceQuoteStatus,
      sourceQuoteModified: packet.sourceQuoteModified,
      targetCustomerQuoteId: packet.targetCustomerQuoteId,
      targetQuoteVersion: packet.targetQuoteVersion,
      correctionReason: packet.correctionReason,
      requestText: packet.requestText,
      writeArgsJson: packet.writeArgsJson,
      previewJson: packet.previewJson,
      argsDigest: packet.argsDigest,
      previewDigest: packet.previewDigest,
      receiptPreviewDigest: packet.receiptPreviewDigest,
      dryRunReceipt: packet.dryRunReceipt,
      expiresAt: packet.expiresAt,
      requestedByUserId: auth.session.user_id,
      requestedByFrappeUser,
      runId: packet.runId,
      now: new Date().toISOString(),
    });
    if (created.kind === "conflict") {
      return privateAppJson(
        {
          error: "idempotency_conflict",
          approval: quoteRevisionApprovalProjection(created.request),
        },
        409,
      );
    }
    return privateAppJson(
      {
        approval: quoteRevisionApprovalProjection(created.request),
        replayed: created.kind === "replayed",
      },
      created.kind === "created" ? 201 : 200,
    );
  } catch {
    return privateAppJson(
      { error: "quote_revision_approval_store_unavailable" },
      502,
    );
  }
}

async function approveQuoteRevisionApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const identity = quoteRevisionApprovalBrokerDecisionIdentity(env, auth);
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const decisionIdempotencyKey = idempotencyKey(req);
  if (!decisionIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const expectedVersion = parseExpectedVersion(parsed.value);
  if (expectedVersion === null)
    return privateAppJson(
      { error: "invalid_quote_revision_approval_decision" },
      400,
    );

  const now = new Date();
  let claimed;
  try {
    claimed = await claimQuoteRevisionApprovalExecution(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion,
      decisionIdempotencyKey,
      approvedByUserId: auth.session.user_id,
      approvedByFrappeUser: identity.frappeUserId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(
        now.getTime() + identity.config.executionLeaseSeconds * 1000,
      ).toISOString(),
    });
  } catch {
    return privateAppJson(
      { error: "quote_revision_approval_store_unavailable" },
      502,
    );
  }
  if (claimed.kind !== "claimed")
    return quoteRevisionDecisionResultResponse(claimed);

  let outcome;
  try {
    outcome = await executeQuoteRevisionApproval(env, claimed.request);
  } catch (error) {
    return await finalizeQuoteRevisionBrokerFailure(
      env,
      auth,
      claimed.request,
      decisionIdempotencyKey,
      error,
    );
  }
  try {
    const finalized = await finalizeQuoteRevisionApprovalExecution(env, {
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
        ? privateAppJson(
            {
              error: "quote_revision_approval_state_changed",
              approval: quoteRevisionApprovalProjection(finalized.request),
            },
            409,
          )
        : privateAppJson({ error: "not_found" }, 404);
    }
    const status =
      outcome.state === "executed"
        ? 200
        : outcome.state === "execution_uncertain"
          ? 502
          : 422;
    return privateAppJson(
      { approval: quoteRevisionApprovalProjection(finalized.request) },
      status,
    );
  } catch {
    // The private broker may have completed a Frappe write. Keep the lease so
    // it becomes reconciliation work rather than inviting a second revision.
    return privateAppJson(
      { error: "quote_revision_execution_finalization_unavailable" },
      502,
    );
  }
}

async function finalizeQuoteRevisionBrokerFailure(
  env: AppEnv,
  auth: AuthContext,
  request: Parameters<typeof executeQuoteRevisionApproval>[1],
  decisionIdempotencyKey: string,
  error: unknown,
): Promise<Response> {
  const errorCode =
    error instanceof QuoteRevisionApprovalBrokerError &&
    error.code === "quote_revision_broker_unavailable"
      ? "quote_revision_broker_unavailable"
      : "quote_revision_broker_response_unverified";
  try {
    const finalized = await finalizeQuoteRevisionApprovalExecution(env, {
      tenantId: auth.session.tenant_id,
      requestId: request.quote_revision_approval_id,
      decisionIdempotencyKey,
      state: "execution_uncertain",
      hermesRunId: request.run_id,
      errorCode,
      now: new Date().toISOString(),
    });
    if (finalized.kind === "finalized") {
      return privateAppJson(
        {
          error: "execution_uncertain",
          approval: quoteRevisionApprovalProjection(finalized.request),
        },
        502,
      );
    }
    return finalized.request
      ? privateAppJson(
          {
            error: "quote_revision_approval_state_changed",
            approval: quoteRevisionApprovalProjection(finalized.request),
          },
          409,
        )
      : privateAppJson({ error: "not_found" }, 404);
  } catch {
    return privateAppJson(
      { error: "quote_revision_execution_finalization_unavailable" },
      502,
    );
  }
}

async function rejectQuoteRevisionApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const identity = approvalDecisionIdentity(env, auth);
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const decisionIdempotencyKey = idempotencyKey(req);
  if (!decisionIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const decision = parseRejectionDecision(parsed.value);
  if (!decision)
    return privateAppJson(
      { error: "invalid_quote_revision_approval_decision" },
      400,
    );
  try {
    const denied = await denyQuoteRevisionApprovalRequest(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion: decision.version,
      decisionIdempotencyKey,
      approvedByUserId: auth.session.user_id,
      approvedByFrappeUser: identity.frappeUserId,
      rejectionReason: decision.reason,
      now: new Date().toISOString(),
    });
    if (denied.kind === "denied")
      return privateAppJson({
        approval: quoteRevisionApprovalProjection(denied.request),
      });
    return quoteRevisionDecisionResultResponse(denied);
  } catch {
    return privateAppJson(
      { error: "quote_revision_approval_store_unavailable" },
      502,
    );
  }
}

async function reconcileQuoteRevisionApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const identity = approvalDecisionIdentity(env, auth);
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const reconciliation = parseReconciliation(parsed.value);
  if (!reconciliation)
    return privateAppJson(
      { error: "invalid_quote_revision_reconciliation" },
      400,
    );
  try {
    const result = await reconcileQuoteRevisionApprovalUncertainty(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion: reconciliation.version,
      reconciledByUserId: auth.session.user_id,
      reconciledByFrappeUser: identity.frappeUserId,
      outcome: reconciliation.outcome,
      evidence: reconciliation.evidence,
      now: new Date().toISOString(),
    });
    if (result.kind === "reconciled")
      return privateAppJson({
        approval: quoteRevisionApprovalProjection(result.request),
      });
    if (result.kind === "already_reconciled") {
      return privateAppJson({
        approval: quoteRevisionApprovalProjection(result.request),
        replayed: true,
      });
    }
    if (result.kind === "missing")
      return privateAppJson({ error: "not_found" }, 404);
    if (result.kind === "not_uncertain") {
      return privateAppJson(
        {
          error: "quote_revision_approval_not_uncertain",
          approval: quoteRevisionApprovalProjection(result.request),
        },
        409,
      );
    }
    return privateAppJson(
      {
        error: "quote_revision_approval_version_conflict",
        approval: quoteRevisionApprovalProjection(result.request),
      },
      409,
    );
  } catch {
    return privateAppJson(
      { error: "quote_revision_approval_store_unavailable" },
      502,
    );
  }
}

async function prepareProposalPublicationApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!proposalPublicationEnabled(env))
    return privateAppJson({ error: "not_found" }, 404);
  if (!hasPermission(auth, "approvals:prepare"))
    return privateAppJson({ error: "office_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const prepareIdempotencyKey = idempotencyKey(req);
  if (!prepareIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseProposalPublicationApprovalPreparation(parsed.value);
  if (!input)
    return privateAppJson(
      { error: "invalid_proposal_publication_approval_request" },
      400,
    );
  return await prepareProposalPublicationApprovalRequest(
    env,
    auth,
    prepareIdempotencyKey,
    input,
  );
}

async function prepareProposalPublicationApprovalRequest(
  env: AppEnv,
  auth: AuthContext,
  prepareIdempotencyKey: string,
  input: NonNullable<ReturnType<typeof parseProposalPublicationApprovalPreparation>>,
): Promise<Response> {
  const requestedByFrappeUser = auth.session.frappe_user_id?.trim() ?? "";
  if (!requestedByFrappeUser)
    return privateAppJson({ error: "frappe_identity_required" }, 403);
  const requestText = proposalPublicationRequestText(input.proposalEvidencePackId);

  try {
    const existing = await getProposalPublicationApprovalRequestByPrepareKey(
      env,
      auth.session.tenant_id,
      prepareIdempotencyKey,
    );
    if (existing) {
      return matchesProposalPublicationApprovalPreparation(existing, {
        requestedByUserId: auth.session.user_id,
        roofJobId: input.roofJobId,
        proposalEvidencePackId: input.proposalEvidencePackId,
        requestText,
      })
        ? privateAppJson({
            approval: proposalPublicationApprovalProjection(existing),
            replayed: true,
          })
        : privateAppJson(
            {
              error: "idempotency_conflict",
              approval: proposalPublicationApprovalProjection(existing),
            },
            409,
          );
    }
  } catch {
    return privateAppJson(
      { error: "proposal_publication_approval_store_unavailable" },
      502,
    );
  }

  if (!proposalPublicationApprovalBrokerConfig(env) || !approvalDecisionConfig(env)) {
    return privateAppJson(
      { error: "proposal_publication_broker_not_configured" },
      503,
    );
  }
  const approvalRequestId = `proposal-publication-approval:${randomToken()}`;
  const runId = `run:proposal-publication:${randomToken()}`;
  let packet;
  try {
    packet = await previewProposalPublicationApproval(env, {
      approvalRequestId,
      tenantId: auth.session.tenant_id,
      runId,
      roofJobId: input.roofJobId,
      proposalEvidencePackId: input.proposalEvidencePackId,
      requestText,
      requestedByUserId: auth.session.user_id,
      requestedByFrappeUser,
    });
  } catch (error) {
    return privateAppJson(
      { error: proposalPublicationBrokerPrepareError(error) },
      proposalPublicationBrokerPrepareStatus(error),
    );
  }

  try {
    const created = await createProposalPublicationApprovalRequest(env, {
      id: approvalRequestId,
      tenantId: auth.session.tenant_id,
      prepareIdempotencyKey,
      intentFingerprint: packet.intentFingerprint,
      actorUser: packet.actorUser,
      siteId: packet.siteId,
      roofJobId: packet.roofJobId,
      proposalEvidencePackId: packet.proposalEvidencePackId,
      customerQuoteId: packet.customerQuoteId,
      packStatusBefore: packet.packStatusBefore,
      requestText: packet.requestText,
      writeArgsJson: packet.writeArgsJson,
      previewJson: packet.previewJson,
      argsDigest: packet.argsDigest,
      previewDigest: packet.previewDigest,
      receiptPreviewDigest: packet.receiptPreviewDigest,
      dryRunReceipt: packet.dryRunReceipt,
      expiresAt: packet.expiresAt,
      requestedByUserId: auth.session.user_id,
      requestedByFrappeUser,
      runId: packet.runId,
      now: new Date().toISOString(),
    });
    if (created.kind === "conflict") {
      return privateAppJson(
        {
          error: "idempotency_conflict",
          approval: proposalPublicationApprovalProjection(created.request),
        },
        409,
      );
    }
    return privateAppJson(
      {
        approval: proposalPublicationApprovalProjection(created.request),
        replayed: created.kind === "replayed",
      },
      created.kind === "created" ? 201 : 200,
    );
  } catch (error) {
    // A competing active intent for the same pack is a conflict, not an outage:
    // Frappe accepts publication only from Draft, so two live runs cannot both win.
    if (String(error).includes("UNIQUE")) {
      return privateAppJson(
        { error: "proposal_publication_approval_already_active" },
        409,
      );
    }
    return privateAppJson(
      { error: "proposal_publication_approval_store_unavailable" },
      502,
    );
  }
}

async function approveProposalPublicationApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  if (!proposalPublicationEnabled(env))
    return privateAppJson({ error: "not_found" }, 404);
  const identity = proposalPublicationApprovalBrokerDecisionIdentity(env, auth);
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const decisionIdempotencyKey = idempotencyKey(req);
  if (!decisionIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const expectedVersion = parseExpectedVersion(parsed.value);
  if (expectedVersion === null)
    return privateAppJson(
      { error: "invalid_proposal_publication_approval_decision" },
      400,
    );

  const now = new Date();
  let claimed;
  try {
    claimed = await claimProposalPublicationApprovalExecution(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion,
      decisionIdempotencyKey,
      approvedByUserId: auth.session.user_id,
      approvedByFrappeUser: identity.frappeUserId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(
        now.getTime() + identity.config.executionLeaseSeconds * 1000,
      ).toISOString(),
    });
  } catch {
    return privateAppJson(
      { error: "proposal_publication_approval_store_unavailable" },
      502,
    );
  }
  if (claimed.kind !== "claimed")
    return proposalPublicationDecisionResultResponse(claimed);

  let outcome;
  try {
    outcome = await executeProposalPublicationApproval(env, claimed.request);
  } catch (error) {
    return await finalizeProposalPublicationBrokerFailure(
      env,
      auth,
      claimed.request,
      decisionIdempotencyKey,
      error,
    );
  }
  try {
    const finalized = await finalizeProposalPublicationApprovalExecution(env, {
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
        ? privateAppJson(
            {
              error: "proposal_publication_approval_state_changed",
              approval: proposalPublicationApprovalProjection(finalized.request),
            },
            409,
          )
        : privateAppJson({ error: "not_found" }, 404);
    }
    const status =
      outcome.state === "executed"
        ? 200
        : outcome.state === "execution_uncertain"
          ? 502
          : 422;
    return privateAppJson(
      { approval: proposalPublicationApprovalProjection(finalized.request) },
      status,
    );
  } catch {
    // The private broker may have completed the Frappe publication. Keep the
    // lease so it becomes reconciliation work rather than a second publish.
    return privateAppJson(
      { error: "proposal_publication_execution_finalization_unavailable" },
      502,
    );
  }
}

async function finalizeProposalPublicationBrokerFailure(
  env: AppEnv,
  auth: AuthContext,
  request: Parameters<typeof executeProposalPublicationApproval>[1],
  decisionIdempotencyKey: string,
  error: unknown,
): Promise<Response> {
  const errorCode =
    error instanceof ProposalPublicationApprovalBrokerError &&
    error.code === "proposal_publication_broker_unavailable"
      ? "proposal_publication_broker_unavailable"
      : "proposal_publication_broker_response_unverified";
  try {
    const finalized = await finalizeProposalPublicationApprovalExecution(env, {
      tenantId: auth.session.tenant_id,
      requestId: request.proposal_publication_approval_id,
      decisionIdempotencyKey,
      state: "execution_uncertain",
      hermesRunId: request.run_id,
      errorCode,
      now: new Date().toISOString(),
    });
    if (finalized.kind === "finalized") {
      return privateAppJson(
        {
          error: "execution_uncertain",
          approval: proposalPublicationApprovalProjection(finalized.request),
        },
        502,
      );
    }
    return finalized.request
      ? privateAppJson(
          {
            error: "proposal_publication_approval_state_changed",
            approval: proposalPublicationApprovalProjection(finalized.request),
          },
          409,
        )
      : privateAppJson({ error: "not_found" }, 404);
  } catch {
    return privateAppJson(
      { error: "proposal_publication_execution_finalization_unavailable" },
      502,
    );
  }
}

async function rejectProposalPublicationApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  if (!proposalPublicationEnabled(env))
    return privateAppJson({ error: "not_found" }, 404);
  const identity = approvalDecisionIdentity(env, auth);
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const decisionIdempotencyKey = idempotencyKey(req);
  if (!decisionIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const decision = parseRejectionDecision(parsed.value);
  if (!decision)
    return privateAppJson(
      { error: "invalid_proposal_publication_approval_decision" },
      400,
    );
  try {
    const denied = await denyProposalPublicationApprovalRequest(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion: decision.version,
      decisionIdempotencyKey,
      approvedByUserId: auth.session.user_id,
      approvedByFrappeUser: identity.frappeUserId,
      rejectionReason: decision.reason,
      now: new Date().toISOString(),
    });
    if (denied.kind === "denied")
      return privateAppJson({
        approval: proposalPublicationApprovalProjection(denied.request),
      });
    return proposalPublicationDecisionResultResponse(denied);
  } catch {
    return privateAppJson(
      { error: "proposal_publication_approval_store_unavailable" },
      502,
    );
  }
}

async function reconcileProposalPublicationApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  if (!proposalPublicationEnabled(env))
    return privateAppJson({ error: "not_found" }, 404);
  const identity = approvalDecisionIdentity(env, auth);
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const reconciliation = parseReconciliation(parsed.value);
  if (!reconciliation)
    return privateAppJson(
      { error: "invalid_proposal_publication_reconciliation" },
      400,
    );
  try {
    const result = await reconcileProposalPublicationApprovalUncertainty(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion: reconciliation.version,
      reconciledByUserId: auth.session.user_id,
      reconciledByFrappeUser: identity.frappeUserId,
      outcome: reconciliation.outcome,
      evidence: reconciliation.evidence,
      now: new Date().toISOString(),
    });
    if (result.kind === "reconciled")
      return privateAppJson({
        approval: proposalPublicationApprovalProjection(result.request),
      });
    if (result.kind === "already_reconciled") {
      return privateAppJson({
        approval: proposalPublicationApprovalProjection(result.request),
        replayed: true,
      });
    }
    if (result.kind === "missing")
      return privateAppJson({ error: "not_found" }, 404);
    if (result.kind === "not_uncertain") {
      return privateAppJson(
        {
          error: "proposal_publication_approval_not_uncertain",
          approval: proposalPublicationApprovalProjection(result.request),
        },
        409,
      );
    }
    return privateAppJson(
      {
        error: "proposal_publication_approval_version_conflict",
        approval: proposalPublicationApprovalProjection(result.request),
      },
      409,
    );
  } catch {
    return privateAppJson(
      { error: "proposal_publication_approval_store_unavailable" },
      502,
    );
  }
}

async function prepareProductionScheduleApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  const identity = productionScheduleApprovalBrokerDecisionIdentity(env, auth);
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const prepareIdempotencyKey = idempotencyKey(req);
  if (!prepareIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseProductionScheduleApprovalPreparation(parsed.value);
  if (!input)
    return privateAppJson(
      { error: "invalid_production_schedule_approval_request" },
      400,
    );
  const requestText = productionScheduleRequestText(input);

  try {
    const existing = await getProductionScheduleApprovalRequestByPrepareKey(
      env,
      auth.session.tenant_id,
      prepareIdempotencyKey,
    );
    if (existing) {
      return matchesProductionScheduleApprovalPreparation(existing, {
        requestedByUserId: auth.session.user_id,
        roofJobId: input.roofJobId,
        targetAssignmentId: existing.target_assignment_id,
        crewProfileId: input.crewProfileId,
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
        supersedesAssignmentId: input.supersedesAssignmentId,
        correctionReason: input.correctionReason,
        requestText,
      })
        ? privateAppJson({
            approval: productionScheduleApprovalProjection(existing),
            replayed: true,
          })
        : privateAppJson(
            {
              error: "idempotency_conflict",
              approval: productionScheduleApprovalProjection(existing),
            },
            409,
          );
    }
  } catch {
    return privateAppJson(
      { error: "production_schedule_approval_store_unavailable" },
      502,
    );
  }

  const eligibility = await validateProductionSchedulePreparation(
    env,
    auth,
    input,
  );
  if (!eligibility.ok)
    return privateAppJson({ error: eligibility.error }, eligibility.status);

  const approvalRequestId = `production-schedule-approval:${randomToken()}`;
  const runId = `run:production-schedule:${randomToken()}`;
  let packet;
  try {
    packet = await previewProductionScheduleApproval(env, {
      approvalRequestId,
      tenantId: auth.session.tenant_id,
      runId,
      roofJobId: input.roofJobId,
      crewProfileId: input.crewProfileId,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      supersedesAssignmentId: input.supersedesAssignmentId,
      correctionReason: input.correctionReason,
      requestText,
      requestedByUserId: auth.session.user_id,
      requestedByFrappeUser: identity.frappeUserId,
    });
  } catch (error) {
    return privateAppJson(
      { error: productionScheduleBrokerPrepareError(error) },
      productionScheduleBrokerPrepareStatus(error),
    );
  }

  try {
    const created = await createProductionScheduleApprovalRequest(env, {
      id: approvalRequestId,
      tenantId: auth.session.tenant_id,
      prepareIdempotencyKey,
      intentFingerprint: packet.intentFingerprint,
      actorUser: packet.actorUser,
      siteId: packet.siteId,
      roofJobId: packet.roofJobId,
      targetAssignmentId: packet.targetName,
      crewProfileId: packet.crewProfileId,
      scheduledStart: packet.scheduledStart,
      scheduledEnd: packet.scheduledEnd,
      supersedesAssignmentId: packet.supersedesAssignmentId,
      correctionReason: packet.correctionReason,
      requestText: packet.requestText,
      writeArgsJson: packet.writeArgsJson,
      previewJson: packet.previewJson,
      argsDigest: packet.argsDigest,
      previewDigest: packet.previewDigest,
      receiptPreviewDigest: packet.receiptPreviewDigest,
      dryRunReceipt: packet.dryRunReceipt,
      expiresAt: packet.expiresAt,
      requestedByUserId: auth.session.user_id,
      requestedByFrappeUser: identity.frappeUserId,
      runId: packet.runId,
      now: new Date().toISOString(),
    });
    if (created.kind === "conflict") {
      return privateAppJson(
        {
          error: "idempotency_conflict",
          approval: productionScheduleApprovalProjection(created.request),
        },
        409,
      );
    }
    return privateAppJson(
      {
        approval: productionScheduleApprovalProjection(created.request),
        replayed: created.kind === "replayed",
      },
      created.kind === "created" ? 201 : 200,
    );
  } catch {
    return privateAppJson(
      { error: "production_schedule_approval_store_unavailable" },
      502,
    );
  }
}

async function approveProductionScheduleApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const identity = productionScheduleApprovalBrokerDecisionIdentity(env, auth);
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const decisionIdempotencyKey = idempotencyKey(req);
  if (!decisionIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const expectedVersion = parseExpectedVersion(parsed.value);
  if (expectedVersion === null)
    return privateAppJson(
      { error: "invalid_production_schedule_approval_decision" },
      400,
    );

  const now = new Date();
  // Releasing a crew to a job is a release decision, so it consumes current
  // safety readiness for that job before the execution lease is claimed. The
  // verdict — including a refusal — is recorded as an immutable snapshot.
  const scheduleRequest = await getProductionScheduleApprovalRequest(
    env,
    auth.session.tenant_id,
    requestId,
  ).catch(() => null);
  if (scheduleRequest?.roof_job_id) {
    const gate = await safetyReleaseGate(env, {
      tenantId: auth.session.tenant_id,
      scope: { type: "roof_job", id: scheduleRequest.roof_job_id },
      jobId: scheduleRequest.roof_job_id,
      subjectUserIds: [],
      consumer: "schedule_release",
      evaluatedByUserId: auth.session.user_id,
      decisionRef: `${requestId}:${decisionIdempotencyKey}`,
      now: now.toISOString(),
    });
    if (!gate.readiness.ready) {
      return privateAppJson(
        {
          error: "safety_release_blocked",
          blockers: gate.readiness.blockers,
          snapshot_id: gate.snapshot_id,
        },
        409,
      );
    }
  }
  let claimed;
  try {
    claimed = await claimProductionScheduleApprovalExecution(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion,
      decisionIdempotencyKey,
      approvedByUserId: auth.session.user_id,
      approvedByFrappeUser: identity.frappeUserId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(
        now.getTime() + identity.broker.executionLeaseSeconds * 1000,
      ).toISOString(),
    });
  } catch {
    return privateAppJson(
      { error: "production_schedule_approval_store_unavailable" },
      502,
    );
  }
  if (claimed.kind !== "claimed")
    return productionScheduleDecisionResultResponse(claimed);

  let outcome;
  try {
    outcome = await executeProductionScheduleApproval(env, claimed.request);
  } catch (error) {
    return await finalizeProductionScheduleBrokerFailure(
      env,
      auth,
      claimed.request,
      decisionIdempotencyKey,
      error,
    );
  }
  try {
    const finalized = await finalizeProductionScheduleApprovalExecution(env, {
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
        ? privateAppJson(
            {
              error: "production_schedule_approval_state_changed",
              approval: productionScheduleApprovalProjection(finalized.request),
            },
            409,
          )
        : privateAppJson({ error: "not_found" }, 404);
    }
    const status =
      outcome.state === "executed"
        ? 200
        : outcome.state === "execution_uncertain"
          ? 502
          : 422;
    return privateAppJson(
      { approval: productionScheduleApprovalProjection(finalized.request) },
      status,
    );
  } catch {
    // A verified private broker may already have created the assignment. Leave
    // the claim intact so the cron sweep makes it reconciliation work instead
    // of inviting a second append-only write.
    return privateAppJson(
      { error: "production_schedule_execution_finalization_unavailable" },
      502,
    );
  }
}

async function finalizeProductionScheduleBrokerFailure(
  env: AppEnv,
  auth: AuthContext,
  request: Parameters<typeof executeProductionScheduleApproval>[1],
  decisionIdempotencyKey: string,
  error: unknown,
): Promise<Response> {
  const errorCode =
    error instanceof ProductionScheduleApprovalBrokerError &&
    error.code === "production_schedule_broker_unavailable"
      ? "production_schedule_broker_unavailable"
      : "production_schedule_broker_response_unverified";
  try {
    const finalized = await finalizeProductionScheduleApprovalExecution(env, {
      tenantId: auth.session.tenant_id,
      requestId: request.production_schedule_approval_id,
      decisionIdempotencyKey,
      state: "execution_uncertain",
      hermesRunId: request.run_id,
      errorCode,
      now: new Date().toISOString(),
    });
    if (finalized.kind === "finalized") {
      return privateAppJson(
        {
          error: "execution_uncertain",
          approval: productionScheduleApprovalProjection(finalized.request),
        },
        502,
      );
    }
    return finalized.request
      ? privateAppJson(
          {
            error: "production_schedule_approval_state_changed",
            approval: productionScheduleApprovalProjection(finalized.request),
          },
          409,
        )
      : privateAppJson({ error: "not_found" }, 404);
  } catch {
    return privateAppJson(
      { error: "production_schedule_execution_finalization_unavailable" },
      502,
    );
  }
}

async function rejectProductionScheduleApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const identity = productionScheduleApprovalDecisionIdentity(env, auth);
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const decisionIdempotencyKey = idempotencyKey(req);
  if (!decisionIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const decision = parseRejectionDecision(parsed.value);
  if (!decision)
    return privateAppJson(
      { error: "invalid_production_schedule_approval_decision" },
      400,
    );
  try {
    const denied = await denyProductionScheduleApprovalRequest(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion: decision.version,
      decisionIdempotencyKey,
      approvedByUserId: auth.session.user_id,
      approvedByFrappeUser: identity.frappeUserId,
      rejectionReason: decision.reason,
      now: new Date().toISOString(),
    });
    if (denied.kind === "denied")
      return privateAppJson({
        approval: productionScheduleApprovalProjection(denied.request),
      });
    return productionScheduleDecisionResultResponse(denied);
  } catch {
    return privateAppJson(
      { error: "production_schedule_approval_store_unavailable" },
      502,
    );
  }
}

async function reconcileProductionScheduleApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const identity = productionScheduleApprovalDecisionIdentity(env, auth);
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const reconciliation = parseReconciliation(parsed.value);
  if (!reconciliation)
    return privateAppJson(
      { error: "invalid_production_schedule_reconciliation" },
      400,
    );
  try {
    const result = await reconcileProductionScheduleApprovalUncertainty(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion: reconciliation.version,
      reconciledByUserId: auth.session.user_id,
      reconciledByFrappeUser: identity.frappeUserId,
      outcome: reconciliation.outcome,
      evidence: reconciliation.evidence,
      now: new Date().toISOString(),
    });
    if (result.kind === "reconciled")
      return privateAppJson({
        approval: productionScheduleApprovalProjection(result.request),
      });
    if (result.kind === "already_reconciled") {
      return privateAppJson({
        approval: productionScheduleApprovalProjection(result.request),
        replayed: true,
      });
    }
    if (result.kind === "missing")
      return privateAppJson({ error: "not_found" }, 404);
    if (result.kind === "not_uncertain") {
      return privateAppJson(
        {
          error: "production_schedule_approval_not_uncertain",
          approval: productionScheduleApprovalProjection(result.request),
        },
        409,
      );
    }
    return privateAppJson(
      {
        error: "production_schedule_approval_version_conflict",
        approval: productionScheduleApprovalProjection(result.request),
      },
      409,
    );
  } catch {
    return privateAppJson(
      { error: "production_schedule_approval_store_unavailable" },
      502,
    );
  }
}

async function prepareLeadTriageApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!hasPermission(auth, "approvals:prepare"))
    return privateAppJson({ error: "office_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const prepareIdempotencyKey = idempotencyKey(req);
  if (!prepareIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseLeadTriagePreparation(parsed.value);
  if (!input) return privateAppJson({ error: "invalid_approval_request" }, 400);
  const requestText = leadTriageRequestText(input.triageSummary);
  const requestedByFrappeUser = auth.session.frappe_user_id?.trim() ?? "";
  if (!requestedByFrappeUser)
    return privateAppJson({ error: "frappe_identity_required" }, 403);

  try {
    const existing = await getApprovalRequestByPrepareKey(
      env,
      auth.session.tenant_id,
      prepareIdempotencyKey,
    );
    if (existing) {
      return matchesApprovalPreparation(existing, {
        requestedByUserId: auth.session.user_id,
        leadEnvelopeId: input.leadEnvelopeId,
        triageSummary: input.triageSummary,
        requestText,
      })
        ? privateAppJson({
            approval: approvalProjection(existing),
            replayed: true,
          })
        : privateAppJson(
            {
              error: "idempotency_conflict",
              approval: approvalProjection(existing),
            },
            409,
          );
    }
  } catch {
    return privateAppJson({ error: "approval_store_unavailable" }, 502);
  }

  if (!approvalBrokerConfig(env))
    return privateAppJson({ error: "approval_broker_not_configured" }, 503);
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
      requestText,
      requestedByUserId: auth.session.user_id,
      requestedByFrappeUser,
    });
  } catch (error) {
    return privateAppJson(
      { error: brokerPrepareError(error) },
      brokerPrepareStatus(error),
    );
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
      return privateAppJson(
        {
          error: "idempotency_conflict",
          approval: approvalProjection(created.request),
        },
        409,
      );
    }
    return privateAppJson(
      {
        approval: approvalProjection(created.request),
        replayed: created.kind === "replayed",
      },
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
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const decisionIdempotencyKey = idempotencyKey(req);
  if (!decisionIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const expectedVersion = parseExpectedVersion(parsed.value);
  if (expectedVersion === null)
    return privateAppJson({ error: "invalid_approval_decision" }, 400);

  const now = new Date();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(
    now.getTime() + identity.config.executionLeaseSeconds * 1000,
  ).toISOString();
  let claimed;
  try {
    claimed = await claimApprovalExecution(env, {
      tenantId: auth.session.tenant_id,
      requestId,
      expectedVersion,
      decisionIdempotencyKey,
      approvedByUserId: auth.session.user_id,
      approvedByFrappeUser: identity.frappeUserId,
      now: nowIso,
      leaseExpiresAt,
    });
  } catch {
    return privateAppJson({ error: "approval_store_unavailable" }, 502);
  }
  if (claimed.kind !== "claimed")
    return approvalDecisionResultResponse(claimed);

  try {
    const dispatch = await claimGovernedTransitionOutbox(env, {
      tenantId: auth.session.tenant_id,
      approvalRequestId: requestId,
      decisionIdempotencyKey,
      now: nowIso,
      leaseExpiresAt,
    });
    if (dispatch.kind !== "claimed") {
      return privateAppJson(
        {
          error: dispatch.kind === "already_leased"
            ? "approval_execution_in_progress"
            : "approval_dispatch_unavailable",
          approval: approvalProjection(claimed.request),
        },
        dispatch.kind === "already_leased" ? 202 : 502,
      );
    }
  } catch {
    return privateAppJson(
      {
        error: "approval_dispatch_unavailable",
        approval: approvalProjection(claimed.request),
      },
      502,
    );
  }

  let outcome;
  try {
    outcome = await executeLeadTriageApproval(env, claimed.request);
  } catch (error) {
    return await finalizeBrokerFailure(
      env,
      auth,
      claimed.request,
      decisionIdempotencyKey,
      error,
    );
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
        ? privateAppJson(
            {
              error: "approval_state_changed",
              approval: approvalProjection(finalized.request),
            },
            409,
          )
        : privateAppJson({ error: "not_found" }, 404);
    }
    const status =
      outcome.state === "executed"
        ? 200
        : outcome.state === "execution_uncertain"
          ? 502
          : 422;
    return privateAppJson(
      { approval: approvalProjection(finalized.request) },
      status,
    );
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
  const errorCode = brokerFailureCode(error);
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
      return privateAppJson(
        {
          error: "execution_uncertain",
          approval: approvalProjection(finalized.request),
        },
        502,
      );
    }
    return finalized.request
      ? privateAppJson(
          {
            error: "approval_state_changed",
            approval: approvalProjection(finalized.request),
          },
          409,
        )
      : privateAppJson({ error: "not_found" }, 404);
  } catch {
    return privateAppJson({ error: "execution_finalization_unavailable" }, 502);
  }
}

function brokerFailureCode(
  error: unknown,
): "broker_unavailable" | "broker_response_unverified" {
  return error instanceof ApprovalBrokerError &&
      error.code === "approval_broker_unavailable"
    ? "broker_unavailable"
    : "broker_response_unverified";
}

/**
 * Runs one bounded first-dispatch recovery. A pending outbox has no recorded
 * broker call, while leased, uncertain, and terminal items remain untouched.
 */
export async function recoverPendingLeadTriageOutbox(env: AppEnv): Promise<void> {
  const tenantId = env.APP_TENANT_ID?.trim() ?? "";
  const config = approvalBrokerConfig(env);
  if (!/^[a-z0-9-]{2,64}$/.test(tenantId) || !config) return;

  const now = new Date();
  const claimed = await claimNextPendingGovernedTransitionOutbox(env, {
    tenantId,
    now: now.toISOString(),
    leaseExpiresAt: new Date(
      now.getTime() + config.executionLeaseSeconds * 1000,
    ).toISOString(),
  });
  if (claimed.kind !== "claimed") return;

  const request = await getApprovalRequest(
    env,
    tenantId,
    claimed.outbox.approval_request_id,
  );
  if (
    !request ||
    request.state !== "executing" ||
    request.decision_idempotency_key !== claimed.outbox.decision_idempotency_key
  ) {
    return;
  }

  let outcome;
  try {
    outcome = await executeLeadTriageApproval(env, request);
  } catch (error) {
    await finalizeApprovalExecution(env, {
      tenantId,
      requestId: request.approval_request_id,
      decisionIdempotencyKey: claimed.outbox.decision_idempotency_key,
      state: "execution_uncertain",
      hermesRunId: request.run_id,
      errorCode: brokerFailureCode(error),
      now: new Date().toISOString(),
    });
    return;
  }

  await finalizeApprovalExecution(env, {
    tenantId,
    requestId: request.approval_request_id,
    decisionIdempotencyKey: claimed.outbox.decision_idempotency_key,
    state: outcome.state,
    hermesRunId: outcome.hermesRunId,
    resultJson: outcome.resultJson,
    errorCode: outcome.errorCode,
    now: new Date().toISOString(),
  });
}

async function rejectLeadTriageApproval(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const identity = approvalDecisionIdentity(env, auth);
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const decisionIdempotencyKey = idempotencyKey(req);
  if (!decisionIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const decision = parseRejectionDecision(parsed.value);
  if (!decision)
    return privateAppJson({ error: "invalid_approval_decision" }, 400);
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
    if (denied.kind === "denied")
      return privateAppJson({ approval: approvalProjection(denied.request) });
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
  if (!identity.ok)
    return privateAppJson({ error: identity.error }, identity.status);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const reconciliation = parseReconciliation(parsed.value);
  if (!reconciliation)
    return privateAppJson({ error: "invalid_reconciliation" }, 400);
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
    if (result.kind === "reconciled")
      return privateAppJson({ approval: approvalProjection(result.request) });
    if (result.kind === "already_reconciled") {
      return privateAppJson({
        approval: approvalProjection(result.request),
        replayed: true,
      });
    }
    if (result.kind === "missing")
      return privateAppJson({ error: "not_found" }, 404);
    if (result.kind === "not_uncertain") {
      return privateAppJson(
        {
          error: "approval_not_uncertain",
          approval: approvalProjection(result.request),
        },
        409,
      );
    }
    return privateAppJson(
      {
        error: "approval_version_conflict",
        approval: approvalProjection(result.request),
      },
      409,
    );
  } catch {
    return privateAppJson({ error: "approval_store_unavailable" }, 502);
  }
}

function officeRole(auth: AuthContext): boolean {
  return auth.session.role === "owner" || auth.session.role === "ops";
}

function hasPermission(auth: AuthContext, permission: string): boolean {
  return auth.permissions.includes(permission);
}

function canReadJobs(auth: AuthContext): boolean {
  return hasPermission(auth, "jobs:read:any") ||
    hasPermission(auth, "jobs:read:assigned");
}

async function validateProductionSchedulePreparation(
  env: AppEnv,
  auth: AuthContext,
  input: NonNullable<ReturnType<typeof parseProductionScheduleApprovalPreparation>>,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  try {
    const runway = await buildProductionRunwayReadModel(env, auth);
    const job = runway.jobs.find((candidate) => candidate.id === input.roofJobId);
    if (
      !runway.allowed_actions.includes("production_schedule_approval.prepare") ||
      !job ||
      !job.scheduling_preparation_allowed
    ) {
      return {
        ok: false,
        error: "production_schedule_not_eligible",
        status: 409,
      };
    }
    if (!runway.crews.some((crew) => crew.id === input.crewProfileId)) {
      return {
        ok: false,
        error: "active_crew_profile_required",
        status: 409,
      };
    }
    if (job.assignment) {
      if (
        input.supersedesAssignmentId !== job.assignment.id ||
        input.correctionReason === null
      ) {
        return {
          ok: false,
          error: "production_schedule_supersede_required",
          status: 409,
        };
      }
    } else if (
      input.supersedesAssignmentId !== null ||
      input.correctionReason !== null
    ) {
      return {
        ok: false,
        error: "production_schedule_supersede_invalid",
        status: 409,
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "production_schedule_preparation_unavailable",
      status: 502,
    };
  }
}

function productionScheduleApprovalDecisionIdentity(
  env: AppEnv,
  auth: AuthContext,
):
  | {
      ok: true;
      config: NonNullable<
        ReturnType<typeof productionScheduleApprovalDecisionConfig>
      >;
      frappeUserId: string;
    }
  | { ok: false; error: string; status: number } {
  if (auth.session.role !== "owner")
    return { ok: false, error: "owner_role_required", status: 403 };
  const config = productionScheduleApprovalDecisionConfig(env);
  if (!config) {
    return {
      ok: false,
      error: "production_schedule_approver_not_configured",
      status: 503,
    };
  }
  const frappeUserId = auth.session.frappe_user_id?.trim() ?? "";
  if (!frappeUserId || frappeUserId !== config.approverId) {
    return { ok: false, error: "configured_approver_required", status: 403 };
  }
  if (!sessionIsRecentForProductionScheduleApproval(
    auth.session.session_created_at,
    config,
  )) {
    return { ok: false, error: "recent_session_required", status: 403 };
  }
  return { ok: true, config, frappeUserId };
}

function productionScheduleApprovalBrokerDecisionIdentity(
  env: AppEnv,
  auth: AuthContext,
):
  | {
      ok: true;
      decision: NonNullable<
        ReturnType<typeof productionScheduleApprovalDecisionConfig>
      >;
      broker: NonNullable<
        ReturnType<typeof productionScheduleApprovalBrokerConfig>
      >;
      frappeUserId: string;
    }
  | { ok: false; error: string; status: number } {
  const decision = productionScheduleApprovalDecisionIdentity(env, auth);
  if (!decision.ok) return decision;
  const broker = productionScheduleApprovalBrokerConfig(env);
  if (!broker) {
    return {
      ok: false,
      error: "production_schedule_broker_not_configured",
      status: 503,
    };
  }
  return { ok: true, decision: decision.config, broker, frappeUserId: decision.frappeUserId };
}

function quoteRevisionApprovalBrokerDecisionIdentity(
  env: AppEnv,
  auth: AuthContext,
):
  | {
      ok: true;
      config: NonNullable<ReturnType<typeof quoteRevisionApprovalBrokerConfig>>;
      frappeUserId: string;
    }
  | { ok: false; error: string; status: number } {
  const decision = approvalDecisionIdentity(env, auth);
  if (!decision.ok) return decision;
  const config = quoteRevisionApprovalBrokerConfig(env);
  if (!config)
    return {
      ok: false,
      error: "quote_revision_broker_not_configured",
      status: 503,
    };
  return { ok: true, config, frappeUserId: decision.frappeUserId };
}

function approvalDecisionIdentity(
  env: AppEnv,
  auth: AuthContext,
):
  | {
      ok: true;
      config: NonNullable<ReturnType<typeof approvalDecisionConfig>>;
      frappeUserId: string;
    }
  | { ok: false; error: string; status: number } {
  if (auth.session.role !== "owner")
    return { ok: false, error: "owner_role_required", status: 403 };
  const config = approvalDecisionConfig(env);
  if (!config)
    return {
      ok: false,
      error: "approval_approver_not_configured",
      status: 503,
    };
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
):
  | {
      ok: true;
      config: NonNullable<ReturnType<typeof approvalBrokerConfig>>;
      frappeUserId: string;
    }
  | { ok: false; error: string; status: number } {
  const decision = approvalDecisionIdentity(env, auth);
  if (!decision.ok) return decision;
  const config = approvalBrokerConfig(env);
  if (!config)
    return { ok: false, error: "approval_broker_not_configured", status: 503 };
  return { ok: true, config, frappeUserId: decision.frappeUserId };
}

function approvalDecisionResultResponse(
  result:
    | Exclude<
        Awaited<ReturnType<typeof claimApprovalExecution>>,
        { kind: "claimed" }
      >
    | Exclude<
        Awaited<ReturnType<typeof denyApprovalRequest>>,
        { kind: "denied" }
      >,
): Response {
  if (result.kind === "missing")
    return privateAppJson({ error: "not_found" }, 404);
  if (result.kind === "expired")
    return privateAppJson(
      {
        error: "approval_expired",
        approval: approvalProjection(result.request),
      },
      410,
    );
  if (result.kind === "version_conflict") {
    return privateAppJson(
      {
        error: "approval_version_conflict",
        approval: approvalProjection(result.request),
      },
      409,
    );
  }
  if (result.kind === "replayed") {
    const status = result.request.state === "executing" ? 202 : 200;
    return privateAppJson(
      { approval: approvalProjection(result.request), replayed: true },
      status,
    );
  }
  return privateAppJson(
    {
      error: "approval_already_decided",
      approval: approvalProjection(result.request),
    },
    409,
  );
}

function quoteRevisionDecisionResultResponse(
  result:
    | Exclude<
        Awaited<ReturnType<typeof claimQuoteRevisionApprovalExecution>>,
        { kind: "claimed" }
      >
    | Exclude<
        Awaited<ReturnType<typeof denyQuoteRevisionApprovalRequest>>,
        { kind: "denied" }
      >,
): Response {
  if (result.kind === "missing")
    return privateAppJson({ error: "not_found" }, 404);
  if (result.kind === "expired") {
    return privateAppJson(
      {
        error: "quote_revision_approval_expired",
        approval: quoteRevisionApprovalProjection(result.request),
      },
      410,
    );
  }
  if (result.kind === "version_conflict") {
    return privateAppJson(
      {
        error: "quote_revision_approval_version_conflict",
        approval: quoteRevisionApprovalProjection(result.request),
      },
      409,
    );
  }
  if (result.kind === "replayed") {
    const status = result.request.state === "executing" ? 202 : 200;
    return privateAppJson(
      {
        approval: quoteRevisionApprovalProjection(result.request),
        replayed: true,
      },
      status,
    );
  }
  return privateAppJson(
    {
      error: "quote_revision_approval_already_decided",
      approval: quoteRevisionApprovalProjection(result.request),
    },
    409,
  );
}

function proposalPublicationDecisionResultResponse(
  result:
    | Exclude<
        Awaited<ReturnType<typeof claimProposalPublicationApprovalExecution>>,
        { kind: "claimed" }
      >
    | Exclude<
        Awaited<ReturnType<typeof denyProposalPublicationApprovalRequest>>,
        { kind: "denied" }
      >,
): Response {
  if (result.kind === "missing")
    return privateAppJson({ error: "not_found" }, 404);
  if (result.kind === "expired") {
    return privateAppJson(
      {
        error: "proposal_publication_approval_expired",
        approval: proposalPublicationApprovalProjection(result.request),
      },
      410,
    );
  }
  if (result.kind === "version_conflict") {
    return privateAppJson(
      {
        error: "proposal_publication_approval_version_conflict",
        approval: proposalPublicationApprovalProjection(result.request),
      },
      409,
    );
  }
  if (result.kind === "replayed") {
    const status = result.request.state === "executing" ? 202 : 200;
    return privateAppJson(
      {
        approval: proposalPublicationApprovalProjection(result.request),
        replayed: true,
      },
      status,
    );
  }
  return privateAppJson(
    {
      error: "proposal_publication_approval_already_decided",
      approval: proposalPublicationApprovalProjection(result.request),
    },
    409,
  );
}

function productionScheduleDecisionResultResponse(
  result:
    | Exclude<
        Awaited<ReturnType<typeof claimProductionScheduleApprovalExecution>>,
        { kind: "claimed" }
      >
    | Exclude<
        Awaited<ReturnType<typeof denyProductionScheduleApprovalRequest>>,
        { kind: "denied" }
      >,
): Response {
  if (result.kind === "missing")
    return privateAppJson({ error: "not_found" }, 404);
  if (result.kind === "expired") {
    return privateAppJson(
      {
        error: "production_schedule_approval_expired",
        approval: productionScheduleApprovalProjection(result.request),
      },
      410,
    );
  }
  if (result.kind === "version_conflict") {
    return privateAppJson(
      {
        error: "production_schedule_approval_version_conflict",
        approval: productionScheduleApprovalProjection(result.request),
      },
      409,
    );
  }
  if (result.kind === "replayed") {
    const status = result.request.state === "executing" ? 202 : 200;
    return privateAppJson(
      {
        approval: productionScheduleApprovalProjection(result.request),
        replayed: true,
      },
      status,
    );
  }
  return privateAppJson(
    {
      error: "production_schedule_approval_already_decided",
      approval: productionScheduleApprovalProjection(result.request),
    },
    409,
  );
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

function quoteRevisionApprovalReadEnvelope(
  env: AppEnv,
  auth: AuthContext,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: 1,
    read_model_generated_at: new Date().toISOString(),
    permissions: auth.permissions,
    allowed_actions: quoteRevisionApprovalAllowedActions(env, auth),
    ...body,
  };
}

function proposalPublicationApprovalReadEnvelope(
  env: AppEnv,
  auth: AuthContext,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: 1,
    read_model_generated_at: new Date().toISOString(),
    permissions: auth.permissions,
    allowed_actions: proposalPublicationApprovalAllowedActions(env, auth),
    ...body,
  };
}

function productionScheduleApprovalReadEnvelope(
  env: AppEnv,
  auth: AuthContext,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: 1,
    read_model_generated_at: new Date().toISOString(),
    permissions: auth.permissions,
    allowed_actions: productionScheduleApprovalAllowedActions(env, auth),
    ...body,
  };
}

function approvalAllowedActions(env: AppEnv, auth: AuthContext): string[] {
  if (!hasPermission(auth, "approvals:read")) return [];
  const actions = ["approval.read"];
  const config = approvalBrokerConfig(env);
  if (
    hasPermission(auth, "approvals:prepare") &&
    config &&
    auth.session.frappe_user_id?.trim()
  )
    actions.push("approval.prepare");
  if (approvalDecisionIdentity(env, auth).ok) actions.push("approval.reject");
  if (approvalDecisionIdentity(env, auth).ok)
    actions.push("approval.reconcile");
  if (approvalBrokerDecisionIdentity(env, auth).ok)
    actions.push("approval.approve");
  return actions;
}

function quoteRevisionApprovalAllowedActions(
  env: AppEnv,
  auth: AuthContext,
): string[] {
  if (!hasPermission(auth, "approvals:read")) return [];
  const actions = ["quote_revision_approval.read"];
  const broker = quoteRevisionApprovalBrokerConfig(env);
  if (
    hasPermission(auth, "approvals:prepare") &&
    broker &&
    approvalDecisionConfig(env) &&
    auth.session.frappe_user_id?.trim()
  ) {
    actions.push("quote_revision_approval.prepare");
  }
  if (approvalDecisionIdentity(env, auth).ok)
    actions.push("quote_revision_approval.reject");
  if (approvalDecisionIdentity(env, auth).ok)
    actions.push("quote_revision_approval.reconcile");
  if (quoteRevisionApprovalBrokerDecisionIdentity(env, auth).ok)
    actions.push("quote_revision_approval.approve");
  return actions;
}

function proposalPublicationApprovalAllowedActions(
  env: AppEnv,
  auth: AuthContext,
): string[] {
  if (!hasPermission(auth, "approvals:read")) return [];
  if (!proposalPublicationEnabled(env)) return [];
  const actions = ["proposal_publication_approval.read"];
  const broker = proposalPublicationApprovalBrokerConfig(env);
  if (
    hasPermission(auth, "approvals:prepare") &&
    broker &&
    approvalDecisionConfig(env) &&
    auth.session.frappe_user_id?.trim()
  ) {
    actions.push("proposal_publication_approval.prepare");
  }
  if (approvalDecisionIdentity(env, auth).ok)
    actions.push("proposal_publication_approval.reject");
  if (approvalDecisionIdentity(env, auth).ok)
    actions.push("proposal_publication_approval.reconcile");
  if (proposalPublicationApprovalBrokerDecisionIdentity(env, auth).ok)
    actions.push("proposal_publication_approval.approve");
  return actions;
}

function productionScheduleApprovalAllowedActions(
  env: AppEnv,
  auth: AuthContext,
): string[] {
  if (auth.session.role !== "owner") return [];
  const actions = ["production_schedule_approval.read"];
  if (productionScheduleApprovalDecisionIdentity(env, auth).ok) {
    actions.push(
      "production_schedule_approval.reject",
      "production_schedule_approval.reconcile",
    );
  }
  if (productionScheduleApprovalBrokerDecisionIdentity(env, auth).ok) {
    actions.push(
      "production_schedule_approval.prepare",
      "production_schedule_approval.approve",
    );
  }
  return actions;
}

function parseLeadTriagePreparation(value: unknown): {
  leadEnvelopeId: string;
  triageSummary: string;
} | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["lead_envelope_id", "triage_summary"])
  )
    return null;
  const leadEnvelopeId = idText(value.lead_envelope_id, 1, 140);
  const triageSummary = boundedText(value.triage_summary, 1, 2_000);
  return leadEnvelopeId && triageSummary
    ? { leadEnvelopeId, triageSummary }
    : null;
}

function leadTriageRequestText(triageSummary: string): string {
  return `Record local lead triage after human review. Summary: ${triageSummary}`;
}

function parseQuoteRevisionApprovalPreparation(value: unknown): {
  roofJobId: string;
  customerQuoteId: string;
  correctionReason: string;
} | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["roof_job_id", "customer_quote_id", "correction_reason"])
  )
    return null;
  const roofJobId = idText(value.roof_job_id, 1, 140);
  const customerQuoteId = idText(value.customer_quote_id, 1, 140);
  const correctionReason = boundedText(value.correction_reason, 1, 2_000);
  return roofJobId && customerQuoteId && correctionReason
    ? { roofJobId, customerQuoteId, correctionReason }
    : null;
}

function quoteRevisionRequestText(correctionReason: string): string {
  return `Prepare an append-only Draft Customer Quote revision shell after human review. Reason: ${correctionReason}`;
}

function parseProposalPublicationApprovalPreparation(value: unknown): {
  roofJobId: string;
  proposalEvidencePackId: string;
} | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["roof_job_id", "proposal_evidence_pack_id"])
  )
    return null;
  const roofJobId = idText(value.roof_job_id, 1, 140);
  const proposalEvidencePackId = idText(value.proposal_evidence_pack_id, 1, 140);
  return roofJobId && proposalEvidencePackId
    ? { roofJobId, proposalEvidencePackId }
    : null;
}

function proposalPublicationRequestText(proposalEvidencePackId: string): string {
  return `Publish the reviewed Draft Proposal Evidence Pack ${proposalEvidencePackId} to the private customer portal. No customer message, portal link, signature, or quote change.`;
}

function parseProductionScheduleApprovalPreparation(value: unknown): {
  roofJobId: string;
  crewProfileId: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  supersedesAssignmentId: string | null;
  correctionReason: string | null;
} | null {
  const requiredKeys = [
    "roof_job_id",
    "crew_profile_id",
    "scheduled_start",
    "scheduled_end",
    "supersedes_assignment_id",
    "correction_reason",
  ];
  if (
    !isRecord(value) ||
    !onlyKeys(value, requiredKeys) ||
    !requiredKeys.every((key) => Object.hasOwn(value, key))
  ) {
    return null;
  }
  const roofJobId = idText(value.roof_job_id, 1, 140);
  const crewProfileId = idText(value.crew_profile_id, 1, 140);
  const scheduledStart = normalizedIso(value.scheduled_start);
  const scheduledEnd =
    value.scheduled_end === null ? null : normalizedIso(value.scheduled_end);
  const supersedesAssignmentId =
    value.supersedes_assignment_id === null
      ? null
      : idText(value.supersedes_assignment_id, 1, 140);
  const correctionReason =
    value.correction_reason === null
      ? null
      : boundedText(value.correction_reason, 1, 2_000);
  if (
    !roofJobId ||
    !crewProfileId ||
    !scheduledStart ||
    (value.scheduled_end !== null && !scheduledEnd) ||
    (value.supersedes_assignment_id !== null && !supersedesAssignmentId) ||
    (value.correction_reason !== null && !correctionReason) ||
    (scheduledEnd !== null && Date.parse(scheduledEnd) <= Date.parse(scheduledStart)) ||
    (supersedesAssignmentId === null) !== (correctionReason === null)
  ) {
    return null;
  }
  return {
    roofJobId,
    crewProfileId,
    scheduledStart,
    scheduledEnd,
    supersedesAssignmentId,
    correctionReason,
  };
}

function productionScheduleRequestText(
  input: NonNullable<ReturnType<typeof parseProductionScheduleApprovalPreparation>>,
): string {
  const timing = input.scheduledEnd
    ? `${input.scheduledStart} to ${input.scheduledEnd}`
    : `starting ${input.scheduledStart}`;
  return input.supersedesAssignmentId
    ? `Prepare an append-only Production Job Assignment correction for ${input.crewProfileId} ${timing}. Reason: ${input.correctionReason}`
    : `Prepare an append-only Production Job Assignment for ${input.crewProfileId} ${timing}.`;
}

function parseExpectedVersion(value: unknown): number | null {
  if (!isRecord(value) || !onlyKeys(value, ["version"])) return null;
  return validVersion(value.version);
}

function parseRejectionDecision(
  value: unknown,
): { version: number; reason: string } | null {
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
  if (!isRecord(value) || !onlyKeys(value, ["version", "outcome", "evidence"]))
    return null;
  const version = validVersion(value.version);
  const outcome =
    value.outcome === "executed" ||
    value.outcome === "not_executed" ||
    value.outcome === "inconclusive"
      ? value.outcome
      : null;
  const evidence = boundedText(value.evidence, 3, 1_000);
  return version && outcome && evidence ? { version, outcome, evidence } : null;
}

function validVersion(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 2_147_483_647
    ? value
    : null;
}

function idempotencyKey(req: Request): string | null {
  const value = req.headers.get("idempotency-key")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{8,140}$/.test(value) ? value : null;
}

function postizIdempotencyKey(req: Request): string | null {
  const value = req.headers.get("idempotency-key")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{16,160}$/.test(value) ? value : null;
}

function quickBooksIdempotencyKey(req: Request): string | null {
  const value = req.headers.get("idempotency-key")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{16,160}$/.test(value) ? value : null;
}

function quickBooksConnectBody(value: unknown): "/accounting/quickbooks" | null {
  return isRecord(value) && Object.keys(value).length === 1 &&
      value.return_path === "/accounting/quickbooks"
    ? value.return_path
    : null;
}

function quickBooksVersionBody(value: unknown): number | null {
  if (!isRecord(value) || !onlyKeys(value, ["version"]) || Object.keys(value).length !== 1)
    return null;
  return validVersion(value.version);
}

function quickBooksExpectedVersionBody(value: unknown): number | null {
  return quickBooksVersionBody(value);
}

function quickBooksRejectBody(value: unknown): {
  version: number;
  reasonCode: QuickBooksRejectionReason;
} | null {
  if (!isRecord(value) || !onlyKeys(value, ["version", "reason_code"]) ||
      Object.keys(value).length !== 2) return null;
  const version = validVersion(value.version);
  const reasonCode = (QUICKBOOKS_REJECTION_REASONS as readonly unknown[]).includes(value.reason_code)
    ? value.reason_code as QuickBooksRejectionReason
    : null;
  return version && reasonCode ? { version, reasonCode } : null;
}

function decodedQuickBooksIntentId(value: string): string | null {
  const decoded = decodedPathSegment(value);
  return decoded && validQuickBooksIntentId(decoded) ? decoded : null;
}

function postizProviderBody(value: unknown): PostizProvider | null {
  if (!isRecord(value) || !onlyKeys(value, ["provider"])) return null;
  return (POSTIZ_PROVIDERS as readonly unknown[]).includes(value.provider)
    ? value.provider as PostizProvider
    : null;
}

function postizExpectedVersionBody(value: unknown): number | null {
  if (!isRecord(value) || !onlyKeys(value, ["expected_version"])) return null;
  return validVersion(value.expected_version);
}

function decodedPostizIntentId(value: string): string | null {
  const decoded = decodedPathSegment(value);
  return decoded &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(decoded)
    ? decoded
    : null;
}

function decodedApprovalRequestId(value: string): string | null {
  const decoded = decodedPathSegment(value);
  return decoded && /^approval:[A-Za-z0-9_-]{16,64}$/.test(decoded)
    ? decoded
    : null;
}

function decodedQuoteRevisionApprovalId(value: string): string | null {
  const decoded = decodedPathSegment(value);
  return decoded &&
    /^quote-revision-approval:[A-Za-z0-9_-]{16,64}$/.test(decoded)
    ? decoded
    : null;
}

function decodedProposalPublicationApprovalId(value: string): string | null {
  const decoded = decodedPathSegment(value);
  return decoded &&
    /^proposal-publication-approval:[A-Za-z0-9_-]{16,64}$/.test(decoded)
    ? decoded
    : null;
}

function decodedProductionScheduleApprovalId(value: string): string | null {
  const decoded = decodedPathSegment(value);
  return decoded &&
    /^production-schedule-approval:[A-Za-z0-9_-]{16,64}$/.test(decoded)
    ? decoded
    : null;
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
  return typeof value === "string" &&
    new RegExp(`^[A-Za-z0-9._:-]{${min},${max}}$`).test(value)
    ? value
    : null;
}

function normalizedIso(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 80)
    return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function boundedText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= min && text.length <= max ? text : null;
}

function brokerPrepareError(error: unknown): string {
  if (
    error instanceof ApprovalBrokerError &&
    error.code === "approval_broker_not_configured"
  )
    return error.code;
  return "approval_broker_unavailable";
}

function brokerPrepareStatus(error: unknown): number {
  return error instanceof ApprovalBrokerError &&
    error.code === "approval_broker_not_configured"
    ? 503
    : 502;
}

function quoteRevisionBrokerPrepareError(error: unknown): string {
  if (
    error instanceof QuoteRevisionApprovalBrokerError &&
    error.code === "quote_revision_broker_not_configured"
  ) {
    return error.code;
  }
  return "quote_revision_broker_unavailable";
}

function quoteRevisionBrokerPrepareStatus(error: unknown): number {
  return error instanceof QuoteRevisionApprovalBrokerError &&
    error.code === "quote_revision_broker_not_configured"
    ? 503
    : 502;
}

function proposalPublicationEnabled(env: AppEnv): boolean {
  return String(env.APP_PROPOSAL_PUBLICATION_ENABLED) === "true";
}

function proposalPublicationApprovalBrokerDecisionIdentity(
  env: AppEnv,
  auth: AuthContext,
):
  | {
      ok: true;
      config: NonNullable<
        ReturnType<typeof proposalPublicationApprovalBrokerConfig>
      >;
      frappeUserId: string;
    }
  | { ok: false; error: string; status: number } {
  const decision = approvalDecisionIdentity(env, auth);
  if (!decision.ok) return decision;
  const config = proposalPublicationApprovalBrokerConfig(env);
  if (!config)
    return {
      ok: false,
      error: "proposal_publication_broker_not_configured",
      status: 503,
    };
  return { ok: true, config, frappeUserId: decision.frappeUserId };
}

function proposalPublicationBrokerPrepareError(error: unknown): string {
  if (
    error instanceof ProposalPublicationApprovalBrokerError &&
    error.code === "proposal_publication_broker_not_configured"
  ) {
    return error.code;
  }
  return "proposal_publication_broker_unavailable";
}

function proposalPublicationBrokerPrepareStatus(error: unknown): number {
  return error instanceof ProposalPublicationApprovalBrokerError &&
    error.code === "proposal_publication_broker_not_configured"
    ? 503
    : 502;
}

function productionScheduleBrokerPrepareError(error: unknown): string {
  if (
    error instanceof ProductionScheduleApprovalBrokerError &&
    error.code === "production_schedule_broker_not_configured"
  ) {
    return error.code;
  }
  return "production_schedule_broker_unavailable";
}

function productionScheduleBrokerPrepareStatus(error: unknown): number {
  return error instanceof ProductionScheduleApprovalBrokerError &&
    error.code === "production_schedule_broker_not_configured"
    ? 503
    : 502;
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

function decodeWorkObjectScope(
  match: RegExpMatchArray,
): WorkObjectScope | null {
  const values = match.slice(1, 5).map((value) => decodedPathSegment(value));
  if (values.some((value): value is null => value === null)) return null;
  const [workObjectType, workObjectId, physicalContextType, physicalContextId] =
    values as [string, string, string, string];
  if (
    !workObjectType ||
    !workObjectId ||
    !physicalContextType ||
    !physicalContextId
  ) {
    return null;
  }
  return {
    workObjectType,
    workObjectId,
    physicalContextType,
    physicalContextId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readJson(
  req: Request,
  maxBytes: number,
): Promise<
  { ok: true; value: unknown } | { ok: false; error: string; status: number }
> {
  if (Number(req.headers.get("content-length") ?? "0") > maxBytes) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  const text = await req.text();
  if (text.length > maxBytes)
    return { ok: false, error: "payload_too_large", status: 413 };
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

/**
 * An inactive private-app rail must not advertise its existence or configuration to an
 * unauthenticated public host. Operators retain the detailed, authenticated readiness map.
 */
function unavailableAppRoute(): Response {
  const response = appJson({ error: "not_found" }, 404);
  response.headers.set("cache-control", "no-store");
  return response;
}

function privateAppJson(body: unknown, status = 200): Response {
  const response = appJson(body, status);
  response.headers.set("cache-control", "private, no-store");
  return response;
}
