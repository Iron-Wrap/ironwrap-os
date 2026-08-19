// service-cases.ts - the office BFF surface for the complaint, warranty, service, diagnosis,
// remedy, and cost-recovery lifecycle owned by `service-case-store.ts` (D1 migration 0056).
//
// Everything here is a thin, authenticated authority check over that store. The store and its D1
// triggers remain the enforcement boundary; this module decides who may ask, derives every
// identifier and evidence-bearing attribution from the session rather than the request body, and
// projects rows back to the browser.
//
// Three rules shape the request shapes below:
//
//  1. Identifiers are never accepted from the browser. Case, triage, diagnosis, remedy, and claim
//     ids are minted here, and the triage/diagnosis a step builds on is read back from the case,
//     so a caller cannot bind a remedy to another case's diagnosis.
//  2. Attribution comes from the session. `decided_by_user_id`, `diagnosed_by_user_id`,
//     `verified_by_user_id`, and the claim's actor are the authenticated user, never a field.
//  3. No provider is called. Cost recovery is submitted out of band today, so the lease/result
//     routes record what an operator did with the single permitted attempt; they never call a
//     supplier, manufacturer, or insurer.

import { validAppCsrf } from "./app-auth.ts";
import { APP_API_VERSION, type AppEnv, type AuthContext } from "./app-types.ts";
import {
  SERVICE_CASE_SEVERITIES,
  SERVICE_CLOSURE_REASONS,
  SERVICE_RESPONSIBILITIES,
  SERVICE_TRIAGE_CATEGORIES,
  closeServiceCase,
  claimCostRecoveryEffect,
  finalizeCostRecoveryEffect,
  getServiceCase,
  issueServiceRemedy,
  listCostRecoveryClaims,
  listServiceCaseDiagnoses,
  listServiceCaseEvents,
  listServiceCaseRemedies,
  listServiceCaseTriage,
  listServiceCases,
  openCostRecoveryClaim,
  openServiceCase,
  reconcileCostRecoveryEffect,
  recordCustomerServiceDecision,
  recordServiceDiagnosis,
  recordServiceTriage,
  reopenServiceCase,
  summarizeServiceCaseCost,
  verifyServiceRemedy,
  type ServiceCaseRecord,
  type ServiceCaseSeverity,
  type ServiceClosureReason,
  type ServiceCostRecoveryClaimRecord,
  type ServiceResponsibility,
  type ServiceTriageCategory,
} from "./service-case-store.ts";

const MAX_SERVICE_BODY_BYTES = 16 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const REPORTED_CHANNELS = ["phone", "portal", "email", "field", "partner"] as const;
const COUNTERPARTY_KINDS = ["supplier", "manufacturer", "insurer"] as const;
const ADVISORY_SOURCES = ["model", "rule", "none"] as const;
/** One permitted attempt still needs a bounded lease so a crashed operator can be recovered. */
const MIN_LEASE_SECONDS = 60;
const MAX_LEASE_SECONDS = 24 * 60 * 60;

export const SERVICE_CASE_ALLOWED_ACTIONS = [
  "service_case.read",
  "service_case.open",
  "service_case.triage",
  "service_case.diagnose",
  "service_case.issue_remedy",
  "service_case.verify_remedy",
  "service_case.record_customer_decision",
  "service_case.close",
  "service_case.reopen",
  "service_case.recover_cost",
] as const;

/**
 * Owns every `/api/v1/service-cases` path. The office roles run the lifecycle; cost recovery is
 * money claimed from a third party, so it stays with the owner.
 */
