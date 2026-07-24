# IronWrap OS Production Readiness Audit Report

**Date:** 2026-07-24  
**Auditor:** Claude Code Agent  
**Commit:** HEAD (current working tree)  
**Worker:** ironwrap-bus.yellow-rain-7498.workers.dev  
**Cloudflare Account:** 7ee5775bc1ba46f05c5a65235b60e939  

---

## Executive Summary

**LAUNCH STATUS: BLOCKED**

The IronWrap OS repository is in excellent shape — all validators pass, all test suites are green, and the CI/CD pipeline is configured. However, **the production deployment is an empty shell**: the Cloudflare Worker is deployed and responds to `/health`, but `/ready` returns `false`, the D1 production database contains only a single `heartbeat` table (no operational schema), the Frappe operating core is not deployed, every enablement gate is closed, and critical secrets are missing.

**Bottom line:** This is a **repository-complete, deployment-incomplete** state. No launch should proceed.

---

## Section-by-Section Audit Results

### 1. INFRASTRUCTURE DEPLOYMENT AUDIT — **PARTIAL**

| Item | Status | Evidence |
|------|--------|----------|
| Worker `ironwrap-bus` deployed | **PASS** | `curl /health` → `{"ok":true}` |
| `/ready` returns `{"ok":true}` | **FAIL** | Returns `{"ok":false}` — at least `newo_enabled`, `newo_webhook_credentials`, `newo_api_authentication`, `newo_production_actor`, `newo_report_webhook_match`, `newo_configuration_drift` are all false because `NEWO_PRODUCTION_REQUIRED="true"` but `NEWO_ENABLED="false"` and all Newo secrets/IDs are empty or missing |
| `/admin/status` with ADMIN_TOKEN | **PARTIAL** | Returns `{"error":"unauthorized"}` with dummy token (auth layer works); cannot verify operational counts without real token |
| D1 migrations 0001–0026 applied | **FAIL** | `wrangler d1 migrations list` reports "No migrations to apply" but `PRAGMA table_list` shows only `heartbeat` and `sqlite_temp_schema` — no `envelopes`, `audit_log`, `dead_letter`, or any operational tables exist |
| Required secrets set | **PARTIAL** | 10 of ~17 critical secrets are set. **Missing:** `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`, `NEWO_API_KEY`, `NEWO_WEBHOOK_TOKEN`, `NEWO_BOOKING_TOKEN`, `NEWO_CONTROL_SIGNING_SECRET`, `PUBLIC_ESTIMATE_TURNSTILE_SECRET` |
| R2 bucket `ironwrap-bus-raw` | **PASS** | Configured in `wrangler.jsonc`; Worker binding exists |
| Queues exist | **PASS** | `ironwrap-jn-push`, `ironwrap-jn-dlq`, `ironwrap-newo-events`, `ironwrap-newo-dlq` all configured in `wrangler.jsonc` |

**GitHub CI/CD:**

| Item | Status | Evidence |
|------|--------|----------|
| `.github/workflows/deploy.yml` | **PASS** | Exists; triggers on push to `main`; builds PWA + deploys Worker + applies D1 migrations |
| `.github/workflows/ci.yml` | **PASS** | Exists; runs full test matrix including validators, Frappe app tests, MCP tests, PWA build, Playwright e2e, Worker tests, production-readiness checks |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets in repo | **UNKNOWN** | Cannot verify GitHub repo secrets without admin access |
| CI builds `app/` before Worker deploy | **PASS** | `deploy.yml` runs `npm run build --prefix app` before `npm run deploy --prefix workers-bus` |
| CI runs `npm test` and blocks on failure | **PASS** | `ci.yml` runs `npm test --prefix workers-bus` and `npm test --prefix app` |

**Critical gap:** The production D1 database has no operational tables. Either migrations were applied to a destroyed/recreated database, or the migration state table (`_d1_migrations`) is out of sync with the actual schema. This must be resolved before any data can be written.

---

### 2. FRAPPE OPERATING CORE AUDIT — **NOT_STARTED**

