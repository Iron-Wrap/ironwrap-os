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
     push to JobNimbus
     optional push to ERPNext Lead Envelope + Roof Job → status=pushed
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
| ERPNext bridge proof | `erpnext.ts` creates/updates Lead Envelope, Roofing Property, Roof Job, Measurement Report, and Evidence Item rows when enabled |

## Files

```
src/core.ts        pure logic (envelope, dedup, routing, reconcile) — node-testable, no I/O
src/store.ts       D1 + R2 adapters (the owned store)
src/jobnimbus.ts   JobNimbus push adapter (live-tested; enabled by config)
src/erpnext.ts     Optional ERPNext/Frappe consumer for lead, property, job, measurement, and evidence rows
src/google.ts      Gmail send + Google Drive Shared Drive filing
src/notify.ts      Gmail instant-ack/alerts/digest; SMS is JobNimbus Engage's job
src/index.ts       the Worker: fetch + queue + scheduled
migrations/0001_init.sql   D1 schema; 0002/0003 add ERPNext proof fields
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
npx wrangler secret put JOBNIMBUS_API_KEY
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
npx wrangler secret put QB_WEBHOOK_TOKEN   # when the QuickBooks webhook is connected
npx wrangler secret put ERPNEXT_API_KEY    # when ERPNext bridge is enabled
npx wrangler secret put ERPNEXT_API_SECRET

npm test                     # pure-logic self-test
npm run typecheck            # tsc --noEmit
npx wrangler deploy
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/ingest/:source` | `Bearer INGEST_TOKEN` | ingest a lead (`source` ∈ website,phone,gbp,ad,referral,manual) |
| POST | `/ingest/photo` | `Bearer INGEST_TOKEN` | ingest Jotform jobsite photos, file them to Google Drive, and optionally sync ERPNext Evidence Items |
| POST | `/ingest/measurement` | `Bearer INGEST_TOKEN` | ingest RoofRuler/AppliCad measurement metadata/report files |
| GET | `/health` | — | liveness |
| POST | `/admin/reconcile` | `Bearer ADMIN_TOKEN` | run reconciliation now |
| POST | `/admin/source-count` | `Bearer ADMIN_TOKEN` | record independent ground-truth count `{day?,channel,count}` |
| POST | `/admin/replay` | `Bearer ADMIN_TOKEN` | re-drive dead-lettered envelopes |
| GET | `/admin/envelopes?limit=50` | `Bearer ADMIN_TOKEN` | read recent bus envelopes for owner/Hermes diagnostics |
| GET | `/admin/envelope/:id` | `Bearer ADMIN_TOKEN` | read one canonical bus envelope |
| GET | `/admin/dead-letter?limit=50` | `Bearer ADMIN_TOKEN` | read unrecovered dead-letter rows |
| POST | `/webhook/quickbooks` | `intuit-signature` | capture signed QuickBooks invoice/payment events |

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
   `JOBNIMBUS_ENABLED` is now `"true"` in `wrangler.jsonc`.
2. **Google Workspace/Drive** — Gmail send and Shared Drive filing use
   `GOOGLE_SERVICE_ACCOUNT_JSON` with domain-wide delegation. `FROM_EMAIL` is currently
   `sales@ironwrapexteriors.com`; switch it only after the mailbox/sender alias decision changes.
3. **SMS / A2P** — the Worker does not send SMS. Prospect SMS belongs in JobNimbus Engage after
   A2P/carrier registration. Pre-A2P instant-ack is Gmail email + owner alert.
4. **QuickBooks webhook** — the receiver captures signed events now. Mirroring invoice/payment
   status back to JobNimbus needs a later QB OAuth read path.
5. **ERPNext bridge** — disabled by default. Before setting `ERPNEXT_ENABLED=true`, apply
   migrations and install the `frappe-apps/ironwrap_roofing` app so the Lead Envelope,
   Roofing Property, Roof Job, Measurement Report, Measurement Value, Production Gate
   State, and Evidence Item DocTypes exist. The Worker upserts Lead Envelope by
   `envelope_id`, optional Roofing Property by `property_key`, Roof Job by `roof_job_id`,
   and measurement reports by `measurement_id`. Measurement sync creates a linked
   Evidence Item for the raw/report artifact. Photo sync creates one photo Evidence
   Item per submitted Jotform photo and links Drive file ids/URLs when available.
   Roof Job sync also creates missing initial production gate rows without resetting
   existing gate state. ERPNext is still a consumer, not the raw intake source.

## Maintenance owner (don't skip — spec gap #3)

This is owned code a no-devops shop must keep running. Name a build/maintenance owner (or
a retainer) before going live, and keep the **hybrid**: a ~$9/mo Make Core seat for its
native JobNimbus/QuickBooks connectors + visual observability until this custom JobNimbus
integration is proven. The bus discipline (envelope, dedup, dead-letter, reconcile) is the
same as the spec — this only changes *where the infra runs*.
