import { handlePricingCatalog } from "./pricing-catalog-api.ts";
import { PricingCatalogError } from "./pricing-catalog.ts";
import { handleJobMeasurementReports } from "./job-measurement-report-api.ts";
import { handleMeasurementReportPrivacyAudit } from "./job-measurement-report-privacy.ts";
import { handleMeasurementIntakePrivacyAudit } from "./measurement-intake-privacy.ts";
import { handleAgentTeamAppRoute } from "./agents/api.ts";
import { handleJobManualMeasurements } from "./job-manual-measurement-api.ts";
import { handleFieldItemResolutions } from "./field-item-resolutions.ts";
import { OFFICE_LEAD_REQUEST_ID, OfficeIntakeError, parseOfficeCapture, recordOfficeIntake, readOfficeIntakeReceipt, readOfficeLeadFacts, resumeOfficeIntake } from "./office-lead-intake-store.ts";
import { handleAccountingRoute, type AccountingRouteDeps } from "./accounting-api.ts";
import { handlePipelineRoute } from "./pipeline-board-api.ts";
import { buildCapabilitySignalReadModel } from "./capability-signal-api.ts";
import {
  admitCapabilityManifest,
  admitCapabilityProfile,
} from "./capability-admission.ts";
import {
  ingestLead,
  officeLeadPayload,
  parseOfficeLead,
} from "./lead-intake.ts";
import * as appAuthStore from "./app-auth-store.ts";
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
  type AppAuthRefusal,
} from "./app-auth.ts";
import {
  acceptUserInvite,
  authorizeAppUserMutation,
  changeAppUserAccess,
  changeAppUserRole,
  createUserInvite,
  listAppUsersForOffice,
  listUserInvitesForOffice,
  resendUserInviteForOffice,
  revokeUserInviteForOffice,
} from "./app-user-invites.ts";
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
import { buildCustomerJobHistoryReadModel } from "./customer-job-history.ts";
import {
  activeAssignmentForJob,
  activeAssignmentForWorkObject,
  buildEstimatorWorkbenchReadModel,
  buildJobFieldMeasurementPageReadModel,
  buildJobProofReadModel,
  buildJobHistoryReadModel,
  buildJobReadModel,
  buildOwnerNowReadModel,
  buildProductionRunwayReadModel,
  buildSalesReadModel,
  buildTodayReadModel,
  buildUniversalWorkPackageReadModel,
  fleetAssetForFieldActor,
} from "./app-read-models.ts";
import { parseFieldMeasurementCursor } from "./field-measurements.ts";
import {
  importEstimatorEvidenceFromNativeSources,
  type ImportEstimatorEvidenceInput,
} from "./estimator-native.ts";
import { EstimatorNativeStoreError } from "./estimator-native-store.ts";
import { buildNowReadModel } from "./now-read-model.ts";
import { parseDecisionPageRequest } from "./decision-read-model.ts";
import {
  SEARCH_MAX_RAW_QUERY_LENGTH,
  buildOperatorSearchReadModel,
} from "./app-search.ts";
import { buildOperatingIntakeReadModel } from "./operating-intake.ts";
import { handleCompanySetupRoute } from "./company-setup-api.ts";
import { handleSchemaFormsRoute } from "./schema-forms-api.ts";
import { handleAutomationRecipientRoute } from "./automation-recipients-api.ts";
import { handleCustomerPortalLinks } from "./customer-portal.ts";
import { handleServiceCaseRoute } from "./service-cases.ts";
import {
  APP_API_VERSION,
  appUserIdentities,
  type AppEnv,
  type AppRole,
  type AuthContext,
  type WorkObjectScope,
} from "./app-types.ts";
import {
  claimFieldUploadWindow,
  handleFieldAction,
  r2ObjectStore,
} from "./field-actions.ts";
import { type FrappeRow } from "./frappe-read.ts";
import { handleFleetAction, type FleetActionKind } from "./fleet-actions.ts";
import {
  handleFleetCollisionCollection,
  handleFleetCollisionTransition,
} from "./fleet-collision-api.ts";
import { handleFleetPhotoUpload } from "./fleet-photo-evidence.ts";
import { buildFleetPanelReadModel } from "./fleet-panel.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import {
  handleWorkPackageAction,
  replayVerifiedWorkPackageAction,
  type WorkPackageActionKind,
} from "./work-package-actions.ts";
import {
  fieldWorkPackageForAssignment,
  hasPhysicalAssignmentAuthority,
} from "./work-package.ts";
import {
  getNativeWorkPackageVersionHead,
  issueNativeWorkPackage,
  replayNativeWorkPackageIssue,
  releaseNativeWorkPackageHold,
  reviewNativeWorkPackageEvidence,
  type NativeWorkPackageHoldPoint,
  type NativeWorkPackageStep,
  type NativeWorkPackageWorker,
} from "./work-package-store.ts";
import { parseAuthorityRequirements } from "./authority-records.ts";
import { handleAuthorityRecordRoute } from "./authority-record-api.ts";
import { handleSafetyRoute } from "./safety-api.ts";
import { handleInventoryRoute } from "./inventory-control-api.ts";
import { handleWorkPackageStopReleaseRoute } from "./work-package-stop-release.ts";
import { handleCrewRosterRoute } from "./crew-roster.ts";
import { handleEvidenceContentRead, handleEvidenceUpload } from "./evidence-uploads.ts";
import { handlePrivacyEvidenceAuditRoute } from "./privacy-evidence-audit.ts";
import { handlePrivacyEvidenceDispositionRoute } from "./privacy-evidence-disposition.ts";
import { handleProposalDocAction } from "./proposal-doc-action.ts";
import { handleProductionGateClearance } from "./production-gate-clearance.ts";
import {
  listMeasurementIntakeExceptions,
  projectMeasurementIntakeOwnerException,
} from "./measurement-intake-store.ts";
import { handleNewoHandoffResolutionRoute } from "./newo-handoff-resolution.ts";
import { buildNewoOperationsReadModel } from "./newo-operations-read-model.ts";
import { buildOwnerRuntimeReadModel } from "./operations.ts";
import {
  READINESS_PROFILE_KEYS,
  buildCapabilityReadinessReadModel,
  type ReadinessProfileKey,
} from "./capability-readiness.ts";
import {
  listFacetV2IntakeExceptions,
  listFacetV2WorkflowEvidence,
} from "./facet-v2-evidence.ts";
import { issueFacetLaunch } from "./facet-launch.ts";
import {
  issueFacetPrequoteLaunch,
  promoteFacetEstimatorReady,
  FacetPrequoteError,
} from "./facet-prequote.ts";
import {
  parseFacetLinkRevocationBody,
  revokeFacetLink,
} from "./facet-link-revocation.ts";
import {
  admitCommercialPermit,
  commercialCommandFingerprint,
  CommercialAuthorityError,
  getCommercialPermit,
} from "./commercial-authority.ts";
import {
  buildLeadTriageCommand,
  CommercialStoreError,
  buildCommercialPublicationCommand,
  prepareCommercialQuote,
  recordCommercialProposalPublication,
  recordCommercialQuoteRevision,
  prepareCommercialProposal,
  recordLeadTriageDecision,
  type CommercialQuoteLineInput,
  type CommercialPublicationState,
  type CommercialPublicationRecord,
  type CommercialQuoteRecord,
  type CommercialQuoteStatus,
  type RecordCommercialPublicationInput,
  type RecordCommercialQuoteInput,
  recordCommercialProposalRevision,
  type CommercialLeadTriageRecord,
  type CommercialProposalRecord,
  unconfirmedProposalDelivery,
} from "./commercial-store.ts";
import {
  beginCommercialDepositDerivationRequest,
  ensureCommercialDepositDerivation,
  finishCommercialDepositDerivationRequest,
  readCommercialDepositDerivation,
  readCommercialDepositDerivationEvent,
  type CommercialDepositDerivationRecord,
} from "./commercial-deposit.ts";
import { readAccountingIntent } from "./accounting-intents.ts";
import { readCommercialJobPhase } from "./commercial-job-phase.ts";
import { readCommercialContext } from "./commercial-context.ts";
import {
  OperatingJobAssignmentError,
  recordOperatingJobAssignment,
} from "./operating-job-assignment-store.ts";
import {
  OperatingWorkObjectAssignmentError,
  recordOperatingWorkObjectAssignment,
} from "./operating-work-object-assignment-store.ts";
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
  recordNativeInitialProviderMapping,
  rejectQuickBooksFinalInvoice,
  removeQuickBooksFromIronWrap,
  requestQuickBooksConnect,
  requestQuickBooksFinalInvoiceReconciliation,
  validQuickBooksIntentId,
  type QuickBooksRejectionReason,
} from "./quickbooks-final-invoice.ts";

const MAX_ADMIN_BODY_BYTES = 8 * 1024;
const MAX_COMMERCIAL_BODY_BYTES = 64 * 1024;

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
  // Every method that can change state, not just POST. While POST was the only
  // mutation this router accepted the distinction was invisible; the moment a `PUT`
  // route exists, treating it as a read would let a request with no `Origin` header
  // skip origin validation entirely.
  const mutation = req.method === "POST" || req.method === "PUT" ||
    req.method === "PATCH" || req.method === "DELETE";
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
  } else if (
    req.method === "POST" &&
    url.pathname === "/api/v1/auth/invites/accept"
  ) {
    // Unauthenticated by construction, exactly like the two consume routes above it: the
    // one-time secret in the invitation is the authority. It produces a grant, not a session.
    const accepted = await acceptUserInvite(req, appEnv, ctx);
    response = accepted.ok
      ? privateAppJson({ version: APP_API_VERSION, ...accepted.body })
      : privateAppJson({ error: accepted.error }, accepted.status);
  } else {
    const outcome = await authenticateAppRequest(req, appEnv);
    if (!outcome.ok) {
      response = unauthenticatedAppResponse(req, url, appEnv, outcome.refusal);
    } else {
      response = await handleAuthenticatedRoute(req, appEnv, outcome.auth, { ctx });
    }
  }
  return withCors(response, origin.origin);
}

/**
 * The response for a request that could not be authenticated.
 *
 * The session cookie is expired for exactly ONE reason: the cookie names nothing live, so the
 * browser is holding something dead. A live field session that did not carry its device proof
 * keeps its cookie and gets a plain refusal - expiring it made a single proofless call from a
 * field surface look identical to a sign-out, and the PWA then dropped the device secret and
 * demanded re-pairing on the next cold load (ELEC-167 item 18).
 *
 * `/session` and `/field/bootstrap` answer 200 with the unauthenticated payload so a signed-out
 * browser can paint its sign-in screen. That friendly payload is exactly what a proofless field
 * request must NOT get: reading `authenticated: false` is itself what clears the device secret,
 * so a proof failure is a refusal on every path.
 */
function unauthenticatedAppResponse(
  req: Request,
  url: URL,
  appEnv: AppEnv,
  refusal: AppAuthRefusal,
): Response {
  if (refusal === "device_proof_required")
    return privateAppJson({ error: "device_proof_required" }, 401);
  let response: Response;
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
  } else {
    response = privateAppJson({ error: "unauthorized" }, 401);
  }
  response.headers.set("set-cookie", expiredSessionCookie());
  return response;
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
  const target = await appAuthStore.findAppUserByEmail(
    appEnv,
    validated.value.tenant_id,
    validated.value.email_normalized,
  );
  const authority = authorizeAppUserMutation(auth, target, validated.value.role);
  if (authority) return appJson({ error: authority.error }, authority.status);
  const user = await provisionAppUser(appEnv, {
    ...validated.value,
    provisioned_by: auth.session.email_normalized,
  }, req, {
    actorUserId: auth.session.user_id,
    actorRole: auth.session.role,
    expectedTarget: target,
  });
  if (!user) return appJson({ error: "app_user_state_changed" }, 409);
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
 * Taking a lead by hand (ELEC-158 B1 and ELEC-157 deferred item 9). It travels the same envelope,
 * dedup, audit and native-materialization path as `POST /ingest/<source>`; the only difference is
 * that a person's session authorizes it instead of the deployment's ingest secret.
 */
