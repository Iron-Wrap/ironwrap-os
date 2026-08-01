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
} from "./core.ts";
import * as store from "./store.ts";
import {
  BULK_REPLAY_CONFIRMATION,
  executeReplayRequest,
  getOperationalStatus,
  getNewoOpenIncidentCount,
  getReadiness,
  runOwnerWatchdog,
  validateReplayApprovalContext,
} from "./operations.ts";
import { pushToJobNimbus } from "./jobnimbus.ts";
import { pushToErpNext, syncLeadTransportToErpNext } from "./erpnext.ts";
import { sendInstantAck, sendOwnerAlert, sendDailyDigest } from "./notify.ts";
import { handlePhotoIngest } from "./photos.ts";
import {
  handleMeasurementIngest,
  retryMeasurementIntakeReceipts,
} from "./measurements.ts";
import { handleEstimateIngest, retryEstimateErpNextSyncs } from "./estimates.ts";
import { handleFacetDesignIngest } from "./facet-design-ingest.ts";
import {
  handleQuickbooksWebhook,
  recoverDueQuickBooksProjections,
} from "./quickbooks.ts";
import { reconcileFacetDesignFrappeProjections } from "./facet-design-projection.ts";
import {
  handlePublicInstantEstimate,
  prunePublicEstimateRateLimits,
  type PublicEstimatorEnv,
} from "./public-estimator.ts";
import { ensureJobFolder, googleConfigured } from "./google.ts";
import {
  handleAdminAppUserProvision,
  handleAppApi,
  recoverPendingLeadTriageOutbox,
} from "./app-api.ts";
import { pruneAuthRecords } from "./app-auth-store.ts";
import { handleCustomerPortalResolve } from "./customer-portal.ts";
import {
  handleCustomerPortalAcceptanceChallenge,
  handleCustomerPortalAcceptanceConfirm,
  reconcileCustomerContractAcceptanceAttempts,
} from "./customer-contract-acceptance.ts";
import { pruneCustomerPortalRecords } from "./customer-portal-store.ts";
import {
  listMeasurementIntakeExceptions,
  pruneMeasurementIntakeReceipts,
  projectMeasurementIntakeAdminException,
  type MeasurementIntakeAdminException,
} from "./measurement-intake-store.ts";
import { aggregateMeasurementDeltas, listMeasurementDeltas } from "./measurement-deltas-store.ts";
import { markExpiredExecutionLeases } from "./approval-store.ts";
import { markExpiredQuoteRevisionApprovalExecutionLeases } from "./quote-revision-approval-store.ts";
import { markExpiredProductionScheduleApprovalExecutionLeases } from "./production-schedule-approval-store.ts";
import {
  handleNewoQueueMessage,
  handleNewoWebhook,
  reconcileNewoSessions,
  type NewoQueueMessage,
} from "./newo.ts";
import { handleNewoAdmin } from "./newo-admin.ts";
import {
  newoOperationalCounts,
  recordNewoReconciliationRun,
} from "./newo-store.ts";

