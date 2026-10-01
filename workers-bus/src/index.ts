// index.ts — the IronWrap integration bus (one Worker: fetch + queue + scheduled).
//
// Flow (spec 01/04/06): inbound → raw to R2 FIRST → canonical envelope to D1 (system of
// record) → instant-ack OFF the owned-store write → enqueue JobNimbus push. The queue
// consumer does the idempotent, retried JN push (pending_jn_push → pushed); a 5-min cron
// re-drives anything stuck; a daily cron reconciles source vs landed and emits the heartbeat.

import {
  ALLOWED_SOURCES,
  type Source,
  type EnvelopeRecord,
  newEnvelopeId,
  normalizeEnvelope,
  dedupKey,
  validateInbound,
  classifyIntent,
  reconcileDiff,
  parseBody,
  validateSourceCount,
  operatingTenantId,
  isOn,
  RELEASE_SMOKE_HEADER,
  RELEASE_SMOKE_HEADER_VALUE,
  RELEASE_SMOKE_FIXTURE_ERROR,
  isReleaseSmokeFixture,
} from "./core.ts";
import * as store from "./store.ts";
import { flattenEnv } from "./env-bindings.ts";
import {
  BULK_REPLAY_CONFIRMATION,
  executeReplayRequest,
  getOperationalStatus,
  getNewoOpenIncidentCount,
  getReadiness,
  runOwnerWatchdog,
  sweepDeadLetterAutoReplay,
  validateReplayApprovalContext,
} from "./operations.ts";
import { getCronLiveness, type CronLivenessReport } from "./cron-liveness.ts";
import { ingestLead } from "./lead-intake.ts";
import { companyLogoResponse } from "./company-profile.ts";
import { pushToJobNimbus } from "./jobnimbus.ts";
import { materializeOperatingCore } from "./operating-core.ts";
import { sendInstantAck, sendOwnerAlert, sendDailyDigest } from "./notify.ts";
import { handlePhotoIngest } from "./photos.ts";
import {
  handleMeasurementDeadLetter,
  handleMeasurementIngest,
  handleMeasurementQueueMessage,
  retryMeasurementIntakeReceipts,
} from "./measurements.ts";
import { handleEstimateIngest, retryEstimateOperatingCoreMaterializations } from "./estimates.ts";
import {
  handleFacetDesignIngest,
  reconcileFacetV2UnassociatedIntakes,
} from "./facet-design-ingest.ts";
import { handleFacetEstimatorReadyIngest } from "./facet-prequote.ts";
import {
  handleQuickbooksWebhook,
  recoverDueQuickBooksProjections,
} from "./quickbooks.ts";
// The IRO-52 money-plane sweeps are the same class of scheduled reconciliation work as the
// QuickBooks recovery above, so they are registered on the same frequent cron.
import {
  accountingSweepIsNoteworthy,
  accountingSweepTenantId,
  runAccountingSweeps,
} from "./accounting-sweeps.ts";
// The dispatcher itself. Same cron, same class of work: `submission_pending` is an outbox and this
// is what drains it (contract section 8.1).
import {
  runAccountingCompensationDispatch,
  runAccountingDispatch,
} from "./accounting-dispatch.ts";
// ...and what it dispatches *through*. ELEC-74: the call above existed, the connection did not.
import { resolveAccountingDispatchBinding } from "./accounting-dispatch-binding.ts";
import {
  accountingIntentReobserver,
  resolveAccountingObservationBinding,
} from "./accounting-reobservation.ts";
import {
  handleQuickBooksOAuthCallback,
  recoverQuickBooksFinalInvoices,
} from "./quickbooks-final-invoice.ts";
import { deriveNativeFinalInvoiceIntents } from "./native-final-invoice-producer.ts";
import { reconcileFacetDesignNativeProjections } from "./facet-design-projection.ts";
import { reconcileFacetDesignFrappeProjections } from "./facet-design-frappe-projection.ts";
import {
  recoverPostizControlPlane,
} from "./postiz.ts";
import {
  handlePublicInstantEstimate,
  prunePublicEstimateRateLimits,
  type PublicEstimatorEnv,
} from "./public-estimator.ts";
import { ensureJobFolder, googleConfigured } from "./google.ts";
import {
  handleAdminFirstOwnerBootstrap,
  handleAppApi,
  recoverPendingLeadTriageOutbox,
} from "./app-api.ts";
import { handleAuthorityRecordExecutorRoute } from "./authority-record-executor-api.ts";
import { pruneAuthRecords } from "./app-auth-store.ts";
import { handleCustomerPortalResolve } from "./customer-portal.ts";
import {
  handleCustomerPortalAcceptanceChallenge,
  handleCustomerPortalAcceptanceConfirm,
  reconcileCustomerContractAcceptanceAttempts,
} from "./customer-contract-acceptance.ts";
import {
  handleCustomerPortalDecision,
  reconcileCustomerPortalDecisionAttempts,
} from "./customer-portal-decision.ts";
import { pruneCustomerPortalRecords } from "./customer-portal-store.ts";
import {
  listMeasurementIntakeExceptions,
  pruneMeasurementIntakeReceipts,
  projectMeasurementIntakeAdminException,
  type MeasurementIntakeAdminException,
} from "./measurement-intake-store.ts";
import {
  listMeasurementDeltas,
  measurementCalibrationReport,
} from "./measurement-deltas-store.ts";
import { markExpiredExecutionLeases } from "./approval-store.ts";
import {
  handleExternalEffectClaim,
  handleExternalEffectReconciliation,
  handleExternalEffectRetry,
  handleExternalEffectSettlement,
} from "./effect-runtime-admin.ts";
import { recoverExpiredExternalEffects } from "./effect-runtime.ts";
import { drainPipelineStageAutomation } from "./pipeline-automation.ts";
import { markExpiredQuoteRevisionApprovalExecutionLeases } from "./quote-revision-approval-store.ts";
import { markExpiredProductionScheduleApprovalExecutionLeases } from "./production-schedule-approval-store.ts";
import {
  handleNewoQueueMessage,
  handleNewoWebhook,
  reconcileNewoSessions,
  type NewoQueueMessage,
} from "./newo.ts";
import { handleNewoAdmin } from "./newo-admin.ts";
import { handleCrmImport } from "./crm-import-api.ts";
import {
  newoOperationalCounts,
  recordNewoReconciliationRun,
} from "./newo-store.ts";

type BusQueueMessage =
  | { envelope_id: string }
  | { measurement_receipt_id: string; lease_token: string }
  | NewoQueueMessage;

const MAX_BODY_BYTES = 256 * 1024;
const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

async function recoverLeadTriageOutboxThenExpireLeases(env: Env): Promise<void> {
  try {
    await recoverPendingLeadTriageOutbox(env);
  } catch (error) {
    log({ at: "approval_outbox_recovery", error: String(error) });
  }
  // A broker timeout must never trigger a second write. Recovery runs first
  // only for a provably never-attempted outbox; every other lease expires into
  // owner-visible reconciliation work.
  try {
    await markExpiredExecutionLeases(env, new Date().toISOString());
  } catch (error) {
    log({ at: "approval_lease_sweep", error: String(error) });
  }
}

