# IronWrap OS Operations Runbook

Status: current runbook for the D1/Worker operating plane; Frappe and Hermes steps are conditional
compatibility procedures, not operating authority.

Day-2 monitoring, incident recovery, replay, secret rotation, backup, and restore procedure for
the Worker-owned operating plane and any explicitly enabled compatibility projections. Tenant creation is in
`docs/WHITE-LABEL-CLONE-PLAYBOOK.md`; initial deployment is in `docs/LAUNCH-RUNBOOK.md`.
The canonical authority and proof boundaries are in
[`AI-NATIVE-ARCHITECTURE.md`](./AI-NATIVE-ARCHITECTURE.md).

Admin routes require `Authorization: Bearer <ADMIN_TOKEN>`. Never put the token in a URL,
request body, log line, incident ticket, or command history.

## Operational Truth Surfaces

| Surface | Auth | Meaning | Healthy state |
| --- | --- | --- | --- |
| `GET /health` | none | Worker isolate liveness only | HTTP 200; does not prove dependencies |
| `GET /ready` | none for `{ok}`; admin for diagnostic checks | D1 schema query plus R2/Queue binding and required native configuration; enabled provider/compatibility checks apply only to their configured scopes; `?scope=ops` additionally gates on both crons having ticked recently | HTTP 200 and every authenticated required check true; HTTP 503 blocks traffic cutover |
| `GET /admin/status` | admin | Heartbeat freshness, pending/stuck/dead counts, provider/projection errors, audit failures, latest QB receipt, per-cron tick freshness (`crons`) | `status: ok`; investigate every degraded reason. A stale cron is evidence here — it never moves `status` |
| `GET /admin/dead-letter` | admin | Open forensic dead-letter rows | Empty |
| `GET /admin/envelopes` | admin | Recent canonical envelopes and status | No unexplained pending/dead records |
| `POST /admin/reconcile` | admin | Source-vs-landed reconcile and heartbeat | No unexplained gap; new heartbeat written |
| Worker structured logs | Cloudflare account | Request, queue, retry, reconcile, and recovery errors | No repeated error signature |

`/admin/status` treats a missing/stale/non-reconciled heartbeat, open dead letters, stuck
envelopes, enabled projection errors, failed/stuck replay requests, or recent audit failures as degraded.
Its heartbeat freshness window is 36 hours and recent-audit window is 24 hours. It reports the
latest QuickBooks receipt and 24-hour freshness separately; lack of recent QB activity is not by
itself a system outage.

Separately, both crons write a heartbeat row (`cron_heartbeat`) at the start and the end of their
composed work: the `*/5 * * * *` sweep is fresh for 10 minutes after its last tick started, and the
daily `0 14 * * *` reconcile is fresh for 26 hours — tighter than the 36-hour heartbeat window above,
so it cannot ride a green `/admin/status` to a dead daily cron. The startup grace for a never-ticked
row is per-cron, not one shared constant: the 20-minute deploy stretch (migration-apply through
cutover to the first tick a deployed revision can write) plus the cron's own freshness window — 30
minutes for `*/5` and 26 h 20 min for the daily, wider than its 24-hour period so its first tick
always lands inside it. `/admin/status` carries this as the `crons` block and it never changes
`status`; the gate is the token-less `GET /ready?scope=ops`, which returns 503 when either cron is
stale and is what the qa deploy polls after cutover. `crons[].status` is `seeded|running|ok|error`;
`error` means the tick fired and its composed work threw — the same failure also surfaces as an
errored invocation on the Cloudflare Cron Triggers tab, and an operator reading `error` here should
check there next.

`/ready` does not contact every configured downstream API or perform an R2/Queue mutation. Its
unauthenticated response is deliberately limited to `{ok}`; send `ADMIN_TOKEN` to receive the
diagnostic check map. Pair it with targeted smoke evidence for every provider or compatibility
projection enabled during launch and incidents.

### Cross-service correlation proof

For an approved synthetic Facet event, preserve its immutable `event_id` and search the configured
Facet, Cloudflare Worker, and Frappe log backends for that exact value. A passing trace contains:

1. one Facet delivery outcome keyed by the event id;
2. one Worker `http_request_completed` record whose `request_id` is the event id; and
3. one Frappe `http_request_completed` record whose `request_id` and `envelope_id` are the event id.

Every completion record must contain only the route path, never its query string, and must not
contain request bodies, authorization headers, credentials, customer contact data, or arbitrary
exception text. Missing, duplicate, or mismatched records fail the trace. Record the exact release
SHAs, UTC window, event id, and log-backend query receipts; a local test or synthetic trace is not
customer proof.

The scheduled `0 14 * * *` reconcile email is also a heartbeat. If no digest arrives, check
`GET /ready?scope=ops` first — it is a single token-less read of `cron_heartbeat` rather than
waiting on mail delivery — then `/admin/status`, the D1 heartbeat row, cron execution, and email
delivery before assuming the reconcile succeeded.

Source-vs-landed reconciliation needs independent source counts. Authorized source adapters send
daily `{day, channel, count}` facts to `POST /admin/source-count`; do not synthesize counts from
the same D1 envelopes being checked.

## App Identity And Portal Control Plane

`ADMIN_TOKEN` is not steady-state authority to mint office users. Keep app identity control split
between first-owner bootstrap and authenticated office administration:

1. `POST /admin/app-users/bootstrap` is a one-time, default-off ceremony for the first owner only.
   It requires both the existing admin bearer and `APP_FIRST_OWNER_BOOTSTRAP_ENABLED=true`,
   accepts only the strict owner bootstrap body, derives audit attribution server-side, inserts
   only while the tenant still has zero `app_users`, and must return a stable denial on replay.
   Turn the flag back off immediately after that first successful insert.
