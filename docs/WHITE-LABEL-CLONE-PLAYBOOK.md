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
| Storage | One Drive namespace (Shared Drives) + one R2 bucket | `SHARED_DRIVE_ID_*` vars, `RAW` binding |
| Accounting | One QuickBooks connection (own realm, verifier, and bounded Frappe issuer) | `QB_EXPECTED_REALM_ID`, `QB_WEBHOOK_TOKEN`, and tenant-only issuer credentials |
| Brand | One brand/template pack + tenant config | `config/tenants/<tenant>.json` |

Why isolation first: the risk register lists "Tenant leakage" as a product-killing risk.
Site/profile/namespace isolation is the control.

## Clone Steps

Assume the new tenant id is `<tenant>` (example already in repo: `demo-exteriors`).

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
3. `r2_buckets[0]`: `wrangler r2 bucket create <tenant>-bus-raw`.
4. `queues`: `wrangler queues create <tenant>-jn-push` and `wrangler queues create <tenant>-jn-dlq`;
   update producer, consumer, and `dead_letter_queue` names.
5. `vars`: tenant's own `OWNER_ALERT_EMAIL`, `BACKUP_ALERT_EMAIL`, `FROM_EMAIL`,
   `SHARED_DRIVE_ID_JOBS`, `SHARED_DRIVE_ID_RESTRICTED`, `SHARED_DRIVE_ID_ARCHIVE`,
   `ERPNEXT_BASE_URL`, `APP_TENANT_ID`, `APP_TENANT_NAME`, `APP_TENANT_BRAND`,
   `APP_LOCALE`, `APP_TIME_ZONE`, `APP_CURRENCY`, `APP_BFF_ENABLED`,
   `APP_PUBLIC_ORIGIN`, `APP_ALLOWED_ORIGINS`, and `APP_CUSTOMER_PORTAL_ENABLED`.
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
   `0031_quickbooks_projection_outbox.sql`).