async function reconcileFacetDesignSurfaces(env: Env): Promise<void> {
  try {
    await reconcileFacetV2UnassociatedIntakes(env);
    await reconcileFacetDesignNativeProjections(env);
  } catch (error) {
    log({ at: "facet_design_native_projection_reconcile", error: String(error) });
  }
  try {
    await reconcileFacetDesignFrappeProjections(
      env as import("./app-types.ts").AppEnv,
    );
  } catch (error) {
    log({ at: "facet_design_frappe_compatibility_reconcile", error: String(error) });
  }
}

async function deriveThenRecoverQuickBooksFinalInvoices(env: Env): Promise<void> {
  try {
    const derivation = await deriveNativeFinalInvoiceIntents(
      env as import("./app-types.ts").AppEnv,
    );
    if (
      derivation.blocked > 0 ||
      derivation.no_balance > 0 ||
      derivation.intents_derived > 0 ||
      derivation.intents_replayed > 0
    ) {
      log({ at: "native_final_invoice_derivation", ...derivation });
    }
  } catch (error) {
    log({ at: "native_final_invoice_derivation", error: String(error) });
  }
  const recovery = await recoverQuickBooksFinalInvoices(
    env as import("./app-types.ts").AppEnv,
  );
  if (recovery.discovered > 0 || recovery.effects_processed > 0) {
    log({ at: "quickbooks_final_invoice_recovery", ...recovery });
  }
}
const escapeHtml = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");
const safeJson = (s: string): Record<string, unknown> => {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export default {
  async fetch(
    req: Request,
    boundEnv: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const env = flattenEnv(boundEnv);
    const requestId = requestIdFor(req);
    const startedAt = Date.now();
    let response: Response;
    let errorCode: string | null = null;
    try {
      response = await routeRequest(withRequestId(req, requestId), env, ctx);
    } catch {
      errorCode = "unhandled_exception";
      response = json({ error: "internal" }, 500);
    }
    const completed = withResponseHeaders(response, requestId);
    logRequestCompletion(req, env, completed, requestId, startedAt, errorCode);
    return completed;
  },

  async queue(
    batch: MessageBatch<BusQueueMessage>,
    boundEnv: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const env = flattenEnv(boundEnv);
    const isDlq = batch.queue.endsWith("-dlq");
    for (const msg of batch.messages) {
      try {
        if ("measurement_receipt_id" in msg.body) {
          const receiptId = msg.body.measurement_receipt_id;
          if (isDlq) {
            const created = await handleMeasurementDeadLetter(
              env,
              receiptId,
              msg.body.lease_token,
            );
            if (created) {
              await sendOwnerAlert(
                env,
                "DEAD-LETTER: measurement processing exhausted retries",
                `<p>Measurement receipt <b>${escapeHtml(receiptId)}</b> exhausted Queue retries.</p>
                 <p>The durable exception is visible in IronWrap owner operations.</p>`,
              ).catch((error) =>
                log({
                  at: "measurement_deadletter_alert_failed",
                  receipt_id: receiptId,
                  error: String(error),
                })
              );
            }
          } else {
            await handleMeasurementQueueMessage(
              env,
              receiptId,
              msg.body.lease_token,
            );
          }
        } else if ("newo_event_id" in msg.body) {
          await handleNewoQueueMessage(env, msg.body.newo_event_id, isDlq);
        } else if (isDlq) await handleDead(env, msg.body.envelope_id);
        else await handlePush(env, msg.body.envelope_id);
        msg.ack();
      } catch (err) {
        log({
          at: "queue",
          queue: batch.queue,
          message_id: "measurement_receipt_id" in msg.body
            ? msg.body.measurement_receipt_id
            : "newo_event_id" in msg.body
              ? msg.body.newo_event_id
              : msg.body.envelope_id,
          error: String(err),
        });
        msg.retry(); // exhausting retries on the main queue routes to the DLQ (wrangler.jsonc)
      }
    }
  },

  async scheduled(
    controller: ScheduledController,
    boundEnv: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const env = flattenEnv(boundEnv);
    if (controller.cron === "0 14 * * *") {
      ctx.waitUntil(
        store.markCronTickStarted(env, controller.cron).catch((error) =>
          log({ at: "cron_heartbeat", cron: controller.cron, error: String(error) })
        ).then(() => Promise.all([
          runReconcile(env),
          runOwnerWatchdog(env).catch((error) =>
            log({ at: "owner_watchdog", error: String(error) })
          ),
          runNewoDailyReconcile(env).catch((error) =>
            log({ at: "newo_daily_reconcile", error: String(error) })
          ),
          pruneAuthRecords(env).catch((error) =>
            log({ at: "auth_prune", error: String(error) }),
          ),
          pruneCustomerPortalRecords(env).catch((error) =>
            log({ at: "customer_portal_prune", error: String(error) }),
          ),
          pruneMeasurementIntakeReceipts(env).catch((error) =>
            log({ at: "measurement_receipt_prune", error: String(error) }),
          ),
          prunePublicEstimateRateLimits(env as PublicEstimatorEnv).catch((error) =>
            log({ at: "public_estimate_rate_limit_prune", error: String(error) }),
          ),
        ]).then(() => {})).then(
          () =>
            store.markCronTickSettled(env, controller.cron, "ok").catch((error) =>
              log({ at: "cron_heartbeat", cron: controller.cron, error: String(error) })
            ),
          async (error) => {
            log({ at: "cron_tick", cron: controller.cron, error: String(error) });
            await store.markCronTickSettled(env, controller.cron, "error").catch((writeError) =>
              log({ at: "cron_heartbeat", cron: controller.cron, error: String(writeError) })
            );
            // Re-raise so Cloudflare still records the invocation as an exception, as it did before
            // the heartbeat wrapped the composed work. `status='error'` is evidence, not a
            // replacement for that signal.
            throw error;
          },
        ),
      );
    } else if (controller.cron === "*/5 * * * *") {
      // Resolved once and awaited by both money dispatchers below. `catch` rather than a throw:
      // a connection lookup that fails is the unbound case, not a reason to fail the whole tick.
      const accountingDispatchBinding = resolveAccountingDispatchBinding(
        env as import("./app-types.ts").AppEnv,
        { tenantId: accountingSweepTenantId(env as import("./app-types.ts").AppEnv) },
      ).catch((error) => {
        log({ at: "accounting_money_dispatch_binding", error: String(error) });
        return null;
      });
      // Resolved separately from the dispatch binding, and deliberately so: re-observing needs a
      // QuickBooks connection and nothing else, while dispatching also needs the effect ledger. A
      // Worker with the ledger switched off must still be able to re-read what it already posted.
      const accountingObservationBinding = resolveAccountingObservationBinding(
        env as import("./app-types.ts").AppEnv,
        { tenantId: accountingSweepTenantId(env as import("./app-types.ts").AppEnv) },
      ).catch((error) => {
        log({ at: "accounting_money_observation_binding", error: String(error) });
        return null;
      });
      ctx.waitUntil(
        store.markCronTickStarted(env, controller.cron).catch((error) =>
          log({ at: "cron_heartbeat", cron: controller.cron, error: String(error) })
        ).then(() => Promise.all([
          retrySweep(env),
          reconcileNewoSessions(env).catch((error) =>
            log({ at: "newo_five_minute_reconcile", error: String(error) })
          ),
          retryMeasurementIntakeReceipts(env).catch((error) =>
            log({ at: "measurement_intake_retry", error: String(error) }),
          ),
          retryEstimateOperatingCoreMaterializations(env).catch((error) =>
            log({ at: "estimate_operating_core_retry", error: String(error) }),
          ),
          recoverDueQuickBooksProjections(env).then((result) => {
            if (result.due > 0) log({ at: "quickbooks_projection_recovery", ...result });
          }).catch((error) =>
            log({ at: "quickbooks_projection_recovery", error: String(error) }),
          ),
          // ELEC-52 / IRO-194: the dual-surface pipeline heals itself instead of waiting for an
          // admin to notice a dead letter. Silent when there is no dead-letter backlog at all.
          sweepDeadLetterAutoReplay(env).then((result) => {
            if (result.scanned > 0) log({ at: "dead_letter_auto_replay", ...result });
          }).catch((error) =>
            log({ at: "dead_letter_auto_replay", error: String(error) }),
          ),
          deriveThenRecoverQuickBooksFinalInvoices(env).catch(() =>
            log({ at: "quickbooks_final_invoice_recovery", error: "quickbooks_recovery_failed" })
          ),
          reconcileCustomerContractAcceptanceAttempts(env).catch((error) =>
            log({ at: "customer_contract_acceptance_reconcile", error: String(error) }),
          ),
          reconcileCustomerPortalDecisionAttempts(env).catch((error) =>
            log({ at: "customer_portal_decision_reconcile", error: String(error) }),
          ),
          reconcileFacetDesignSurfaces(env),
          recoverLeadTriageOutboxThenExpireLeases(env),
          recoverPostizControlPlane(env as import("./app-types.ts").AppEnv).then((result) => {
            if (result.effects_processed > 0 || result.intents_reconciled > 0)
              log({ at: "postiz_control_plane_recovery", ...result });
          }).catch((error) =>
            log({ at: "postiz_control_plane_recovery", error: String(error) })
          ),
          // Quote-revision execution has an independent ledger and broker. Its
          // lease therefore becomes explicit reconciliation work independently of
          // the lead-triage authority.
          markExpiredQuoteRevisionApprovalExecutionLeases(
            env,
            new Date().toISOString(),
          ).catch((error) =>
            log({
              at: "quote_revision_approval_lease_sweep",
              error: String(error),
            }),
          ),
          // Scheduling has an independent append-only assignment ledger. An
          // orphaned execution lease must likewise become reconciliation work,
          // never a second dispatch attempt.
          markExpiredProductionScheduleApprovalExecutionLeases(
            env,
            new Date().toISOString(),
          ).catch((error) =>
            log({
              at: "production_schedule_approval_lease_sweep",
              error: String(error),
            }),
          ),
          // IRO-52. The money-plane dispatcher: it is what turns an accountant's approve into a
          // provider mutation and an authorized compensation into a reversal. `submission_pending`
          // is its queue, the same way the final-invoice outbox is drained here rather than by a
          // Cloudflare Queue (contract section 8.1).
          //
          // The binding is resolved once per tick and shared by both dispatchers, so one tick
          // performs one connection lookup rather than two. It resolves to `null` - and both
          // dispatchers fall back to reporting what is waiting and dispatching nothing - whenever
          // the effect ledger is disabled, QuickBooks OAuth is unconfigured, or the tenant has
          // never connected a realm. ELEC-74 proved that unbound path was *all* there was: no
          // production code constructed a binding at all, so an approved intent sat in
          // `submission_pending` forever.
          accountingDispatchBinding.then((binding) =>
            runAccountingDispatch(env as import("./app-types.ts").AppEnv, {
              tenantId: accountingSweepTenantId(env as import("./app-types.ts").AppEnv),
              ...(binding ? { binding } : {}),
            })
          ).then((report) => {
            if (report.pending.length > 0 || report.dispatched.length > 0) {
              log({
                at: "accounting_money_dispatch",
                tenant_id: report.tenant_id,
                pending: report.pending.length,
                dispatched: report.dispatched.length,
                expectation_unbound: report.expectation_unbound.length,
                // Per intent, with the code that stopped each one: an aggregate count is what
                // made ELEC-73's head-of-line block invisible in the first place.
                failed: report.failed,
                dispatcher_unbound: report.dispatcher_unbound,
              });
            }
          }).catch((error) =>
            log({ at: "accounting_money_dispatch", error: String(error) }),
          ),
          accountingDispatchBinding.then((binding) =>
            runAccountingCompensationDispatch(env as import("./app-types.ts").AppEnv, {
              tenantId: accountingSweepTenantId(env as import("./app-types.ts").AppEnv),
              ...(binding ? { binding } : {}),
            })
          ).then((report) => {
            if (report.authorized.length > 0 || report.refused.length > 0) {
              log({
                at: "accounting_money_compensation_dispatch",
                tenant_id: report.tenant_id,
                authorized: report.authorized.length,
                dispatched: report.dispatched.length,
                refused: report.refused.length,
                dispatcher_unbound: report.dispatcher_unbound,
              });
            }
          }).catch((error) =>
            log({ at: "accounting_money_compensation_dispatch", error: String(error) }),
          ),
          // IRO-52 slices S8 and S11. Four money-plane sweeps: due observations, the `unknown`
          // dispatch deadline, exception ageing, and dispatches that have stopped moving.
          //
          // The due-observation sweep is the half S11 finished. Until this binding existed it ran
          // with no reader at all (ELEC-77), so a dispatched invoice sat at `partially_settled`
          // forever and `reconciled` was unreachable in the shipped product no matter what the
          // customer paid. It now re-observes through the same connection the dispatcher uses:
          // read the entity by its exact id, observe the Payments that entity declares, judge once.
          // Unbound stays exactly what it was - the sweep reports what is due and re-reads nothing,
          // because a timer is not evidence (contract section 5.1).
          accountingObservationBinding.then((binding) =>
            runAccountingSweeps(env as import("./app-types.ts").AppEnv, {
              tenantId: accountingSweepTenantId(env as import("./app-types.ts").AppEnv),
              ...(binding
                ? {
                  reobserve: accountingIntentReobserver(
                    env as import("./app-types.ts").AppEnv,
                    binding,
                  ),
                }
                : {}),
            })
          ).then((report) => {
            if (accountingSweepIsNoteworthy(report)) {
              log({
                at: "accounting_money_sweep",
                tenant_id: report.tenant_id,
                due_observations: report.due_observations.due.length,
                reader_unbound: report.due_observations.reader_unbound,
                reread: report.due_observations.reread,
                reconciled: report.due_observations.reconciled,
                partially_settled: report.due_observations.partially_settled,
                mismatched: report.due_observations.mismatched,
                uncertain_expired: report.uncertain.expired.length,
                exceptions_ageing: report.exceptions.ageing.length,
                stuck_dispatches: report.stuck_dispatches.stuck.length,
              });
            }
          }).catch((error) =>
            log({ at: "accounting_money_sweep", error: String(error) }),
          ),
          recoverExpiredExternalEffects(
            env as import("./app-types.ts").AppEnv,
          ).then((result) => {
            if (result.recovered > 0 || result.failed > 0) log({ at: "external_effect_lease_sweep", ...result });
          }).catch((error) =>
            log({ at: "external_effect_lease_sweep", error: String(error) }),
          ),
          drainPipelineStageAutomation(env as import("./app-types.ts").AppEnv).then((result) => {
            log({
              at: "pipeline_stage_automation_drain",
              enabled: result.enabled,
              available: result.available,
              scanned: result.scanned,
              claimed: result.claimed,
              sent: result.sent,
              retried: result.retried,
              failed: result.failed,
              unknown: result.unknown,
              no_rule: result.no_rule,
              recovered: result.recovered,
              unavailable: result.unavailable,
            });
          }).catch((error) =>
            log({ at: "pipeline_stage_automation_drain", error: String(error) }),
          ),
        ]).then(() => {})).then(
          () =>
            store.markCronTickSettled(env, controller.cron, "ok").catch((error) =>
              log({ at: "cron_heartbeat", cron: controller.cron, error: String(error) })
            ),
          async (error) => {
            log({ at: "cron_tick", cron: controller.cron, error: String(error) });
            await store.markCronTickSettled(env, controller.cron, "error").catch((writeError) =>
              log({ at: "cron_heartbeat", cron: controller.cron, error: String(writeError) })
            );
            // Re-raise so Cloudflare still records the invocation as an exception, as it did before
            // the heartbeat wrapped the composed work. `status='error'` is evidence, not a
            // replacement for that signal.
            throw error;
          },
        ),
      ); // the frequent cron
    }
  },
} satisfies ExportedHandler<Env, BusQueueMessage>;

async function routeRequest(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  // Preserve the original cheap liveness contract for platform health checks. Readiness is
  // intentionally separate because it can fail while the isolate itself is healthy.
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/health")
    return methodAwareJson(req, { ok: true });
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/ready") {
    const readiness = await getReadiness(env);
    const scope = url.searchParams.get("scope");
    // Cron rows are read only for scope=ops, so every other scope keeps its current cost.
    const cronLiveness: CronLivenessReport | null = scope === "ops" ? await getCronLiveness(env) : null;
    const verdict = scope === "core" || scope === "owned_core"
      ? readiness.owned_core_ok
      : scope === "office"
      ? readiness.office_operating_plane_ok
      : scope === "projection"
      ? readiness.projection_rails_ok
      : scope === "ops"
      ? readiness.owned_core_ok && (cronLiveness as CronLivenessReport).ok
      : readiness.ok;
    // Keep public monitoring useful without advertising the state of every
    // downstream rail to an unauthenticated caller. Operators can use the
    // existing admin bearer token for the diagnostic check map.
    if (!constantTimeEqual(bearer(req), env.ADMIN_TOKEN))
      return methodAwareJson(req, { ok: verdict }, verdict ? 200 : 503);
    return methodAwareJson(
      req,
      cronLiveness ? { ...readiness, crons: cronLiveness.crons } : readiness,
      verdict ? 200 : 503,
    );
  }
  if (url.pathname.startsWith("/internal/v1/authority-records/")) {
    const authorityResponse = await handleAuthorityRecordExecutorRoute(
      req,
      env as import("./app-types.ts").AppEnv,
    );
    if (authorityResponse) return authorityResponse;
  }
  if (url.pathname === "/oauth/quickbooks/callback") {
    return await handleQuickBooksOAuthCallback(
      req,
      env as import("./app-types.ts").AppEnv,
    );
  }
  // The tenant's own logo. Public because the estimate request form and the sign-in screen both
  // render it before there is any session; it carries no tenant data beyond the image the owner
  // uploaded for exactly that purpose.
  if (url.pathname === "/public/company-logo") {
    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const tenantId = operatingTenantId(
      (env as Env & { APP_TENANT_ID?: string }).APP_TENANT_ID,
    );
    if (!tenantId) return json({ error: "not_found" }, 404);
    return await companyLogoResponse(env as import("./app-types.ts").AppEnv, tenantId);
  }
  // Public estimator traffic is browser-origin constrained and has independent
  // Turnstile/rate controls. It never accepts the private ingest bearer token.
  if (url.pathname.startsWith("/public/")) {
    return await handlePublicInstantEstimate(req, env as PublicEstimatorEnv);
  }
  // Customer capability resolution bypasses office cookies but requires healthy BFF configuration
  // so the office revocation control plane cannot disappear while customer links remain live. It
  // accepts one opaque token in a POST body after the app has scrubbed the fragment from its
  // signed link; it never accepts a token path/query as authority.
  if (url.pathname === "/api/v1/customer-portal/resolve") {
    return await handleCustomerPortalResolve(
      req,
      env as import("./app-types.ts").AppEnv,
    );
  }
  if (url.pathname === "/api/v1/customer-portal/acceptance/challenge") {
    return await handleCustomerPortalAcceptanceChallenge(
      req,
      env as import("./app-types.ts").AppEnv,
    );
  }
  if (url.pathname === "/api/v1/customer-portal/acceptance/confirm") {
    return await handleCustomerPortalAcceptanceConfirm(
      req,
      env as import("./app-types.ts").AppEnv,
    );
  }
  // Recording which curated option a customer prefers. Same capability and origin discipline as
  // resolve, plus an Idempotency-Key; it is separately enabled and stays dark without its own
  // Frappe service credentials.
  if (url.pathname === "/api/v1/customer-portal/decision") {
    return await handleCustomerPortalDecision(
      req,
      env as import("./app-types.ts").AppEnv,
    );
  }
  if (url.pathname.startsWith("/api/v1/"))
    return await handleAppApi(req, env, ctx);
  // Jobsite-photo intake (Phase 3) — checked before the generic /ingest/:source match.
  if (req.method === "POST" && url.pathname === "/ingest/photo") {
    if (!constantTimeEqual(bearer(req), env.INGEST_TOKEN))
      return json({ error: "unauthorized" }, 401);
    if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES)
      return json({ error: "payload_too_large" }, 413);
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES)
      return json({ error: "payload_too_large" }, 413);
    return await handlePhotoIngest(env, text, req.headers.get("content-type"));
  }
  // Measurement-report intake (Phase 3) — also before the generic /ingest/:source match.
  if (req.method === "POST" && url.pathname === "/ingest/measurement") {
    if (!constantTimeEqual(bearer(req), env.INGEST_TOKEN))
      return json({ error: "unauthorized" }, 401);
    const body = await readBounded(req);
    if (body === null) return json({ error: "payload_too_large" }, 413);
    return await handleMeasurementIngest(
      env,
      body,
      req.headers.get("content-type"),
      req.headers.get("idempotency-key") ??
        req.headers.get("x-idempotency-key"),
    );
  }
  // Estimator/configurator handoff: own the lead/session first; do not depend on JobNimbus/GHL.
  if (req.method === "POST" && url.pathname === "/ingest/estimate") {
    if (!constantTimeEqual(bearer(req), env.INGEST_TOKEN))
      return json({ error: "unauthorized" }, 401);
    const body = await readBounded(req);
    if (body === null) return json({ error: "payload_too_large" }, 413);
    // Release-smoke scope, read only after the bearer check and honoured only for
    // the reserved fixture (IRO-264).
    const releaseSmoke = releaseSmokeRequested(req);
    if (
      releaseSmoke &&
      !isReleaseSmokeFixture(parseBody(body, req.headers.get("content-type")))
    ) {
      return json({ error: RELEASE_SMOKE_FIXTURE_ERROR }, 400);
    }
    return await handleEstimateIngest(
      env,
      body,
      req.headers.get("content-type"),
      req.headers.get("idempotency-key") ??
        req.headers.get("x-idempotency-key"),
      releaseSmoke,
    );
  }
  // Facet v2 has separately provisioned rotating HMAC authority. It must never fall through to
  // the broad lead-ingest bearer route; native projection runs only from immutable accepted D1.
  if (url.pathname === "/ingest/facet-design") {
    const response = await handleFacetDesignIngest(req, env);
    const waitUntil = (ctx as ExecutionContext & { waitUntil?: ExecutionContext["waitUntil"] }).waitUntil;
    if (response.ok && typeof waitUntil === "function") {
      waitUntil.call(ctx, reconcileFacetDesignSurfaces(env));
    }
    return response;
  }
  if (url.pathname === "/ingest/facet-estimator-ready") {
    return await handleFacetEstimatorReadyIngest(req, env as import("./app-types.ts").AppEnv);
  }
  const ingest = url.pathname.match(/^\/ingest\/([a-z]+)$/);
  if (req.method === "POST" && ingest) {
    if (!constantTimeEqual(bearer(req), env.INGEST_TOKEN))
      return json({ error: "unauthorized" }, 401);
    return await handleIngest(req, env, ctx, ingest[1]);
  }
  if (url.pathname === "/webhook/newo" || url.pathname.startsWith("/webhook/newo/")) {
    return await handleNewoWebhook(req, env, ctx, url);
  }
  if (url.pathname.startsWith("/admin/effects/")) {
    if (!constantTimeEqual(bearer(req), env.EFFECT_RUNTIME_TOKEN))
      return json({ error: "unauthorized" }, 401);
    if (req.method === "POST" && url.pathname === "/admin/effects/claim")
      return await handleExternalEffectClaim(req, env as import("./app-types.ts").AppEnv);
    if (req.method === "POST" && url.pathname === "/admin/effects/reconcile")
      return await handleExternalEffectReconciliation(req, env as import("./app-types.ts").AppEnv);
    if (req.method === "POST" && url.pathname === "/admin/effects/retry")
      return await handleExternalEffectRetry(req, env as import("./app-types.ts").AppEnv);
    if (req.method === "POST" && url.pathname === "/admin/effects/settle")
      return await handleExternalEffectSettlement(req, env as import("./app-types.ts").AppEnv);
    return json({ error: "not_found" }, 404);
  }
  if (url.pathname.startsWith("/admin/")) {
    if (!constantTimeEqual(bearer(req), env.ADMIN_TOKEN))
      return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/admin/newo" || url.pathname.startsWith("/admin/newo/"))
      return await handleNewoAdmin(req, env, url);
    // Existing-CRM import (ELEC-166). Dry-run plans and writes nothing; execute materializes the
    // same plan through the ordinary operating-core path. Contacts no provider.
    if (url.pathname.startsWith("/admin/crm-import/"))
      return await handleCrmImport(req, env, url);
    if (req.method === "GET" && url.pathname === "/admin/envelopes")
      return json(await handleListEnvelopes(env, url));
    if (req.method === "GET" && url.pathname.startsWith("/admin/envelope/"))
      return json(await handleGetEnvelope(env, url));
    if (req.method === "GET" && url.pathname === "/admin/dead-letter")
      return json(await handleListDeadLetters(env, url));
    if (
      req.method === "GET" &&
      url.pathname === "/admin/measurements/exceptions"
    ) {
      return json(await handleListMeasurementExceptions(env, url));
    }
    // Calibration ledger: recent verification comparisons + measured accuracy
    // aggregates per (source, metric). Read-only; rows are written at intake.
    if (req.method === "GET" && url.pathname === "/admin/measurements/deltas") {
      const limit = clampLimit(url.searchParams.get("limit"), 50, 200);
      const asOfParam = url.searchParams.get("as_of");
      const asOf = asOfParam === null ? new Date() : new Date(asOfParam);
      if (
        asOfParam !== null &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(asOfParam) ||
          !Number.isFinite(asOf.getTime()) || asOf.toISOString() !== asOfParam)
      ) return json({ error: "invalid_as_of" }, 400);
      const calibration = await measurementCalibrationReport(env, asOf);
      return json({
        deltas: await listMeasurementDeltas(env, limit),
        aggregates: calibration.cohorts,
        calibration,
      });
    }
    if (req.method === "GET" && url.pathname === "/admin/status") {
      return json(
        await getOperationalStatus(
          env,
          clampLimit(url.searchParams.get("audit_limit"), 20, 100),
        ),
      );
    }
    // Release-smoke scope (IRO-264), after the admin bearer check that guards this
    // whole block. This route carries no body, so there is no fixture to match:
    // the scope's only effect here is to skip the digest email to the owner and
    // backup owner. The heartbeat row is still written exactly as always.
    if (req.method === "POST" && url.pathname === "/admin/reconcile")
      return json(await runReconcile(env, releaseSmokeRequested(req)));
    if (req.method === "POST" && url.pathname === "/admin/source-count")
      return await handleSourceCount(req, env);
    if (req.method === "POST" && url.pathname === "/admin/replay")
      return await handleReplay(req, env);
    if (req.method === "POST" && url.pathname === "/admin/app-users/bootstrap") {
      return await handleAdminFirstOwnerBootstrap(req, env);
    }
    // Local-only development capture reader. 404 unless the Worker runs in explicit
    // localhost-only mode (APP_ALLOW_INSECURE_LOCAL="true"); never enabled in production.
    if (req.method === "GET" && url.pathname === "/admin/dev-outbox") {
      if (String(env.APP_ALLOW_INSECURE_LOCAL) !== "true") return json({ error: "not_found" }, 404);
      const limit = clampLimit(url.searchParams.get("limit"), 20, 100);
      const rows = await env.DB.prepare(
        "SELECT capture_id, kind, recipient, href, created_at FROM dev_outbox ORDER BY created_at DESC LIMIT ?",
      ).bind(limit).all();
      return json({ captures: rows.results ?? [] });
    }
  }
  // No proposal mutation route: owned click-to-accept is the keeper path; a commercial e-sign
  // API may bridge while it matures. DocuSeal/Documenso remain permanently rejected.
  // QuickBooks webhook — authenticity is the Intuit signature, not a bearer token.
  if (req.method === "POST" && url.pathname === "/webhook/quickbooks") {
    const body = await readBounded(req);
    if (body === null) return json({ error: "payload_too_large" }, 413);
    return await handleQuickbooksWebhook(
      env,
      body,
      req.headers.get("intuit-signature"),
    );
  }
  return json({ error: "not_found" }, 404);
}