2. Every later owner, ops, or field identity must be issued from an authenticated owner/ops office
   session through the app API with CSRF protection. Admin bearer requests alone must fail for this
   path.
3. Customer portal links stay revocable only while the BFF, exact `APP_PUBLIC_ORIGIN`,
   matching `APP_ALLOWED_ORIGINS`, and office session path remain healthy. A wrong origin or
   disabled BFF must fail closed rather than silently widening acceptance.
4. Contract-acceptance email is a separate backend gate. The portal must not advertise an
   acceptance CTA unless the live configuration resolves the dedicated acceptance service/HMAC/API
   pair as available.

## Seeding A Non-production Environment

`tools/seed-env.mjs` fills an empty `qa` (or a local `wrangler dev`) with clearly synthetic data
in one idempotent run, and refuses to run against production on its own:

```bash
ADMIN_TOKEN=... INGEST_TOKEN=... node tools/seed-env.mjs --env qa [--leads N] [--json]
node tools/seed-env.mjs --base-url http://localhost:7100                 # loopback only
make seed ENV=qa            # ADMIN_TOKEN/INGEST_TOKEN from your own environment
make seed BASE_URL=http://localhost:7100   # both tokens sourced from workers-bus/.dev.vars
```

`ADMIN_TOKEN` and `INGEST_TOKEN` come from the environment only - never a command-line argument,
never logged, never present in `--json` output.

**The guard**, checked before any request: `--env` must name an environment other than the
production block (bare, `production`, or an empty string is refused); a `--base-url` must resolve
to `localhost`, `127.0.0.1`, `::1` or `ironwrap.localhost`; the selected environment's D1 database
id and public-origin hostname must both differ from the ones `workers-bus/wrangler.jsonc` commits
for production. Then, still before any write, `GET /health` must answer 200 and the 100 most recent
rows from `GET /admin/envelopes` must carry no non-synthetic `contact_email` - a target that already
holds real-looking data is refused outright.

**What it seeds**, in order: an owner-user bootstrap; the shipped JobNimbus synthetic snapshot
flattened into `generic` CRM-import rows (12 rows: one per job, one per contact with no job);
`--leads N` (default 3, capped at 25) synthetic website leads, one synthetic estimate submission,
and the committed synthetic AppliCad measurement fixture. Markers throughout: `synth-` ids,
`example.invalid` addresses, `555` phone blocks - never anything that looks like a real person.
The seeded AppliCad XML carries no `job_number`, so it lands as a no-job report in
`/admin/measurements/exceptions` (`docs/LAUNCH-RUNBOOK.md`) rather than as a matched measurement.

**Owner step it does not perform**: the pipeline board. The tool writes
`output/seed-env/<env>/pipelines.sql` and prints the exact `wrangler d1 execute` command; applying
it against a real D1 is the owner's action, same as every other Ansible/Cloudflare apply.

**Idempotence**: every step's `created` is 0 from the second run on, and the `counts` block is
byte-identical from the second run on; run 1 and run 2 differ by design, each `created` becoming
the matching `kept`. A `crm_import_runs` row (and its `crm_import_issues` rows) is written on
every run regardless - that per-run ledger is expected, not a violation of "nothing new". The
no-op rests on the seeded leads still being inside the 100 most recent envelopes: past that cap,
the `GET /admin/envelopes` pre-check stops seeing them, and only `/ingest/*`'s 72h dedup window
keeps a re-run from creating new ones. One named exception: `/ingest/measurement` answers 202
`processing` with no `idempotent_replay` both on a first submission and on a repeat made before
the measurement queue drains that receipt, so a second run started inside that window reports
`measurement_intake: created=1` again, and reports `kept=1` once the receipt has settled - queue
timing, not a re-run bug.

**Exit codes**: `0` seeded, `1` refused before any write, `2` usage, `3` ran and at least one
attempted write failed, or crashed after a write. Exit `1` means no write was attempted, and stderr
says why in one of four shapes:

1. A committed input that cannot be read or parsed (the synthetic fixture, the AppliCad XML, the
   pipeline template): `refused: a committed input could not be loaded: ` followed by the error's
   stack. When it is the fixture generator itself that fails, the generator's own uncaught error
   prints first.
2. An unreachable pre-write read (`/health`, `/admin/envelopes`, `/ready`, `/admin/status`): one
   line, `refused: GET <url> is unreachable: ` and the transport code or message, for example
   `UND_ERR_SOCKET` or `ECONNREFUSED`.
3. Every other guard refusal - a production or non-loopback target, a non-200 `/health`, a 401
   `/admin/envelopes`, a non-synthetic fixture row or envelope: its own one-line `refused: ` message.
4. An unexpected error in the guard path itself - a malformed `workers-bus/wrangler.jsonc`, for
   one: a bare stack and no `refused:` line.

Without `--json`, a refusal raised after the fixture generator has run comes after the generator's
one `synthetic snapshot: ...` line on stdout.

For every failure the step classifiers see, each step still reports
created/kept/skipped/`failed` and the full report prints before the process exits 3. One class
stays outside that promise: a crash the classifiers never see - a dropped connection mid-write, a
Cloudflare-side error, or a failure writing `output/seed-env/<env>/pipelines.sql` - prints a stack
trace and exits 3 with no `counts` block at all. Exit 3 with no report therefore means writes may
have landed and none of them is accounted for: read `GET /admin/envelopes` on the target before
re-running. Every offline input - the synthetic JobNimbus fixture, the AppliCad XML, the pipeline
template - is read and validated before the first write, so no missing or unreadable committed
file can put you in that state. A `/ready` or `/admin/status` that answers is reported in `run`
(`ready_status`, `admin_status`), never in `counts`, and never moves the exit code: the probe is a
read and the exit code is about writes. One that cannot be reached at all is a different thing: it
refuses at exit `1` before the first write, like any other unreachable pre-write read.

