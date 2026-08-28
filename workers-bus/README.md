# ironwrap-bus

The IronWrap integration bus on Cloudflare Workers. It implements the owned D1/R2 first-write
intake, normalized operating plane, control kernel, and evidence spine described by
[`docs/AI-NATIVE-ARCHITECTURE.md`](../docs/AI-NATIVE-ARCHITECTURE.md). One deployment
serves the built PWA, its authenticated `/api/v1/*` BFF,
ingest/admin routes, queue consumers, and scheduled recovery. Static app navigation falls back
to `app/dist/index.html`; dynamic routes are explicitly Worker-first in `wrangler.jsonc`.

The owned store is the initial durable write. Instant acknowledgement follows owned-store
acceptance; bridge pushes are separate retried jobs. An unavailable bridge must not lose or delay
owned intake, and intake success must not be reported as bridge-delivery proof.

## Flow

```
inbound (website/phone/gbp/ad/referral/manual)
  │  POST /ingest/:source   (Bearer INGEST_TOKEN)
  ▼
[1] raw body → R2  ............... FIRST, nothing is ever lost
[2] canonical envelope → D1 ...... authoritative intake record (`envelopes.tenant_id` + status=pending_jn_push)
[3] instant-ack (ctx.waitUntil) .. prospect email + owner alert — OFF the owned-store write
[4] enqueue → JN_QUEUE
        │
        ▼  queue consumer (idempotent, auto-retried)
     push to JobNimbus
     optional Frappe compatibility projection → status=pushed
        │ fail ×5 → DLQ → dead_letter table + owner email
        ▼
  cron */5  → retry sweep (re-drive anything stuck in pending_jn_push)
  cron 0 14 → reconcile: independent source counts vs landed; daily digest = heartbeat

governed pipeline stage automation (disabled by default)
  committed transition → immutable outbox binding → bounded cron */5 drain
  owner-only rule revisions + deployment-owned recipient refs → universal effect runtime/Gmail readback

estimator/configurator
  │  POST /ingest/estimate  (Bearer INGEST_TOKEN)
  ▼
[0] idempotency check ............ project id, Idempotency-Key, or project URL
[1] raw estimator payload → R2  ... FIRST for the accepted submission
[2] canonical envelope → D1 ...... status=received, no JobNimbus/GHL queue
[3] native D1 estimate/lead/job records; optional Frappe compatibility projection when enabled
[4] response returns native identities plus any projection outcome; retries return original identities

Facet approved design
  │  POST /ingest/facet-design  (dedicated HMAC; never INGEST_TOKEN)
  ▼
[1] signed raw event + source→local allowlist → immutable R2 ........... FIRST
[2] design receipt + hashed nonce → D1 ........ no quote/contract/Frappe mutation
[3] optional scheduled projection uses exact current anchors → blank non-customer-safe Draft,
    predecessor rejection on chain advance, evidence + reconciliation

IronWrap PWA
  │  passwordless session cookie + exact-origin CORS + CSRF on authenticated mutations
  ▼
[1] tenant-bound active app user → one-time emailed magic link (hash only in D1)
[2] one-time consume → fixed 12h __Host session (hash only in D1)
[3] /api/v1/today, /jobs/:id, /owner/now, /sales, /estimator/jobs/:id → permission-shaped native D1 reads
[4] remaining explicitly named compatibility reads fail closed and cannot promote Frappe state into authority
```

## Implemented mappings to canonical intake requirements

