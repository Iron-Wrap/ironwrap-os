# IronWrap OS Launch Runbook

Production-candidate deployment guide for the owned Worker + Frappe + Hermes path.
Companion files live in `deploy/`; steady-state recovery is in
`docs/OPERATIONS-RUNBOOK.md`.

## Truth Boundary

The repository contains a locked, testable deployment contract. It does not prove that a
host, Cloudflare account, Frappe site, Hermes runtime, backups, or real source cutovers are
currently live. Keep these evidence classes separate:

| Evidence class | Required proof |
| --- | --- |
| Repository | CI, `production-readiness.mjs contract`, source tests, pinned runtime lock |
| Deployment | Image digest, site/app install output, Worker migration/deploy output |
| Runtime | `/ready`, `/admin/status`, Frappe login, Hermes read/write smoke tests |
| Admin/source | Account ownership, rotated secrets, and each enabled source/provider cutover |

Never mark launch complete from repository checks alone.

## 0. Required Access And Inputs

| Item | Why |
| --- | --- |
| Linux host meeting `deploy/runtime-lock.json` minimums | Runs Frappe and Hermes |
| Private app repository and release tag | Supplies the proprietary app without embedding credentials in the image definition |
| Container registry | Publishes the release image and yields an immutable digest |
| Cloudflare account for the configured Worker, D1, R2, Queues, DNS, and Tunnel | Owns intake, storage, recovery, and ingress |
| Frappe hostname and DNS authority | Serves the operating core over HTTPS |
| Offline `age` recipient and dedicated R2 backup credentials | Encrypts and stores recoverable backups |
| Enabled website/provider/QuickBooks/Newo admin access | Proves each enabled real-source cutover |
| Dedicated Frappe, QuickBooks issuer, bus, Hermes-approval, ingest, and backup credentials | Keeps privileges separated by purpose |

The host floor is locked at Ubuntu 22.04+, 2 CPU cores, 8 GiB RAM, 80 GiB free disk,
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

## 2. Prepare And Prove The Host

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

## 3. Publish A Tagged App Release

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

## 4. Build And Publish The Locked Frappe-Only Image

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

## 5. Create The Frappe Site

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

Log in with each IronWrap role, open the `IronWrap OS` Workspace and `IronWrap Control Center`,
and prove the role sees only permitted records. Exercise a populated job, no-job empty state,
unreachable Worker readiness state, and source-record navigation. The cockpit is read-only; a
button or network call that mutates a business record blocks launch.

`list-apps` must contain `frappe` and `ironwrap_roofing` and must not contain `erpnext`.
Create a dedicated non-interactive API user for the Worker/MCP path with the minimum IronWrap
roles required by its tools. Do not reuse the Administrator account. Store its API key and secret
only in the Worker and MCP secret stores.

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

## 6. Configure HTTPS Ingress

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

## 7. Migrate And Deploy The Worker