type BusQueueMessage = { envelope_id: string } | NewoQueueMessage;

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
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const requestId = requestIdFor(req);
    try {
      const response = await routeRequest(req, env, ctx);
      return withResponseHeaders(response, requestId);
    } catch (err) {
      log({ at: "fetch", request_id: requestId, error: String(err) });
      return withResponseHeaders(json({ error: "internal" }, 500), requestId);
    }
  },

  async queue(
    batch: MessageBatch<BusQueueMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const isDlq = batch.queue.endsWith("-dlq");
    for (const msg of batch.messages) {
      try {
        if ("newo_event_id" in msg.body) {
          await handleNewoQueueMessage(env, msg.body.newo_event_id, isDlq);
        } else if (isDlq) await handleDead(env, msg.body.envelope_id);
        else await handlePush(env, msg.body.envelope_id);
        msg.ack();
      } catch (err) {
        log({
          at: "queue",
          queue: batch.queue,
          message_id: "newo_event_id" in msg.body
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
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (controller.cron === "0 14 * * *") {
      ctx.waitUntil(
        Promise.all([
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
        ]).then(() => {}),
      );
    } else
      ctx.waitUntil(
        Promise.all([
          retrySweep(env),
          reconcileNewoSessions(env).catch((error) =>
            log({ at: "newo_five_minute_reconcile", error: String(error) })
          ),
          retryMeasurementIntakeReceipts(env).catch((error) =>
            log({ at: "measurement_intake_retry", error: String(error) }),
          ),
          retryEstimateErpNextSyncs(env).catch((error) =>
            log({ at: "estimate_erpnext_retry", error: String(error) }),
          ),
          recoverDueQuickBooksProjections(env).then((result) => {
            if (result.due > 0) log({ at: "quickbooks_projection_recovery", ...result });
          }).catch((error) =>
            log({ at: "quickbooks_projection_recovery", error: String(error) }),
          ),
          reconcileCustomerContractAcceptanceAttempts(env).catch((error) =>
            log({ at: "customer_contract_acceptance_reconcile", error: String(error) }),
          ),
          reconcileFacetDesignFrappeProjections(env).catch((error) =>
            log({ at: "facet_design_frappe_projection_reconcile", error: String(error) }),
          ),
          recoverLeadTriageOutboxThenExpireLeases(env),
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
        ]).then(() => {}),
      ); // the frequent cron
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
    // ?scope=core reports only the owned intake spine so a deliberate launch
    // gate (Newo) cannot hide a core regression from monitoring. The full
    // verdict remains the default.
    const verdict = url.searchParams.get("scope") === "core" ? readiness.core_ok : readiness.ok;
    // Keep public monitoring useful without advertising the state of every
    // downstream rail to an unauthenticated caller. Operators can use the
    // existing admin bearer token for the diagnostic check map.
    if (!constantTimeEqual(bearer(req), env.ADMIN_TOKEN))
      return methodAwareJson(req, { ok: verdict }, verdict ? 200 : 503);
    return methodAwareJson(req, readiness, verdict ? 200 : 503);
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
    return await handleEstimateIngest(
      env,
      body,
      req.headers.get("content-type"),
      req.headers.get("idempotency-key") ??
        req.headers.get("x-idempotency-key"),
    );
  }
  // Facet has a separately provisioned HMAC authority. It must never fall through to the broad
  // lead-ingest bearer token route, and this receipt has no Frappe projection in this slice.
  if (url.pathname === "/ingest/facet-design") return await handleFacetDesignIngest(req, env);
  const ingest = url.pathname.match(/^\/ingest\/([a-z]+)$/);
  if (req.method === "POST" && ingest) {
    if (!constantTimeEqual(bearer(req), env.INGEST_TOKEN))
      return json({ error: "unauthorized" }, 401);
    return await handleIngest(req, env, ctx, ingest[1]);
  }
  if (url.pathname === "/webhook/newo" || url.pathname.startsWith("/webhook/newo/")) {
    return await handleNewoWebhook(req, env, ctx, url);
  }
  if (url.pathname.startsWith("/admin/")) {
    if (!constantTimeEqual(bearer(req), env.ADMIN_TOKEN))
      return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/admin/newo" || url.pathname.startsWith("/admin/newo/"))
      return await handleNewoAdmin(req, env, url);
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
      return json({
        deltas: await listMeasurementDeltas(env, limit),
        aggregates: await aggregateMeasurementDeltas(env),
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
    if (req.method === "POST" && url.pathname === "/admin/reconcile")
      return json(await runReconcile(env));
    if (req.method === "POST" && url.pathname === "/admin/source-count")
      return await handleSourceCount(req, env);
    if (req.method === "POST" && url.pathname === "/admin/replay")
      return await handleReplay(req, env);
    if (req.method === "POST" && url.pathname === "/admin/app-users") {
      return await handleAdminAppUserProvision(req, env);
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

async function handleIngest(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  source: string,
  provider?: string,
): Promise<Response> {
  if (!(ALLOWED_SOURCES as readonly string[]).includes(source))
    return json({ error: "bad_source" }, 400);

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  const rawText = await req.text();
  if (rawText.length > MAX_BODY_BYTES)
    return json({ error: "payload_too_large" }, 413);

  const parsed = parseBody(rawText, req.headers.get("content-type"));
  const raw = provider ? { ...parsed, provider } : parsed;
  const envelopeId = newEnvelopeId();
  const now = new Date().toISOString();
  const rawKey = `raw/${now.slice(0, 10)}/${envelopeId}.json`;

  // 1) Raw to R2 FIRST — nothing is lost even if everything after this throws.
  await store.putRaw(env, rawKey, rawText, "application/json");

  // 2) Canonical envelope.
  const envelope = normalizeEnvelope(source as Source, raw, now);
  const valid = validateInbound(envelope);
  const key = dedupKey(envelope.contact);

  // 3) Dedup across all inbound paths (phone/email, within the window).
  let dupOf: string | null = null;
  if (key) {
    const windowH = Number(env.DEDUP_WINDOW_HOURS ?? "72");
    const since = new Date(Date.now() - windowH * 3600_000).toISOString();
    dupOf = await store.claimDedup(env, key, envelopeId, now, since);
  }

  const intentText = `${raw["service"] ?? ""} ${raw["service_intent"] ?? ""} ${raw["message"] ?? ""}`;
  const rec: EnvelopeRecord = {
    envelope_id: envelopeId,
    source,
    contact_name: envelope.contact.name ?? null,
    contact_phone: envelope.contact.phone ?? null,
    contact_email: envelope.contact.email ?? null,
    job_ref: envelope.job_ref,
    payload_json: JSON.stringify(envelope.payload),
    raw_key: rawKey,
    ts: now,
    status: dupOf ? "duplicate" : valid.ok ? "pending_jn_push" : "received",
    dedup_key: key,
    dup_of: dupOf,
    attempts: 0,
    last_error: valid.ok ? null : (valid.reason ?? null),
    jn_contact_id: null,
    jn_job_id: null,
    intent_queue: classifyIntent(intentText),
    created_at: now,
    updated_at: now,
  };

  // 4) Owned store write (system of record).
  await store.insertEnvelope(env, rec);
  await store.recordAudit(env, {
    automation: "ingest",
    trigger: source,
    envelope_id: envelopeId,
    source_ids: provider ? `provider:${provider}` : undefined,
    action: dupOf ? "dedup" : "received",
    result: "ok",
    error: rec.last_error,
    recovery_owner: env.OWNER_ALERT_EMAIL,
  });

  // 5) Instant-ack fires OFF the first owned-store write (never off a duplicate/retry).
  if (!dupOf) {
    ctx.waitUntil(
      sendInstantAck(env, rec).catch((e) =>
        log({ at: "instant_ack", envelope_id: envelopeId, error: String(e) }),
      ),
    );
  }

  // 6) Enqueue the JobNimbus push (skip pure duplicates and unroutable-no-contact rows).
  if (!dupOf && valid.ok) await env.JN_QUEUE.send({ envelope_id: envelopeId });

  return json({
    envelope_id: envelopeId,
    status: rec.status,
    duplicate: !!dupOf,
    queue: rec.intent_queue,
  });
}

// ---------------------------------------------------------------------------- queue work

async function handlePush(env: Env, envelopeId: string): Promise<void> {
  const rec = await store.getEnvelope(env, envelopeId);
  if (!rec) throw new Error("envelope_missing");
  if (rec.status === "pushed" || rec.status === "reconciled") {
    await store.markDeadLettersRecovered(env, envelopeId);
    return; // idempotent re-delivery also closes any stale open recovery row for this envelope only
  }
  // The owned operating record must exist before the temporary JobNimbus bridge. A bridge outage
  // is an Automation Incident, never a reason to hide a fresh lead from the operator queue.
  try {
    const erp = await pushToErpNext(env, rec);
    if (erp) {
      await store.setErpNextSync(env, envelopeId, {
        leadEnvelopeId: erp.name,
        roofingPropertyId: erp.roofingPropertyName ?? null,
        roofJobId: erp.roofJobName ?? null,
      });
      const targetIds = [
        `lead_envelope:${erp.name}`,
        erp.roofingPropertyName
          ? `roofing_property:${erp.roofingPropertyName}`
          : null,
        erp.roofJobName ? `roof_job:${erp.roofJobName}` : null,
        erp.productionGateCount
          ? `production_gates:${erp.productionGateCount}`
          : null,
      ]
        .filter(Boolean)
        .join(",");
      await store.recordAudit(env, {
        automation: "erpnext_push",
        trigger: "queue",
        envelope_id: envelopeId,
        target_ids: targetIds,
        action: erp.reused ? "upsert_pre_bridge" : "create_pre_bridge",
        result: "ok",
      });
    }
  } catch (err) {
    const error = `erpnext_push: ${String(err)}`;
    await store.setErpNextError(env, envelopeId, error).catch(() => {});
    const n = await store.bumpAttempt(env, envelopeId, error);
    await store.recordAudit(env, {
      automation: "erpnext_push",
      trigger: "queue",
      envelope_id: envelopeId,
      action: `push_attempt_${n}`,
      result: "error",
      error,
      recovery_owner: env.OWNER_ALERT_EMAIL,
    });
    throw err; // retry preserves the owned business record as a hard prerequisite for the bridge
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
    const lead = await syncLeadTransportToErpNext(env, pushedRecord, r);
    if (lead) {
      await store.recordAudit(env, {
        automation: "erpnext_push",
        trigger: "queue",
        envelope_id: envelopeId,
        target_ids: [
          `lead_envelope:${lead.name}`,
          lead.roofJobName ? `roof_job:${lead.roofJobName}` : null,
        ]
          .filter(Boolean)
          .join(","),
        action: "sync_bridge_transport",
        result: "ok",
      });
    }
  } catch (err) {
    const error = `erpnext_transport_sync: ${String(err)}`;
    await store.setErpNextError(env, envelopeId, error).catch(() => {});
    const n = await store.bumpAttempt(env, envelopeId, error);
    await store.recordAudit(env, {
      automation: "erpnext_push",
      trigger: "queue",
      envelope_id: envelopeId,
      action: `transport_sync_attempt_${n}`,
      result: "error",
      error,
      recovery_owner: env.OWNER_ALERT_EMAIL,
    });
    throw err; // keep pending so retry re-verifies both the bridge and its mirrored transport facts
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
  const stage = rec?.last_error?.includes("erpnext_")
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
async function runReconcile(env: Env): Promise<{
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
  await sendDailyDigest(
    env,
    subject,
    `<p>Daily source-vs-landed reconciliation for ${day}. (This email IS the heartbeat — if it
      doesn't arrive, the reconcile didn't run: escalate to the backup owner.)</p>
     <table border="1" cellpadding="4"><tr><th>channel</th><th>source</th><th>landed</th><th>gap</th></tr>${table}</table>
     <p>Open dead-letter items: <b>${openDlq}</b>.</p>`,
  ).catch((e) => log({ at: "reconcile_digest_failed", day, error: String(e) }));
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
