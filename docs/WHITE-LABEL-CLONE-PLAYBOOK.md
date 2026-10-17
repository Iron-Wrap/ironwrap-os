# White-Label Tenant Clone Playbook

How to stand up a second contractor ("tenant") on the IronWrap OS stack with fully isolated
brand, config, data, and tools. Acceptance requires a demo tenant to run end to end on its own
copies of everything, with zero shared state with the live IronWrap tenant.

Authority: `docs/AUTONOMOUS-OPERATING-SYSTEM.md`,
`docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md`, and the second-tenant production-proof requirement in
`docs/CAPABILITY-MATRIX.md`.

## Isolation Model

One of each, per contractor. Nothing is shared. Multi-tenant consolidation remains deferred until
the cloneable shape is proven with isolation, export, restore, and negative cross-tenant tests.

| Layer | Per-tenant unit | Repo artifact |
| --- | --- | --- |
| Frappe (IronWrap OS) | One plain Frappe site (never install the erpnext app) | `frappe-apps/ironwrap_roofing` installed per site |
| Hermes | One Hermes profile (own memory, skills, MCP allowlist) | MCP env vars below |
| Cloudflare | One Worker + D1 + R2 + queues + secrets set | `workers-bus/wrangler.jsonc` |
| Storage | One Drive namespace (Shared Drives) + raw and privacy R2 buckets | `SHARED_DRIVE_ID_*` vars, `RAW` and `PRIVACY_LEDGER` bindings |
| Accounting | One QuickBooks connection (own realm, verifier, and bounded Frappe issuer) | `QB_EXPECTED_REALM_ID`, `QB_WEBHOOK_TOKEN`, and tenant-only issuer credentials |
| Brand | One brand/template pack + tenant config | `config/tenants/<tenant>.json` |

Why isolation first: the risk register lists "Tenant leakage" as a product-killing risk.
Site/profile/namespace isolation is the control.

## The Automated Path

Everything below that a laptop can prove is now a script. `deploy/clone-tenant.sh` renders the
tenant config, provisions the tenant's own Frappe site on the local compose stack, derives the
tenant's Worker config and secrets, applies the migration chain to the tenant's local D1, and
runs the validators. `deploy/tenant-leakage-checks.sh` then runs the eight checks below against
the two tenants standing side by side.

```bash
cp deploy/templates/tenant-answers.example.json my-tenant.json   # then edit every value
deploy/clone-tenant.sh --tenant <tenant> --answers my-tenant.json \
  --worker-port 7200 --broker-port-base 9200

# start the tenant Worker with the command the script prints, then:
deploy/tenant-leakage-checks.sh --tenant-a ironwrap --tenant-b <tenant>
```

What it produces, and where the manual steps below still apply:

| Step | Automated | Still manual |
| --- | --- | --- |
| 1 tenant config | `tools/generate-tenant-config.mjs` renders `config/tenants/<tenant>.json` from `deploy/templates/tenant-config.template.json` and refuses a tenant id or sender domain another tenant already owns | the answers themselves (brand, service areas, supplier, review links) |
| 2 Cloudflare namespace | `tools/generate-tenant-worker-config.mjs` derives `workers-bus/wrangler.<tenant>.jsonc` from the shipped config, re-points every binding onto `<tenant>-*` resources, and fails if any var still names the source tenant | creating the real account resources, pasting the D1 `database_id`, and `wrangler secret put` (step 2 below) |
| 3 Frappe site | one `bench new-site` on the local compose stack, with all thirteen identities on the tenant's own `@<tenant>.local` domain and every site-config pin applied | a production Frappe host, and the tenant's own blessed workflow-profile and locale-policy values |
| 4 Drive | nothing: the tenant Worker ships with no Shared Drive id at all | all of step 4 |
| 5 QuickBooks | nothing: `QB_EXPECTED_REALM_ID` ships empty | all of step 5 |
| 6 Hermes / MCP | nothing | all of step 6 |

The script provisions **no infrastructure**. It calls no Cloudflare, Google or Intuit API; the
owner steps are printed as a `HAND-OFF` list at the end of the run and are exactly the rows above.

Two facts about the local stack that the script depends on, and that a hand-run should know:

- **One bench, one site per tenant.** The tenant site is `<tenant>.localhost` on the same
  compose stack and the same host port; Frappe v15 resolves the site from the Host header, and
  every `*.localhost` name resolves to loopback without touching `/etc/hosts`. Separate
  databases, separate users, separate API keys. Only the default site owns the bare `localhost`
  alias, so a clone can never move the first tenant's Worker onto the second tenant's Frappe.
