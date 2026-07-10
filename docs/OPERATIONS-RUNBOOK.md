# IronWrap OS Operations Runbook

Day-2 monitoring, incident recovery, replay, secret rotation, backup, and restore procedure for
the Worker-owned bus and Frappe consumer. Tenant creation is in
`docs/WHITE-LABEL-CLONE-PLAYBOOK.md`; initial deployment is in `docs/LAUNCH-RUNBOOK.md`.

Admin routes require `Authorization: Bearer <ADMIN_TOKEN>`. Never put the token in a URL,
request body, log line, incident ticket, or command history.

## Operational Truth Surfaces

| Surface | Auth | Meaning | Healthy state |
| --- | --- | --- | --- |
| `GET /health` | none | Worker isolate liveness only | HTTP 200; does not prove dependencies |
| `GET /ready` | none | D1 schema query plus R2/Queue binding and auth/notification/JobNimbus/enabled-Frappe config presence | HTTP 200 and every check true; HTTP 503 blocks traffic cutover |
| `GET /admin/status` | admin | Heartbeat freshness, pending/stuck/dead counts, Frappe errors, audit failures, latest QB receipt | `status: ok`; investigate every degraded reason |
| `GET /admin/dead-letter` | admin | Open forensic dead-letter rows | Empty |
| `GET /admin/envelopes` | admin | Recent canonical envelopes and status | No unexplained pending/dead records |
| `POST /admin/reconcile` | admin | Source-vs-landed reconcile and heartbeat | No unexplained gap; new heartbeat written |
| Worker structured logs | Cloudflare account | Request, queue, retry, reconcile, and recovery errors | No repeated error signature |

`/admin/status` treats a missing/stale/non-reconciled heartbeat, open dead letters, stuck
envelopes, Frappe sync errors, failed/stuck replay requests, or recent audit failures as degraded.
Its heartbeat freshness window is 36 hours and recent-audit window is 24 hours. It reports the
latest QuickBooks receipt and 24-hour freshness separately; lack of recent QB activity is not by
itself a system outage.

`/ready` does not contact every configured downstream API or perform an R2/Queue mutation. Pair it
with targeted Frappe/JobNimbus/Google/QuickBooks smoke evidence during launch and incidents.

The scheduled `0 14 * * *` reconcile email is also a heartbeat. If no digest arrives, check
`/admin/status`, the D1 heartbeat row, cron execution, and email delivery before assuming the
reconcile succeeded.

Source-vs-landed reconciliation needs independent source counts. Authorized source adapters send
daily `{day, channel, count}` facts to `POST /admin/source-count`; do not synthesize counts from
the same D1 envelopes being checked.

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
3. Inspect `last_error`, attempts, timestamps, Frappe/JobNimbus status, and the raw R2 object by
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
- `/admin/status` no longer reports the recovered dead/stuck/Frappe condition.
- The downstream record is not duplicated and its external/idempotency key is unchanged.
- The replay audit carries `run_id`, approver, reason, counts, result, and any recovery owner.
- The replay ledger has no unexplained failed or stale-running row; `/admin/status` reports
  `replay_failed: 0` and `replay_stuck: 0`.

## Stuck Envelopes

The five-minute retry sweep re-enqueues envelopes left in `pending_jn_push` longer than
`STUCK_THRESHOLD_MIN` (15 minutes by default). Repeatedly stuck envelopes indicate a downstream
failure, not a missing queue message. Inspect the envelope and structured logs, repair the target,
and allow the retry path to run. Do not force the row directly in D1.

## Frappe Site Failure

Frappe is the operating core; D1/R2 preserve canonical/raw intake while it is unavailable.
Queue retry and DLQ preserve the mirror path. When Frappe returns:

1. Prove site HTTPS and API authentication.
2. Confirm `/ready` passes its enabled-Frappe configuration check.
3. Confirm schema/migrations and installed app versions match the release record.
4. Replay only affected dead envelopes using the procedure above.
5. Reconcile D1 envelopes against Frappe records and close the Automation Incident.

Do not describe Frappe as live merely because the repository app tests pass.

## Hermes / MCP Mutation Failure

All approved Frappe mutations require HTTPS (except explicitly enabled localhost development),
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

`POST /webhook/quickbooks` returns 401 for an invalid `intuit-signature` and 503 when
`QB_WEBHOOK_TOKEN` is unset. The payload-hash receipt guard makes legitimate Intuit redelivery
idempotent.

1. Compare the configured verifier-token binding with the Intuit application without printing it.
2. Rotate both sides together if integrity is uncertain.
3. Confirm a valid signed event appears in `/admin/status` and a repeated payload increments replay
   evidence without a duplicate business event.
4. Reconcile missed invoice/payment state in QuickBooks, which remains accounting truth.

## JobNimbus Contract Failure

The known live-account contract uses contact type `Customer`, job type `Retail`, and omits
`source_name` unless that exact source is configured in the account. `Lead` is rejected. Source
attribution stays on the canonical envelope and temporary bridge tags. After a mapping fix, use
targeted replay for each affected envelope.

