# ironwrap-bus

The IronWrap integration bus on Cloudflare Workers — the build that collapses the
spec's **Make bus + owned D1/R2 store** into one serverless app (~CAD $7/mo vs Make's
tier-bump). One deployment serves the built PWA, its authenticated `/api/v1/*` BFF,
ingest/admin routes, queue consumers, and scheduled recovery. Static app navigation falls back
to `app/dist/index.html`; dynamic routes are explicitly Worker-first in `wrangler.jsonc`.

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

IronWrap PWA
  │  passwordless session cookie + exact-origin CORS + CSRF on authenticated mutations
  ▼
[1] tenant-bound active app user → one-time emailed magic link (hash only in D1)
[2] one-time consume → fixed 12h __Host session (hash only in D1)
[3] /api/v1/today, /jobs/:id, /owner/now, /sales, /estimator/jobs/:id → permission-shaped Frappe reads
[4] field users are filtered and rechecked against Frappe _assign before a job is returned
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
| Passwordless app auth | `app-auth.ts` + D1 migration `0011`; one-time hashed links, hashed fixed-TTL sessions, exact-origin CORS, CSRF, throttles, and audit |
| Permission-shaped PWA reads | `app-read-models.ts` + `frappe-read.ts`; hard-coded DocType/field/filter allowlists and fail-closed field assignment |

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
src/app-auth.ts    one-time magic-link/session/CSRF/origin contract; no raw token persistence
src/app-auth-store.ts D1 app-user/auth/throttle/audit adapter and retention cleanup
src/frappe-read.ts strict default, office-Sales, and office-Estimator Frappe GET allowlists plus credential-safe upstream adapter
src/app-read-models.ts screen-shaped Today, Job, Owner Now, bounded office Sales, and source-derived Estimator projections
src/app-api.ts     /api/v1 routing/CORS plus admin-token app-user provisioning and governed approval routes
src/approval-store.ts immutable D1 approval-request projection/event ledger and CAS transitions
src/approval-broker-client.ts Worker-to-private-broker HMAC client; no Frappe write capability in Worker
src/index.ts       the Worker: fetch + queue + scheduled
migrations/0001_init.sql   D1 schema; 0002–0010 add operating and replay safety; 0011 adds app auth/audit state
test/core.test.ts  zero-dep self-test (`node --test`)
```

## Setup

```bash
# Node.js 22+ (required by the pinned Wrangler runtime)
npm ci --ignore-scripts        # Wrangler's optional sharp hook is not required by this Worker
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
npx wrangler secret put APP_AUTH_PEPPER    # 32+ random characters; required before APP_BFF_ENABLED=true
npx wrangler secret put APPROVAL_BROKER_SHARED_SECRET  # only when the governed approval broker is enabled

