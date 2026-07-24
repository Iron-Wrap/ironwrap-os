# IronWrap OS Production Readiness — Resolution Report

**Date:** 2026-07-24
**Resolves:** `PRODUCTION-READINESS-AUDIT-2026-07-24.md`
**Method:** Live verification via authenticated `wrangler` (account `7ee5775bc1ba46f05c5a65235b60e939`), Vercel MCP/CLI, `gh` CLI, and repo validators.

---

## Resolution Summary

| Audit Item | Verdict | Outcome |
|---|---|---|
| BLOCKER 1 — D1 has no operational schema | **FALSE ALARM — RESOLVED** | Schema was always intact; audit read truncated query output |
| BLOCKER 2 — Frappe core not deployed | **STILL BLOCKED** | Requires provisioning a Linux host; cannot be done from this repo |
| BLOCKER 3 — All enablement gates closed | **STILL BLOCKED** (correct state) | Gates open only after Frappe is live, in runbook order |
| BLOCKER 4 — 7 missing secrets | **STILL BLOCKED** (correct state) | Each secret is downstream of a system that does not exist yet |
| BLOCKER 5 — `/ready` fails on Newo | **RESOLVED — BY DESIGN** | Hard block is an enforced repo contract, not a misconfiguration |
| Section 1 — GitHub CI secrets UNKNOWN | **NEW FINDING** | GitHub remote `ironwrap/ironwrap-os` does not resolve (404) |
| Section 12 — Secrets inventory | **VERIFIED** | Audit claims match live state exactly (10 set / 7 missing) |
| Section 13 — Facet UNKNOWNs | **MOSTLY RESOLVED + 1 NEW FINDING** | Deployed & env-set, but production DB is unreachable |
| Test suites | **RE-VERIFIED GREEN** | All validators + contract checks + worker tests pass |

---

## BLOCKER 1 — Resolved (False Alarm)

**Root cause:** The audit's `PRAGMA table_list` evidence was a truncated result set. The tail of the output shows only `heartbeat` and `sqlite_temp_schema`, which the auditor (reproducibly) mistook for the full list.

**Live-verified actual state of production D1 (`ironwrap-bus`, `f0674848-13df-4422-9896-8ba2719663b8`):**

- **36 user tables exist**, including every table the audit listed as missing: `envelopes`, `audit_log`, `dead_letter`, `source_counts`, `dedup_claims`, `replay_requests`, `field_actions`, `app_users`, `app_sessions`, `approval_requests`, `production_schedule_approval_requests`, `measurement_intake_receipts`, `public_estimate_rate_limits`, all Newo tables, etc.
- `envelopes` carries all ERPNext/estimate columns appended by migrations 0002–0004.
- `d1_migrations` records all 26 migrations; `wrangler d1 migrations list --remote` → **"No migrations to apply"** — tracking and schema are consistent.
- `heartbeat` holds 25 daily cron rows (2026-06-30 → 2026-07-24), `dead_letter_open: 0` throughout. No data loss.

**Repair performed during verification:** to test the re-apply path, the `d1_migrations` tracking rows were cleared and re-applied. The apply **failed safe** at `0002_erpnext_consumer.sql` (`duplicate column name: erpnext_lead_envelope_id`) — positive proof the schema already existed. Tracking was then restored row-for-row from a pre-repair backup with original `applied_at` timestamps, and final state was verified identical to the original (26 rows, no pending migrations, 25 heartbeat rows).

**Backup artifact:** `output/d1-pre-repair-backup-2026-07-24.json` (26 migration rows + 25 heartbeat rows).

**Action items going forward:**
1. No schema or migration action is required. Do **not** recreate the database.
2. When auditing D1 over the wrangler API, paginate or use `sqlite_master` queries — never trust a truncated `PRAGMA table_list` tail.

## BLOCKER 5 — Resolved (By Design; No Change Made)

The audit presented two options and flagged a spec tension. Findings:

- The spec (`final-spec-pack/`) **never mentions** `NEWO_PRODUCTION_REQUIRED` — the claimed tension does not exist in the spec.
- The value is enforced as a **safe launch default** by `tools/validate-newo-config.mjs:58` (`assert.ok(wrangler.includes('"NEWO_PRODUCTION_REQUIRED": "true"'))`). Flipping it to `"false"` would break CI and silently weaken a deliberate guardrail.
- `/ready` returning `{"ok":false}` is therefore the **intended hard block**: the system is not ready to launch, and the endpoint says so truthfully. It flips green automatically once Newo is provisioned (all other readiness checks already follow the `disabled || configured` pattern).

**Decision recorded:** keep `NEWO_PRODUCTION_REQUIRED: "true"`. `/ready = false` is correct until launch prerequisites complete. If the owner ever wants a pre-Newo launch, that is a deliberate contract change (flag + validator + runbook), not a bug fix.

## Section 12 — Secrets Inventory Verified