// ---------------------------------------------------------------------------- ingest

/**
 * Release-smoke scope request (IRO-264). Callers must already have passed the
 * route's bearer check: this only reads the header, it authorizes nothing.
 */
function releaseSmokeRequested(req: Request): boolean {
  return req.headers.get(RELEASE_SMOKE_HEADER) === RELEASE_SMOKE_HEADER_VALUE;
}

async function handleIngest(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  source: string,
  provider?: string,
): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  const rawText = await req.text();
  if (rawText.length > MAX_BODY_BYTES)
    return json({ error: "payload_too_large" }, 413);

  const contentType = req.headers.get("content-type");
  // Release-smoke scope (IRO-264), read only after the caller's bearer token was
  // accepted by the route above. It is honoured only for the reserved fixture, so
  // a real lead can never be silently diverted to the side-effect-free path.
  const releaseSmoke = releaseSmokeRequested(req);
  if (releaseSmoke && !isReleaseSmokeFixture(parseBody(rawText, contentType))) {
    return json({ error: RELEASE_SMOKE_FIXTURE_ERROR }, 400);
  }

  const result = await ingestLead(
    env,
    ctx,
    { source, provider, rawText, contentType, releaseSmoke },
    log,
  );
  const response = result.ok ? json(result.body) : json({ error: result.error }, result.status);
  if (result.ok) response.headers.set("x-ironwrap-envelope-id", result.body.envelope_id);
  return response;
}