**Rollback**: the seeded rows are all synthetic and identifiable (`synth-` ids, `example.invalid`
addresses). Either delete them per table with `wrangler d1 execute --remote`, or reset that
environment's D1 the way #290 reset qa on 2026-09-27. Nothing in the repository undoes a seeded
row, and the `crm_import_runs` / `crm_import_issues` ledger grows monotonically by design.

**When a step is skipped rather than run**: `APP_FIRST_OWNER_BOOTSTRAP_ENABLED=false` or
`APP_BFF_ENABLED=false` on the target makes owner bootstrap a skipped step with its reason and the
owner action that unblocks it (flip the flag on that environment), not a failure - the process exit
code stays 0 as long as every attempted write succeeded. `skipped` means deliberately not
attempted (only the two flag-gated bootstrap codes and the pipeline-board owner action produce
it); `failed` means attempted and did not succeed, for example a stale `INGEST_TOKEN` answering
401 on an intake write - that is the case that moves the exit code to `3`.

### QA commercial journey

`tools/seed-qa-journey.mjs` puts one synthetic commercial journey into `qa` through the governed
routes only. It signs in as the seed owner `qa-seed@example.invalid`, then runs office lead (no
acknowledgement mail), triage, an approved quote, a proposal, the publication (prepare, a
`qa-synthetic-publication` effect claimed and settled through `/admin/effects/*`, record), a
customer portal link, the accounting tester as an app user, and one crew (`synth-seed-qa:crew:1`)
with two synthetic field users (`qa-crew-lead@example.invalid`, `qa-crew-hand@example.invalid`)
through the roster route `/api/v1/admin/crews`. Customer acceptance, the deposit
and its approval stay with the two named testers. The job is not scheduled to the crew: scheduling
needs all six production gates cleared, and a gate clears today only by an office waiver or a
reconciled deposit invoice, both people's decisions, so the seed clears no gate. It never writes
D1 directly, calls only an
allowlist of routes, refuses any target that is not one of qa's own origins, and refuses any
identity outside `example.invalid` and the two testers.

```bash
node tools/qa-seed-owner.mjs --sql-out output/qa/owner-access/qa-seed-owner.sql \
  --secrets ~/.secrets/ironwrap/qa-release.env --apply
QA_SEED_MAGIC_LINK_TOKEN=... EFFECT_RUNTIME_TOKEN=... node tools/seed-qa-journey.mjs \
  --base-url https://<qa origin> --customer-tester <email> --accounting-tester <email>
```

`qa-seed-owner.mjs` writes one guarded batch: the seed owner, only when the email is absent and an
active owner exists, with one `app_auth_audit` row (`owner:qa_seed_owner_directed_grant_outside_ui`),
plus a fresh single-use sign-in with the app's own 15-minute lifetime. The raw token goes only to the
secrets file; each journey run consumes one. Every journey step reads the job's commercial context
first and does only what is missing, so a second run reports `created: 0`. The portal URL goes to
`output/seed-env/qa/portal-link.json` (mode 600) and is never printed. The journey stops with
`policy_expired` when the qa policy window in `workers-bus/wrangler.jsonc` has lapsed (renew it with a
one-line edit), and with `seed_sign_in_refused` when the link was already used (mint a new one).

## Incident Triage

1. Record UTC start time, affected source/tenant, release commit, Worker deployment, image digest,
   and observed status without copying secrets or raw customer payloads.
2. Check `/health`, `/ready`, and `/admin/status` in that order.
3. Preserve the envelope id, raw R2 key, audit id, `run_id`, and relevant structured-log request id.
4. Stop unsafe mutations. Leave Hermes/Bus write flags false unless an approved recovery requires
   one narrow tool.
5. Fix the dependency or policy cause before replaying.
6. Use targeted replay by default. Verify landed state and audit evidence after recovery.
7. Record cause, actions, evidence, remaining risk, and closure owner in an Automation Incident.

## Dead-Letter Recovery

### Inspect Without Mutating

1. List open rows with `GET /admin/dead-letter`.
2. Read the selected canonical record with `GET /admin/envelope/<envelope_id>`.
3. Inspect `last_error`, attempts, timestamps, enabled provider/projection status, and the raw R2 object by
   its key. Dead-letter copies are redacted; R2 remains the raw source.
4. Prove the dependency fix before creating an approval.

### Targeted Replay (Default)

Every replay requires explicit approval evidence. `run_id` must be stable and unique for the
operator action; `approved_by` identifies the human approver; `reason` states the diagnosed cause
and fix. The admin bearer is the authentication factor and is not accepted in the JSON body.

```bash
envelope_id='ow_<uuid>'
run_id='ops-replay-20260710T120000Z-INC-123'
jq -n \
  --arg envelope_id "$envelope_id" \
  --arg run_id "$run_id" \
  --arg approved_by "$APPROVER_ID" \
  --arg reason 'Credential repaired and a read-only dependency check passed.' \
  '{envelope_id:$envelope_id,run_id:$run_id,approved_by:$approved_by,reason:$reason}' \
| curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    "$BUS_BASE_URL/admin/replay"
```

The Worker first binds `run_id` to the exact replay selection, envelope, approver, and normalized
reason in a D1 ledger. It then compare-and-set claims only an envelope that is still `dead`,
publishes it, and restores the envelope claim if queue publication fails or is uncertain. An exact
retry of a completed run returns the stored outcome with `replayed: true` and performs no second
queue or audit write. Reusing the run id with changed intent or approval identity returns
`409 replay_run_id_conflict`; a concurrent exact request returns `409 replay_run_in_progress`.
A failed rolled-back run may reclaim the same identity and retry safely. Dead-letter rows are
marked recovered only after the envelope successfully lands.

