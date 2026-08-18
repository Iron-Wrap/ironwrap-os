# White-Label Onboarding

## Purpose
Stand up a new contractor tenant from a validated config with isolated data, brand, and tools, so
a second shop runs on the same product without mixing customers.

## When to use
- Onboarding a new white-label contractor or spinning up a demo tenant.
- Auditing an existing tenant's config for drift or isolation problems.

## Inputs
- `config/tenants/<tenant>.json` (brand, geography, services, materials, estimates, proposal, production gates, communications, integrations, agents, market_defense).
- Validator `tools/validate-tenant-config.mjs` and reference `config/tenants/ironwrap.json` / `config/tenants/demo-exteriors.json`.
- `docs/WHITE-LABEL-CLONE-PLAYBOOK.md` (isolation model and clone steps) and
  `docs/OPERATIONS-RUNBOOK.md` (day-two operation).
- Site-local `get_white_label_tenant` / `list_white_label_tenants` lifecycle metadata.
- Site-local `get_tenant_export_run` / `list_tenant_export_runs_for_tenant` plus the tenant-export request dry-run/write pair for portability checks.

## Procedure
1. Clone an existing tenant config to `config/tenants/<new-tenant>.json` and edit brand, geography, service areas, suppliers, gates, and market-defense set. Reference secrets by env var name only; never inline a secret value.
2. Run `node tools/validate-tenant-config.mjs`. It must pass: required areas present, quiet hours
   sane, CASL consent required, public intake price-free and review-required, every
   schema-required production gate present, the implemented agent approval policy, no
   secret-looking strings, unique tenant id, and non-overlapping sender domains.
3. Follow `docs/WHITE-LABEL-CLONE-PLAYBOOK.md` to provision the isolated stack: one plain Frappe
   site, one Hermes profile, one Cloudflare namespace/config set, one Drive/R2 namespace, one
   QuickBooks connection, and one brand/template pack. Never install ERPNext.
4. Install the proprietary IronWrap app, run the committed DocType validator, and confirm the site
   has at most one Active White-Label Tenant.
5. Wire the Frappe MCP server with per-tenant `ERPNEXT_BASE_URL`, an API key/secret pair
   issued to exactly its configured actor, `ERPNEXT_WRITE_ENABLED`, a unique
   `HERMES_DRY_RUN_SIGNING_KEY`, the approval broker public-key path, and one configured
   role/actor per process; retain `HERMES_WRITE_TOKEN` only for the separate bus replay
   server. Confirm runtime role filtering with `node tools/validate-hermes-config.mjs`.
6. Prove data portability by previewing `dry_run_tenant_export` and, after owner approval, calling `request_tenant_export`. It appends only a Requested Tenant Export Run; a separate audited worker creates/encrypts the archive and must exclude credentials, session tokens, and key material.
7. Run the clone acceptance checklist and tenant-leakage checks. Report readiness to the owner.

## Guardrails
- Never write a real secret value into a tenant config; env var names only.
- Never share a sender domain, Frappe site, namespace, or QuickBooks connection across tenants.
- Do not go live until every validator named by the clone playbook passes and the leakage checks
  are clean.
- Onboarding provisions and validates config; it does not send customer communications or mutate accounting.
- Tenant Export Run corrections append a new request with `supersedes`; never overwrite a prior export run or expose an archive/key through Hermes.

## Output
A validated `config/tenants/<tenant>.json`, an isolated provisioned stack, passing named
validators, and a completed clone acceptance checklist proving the tenant runs without mixing
another tenant's data.
