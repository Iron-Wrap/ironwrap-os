# IronWrap OS Launch Runbook

Status: current launch runbook for the D1/Worker/PWA operating plane. Frappe and broad Hermes
sections are a conditional compatibility track and never replace native operating authority.

Production-candidate deployment guide for the owned D1/Worker/PWA path and any explicitly enabled
compatibility projections. Companion files live in `deploy/`; steady-state recovery is in
`docs/OPERATIONS-RUNBOOK.md`.
The canonical architecture, authority map, maturity state, and proof ladder are in
[`AI-NATIVE-ARCHITECTURE.md`](./AI-NATIVE-ARCHITECTURE.md).

## Truth Boundary

The repository contains a locked, testable deployment contract. It does not prove that a
host, Cloudflare account, Frappe site, Hermes runtime, backups, or real source cutovers are
currently live. Keep these evidence classes separate:

| Evidence class | Required proof |
| --- | --- |
| Repository | CI, `production-readiness.mjs contract`, source tests, pinned runtime lock |
| Deployment | Image digest, site/app install output, Worker migration/deploy output |
| Runtime | `/ready`, `/admin/status`, native journey smoke; Frappe/Hermes smoke only when their compatibility scope is enabled |
| Admin/source | Account ownership, rotated secrets, and each enabled source/provider cutover |
| Technical reference | Controlled end-to-end journey plus failure/recovery receipts bound to the deployed source |
| Customer validation | Independent real-customer use and acceptance; never inferred from any row above |

Never mark launch complete from repository checks alone.

## 0. Required Access And Inputs

The Cloudflare and native-provider inputs are baseline. Host, Frappe, registry image, and broad
Hermes inputs are required only when the compatibility track is deliberately enabled.

| Item | Why |
| --- | --- |
| Linux host meeting `deploy/runtime-lock.json` minimums | Conditional: runs Frappe and broad Hermes compatibility services |
| Private app repository and release tag | Conditional: supplies the Frappe compatibility app without embedding credentials in the image definition |
| Container registry | Conditional: publishes the compatibility image and yields an immutable digest |
| Cloudflare account for the configured Worker, D1, R2, Queues, DNS, and Tunnel | Owns intake, storage, recovery, and ingress |
| Frappe hostname and DNS authority | Conditional: serves the compatibility projection over HTTPS |
| Offline `age` recipient and dedicated R2 backup credentials | Encrypts and stores recoverable backups |
| Enabled website/provider/QuickBooks/Newo admin access | Proves each enabled real-source cutover |
| Dedicated native/provider credentials; conditional Frappe and Hermes credentials | Keeps privileges separated by purpose and prevents compatibility identities from gaining native authority |

When that compatibility track is enabled, its host floor is locked at Ubuntu 22.04+, 2 CPU cores, 8 GiB RAM, 80 GiB free disk,
Node.js 22.12.0+, and `x86_64`. The pinned upstream frappe_docker compose topology is
`linux/amd64`; do not represent `aarch64` as a native supported deployment until a separate
multi-architecture build and compose proof is recorded. Capacity is a floor, not a sizing promise.

## 1. Prove The Repository Contract

From a clean checkout of the release commit:

```bash
node tools/validate-documentation.mjs
node tools/production-readiness.mjs contract
node --test tools/production-readiness.test.mjs
```

The contract checks the exact Frappe, frappe_docker, and Hermes tags/commits; digest-pinned
base images; Frappe-only policy; credential-free app manifest; strict deploy scripts;
encrypted backup protocol; and the environment-name inventory. A failure blocks image build.

## 2. Compatibility Track: Prepare And Prove The Host

Skip Sections 2-6 when Frappe/broad-Hermes compatibility is disabled. Skipping this conditional
track cannot skip D1 migration, Worker/PWA deployment, native readiness, provider gates, recovery,
or reference-journey proof.

Install Docker with Compose v2, Git, Node.js 22.12.0+, `age`, `cloudflared`, `curl`, `jq`, `openssl`,
`rclone`, `sha256sum`, `sqlite3`, and `tar`. Install `cloudflared` from an approved Cloudflare package
source before the preflight; `--install` intentionally does not select or add that package source.
Ensure the Docker daemon is reachable by the deployment account and the host clock is synchronized. Then run:

```bash
deploy/host-preflight.sh
```

The preflight reads only `deploy/runtime-lock.json`; it accepts no command-line configuration
and does not print the environment. Do not continue until every host check passes.
The distribution `nodejs` package may be older than the lock; install an approved Node.js 22.12.0+
runtime before running the preflight.

## 3. Compatibility Track: Publish A Tagged Frappe App Release

The application repository must be private, credential-free in `apps.json`, and addressed by
an immutable release tag. Split the monorepo app, inspect the resulting commit, test it, and tag
that exact commit in the app repository:

```bash
APP_REPO_URL=https://github.com/ironwrap/ironwrap_roofing.git deploy/split-app-repo.sh
```

Copy `deploy/apps.example.json` to a secret file outside the checkout and replace
`<IRONWRAP_APP_RELEASE_TAG>` with the release tag. The JSON URL must stay
`https://github.com/ironwrap/ironwrap_roofing.git`; private-repository credentials belong in
an optional BuildKit credential file, never in the URL or Git history.

## 4. Compatibility Track: Build And Publish The Locked Frappe-Only Image

Check out frappe_docker at the exact commit in `deploy/runtime-lock.json` and leave that checkout
pristine. The build script refuses a dirty or mismatched checkout and rejects ERPNext:

```bash
export FRAPPE_DOCKER_DIR=/opt/src/frappe_docker
export APPS_JSON_FILE=/run/secrets/ironwrap-apps.json
export GIT_CREDENTIALS_FILE=/run/secrets/github.credentials
export IRONWRAP_APP_COMMIT=<40-character-app-commit>
export IRONWRAP_IMAGE_REF=registry.example.com/ironwrap/os:2026.07.10.1
deploy/build-production-image.sh
docker push "$IRONWRAP_IMAGE_REF"
```

Record the pushed image as a registry digest such as
`registry.example.com/ironwrap/os@sha256:...`. Deployment and backup evidence must use this
digest, never `latest` or an unqualified tag.

## 5. Compatibility Track: Create The Frappe Projection Site

Use the exact pinned frappe_docker compose topology plus the checked-in IronWrap overlay. It replaces
the image for configurator, backend, frontend, websocket, both queues, and scheduler; replacing only
backend/frontend leaves app processes on the upstream image. Validate the rendered topology before
starting it, then persist MariaDB, sites, logs, and Redis according to the pinned upstream configuration:

```bash
export FRAPPE_DOCKER_DIR=/opt/src/frappe_docker
export IRONWRAP_OS_IMAGE=registry.example.com/ironwrap/os@sha256:<64-hex-digest>
deploy/validate-frappe-compose.sh
docker compose --project-directory "$FRAPPE_DOCKER_DIR" \
  -f "$FRAPPE_DOCKER_DIR/compose.yaml" \
  -f "$FRAPPE_DOCKER_DIR/overrides/compose.mariadb.yaml" \
  -f "$FRAPPE_DOCKER_DIR/overrides/compose.redis.yaml" \
  -f /opt/ironwrap/deploy/frappe-compose.override.yml up -d
```

Create the site and install only the proprietary app:

```bash
docker exec <backend> bench new-site os.ironwrapexteriors.com --admin-password '<from-secret-store>'
docker exec <backend> bench --site os.ironwrapexteriors.com install-app ironwrap_roofing
docker exec <backend> bench --site os.ironwrapexteriors.com list-apps
```

Log in with each compatibility role, open the `IronWrap OS` Workspace and `IronWrap Control Center`,
and prove the role sees only permitted records. Exercise a populated job, no-job empty state,
unreachable Worker readiness state, and source-record navigation. The cockpit is read-only; a
button or network call that mutates a business record blocks launch.

`list-apps` must contain `frappe` and `ironwrap_roofing` and must not contain `erpnext`.
Create a dedicated non-interactive API user for each enabled projection/MCP path with the minimum
compatibility roles required by its tools. Do not reuse the Administrator account. Store its API
key and secret only in the applicable Worker or MCP secret store. This identity cannot authorize a
native D1 commercial, safety, evidence, scheduling, or accounting transition.

For QuickBooks projection, create a second non-interactive Frappe user with only the IronWrap
QuickBooks Reconciliation Issuer role and its own API key/secret. It must not hold the general
Worker/MCP roles, a human finance role, or System Manager. Set the Frappe site config key
ironwrap_quickbooks_reconciliation_issuer_user to that exact user.

Bind the Field Companion evidence issuer to that exact Worker user before enabling the Worker
bridge. This is a site-local allowlist, not a Worker variable; it prevents ordinary Desk/REST
writes from creating or promoting gate-eligible `Verified` evidence:

```bash
docker exec <backend> bench --site os.ironwrapexteriors.com set-config \
  ironwrap_field_evidence_issuer_user '<worker-api-user-email>'
```

## 6. Compatibility Track: Configure Frappe HTTPS Ingress

Create a Cloudflare Tunnel, route the production hostname, and install a filled copy of
`deploy/cloudflared-config.example.yml` outside the repository. The template routes only the
named Frappe hostname to local port 8080 and fails closed with a 404 fallback.