npm test                     # pure-logic self-test
npm run typecheck            # tsc --noEmit
(cd ../app && npm ci && npm run build)  # creates the static-assets directory
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
| POST | `/admin/source-count` | `Bearer ADMIN_TOKEN` | record `{day?,channel,count}`; day is a real UTC `YYYY-MM-DD`, channel is an ingest source, count is an integer from 0–1,000,000 |
| POST | `/admin/replay` | `Bearer ADMIN_TOKEN` | targeted or explicitly confirmed bulk dead-letter replay; both require non-secret human-approval evidence (below) |
| GET | `/admin/envelopes?limit=50` | `Bearer ADMIN_TOKEN` | read recent bus envelopes for owner/Hermes diagnostics |
| GET | `/admin/envelope/:id` | `Bearer ADMIN_TOKEN` | read one canonical bus envelope |
| GET | `/admin/dead-letter?limit=50` | `Bearer ADMIN_TOKEN` | read unrecovered dead-letter rows |
| POST | `/admin/app-users` | `Bearer ADMIN_TOKEN` | provision/update/deactivate one user on this deployment's configured tenant |
| POST | `/webhook/quickbooks` | `intuit-signature` | capture signed QuickBooks invoice/payment events with payload-hash replay protection |
| POST | `/api/v1/auth/magic-link/request` | exact allowed `Origin` | request a link; active/unknown/inactive/throttled identities receive the same `202` body |
| POST | `/api/v1/auth/magic-link/consume` | exact allowed `Origin` | atomically consume a one-time token and set the fixed-TTL `__Host-ironwrap_session` cookie; GET is not supported |
| GET | `/api/v1/session` | cookie optional | exact authenticated/unauthenticated bootstrap envelope; always `200`, `private, no-store` |
| POST | `/api/v1/auth/logout` | session cookie + `X-CSRF-Token` + exact allowed `Origin` | revoke the current hashed session and expire its cookie |
| GET | `/api/v1/today` | session cookie | assigned active jobs for field; broader active jobs for owner/ops |
| GET | `/api/v1/jobs/:id` | session cookie | job, gate locks, and proof stream; an unassigned field lookup is indistinguishable from missing |
| GET | `/api/v1/owner/now` | owner/ops session | exception-first blocked gate, incident, finance, lead, and material read model |
| GET | `/api/v1/sales` | owner/ops session | bounded office Lead Envelope, estimate, quote, and communication-record review DTO; raw payloads and commercial-policy internals are excluded |
| GET | `/api/v1/estimator/jobs/:id` | owner/ops session | bounded source-review DTO: server-recomputed retained geometry, persisted metric/takeoff source refs, explicit measurement-to-takeoff and quote-to-proposal linkage, captured quote snapshot/revision comparison, and quote-attributed change-order review; no raw key/XML/report URL/evidence JSON or mutation path |
| GET | `/api/v1/approvals` | owner/ops session | browser-safe approval inbox with server-issued capability names; never returns receipts, raw args, or broker output |
| GET | `/api/v1/approvals/:id` | owner/ops session | one current approval DTO; re-evaluates pending expiry |
| POST | `/api/v1/approvals/lead-triage` | owner/ops session + CSRF + idempotency key | fixed local-triage preparation path; not a generic tool proxy |
| POST | `/api/v1/approvals/:id/approve` | configured owner + CSRF + recent session + idempotency key | compare-and-set decision through the private broker; transport ambiguity becomes `execution_uncertain`, never a retry |
| POST | `/api/v1/approvals/:id/reject` | configured owner + CSRF + recent session + idempotency key | durable rejection; does not invoke the broker |
| POST | `/api/v1/approvals/:id/reconcile` | configured owner + CSRF + recent session | append reconciliation evidence/outcome to an uncertain request; never reopens or retries the write |

### PWA auth and tenant boundary

This slice is intentionally **one tenant + one Frappe site + one Worker deployment**. Frappe
business records do not yet carry a tenant discriminator, so `APP_TENANT_ID` is the isolation
boundary: provisioning rejects any other tenant, every session joins back to an active user on
that tenant, and the BFF rejects a session whose tenant differs. A reseller tenant gets a separate
deployment/site/credential set until record-level tenant isolation exists and is proven.
The magic-link request body is `{ "email": "…" }`; the Worker infers its configured tenant. A
legacy caller may also send `tenant_id`, but a mismatch still receives the same generic `202` and
never selects another tenant.

Required non-secret configuration before `APP_BFF_ENABLED=true`:

```text
APP_TENANT_ID=ironwrap
APP_TENANT_NAME=IronWrap OS
APP_TENANT_BRAND=IronWrap
APP_LOCALE=en-CA
APP_TIME_ZONE=America/Edmonton
APP_CURRENCY=CAD
APP_PUBLIC_ORIGIN=https://<the deployed app origin>
APP_ALLOWED_ORIGINS=https://<the deployed app origin>
```

Provision with `POST /admin/app-users` and the admin bearer token:

```json
{
  "tenant_id": "ironwrap",
  "email": "crew@example.com",
  "display_name": "Crew Member",
  "role": "field",
  "frappe_user_id": "crew@example.com",
  "active": true,
  "provisioned_by": "owner@example.com"
}
```

`role` is exactly `owner`, `ops`, or `field`; field users require a Frappe user id for exact
assignment checks. Re-send the record with `active:false` to revoke that user's sessions
and open link. Keep `APP_BFF_ENABLED=false` until migration `0011`, the app build, Frappe read
credentials, Gmail delegation, `APP_AUTH_PEPPER`, and the origin metadata are present; `/ready`
fails closed when any enabled-BFF dependency is missing or malformed.