// ---------------------------------------------------------------------------- queue work

async function handlePush(env: Env, envelopeId: string): Promise<void> {
  const rec = await store.getEnvelope(env, envelopeId);
  if (!rec) throw new Error("envelope_missing");
  if (
    rec.status === "pushed" ||
    rec.status === "reconciled" ||
    rec.status === "jn_skipped" ||
    rec.release_smoke === 1
  ) {
    await store.markDeadLettersRecovered(env, envelopeId);
    return; // idempotent re-delivery also closes any stale open recovery row for this envelope only
  }
  // Native D1 authority must exist before the JobNimbus side effect. This also re-drives legacy
  // rows stranded by the retired Frappe credential gate.
  try {
    const operating = await materializeOperatingCore(env, rec);
    await store.recordAudit(env, {
      automation: "operating_core",
      trigger: "queue",
      envelope_id: envelopeId,
      target_ids: [
        `lead:${operating.leadId}`,
        `customer:${operating.customerId}`,
        operating.propertyId ? `property:${operating.propertyId}` : null,
        `roof_job:${operating.roofJobId}`,
      ].filter(Boolean).join(","),
      action: operating.reused ? "readback_pre_bridge" : "materialize_pre_bridge",
      result: "ok",
    });
  } catch (err) {
    const error = `native_operating_core: ${String(err)}`;
    await store.setErpNextError(env, envelopeId, error).catch(() => {});
    const n = await store.bumpAttempt(env, envelopeId, error);
    await store.recordAudit(env, {
      automation: "operating_core",
      trigger: "queue",
      envelope_id: envelopeId,
      action: `materialize_attempt_${n}`,
      result: "error",
      error,
      recovery_owner: env.OWNER_ALERT_EMAIL,
    });
    throw err;
  }

  // Kill switch: a disabled JobNimbus write is a terminal skip, never a retry/DLQ.
  // Do not stamp status=pushed — that would fake a CRM landing.
  if (!isOn(env.JOBNIMBUS_ENABLED)) {
    await store.recordAudit(env, {
      automation: "jn_push",
      trigger: "queue",
      envelope_id: envelopeId,
      action: "skip",
      result: "ok",
      error: "jobnimbus_disabled",
    });
    await store.setStatus(env, envelopeId, "jn_skipped", {
      last_error: "jobnimbus_disabled",
    });
    // The skip IS the terminal outcome here, so a replayed dead envelope has recovered the moment
    // it lands: close its dead-letter rows exactly as the `pushed` path does. Before ELEC-137 this
    // branch was the one terminal success that never closed them, which left every
    // JOBNIMBUS_ENABLED=false environment permanently `degraded` with an inflated
    // `open_dead_letters` after a sweep or admin replay had already healed the envelope. Marked
    // ahead of the Desk sync below on purpose: that sync is best-effort and never un-terminals the
    // skip, so the recovery must not depend on it.
    await store.markDeadLettersRecovered(env, envelopeId);
    return;
  }

  let r: Awaited<ReturnType<typeof pushToJobNimbus>>;
  try {
    r = await pushToJobNimbus(env, rec);
    await store.recordAudit(env, {
      automation: "jn_push",
      trigger: "queue",
      envelope_id: envelopeId,
      target_ids: `contact:${r.contactId}${r.jobId ? ",job:" + r.jobId : ""}`,
      action: "push",
      result: "ok",
    });
    // Fresh job → ensure its Drive folder (+01–06 template) now (best-effort, credential-gated).
    if (r.jobNumber && googleConfigured(env)) {
      const p = safeJson(rec.payload_json);
      await ensureJobFolder(
        env,
        r.jobNumber,
        rec.contact_name,
        typeof p.brand === "string" ? p.brand : null,
      ).catch((e) =>
        log({ at: "job_folder", job: r.jobNumber, error: String(e) }),
      );
    }
  } catch (err) {
    const n = await store.bumpAttempt(env, envelopeId, String(err));
    await store.recordAudit(env, {
      automation: "jn_push",
      trigger: "queue",
      envelope_id: envelopeId,
      action: `push_attempt_${n}`,
      result: "error",
      error: String(err),
      recovery_owner: env.OWNER_ALERT_EMAIL,
    });
    throw err; // → queue retry; exhausted → DLQ
  }

  const pushedRecord: EnvelopeRecord = {
    ...rec,
    status: "pushed",
    job_ref: r.jobNumber ?? rec.job_ref,
    jn_contact_id: r.contactId,
    jn_job_id: r.jobId ?? null,
  };
  try {
    const operating = await materializeOperatingCore(env, pushedRecord, r);
    await store.recordAudit(env, {
      automation: "operating_core",
      trigger: "queue",
      envelope_id: envelopeId,
      target_ids: `roof_job:${operating.roofJobId},jobnimbus_contact:${r.contactId}${r.jobId ? `,jobnimbus_job:${r.jobId}` : ""}`,
      action: "bind_jobnimbus_transport",
      result: "ok",
    });
  } catch (err) {
    const error = `native_operating_transport: ${String(err)}`;
    await store.setErpNextError(env, envelopeId, error).catch(() => {});
    const n = await store.bumpAttempt(env, envelopeId, error);
    await store.recordAudit(env, {
      automation: "operating_core",
      trigger: "queue",
      envelope_id: envelopeId,
      action: `transport_bind_attempt_${n}`,
      result: "error",
      error,
      recovery_owner: env.OWNER_ALERT_EMAIL,
    });
    throw err;
  }

  await store.setStatus(env, envelopeId, "pushed", {
    job_ref: r.jobNumber ?? rec.job_ref,
    jn_contact_id: r.contactId,
    jn_job_id: r.jobId ?? null,
  });
  await store.markDeadLettersRecovered(env, envelopeId);
}