```bash
cloudflared tunnel create ironwrap-os
cloudflared tunnel route dns ironwrap-os os.ironwrapexteriors.com
sudo install -m 0600 /secure/cloudflared-config.yml /etc/cloudflared/config.yml
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Prove HTTPS from outside the host before storing the URL in Worker or MCP configuration.

## 7. Migrate And Deploy The Native D1/Worker/PWA Plane

Apply every D1 migration from the release commit and deploy the Worker/PWA through the governed
release lane. Set Frappe credentials and enable its consumer only for an explicitly approved
compatibility projection. The normal production path is the automatic
`.github/workflows/deploy.yml` `workflow_run` lane; it does not require a routine release click
and it does not invoke the direct `npm run deploy` path. The commands below are local preflight
and migration preparation only:

```bash
npm ci --prefix app
npm run build --prefix app
cd workers-bus
npm ci --ignore-scripts
npm run typegen
npm test
npm run typecheck
npm run deploy -- --dry-run
npx wrangler secret put ERPNEXT_API_KEY --env=""
npx wrangler secret put ERPNEXT_API_SECRET --env=""
npm run db:migrate
```

### Signed Permit And Immutable Promotion

The release workflow fails closed unless all of the following are available for the exact
successful pull-request CI merge commit, open PR head/base, and tested tree:

- `RELEASE_REVIEW_PUBLIC_KEY` from an independent reviewer whose source-addressed signed GO is
  retrieved from `.release/reviews/<source-commit>.json` on the `release-review/<source-commit>`
  ref, is bound to the complete source/tree/diff, and has no unresolved P0/P1 findings. The
  receipt is durable review evidence, not a per-release GitHub secret;
- `RELEASE_INDEPENDENT_ISSUER_URL` (the explicit `/v2/independent-issuer` route) and its
  trigger-only `RELEASE_INDEPENDENT_ISSUER_TOKEN`; `issuer-request` sends the exact v2 body with
  a canonical five-minute `requested_at`/`expires_at` window, and the authenticated issuer must
  acknowledge its distinct principal/task/run/key identity for the exact GitHub artifact digest
  before the bounded wait. Expired or malformed requests fail closed. An exact still-valid replay
  returns the ledgered acknowledgement without an executor re-run; an expired replay fails closed.
  This trigger does not mint findings or receipts;
- `RELEASE_PERMIT_PRIVATE_KEY` and `RELEASE_PERMIT_PUBLIC_KEY`, plus separate
  `RELEASE_POLICY_LEDGER_API_TOKEN`, `RELEASE_STAGING_CLOUDFLARE_API_TOKEN`, and
  `RELEASE_PRODUCTION_CLOUDFLARE_API_TOKEN` credentials with non-overlapping authority;
- a separately signed full-surface evidence receipt covering reception, sales, field, production,
  shop, finance, customer, agent, Facet, provider reconciliation, and genuine IRO-7 actor/business
  evidence; a skipped scope requires signed non-applicability evidence and the provider scope may
  not be skipped;
- staging and production authenticated launch-proof/Frappe credentials, plus the HTTPS Frappe
  release-adapter URL, bearer token, public key, and separately held provider private key; and
- every expected Worker secret name in each Cloudflare environment. Secret values are never
  placed in the permit or receipts.

The complete name-only inventory and custody split is in `deploy/release.env.example`. The
independent review/evidence trigger receives neither the permit private key nor provider mutation
credentials, and it is not the signing/publication implementation. The existing
`review-sign`, `review-publish`, `release-evidence-sign`, and `release-evidence-publish` primitives
remain under the independent issuer custodian's custody. The Frappe adapter receives neither
GitHub merge authority nor the Cloudflare token.

Generation N enforcement is loaded from the PR base, not from candidate source, so a candidate
cannot weaken and approve its own release boundary. That predecessor enforcer atomically
bootstraps generation `0` at
`release-policy:Iron-Wrap/ironwrap-os` in the existing `dedup_claims` table using the canonical
policy-and-executable-enforcement hash, or reads the existing state. The first installation of
this workflow therefore requires the reviewed predecessor enforcer to exist on the protected base;
repository source does not claim that external bootstrap is already installed. A malformed or
conflicting genesis row, changed PR/base/tree identity, missing exact CI run/job identity, changed migration set, source/tree/diff drift, missing
secret inventory, provider DNS/readiness failure, or absent external credential stops admission.
No release-specific migration or process-memory replay map may replace this boundary.
Before any secret-bearing Wrangler invocation, that predecessor policy also rejects candidate
custom builds and local-file/module discovery controls, validates the candidate service/database/
bucket/queue/route coordinates, and runs the pinned predecessor Wrangler installation. Staging and
production credentials must be distinct and incapable of cross-environment mutation.
Before the first migration or upload, a second static readiness preflight requires every top-level
variable to be repeated in a named environment, nonempty notification sender/recipient variables,
the exact Cloudflare secret-name inventory, and an allowed OCR model plus OCR secret whenever OCR
is enabled. It does not weaken `/ready`; a missing value or secret stops before mutation.
Any failed staging step after traffic deployment restores the captured previous staging revision
and accepts cleanup only after exact active-deployment readback; that cleanup receipt is not the
successful compatibility drill. A production deploy that returns failure after changing traffic is
also treated as attempted: recovery forces the captured previous version and trusts only readback.

CI creates one deterministic aggregate containing the Worker bundle and PWA assets; it may carry a
leftover Frappe wheel only for an enabled compatibility release. It records each included component
digest and uploads the aggregate once. Wrangler uploads
the same bytes separately to the distinct staging and production Worker services; their provider
version IDs are therefore different and both IDs, version readbacks, environment config digests,
and secret-name inventory digests are bound into the permit. Staging must first prove active
revision identity, `/health`, `/ready?scope=core`, authenticated affected-workflow smoke, an
explicit nonempty export plus structured `d1 execute --json` schema/row-count/sentinel manifest
restore into a `$RUNNER_TEMP`-persisted local target, and a previous-version rollback readback
against the migrated schema with health/readiness/smoke proof. Only then is the short-lived permit
assembled and consumed once through D1; the exact admitted PR is machine-merged and read back
before production migrations or traffic promotion. Production promotes any enabled compatibility
artifact through its authenticated adapter, promotes the pre-uploaded Worker/PWA version, re-reads
every applicable identity after smoke, and advances the durable generation only after the exact
authenticated launch-proof step set is bound into an immutable production-promotion receipt.
Failure after a compatibility promotion attempt invokes its idempotent rollback plus Worker
rollback, then verifies the restored Worker/PWA and applicable compatibility identities and
health/readiness before atomically persisting the rollback outcome.
An expired permit may record that emergency rollback only when its original durable single-use
admission claim is read back exactly. If an admitted D1 migration fails before Frappe or Worker/PWA
promotion, no down migration or false rollback is attempted: the durable ledger records an exact
`production_recovery_required` outcome bound to the source merge, pre-migration D1 recovery point,
and prior Worker/PWA/Frappe identities for operator recovery.

Repository tests prove the source contract only. A successful workflow is not live provider,
DNS, readiness, credential, business acceptance, or production proof until its redacted receipts
are independently read back.

### Optional Facet-to-Frappe Compatibility Projection Gate

The canonical compatibility flag is `FACET_DESIGN_FRAPPE_PROJECTION_ENABLED`; it is default-off
(`false`) in every checked-in environment. Leave it false until the `0035` D1 migration is applied in
the named environment and all of the following are proven there:

1. Create a dedicated Frappe API user with only `IronWrap Facet Design Projection Service`, pin
   its email in `ironwrap_facet_design_projection_service_user`, and set a distinct
   `ironwrap_facet_design_projection_hmac_key`. Give it no generic quote, contract, acceptance, or
   Proposal Evidence Pack write permission.
2. Store `FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY`,
   `FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY`, and
   `FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET` only with `wrangler secret put`. Do not
   reuse the Facet ingress HMAC, broad Worker/Frappe API identity, or customer-acceptance identity.
3. Establish the governed v2 project/producer-identity link and launch anchors before projection.
   The Worker must resolve those native D1 anchors and read the current approved quote, proposal,
   publication, and acceptance authority back from their owning stores. There is no deployment JSON
   association or commercial authority.
4. With a disposable existing Roof Job and its current `Approved` Customer Quote, prove the
   scheduled projection reads an already durable native D1 head and accepts only exact current
   authority. For `approved`/`corrected`, the endpoint creates a blank, non-customer-safe `Draft`
   Customer Quote. On every chain advance it marks the predecessor projected quote `Rejected`, and
   creates a replacement only for an active decision. It also creates a non-customer-safe Evidence
   Item and an Integration Reconciliation row (`Pending` active, `Superseded` terminal). The
   compatibility draft supplies no price, line items, taxes, payment schedule, or commercial terms.
   Repeat the exact event to
   prove deterministic replay; separately prove missing/mismatched mappings make no Frappe call,
   an unsigned or tampered `200` becomes an unknown manual-reconciliation effect with no redispatch,
   and an Frappe refusal creates no Worker success.

Keep the flag false if any proof is missing. Repository tests, an ingress `202`, or a deployed D1
migration are not runtime evidence for this customer-linked projection. Archive only redacted
event/evidence/reconciliation IDs with the release evidence.

### Facet Release Order And Default-Off Gates

Treat Facet as a consumer-first rollout with separate, default-off release gates. Do not collapse
receipt capture, commercial association, Frappe projection, or quote revision into one "Facet is
live" claim.

1. Enable only `FACET_DESIGN_INGEST_ENABLED=true` first, with
   `FACET_DESIGN_INGEST_SOURCE_TENANT_ID` set to the reviewed Facet producer owner/tenant id, a v2
   map containing exactly that source key, and migration state in the intended environment. The
   accepted artifact is still immutable evidence only: it is not a quote, proposal, contract,
   payment, or accounting mutation.
2. Capture live v2 receipt proof in the named Worker, D1, and R2 environment before discussing any
   downstream cutover. A staging payload, repository fixture, or attachment transcript is not
   runtime proof.
3. Keep the append-only, office-authored association ledger separate from ingest proof. An
   association may bind only exact v2 receipt anchors to an existing same-brand Roof Job and its
   current `Approved` quote after Frappe read-back; it never copies or changes commercial terms.
4. Keep `FACET_DESIGN_FRAPPE_PROJECTION_ENABLED=false` until the projection gate above is closed in
   that same environment. Compatibility projection creates only the blank non-customer-safe Draft
   shell described above, rejects its predecessor shell on chain advance, and supplies no commercial
   content; it is not permission to mutate the approved source quote, proposal pack, contract
   acceptance, accounting record, or customer commitment.
5. Keep `APP_FACET_QUOTE_REVISION_PREPARE_ENABLED=false` until the private quote-revision broker,
   configured human approver, resolved v2 association, dry-run, approval, create-only blank Draft,
   audit, and uncertainty paths are proven in that environment. Do not treat a projected Facet
   receipt as permission to revise commercial terms.
6. Enable any Facet-side producer or automation flag only after IronWrap v2 ingest, exact
   associations, and live receipt proof are already demonstrated. Legacy v1 events remain
   `provenance_unknown` evidence and cannot be commercially associated with IronWrap or iRoof.

The v2 `customer_capability` provenance and `bearer_capability_only` identity assurance prove only
possession and exercise of the issued link. They do not establish a distinct natural person,
informed consent, contract acceptance, or commercial authority.

Newo production uses the managed federation and full governed control plane. Store
`NEWO_API_KEY`, `NEWO_WEBHOOK_TOKEN`, `NEWO_BOOKING_TOKEN`, and
`NEWO_CONTROL_SIGNING_SECRET` only as Cloudflare secrets after the exact target is verified.
Follow [`NEWO-PRODUCTION-RUNBOOK.md`](./NEWO-PRODUCTION-RUNBOOK.md); do not substitute
`INGEST_TOKEN`, expose a provider key to an MCP process, or enable customer outbound at launch.

Only when the Frappe compatibility projection is intentionally enabled, set the reviewed
non-secret Worker vars `ERPNEXT_ENABLED="true"` and
`ERPNEXT_BASE_URL="https://<frappe-host>"` in that environment before deployment. The legacy
`ERPNEXT_*` names address the Frappe compatibility site; only the API key and secret are Worker
secrets. The native target is to remove this dependency after projection/rollback retirement
proof. Then prove all applicable health surfaces:

The Worker pair is a dedicated integration credential. Do not mount it in Hermes: every Hermes
MCP process needs its own Frappe API pair issued to exactly its `HERMES_ACTOR_USER`, so the
atomic safety acknowledgement command cannot impersonate a field actor.

Before QuickBooks cutover, apply migration `0031_quickbooks_projection_outbox.sql` to the intended
D1 database. Set `QB_EXPECTED_REALM_ID` to the one approved Intuit company realm and set
`QB_RECONCILIATION_ISSUER_USER` to the separate Frappe user configured above. Put
`QB_WEBHOOK_TOKEN` and the issuer API key/secret only in Worker secrets. The issuer pair must be
distinct from `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET` and every human or MCP credential.

```bash
curl --fail --silent --show-error "$BUS_BASE_URL/health"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BUS_BASE_URL/ready"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BUS_BASE_URL/admin/status"
docker exec <backend> bench --site os.ironwrapexteriors.com set-config \
  ironwrap_bus_base_url "$BUS_BASE_URL"
