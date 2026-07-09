// index.ts — the IronWrap integration bus (one Worker: fetch + queue + scheduled).
//
// Flow (spec 01/04/06): inbound → raw to R2 FIRST → canonical envelope to D1 (system of
// record) → instant-ack OFF the owned-store write → enqueue JobNimbus push. The queue
// consumer does the idempotent, retried JN push (pending_jn_push → pushed); a 5-min cron
// re-drives anything stuck; a daily cron reconciles source vs landed and emits the heartbeat.

import {
  ALLOWED_SOURCES, type Source, type EnvelopeRecord,
  newEnvelopeId, normalizeEnvelope, dedupKey, validateInbound, classifyIntent, reconcileDiff, parseBody,
} from "./core.ts";
import * as store from "./store.ts";
import { pushToJobNimbus } from "./jobnimbus.ts";
import { pushToErpNext } from "./erpnext.ts";
import { sendInstantAck, sendOwnerAlert, sendDailyDigest } from "./notify.ts";
import { handlePhotoIngest } from "./photos.ts";
import { handleMeasurementIngest } from "./measurements.ts";
import { handleEstimateIngest } from "./estimates.ts";
import { handleQuickbooksWebhook } from "./quickbooks.ts";
import { ensureJobFolder, googleConfigured } from "./google.ts";

