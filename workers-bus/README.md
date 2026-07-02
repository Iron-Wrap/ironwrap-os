# ironwrap-bus

The IronWrap integration bus on Cloudflare Workers — the build that collapses the
spec's **Make bus + owned D1/R2 store** into one serverless app (~CAD $7/mo vs Make's
tier-bump). One Worker, three handlers: `fetch` (ingest + admin), `queue` (JobNimbus
push + dead-letter), `scheduled` (retry sweep + daily reconciliation).

> Implements `final-spec-pack/01,03,04,06`. The dual-write becomes a **single write**
> (the owned store *is* the bus), which is what dissolves the spec's partial-write
> problem: instant-ack fires off the owned-store write, and the JobNimbus push is a
> separate retried queue job — JobNimbus being down can never lose or delay a lead.

## Flow

```
inbound (website/phone/gbp/ad/referral/manual)
  │  POST /ingest/:source   (Bearer INGEST_TOKEN)
  ▼
[1] raw body → R2  ............... FIRST, nothing is ever lost
[2] canonical envelope → D1 ...... system of record (status=pending_jn_push)
[3] instant-ack (ctx.waitUntil) .. prospect email + owner alert — OFF the owned-store write
[4] enqueue → JN_QUEUE
        │
        ▼  queue consumer (idempotent, auto-retried)
     push to JobNimbus → status=pushed
        │ fail ×5 → DLQ → dead_letter table + owner email
        ▼
  cron */5  → retry sweep (re-drive anything stuck in pending_jn_push)
  cron 0 14 → reconcile: independent source counts vs landed; daily digest = heartbeat
```

## How it maps to the spec's hard requirements

| Spec requirement | Where |
|---|---|
| Canonical lead envelope `{source,contact,job_ref,payload,ts}` | `core.ts:normalizeEnvelope` |
| Raw submission stored FIRST | `index.ts:handleIngest` step 1 → `store.putRaw` (R2) |
| Owned store is system of record (single write) | `store.insertEnvelope` (D1) before any JN push |
| Dedup/idempotency on phone/email, all paths | `core.ts:dedupKey` + `store.findDuplicate` |
| Instant-ack/MCTB off the owned-store write (interim email pre-A2P) | `index.ts` step 5 → `notify.sendInstantAck` |
| Partial-write repair (pending_jn_push→pushed, retry sweep) | `queue` handler + `scheduled` retry sweep |
| Dead-letter on a redundant channel (email, not SMS-only) | DLQ consumer → `notify.sendOwnerAlert` |
| Daily reconciliation w/ independent ground-truth + heartbeat | `index.ts:runReconcile` + `source_counts` table |
| Idempotent record handoff, kill switch, logging | `external_id`=envelope_id; `JOBNIMBUS_ENABLED` flag; `audit_log` |
| Intent → owner queue routing (spec 16) | `core.ts:classifyIntent` |

## Files

```
src/core.ts        pure logic (envelope, dedup, routing, reconcile) — node-testable, no I/O
src/store.ts       D1 + R2 adapters (the owned store)
src/jobnimbus.ts   JobNimbus push adapter — GATED until API shape verified
src/notify.ts      Resend email (ack/alerts/digest); Twilio SMS stub (post-A2P)
src/index.ts       the Worker: fetch + queue + scheduled
migrations/0001_init.sql   D1 schema
test/core.test.ts  zero-dep self-test (`node --test`)
```

## Setup

```bash
npm install
npx wrangler login

# create resources, then paste the d1 id into wrangler.jsonc
npx wrangler d1 create ironwrap-bus
npx wrangler r2 bucket create ironwrap-bus-raw
npx wrangler queues create ironwrap-jn-push
npx wrangler queues create ironwrap-jn-dlq

npm run db:migrate           # apply schema to D1 (remote); db:migrate:local for local
npm run typegen              # generate worker-configuration.d.ts (Env types)

# secrets (never commit): see .dev.vars.example
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put JOBNIMBUS_API_KEY

npm test                     # pure-logic self-test
npm run typecheck            # tsc --noEmit
npx wrangler deploy
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/ingest/:source` | `Bearer INGEST_TOKEN` | ingest a lead (`source` ∈ website,phone,gbp,ad,referral,manual) |
| GET | `/health` | — | liveness |
| POST | `/admin/reconcile` | `Bearer ADMIN_TOKEN` | run reconciliation now |
| POST | `/admin/source-count` | `Bearer ADMIN_TOKEN` | record independent ground-truth count `{day?,channel,count}` |
| POST | `/admin/replay` | `Bearer ADMIN_TOKEN` | re-drive dead-lettered envelopes |

Point the website forms, GBP, and AssistAI call-completed webhook at `/ingest/:source`
(website → `/ingest/website`, AssistAI/voicemail → `/ingest/phone`, etc.). Feed the daily
independent counts (Twilio call logs, form-provider/Cloudflare logs, GBP) via
`/admin/source-count` so reconciliation can detect a lead that never reached the bus.

## ⚠️ Confirm before production (the honest seams)

1. **JobNimbus API** (`src/jobnimbus.ts`) — **verified live (2026-06-28)**: auth, the
   `{count,results}` envelope, `jnid`, the `filter` search, and the field mapping are
   confirmed against the real account. Valid record types are `Customer` (contact) /
   `Retail` (job), set via the `JN_*` vars — `"Lead"` is rejected by this account (it's the
   exact 400 that broke the experimental Make import). Idempotency is by the `bus:<id>` tag.
   The adapter stays **gated** (`JOBNIMBUS_ENABLED="false"`) only because the live **write**
   path hasn't been exercised yet — flip to `"true"` after one approved test write. Until
   then pushes fail loud into the dead-letter (never a fake success).
2. **Resend** — verify your sending domain + SPF/DKIM/DMARC; set `FROM_EMAIL`.
3. **Twilio / A2P** (`notify.sendProspectSms`) — wire after A2P 10DLC approves, then set
   `A2P_SMS_ENABLED="true"`. Pre-A2P the instant-ack is email + owner alert (spec interim path).

## Maintenance owner (don't skip — spec gap #3)

This is owned code a no-devops shop must keep running. Name a build/maintenance owner (or
a retainer) before going live, and keep the **hybrid**: a ~$9/mo Make Core seat for its
native JobNimbus/QuickBooks connectors + visual observability until this custom JobNimbus
integration is proven. The bus discipline (envelope, dedup, dead-letter, reconcile) is the
same as the spec — this only changes *where the infra runs*.