export async function handleServiceCaseRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!officeRole(auth)) return json({ error: "office_role_required" }, 403);
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/v1\/service-cases\/?/, "");
  const segments = path.length === 0 ? [] : path.split("/").map(decodeSegment);
  if (segments.some((segment) => segment === null)) return json({ error: "not_found" }, 404);
  const parts = segments as string[];

  if (req.method === "GET" && parts.length === 0) return await listCases(env, auth, url);
  if (req.method === "POST" && parts.length === 0) return await openCase(req, env, auth);

  const caseId = parts[0];
  if (!caseId) return json({ error: "not_found" }, 404);
  if (req.method === "GET" && parts.length === 1) return await readCase(env, auth, caseId);
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);

  const tail = parts.slice(1).join("/");
  switch (tail) {
    case "triage":
      return await recordTriage(req, env, auth, caseId);
    case "diagnoses":
      return await recordDiagnosis(req, env, auth, caseId);
    case "remedies":
      return await issueRemedy(req, env, auth, caseId);
    case "closure":
      return await closeCase(req, env, auth, caseId);
    case "reopen":
      return await reopenCase(req, env, auth, caseId);
    case "cost-recovery-claims":
      return await openClaim(req, env, auth, caseId);
    default:
      break;
  }
  if (parts.length === 4 && parts[1] === "remedies") {
    const remedyId = parts[2] ?? "";
    if (parts[3] === "verification") {
      return await verifyRemedy(req, env, auth, caseId, remedyId);
    }
    if (parts[3] === "customer-decision") {
      return await recordCustomerDecision(req, env, auth, caseId, remedyId);
    }
  }
  if (parts.length === 4 && parts[1] === "cost-recovery-claims") {
    const claimId = parts[2] ?? "";
    if (parts[3] === "lease") return await leaseClaimAttempt(req, env, auth, caseId, claimId);
    if (parts[3] === "result") return await recordClaimResult(req, env, auth, caseId, claimId);
    if (parts[3] === "reconcile") return await reconcileClaim(req, env, auth, caseId, claimId);
  }
  return json({ error: "not_found" }, 404);
}

async function listCases(env: AppEnv, auth: AuthContext, url: URL): Promise<Response> {
  try {
    const cases = await listServiceCases(env, {
      tenantId: auth.session.tenant_id,
      limit: listLimit(url.searchParams.get("limit")),
      openOnly: url.searchParams.get("state") === "open",
    });
    return json(envelope(auth, { service_cases: cases.map(projectCase) }));
  } catch {
    return json({ error: "service_case_store_unavailable" }, 502);
  }
}

async function readCase(env: AppEnv, auth: AuthContext, caseId: string): Promise<Response> {
  try {
    const tenantId = auth.session.tenant_id;
    const record = await getServiceCase(env, { tenantId, serviceCaseId: caseId });
    if (!record) return json({ error: "not_found" }, 404);
    const [triage, diagnoses, remedies, claims, events, cost] = await Promise.all([
      listServiceCaseTriage(env, { tenantId, serviceCaseId: caseId }),
      listServiceCaseDiagnoses(env, { tenantId, serviceCaseId: caseId }),
      listServiceCaseRemedies(env, { tenantId, serviceCaseId: caseId }),
      listCostRecoveryClaims(env, { tenantId, serviceCaseId: caseId }),
      listServiceCaseEvents(env, { tenantId, serviceCaseId: caseId }),
      summarizeServiceCaseCost(env, { tenantId, serviceCaseId: caseId }),
    ]);
    return json(
      envelope(auth, {
        service_case: projectCase(record),
        triage,
        diagnoses,
        remedies,
        cost_recovery_claims: claims.map(projectClaim),
        events,
        cost: cost,
      }),
    );
  } catch {
    return json({ error: "service_case_store_unavailable" }, 502);
  }
}