- **`IRONWRAP_LOCAL_IDENTITY_DOMAIN`** selects the domain a site's non-interactive identities
  live on (default `ironwrap.local`). A clone uses `<tenant>.local`, which is what keeps the
  tenant's `ERPNEXT_INTEGRATION_USER` and `QB_RECONCILIATION_ISSUER_USER` from naming another
  tenant's identity.
- **The compose stack is profile-gated, so every command that starts it passes
  `--profile frappe`.** All five services in `deploy/local/docker-compose.yml` carry
  `profiles: [frappe]`, and `docker compose up -d` without the flag selects nothing and exits
  with `no service selected`. `deploy/clone-tenant.sh` and `deploy/local/predev.mjs` both pass
  it; a hand-run has to as well:

  ```bash
  docker compose -f deploy/local/docker-compose.yml --profile frappe up -d
  docker compose -f deploy/local/docker-compose.yml --profile frappe logs -f frappe-init
  ```

  `docker compose exec` and `restart` reach an already-running service by name and do not need
  the flag. Do not reach for `COMPOSE_PROFILES=frappe` in the environment instead: it works,
  but it makes the requirement invisible to the next reader of the script.

## Clone Steps

These are the authority for what a clone IS, and the fallback for anything the script cannot
reach. Assume the new tenant id is `<tenant>` (examples already in repo: `demo-exteriors`,
hand-written; `northline-metal`, rendered by the automated path above).

### 1. Tenant config

1. Copy `config/tenants/demo-exteriors.json` to `config/tenants/<tenant>.json`.
2. Fill in: `tenant.id` (unique), `runtime.app_tenant_name`, brands with their own `sender_mailbox` and `sender_domain`
   (must not overlap any other tenant's domains), service areas, services, suppliers,
   milestones, gates.
3. Secrets stay out: the config carries env var NAMES only (`*_env` fields).
4. Validate: `node tools/validate-tenant-config.mjs` must print
   `ok N tenant configs validated`. The validator enforces id uniqueness, sender-domain
   isolation, CASL consent, quiet hours sanity, price-free public estimator intake, the 7
   production gates, the approval policy, runtime tenant naming, and a no-secret-values scan.

### 2. Cloudflare namespace (Worker + data plane)

Duplicate `workers-bus/wrangler.jsonc` into a tenant-suffixed config (or a separate
Wrangler environment) and re-point every binding at NEW tenant-owned resources:

1. `name`: `<tenant>-bus` (new Worker, new URL).
2. `d1_databases[0]`: `wrangler d1 create <tenant>-bus`, paste the new `database_id`,
   keep `migrations_dir: migrations`.
3. `r2_buckets`: create both `<tenant>-bus-raw` (`RAW`) and `<tenant>-bus-privacy`
   (`PRIVACY_LEDGER`). Keep the privacy bucket outside D1/raw restore and lifecycle
   replacement. Provision both before deploying a Worker that requires the ledger.
4. `queues`: `wrangler queues create <tenant>-jn-push` and `wrangler queues create <tenant>-jn-dlq`;
   update producer, consumer, and `dead_letter_queue` names.
5. `vars`: tenant's own `OWNER_ALERT_EMAIL`, `BACKUP_ALERT_EMAIL`, `FROM_EMAIL`,
   `SHARED_DRIVE_ID_JOBS`, `SHARED_DRIVE_ID_RESTRICTED`, `SHARED_DRIVE_ID_ARCHIVE`,
   `ERPNEXT_BASE_URL`, `APP_TENANT_ID`, `APP_TENANT_NAME`, `APP_TENANT_BRAND`,
   `APP_LOCALE`, `APP_TIME_ZONE`, `APP_CURRENCY`, `APP_BFF_ENABLED`,
   `APP_PUBLIC_ORIGIN`, `APP_ALLOWED_ORIGINS`, `APP_CUSTOMER_PORTAL_ENABLED`, and
   `PIPELINE_AUTOMATION_ENABLED`.
   Keep `JOBNIMBUS_ENABLED` per the tenant's bridge decision (JobNimbus is a temporary bridge,
   not a keeper).
   If `APP_BFF_ENABLED=true`, set a canonical HTTPS `APP_PUBLIC_ORIGIN` and include that exact
   value in comma-separated `APP_ALLOWED_ORIGINS`. `APP_CUSTOMER_PORTAL_ENABLED=true` requires
   the BFF to be enabled.
   Set `QB_EXPECTED_REALM_ID` to the tenant's one approved QuickBooks company realm and
   `QB_RECONCILIATION_ISSUER_USER` to its separate Frappe issuer identity. These are
   tenant-only non-secret Worker vars; neither may be copied from another tenant or point to the
   general Worker/MCP user.
