# Launch-proof `--execute` side-effect inventory

Authorization sheet for `tools/launch-proof.mjs --execute`. It exists so a human can decide, from
one page, exactly what a real run touches before approving it. Derived by reading the tool and
every handler it reaches; it is a code inventory, not a claim that a run has happened.

Source of truth for behaviour: `tools/launch-proof.mjs`, `workers-bus/src/index.ts`,
`workers-bus/src/estimates.ts`, `workers-bus/src/store.ts`, `workers-bus/src/notify.ts`,
`workers-bus/src/google.ts`, `workers-bus/src/jobnimbus.ts`, `workers-bus/src/erpnext.ts`,
`workers-bus/src/operations.ts`,
`frappe-apps/ironwrap_roofing/ironwrap_roofing/launch_proof_api.py` (historical Frappe lookup; **not** the IRO-189 gate).

## 1. Modes

`node tools/launch-proof.mjs` **without** `--execute` performs **no I/O at all**. It builds the
plan, prints one `curl` template per step with `$BUS_BASE_URL` / `$INGEST_TOKEN` / `$ADMIN_TOKEN`
left unexpanded, and returns `{ mode: "dry_run", plan }`. It does not read env vars, does
not resolve DNS, and cannot detect any defect in the system under test. It does not print a
Frappe lookup.

`--execute` sends every request below against whatever `BUS_BASE_URL` names. The tool has no
production guard: the only thing separating a staging run from a production run is the value of
`BUS_BASE_URL`.

`--release-smoke` (IRO-264) adds `X-IronWrap-Release-Smoke: 1` to steps 3, 4, 5, 6 and 8 only —
the Worker honours the header only when the request body is this tool's own reserved
`example.invalid` fixture, and refuses with `400 release_smoke_fixture_required` otherwise, so the
header is not a way to drop a real lead silently. This is the mode `deploy-production.yml` runs
against **production** for every release, to get the ten `LAUNCH_PROOF_STEP_NAMES` proof without
the three outward side effects (§5, §6 criterion 9, §8). It does not change steps 1, 2, 7 or 9, and
does not change what dry-run prints beyond the header line on the affected `curl` templates.

## 2. Required inputs

| Variable | Required | Used for |
|---|---|---|
| `BUS_BASE_URL` | yes | Worker origin; trailing slashes stripped. Empty ⇒ assertion failure before any request. |
| `INGEST_TOKEN` | yes | `Authorization: Bearer` on both `/ingest/*` steps. Must equal the Worker's `INGEST_TOKEN` secret. |
| `ADMIN_TOKEN` | yes | `Authorization: Bearer` on `/ready`, `/admin/envelopes`, `/admin/envelope/:id`, `/admin/reconcile`, `/admin/status`. Must equal the Worker's `ADMIN_TOKEN` secret. |
| `FRAPPE_BASE_URL` / `FRAPPE_API_KEY` / `FRAPPE_API_SECRET` | no | **Out of scope.** IRO-189's gate is D1 identity. Supplying these does not make Frappe the system of record and the tool does not call Frappe. |

A missing Frappe credential does **not** abort the run. The operating authority is D1/Worker.

Not passed to the tool but required **on the Worker** for the run to pass: a `/ready` verdict of green. `ERPNEXT_ENABLED` and `APP_BFF_ENABLED` are **not** this proof's acceptance path (IRO-195).

## 3. Fixtures

Both fixtures are synthetic and carry an execution-unique id `<13-digit ms>-<32 hex>`:

- lead: name `Launch Proof`, phone `587555<last 4 of stamp>`, email
  `launch-proof+<execution-id>@example.invalid`, service `metal roofing`, brand `ironwrap`.
- estimate: `project_id` / `job_number` `LP-<execution-id>`, customer `Launch Proof`,
  address `Edmonton, AB`, total `$1.00`.

The phone is a **real, dialable NANP-shaped number** in the 587 (Alberta) area code, normalized to
`+1587555NNNN`. It is not a reserved test range.

## 4. Ordered wire calls

Frappe is **not** on this wire. The tool never calls `FRAPPE_BASE_URL` and does not use a
launch-proof Frappe reader (IRO-189 / IRO-195).

