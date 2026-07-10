# White-Label Onboarding

## Purpose
Stand up a new contractor tenant from a validated config with isolated data, brand, and tools, so a second shop runs on the same product without mixing customers. This is the gate-11 clone procedure as an agent-followable checklist.

## When to use
- Onboarding a new white-label contractor or spinning up a demo tenant.
- Auditing an existing tenant's config for drift or isolation problems.

## Inputs
- `config/tenants/<tenant>.json` (brand, geography, services, materials, estimates, proposal, production gates, communications, integrations, agents, market_defense).
- Validator `tools/validate-tenant-config.mjs` and reference `config/tenants/ironwrap.json` / `config/tenants/demo-exteriors.json`.
- `docs/WHITE-LABEL-CLONE-PLAYBOOK.md` (isolation model and clone steps) and `docs/OPERATIONS-RUNBOOK.md` (gate-13 ops).
- Site-local `get_white_label_tenant` / `list_white_label_tenants` lifecycle metadata.

## Procedure
1. Clone an existing tenant config to `config/tenants/<new-tenant>.json` and edit brand, geography, service areas, suppliers, gates, and market-defense set. Reference secrets by env var name only; never inline a secret value.
2. Run `node tools/validate-tenant-config.mjs`. It must pass: required areas present, quiet hours sane, CASL consent required, instant estimate non-binding and review-required, all seven production gates present, agents approval_policy dry_run_then_human_approval, no secret-looking strings, unique tenant id, and non-overlapping sender domains (tenant isolation).
3. Follow `docs/WHITE-LABEL-CLONE-PLAYBOOK.md` to provision the isolated stack: one plain Frappe
   site, one Hermes profile, one Cloudflare namespace/config set, one Drive/R2 namespace, one
   QuickBooks connection, and one brand/template pack. Never install ERPNext.
4. Install the proprietary IronWrap app, validate its 33 DocTypes, and confirm the site has at
   most one Active White-Label Tenant.
5. Wire the MCP servers for the tenant with per-tenant `ERPNEXT_BASE_URL`, API key/secret, and write guards (`ERPNEXT_WRITE_ENABLED`, `HERMES_WRITE_TOKEN`); confirm the agent tool filtering with `node tools/validate-hermes-config.mjs`.
6. Run the clone acceptance checklist and the tenant-leakage checks from the playbook. Report readiness to the owner.

## Guardrails
- Never write a real secret value into a tenant config; env var names only.
- Never share a sender domain, Frappe site, namespace, or QuickBooks connection across tenants.
- Do not go live until all three validators pass and the leakage checks are clean.
- Onboarding provisions and validates config; it does not send customer communications or mutate accounting.

## Output
A validated `config/tenants/<tenant>.json`, an isolated provisioned stack, three green validators, and a completed clone acceptance checklist proving the tenant runs without mixing another tenant's data.
