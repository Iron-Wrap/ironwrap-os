# Operations Runbook (Maturity Gate 13)

Day-2 operations for the IronWrap OS bus and its consumers. Gate 13 (blueprint): "Tenant
setup, monitoring, support, backups, billing, and incident playbooks exist." Tenant setup
lives in `docs/WHITE-LABEL-CLONE-PLAYBOOK.md`; this runbook covers monitoring, incidents,
backups, secrets, escalation, and cadence.

All routes below exist in `workers-bus/src/index.ts`. Admin routes require
`Authorization: Bearer <ADMIN_TOKEN>`; ingest routes require `INGEST_TOKEN`.

## Monitoring

| Signal | Source | Healthy state |
| --- | --- | --- |
| Daily reconcile digest email | `runReconcile` in `workers-bus/src/index.ts`, cron `0 14 * * *` (wrangler.jsonc) | Subject starts with a check mark: 0 gaps, 0 open dead-letter. The email IS the heartbeat: if it does not arrive, the reconcile did not run |
| Heartbeat row | `store.writeHeartbeat` inside `runReconcile` writes a D1 row per day | Row exists for today with green status; query via `wrangler d1 execute ironwrap-bus --remote` |
| `GET /health` | Worker fetch handler | 200. Wire an external uptime check at the bus URL |
| `GET /admin/dead-letter` | Lists open dead-letter rows | Empty list |
| `GET /admin/envelopes` | Recent envelopes with status | No long-lived `pending_jn_push` rows older than `STUCK_THRESHOLD_MIN` (15 min default) |
| `POST /admin/reconcile` | Runs the same reconcile on demand | Use to re-check after fixing a gap |
| Worker logs | `observability.enabled: true` in `workers-bus/wrangler.jsonc`; structured `log({at: ...})` lines | No repeated `at: queue` errors |

Source-vs-landed reconciliation needs independent source counts: external feeds report
daily totals to `POST /admin/source-count` with `{day, channel, count}`.

## Incident Playbooks

### Dead-letter replay

Symptom: DEAD-LETTER alert email (sent by `handleDead`) or non-empty `GET /admin/dead-letter`.

1. Read the failure: `GET /admin/dead-letter`, then `GET /admin/envelope/<envelope_id>`
   for the full record (`last_error`, attempts). Dead-letter payload copies are redacted;
   the raw body is still in R2 under the envelope's `raw_key`.
2. Fix the cause (credential, upstream outage, bad config) BEFORE replaying.
3. Replay: `POST /admin/replay`. Note this re-drives ALL envelopes with status `dead`
   (up to 500 per call) back through the push queue and marks dead-letter rows recovered;
   there is no per-envelope replay route.
4. Verify: `GET /admin/dead-letter` empty, envelopes reach `pushed`.

### Stuck envelopes (retry sweep)

The `*/5 * * * *` cron runs `retrySweep`, which re-enqueues envelopes stuck in
`pending_jn_push` longer than `STUCK_THRESHOLD_MIN`. This is the automatic backstop for a
lost queue message. If the same envelopes stay stuck across sweeps, the push itself is
failing; look at `last_error` via `GET /admin/envelope/<id>` and treat as an outage of the
target system, not a queue problem.

### Frappe site down

The IronWrap OS Frappe site (the bridge keeps its erpnext-* naming) can be down without data
risk. `handlePush` throws on Frappe-site failure, which keeps the envelope pending and lets
queue retries (max 5, then DLQ) preserve the proof path; the envelope, raw R2 body, and audit
rows already exist. When the Frappe site recovers, retries or the retry sweep complete the
mirror. If envelopes dead-lettered during the outage, run the dead-letter replay above after
the site is back.

### QuickBooks webhook signature failures

`POST /webhook/quickbooks` returns 401 `bad_signature` when the `intuit-signature` HMAC
does not match `QB_WEBHOOK_TOKEN`, and 503 `quickbooks_not_configured` when the secret is
unset (`workers-bus/src/quickbooks.ts`).

1. Confirm the verifier token in the Intuit developer portal matches the Worker secret;
   re-set with `npx wrangler secret put QB_WEBHOOK_TOKEN` from `workers-bus/`.
2. Intuit retries failed deliveries, and the receiver has a payload-hash replay guard
   (migration `0005_quickbooks_webhook_receipts.sql`), so re-deliveries after the fix are
   safe and idempotent.
3. If events were missed during the window, reconcile invoice/payment state manually in
   QuickBooks; QuickBooks remains accounting truth.

### JobNimbus 400 on unknown source_name

Known account behavior: the JobNimbus account 400s on unknown `source_name` values, so the
push payload must OMIT `source_name` entirely (see `CLAUDE.md` and
`workers-bus/src/jobnimbus.ts`). If a 400 appears in `last_error` mentioning source:

1. Do not add source values to JobNimbus payloads; source attribution lives on the bus
   envelope and as JobNimbus tags (`brand:*`, `bus:*`).