```

`/health` proves isolate liveness only. `/ready` queries the D1 operational schema and checks that
R2/Queue bindings plus auth, notification, JobNimbus, and any enabled compatibility configuration are
present; it returns only `{ok}` without auth and the diagnostic map only with `ADMIN_TOKEN`.
It does not contact every downstream service. `/admin/status` is the authenticated
operating view for heartbeat freshness, queue/dead-letter counts, enabled provider/projection
errors, failed/stuck replay requests, audit failures, and QuickBooks receipt freshness.
The non-secret site config lets the Control Center show the public `{ok}` result; it never
stores or uses the Worker admin token.

### QuickBooks Provider And Optional Frappe Projection Gate

The expected realm and any compatibility-projection issuer values are deployment configuration,
not proof that Intuit, the Frappe user, or its role is live. Run the live-environment readiness
check to reject missing, malformed, reused, or mismatched values; then prove the applicable path
against the intended accounts. D1 accounting intent/effect/reconciliation remains authoritative;
the Frappe record, if enabled, is a projection only:

1. The configured QuickBooks company sends one signed supported finance event to the intended
   Worker URL, while a different realm is retained only as rejected audit evidence.
2. The Worker preserves the raw payload, receipt, and one durable projection-outbox row before
   the bounded Frappe call. A successful projection creates or reuses exactly one Pending
   Integration Reconciliation; it does not claim a payment, amount, posting, or reconciliation
   fact from the webhook.
3. A temporary Frappe/issuer failure returns a retryable result and leaves the row pending.
   Repair the deployment/configuration, then allow the five-minute recovery sweep or an Intuit
   redelivery to acquire the leased row. Do not edit the D1 row to force completion.
4. After five failed attempts, preserve the audit evidence and open or continue a SEV2 Automation
   Incident. Only the documented immutable identity-conflict response is terminal; reconcile that
   conflict with a human and QuickBooks read-back.

### Public Instant-Estimate Activation Gate

`/public/instant-estimate` is the browser-safe route; it is deliberately separate from the
private bearer-authenticated `/ingest/estimate` handoff. Do not put `INGEST_TOKEN`, a price rule,
or a Turnstile secret in a website or PWA bundle.

Before setting `PUBLIC_ESTIMATE_ENABLED=true` in the intended Cloudflare account:

1. Apply migration `0021_public_estimate_rate_limits.sql` with the same release. It stores only
   keyed IP/client hashes for a bounded abuse window; it does not store raw IPs, tokens, or form
   fields.
2. Create the Turnstile widget for the exact HTTPS PWA/Worker hostname, set the site key as the
   non-secret `PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY`, then set both
   `PUBLIC_ESTIMATE_TURNSTILE_SECRET` and `PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER` with
   `wrangler secret put`. The Worker validates every first submission with Siteverify; the browser
   token alone is not proof.
3. Set `PUBLIC_ESTIMATE_ALLOWED_ORIGINS` to the exact origin serving `/estimate` (normally the
   Worker/PWA origin). This is not the marketing-site iframe parent: iframe parents are separately
   constrained by the `/estimate` `frame-ancestors` rule. Keep
   `PUBLIC_ESTIMATE_ALLOW_INSECURE_LOCAL=false` outside explicit localhost development.
4. Set `PUBLIC_ESTIMATE_ALLOWED_BRANDS` to the exact tenant keys (`ironwrap,iroof` for the
   current tenant) and pin each marketing iframe to `/estimate?brand=<key>`. The visible brand and
   canonical lead must agree. Set `PUBLIC_ESTIMATE_CONSENT_JURISDICTION` to the tenant's explicit
   governing jurisdiction (`Alberta, Canada` here); never derive either value from an untrusted
   `Referer` or free-form field.
5. Set bounded rate controls and keep `PUBLIC_ESTIMATE_RANGE_RULES_JSON=[]`. Public intake never
   returns a price before measurement evidence and an approved pricing policy. Any non-empty value
   fails readiness; do not deploy illustrative or static ranges.
6. When the Frappe compatibility projection is enabled, set `ERPNEXT_INTEGRATION_USER` to its exact
   dedicated Worker user. The projection stays disabled until this identity is present; explicit
   follow-up consent remains authoritative in D1 and may be mirrored as append-only channel records.
7. Build the PWA and deploy the Worker, then verify `/ready` is green. A failed configuration
   returns a disabled form rather than accepting unauditable browser intake.

Use a real Turnstile test submission from the live `/estimate` route to prove the full path:
the public response must contain only acceptance, an opaque envelope id, `range=null`, the fixed
no-online-price disclaimer, and `review_required=true`. In D1/R2, prove the corresponding raw record
and authoritative lead/estimate/consent identities. If the Frappe projection is enabled, separately
prove its Lead Envelope, Roof Job, Instant Estimate Session, source Evidence Item, and
`Communication Consent` projections. Also prove a rejected challenge,
wrong Origin, mismatched idempotency key, and rate-limited request create no accepted estimate.
Archive only redacted request ids and the release evidence.

## 8. Configure The Optional Hermes And MCP Compatibility Surface

If the broad compatibility surface is enabled, install Hermes at the tag and commit in
`deploy/runtime-lock.json`. Register the four entries in
`hermes/mcp-servers.json`. The bus, Frappe, and Newo tool filters come from
`hermes/agents/roles.json`; the separate desktop pilot server is outside that inventory and must
remain fixed at `hermes_next_tasks`, `hermes_stage_context`, and `hermes_submit_draft`. MCP base
URLs must be production HTTPS URLs. Plain HTTP is accepted only for explicit localhost development.

Keep `APP_HERMES_DESKTOP_ENABLED=false` during the broad role smoke test. The checked-in desktop
surface is a narrow `lead_follow_up_draft` pilot, not a resident company coordinator or operating
authority. For first pairing, issue
the one-time fragment link from PWA Settings and pass it only as
`IRONWRAP_HERMES_DESKTOP_PAIRING_URL` to the local desktop MCP child process; it removes the link
after parsing and retains the 15-minute credentials only in memory. A native launcher may instead
resolve the paired access token and device proof from desktop OS secure storage. Never give this
server an admin/write token or native connector credential. Enabling the flag is not launch proof:
separately prove one owner/ops pairing, the device-bound task envelope, optional untrusted context
staging, and a draft submission that returns a handoff without sending, booking, or creating
downstream authority.

Keep the Frappe, bus, and Newo MCP/Worker write flags false for the first read-only smoke test:

```bash
node tools/validate-hermes-config.mjs
```

Ask the owner-operator profile for bus readiness, operational status, and blocked jobs. Confirm
that no mutation or `Hermes Run` was created. For the approved-write proof, enable only the one
required write surface, use a stable unique `run_id`, execute the matching dry-run, obtain human
approval, and invoke the request tool with the approval token. Repeating the same completed
Frappe `run_id` must return its recorded result without repeating the business mutation.
For lead triage specifically, archive an `Untriaged` Lead Envelope dry-run, its signed human
approval, the protected triage command result, and the linked Hermes Run. Verify the command
changed exactly `triage_status`, `triaged_by`, `triaged_at`, and `triage_summary`, left bus
transport unchanged, and that an ordinary Desk/REST Lead Envelope patch is rejected.

## 9. Run Repository And Live-Environment Readiness

Copy `deploy/env.example` to a root-owned file outside the repository, fill it from secret
stores, and export it without printing values. Then run:

```bash
node tools/production-readiness.mjs live-env
node tools/production-readiness.mjs all
```

`live-env` checks configuration shape, immutable runtime pins, digest-pinned image identity,
HTTPS URLs, explicit write gates, credential separation, and backup inputs. It does not call the
live services; the HTTP and application smoke tests in this runbook remain mandatory.

### Field Companion BFF Enablement Gate

The checked-in top-level/staging configuration enables `APP_BFF_ENABLED` and supplies app origins;
development remains disabled. This is configured repository intent only. A successful
`wrangler deploy --dry-run` proves the bundle/config shape, not a Field Companion deployment,
runtime path, real-device result, or customer proof.

Before treating the configured BFF as launch-ready in the intended Cloudflare account:

1. Apply the exact D1 migration sequence remotely, including `0028_work_package_actions.sql`, then
   run the Frappe app migration so legacy Lead Envelopes become explicit `Unknown` triage rows.
   Verify `/ready` against the intended database. The complete migration-derived table/index/trigger
   backup-and-restore inventory must be deployed with the same release.
2. In the controlled production Worker configuration, set `APP_BFF_ENABLED=true`, exact tenant
   presentation fields, `APP_PUBLIC_ORIGIN` to the canonical HTTPS PWA origin, and
   `APP_ALLOWED_ORIGINS` to that exact origin (or an explicit, reviewed comma-separated set).
   Leave `APP_ALLOW_INSECURE_LOCAL=false`. If restricted insurance evidence is needed in the
   browser, set `APP_INSURANCE_ESTIMATOR_FRAPPE_USERS` only to reviewed, exact Frappe estimator
   identities; leave it blank to restrict the rail to owner sessions. Broad app `ops` access never
   grants this read. Do not bake an operator's temporary preview origin into the release
   configuration.
3. Store a new high-entropy `APP_AUTH_PEPPER` only with `wrangler secret put`; it is a Worker
   secret, never a `vars` value or a browser value. Configure the dedicated Gmail sender and any
   Frappe read credentials separately. Keep Hermes write flags false for this gate.

   The enabled BFF carries the two bounded field-capture rails, and each issues Frappe with its
   OWN identity rather than the broad `ERPNEXT_API_KEY` pair. Create one non-interactive Frappe
   user holding only `IronWrap Fleet Capture Issuer` and one holding only
   `IronWrap Work Package Issuer`, pin `ironwrap_fleet_capture_issuer_user` and
   `ironwrap_work_package_issuer_user` to those exact emails, and store their pairs as
   `FLEET_CAPTURE_FRAPPE_API_KEY`/`_SECRET` and `WORK_PACKAGE_FRAPPE_API_KEY`/`_SECRET` with
   `wrangler secret put`. Do not reuse the bus pair for either: the Worker refuses a repeated
   value outright and `/ready` reports `rail_credential_isolation: false`, so this gate cannot be
   closed by copying a credential. Rotation is in `OPERATIONS-RUNBOOK.md`.
4. If the tenant has zero `app_users`, use the one-time bootstrap ceremony first: keep
   `APP_FIRST_OWNER_BOOTSTRAP_ENABLED=false` by default, enable it only long enough for one
   `POST /admin/app-users/bootstrap` request, and prove the route accepts only an owner body,
   derives its audit actor server-side, inserts only while the tenant still has zero users, and
   returns a stable denial on replay. After that first owner exists, turn the flag back off.
5. Provision any steady-state owner, ops, and field users only through the authenticated office
   session + CSRF app API route. `ADMIN_TOKEN` alone is not authority to create another active
   owner or ops identity. Confirm office magic-link delivery, QR issue, fragment-only consume, one
   field read with `X-IronWrap-Device-Proof`, and the refusal of the same request without that
   proof.
6. Run the lost-device procedure in `OPERATIONS-RUNBOOK.md`: revoke the paired device, prove its
   old cookie/proof fails, then pair a replacement with a fresh QR. Archive request ids, device
   ids, and timestamps only; never archive QR URLs, tokens, or device proofs.
7. Capture real iOS and Android install/camera/share/clipboard/weak-signal evidence before any
   field-launch wording. A local build, static QR image, or a browser emulator does not close this
   gate.
8. Run one consented lead through the production sender. Archive the canonical envelope id, D1
   `lead_ack_receipts` row, provider message id, and observed timestamp; prove Owner Now labels it
   only as provider acceptance within/after 60 seconds. Do not call this delivery proof. Repeat
   with no eligible email to prove the queue shows a no-channel exception rather than a false
   “sent” result. For an intentionally rejected staging send, wait past the 60-second deadline
   and prove the queue shows an unproven exception.

### Legacy Frappe Schedule-Broker Compatibility Gate

Native D1 append-only assignment revisions, conflicts, and approval records are the current
operating authority. Prove that native path for the technical reference journey. The steps below
apply only while the older Frappe schedule broker remains enabled; passing them cannot make the
broker authoritative. A local broker test, Worker bundle, or populated schedule card is not
permission to dispatch a crew or call an assignment live.

1. Apply the remote D1 migration through `0028_work_package_actions.sql` and
   the matching Frappe migration. Confirm the Frappe document policy is installed before the
   broker receives a write-capable credential: it must lock the Roof Job, reject current
   `Needs Review`/`Shortage` supplier exceptions, and reject any initial or correction assignment
   that would create a second logical current scheduled Production assignment.
2. Install the separate loopback-only service and owner-readable environment from
   `deploy/production-schedule-approval-broker.service.example` and
   `deploy/production-schedule-approval-broker.env.example`. Use a distinct
   `production-controller` Frappe API identity, HMAC secret, and approval signing key; never
   reuse the lead-triage or quote-revision broker credentials.
3. Configure only the scoped Worker variables in `deploy/env.example`, then set
   `PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET` with `wrangler secret put`. Do not put the private
   broker environment, its API credential, or its signing key in Worker vars, browser assets, or
   deployment logs. Keep the broker origin private behind the reviewed tunnel/access path.
4. With a disposable test Roof Job, prove an eligible owner can create one *pending* approval that
   contains only the projected crew/timing/correction data. Prove a field/ops session, stale owner
   session, unknown Crew Profile, individual-user target, missing gate, and material shortage all
   fail before an assignment is written.
5. Approve exactly one test request and archive the request id, Job Assignment id, Hermes Run id,
   source-state timestamps, and redacted result. Then prove a second initial request and a second
   correction of the same source assignment are rejected. Do not describe provider acceptance as
   crew notification, dispatch, customer contact, or completed work.

Remote migration, broker reachability, authenticated owner acceptance, and this live proof remain
open until those exact checks are captured.

### Customer Portal and Contract-Acceptance Availability Gate

The checked-in top-level/staging configuration sets the portal and contract-acceptance flags true;
development remains false. Those values are configured repository intent only. The portal bearer
is read-only and is never customer authentication or acceptance evidence. The separate
email-bound route may commit native acceptance only after it pins the current quote, published
proposal, canonical terms snapshot, challenge, and customer decision.

Neither route is a public estimate widget, customer session, document-download service, payment
flow, generic commercial e-sign service, deposit collection, or delivery proof. They show only
customer-safe projected summaries; raw storage keys, Drive links, field notes, unapproved
estimates, and office session data never cross the public boundary.

The visible customer-portal brand comes from the linked Roof Job's bounded `brand` field and
falls back to the tenant presentation brand only when that job record lacks a recognized brand.
Do not treat the marketing hostname, attachment notes, or a global deployment label as the
customer-facing portal brand source of truth.

Before treating either configured route as available in the intended Cloudflare account:

1. Apply the migration sequence through `0029_customer_contract_acceptance.sql` with the same
   release and prove `/ready` against the migrated D1 database. If either respective gate below is
   incomplete, override its flag to false or block the deployment; a checked-in true value cannot
   waive runtime proof.
2. Complete the Field Companion BFF configuration above, including the exact HTTPS
   `APP_PUBLIC_ORIGIN`, matching `APP_ALLOWED_ORIGINS`, Frappe read credentials, and the
   `APP_AUTH_PEPPER` secret. Then set `APP_CUSTOMER_PORTAL_ENABLED=true`; the portal fails closed
   without every one of those prerequisites or an enabled, healthy BFF. This preserves an office
   revocation path for every live customer link.
3. From an owner/ops session, issue one explicit-expiry link for a test job with a linked Roofing
   Customer. The response must be `https://<origin>/portal#token=...`: the token is in a fragment,
   is scrubbed by the browser, and is POSTed to the fixed resolver without cookies. Do not put a
   token in a query string, path, ticket, screenshot, browser recording, or log.