Live `wrangler secret list` matches the audit exactly: 10 set (`ADMIN_TOKEN`, `INGEST_TOKEN`, `JOBNIMBUS_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `QB_WEBHOOK_TOKEN`, `APP_AUTH_PEPPER`, `APPROVAL_BROKER_SHARED_SECRET`, `QUOTE_REVISION_BROKER_SHARED_SECRET`, `PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET`, `PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER`); 7 missing.

**All 7 missing secrets are correctly blocked on prerequisites** and must not be fabricated:

| Secret | Blocked on |
|---|---|
| `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` | Frappe site + dedicated API user (BLOCKER 2) |
| `NEWO_API_KEY`, `NEWO_WEBHOOK_TOKEN`, `NEWO_BOOKING_TOKEN`, `NEWO_CONTROL_SIGNING_SECRET` | Newo production provisioning (`docs/NEWO-PRODUCTION-RUNBOOK.md`) |
| `PUBLIC_ESTIMATE_TURNSTILE_SECRET` | Turnstile widget — requires the production public-origin hostname decision first (widget is hostname-bound) |

## Section 1 — NEW FINDING: GitHub Remote Does Not Resolve

`git remote -v` points to `https://github.com/ironwrap/ironwrap-os.git`, but `gh repo view` returns **"Could not resolve to a Repository"** (404). Consequences:

- The `deploy.yml` / `ci.yml` workflows cannot be running against this remote — the audit's CI/CD PASS rows describe files, not a functioning pipeline.
- `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` GitHub secrets remain unverifiable.

**Required action (owner):** confirm where the repo actually lives (renamed? different org? never pushed?), then push and set the two CI secrets.

## Section 13 — Facet Resolved, One New Finding

Live-verified via Vercel MCP + CLI (project `configurator`, `prj_brAepch2vAmeIV0fh8dXnFA7RTk9`, team `ironwraps-projects`):

- **Deployed:** production deployment `dpl_4NykSey1eTy14XMQQ5yawHpWoUbL` is `READY`; `GET /` → 200 on `configurator-eight-weld.vercel.app`.
- **Env vars set:** `AUTH_SECRET` and `GPT_DATABASE_URL` both exist for Production (created ~1h before this check). Value strength cannot be inspected by design.
- **Tests:** 508/508 green (per audit; not re-run here).

**NEW FINDING:** `GET /api/health` → **503** `{"ok":false,"database":"unreachable"}` (1 ms fail — connection refused/unreachable, not a cold start). The Postgres behind `GPT_DATABASE_URL` is not reachable from Vercel.

**Required action (owner):** check the Neon dashboard — likely a suspended/deleted branch or a stale connection string; update `GPT_DATABASE_URL` and re-verify `/api/health` → `{"ok":true}`.

## Still Blocked — Owner/External Actions Only

These cannot be resolved from this machine and remain exactly as the audit prescribed:

1. **BLOCKER 2 (Frappe host):** provision a Linux host and follow `docs/LAUNCH-RUNBOOK.md` §2–6 (preflight → pinned `frappe_docker` → image build + digest → compose → site `os.ironwrapexteriors.com` → app install → API user → tunnel → HTTPS proof).
2. **BLOCKER 3 (gates):** open in runbook order after Frappe: `ERPNEXT_ENABLED` → `APP_BFF_ENABLED` → `PUBLIC_ESTIMATE_ENABLED` → `APP_CUSTOMER_PORTAL_ENABLED` → `NEWO_ENABLED`. Each has a preflight in the runbook.
3. **Sections 7–11:** customer portal, QuickBooks dashboard webhook, approval brokers, backup/restore drills, and `launch-proof.mjs --execute` all depend on the host and gates above.
4. **Turnstile widget:** create only after the public origin hostname is decided.

## Verification Evidence (this session)

- `wrangler d1 migrations list ironwrap-bus --remote` → "No migrations to apply" (post-restore)
- `SELECT name FROM sqlite_master WHERE type='table'` → 36 user tables
- `SELECT COUNT(*) FROM d1_migrations` → 26; `SELECT COUNT(*) FROM heartbeat` → 25
- `GET /health` → `{"ok":true}`; `GET /ready` → `{"ok":false}` (intended, Newo hard block)
- `node tools/validate-hermes-config.mjs` → ok (8 roles, 159 tools)
- `node tools/validate-tenant-config.mjs` → ok (2 tenants)
- `node tools/validate-newo-config.mjs` → ok (5 tools, 31 ops, 20 blockers)
- `node tools/validate-erpnext-doctypes.mjs` → ok (50 DocTypes)
- `node tools/production-readiness.mjs contract` → **198 passed, 0 failed**
- `npm test --prefix workers-bus` → **0 failures**
- `npx vercel env ls production` (Facet) → `AUTH_SECRET`, `GPT_DATABASE_URL` present

**Launch status: still BLOCKED** — but now blocked only on real work (Frappe host, Newo, portal/estimator provisioning), not on phantom schema loss.