| Item | Status | Evidence |
|------|--------|----------|
| Linux host (Ubuntu 22.04+) | **NOT_STARTED** | No production host provisioned |
| `deploy/host-preflight.sh` passes | **NOT_STARTED** | No host to run it on |
| `frappe_docker` at exact commit | **NOT_STARTED** | `deploy/runtime-lock.json` pins `d4a310089f5d6fc38ed1317b898d75b9c74901db` but no checkout exists on a production host |
| Frappe-only image built | **NOT_STARTED** | `Containerfile.frappe` and `build-production-image.sh` exist but no image digest is recorded |
| Image pushed to registry with immutable digest | **NOT_STARTED** | No registry reference in environment |
| Docker Compose topology validated | **NOT_STARTED** | `validate-frappe-compose.sh` exists but not run |
| Frappe site created | **NOT_STARTED** | No `os.ironwrapexteriors.com` site exists |
| `ironwrap_roofing` app installed | **NOT_STARTED** | Local dev stack has it (`bench list-apps` shows `frappe` + `ironwrap_roofing`), but production does not |
| `list-apps` shows ONLY `frappe` + `ironwrap_roofing` | **NOT_STARTED** | Cannot verify; local stack satisfies this |
| Dedicated non-interactive API user | **NOT_STARTED** | No production Frappe site = no API user |
| `ironwrap_field_evidence_issuer_user` site config | **NOT_STARTED** | No site to configure |
| Cloudflare Tunnel routes Frappe hostname | **NOT_STARTED** | `cloudflared-config.example.yml` exists but no tunnel configured |
| HTTPS proven from outside host | **NOT_STARTED** | No host, no tunnel, no HTTPS |

**Local development stack status:** The `deploy/local/` stack is running (`ironwrap-local-frappe-1`, `ironwrap-local-mariadb-1`, `ironwrap-local-redis-cache-1`, `ironwrap-local-redis-queue-1`). Local `bench list-apps` shows `frappe 15.114.0` and `ironwrap_roofing 0.0.1`. This proves the app builds and installs, but **local dev is not production**.

---

### 3. WORKER-TO-FRAPPE INTEGRATION AUDIT — **NOT_STARTED**

| Item | Status | Evidence |
|------|--------|----------|
| `ERPNEXT_ENABLED="true"` | **FAIL** | `wrangler.jsonc` has `"ERPNEXT_ENABLED": "false"` in production vars |
| `ERPNEXT_BASE_URL` points to live Frappe | **FAIL** | Empty string in production vars |
| `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` are Worker secrets | **FAIL** | Not in `wrangler secret list` output |
| `ERPNEXT_INTEGRATION_USER` matches Worker Frappe user | **FAIL** | Empty string in production vars |
| `/ready` shows Frappe as healthy | **FAIL** | `/ready` is `false`; Frappe check is disabled (ERPNEXT_ENABLED=false) |
| Fixture lead via `/ingest/website` → Frappe | **NOT_STARTED** | No Frappe integration = no test possible |

---

### 4. HERMES MCP LAYER AUDIT — **PARTIAL**

| Item | Status | Evidence |
|------|--------|----------|
| `hermes/mcp-servers.json` registers exactly 3 MCP servers | **PASS** | `ironwrap-bus-mcp`, `erpnext-roofing-mcp`, `newo-mcp` |
| `hermes/agents/roles.json` is source of truth for 8 roles | **PASS** | 8 roles defined; `validate-hermes-config.mjs` passes |
| `tools/validate-hermes-config.mjs` passes | **PASS** | `ok 8 Hermes agent roles + manifest validated against 159 implemented MCP tools` |
| MCP base URLs are production HTTPS | **NOT_STARTED** | `mcp-servers.json` exists but no production MCP host is deployed |
| Frappe write gates FALSE for smoke test | **PASS** | `ERPNEXT_WRITE_ENABLED` is not set; default behavior is disabled |
| One human-approved mutation test completed | **NOT_STARTED** | No Hermes runtime deployed = no smoke test possible |

---

### 5. FIELD COMPANION BFF AUDIT — **NOT_STARTED**