async function openCase(req: Request, env: AppEnv, auth: AuthContext): Promise<Response> {
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  const allowed = [
    "customer_id",
    "property_key",
    "roof_job_id",
    "asset_ref",
    "warranty_packet_id",
    "origin_work_package_ref",
    "severity",
    "symptom_code",
    "reported_channel",
    "consent_ref",
    "intake_evidence_digest",
    "response_sla_minutes",
    "intake_code",
  ];
  if (!onlyKeys(body, allowed)) return json({ error: "unexpected_field" }, 400);

  const customerId = boundedText(body.customer_id, 3, 140);
  const propertyKey = boundedText(body.property_key, 3, 140);
  const roofJobId = boundedText(body.roof_job_id, 3, 140);
  const severity = oneOf(body.severity, SERVICE_CASE_SEVERITIES);
  const symptomCode = codeText(body.symptom_code, 3, 80);
  const reportedChannel = oneOf(body.reported_channel, REPORTED_CHANNELS);
  const consentRef = boundedText(body.consent_ref, 3, 140);
  const intakeEvidenceDigest = digest(body.intake_evidence_digest);
  const responseSlaMinutes = boundedInteger(body.response_sla_minutes, 1, 60 * 24 * 30);
  if (
    !customerId ||
    !propertyKey ||
    !roofJobId ||
    !severity ||
    !symptomCode ||
    !reportedChannel ||
    !consentRef ||
    !intakeEvidenceDigest ||
    responseSlaMinutes === null
  ) {
    return json({ error: "invalid_service_case_intake" }, 400);
  }
  if (severity === "emergency" && responseSlaMinutes > 240) {
    return json({ error: "service_case_emergency_sla_exceeded" }, 400);
  }

  try {
    const result = await openServiceCase(env, {
      serviceCaseId: newId("svc_case"),
      tenantId: auth.session.tenant_id,
      customerId,
      propertyKey,
      roofJobId,
      assetRef: optionalText(body.asset_ref, 3, 140),
      warrantyPacketId: optionalText(body.warranty_packet_id, 3, 140),
      originWorkPackageRef: optionalRefText(body.origin_work_package_ref, 1, 140),
      severity: severity as ServiceCaseSeverity,
      symptomCode,
      reportedChannel,
      consentRef,
      intakeEvidenceDigest,
      responseSlaMinutes,
      openedByUserId: auth.session.user_id,
      intakeCode: optionalCode(body.intake_code, 3, 120),
      now: new Date().toISOString(),
    });
    return json(
      envelope(auth, {
        result: result.kind,
        service_case: projectCase(result.serviceCase),
        original_case: result.kind === "duplicate" ? projectCase(result.original) : null,
      }),
      201,
    );
  } catch (error) {
    return storeError(error);
  }
}

async function recordTriage(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
): Promise<Response> {
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (
    !onlyKeys(body, [
      "advisory_source",
      "advisory_category",
      "advisory_confidence_bps",
      "final_category",
      "responsibility",
      "evidence_digest",
    ])
  ) {
    return json({ error: "unexpected_field" }, 400);
  }
  const advisorySource = oneOf(body.advisory_source, ADVISORY_SOURCES);
  const finalCategory = oneOf(body.final_category, SERVICE_TRIAGE_CATEGORIES);
  const responsibility = oneOf(body.responsibility, SERVICE_RESPONSIBILITIES);
  const evidenceDigest = digest(body.evidence_digest);
  if (!advisorySource || !finalCategory || !responsibility || !evidenceDigest) {
    return json({ error: "invalid_service_triage" }, 400);
  }
  const advisoryCategory =
    body.advisory_category === undefined || body.advisory_category === null
      ? null
      : oneOf(body.advisory_category, SERVICE_TRIAGE_CATEGORIES);
  const advisoryConfidence =
    body.advisory_confidence_bps === undefined || body.advisory_confidence_bps === null
      ? null
      : boundedInteger(body.advisory_confidence_bps, 0, 10_000);
  // A model or rule advisory is evidence beside the decision; without both its category and its
  // confidence it is not an advisory at all, and D1 refuses the half-recorded form.
  if (advisorySource !== "none" && (!advisoryCategory || advisoryConfidence === null)) {
    return json({ error: "invalid_service_triage_advisory" }, 400);
  }
  if (advisorySource === "none" && (advisoryCategory || advisoryConfidence !== null)) {
    return json({ error: "invalid_service_triage_advisory" }, 400);
  }

  try {
    const result = await recordServiceTriage(env, {
      triageId: newId("svc_triage"),
      tenantId: auth.session.tenant_id,
      serviceCaseId: caseId,
      advisorySource,
      advisoryCategory: advisoryCategory as ServiceTriageCategory | null,
      advisoryConfidenceBps: advisoryConfidence,
      finalCategory: finalCategory as ServiceTriageCategory,
      responsibility: responsibility as ServiceResponsibility,
      // The deciding human is the authenticated session, never a claim in the request body.
      decidedByUserId: auth.session.user_id,
      decidedByRole: auth.session.role,
      evidenceDigest,
      now: new Date().toISOString(),
    });
    return json(
      envelope(auth, { triage: result.triage, service_case: projectCase(result.serviceCase) }),
      201,
    );
  } catch (error) {
    return storeError(error);
  }
}

