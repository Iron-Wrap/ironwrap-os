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

Failed primary lead, measurement, and Newo deliveries back off by 10, 20, 40, 80, then
120 seconds using Cloudflare transport attempts. The five-retry limits and DLQ behavior
remain unchanged. See [Stuck Envelopes](../docs/OPERATIONS-RUNBOOK.md#stuck-envelopes)
for durable-counter differences, sweep recovery, and the measurement lease caveat.

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
        │ initial delivery + 5 retries exhausted → DLQ → dead_letter table + owner email
        ▼
  cron */5  → retry sweep (re-drive anything stuck in pending_jn_push)
  cron 0 14 → reconcile: independent source counts vs landed; daily digest = heartbeat

governed pipeline stage automation (disabled by default)
  committed transition → immutable outbox binding → bounded cron */5 drain
  owner-only rule revisions + deployment-owned recipient refs → universal effect runtime/Gmail send receipt

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

Field linear observations use the existing multipart `field_checkin` outbox route:
`POST /api/v1/jobs/:id/check-ins` (or its scoped work-object equivalent). Keep the existing
metadata, capture times, assignment and any Work Package/evidence/correction binding. Set
`payload.proof_slot` to `Measurement` and add this optional object:

```json
{"measurement":{"feet":42,"inches":7,"eighths":3,"area_label":"South eave"}}
```

All three numbers are integers: feet 0–100000, inches 0–11, eighths 0–7, with a nonzero total.
The Worker normalizes label whitespace and Unicode, bounds the label to 120 characters, and
stores `total_eighth_inches = feet * 96 + inches * 8 + eighths` (4091 for this reading).
Migration `0144_field_structured_measurements.sql` adds immutable facts to `field_actions`,
including the authenticated paired device and correction lineage. Hashes and immutable R2
manifests include the structured input and device. Omitted/null measurements preserve the legacy
request hash shape; historical free-text notes are never parsed or backfilled.

The verified POST receipt returns `measurement` with `total_eighth_inches`. Job, job-history and
scoped work-object reads expose `field_measurements` and `field_measurements_more`; only verified,
manifested captures appear, newest first, bounded to 100 items. Each item retains its measurement,
check-in/action/assignment identity, actor, device, capture time, predecessor/successor and any
original Work Package binding. `recorded_by_name` is the current display name of the user who
recorded it, or null when that user is unavailable. Each live read item has its own
`allowed_actions` and `correction_target`. The only advertised action is
`field.measurement.correct`, for the assigned active field actor's own unsuperseded reading.
For a generic reading, the target contains `{correction_of: checkin_id}`. For typed evidence it
contains `{evidence_correction_of, evidence_item_correction_of}` only when the current Work Package
ledger has one eligible evidence item; the write checks all authority again. A correction is a new
action with that target and a reason. The D1 guard binds the predecessor's exact assignment,
job, actor, parent/context and Work Package version/release/slot; reassignment cannot silently
rewrite its provenance. Office history has no correction action or target. A Blocked package
still permits safe observations and append-only corrections under the existing field authority.
Neither operation restarts work, clears a hold or gate, accepts evidence, or promotes a reading
to design/cut truth.
`GET /api/v1/jobs/:id/field-measurements?cursor=<opaque>` continues the history beyond 100
without repeating rows when newer captures arrive. It returns the standard read envelope plus
`{items, page_size: 100, next_cursor: string|null}`. Omit `cursor` for the first page; follow
`next_cursor` until null. The route is private and no-store, requires office job-read authority
or the crew member's current assignment on a live job, and refuses an invalid cursor with 400.
Its envelope grants no action in `allowed_actions`; each item carries its own current correction
hint. An unavailable native paginated read returns 502 rather than an empty history. An unavailable
embedded read leaves the live job, work-object or office history available with an empty
`field_measurements` list, `field_measurements_more: false` and
`field_measurements.native_unavailable` in `stale_fields`.
Neither storage verification nor these observations approve geometry, calibration, takeoff,
physical acceptance or a commercial measurement revision. The PWA consumer must retain and render
the new read fields and enqueue the structured object before the joined workflow is complete.

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
| Fail-closed readiness + operator status | `/ready` probes D1/schema/bindings/config, plus a per-cron liveness verdict on `?scope=ops`; `/admin/status` reports heartbeat, queue/dead-letter/Frappe/audit/QB signals, and per-cron tick freshness (evidence only) |
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
| GET | `/ready` | — | detailed public readiness booleans; `?scope=ops` additionally gates on both crons having ticked recently (`*/5` fresh ≤10 min, daily fresh ≤26 h; a never-ticked row gets a per-cron startup grace — the 20-min deploy stretch plus that cron's own window, so 30 min and 26 h 20 min); never returns secret values |
| GET | `/admin/status?audit_limit=20` | `Bearer ADMIN_TOKEN` | latest heartbeat, open dead letters, pending/stuck/provider/projection/replay-ledger counts, 24h audit failures, latest QB receipt freshness, and per-cron tick freshness (`crons`, evidence only — never moves `status`) |
| POST | `/admin/source-count` | `Bearer ADMIN_TOKEN` | record `{day?,channel,count}`; day is a real UTC `YYYY-MM-DD`, channel is an ingest source, count is an integer from 0–1,000,000 |
| POST | `/admin/replay` | `Bearer ADMIN_TOKEN` | targeted or explicitly confirmed bulk dead-letter replay; both require non-secret human-approval evidence (below) |
| GET | `/admin/envelopes?limit=50` | `Bearer ADMIN_TOKEN` | read recent bus envelopes for owner/Hermes diagnostics |
| GET | `/admin/envelope/:id` | `Bearer ADMIN_TOKEN` | read one canonical bus envelope |
| GET | `/admin/dead-letter?limit=50` | `Bearer ADMIN_TOKEN` | read unrecovered dead-letter rows |
| GET | `/admin/measurements/exceptions?limit=50` | `Bearer ADMIN_TOKEN` | read unmatched or retryable measurement receipts without idempotency/payload hash fields or lease tokens; opaque receipt ids and raw pointers remain available for review. Retryable and expired-lease receipts re-drive sequentially from verified R2 raw sources with bounded backoff |
| POST | `/admin/app-users/bootstrap` | `Bearer ADMIN_TOKEN` + `APP_FIRST_OWNER_BOOTSTRAP_ENABLED=true` | one-time bootstrap that creates the first owner only when this tenant has zero app users |
| GET | `/api/v1/agents/signals?after&limit` | `Bearer AGENT_HOST_TOKEN` | AI team signals after a cursor, for the agent host ([`agent-host`](../agent-host/README.md)); dark (404) while the token is unset |
| POST | `/api/v1/agents/runs` | `Bearer AGENT_HOST_TOKEN` | open or resume the coordination run for one signal and `host_run_key`; returns the goal, context snapshot and the run's tools, with the routing hints: the reviewed run and its model family for an audit, the specialist's current passed qualifications (the latest row per provider, model, effort and release) and `close_model: 3`; 409 once that run is closed. A run past its 10-minute wall time closes `ceiling_reached` with its abstention receipt (naming nobody for a question or an owner report) and answers 409 `run_expired`; the five-minute cron closes any other such run |
| GET | `/api/v1/agents/runs/:id/tools` | `Bearer AGENT_HOST_TOKEN` | the run's tools: owned, registered catalog actions with strict argument schemas |
| POST | `/api/v1/agents/runs/:id/steps` | `Bearer AGENT_HOST_TOKEN` | propose one step `{action_id, args, citations, step_key}`; deterministic policy records it as a receipt (done, drafted, asks first, escalated, abstained or denied); a repeated `step_key` answers once |
| POST | `/api/v1/agents/runs/:id/close` | `Bearer AGENT_HOST_TOKEN` | close the run with its outcome; an abstaining or escalating run always leaves a receipt that names a person. A v3 model block's live or shadow output stands only on a qualification it names that is this specialist's, passed, for the close's provider, model, effort and release, with no later failure for its key; otherwise the run abstains `no_qualified_route`. A run class this Worker's `AGENT_DATA_CLASS` cannot hold is refused (422 `run_class_refused`): `synthetic` only on a `synthetic` Worker, `eval_history` never |
| POST | `/api/v1/agents/host/heartbeat` | `Bearer AGENT_HOST_TOKEN` | the host's readiness, alerts and backlog |
| GET | `/api/v1/agent-team/receipts?view=needs_you\|doing\|done` | owner or ops session | the team's receipts in Now's three lanes |
| GET | `/api/v1/agent-team/hosts` | owner or ops session | the agent hosts' last heartbeat and alerts |
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
| POST | `/api/v1/evidence-uploads` | session + CSRF + Origin + Idempotency-Key; Field requires paired-device proof | bounded file/photo upload, Worker-computed binary SHA256, immutable R2 readback then D1 receipt; see file evidence contract below |
| GET | `/api/v1/privacy/evidence-uploads[?limit=20&cursor=evu_...]` | current owner session | tenant-scoped receipt metadata inventory, at most 50 per page; private, no-store |
| GET | `/api/v1/privacy/evidence-uploads/markers[?limit=20&cursor=...]` | current owner session | tenant-scoped independent privacy-marker inventory, including markers absent from a restored D1; at most 50 per page, private, no-store |
| GET | `/api/v1/privacy/evidence-uploads/{receipt_id}/audit` | current owner session | accepted-business-link and R2 byte-integrity readback for one tenant receipt; private, no-store |
| POST | `/api/v1/privacy/evidence-uploads/{receipt_id}/holds` | current owner + CSRF | create an idempotent legal hold on one receipt; exact body `{hold_id,reason}` |
| POST | `/api/v1/privacy/evidence-uploads/{receipt_id}/holds/{hold_id}/release` | current owner + CSRF | release one hold with an audited reason; exact body `{reason}` |
| POST | `/api/v1/privacy/evidence-uploads/{receipt_id}/destruction` | current owner + CSRF | manually dispose of an unlinked upload with an exact decision and R2 negative readback; see policy limits below |
| POST | `/api/v1/privacy/evidence-uploads/{receipt_id}/reconciliation` | current owner + CSRF | record a new marker-bound decision after an old D1 restore lost the original decision text; exact retry also re-verifies restored RAW bytes |
| GET | `/api/v1/today` | session cookie | assigned active jobs for field; broader active jobs for owner/ops |
| GET | `/api/v1/jobs/:id` | session cookie | job, gate locks, and proof stream; an unassigned field lookup is indistinguishable from missing |
| GET | `/api/v1/owner/now` | owner/ops session | exception-first blocked gate, incident, finance, lead, and material read model |
| GET | `/api/v1/owner/measurement-intake-exceptions?limit=50` | owner/ops session | compact unmatched/retryable measurement queue; browser projection excludes R2 keys, hashes, leases, Frappe ids, and provider error text, while safe Google Drive links and a server-derived manual/scheduled/blocked/exhausted recovery disposition remain available for operator review |
| GET | `/api/v1/sales` | owner/ops session | bounded office Lead Envelope, estimate, quote, and communication-record review DTO; raw payloads and commercial-policy internals are excluded |
| GET | `/api/v1/estimator/jobs/:id` | owner/ops session | bounded source-review DTO: server-recomputed retained geometry, persisted metric/takeoff source refs, explicit measurement-to-takeoff and quote-to-proposal linkage, captured quote snapshot/revision comparison, and quote-attributed change-order review; no raw key/XML/report URL/evidence JSON or mutation path |
| GET | `/api/v1/pricing/catalog` | session with `estimator:read` | private tenant catalog history, active revision and server-issued allowed actions; `revision_cursor` and `activation_before` page immutable history |
| POST | `/api/v1/pricing/catalog/revisions` | owner/ops session with `pricing:manage`, CSRF and Idempotency-Key | save a bounded candidate snapshot; `source: "environment"` reads configured JSON as a draft only |
| POST | `/api/v1/pricing/catalog/activations` | owner/ops session with `pricing:manage`, CSRF and Idempotency-Key | approve a reviewed revision by exact SHA-256 and expected head version; one immutable receipt advances the tenant head |

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

The pricing catalog is disabled in every checked-in environment by
`APP_PRICING_CATALOG_ENABLED=false`; its API returns 404 while disabled. Native
imports then retain the existing `ESTIMATOR_PRICE_LIST_JSON` behavior. Enable the
catalog only after its Figma-derived owner interface and QA cutover are accepted.
When enabled, a new import uses only the active, reviewed D1 catalog revision;
environment JSON is a candidate source for an explicit owner draft, never an
implicit approval. Previously imported estimates continue to read their own
verified, frozen pricing snapshot across activation changes and flag rollback.
Catalog reads and new imports refuse a restored head that is missing or behind retained
activation history. An internal catalog approval does not verify supplier availability or an
external price, publish a quote, record customer consent, or authorize a purchase.

### Private measurement report contract

Source-present in `src/job-measurement-report-api.ts`, its store and read model, and D1 migration
`0146_job_measurement_reports.sql`. Authenticated owner and operations staff can upload an exact
PDF, recover an interrupted R2 write, record candidate facts, and review those facts through
immutable receipts. Sales staff can read the report without adjudicating it. Backup and restore
inventory includes the report bytes' D1 links, events, heads, receipts, indexes, and guards.
Report reads and new review commands refuse retained history with a missing or older head.
Transcription and review retain their own report and job lineage; neither promotes report
observations or C3 field observations to accepted geometry, cut truth, or quote approval.
The strict response fixture lives in `test/` until the Figma-derived screen defines its app
consumer. Focused local tests use synthetic PDF bytes and controlled D1/R2 adapters; hosted CI, deployed
storage recovery, final Figma-derived UI, and business acceptance remain open.

The owner-only `GET /api/v1/privacy/measurement-reports` lists governed PDFs across jobs with
tenant-scoped keyset paging (`before`, `limit` 1–50). `GET
/api/v1/privacy/measurement-reports/:report_id/audit` returns the immutable file metadata and
checks the exact R2 bytes, distinguishing intact, missing, mismatched and unavailable objects.
It also distinguishes an interrupted upload with staged bytes from one with no bytes. Both
responses are private and no-store. This is a read-only inventory, not a retention or disposal
workflow. The older OCR intake's content-addressed `raw/measurement-reports/` objects are a
separate class whose tenant and reference scope must be reconciled before subject disposal.
`current_job_customer_id` is a locator for review, not proof of whose data a PDF contains.

The same owner-only boundary offers `GET /api/v1/privacy/measurement-intakes` with tenant-scoped
keyset paging and `GET /api/v1/privacy/measurement-intakes/:receipt_id/audit`. The detail verifies
the exact RAW intake, fetched report and OCR-result bytes against their recorded SHA-256 values,
and locates recorded Drive/Frappe copies. Migration `0103` added a nullable tenant ID to intake
receipts. The route excludes old receipts that still have no attributable tenant; an operator
must reconcile those separately without guessing an owner. A report object can be referenced by
several receipts, including across tenants, because its key is content-addressed. These reads
authorize no purge and do not prove a PDF's subject from the current job association.

### File evidence contract

Source-present in `src/evidence-uploads.ts`, `src/inventory-control-api.ts`,
`src/service-cases.ts`, `src/service-case-store.ts`, and `src/safety-api.ts`; D1 migration
`0139_evidence_upload_receipts.sql` and `0141_evidence_privacy_disposition.sql`. Focused local checks are in `test/evidence-uploads.test.ts`,
`test/inventory-control-api.test.ts`, `test/service-cases-api.test.ts`, and `test/app-auth.test.ts`.
These checks use synthetic files and controlled D1/R2 adapters; they do not prove deployment,
provider configuration, real-device operation, or accepted UI behavior.

The owner audit routes inventory receipts without returning file bytes or R2 keys. The list
returns `{version:1,receipts:[{receipt_id,actor_user_id,purpose,target_id,action,operation_id,file_name,content_type,byte_size,created_at,disposition_state}],next_cursor}`.
The detail returns `{version:1,receipt_id,purpose,target_id,actor_user_id,file_name,content_type,byte_size,created_at,business_linked,domain_record_linked,disposition_state,active_hold_count,external_marker_present,external_marker_decision_id,restore_recheck_pending,object_status,recent_events}`.
`business_linked` requires a matching receipt reference and digest in an applied stock command,
submitted corrective action, or accepted service case transition. A corrective action's persisted
manifest digest also counts when its reference list is legacy or incomplete. A manifest by itself
is not a business link. `domain_record_linked` is also true for a rejected stock command or a
durable service child row or case last-evidence digest without a matching transition event. A
cleanup decision must not infer
"abandoned" from `business_linked: false` alone. `object_status` is `verified`, `missing`,
`mismatch`, or `restore_reappeared` when a destroyed or quarantined receipt has bytes again. A D1 or R2 outage
returns `502` rather than an absence claim. The detail shows the latest 50 immutable privacy
events. `restore_recheck_pending` stays true when restored bytes were detected but their removal
has not settled in D1. It is an operator preview, not a complete event export.

An owner may create and release a receipt-specific hold. The only enabled disposal basis is
`manual_correction` with `policy_version: "manual-v1"`: the owner must submit exact
`{decision_id,basis,authority_ref,policy_version,reason,expected_sha256}` and the receipt must
have no durable business record. A manifest prepared before a failed or abandoned submit may
remain for audit; the D1 disposition guard checks every durable stock, corrective and service
link, while domain-write guards prevent that manifest from being consumed after disposal. A
concurrent domain write and disposition therefore have one winner in D1. The decision is
persisted before R2 deletion. A provider failure leaves a retryable `failed` disposition; the same decision ID
may retry after any new hold is released. Only a negative R2 readback marks `destroyed`.
Upload replay and domain receipt resolution refuse every pending or destroyed disposition,
including after R2 bytes reappear. The immutable receipt and privacy events remain in D1.
After a receipt exists, an exact upload replay does not recreate missing R2 bytes; the owner
audit reports the loss for recovery review instead of allowing a replay to undo disposal.
Every cold-upload attempt first inserts an exact tenant/actor/receipt/request/RAW-key write
claim in D1. The claim spans every RAW await and settles once, after that attempt can perform
no further PUT. D1 refuses disposal insert, retry or verification while any writer is unsettled,
and refuses a new writer after a disposition exists. This serializes the lifecycle decision;
it does not make D1 and R2 one transaction. A concurrent owner gets
`409 evidence_upload_write_pending`, the pending/unknown counts and an inspection link.
A rejected PUT is an unknown provider outcome, even if a later read is empty. It leaves an
unsettled `unknown` claim and returns `evidence_upload_write_outcome_unknown`; a terminated
request may leave `active`. Neither state expires or can be stolen or automatically cleared.
The current owner can inspect pending attempts, including attempts without a receipt, through
`GET /api/v1/privacy/evidence-uploads/write-claims?receipt_id={receipt_id}&limit=20&cursor={claim_id}`.
The receipt filter and cursor are optional; follow `next_cursor` until null. This endpoint is
read-only and does not authorize settlement. A hold can still be acquired while a writer is
unsettled; no upload failure performs a compensating delete of possibly held evidence.

Backups and restores must preserve all write claims and their guards, including unresolved
claims. Before enabling this lifecycle, restoring D1/RAW, or rolling schema/code back, the
runtime owner must establish an approved, verifiable quiescence procedure covering old
unclaimed Worker requests and pending provider writes. Disabling a flag, waiting, or observing
an empty object is not proof that a delayed PUT cannot finish. Do not restore an older D1
snapshot over active writers or infer that an ambiguous claim can be settled. Provisioning,
quiescence evidence and any future operator resolution contract remain separate release gates;
this implementation exposes the exception and provides no claim-clearing operation.

If R2 bytes reappear behind a destroyed receipt, the same owner decision records the detection,
deletes the bytes again, and settles only after a negative R2 `head` readback. A failed delete or
D1 settlement leaves a visible pending recheck; the exact decision retry resumes it, even when
the bytes were already removed. Immutable `reappearance_detected` and
`destruction_reverified` events keep that correction auditable. A D1 restore that discards the
disposition itself is blocked by the separate `PRIVACY_LEDGER`
R2 bucket: D1 first commits a disposition that prevents new manifests; the Worker then
creates an exact-decision marker before deleting RAW bytes. Every upload retry, receipt
resolution and owner audit consults the marker. A restored
D1 with no disposition shows `quarantined` instead of `available`, even if RAW bytes return.
The owner may replay the exact decision to recreate the D1 disposition and remove the bytes.
When the old D1 decision text cannot be recovered, the owner may POST
`/api/v1/privacy/evidence-uploads/{receipt_id}/reconciliation` with
`{decision_id,marker_decision_id,reason,expected_sha256}`. The marker decision ID names the
surviving original; the new decision ID and reason record a separate owner correction.
The new D1 `authority_ref` binds the original marker digest without claiming that the lost
reason or actor was reconstructed. A hold, manifest or durable business record still refuses
deletion. The marker is re-read before RAW deletion; a negative RAW `head` settles the new
decision. An exact retry resumes interrupted work, including re-purging bytes that reappear.
After reconciliation, repeat the same `/reconciliation` request to re-verify or re-purge;
`/destruction` cannot replay the lost original decision. A readable but changed or malformed
marker is a `409 evidence_destruction_conflict`; an unavailable R2 read is a retryable `502`.
The marker contains a tenant and receipt locator, receipt digest, R2 key, decision ID and
decision digest. It does not copy the free-text reason, authority reference or actor; its
remaining metadata still needs an approved retention and access policy. A different decision
against an old D1 snapshot is refused before it can create a conflicting D1 row. If an older
snapshot also lacks the receipt, the marker still blocks the same upload key. The owner can
enumerate the independent ledger through `GET /api/v1/privacy/evidence-uploads/markers`.
Each row reports `receipt_id`, `marker_decision_id`, `d1_receipt` (`missing`, `matches`, or
`mismatch`), `d1_disposition_state`, and `raw_object_present`. Follow `next_cursor` until null;
each page also carries `marker_entries_valid` and `marker_issues`. A malformed or missing
marker is omitted from trusted `markers`, identified in `marker_issues` by receipt ID when
available and a SHA-256 fingerprint of its R2 key, and makes `marker_entries_valid` false.
Do not interpret the valid rows as a clean restore until every page has been read and every issue
and D1/RAW mismatch is resolved. No raw R2 key is returned. A failed ledger, D1, or RAW read
still fails the page instead of claiming a clean restore; a damaged marker still blocks receipt
use and disposal.
This is a read-only inventory: an orphan marker needs an explicit receipt recovery or approved
restore procedure before reconciliation can delete restored RAW bytes. A complete, reviewed
marker inventory remains a production release gate.
If ledger creation fails, the D1 disposition keeps the receipt blocked until an exact
retry writes the marker. The Worker never deletes a privacy marker. The normal disposal path
uses R2's `If-None-Match: *` conditional create, so a competing decision cannot overwrite it.
A missing or unavailable ledger fails closed before RAW deletion.
The privacy bucket must be provisioned before deploy, excluded from old D1/RAW restore,
and included in the privacy owner's metadata-retention and access policy. Generic D1 writers,
production restore fencing and real-provider restore proof remain release gates.

The route refuses `subject_request` and `approved_retention` until identity proof, owner-approved
purpose schedules, exceptions, and backup/provider reconciliation exist. There is no automatic
retention job or global duration. This source-level manual correction path does not finish A11,
authorize production receipt enforcement, or prove the production restore path. Older D1
backups, other stores, and agent/browser artifacts still need independent policy and readback.

`APP_EVIDENCE_UPLOADS_ENABLED="true"` permits file uploads and receipt-based domain writes.
It is false in every checked-in environment. When disabled, both the upload and receipt-resolution
paths return `503 evidence_uploads_disabled` before writing R2, a manifest, or a business link.
Existing legacy evidence inputs keep their current validation and never become upload receipts.
Enable uploads in a named environment only after its privacy controls and recovery path are
approved; the UI must show a plain unavailable state while the switch is off.

`APP_EVIDENCE_RECEIPTS_REQUIRED="true"` separately requires receipts instead of legacy
evidence inputs. It remains off by default. Both switches must be true to require and accept
receipt-based evidence. With only uploads enabled, confirmed receipt IDs may be submitted and
always receive full scope and byte readback verification. Legacy stock refs still have their
actual binary R2 bytes checked. Mixing legacy fields with receipt IDs is refused in either mode.
Legacy safety and authority reference lists cannot claim the reserved `evidence-upload://`
scheme. A corrective record can name an upload receipt only when the tenant, action, target
and digest match a resolved manifest; D1 enforces this at the corrective update boundary.

Upload one selected file through `POST /api/v1/evidence-uploads`. The multipart fields are
`file`, `purpose`, `target_id`, `action`, and `operation_id` (empty for actions whose table entry
says empty). `Idempotency-Key` identifies this upload, independently of its domain operation ID.
Choose a distinct upload key for each selected file and retain it through retries. Upload keys
are 8-120 characters using letters, digits, period, underscore, colon, or hyphen, beginning with
a letter or digit. Stock operation IDs are 8-200 characters with the same character set; other
target/operation tokens are 3-200 characters. Intake operation IDs follow the upload-key rules.

| Purpose | target_id | action | operation_id | Current authorization |
|---|---|---|---|---|
| stock | Selected inventory lot | receive, reserve, release_reservation, issue_use, return, transfer, quarantine, release_quarantine, count_freeze, count_adjustment, yield, reversal | Stock command_id | Owner/Ops; Field only issue_use, return, quarantine |
| service_intake | Selected native roof_job_id, before a case exists | open | Intake request Idempotency-Key | Owner/Ops |
| service_step | Service case ID | triage, diagnose, issue_remedy, close | Empty | Owner/Ops |
| service_step | Service case ID | verify_remedy, customer_decision | Remedy ID belonging to that case | Owner/Ops |
| service_step | Service case ID | recover_cost | Empty | Owner only |
| corrective_action | Corrective action ID | submit | Empty | Current active safety actor |

Stock resolves the current source position's lot before using a receipt. Receiving/returning may
open a new position, using the selected lot. Reversal uses the first movement lot of the referenced
original command. The receipt does not supply policy, authority, stock approval, or safety release.
The command, conservation checks, current safety actor checks, and independent verifier rules
continue to decide whether a transition is permitted.

```sh
curl https://app.example.invalid/api/v1/evidence-uploads \
  -H 'Origin: https://app.example.invalid' \
  -H 'Cookie: __Host-ironwrap_session=<session-token>' \
  -H 'X-CSRF-Token: <session-csrf>' \
  -H 'Idempotency-Key: upload-stock-synthetic-01' \
  -F 'purpose=stock' -F 'target_id=lot_synthetic_1' \
  -F 'action=receive' -F 'operation_id=stock-cmd-1' \
  -F 'file=@synthetic-proof.png;type=image/png'
```

Field calls also carry `X-IronWrap-Device-Proof`. The global authentication gate rejects a missing
or mismatched proof before parsing files. The upload returns `201` with this shape; exact retries
return `200` and `result: replayed` with the original receipt:

```json
{"result":"stored","receipt":{"receipt_id":"evu_<64-lowercase-hex>","file_name":"synthetic-proof.png","content_type":"image/png","byte_size":15,"purpose":"stock","target_id":"lot_synthetic_1","action":"receive","operation_id":"stock-cmd-1"}}
```

Pass `evidence_receipt_ids: ["evu_<64-lowercase-hex>"]` in the domain JSON after upload confirmation.
One mutation may select 1-4 distinct receipts with exactly the same scope. No digest or R2 key is
needed from the browser. The actual `evu_` token is the one returned by the upload, not a token
constructed from the displayed placeholder. For stock, the rest of the intent is unchanged and
`request_fingerprint_sha256` is optional: the Worker derives the replay fingerprint from the
complete normalized intent and resolved files. A supplied compatibility fingerprint never overrides
that calculation.

For example, `POST /api/v1/inventory/commands` with a receipt uploaded for `receive`, the same
`command_id`, and the selected `lot_id`:

```json
{"command_id":"stock-cmd-1","idempotency_key":"stock-cmd-1","transition":"receive","authority_ref":"<current-authority-readback-id>","policy_ref":"policy:inventory-command","policy_version":"1","item_id":"<selected-item-id>","lot_id":"lot_synthetic_1","bin_id":"<selected-bin-id>","uom_id":"<selected-uom-id>","job_custody":"-","quantity_scaled":10,"unit_cost_minor":500,"receipt_id":"<business-receipt-id>","po_line_id":"<owned-po-line-id>","evidence_receipt_ids":["evu_<64-lowercase-hex>"]}
```

Select IDs and the current authority readback from the inventory API; the example placeholders
do not create an authority or native row. `receipt_id` is the existing business receipt reference;
`evidence_receipt_ids` contains the confirmed file-upload receipts. Other stock transitions use
their existing intent fields and the exact transition/command scope in the table above.

Service intake uses the same stable domain `Idempotency-Key` in its scope and request header:

```json
{"customer_id":"CUSTOMER-SYNTHETIC","property_key":"PROPERTY-SYNTHETIC","roof_job_id":"JOB-SYNTHETIC-1","severity":"standard","symptom_code":"synthetic_leak","reported_channel":"phone","consent_ref":"consent-synthetic","response_sla_minutes":60,"evidence_receipt_ids":["evu_<64-lowercase-hex>"]}
```

`POST /api/v1/service-cases/{case_id}/triage`:

```json
{"advisory_source":"none","final_category":"material_manufacturer","responsibility":"manufacturer","evidence_receipt_ids":["evu_<64-lowercase-hex>"]}
```

`POST /api/v1/service-cases/{case_id}/diagnoses` (receipt action `diagnose`):

```json
{"root_cause_code":"granule_loss_defect","corrective_action_code":"replace_affected_field","work_package_ref":"<owned-work-package-ref>","work_package_version":1,"warranty_reserve_cents":120000,"evidence_receipt_ids":["evu_<64-lowercase-hex>"]}
```

`POST /api/v1/service-cases/{case_id}/remedies` (receipt action `issue_remedy`):

```json
{"scheduled_start_at":"<selected-start-ISO-timestamp>","scheduled_end_at":"<selected-end-ISO-timestamp>","evidence_receipt_ids":["evu_<64-lowercase-hex>"]}
```

Replace the timestamp placeholders with user-selected operational inputs to the existing service
API; the end must follow the start.

`POST /api/v1/service-cases/{case_id}/remedies/{remedy_id}/verification`:

```json
{"outcome":"verified","cost_actual_cents":1000,"evidence_receipt_ids":["evu_<64-lowercase-hex>"]}
```

`POST /api/v1/service-cases/{case_id}/remedies/{remedy_id}/customer-decision` (receipt action
`customer_decision`, operation ID `{remedy_id}`):

```json
{"decision":"accepted","acceptance_ref":"<customer-acceptance-ref>","evidence_receipt_ids":["evu_<64-lowercase-hex>"]}
```

`POST /api/v1/service-cases/{case_id}/closure` (receipt action `close`):

```json
{"closure_reason":"remedied_accepted","evidence_receipt_ids":["evu_<64-lowercase-hex>"]}
```

`POST /api/v1/service-cases/{case_id}/cost-recovery-claims` (receipt action `recover_cost`, Owner):

```json
{"counterparty_kind":"manufacturer","counterparty_ref":"<counterparty-ref>","claim_basis_code":"material_defect","claimed_amount_cents":1000,"deadline_at":"<selected-future-ISO-timestamp>","evidence_receipt_ids":["evu_<64-lowercase-hex>"]}
```

The claim API retains its existing user-selected operational `deadline_at` validation and
diagnosis requirement. Creating a file receipt or a claim does not configure provider execution.

`POST /api/v1/safety/corrective-actions/{action_id}/evidence`:

```json
{"detail":"Synthetic control photographed","evidence_receipt_ids":["evu_<64-lowercase-hex>"]}
```

The remaining service actions retain their existing non-evidence inputs. Their previous
`evidence_digest`, `field_evidence_digest`, and `parts_manifest_digest` fields are replaced by
`evidence_receipt_ids`. Closure may omit receipts when its existing state/rule allows closure
without new evidence. Intake replaces `intake_evidence_digest`; stock replaces `evidence_refs`;
corrective submission replaces `evidence_refs_json` and `evidence_sha256`. Required receipt mode
refuses those legacy public fields, and both rollout modes refuse them beside receipt IDs.
Historical reads and internal legacy fixtures retain their original digest fields and do not gain
verified file provenance retroactively. UI adoption is required before enabling the rollout flag.

Only JPEG, PNG, WebP, HEIC, HEIF, and PDF are accepted; the declared MIME must match the file
signature. Signature checks identify a format, not its truth or physical quality. Each file must be
1 byte through 8 MiB. Actual streamed multipart bytes are capped at 8 MiB plus 16 KiB, including
requests without an accurate Content-Length. Extra or duplicate multipart fields are refused.
Field and non-office uploads share the existing 8-attempts-per-60-seconds throttle. Owner and Ops
may make 16 attempts in the same window so a four-file step and exact retries remain workable.
Every attempt, including a replay, counts; exhausted windows return `429` with `Retry-After`.
Domain JSON retains its existing body limits.

The Worker writes R2 conditionally to an immutable actor/upload-key identity, then reads the
object and hashes its binary `arrayBuffer()` before issuing a D1 receipt. D1 records tenant, actor,
role, purpose, target, action, operation ID, R2 pointer, size, MIME, name, and Worker digest.
Receipts and resolved manifests reject update/delete/replace. Resolution checks current role and
current target ownership, receipt tenant/actor/action/operation, R2 size/type/metadata, and the hash
of the actual stored bytes before starting any domain mutation. Stock retains per-file refs and
hashes; service and corrective aggregate digests identify the immutable server-derived manifest
in `evidence_upload_manifests`, which retains the exact per-file refs and binary hashes.

Recovery invariants:

- R2 failure creates no receipt. R2 success with D1 failure returns a retryable store error and leaves
  only retained raw evidence. Re-send the original upload key, scope, name, type, and bytes; the
  Worker verifies and anchors the original object without overwriting it. Changed intent conflicts,
  including while no D1 receipt exists. An R2 object alone never authorizes a domain write.
- Missing or tampered files, wrong tenant/actor/target/action/operation, duplicate receipt selections,
  and manifest-store failure refuse before stock/service/safety mutation. Exact upload retries are
  also subject to the throttle. No receipt is returned before both stores are verified.
- Receipt-based intake IDs are derived from tenant, actor, and domain Idempotency-Key. Exact retries, including
  concurrent first requests and retries of an originally linked duplicate, return the same case
  with `result: replayed`; changed normalized intake intent returns a conflict. A separate new
  customer report uses a new intake key and retains the existing linked-duplicate policy.
  Legacy intake retains its existing report/duplicate behavior while enforcement is off; its typed
  digest and absent upload receipt do not gain file proof or the new receipt-based replay contract.
- Files need connectivity to upload. Retain each file and upload key locally until a receipt is
  confirmed; a JSON outbox must never treat a digest or file name as uploaded evidence. After a lost
  response, retry the upload first, then submit the confirmed receipt IDs. Stock uses its existing
  command idempotency; intake uses its stable request key; corrective submission preserves exact
  evidence/detail replay. Other service-step transition conflicts require a current-case read before
  another attempt; uploading evidence alone does not make a service transition retry-safe.
- A retained file is capture evidence, not independent safety acceptance. The reporter, corrective
  owner, and evidence capturer remain excluded from verifying their own closure. No provider
  credentials or external-effect authority are added; cost-recovery execution stays unconfigured.

Accepted uploads are readable through the domain facts that linked them. The stock command,
service case, and corrective action detail reads each add top-level `evidence_files`, an array of
`{receipt_id, file_name, content_type, byte_size}`, and `evidence_files_unavailable: boolean`.
A healthy empty array has the marker `false`; an attachment-index failure keeps the primary
business record and allowed actions readable with an empty array and marker `true`. The private
content route still returns its real failure. Historical digest-only evidence yields a healthy
empty array; the read model never calls it an uploaded file. Stock files require an applied
command, service files a case event or cost-recovery claim, and corrective files a submitted
action. `GET /api/v1/evidence-uploads/{receipt_id}/content` requires a current active user whose
effective role still matches the session, the tenant's receipt, the permitted domain role, and an
accepted business link. It rechecks R2 metadata, size and the original-byte hash before returning
an attachment with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.
Unlinked or cross-tenant receipts return 404, a role change or disallowed role returns 403, and
missing or altered R2 bytes return 409. A broken D1 linkage is a 502 recovery exception. The
receipt feature remains off for required enforcement until the separate A11 retention/destruction
path and UI integration are accepted.

## PWA auth and tenant boundary

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
first tenant user exists. The checked-in top-level configuration enables the BFF, but that
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

### Customer portal install window

`POST /api/v1/customer-portal/resolve` rechecks the capability's tenant, job, and customer binding
on every request. Its `install_window` is either `null` or a redacted current native assignment:
`{ scheduled_start, scheduled_end, confirmed: true, confirmation_basis: "office_committed_assignment" }`.
The times retain the native assignment's ISO timestamp format; `scheduled_end` may be `null` when
the office has committed a start without an end. `confirmed` means the office saved the schedule
through the existing native assignment authority. It does not mean the customer acknowledged it.

Only the unsuperseded `operating_job_assignments` revision for the bound job is shared, and its
creation time participates in `source_updated_at`. A missing native schedule or a cancelled job
returns `null`. Uncommitted approval proposals and legacy broker/Frappe assignments stay unshared.
Crew, worker, assignment, approval, and receipt details are excluded. A database read failure
returns the existing unavailable response; it is not reported as a missing schedule.

### Customer portal contact

The same resolve response optionally includes
`company_contact: { phone: string | null, email: string | null }`. It reads only the current
tenant's saved Company details, where the owner or delegated office operator enters the
customer-facing contact. Deployment defaults and staff records never supply this field. Empty
or invalid contact is omitted; clearing the saved values removes it on the next resolve. Phone
numbers are emitted in E.164 form only, using a saved country for North American local numbers;
the Worker does not infer a country from the customer's device or tenant name. The portal remains
private and `no-store`. The PWA's strict response schema must accept this additive field before
the Worker response containing it is released.
The owner Company details GET and save responses include
`public_contact_preview: { phone: string | null, email: string | null } | null` from the same
normalization function. This lets the owner see exactly which saved contact customers can use;
`null` means no public contact, while a null phone beside a valid email means the phone will not
be shown. Defaults never become a public contact.

### Customer portal first open

When `APP_CUSTOMER_PORTAL_PROPOSAL_VIEWS_ENABLED=true`, a resolve that shows a published proposal
keeps the first open of that publication through that link in `customer_portal_proposal_views`
(0163): ids and one timestamp, nothing about the device. The write runs after the response
(`waitUntil`) and a failure is only logged. Staff are skipped when the app sends
`staff_preview: true` (it does while an office sign-in is live in that browser; the request itself
omits credentials) or when the request comes from the device that issued the link; a staff member
on another device without a sign-in counts as the customer. D1 refuses to delete a row younger than
3 years; the daily cron deletes older rows before it prunes portal links. The flag is `false` in
every checked-in environment until the owner approves the portal privacy notice that says the first
open is recorded and kept for at most 3 years.

### Crew office contact

Authenticated `GET /api/v1/jobs/{job}` and the universal work-object read include
`office_contact: { phone: string | null, email: string | null } | null`. This is the same
tenant-scoped, owner-saved public contact used by the customer portal and Company details preview.
It never uses the customer's `packet.contact`, deployment defaults or staff identities. An
unsaved profile or no valid public contact yields `null`; a profile read failure leaves the work
plan available with `office_contact: null` and `office_contact.unavailable` in `stale_fields`, so
the missing contact is not mistaken for an owner choice. The profile update time participates in
`source_updated_at`. A crew phone may retain a previously read job packet offline, so its UI must
identify cached contact as last-synced information rather than a live directory lookup. Both
authenticated read responses, including refusals, use `Cache-Control: private, no-store`.

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

New quote-revision approval records freeze `approved_snapshot: {snapshot_id,
version_label}` inside their immutable `preview_json` during preparation. The
browser DTO exposes that saved descriptor alongside the safe preview. The label
`Source quote vN (correction draft review)` refers to the saved source version:
this approval creates a correction draft and does not approve quote terms. Reads,
decisions, replay, failure, and reconciliation use the saved descriptor; legacy
records without a complete descriptor project `approved_snapshot: null`.

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
never an automatic retry. The frequent Worker sweep also moves expired execution
leases for its configured tenant into that reconciliation-only state, including
when the capability has since been disabled. It preserves the saved approval and
never republishes the pack.

New publication approvals freeze and project `approved_snapshot: {snapshot_id,
version_label}` during preparation. The label is `Saved proposal publication
review`: this broker preview does not bind an exact native proposal revision,
so it cannot truthfully claim a proposal version. Legacy or incomplete saved
descriptors project `null`; no receipt read looks up a current revision.

For both approval kinds, `snapshot_id` is `approval-snapshot:` followed by the
SHA-256 of canonical JSON containing the tenant, approval request id, request
kind, original saved preview, version label, and the saved argument, preview,
and private receipt-preview digests. The descriptor is excluded from that
hash. Existing SQL guards make the stored preview and digests immutable. The
Worker removes only its descriptor when sending the original saved preview to
the broker. It preserves the broker's exact JSON bytes and key order, which the
broker validates at execution; the existing digest and dry-run receipt contracts
remain intact. The projected snapshot id is an identifier and grants no authority.

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
    "currency": "CAD",
    "office_phone": "780-555-0142"
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

`tenant.office_phone` is the line a crew phone offers under "Call the office" on its emergency
line. It is the phone on the owner-saved company profile, trimmed and otherwise exactly as stored;
the app builds the `tel:` link. It is `null` on a signed-out session, while no owner has saved the
profile, when the saved phone is blank, or when it fails the profile's own save-time check. The
same value rides in the field bootstrap's `session` and in the magic-link and device-pairing
consume responses. A failed profile read never fails the session: the phone is `null` and
`stale_fields` carries `office_phone.unavailable`.

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
    "customer_display_name": "Example Customer",
    "address": "123 Example Ave, Calgary AB T2P 1J9, Canada",
    "scheduled_start": null,
    "scheduled_end": null,
    "blocked_gate_count": 1,
    "next_action": null
  }]
}
```

`customer_display_name` is the name the job read shows as `packet.contact.display_name` for the
same job, through the same helper, and `null` when the job has no customer name. Today reads it in
one tenant-scoped batch for the jobs it already lists, so a crew sees only its own jobs' customers.

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

The checked-in top-level/qa configuration enables `FACET_DESIGN_INGEST_ENABLED`; this is
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
   mailbox authority, folder permissions, and retention against the target tenant. Gmail requests
   only `gmail.send`: a successful send response with a message ID proves provider acceptance of
   the prepared request, not independent mailbox/body readback or recipient delivery. An unreadable
   or missing receipt remains unknown and cannot be sent again automatically. The challenge's
   `sent` state records that acceptance only; customer acceptance requires the bound customer
   confirmation. `email.delivery.readback` readiness still needs a separate authenticated proof,
   and any consumer requiring an independent read must retain its scope/proof refusal. IRO-273's
   owner grant and runtime evidence remain external to these source tests.
3. **SMS / carrier registration** — the Worker does not send prospect SMS. Any external SMS
   bridge requires current carrier/consent evidence and separate delivery reconciliation.
4. **QuickBooks webhook** — the receiver accepts only the configured company realm, anchors a
   signed raw receipt plus one durable outbox row per supported identity, and projects bounded
   Pending reconciliation work through a distinct least-privilege Frappe issuer. Frappe failures
   remain leased/retryable with capped backoff and escalate after five attempts; only the documented
   immutable identity conflict is terminal. This is not accounting authority: amounts, payment,
   posting, and reconciliation facts require authenticated QuickBooks read-back.
5. **Frappe compatibility projection** — configured false in the checked-in top-level
   (production, owner decision 2026-09-27) and qa profiles and true only in the local
   development profile; none of those values is live proof. Before treating
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