4. Prove one customer-safe project view in the real browser, then prove that a wrong origin,
   expired link, revoked link, and a job reassigned to a different Roofing Customer all return the
   same unavailable result. Check the live static asset headers include `Referrer-Policy:
   no-referrer` and a restrictive CSP before sending any link.
5. Archive only link id, job id, request id, expiry, and test result. Never archive the raw URL or
   capability token. Confirm a fresh link revokes the prior active link for that job.

Do not enable `APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED=true` merely because the portal is live.
Before this separate capability is enabled in a named environment:

1. Prove the linked native `operating_customers` and Roof Job resolve exactly one current,
   approved, unexpired commercial quote -> proposal -> latest published proposal chain. Missing or
   ambiguous chains must fail closed, and the acceptance CTA must remain absent until the customer
   portal resolves `contract_acceptance_available=true` from live configuration.
2. Configure the approved Gmail sender and exact HTTPS `APP_PUBLIC_ORIGIN`. The email must use
   `https://<origin>/contract-accept#token=...`; do not log, screen-capture, or place that token in
   a query string, path, ticket, or browser recording. Provider message acceptance is not delivery
   evidence.
3. With a disposable linked Roof Job, approved Customer Quote, and approved Proposal Evidence
   Pack, prove the email challenge stores only hashes in D1, rejects cookie-only and wrong-origin
   requests, and exposes no raw email or token in the ledger or response. Change the quote terms,
   proposal state, or customer email after challenge issuance and prove confirmation is rejected.