async function recordDiagnosis(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
): Promise<Response> {
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (
    !onlyKeys(body, [
      "root_cause_code",
      "corrective_action_code",
      "recurrence_of_case_id",
      "work_package_ref",
      "work_package_version",
      "warranty_reserve_cents",
      "evidence_digest",
    ])
  ) {
    return json({ error: "unexpected_field" }, 400);
  }
  const rootCauseCode = codeText(body.root_cause_code, 3, 120);
  const correctiveActionCode = codeText(body.corrective_action_code, 3, 120);
  const workPackageRef = refText(body.work_package_ref, 1, 140);
  const workPackageVersion = boundedInteger(body.work_package_version, 1, 1_000_000);
  const warrantyReserveCents = boundedInteger(body.warranty_reserve_cents, 0, 100_000_000);
  const evidenceDigest = digest(body.evidence_digest);
  if (
    !rootCauseCode ||
    !correctiveActionCode ||
    !workPackageRef ||
    workPackageVersion === null ||
    warrantyReserveCents === null ||
    !evidenceDigest
  ) {
    return json({ error: "invalid_service_diagnosis" }, 400);
  }

  try {
    const tenantId = auth.session.tenant_id;
    // The diagnosis binds to the triage this case actually carries, so the browser cannot cite
    // another case's decision as the basis for dispatching remedy work.
    const triage = (await listServiceCaseTriage(env, { tenantId, serviceCaseId: caseId })).at(-1);
    if (!triage) return json({ error: "service_case_triage_required" }, 409);
    const result = await recordServiceDiagnosis(env, {
      diagnosisId: newId("svc_diag"),
      tenantId,
      serviceCaseId: caseId,
      triageId: triage.triage_id,
      rootCauseCode,
      correctiveActionCode,
      recurrenceOfCaseId: optionalCaseId(body.recurrence_of_case_id),
      workPackageRef,
      workPackageVersion,
      warrantyReserveCents,
      evidenceDigest,
      diagnosedByUserId: auth.session.user_id,
      now: new Date().toISOString(),
    });
    return json(
      envelope(auth, {
        diagnosis: result.diagnosis,
        service_case: projectCase(result.serviceCase),
      }),
      201,
    );
  } catch (error) {
    return storeError(error);
  }
}

async function issueRemedy(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
): Promise<Response> {
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (
    !onlyKeys(body, ["scheduled_start_at", "scheduled_end_at", "parts_manifest_digest"])
  ) {
    return json({ error: "unexpected_field" }, 400);
  }
  const scheduledStartAt = isoTimestamp(body.scheduled_start_at);
  const scheduledEndAt = isoTimestamp(body.scheduled_end_at);
  const partsManifestDigest = digest(body.parts_manifest_digest);
  if (!scheduledStartAt || !scheduledEndAt || !partsManifestDigest) {
    return json({ error: "invalid_service_remedy" }, 400);
  }
  if (Date.parse(scheduledEndAt) <= Date.parse(scheduledStartAt)) {
    return json({ error: "service_remedy_window_invalid" }, 400);
  }

  try {
    const tenantId = auth.session.tenant_id;
    const diagnosis = (
      await listServiceCaseDiagnoses(env, { tenantId, serviceCaseId: caseId })
    ).at(-1);
    if (!diagnosis) return json({ error: "service_case_diagnosis_required" }, 409);
    const result = await issueServiceRemedy(env, {
      remedyId: newId("svc_remedy"),
      tenantId,
      serviceCaseId: caseId,
      diagnosisId: diagnosis.diagnosis_id,
      scheduledStartAt,
      scheduledEndAt,
      partsManifestDigest,
      issuedByUserId: auth.session.user_id,
      now: new Date().toISOString(),
    });
    return json(
      envelope(auth, { remedy: result.remedy, service_case: projectCase(result.serviceCase) }),
      201,
    );
  } catch (error) {
    return storeError(error);
  }
}

async function verifyRemedy(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
  remedyId: string,
): Promise<Response> {
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (
    !onlyKeys(body, ["outcome", "field_evidence_digest", "cost_actual_cents", "failure_code"])
  ) {
    return json({ error: "unexpected_field" }, 400);
  }
  const outcome = oneOf(body.outcome, ["verified", "failed"] as const);
  const fieldEvidenceDigest = digest(body.field_evidence_digest);
  const costActualCents = boundedInteger(body.cost_actual_cents, 0, 100_000_000);
  const failureCode = optionalCode(body.failure_code, 3, 120);
  if (!outcome || !fieldEvidenceDigest || costActualCents === null) {
    return json({ error: "invalid_service_remedy_verification" }, 400);
  }
  if (outcome === "failed" && !failureCode) {
    return json({ error: "service_case_remedy_failure_code_required" }, 400);
  }

  try {
    const owned = await remedyBelongsToCase(env, auth, caseId, remedyId);
    if (!owned) return json({ error: "not_found" }, 404);
    const result = await verifyServiceRemedy(env, {
      tenantId: auth.session.tenant_id,
      serviceCaseId: caseId,
      remedyId,
      fieldEvidenceDigest,
      costActualCents,
      verifiedByUserId: auth.session.user_id,
      outcome,
      failureCode,
      now: new Date().toISOString(),
    });
    return json(
      envelope(auth, { remedy: result.remedy, service_case: projectCase(result.serviceCase) }),
    );
  } catch (error) {
    return storeError(error);
  }
}