async function handleDead(env: Env, envelopeId: string): Promise<void> {
  const rec = await store.getEnvelope(env, envelopeId);
  const stage = rec?.last_error?.includes("native_operating_")
    ? "operating_core"
    : rec?.last_error?.includes("erpnext_")
    ? "erpnext_push"
    : "jn_push";
  await store.setStatus(env, envelopeId, "dead", {
    last_error: rec?.last_error ?? "dead_letter",
  });
  await store.recordDeadLetter(env, {
    envelope_id: envelopeId,
    stage,
    error: rec?.last_error ?? "unknown",
    payload_json: rec?.payload_json ?? "{}",
  });
  // Best-effort: the dead_letter ROW (recorded above) is the source of truth; a failed alert email
  // must not throw, or the DLQ message would needlessly retry/drop.
  await sendOwnerAlert(
    env,
    `DEAD-LETTER: lead ${envelopeId} failed during ${stage}`,
    `<p>Envelope <b>${envelopeId}</b> exhausted retries during <b>${stage}</b>.</p>
     <p>Last error: ${rec?.last_error ?? "unknown"}</p>
     <p>Recover with POST /admin/replay once the cause is fixed.</p>`,
  ).catch((e) =>
    log({
      at: "deadletter_alert_failed",
      envelope_id: envelopeId,
      error: String(e),
    }),
  );
}