`APP_AUTH_PEPPER` is a Worker secret with at least 32 random characters. Production accepts only
HTTPS origins. `APP_ALLOW_INSECURE_LOCAL=true` permits explicit localhost HTTP origins for local
development only. `APP_PUBLIC_ORIGIN` must be in the exact comma-separated origin allowlist.
There is never a wildcard credentialed CORS response.

### Governed approval broker (optional BFF slice)

The ordinary BFF read surfaces do **not** require an approval broker. Enable
this separate slice only after migration `0016` and the private broker host are
ready. Set these Worker values (the shared secret is a secret binding):

```text
APP_APPROVAL_BROKER_URL=https://<private-access-broker-origin>
APP_APPROVAL_BROKER_KEY_ID=approval-v1
APP_APPROVAL_APPROVER_ID=owner@ironwrapexteriors.com
APP_APPROVAL_MAX_SESSION_AGE_SECONDS=900
APP_APPROVAL_BROKER_TIMEOUT_MS=15000
APP_APPROVAL_EXECUTION_LEASE_SECONDS=45
APPROVAL_BROKER_SHARED_SECRET=<same 32+-byte value held by the broker>
```

The Worker HMAC-binds timestamp, path, nonce, and raw body in both directions.
It holds the D1 approval ledger only—not the Ed25519 approval private key or
Frappe write credentials. The separate loopback-only broker owns those
credentials and exposes only `/v1/lead-triage/preview` and
`/v1/lead-triage/execute`; see `docs/APPROVAL-BROKER-CONTRACT.md` and
`deploy/approval-broker.service.example`. A stale execution lease becomes
`execution_uncertain` during the frequent Worker sweep and must be reconciled
by recorded `run_id`, never automatically re-executed.

The session cookie is `Secure; HttpOnly; SameSite=Strict; Path=/`, has no `Domain`, and expires
after a fixed 12 hours. The D1 row contains only an HMAC; the CSRF value is separately derived and
must be echoed in `X-CSRF-Token` for authenticated mutations. Magic links expire after 15 minutes,
are stored only as SHA-256 hashes, are invalidated when replaced/deactivated, and are consumed by
POST only. The email targets `/auth/verify#token=…`; the PWA immediately scrubs that fragment and
POSTs it to `/api/v1/auth/magic-link/consume`. The fragment stays out of HTTP/access logs and a
normal link-scanner GET cannot consume it. IP/email throttles and redacted auth audit rows live in
the owned D1 database; raw tokens, cookie values, Frappe credentials, and authorization headers are
never logged or returned.

`GET /api/v1/session` always returns this top-level contract (null/empty auth fields when signed out):

```json
{
  "version": 1,
  "authenticated": true,
  "user": {
    "id": "appu_...",
    "email": "crew@example.com",
    "display_name": "Crew Member",
    "role": "field",
    "frappe_user_id": "crew@example.com"
  },
  "tenant": {
    "id": "ironwrap",
    "name": "IronWrap OS",
    "brand": "IronWrap",
    "locale": "en-CA",
    "time_zone": "America/Edmonton",
    "currency": "CAD"
  },
  "permissions": ["session:read", "jobs:read:assigned"],
  "allowed_actions": ["session.logout", "today.read", "job.read.assigned"],
  "csrf_token": "client-echo-token",
  "session_expires_at": "2026-07-10T22:00:00.000Z",
  "source_updated_at": "2026-07-10T10:00:00.000Z",
  "read_model_generated_at": "2026-07-10T10:00:01.000Z",
  "stale_fields": []
}
```

The three operational read endpoints use the same top-level metadata envelope. Their exact v1
shapes are:

```json
{
  "version": 1,
  "source_updated_at": "2026-07-10T10:00:00.000Z",
  "read_model_generated_at": "2026-07-10T10:00:01.000Z",
  "stale_fields": ["jobs.scheduled_start", "jobs.scheduled_end", "jobs.next_action"],
  "permissions": ["session:read", "jobs:read:assigned"],
  "allowed_actions": ["job.read", "gate.read", "evidence.read", "checkin.read"],
  "date": "2026-07-10",
  "jobs": [{
    "id": "ROOF-JOB-0001",
    "job_number": "IW-1042",
    "brand": "IronWrap",
    "status": "In Production",
    "address": "123 Example Ave, Calgary AB T2P 1J9, Canada",
    "scheduled_start": null,
    "scheduled_end": null,
    "blocked_gate_count": 1,
    "next_action": null
  }]
}
```