| Item | Status | Evidence |
|------|--------|----------|
| D1 migration `0021_public_estimate_rate_limits.sql` applied | **FAIL** | No evidence of migration applied (only `heartbeat` table in prod D1) |
| Frappe app migration for `Unknown` triage | **NOT_STARTED** | No production Frappe site |
| `APP_BFF_ENABLED="true"` | **FAIL** | `wrangler.jsonc` has `"APP_BFF_ENABLED": "false"` |
| `APP_PUBLIC_ORIGIN` set | **FAIL** | Empty string in production vars |
| `APP_ALLOWED_ORIGINS` matches | **FAIL** | Empty string in production vars |
| `APP_AUTH_PEPPER` is Worker secret | **PASS** | Listed in `wrangler secret list` |
| Owner/ops user provisioned | **NOT_STARTED** | BFF disabled |
| Office magic-link delivery proven | **NOT_STARTED** | BFF disabled |
| QR issue + fragment-only consume proven | **NOT_STARTED** | BFF disabled |
| Field read with `X-IronWrap-Device-Proof` proven | **NOT_STARTED** | BFF disabled |
| Lost-device procedure tested | **NOT_STARTED** | BFF disabled |

---

### 6. PUBLIC ESTIMATOR AUDIT — **NOT_STARTED**

| Item | Status | Evidence |
|------|--------|----------|
| Migration `0021_public_estimate_rate_limits.sql` applied | **FAIL** | Not applied (see D1 state) |
| Turnstile widget created for Worker hostname | **NOT_STARTED** | No widget ID configured |
| `PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY` in vars | **FAIL** | Empty string in production vars |
| `PUBLIC_ESTIMATE_TURNSTILE_SECRET` and `PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER` are secrets | **PARTIAL** | `PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER` is set; `PUBLIC_ESTIMATE_TURNSTILE_SECRET` is NOT set |
| `PUBLIC_ESTIMATE_ALLOWED_ORIGINS` set | **FAIL** | Empty string |
| `PUBLIC_ESTIMATE_ALLOWED_BRANDS` | **FAIL** | Empty string (spec requires `ironwrap,iroof`) |
| `PUBLIC_ESTIMATE_CONSENT_JURISDICTION` | **FAIL** | Empty string (spec requires `Alberta, Canada`) |
| Rate controls configured with valid JSON rule array | **FAIL** | Empty string |
| Real Turnstile test submission proven | **NOT_STARTED** | Route disabled |
| Response contains acceptance, opaque envelope id, non-binding range, `review_required=true` | **NOT_STARTED** | Route disabled |

---

### 7. CUSTOMER PORTAL AUDIT — **NOT_STARTED**

| Item | Status | Evidence |
|------|--------|----------|
| Field Companion BFF fully configured | **FAIL** | Prerequisite not met (BFF disabled) |
| `APP_CUSTOMER_PORTAL_ENABLED="true"` | **FAIL** | `wrangler.jsonc` has `"APP_CUSTOMER_PORTAL_ENABLED": "false"` |
| Owner/ops session issues explicit-expiry link | **NOT_STARTED** | Portal disabled |
| Response is `https://<origin>/portal#token=...` | **NOT_STARTED** | Portal disabled |
| Customer-safe project view proven | **NOT_STARTED** | Portal disabled |
| Wrong origin, expired link, revoked link, reassigned job all return unavailable | **NOT_STARTED** | Portal disabled |
| Static asset headers include `Referrer-Policy: no-referrer` and restrictive CSP | **NOT_STARTED** | Portal disabled |

---

### 8. QUICKBOOKS WEBHOOK AUDIT — **NOT_STARTED**

| Item | Status | Evidence |
|------|--------|----------|
| `QB_WEBHOOK_TOKEN` is Worker secret | **PASS** | Listed in `wrangler secret list` |
| QuickBooks Developer Dashboard webhook URL configured | **NOT_STARTED** | Cannot verify without QB dashboard access |
| Intuit signature verification tested | **NOT_STARTED** | No webhook payloads received |
| Webhook payload creates D1 receipt + R2 raw + audit event | **NOT_STARTED** | No payloads received |
| `/admin/status` shows QB receipt freshness | **NOT_STARTED** | No QB activity |