// ---------------------------------------------------------------------------- cron

/** Re-drive envelopes stuck in pending_jn_push (backstop if a queue message was lost). */
async function retrySweep(env: Env): Promise<void> {
  const thresholdMin = Number(env.STUCK_THRESHOLD_MIN ?? "15");
  const stuck = await store.listStuck(env, thresholdMin, 100);
  if (stuck.length === 0) return;
  await env.JN_QUEUE.sendBatch(
    stuck.map((r) => ({ body: { envelope_id: r.envelope_id } })),
  );
  log({ at: "retry_sweep", redriven: stuck.length });
}

/** Daily reconciliation: independent source counts vs envelopes landed; heartbeat = the digest email. */
async function runReconcile(env: Env, releaseSmoke = false): Promise<{
  day: string;
  rows: ReturnType<typeof reconcileDiff>;
  openDeadLetter: number;
}> {
  const day = new Date().toISOString().slice(0, 10);
  const [sourceCounts, landed, openDlq] = await Promise.all([
    store.getSourceCounts(env, day),
    store.countLandedByChannel(env, day),
    store.countOpenDeadLetter(env),
  ]);
  const rows = reconcileDiff(sourceCounts, landed);
  const gaps = rows.filter((r) => r.gap > 0);
  await store.writeHeartbeat(env, day, gaps.length === 0, openDlq);

  const table = rows
    .map(
      (r) =>
        `<tr><td>${r.channel}</td><td>${r.source}</td><td>${r.landed}</td><td>${r.gap}</td></tr>`,
    )
    .join("");
  const subject =
    gaps.length || openDlq
      ? `⚠️ Reconciliation ${day}: ${gaps.length} gap(s), ${openDlq} dead-letter`
      : `✓ Reconciliation ${day}: green`;
  // Email is best-effort: the heartbeat ROW (writeHeartbeat above) is the source of truth, so a
  // missing/unconfigured mailer must not fail the reconcile. Once email is wired, its arrival is
  // the human-facing heartbeat; until then, rely on the D1 heartbeat row / the admin result.
  // Under the release-smoke scope the digest is skipped: a production release
  // proof must not send the owner and backup owner a heartbeat email that says
  // the day reconciled when it is really a release probe (IRO-264). The
  // heartbeat row above is unchanged, so the real daily cron still reports.
  if (!releaseSmoke) {
    await sendDailyDigest(
      env,
      subject,
      `<p>Daily source-vs-landed reconciliation for ${day}. (This email IS the heartbeat — if it
        doesn't arrive, the reconcile didn't run: escalate to the backup owner.)</p>
       <table border="1" cellpadding="4"><tr><th>channel</th><th>source</th><th>landed</th><th>gap</th></tr>${table}</table>
       <p>Open dead-letter items: <b>${openDlq}</b>.</p>`,
    ).catch((e) => log({ at: "reconcile_digest_failed", day, error: String(e) }));
  }
  log({ at: "reconcile", day, gaps: gaps.length, openDeadLetter: openDlq });
  return { day, rows, openDeadLetter: openDlq };
}