async function handleOfficeLeadCreate(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  if (!hasPermission(auth, "sales:lead_create"))
    return privateAppJson({ error: "sales_lead_create_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const parsed = await readJson(req, MAX_COMMERCIAL_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  // Explicit opt-in preserves the response and input contract of installed legacy clients.
  const includeReceipt = new URL(req.url).searchParams.get("include_receipt");
  if (includeReceipt !== null && includeReceipt !== "1") return privateAppJson({ error: "invalid_include_receipt" }, 400);
  if (includeReceipt === "1") {
    const capture = parseOfficeCapture(parsed.value);
    if (!capture.ok) return privateAppJson({ error: capture.error }, 400);
    try {
      return privateAppJson(await recordOfficeIntake(env, { tenantId: auth.session.tenant_id,
        userId: auth.session.user_id, email: auth.session.email_normalized }, req.headers.get("Idempotency-Key") ?? "", capture.value));
    } catch (error) {
      return error instanceof OfficeIntakeError
        ? privateAppJson({ error: error.code }, error.status)
        : privateAppJson({ error: "office_intake_unavailable" }, 503);
    }
  }
  const validated = parseOfficeLead(parsed.value);
  if (!validated.ok) return privateAppJson({ error: validated.error }, 400);

  const pending: Promise<unknown>[] = [];
  const result = await ingestLead(
    env,
    { waitUntil: (promise) => (ctx ? ctx.waitUntil(promise) : pending.push(promise)) },
    {
      source: "manual",
      rawText: JSON.stringify(
        officeLeadPayload(validated.value, auth.session.email_normalized),
      ),
      contentType: "application/json",
    },
  );
  // Without an execution context (unit tests, and any future caller that has none) the
  // acknowledgement is awaited rather than abandoned. It never fails the write: the lead is
  // already the system of record by this point.
  await Promise.allSettled(pending);
  return result.ok
    ? privateAppJson({ version: APP_API_VERSION, lead: result.body })
    : privateAppJson({ error: result.error }, result.status);
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
  quickBooksFetcher?: typeof fetch;
  /**
   * The request's execution context. Office lead intake needs `waitUntil` for the instant
   * acknowledgement, exactly as the bearer-token ingest route does; without one it degrades to
   * awaiting the ack inline rather than dropping it.
   */
  ctx?: Pick<ExecutionContext, "waitUntil">;
}

export async function handleAuthenticatedRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  deps: AppRouteDeps = {},
): Promise<Response> {
  const url = new URL(req.url);
  // Retired rail, not a stub over a working one. The scheduling write moved to the native
  // `POST /api/v1/jobs/{job}/schedule` in the IRO-195 D1 cutover (#132) and this whole family
  // has answered 404 ever since. Its handlers used to live 350 lines below, unreachable behind
  // this refusal and readable as if they still served traffic; ELEC-167 deleted them, so a
  // reader now sees only the refusal that is actually the behaviour.
  if (
    url.pathname === "/api/v1/production-schedule-approvals" ||
    url.pathname.startsWith("/api/v1/production-schedule-approvals/")
  ) {
    return privateAppJson({ error: "not_found" }, 404);
  }
  if (url.pathname.startsWith("/api/v1/agent-team/")) {
    return await handleAgentTeamAppRoute(req, env, auth);
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/hermes/desktop-pairings"
  ) {
    return await handleHermesDesktopPairingIssue(req, env, auth);
  }
  if (url.pathname === "/api/v1/admin/app-users") {
    if (req.method === "POST") {
      return await handleAdminAppUserProvision(req, env, auth);
    }
    if (req.method === "GET") {
      const listed = await listAppUsersForOffice(env, auth);
      return listed.ok
        ? privateAppJson(listed.body)
        : privateAppJson({ error: listed.error }, listed.status);
    }
    return privateAppJson({ error: "not_found" }, 404);
  }
  const appUserRoleMatch = url.pathname.match(
    /^\/api\/v1\/admin\/app-users\/([^/]+)\/role$/,
  );
  if (req.method === "POST" && appUserRoleMatch) {
    const userId = decodedPathSegment(appUserRoleMatch[1]);
    if (!userId) return privateAppJson({ error: "user_not_found" }, 404);
    const changed = await changeAppUserRole(req, env, auth, userId);
    return changed.ok
      ? privateAppJson(changed.body)
      : privateAppJson({ error: changed.error }, changed.status);
  }
  const appUserAccessMatch = url.pathname.match(
    /^\/api\/v1\/admin\/app-users\/([^/]+)\/access$/,
  );
  if (req.method === "POST" && appUserAccessMatch) {
    const userId = decodedPathSegment(appUserAccessMatch[1]);
    if (!userId) return privateAppJson({ error: "user_not_found" }, 404);
    const changed = await changeAppUserAccess(req, env, auth, userId);
    return changed.ok
      ? privateAppJson(changed.body)
      : privateAppJson({ error: changed.error }, changed.status);
  }
  if (url.pathname === "/api/v1/admin/user-invites") {
    if (req.method === "GET") {
      const listed = await listUserInvitesForOffice(env, auth);
      return listed.ok
        ? privateAppJson(listed.body)
        : privateAppJson({ error: listed.error }, listed.status);
    }
    if (req.method === "POST") {
      const created = await createUserInvite(req, env, auth);
      return created.ok
        ? privateAppJson(created.body, created.status)
        : privateAppJson({ error: created.error }, created.status);
    }
    return privateAppJson({ error: "not_found" }, 404);
  }
  const inviteResendMatch = url.pathname.match(
    /^\/api\/v1\/admin\/user-invites\/([^/]+)\/resend$/,
  );
  if (req.method === "POST" && inviteResendMatch) {
    const inviteId = decodedPathSegment(inviteResendMatch[1]);
    if (!inviteId) return privateAppJson({ error: "invite_not_found" }, 404);
    const resent = await resendUserInviteForOffice(req, env, auth, inviteId);
    return resent.ok
      ? privateAppJson(resent.body)
      : privateAppJson({ error: resent.error }, resent.status);
  }
  const inviteRevokeMatch = url.pathname.match(
    /^\/api\/v1\/admin\/user-invites\/([^/]+)\/revoke$/,
  );
  if (req.method === "POST" && inviteRevokeMatch) {
    const inviteId = decodedPathSegment(inviteRevokeMatch[1]);
    if (!inviteId) return privateAppJson({ error: "invite_not_found" }, 404);
    const revoked = await revokeUserInviteForOffice(req, env, auth, inviteId);
    return revoked.ok
      ? privateAppJson(revoked.body)
      : privateAppJson({ error: revoked.error }, revoked.status);
  }
  if (url.pathname.startsWith("/api/v1/privacy/measurement-reports")) {
    const audit = await handleMeasurementReportPrivacyAudit(req, env, auth);
    if (audit) return audit;
  }
  if (url.pathname.startsWith("/api/v1/privacy/measurement-intakes")) {
    const audit = await handleMeasurementIntakePrivacyAudit(req, env, auth);
    if (audit) return audit;
  }
  const pricingCatalogMatch = url.pathname.match(/^\/api\/v1\/pricing\/catalog(?:\/(revisions|activations))?$/);
  if (pricingCatalogMatch) return handlePricingCatalog(req, env, auth, pricingCatalogMatch[1]);
  const reportMatch = url.pathname.match(/^\/api\/v1\/estimator\/jobs\/([^/]+)\/measurement-reports(?:\/([^/]+)(?:\/(bytes|resume|candidate-sets|reviews))?)?$/);
  if (reportMatch) return handleJobMeasurementReports(req, env, auth, reportMatch[1], reportMatch[2], reportMatch[3]);
  const manualMeasurementMatch = url.pathname.match(/^\/api\/v1\/estimator\/jobs\/([^/]+)\/manual-measurements$/);
  if (manualMeasurementMatch) return handleJobManualMeasurements(req, env, auth, manualMeasurementMatch[1]);
  if (req.method === "POST" && url.pathname === "/api/v1/sales/leads") {
    return await handleOfficeLeadCreate(req, env, auth, deps.ctx);
  }
  const intakeResumeMatch = url.pathname.match(/^\/api\/v1\/sales\/intakes\/([^/]+)\/resume$/);
  if (req.method === "POST" && intakeResumeMatch) {
    if (!hasPermission(auth, "sales:read") || !hasPermission(auth, "sales:lead_create"))
      return privateAppJson({ error: "office_role_required" }, 403);
    if (!validAppCsrf(req, auth)) return privateAppJson({ error: "csrf_failed" }, 403);
    const requestId = decodedPathSegment(intakeResumeMatch[1]);
    if (!requestId || !OFFICE_LEAD_REQUEST_ID.test(requestId)) return privateAppJson({ error: "intake_not_found" }, 404);
    const body = await readJson(req, 1024);
    if (!body.ok) return privateAppJson({ error: body.error }, body.status);
    if (!isRecord(body.value) || Object.keys(body.value).length !== 0)
      return privateAppJson({ error: "invalid_intake_resume" }, 400);
    try {
      return privateAppJson(await resumeOfficeIntake(env, { tenantId: auth.session.tenant_id,
        userId: auth.session.user_id, email: auth.session.email_normalized }, requestId));
    } catch (error) {
      return error instanceof OfficeIntakeError ? privateAppJson({ error: error.code }, error.status)
        : privateAppJson({ error: "office_intake_unavailable" }, 503);
    }
  }
  const intakeReceiptMatch = url.pathname.match(/^\/api\/v1\/sales\/intakes\/([^/]+)$/);
  if (req.method === "GET" && intakeReceiptMatch) {
    if (!hasPermission(auth, "sales:read") || !hasPermission(auth, "sales:lead_create"))
      return privateAppJson({ error: "office_role_required" }, 403);
    const requestId = decodedPathSegment(intakeReceiptMatch[1]);
    if (!requestId || !OFFICE_LEAD_REQUEST_ID.test(requestId)) return privateAppJson({ error: "intake_not_found" }, 404);
    try {
      return privateAppJson(await readOfficeIntakeReceipt(env, auth.session.tenant_id, auth.session.user_id, requestId));
    } catch (error) {
      return error instanceof OfficeIntakeError ? privateAppJson({ error: error.code }, error.status)
        : privateAppJson({ error: "office_intake_unavailable" }, 503);
    }
  }
  const salesLeadMatch = url.pathname.match(/^\/api\/v1\/sales\/leads\/([^/]+)$/);
  if (req.method === "GET" && salesLeadMatch) {
    if (!hasPermission(auth, "sales:read")) return privateAppJson({ error: "office_role_required" }, 403);
    const leadId = decodedPathSegment(salesLeadMatch[1]);
    if (!leadId || !/^lead:[a-z0-9][a-z0-9-]{1,63}:[a-f0-9]{64}$/.test(leadId))
      return privateAppJson({ error: "lead_not_found" }, 404);
    try {
      const model = await buildSalesReadModel(env, auth, leadId);
      const lead = model.leads.find((item) => item.id === leadId);
      if (!lead) return privateAppJson({ error: "lead_not_found" }, 404);
      return privateAppJson({ version: APP_API_VERSION, read_model_generated_at: model.read_model_generated_at,
        permissions: model.permissions, allowed_actions: model.allowed_actions, stale_fields: model.stale_fields,
        partial_sources: model.partial_sources, lead, intake: await readOfficeLeadFacts(env.DB, auth.session.tenant_id, lead.envelope_id) });
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  // Company profile, the derived setup checklist, and per-person notification
  // preferences. Returns null for anything it does not own, so routing continues.
  const companySetupResponse = await handleCompanySetupRoute(req, env, auth);
  if (companySetupResponse) return companySetupResponse;
  const schemaFormsResponse = await handleSchemaFormsRoute(req, env, auth);
  if (schemaFormsResponse) return schemaFormsResponse;
  // Where an automation may deliver. It sits beside the other administration surfaces rather than
  // inside `/api/v1/admin/pipelines` because a recipient is tenant-wide: the same "shop" record is
  // referenced by rules on every board, so it is not owned by any one of them (ELEC-204).
  const recipientResponse = await handleAutomationRecipientRoute(req, env, auth);
  if (recipientResponse) return recipientResponse;
  if (req.method === "GET" && url.pathname === "/api/v1/session") {
    const response = appJson(sessionPayload(auth, env));
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
  // Whether a capability is absent, off, on-but-unconfigured or reachable, for the capabilities
  // this caller's role can actually reach. Every authenticated role, deliberately: before this
  // route a non-office role learned a capability was unavailable from a 404 or a 503 at first use
  // (ELEC-232), which is indistinguishable from a fault. The office pair gets the operator detail;
  // every other role gets state and reason only (ELEC-240).
  if (req.method === "GET" && url.pathname === "/api/v1/capabilities") {
    return privateAppJson(buildCapabilitySignalReadModel(env, auth));
  }
  if (req.method === "GET" && url.pathname === "/api/v1/field/bootstrap") {
    if (!hasPermission(auth, "today:read"))
      return privateAppJson({ error: "today_read_required" }, 403);
    try {
      return privateAppJson({
        version: APP_API_VERSION,
        session: sessionPayload(auth, env),
        // A field device gets one call before it goes offline, so the capability signal rides
        // with it rather than costing a second round trip on a bad connection. It stays a hint:
        // the server re-derives and re-enforces on every write, and a cached state never admits
        // one (docs/CAPABILITY-SIGNAL-CONTRACT.md, "Offline").
        capabilities: buildCapabilitySignalReadModel(env, auth),
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
  if (url.pathname === "/api/v1/evidence-uploads") return await handleEvidenceUpload(req, env, auth);
  if (url.pathname.startsWith("/api/v1/privacy/evidence-uploads")) {
    const dispositionResponse = await handlePrivacyEvidenceDispositionRoute(req, env, auth);
    if (dispositionResponse) return dispositionResponse;
    const privacyResponse = await handlePrivacyEvidenceAuditRoute(req, env, auth);
    if (privacyResponse) return privacyResponse;
  }
  const evidenceContent = url.pathname.match(/^\/api\/v1\/evidence-uploads\/([^/]+)\/content$/);
  if (evidenceContent) return req.method === "GET"
    ? await handleEvidenceContentRead(env, auth, evidenceContent[1] ?? "")
    : privateAppJson({ error: "not_found" }, 404);
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
  // Releasing a crew stop is people-only: the sub-router admits only a person's own cookie session
  // in a releasing role who neither raised nor reported the stop (docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md).
  if (url.pathname.startsWith("/api/v1/work-packages/")) {
    const stopReleaseResponse = await handleWorkPackageStopReleaseRoute(req, env, auth);
    if (stopReleaseResponse) return stopReleaseResponse;
  }
  // Crews and their members are set by an owner or ops person only (crew-roster.ts): scheduling
  // reads this roster, and nothing else writes it.
  if (url.pathname.startsWith("/api/v1/admin/crews")) {
    const rosterResponse = await handleCrewRosterRoute(req, env, auth);
    if (rosterResponse) return rosterResponse;
  }
  // The pipeline board owns `/api/v1/pipelines` outright, and `/api/v1/admin/pipelines` with it:
  // the administration commands reshape exactly the model the board routes read, so one sub-router
  // owns both. Its safe-movement matrix, role scope, administrator authority and undo window are
  // enforced inside that sub-router, before any write commits (ELEC-159, ELEC-175).
  if (
    url.pathname.startsWith("/api/v1/pipelines") ||
    url.pathname.startsWith("/api/v1/admin/pipelines")
  ) {
    const pipelineResponse = await handlePipelineRoute(req, env, auth);
    if (pipelineResponse) return pipelineResponse;
  }
  if (req.method === "GET" && url.pathname === "/api/v1/now") {
    if (!hasPermission(auth, "now:read"))
      return privateAppJson({ error: "office_role_required" }, 403);
    const decisionPage = parseDecisionPageRequest(url.searchParams, auth);
    if (!decisionPage.ok) {
      return privateAppJson(
        { error: decisionPage.status === 404 ? "not_found" : "decision_cursor_invalid" },
        decisionPage.status,
      );
    }
    return privateAppJson(
      await buildNowReadModel(env, auth, new Date(), decisionPage),
    );
  }
  // Search-and-jump for the command palette. Every authenticated role may call it; the role is
  // enforced by what the payload contains, not by refusing the route, because every role has at
  // least its own navigable destinations to jump to.
  if (req.method === "GET" && url.pathname === "/api/v1/search") {
    const rawQuery = url.searchParams.get("q") ?? "";
    if (rawQuery.length > SEARCH_MAX_RAW_QUERY_LENGTH)
      return privateAppJson({ error: "search_query_too_long" }, 400);
    try {
      return privateAppJson(
        await buildOperatorSearchReadModel(env, auth, rawQuery),
      );
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/v1/operating-intake") {
    const model = await buildOperatingIntakeReadModel(env, auth);
    if ("error" in model) return privateAppJson({ error: model.error }, 403);
    return privateAppJson(model);
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
  if (url.pathname === "/api/v1/quickbooks/final-invoice-mappings") {
    return req.method === "POST"
      ? await handleQuickBooksFinalInvoiceMappingWrite(req, env, auth, deps.quickBooksFetcher)
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
  if (req.method === "POST" && url.pathname === "/api/v1/facet-link-revocations") {
    if (!hasPermission(auth, "facet:launch") || auth.session.role !== "owner") {
      return privateAppJson({ error: "facet_link_revocation_owner_required" }, 403);
    }
    if (!validAppCsrf(req, auth)) return privateAppJson({ error: "csrf_failed" }, 403);
    const contentType = req.headers.get("content-type")
      ?.toLowerCase()
      .split(";", 1)[0]
      .trim();
    if (contentType !== "application/json") {
      return privateAppJson({ error: "content_type_required" }, 415);
    }
    const parsed = await readJson(req, 2_048);
    if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
    const body = parseFacetLinkRevocationBody(parsed.value);
    if (!body) return privateAppJson({ error: "invalid_facet_link_revocation" }, 400);
    try {
      const result = await revokeFacetLink(env, {
        ...body,
        tenantId: auth.session.tenant_id,
        actorUserId: auth.session.user_id,
      });
      if (result.kind === "rejected") {
        return privateAppJson({ error: result.code }, result.status);
      }
      return privateAppJson({
        version: APP_API_VERSION,
        revocation: result.revocation,
        ...(result.kind === "replayed" ? { replayed: true } : {}),
      }, result.kind === "created" ? 201 : 200);
    } catch {
      return privateAppJson({ error: "facet_link_revocation_unavailable" }, 502);
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
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/commercial/lead-triage-decisions"
  ) {
    return await createCommercialLeadTriageDecision(req, env, auth);
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/commercial/quote-revisions"
  ) {
    return await createCommercialQuoteRevision(req, env, auth);
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/commercial/proposal-revisions"
  ) {
    return await createCommercialProposalRevision(req, env, auth);
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/commercial/proposal-publications/prepare"
  ) {
    return await prepareCommercialProposalPublication(req, env, auth);
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/commercial/proposal-publications"
  ) {
    return await settleCommercialProposalPublication(req, env, auth);
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/commercial/deposit-intents/reconcile"
  ) {
    return await reconcileCommercialDepositIntent(req, env, auth);
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
  const operatingScheduleMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/schedule$/,
  );
  if (req.method === "POST" && operatingScheduleMatch) {
    return await createOperatingJobAssignment(
      req,
      env,
      auth,
      operatingScheduleMatch[1],
    );
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
  // An office person's answer to an unconfirmed crew item, and the crew phone's read of it.
  if (url.pathname === "/api/v1/field-item-resolutions")
    return await handleFieldItemResolutions(req, env, auth);
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
    const estimatorReadOnly =
      auth.session.role === "sales" && hasPermission(auth, "estimator:read");
    if (!canReadJobs(auth) && !estimatorReadOnly)
      return privateAppJson({ error: "job_read_required" }, 403);
    const jobName = decodedPathSegment(proofMatch[1]);
    if (!jobName) return privateAppJson({ error: "not_found" }, 404);
    try {
      const model = await buildJobProofReadModel(
        env,
        auth,
        jobName,
        url.searchParams.get("cursor"),
        { estimatorReadOnly },
      );
      return model
        ? privateAppJson(model)
        : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
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
  const universalAssignmentMatch = url.pathname.match(
    /^\/api\/v1\/work-objects\/([^/]+)\/([^/]+)\/physical-contexts\/([^/]+)\/([^/]+)\/assignment$/,
  );
  if (req.method === "POST" && universalAssignmentMatch) {
    const scope = decodeWorkObjectScope(universalAssignmentMatch);
    return scope
      ? await createOperatingWorkObjectAssignment(req, env, auth, scope)
      : privateAppJson({ error: "not_found" }, 404);
  }
  const workPackageIssueMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/work-package$/,
  );
  if (req.method === "POST" && workPackageIssueMatch) {
    return await handleOfficeWorkPackageIssueRoute(
      req,
      env,
      auth,
      workPackageIssueMatch[1],
    );
  }
  const universalWorkPackageIssueMatch = url.pathname.match(
    /^\/api\/v1\/work-objects\/([^/]+)\/([^/]+)\/physical-contexts\/([^/]+)\/([^/]+)\/work-package$/,
  );
  if (req.method === "POST" && universalWorkPackageIssueMatch) {
    const scope = decodeWorkObjectScope(universalWorkPackageIssueMatch);
    if (!scope) return appJson({ error: "not_found" }, 404);
    return await handleOfficeWorkPackageIssueRoute(
      req,
      env,
      auth,
      scope.workObjectId,
      scope,
    );
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
  const fleetPhotoMatch = url.pathname.match(
    /^\/api\/v1\/fleet\/assets\/([^/]+)\/photo-evidence$/,
  );
  if (req.method === "POST" && fleetPhotoMatch) {
    return await handleFleetPhotoUpload(req, env, auth, fleetPhotoMatch[1]);
  }
  const fleetCollisionMatch = url.pathname.match(
    /^\/api\/v1\/fleet\/assets\/([^/]+)\/collisions$/,
  );
  if (fleetCollisionMatch && (req.method === "GET" || req.method === "POST")) {
    return await handleFleetCollisionCollection(req, env, auth, fleetCollisionMatch[1]);
  }
  const fleetCollisionTransitionMatch = url.pathname.match(
    /^\/api\/v1\/fleet\/assets\/([^/]+)\/collisions\/([^/]+)\/transitions$/,
  );
  if (req.method === "POST" && fleetCollisionTransitionMatch) {
    return await handleFleetCollisionTransition(
      req,
      env,
      auth,
      fleetCollisionTransitionMatch[1],
      fleetCollisionTransitionMatch[2],
    );
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
  const workPackageHoldReleaseMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/work-package\/holds\/(\d+)\/release$/,
  );
  if (req.method === "POST" && workPackageHoldReleaseMatch) {
    return await handleOfficeWorkPackageHoldReleaseRoute(
      req,
      env,
      auth,
      workPackageHoldReleaseMatch[1],
      Number(workPackageHoldReleaseMatch[2]),
    );
  }
  const workPackageEvidenceReviewMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/work-package\/evidence\/([^/]+)\/review$/,
  );
  if (req.method === "POST" && workPackageEvidenceReviewMatch) {
    return await handleOfficeWorkPackageEvidenceReviewRoute(
      req,
      env,
      auth,
      workPackageEvidenceReviewMatch[1],
      workPackageEvidenceReviewMatch[2],
    );
  }
  const universalWorkPackageHoldReleaseMatch = url.pathname.match(
    /^\/api\/v1\/work-objects\/([^/]+)\/([^/]+)\/physical-contexts\/([^/]+)\/([^/]+)\/work-package\/holds\/(\d+)\/release$/,
  );
  if (req.method === "POST" && universalWorkPackageHoldReleaseMatch) {
    const scope = decodeWorkObjectScope(universalWorkPackageHoldReleaseMatch);
    if (!scope) return appJson({ error: "not_found" }, 404);
    return await handleOfficeWorkPackageHoldReleaseRoute(
      req,
      env,
      auth,
      scope.workObjectId,
      Number(universalWorkPackageHoldReleaseMatch[5]),
      scope,
    );
  }
  const universalWorkPackageEvidenceReviewMatch = url.pathname.match(
    /^\/api\/v1\/work-objects\/([^/]+)\/([^/]+)\/physical-contexts\/([^/]+)\/([^/]+)\/work-package\/evidence\/([^/]+)\/review$/,
  );
  if (req.method === "POST" && universalWorkPackageEvidenceReviewMatch) {
    const scope = decodeWorkObjectScope(
      universalWorkPackageEvidenceReviewMatch,
    );
    if (!scope) return appJson({ error: "not_found" }, 404);
    return await handleOfficeWorkPackageEvidenceReviewRoute(
      req,
      env,
      auth,
      scope.workObjectId,
      universalWorkPackageEvidenceReviewMatch[5],
      scope,
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
    if (!scope) return privateAppJson({ error: "not_found" }, 404);
    try {
      const model = await buildUniversalWorkPackageReadModel(env, auth, scope);
      return model ? privateAppJson(model) : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
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
  const facetPrequoteLaunchMatch = url.pathname.match(
    /^\/api\/v1\/estimator\/jobs\/([^/]+)\/facet-prequote-launches$/,
  );
  if (req.method === "POST" && facetPrequoteLaunchMatch) {
    const jobName = decodedPathSegment(facetPrequoteLaunchMatch[1]);
    return jobName
      ? await handleFacetPrequoteLaunch(req, env, auth, jobName)
      : privateAppJson({ error: "not_found" }, 404);
  }
  const facetPrequotePromotionMatch = url.pathname.match(
    /^\/api\/v1\/estimator\/jobs\/([^/]+)\/facet-prequote-promotions$/,
  );
  if (req.method === "POST" && facetPrequotePromotionMatch) {
    const jobName = decodedPathSegment(facetPrequotePromotionMatch[1]);
    return jobName
      ? await handleFacetPrequotePromotion(req, env, auth, jobName)
      : privateAppJson({ error: "not_found" }, 404);
  }
  const estimatorEvidenceImportMatch = url.pathname.match(
    /^\/api\/v1\/estimator\/jobs\/([^/]+)\/evidence-imports$/,
  );
  if (req.method === "POST" && estimatorEvidenceImportMatch) {
    const jobName = decodedPathSegment(estimatorEvidenceImportMatch[1]);
    return jobName
      ? await handleEstimatorEvidenceImport(req, env, auth, jobName)
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
  const jobFieldMeasurementsMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/field-measurements$/,
  );
  if (req.method === "GET" && jobFieldMeasurementsMatch) {
    if (!canReadJobs(auth))
      return privateAppJson({ error: "job_read_required" }, 403);
    const jobName = decodedPathSegment(jobFieldMeasurementsMatch[1]);
    if (!jobName) return privateAppJson({ error: "not_found" }, 404);
    if (
      [...url.searchParams.keys()].some((key) => key !== "cursor") ||
      url.searchParams.getAll("cursor").length > 1
    )
      return privateAppJson({ error: "invalid_field_measurement_cursor" }, 400);
    const cursor = parseFieldMeasurementCursor(url.searchParams.get("cursor"));
    if (cursor === undefined)
      return privateAppJson({ error: "invalid_field_measurement_cursor" }, 400);
    try {
      const model = await buildJobFieldMeasurementPageReadModel(
        env,
        auth,
        jobName,
        cursor,
      );
      return model
        ? privateAppJson(model)
        : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson({ error: "field_measurements_unavailable" }, 502);
    }
  }
  const jobHistoryMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/history$/,
  );
  if (req.method === "GET" && jobHistoryMatch) {
    // Same gate as the customer's history beside it, and narrower than the live job route: a crew
    // holds `jobs:read:assigned` and is shown today's work, not the record of work that is over.
    if (!hasPermission(auth, "jobs:read:any"))
      return privateAppJson({ error: "job_read_any_required" }, 403);
    const jobName = decodedPathSegment(jobHistoryMatch[1]);
    if (!jobName) return privateAppJson({ error: "not_found" }, 404);
    try {
      const model = await buildJobHistoryReadModel(
        env,
        auth,
        jobName,
        url.searchParams.get("cursor"),
      );
      return model
        ? privateAppJson(model)
        : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const customerJobHistoryMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/customer-history$/,
  );
  if (req.method === "GET" && customerJobHistoryMatch) {
    // `jobs:read:any` only. A crew member holds `jobs:read:assigned` and is shown one assignment at
    // a time on purpose; this customer's other work — including addresses nobody sent them to — is
    // office context, and widening the field packet to carry it would be a new disclosure.
    if (!hasPermission(auth, "jobs:read:any"))
      return privateAppJson({ error: "job_read_any_required" }, 403);
    const jobName = decodedPathSegment(customerJobHistoryMatch[1]);
    if (!jobName) return privateAppJson({ error: "not_found" }, 404);
    try {
      const model = await buildCustomerJobHistoryReadModel(env, auth, jobName);
      return model
        ? privateAppJson(model)
        : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  if (req.method === "GET" && jobMatch) {
    // Sales may inspect the job plan through this one read. Do not grant jobs:read:any: it also
    // opens history, commercial phase and other records that are outside the estimator view.
    const estimatorReadOnly =
      auth.session.role === "sales" && hasPermission(auth, "estimator:read");
    if (!canReadJobs(auth) && !estimatorReadOnly)
      return privateAppJson({ error: "job_read_required" }, 403);
    const jobName = decodedPathSegment(jobMatch[1]);
    if (!jobName) return privateAppJson({ error: "not_found" }, 404);
    try {
      const model = await buildJobReadModel(env, auth, jobName, {
        estimatorReadOnly,
      });
      return model
        ? privateAppJson(model)
        : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const jobPhaseMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/phase$/);
  if (req.method === "GET" && jobPhaseMatch) {
    // `jobs:read:any` only. The phase carries quote totals, terms, the customer's acceptance and
    // the accounting intents, and `readCommercialJobPhase` is not scoped to an assignment, so the
    // assigned-only crew reading `canReadJobs` used to admit could read any job's money by id.
    if (!hasPermission(auth, "jobs:read:any"))
      return privateAppJson({ error: "job_read_any_required" }, 403);
    const jobName = decodedPathSegment(jobPhaseMatch[1]);
    if (!jobName) return privateAppJson({ error: "not_found" }, 404);
    try {
      const model = await readCommercialJobPhase(
        env,
        auth.session.tenant_id,
        jobName,
      );
      return model
        ? privateAppJson(model)
        : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const commercialContextMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/commercial-context$/,
  );
  if (req.method === "GET" && commercialContextMatch) {
    // The people who write to a customer: owner, ops and sales. It carries the customer's email and
    // consent, which the job packet and search deliberately never do.
    if (!hasPermission(auth, "sales:read"))
      return privateAppJson({ error: "sales_read_required" }, 403);
    const jobName = decodedPathSegment(commercialContextMatch[1]);
    if (!jobName) return privateAppJson({ error: "not_found" }, 404);
    try {
      const model = await readCommercialContext(
        env,
        auth.session.tenant_id,
        jobName,
      );
      return model
        ? privateAppJson(model)
        : privateAppJson({ error: "not_found" }, 404);
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
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
  if (req.method === "GET" && url.pathname === "/api/v1/integrations/readiness") {
    if (!officeRole(auth))
      return privateAppJson({ error: "office_role_required" }, 403);
    const requestedProfile = url.searchParams.get("profile") ?? "reference_journey";
    if (!READINESS_PROFILE_KEYS.includes(requestedProfile as ReadinessProfileKey))
      return privateAppJson({ error: "invalid_readiness_profile" }, 400);
    try {
      // Manifests, proofs, and profiles are projected from the tenant's append-only D1 facts.
      // No provider credential, raw response, evidence body, or configuration mutation crosses
      // this owner/ops read boundary.
      return privateAppJson(await buildCapabilityReadinessReadModel(
        env,
        auth.session.tenant_id,
        requestedProfile as ReadinessProfileKey,
      ));
    } catch {
      return privateAppJson({ error: "integration_readiness_unavailable" }, 502);
    }
  }
  if (
    req.method === "POST" &&
    (url.pathname === "/api/v1/integrations/manifests" ||
      url.pathname === "/api/v1/integrations/profiles")
  ) {
    if (!officeRole(auth))
      return privateAppJson({ error: "office_role_required" }, 403);
    if (!validAppCsrf(req, auth))
      return privateAppJson({ error: "csrf_failed" }, 403);
    if (String(env.APP_READINESS_ADMISSION_ENABLED ?? "") !== "true")
      return privateAppJson({ error: "integration_admission_disabled" }, 503);
    const parsed = await readBoundedJson(req, 16 * 1024);
    if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
    try {
      const result = url.pathname.endsWith("/manifests")
        ? await admitCapabilityManifest(env, auth, parsed.value)
        : await admitCapabilityProfile(env, auth, parsed.value);
      return privateAppJson(result.body, result.status);
    } catch {
      return privateAppJson({ error: "integration_admission_store_unavailable" }, 502);
    }
  }
  // Resolving a failed Newo handoff is people-only: the sub-router admits only a person's own
  // cookie session in the owner or ops role (docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md).
  if (url.pathname.startsWith("/api/v1/newo/operations/handoffs/")) {
    const resolutionResponse = await handleNewoHandoffResolutionRoute(req, env, auth);
    if (resolutionResponse) return resolutionResponse;
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
  // The producers the six scheduling gates never had (ELEC-122). Nested under the
  // job on purpose: a gate has no identity apart from the job it locks, and the
  // path says which job's schedule is being unlocked.
  const productionGateClearanceMatch = url.pathname.match(
    /^\/api\/v1\/production\/jobs\/([^/]+)\/gates\/([^/]+)\/clearance$/,
  );
  if (req.method === "POST" && productionGateClearanceMatch) {
    const roofJobId = decodedPathSegment(productionGateClearanceMatch[1]);
    const gate = decodedPathSegment(productionGateClearanceMatch[2]);
    if (!roofJobId || !gate) return privateAppJson({ error: "not_found" }, 404);
    return await handleProductionGateClearance(req, env, auth, roofJobId, gate);
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

async function handleEstimatorEvidenceImport(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  roofJobId: string,
): Promise<Response> {
  if (!hasPermission(auth, "estimator:read") || auth.session.role !== "owner") {
    return privateAppJson({ error: "estimator_import_owner_required" }, 403);
  }
  if (!validAppCsrf(req, auth)) {
    return privateAppJson({ error: "csrf_failed" }, 403);
  }
  const requestIdempotencyKey = estimatorIdempotencyKey(req);
  if (!requestIdempotencyKey) {
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  }
  const parsed = await readJson(req, 4_096);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const body = estimatorEvidenceImportBody(parsed.value);
  if (!body) {
    return privateAppJson({ error: "invalid_estimator_evidence_import" }, 400);
  }
  const input: ImportEstimatorEvidenceInput = {
    tenantId: auth.session.tenant_id,
    roofJobId,
    measurementReceiptId: body.measurementReceiptId,
    facetEventId: body.facetEventId,
    estimatorReadyEventId: body.estimatorReadyEventId,
    commercialQuoteRevisionId: body.commercialQuoteRevisionId,
    revisionNumber: body.revisionNumber,
    supersedesEstimatorRevisionId: body.supersedesEstimatorRevisionId,
    correctionReason: body.correctionReason,
    importedByUserId: auth.session.user_id,
    idempotencyKey: requestIdempotencyKey,
  };
  try {
    const result = await importEstimatorEvidenceFromNativeSources(env, input);
    return privateAppJson(
      {
        version: 1,
        estimator_revision_id: result.revision.estimator_revision_id,
        roof_job_id: result.revision.roof_job_id,
        revision_number: Number(result.revision.revision_number),
        measurement_receipt_id: result.revision.measurement_receipt_id,
        facet_event_id: result.revision.facet_event_id,
        estimator_ready_event_id: result.revision.estimator_ready_event_id,
        commercial_quote_revision_id:
          result.revision.commercial_quote_revision_id,
        evidence_digest: result.revision.evidence_digest,
        created_at: result.revision.created_at,
        replayed: result.kind === "replayed",
      },
      result.kind === "created" ? 201 : 200,
    );
  } catch (error) {
    if (error instanceof EstimatorNativeStoreError || error instanceof PricingCatalogError) {
      return privateAppJson({ error: error.code }, error.status);
    }
    return privateAppJson({ error: "estimator_import_unavailable" }, 502);
  }
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

async function handleFacetPrequoteLaunch(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
): Promise<Response> {
  // The existing `facet:launch` permission is intentionally not granted to generic roles;
  // this new route does not widen the role matrix and remains owner-only.
  if (!hasPermission(auth, "facet:launch") || auth.session.role !== "owner") {
    return privateAppJson({ error: "facet_prequote_owner_required" }, 403);
  }
  if (!validAppCsrf(req, auth)) return privateAppJson({ error: "csrf_failed" }, 403);
  const requestIdempotencyKey = idempotencyKey(req);
  if (!requestIdempotencyKey) {
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  }
  const parsed = await readJson(req, 1_024);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value) || Object.keys(parsed.value).length !== 0) {
    return privateAppJson({ error: "invalid_facet_prequote_launch_request" }, 400);
  }
  try {
    const result = await issueFacetPrequoteLaunch(env, {
      tenantId: auth.session.tenant_id,
      jobName,
      actorUserId: auth.session.user_id,
      actorRole: auth.session.role,
      idempotencyKey: requestIdempotencyKey,
    });
    if (result.kind === "rejected") return privateAppJson({ error: result.code }, result.status);
    return privateAppJson({
      version: APP_API_VERSION,
      read_model_generated_at: new Date().toISOString(),
      permissions: auth.permissions,
      allowed_actions: ["facet_prequote_launch.create"],
      launch: result.launch,
      ...(result.kind === "replayed" ? { replayed: true } : {}),
    }, result.kind === "created" ? 201 : 200);
  } catch (error) {
    if (error instanceof FacetPrequoteError) {
      return privateAppJson({ error: error.code }, error.status);
    }
    return privateAppJson({ error: "facet_prequote_launch_unavailable" }, 502);
  }
}

async function handleFacetPrequotePromotion(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  roofJobId: string,
): Promise<Response> {
  if (!hasPermission(auth, "facet:launch") || auth.session.role !== "owner") {
    return privateAppJson({ error: "facet_promotion_owner_required" }, 403);
  }
  if (!validAppCsrf(req, auth)) return privateAppJson({ error: "csrf_failed" }, 403);
  const requestIdempotencyKey = idempotencyKey(req);
  if (!requestIdempotencyKey) {
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  }
  const parsed = await readJson(req, 4_096);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const body = facetPrequotePromotionBody(parsed.value);
  if (!body) return privateAppJson({ error: "invalid_facet_prequote_promotion" }, 400);
  try {
    const result = await promoteFacetEstimatorReady(env, {
      tenantId: auth.session.tenant_id,
      roofJobId,
      estimatorReadyEventId: body.estimatorReadyEventId,
      estimatorRevisionId: body.estimatorRevisionId,
      commercialQuoteRevisionId: body.commercialQuoteRevisionId,
      actorUserId: auth.session.user_id,
      actorRole: auth.session.role,
      idempotencyKey: requestIdempotencyKey,
    });
    if (result.kind === "rejected") return privateAppJson({ error: result.code }, result.status);
    return privateAppJson({
      version: APP_API_VERSION,
      promotion: result.promotion,
      ...(result.kind === "replayed" ? { replayed: true } : {}),
    }, result.kind === "created" ? 201 : 200);
  } catch (error) {
    if (error instanceof FacetPrequoteError) {
      return privateAppJson({ error: error.code }, error.status);
    }
    return privateAppJson({ error: "facet_prequote_promotion_unavailable" }, 502);
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

async function handleQuickBooksFinalInvoiceMappingWrite(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  fetcher?: typeof fetch,
): Promise<Response> {
  if (auth.session.role !== "owner")
    return privateAppJson({ error: "owner_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const key = quickBooksIdempotencyKey(req);
  if (!key) return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, 2_048);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const mapping = quickBooksMappingBody(parsed.value);
  if (!mapping)
    return privateAppJson({ error: "invalid_quickbooks_mapping_request" }, 400);
  try {
    const result = await recordNativeInitialProviderMapping(env, {
      tenantId: auth.session.tenant_id,
      roofJobId: mapping.roofJobId,
      qboCustomerId: mapping.qboCustomerId,
      qboItemId: mapping.qboItemId,
      qboTaxCodeId: mapping.qboTaxCodeId,
      qboTermsId: mapping.qboTermsId,
      jurisdiction: mapping.jurisdiction,
      taxCode: mapping.taxCode,
      paymentTermsDays: mapping.paymentTermsDays,
      actorUserId: auth.session.user_id,
      idempotencyKey: key,
      correctionReason: mapping.correctionReason,
      fetcher,
    });
    if (result.kind === "rejected")
      return privateAppJson({ error: result.code }, result.status);
    return privateAppJson(await quickBooksConnectionEnvelope(
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
    // the authenticated field user holds or drives this asset; the native D1
    // insert trigger repeats that scope check against the current asset state.
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
  if ((env.APP_TENANT_ID ?? "ironwrap").trim() !== auth.session.tenant_id)
    return appJson({ error: "not_found" }, 404);
  if (!validAppCsrf(req, auth)) return appJson({ error: "csrf_failed" }, 403);
  const jobName = scope?.workObjectId ?? decodedPathSegment(encodedJobName ?? "");
  if (!jobName) return appJson({ error: "not_found" }, 404);
  const replay = await replayVerifiedWorkPackageAction(
    req,
    env,
    auth,
    jobName,
    kind,
    scope,
  );
  if (replay) return replay;
  try {
    // Do not trust a job or assignment identifier from the browser. The BFF
    // resolves the current native assignment for the authenticated field user.
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
  if ((env.APP_TENANT_ID ?? "ironwrap").trim() !== auth.session.tenant_id)
    return privateAppJson({ error: "not_found" }, 404);
  if (!validAppCsrf(req, auth)) return privateAppJson({ error: "csrf_failed" }, 403);
  const jobName = scope?.workObjectId ?? decodedPathSegment(encodedJobName ?? "");
  if (!jobName) return privateAppJson({ error: "not_found" }, 404);
  const replay = await replayVerifiedWorkPackageAction(
    req,
    env,
    auth,
    jobName,
    kind,
    scope,
  );
  if (replay) return replay;
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
        appUserIdentities(auth.session),
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

async function handleOfficeWorkPackageIssueRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedJobName: string | undefined,
  scope?: WorkObjectScope,
): Promise<Response> {
  if (!["owner", "ops", "production"].includes(auth.session.role))
    return privateAppJson({ error: "production_role_required" }, 403);
  if ((env.APP_TENANT_ID ?? "ironwrap").trim() !== auth.session.tenant_id)
    return privateAppJson({ error: "not_found" }, 404);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const deviceActionId = idempotencyKey(req);
  if (!deviceActionId)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  if (req.headers.get("x-device-action-id")?.trim() !== deviceActionId)
    return privateAppJson({ error: "device_action_id_mismatch" }, 400);
  const jobName = scope?.workObjectId ?? decodedPathSegment(encodedJobName ?? "");
  if (!jobName) return privateAppJson({ error: "not_found" }, 404);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseOfficeWorkPackageIssue(parsed.value);
  if (!input)
    return privateAppJson({ error: "invalid_work_package_issue" }, 400);

  const workPackageId = `wp_${(
    await sha256Hex(
      `${auth.session.tenant_id}:${jobName}:${input.assignmentId}:${input.version}`,
    )
  ).slice(0, 32)}`;
  const issueRequestSha256 = await sha256Hex(
    canonicalJson({
      schema_version: "ironwrap.work-package-issue-request.v1",
      tenant_id: auth.session.tenant_id,
      actor_user_id: auth.session.user_id,
      actor_role: auth.session.role,
      device_action_id: deviceActionId,
      job_id: jobName,
      route_scope: scope ?? null,
      request: input,
    }),
  );
  const manifestKey = workPackageOfficeManifestKey(
    auth.session.tenant_id,
    deviceActionId,
  );

  try {
    const durableReplay = await replayNativeWorkPackageIssue(env, {
      tenantId: auth.session.tenant_id,
      deviceActionId,
      issueRequestSha256,
      workPackageId,
      workPackageVersion: input.version,
      jobId: jobName,
      assignmentId: input.assignmentId,
      actorUserId: auth.session.user_id,
    });
    if (durableReplay) {
      await storeWorkPackageOfficeManifest(
        env,
        auth.session.tenant_id,
        deviceActionId,
        officeWorkPackageIssueManifest(
          durableReplay.document,
          auth,
          deviceActionId,
          jobName,
          input,
          scope,
        ),
      );
      return officeWorkPackageIssueResponse(
        auth.session.tenant_id,
        deviceActionId,
        workPackageId,
        input.version,
      );
    }
    const assignment = scope
      ? await activeAssignmentForWorkObject(env, auth, scope)
      : await activeAssignmentForJob(env, auth, jobName);
    const assignmentName = boundedText(assignment?.name, 1, 140);
    const assignmentId = boundedText(assignment?.assignment_id, 1, 140);
    if (
      !assignment ||
      !assignmentName ||
      (input.assignmentId !== assignmentName && input.assignmentId !== assignmentId)
    )
      return privateAppJson({ error: "work_package_assignment_not_available" }, 404);
    const nativeScope = officeWorkPackageIssueScope(assignment, jobName, scope);
    if (!nativeScope)
      return privateAppJson({ error: "work_package_scope_conflict" }, 409);

    const assignmentModified = normalizedIso(assignment.modified);
    if (!assignmentModified || assignmentModified !== input.assignmentModified)
      return privateAppJson({ error: "work_package_assignment_changed" }, 409);
    let authorityRequirements: ReturnType<typeof parseAuthorityRequirements>;
    try {
      authorityRequirements = parseAuthorityRequirements(
        assignment.authority_requirements_json,
      );
    } catch {
      return privateAppJson(
        { error: "work_package_authority_requirements_invalid" },
        409,
      );
    }
    const assignmentVersion = validVersion(assignment.assignment_version);
    const assignmentCommandFingerprint = boundedText(
      assignment.assignment_command_fingerprint,
      64,
      64,
    );
    const assignmentAuthorityRequirementsSha256 = boundedText(
      assignment.authority_requirements_sha256,
      64,
      64,
    );
    if (
      !assignmentVersion ||
      !assignmentCommandFingerprint ||
      !assignmentAuthorityRequirementsSha256 ||
      !/^[0-9a-f]{64}$/.test(assignmentCommandFingerprint) ||
      !/^[0-9a-f]{64}$/.test(assignmentAuthorityRequirementsSha256) ||
      (await sha256Hex(canonicalJson(authorityRequirements))) !==
        assignmentAuthorityRequirementsSha256
    ) {
      return privateAppJson(
        { error: "work_package_authority_requirements_invalid" },
        409,
      );
    }

    const head = await getNativeWorkPackageVersionHead(
      env,
      auth.session.tenant_id,
      jobName,
      assignmentName,
    );
    if (assignmentName !== input.assignmentId)
      return privateAppJson(
        { error: "work_package_assignment_not_available" },
        404,
      );
    const replay =
      head?.version === input.version && head.workPackageId === workPackageId;
    if (!replay) {
      if (head?.status === "Blocked")
        return privateAppJson({ error: "work_package_stop_release_required" }, 409);
      if (
        head &&
        !["Released", "Acknowledged", "In Progress"].includes(
          head.status,
        )
      )
        return privateAppJson({ error: "work_package_assignment_terminal" }, 409);
      const expectedVersion = head ? head.version + 1 : 1;
      if (
        input.version !== expectedVersion ||
        (expectedVersion === 1 && input.correctionReason) ||
        (expectedVersion > 1 && !input.correctionReason)
      )
        return privateAppJson({ error: "work_package_version_conflict" }, 409);
      if (Math.abs(Date.now() - Date.parse(input.issuedAt)) > 5 * 60 * 1_000)
        return privateAppJson({ error: "work_package_issue_time_invalid" }, 409);
    }
    if (
      replay &&
      (head.correctionReason !== input.correctionReason ||
        (input.version > 1 && !head.supersedesId))
    )
      return privateAppJson({ error: "work_package_definition_conflict" }, 409);

    const workers = officeWorkPackageAssignmentRoster(assignment);
    if (!workers?.some((worker) => worker.required))
      return privateAppJson({ error: "work_package_worker_roster_missing" }, 409);
    const authorityUser = boundedText(assignment.authority_user, 1, 140);
    const authorityRole = boundedText(assignment.authority_role, 1, 140);
    if (
      Boolean(authorityUser) !== Boolean(authorityRole) ||
      (scope && (!authorityUser || !authorityRole))
    )
      return privateAppJson({ error: "work_package_assignment_authority_invalid" }, 409);
    const priorId = replay
      ? head.supersedesId
      : input.version > 1
        ? head?.workPackageId ?? null
        : null;
    const releaseAttemptId = `wpr_${(
      await sha256Hex(`${auth.session.tenant_id}:${deviceActionId}:release`)
    ).slice(0, 32)}`;
    const result = await issueNativeWorkPackage(env, {
      tenantId: auth.session.tenant_id,
      workPackageId,
      version: input.version,
      deviceActionId,
      manifestKey,
      jobId: jobName,
      assignmentId: assignmentName,
      assignmentVersion,
      assignmentCommandFingerprint,
      assignmentAuthorityRequirementsSha256,
      issueRequestSha256,
      workObjectType: nativeScope.workObjectType,
      workObjectId: nativeScope.workObjectId,
      physicalContextType: nativeScope.physicalContextType,
      physicalContextId: nativeScope.physicalContextId,
      assignmentAuthorityUser: authorityUser,
      assignmentAuthorityRole: authorityRole,
      title: input.title,
      objective: input.objective,
      boundaries: input.boundaries,
      prerequisites: input.prerequisites,
      expectedResult: input.expectedResult,
      stopConditions: input.stopConditions,
      makeSafeProcedure: input.makeSafeProcedure,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      releasedAt: input.issuedAt,
      releaseAttemptId,
      authorityRequirements,
      steps: input.steps,
      holdPoints: input.holdPoints,
      assignedWorkers: workers,
      supersedesId: priorId,
      supersedesVersion: priorId ? input.version - 1 : null,
      correctionReason: input.correctionReason,
      issuedByUser: auth.session.user_id,
      issuedByRole: officeWorkPackageRoleLabel(auth.session.role),
    });
    await storeWorkPackageOfficeManifest(
      env,
      auth.session.tenant_id,
      deviceActionId,
      officeWorkPackageIssueManifest(
        result.document,
        auth,
        deviceActionId,
        jobName,
        input,
        scope,
      ),
    );
    return officeWorkPackageIssueResponse(
      auth.session.tenant_id,
      deviceActionId,
      workPackageId,
      input.version,
    );
  } catch (error) {
    return privateAppJson(
      workPackageOfficeActionError(error),
      workPackageOfficeActionStatus(error),
    );
  }
}

async function handleOfficeWorkPackageHoldReleaseRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedJobName: string | undefined,
  holdPointSequence: number,
  scope?: WorkObjectScope,
): Promise<Response> {
  if (
    auth.session.role !== "owner" &&
    auth.session.role !== "ops" &&
    auth.session.role !== "production"
  )
    return privateAppJson({ error: "production_role_required" }, 403);
  if ((env.APP_TENANT_ID ?? "ironwrap").trim() !== auth.session.tenant_id)
    return privateAppJson({ error: "not_found" }, 404);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const deviceActionId = idempotencyKey(req);
  if (!deviceActionId)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  if (req.headers.get("x-device-action-id")?.trim() !== deviceActionId)
    return privateAppJson({ error: "device_action_id_mismatch" }, 400);
  const jobName =
    scope?.workObjectId ?? decodedPathSegment(encodedJobName ?? "");
  if (!jobName) return privateAppJson({ error: "not_found" }, 404);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseOfficeWorkPackageHoldRelease(parsed.value);
  if (!input)
    return privateAppJson({ error: "invalid_work_package_hold_release" }, 400);
  try {
    const workPackage = await fieldWorkPackageForAssignment(
      env,
      jobName,
      input.assignmentId,
      auth.session.tenant_id,
    );
    if (
      !workPackage ||
      workPackage.id !== input.workPackageId ||
      workPackage.version !== input.workPackageVersion
    ) {
      return privateAppJson({ error: "work_package_not_available" }, 404);
    }
    if (!workPackage.releaseAttemptId)
      return privateAppJson(
        { error: "work_package_release_attempt_unavailable" },
        409,
      );
    const nativeScope = officeWorkPackageScope(workPackage, jobName, scope);
    if (!nativeScope)
      return privateAppJson({ error: "work_package_scope_conflict" }, 409);
    const hold = workPackage.holdPoints.find(
      (candidate) => candidate.sequence === holdPointSequence,
    );
    if (!hold)
      return privateAppJson({ error: "work_package_hold_invalid" }, 404);
    const supersededEvidence = new Set(
      (workPackage.evidence ?? [])
        .map((candidate) => candidate.correctionOf)
        .filter((eventId): eventId is string => Boolean(eventId)),
    );
    const holdEvidence = (workPackage.evidence ?? []).filter(
      (candidate) =>
        candidate.slotId === `hold:${holdPointSequence}` &&
        !supersededEvidence.has(candidate.eventId) &&
        candidate.verification === "Verified" &&
        candidate.disposition === "Open" &&
        candidate.freshness === "Current" &&
        ["None", "Resolved"].includes(candidate.conflictState),
    );
    if (holdEvidence.length !== 1)
      return privateAppJson(
        { error: "work_package_hold_evidence_invalid" },
        409,
      );
    const evidence = holdEvidence[0]!;
    const manifestKey = await storeWorkPackageOfficeManifest(
      env,
      auth.session.tenant_id,
      deviceActionId,
      {
        version: 1,
        tenant_id: auth.session.tenant_id,
        user_id: auth.session.user_id,
        role: auth.session.role,
        job_id: jobName,
        assignment_id: input.assignmentId,
        work_package_id: workPackage.id,
        work_package_version: workPackage.version,
        kind: "hold_release",
        target: {
          hold_point_sequence: holdPointSequence,
          evidence_event_id: evidence.eventId,
          evidence_item: evidence.evidenceItem,
          evidence_slot_id: evidence.slotId,
        },
        scope: nativeScope,
      },
    );
    const occurredAt = new Date().toISOString();
    const result = await releaseNativeWorkPackageHold(env, {
      tenantId: auth.session.tenant_id,
      workPackageId: workPackage.id,
      workPackageVersion: workPackage.version,
      jobId: jobName,
      assignmentId: input.assignmentId,
      actorUser: auth.session.user_id,
      actorRole: auth.session.role,
      deviceActionId,
      holdPointSequence,
      evidenceItem: evidence.evidenceItem,
      releaseAttemptId: workPackage.releaseAttemptId,
      workObjectType: nativeScope.workObjectType,
      workObjectId: nativeScope.workObjectId,
      physicalContextType: nativeScope.physicalContextType,
      physicalContextId: nativeScope.physicalContextId,
      manifestKey,
      occurredAt,
    });
    return privateAppJson({
      device_action_id: deviceActionId,
      status: "verified",
      server_ref: result.workPackageName,
      cursor: result.eventName,
    });
  } catch (error) {
    return privateAppJson(
      workPackageOfficeActionError(error),
      workPackageOfficeActionStatus(error),
    );
  }
}

async function handleOfficeWorkPackageEvidenceReviewRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedJobName: string | undefined,
  encodedEvidenceEventId: string,
  scope?: WorkObjectScope,
): Promise<Response> {
  if (
    auth.session.role !== "owner" &&
    auth.session.role !== "ops" &&
    auth.session.role !== "production"
  )
    return privateAppJson({ error: "production_role_required" }, 403);
  if ((env.APP_TENANT_ID ?? "ironwrap").trim() !== auth.session.tenant_id)
    return privateAppJson({ error: "not_found" }, 404);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const deviceActionId = idempotencyKey(req);
  if (!deviceActionId)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  if (req.headers.get("x-device-action-id")?.trim() !== deviceActionId)
    return privateAppJson({ error: "device_action_id_mismatch" }, 400);
  const jobName =
    scope?.workObjectId ?? decodedPathSegment(encodedJobName ?? "");
  const evidenceEventId = decodedPathSegment(encodedEvidenceEventId ?? "");
  if (!jobName || !evidenceEventId)
    return privateAppJson({ error: "not_found" }, 404);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseOfficeWorkPackageEvidenceReview(parsed.value);
  if (!input)
    return privateAppJson(
      { error: "invalid_work_package_evidence_review" },
      400,
    );
  try {
    const workPackage = await fieldWorkPackageForAssignment(
      env,
      jobName,
      input.assignmentId,
      auth.session.tenant_id,
    );
    if (
      !workPackage ||
      workPackage.id !== input.workPackageId ||
      workPackage.version !== input.workPackageVersion
    ) {
      return privateAppJson({ error: "work_package_not_available" }, 404);
    }
    if (!workPackage.releaseAttemptId)
      return privateAppJson(
        { error: "work_package_release_attempt_unavailable" },
        409,
      );
    const nativeScope = officeWorkPackageScope(workPackage, jobName, scope);
    if (!nativeScope)
      return privateAppJson({ error: "work_package_scope_conflict" }, 409);
    const evidence = workPackage.evidence?.find(
      (candidate) => candidate.eventId === evidenceEventId,
    );
    if (!evidence)
      return privateAppJson(
        { error: "work_package_evidence_review_target_invalid" },
        404,
      );
    const manifestKey = await storeWorkPackageOfficeManifest(
      env,
      auth.session.tenant_id,
      deviceActionId,
      {
        version: 1,
        tenant_id: auth.session.tenant_id,
        user_id: auth.session.user_id,
        role: auth.session.role,
        job_id: jobName,
        assignment_id: input.assignmentId,
        work_package_id: workPackage.id,
        work_package_version: workPackage.version,
        kind: "evidence_review",
        target: {
          evidence_event_id: evidenceEventId,
          evidence_item: evidence.evidenceItem,
          evidence_slot_id: evidence.slotId,
          disposition: input.disposition,
          correction_reason: input.correctionReason,
        },
        scope: nativeScope,
      },
    );
    const occurredAt = new Date().toISOString();
    const result = await reviewNativeWorkPackageEvidence(env, {
      tenantId: auth.session.tenant_id,
      workPackageId: workPackage.id,
      workPackageVersion: workPackage.version,
      jobId: jobName,
      assignmentId: input.assignmentId,
      actorUser: auth.session.user_id,
      actorRole: auth.session.role,
      deviceActionId,
      evidenceEventId,
      evidenceItem: evidence.evidenceItem,
      evidenceSlotId: evidence.slotId,
      disposition: input.disposition,
      correctionReason: input.correctionReason,
      releaseAttemptId: workPackage.releaseAttemptId,
      workObjectType: nativeScope.workObjectType,
      workObjectId: nativeScope.workObjectId,
      physicalContextType: nativeScope.physicalContextType,
      physicalContextId: nativeScope.physicalContextId,
      manifestKey,
      occurredAt,
    });
    return privateAppJson({
      device_action_id: deviceActionId,
      status: "verified",
      server_ref: result.workPackageName,
      cursor: result.eventName,
    });
  } catch (error) {
    return privateAppJson(
      workPackageOfficeActionError(error),
      workPackageOfficeActionStatus(error),
    );
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
  // The recorded code is what a later reconciliation reads to decide what happened.
  // A signature-verified 4xx is neither an outage nor an unverified response, so it
  // records the broker's own reason; the state stays `execution_uncertain` either
  // way, because only the broker knows whether it got as far as the Frappe write.
  const errorCode = brokerFailureErrorCode(
    error,
    ProposalPublicationApprovalBrokerError,
    "proposal_publication_broker_unavailable",
    "proposal_publication_broker_response_unverified",
  );
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

async function createOperatingJobAssignment(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedJobId: string | undefined,
): Promise<Response> {
  if (!["owner", "ops", "production"].includes(auth.session.role)) {
    return privateAppJson({ error: "production_role_required" }, 403);
  }
  if ((env.APP_TENANT_ID ?? "ironwrap").trim() !== auth.session.tenant_id) {
    return privateAppJson({ error: "not_found" }, 404);
  }
  if (!validAppCsrf(req, auth)) {
    return privateAppJson({ error: "csrf_failed" }, 403);
  }
  const requestIdempotencyKey = idempotencyKey(req);
  if (!requestIdempotencyKey) {
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  }
  const roofJobId = decodedPathSegment(encodedJobId ?? "");
  if (!roofJobId || !idText(roofJobId, 8, 200)) {
    return privateAppJson({ error: "not_found" }, 404);
  }
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseOperatingJobAssignment(parsed.value);
  if (!input) {
    return privateAppJson({ error: "invalid_operating_job_assignment" }, 400);
  }
  try {
    const result = await recordOperatingJobAssignment(env, {
      tenantId: auth.session.tenant_id,
      roofJobId,
      expectedRoofJobVersion: input.expectedRoofJobVersion,
      crewId: input.crewId,
      expectedCrewVersion: input.expectedCrewVersion,
      authorityRequirements: input.authorityRequirements,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      supersedesAssignmentId: input.supersedesAssignmentId,
      correctionReason: input.correctionReason,
      actorUserId: auth.session.user_id,
      idempotencyKey: requestIdempotencyKey,
    });
    const assignment = result.assignment;
    return privateAppJson(
      {
        version: 1,
        assignment: {
          id: assignment.assignment_id,
          assignment_version: assignment.assignment_version,
          roof_job_id: assignment.roof_job_id,
          roof_job_version: assignment.roof_job_version,
          crew_id: assignment.crew_id,
          crew_version: assignment.crew_version,
          assigned_users: assignment.assigned_users,
          authority_requirements: assignment.authority_requirements,
          authority_requirements_sha256:
            assignment.authority_requirements_sha256,
          scheduled_start: assignment.scheduled_start,
          scheduled_end: assignment.scheduled_end,
          supersedes_assignment_id: assignment.supersedes_assignment_id,
          correction_reason: assignment.correction_reason,
          actor_user_id: assignment.actor_user_id,
          created_at: assignment.created_at,
        },
        replayed: result.kind === "replayed",
      },
      result.kind === "created" ? 201 : 200,
    );
  } catch (error) {
    return operatingJobAssignmentErrorResponse(error);
  }
}

async function createOperatingWorkObjectAssignment(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  scope: WorkObjectScope,
): Promise<Response> {
  if (!["owner", "ops", "production"].includes(auth.session.role)) {
    return privateAppJson({ error: "production_role_required" }, 403);
  }
  if ((env.APP_TENANT_ID ?? "ironwrap").trim() !== auth.session.tenant_id) {
    return privateAppJson({ error: "not_found" }, 404);
  }
  if (!validAppCsrf(req, auth)) {
    return privateAppJson({ error: "csrf_failed" }, 403);
  }
  const requestIdempotencyKey = idempotencyKey(req);
  if (!requestIdempotencyKey) {
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  }
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseOperatingWorkObjectAssignment(parsed.value);
  if (!input) {
    return privateAppJson(
      { error: "invalid_operating_work_object_assignment" },
      400,
    );
  }
  try {
    const result = await recordOperatingWorkObjectAssignment(env, {
      tenantId: auth.session.tenant_id,
      ...scope,
      assignedUsers: input.assignedUsers,
      authorityRequirements: input.authorityRequirements,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      authorityUserId: input.authorityUserId,
      authorityRole: input.authorityRole,
      supersedesAssignmentId: input.supersedesAssignmentId,
      correctionReason: input.correctionReason,
      actorUserId: auth.session.user_id,
      idempotencyKey: requestIdempotencyKey,
    });
    const assignment = result.assignment;
    return privateAppJson(
      {
        version: 1,
        assignment: {
          id: assignment.assignment_id,
          assignment_version: assignment.assignment_version,
          work_object_type: assignment.work_object_type,
          work_object_id: assignment.work_object_id,
          physical_context_type: assignment.physical_context_type,
          physical_context_id: assignment.physical_context_id,
          assigned_users: assignment.assigned_users,
          authority_requirements: assignment.authority_requirements,
          authority_requirements_sha256:
            assignment.authority_requirements_sha256,
          scheduled_start: assignment.scheduled_start,
          scheduled_end: assignment.scheduled_end,
          authority_user_id: assignment.authority_user_id,
          authority_role: assignment.authority_role,
          supersedes_assignment_id: assignment.supersedes_assignment_id,
          correction_reason: assignment.correction_reason,
          actor_user_id: assignment.actor_user_id,
          created_at: assignment.created_at,
        },
        replayed: result.kind === "replayed",
      },
      result.kind === "created" ? 201 : 200,
    );
  } catch (error) {
    return operatingWorkObjectAssignmentErrorResponse(error);
  }
}

async function createCommercialLeadTriageDecision(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!hasPermission(auth, "approvals:prepare"))
    return privateAppJson({ error: "office_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const requestIdempotencyKey = idempotencyKey(req);
  if (!requestIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_COMMERCIAL_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseCommercialLeadTriageRequest(parsed.value);
  if (!input)
    return privateAppJson(
      { error: "invalid_commercial_lead_triage_request" },
      400,
    );

  const routeInput = {
    tenantId: auth.session.tenant_id,
    leadId: input.leadId,
    expectedLeadVersion: input.expectedLeadVersion,
    lifecycleStatus: input.lifecycleStatus,
    priority: input.priority,
    category: input.category,
    summary: input.summary,
    nextAction: input.nextAction,
    authority: { kind: "policy_permit" as const, permitId: "pending" },
    idempotencyKey: requestIdempotencyKey,
  };
  let command: Readonly<Record<string, unknown>>;
  try {
    command = buildLeadTriageCommand(routeInput);
    const idempotencyKeyHash = await sha256Hex(requestIdempotencyKey);
    const existing = await env.DB.prepare(
      `SELECT * FROM commercial_lead_triage_decisions
        WHERE tenant_id = ? AND idempotency_key_hash = ?`,
    ).bind(auth.session.tenant_id, idempotencyKeyHash)
      .first<CommercialLeadTriageRecord>();
    if (existing) {
      if (
        !existing.policy_permit_id ||
        existing.command_fingerprint !== await commercialCommandFingerprint(command)
      ) {
        return privateAppJson(
          { error: "commercial_triage_idempotency_conflict" },
          409,
        );
      }
      return privateAppJson({
        decision: commercialLeadTriageProjection(existing),
        replayed: true,
        permit: { permit_id: existing.policy_permit_id, replayed: true },
      });
    }
  } catch (error) {
    if (
      error instanceof CommercialAuthorityError ||
      error instanceof CommercialStoreError
    ) {
      return privateAppJson({ error: error.code }, commercialRouteStatus(error.code));
    }
    throw error;
  }

  const lead = await env.DB.prepare(
    `SELECT lead_id, source_envelope_id, source_raw_key, source,
            lifecycle_status, version, updated_at
       FROM operating_leads WHERE tenant_id = ? AND lead_id = ?`,
  ).bind(auth.session.tenant_id, input.leadId).first<{
    lead_id: string;
    source_envelope_id: string;
    source_raw_key: string | null;
    source: string;
    lifecycle_status: string;
    version: number;
    updated_at: string;
  }>();
  if (!lead) return privateAppJson({ error: "commercial_lead_missing" }, 404);
  if (lead.version !== input.expectedLeadVersion)
    return privateAppJson({ error: "commercial_triage_version_conflict" }, 409);

  const now = new Date();
  const nowIso = now.toISOString();

  try {
    const sourceFacts = {
      schema_version: "ironwrap.commercial-lead-source.v1",
      tenant_id: auth.session.tenant_id,
      lead_id: lead.lead_id,
      source_envelope_id: lead.source_envelope_id,
      source_raw_key: lead.source_raw_key,
      source: lead.source,
      lifecycle_status: lead.lifecycle_status,
      version: lead.version,
      updated_at: lead.updated_at,
    };
    const permit = await admitCommercialPermit(env, {
      tenantId: auth.session.tenant_id,
      actor: {
        type: auth.session.role === "owner" ? "owner" : "worker",
        id: auth.session.user_id,
      },
      action: "lead.triage.record",
      aggregate: {
        type: "lead",
        id: input.leadId,
        version: input.expectedLeadVersion,
      },
      command,
      facts: {
        source: "app-api:commercial-lead-triage",
        source_facts: sourceFacts,
        requested_by_user_id: auth.session.user_id,
      },
      factsObservedAt: nowIso,
      evidence: [{
        ref: `d1://operating_leads/${lead.lead_id}/v${lead.version}`,
        sha256: await sha256Hex(canonicalJson(sourceFacts)),
      }],
      idempotencyKey: requestIdempotencyKey,
      expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    }, now);
    const result = await recordLeadTriageDecision(env, {
      ...routeInput,
      authority: { kind: "policy_permit", permitId: permit.permit.permit_id },
    }, now);
    return privateAppJson(
      {
        decision: commercialLeadTriageProjection(result.decision),
        replayed: result.kind === "replayed",
        permit: {
          permit_id: permit.permit.permit_id,
          replayed: permit.kind === "replayed",
        },
      },
      result.kind === "created" ? 201 : 200,
    );
  } catch (error) {
    if (
      error instanceof CommercialAuthorityError ||
      error instanceof CommercialStoreError
    ) {
      return privateAppJson({ error: error.code }, commercialRouteStatus(error.code));
    }
    throw error;
  }
}

async function reconcileCommercialDepositIntent(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!hasPermission(auth, "accounting:review"))
    return privateAppJson({ error: "accounting_review_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const requestIdempotencyKey = idempotencyKey(req);
  if (!requestIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, 1_024);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const acceptanceId = parseCommercialDepositReconcileRequest(parsed.value);
  if (!acceptanceId)
    return privateAppJson({ error: "invalid_commercial_deposit_reconcile_request" }, 400);

  const derivation = await readCommercialDepositDerivation(
    env,
    auth.session.tenant_id,
    acceptanceId,
  );
  if (!derivation)
    return privateAppJson({ error: "commercial_deposit_derivation_missing" }, 404);
  let evidenceRefs: string[] = [];
  try {
    const parsedEvidence = JSON.parse(derivation.evidence_refs_json) as unknown;
    evidenceRefs = Array.isArray(parsedEvidence)
      ? parsedEvidence.flatMap((item) => {
          if (!isRecord(item) || typeof item.ref !== "string") return [];
          return [item.ref];
        })
      : [];
  } catch {
    return privateAppJson({ error: "commercial_deposit_evidence_invalid" }, 409);
  }

  let request;
  try {
    request = await beginCommercialDepositDerivationRequest(env, {
      tenantId: auth.session.tenant_id,
      acceptanceId,
      actorUserId: auth.session.user_id,
      idempotencyKey: requestIdempotencyKey,
      policyVersion: "ironwrap.commercial-deposit-reconcile.v1",
      evidenceRefs,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "commercial_deposit_reconcile_idempotency_conflict")
      return privateAppJson({ error: error.message }, 409);
    return privateAppJson({ error: "commercial_deposit_reconcile_unavailable" }, 502);
  }
  if (!request)
    return privateAppJson({ error: "commercial_deposit_derivation_missing" }, 404);

  // A terminal command receipt is immutable.  Replaying a blocked/failed key must not run the
  // derivation again after facts are repaired; a fresh key is the explicit recovery attempt.
  if (request.replayed && request.request.state !== "pending") {
    if (request.request.state === "failed") {
      return privateAppJson({ error: "commercial_deposit_reconcile_unavailable" }, 502);
    }
    try {
      const current = await readCommercialDepositDerivation(
        env,
        auth.session.tenant_id,
        acceptanceId,
      );
      if (!current)
        return privateAppJson({ error: "commercial_deposit_derivation_missing" }, 404);
      const event = await readCommercialDepositDerivationEvent(
        env,
        auth.session.tenant_id,
        current.derivation_id,
        request.request.derivation_version,
      );
      if (!event) {
        return privateAppJson({ error: "commercial_deposit_reconcile_terminal_unavailable" }, 409);
      }
      const terminalDerivation: CommercialDepositDerivationRecord = {
        ...current,
        state: event.state,
        intent_id: event.intent_id,
        blocker_code: event.blocker_code,
        blocker_next_step: event.blocker_next_step,
        basis_sha256: event.basis_sha256,
        version: event.event_version,
        updated_at: event.occurred_at,
      };
      const intent = event.state === "derived" && event.intent_id
        ? await readAccountingIntent(env, current.tenant_id, event.intent_id)
        : null;
      return privateAppJson({
        version: 1,
        acceptance_id: acceptanceId,
        request: {
          request_id: request.request.request_id,
          state: request.request.state,
          version: request.request.version,
          replayed: true,
        },
        derivation: commercialDepositDerivationRouteProjection(terminalDerivation),
        intent: intent
          ? {
              intent_id: intent.intent_id,
              kind: intent.kind,
              state: intent.state,
              version: intent.version,
              currency: intent.currency,
              total_amount: intent.total_amount,
            }
          : null,
      });
    } catch {
      return privateAppJson({ error: "commercial_deposit_reconcile_unavailable" }, 502);
    }
  }

  try {
    const result = await ensureCommercialDepositDerivation(env, {
      tenantId: auth.session.tenant_id,
      acceptanceId,
    });
    if (!result)
      return privateAppJson({ error: "commercial_deposit_derivation_missing" }, 404);
    const finalRequest = await finishCommercialDepositDerivationRequest(env, {
      tenantId: auth.session.tenant_id,
      requestId: request.request.request_id,
      expectedVersion: request.request.version,
      state: result.derivation.state === "derived" ? "derived" : "blocked",
      derivationVersion: result.derivation.version,
    });
    return privateAppJson({
      version: 1,
      acceptance_id: acceptanceId,
      request: finalRequest
        ? {
            request_id: finalRequest.request_id,
            state: finalRequest.state,
            version: finalRequest.version,
            replayed: request.replayed,
          }
        : { request_id: request.request.request_id, replayed: request.replayed },
      derivation: commercialDepositDerivationRouteProjection(result.derivation),
      intent: result.intent
        ? {
            intent_id: result.intent.intent_id,
            kind: result.intent.kind,
            state: result.intent.state,
            version: result.intent.version,
            currency: result.intent.currency,
            total_amount: result.intent.total_amount,
          }
        : null,
    });
  } catch (error) {
    await finishCommercialDepositDerivationRequest(env, {
      tenantId: auth.session.tenant_id,
      requestId: request.request.request_id,
      expectedVersion: request.request.version,
      state: "failed",
      derivationVersion: derivation.version,
      errorCode: error instanceof Error ? error.message : "commercial_deposit_reconcile_failed",
    }).catch(() => null);
    return privateAppJson({ error: "commercial_deposit_reconcile_unavailable" }, 502);
  }
}

async function createCommercialQuoteRevision(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!hasPermission(auth, "approvals:prepare"))
    return privateAppJson({ error: "office_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const requestIdempotencyKey = idempotencyKey(req);
  if (!requestIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_COMMERCIAL_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseCommercialQuoteRevisionRequest(parsed.value);
  if (!input)
    return privateAppJson(
      { error: "invalid_commercial_quote_revision_request" },
      400,
    );

  const now = new Date();
  const routeInput: RecordCommercialQuoteInput = {
    tenantId: auth.session.tenant_id,
    quoteRevisionId: input.quoteRevisionId,
    customerQuoteId: input.customerQuoteId,
    revisionNumber: input.revisionNumber,
    roofJobId: input.roofJobId,
    customerId: input.customerId,
    supersedesQuoteRevisionId: input.supersedesQuoteRevisionId,
    status: input.status,
    currency: input.currency,
    validUntil: input.validUntil,
    terms: input.terms,
    evidence: input.evidence,
    correctionReason: input.correctionReason,
    lines: input.lines,
    authority: { kind: "policy_permit", permitId: "pending" },
    idempotencyKey: requestIdempotencyKey,
  };

  try {
    const prepared = await prepareCommercialQuote(routeInput);
    const existing = await env.DB.prepare(
      `SELECT policy_permit_id FROM commercial_quote_revisions
        WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
    ).bind(
      auth.session.tenant_id,
      await sha256Hex(requestIdempotencyKey),
    ).first<{ policy_permit_id: string | null }>();
    if (existing) {
      const permit = existing.policy_permit_id
        ? await getCommercialPermit(env, auth.session.tenant_id, existing.policy_permit_id)
        : null;
      if (!permit) return privateAppJson({ error: "commercial_permit_missing" }, 409);
      const expectedActorType = auth.session.role === "owner" ? "owner" : "worker";
      if (permit.actor_type !== expectedActorType || permit.actor_id !== auth.session.user_id) {
        return privateAppJson({ error: "commercial_permit_actor_mismatch" }, 403);
      }
      if (permit.command_fingerprint !== await commercialCommandFingerprint(prepared.command)) {
        return privateAppJson({ error: "commercial_permit_idempotency_conflict" }, 409);
      }
      const result = await recordCommercialQuoteRevision(env, {
        ...routeInput,
        authority: { kind: "policy_permit", permitId: permit.permit_id },
      }, now);
      return privateAppJson(
        {
          quote: commercialQuoteProjection(result.quote, result.lines),
          replayed: true,
          permit: { permit_id: permit.permit_id, replayed: true },
        },
        200,
      );
    }
    const binding = await readCommercialJobBinding(
      env,
      auth.session.tenant_id,
      input.roofJobId,
      input.customerId,
    );
    if (!binding) return privateAppJson({ error: "commercial_job_missing" }, 404);
    if (binding.property_id && !binding.bound_property_id) {
      return privateAppJson({ error: "commercial_property_missing" }, 404);
    }
    if (binding.job_status === "cancelled" || binding.customer_status === "archived") {
      return privateAppJson({ error: "commercial_job_not_active" }, 409);
    }
    const quoteCorrection = input.revisionNumber > 1 && !!input.supersedesQuoteRevisionId;
    if (
      !binding.lead_status ||
      (binding.lead_status !== "qualified" &&
        !(binding.lead_status === "converted" && quoteCorrection))
    ) {
      return privateAppJson({ error: "commercial_lead_not_qualified" }, 409);
    }
    const nowIso = now.toISOString();
    const sourceFacts = {
      schema_version: "ironwrap.commercial-job-binding.v1",
      tenant_id: auth.session.tenant_id,
      roof_job_id: input.roofJobId,
      customer_id: input.customerId,
      property_id: binding.property_id,
      job_version: binding.job_version,
      customer_version: binding.customer_version,
      lead_id: binding.lead_id,
      lead_version: binding.lead_version,
      job_status: binding.job_status,
      customer_status: binding.customer_status,
      lead_status: binding.lead_status,
    };
    const evidence = mergeCommercialEvidence(
      input.evidence,
      `d1://operating_roof_jobs/${input.roofJobId}/v${binding.job_version}`,
      await sha256Hex(canonicalJson(sourceFacts)),
    );
    const command = prepared.command;
    const permit = await admitCommercialPermit(env, {
      tenantId: auth.session.tenant_id,
      actor: {
        type: auth.session.role === "owner" ? "owner" : "worker",
        id: auth.session.user_id,
      },
      action: "quote.revision.record",
      aggregate: {
        type: "customer_quote",
        id: input.customerQuoteId,
        version: input.revisionNumber,
      },
      amountCents: prepared.totalCents,
      command,
      facts: {
        source: "app-api:commercial-quote-revision",
        source_facts: sourceFacts,
        quote_revision_id: input.quoteRevisionId,
        quote_total_cents: prepared.totalCents,
        terms_hash: prepared.termsHash,
        requested_by_user_id: auth.session.user_id,
      },
      factsObservedAt: input.factsObservedAt,
      evidence,
      idempotencyKey: requestIdempotencyKey,
      expiresAt: new Date(Date.parse(input.factsObservedAt) + 30_000).toISOString(),
    }, now);
    const result = await recordCommercialQuoteRevision(env, {
      ...routeInput,
      authority: { kind: "policy_permit", permitId: permit.permit.permit_id },
    }, now);
    return privateAppJson(
      {
        quote: commercialQuoteProjection(result.quote, result.lines),
        replayed: result.kind === "replayed",
        permit: {
          permit_id: permit.permit.permit_id,
          replayed: permit.kind === "replayed",
        },
      },
      result.kind === "created" ? 201 : 200,
    );
  } catch (error) {
    if (error instanceof CommercialAuthorityError || error instanceof CommercialStoreError) {
      return privateAppJson({ error: error.code }, commercialRouteStatus(error.code));
    }
    throw error;
  }
}

async function prepareCommercialProposalPublication(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!hasPermission(auth, "approvals:prepare"))
    return privateAppJson({ error: "office_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const requestIdempotencyKey = idempotencyKey(req);
  if (!requestIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_COMMERCIAL_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseCommercialPublicationPreparation(parsed.value);
  if (!input)
    return privateAppJson(
      { error: "invalid_commercial_publication_request" },
      400,
    );
  const now = new Date();
  const routeInput: RecordCommercialPublicationInput = {
    tenantId: auth.session.tenant_id,
    proposalRevisionId: input.proposalRevisionId,
    proposalPackId: input.proposalPackId,
    publicationVersion: input.publicationVersion,
    previousState: input.previousState,
    state: input.state,
    authority: { kind: "policy_permit", permitId: "pending" },
    externalEffectId: null,
    idempotencyKey: requestIdempotencyKey,
  };
  try {
    const proposal = await env.DB.prepare(
      `SELECT proposal.proposal_revision_id, proposal.proposal_pack_id,
              proposal.quote_revision_id, proposal.roof_job_id, proposal.customer_id,
              proposal.terms_hash, quote.customer_quote_id, quote.status AS quote_status,
              quote.revision_number AS quote_revision_number,
              quote.supersedes_quote_revision_id,
              job.version AS job_version, customer.version AS customer_version,
              lead.lead_id, lead.version AS lead_version,
              job.property_id, job.job_status, customer.lifecycle_status AS customer_status,
              lead.lifecycle_status AS lead_status
         FROM commercial_proposal_revisions proposal
         JOIN commercial_quote_revisions quote
           ON quote.tenant_id = proposal.tenant_id
          AND quote.quote_revision_id = proposal.quote_revision_id
         JOIN operating_roof_jobs job
           ON job.tenant_id = proposal.tenant_id AND job.roof_job_id = proposal.roof_job_id
         JOIN operating_customers customer
           ON customer.tenant_id = proposal.tenant_id AND customer.customer_id = proposal.customer_id
         JOIN operating_leads lead
           ON lead.tenant_id = proposal.tenant_id AND lead.lead_id = job.lead_id
        WHERE proposal.tenant_id = ? AND proposal.proposal_revision_id = ?
          AND proposal.proposal_pack_id = ? LIMIT 1`,
    ).bind(
      auth.session.tenant_id,
      input.proposalRevisionId,
      input.proposalPackId,
    ).first<CommercialPublicationFacts>();
    if (!proposal) return privateAppJson({ error: "commercial_publication_proposal_missing" }, 404);
    if (proposal.quote_status !== "approved") {
      return privateAppJson({ error: "commercial_publication_quote_not_approved" }, 409);
    }
    // A proposal is not sent again until its last send is confirmed delivered: a second send
    // while the first is pending or unknown could reach the customer twice.
    if (input.state === "published") {
      const pending = await unconfirmedProposalDelivery(
        env,
        auth.session.tenant_id,
        input.proposalPackId,
        input.proposalRevisionId,
      );
      if (pending) {
        return privateAppJson({
          error: "proposal_delivery_unconfirmed",
          delivery_state: pending.state,
          external_effect_id: pending.effect_id,
          next_step: "check_delivery",
        }, 409);
      }
    }
    if (proposal.job_status === "cancelled" || proposal.customer_status === "archived") {
      return privateAppJson({ error: "commercial_job_not_active" }, 409);
    }
    const proposalCorrection =
      proposal.quote_revision_number > 1 && !!proposal.supersedes_quote_revision_id;
    if (
      !proposal.lead_status ||
      (proposal.lead_status !== "qualified" &&
        !(proposal.lead_status === "converted" && proposalCorrection))
    ) {
      return privateAppJson({ error: "commercial_lead_not_qualified" }, 409);
    }
    const sourceFacts = {
      schema_version: "ironwrap.commercial-publication-source.v1",
      tenant_id: auth.session.tenant_id,
      proposal_revision_id: input.proposalRevisionId,
      proposal_pack_id: input.proposalPackId,
      quote_revision_id: proposal.quote_revision_id,
      roof_job_id: proposal.roof_job_id,
      customer_id: proposal.customer_id,
      customer_quote_id: proposal.customer_quote_id,
      terms_hash: proposal.terms_hash,
      job_version: proposal.job_version,
      customer_version: proposal.customer_version,
      lead_id: proposal.lead_id,
      lead_version: proposal.lead_version,
    };
    const evidence = mergeCommercialEvidence(
      input.evidence,
      `d1://commercial_proposal_revisions/${input.proposalRevisionId}`,
      await sha256Hex(canonicalJson(sourceFacts)),
    );
    const command = buildCommercialPublicationCommand(routeInput);
    const permit = await admitCommercialPermit(env, {
      tenantId: auth.session.tenant_id,
      actor: {
        type: auth.session.role === "owner" ? "owner" : "worker",
        id: auth.session.user_id,
      },
      action: input.state === "published" ? "proposal.publish" : "proposal.withdraw",
      aggregate: {
        type: "proposal_publication",
        id: input.proposalPackId,
        version: input.publicationVersion,
      },
      command,
      facts: {
        source: "app-api:commercial-proposal-publication",
        source_facts: sourceFacts,
        requested_by_user_id: auth.session.user_id,
      },
      factsObservedAt: input.factsObservedAt,
      evidence,
      idempotencyKey: requestIdempotencyKey,
      expiresAt: new Date(Date.parse(input.factsObservedAt) + 30_000).toISOString(),
    }, now);
    return privateAppJson({
      publication: {
        proposal_revision_id: input.proposalRevisionId,
        proposal_pack_id: input.proposalPackId,
        publication_version: input.publicationVersion,
        previous_state: input.previousState,
        state: input.state,
        status: "awaiting_succeeded_effect",
      },
      permit: {
        permit_id: permit.permit.permit_id,
        policy_ref: permit.permit.policy_id,
        policy_version: permit.permit.policy_version,
        actor_type: permit.permit.actor_type,
        actor_id: permit.permit.actor_id,
        action: permit.permit.action,
        aggregate_type: permit.permit.aggregate_type,
        aggregate_id: permit.permit.aggregate_id,
        aggregate_version: permit.permit.aggregate_version,
        expires_at: permit.permit.expires_at,
        replayed: permit.kind === "replayed",
      },
    }, permit.kind === "created" ? 201 : 200);
  } catch (error) {
    if (error instanceof CommercialAuthorityError || error instanceof CommercialStoreError) {
      return privateAppJson({ error: error.code }, commercialRouteStatus(error.code));
    }
    throw error;
  }
}

async function settleCommercialProposalPublication(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!hasPermission(auth, "approvals:prepare"))
    return privateAppJson({ error: "office_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const requestIdempotencyKey = idempotencyKey(req);
  if (!requestIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_COMMERCIAL_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseCommercialPublicationSettlement(parsed.value);
  if (!input)
    return privateAppJson(
      { error: "invalid_commercial_publication_settlement" },
      400,
    );
  try {
    const permit = await getCommercialPermit(
      env,
      auth.session.tenant_id,
      input.permitId,
    );
    if (!permit) return privateAppJson({ error: "commercial_permit_missing" }, 404);
    const expectedActorType = auth.session.role === "owner" ? "owner" : "worker";
    if (
      permit.actor_type !== expectedActorType ||
      permit.actor_id !== auth.session.user_id
    ) {
      return privateAppJson({ error: "commercial_permit_actor_mismatch" }, 403);
    }
    const result = await recordCommercialProposalPublication(env, {
      tenantId: auth.session.tenant_id,
      proposalRevisionId: input.proposalRevisionId,
      proposalPackId: input.proposalPackId,
      publicationVersion: input.publicationVersion,
      previousState: input.previousState,
      state: input.state,
      authority: { kind: "policy_permit", permitId: permit.permit_id },
      externalEffectId: input.externalEffectId,
      idempotencyKey: requestIdempotencyKey,
    }, new Date());
    return privateAppJson(
      {
        publication: commercialPublicationProjection(result.publication),
        replayed: result.kind === "replayed",
        permit: { permit_id: permit.permit_id },
      },
      result.kind === "created" ? 201 : 200,
    );
  } catch (error) {
    if (error instanceof CommercialAuthorityError || error instanceof CommercialStoreError) {
      return privateAppJson({ error: error.code }, commercialRouteStatus(error.code));
    }
    throw error;
  }
}

async function createCommercialProposalRevision(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!hasPermission(auth, "approvals:prepare"))
    return privateAppJson({ error: "office_role_required" }, 403);
  if (!validAppCsrf(req, auth))
    return privateAppJson({ error: "csrf_failed" }, 403);
  const requestIdempotencyKey = idempotencyKey(req);
  if (!requestIdempotencyKey)
    return privateAppJson({ error: "idempotency_key_required" }, 400);
  const parsed = await readJson(req, MAX_COMMERCIAL_BODY_BYTES);
  if (!parsed.ok) return privateAppJson({ error: parsed.error }, parsed.status);
  const input = parseCommercialProposalRevisionRequest(parsed.value);
  if (!input)
    return privateAppJson(
      { error: "invalid_commercial_proposal_revision_request" },
      400,
    );

  const now = new Date();
  const routeInput = {
    tenantId: auth.session.tenant_id,
    proposalRevisionId: input.proposalRevisionId,
    proposalPackId: input.proposalPackId,
    revisionNumber: input.revisionNumber,
    quoteRevisionId: input.quoteRevisionId,
    roofJobId: input.roofJobId,
    customerId: input.customerId,
    supersedesProposalRevisionId: input.supersedesProposalRevisionId,
    title: input.title,
    summary: input.summary,
    terms: input.terms,
    contentRef: input.contentRef,
    contentHash: input.contentHash,
    evidence: input.evidence,
    authority: { kind: "policy_permit" as const, permitId: "pending" },
    idempotencyKey: requestIdempotencyKey,
  };

  try {
    const prepared = await prepareCommercialProposal(routeInput);
    const existing = await env.DB.prepare(
      `SELECT policy_permit_id FROM commercial_proposal_revisions
        WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
    ).bind(
      auth.session.tenant_id,
      await sha256Hex(requestIdempotencyKey),
    ).first<{ policy_permit_id: string | null }>();
    if (existing) {
      const permit = existing.policy_permit_id
        ? await getCommercialPermit(env, auth.session.tenant_id, existing.policy_permit_id)
        : null;
      if (!permit) return privateAppJson({ error: "commercial_permit_missing" }, 409);
      const expectedActorType = auth.session.role === "owner" ? "owner" : "worker";
      if (permit.actor_type !== expectedActorType || permit.actor_id !== auth.session.user_id) {
        return privateAppJson({ error: "commercial_permit_actor_mismatch" }, 403);
      }
      if (permit.command_fingerprint !== await commercialCommandFingerprint(prepared.command)) {
        return privateAppJson({ error: "commercial_permit_idempotency_conflict" }, 409);
      }
      const result = await recordCommercialProposalRevision(env, {
        ...routeInput,
        authority: { kind: "policy_permit", permitId: permit.permit_id },
      }, now);
      return privateAppJson(
        {
          proposal: commercialProposalProjection(result.proposal),
          replayed: true,
          permit: { permit_id: permit.permit_id, replayed: true },
        },
        200,
      );
    }
    const binding = await readCommercialJobBinding(
      env,
      auth.session.tenant_id,
      input.roofJobId,
      input.customerId,
    );
    if (!binding) return privateAppJson({ error: "commercial_job_missing" }, 404);
    const quoteCorrection = await env.DB.prepare(
      `SELECT revision_number, supersedes_quote_revision_id
         FROM commercial_quote_revisions
        WHERE tenant_id = ? AND quote_revision_id = ? LIMIT 1`,
    ).bind(auth.session.tenant_id, input.quoteRevisionId).first<{
      revision_number: number;
      supersedes_quote_revision_id: string | null;
    }>();
    const proposalCorrection =
      (input.revisionNumber > 1 && !!input.supersedesProposalRevisionId) ||
      (!!quoteCorrection && quoteCorrection.revision_number > 1 && !!quoteCorrection.supersedes_quote_revision_id);
    if (
      !binding.lead_status ||
      (binding.lead_status !== "qualified" &&
        !(binding.lead_status === "converted" && proposalCorrection))
    ) {
      return privateAppJson({ error: "commercial_lead_not_qualified" }, 409);
    }
    const factsObservedAt = input.factsObservedAt;
    const permit = await admitCommercialPermit(env, {
      tenantId: auth.session.tenant_id,
      actor: {
        type: auth.session.role === "owner" ? "owner" : "worker",
        id: auth.session.user_id,
      },
      action: "proposal.revision.record",
      aggregate: {
        type: "proposal",
        id: input.proposalPackId,
        version: input.revisionNumber,
      },
      command: prepared.command,
      facts: {
        source: "app-api:commercial-proposal-revision",
        proposal_revision_id: input.proposalRevisionId,
        proposal_pack_id: input.proposalPackId,
        quote_revision_id: input.quoteRevisionId,
        roof_job_id: input.roofJobId,
        customer_id: input.customerId,
        content_hash: input.contentHash,
        terms_hash: prepared.termsHash,
        requested_by_user_id: auth.session.user_id,
      },
      factsObservedAt,
      evidence: input.evidence,
      idempotencyKey: requestIdempotencyKey,
      expiresAt: new Date(Date.parse(factsObservedAt) + 30_000).toISOString(),
    }, now);
    const result = await recordCommercialProposalRevision(env, {
      ...routeInput,
      authority: { kind: "policy_permit", permitId: permit.permit.permit_id },
    }, now);
    return privateAppJson(
      {
        proposal: commercialProposalProjection(result.proposal),
        replayed: result.kind === "replayed",
        permit: {
          permit_id: permit.permit.permit_id,
          replayed: permit.kind === "replayed",
        },
      },
      result.kind === "created" ? 201 : 200,
    );
  } catch (error) {
    if (
      error instanceof CommercialAuthorityError ||
      error instanceof CommercialStoreError
    ) {
      return privateAppJson(
        { error: error.code },
        commercialRouteStatus(error.code),
      );
    }
    throw error;
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

function parseOperatingJobAssignment(value: unknown): {
  expectedRoofJobVersion: number;
  crewId: string;
  expectedCrewVersion: number;
  authorityRequirements: ReturnType<typeof parseAuthorityRequirements>;
  scheduledStart: string;
  scheduledEnd: string | null;
  supersedesAssignmentId: string | null;
  correctionReason: string | null;
} | null {
  const requiredKeys = [
    "expected_roof_job_version",
    "crew_id",
    "expected_crew_version",
    "authority_requirements",
    "scheduled_start",
    "scheduled_end",
    "supersedes_assignment_id",
    "correction_reason",
  ];
  if (
    !isRecord(value) ||
    !onlyKeys(value, requiredKeys) ||
    !requiredKeys.every((key) => Object.hasOwn(value, key))
  ) return null;
  const expectedRoofJobVersion = validVersion(value.expected_roof_job_version);
  const crewId = idText(value.crew_id, 8, 200);
  const expectedCrewVersion = validVersion(value.expected_crew_version);
  let authorityRequirements: ReturnType<typeof parseAuthorityRequirements>;
  try {
    authorityRequirements = parseAuthorityRequirements(
      value.authority_requirements,
    );
  } catch {
    return null;
  }
  const scheduledStart = normalizedIso(value.scheduled_start);
  const scheduledEnd = value.scheduled_end === null
    ? null
    : normalizedIso(value.scheduled_end);
  const supersedesAssignmentId = value.supersedes_assignment_id === null
    ? null
    : idText(value.supersedes_assignment_id, 12, 200);
  const correctionReason = value.correction_reason === null
    ? null
    : boundedText(value.correction_reason, 3, 1_200);
  if (
    !expectedRoofJobVersion ||
    !crewId ||
    !expectedCrewVersion ||
    !scheduledStart ||
    (value.scheduled_end !== null && !scheduledEnd) ||
    (value.supersedes_assignment_id !== null && !supersedesAssignmentId) ||
    (value.correction_reason !== null && !correctionReason) ||
    (scheduledEnd !== null && Date.parse(scheduledEnd) <= Date.parse(scheduledStart)) ||
    (supersedesAssignmentId === null) !== (correctionReason === null)
  ) return null;
  return {
    expectedRoofJobVersion,
    crewId,
    expectedCrewVersion,
    authorityRequirements,
    scheduledStart,
    scheduledEnd,
    supersedesAssignmentId,
    correctionReason,
  };
}

function parseOperatingWorkObjectAssignment(value: unknown): {
  assignedUsers: string[];
  authorityRequirements: ReturnType<typeof parseAuthorityRequirements>;
  scheduledStart: string;
  scheduledEnd: string | null;
  authorityUserId: string;
  authorityRole: "owner" | "production";
  supersedesAssignmentId: string | null;
  correctionReason: string | null;
} | null {
  const requiredKeys = [
    "assigned_users",
    "authority_requirements",
    "scheduled_start",
    "scheduled_end",
    "authority_user_id",
    "authority_role",
    "supersedes_assignment_id",
    "correction_reason",
  ];
  if (
    !isRecord(value) ||
    !onlyKeys(value, requiredKeys) ||
    !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    !Array.isArray(value.assigned_users) ||
    value.assigned_users.length < 1 ||
    value.assigned_users.length > 50
  ) {
    return null;
  }
  const assignedUsers = value.assigned_users.map((user) =>
    idText(user, 8, 200),
  );
  let authorityRequirements: ReturnType<typeof parseAuthorityRequirements>;
  try {
    authorityRequirements = parseAuthorityRequirements(
      value.authority_requirements,
    );
  } catch {
    return null;
  }
  const scheduledStart = normalizedIso(value.scheduled_start);
  const scheduledEnd =
    value.scheduled_end === null ? null : normalizedIso(value.scheduled_end);
  const authorityUserId = idText(value.authority_user_id, 8, 200);
  const authorityRole =
    value.authority_role === "owner" || value.authority_role === "production"
      ? value.authority_role
      : null;
  const supersedesAssignmentId =
    value.supersedes_assignment_id === null
      ? null
      : idText(value.supersedes_assignment_id, 12, 200);
  const correctionReason =
    value.correction_reason === null
      ? null
      : boundedText(value.correction_reason, 3, 1_200);
  if (
    assignedUsers.some((user) => !user) ||
    new Set(assignedUsers.map((user) => user!.toLowerCase())).size !==
      assignedUsers.length ||
    !scheduledStart ||
    (value.scheduled_end !== null && !scheduledEnd) ||
    (scheduledEnd !== null &&
      Date.parse(scheduledEnd) <= Date.parse(scheduledStart)) ||
    !authorityUserId ||
    !authorityRole ||
    (value.supersedes_assignment_id !== null && !supersedesAssignmentId) ||
    (value.correction_reason !== null && !correctionReason) ||
    (supersedesAssignmentId === null) !== (correctionReason === null)
  ) {
    return null;
  }
  return {
    assignedUsers: assignedUsers as string[],
    authorityRequirements,
    scheduledStart,
    scheduledEnd,
    authorityUserId,
    authorityRole,
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

function parseCommercialLeadTriageRequest(value: unknown): {
  leadId: string;
  expectedLeadVersion: number;
  lifecycleStatus: "triaged" | "qualified" | "disqualified";
  priority: "low" | "normal" | "high" | "urgent";
  category: string;
  summary: string;
  nextAction: string;
} | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "lead_id",
      "expected_lead_version",
      "lifecycle_status",
      "priority",
      "category",
      "summary",
      "next_action",
    ])
  ) return null;
  const leadId = idText(value.lead_id, 8, 200);
  const expectedLeadVersion = validVersion(value.expected_lead_version);
  const lifecycleStatus = ["triaged", "qualified", "disqualified"].includes(
      String(value.lifecycle_status),
    )
    ? value.lifecycle_status as "triaged" | "qualified" | "disqualified"
    : null;
  const priority = ["low", "normal", "high", "urgent"].includes(
      String(value.priority),
    )
    ? value.priority as "low" | "normal" | "high" | "urgent"
    : null;
  const category = boundedText(value.category, 2, 80);
  const summary = boundedText(value.summary, 1, 2_000);
  const nextAction = boundedText(value.next_action, 1, 500);
  return leadId && expectedLeadVersion && lifecycleStatus && priority &&
      category && summary && nextAction
    ? {
        leadId,
        expectedLeadVersion,
        lifecycleStatus,
        priority,
        category,
        summary,
        nextAction,
      }
    : null;
}

function parseCommercialQuoteRevisionRequest(value: unknown): {
  quoteRevisionId: string;
  customerQuoteId: string;
  revisionNumber: number;
  roofJobId: string;
  customerId: string;
  factsObservedAt: string;
  supersedesQuoteRevisionId?: string | null;
  status: CommercialQuoteStatus;
  currency: string;
  validUntil: string;
  terms: unknown;
  correctionReason?: string | null;
  lines: CommercialQuoteLineInput[];
  evidence: Array<{ ref: string; sha256: string }>;
} | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "quote_revision_id",
      "customer_quote_id",
      "revision_number",
      "roof_job_id",
      "customer_id",
      "facts_observed_at",
      "supersedes_quote_revision_id",
      "status",
      "currency",
      "valid_until",
      "terms",
      "correction_reason",
      "lines",
      "evidence",
    ]) ||
    !Array.isArray(value.lines)
  ) return null;
  const quoteRevisionId = idText(value.quote_revision_id, 12, 160);
  const customerQuoteId = idText(value.customer_quote_id, 8, 160);
  const revisionNumber = validVersion(value.revision_number);
  const roofJobId = idText(value.roof_job_id, 8, 200);
  const customerId = idText(value.customer_id, 8, 200);
  const factsObservedAt = normalizedIso(value.facts_observed_at);
  const supersedesQuoteRevisionId =
    value.supersedes_quote_revision_id === undefined ||
      value.supersedes_quote_revision_id === null
      ? value.supersedes_quote_revision_id ?? undefined
      : idText(value.supersedes_quote_revision_id, 12, 160);
  const status = ["draft", "needs_review", "approved", "rejected", "expired"].includes(
    String(value.status),
  ) ? value.status as CommercialQuoteStatus : null;
  const currency = typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency)
    ? value.currency
    : null;
  const validUntil = isoDateOnly(value.valid_until);
  const correctionReason =
    value.correction_reason === undefined || value.correction_reason === null
      ? value.correction_reason ?? undefined
      : boundedText(value.correction_reason, 3, 2_000);
  const lines = commercialQuoteLines(value.lines);
  const evidence = commercialEvidence(value.evidence);
  if (
    !quoteRevisionId || !customerQuoteId || !revisionNumber || !roofJobId || !customerId ||
    !factsObservedAt || supersedesQuoteRevisionId === null || !status || !currency ||
    !validUntil || !Object.hasOwn(value, "terms") || correctionReason === null ||
    !lines || !evidence
  ) return null;
  return {
    quoteRevisionId,
    customerQuoteId,
    revisionNumber,
    roofJobId,
    customerId,
    factsObservedAt,
    supersedesQuoteRevisionId,
    status,
    currency,
    validUntil,
    terms: value.terms,
    correctionReason,
    lines,
    evidence,
  };
}

function parseCommercialProposalRevisionRequest(value: unknown): {
  proposalRevisionId: string;
  proposalPackId: string;
  revisionNumber: number;
  quoteRevisionId: string;
  roofJobId: string;
  customerId: string;
  factsObservedAt: string;
  supersedesProposalRevisionId?: string | null;
  title: string;
  summary: string;
  terms: unknown;
  contentRef: string;
  contentHash: string;
  evidence: Array<{ ref: string; sha256: string }>;
} | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "proposal_revision_id",
      "proposal_pack_id",
      "revision_number",
      "quote_revision_id",
      "roof_job_id",
      "customer_id",
      "facts_observed_at",
      "supersedes_proposal_revision_id",
      "title",
      "summary",
      "terms",
      "content_ref",
      "content_hash",
      "evidence",
    ])
  ) return null;
  const proposalRevisionId = idText(value.proposal_revision_id, 12, 160);
  const proposalPackId = idText(value.proposal_pack_id, 8, 160);
  const revisionNumber = validVersion(value.revision_number);
  const quoteRevisionId = idText(value.quote_revision_id, 12, 160);
  const roofJobId = idText(value.roof_job_id, 8, 200);
  const customerId = idText(value.customer_id, 8, 200);
  const factsObservedAt = normalizedIso(value.facts_observed_at);
  const supersedesProposalRevisionId =
    value.supersedes_proposal_revision_id === undefined ||
      value.supersedes_proposal_revision_id === null
      ? value.supersedes_proposal_revision_id ?? undefined
      : idText(value.supersedes_proposal_revision_id, 12, 160);
  const title = boundedText(value.title, 1, 200);
  const summary = boundedText(value.summary, 1, 4_000);
  const contentRef = commercialContentRef(value.content_ref);
  const contentHash = commercialSha256(value.content_hash);
  const evidence = commercialEvidence(value.evidence);
  if (
    !proposalRevisionId ||
    !proposalPackId ||
    !revisionNumber ||
    !quoteRevisionId ||
    !roofJobId ||
    !customerId ||
    !factsObservedAt ||
    supersedesProposalRevisionId === null ||
    !title ||
    !summary ||
    !contentRef ||
    !contentHash ||
    !evidence ||
    !Object.hasOwn(value, "terms")
  ) return null;
  return {
    proposalRevisionId,
    proposalPackId,
    revisionNumber,
    quoteRevisionId,
    roofJobId,
    customerId,
    factsObservedAt,
    supersedesProposalRevisionId,
    title,
    summary,
    terms: value.terms,
    contentRef,
    contentHash,
    evidence,
  };
}

function parseCommercialPublicationPreparation(value: unknown): {
  proposalRevisionId: string;
  proposalPackId: string;
  publicationVersion: number;
  previousState: CommercialPublicationState;
  state: Exclude<CommercialPublicationState, "draft">;
  factsObservedAt: string;
  evidence: Array<{ ref: string; sha256: string }>;
} | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "proposal_revision_id",
      "proposal_pack_id",
      "publication_version",
      "previous_state",
      "state",
      "facts_observed_at",
      "evidence",
    ])
  ) return null;
  const proposalRevisionId = idText(value.proposal_revision_id, 12, 160);
  const proposalPackId = idText(value.proposal_pack_id, 8, 160);
  const publicationVersion = validVersion(value.publication_version);
  const previousState = ["draft", "published", "withdrawn"].includes(
    String(value.previous_state),
  ) ? value.previous_state as CommercialPublicationState : null;
  const state = ["published", "withdrawn"].includes(String(value.state))
    ? value.state as Exclude<CommercialPublicationState, "draft">
    : null;
  const factsObservedAt = normalizedIso(value.facts_observed_at);
  const evidence = commercialEvidence(value.evidence);
  return proposalRevisionId && proposalPackId && publicationVersion && previousState && state &&
      factsObservedAt && evidence
    ? {
        proposalRevisionId,
        proposalPackId,
        publicationVersion,
        previousState,
        state,
        factsObservedAt,
        evidence,
      }
    : null;
}

function parseCommercialPublicationSettlement(value: unknown): {
  proposalRevisionId: string;
  proposalPackId: string;
  publicationVersion: number;
  previousState: CommercialPublicationState;
  state: Exclude<CommercialPublicationState, "draft">;
  permitId: string;
  externalEffectId: string;
} | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "proposal_revision_id",
      "proposal_pack_id",
      "publication_version",
      "previous_state",
      "state",
      "permit_id",
      "external_effect_id",
    ])
  ) return null;
  const proposalRevisionId = idText(value.proposal_revision_id, 12, 160);
  const proposalPackId = idText(value.proposal_pack_id, 8, 160);
  const publicationVersion = validVersion(value.publication_version);
  const previousState = ["draft", "published", "withdrawn"].includes(
    String(value.previous_state),
  ) ? value.previous_state as CommercialPublicationState : null;
  const state = ["published", "withdrawn"].includes(String(value.state))
    ? value.state as Exclude<CommercialPublicationState, "draft">
    : null;
  const permitId = idText(value.permit_id, 20, 180);
  const externalEffectId = idText(value.external_effect_id, 16, 160);
  return proposalRevisionId && proposalPackId && publicationVersion && previousState && state &&
      permitId && externalEffectId
    ? { proposalRevisionId, proposalPackId, publicationVersion, previousState, state, permitId, externalEffectId }
    : null;
}

function parseCommercialDepositReconcileRequest(value: unknown): string | null {
  if (!isRecord(value) || !onlyKeys(value, ["acceptance_id"])) return null;
  return idText(value.acceptance_id, 16, 160);
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

interface OfficeWorkPackageIssueInput {
  assignmentId: string;
  assignmentModified: string;
  version: number;
  issuedAt: string;
  expiresAt: string;
  title: string;
  objective: string;
  boundaries: string;
  prerequisites: string;
  expectedResult: string;
  stopConditions: string;
  makeSafeProcedure: string;
  correctionReason: string | null;
  steps: NativeWorkPackageStep[];
  holdPoints: NativeWorkPackageHoldPoint[];
}

function parseOfficeWorkPackageIssue(
  value: unknown,
): OfficeWorkPackageIssueInput | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "assignment_id",
      "assignment_modified",
      "version",
      "issued_at",
      "expires_at",
      "title",
      "objective",
      "boundaries",
      "prerequisites",
      "expected_result",
      "stop_conditions",
      "make_safe_procedure",
      "correction_reason",
      "steps",
      "hold_points",
    ]) ||
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > 100 ||
    !Array.isArray(value.hold_points) ||
    value.hold_points.length < 1 ||
    value.hold_points.length > 100
  )
    return null;
  const assignmentId = boundedText(value.assignment_id, 1, 140);
  const assignmentModified = normalizedIso(value.assignment_modified);
  const version = validVersion(value.version);
  const issuedAt = normalizedIso(value.issued_at);
  const expiresAt = normalizedIso(value.expires_at);
  const title = boundedText(value.title, 1, 200);
  const objective = boundedText(value.objective, 1, 4_000);
  const boundaries = boundedText(value.boundaries, 1, 4_000);
  const prerequisites = boundedText(value.prerequisites, 1, 4_000);
  const expectedResult = boundedText(value.expected_result, 1, 4_000);
  const stopConditions = boundedText(value.stop_conditions, 1, 4_000);
  const makeSafeProcedure = boundedText(value.make_safe_procedure, 1, 4_000);
  const correctionReason =
    value.correction_reason === null || value.correction_reason === undefined
      ? null
      : boundedText(value.correction_reason, 1, 2_000);
  if (
    !assignmentId ||
    !assignmentModified ||
    !version ||
    !issuedAt ||
    !expiresAt ||
    Date.parse(expiresAt) <= Date.parse(issuedAt) ||
    !title ||
    !objective ||
    !boundaries ||
    !prerequisites ||
    !expectedResult ||
    !stopConditions ||
    !makeSafeProcedure ||
    (value.correction_reason !== null &&
      value.correction_reason !== undefined &&
      !correctionReason)
  )
    return null;

  const steps: NativeWorkPackageStep[] = [];
  for (const [index, raw] of value.steps.entries()) {
    if (
      !isRecord(raw) ||
      !onlyKeys(raw, [
        "instruction",
        "required_evidence",
        "acceptance_criteria",
      ])
    )
      return null;
    const instruction = boundedText(raw.instruction, 1, 4_000);
    const requiredEvidence = boundedText(raw.required_evidence, 1, 2_000);
    const acceptanceCriteria = boundedText(raw.acceptance_criteria, 1, 2_000);
    if (!instruction || !requiredEvidence || !acceptanceCriteria) return null;
    steps.push({
      sequence: index + 1,
      instruction,
      requiredEvidence,
      acceptanceCriteria,
    });
  }
  const holdPoints: NativeWorkPackageHoldPoint[] = [];
  for (const [index, raw] of value.hold_points.entries()) {
    if (
      !isRecord(raw) ||
      !onlyKeys(raw, [
        "hold_point",
        "release_phase",
        "release_authority",
        "required_evidence",
        "acceptance_criteria",
      ])
    )
      return null;
    const holdPoint = boundedText(raw.hold_point, 1, 4_000);
    const releasePhase =
      raw.release_phase === "Pre-start" ||
      raw.release_phase === "In-process" ||
      raw.release_phase === "Completion"
        ? raw.release_phase
        : null;
    const releaseAuthority = boundedText(raw.release_authority, 1, 140);
    const requiredEvidence = boundedText(raw.required_evidence, 1, 2_000);
    const acceptanceCriteria = boundedText(raw.acceptance_criteria, 1, 2_000);
    if (
      !holdPoint ||
      !releasePhase ||
      !releaseAuthority ||
      !requiredEvidence ||
      !acceptanceCriteria
    )
      return null;
    holdPoints.push({
      sequence: index + 1,
      holdPoint,
      releasePhase,
      releaseAuthority,
      requiredEvidence,
      acceptanceCriteria,
    });
  }
  return {
    assignmentId,
    assignmentModified,
    version,
    issuedAt,
    expiresAt,
    title,
    objective,
    boundaries,
    prerequisites,
    expectedResult,
    stopConditions,
    makeSafeProcedure,
    correctionReason,
    steps,
    holdPoints,
  };
}

function parseOfficeWorkPackageHoldRelease(value: unknown): {
  assignmentId: string;
  workPackageId: string;
  workPackageVersion: number;
} | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "assignment_id",
      "work_package_id",
      "work_package_version",
    ])
  )
    return null;
  const assignmentId = boundedText(value.assignment_id, 1, 140);
  const workPackageId = boundedText(value.work_package_id, 1, 140);
  const workPackageVersion = validVersion(value.work_package_version);
  return assignmentId && workPackageId && workPackageVersion
    ? { assignmentId, workPackageId, workPackageVersion }
    : null;
}

function parseOfficeWorkPackageEvidenceReview(value: unknown): {
  assignmentId: string;
  workPackageId: string;
  workPackageVersion: number;
  disposition: "Accepted" | "Needs Correction";
  correctionReason: string | null;
} | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "assignment_id",
      "work_package_id",
      "work_package_version",
      "disposition",
      "correction_reason",
    ])
  ) {
    return null;
  }
  const assignmentId = boundedText(value.assignment_id, 1, 140);
  const workPackageId = boundedText(value.work_package_id, 1, 140);
  const workPackageVersion = validVersion(value.work_package_version);
  const disposition =
    value.disposition === "Accepted" || value.disposition === "Needs Correction"
      ? value.disposition
      : null;
  const correctionReason =
    value.correction_reason === null || value.correction_reason === undefined
      ? null
      : boundedText(value.correction_reason, 1, 2_000);
  if (!assignmentId || !workPackageId || !workPackageVersion || !disposition)
    return null;
  if (disposition === "Needs Correction" && !correctionReason) return null;
  if (disposition === "Accepted" && correctionReason) return null;
  return {
    assignmentId,
    workPackageId,
    workPackageVersion,
    disposition,
    correctionReason,
  };
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

function estimatorIdempotencyKey(req: Request): string | null {
  const value = req.headers.get("idempotency-key")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{16,160}$/.test(value) ? value : null;
}

function estimatorEvidenceImportBody(value: unknown): {
  measurementReceiptId: string;
  facetEventId: string | null;
  estimatorReadyEventId: string | null;
  commercialQuoteRevisionId: string | null;
  revisionNumber: number;
  supersedesEstimatorRevisionId: string | null;
  correctionReason: string | null;
} | null {
  if (!isRecord(value)) return null;
  const allowed = new Set([
    "measurement_receipt_id",
    "facet_event_id",
    "estimator_ready_event_id",
    "commercial_quote_revision_id",
    "revision_number",
    "supersedes_estimator_revision_id",
    "correction_reason",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const measurementReceiptId = exactEstimatorIdentifier(
    value.measurement_receipt_id,
    20,
    120,
  );
  const revisionNumber = validVersion(value.revision_number);
  const facetEventId = optionalEstimatorIdentifier(
    value.facet_event_id,
    8,
    200,
  );
  const estimatorReadyEventId = optionalEstimatorIdentifier(
    value.estimator_ready_event_id,
    8,
    200,
  );
  const commercialQuoteRevisionId = optionalEstimatorIdentifier(
    value.commercial_quote_revision_id,
    8,
    200,
  );
  const supersedesEstimatorRevisionId = optionalEstimatorIdentifier(
    value.supersedes_estimator_revision_id,
    20,
    200,
  );
  const correctionReason = optionalEstimatorText(
    value.correction_reason,
    3,
    2_000,
  );
  if (!measurementReceiptId || !revisionNumber) return null;
  if (
    (value.facet_event_id !== undefined && facetEventId === undefined) ||
    (value.estimator_ready_event_id !== undefined && estimatorReadyEventId === undefined) ||
    (value.commercial_quote_revision_id !== undefined &&
      commercialQuoteRevisionId === undefined) ||
    (value.supersedes_estimator_revision_id !== undefined &&
      supersedesEstimatorRevisionId === undefined) ||
    (value.correction_reason !== undefined && correctionReason === undefined)
  )
    return null;
  if (
    (revisionNumber === 1 &&
      (supersedesEstimatorRevisionId !== null || correctionReason !== null)) ||
    (revisionNumber > 1 &&
      (!supersedesEstimatorRevisionId || !correctionReason))
  )
    return null;
  if (
    (facetEventId !== null && estimatorReadyEventId !== null) ||
    (estimatorReadyEventId !== null && commercialQuoteRevisionId !== null)
  ) return null;
  return {
    measurementReceiptId,
    facetEventId: facetEventId ?? null,
    estimatorReadyEventId: estimatorReadyEventId ?? null,
    commercialQuoteRevisionId: commercialQuoteRevisionId ?? null,
    revisionNumber,
    supersedesEstimatorRevisionId: supersedesEstimatorRevisionId ?? null,
    correctionReason: correctionReason ?? null,
  };
}

function facetPrequotePromotionBody(value: unknown): {
  estimatorReadyEventId: string;
  estimatorRevisionId: string;
  commercialQuoteRevisionId: string;
} | null {
  if (!isRecord(value)) return null;
  const allowed = new Set([
    "estimator_ready_event_id",
    "estimator_revision_id",
    "commercial_quote_revision_id",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const estimatorReadyEventId = exactEstimatorIdentifier(value.estimator_ready_event_id, 8, 160);
  const estimatorRevisionId = exactEstimatorIdentifier(value.estimator_revision_id, 20, 160);
  const commercialQuoteRevisionId = exactEstimatorIdentifier(
    value.commercial_quote_revision_id,
    8,
    160,
  );
  return estimatorReadyEventId && estimatorRevisionId && commercialQuoteRevisionId
    ? { estimatorReadyEventId, estimatorRevisionId, commercialQuoteRevisionId }
    : null;
}

function exactEstimatorIdentifier(
  value: unknown,
  min: number,
  max: number,
): string | null {
  return typeof value === "string" &&
    value.length >= min &&
    value.length <= max &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    ? value
    : null;
}

function optionalEstimatorIdentifier(
  value: unknown,
  min: number,
  max: number,
): string | null | undefined {
  if (value === undefined || value === null) return null;
  return exactEstimatorIdentifier(value, min, max) ?? undefined;
}

function optionalEstimatorText(
  value: unknown,
  min: number,
  max: number,
): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length >= min && normalized.length <= max
    ? normalized
    : undefined;
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

function workPackageOfficeActionError(error: unknown): { error: string } {
  if (!(error instanceof Error))
    return { error: "work_package_native_unavailable" };
  const code =
    "code" in error && typeof error.code === "string"
      ? error.code
      : error.message;
  if (
    error.message === "work_package_hold_release_authority_required" ||
    error.message === "work_package_evidence_review_authority_required" ||
    error.message === "work_package_evidence_separation_required" ||
    error.message === "work_package_actor_identity_invalid" ||
    error.message === "work_package_actor_role_invalid" ||
    error.message === "work_package_issuer_authority_required" ||
    error.message === "work_package_worker_authority_invalid" ||
    error.message === "work_package_assignment_authority_required" ||
    error.message === "work_package_assignment_authority_invalid"
  ) {
    return { error: error.message };
  }
  if (
    code === "immutable_object_conflict" ||
    error.message === "work_package_hold_not_releasable" ||
    error.message === "work_package_hold_evidence_invalid" ||
    error.message === "work_package_scope_conflict" ||
    error.message === "work_package_evidence_review_target_invalid" ||
    error.message === "work_package_device_action_conflict" ||
    error.message === "work_package_correction_reason_required" ||
    error.message === "work_package_release_attempt_unavailable" ||
    error.message === "work_package_definition_invalid" ||
    error.message === "work_package_definition_incomplete" ||
    error.message === "work_package_definition_conflict" ||
    error.message === "work_package_expiry_invalid" ||
    error.message === "work_package_supersession_invalid" ||
    error.message === "work_package_sequence_invalid" ||
    error.message === "work_package_required_worker_missing" ||
    error.message === "work_package_worker_duplicate" ||
    error.message === "work_package_assignment_snapshot_invalid" ||
    error.message === "work_package_assignment_snapshot_stale" ||
    error.message === "work_package_stop_release_required"
  ) {
    return { error: code };
  }
  return { error: "work_package_native_unavailable" };
}

function workPackageOfficeActionStatus(error: unknown): number {
  if (!(error instanceof Error)) return 502;
  const code =
    "code" in error && typeof error.code === "string"
      ? error.code
      : error.message;
  if (
    error.message === "work_package_hold_release_authority_required" ||
    error.message === "work_package_evidence_review_authority_required" ||
    error.message === "work_package_evidence_separation_required" ||
    error.message === "work_package_actor_identity_invalid" ||
    error.message === "work_package_actor_role_invalid" ||
    error.message === "work_package_issuer_authority_required" ||
    error.message === "work_package_worker_authority_invalid" ||
    error.message === "work_package_assignment_authority_required" ||
    error.message === "work_package_assignment_authority_invalid"
  ) {
    return 403;
  }
  if (
    code === "immutable_object_conflict" ||
    error.message === "work_package_hold_not_releasable" ||
    error.message === "work_package_hold_evidence_invalid" ||
    error.message === "work_package_scope_conflict" ||
    error.message === "work_package_evidence_review_target_invalid" ||
    error.message === "work_package_device_action_conflict" ||
    error.message === "work_package_correction_reason_required" ||
    error.message === "work_package_release_attempt_unavailable" ||
    error.message === "work_package_definition_invalid" ||
    error.message === "work_package_definition_incomplete" ||
    error.message === "work_package_definition_conflict" ||
    error.message === "work_package_expiry_invalid" ||
    error.message === "work_package_supersession_invalid" ||
    error.message === "work_package_sequence_invalid" ||
    error.message === "work_package_required_worker_missing" ||
    error.message === "work_package_worker_duplicate" ||
    error.message === "work_package_assignment_snapshot_invalid" ||
    error.message === "work_package_assignment_snapshot_stale" ||
    error.message === "work_package_stop_release_required"
  ) {
    return 409;
  }
  return 502;
}

async function storeWorkPackageOfficeManifest(
  env: AppEnv,
  tenantId: string,
  deviceActionId: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const body = canonicalJson(manifest);
  const manifestKey = workPackageOfficeManifestKey(tenantId, deviceActionId);
  await r2ObjectStore(env.RAW).ensure(
    manifestKey,
    body,
    "application/json",
    await sha256Hex(body),
  );
  return manifestKey;
}

function workPackageOfficeManifestKey(
  tenantId: string,
  deviceActionId: string,
): string {
  return `work-packages/office-actions/${tenantId}/${deviceActionId}.json`;
}

function officeWorkPackageIssueManifest(
  document: FrappeRow,
  auth: AuthContext,
  deviceActionId: string,
  jobName: string,
  input: NonNullable<ReturnType<typeof parseOfficeWorkPackageIssue>>,
  routeScope?: WorkObjectScope,
): Record<string, unknown> {
  const nativeScope = officeWorkPackageIssueScope(
    document,
    jobName,
    routeScope,
  );
  const workers = officeWorkPackageAssignmentRoster(document);
  const workPackageId = boundedText(document.work_package_id, 1, 140);
  const assignmentId = boundedText(document.job_assignment, 1, 140);
  const releaseAttemptId = boundedText(document.release_attempt_id, 1, 140);
  let authorityRequirements: ReturnType<typeof parseAuthorityRequirements>;
  try {
    authorityRequirements = parseAuthorityRequirements(
      document.authority_requirements_json,
    );
  } catch {
    throw new Error("work_package_definition_invalid");
  }
  if (
    !nativeScope ||
    !workPackageId ||
    !assignmentId ||
    !releaseAttemptId ||
    !workers?.some((worker) => worker.required)
  ) {
    throw new Error("work_package_definition_invalid");
  }
  const priorId = boundedText(document.supersedes, 1, 140);
  return {
    version: 1,
    tenant_id: auth.session.tenant_id,
    user_id: auth.session.user_id,
    role: auth.session.role,
    device_action_id: deviceActionId,
    kind: "work_package_issue",
    job_id: jobName,
    assignment_id: assignmentId,
    work_package_id: workPackageId,
    work_package_version: input.version,
    release_attempt_id: releaseAttemptId,
    supersedes_id: priorId,
    supersedes_version: priorId ? input.version - 1 : null,
    correction_reason: input.correctionReason,
    issued_at: input.issuedAt,
    expires_at: input.expiresAt,
    scope: nativeScope,
    assignment_authority: {
      user: boundedText(document.authority_user, 1, 140),
      role: boundedText(document.authority_role, 1, 140),
    },
    authority_requirements: authorityRequirements,
    assigned_workers: workers,
    title: input.title,
    objective: input.objective,
    boundaries: input.boundaries,
    prerequisites: input.prerequisites,
    expected_result: input.expectedResult,
    stop_conditions: input.stopConditions,
    make_safe_procedure: input.makeSafeProcedure,
    steps: input.steps,
    hold_points: input.holdPoints,
  };
}

async function officeWorkPackageIssueResponse(
  tenantId: string,
  deviceActionId: string,
  workPackageId: string,
  version: number,
): Promise<Response> {
  return privateAppJson({
    device_action_id: deviceActionId,
    status: "verified",
    server_ref: workPackageId,
    cursor: `wpi_${(await sha256Hex(`${tenantId}:${deviceActionId}`)).slice(
      0,
      32,
    )}`,
    work_package_version: version,
  });
}

function officeWorkPackageIssueScope(
  assignment: FrappeRow,
  jobId: string,
  routeScope?: WorkObjectScope,
): WorkObjectScope | null {
  if (routeScope) {
    return boundedText(assignment.work_object_type, 1, 140) ===
      routeScope.workObjectType &&
      boundedText(assignment.work_object_id, 1, 140) === routeScope.workObjectId &&
      boundedText(assignment.physical_context_type, 1, 140) ===
        routeScope.physicalContextType &&
      boundedText(assignment.physical_context_id, 1, 140) ===
        routeScope.physicalContextId
      ? routeScope
      : null;
  }
  if (boundedText(assignment.roof_job, 1, 140) !== jobId) return null;
  const explicit = {
    workObjectType: boundedText(assignment.work_object_type, 1, 140),
    workObjectId: boundedText(assignment.work_object_id, 1, 140),
    physicalContextType: boundedText(
      assignment.physical_context_type,
      1,
      140,
    ),
    physicalContextId: boundedText(assignment.physical_context_id, 1, 140),
  };
  if (
    (explicit.workObjectType && explicit.workObjectType !== "Roof Job") ||
    (explicit.workObjectId && explicit.workObjectId !== jobId) ||
    (explicit.physicalContextType &&
      explicit.physicalContextType !== "Roof Site") ||
    (explicit.physicalContextId && explicit.physicalContextId !== jobId)
  )
    return null;
  return {
    workObjectType: "Roof Job",
    workObjectId: jobId,
    physicalContextType: "Roof Site",
    physicalContextId: jobId,
  };
}

function officeWorkPackageAssignmentRoster(
  assignment: FrappeRow,
): NativeWorkPackageWorker[] | null {
  const roster = new Map<
    string,
    { workerUser: string; workerRole: string; required: boolean }
  >();
  const add = (workerUser: string, workerRole: string, required: boolean) => {
    const key = workerUser.toLowerCase();
    const existing = roster.get(key);
    if (
      existing &&
      (existing.workerRole !== workerRole || existing.required !== required)
    )
      return false;
    roster.set(key, existing ?? { workerUser, workerRole, required });
    return true;
  };
  if (assignment.source_system !== "ironwrap-d1") return null;
  const declared = assignment.assigned_workers;
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > 50)
    return null;
  for (const row of declared) {
    if (!isRecord(row)) return null;
    const sequence = Number(row.sequence);
    const workerUser = boundedText(row.worker_user, 1, 140);
    const workerRole = boundedText(row.worker_role, 1, 140);
    const required = frappeBoolean(row.required, true);
    if (
      !Number.isInteger(sequence) ||
      sequence < 1 ||
      !workerUser ||
      !workerRole ||
      required !== true ||
      !add(workerUser, workerRole, required)
    )
      return null;
  }
  return [...roster.values()]
    .sort((left, right) =>
      left.workerUser.localeCompare(right.workerUser, "en", {
        sensitivity: "base",
      }),
    )
    .map((worker, index) => ({ sequence: index + 1, ...worker }));
}

function frappeBoolean(
  value: unknown,
  fallback = false,
): boolean | null {
  if (value === null || value === undefined) return fallback;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function officeWorkPackageRoleLabel(role: AppRole): string {
  if (role === "owner") return "IronWrap Owner";
  if (role === "ops") return "System Manager";
  if (role === "production") return "IronWrap Production";
  return "";
}

function officeWorkPackageScope(
  workPackage: {
    workObjectType?: string | null;
    workObjectId?: string | null;
    physicalContextType?: string | null;
    physicalContextId?: string | null;
  },
  jobId: string,
  routeScope?: WorkObjectScope,
): WorkObjectScope | null {
  const resolved = {
    workObjectType: workPackage.workObjectType ?? "",
    workObjectId: workPackage.workObjectId ?? "",
    physicalContextType: workPackage.physicalContextType ?? "",
    physicalContextId: workPackage.physicalContextId ?? "",
  };
  if (Object.values(resolved).some((value) => !value)) return null;
  if (routeScope) {
    return Object.entries(routeScope).every(
      ([key, value]) => resolved[key as keyof WorkObjectScope] === value,
    )
      ? resolved
      : null;
  }
  return resolved.workObjectType === "Roof Job" &&
    resolved.workObjectId === jobId
    ? resolved
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

function quickBooksMappingBody(value: unknown): {
  roofJobId: string;
  qboCustomerId: string;
  qboItemId: string;
  qboTaxCodeId: string;
  qboTermsId: string;
  jurisdiction: string;
  taxCode: string;
  paymentTermsDays: number;
  correctionReason: string | null;
} | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "roof_job_id",
      "qbo_customer_id",
      "qbo_item_id",
      "qbo_tax_code_id",
      "qbo_terms_id",
      "jurisdiction",
      "tax_code",
      "payment_terms_days",
      "correction_reason",
    ])
  ) return null;
  const roofJobId = boundedText(value.roof_job_id, 1, 160);
  const qboCustomerId = boundedText(value.qbo_customer_id, 1, 32);
  const qboItemId = boundedText(value.qbo_item_id, 1, 32);
  const qboTaxCodeId = boundedText(value.qbo_tax_code_id, 1, 32);
  const qboTermsId = boundedText(value.qbo_terms_id, 1, 32);
  const jurisdiction = boundedText(value.jurisdiction, 2, 32);
  const taxCode = boundedText(value.tax_code, 1, 32);
  const paymentTermsDays = typeof value.payment_terms_days === "number" &&
      Number.isInteger(value.payment_terms_days) &&
      value.payment_terms_days >= 0 &&
      value.payment_terms_days <= 365
    ? value.payment_terms_days
    : null;
  const correctionReason = value.correction_reason == null
    ? null
    : boundedText(value.correction_reason, 3, 1200);
  if (
    !roofJobId ||
    !/^[A-Za-z0-9:_-]+$/.test(roofJobId) ||
    ![qboCustomerId, qboItemId, qboTaxCodeId, qboTermsId].every(
      (entry) => !!entry && /^\d{1,32}$/.test(entry),
    ) ||
    !jurisdiction ||
    !/^[A-Za-z0-9._:-]+$/.test(jurisdiction) ||
    !taxCode ||
    !/^[A-Za-z0-9._:-]+$/.test(taxCode) ||
    paymentTermsDays === null
  ) return null;
  return {
    roofJobId,
    qboCustomerId: qboCustomerId!,
    qboItemId: qboItemId!,
    qboTaxCodeId: qboTaxCodeId!,
    qboTermsId: qboTermsId!,
    jurisdiction,
    taxCode,
    paymentTermsDays,
    correctionReason,
  };
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

// Classifies a broker call that threw into the code the approval ledger records for it.
// It was shared with the production-schedule rail until that rail was retired (ELEC-167).
function brokerFailureErrorCode(
  error: unknown,
  errorClass: typeof ProposalPublicationApprovalBrokerError,
  unavailableCode: string,
  unverifiedCode: string,
): string {
  if (!(error instanceof errorClass)) return unverifiedCode;
  if (error.code.endsWith("_rejected")) return error.brokerErrorCode ?? unverifiedCode;
  if (error.code.endsWith("_unavailable")) return unavailableCode;
  return unverifiedCode;
}

// A broker that answers 4xx has made a decision; a broker that cannot be reached
// has not. Reporting both as `_unavailable` told the owner to retry a request the
// broker had already refused on its merits, and told whoever read the response
// nothing about which of the two happened (ELEC-95 process risk 3). The broker's
// code is passed through in both cases; only the status class distinguishes a
// business rejection (422) from an integration fault (502).
function proposalPublicationBrokerPrepareError(error: unknown): string {
  if (!(error instanceof ProposalPublicationApprovalBrokerError)) {
    return "proposal_publication_broker_unavailable";
  }
  if (error.code === "proposal_publication_broker_not_configured") return error.code;
  if (error.code === "proposal_publication_broker_rejected") {
    return error.brokerErrorCode ?? error.code;
  }
  return "proposal_publication_broker_unavailable";
}

function proposalPublicationBrokerPrepareStatus(error: unknown): number {
  if (!(error instanceof ProposalPublicationApprovalBrokerError)) return 502;
  if (error.code === "proposal_publication_broker_not_configured") return 503;
  if (error.code === "proposal_publication_broker_rejected" && error.brokerStatus === 422) return 422;
  return 502;
}

function commercialRouteStatus(code: string): number {
  if (
    code === "commercial_policy_missing" ||
    code === "commercial_policy_invalid" ||
    code === "commercial_policy_inactive"
  ) return 503;
  if (
    code === "commercial_policy_action_denied" ||
    code === "commercial_policy_actor_denied"
  ) return 403;
  if (
    code.includes("_conflict") ||
    code.includes("_mismatch") ||
    code.includes("_stale") ||
    code.includes("_expired") ||
    code.includes("_not_current") ||
    code === "commercial_quote_already_expired"
  ) return 409;
  if (code.endsWith("_missing")) return 404;
  return 400;
}

function commercialLeadTriageProjection(
  decision: CommercialLeadTriageRecord,
): Record<string, unknown> {
  return {
    triage_decision_id: decision.triage_decision_id,
    lead_id: decision.lead_id,
    lead_version: decision.lead_version,
    lifecycle_status: decision.lifecycle_status,
    priority: decision.priority,
    category: decision.category,
    summary: decision.summary,
    next_action: decision.next_action,
    decided_at: decision.decided_at,
  };
}

function commercialProposalProjection(
  proposal: CommercialProposalRecord,
): Record<string, unknown> {
  return {
    proposal_revision_id: proposal.proposal_revision_id,
    proposal_pack_id: proposal.proposal_pack_id,
    revision_number: proposal.revision_number,
    quote_revision_id: proposal.quote_revision_id,
    roof_job_id: proposal.roof_job_id,
    customer_id: proposal.customer_id,
    supersedes_proposal_revision_id: proposal.supersedes_proposal_revision_id,
    title: proposal.title,
    summary: proposal.summary,
    terms_hash: proposal.terms_hash,
    content_ref: proposal.content_ref,
    content_hash: proposal.content_hash,
    evidence: JSON.parse(proposal.evidence_refs_json) as unknown,
    created_at: proposal.created_at,
  };
}

function commercialQuoteProjection(
  quote: CommercialQuoteRecord,
  lines: readonly unknown[],
): Record<string, unknown> {
  return {
    quote_revision_id: quote.quote_revision_id,
    customer_quote_id: quote.customer_quote_id,
    revision_number: quote.revision_number,
    roof_job_id: quote.roof_job_id,
    customer_id: quote.customer_id,
    supersedes_quote_revision_id: quote.supersedes_quote_revision_id,
    status: quote.status,
    currency: quote.currency,
    valid_until: quote.valid_until,
    subtotal_cents: quote.subtotal_cents,
    tax_cents: quote.tax_cents,
    total_cents: quote.total_cents,
    terms_hash: quote.terms_hash,
    evidence: JSON.parse(quote.evidence_refs_json) as unknown,
    lines,
    created_at: quote.created_at,
  };
}

function commercialPublicationProjection(
  publication: CommercialPublicationRecord,
): Record<string, unknown> {
  return {
    publication_event_id: publication.publication_event_id,
    proposal_revision_id: publication.proposal_revision_id,
    proposal_pack_id: publication.proposal_pack_id,
    publication_version: publication.publication_version,
    previous_state: publication.previous_state,
    state: publication.state,
    external_effect_id: publication.external_effect_id,
    occurred_at: publication.occurred_at,
  };
}

function commercialDepositDerivationRouteProjection(
  derivation: CommercialDepositDerivationRecord,
): Record<string, unknown> {
  return {
    derivation_id: derivation.derivation_id,
    acceptance_binding_id: derivation.acceptance_binding_id,
    acceptance_id: derivation.acceptance_id,
    quote_revision_id: derivation.quote_revision_id,
    proposal_revision_id: derivation.proposal_revision_id,
    proposal_version: derivation.proposal_version,
    publication_event_id: derivation.publication_event_id,
    publication_version: derivation.publication_version,
    roof_job_id: derivation.roof_job_id,
    customer_id: derivation.customer_id,
    quote_version: derivation.quote_version,
    quote_currency: derivation.quote_currency,
    quote_subtotal_cents: derivation.quote_subtotal_cents,
    quote_tax_cents: derivation.quote_tax_cents,
    quote_total_cents: derivation.quote_total_cents,
    deposit_percent: derivation.deposit_percent,
    state: derivation.state,
    intent_id: derivation.intent_id,
    blocker_code: derivation.blocker_code,
    blocker_next_step: derivation.blocker_next_step,
    basis_sha256: derivation.basis_sha256,
    command_fingerprint: derivation.command_fingerprint,
    version: derivation.version,
    accepted_at: derivation.accepted_at,
    updated_at: derivation.updated_at,
  };
}

interface CommercialJobBinding {
  lead_id: string;
  lead_version: number;
  lead_status: string;
  job_version: number;
  job_status: string;
  property_id: string | null;
  bound_property_id: string | null;
  customer_version: number;
  customer_status: string;
}

interface CommercialPublicationFacts {
  proposal_revision_id: string;
  proposal_pack_id: string;
  quote_revision_id: string;
  roof_job_id: string;
  customer_id: string;
  terms_hash: string;
  customer_quote_id: string;
  quote_revision_number: number;
  supersedes_quote_revision_id: string | null;
  job_version: number;
  customer_version: number;
  lead_id: string;
  lead_version: number;
  property_id: string | null;
  job_status: string;
  customer_status: string;
  lead_status: string;
  quote_status: string;
}

async function readCommercialJobBinding(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  customerId: string,
): Promise<CommercialJobBinding | null> {
  return await env.DB.prepare(
    `SELECT job.lead_id, job.version AS job_version, job.job_status,
            job.property_id, property.property_id AS bound_property_id,
            customer.version AS customer_version,
            customer.lifecycle_status AS customer_status,
            lead.version AS lead_version, lead.lifecycle_status AS lead_status
       FROM operating_roof_jobs job
       JOIN operating_customers customer
         ON customer.tenant_id = job.tenant_id AND customer.customer_id = job.customer_id
       JOIN operating_leads lead
         ON lead.tenant_id = job.tenant_id AND lead.lead_id = job.lead_id
       LEFT JOIN operating_properties property
         ON property.tenant_id = job.tenant_id AND property.property_id = job.property_id
      WHERE job.tenant_id = ? AND job.roof_job_id = ? AND job.customer_id = ? LIMIT 1`,
  ).bind(tenantId, roofJobId, customerId).first<CommercialJobBinding>();
}

function mergeCommercialEvidence(
  evidence: readonly { ref: string; sha256: string }[],
  ref: string,
  sha256: string,
): Array<{ ref: string; sha256: string }> {
  return evidence.some((entry) => entry.ref === ref)
    ? [...evidence]
    : [...evidence, { ref, sha256 }];
}

function commercialQuoteLines(value: unknown[]): CommercialQuoteLineInput[] | null {
  const lines = value.map((entry) => {
    if (!isRecord(entry) || !onlyKeys(entry, [
      "line_id", "sequence", "kind", "description", "quantity_micros", "uom",
      "unit_price_cents", "tax_code", "tax_cents",
    ])) return null;
    const lineId = idText(entry.line_id, 3, 120);
    const sequence = validVersion(entry.sequence);
    const kind = ["material", "labour", "equipment", "subcontract", "allowance", "discount", "other"].includes(
      String(entry.kind),
    ) ? entry.kind as CommercialQuoteLineInput["kind"] : null;
    const description = boundedText(entry.description, 1, 500);
    const quantityMicros = safeInteger(entry.quantity_micros, 1, 1_000_000_000_000);
    const uom = boundedText(entry.uom, 1, 32);
    const unitPriceCents = safeInteger(entry.unit_price_cents, -1_000_000_000_000, 1_000_000_000_000);
    const taxCode = entry.tax_code === undefined || entry.tax_code === null
      ? entry.tax_code ?? null
      : boundedText(entry.tax_code, 1, 40);
    const taxCents = safeInteger(entry.tax_cents, -1_000_000_000_000, 1_000_000_000_000);
    return lineId && sequence && kind && description && quantityMicros && uom &&
        unitPriceCents !== null && taxCode !== undefined && taxCents !== null
      ? {
          lineId,
          sequence,
          kind,
          description,
          quantityMicros,
          uom,
          unitPriceCents,
          taxCode,
          taxCents,
        }
      : null;
  });
  return lines.some((line) => line === null)
    ? null
    : lines as CommercialQuoteLineInput[];
}

function safeInteger(value: unknown, min: number, max: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : null;
}

function isoDateOnly(value: unknown): string | null {
  // Date.parse accepts "2026-02-30" and rolls it to 2 March; only a date that survives the round
  // trip is a real calendar date.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
    ? value
    : null;
}

function commercialContentRef(value: unknown): string | null {
  return typeof value === "string" &&
      value.length >= 3 &&
      value.length <= 512 &&
      !/[\s?#]/.test(value) &&
      !value.includes("..") &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
    ? value
    : null;
}

function commercialSha256(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? value
    : null;
}

function commercialEvidence(
  value: unknown,
): Array<{ ref: string; sha256: string }> | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    return null;
  const evidence = value.map((entry) => {
    if (!isRecord(entry)) return null;
    const ref = commercialContentRef(entry.ref);
    const sha256 = commercialSha256(entry.sha256);
    return ref && sha256 ? { ref, sha256 } : null;
  });
  if (evidence.some((entry) => entry === null)) return null;
  const normalized = evidence as Array<{ ref: string; sha256: string }>;
  return new Set(normalized.map((entry) => entry.ref)).size === normalized.length
    ? normalized
    : null;
}

function operatingJobAssignmentErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof OperatingJobAssignmentError
    ? error.code
    : message.match(/operating_job_assignment_[a-z_]+/)?.[0] ?? null;
  if (!code) {
    return privateAppJson({ error: "operating_job_assignment_unavailable" }, 502);
  }
  if (code === "operating_job_assignment_actor_invalid") {
    return privateAppJson({ error: code }, 403);
  }
  return privateAppJson({ error: code }, 409);
}

function operatingWorkObjectAssignmentErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof OperatingWorkObjectAssignmentError
      ? error.code
      : message.match(/operating_work_object_assignment_[a-z_]+/)?.[0] ?? null;
  if (!code) {
    return privateAppJson(
      { error: "operating_work_object_assignment_unavailable" },
      502,
    );
  }
  if (code === "operating_work_object_assignment_actor_invalid") {
    return privateAppJson({ error: code }, 403);
  }
  return privateAppJson({ error: code }, 409);
}

function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
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

async function readBoundedJson(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes)
    return { ok: false, error: "payload_too_large", status: 413 };
  const reader = req.body?.getReader();
  if (!reader) return { ok: false, error: "invalid_json", status: 400 };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: "payload_too_large", status: 413 };
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body)),
    };
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
