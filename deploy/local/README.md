# Local E2E stack - IronWrap OS (dev only, never production)

One command brings up the whole owned path locally:

```bash
cd workers-bus && npm run dev
```

`predev.mjs` (wired into `npm run dev`) guarantees, idempotently:

1. `app/dist` is built (PWA served by the Worker on `http://localhost:7100`)
2. throwaway Hermes approval key material exists in `deploy/local/keys/` (gitignored)
3. the docker-compose Frappe v15 + MariaDB + Redis stack is up and answering on
   `http://localhost:8000` (the committed DocType contract is provisioned by `frappe-init.sh`)
4. `workers-bus/.dev.vars` carries the local Frappe integration API key/secret
5. every D1 migration is applied to the local Miniflare database
6. the bench copy of `ironwrap_roofing` matches the repo (a stale volume is resynced
   and the container restarted; see "App source edits vs the bench copy" below)
7. `deploy/local/keys/*-broker.env` exist for the two scripted approval brokers

Then `wrangler dev --env local --port 7100 --test-scheduled` starts: the Worker serves
the built PWA and every API route. The `local` env keeps all bridge rails OFF
(JobNimbus/Drive), turns the BFF + public estimator ON, uses Turnstile always-pass
test keys, and captures magic-link **and customer contract-acceptance** email into the
`dev_outbox` table instead of Gmail (both writers are gated on
`APP_ALLOW_INSECURE_LOCAL="true"`, which every deployed environment pins to `"false"`).

`local` also has the Facet v2 chain and the customer portal switched on:
`FACET_V2_INGEST_ENABLED`, `FACET_V2_FRAPPE_PROJECTION_ENABLED`, `APP_FACET_LAUNCH_ENABLED`,
`APP_CUSTOMER_PORTAL_ENABLED`, `APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED`. `predev.mjs`
generates the three throwaway Facet keys into `deploy/local/keys/`, provisions the scoped
`ironwrap-facet-projection@ironwrap.local` service identity, and pins the matching
`ironwrap_facet_design_projection_hmac_key` into the Frappe site config.

## Driving the Facet v2 ingest leg

The v2 delivery signature binds the request to the exact **public https origin** in
`FACET_V2_ROUTES_JSON`, so `http://localhost:7100` can never satisfy it. The local route
points at `https://bus.local.test:7443/ingest/facet-design`; run a second Worker over TLS and
resolve that name to loopback rather than editing `/etc/hosts`:

```bash
cd workers-bus && npx wrangler dev --env local --port 7443 --local-protocol https --test-scheduled
# then deliver a Facet-signed event:
curl -sS -k --resolve bus.local.test:7443:127.0.0.1 \
  -X POST https://bus.local.test:7443/ingest/facet-design \
  -H 'content-type: application/json' -H 'x-ironwrap-event-...: ...' --data-binary @event.json
```

The owner action that opens the chain is `POST /api/v1/estimator/jobs/{job}/facet-launches`
(owner session + CSRF); it registers the authority link the signed event must match.

## What you can drive end-to-end

| Flow | Entry point |
|---|---|
| Estimate spine (D1/R2 → Frappe Lead Envelope + Roof Job + gates) | `POST /ingest/estimate` (INGEST_TOKEN) |
| Public estimator-review intake (Turnstile test keys, no online price) | `POST /public/instant-estimate` |
| Magic-link sign-in (dev outbox instead of email) | `POST /api/v1/auth/magic-link/request` → `GET /admin/dev-outbox` (ADMIN_TOKEN) |
| Owner → field QR pairing → device-bound field session | `POST /api/v1/device-pairings` → `POST /api/v1/auth/device-pairing/consume` |
| Field check-in + evidence (R2 + Frappe Evidence Item) | `POST /api/v1/jobs/{job}/check-ins` (multipart) |
| Photo bridge | `POST /ingest/photo` (INGEST_TOKEN) |
| Cron sweeps | `GET /__scheduled?cron=0%208%20*%20*%20*` |
| Dead-letter replay | `POST /admin/replay` (ADMIN_TOKEN + approval context) |

## Approval brokers (Hermes approved writes)

Steps 5 and 6 of the six-step workflow (publish a proposal to the customer portal,
schedule production) are approved writes: the Worker never touches Frappe for them,
it calls a private broker that holds the Hermes signing material and its own Frappe
operator identity. **Both of those brokers are started by script.** Nothing has to be
provisioned or hand-written first:

```bash
cd workers-bus && npm run dev          # predev provisions identities + writes broker env
deploy/local/start-approval-brokers.sh # starts 9104 + 9103, waits until both answer
```

`start-local-runtime.sh` starts them too, as one supervised child, so a full local
runtime needs no separate command. Set `IRONWRAP_LOCAL_APPROVAL_BROKERS=off` to skip
them (steps 5 and 6 then have no path to Frappe).

What makes that work:

- `frappe-init.sh` provisions the four broker actor identities
  (`lead-concierge@`, `estimator-assistant@`, `production-controller@`,
  `owner-operator@ironwrap.local`) with their own API key pairs, plus the
  `owner@ironwrap.local` approver and `crew@ironwrap.local` field login. A broker
  refuses to start when its API token resolves to any user other than its configured
  actor (`frappe_service_principal_mismatch`), so these are not optional.