| Requirement | Where |
|---|---|
| Canonical lead envelope `{source,contact,job_ref,payload,ts}` | `core.ts:normalizeEnvelope` |
| Raw submission stored FIRST | `index.ts:handleIngest` step 1 → `store.putRaw` (R2) |
| Owned intake record precedes side effects | `store.insertEnvelope` (D1) before any JN push |
| Dedup/idempotency on phone/email, all paths | `core.ts:dedupKey` + `store.claimDedup` backed by D1 `dedup_claims`; a contact replay returns the original `envelope_id` / `canonical_envelope_id` and does not insert a second `envelopes` row |
| Operating tenant on the lead row | `envelopes.tenant_id` (migration 0082); ingest refuses unverified `APP_TENANT_ID` labels before mutation |
| Instant-ack/MCTB off the owned-store write (interim email pre-A2P) | `index.ts` step 5 → `notify.sendInstantAck` |
| Partial-write repair (pending_jn_push→pushed, retry sweep) | `queue` handler + `scheduled` retry sweep |
| Dead-letter on a redundant channel (email, not SMS-only) | DLQ consumer → `notify.sendOwnerAlert`; dead-letter rows keep a redacted payload pointer |
| Daily reconciliation w/ independent ground-truth + heartbeat | `index.ts:runReconcile` + `source_counts` table |
| Fail-closed readiness + operator status | `/ready` probes D1/schema/bindings/config; `/admin/status` reports heartbeat, queue/dead-letter/Frappe/audit/QB signals |
| Safe dead-letter recovery | targeted replay by `envelope_id`; confirmed bulk replay; recovery is marked only after that envelope completes |
| Idempotent record handoff, kill switch, logging | `external_id`=envelope_id; `JOBNIMBUS_ENABLED` flag; `audit_log` |
| Intent → owner queue routing | `core.ts:classifyIntent` |
| Optional Frappe compatibility projection | `erpnext.ts` creates/updates bounded legacy records when enabled; failures do not rewrite authoritative D1 state |
| Owned estimator handoff | `estimates.ts` implements `/ingest/estimate`: retry-safe project/idempotency key + raw R2 + native D1 records plus any enabled compatibility projection, without JobNimbus/GHL dependency |
| Facet approved-design receipt | `facet-design-ingest.ts` verifies a dedicated raw-body HMAC plus source-tenant allowlist, stores immutable R2 evidence first, then local-tenant D1 event/nonce anchors; it is distinct from estimate, quote, contract, and customer acceptance |
| Facet review projection | `facet-design-frappe-projection.ts` reads only current native v2 heads with exact project, identity, quote, proposal, publication, and acceptance authority. The default-off Frappe endpoint creates a blank non-customer-safe Draft Customer Quote for active decisions, rejects the predecessor projected quote on chain advance, and appends Evidence Item plus Integration Reconciliation records without supplying commercial terms. |
| Passwordless app auth | `app-auth.ts` + D1 migration `0011`; one-time hashed links, hashed fixed-TTL sessions, exact-origin CORS, CSRF, throttles, and audit |
| Permission-shaped PWA reads | `app-read-models.ts` and native D1 domain stores; any remaining `frappe-read.ts` compatibility access uses hard-coded DocType/field/filter allowlists and fails closed |
| Governed stage-change automation | `pipeline-automation.ts` + migrations `0123_pipeline_stage_automation.sql` and `0127_pipeline_automation_action_registry.sql`; a closed two-action registry (stage-change email, and generate-a-document-then-email-it), immutable outbox bindings, exact leases, effect/readback evidence, and explicit no-rule completion |
| Automation-generated documents | `pipeline-automation.ts` -> `document-generation-r2.ts`; the document action mints a scoped `worker`/`ops` service permit per invocation - one tenant, entity, template, action and attempt - so an automation never borrows the owner's route or role, and the delivered mail carries the exact bytes the immutable receipt attests |

## Files

```
src/core.ts        pure logic (envelope, dedup, routing, reconcile) — node-testable, no I/O
src/store.ts       D1 + R2 adapters (the owned store)
src/jobnimbus.ts   Config-gated JobNimbus push adapter
src/erpnext.ts     Optional Frappe compatibility projection for bounded legacy records
src/estimates.ts   Owned estimator/configurator intake; idempotent by project/key; no JobNimbus/GHL queue
src/facet-design-ingest.ts Signed Facet approved-design evidence receipt; no Frappe or commercial mutation
src/facet-design-projection.ts Scheduled review-only D1-anchor projection through a separately authenticated Frappe command
src/measurement-intake-store.ts Durable, hashed measurement receipt/lease ledger and exception query
src/pipeline-automation.ts Owner-only rule revisions and bounded stage-change outbox/effect drain
src/google.ts      Gmail send + Google Drive Shared Drive filing
src/notify.ts      Gmail instant-ack/alerts/digest; no prospect-SMS implementation
src/operations.ts  readiness, operational status, and dead-letter replay safety orchestration
src/app-auth.ts    one-time magic-link/session/CSRF/origin contract; no raw token persistence
src/app-auth-store.ts D1 app-user/auth/throttle/audit adapter and retention cleanup
src/frappe-read.ts strict compatibility-only Frappe GET allowlists plus credential-safe upstream adapter
src/app-read-models.ts screen-shaped Today, Job, Owner Now, bounded office Sales, and source-derived Estimator projections assembled from authoritative/native stores plus named compatibility seams
src/app-api.ts     /api/v1 routing/CORS plus admin-token app-user provisioning and governed approval routes
src/approval-store.ts immutable D1 approval-request projection/event ledger and CAS transitions
src/approval-broker-client.ts Worker-to-private-broker HMAC client; no Frappe write capability in Worker
src/index.ts       the Worker: fetch + queue + scheduled
migrations/0001_init.sql   D1 schema; 0002–0010 add operating and replay safety; 0011 adds app auth/audit state; 0019 adds measurement receipt leases; 0123 adds governed stage automation; 0127 widens its closed action registry
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
npx wrangler secret put INGEST_TOKEN --env=""
npx wrangler secret put ADMIN_TOKEN --env=""
npx wrangler secret put NEWO_WEBHOOK_TOKEN --env=""  # only when Newo phone intake is enabled
npx wrangler secret put JOBNIMBUS_API_KEY --env=""
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --env=""
npx wrangler secret put PIPELINE_AUTOMATION_RECIPIENTS_JSON --env=""  # opaque ref -> address mapping; required only when automation is enabled
npx wrangler secret put QB_WEBHOOK_TOKEN --env=""  # when the QuickBooks webhook is connected
npx wrangler secret put QB_RECONCILIATION_ISSUER_API_KEY --env=""
npx wrangler secret put QB_RECONCILIATION_ISSUER_API_SECRET --env=""
npx wrangler secret put ERPNEXT_API_KEY --env=""  # when the Frappe bridge is enabled
npx wrangler secret put ERPNEXT_API_SECRET --env=""
npx wrangler secret put FLEET_CAPTURE_FRAPPE_API_KEY --env=""     # dedicated fleet-capture issuer
npx wrangler secret put FLEET_CAPTURE_FRAPPE_API_SECRET --env=""
npx wrangler secret put WORK_PACKAGE_FRAPPE_API_KEY --env=""      # dedicated work-package issuer
npx wrangler secret put WORK_PACKAGE_FRAPPE_API_SECRET --env=""
npx wrangler secret put PUBLIC_ESTIMATE_TURNSTILE_SECRET --env=""
npx wrangler secret put PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER --env=""  # 32+ random characters
npx wrangler secret put APP_AUTH_PEPPER --env=""  # 32+ random characters; required before APP_BFF_ENABLED=true
npx wrangler secret put APPROVAL_BROKER_SHARED_SECRET --env=""  # only when the governed approval broker is enabled
npx wrangler secret put FACET_DESIGN_INGEST_HMAC_KEY --env=""  # separate Facet event authority
npx wrangler secret put FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY --env=""  # separate projection HMAC
npx wrangler secret put FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY --env=""  # dedicated Frappe role
npx wrangler secret put FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET --env=""

npm test                     # pure-logic self-test
npm run typecheck            # tsc --noEmit
(cd ../app && npm ci && npm run build)  # creates the static-assets directory
npx wrangler deploy --env=""
```