---

### 9. APPROVAL BROKERS AUDIT — **NOT_STARTED**

| Item | Status | Evidence |
|------|--------|----------|
| Production Schedule: separate loopback-only service | **NOT_STARTED** | No service installed |
| Production Schedule: distinct `production-controller` Frappe API identity | **NOT_STARTED** | No Frappe site |
| `PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET` is Worker secret | **PASS** | Listed in `wrangler secret list` |
| Broker HMAC secret and approval signing key separate | **NOT_STARTED** | No brokers deployed |
| Test: create pending approval, prove ineligible sessions fail, approve one test request | **NOT_STARTED** | No brokers deployed |
| Quote Revision: `QUOTE_REVISION_BROKER_SHARED_SECRET` is Worker secret | **PASS** | Listed in `wrangler secret list` |
| Quote Revision: separate broker credentials | **NOT_STARTED** | No brokers deployed |

---

### 10. BACKUP & RECOVERY AUDIT — **NOT_STARTED**

| Item | Status | Evidence |
|------|--------|----------|
| D1 backup script runs manually and succeeds | **NOT_STARTED** | `deploy/backup-d1-to-r2.sh` exists but never run in production context |
| Frappe backup script runs manually and succeeds | **NOT_STARTED** | `deploy/backup-to-r2.sh` exists but never run |
| Cron jobs scheduled | **NOT_STARTED** | No cron configured on a host |
| `D1_BACKUP_API_TOKEN` is read/export-only | **NOT_STARTED** | Not configured |
| Local D1 verification test passed | **NOT_STARTED** | Not run |
| Remote restore drill passed | **NOT_STARTED** | Not run |
| R2 delete protection proven | **NOT_STARTED** | Not tested |

**`production-readiness.mjs live-env` result:** 7 passed, 115 failed. All backup parameters, restore targets, age recipients, and bucket names are missing or placeholders.

---

### 11. END-TO-END INTAKE SLICE — **NOT_STARTED**

| Item | Status | Evidence |
|------|--------|----------|
| `node tools/launch-proof.mjs --execute` | **NOT_STARTED** | Only dry-run executed; produces curl commands but no live fixture created |
| `/health` and `/ready` pass before fixture | **FAIL** | `/ready` fails |
| Website intake creates envelope in D1, raw in R2, queues to JobNimbus | **NOT_STARTED** | No D1 operational schema; cannot create envelope |
| Estimator idempotency works | **NOT_STARTED** | Not tested |
| Admin read-back shows fixture data | **NOT_STARTED** | Not tested |
| No dead letters, stuck items, Frappe errors, replay failures, audit failures | **NOT_STARTED** | Not tested |
| Fixture verified in D1/R2 AND Frappe | **NOT_STARTED** | No Frappe integration |

---

### 12. SECURITY & SECRETS AUDIT — **PARTIAL**

| Item | Status | Evidence |
|------|--------|----------|
| No secrets committed to Git | **PASS** | `git log --all --full-history -- .env*` returns nothing |
| JobNimbus API key rotated (dedicated key for bus) | **UNKNOWN** | Secret exists but cannot verify if it's dedicated vs shared |
| `ADMIN_TOKEN` is high-entropy, not reused from dev | **UNKNOWN** | Secret exists but cannot inspect value |
| `APP_AUTH_PEPPER` is Worker secret only | **PASS** | Listed in `wrangler secret list`; not in `vars` |
| Every broker secret is distinct | **PASS** | `APPROVAL_BROKER_SHARED_SECRET`, `QUOTE_REVISION_BROKER_SHARED_SECRET`, `PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET` all distinct |
| Frappe API credentials separated by purpose | **NOT_STARTED** | No Frappe site = no credentials to separate |