Set Frappe credentials with `wrangler secret put`, enable the Frappe consumer, apply every D1
migration, and deploy from the release commit:

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
npm run deploy
```

### Facet-to-Frappe Review-Projection Gate

Leave `FACET_DESIGN_FRAPPE_PROJECTION_ENABLED=false` until the `0031` D1 migration is applied in
the named environment and all of the following are proven there:

1. Create a dedicated Frappe API user with only `IronWrap Facet Design Projection Service`, pin
   its email in `ironwrap_facet_design_projection_service_user`, and set a distinct
   `ironwrap_facet_design_projection_hmac_key`. Give it no generic quote, contract, acceptance, or
   Proposal Evidence Pack write permission.
2. Store `FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY`,
   `FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY`, and
   `FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET` only with `wrangler secret put`. Do not
   reuse the Facet ingress HMAC, broad Worker/Frappe API identity, or customer-acceptance identity.
3. Submit the reviewed deployment configuration
   `FACET_DESIGN_FRAPPE_PROJECTION_ASSOCIATIONS_JSON` with schema version `1`. Each exact mapping
   includes only D1 receipt anchors plus opaque `roof_job_id` and `customer_quote_id`; it contains
   no customer names, addresses, prices, or operator-entered commercial facts. There is no mutable
   operator association API.
4. With a disposable existing Roof Job and its current `Approved` Customer Quote, prove the
   scheduled projection reads an already durable D1 receipt, accepts only an exact association,
   creates one non-customer-safe Evidence Item and one `Pending` Integration Reconciliation record,
   and leaves the quote, Contract Acceptance, and Proposal Evidence Pack unchanged. Repeat the
   exact event to prove deterministic replay; separately prove missing/mismatched mappings make no
   Frappe call and an Frappe refusal creates no Worker success.

Keep the flag false if any proof is missing. Repository tests, an ingress `202`, or a deployed D1
migration are not runtime evidence for this customer-linked projection. Archive only redacted
event/evidence/reconciliation IDs with the release evidence.

Newo production uses the managed federation and full governed control plane. Store
`NEWO_API_KEY`, `NEWO_WEBHOOK_TOKEN`, `NEWO_BOOKING_TOKEN`, and
`NEWO_CONTROL_SIGNING_SECRET` only as Cloudflare secrets after the exact target is verified.
Follow [`NEWO-PRODUCTION-RUNBOOK.md`](./NEWO-PRODUCTION-RUNBOOK.md); do not substitute
`INGEST_TOKEN`, expose a provider key to an MCP process, or enable customer outbound at launch.

Set the reviewed non-secret Worker vars `ERPNEXT_ENABLED="true"` and
`ERPNEXT_BASE_URL="https://<frappe-host>"` in the production configuration before deployment.
The legacy `ERPNEXT_*` names address the Frappe-only core; only the API key and secret are Worker
secrets. Then prove both health surfaces:

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
R2/Queue bindings plus auth, notification, JobNimbus, and enabled-Frappe configuration are
present; it returns only `{ok}` without auth and the diagnostic map only with `ADMIN_TOKEN`.
It does not contact every downstream service. `/admin/status` is the authenticated
operating view for heartbeat freshness, queue/dead-letter counts, Frappe
errors, failed/stuck replay requests, audit failures, and QuickBooks receipt freshness.
The non-secret site config lets the Control Center show the public `{ok}` result; it never
stores or uses the Worker admin token.

### QuickBooks Projection Gate

The expected realm and Frappe issuer values are deployment configuration, not proof that Intuit,
the Frappe user, or its role is live. Run the live-environment readiness check to reject missing,
malformed, reused, or mismatched values; then prove the following against the intended accounts:

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
5. Set bounded rate controls and a valid JSON rule array. Leave
   `PUBLIC_ESTIMATE_RANGE_RULES_JSON=[]` until the owner has loaded real, supplier-reviewed,
   versioned ranges using those brand keys and the tenant service ids. An empty array safely
   accepts a review request but returns no range; never deploy illustrative prices.
6. Set `ERPNEXT_INTEGRATION_USER` to the exact dedicated Worker Frappe user. When Frappe is
   enabled, the public route stays disabled until this identity is present: explicit follow-up
   consent is mirrored as append-only channel records linked to the raw R2 evidence.
7. Build the PWA and deploy the Worker, then verify `/ready` is green. A failed configuration
   returns a disabled form rather than accepting unauditable browser intake.

Use a real Turnstile test submission from the live `/estimate` route to prove the full path:
the public response must contain only acceptance, an opaque envelope id, an optional non-binding
range, and `review_required=true`. In D1/R2 and Frappe, prove the corresponding raw record,
Lead Envelope, Roof Job, Instant Estimate Session, source Evidence Item, and one
`Communication Consent` record per supplied follow-up channel. Also prove a rejected challenge,
wrong Origin, mismatched idempotency key, and rate-limited request create no accepted estimate.
Archive only redacted request ids and the release evidence.

## 8. Configure Hermes And MCP

Install Hermes at the tag and commit in `deploy/runtime-lock.json`. Register only the three MCP
servers in `hermes/mcp-servers.json`; role tool filters come from
`hermes/agents/roles.json`. MCP base URLs must be production HTTPS URLs. Plain HTTP is accepted
only for explicit localhost development.

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

The checked-in Worker baseline deliberately leaves `APP_BFF_ENABLED=false` and both app origins
blank. A successful `wrangler deploy --dry-run` proves the bundle/config shape only; it is not a
Field Companion deployment and must not be described as one.

Before enabling the BFF in the intended Cloudflare account:

1. Apply the exact D1 migration sequence remotely, including `0028_work_package_actions.sql`, then
   run the Frappe app migration so legacy Lead Envelopes become explicit `Unknown` triage rows.
   Verify `/ready` against the intended database. The 34-table backup/restore inventory must be
   deployed with the same release.
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
4. Provision one owner/ops user and one assigned field user through the guarded app-user admin
   route. Confirm office magic-link delivery, QR issue, fragment-only consume, one field read with
   `X-IronWrap-Device-Proof`, and the refusal of the same request without that proof.
5. Run the lost-device procedure in `OPERATIONS-RUNBOOK.md`: revoke the paired device, prove its
   old cookie/proof fails, then pair a replacement with a fresh QR. Archive request ids, device
   ids, and timestamps only; never archive QR URLs, tokens, or device proofs.
6. Capture real iOS and Android install/camera/share/clipboard/weak-signal evidence before any
   field-launch wording. A local build, static QR image, or a browser emulator does not close this
   gate.
7. Run one consented lead through the production sender. Archive the canonical envelope id, D1
   `lead_ack_receipts` row, provider message id, and observed timestamp; prove Owner Now labels it
   only as provider acceptance within/after 60 seconds. Do not call this delivery proof. Repeat
   with no eligible email to prove the queue shows a no-channel exception rather than a false
   “sent” result. For an intentionally rejected staging send, wait past the 60-second deadline
   and prove the queue shows an unproven exception.

### Production Schedule Approval Enablement Gate

The Production Runway remains a read surface until this gate closes. A local
broker test, a Worker bundle, or a populated schedule card is not permission to
dispatch a crew or call a production assignment live.

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

### Customer Portal and Contract-Acceptance Enablement Gate

The checked-in customer portal is a disabled, read-only capability foundation. A separate,
also-disabled, email-bound click-to-accept route may move one approved quote to `Accepted` only
after it pins the current quote, approved proposal pack, and canonical terms snapshot. The portal
bearer itself remains read-only and is never customer authentication or acceptance evidence.

Neither route is a public estimate widget, customer session, document-download service, payment
flow, generic commercial e-sign service, deposit collection, or delivery proof. They show only
customer-safe projected summaries; raw storage keys, Drive links, field notes, unapproved
estimates, and office session data never cross the public boundary.

Before enabling it in the intended Cloudflare account:

1. Apply the migration sequence through `0029_customer_contract_acceptance.sql` with the same
   release and prove `/ready` against the migrated D1 database. Keep both
   `APP_CUSTOMER_PORTAL_ENABLED=false` and `APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED=false` until
   their respective gates below are complete.
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

1. Provision a dedicated Frappe API user with only the `IronWrap Customer Acceptance Service`
   role, pin its email in `ironwrap_customer_acceptance_service_user`, and use its API key/secret
   only for the two customer-acceptance methods. Do not reuse the broad Worker BFF identity.
2. Set a distinct `APP_CUSTOMER_ACCEPTANCE_HMAC_KEY` in the Worker and the matching
   `ironwrap_customer_acceptance_hmac_key` Frappe site config. Set the dedicated
   `APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY` and
   `APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_SECRET` as Worker secrets. The HMAC timestamp/nonce window,
   service user, and service role must all fail closed.
3. Configure the approved Gmail sender and exact HTTPS `APP_PUBLIC_ORIGIN`. The email must use
   `https://<origin>/contract-accept#token=...`; do not log, screen-capture, or place that token in
   a query string, path, ticket, or browser recording. Provider message acceptance is not delivery
   evidence.
