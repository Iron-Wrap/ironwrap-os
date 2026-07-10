# ironwrap-bus

The IronWrap integration bus on Cloudflare Workers — the build that collapses the
spec's **Make bus + owned D1/R2 store** into one serverless app (~CAD $7/mo vs Make's
tier-bump). One Worker, three handlers: `fetch` (ingest + admin), `queue` (temporary
JobNimbus bridge + dead-letter), `scheduled` (retry sweep + daily reconciliation).

> Implements `final-spec-pack/01,03,04,06`. The dual-write becomes a **single write**
> (the owned store *is* the bus), which is what dissolves the spec's partial-write
> problem: instant-ack fires off the owned-store write, and bridge pushes are separate
> retried jobs — JobNimbus/GHL being down can never lose or delay owned intake.

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

estimator/configurator
  │  POST /ingest/estimate  (Bearer INGEST_TOKEN)
  ▼
[0] idempotency check ............ project id, Idempotency-Key, or project URL
[1] raw estimator payload → R2  ... FIRST for the accepted submission
[2] canonical envelope → D1 ...... status=received, no JobNimbus/GHL queue
[3] ERPNext Lead Envelope + Roof Job + Instant Estimate Session when enabled
[4] response returns ERPNext ids/errors to the estimator frontend; retries return the original ids
```

## How it maps to the spec's hard requirements

| Spec requirement | Where |
|---|---|
| Canonical lead envelope `{source,contact,job_ref,payload,ts}` | `core.ts:normalizeEnvelope` |
| Raw submission stored FIRST | `index.ts:handleIngest` step 1 → `store.putRaw` (R2) |
| Owned store is system of record (single write) | `store.insertEnvelope` (D1) before any JN push |
| Dedup/idempotency on phone/email, all paths | `core.ts:dedupKey` + `store.claimDedup` backed by D1 `dedup_claims` |
| Instant-ack/MCTB off the owned-store write (interim email pre-A2P) | `index.ts` step 5 → `notify.sendInstantAck` |
| Partial-write repair (pending_jn_push→pushed, retry sweep) | `queue` handler + `scheduled` retry sweep |
| Dead-letter on a redundant channel (email, not SMS-only) | DLQ consumer → `notify.sendOwnerAlert`; dead-letter rows keep a redacted payload pointer |
| Daily reconciliation w/ independent ground-truth + heartbeat | `index.ts:runReconcile` + `source_counts` table |
| Fail-closed readiness + operator status | `/ready` probes D1/schema/bindings/config; `/admin/status` reports heartbeat, queue/dead-letter/Frappe/audit/QB signals |
| Safe dead-letter recovery | targeted replay by `envelope_id`; confirmed bulk replay; recovery is marked only after that envelope completes |
| Idempotent record handoff, kill switch, logging | `external_id`=envelope_id; `JOBNIMBUS_ENABLED` flag; `audit_log` |
| Intent → owner queue routing (spec 16) | `core.ts:classifyIntent` |
| ERPNext bridge proof | `erpnext.ts` creates/updates Lead Envelope, Roofing Property, Roof Job, Instant Estimate Session, Measurement Report, Evidence Item, Field Check-in, and Payment Milestone rows when enabled |
| Owned estimator handoff | `estimates.ts` implements `/ingest/estimate`: retry-safe project/idempotency key + raw R2 + D1 envelope + ERPNext Instant Estimate Session without JobNimbus/GHL dependency |

## Files

```
src/core.ts        pure logic (envelope, dedup, routing, reconcile) — node-testable, no I/O
src/store.ts       D1 + R2 adapters (the owned store)
src/jobnimbus.ts   JobNimbus push adapter (live-tested; enabled by config)
src/erpnext.ts     Optional ERPNext/Frappe consumer for lead, property, job, estimate, measurement, evidence, field check-in, and payment milestone rows
src/estimates.ts   Owned estimator/configurator intake; idempotent by project/key; no JobNimbus/GHL queue
src/google.ts      Gmail send + Google Drive Shared Drive filing
src/notify.ts      Gmail instant-ack/alerts/digest; SMS is JobNimbus Engage's job
src/operations.ts  readiness, operational status, and dead-letter replay safety orchestration
src/index.ts       the Worker: fetch + queue + scheduled
migrations/0001_init.sql   D1 schema; 0002–0006 add operating proof/idempotency state; 0007–0010 add operational safety, replay approval evidence, and the run-id ledger
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
| POST | `/ingest/estimate` | `Bearer INGEST_TOKEN` | ingest public estimator/configurator payloads into owned R2/D1 and ERPNext without a JobNimbus/GHL queue dependency; accepts stable project ids or `Idempotency-Key`/`X-Idempotency-Key` for retry-safe replay |
| POST | `/ingest/photo` | `Bearer INGEST_TOKEN` | ingest Jotform jobsite photos, file them to Google Drive, and optionally sync ERPNext Evidence Items |
| POST | `/ingest/measurement` | `Bearer INGEST_TOKEN` | ingest RoofRuler/AppliCad measurement metadata/report files |
| GET | `/health` | — | backward-compatible, dependency-free liveness probe (`{"ok":true}`) |
| GET | `/ready` | — | detailed public readiness booleans; never returns secret values |
| GET | `/admin/status?audit_limit=20` | `Bearer ADMIN_TOKEN` | latest heartbeat, open dead letters, pending/stuck/Frappe/replay-ledger counts, 24h audit failures, and latest QB receipt freshness |
| POST | `/admin/reconcile` | `Bearer ADMIN_TOKEN` | run reconciliation now |
| POST | `/admin/source-count` | `Bearer ADMIN_TOKEN` | record `{day?,channel,count}`; day is a real UTC `YYYY-MM-DD`, channel is an ingest source, count is an integer from 0–1,000,000 |
| POST | `/admin/replay` | `Bearer ADMIN_TOKEN` | targeted or explicitly confirmed bulk dead-letter replay; both require non-secret human-approval evidence (below) |
| GET | `/admin/envelopes?limit=50` | `Bearer ADMIN_TOKEN` | read recent bus envelopes for owner/Hermes diagnostics |
| GET | `/admin/envelope/:id` | `Bearer ADMIN_TOKEN` | read one canonical bus envelope |
| GET | `/admin/dead-letter?limit=50` | `Bearer ADMIN_TOKEN` | read unrecovered dead-letter rows |
| POST | `/webhook/quickbooks` | `intuit-signature` | capture signed QuickBooks invoice/payment events with payload-hash replay protection |

