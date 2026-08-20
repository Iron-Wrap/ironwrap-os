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

The four private brokers run against the local Frappe stack on `127.0.0.1:9101-9104`.
Each needs its own Frappe identity (the API token's user must equal the actor user -
`frappe_service_principal_mismatch` otherwise) and the shared key material in
`deploy/local/keys/`. Provision once per fresh site:

```bash
# role users (owner@, crew@ are only needed for BFF/field flows)
docker exec -i ironwrap-local-frappe-1 bash -lc \
  'cd /home/frappe/frappe-bench && bench --site ironwrap.localhost console' <<'PYEOF'
import frappe
for email in ["lead-concierge@ironwrap.local", "estimator-assistant@ironwrap.local",
              "production-controller@ironwrap.local", "owner-operator@ironwrap.local",
              "owner@ironwrap.local", "crew@ironwrap.local"]:
    if not frappe.db.exists("User", email):
        u = frappe.get_doc({"doctype": "User", "email": email, "first_name": email.split("@")[0],
                            "send_welcome_email": 0, "roles": [{"role": "System Manager"}]})
        u.insert(ignore_permissions=True)
for email in ["lead-concierge@ironwrap.local", "estimator-assistant@ironwrap.local",
              "production-controller@ironwrap.local", "owner-operator@ironwrap.local"]:
    frappe.core.doctype.user.user.generate_keys(email)
frappe.db.commit()
print("users ok")
PYEOF
```

Broker env (one file per broker, secrets sourced from `workers-bus/.dev.vars`; keep
them out of git - `*.env` is ignored):

- common: `ERPNEXT_BASE_URL=http://localhost:8000`, `ERPNEXT_ALLOW_INSECURE_LOCAL=true`,
  `ERPNEXT_WRITE_ENABLED=true`, `HERMES_ROLE_POLICY_PATH=<repo>/hermes/agents/roles.json`,
  `HERMES_DRY_RUN_SIGNING_KEY=$(cat deploy/local/keys/dry-run-signing-key.txt)`,
  `HERMES_APPROVAL_PUBLIC_KEY_FILE` / `HERMES_APPROVAL_PRIVATE_KEY_FILE` (deploy/local/keys),
  `HERMES_APPROVER_ID=owner@ironwrap.local`
- lead-triage (`src/approval-broker.mjs`, port 9101): role `lead-concierge`,
  `APPROVAL_BROKER_{TENANT_ID=ironwrap,KEY_ID=local-approval-broker,SHARED_SECRET,PORT}`
- quote-revision (`src/quote-revision-approval-broker.mjs`, port 9102): role
  `estimator-assistant`, `QUOTE_REVISION_BROKER_*`
- production-schedule (`src/production-schedule-approval-broker.mjs`, port 9103): role
  `production-controller`, `PRODUCTION_SCHEDULE_BROKER_*`
- proposal-publication (`src/proposal-publication-approval-broker.mjs`, port 9104): role
  `owner-operator`, `PROPOSAL_PUBLICATION_BROKER_*`. This is the one that turns a Draft
  Proposal Evidence Pack into a customer-visible proposal, so the local stack also needs
  `APP_PROPOSAL_PUBLICATION_ENABLED=true` (already set for `--env local`) and an
  `owner-operator@ironwrap.local` Frappe user with generated API keys.

Start: `cd mcp/erpnext-roofing-mcp && set -a && source <env-file> && set +a && node src/<broker>.mjs`

## App source edits vs the bench copy

`frappe-init.sh` copies `frappe-apps/ironwrap_roofing` into the bench at provision time
(pip editable install of that copy). After editing the app's Python/JSON, sync + restart:

```bash
docker cp frappe-apps/ironwrap_roofing/ironwrap_roofing/<file> \
  ironwrap-local-frappe-1:/home/frappe/frappe-bench/apps/ironwrap_roofing/ironwrap_roofing/<file>
docker restart ironwrap-local-frappe-1
```

(DocType schema changes additionally need `bench --site ironwrap.localhost migrate`.)

## Reset

```bash
docker compose -f deploy/local/docker-compose.yml down -v   # wipe Frappe + MariaDB
rm -rf workers-bus/.wrangler/state                          # wipe local D1/R2/queues
```

`npm run dev` then reprovisions from scratch (init container re-runs, fresh keys only
if `deploy/local/keys/` is also removed).