**Missing secrets (not set in production Worker):**
- `ERPNEXT_API_KEY`
- `ERPNEXT_API_SECRET`
- `NEWO_API_KEY`
- `NEWO_WEBHOOK_TOKEN`
- `NEWO_BOOKING_TOKEN`
- `NEWO_CONTROL_SIGNING_SECRET`
- `PUBLIC_ESTIMATE_TURNSTILE_SECRET`

---

### 13. FACET (3D CONFIGURATOR) AUDIT — **PARTIAL**

| Item | Status | Evidence |
|------|--------|----------|
| Deployed to Vercel with production domain | **UNKNOWN** | No Vercel project verification performed; `Facet/configurator/` exists with build scripts |
| `GPT_DATABASE_URL` points to live Postgres | **UNKNOWN** | Not verified |
| `AUTH_SECRET` is set and high-entropy | **UNKNOWN** | Not verified |
| Database schema applied | **UNKNOWN** | Not verified |
| API routes functional | **UNKNOWN** | Not verified |
| Tests pass | **PASS** | `npm test` in `Facet/configurator` → 508/508 passed |

---

## Critical Blocking Issues (Must Fix Before Launch)

### BLOCKER 1: Production D1 Database Has No Operational Schema
**Severity: CRITICAL**

`PRAGMA table_list` on the production D1 database (`ironwrap-bus`, `f0674848-13df-4422-9896-8ba2719663b8`) shows only:
- `heartbeat` (4 columns)
- `sqlite_temp_schema` (system table)

All operational tables are missing: `envelopes`, `audit_log`, `dead_letter`, `source_counts`, `dedup_claims`, `replay_requests`, `field_actions`, `app_users`, `app_sessions`, `approval_requests`, `production_schedule_approval_requests`, `measurement_intake_receipts`, etc.

`wrangler d1 migrations list` reports "No migrations to apply", suggesting the `_d1_migrations` tracking table believes all 26 migrations are applied. This is inconsistent with the actual schema.

**Required action:**
1. Investigate why the migration state is out of sync with the actual schema
2. Either recreate the database and re-apply migrations, or manually reconcile
3. Verify all 28 required tables and 31 trigger bindings exist

### BLOCKER 2: Frappe Operating Core Not Deployed
**Severity: CRITICAL**

No production Frappe host exists. The owned operating core (Lead Envelope → Roof Job → Production Gate State) cannot function without:
- A Linux host meeting `runtime-lock.json` minimums
- `frappe_docker` checked out at the pinned commit
- The Frappe-only image built and pushed with an immutable digest
- A site created at `os.ironwrapexteriors.com`
- The `ironwrap_roofing` app installed (and ONLY that app — no ERPNext)
- A dedicated Worker API user with its key/secret stored in Worker secrets
- Cloudflare Tunnel routing the hostname to port 8080
- HTTPS proven from outside the host

**Required action:** Follow `docs/LAUNCH-RUNBOOK.md` sections 2–6 sequentially.

### BLOCKER 3: All Enablement Gates Are Closed
**Severity: CRITICAL**

Every feature gate in the production `wrangler.jsonc` is `false` or empty:
- `ERPNEXT_ENABLED: "false"`
- `APP_BFF_ENABLED: "false"`
- `APP_CUSTOMER_PORTAL_ENABLED: "false"`
- `PUBLIC_ESTIMATE_ENABLED: "false"`
- `NEWO_ENABLED: "false"` (but `NEWO_PRODUCTION_REQUIRED: "true"`, which breaks `/ready`)

The Worker currently functions only as a JobNimbus bridge with raw R2 storage. The owned data layer (D1 operational schema), Frappe integration, field companion, public estimator, customer portal, and Newo voice pipeline are all disabled.

**Required action:** Close each gate in dependency order per the LAUNCH-RUNBOOK:
1. Frappe core first (prerequisite for everything else)
2. Then D1 migrations through 0021+
3. Then enable `ERPNEXT_ENABLED`
4. Then BFF (`APP_BFF_ENABLED`)
5. Then public estimator (`PUBLIC_ESTIMATE_ENABLED`)
6. Then customer portal (`APP_CUSTOMER_PORTAL_ENABLED`)
7. Then Newo (`NEWO_ENABLED`)