## Data Ownership And Recovery

| Store | Role | Recovery property |
| --- | --- | --- |
| Cloudflare D1 | Canonical envelope/audit/dead-letter/heartbeat/dedup/replay/auth/QB receipt ledger | Daily exact-account remote SQL export, encrypted in R2; isolated SQLite plus D1 drill restore |
| Cloudflare R2 raw bucket | Raw inbound payload/file source stored before downstream work | Re-derive an envelope or evidence record from its immutable key |
| Frappe site | Deterministic business records, roles, policy gates, and audit objects | Rebuild consumer state from D1/R2 plus reconciliation; back up for faster/complete operational restore |
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
isolated SQLite file, runs integrity checks, and requires all 18 production tables before
packaging, encrypting, uploading immutably, and remotely checking the generation. It prints the
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

The D1 required-table allowlist is release state, not a static assumption: `envelopes`,
`audit_log`, `dead_letter`, `source_counts`, `heartbeat`, `quickbooks_webhook_receipts`,
`dedup_claims`, `replay_requests`, `field_actions`, `field_action_media`, `app_users`,
`app_magic_links`, `app_sessions`, `app_auth_throttles`, `app_auth_audit`,
`app_action_throttles`, `app_device_pairings`, and `app_devices`. Every migration that adds a persistent table must
advance both scripts, manifest expectation, readiness contract, and executable tests before that
migration can deploy.

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
table. It deletes its plaintext workspace on success, failure, or signal.

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
   SQLite. Any mismatch fails the drill even if Wrangler returned success.
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

This procedure applies only after the Field Companion BFF and the office **Crew devices** setting
are deployed. It is intentionally an office action: a field account cannot issue, list, or revoke
devices, and crew members never receive a passwordless magic-link session.

1. Treat a lost or reassigned phone as a credential incident. Record the field user, device id,
   reporter, and UTC time in the incident record. Do not copy a QR image, pairing URL, token, or
   device proof into the record.
2. An owner or operations user opens **Settings -> Crew devices**, identifies the active device,
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
| approval broker key pair / `HERMES_APPROVER_ID` | Private key stays only in authenticated owner approval broker; MCP retains public key and exact bound approver identity |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Mint new key, verify Drive/email, then revoke old key |
| `QB_WEBHOOK_TOKEN` | Change Worker binding and Intuit verifier token together |
| `D1_BACKUP_API_TOKEN` | Persist only the exact production D1 read/export scope in `backup.env`; never reuse restore or R2 credentials; run a backup after rotation |
| `D1_RESTORE_API_TOKEN` | Separate drill/write scope injected only for one approved remote drill; unset immediately afterward and keep unset for local verification |
| R2 backup key pair | Backup-bucket-only credentials; rotate and immediately run backup plus isolated decrypt check |

Never reuse Frappe, bus admin, ingest, approval, or backup credentials. Never commit filled env
files. After rotation, verify `/ready`, relevant runtime action, and audit evidence.

## Severity And Escalation

| Severity | Definition | Examples | Response |
| --- | --- | --- | --- |
| SEV1 | Lead loss possible or ingest unavailable | R2/D1 write failure, all intake failing, Worker unavailable | Immediate; protect raw-first intake before other work |
| SEV2 | Leads captured but processing/audit incomplete | Dead letters, Frappe/JobNimbus push failure, missing ack, audit-finalization failure | Same business day; approved recovery after diagnosis |
| SEV3 | Degraded visibility or stale mirror | Reconcile gap, stale heartbeat, QB receipt/signature issue, Drive filing failure | Investigate within one business day |
| SEV4 | Non-operational defect/debt | Placeholder config, documentation drift, cosmetic issue | Track for the next controlled maintenance window |

Escalation: primary owner alert -> backup owner -> maintainer. A missing reconcile digest is SEV2
until `/admin/status`, D1 heartbeat, and delivery logs prove otherwise.

## Operating Cadence

Daily:

- Open the `IronWrap Control Center`; reconcile every red/amber item with its source record and
  use standard Frappe lists/forms if the cockpit cannot load.
- Check reconcile digest and `/admin/status`; investigate every degraded reason.
- Confirm external monitors for `/health` and `/ready` disagree only during known dependency work.
- Confirm both encrypted D1 and Frappe backups completed and published their distinct markers.

Weekly:

- Review dead letters, pending/stuck envelopes, Frappe errors, and recent audit failures.
- Sample one raw R2 object through envelope and Frappe evidence linkage.
- Review open Automation Incidents and close only with recovery evidence.
- Review write flags; default them to false when no approved operation is active.

Monthly:

- Run the exact-prefix D1 remote row-count-parity drill and isolated Frappe restore; record both RTO results and the current R2 denied-delete evidence.
- Audit secret age and purpose separation; complete pending rotations.
- Run all repository validators and `node tools/production-readiness.mjs contract` on the intended
  next release commit.
- Review heartbeat continuity, tenant isolation, quiet hours/CASL policy, and market-watch items.