async function runNewoDailyReconcile(env: Env): Promise<void> {
  const runtime = env as Env & {
    NEWO_ENABLED?: string;
    NEWO_PRODUCTION_REQUIRED?: string;
    NEWO_USAGE_LIMIT_MINUTES?: string;
  };
  if (String(runtime.NEWO_ENABLED) !== "true" && String(runtime.NEWO_PRODUCTION_REQUIRED) !== "true") return;
  const ranAt = new Date().toISOString();
  const [readiness, counts, unresolvedIncidents] = await Promise.all([
    getReadiness(env),
    newoOperationalCounts(env),
    getNewoOpenIncidentCount(env),
  ]);
  const driftReasons = [
    ...readiness.newo.drift_reasons,
    ...(readiness.newo.api_error ? [readiness.newo.api_error] : []),
    ...(readiness.newo.frappe_error ? [readiness.newo.frappe_error] : []),
  ];
  const usageLimit = Number(runtime.NEWO_USAGE_LIMIT_MINUTES ?? "0");
  const degraded = !readiness.ok || counts.failed_events > 0 || counts.failed_sync > 0 ||
    counts.missing_reports > 0 || counts.control_failures > 0 ||
    unresolvedIncidents === null || unresolvedIncidents > 0;
  await recordNewoReconciliationRun(env, {
    run_id: `newo:daily:${crypto.randomUUID()}`,
    run_type: "daily",
    status: degraded ? "degraded" : "ok",
    ran_at: ranAt,
    retryable_syncs_requeued: 0,
    missing_reports: counts.missing_reports,
    failed_handoffs: counts.failed_handoffs,
    pending_bookings: counts.pending_bookings,
    unresolved_incidents: unresolvedIncidents,
    drift_reasons_json: JSON.stringify([...new Set(driftReasons)]),
    usage_status: "unavailable_from_documented_api",
    usage_minutes: null,
    usage_limit_minutes: Number.isFinite(usageLimit) && usageLimit > 0 ? usageLimit : null,
    detail_json: JSON.stringify({
      readiness_status: readiness.status,
      last_event_at: counts.last_event_at,
      last_report_at: counts.last_report_at,
      control_failures: counts.control_failures,
      usage_evidence: "Newo documented session aggregates do not expose call minutes; verify provider-console alerts.",
    }),
  });
  if (degraded) {
    await sendOwnerAlert(
      env,
      "Newo daily reconciliation requires review",
      `<p>Newo readiness or owned landing checks are degraded.</p>
       <p>Missing reports: ${counts.missing_reports}; failed syncs: ${counts.failed_sync};
       unresolved callback incidents: ${unresolvedIncidents ?? "unavailable"}.</p>
       <p>Configuration/API reasons: ${driftReasons.map(escapeHtml).join(", ") || "none"}.</p>`,
    ).catch(() => {});
  }
  log({
    at: "newo_daily_reconcile",
    status: degraded ? "degraded" : "ok",
    missing_reports: counts.missing_reports,
    failed_syncs: counts.failed_sync,
    unresolved_incidents: unresolvedIncidents,
    drift_count: driftReasons.length,
    usage_status: "unavailable_from_documented_api",
  });
}