async function recordCustomerDecision(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
  remedyId: string,
): Promise<Response> {
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (
    !onlyKeys(body, ["decision", "acceptance_ref", "dispute_code", "evidence_digest"])
  ) {
    return json({ error: "unexpected_field" }, 400);
  }
  const decision = oneOf(body.decision, ["accepted", "disputed"] as const);
  const evidenceDigest = digest(body.evidence_digest);
  const acceptanceRef = optionalText(body.acceptance_ref, 3, 140);
  const disputeCode = optionalCode(body.dispute_code, 3, 120);
  if (!decision || !evidenceDigest) {
    return json({ error: "invalid_service_customer_decision" }, 400);
  }
  if (decision === "accepted" && !acceptanceRef) {
    return json({ error: "service_case_customer_acceptance_ref_required" }, 400);
  }
  if (decision === "disputed" && !disputeCode) {
    return json({ error: "service_case_dispute_code_required" }, 400);
  }

  try {
    const owned = await remedyBelongsToCase(env, auth, caseId, remedyId);
    if (!owned) return json({ error: "not_found" }, 404);
    const result = await recordCustomerServiceDecision(env, {
      tenantId: auth.session.tenant_id,
      serviceCaseId: caseId,
      remedyId,
      decision,
      acceptanceRef,
      disputeCode,
      evidenceDigest,
      actorUserId: auth.session.user_id,
      now: new Date().toISOString(),
    });
    return json(
      envelope(auth, { remedy: result.remedy, service_case: projectCase(result.serviceCase) }),
    );
  } catch (error) {
    return storeError(error);
  }
}

async function closeCase(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
): Promise<Response> {
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!onlyKeys(body, ["closure_reason", "detail_code", "evidence_digest"])) {
    return json({ error: "unexpected_field" }, 400);
  }
  const closureReason = oneOf(
    body.closure_reason,
    SERVICE_CLOSURE_REASONS.filter((reason) => reason !== "duplicate"),
  );
  if (!closureReason) return json({ error: "invalid_service_closure" }, 400);
  const evidenceDigest =
    body.evidence_digest === undefined || body.evidence_digest === null
      ? null
      : digest(body.evidence_digest);
  if (body.evidence_digest !== undefined && body.evidence_digest !== null && !evidenceDigest) {
    return json({ error: "invalid_service_closure" }, 400);
  }

  try {
    const serviceCase = await closeServiceCase(env, {
      tenantId: auth.session.tenant_id,
      serviceCaseId: caseId,
      closureReason: closureReason as Exclude<ServiceClosureReason, "duplicate">,
      detailCode: optionalCode(body.detail_code, 3, 120),
      evidenceDigest,
      actorUserId: auth.session.user_id,
      now: new Date().toISOString(),
    });
    return json(envelope(auth, { service_case: projectCase(serviceCase) }));
  } catch (error) {
    return storeError(error);
  }
}

async function reopenCase(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
): Promise<Response> {
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!onlyKeys(body, ["reopen_code"])) return json({ error: "unexpected_field" }, 400);
  const reopenCode = codeText(body.reopen_code, 3, 120);
  if (!reopenCode) return json({ error: "invalid_service_reopen" }, 400);

  try {
    const serviceCase = await reopenServiceCase(env, {
      tenantId: auth.session.tenant_id,
      serviceCaseId: caseId,
      reopenCode,
      actorUserId: auth.session.user_id,
      now: new Date().toISOString(),
    });
    return json(envelope(auth, { service_case: projectCase(serviceCase) }));
  } catch (error) {
    return storeError(error);
  }
}