Hermes exposes only targeted replay: `dry_run_replay` then human approval then `request_replay`.
Bulk replay is intentionally absent from the MCP surface.

For qa, dispatch `.github/workflows/qa-dead-letter.yml` without inputs to inspect counts, open
rows and envelope states. It performs only reads and does not publish payloads. Replay is absent:
an agent holding the owner's GitHub token can dispatch a workflow, so dispatcher identity does
not prove human approval. Use the existing targeted replay procedure with explicit human approval;
a future replay workflow must verify an independent approval before writing. An open qa dead
letter still fails Deploy's drain step before the restore drill; inspection does not recover it.

### Bulk Replay (Exceptional)

Bulk replay may be used only after an incident owner has reviewed the full open set and approved
one common, repaired cause. The JSON body must include:

```json
{
  "all": true,
  "confirm": "REPLAY_ALL_OPEN_DEAD_LETTERS",
  "run_id": "ops-replay-all-20260710T120000Z-INC-123",
  "approved_by": "owner@example.com",
  "reason": "Shared dependency repaired; every open row was reviewed against incident INC-123."
}
```

Do not include `envelope_id` with `all: true`. Archive the before/after list and the replay audit.
If candidates have different causes, replay them individually.

### Recovery Verification

- Selected envelopes progress from `dead` to `pending_jn_push` to the intended landed status.
- Corresponding dead-letter rows become recovered; unrelated rows remain untouched.
- `/admin/status` no longer reports the recovered dead/stuck provider or projection condition.
- The downstream record is not duplicated and its external/idempotency key is unchanged.
- The replay audit carries `run_id`, approver, reason, counts, result, and any recovery owner.
- The replay ledger has no unexplained failed or stale-running row; `/admin/status` reports
  `replay_failed: 0` and `replay_stuck: 0`.

## Stuck Envelopes