4. With a disposable linked Roof Job, approved Customer Quote, and approved Proposal Evidence
   Pack, prove the email challenge stores only hashes in D1, rejects cookie-only and wrong-origin
   requests, and exposes no raw email or token in the ledger or response. Change the quote terms,
   proposal state, or customer email after challenge issuance and prove confirmation is rejected.
5. Confirm once through the email fragment, then prove same-token and conflicting-idempotency
   retries cannot create another acceptance. Verify R2 receipt storage precedes the one Frappe
   transaction that creates the verified Evidence Item and Contract Acceptance and changes the
   quote from `Approved` to `Accepted` with the exact locked anchors. Force an ambiguous Frappe
   transport result and prove it ends `uncertain` without replaying the customer write.

This proof is still open until it runs in the named Cloudflare, Frappe, R2, and Gmail environment.
Do not call the repository slice a legal signature determination, a received-email proof, a paid
deposit, or a preconstruction release.

Do not add proof-photo/download, invoice, warranty-file, or proposal-file URLs to this route
without a separate short-lived attachment-authorization design and browser proof. The private
`/ingest/estimate` route remains bearer-authenticated; public estimation is limited to the
separate review-gated `/public/instant-estimate` contract above.

## 10. Prove The End-To-End Intake Slice

Before executing the proof, create a separate non-Desk Frappe API user with only the
`IronWrap Launch Proof Reader` role. That role may read only `Instant Estimate Session`; do not
assign it Lead Envelope, Roof Job, Roofing Customer, or any other IronWrap role. Pin that exact
user in the Frappe site config key `ironwrap_launch_proof_reader_user`, and use only that user's
API key/secret as `FRAPPE_API_KEY` and `FRAPPE_API_SECRET`. Set `FRAPPE_BASE_URL`,
`FRAPPE_PROOF_POLL_ATTEMPTS`, and `FRAPPE_PROOF_POLL_INTERVAL_MS` from the launch-proof block in
`deploy/env.example`; do not reuse the Worker integration credential pair.