async function openClaim(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
): Promise<Response> {
  if (auth.session.role !== "owner") return json({ error: "owner_role_required" }, 403);
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (
    !onlyKeys(body, [
      "counterparty_kind",
      "counterparty_ref",
      "claim_basis_code",
      "claimed_amount_cents",
      "evidence_digest",
      "deadline_at",
    ])
  ) {
    return json({ error: "unexpected_field" }, 400);
  }
  const counterpartyKind = oneOf(body.counterparty_kind, COUNTERPARTY_KINDS);
  const counterpartyRef = boundedText(body.counterparty_ref, 3, 140);
  const claimBasisCode = codeText(body.claim_basis_code, 3, 120);
  const claimedAmountCents = boundedInteger(body.claimed_amount_cents, 1, 100_000_000);
  const evidenceDigest = digest(body.evidence_digest);
  const deadlineAt = isoTimestamp(body.deadline_at);
  if (
    !counterpartyKind ||
    !counterpartyRef ||
    !claimBasisCode ||
    claimedAmountCents === null ||
    !evidenceDigest ||
    !deadlineAt
  ) {
    return json({ error: "invalid_cost_recovery_claim" }, 400);
  }
  const now = new Date().toISOString();
  if (Date.parse(deadlineAt) <= Date.parse(now)) {
    return json({ error: "cost_recovery_deadline_passed" }, 400);
  }

  try {
    const tenantId = auth.session.tenant_id;
    const diagnosis = (
      await listServiceCaseDiagnoses(env, { tenantId, serviceCaseId: caseId })
    ).at(-1);
    if (!diagnosis) return json({ error: "service_case_diagnosis_required" }, 409);
    const result = await openCostRecoveryClaim(env, {
      claimId: newId("svc_recovery"),
      tenantId,
      serviceCaseId: caseId,
      diagnosisId: diagnosis.diagnosis_id,
      counterpartyKind,
      counterpartyRef,
      claimBasisCode,
      claimedAmountCents,
      evidenceDigest,
      actorUserId: auth.session.user_id,
      actorRole: auth.session.role,
      deadlineAt,
      now,
    });
    return json(
      envelope(auth, { result: result.kind, claim: projectClaim(result.claim) }),
      result.kind === "opened" ? 201 : 200,
    );
  } catch (error) {
    return storeError(error);
  }
}

async function leaseClaimAttempt(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
  claimId: string,
): Promise<Response> {
  if (auth.session.role !== "owner") return json({ error: "owner_role_required" }, 403);
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!onlyKeys(body, ["lease_seconds"])) return json({ error: "unexpected_field" }, 400);
  const leaseSeconds = boundedInteger(body.lease_seconds, MIN_LEASE_SECONDS, MAX_LEASE_SECONDS);
  if (leaseSeconds === null) return json({ error: "invalid_cost_recovery_lease" }, 400);

  try {
    const owned = await claimBelongsToCase(env, auth, caseId, claimId);
    if (!owned) return json({ error: "not_found" }, 404);
    const now = new Date();
    const result = await claimCostRecoveryEffect(env, {
      tenantId: auth.session.tenant_id,
      claimId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1_000).toISOString(),
    });
    if (result.kind === "missing") return json({ error: "not_found" }, 404);
    return json(
      envelope(auth, { result: result.kind, claim: projectClaim(result.claim) }),
      result.kind === "claimed" ? 200 : 409,
    );
  } catch (error) {
    return storeError(error);
  }
}

async function recordClaimResult(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
  claimId: string,
): Promise<Response> {
  if (auth.session.role !== "owner") return json({ error: "owner_role_required" }, 403);
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (
    !onlyKeys(body, ["outcome", "result_ref", "result_code", "recovered_amount_cents"])
  ) {
    return json({ error: "unexpected_field" }, 400);
  }
  const outcome = oneOf(body.outcome, ["succeeded", "failed", "uncertain"] as const);
  const resultRef = boundedText(body.result_ref, 3, 140);
  const resultCode = optionalCode(body.result_code, 3, 120);
  const recoveredAmountCents =
    body.recovered_amount_cents === undefined || body.recovered_amount_cents === null
      ? null
      : boundedInteger(body.recovered_amount_cents, 0, 100_000_000);
  if (!outcome || !resultRef) return json({ error: "invalid_cost_recovery_result" }, 400);
  if (outcome === "succeeded" && recoveredAmountCents === null) {
    return json({ error: "cost_recovery_recovered_amount_required" }, 400);
  }
  if (outcome !== "succeeded" && !resultCode) {
    return json({ error: "cost_recovery_result_code_required" }, 400);
  }

  try {
    const owned = await claimBelongsToCase(env, auth, caseId, claimId);
    if (!owned) return json({ error: "not_found" }, 404);
    const claim = await finalizeCostRecoveryEffect(env, {
      tenantId: auth.session.tenant_id,
      claimId,
      outcome,
      resultRef,
      resultCode,
      recoveredAmountCents,
      now: new Date().toISOString(),
    });
    return json(envelope(auth, { claim: projectClaim(claim) }));
  } catch (error) {
    return storeError(error);
  }
}