4. Confirm once through the email fragment, then prove same-token and conflicting-idempotency
   retries cannot create another acceptance. Verify R2 receipt storage precedes the atomic D1
   transaction that makes the intent terminal and inserts the exact immutable
   `commercial_acceptance_bindings` row. Simulate a committed-but-lost D1 response and prove the
   immutable intent plus binding readback returns the original accepted result without duplication.

This proof is still open until it runs in the named Cloudflare D1, R2, and Gmail environment.
Do not call the repository slice a legal signature determination, a received-email proof, a paid
deposit, or a preconstruction release.

Do not add proof-photo/download, invoice, warranty-file, or proposal-file URLs to this route
without a separate short-lived attachment-authorization design and browser proof. The private
`/ingest/estimate` route remains bearer-authenticated; public estimation is limited to the
separate review-gated `/public/instant-estimate` contract above.

## 10. Prove The End-To-End Intake Slice

Before using `--execute`, read the
[launch-proof side-effect inventory](./LAUNCH-PROOF-SIDE-EFFECTS.md) and obtain owner authorization
for its enumerated email, JobNimbus, Drive, D1/R2, and queue effects. The command has no
partial production mode, and several effects are irreversible or only soft-reversible.

IRO-189's gate is D1/Worker operating authority. Frappe/ERPNext stand-up is out of scope
(superseded by IRO-195). Do not create a launch-proof Frappe reader or pass `FRAPPE_*`
to this command. HELM permit/receipt activation remains IRO-190 and is not this proof.