6. Run migrations against the NEW database:
   `npx wrangler d1 migrations apply <tenant>-bus --remote`
   (applies all committed migrations, currently through
   `0201_agent_delegation.sql`; `node tools/validate-documentation.mjs`
   fails if this filename drifts from the chain on `main`).
7. Secrets: use individual `wrangler secret put <NAME>` commands from an approved secret store
   with the exact tenant `--env <tenant-environment>` or tenant `--config <path>` target;
   never pass a generic Cloudflare token to a repository script. Required set:
   `INGEST_TOKEN`, `ADMIN_TOKEN`, `JOBNIMBUS_API_KEY` (if bridging),
   `GOOGLE_SERVICE_ACCOUNT_JSON`, `QB_WEBHOOK_TOKEN`, `QB_RECONCILIATION_ISSUER_API_KEY`,
   `QB_RECONCILIATION_ISSUER_API_SECRET`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`,
   and `APP_AUTH_PEPPER`; add each broker shared secret only when its isolated broker is enabled.
   Do NOT set `PIPELINE_AUTOMATION_RECIPIENTS_JSON` for a new tenant: automation recipients are
   tenant data since ELEC-204, and the owner adds them through the configuration hub. That secret
   remains readable only as a fallback for a tenant that has never written a recipient record.
   All tokens are NEW values, never reused from another tenant.
8. Compare the intended Worker runtime values before deployment (this reads supplied env values;
   it does not inspect or change a live Worker):
   `IRONWRAP_TENANT_CONFIG=<tenant> APP_TENANT_ID=<tenant> APP_TENANT_NAME='<tenant app name>' APP_TENANT_BRAND='<tenant brand>' APP_LOCALE=en-CA APP_TIME_ZONE=America/Edmonton APP_CURRENCY=CAD FROM_EMAIL=<declared sender mailbox> APP_BFF_ENABLED=false APP_CUSTOMER_PORTAL_ENABLED=false node tools/validate-tenant-runtime.mjs`.
   Run `npm test`, `npm run typecheck`, and an explicitly targeted
   `npx wrangler deploy --dry-run --env <tenant-environment>` (or the tenant config equivalent)
   in `workers-bus/`.
   A deliberate deployment in the tenant's Cloudflare account and separate live health/origin checks
   remain required before treating this step as complete.

### 3. Frappe site

1. Create a fresh plain Frappe site for the tenant: `bench new-site <tenant-site>`
   (own database, own users). Never install the erpnext app; the site is Frappe-only.
2. Install the custom app: `bench get-app frappe-apps/ironwrap_roofing` then
   `bench --site <tenant-site> install-app ironwrap_roofing`.
3. Sanity: `node tools/validate-erpnext-doctypes.mjs` in the repo confirms the 79-DocType
   pack shape; on the site, confirm the IronWrap Roofing DocTypes exist.
4. Create a tenant-scoped API key/secret pair for the bus, plus a separate pair for every
   Hermes MCP actor. Each MCP pair must be issued to exactly that process's
   `HERMES_ACTOR_USER`; never use the bus pair to attest an actor action.
5. Create a third non-interactive QuickBooks issuer user with only the IronWrap QuickBooks
   Reconciliation Issuer role and its own API key/secret. Set
   `ironwrap_quickbooks_reconciliation_issuer_user` to that exact user. Do not grant it a
   human finance role, System Manager, or the general bus/MCP roles.
6. Pin every bounded-rail issuer identity in the site config. Each rail refuses to run
   until its own key is set, so a key left unset is a rail that is dead on this tenant
   even though the app ships it and CI is green — this is how fleet capture reached a
   real site broken (IRO-54). `node tools/validate-site-config-pins.mjs` fails when a
   key the app reads is missing from this list.

   The Worker BFF authenticates its field-evidence and production-gate rails with the
   single bus API pair from step 4, so those two issuer keys name that same bus user:

   ```
   bench --site <tenant-site> set-config ironwrap_field_evidence_issuer_user  '<worker-api-user-email>'
   bench --site <tenant-site> set-config ironwrap_production_gate_issuer_user '<worker-api-user-email>'
   ```

   Fleet capture and work package do NOT. The bus pair is a System Manager, so issuing
   those two rails with it meant one leaked key reached the whole site instead of one
   rail's narrow grant (ELEC-48 audit section 3). Each holds its own non-interactive user,
   its own least-privilege role, and its own API key/secret pair — and re-pinning the site
   config to that user is also what revokes the bus pair's access, because the app compares
   the session user against the pin and fails closed with `*_issuer_auth_mismatch`:

   ```
   bench --site <tenant-site> set-config ironwrap_fleet_capture_issuer_user '<fleet-capture-issuer-email>'
   bench --site <tenant-site> set-config ironwrap_work_package_issuer_user  '<work-package-issuer-email>'
   ```

   | rail | user role | Worker secrets |
   |---|---|---|
   | fleet capture | `IronWrap Fleet Capture Issuer` (create Asset Inspection + Asset Defect, read Fleet Asset) | `FLEET_CAPTURE_FRAPPE_API_KEY` / `FLEET_CAPTURE_FRAPPE_API_SECRET` |
   | work package | `IronWrap Work Package Issuer` (read Work Package, create Work Package Event) | `WORK_PACKAGE_FRAPPE_API_KEY` / `WORK_PACKAGE_FRAPPE_API_SECRET` |

   Neither pair may hold the bus key/secret values. The Worker rejects that arrangement
   outright (`*_frappe_shared_credential_rejected`) rather than accepting a binding name
   that carries a shared identity, and `/ready`'s `rail_credential_isolation` check goes
   red for it. `node tools/validate-rail-credential-isolation.mjs` proves the whole chain
   — role, user, provisioner, Worker binding, config surface — is present in the repo.

   The Frappe app rejects `Verified` evidence, submitted pre/post-trip inspections and
   field-issued Work Package events through ordinary Desk/REST writes, so these
   site-local pins are required before any of those can become gate-eligible.
   `ironwrap_production_gate_issuer_user` is the same shape for the six scheduling
   gates: without it the office has no way to clear Deposit, Materials, Safety,
   Access, Weather or Crew, and every Won job stays unschedulable on this site.

   The remaining identities are deliberately NOT the bus user — each holds its own
   least-privilege role and its own API key/secret pair:

   | site config key | identity | provisioned in |
   |---|---|---|
   | `ironwrap_fleet_capture_issuer_user` | IronWrap Fleet Capture Issuer | dedicated user, own key pair (this step) |
   | `ironwrap_work_package_issuer_user` | IronWrap Work Package Issuer | dedicated user, own key pair (this step) |
   | `ironwrap_quickbooks_reconciliation_issuer_user` | IronWrap QuickBooks Reconciliation Issuer | step 3.5 |
   | `ironwrap_facet_design_projection_service_user` | IronWrap Facet Design Projection Service | set with `FACET_DESIGN_FRAPPE_PROJECTION_*` in step 2.7 |
   | `ironwrap_launch_proof_reader_user` | IronWrap Launch Proof Reader | leftover Frappe lookup identity only. `tools/launch-proof.mjs` proves D1/Worker identity with `INGEST_TOKEN` / `ADMIN_TOKEN` and ignores `FRAPPE_*` (IRO-189). Do not treat this pin as a release-wire gate. |

   Customer portal decisions are not one of those Frappe-issued rails. The authoritative write is
   the native D1 intent plus immutable R2 receipt in `0069_customer_portal_decision_intents.sql`;
   no Frappe decision issuer is provisioned for clones.

   Three further pins are tenant *constants* rather than identities. A Roof Job cannot
   reach `Won` without a workflow profile and the locale-policy pair, and the customer
   contract acceptance command is what stamps them, so a site that skips these accepts
   no contracts at all — it fails closed rather than stamping a jurisdiction fact
   nobody blessed. Pin the tenant's own blessed values, not IronWrap Exteriors':

   ```
   bench --site <tenant-site> set-config ironwrap_default_workflow_profile     '<Roof Job workflow profile>'
   bench --site <tenant-site> set-config ironwrap_locale_policy_version        '<blessed locale policy version>'
   bench --site <tenant-site> set-config ironwrap_locale_policy_snapshot_json  '<blessed locale policy JSON object>'
   ```

   `ironwrap_default_workflow_profile` must be one of the Roof Job `workflow_profile`
   options (`Residential Retail`, `Insurance Restoration`, `Commercial`, `Service`,
   `Warranty`, `Custom`) and is the tenant default only: a profile an operator already
   set on a job is never overwritten. `ironwrap_locale_policy_version` and
   `ironwrap_locale_policy_snapshot_json` (a non-empty JSON object) are the tenant's
   jurisdiction facts, blessed by whoever owns legal/compliance for that tenant and
   re-pinned when its jurisdiction rules change. Retirement: these three pins belong to
   the Frappe compatibility-projection era (IRO-195 / ELEC-115 Path A) and go away with
   it when the D1-native acceptance transition ships.

7. Never adopt frappe/press (AGPL, Frappe Cloud's control plane): per-tenant provisioning
   stays on IronWrap's own scripts (`config/tenants/` + validators + this playbook).

### 4. Drive / evidence namespace

1. Create the tenant's own Shared Drives (Jobs / Restricted / Archive pattern).
2. Grant the tenant's service account access; set the three `SHARED_DRIVE_ID_*` vars.
3. The raw R2 bucket from step 2.3 is the tenant's payload namespace. The separate
   privacy bucket holds sticky evidence disposition markers. Never include it in an
   older D1/raw restore or a bulk replacement; nothing writes to another tenant's bucket.

### 5. QuickBooks connection

1. Connect the tenant's own QuickBooks company (own realm id).
2. Register the tenant Worker's `POST /webhook/quickbooks` URL in the tenant's own Intuit
   app; set that verifier as `QB_WEBHOOK_TOKEN` on the tenant Worker.
3. Set the exact realm and separate issuer values above, then prove one signed expected-realm
   event creates the raw receipt, durable projection row, and Pending Frappe reconciliation.
   A deploy dry-run or local test cannot substitute for this tenant-account proof.

### 6. Hermes profile + MCP servers

Run tenant-dedicated MCP server processes with tenant-only env:

- `mcp/erpnext-roofing-mcp`: `ERPNEXT_BASE_URL`, an `ERPNEXT_API_KEY` /
  `ERPNEXT_API_SECRET` pair belonging to exactly `HERMES_ACTOR_USER`,
  `ERPNEXT_WRITE_ENABLED`, `HERMES_DRY_RUN_SIGNING_KEY`, and
  `HERMES_APPROVAL_PUBLIC_KEY_FILE`.
- `mcp/ironwrap-bus-mcp`: `IRONWRAP_BUS_BASE_URL`, `IRONWRAP_ADMIN_TOKEN`,
  `IRONWRAP_BUS_WRITE_ENABLED`, `IRONWRAP_BUS_WRITE_TOKEN`.
- `mcp/newo-mcp`: `IRONWRAP_BUS_BASE_URL`, `IRONWRAP_ADMIN_TOKEN`,
  `NEWO_MCP_WRITE_ENABLED`, and no provider API key. The tenant Worker owns the Newo key,
  signed receipt ledger, control gates, and provider calls.

Defaults for a new tenant: write flags off (`ERPNEXT_WRITE_ENABLED` unset/false) until the
tenant passes the approved-write proof. `HERMES_DRY_RUN_SIGNING_KEY` is unique per tenant and the
approval broker public key plus bound approver identity are configured per isolated runtime. The
Hermes profile (memory, skills, tool allowlist) is created fresh; never point two tenants'
profiles at the same MCP process or token.

### 7. Brand/template pack

Sender mailboxes on the tenant's own domains (SPF/DKIM/DMARC per domain), proposal print
formats on the tenant's ERPNext site, review links in `config/tenants/<tenant>.json`.

## Tenant-Leakage Checks

Run all of these before calling the clone done. On the local stack they are one command:

```bash
deploy/tenant-leakage-checks.sh --tenant-a ironwrap --tenant-b <tenant>
```

It ingests a uniquely marked lead into tenant B and then looks for that marker everywhere in
tenant A, and reports each check as `PASS`, `FAIL`, or `HAND-OFF`. `HAND-OFF` means the check
needs a live provider account this stack deliberately does not have (Google Drive, outbound
mail): the runner asserts the locally provable control, names the owner action, and never
counts it as a pass. Any `FAIL` exits non-zero.

1. `node tools/validate-tenant-config.mjs` passes (id uniqueness + sender-domain isolation), and
   `tools/validate-tenant-runtime.mjs` passes against the intended tenant runtime values.
2. Cross-tenant token test: call the new Worker's `GET /admin/envelopes` with the OLD
   tenant's `ADMIN_TOKEN`; expect 401. Repeat in the other direction.
3. Data plane: `wrangler d1 execute <tenant>-bus --remote --command "SELECT COUNT(*) FROM envelopes"`
   shows only the demo tenant's rows; the IronWrap database count is unchanged by demo traffic.
4. R2: demo raw payloads land only in `<tenant>-bus-raw`; spot-check the IronWrap bucket
   for the same timestamps. A manual evidence disposition creates a marker only in
   `<tenant>-bus-privacy`; verify that the IronWrap privacy bucket is unchanged.
5. Frappe site: the demo lead exists only on the tenant site. Search **every doctype the app
   ships**, not just `Lead Envelope` — the ingest fan-out writes the same contact into several
   (`Roofing Customer.email` among them), so a single-doctype search reports zero hits while a
   leaked customer record sits on the other site. `deploy/local/frappe-marker-sweep.mjs` does
   this from the app's own doctype JSONs, and reports a query that failed to run as an error
   rather than as an absence of rows; `tools/validate-ingest-doctype-coverage.mjs` fails CI if a
   doctype `workers-bus/src/erpnext.ts` names ever falls outside the sweep.
6. Drive: the demo job folder exists only in the tenant's Shared Drive.
7. MCP: from the tenant Hermes profile, `list_recent_envelopes` returns only tenant data;
   attempting the other tenant's `ERPNEXT_BASE_URL` credentials fails.
8. Email: the demo instant-ack sends from the tenant's `FROM_EMAIL`, never from an
   ironwrapexteriors.com or iroofalberta.ca mailbox.

## Acceptance Checklist

A second demo company runs with separate brand, configuration, data, tools, evidence, and
recovery boundaries.

- [ ] `config/tenants/<tenant>.json` exists and `node tools/validate-tenant-config.mjs` passes.
- [ ] Tenant Worker deployed with its own D1, raw R2 and privacy R2 buckets, queues,
  crons, and secrets; `GET /health` returns ok.
- [ ] Governed stage automation is either left disabled, or has `PIPELINE_AUTOMATION_ENABLED=true`
  and the tenant owner has added at least one recipient on the Recipients screen
  (`/settings/configuration/automations/recipients`, backed by
  `POST /api/v1/admin/automation-recipients`). No deploy secret and no developer are involved.
- [ ] All 121 D1 migrations through `0201_agent_delegation.sql` applied to the tenant database.
- [ ] Evidence upload lifecycle remains disabled until runtime-owned quiescence proof covers old
  unclaimed requests and pending provider PUTs. Preserve unresolved write claims on backup/restore;
  an older snapshot, elapsed time or empty RAW read does not authorize clearing them.
- [ ] Backup/restore host uses SQLite CLI 3.46.0 or newer. Older fixed parser stacks cannot parse
  the existing 0117 authority lifecycle guard; both scripts refuse them before export/download.
  CI builds checksum-pinned SQLite 3.54.1 for these full-schema proofs. This verifier is separate
  from the pinned Wrangler/workerd D1 engine; do not remove or simplify guards to fit an old CLI.
  SQLite documents the parser change in its [3.46 release notes](https://www.sqlite.org/releaselog/3_46_0.html).
- [ ] Tenant Frappe site up (no erpnext app) with `ironwrap_roofing` installed, its own API key pair,
  `ironwrap_field_evidence_issuer_user` and `ironwrap_production_gate_issuer_user` bound
  to that dedicated Worker user; `ironwrap_fleet_capture_issuer_user` and
  `ironwrap_work_package_issuer_user` bound to their OWN least-privilege users with their own
  key pairs in `FLEET_CAPTURE_FRAPPE_API_*` / `WORK_PACKAGE_FRAPPE_API_*`; and a separate
  QuickBooks issuer user/role/key pair bound through `ironwrap_quickbooks_reconciliation_issuer_user`.
  Every key in the step 3.6 table is either set or consciously deferred; `node
  tools/validate-site-config-pins.mjs` passes.
- [ ] Tenant Shared Drives + R2 bucket receive a test job's files.
- [ ] Tenant QuickBooks expected realm and signed webhook verified: receipt/outbox and exactly one Pending Frappe reconciliation exist; provider accounting facts are still read-back/reconciliation work.
- [ ] Tenant Hermes profile answers a read-only question from tenant data via all granted MCP servers.
- [ ] A test lead flows source -> bus envelope -> tenant ERPNext record -> tenant-branded ack email.
- [ ] All 8 tenant-leakage checks above pass.
- [ ] No secret value appears in the repo, the tenant config, or this checklist's evidence.