```bash
node tools/launch-proof.mjs
BUS_BASE_URL=... INGEST_TOKEN=... ADMIN_TOKEN=... FRAPPE_BASE_URL=... FRAPPE_API_KEY=... FRAPPE_API_SECRET=... node tools/launch-proof.mjs --execute > launch-proof-evidence.json
```

The dry run makes no network request. Execute mode refuses to send even a synthetic POST unless
the bounded Frappe proof configuration is complete. Before it contacts the bus, it makes one
GET-only lookup for its fresh correlation and requires the configured reader to return `pending`;
a missing site-config pin, wrong API identity, missing role, or inaccessible estimate session fails
before a synthetic POST. It then proves `/health` and every `/ready` check before it creates a
fixture; verifies website intake, estimator idempotency, admin read-back, reconciliation, and a
fresh/reconciled `/admin/status`; and finally polls the GET-only synthetic Frappe correlation
endpoint at most five times. The artifact contains only redacted evidence and response request ids;
do not add tokens, raw Frappe responses, or document data to it.

A matched synthetic Frappe projection is evidence only: it does not retire JobNimbus, GHL, or any
other bridge. A missing, mismatched, timed-out, or unavailable projection writes its redacted
artifact with `bridge_keep_enabled=true` and `reconciliation_required=true`, then makes
`node tools/launch-proof.mjs --execute` exit non-zero. Preserve that artifact for reconciliation;
it is failed proof evidence, not a green launch gate. Reconcile it before any cutover decision.

Archive `launch-proof-evidence.json` with the release commit and image digest. Verify the fixture
in D1/R2 and in Frappe as Lead Envelope, Roofing Customer/Property, Roof Job, and seven Production
Gate State rows. Remove or clearly label fixture records after proof.

## 11. Cut Over Real Sources

| Source | Runtime proof |
| --- | --- |
| Website | Real consented submission reaches `/ingest/website`, raw R2, D1, Frappe, provider-acceptance receipt (not delivery proof), and temporary JobNimbus bridge |
| Public estimator | Live `/estimate` Turnstile challenge and exact-origin POST create a raw-first, idempotent, review-gated session; the response leaks no submitted PII and explicit follow-up consent is mirrored with source evidence |
| 3D estimator handoff | Repeated private `/ingest/estimate` idempotency key returns the original session and remains review-gated |
| Jotform field intake | Device submission reaches `/ingest/photo`, Drive/R2, evidence, and check-in with photos plus one voice note |
| RoofRuler/AppliCad | `/ingest/measurement` records one hashed receipt per provider/idempotency identity, stores raw source first, routes no-job or unresolved-job reports and retryable failures to `/admin/measurements/exceptions`, sequentially re-drives verified raw sources with bounded backoff, and keeps uncertain values review-gated |
| QuickBooks | Expected-realm signed event produces raw R2, a D1 receipt plus durable projection row, and one Pending Frappe reconciliation; invalid signatures and other realms are rejected, and provider facts remain unproven until read-back |
| Newo receptionist | Approved real call produces `raw/newo/` R2, event receipt, distinct reception session, lead envelope when applicable, Frappe landing, downstream result, and operator status; same-caller second calls remain distinct sessions; report omission and failed transfer become owned exceptions |

JobNimbus and GHL remain bridges until each replacement slice has live evidence. SMS remains
record-only until A2P/carrier approval. QuickBooks remains accounting truth.

## 12. Backups And Restore Drill