async function reconcileClaim(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
  claimId: string,
): Promise<Response> {
  if (auth.session.role !== "owner") return json({ error: "owner_role_required" }, 403);
  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (
    !onlyKeys(body, ["outcome", "reconciliation_ref", "recovered_amount_cents"])
  ) {
    return json({ error: "unexpected_field" }, 400);
  }
  const outcome = oneOf(body.outcome, ["executed", "not_executed", "inconclusive"] as const);
  const reconciliationRef = boundedText(body.reconciliation_ref, 3, 140);
  const recoveredAmountCents =
    body.recovered_amount_cents === undefined || body.recovered_amount_cents === null
      ? null
      : boundedInteger(body.recovered_amount_cents, 0, 100_000_000);
  if (!outcome || !reconciliationRef) {
    return json({ error: "invalid_cost_recovery_reconciliation" }, 400);
  }
  if (outcome === "executed" && recoveredAmountCents === null) {
    return json({ error: "cost_recovery_recovered_amount_required" }, 400);
  }

  try {
    const owned = await claimBelongsToCase(env, auth, caseId, claimId);
    if (!owned) return json({ error: "not_found" }, 404);
    const claim = await reconcileCostRecoveryEffect(env, {
      tenantId: auth.session.tenant_id,
      claimId,
      outcome,
      reconciliationRef,
      recoveredAmountCents,
      now: new Date().toISOString(),
    });
    return json(envelope(auth, { claim: projectClaim(claim) }));
  } catch (error) {
    return storeError(error);
  }
}

/**
 * A remedy id from the browser is only meaningful under the case that owns it; without this the
 * URL's case would be decoration and one case's session could verify another case's remedy.
 */
async function remedyBelongsToCase(
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
  remedyId: string,
): Promise<boolean> {
  const remedies = await listServiceCaseRemedies(env, {
    tenantId: auth.session.tenant_id,
    serviceCaseId: caseId,
  });
  return remedies.some((remedy) => remedy.remedy_id === remedyId);
}

async function claimBelongsToCase(
  env: AppEnv,
  auth: AuthContext,
  caseId: string,
  claimId: string,
): Promise<boolean> {
  const claims = await listCostRecoveryClaims(env, {
    tenantId: auth.session.tenant_id,
    serviceCaseId: caseId,
  });
  return claims.some((claim) => claim.claim_id === claimId);
}

function projectCase(record: ServiceCaseRecord): Record<string, unknown> {
  const { tenant_id: _tenantId, ...rest } = record;
  return rest;
}

/**
 * `request_hash` is an internal effect-runtime identity, not office information; the rest of the
 * claim, including who authorized it and under which triage decision, is what the office reviews.
 */
function projectClaim(claim: ServiceCostRecoveryClaimRecord): Record<string, unknown> {
  const { tenant_id: _tenantId, request_hash: _requestHash, ...rest } = claim;
  return rest;
}

function envelope(auth: AuthContext, body: Record<string, unknown>): Record<string, unknown> {
  return {
    version: APP_API_VERSION,
    read_model_generated_at: new Date().toISOString(),
    allowed_actions: allowedActions(auth),
    ...body,
  };
}

function allowedActions(auth: AuthContext): string[] {
  return SERVICE_CASE_ALLOWED_ACTIONS.filter(
    (action) => action !== "service_case.recover_cost" || auth.session.role === "owner",
  );
}

function officeRole(auth: AuthContext): boolean {
  return auth.session.role === "owner" || auth.session.role === "ops";
}

/**
 * Store and trigger failures are business outcomes, not server faults: a caller that tried an
 * illegal transition deserves the code D1 raised, at a status that says "not while the case is in
 * this state" rather than "IronWrap OS is broken".
 */