const MAX_BODY_BYTES = 256 * 1024;
const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
const safeJson = (s: string): Record<string, unknown> => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }
      // Jobsite-photo intake (Phase 3) — checked before the generic /ingest/:source match.
      if (req.method === "POST" && url.pathname === "/ingest/photo") {
        if (!constantTimeEqual(bearer(req), env.INGEST_TOKEN)) return json({ error: "unauthorized" }, 401);
        if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
        const text = await req.text();
        if (text.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
        return await handlePhotoIngest(env, text, req.headers.get("content-type"));
      }
      // Measurement-report intake (Phase 3) — also before the generic /ingest/:source match.
      if (req.method === "POST" && url.pathname === "/ingest/measurement") {
        if (!constantTimeEqual(bearer(req), env.INGEST_TOKEN)) return json({ error: "unauthorized" }, 401);
        const body = await readBounded(req);
        if (body === null) return json({ error: "payload_too_large" }, 413);
        return await handleMeasurementIngest(env, body, req.headers.get("content-type"));
      }
      // Estimator/configurator handoff: own the lead/session first; do not depend on JobNimbus/GHL.
      if (req.method === "POST" && url.pathname === "/ingest/estimate") {
        if (!constantTimeEqual(bearer(req), env.INGEST_TOKEN)) return json({ error: "unauthorized" }, 401);
        const body = await readBounded(req);
        if (body === null) return json({ error: "payload_too_large" }, 413);
        return await handleEstimateIngest(
          env,
          body,
          req.headers.get("content-type"),
          req.headers.get("idempotency-key") ?? req.headers.get("x-idempotency-key"),
        );
      }
      const ingest = url.pathname.match(/^\/ingest\/([a-z]+)$/);
      if (req.method === "POST" && ingest) {
        if (!constantTimeEqual(bearer(req), env.INGEST_TOKEN)) return json({ error: "unauthorized" }, 401);
        return await handleIngest(req, env, ctx, ingest[1]);
      }
      if (url.pathname.startsWith("/admin/")) {
        if (!constantTimeEqual(bearer(req), env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);
        if (req.method === "GET" && url.pathname === "/admin/envelopes") return json(await handleListEnvelopes(env, url));
        if (req.method === "GET" && url.pathname.startsWith("/admin/envelope/")) return json(await handleGetEnvelope(env, url));
        if (req.method === "GET" && url.pathname === "/admin/dead-letter") return json(await handleListDeadLetters(env, url));
        if (req.method === "POST" && url.pathname === "/admin/reconcile") return json(await runReconcile(env));
        if (req.method === "POST" && url.pathname === "/admin/source-count") return await handleSourceCount(req, env);
        if (req.method === "POST" && url.pathname === "/admin/replay") return json(await replayDeadLetter(env));
      }
      // (Proposal e-sign route removed 2026-07-02: JobNimbus native e-sign is confirmed
      // sufficient; DocuSeal stays benched as the escape hatch — see final-spec-pack/00.)
      // QuickBooks webhook — authenticity is the Intuit signature, not a bearer token.
      if (req.method === "POST" && url.pathname === "/webhook/quickbooks") {
        const body = await readBounded(req);
        if (body === null) return json({ error: "payload_too_large" }, 413);
        return await handleQuickbooksWebhook(env, body, req.headers.get("intuit-signature"));
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      log({ at: "fetch", error: String(err) });
      return json({ error: "internal" }, 500);
    }
  },

  async queue(batch: MessageBatch<{ envelope_id: string }>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const isDlq = batch.queue.endsWith("-dlq");
    for (const msg of batch.messages) {
      try {
        if (isDlq) await handleDead(env, msg.body.envelope_id);
        else await handlePush(env, msg.body.envelope_id);
        msg.ack();
      } catch (err) {
        log({ at: "queue", queue: batch.queue, envelope_id: msg.body.envelope_id, error: String(err) });
        msg.retry(); // exhausting retries on the main queue routes to the DLQ (wrangler.jsonc)
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === "0 14 * * *") ctx.waitUntil(runReconcile(env).then(() => {}));
    else ctx.waitUntil(retrySweep(env)); // the frequent cron
  },
} satisfies ExportedHandler<Env, { envelope_id: string }>;

// ---------------------------------------------------------------------------- ingest

async function handleIngest(req: Request, env: Env, ctx: ExecutionContext, source: string): Promise<Response> {
  if (!(ALLOWED_SOURCES as readonly string[]).includes(source)) return json({ error: "bad_source" }, 400);

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  const rawText = await req.text();
  if (rawText.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  const raw = parseBody(rawText, req.headers.get("content-type"));
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
    envelope_id: envelopeId, source,
    contact_name: envelope.contact.name ?? null,
    contact_phone: envelope.contact.phone ?? null,
    contact_email: envelope.contact.email ?? null,
    job_ref: envelope.job_ref,
    payload_json: JSON.stringify(envelope.payload),
    raw_key: rawKey, ts: now,
    status: dupOf ? "duplicate" : valid.ok ? "pending_jn_push" : "received",
    dedup_key: key, dup_of: dupOf, attempts: 0,
    last_error: valid.ok ? null : valid.reason ?? null,
    jn_contact_id: null, jn_job_id: null,
    intent_queue: classifyIntent(intentText),
    created_at: now, updated_at: now,
  };

  // 4) Owned store write (system of record).
  await store.insertEnvelope(env, rec);
  await store.recordAudit(env, {
    automation: "ingest", trigger: source, envelope_id: envelopeId,
    action: dupOf ? "dedup" : "received", result: "ok",
    error: rec.last_error, recovery_owner: env.OWNER_ALERT_EMAIL,
  });

  // 5) Instant-ack fires OFF the owned-store write (never off the JobNimbus push).
  ctx.waitUntil(sendInstantAck(env, rec).catch((e) =>
    log({ at: "instant_ack", envelope_id: envelopeId, error: String(e) })));

  // 6) Enqueue the JobNimbus push (skip pure duplicates and unroutable-no-contact rows).
  if (!dupOf && valid.ok) await env.JN_QUEUE.send({ envelope_id: envelopeId });

  return json({ envelope_id: envelopeId, status: rec.status, duplicate: !!dupOf, queue: rec.intent_queue });
}

// ---------------------------------------------------------------------------- queue work

async function handlePush(env: Env, envelopeId: string): Promise<void> {
  const rec = await store.getEnvelope(env, envelopeId);
  if (!rec) throw new Error("envelope_missing");
  if (rec.status === "pushed" || rec.status === "reconciled") return; // idempotent re-delivery
  let r: Awaited<ReturnType<typeof pushToJobNimbus>>;
  try {
    r = await pushToJobNimbus(env, rec);
    await store.recordAudit(env, {
      automation: "jn_push", trigger: "queue", envelope_id: envelopeId,
      target_ids: `contact:${r.contactId}${r.jobId ? ",job:" + r.jobId : ""}`,
      action: "push", result: "ok",
    });
    // Fresh job → ensure its Drive folder (+01–06 template) now (best-effort, credential-gated).
    if (r.jobNumber && googleConfigured(env)) {
      const p = safeJson(rec.payload_json);
      await ensureJobFolder(env, r.jobNumber, rec.contact_name, typeof p.brand === "string" ? p.brand : null)
        .catch((e) => log({ at: "job_folder", job: r.jobNumber, error: String(e) }));
    }
  } catch (err) {
    const n = await store.bumpAttempt(env, envelopeId, String(err));
    await store.recordAudit(env, {
      automation: "jn_push", trigger: "queue", envelope_id: envelopeId,
      action: `push_attempt_${n}`, result: "error", error: String(err),
      recovery_owner: env.OWNER_ALERT_EMAIL,
    });
    throw err; // → queue retry; exhausted → DLQ
  }

  try {
    const erp = await pushToErpNext(env, rec, r);
    if (erp) {
      await store.setErpNextSync(env, envelopeId, {
        leadEnvelopeId: erp.name,
        roofingPropertyId: erp.roofingPropertyName ?? null,
        roofJobId: erp.roofJobName ?? null,
      });
      const targetIds = [
        `lead_envelope:${erp.name}`,
        erp.roofingPropertyName ? `roofing_property:${erp.roofingPropertyName}` : null,
        erp.roofJobName ? `roof_job:${erp.roofJobName}` : null,
        erp.productionGateCount ? `production_gates:${erp.productionGateCount}` : null,
      ].filter(Boolean).join(",");
      await store.recordAudit(env, {
        automation: "erpnext_push", trigger: "queue", envelope_id: envelopeId,
        target_ids: targetIds,
        action: erp.reused ? "upsert_existing" : "create", result: "ok",
      });
    }
  } catch (err) {
    const error = `erpnext_push: ${String(err)}`;
    await store.setErpNextError(env, envelopeId, error).catch(() => {});
    const n = await store.bumpAttempt(env, envelopeId, error);
    await store.recordAudit(env, {
      automation: "erpnext_push", trigger: "queue", envelope_id: envelopeId,
      action: `push_attempt_${n}`, result: "error", error,
      recovery_owner: env.OWNER_ALERT_EMAIL,
    });
    throw err; // keep the envelope pending; queue retry preserves the ERPNext proof path
  }

  await store.setStatus(env, envelopeId, "pushed", {
    job_ref: r.jobNumber ?? rec.job_ref,
    jn_contact_id: r.contactId,
    jn_job_id: r.jobId ?? null,
  });
}

async function handleDead(env: Env, envelopeId: string): Promise<void> {
  const rec = await store.getEnvelope(env, envelopeId);
  const stage = rec?.last_error?.includes("erpnext_") ? "erpnext_push" : "jn_push";
  await store.setStatus(env, envelopeId, "dead", { last_error: rec?.last_error ?? "dead_letter" });
  await store.recordDeadLetter(env, {
    envelope_id: envelopeId, stage,
    error: rec?.last_error ?? "unknown", payload_json: rec?.payload_json ?? "{}",
  });
  // Best-effort: the dead_letter ROW (recorded above) is the source of truth; a failed alert email
  // must not throw, or the DLQ message would needlessly retry/drop.
  await sendOwnerAlert(env, `DEAD-LETTER: lead ${envelopeId} failed during ${stage}`,
    `<p>Envelope <b>${envelopeId}</b> exhausted retries during <b>${stage}</b>.</p>
     <p>Last error: ${rec?.last_error ?? "unknown"}</p>
     <p>Recover with POST /admin/replay once the cause is fixed.</p>`)
    .catch((e) => log({ at: "deadletter_alert_failed", envelope_id: envelopeId, error: String(e) }));
}

// ---------------------------------------------------------------------------- cron

/** Re-drive envelopes stuck in pending_jn_push (backstop if a queue message was lost). */
async function retrySweep(env: Env): Promise<void> {
  const thresholdMin = Number(env.STUCK_THRESHOLD_MIN ?? "15");
  const stuck = await store.listStuck(env, thresholdMin, 100);
  if (stuck.length === 0) return;
  await env.JN_QUEUE.sendBatch(stuck.map((r) => ({ body: { envelope_id: r.envelope_id } })));
  log({ at: "retry_sweep", redriven: stuck.length });
}

/** Daily reconciliation: independent source counts vs envelopes landed; heartbeat = the digest email. */
async function runReconcile(env: Env): Promise<{ day: string; rows: ReturnType<typeof reconcileDiff>; openDeadLetter: number }> {
  const day = new Date().toISOString().slice(0, 10);
  const [sourceCounts, landed, openDlq] = await Promise.all([
    store.getSourceCounts(env, day),
    store.countLandedByChannel(env, day),
    store.countOpenDeadLetter(env),
  ]);
  const rows = reconcileDiff(sourceCounts, landed);
  const gaps = rows.filter((r) => r.gap > 0);
  await store.writeHeartbeat(env, day, gaps.length === 0, openDlq);

  const table = rows.map((r) =>
    `<tr><td>${r.channel}</td><td>${r.source}</td><td>${r.landed}</td><td>${r.gap}</td></tr>`).join("");
  const subject = gaps.length || openDlq
    ? `⚠️ Reconciliation ${day}: ${gaps.length} gap(s), ${openDlq} dead-letter`
    : `✓ Reconciliation ${day}: green`;
  // Email is best-effort: the heartbeat ROW (writeHeartbeat above) is the source of truth, so a
  // missing/unconfigured mailer must not fail the reconcile. Once email is wired, its arrival is
  // the human-facing heartbeat; until then, rely on the D1 heartbeat row / the admin result.
  await sendDailyDigest(env, subject,
    `<p>Daily source-vs-landed reconciliation for ${day}. (This email IS the heartbeat — if it
      doesn't arrive, the reconcile didn't run: escalate to the backup owner.)</p>
     <table border="1" cellpadding="4"><tr><th>channel</th><th>source</th><th>landed</th><th>gap</th></tr>${table}</table>
     <p>Open dead-letter items: <b>${openDlq}</b>.</p>`)
    .catch((e) => log({ at: "reconcile_digest_failed", day, error: String(e) }));
  log({ at: "reconcile", day, gaps: gaps.length, openDeadLetter: openDlq });
  return { day, rows, openDeadLetter: openDlq };
}

async function replayDeadLetter(env: Env): Promise<{ requeued: number }> {
  // Re-drive every dead envelope back through the JobNimbus push.
  const res = await env.DB.prepare(`SELECT envelope_id FROM envelopes WHERE status = 'dead' LIMIT 500`)
    .all<{ envelope_id: string }>();
  const ids = (res.results ?? []).map((r) => r.envelope_id);
  for (const id of ids) await store.setStatus(env, id, "pending_jn_push");
  if (ids.length) await env.JN_QUEUE.sendBatch(ids.map((id) => ({ body: { envelope_id: id } })));
  await env.DB.prepare(`UPDATE dead_letter SET recovered = 1 WHERE recovered = 0`).run();
  return { requeued: ids.length };
}

async function handleListEnvelopes(env: Env, url: URL): Promise<{ envelopes: ReturnType<typeof adminEnvelope>[] }> {
  const limit = clampLimit(url.searchParams.get("limit"), 50, 100);
  const rows = await store.listRecentEnvelopes(env, limit);
  return { envelopes: rows.map(adminEnvelope) };
}

async function handleGetEnvelope(env: Env, url: URL): Promise<{ envelope: ReturnType<typeof adminEnvelope> | null }> {
  const id = decodeURIComponent(url.pathname.slice("/admin/envelope/".length));
  const rec = id ? await store.getEnvelope(env, id) : null;
  return { envelope: rec ? adminEnvelope(rec) : null };
}

async function handleListDeadLetters(env: Env, url: URL): Promise<{ dead_letters: Awaited<ReturnType<typeof store.listOpenDeadLetters>> }> {
  const limit = clampLimit(url.searchParams.get("limit"), 50, 100);
  return { dead_letters: await store.listOpenDeadLetters(env, limit) };
}

function adminEnvelope(rec: EnvelopeRecord): Omit<EnvelopeRecord, "payload_json"> & { payload: Record<string, unknown> } {
  const { payload_json, ...rest } = rec;
  return { ...rest, payload: safeJson(payload_json) };
}

function clampLimit(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

async function handleSourceCount(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as { day?: string; channel?: string; count?: number };
  if (!body.channel || typeof body.count !== "number") return json({ error: "bad_request" }, 400);
  const day = body.day ?? new Date().toISOString().slice(0, 10);
  await store.putSourceCount(env, day, body.channel, body.count);
  return json({ ok: true, day, channel: body.channel, count: body.count });
}

// ---------------------------------------------------------------------------- helpers

/** Read the request body, returning null if it exceeds the cap. */
async function readBounded(req: Request): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return null;
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
  const tse = (crypto.subtle as unknown as { timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean }).timingSafeEqual;
  if (typeof tse === "function") return tse.call(crypto.subtle, ab, bb);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