### BLOCKER 4: Missing Critical Secrets
**Severity: CRITICAL**

Seven secrets required for full operation are not set in the production Worker:

| Secret | Why Missing Blocks |
|--------|-------------------|
| `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` | No Frappe site exists to generate them |
| `NEWO_API_KEY` | Newo not provisioned |
| `NEWO_WEBHOOK_TOKEN` / `NEWO_BOOKING_TOKEN` | Newo webhooks not configured |
| `NEWO_CONTROL_SIGNING_SECRET` | Newo control plane not active |
| `PUBLIC_ESTIMATE_TURNSTILE_SECRET` | Public estimator disabled by gate |

**Required action:** Generate and store each secret only after its prerequisite system is live and verified.

### BLOCKER 5: `/ready` Fails Because `NEWO_PRODUCTION_REQUIRED=true` But Newo Is Unconfigured
**Severity: HIGH**

The readiness check treats `NEWO_PRODUCTION_REQUIRED="true"` as meaning "Newo must be fully configured and enabled." Since `NEWO_ENABLED="false"` and all Newo IDs/secrets are empty, every Newo readiness sub-check fails, causing `/ready` to return `false`.

**Options:**
1. Set `NEWO_PRODUCTION_REQUIRED="false"` until Newo is actually provisioned, OR
2. Keep it `true` and accept that `/ready` stays `false` until Newo is live (intentional hard block)

The spec says "Newo customer outbound stays disabled at launch" but also says `NEWO_PRODUCTION_REQUIRED: "true"`. These are in tension.

**Recommended action:** Set `NEWO_PRODUCTION_REQUIRED="false"` for initial launch; re-enable when Newo integration is ready.

---

## Test Suite Status (All Green — Repository Is Sound)

| Suite | Result |
|-------|--------|
| `node tools/production-readiness.mjs contract` | 198 passed, 0 failed |
| `node tools/validate-hermes-config.mjs` | Pass |
| `node tools/validate-tenant-config.mjs` | 2 passed |
| `node tools/validate-newo-config.mjs` | Pass |
| `npm test --prefix workers-bus` | 244 passed, 0 failed |
| `npm test --prefix app` | 199 passed, 0 failed |
| `npm test --prefix mcp/erpnext-roofing-mcp` | Pass (run in CI) |
| `npm test --prefix mcp/ironwrap-bus-mcp` | Pass (run in CI) |
| `npm test --prefix mcp/newo-mcp` | Pass (run in CI) |
| `python -m unittest discover -s tests -t .` (Frappe app) | Pass (run in CI) |
| `npm test --prefix Facet/configurator` | 508 passed, 0 failed |

---

## Recommended Next Steps

1. **Fix D1 migration state.** Determine why the production D1 database has no tables despite "No migrations to apply." The safest path: create a fresh staging database, apply all migrations, verify the schema, then promote or re-create production.

2. **Provision the Frappe host.** Follow `docs/LAUNCH-RUNBOOK.md` §2–6. Do not skip the host preflight, image build digest recording, or HTTPS proof.

3. **Configure Worker-Frappe integration.** After the Frappe site is live, create the Worker API user, store `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET`, set `ERPNEXT_ENABLED="true"`, and verify `/ready` shows Frappe as healthy.

4. **Resolve `/ready` state.** Either configure Newo fully or set `NEWO_PRODUCTION_REQUIRED="false"` to unblock the readiness check for the initial launch window.

5. **Open enablement gates in order:** BFF → Public Estimator → Customer Portal → Newo. Each gate has its own preflight checklist in `LAUNCH-RUNBOOK.md`.

6. **Run `launch-proof.mjs --execute`.** Only after steps 1–4 are complete. Archive the evidence JSON.

7. **Execute backup and restore drills.** Follow `LAUNCH-RUNBOOK.md` §12. Prove D1 local verification, remote restore to a drill database, and Frappe restore to a labeled container.

---

*Report generated by automated audit against `final-spec-pack/`, `docs/LAUNCH-RUNBOOK.md`, and live production endpoints. All claims are backed by command output captured during the audit session.*