7. Secrets: use individual `wrangler secret put <NAME>` commands from an approved secret store
   with the exact tenant `--env <tenant-environment>` or tenant `--config <path>` target;
   never pass a generic Cloudflare token to a repository script. Required set:
   `INGEST_TOKEN`, `ADMIN_TOKEN`, `JOBNIMBUS_API_KEY` (if bridging),
   `GOOGLE_SERVICE_ACCOUNT_JSON`, `QB_WEBHOOK_TOKEN`, `QB_RECONCILIATION_ISSUER_API_KEY`,
   `QB_RECONCILIATION_ISSUER_API_SECRET`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`,
   and `APP_AUTH_PEPPER`; add each broker shared secret only when its isolated broker is enabled.
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
3. Sanity: `node tools/validate-erpnext-doctypes.mjs` in the repo confirms the 50-DocType
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

   The Worker BFF authenticates every one of its rails with the single bus API pair from
   step 4, so all three of its issuer keys name that same bus user:

   ```
   bench --site <tenant-site> set-config ironwrap_field_evidence_issuer_user '<worker-api-user-email>'
   bench --site <tenant-site> set-config ironwrap_fleet_capture_issuer_user  '<worker-api-user-email>'
   bench --site <tenant-site> set-config ironwrap_work_package_issuer_user   '<worker-api-user-email>'
   ```

   The Frappe app rejects `Verified` evidence, submitted pre/post-trip inspections and
   field-issued Work Package events through ordinary Desk/REST writes, so these
   site-local pins are required before any of those can become gate-eligible.

   The remaining identities are deliberately NOT the bus user — each holds its own
   least-privilege role and its own API key/secret pair:

   | site config key | identity | provisioned in |
   |---|---|---|
   | `ironwrap_customer_acceptance_service_user` | IronWrap Customer Acceptance Service | step 3.4 pair, dedicated user |
   | `ironwrap_customer_decision_service_user` | IronWrap Customer Decision Service | step 3.4 pair, dedicated user |
   | `ironwrap_quickbooks_reconciliation_issuer_user` | IronWrap QuickBooks Reconciliation Issuer | step 3.5 |
   | `ironwrap_facet_design_projection_service_user` | IronWrap Facet Design Projection Service | set with `FACET_DESIGN_FRAPPE_PROJECTION_*` in step 2.7 |
   | `ironwrap_launch_proof_reader_user` | IronWrap Launch Proof Reader | release-time only, for `tools/launch-proof.mjs` |

7. Never adopt frappe/press (AGPL, Frappe Cloud's control plane): per-tenant provisioning
   stays on IronWrap's own scripts (`config/tenants/` + validators + this playbook).

### 4. Drive / evidence namespace

1. Create the tenant's own Shared Drives (Jobs / Restricted / Archive pattern).
2. Grant the tenant's service account access; set the three `SHARED_DRIVE_ID_*` vars.
3. The R2 bucket from step 2.3 is the tenant's raw-payload namespace; nothing writes to
   another tenant's bucket.

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

Run all of these before calling the clone done:

1. `node tools/validate-tenant-config.mjs` passes (id uniqueness + sender-domain isolation), and
   `tools/validate-tenant-runtime.mjs` passes against the intended tenant runtime values.
2. Cross-tenant token test: call the new Worker's `GET /admin/envelopes` with the OLD
   tenant's `ADMIN_TOKEN`; expect 401. Repeat in the other direction.
3. Data plane: `wrangler d1 execute <tenant>-bus --remote --command "SELECT COUNT(*) FROM envelopes"`
   shows only the demo tenant's rows; the IronWrap database count is unchanged by demo traffic.
4. R2: demo raw payloads land only in `<tenant>-bus-raw`; spot-check the IronWrap bucket
   for the same timestamps.
5. Frappe site: the demo lead exists only on the tenant site; search the IronWrap site for
   the demo contact and expect zero hits.
6. Drive: the demo job folder exists only in the tenant's Shared Drive.
7. MCP: from the tenant Hermes profile, `list_recent_envelopes` returns only tenant data;
   attempting the other tenant's `ERPNEXT_BASE_URL` credentials fails.
8. Email: the demo instant-ack sends from the tenant's `FROM_EMAIL`, never from an
   ironwrapexteriors.com or iroofalberta.ca mailbox.

## Acceptance Checklist

A second demo company runs with separate brand, configuration, data, tools, evidence, and
recovery boundaries.

- [ ] `config/tenants/<tenant>.json` exists and `node tools/validate-tenant-config.mjs` passes.
- [ ] Tenant Worker deployed with its own D1, R2, queues, crons, and secrets; `GET /health` returns ok.
- [ ] All 31 D1 migrations through `0031_quickbooks_projection_outbox.sql` applied to the tenant database.
- [ ] Tenant Frappe site up (no erpnext app) with `ironwrap_roofing` installed, its own API key pair,
  `ironwrap_field_evidence_issuer_user`, `ironwrap_fleet_capture_issuer_user` and
  `ironwrap_work_package_issuer_user` all bound to that dedicated Worker user, and a separate
  QuickBooks issuer user/role/key pair bound through `ironwrap_quickbooks_reconciliation_issuer_user`.
  Every key in the step 3.6 table is either set or consciously deferred; `node
  tools/validate-site-config-pins.mjs` passes.
- [ ] Tenant Shared Drives + R2 bucket receive a test job's files.
- [ ] Tenant QuickBooks expected realm and signed webhook verified: receipt/outbox and exactly one Pending Frappe reconciliation exist; provider accounting facts are still read-back/reconciliation work.
- [ ] Tenant Hermes profile answers a read-only question from tenant data via all granted MCP servers.
- [ ] A test lead flows source -> bus envelope -> tenant ERPNext record -> tenant-branded ack email.
- [ ] All 8 tenant-leakage checks above pass.
- [ ] No secret value appears in the repo, the tenant config, or this checklist's evidence.