2. Also verify record types: contact `Customer`, job `Retail`; `"Lead"` is rejected with 400.
3. After fixing, replay via `POST /admin/replay`.

## Backup and Data Ownership

| Store | Role | Recovery property |
| --- | --- | --- |
| D1 (`ironwrap-bus` database) | System of record: envelopes, audit, dead-letter, heartbeats, dedup claims, QB receipts | Schema rebuildable from `workers-bus/migrations/`; export via `wrangler d1 export`. Everything downstream can be rebuilt from D1 + R2 |
| R2 (`ironwrap-bus-raw` bucket) | Immutable raw inbound payloads, stored FIRST before any processing | Any envelope can be re-derived from its `raw_key` object |
| Frappe site (IronWrap OS) | Operating mirror (Lead Envelope, Roof Job, gates, evidence records) | Re-populatable by replaying envelopes; not the system of record |
| Google Drive Shared Drives (IW Jobs / Restricted / Archive) | Human-facing job files and archive | Drive-native versioning/trash; IDs in `wrangler.jsonc` vars |
| QuickBooks | Accounting truth (invoices, payments) | Owned by Intuit; the bus only mirrors status |

Ownership rule: customer/tenant data lives in tenant-owned D1/R2/Drive/Frappe/QuickBooks,
never only inside a vendor tool. JobNimbus is a temporary bridge and holds no unique truth.

## Secret Rotation

Set from `workers-bus/`: `printf '%s' '<value>' | npx wrangler secret put <NAME>`, or bulk
via `bash workers-bus/scripts/apply-secrets.sh` (reads `ACCESS.env`, skips empty values).
Local dev values go in `workers-bus/.dev.vars` (gitignored; template `.dev.vars.example`).

| Secret | Rotation notes |
| --- | --- |
| `JOBNIMBUS_API_KEY` | KNOWN DEBT: the current key was shared in chat and must be rotated to a dedicated bus key (`docs/ACTIVATION-CHECKLIST.md` section 6). Rotate in JobNimbus admin, then `wrangler secret put` |
| `INGEST_TOKEN` | Rotate, then update every source that POSTs to `/ingest/*` (website forward, Make module, Jotform bridge) |
| `ADMIN_TOKEN` | Rotate, then update operator tooling and `mcp/ironwrap-bus-mcp` env (`IRONWRAP_ADMIN_TOKEN`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Mint a new service-account key in Google Cloud, apply, then delete the old key |
| `QB_WEBHOOK_TOKEN` | Must match the Intuit developer portal verifier token; change both together |
| `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` | Regenerate on the Frappe site (env names keep the ERPNEXT_* prefix for compatibility); also update `mcp/erpnext-roofing-mcp` env |
| `HERMES_WRITE_TOKEN`, `ERPNEXT_WRITE_ENABLED` | MCP-side write guards (not Worker secrets); rotate the token per tenant, keep the flag false unless approved writes are in use |

Never commit secret values. After any rotation, send a test lead and confirm the ack path
end to end.

## Escalation and Severity

Contacts: primary `OWNER_ALERT_EMAIL` (info@ironwrapexteriors.com), backup
`BACKUP_ALERT_EMAIL` (sales@ironwrapexteriors.com), maintainer Ilia via Claude Code.

| Severity | Definition | Examples | Response |
| --- | --- | --- | --- |
| SEV1 | Lead loss possible or ingest down | `/ingest/*` erroring, R2/D1 writes failing, Worker down | Act immediately; fix ingest before anything else. Raw-first design means true loss requires R2 and D1 both failing |
| SEV2 | Leads captured but not flowing | Dead-letters accumulating, JobNimbus/Frappe push failing, ack emails not sending | Same business day; replay after fix |
| SEV3 | Degraded visibility or stale mirrors | Reconcile gaps, missed digest, QB webhook 401s, Drive filing failing | Within 1 to 2 business days |
| SEV4 | Cosmetic or debt | Known rotation debt, placeholder config, doc drift | Next weekly review |

Escalation path: digest/alert email -> owner -> backup owner -> maintainer. A missing
digest email is itself SEV2 (heartbeat failure): check the D1 heartbeat row and Worker logs.

## Operational Cadence

Weekly:

- Review the 7 daily digests; chase any gap or dead-letter day.
- Spot check `GET /admin/dead-letter` and `GET /admin/envelopes`.
- Confirm the uptime check on `GET /health` is green.
- Review Worker error logs (observability dashboard).
- Triage SEV4 backlog (rotation debt, placeholders in `config/tenants/*.json`).

Monthly:

- Market defense pass per `market_defense.watch_cadence_days: 30` in the tenant config;
  route findings to `escalation_owner`.
- D1 export snapshot and R2 spot-restore test (pull one raw object, re-derive its envelope).
- Secret audit: age of each secret above; execute pending rotations (JobNimbus key first).
- Re-run `node tools/validate-tenant-config.mjs` and `node tools/validate-erpnext-doctypes.mjs`.
- Verify crons fired daily (heartbeat rows have no missing days).
- Review quiet-hours and CASL consent settings against any brand/geography changes.