Failed primary-queue deliveries for leads, measurements, and Newo events use exponential
back-off in production and qa: `min(120, 10 * 2 ** (msg.attempts - 1))` seconds.
Cloudflare transport attempts start at 1; failures of deliveries 1–5 schedule delays of
10, 20, 40, 80, and 120 seconds (cumulative 10, 30, 70, 150, and 270 seconds).
The configured five retries still allow six total deliveries. DLQ consumers retain their
existing immediate retry behavior and limits. See the Cloudflare
[Message API](https://developers.cloudflare.com/queues/configuration/javascript-apis/#message)
and [retry delays](https://developers.cloudflare.com/queues/configuration/batching-retries/).

Transport `msg.attempts` is independent of durable `envelopes.attempts`: a D1 export lock can
throw before the durable counter increments. Missing or invalid transport attempt values
use the first delay. The schedule excludes processing time and provider scheduling latency;
measurement leases remain five minutes, so a late delivery can still become the existing
no-op with scheduled recovery. This change does not extend leases or guarantee DLQ delivery
for every measurement failure.

The five-minute retry sweep re-enqueues envelopes left in `pending_jn_push` longer than
`STUCK_THRESHOLD_MIN` (15 minutes by default). Repeatedly stuck envelopes indicate a downstream
failure, not a missing queue message. Inspect the envelope and structured logs, repair the target,
and allow the retry path to run. Do not force the row directly in D1.

## Frappe Compatibility Projection Failure

D1/Worker remains the operating authority while an enabled Frappe compatibility projection is
unavailable. Queue retry and DLQ preserve the projection path; projection failure must not rewrite,
promote, or invalidate authoritative D1 state. When the compatibility site returns:

1. Prove site HTTPS and API authentication.
2. Confirm `/ready` passes its enabled-Frappe configuration check.
3. Confirm schema/migrations and installed app versions match the release record.
4. Replay only affected projection envelopes using the procedure above.
5. Reconcile Frappe records back to their D1 source identities and close the Automation Incident.

Do not describe Frappe as live merely because the repository app tests pass.

## Hermes / MCP Compatibility Mutation Failure

All approved compatibility mutations require HTTPS (except explicitly enabled localhost development),
a bounded request timeout, a stable required `run_id`, human approval, and the matching dry-run.

- A completed `run_id` is idempotent: retry returns the stored result without repeating the target
  mutation.
- A normal pre-mutation or target failure ends `Hermes Run` as `Failed` and records no applied
  mutation.
- If the target mutation succeeds but final audit persistence fails, the operation fails closed.
  `Hermes Run` must end as `Audit Failed` with `mutation_applied=true`, correlation/target ids,
  result evidence, error, policy/approval proof, and an `audit_incident_id`; an Automation Incident
  is created best-effort. Treat this as SEV2 until the business result and audit record reconcile.

Never retry an audit-failed mutation under a new `run_id` until the target state is inspected.

## QuickBooks Webhook Failure

`POST /webhook/quickbooks` returns 401 for an invalid `intuit-signature` and 503 when the
verifier, expected realm, or bounded issuer prerequisites are unavailable. A payload-hash receipt
is not completion: each supported expected-realm entity has a durable D1 projection-outbox row.

1. Compare the configured verifier binding, `QB_EXPECTED_REALM_ID`, issuer user, Frappe site
   config, role, and separate API pair with the intended accounts without printing secret values.
   A valid signature from another realm is rejected; do not retarget a live Worker to make it pass.
2. Confirm the raw object, receipt, outbox state, and audit records for the affected identity.
   Pending means the bounded Frappe projection did not complete; it is not payment, posting,
   amount, or reconciliation truth.
3. Repair credential, role, route, or deployment drift, then allow the five-minute recovery sweep
   or a legitimate Intuit redelivery to retry the leased row. Backoff begins at one minute, caps at
   one hour, and D1 rows are never manually edited to force a retry.
4. On the fifth failed attempt, open or continue a SEV2 Automation Incident with the receipt,
   outbox, and redacted audit references. Only the documented immutable identity conflict is
   terminally rejected; investigate it with a human and QuickBooks read-back.
5. Rotate the verifier on both Intuit and Worker only in a controlled cutover. Rotate the issuer
   by provisioning a new least-privilege user/key pair, matching the Frappe site config and Worker
   vars/secrets, proving one live expected-realm projection, then revoking the old pair.

Repository checks and local tests prove this retry protocol's shape only. A real signed event,
Frappe Pending reconciliation, and QuickBooks read-back remain separate live evidence.

## JobNimbus Contract Failure

The known live-account contract uses contact type `Customer`, job type `Retail`, and omits
`source_name` unless that exact source is configured in the account. `Lead` is rejected. Source
attribution stays on the canonical envelope and temporary bridge tags. After a mapping fix, use
targeted replay for each affected envelope.

## Lead Triage And MCTB Evidence

`Lead Envelope.status` is bridge transport only. It must never be used as proof that a homeowner
was contacted or that a lead was triaged. The operating state is separate:

1. New Worker-created leads are `Untriaged`; migrated legacy rows are `Unknown` and require
   explicit review rather than being counted as new.
2. While the legacy triage command remains enabled, mark a lead `Triaged` only through its
   receipt-bound Hermes dry-run/approval/write compatibility path, with a concise disposition.
   That patch must not alter transport status or a Communication Event.
3. `lead_ack_receipts` is append-only and records only a Gmail provider-acceptance identifier,
   failed attempt, or no eligible channel. It is not delivery, read, consent, or human-follow-up
   proof.
4. The 60-second MCTB timer starts from the owned D1 intake timestamp. Treat an absent receipt as
   **unproven**, a late receipt as **late**, and an unavailable channel as an operator exception.
   Never call any of these states “sent” or “delivered.”
5. If provider acceptance is not proven by the deadline, open/continue an Automation Incident,
   preserve the raw envelope, investigate Gmail/credential/route state, and record the recovery
   evidence before closing it.

## Data Ownership And Recovery

| Store | Role | Recovery property |
| --- | --- | --- |
| Cloudflare D1 | Authoritative normalized operating state plus envelope/audit/effect/gate/evidence/reconciliation ledgers | Daily exact-account remote SQL export, encrypted in R2; isolated SQLite plus D1 drill restore |
| Cloudflare R2 raw bucket | Raw inbound payload/file source stored before downstream work | Re-derive an envelope or evidence record from its immutable key |
| Frappe site | Optional compatibility projection and legacy role/tool surface; never authority for native operating facts | Rebuild projections from D1/R2 plus reconciliation; back up only while the compatibility track is enabled |
| R2 backup bucket | Encrypted complete Frappe and D1 generations | Restore only exact prefixes bearing the matching Frappe or D1 completion marker; live bucket-lock proof required |
| Google Shared Drives | Human-facing job evidence/archive | Drive versioning/trash; ids remain in owned configuration |
| QuickBooks | Invoice/payment/accounting truth | Reconcile through Intuit records; no Hermes accounting mutation |

Customer data must never exist only in JobNimbus, GHL, Make, or another temporary bridge.

## Backup Verification And Restore Drill

Run canonical D1 first and Frappe second from the root-owned, mode-`0600` environment file. The
production cron times are `09:05 UTC` and `09:25 UTC` respectively; the independent jobs prevent
one failure from suppressing the other:

```bash
cd /opt/ironwrap
set +x
set -a
source /etc/ironwrap/backup.env
set +a
deploy/backup-d1-to-r2.sh
deploy/backup-to-r2.sh
```

`deploy/backup-d1-to-r2.sh` accepts no arguments. It uses only the locked
`workers-bus/node_modules/.bin/wrangler` 4.x version and an exact generated config for account
`7ee5775bc1ba46f05c5a65235b60e939`, database `ironwrap-bus`, UUID
`f0674848-13df-4422-9896-8ba2719663b8`. It performs `d1 export --remote`, imports the SQL into an
isolated SQLite file, runs integrity checks, and requires the complete migration-derived table,
index, and invariant-trigger inventories before packaging, encrypting, uploading immutably, and remotely
checking the generation. It prints the
exact committed `d1/ironwrap-bus/<timestamp-pid-random>` prefix. Do not list-and-select latest in
a script, infer a prefix, or restore a generation without `IRONWRAP-D1-BACKUP-COMPLETE`.
Both D1 scripts unset any inherited generic `CLOUDFLARE_API_TOKEN`; Wrangler receives only
`D1_BACKUP_API_TOKEN` for one export command or `D1_RESTORE_API_TOKEN` for drill commands.

`deploy/backup-to-r2.sh` creates a new complete database/site-config/public/private backup set,
archives a restore manifest with the deployed image digest, encrypts locally with `age`, uploads
immutably, verifies the remote content, and writes the completion marker last. It cleans an
incomplete remote prefix on failure/interruption and applies retention only after verification.
The D1 script applies the same commit protocol with its D1-specific marker. Retention hides each
expired marker first and keeps its encrypted archive/checksum for one additional hour, so a
restore cannot observe a committed marker after its data was deleted.

The D1 required-table allowlist is release state, not a static prose assumption. It includes the
QuickBooks, customer-acceptance, Newo, measurement, Facet evidence/association, approval,
governed-transition, field Work Package, safety, effect, and accounting ledgers. The readiness checker derives the complete
table and trigger inventory from the migration chain and requires both recovery scripts to match it
exactly. Every migration that adds persistent state therefore fails the deployment contract until
both scripts and executable recovery tests advance with it.

The required trigger bindings include source-count validation, immutable lead-ack receipts,
customer acceptance, Facet identity/nonce/evidence ledgers, all three approval ledgers, and the
governed-transition outbox. In particular,
the approval-request binding trigger must reject `UPDATE` with
`ABORT, 'approval_request_binding_immutable'`; approval-event update/delete triggers must reject
with `ABORT, 'approval_request_events_immutable'`. For the explicitly checked receipt and approval
invariants, a matching name and table alone does not pass recovery verification. A migration that
adds or changes a persistent invariant trigger must advance the same recovery contract and tests.

Daily verification:

- Both backup logs end with their committed-and-verified success lines.
- The recorded D1 prefix contains one `.age` archive, checksum, and
  `IRONWRAP-D1-BACKUP-COMPLETE`; the Frappe prefix contains the analogous three objects with
  `IRONWRAP-BACKUP-COMPLETE`.
- No alert reports an incomplete prefix that could not be purged.

Weekly local D1 recovery verification is non-mutating and is the default:

```bash
export D1_RESTORE_R2_COMPLETED_PREFIX='d1/ironwrap-bus/<YYYYMMDDTHHMMSSZ-pid-random>'
export D1_RESTORE_MODE=verify
unset D1_RESTORE_API_TOKEN D1_RESTORE_CONFIRMATION
deploy/restore-d1-from-r2.sh
```

The script verifies ciphertext checksum before decryption, validates the exact source manifest,
imports into isolated SQLite, checks integrity, and records a local row count for every required
table plus the exact migration-derived index and trigger-to-table inventories. It also checks the receipt trigger SQL for
the required `BEFORE UPDATE` / `BEFORE DELETE` abort semantics. It deletes its plaintext
workspace on success, failure, or signal.

Monthly isolated restore drill:

1. Select one exact Frappe marker-bearing prefix and one exact D1 marker-bearing prefix; record
   their paths, checksums, release commit, and approver. Never let recovery code choose latest.
2. Run the D1 local verification above. Create a fresh empty database named
   `ironwrap-restore-drill-<label>` in the exact committed Cloudflare account and record its UUID.
   Then bind one approval to that non-production name and UUID:

```bash
export D1_RESTORE_MODE=remote
export D1_RESTORE_TARGET_ACCOUNT_ID=7ee5775bc1ba46f05c5a65235b60e939
export D1_RESTORE_TARGET_DATABASE_NAME='ironwrap-restore-drill-monthly'
export D1_RESTORE_TARGET_DATABASE_ID='<different-non-production-d1-uuid>'
export D1_RESTORE_API_TOKEN='<just-in-time-d1-drill-write-token>'
export D1_RESTORE_CONFIRMATION="RESTORE_D1:${D1_RESTORE_TARGET_DATABASE_NAME}@${D1_RESTORE_TARGET_DATABASE_ID}"
deploy/restore-d1-from-r2.sh
unset D1_RESTORE_API_TOKEN D1_RESTORE_CONFIRMATION
export D1_RESTORE_MODE=verify
```

   The script rejects production name or UUID, mismatched confirmation, a different account, or
   any nonempty target. It imports through a generated exact target config, then queries every
   required table on the target and compares the complete table-to-row-count map against local
   SQLite, then compares the exact trigger-to-table inventory and receipt-trigger SQL semantics.
   Any mismatch fails the drill even if Wrangler returned success.
3. Copy the Frappe generation to a restricted restore host; verify ciphertext before decryption.
4. Decrypt with the offline `age` identity and extract into a mode-0700 temporary directory.
5. Read `IRONWRAP-BACKUP-MANIFEST.txt`; start the recorded digest-pinned image in an isolated
   network and create a non-production site.
6. Run the Frappe v15 restore using the recorded database, public-files, and private-files
   artifacts. Keep the pre-created target site's database configuration and credentials; the
   restore utility extracts and atomically merges only the source Frappe encryption key required
   to read restored encrypted fields. The source `site_config_backup.json` is never installed.
7. Run migrations, log in, open representative Roof Job/Evidence/Payment/Hermes records, and
   compare row/file checks against the source-site restore manifest.
8. Record both restore durations/results, destroy the non-production D1 database, Frappe drill
   site, and plaintext artifacts through an approved deletion, then close or
   escalate the drill incident.

Upload success without an isolated restore is not recovery proof.

`cron_heartbeat` is inside the backup set, so a restored generation brings back the `started_at` it
carried when the backup was taken. Restoring a generation older than 26 hours into a live database
therefore reads `GET /ready?scope=ops` as 503 on `0 14 * * *` until the next 14:00 UTC tick, with
both crons alive and nothing wrong: the per-cron startup grace covers only a row that has never
ticked (`started_at IS NULL`), never a restored one. Confirm liveness from the `crons` block on
`/admin/status` and the Cloudflare Cron Triggers tab, and wait for the tick rather than widening the
window. The monthly drill restores into a separate non-production database
(`ironwrap-restore-drill-<label>`) and the deploy's export/restore drill into `$RUNNER_TEMP`, so
neither touches this probe or any pipeline gate.

### Live R2 Delete-Protection Gate

Before launch and after every lock-policy change, archive Cloudflare account evidence for the
backup bucket rule id, protected D1/Frappe prefixes, mode, and duration. Put a disposable canary
under each protected prefix and record a denied delete while its lock is active. Configure the
lock to cover the approved protection window but expire at least 24 hours before script retention
so planned marker-first expiry can run. Separately archive the raw intake bucket's retention and
delete-protection rule plus its denied-delete proof. `rclone --immutable`, repository tests, an
unenforced policy document, or a dashboard screenshot without the denied-delete response does
not prove this live gate.

## Field Device Loss, Replacement, And Revocation

This procedure applies only after the Field Companion BFF and the office **Crew phones** setting
are deployed. It is intentionally an office action: a field account cannot issue, list, or revoke
devices, and crew members never receive a passwordless magic-link session.

1. Treat a lost or reassigned phone as a credential incident. Record the field user, device id,
   reporter, and UTC time in the incident record. Do not copy a QR image, pairing URL, token, or
   device proof into the record.
2. An owner or operations user opens **Settings -> Crew phones**, identifies the active device,
   and selects **Revoke lost device**. Confirm the resulting `device_id` and `revoked_at` response.
3. Verify the device appears as revoked on a freshly loaded office list. The old device must fail a
   current `/api/v1/session` request even if it still has its session cookie and local proof; a
   screenshot of the button state is not enough.
4. Preserve unsynced field work only from the physical device if it is recovered. Do not move its
   IndexedDB data or device proof to a replacement handset. The owner decides whether any queued
   proof is manually recovered as an evidence exception.
5. On the replacement handset, install/open the PWA under office supervision. The office issues a
   new short-lived QR; the handset creates a fresh local device proof and consumes the fragment
   token with a POST. Verify the new device list row and one authorized Field Companion read.
6. Close the incident only after the old device fails, the replacement succeeds, the relevant
   D1/device audit evidence is retained, and no raw pairing credential appears in logs, chat, or
   tickets.

Local tests prove the protocol shape. The deployment/device proof remains a launch gate until the
above steps are performed against the intended Worker, D1 database, and a real iOS or Android
device.

## Secret Rotation

| Secret | Rotation rule |
| --- | --- |
| `JOBNIMBUS_API_KEY` | Rotate the previously exposed key first; use a dedicated bus key |
| `INGEST_TOKEN` | Rotate every ingest source in a controlled cutover, then send a test event |
| `ADMIN_TOKEN` / `IRONWRAP_ADMIN_TOKEN` | Same bus admin credential binding; rotate operator/MCP consumers together |
| `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` | Worker uses a dedicated integration user. Each Hermes MCP process uses a separate pair issued to exactly `HERMES_ACTOR_USER`; never share either credential or rotate them as one binding. |
| `HERMES_WRITE_TOKEN` | Dedicated bus-replay token only; keep bus write flag false outside approved windows |
| `HERMES_DRY_RUN_SIGNING_KEY` | Unique per Frappe tenant/runtime; rotate with a controlled preview-receipt cutover |
| approval broker key pair / `HERMES_APPROVER_ID` | Private key stays only in authenticated owner approval broker; rotate the public key atomically in MCP and the Frappe backend's `IRONWRAP_HERMES_APPROVAL_PUBLIC_KEY_FILE`, then verify a new receipt and fail-closed old receipt |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Mint new key, verify Drive/email, then revoke old key |
| `QB_WEBHOOK_TOKEN` | Change Worker binding and Intuit verifier token together; prove one expected-realm signed event after cutover |
| `QB_EXPECTED_REALM_ID` | Recheck against the intended company before cutover; a change is an owner-approved company-boundary migration, never generic configuration churn |
| `QB_RECONCILIATION_ISSUER_USER` and issuer API pair | Provision a replacement Frappe user with only IronWrap QuickBooks Reconciliation Issuer, match Worker vars/secrets and site config, prove one live Pending reconciliation, then revoke the old pair |
| `FLEET_CAPTURE_FRAPPE_API_KEY` / `_SECRET` | Dedicated `IronWrap Fleet Capture Issuer` user; never the bus pair. See "Per-rail Frappe issuer rotation" below. |
| `WORK_PACKAGE_FRAPPE_API_KEY` / `_SECRET` | Dedicated `IronWrap Work Package Issuer` user; never the bus pair. See "Per-rail Frappe issuer rotation" below. |
| `D1_BACKUP_API_TOKEN` | Persist only the exact production D1 read/export scope in `backup.env`; never reuse restore or R2 credentials; run a backup after rotation |
| `D1_RESTORE_API_TOKEN` | Separate drill/write scope injected only for one approved remote drill; unset immediately afterward and keep unset for local verification |
| R2 backup key pair | Backup-bucket-only credentials; rotate and immediately run backup plus isolated decrypt check |

Never reuse Frappe, bus admin, ingest, approval, or backup credentials. Never commit filled env
files. After rotation, verify `/ready`, relevant runtime action, and audit evidence.

### Per-rail Frappe issuer rotation (fleet capture, work package)

These two rails hold their own Frappe identities rather than the broad bus pair, so one leaked
key reaches one rail's narrow grant instead of a System Manager (ELEC-48 audit section 3). The
Frappe app compares `frappe.session.user` against the site-config pin, so the pin — not the key
— is what grants and revokes access. Rotate one rail at a time.

Substitute `fleet_capture` / `ironwrap_fleet_capture_issuer_user` / `IronWrap Fleet Capture Issuer`
/ `FLEET_CAPTURE_FRAPPE_API_*` with the work-package equivalents for that rail.

1. **Mint the replacement identity.** On the site, create (or reuse) a non-interactive user
   holding ONLY the rail's role, then issue its API pair. `generate_keys` mints keys for a user
   that already exists — on a fresh replacement email it raises `DoesNotExistError`, so the
   `insert()` and the role assignment are part of the step, not setup someone did earlier. This is
   the same block `provision_rail_issuer` runs in `deploy/local/frappe-init.sh`:

   ```
   bench --site <site> console
   >>> import frappe
   >>> from frappe.core.doctype.user.user import generate_keys
   >>> email = "<new-fleet-capture-issuer-email>"
   >>> role = "IronWrap Fleet Capture Issuer"
   >>> if not frappe.db.exists("User", email):
   ...     u = frappe.get_doc({"doctype": "User", "email": email,
   ...                         "first_name": "Fleet Capture Issuer",
   ...                         "send_welcome_email": 0, "roles": [{"role": role}]})
   ...     u.insert(ignore_permissions=True)
   ... else:
   ...     u = frappe.get_doc("User", email)
   ...     if role not in {entry.role for entry in u.roles}:
   ...         u.append("roles", {"role": role})
   ...         u.save(ignore_permissions=True)
   ...
   >>> generate_keys(email)
   >>> frappe.db.commit()
   ```

   `generate_keys` returns `{"api_secret": ...}` and leaves `u.api_key` on the user; read the pair
   from that return value plus `frappe.get_doc("User", email).api_key`. Paste both straight into
   step 2 — unlike the local stack, a production rotation writes no credential file.

   Grant no other role. `IronWrap Fleet Capture Issuer` is create-only on Asset Inspection and
   Asset Defect plus read on Fleet Asset; `IronWrap Work Package Issuer` is read on Work Package
   plus create on Work Package Event. Anything wider defeats the split. Reusing an existing user
   that already holds another role is not "reuse" — mint a fresh one.

2. **Load the Worker secrets first, while the old pin is still live.** The rail keeps working on
   the old identity until step 3, so this step is not a cutover:

   ```
   npx wrangler secret put FLEET_CAPTURE_FRAPPE_API_KEY --env=""
   npx wrangler secret put FLEET_CAPTURE_FRAPPE_API_SECRET --env=""
   ```

   Never paste `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET` here. The Worker rejects that outright with
   `fleet_frappe_shared_credential_rejected` and `/ready` turns `rail_credential_isolation` red.

3. **Move the pin — this is the cutover, and it is also the revocation.** Until this runs, the
   new key gets `fleet_issuer_auth_mismatch`; after it, the old key does:

   ```
   bench --site <site> set-config ironwrap_fleet_capture_issuer_user '<new-fleet-capture-issuer-email>'
   ```

4. **Prove the rail.** `GET /ready` (admin bearer) must show `rail_credential_isolation: true`,
   then issue one real capture from a paired device and confirm the resulting Asset Inspection /
   Asset Defect (or Work Package Event) exists with the new issuer as its creator.

5. **Retire the old identity.** Delete its API keys and disable the user. Confirm the retired
   pair now fails: a capture issued with it must return `fleet_issuer_auth_mismatch`, not a write.

`node tools/validate-rail-credential-isolation.mjs` asserts the repo-side half of this contract
(role, user, provisioner, Worker binding, config surface). For the one module that issues two
rails it also EXECUTES the shipped authorizer — `frappe-field.ts` is imported and called with a
real `work_package_api` path and a real `field_evidence_api` path under three credential
configurations, and the identity each hands back is asserted, including that the work-package
rail refuses rather than degrades to the bus pair when its binding is unset. Reading the routing
as text accepted an unreachable branch (ELEC-143); calling it does not. The validator still
cannot see a live site, so steps 4 and 5 remain the only proof that a rotation actually landed.

## Severity And Escalation

| Severity | Definition | Examples | Response |
| --- | --- | --- | --- |
| SEV1 | Lead loss possible or ingest unavailable | R2/D1 write failure, all intake failing, Worker unavailable | Immediate; protect raw-first intake before other work |
| SEV2 | Leads captured but processing/audit incomplete | Dead letters, Frappe/JobNimbus push failure, pending/escalated QuickBooks projection, missing ack, audit-finalization failure | Same business day; approved recovery after diagnosis |
| SEV3 | Degraded visibility or stale mirror | Reconcile gap, stale heartbeat, QB receipt/signature issue without pending projection, Drive filing failure | Investigate within one business day |
| SEV4 | Non-operational defect/debt | Placeholder config, documentation drift, cosmetic issue | Track for the next controlled maintenance window |

Escalation: primary owner alert -> backup owner -> maintainer. A missing reconcile digest is SEV2
until `/admin/status`, D1 heartbeat, and delivery logs prove otherwise.

## Operating Cadence

Daily:

- Open the native PWA operating surfaces; reconcile every red/amber item with its authoritative
  D1 record. Use the `IronWrap Control Center` and Frappe lists/forms only for an explicitly enabled
  compatibility projection.
- Check reconcile digest and `/admin/status`; investigate every degraded reason.
- Inspect pending/escalated QuickBooks projections and their audit references; no recent QuickBooks
  receipt is not an outage by itself.
- Confirm external monitors for `/health` and `/ready` disagree only during known dependency work.
- Confirm the encrypted D1 backup completed; if Frappe compatibility is enabled, confirm its
  separate backup marker too.

Weekly:

- Review dead letters, pending/stuck envelopes, pending/escalated QuickBooks effects/projections,
  enabled compatibility errors, and recent audit failures.
- Sample one raw R2 object through its D1 envelope/evidence linkage and any enabled projection.
- Review open Automation Incidents and close only with recovery evidence.
- Review write flags; default them to false when no approved operation is active.

Monthly:

- Run the exact-prefix D1 remote table-row-count, trigger-inventory, and receipt-semantics parity
  drill. If Frappe compatibility is enabled, also run its isolated restore; record applicable RTO
  results and current R2 denied-delete evidence.
- Audit secret age and purpose separation; complete pending rotations.
- Run all repository validators and `node tools/production-readiness.mjs contract` on the intended
  next release commit.
- Review heartbeat continuity, tenant isolation, quiet hours/CASL policy, and market-watch items.
