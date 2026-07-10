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
| Admin/source | Account ownership, rotated secrets, website/Make/Jotform/QB cutover |

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
| Website/Make/Jotform/QuickBooks admin access | Proves real-source cutover |
| Dedicated Frappe, bus, Hermes-approval, ingest, and backup credentials | Keeps privileges separated by purpose |

The host floor is locked at Ubuntu 22.04+, 2 CPU cores, 8 GiB RAM, 80 GiB free disk,
Node.js 20+, and either `x86_64` or `aarch64`. Capacity is a floor, not a sizing promise.

## 1. Prove The Repository Contract

From a clean checkout of the release commit:

```bash
node tools/production-readiness.mjs contract
node --test tools/production-readiness.test.mjs
```

The contract checks the exact Frappe, frappe_docker, and Hermes tags/commits; digest-pinned
base images; Frappe-only policy; credential-free app manifest; strict deploy scripts;
encrypted backup protocol; and the environment-name inventory. A failure blocks image build.

## 2. Prepare And Prove The Host

Install Docker with Compose v2, Git, Node.js, `age`, `curl`, `jq`, `openssl`, `rclone`,
`sha256sum`, and `tar`. Ensure the Docker daemon is reachable by the deployment account and
the host clock is synchronized. Then run:

```bash
deploy/host-preflight.sh
```

The preflight reads only `deploy/runtime-lock.json`; it accepts no command-line configuration
and does not print the environment. Do not continue until every host check passes.

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

Use the compose topology from the pinned frappe_docker checkout, replacing the backend/frontend
image with the digest-pinned IronWrap image. Persist MariaDB, sites, logs, and Redis according to
the pinned upstream configuration. Create the site and install only the proprietary app:

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
cd workers-bus
npm ci
npm run typegen
npm test
npm run typecheck
npm run deploy -- --dry-run
npx wrangler secret put ERPNEXT_BASE_URL
npx wrangler secret put ERPNEXT_API_KEY
npx wrangler secret put ERPNEXT_API_SECRET
npm run db:migrate
npm run deploy
```

Set `ERPNEXT_ENABLED="true"` in the deployed Worker configuration. Then prove both health
surfaces:

```bash
curl --fail --silent --show-error "$BUS_BASE_URL/health"
curl --fail --silent --show-error "$BUS_BASE_URL/ready"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BUS_BASE_URL/admin/status"
docker exec <backend> bench --site os.ironwrapexteriors.com set-config \
  ironwrap_bus_base_url "$BUS_BASE_URL"
```

`/health` proves isolate liveness only. `/ready` queries the D1 operational schema and checks that
R2/Queue bindings plus auth, notification, JobNimbus, and enabled-Frappe configuration are
present; it does not contact every downstream service. `/admin/status` is the authenticated
operating view for heartbeat freshness, queue/dead-letter counts, Frappe
errors, failed/stuck replay requests, audit failures, and QuickBooks receipt freshness.
The non-secret site config lets the Control Center show the public `/ready` result; it never
stores or uses the Worker admin token.

## 8. Configure Hermes And MCP

Install Hermes at the tag and commit in `deploy/runtime-lock.json`. Register only the two MCP
servers in `hermes/mcp-servers.json`; role tool filters come from
`hermes/agents/roles.json`. MCP base URLs must be production HTTPS URLs. Plain HTTP is accepted
only for explicit localhost development.

Keep both write flags false for the first read-only smoke test:

```bash
node tools/validate-hermes-config.mjs
```

Ask the owner-operator profile for bus readiness, operational status, and blocked jobs. Confirm
that no mutation or `Hermes Run` was created. For the approved-write proof, enable only the one
required write surface, use a stable unique `run_id`, execute the matching dry-run, obtain human
approval, and invoke the request tool with the approval token. Repeating the same completed
Frappe `run_id` must return its recorded result without repeating the business mutation.

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

## 10. Prove The End-To-End Intake Slice

```bash
node tools/launch-proof.mjs
BUS_BASE_URL=... INGEST_TOKEN=... ADMIN_TOKEN=... node tools/launch-proof.mjs --execute
```

Archive the output with the release commit and image digest. Verify the fixture in D1/R2 and in
Frappe as Lead Envelope, Roofing Customer/Property, Roof Job, and seven Production Gate State
rows. Run `POST /admin/reconcile`, then confirm `/admin/status` reports the new heartbeat and no
unexplained gaps. Remove or clearly label fixture records after proof.

## 11. Cut Over Real Sources

| Source | Runtime proof |
| --- | --- |
| Website | Real consented submission reaches `/ingest/website`, raw R2, D1, Frappe, ack, and temporary JobNimbus bridge |
| 3D estimator | Repeated `/ingest/estimate` idempotency key returns the original session and remains review-gated |
| Jotform field intake | Device submission reaches `/ingest/photo`, Drive/R2, evidence, and check-in with photos plus one voice note |
| RoofRuler/AppliCad | `/ingest/measurement` stores raw source and source-referenced values; uncertain values remain review-gated |
| QuickBooks | Valid signed webhook receipt is visible in `/admin/status`; invalid signature is rejected |

JobNimbus and GHL remain bridges until each replacement slice has live evidence. SMS remains
record-only until A2P/carrier approval. QuickBooks remains accounting truth.

## 12. Backups And Restore Drill

Fill the backup block from `deploy/env.example`; `IRONWRAP_OS_IMAGE` must be the deployed image
digest and `BACKUP_AGE_RECIPIENT` must be an offline public recipient. Schedule:

```bash
15 9 * * * /opt/ironwrap/deploy/backup-to-r2.sh >> /var/log/ironwrap-backup.log 2>&1
```

The script creates a complete Frappe backup set, packages a restore manifest, encrypts locally,
uploads immutably, verifies the remote objects, publishes `IRONWRAP-BACKUP-COMPLETE` last, and
only then applies retention. A prefix without that marker is incomplete and must never be used
for restore. At expiry, retention removes the marker before deleting the encrypted data one hour
later, so a committed marker can never point at already-deleted backup content.

Before launch, restore the newest completed prefix to a labelled container using the recorded
image digest. Its Docker network must be internal and its ports must not be published. The target
keeps its own database configuration and credentials; `deploy/restore-from-r2.sh` merges only the
source Frappe encryption key and never installs the source `site_config_backup.json`. Verify the
database/public/private files, log in, open sample jobs/evidence, and record restore duration and
artifact checksums. A successful upload without this restore drill is not backup proof.

## 13. Launch Gate Record

| Gate | Repository evidence | Required live evidence |
| --- | --- | --- |
| Intake spine | Worker tests, typecheck, dry-run bundle | Real source reaches R2, D1, Frappe, ack, bridge, reconcile |
| Operating core | 33 DocTypes, policy/RBAC tests, Workspace/Control Center package proof | App installed on plain Frappe; fixture, per-role cockpit, empty/error/readiness, and source-navigation checks pass |
| Read-only Hermes | Role/manifest and MCP tests | Owner query uses live truth with zero writes |
| Approved write | Dry-run/request contracts and idempotency tests | One human-approved mutation and complete `Hermes Run` audit |
| Recovery | Readiness/status/replay/backup tests | Targeted replay, alert recovery, and isolated restore drill |
| Real sources | Intake contracts | Website, estimator, field, measurement, and QB admin proofs |

Record commit, image digest, Worker deployment version, migration state, Frappe site/app versions,
Hermes version, proof outputs, approver, and any failed/skipped checks. Launch is blocked while a
required live artifact is absent.