```bash
node tools/launch-proof.mjs
BUS_BASE_URL=... INGEST_TOKEN=... ADMIN_TOKEN=... node tools/launch-proof.mjs --execute > launch-proof-evidence.json
```

The dry run makes no network request. Execute mode proves `/health` and every `/ready` check
before it creates a fixture; verifies website intake, website replay (same canonical envelope),
estimator idempotency, `GET /admin/envelope/:id` D1 identity, admin list read-back,
reconciliation, and a fresh/reconciled `/admin/status`. The artifact is
`proof: "ironwrap-launch-proof-v4"` with `operating_authority: "d1"` and
`frappe_projection.state: "out_of_scope"`. It contains only redacted evidence and response
request ids; do not add tokens or contact fields to it.

A matched D1 lead is evidence that the synthetic envelope is the owned operating record. It
does not retire JobNimbus (`bridge_keep_enabled` stays true; IRO-192) and is not a HELM
permit or receipt (IRO-190). A missing D1 row, replay that mints a second identity, or
failed readiness writes a redacted artifact and makes
`node tools/launch-proof.mjs --execute` exit non-zero. Preserve that artifact for
reconciliation; it is failed proof evidence, not a green launch gate.

Archive `launch-proof-evidence.json` with the release commit and image digest. Verify the
fixture in D1 (tenant_id + envelope_id + contact identity) and R2. Remove or clearly label
fixture records after proof. Do not require a Frappe Lead Envelope / Roof Job lookup.

Keep launch-proof artifacts private and redacted. They are release evidence, not canonical docs,
not Git fixtures, and not proof that a later deployment still runs the same exact head.

## 11. Cut Over Real Sources

| Source | Runtime proof |
| --- | --- |
| Website | Real consented submission reaches `/ingest/website`, raw R2, authoritative D1, provider-acceptance receipt (not delivery proof), temporary JobNimbus bridge, and any enabled compatibility projection |
| Public estimator | Live `/estimate` Turnstile challenge and exact-origin POST create a raw-first, idempotent, review-gated session; the response leaks no submitted PII and explicit follow-up consent is mirrored with source evidence |
| 3D estimator handoff | Repeated private `/ingest/estimate` idempotency key returns the original session and remains review-gated |
| Jotform field intake | Device submission reaches `/ingest/photo`, Drive/R2, evidence, and check-in with photos plus one voice note |
| RoofRuler/AppliCad | `/ingest/measurement` records one hashed receipt per provider/idempotency identity, stores raw source first, routes no-job or unresolved-job reports and retryable failures to `/admin/measurements/exceptions`, sequentially re-drives verified raw sources with bounded backoff, and keeps uncertain values review-gated |
| QuickBooks | Expected-realm signed event produces raw R2, a D1 receipt plus durable reconciliation/effect state, and any enabled Pending Frappe projection; invalid signatures and other realms are rejected, and provider facts remain unproven until authenticated readback |
| Newo receptionist | Approved real call produces `raw/newo/` R2, event receipt, distinct reception session, native lead/envelope state when applicable, downstream result, and operator status; any Frappe landing is a projection; same-caller second calls remain distinct sessions; report omission and failed transfer become owned exceptions |

JobNimbus and GHL remain bridges until each replacement slice has live evidence. SMS remains
record-only until A2P/carrier approval. QuickBooks remains accounting truth.

## 12. Backups And Restore Drill

Fill only the nightly backup inputs from `deploy/env.example` in
`/etc/ironwrap/backup.env`, owned by root and mode `0600`. `IRONWRAP_OS_IMAGE` must be the
deployed image digest and `BACKUP_AGE_RECIPIENT` must be an offline public recipient.
`D1_BACKUP_API_TOKEN` is the persisted read/export-only authority; keep it distinct from the
backup-only R2 access/secret key pair. Never store `D1_RESTORE_API_TOKEN` in that file: inject
its separate drill/write authority just-in-time for one remote restore and unset it afterward.
Discover the real backend container name from the deployed compose project before any backup or
restore run; the sample `BACKEND_CONTAINER` in `deploy/env.example` is illustrative only and is
not live-environment proof.
Install the Worker lock before scheduling; both D1
scripts refuse any Wrangler other than the exact 4.x version in that lock:

```bash
cd /opt/ironwrap/workers-bus
npm ci --ignore-scripts
./node_modules/.bin/wrangler --version
cd /opt/ironwrap
deploy/backup-d1-to-r2.sh
deploy/backup-to-r2.sh
```

The D1 manual run must succeed. When Frappe compatibility is enabled, its manual run must also
succeed and its scheduled backup follows the canonical D1 export by 20 minutes. They are
independent jobs so a D1 failure cannot silently suppress the compatibility attempt:

```bash
CRON_TZ=UTC
5 9 * * * /bin/bash -c 'set +x; set -a; . /etc/ironwrap/backup.env; set +a; exec /opt/ironwrap/deploy/backup-d1-to-r2.sh' >> /var/log/ironwrap-d1-backup.log 2>&1
25 9 * * * /bin/bash -c 'set +x; set -a; . /etc/ironwrap/backup.env; set +a; exec /opt/ironwrap/deploy/backup-to-r2.sh' >> /var/log/ironwrap-frappe-backup.log 2>&1
```

`backup-d1-to-r2.sh` is bound to Cloudflare account
`7ee5775bc1ba46f05c5a65235b60e939`, database `ironwrap-bus`, and UUID
`f0674848-13df-4422-9896-8ba2719663b8`. It runs locked Wrangler `d1 export --remote`, imports
the SQL into isolated SQLite, checks integrity and the complete migration-derived table, index,
and invariant-trigger inventories, packages manifest plus SQL, encrypts
locally, uploads immutably, remotely checks the objects, and publishes
`IRONWRAP-D1-BACKUP-COMPLETE` last. Its success line records the exact
`d1/ironwrap-bus/<timestamp-pid-random>` prefix. Never discover or infer `latest`.
Both D1 scripts unset any inherited generic `CLOUDFLARE_API_TOKEN` and expose only the applicable
dedicated token to each Wrangler command.

`backup-to-r2.sh` creates the Frappe database/site-config/public/private set and publishes
`IRONWRAP-BACKUP-COMPLETE` last. For both protocols, a prefix without the correct marker is
incomplete and forbidden for recovery. At expiry each protocol deletes its marker first and
retains ciphertext/checksum for one additional hour, so visible completion cannot point at data
already removed by scripted retention.

Local D1 verification is the default and performs no Cloudflare mutation. Copy one exact prefix
from the successful backup log into the environment, keep confirmation unset, and run:

```bash
export D1_RESTORE_R2_COMPLETED_PREFIX='d1/ironwrap-bus/<YYYYMMDDTHHMMSSZ-pid-random>'
export D1_RESTORE_MODE=verify
unset D1_RESTORE_API_TOKEN D1_RESTORE_CONFIRMATION
deploy/restore-d1-from-r2.sh
```

For the launch remote drill, create a fresh empty D1 database named
`ironwrap-restore-drill-<label>` in the same committed account and record its exact UUID. The
name and UUID must both differ from production. Bind one approval to that exact pair; the script
generates a target-only Wrangler config, rechecks emptiness, imports, then compares the complete
table-to-row-count map for every required table and the exact migration-derived index and
trigger-to-table inventories
with the locally verified SQLite export:

```bash
export D1_RESTORE_MODE=remote
export D1_RESTORE_TARGET_ACCOUNT_ID=7ee5775bc1ba46f05c5a65235b60e939
export D1_RESTORE_TARGET_DATABASE_NAME='ironwrap-restore-drill-launch'
export D1_RESTORE_TARGET_DATABASE_ID='<different-non-production-d1-uuid>'
export D1_RESTORE_API_TOKEN='<just-in-time-d1-drill-write-token>'
export D1_RESTORE_CONFIRMATION="RESTORE_D1:${D1_RESTORE_TARGET_DATABASE_NAME}@${D1_RESTORE_TARGET_DATABASE_ID}"
deploy/restore-d1-from-r2.sh
unset D1_RESTORE_API_TOKEN D1_RESTORE_CONFIRMATION
export D1_RESTORE_MODE=verify
```

Any new D1 migration that adds a persistent table must update the required-table allowlist in
both D1 scripts and their recovery tests before deployment; the readiness checker derives the
complete inventories from the migration chain and rejects any drift. The inventory
includes QuickBooks, customer acceptance, Newo, measurement, Facet evidence/association, approval,
governed-transition, and field Work Package ledgers. Approval binding rewrites must raise
`ABORT, 'approval_request_binding_immutable'`; approval event updates/deletes must raise
`ABORT, 'approval_request_events_immutable'` in both local export verification and remote drill proof.

Before launch, prove R2 delete protection in the live Cloudflare account. Archive the bucket-lock
rule identifiers, protected backup prefixes, retention durations, and a denied deletion of a
disposable locked canary. The lock period must cover the approved protection window but expire
at least 24 hours before scripted retention deletion. Prove the raw intake bucket's separate
retention/delete-protection policy too. Repository configuration, `--immutable`, or a dashboard
screenshot without the denied-delete result is not this gate.

When Frappe compatibility is enabled for launch, restore one explicitly selected completed Frappe
prefix to a labelled container using the recorded image digest. Its Docker network must be
internal and its ports must not be published. The target
keeps its own database configuration and credentials; `deploy/restore-from-r2.sh` merges only the
source Frappe encryption key and never installs the source `site_config_backup.json`. Verify the
database/public/private files, log in, open sample jobs/evidence, and record restore duration and
artifact checksums. A successful upload without this restore drill is not backup proof.

## 13. Launch Gate Record

| Gate | Repository evidence | Required live evidence |
| --- | --- | --- |
| Intake spine | Worker tests, typecheck, dry-run bundle | Real source reaches R2, authoritative D1, provider acknowledgement, bridge/projection where enabled, and reconciliation |
| Native operating plane | D1 migrations, Worker/PWA tests, authority/effect/gate/evidence controls | Exact D1/Worker/PWA deployment, identity, readiness, reference journey, readback, and recovery receipts |
| Frappe compatibility | DocType/policy/RBAC and projection tests | Only when enabled: app/projection identity, per-role surface, reconciliation, and rollback proof; never native authority |
| Hermes compatibility | Role/manifest and MCP tests | Only when enabled: bounded live read/draft or human-approved compatibility mutation with complete audit; never resident coordinator proof |
| Recovery | Readiness/status/replay plus encrypted D1 and conditional Frappe backup tests | Targeted replay, alerts, exact-prefix D1 verification/restore, migration-derived parity, live R2 denied-delete proof, and conditional isolated Frappe restore |
| Real sources | Intake contracts | Website, estimator, field, measurement, QB, and every enabled voice/provider-source admin proof |

Record commit, Worker/PWA deployment identity, migration state, applicable compatibility versions,
proof outputs, approver, rollback evidence, and any failed/skipped checks. Record
the exact deployed source head and rerun live proof after every production-affecting secret,
config, migration, image, or Worker-version change. Technical launch is blocked while a required
live artifact is absent. Even a complete technical launch record does not establish customer
validation or production business outcomes.
