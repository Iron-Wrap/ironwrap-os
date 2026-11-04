# Local E2E stack - IronWrap OS (dev only, never production)

Run the Worker and built PWA against local D1/R2/queue state:

```bash
cd workers-bus && npm run dev
```

`predev.mjs` (wired into `npm run dev`) guarantees, idempotently:

1. `app/dist` is built (PWA served by the Worker on `http://localhost:7100`, or on
   `IRONWRAP_LOCAL_WORKER_PORT` - see "Two stacks on one machine")
2. the compatibility receipt verifier public key exists in `deploy/local/keys/` (gitignored).
   Fresh preflight keeps only the public half of an ephemeral pair. Existing key files are preserved.
3. `workers-bus/.dev.vars` exists - on a fresh checkout it is scaffolded from
   `.dev.vars.example`, so `ADMIN_TOKEN`, `INGEST_TOKEN` and `APP_AUTH_PEPPER` are already
   there rather than a hand-add step - and carries the throwaway local keys plus the
   host-port-bearing values (`APP_PUBLIC_ORIGIN` and its allowlist, and the inert
   `ERPNEXT_BASE_URL`) that override `wrangler.jsonc`'s single-stack defaults.
   Existing operator values are preserved outside generated bindings. Preflight also clears
   retired broker overrides in existing files.
4. every D1 migration is applied to the local Miniflare database

Frappe is decommissioned, not migrated: there is no local Frappe stack, Docker is not needed, and
the `local` env keeps `ERPNEXT_ENABLED` and the Frappe projection off.

Then `wrangler dev --env local --port 7100 --test-scheduled` starts (the port follows
`IRONWRAP_LOCAL_WORKER_PORT`): the Worker serves
the built PWA and every API route. The `local` env keeps all bridge rails OFF
(JobNimbus/Drive), turns the BFF + public estimator ON, uses Turnstile always-pass
test keys, and captures magic-link **and customer contract-acceptance** email into the
`dev_outbox` table instead of Gmail (both writers are gated on
`APP_ALLOW_INSECURE_LOCAL="true"`, which every deployed environment pins to `"false"`).

`local` has native Facet v2 ingest/launch and the customer portal switched on:
`FACET_V2_INGEST_ENABLED`, `APP_FACET_LAUNCH_ENABLED`, `APP_CUSTOMER_PORTAL_ENABLED`, and
`APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED`. The Frappe projection flag
`FACET_DESIGN_FRAPPE_PROJECTION_ENABLED` is default-off (`false`) in every checked-in
environment, including local, and no local Frappe site exists to receive it. `predev.mjs`
generates the three throwaway Facet keys into `deploy/local/keys/`. The Worker still carries the
projection code until its own removal: for `approved`/`corrected` it would create a blank,
non-customer-safe `Draft` Customer Quote; on every chain advance it marks the predecessor projected quote
`Rejected` and creates a replacement only for an active decision. The
compatibility draft supplies no price, line items, taxes, payment schedule, or commercial terms.

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
| Estimate spine (D1/R2 native records) | `POST /ingest/estimate` (INGEST_TOKEN) |
| Public estimator-review intake (Turnstile test keys, no online price) | `POST /public/instant-estimate` |
| Magic-link sign-in (dev outbox instead of email) | `POST /api/v1/auth/magic-link/request` → `GET /admin/dev-outbox` (ADMIN_TOKEN) |
| Owner → field QR pairing → device-bound field session | `POST /api/v1/device-pairings` → `POST /api/v1/auth/device-pairing/consume` |
| Field check-in + evidence (R2 + D1) | `POST /api/v1/jobs/{job}/check-ins` (multipart) |
| Photo bridge | `POST /ingest/photo` (INGEST_TOKEN) |
| Cron sweeps | `GET /__scheduled?cron=0%208%20*%20*%20*` |
| Dead-letter replay | `POST /admin/replay` (ADMIN_TOKEN + approval context) |

## Starting the local runtime

`bash start-local-runtime.sh` supervises the Worker, app development server and synthetic ERP
stub. The optional agent host is enabled with `IRONWRAP_LOCAL_AGENT_HOST=on`.

The ERPNext approval broker package is retired. Local launchers leave the historical broker
connections and their feature gates off. Use native Worker paths for supported office and field
work, including native D1 scheduling. Legacy broker-backed lead triage, quote revision, proposal
publication and schedule writes are outside this local launch path. The Worker retains historical
approval records and reconciliation controls.

The surviving MCP servers use stdio and are spawned by their clients. When a local MCP client
must use the Worker bus, pin one known-free port in the parent shell:

```bash
export HERMES_BUS_PORT=8787
export IRONWRAP_BUS_BASE_URL="http://localhost:$HERMES_BUS_PORT"
bash start-local-runtime.sh
```

See `mcp/ironwrap-bus-mcp/README.md` for the client's local authentication variables.

## Two stacks on one machine

Every host port the Worker binds is overridable, so a second stack gets its own port instead
of answering with the first stack's data. Export the port variable and run the second stack
from its own checkout:

| Variable | Default | Moves |
|---|---|---|
| `IRONWRAP_LOCAL_WORKER_PORT` | `7100` | `wrangler dev`'s port, `APP_PUBLIC_ORIGIN`, `APP_ALLOWED_ORIGINS`, `PUBLIC_ESTIMATE_ALLOWED_ORIGINS` |
| `IRONWRAP_LOCAL_FRAPPE_PORT` | `8000` | only the inert `ERPNEXT_BASE_URL` (no Frappe stack runs) |

```bash
export IRONWRAP_LOCAL_WORKER_PORT=7101
cd workers-bus && npm run dev          # same shell, so predev sees it
```

`wrangler.jsonc` is static JSON and cannot read the environment, so the `local` env still
pins the single-stack defaults. `predev.mjs` re-declares every port-bearing value into
`workers-bus/.dev.vars`, which `wrangler dev` loads **over** the config's `vars`. The bindings
table `wrangler dev` prints at start-up shows an overridden var as `(hidden)`; one still printed
in the clear comes straight from `wrangler.jsonc`. If `APP_PUBLIC_ORIGIN` prints in the clear,
the variable was not exported in the shell that ran `npm run dev`; re-export and re-run rather
than hand-editing `.dev.vars` (predev rewrites those lines on every boot).

Two things stay single-stack on purpose: the optional TLS Worker for the Facet v2 ingest
leg (`--port 7443`, above - pass a different `--port` and matching `FACET_V2_ROUTES_JSON`
if a second one is needed), and `.wrangler/state` plus `deploy/local/keys/`, which are
per-checkout rather than per-port. Run the second stack from a second checkout.

## Reset

```bash
rm -rf workers-bus/.wrangler/state                          # wipe local D1/R2/queues
```

`npm run dev` then reapplies every migration (fresh keys only if `deploy/local/keys/` is also
removed).