function storeError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "service_case_store_unavailable";
  if (message === "service_case_not_found") return json({ error: "not_found" }, 404);
  if (message === "service_case_diagnosis_not_found") return json({ error: "not_found" }, 404);
  if (message === "service_case_remedy_not_found") return json({ error: "not_found" }, 404);
  if (message === "service_cost_recovery_claim_not_found") {
    return json({ error: "not_found" }, 404);
  }
  const refusal = conflictCode(message);
  if (refusal !== null) return json({ error: refusal }, 409);
  return json({ error: "service_case_store_unavailable" }, 502);
}

/** A lifecycle rule code as `0056`'s triggers raise it, and as the store's own guards throw it. */
const DOMAIN_RULE_CODE = /^(?:service_case|service_cost_recovery)_[a-z0-9_]{2,100}$/;

/**
 * Real D1 does not hand back the bare SQLite message. It wraps it -- `D1_ERROR:
 * service_case_event_type_mismatch: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)` -- and
 * says `SQLITE_CONSTRAINT`, never SQLite's own `constraint failed` wording. A start-anchored match
 * on the rule code therefore missed every one of `0056`'s 38 `RAISE(ABORT, ...)` refusals in
 * production, and each answered `502 service_case_store_unavailable` instead of the rule that
 * refused it (Multica ELEC-22 §5). Only the in-repo fake, which forwarded `node:sqlite`'s bare
 * message, ever matched -- which is exactly why CI stayed green over the defect.
 *
 * So the shape decides, not the prefix: a constraint marker anywhere means the caller was refused,
 * and a bare rule code on its own is the store's own JS-thrown guard. Anything else really is a
 * fault -- `no such table: service_case_events` carries a rule-code-looking token but no constraint
 * marker, and must stay a 502 rather than being dressed up as a business outcome.
 *
 * @returns the rule code to answer `409` with, or `null` when this is a genuine server fault.
 */
function conflictCode(message: string): string | null {
  const bare = message.trim();
  if (DOMAIN_RULE_CODE.test(bare)) return bare;
  if (!/SQLITE_CONSTRAINT|constraint failed|\bABORT\b/i.test(bare)) return null;
  const raised = bare.match(/(?:D1_ERROR|ABORT|constraint failed):?\s*([a-z0-9_]+)/i);
  if (raised && DOMAIN_RULE_CODE.test(raised[1])) return raised[1];
  const anywhere = bare.match(/(?:service_case|service_cost_recovery)_[a-z0-9_]{2,100}/);
  return anywhere?.[0] ?? "service_case_transition_refused";
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * `Number(null)` and `Number("")` are `0`, not `NaN`, so a `Number.isFinite` guard alone lets an
 * absent `?limit=` fall through to the clamp and collapse the desk to a single case. An absent or
 * blank parameter is the default, never a bound.
 */
function listLimit(value: string | null): number {
  if (value === null || value.trim().length === 0) return DEFAULT_LIST_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 160 && !decoded.includes("/") ? decoded : null;
  } catch {
    return null;
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function boundedText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

function optionalText(value: unknown, min: number, max: number): string | null {
  if (value === undefined || value === null) return null;
  return boundedText(value, min, max);
}

function codeText(value: unknown, min: number, max: number): string | null {
  const text = boundedText(value, min, max);
  return text && /^[a-z0-9_]+$/.test(text) ? text : null;
}

function optionalCode(value: unknown, min: number, max: number): string | null {
  if (value === undefined || value === null) return null;
  return codeText(value, min, max);
}

function refText(value: unknown, min: number, max: number): string | null {
  const text = boundedText(value, min, max);
  return text && /^[A-Za-z0-9._:-]+$/.test(text) ? text : null;
}

function optionalRefText(value: unknown, min: number, max: number): string | null {
  if (value === undefined || value === null) return null;
  return refText(value, min, max);
}

function optionalCaseId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = boundedText(value, 10, 100);
  return text && /^svc_case_[a-z0-9_]+$/.test(text) ? text : null;
}

function digest(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= min && value <= max ? value : null;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 20 || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

async function readJson(
  req: Request,
): Promise<
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string; status: number }
> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_SERVICE_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
  if (raw.length > MAX_SERVICE_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "invalid_json", status: 400 };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