async function handleReplay(req: Request, env: Env): Promise<Response> {
  const rawBody = await readBounded(req);
  if (rawBody === null) return json({ error: "payload_too_large" }, 413);

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not_object");
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (body.all === true) {
    if (body.envelope_id !== undefined)
      return json({ error: "ambiguous_replay_selection" }, 400);
    if (
      hasUnexpectedFields(body, [
        "all",
        "confirm",
        "run_id",
        "approved_by",
        "reason",
      ])
    ) {
      return json({ error: "unexpected_replay_field" }, 400);
    }
    if (body.confirm !== BULK_REPLAY_CONFIRMATION) {
      return json(
        {
          error: "bulk_confirmation_required",
          confirmation: BULK_REPLAY_CONFIRMATION,
        },
        400,
      );
    }
    const approval = validateReplayApprovalContext(body);
    if (!approval.ok)
      return json(
        { error: "invalid_approval_context", fields: approval.fields },
        400,
      );
    const replay = await executeReplayRequest(
      env,
      { all: true },
      approval.value,
    );
    if (replay.kind === "run_id_conflict") {
      return json(
        { error: "replay_run_id_conflict", run_id: approval.value.run_id },
        409,
      );
    }
    if (replay.kind === "in_progress") {
      return json(
        { error: "replay_run_in_progress", run_id: approval.value.run_id },
        409,
      );
    }
    return json({
      matched: replay.matched,
      requeued: replay.requeued,
      run_id: approval.value.run_id,
      replayed: replay.replayed,
    });
  }

  if (body.all !== undefined && body.all !== false)
    return json({ error: "invalid_all_flag" }, 400);
  if (
    hasUnexpectedFields(body, [
      "all",
      "envelope_id",
      "run_id",
      "approved_by",
      "reason",
    ])
  ) {
    return json({ error: "unexpected_replay_field" }, 400);
  }
  if (
    typeof body.envelope_id !== "string" ||
    !/^ow_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      body.envelope_id,
    )
  ) {
    return json({ error: "invalid_envelope_id" }, 400);
  }

  const approval = validateReplayApprovalContext(body);
  if (!approval.ok)
    return json(
      { error: "invalid_approval_context", fields: approval.fields },
      400,
    );
  const replay = await executeReplayRequest(
    env,
    { all: false, envelopeId: body.envelope_id },
    approval.value,
  );
  if (replay.kind === "run_id_conflict") {
    return json(
      { error: "replay_run_id_conflict", run_id: approval.value.run_id },
      409,
    );
  }
  if (replay.kind === "in_progress") {
    return json(
      { error: "replay_run_in_progress", run_id: approval.value.run_id },
      409,
    );
  }
  if (replay.matched === 0) {
    return json(
      {
        error: "dead_letter_not_replayable",
        run_id: approval.value.run_id,
        replayed: false,
      },
      404,
    );
  }
  if (replay.requeued === 0) {
    return json(
      {
        error: "dead_letter_replay_conflict",
        run_id: approval.value.run_id,
        replayed: false,
      },
      409,
    );
  }
  return json({
    matched: replay.matched,
    requeued: replay.requeued,
    envelope_id: body.envelope_id,
    run_id: approval.value.run_id,
    replayed: replay.replayed,
  });
}

async function handleListEnvelopes(
  env: Env,
  url: URL,
): Promise<{ envelopes: ReturnType<typeof adminEnvelope>[] }> {
  const limit = clampLimit(url.searchParams.get("limit"), 50, 100);
  const rows = await store.listRecentEnvelopes(env, limit);
  return { envelopes: rows.map(adminEnvelope) };
}

async function handleGetEnvelope(
  env: Env,
  url: URL,
): Promise<{ envelope: ReturnType<typeof adminEnvelope> | null }> {
  const id = decodeURIComponent(url.pathname.slice("/admin/envelope/".length));
  const rec = id ? await store.getEnvelope(env, id) : null;
  return { envelope: rec ? adminEnvelope(rec) : null };
}

async function handleListDeadLetters(
  env: Env,
  url: URL,
): Promise<{
  dead_letters: Awaited<ReturnType<typeof store.listOpenDeadLetters>>;
}> {
  const limit = clampLimit(url.searchParams.get("limit"), 50, 100);
  return { dead_letters: await store.listOpenDeadLetters(env, limit) };
}

async function handleListMeasurementExceptions(
  env: Env,
  url: URL,
): Promise<{ measurements: MeasurementIntakeAdminException[] }> {
  const limit = clampLimit(url.searchParams.get("limit"), 50, 100);
  return {
    measurements: (await listMeasurementIntakeExceptions(env, limit)).map(
      projectMeasurementIntakeAdminException,
    ),
  };
}

function adminEnvelope(
  rec: EnvelopeRecord,
): Omit<EnvelopeRecord, "payload_json"> & { payload: Record<string, unknown> } {
  const { payload_json, ...rest } = rec;
  return { ...rest, payload: safeJson(payload_json) };
}

function clampLimit(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

function hasUnexpectedFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(body).some((key) => !allowedSet.has(key));
}

async function handleSourceCount(req: Request, env: Env): Promise<Response> {
  const rawBody = await readBounded(req);
  if (rawBody === null) return json({ error: "payload_too_large" }, 413);

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not_object");
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const validation = validateSourceCount(
    body.day === undefined ? new Date().toISOString().slice(0, 10) : body.day,
    body.channel,
    body.count,
  );
  if (!validation.ok) return json({ error: validation.reason }, 400);

  await store.putSourceCount(
    env,
    validation.day,
    validation.channel,
    validation.count,
  );
  return json({
    ok: true,
    day: validation.day,
    channel: validation.channel,
    count: validation.count,
  });
}

// ---------------------------------------------------------------------------- helpers

/** Read the request body, returning null if it exceeds the cap. */
async function readBounded(req: Request): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES)
    return null;
  const text = await req.text();
  return text.length > MAX_BODY_BYTES ? null : text;
}

function bearer(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : h;
}

function constantTimeEqual(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  // Workers exposes crypto.subtle.timingSafeEqual; fall back to a constant-time compare
  // elsewhere (e.g. Node test runtime) so the handler is testable without Miniflare.
  const tse = (
    crypto.subtle as unknown as {
      timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean;
    }
  ).timingSafeEqual;
  if (typeof tse === "function") return tse.call(crypto.subtle, ab, bb);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function methodAwareJson(req: Request, body: unknown, status = 200): Response {
  const response = json(body, status);
  return req.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

function requestIdFor(req: Request): string {
  for (const supplied of [
    req.headers.get("x-correlation-id"),
    req.headers.get("x-request-id"),
  ]) {
    if (supplied && /^[A-Za-z0-9._:-]{8,128}$/.test(supplied)) return supplied;
  }
  return crypto.randomUUID();
}

function withRequestId(req: Request, requestId: string): Request {
  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-correlation-id", requestId);
  return new Request(req, { headers });
}

function safeLogIdentifier(value: string | null | undefined): string | null {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function logRequestCompletion(
  req: Request,
  env: Env,
  response: Response,
  requestId: string,
  startedAt: number,
  errorCode: string | null,
): void {
  const route = new URL(req.url).pathname.slice(0, 256);
  const completionErrorCode =
    errorCode ?? (response.status >= 500 ? "http_5xx" : null);
  log({
    ts: new Date().toISOString(),
    level: completionErrorCode ? "error" : "info",
    msg: "http_request_completed",
    service: "ironwrap-worker",
    request_id: requestId,
    tenant: safeLogIdentifier((env as Env & { APP_TENANT_ID?: string }).APP_TENANT_ID),
    method: req.method.slice(0, 16),
    route,
    status: response.status,
    duration_ms: Math.max(0, Date.now() - startedAt),
    envelope_id: safeLogIdentifier(response.headers.get("x-ironwrap-envelope-id")),
    error_code: completionErrorCode,
  });
}

function withResponseHeaders(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  headers.set(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  headers.set(
    "permissions-policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
  );
  headers.set("referrer-policy", "no-referrer");
  headers.set("strict-transport-security", "max-age=31536000");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("x-request-id", requestId);
  headers.set("x-correlation-id", requestId);
  headers.set("x-robots-tag", "noindex, nofollow");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