```json
{
  "version": 1,
  "source_updated_at": "2026-07-10T10:00:00.000Z",
  "read_model_generated_at": "2026-07-10T10:00:01.000Z",
  "stale_fields": ["required_proof"],
  "permissions": ["session:read", "jobs:read:assigned"],
  "allowed_actions": ["job.read", "gate.read", "evidence.read", "checkin.read"],
  "job": {
    "id": "ROOF-JOB-0001",
    "roof_job_id": "rj_...",
    "job_number": "IW-1042",
    "brand": "IronWrap",
    "service_type": "Roof Replacement",
    "status": "In Production",
    "address": "123 Example Ave, Calgary AB T2P 1J9, Canada",
    "current_gate_state": "Blocked"
  },
  "gates": [{
    "id": "gate_...",
    "name": "Dry-in",
    "state": "Blocked",
    "blocker_reason": "Underlayment proof missing",
    "owner": "ops@example.com",
    "due_at": "2026-07-11 12:00:00"
  }],
  "proof_stream": [{
    "id": "evidence_...",
    "type": "Jobsite Photo",
    "occurred_at": "2026-07-10T09:30:00.000Z",
    "summary": "North slope dry-in",
    "customer_safe": true,
    "source": "Jotform"
  }],
  "required_proof": []
}
```

```json
{
  "version": 1,
  "source_updated_at": "2026-07-10T10:00:00.000Z",
  "read_model_generated_at": "2026-07-10T10:00:01.000Z",
  "stale_fields": ["exceptions.next_action"],
  "permissions": ["session:read", "jobs:read:any", "owner:read"],
  "allowed_actions": ["job.read", "lead.read", "lead_triage.read", "field_blocker.read", "incident.read", "finance_exception.read", "material_exception.read"],
  "exceptions": [{
    "id": "gate_...",
    "kind": "blocked_gate",
    "severity": null,
    "title": "Dry-in gate blocked",
    "why": "Underlayment proof missing",
    "next_action": null,
    "job_id": "ROOF-JOB-0001",
    "occurred_at": null,
    "due_at": "2026-07-11 12:00:00",
    "received_at": null,
    "bus_status": null,
    "triage_status": null,
    "mctb": null
  }],
  "partial_sources": [],
  "summary": {
    "active_jobs": 7,
    "field_blockers": 0,
    "blocked_gates": 1,
    "open_incidents": 0,
    "finance_exceptions": 0,
    "untriaged_leads": 2,
    "lead_triage_unknown": 0,
    "mctb_unproven_due": 0,
    "material_exceptions": 0
  }
}
```

The examples show known values; if a source does not provide one, the value is explicitly `null`
and its path is named in `stale_fields`. The BFF does not fabricate schedule, money, gate-owner,
due-date, next-action, or required-proof data. Frappe requests are GET-only and limited to the
hard-coded DocType, field, filter, and row allowlists in `frappe-read.ts`. Field users must have a
`frappe_user_id` and may see only jobs whose standard Frappe `_assign` JSON contains that exact id;
the Worker rechecks the returned row instead of trusting only the upstream filter.

Point the website forms, GBP, and AssistAI call-completed webhook at `/ingest/:source`
(website → `/ingest/website`, AssistAI/voicemail → `/ingest/phone`, etc.). Feed the daily
independent counts (Twilio call logs, form-provider/Cloudflare logs, GBP) via
`/admin/source-count` so reconciliation can detect a lead that never reached the bus.
Every Worker-generated API/admin/ingest/webhook response carries no-store (the session endpoint is
explicitly `private, no-store`), content/type/frame/referrer/permissions/HSTS hardening, and matching
`X-Request-Id` / `X-Correlation-Id` headers. Static PWA assets are served separately by Cloudflare's
asset binding and remain cacheable. A safe caller-supplied correlation id is preserved; otherwise
the Worker generates one.

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