- `predev.mjs` generates the two Worker-to-broker shared secrets and writes
  `deploy/local/keys/proposal-publication-broker.env` and
  `production-schedule-broker.env` with matching key ids and ports for
  `wrangler.jsonc`'s `local` env (`127.0.0.1:9104` and `127.0.0.1:9103`). The keys
  directory is gitignored; every value in those files is throwaway.
- `start-approval-brokers.sh start|stop|status` manages both processes, logging to
  `.runtime-logs/<broker>-broker.log` with pids in `.runtime-logs/<broker>-broker.pid`.

The other two brokers (lead-triage on 9101, quote-revision on 9102) still need a
hand-written env file; their actor identities and API keys are provisioned for them,
so only the env file and `node src/<broker>.mjs` remain:

- lead-triage (`src/approval-broker.mjs`): role `lead-concierge`,
  `APPROVAL_BROKER_{TENANT_ID=ironwrap,KEY_ID=local-approval-broker,SHARED_SECRET,PORT}`
- quote-revision (`src/quote-revision-approval-broker.mjs`): role
  `estimator-assistant`, `QUOTE_REVISION_BROKER_*`

Read a generated env file for the exact common shape (`ERPNEXT_*`, `HERMES_*`,
`IRONWRAP_EFFECT_RUNTIME_*`); `deploy/*-approval-broker.env.example` is the production
shape and names production hosts and users, not local ones.

### Reading a broker failure

A broker answers `4xx` when it decided against the request and is unreachable when it
did not answer at all. The Worker keeps that distinction: a signature-verified `422`
surfaces the broker's own code (for example `broker_proposal_evidence_pack_not_draft`)
with HTTP 422, other verified `4xx` codes surface with 502, and only a network failure
or a `5xx` reads `*_broker_unavailable`. Before this, every non-2xx collapsed into
`*_broker_unavailable`, and finding the real reason meant instrumenting broker source
(ELEC-95).

## App source edits vs the bench copy (stale volumes)

The bench runs a **copy** of `frappe-apps/ironwrap_roofing`, not the repo mount: the
init container tars the source into `apps/ironwrap_roofing` and pip-installs that copy
as editable. A volume therefore keeps serving whatever the copy held when it was made,
which is how a seven-hour-old volume once ran a bench missing a Role that had shipped
hours earlier, with nothing in the boot output saying so (ELEC-95).

`frappe-init.sh` now compares the two trees on every start and says what it found:

- hashes agree: `app source in sync (<hash>) - no resync needed`
- hashes differ: a `STALE VOLUME DETECTED` banner naming both hashes, then a full
  resync (recopy, `pip install -e`, `bench migrate`, re-pin service identities) and a
  `RESYNC COMPLETE` banner. `predev.mjs` restarts the `frappe` container afterwards so
  the running bench actually loads the new code.

Controls, all through `IRONWRAP_LOCAL_APP_RESYNC`:

```bash
docker compose -f deploy/local/docker-compose.yml up -d frappe-init                      # detect + resync (default)
IRONWRAP_LOCAL_APP_RESYNC=force docker compose -f deploy/local/docker-compose.yml up -d frappe-init   # resync regardless
IRONWRAP_LOCAL_APP_RESYNC=off   docker compose -f deploy/local/docker-compose.yml up -d frappe-init   # refuse to boot on drift
```

`off` is for a run that must never have its bench changed underneath it: on drift the
init container exits 1 with a `REFUSING TO BOOT` banner and `frappe` does not start.
A boot that sees drift either fixes it or says so; it never continues quietly.

Any claim of the form "verified against a real site" is only as fresh as the boot that
produced it. Reading `app source in sync` or `RESYNC COMPLETE` in the `frappe-init` log
is what makes it a claim about the checkout under test:

```bash
docker compose -f deploy/local/docker-compose.yml logs frappe-init | tail -20
```

For a single-file iteration loop during debugging, `docker cp` plus
`docker restart ironwrap-local-frappe-1` is still faster - just expect the next start
to detect that edit as drift and put the bench back on the repo revision.

## Two stacks on one machine

The compose project name and the host port are both overridable, so a second stack gets
its own containers and its own volumes instead of resyncing a bench another run is
mid-proof on:

```bash
export COMPOSE_PROJECT_NAME=ironwrap-scratch IRONWRAP_LOCAL_FRAPPE_PORT=8001
docker compose -f deploy/local/docker-compose.yml up -d
```

`predev.mjs` and `start-approval-brokers.sh` both read `IRONWRAP_LOCAL_FRAPPE_PORT`
(and `IRONWRAP_LOCAL_FRAPPE_URL` respectively). Defaults are unchanged: one stack,
project `ironwrap-local`, port 8000.

## Reset

```bash
docker compose -f deploy/local/docker-compose.yml down -v   # wipe Frappe + MariaDB
rm -rf workers-bus/.wrangler/state                          # wipe local D1/R2/queues
```

`npm run dev` then reprovisions from scratch (init container re-runs, fresh keys only
if `deploy/local/keys/` is also removed).