Fill only the nightly backup inputs from `deploy/env.example` in
`/etc/ironwrap/backup.env`, owned by root and mode `0600`. `IRONWRAP_OS_IMAGE` must be the
deployed image digest and `BACKUP_AGE_RECIPIENT` must be an offline public recipient.
`D1_BACKUP_API_TOKEN` is the persisted read/export-only authority; keep it distinct from the
backup-only R2 access/secret key pair. Never store `D1_RESTORE_API_TOKEN` in that file: inject
its separate drill/write authority just-in-time for one remote restore and unset it afterward.
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

The first manual run must succeed in that order. Schedule the canonical D1 export first and the
Frappe operational backup 20 minutes later. They are independent jobs so a D1 failure cannot
silently suppress the Frappe attempt:

```bash
CRON_TZ=UTC
5 9 * * * /bin/bash -c 'set +x; set -a; . /etc/ironwrap/backup.env; set +a; exec /opt/ironwrap/deploy/backup-d1-to-r2.sh' >> /var/log/ironwrap-d1-backup.log 2>&1
25 9 * * * /bin/bash -c 'set +x; set -a; . /etc/ironwrap/backup.env; set +a; exec /opt/ironwrap/deploy/backup-to-r2.sh' >> /var/log/ironwrap-frappe-backup.log 2>&1
```

`backup-d1-to-r2.sh` is bound to Cloudflare account
`7ee5775bc1ba46f05c5a65235b60e939`, database `ironwrap-bus`, and UUID
`f0674848-13df-4422-9896-8ba2719663b8`. It runs locked Wrangler `d1 export --remote`, imports
the SQL into isolated SQLite, checks integrity and all 34 release-state tables,
plus the 43 release-state invariant trigger bindings, packages manifest plus SQL, encrypts
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
table-to-row-count map for all 34 required tables and the exact 43 trigger-to-table bindings
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
both D1 scripts and their readiness tests before deployment. Any migration that adds or changes
an invariant trigger must update the trigger inventory too. The current 34-table inventory includes
the QuickBooks projection outbox, approval ledgers, governed-transition/outbox tables, and the `field_work_package_actions`
ledger; it is enforced by the two scripts rather than this prose list. The 43 required triggers
include source-count validation, immutable lead-ack receipts, the three approval ledgers, and the
governed-transition outbox rules. Approval binding rewrites must raise
`ABORT, 'approval_request_binding_immutable'`; approval event updates/deletes must raise
`ABORT, 'approval_request_events_immutable'` in both local export verification and remote drill proof.

Before launch, prove R2 delete protection in the live Cloudflare account. Archive the bucket-lock
rule identifiers, protected backup prefixes, retention durations, and a denied deletion of a
disposable locked canary. The lock period must cover the approved protection window but expire
at least 24 hours before scripted retention deletion. Prove the raw intake bucket's separate
retention/delete-protection policy too. Repository configuration, `--immutable`, or a dashboard
screenshot without the denied-delete result is not this gate.

Before launch, restore one explicitly selected completed Frappe prefix to a labelled container using the recorded
image digest. Its Docker network must be internal and its ports must not be published. The target
keeps its own database configuration and credentials; `deploy/restore-from-r2.sh` merges only the
source Frappe encryption key and never installs the source `site_config_backup.json`. Verify the
database/public/private files, log in, open sample jobs/evidence, and record restore duration and
artifact checksums. A successful upload without this restore drill is not backup proof.

## 13. Launch Gate Record

| Gate | Repository evidence | Required live evidence |
| --- | --- | --- |
| Intake spine | Worker tests, typecheck, dry-run bundle | Real source reaches R2, D1, Frappe, ack, bridge, reconcile |
| Operating core | 50 DocTypes (42 top-level + 8 child), policy/RBAC tests, Workspace/Control Center package proof | App installed on plain Frappe; fixture, per-role cockpit, empty/error/readiness, and source-navigation checks pass |
| Read-only Hermes | Role/manifest and MCP tests | Owner query uses live truth with zero writes |
| Approved write | Dry-run/request contracts and idempotency tests | One human-approved mutation and complete `Hermes Run` audit |
| Recovery | Readiness/status/replay plus encrypted Frappe/D1 backup tests | Targeted replay, alerts, exact-prefix local verification, isolated Frappe and D1 restores, table row-count, trigger-inventory, and receipt-semantics parity, and live R2 denied-delete proof |
| Real sources | Intake contracts | Website, estimator, field, measurement, QB, and every enabled voice/provider-source admin proof |

Record commit, image digest, Worker deployment version, migration state, Frappe site/app versions,
Hermes version, proof outputs, approver, and any failed/skipped checks. Launch is blocked while a
required live artifact is absent.
