# White-Label Clone Playbook (Maturity Gate 11)

How to stand up a second contractor ("tenant") on the IronWrap OS stack with fully isolated
brand, config, data, and tools. Gate 11 passes when a demo tenant runs end to end on its own
copies of everything, with zero shared state with the live IronWrap tenant.

Blueprint reference: `docs/HERMES-ERPNEXT-END-PRODUCT-BLUEPRINT.md`, sections
"White-Label Productization" and "Maturity Gates".

## Isolation Model

One of each, per contractor. Nothing is shared. Multi-tenant consolidation is explicitly
deferred until the cloneable shape is proven (see the blueprint's Non-Goals).

| Layer | Per-tenant unit | Repo artifact |
| --- | --- | --- |
| Frappe (IronWrap OS) | One plain Frappe site (never install the erpnext app) | `frappe-apps/ironwrap_roofing` installed per site |
| Hermes | One Hermes profile (own memory, skills, MCP allowlist) | MCP env vars below |
| Cloudflare | One Worker + D1 + R2 + queues + secrets set | `workers-bus/wrangler.jsonc` |
| Storage | One Drive namespace (Shared Drives) + one R2 bucket | `SHARED_DRIVE_ID_*` vars, `RAW` binding |
| Accounting | One QuickBooks connection (own realm, own webhook verifier) | `QB_WEBHOOK_TOKEN` secret |
| Brand | One brand/template pack + tenant config | `config/tenants/<tenant>.json` |

Why isolation first: the risk register lists "Tenant leakage" as a product-killing risk.
Site/profile/namespace isolation is the control.

## Clone Steps

Assume the new tenant id is `<tenant>` (example already in repo: `demo-exteriors`).

### 1. Tenant config

1. Copy `config/tenants/demo-exteriors.json` to `config/tenants/<tenant>.json`.
2. Fill in: `tenant.id` (unique), brands with their own `sender_mailbox` and `sender_domain`
   (must not overlap any other tenant's domains), service areas, services, suppliers,
   milestones, gates.
3. Secrets stay out: the config carries env var NAMES only (`*_env` fields).
4. Validate: `node tools/validate-tenant-config.mjs` must print
   `ok N tenant configs validated`. The validator enforces id uniqueness, sender-domain
   isolation, CASL consent, quiet hours sanity, non-binding instant estimates, the 7
   production gates, the approval policy, and a no-secret-values scan.

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
   `ERPNEXT_BASE_URL`. Keep `JOBNIMBUS_ENABLED` per the tenant's bridge decision
   (JobNimbus is a temporary bridge, not a keeper).
6. Run migrations against the NEW database:
   `npx wrangler d1 migrations apply <tenant>-bus --remote`
   (applies `workers-bus/migrations/0001_init.sql` through `0006_dedup_claims.sql`).
7. Secrets: fill a tenant-specific `ACCESS.env` and run
   `bash workers-bus/scripts/apply-secrets.sh` with the tenant's Cloudflare API token, or
   `printf '%s' '<value>' | npx wrangler secret put <NAME>` per secret. Required set:
   `INGEST_TOKEN`, `ADMIN_TOKEN`, `JOBNIMBUS_API_KEY` (if bridging),
   `GOOGLE_SERVICE_ACCOUNT_JSON`, `QB_WEBHOOK_TOKEN`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`.
   All tokens are NEW values, never reused from another tenant.
8. `npm test`, `npm run typecheck`, `npx wrangler deploy --dry-run` in `workers-bus/`,
   then deploy.

### 3. Frappe site

1. Create a fresh plain Frappe site for the tenant: `bench new-site <tenant-site>`
   (own database, own users). Never install the erpnext app; the site is Frappe-only.
2. Install the custom app: `bench get-app frappe-apps/ironwrap_roofing` then
   `bench --site <tenant-site> install-app ironwrap_roofing`.
3. Sanity: `node tools/validate-erpnext-doctypes.mjs` in the repo confirms the DocType
   pack shape (prints `ok 26`); on the site, confirm the IronWrap Roofing DocTypes exist.
4. Create a tenant-scoped API key/secret pair for the bus and MCP (never the IronWrap pair).
5. Never adopt frappe/press (AGPL, Frappe Cloud's control plane): per-tenant provisioning
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

### 6. Hermes profile + MCP servers

Run tenant-dedicated MCP server processes with tenant-only env:

- `mcp/erpnext-roofing-mcp`: `ERPNEXT_BASE_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`,
  `ERPNEXT_WRITE_ENABLED`, `HERMES_WRITE_TOKEN`.
- `mcp/ironwrap-bus-mcp`: `IRONWRAP_BUS_BASE_URL`, `IRONWRAP_ADMIN_TOKEN`,
  `IRONWRAP_BUS_WRITE_ENABLED`, `IRONWRAP_BUS_WRITE_TOKEN`.

Defaults for a new tenant: write flags off (`ERPNEXT_WRITE_ENABLED` unset/false) until the
tenant passes the approved-write proof. `HERMES_WRITE_TOKEN` is minted per tenant. The
Hermes profile (memory, skills, tool allowlist) is created fresh; never point two tenants'
profiles at the same MCP process or token.

### 7. Brand/template pack

Sender mailboxes on the tenant's own domains (SPF/DKIM/DMARC per domain), proposal print
formats on the tenant's ERPNext site, review links in `config/tenants/<tenant>.json`.

## Tenant-Leakage Checks

Run all of these before calling the clone done:

1. `node tools/validate-tenant-config.mjs` passes (id uniqueness + sender-domain isolation).
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

## Gate 11 Acceptance Checklist

Gate 11 (blueprint): "A second demo company runs with separate brand/config/data/tools."

- [ ] `config/tenants/<tenant>.json` exists and `node tools/validate-tenant-config.mjs` passes.
- [ ] Tenant Worker deployed with its own D1, R2, queues, crons, and secrets; `GET /health` returns ok.
- [ ] All 6 D1 migrations applied to the tenant database.
- [ ] Tenant Frappe site up (no erpnext app) with `ironwrap_roofing` installed and its own API key pair.
- [ ] Tenant Shared Drives + R2 bucket receive a test job's files.
- [ ] Tenant QuickBooks webhook verified (signature accepted on `POST /webhook/quickbooks`).
- [ ] Tenant Hermes profile answers a read-only question from tenant data via both MCP servers.
- [ ] A test lead flows source -> bus envelope -> tenant ERPNext record -> tenant-branded ack email.
- [ ] All 8 tenant-leakage checks above pass.
- [ ] No secret value appears in the repo, the tenant config, or this checklist's evidence.