| # | Call | Auth |
|---|---|---|
| 1 | `GET {BUS}/health` | none |
| 2 | `GET {BUS}/ready` | admin |
| 3 | `POST {BUS}/ingest/website` | ingest |
| 4 | `POST {BUS}/ingest/website` — same contact (replay) | ingest |
| 5 | `POST {BUS}/ingest/estimate` (`Idempotency-Key: lp-<execution-id>`) | ingest |
| 6 | `POST {BUS}/ingest/estimate` — replay, same key | ingest |
| 7 | `GET {BUS}/admin/envelopes?limit=10` | admin |
| 8 | `POST {BUS}/admin/reconcile` | admin |
| 9 | `GET {BUS}/admin/status?audit_limit=20` | admin |

After step 4 the tool also `GET`s `{BUS}/admin/envelope/:canonical_envelope_id` (admin) to
read back the D1 row. Steps 1 and 2 are asserted inline, so a red `/ready` stops the run
before step 3 — no synthetic record is written.

## 5. Side effects, by step

### Step 3 — `POST /ingest/website` (the only step that reaches outbound rails)

| Effect | Store | Detail |
|---|---|---|
| Raw body object | **R2 `RAW`** | key `raw/<YYYY-MM-DD>/ow_<uuid>.json`. Written **first**, before anything else. |
| Dedup claim | **D1 `dedup_claims`** | tenant-scoped key `t:<tenant_id>:p:+1587555NNNN`. Insert or window-expiry update. |
| Envelope row | **D1 `envelopes`** | `tenant_id` bound; status `pending_jn_push`, `intent_queue` = `residential_sales` (the fixture's `metal roofing` matches the residential route). Response `canonical_envelope_id` equals `envelope_id`. |
| Audit row | **D1 `audit_log`** | `automation=ingest`, `action=received`. |
| Prospect ack email | **Gmail** | `sendInstantAck` → `sendGmail` as `FROM_EMAIL` to `launch-proof+…@example.invalid`. A **real outbound message to an undeliverable address** — it will hard-bounce against the sending domain. |
| Owner alert email | **Gmail** | to `OWNER_ALERT_EMAIL` (production value `info@ironwrapexteriors.com`) — a **real message to a real human inbox**, subject `New lead (website) — residential_sales`. |
| Ack receipt row | **D1 `lead_ack_receipts`** | one row per leg outcome. |
| Queue message | **Queue `JN_QUEUE`** | `{ envelope_id }` onto `ironwrap-jn-push`. Fires because the fixture is valid and not a duplicate. |

Both emails are attempted whenever `GOOGLE_SERVICE_ACCOUNT_JSON` **and** `FROM_EMAIL` are set. They
run under `ctx.waitUntil` and their failure does not fail the proof — so a run can succeed while
having sent mail, and can send mail while otherwise failing.

**Under `--release-smoke`:** the envelope row, the R2 raw object, the dedup claim and the `received`
audit row are all still written exactly as above — these are owned writes, not outbound rails. The
status is `jn_skipped` (not `pending_jn_push`) with `last_error: "release_smoke"`, a second audit row
(`automation=jn_push`, `action=skip`, `result=ok`, `error=release_smoke`) records the skip, and
neither the prospect ack email nor the owner alert email nor the `JN_QUEUE` message fires. The
terminal status is what keeps the row out of the `*/5` stuck sweep (`store.listStuck` selects
`status = 'pending_jn_push'`) even across the production workflow's own automatic rollback to the
previous Worker version — a status survives that rollback, a query filter would not.

### Step 4 — `POST /ingest/website` replay

Returns the original `envelope_id` / `canonical_envelope_id` with `duplicate: true`. It does
**not** insert a second `envelopes` row. Raw is still archived to R2; an `audit_log` `dedup`
row is written against the original identity. No second queue message, no second instant-ack.
Under `--release-smoke` this is unchanged: the replay path never reaches the two outward calls
regardless of the header.

### Queue consumer, triggered asynchronously by step 3

The consumer (`handlePush`) runs after the tool has already moved on. Its effects are **not**
asserted by launch-proof and **not** captured in the evidence artifact.

| Effect | Store | Gate |
|---|---|---|
| Frappe `Lead Envelope` (+ `Roofing Property`, `Roof Job`, production gates) | **Frappe** | `ERPNEXT_ENABLED=true` |
| `envelopes.erpnext_*` columns; `audit_log` `erpnext_push` | D1 | as above |
| **JobNimbus contact** — `POST /api1/contacts`, record type `Customer`, status `New`, tagged `ironwrap-bus`, `bus:<envelope>`, `source:website`, `brand:ironwrap`, `queue:residential_sales` | **JobNimbus (live CRM)** | `JOBNIMBUS_ENABLED=true` — **false in production** (JobNimbus is a non-source); the consumer records a terminal `jn_skipped` instead |
| **JobNimbus job** — `POST /api1/jobs`, record type `Retail`, status `Lead`, related to the contact | **JobNimbus (live CRM)** | as above; fires because the intent is routable |
| Preceding JobNimbus **reads** — `GET /api1/contacts` and `/api1/jobs` filtered by tag/email/phone | JobNimbus | as above |
| **Google Drive job folder** + the six `01…06` subfolders under `SHARED_DRIVE_ID_JOBS` | **Google Drive** | fresh JN job number **and** `GOOGLE_SERVICE_ACCOUNT_JSON` + `SHARED_DRIVE_ID_JOBS` set — no JN job number exists while `JOBNIMBUS_ENABLED` is false, so this does not fire in production |
| `audit_log` `jn_push`; `envelopes.status='pushed'` | D1 | |
| On failure: `dead_letter` row after retry exhaustion, DLQ message on `ironwrap-jn-dlq` | D1 / Queue | |

JobNimbus `api1` has **no DELETE**; cleanup is a soft archive via `PUT {is_archived:true}`. A
synthetic contact and job created here are permanent CRM records for practical purposes.

### Steps 5 and 6 — `POST /ingest/estimate` ×2

| Effect | Store | Detail |
|---|---|---|
| Raw body object ×1 | **R2 `RAW`** | `raw/estimates/<YYYY-MM-DD>/ow_<uuid>.json` (first call only; the replay short-circuits). |
| Envelope row ×1 | **D1 `envelopes`** | `estimate_submission_key = estimate:project:lp-<execution-id>`. |
| Audit rows ×2 | **D1 `audit_log`** | `received`, then `idempotent_replay`. |
| Frappe `Lead Envelope` + `Instant Estimate Session` (`estimate_session_id = estimate:LP-<execution-id>`) | **Frappe** | only when `ERPNEXT_ENABLED=true`. Not a launch-proof wire step or gate. |
| `envelopes.erpnext_*`; `audit_log` `erpnext_estimate` | D1 | |

No queue message, no email, no JobNimbus, no Drive on this path regardless of `--release-smoke` —
the header only marks the row (`release_smoke = 1`) since there is no outbound rail here to skip.

### Step 8 — `POST /admin/reconcile`

| Effect | Store | Detail |
|---|---|---|
| Heartbeat upsert | **D1 `heartbeat`** | `INSERT … ON CONFLICT(day) DO UPDATE` — **overwrites today's row**, including `ran_at`. |
| Daily digest email | **Gmail** | to `OWNER_ALERT_EMAIL` **and** `BACKUP_ALERT_EMAIL` (production `info@` and `sales@ironwrapexteriors.com`). The digest text asserts of itself that its arrival *is* the heartbeat, so an out-of-band copy is misleading to the recipient. |

**Under `--release-smoke`:** the daily digest email is skipped (both recipients). The heartbeat
upsert is **not** skipped and is the one effect this mode does not remove — a production release
proof still overwrites today's `ran_at`, because `/admin/status` (step 9 / success criterion 9)
asserts the heartbeat present, fresh and reconciled, and a skipped heartbeat would fail the very
run that skipped it.

Steps 1, 2, 7, and 9 are Worker read-only. There is no Frappe lookup step.

### Totals for one production `--execute`

- **up to 4 real emails**: prospect ack (bounces), owner alert, digest to owner, digest to backup;
- **1 live JobNimbus contact + 1 live JobNimbus job**, plus lookup reads;
- **1 Google Drive job folder with 6 subfolders** on the jobs shared drive;
- **3 R2 objects** (website, website replay raw, estimate);
- **1 queue message** (plus DLQ traffic on failure);
- **D1 writes** across `envelopes` (2 rows: one website lead, one estimate; website replay
  does not add a row), `dedup_claims`, `audit_log` (≥5 rows),
  `lead_ack_receipts`, `heartbeat` (day row overwritten);
- **Frappe records** are not launch-proof wire effects. If `ERPNEXT_ENABLED=true`, the queue
  consumer may still write `Lead Envelope` / property / job / session rows — that rail is
  IRO-195, not this proof's gate.

### Totals for one `--release-smoke --execute` (what `deploy-production.yml` runs against production)

- **0 emails**, **0 JobNimbus writes**, **0 Drive writes** — the three effects this mode exists to
  remove, and the reason it exists rather than pointing production at a non-production target.
- **3 R2 objects** and the same `envelopes` / `dedup_claims` / `audit_log` D1 writes as an ordinary
  run, **plus** one extra `audit_log` row for the `jn_push` skip — these are owned writes, not
  outward rails, and every release leaves real rows of this shape in production by design.
- **`heartbeat` day row still overwritten** — the one effect this mode does not remove (§5, step 8).
- The envelope rows this leaves behind are permanently distinguishable from a real customer lead by
  `status = 'jn_skipped'`, `last_error = 'release_smoke'` and `release_smoke = 1` — they are not
  cleaned up by this tool or by this mode; see §8.

## 6. Success criteria

Hard assertions, any of which aborts the run:

1. `/health` HTTP 200.
2. `/ready` HTTP 200 **and** `ok == true` **and** `status == "ready"` **and every entry in `checks`
   truthy** — including the `newo_*` checks whenever `NEWO_PRODUCTION_REQUIRED=true` or
   `NEWO_ENABLED=true`.
3. `/ingest/website` HTTP 200 with a non-empty `envelope_id` and `canonical_envelope_id`.
4. `/ingest/website` replay HTTP 200, `duplicate == true`, same `canonical_envelope_id`.
5. Both `/ingest/estimate` calls HTTP **200** and both returning the **same** `envelope_id`.
6. `GET /admin/envelope/:id` HTTP 200 with the stored D1 row (tenant_id + contact identity).
7. `/admin/envelopes` HTTP 200 and the lead envelope id present in the first 10 rows.
8. `/admin/reconcile` HTTP 200.
9. `/admin/status`: `status == "ok"`; heartbeat present, `fresh`, `reconciled`; each of
   `open_dead_letters`, `stuck`, `frappe_errors`, `replay_failed`, `replay_stuck` == 0; zero recent
   audit failures. Under `--release-smoke` this holds because the smoke lead is written terminal
   (`jn_skipped`, §5 step 3) and is never a `stuck` candidate; a query filter on
   `getOperationalEnvelopeCounts` instead of a terminal status would have left this criterion
   failing on the **next** release, ~15 minutes after this one.
10. Final CLI gate: `evidence.operating_authority == "d1"` and `evidence.d1_lead.state == "matched"`.
    `frappe_projection.state` is `out_of_scope` and is **not** the gate.

A Frappe projection is not required and is not called. The D1 envelope is the operating record.

## 7. Evidence produced

`--execute` prints one redacted JSON object to stdout (`proof: "ironwrap-launch-proof-v4"`) holding
the envelope id, project id, per-step HTTP status and request id, the readiness check map,
reconciliation day/gap counts, operational status, and D1 lead identity. No payloads, tokens,
or contact fields. Nothing is written to disk — archiving it is the operator's step. Frappe is
`out_of_scope`; a green proof is D1 operating-authority evidence, not authority to retire JobNimbus
and not a HELM permit/receipt (IRO-190).

## 8. Reversal

| Effect | Reversible? |
|---|---|
| D1 rows | Yes, by id — except the `heartbeat` day row, whose prior `ran_at` is lost. |
| R2 objects | Yes, by key. |
| Queue message | No; already consumed. |
| Emails | **No.** |
| JobNimbus contact/job | Soft archive only (`PUT {is_archived:true}`); no delete on `api1`. |
| Drive folder tree | Yes, manually. |
| Frappe records | Yes, by operator with sufficient rights. |

Under `--release-smoke` the queue message, the emails and the JobNimbus contact/job rows in this
table are never created in the first place, so there is nothing to reverse for them. The Drive
folder tree is likewise never created — it hangs off a fresh JobNimbus job number, which this mode
never produces. What remains to reverse is unchanged: the D1 rows (now also tagged
`release_smoke = 1`, which does not change how they are reversed) and the `heartbeat` day row's lost
prior `ran_at`.

## 9. Reading this before authorizing

A production run is **not** dry-runnable: dry-run exercises nothing. The lowest-side-effect real
rehearsal is to point `BUS_BASE_URL` at a non-production Worker whose `JOBNIMBUS_ENABLED=false`,
whose `GOOGLE_SERVICE_ACCOUNT_JSON` is unset — that removes
every email, every CRM write, and every Drive write while still exercising D1, R2, the queue, and
the estimate path. Frappe is not part of this proof.

`--release-smoke` is the production case: it is how `deploy-production.yml` runs this exact tool
against the real `ironwrap-bus` Worker on every release (IRO-264) without a non-production target to
point at instead. It removes the same three effects as the rehearsal above, by construction in the
Worker rather than by unplugging a credential, and it leaves behind real, permanently-tagged D1 and
R2 rows in production — see the `--release-smoke --execute` totals above and §8.