Point the website forms, GBP, and AssistAI call-completed webhook at `/ingest/:source`
(website → `/ingest/website`, AssistAI/voicemail → `/ingest/phone`, etc.). Feed the daily
independent counts (Twilio call logs, form-provider/Cloudflare logs, GBP) via
`/admin/source-count` so reconciliation can detect a lead that never reached the bus.
Every HTTP response carries no-store, content/type/frame/referrer/permissions/HSTS hardening
and matching `X-Request-Id` / `X-Correlation-Id` headers. A safe caller-supplied correlation
id is preserved; otherwise the Worker generates one.

Replay mutation bodies are strict and require `run_id` (3–128 safe identifier characters),
`approved_by` (3–128 characters), and `reason` (10–500 characters). Targeted example:
`{"envelope_id":"ow_…","run_id":"hermes-run-…","approved_by":"owner@example.com","reason":"Cause verified fixed; approved for replay."}`.
Bulk example: `{"all":true,"confirm":"REPLAY_ALL_OPEN_DEAD_LETTERS","run_id":"hermes-run-…","approved_by":"owner@example.com","reason":"Cause verified fixed; approved for bulk replay."}`.
The approval context is stored in `audit_log`; bearer/approval tokens are never accepted in the
JSON body or persisted.

`run_id` is also the replay idempotency key. The first request atomically binds it to the exact
selection (`targeted` + envelope id, or `bulk`) plus `approved_by` and normalized `reason` in
`replay_requests`. An exact retry after completion returns the stored `{matched,requeued}` outcome
with `"replayed":true` and never queues or audits again. Reusing the run id for a different intent
returns `409 replay_run_id_conflict`; a concurrent exact request returns
`409 replay_run_in_progress`. A queue-publication failure rolls the envelope claim back and marks
the ledger attempt failed, so the same exact request can CAS the ledger into a new safe attempt.

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
4. **QuickBooks webhook** — the receiver captures signed events now, records a
   payload-hash receipt to block replay side effects, and can mirror Invoice/Payment
   webhook events into ERPNext Payment Milestone rows. Detailed amount/status sync
   back to JobNimbus still needs a later QB OAuth read path.
5. **ERPNext bridge** — disabled by default. Before setting `ERPNEXT_ENABLED=true`, apply
   migrations and install the `frappe-apps/ironwrap_roofing` app so the Lead Envelope,
   Roofing Property, Roof Job, Instant Estimate Session, Measurement Report, Measurement Value,
   Material Takeoff, Supplier Order, Production Gate State, Evidence Item, Field Check-in, and
   Payment Milestone DocTypes exist. The Worker upserts Lead Envelope by
   `envelope_id`, optional Roofing Property by `property_key`, Roof Job by `roof_job_id`,
   instant estimate sessions by `estimate_session_id` when estimate/range/total fields are present
   or `/ingest/estimate` receives a configurator payload,
   and measurement reports by `measurement_id`. Estimate sessions are captured as
   non-binding and review-required; `/ingest/estimate` stores configurator totals, project links,
   selected services, material choices, the stable estimator submission key, and the ERPNext
   Instant Estimate Session id when present. The Worker does not generate final pricing.
   Measurement sync creates a linked
   Evidence Item for the raw/report artifact. Photo sync creates one photo Evidence
   Item per submitted Jotform photo, links Drive file ids/URLs when available, and
   creates a Field Check-in summary row for the submission. QuickBooks webhook
   sync creates Payment Milestone event rows and links invoice events to Roof Job
   when `qb_invoice_ref` matches.
   Roof Job sync also creates missing initial production gate rows without resetting
   existing gate state. ERPNext is still a consumer, not the raw intake source.

## Operating owner

This is owned product code that IronWrap builds, operates, and resells, so keeping it running is
core to the business, not an outsourced burden. The owner plus Claude Code is the engineering/ops
capacity; the operations runbook (`docs/OPERATIONS-RUNBOOK.md`) covers monitoring, incident
playbooks, and rotation. Optionally keep a ~$9/mo Make Core seat for its native connectors and
visual observability until the owned replacements are proven. The bus discipline (envelope, dedup,
dead-letter, reconcile) is the same as the spec; this only changes where the infra runs.