The two `FLEET_CAPTURE_*` / `WORK_PACKAGE_*` pairs are NOT copies of `ERPNEXT_API_KEY`. Each
belongs to its own non-interactive Frappe user holding only the `IronWrap Fleet Capture Issuer`
or `IronWrap Work Package Issuer` role, and the site config must pin
`ironwrap_fleet_capture_issuer_user` / `ironwrap_work_package_issuer_user` to those users. The
Worker refuses a pair whose value matches the bus pair (`*_frappe_shared_credential_rejected`)
and `/ready` reports `rail_credential_isolation: false` for it, so the shared arrangement cannot
be reintroduced by copying a value. Rotation steps are in
`docs/OPERATIONS-RUNBOOK.md`.

QuickBooks projection also needs the non-secret Worker vars `QB_EXPECTED_REALM_ID` and
`QB_RECONCILIATION_ISSUER_USER`. The user must be a separate Frappe service principal with only
the IronWrap QuickBooks Reconciliation Issuer role, using the two issuer secrets above, and must
match the Frappe site config `ironwrap_quickbooks_reconciliation_issuer_user`. Do not reuse the
general Worker, Hermes MCP, Administrator, or human-finance credentials.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/ingest/:source` | `Bearer INGEST_TOKEN` | ingest a lead (`source` ∈ website,phone,gbp,ad,referral,manual); response includes `envelope_id`, `canonical_envelope_id`, and `tenant_id` |
| POST | `/webhook/newo` | `Bearer NEWO_WEBHOOK_TOKEN` | receive an authenticated Newo Custom Tool handoff as canonical `phone` intake; raw provider body is retained first and duplicate retries do not repeat acknowledgement/queue work. See [`docs/NEWO-INTEGRATION.md`](../docs/NEWO-INTEGRATION.md). |
| POST | `/ingest/estimate` | `Bearer INGEST_TOKEN` | ingest estimator/configurator payloads into owned R2/D1 and any enabled Frappe compatibility projection without a JobNimbus/GHL queue dependency; accepts stable project ids or `Idempotency-Key`/`X-Idempotency-Key` for retry-safe replay |
| POST | `/ingest/facet-design` | dedicated HMAC + exact source-tenant map | receive only `facet.design.approved.v1` design-decision evidence; raw R2 first, immutable local-tenant D1 receipt/nonce second, no quote/contract/Frappe side effect |
| GET | `/public/instant-estimate/config` | exact configured `Origin` when supplied | public Turnstile/site availability envelope; an Origin-less same-origin GET is allowed without CORS headers |
| POST | `/public/instant-estimate` | exact configured `Origin` + Turnstile | public review intake; raw canonical consent is stored first, client/IP rate keys are HMAC hashes only, and no price is returned before measurement and approved pricing evidence |
| POST | `/ingest/photo` | `Bearer INGEST_TOKEN` | ingest Jotform jobsite photos, file them to owned evidence storage/Google Drive, and optionally project Frappe Evidence Items |
| POST | `/ingest/measurement` | `Bearer INGEST_TOKEN` | ingest RoofRuler/AppliCad measurement metadata/report files; provider attachment identity takes precedence over a retry header, raw is stored before downstream work, and completed receipts replay safely |
| GET | `/health` | — | backward-compatible, dependency-free liveness probe (`{"ok":true}`) |
| GET | `/ready` | — | detailed public readiness booleans; never returns secret values |
| GET | `/admin/status?audit_limit=20` | `Bearer ADMIN_TOKEN` | latest heartbeat, open dead letters, pending/stuck/provider/projection/replay-ledger counts, 24h audit failures, and latest QB receipt freshness |
| POST | `/admin/source-count` | `Bearer ADMIN_TOKEN` | record `{day?,channel,count}`; day is a real UTC `YYYY-MM-DD`, channel is an ingest source, count is an integer from 0–1,000,000 |
| POST | `/admin/replay` | `Bearer ADMIN_TOKEN` | targeted or explicitly confirmed bulk dead-letter replay; both require non-secret human-approval evidence (below) |
| GET | `/admin/envelopes?limit=50` | `Bearer ADMIN_TOKEN` | read recent bus envelopes for owner/Hermes diagnostics |
| GET | `/admin/envelope/:id` | `Bearer ADMIN_TOKEN` | read one canonical bus envelope |
| GET | `/admin/dead-letter?limit=50` | `Bearer ADMIN_TOKEN` | read unrecovered dead-letter rows |
| GET | `/admin/measurements/exceptions?limit=50` | `Bearer ADMIN_TOKEN` | read unmatched or retryable measurement receipts without idempotency/payload hash fields or lease tokens; opaque receipt ids and raw pointers remain available for review. Retryable and expired-lease receipts re-drive sequentially from verified R2 raw sources with bounded backoff |
| POST | `/admin/app-users/bootstrap` | `Bearer ADMIN_TOKEN` + `APP_FIRST_OWNER_BOOTSTRAP_ENABLED=true` | one-time bootstrap that creates the first owner only when this tenant has zero app users |
| POST | `/webhook/quickbooks` | `intuit-signature` | accept expected-realm signed finance identities, persist raw/D1 receipt and durable reconciliation work, and optionally project a Pending Frappe record; webhook identity is not posted-accounting truth |
| POST | `/api/v1/auth/magic-link/request` | exact allowed `Origin` | request a link; active/unknown/inactive/throttled identities receive the same `202` body |
| POST | `/api/v1/auth/magic-link/consume` | exact allowed `Origin` | atomically consume a one-time token and set the fixed-TTL `__Host-ironwrap_session` cookie; GET is not supported |
| GET | `/api/v1/session` | cookie optional | exact authenticated/unauthenticated bootstrap envelope; always `200`, `private, no-store` |
| POST | `/api/v1/auth/logout` | session cookie + `X-CSRF-Token` + exact allowed `Origin` | revoke the current hashed session and expire its cookie |
| POST | `/api/v1/admin/app-users` | office session + `X-CSRF-Token` | steady-state provision/update/deactivate one user on this deployment's configured tenant |
| GET/POST | `/api/v1/admin/schema-fields[/{field_id}]` | owner session; mutations require CSRF + idempotency | list/create/read/revise current tenant field configuration; the `/revisions` child is immutable history |
| GET/POST | `/api/v1/admin/document-templates[/{template_id}]` | owner session; mutations require CSRF + idempotency | list/create/read/revise current safe document templates; the `/revisions` child is immutable history |
| GET | `/api/v1/schema-fields/{entity_type}/{entity_id}` | current session | server-filtered record fields and current values |
| POST | `/api/v1/schema-fields/{entity_type}/{entity_id}/{field_id}/values` | current session + CSRF + idempotency | append one field value with expected-version CAS |
| GET | `/api/v1/schema-fields/{entity_type}/{entity_id}/{field_id}/revisions` | current session | authorized immutable value history for one field |
| GET | `/api/v1/documents/{entity_type}/{entity_id}` | current session | active current document template LAYOUT for a record the session may read; never values, 404 for an unknown type / another tenant / a role that may not read the record |
| POST | `/api/v1/document-generations` | owner session + CSRF + idempotency + `APP_DOCUMENT_GENERATION_ENABLED=true` | snapshot authorized inputs, persist intent/attempt, store deterministic immutable HTML in R2, require exact HEAD readback, and optionally atomically bind a server-minted derived attachment receipt |
| GET | `/api/v1/document-generations/{receipt_id}` | owner session | reconstruct one browser-safe immutable generation receipt, its durable settled reconciliation outcome, and exact input versions |
| POST | `/api/v1/document-generations/{generation_attempt_id}/reconcile` | owner session + CSRF + idempotency + enabled generation | perform server-side R2 HEAD reconciliation; no browser-supplied provider evidence or implicit retry |
| GET | `/api/v1/today` | session cookie | assigned active jobs for field; broader active jobs for owner/ops |
| GET | `/api/v1/jobs/:id` | session cookie | job, gate locks, and proof stream; an unassigned field lookup is indistinguishable from missing |
| GET | `/api/v1/owner/now` | owner/ops session | exception-first blocked gate, incident, finance, lead, and material read model |
| GET | `/api/v1/owner/measurement-intake-exceptions?limit=50` | owner/ops session | compact unmatched/retryable measurement queue; browser projection excludes R2 keys, hashes, leases, Frappe ids, and provider error text, while safe Google Drive links and a server-derived manual/scheduled/blocked/exhausted recovery disposition remain available for operator review |
| GET | `/api/v1/sales` | owner/ops session | bounded office Lead Envelope, estimate, quote, and communication-record review DTO; raw payloads and commercial-policy internals are excluded |
| GET | `/api/v1/estimator/jobs/:id` | owner/ops session | bounded source-review DTO: server-recomputed retained geometry, persisted metric/takeoff source refs, explicit measurement-to-takeoff and quote-to-proposal linkage, captured quote snapshot/revision comparison, and quote-attributed change-order review; no raw key/XML/report URL/evidence JSON or mutation path |
| GET | `/api/v1/approvals` | owner/ops session | browser-safe approval inbox with server-issued capability names; never returns receipts, raw args, or broker output |
| GET | `/api/v1/approvals/:id` | owner/ops session | one current approval DTO; re-evaluates pending expiry |
| POST | `/api/v1/approvals/lead-triage` | owner/ops session + CSRF + idempotency key | fixed local-triage preparation path; not a generic tool proxy |
| POST | `/api/v1/approvals/:id/approve` | configured owner + CSRF + recent session + idempotency key | compare-and-set decision through the private broker; transport ambiguity becomes `execution_uncertain`, never a retry |
| POST | `/api/v1/approvals/:id/reject` | configured owner + CSRF + recent session + idempotency key | durable rejection; does not invoke the broker |
| POST | `/api/v1/approvals/:id/reconcile` | configured owner + CSRF + recent session | append reconciliation evidence/outcome to an uncertain request; never reopens or retries the write |
| GET | `/api/v1/quote-revision-approvals` | owner/ops session | separate browser-safe queue for append-only Customer Quote Draft shells; never mixed with lead triage |
| GET | `/api/v1/quote-revision-approvals/:id` | owner/ops session | one safe quote-revision approval DTO; pending expiry is re-evaluated before return |
| POST | `/api/v1/quote-revision-approvals` | owner/ops session + CSRF + idempotency key | fixed estimator-assistant preparation path; source/job/reason are receipt-bound, target/version broker-derived |
| POST | `/api/v1/quote-revision-approvals/:id/approve` | configured owner + CSRF + recent session + idempotency key | distinct broker/ledger execution; ambiguity is reconciliation-only and never replays the Frappe write |
| POST | `/api/v1/quote-revision-approvals/:id/reject` | configured owner + CSRF + recent session + idempotency key | durable rejection; does not invoke either broker |
| POST | `/api/v1/quote-revision-approvals/:id/reconcile` | configured owner + CSRF + recent session | one immutable reconciliation append for an uncertain quote-revision execution |
| GET | `/api/v1/proposal-publication-approvals` | owner/ops session | separate browser-safe queue for Draft -> Approved Proposal Evidence Pack publication; optional `roof_job_id` filter |
| GET | `/api/v1/proposal-publication-approvals/:id` | owner/ops session | one safe publication approval DTO; pending expiry is re-evaluated before return |
| POST | `/api/v1/proposal-publication-approvals` | owner/ops session + CSRF + idempotency key | fixed owner-operator preparation path; only the job and pack are caller-supplied, the quote anchor and preview are broker-derived |
| POST | `/api/v1/proposal-publication-approvals/:id/approve` | configured owner + CSRF + recent session + idempotency key | releases the proposal to a customer link through its own broker; ambiguity is reconciliation-only and never republishes |
| POST | `/api/v1/proposal-publication-approvals/:id/reject` | configured owner + CSRF + recent session + idempotency key | durable rejection of a prepared publication; invokes no broker |
| POST | `/api/v1/proposal-publication-approvals/:id/reconcile` | configured owner + CSRF + recent session | one immutable reconciliation append for an uncertain publication |

### PWA auth and tenant boundary

This slice is intentionally **one tenant + one Worker deployment**. `APP_TENANT_ID` is the
deployment/session isolation boundary: provisioning rejects any other tenant, every session joins
back to an active user on that tenant, and the BFF rejects a session whose tenant differs. If a
Frappe compatibility site is enabled, it is dedicated to that same tenant. A reseller tenant gets a
separate deployment and credential set until record-level tenant isolation is proven.
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

Bootstrap only the first owner with `POST /admin/app-users/bootstrap` when
`APP_FIRST_OWNER_BOOTSTRAP_ENABLED=true` and this tenant has zero app users:

```json
{
  "tenant_id": "ironwrap",
  "email": "owner@example.com",
  "display_name": "Office Owner"
}
```

Every later provisioning change uses `POST /api/v1/admin/app-users` from an authenticated
office session with `X-CSRF-Token`. That steady-state body accepts `role`, compatibility
`frappe_user_id`, and `active`; only a still-enabled Frappe assignment seam requires that legacy
identity. Re-send
the record with `active:false` to revoke that user's sessions and open link. The bearer bootstrap
route never upserts, never accepts a client actor field, and returns a stable denial after the
first tenant user exists. The checked-in top-level/staging configuration enables the BFF, but that
is configured intent only. A named environment must have its required migration state, app build,
Gmail delegation, `APP_AUTH_PEPPER`, origin metadata, and any enabled compatibility credentials;
otherwise override the flag to false or block deployment. `/ready` fails closed on missing or
malformed enabled dependencies.

`APP_AUTH_PEPPER` is a Worker secret with at least 32 random characters. Production accepts only
HTTPS origins. `APP_ALLOW_INSECURE_LOCAL=true` permits explicit localhost HTTP origins for local
development only. `APP_PUBLIC_ORIGIN` must be in the exact comma-separated origin allowlist.
There is never a wildcard credentialed CORS response.

Document generation is a separate default-off capability. Keep
`APP_DOCUMENT_GENERATION_ENABLED=false` until the named Worker has the intended `RAW` binding and
the universal effect ledger is enabled. Activation does not prove runtime success: preserve the
generation/effect/receipt IDs and exact R2 HEAD evidence from a controlled reference execution.

### Public instant-estimate activation

Leave `PUBLIC_ESTIMATE_ENABLED=false` until every control below is set. When enabled, `/ready`
fails closed unless the exact browser origin, tenant brand allowlist, consent jurisdiction,
Turnstile site/secret pair, HMAC rate-limit pepper, numeric rate limits, and the exact disabled range catalogue `[]` are present. `[]` accepts a
review-required lead and materializes its price-free native operating record; this public path never
returns or persists public pricing. A missing or non-empty rule set disables the public endpoint.
`OPERATING_AUTOMATION_USER` names the deterministic non-human actor recorded on native consent and
production-gate evidence.

```text
PUBLIC_ESTIMATE_ENABLED=true
PUBLIC_ESTIMATE_ALLOWED_ORIGINS=https://<the PWA/Worker origin>
PUBLIC_ESTIMATE_ALLOWED_BRANDS=ironwrap,iroof
PUBLIC_ESTIMATE_CONSENT_JURISDICTION="Alberta, Canada"
PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY=<public Turnstile site key>
PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS=900
PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX=12
PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX=3
PUBLIC_ESTIMATE_RANGE_RULES_JSON=[]
OPERATING_AUTOMATION_USER=ironwrap-worker
```

`PUBLIC_ESTIMATE_ALLOWED_ORIGINS` controls browser CORS to this Worker only. It is deliberately
separate from any website iframe `frame-ancestors` policy: configure each surface explicitly; do
not add an iframe parent merely to the Worker CORS allowlist. The browser and Worker never
calculate or return a price from this intake path.

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

### Quote-revision approval broker (optional, separate authority)

The append-only Customer Quote revision command is **not** a second route on
the lead-triage broker. After migration `0017`, enable it only with a separate
loopback service, HMAC secret, key id, port, and estimator-assistant MCP
runtime. The Worker needs only these non-secret values plus one secret:

```text
APP_QUOTE_REVISION_BROKER_URL=https://<private-quote-revision-broker-origin>
APP_QUOTE_REVISION_BROKER_KEY_ID=quote-revision-v1
APP_QUOTE_REVISION_BROKER_TIMEOUT_MS=15000
APP_QUOTE_REVISION_EXECUTION_LEASE_SECONDS=45
APP_FACET_QUOTE_REVISION_PREPARE_ENABLED=false
QUOTE_REVISION_BROKER_SHARED_SECRET=<different 32+-byte Worker-to-broker secret>
```

Use [`deploy/quote-revision-approval-broker.service.example`](../deploy/quote-revision-approval-broker.service.example)
with the dedicated host-only
[`deploy/quote-revision-approval-broker.env.example`](../deploy/quote-revision-approval-broker.env.example).
That process binds `HERMES_AGENT_ROLE=estimator-assistant` and exposes only
`/v1/quote-revision/preview` and `/v1/quote-revision/execute`.

Its D1 ledger stores a redacted preview (source identity/version/status/modified,
empty Draft target/version/supersedes, and correction reason) plus a one-way
digest of the full receipt-bound dry run. It never stores a price, tax, payment,
scope, customer-facing term, acceptance, or approval receipt in the browser
projection. The broker re-runs the full dry run immediately before it signs;
source drift, quote-version drift, or a deterministic target collision fails
before the write. An invoked-write transport failure is terminal
`execution_uncertain`, not an automatic retry.

### Proposal-publication approval broker (optional, separate authority)

Publishing a Proposal Evidence Pack is the one command that makes quote terms
customer-visible on an issued portal link, so it is **not** a second route on any
existing broker. After migration `0068`, enable it only with a separate loopback
service, HMAC secret, key id, port, and owner-operator MCP runtime, and only with
its own capability flag on. The Worker needs these non-secret values plus one
secret:

```text
APP_PROPOSAL_PUBLICATION_ENABLED=false
APP_PROPOSAL_PUBLICATION_BROKER_URL=https://<private-proposal-publication-broker-origin>
APP_PROPOSAL_PUBLICATION_BROKER_KEY_ID=proposal-publication-v1
APP_PROPOSAL_PUBLICATION_BROKER_TIMEOUT_MS=15000
APP_PROPOSAL_PUBLICATION_EXECUTION_LEASE_SECONDS=45
PROPOSAL_PUBLICATION_BROKER_SHARED_SECRET=<different 32+-byte Worker-to-broker secret>
```

Use [`deploy/proposal-publication-approval-broker.service.example`](../deploy/proposal-publication-approval-broker.service.example)
with the dedicated host-only
[`deploy/proposal-publication-approval-broker.env.example`](../deploy/proposal-publication-approval-broker.env.example).
That process binds `HERMES_AGENT_ROLE=owner-operator` and exposes only
`/v1/proposal-publication/preview` and `/v1/proposal-publication/execute`.

The route is the second door onto the same bounded operation the Owner Operator
MCP command performs, not a lighter one: the broker re-runs
`dry_run_publish_proposal_evidence_pack` immediately before signing, so a pack
that left Draft, changed its quote anchor, or changed its job fails before the
write; Frappe's `publish_proposal_evidence_pack` still requires the Approved
Hermes Run, the signed approval receipt, the Draft state, and both record
anchors. Publication changes only the pack's status and approval facts: it
issues no portal link, sends no message, renders no PDF, records no acceptance,
and does not touch the quote.

Its D1 ledger stores a redacted preview (pack identity, job, quote anchor,
Draft-to-Approved transition, and the three "did not happen" facts) plus a
one-way digest of the full receipt-bound dry run. The approver identity, the
receipts, the raw write arguments, and the private digests never reach the
browser projection. A partial unique index permits exactly one live intent per
pack, and an invoked-write transport failure is terminal `execution_uncertain`,
never an automatic retry.

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
due-date, next-action, or required-proof data. Remaining Frappe compatibility requests are GET-only
and limited to the hard-coded DocType, field, filter, and row allowlists in `frappe-read.ts`. Where
the legacy assignment seam is still used, the Worker rechecks the returned row instead of trusting
only the upstream filter. Native D1 read models remain authoritative.

Point website forms, GBP, and approved voice/voicemail handoffs at `/ingest/:source`
(website → `/ingest/website`, voice/voicemail → `/ingest/phone`, etc.). Feed the daily
independent counts (Twilio call logs, form-provider/Cloudflare logs, GBP) via
`/admin/source-count` so reconciliation can detect a lead that never reached the bus.
Every Worker-generated API/admin/ingest/webhook response carries no-store (the session endpoint is
explicitly `private, no-store`), content/type/frame/referrer/permissions/HSTS hardening, and matching
`X-Request-Id` / `X-Correlation-Id` headers. Static PWA assets are served separately by Cloudflare's
asset binding and remain cacheable. A safe caller-supplied correlation id is preserved; otherwise
the Worker generates one.

### Facet design-event receipt contract

The checked-in top-level/staging configuration enables `FACET_DESIGN_INGEST_ENABLED`; this is
configured intent only. Override it to false or block deployment until
`FACET_DESIGN_INGEST_HMAC_KEY` and an exact `FACET_DESIGN_INGEST_TENANT_MAP_JSON` source-to-local
allowlist are independently configured and read back in the named environment.
V2 bindings must also list the allowed local brands, for example
`{"facet-production":{"tenant_id":"ironwrap","brand_ids":["ironwrap","iroof"]}}`. HMAC proves
the Facet deployment; it does not authorize arbitrary Facet tenants or brands.

The governed producer sends `facet.design.customer_approved.v2` / schema `2` with the base fields
`event_id`, `occurred_at`, `tenant_id`, `facet_project_id`, `design_revision`, and
`frozen_evidence`, plus exact `brand_id`, `approval_actor_type:"customer_capability"`, a lowercase
SHA-256 `capability_fingerprint`, and `identity_assurance:"bearer_capability_only"`.
`frozen_evidence` contains only `design` and `approval`; approval contains only `approved_at`
(equal to `occurred_at`) and nullable `client_revision`. Customer identity, address, contact,
pricing, share tokens, and commercial terms are rejected. `design.brandId` must equal `brand_id`,
and `design_revision` must be exactly
`{id:"facet-json-v1:${sha256(canonicalJson(frozen_evidence.design))}",sha256:"…"}`. The legacy
`facet.design.approved.v1` / schema `1` shape remains evidence-only with
`provenance.status:"provenance_unknown"`; it cannot enter the v2 association ledger.

The headers are `X-IronWrap-Event-Id`, `X-IronWrap-Event-Timestamp` (13-digit Unix milliseconds,
within five minutes), `X-IronWrap-Event-Nonce` (32–128 base64url characters), and
`X-IronWrap-Event-Signature` (unpadded base64url HMAC-SHA256). Sign exactly
`${timestamp}.${nonce}.${sha256(rawBody)}`; the header event id must equal the JSON event id.
The JSON `tenant_id` is a Facet source tenant: it must be an exact map key whose configured value
equals `APP_TENANT_ID`. Missing, malformed, unknown, or mismatched mappings fail before R2/D1;
the D1 receipt persists only the mapped local tenant. The Worker records only hashes and anchors in
D1 after immutable R2 storage. A first `202` and fresh-nonce idempotent `200` return the durable
`accepted`, `event_id`, `status:"received"`, `raw_sha256`, `frozen_evidence_sha256`, and
`design_revision:{id,sha256}` anchors plus explicit provenance (the latter also has
`idempotent_replay:true`). Reusing a nonce is rejected. V2 proves only exercise of the bearer
capability; it is not proof of distinct customer identity, informed consent, contract acceptance,
or commercial authority.

### Facet-to-Frappe review projection

The canonical compatibility flag is `FACET_DESIGN_FRAPPE_PROJECTION_ENABLED`; it is default-off
(`false`) in every checked-in environment. It stays `false` until a dedicated Frappe user has only the
`IronWrap Facet Design Projection Service` role, its user email and separate HMAC are configured
in the Frappe site, and its distinct API key, API secret, and HMAC are stored as Worker secrets.
Never reuse the ingress HMAC, broad ERP identity, or customer-acceptance identity.

The adapter consumes only an already durable native D1 design head whose project and producer
identity links, launch intent, approved quote, proposal revision, publication, and acceptance
anchors still resolve exactly. Missing or drifted authority is recorded in the effect/exception
ledger before dispatch; deployment JSON is not association or commercial authority.

For `approved` and `corrected` events, the endpoint creates a blank, non-customer-safe `Draft`
Customer Quote. On every chain advance it marks the predecessor projected quote `Rejected`; only
an active decision receives a replacement Draft. It also creates one deterministic Evidence Item
and one Integration Reconciliation record (`Pending` for active decisions and `Superseded` for
terminal decisions). The compatibility draft supplies no price, line items, taxes, payment schedule,
or commercial terms, and it does not read R2 on this path. An estimator must rebuild and reconcile
all commercial content before use. Frappe returns an HMAC-signed receipt binding the exact request,
locked job/brand/current quote, provenance, immutable hashes, and deterministic record IDs. The
Worker treats any unsigned, malformed, or mismatched `200` as unknown, opens manual reconciliation,
and never redispatches it without explicit operator reconciliation. Before enabling the flag, run a disposable live proof for success,
missing/mismatched association, exact replay, and Frappe refusal, then retain only redacted IDs and
release evidence.

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

## External prerequisites and evidence seams

1. **JobNimbus API** (`src/jobnimbus.ts`) — record types and statuses come from the `JN_*`
   configuration. Before enabling the bridge, prove authentication, response shape, configured
   record types, search behavior, field mapping, create/read/archive, and retry idempotency against
   the exact account. Store dated evidence outside this README. Idempotency uses the `bus:<id>` tag.
2. **Google Workspace/Drive** — Gmail send and Shared Drive filing use
   `GOOGLE_SERVICE_ACCOUNT_JSON` with domain-wide delegation. Validate the configured sender,
   mailbox authority, folder permissions, and retention against the target tenant.
3. **SMS / carrier registration** — the Worker does not send prospect SMS. Any external SMS
   bridge requires current carrier/consent evidence and separate delivery reconciliation.
4. **QuickBooks webhook** — the receiver accepts only the configured company realm, anchors a
   signed raw receipt plus one durable outbox row per supported identity, and projects bounded
   Pending reconciliation work through a distinct least-privilege Frappe issuer. Frappe failures
   remain leased/retryable with capped backoff and escalate after five attempts; only the documented
   immutable identity conflict is terminal. This is not accounting authority: amounts, payment,
   posting, and reconciliation facts require authenticated QuickBooks read-back.
5. **Frappe compatibility projection** — configured true in the checked-in top-level/staging
   profiles and false in development; none of those values is live proof. Before treating
   `ERPNEXT_ENABLED=true` as ready, apply
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
   Measurement sync creates a linked Evidence Item for the raw/report artifact. An unmatched
   measurement is intentionally unlinked and `Needs Review`, so dispatch can attach it to the
   correct Roof Job instead of accepting a false match. Photo sync creates one photo Evidence
   Item per submitted Jotform photo, links Drive file ids/URLs when available, and
   creates a Field Check-in summary row for the submission. QuickBooks webhook
   sync creates only Pending reconciliation work and may create immutable Payment Milestone
   event rows when `qb_invoice_ref` matches; it never asserts provider accounting truth.
   Roof Job sync also creates missing initial production gate rows without resetting
   existing gate state. Frappe is a compatibility consumer/projection, not raw intake or native
   operating authority.

## Operating authority

This is owned product code. Monitoring, incident response, recovery, and rotation follow
[`docs/OPERATIONS-RUNBOOK.md`](../docs/OPERATIONS-RUNBOOK.md). A bridge may remain only until its
owned replacement is implemented, reconciled, accepted, and proven with rollback evidence. The
binding intake, evidence, and side-effect rules are in
[`docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md`](../docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md).
The system boundary and current/target status are in
[`docs/AI-NATIVE-ARCHITECTURE.md`](../docs/AI-NATIVE-ARCHITECTURE.md).
