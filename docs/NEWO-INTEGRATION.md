# Newo Receptionist and NAF Federation

## Authority boundary

Newo owns live voice, ConvoAgent execution, NAF reasoning and tool selection, AKB delivery, and telephony. IronWrap owns customer and business truth, policy, approvals, evidence, reconciliation, and audit.

Newo never writes directly to Frappe, JobNimbus, QuickBooks, email, SMS, or another customer communication provider. Every accepted event lands in IronWrap D1 and R2 before downstream work.

```mermaid
flowchart LR
  Caller --> Newo["Newo voice and NAF"]
  Newo --> Tools["Strict IronWrap tools"]
  Tools --> R2["R2 raw/newo"]
  Tools --> D1["D1 receipts and sessions"]
  D1 --> Queue["Retried Newo queue"]
  Queue --> Core["D1 operating core: lead, customer, property, job"]
  D1 --> JN["JobNimbus temporary bridge"]
  D1 --> Reconcile["Missing report and drift reconciliation"]
  D1 --> Callbacks["D1 callback records, closed by a person"]
```

## Implemented surface

Receptionist routes:

| Route | Purpose | Credential |
|---|---|---|
| `POST /webhook/newo/lookup` | Verified caller lookup with minimal job state | `NEWO_WEBHOOK_TOKEN` |
| `POST /webhook/newo` | Capture a distinct reception lead/session | `NEWO_WEBHOOK_TOKEN` |
| `POST /webhook/newo/handoff` | Record a callback request: the session's handoff status `requested` and its D1 callback record | `NEWO_WEBHOOK_TOKEN` |
| `POST /webhook/newo/report` | Structured terminal session report | `NEWO_WEBHOOK_TOKEN` |
| `POST /webhook/newo/availability` | Request-only availability response | `NEWO_BOOKING_TOKEN` |
| `POST /webhook/newo/booking` | Appointment request | `NEWO_BOOKING_TOKEN` |
| `POST /webhook/newo/booking/cancel` | Appointment request cancellation | `NEWO_BOOKING_TOKEN` |

The event adapter rejects extra properties, transcript text, and recording bodies. Exact event replay returns the original receipt. Reusing an event ID with a different canonical hash returns `409` and records conflict evidence. A repeated caller creates another `Reception Session`; contact matching only associates verified customer/property/job context.

The typed Worker client covers all 31 operations in the documented Newo API groups. Access and refresh tokens stay in Worker isolate memory. Governed mutations require an exact dry-run receipt, separately signed approval, one-time D1 claim, and applicable runtime gates. There is no raw Newo proxy.

People close a callback on the app API, never through Newo, an agent or a connector: `POST /api/v1/newo/operations/handoffs/{session_id}/resolution` (owner or ops, their own cookie session, CSRF and `Idempotency-Key`) and `GET` on the same path ([AUTHORITY-AND-EVIDENCE-CONTRACT.md](AUTHORITY-AND-EVIDENCE-CONTRACT.md#newo-callbacks-and-failed-handoffs)).

The `newo-mcp` exposes role-filtered Worker operations. It never receives `NEWO_API_KEY` or a Newo bearer token. `owner-operator` receives governed controls, `support-admin` receives operational/configuration reads, and `lead-concierge` receives bounded session/conversation reads. Other roles receive no Newo tools.

## Handoff and SMS

The release contract is callback only. The AKB forbids transferring a call live to a person, an owner line, or voicemail. Each handoff calls `request_handoff` with the reason, the caller's urgency, and handoff status `requested`. The Worker accepts only `requested`, `failed`, or no status and refuses anything else with `422`, including a live connection (`connected`). A handoff request that arrives without a status is recorded as `requested`.

What the Worker does with each state:

| Session state | D1 session row | D1 callback record | Owner email | Where it waits for a person |
|---|---|---|---|---|
| `requested`, urgency `urgent` or `emergency` | `handoff_status = requested` | Yes, `requested` | "Urgent Newo callback requested - <urgency>", with the caller's name, phone, address and reason | `open_callbacks` |
| `requested`, urgency `routine` | `handoff_status = requested` | Yes, `requested` | "Newo callback requested", with the same details | `open_callbacks` |
| `failed`: the handoff request did not arrive or could not be processed, including an emergency session that closes without one | `handoff_status = failed` | Yes, `failed` | "Urgent Newo callback required", once per session, with the caller's details | `failed_handoffs` |
| A failed session (`session_failed`) with no failed handoff | `status = failed` | No | "Urgent Newo callback required", once per session | None |

A session keeps its strongest handoff status (failed over requested over none) and its highest urgency.

**The callback record.** When an accepted event leaves a session's handoff `requested` or `failed`, the Worker writes one `newo_callback_records` row (migration `0168`) in the same D1 batch as the session: the tenant, the session, the event whose acceptance wrote it, the handoff status and urgency at that moment, the reason, and the caller's name, phone, email and address as the session knows them. The row is append-only, one per tenant and session, and D1 stamps `recorded_at` from its own clock. An event that arrives after a newer one leaves the session row as it was, but its callback record is still written. The operations read model (`GET /api/v1/newo/operations`) lists each requested callback no person has closed in `exceptions.open_callbacks` and counts it in `counts.open_callbacks`; a callback whose session failed is listed once, under `failed_handoffs`. Either keeps the model in `attention` until a person records how it ended: an outcome (`called_back`, `unreachable` or `not_needed`) and a note. Neither list carries the caller's identity or words; the resolution route's `GET` returns the record, contact details included, to an owner or ops person.

**The owner email** is best effort. It is scheduled as soon as the session and its callback record are in D1, before the audit row and the queue sends, so a queue that stays down until Newo stops retrying does not stop it, and it is sent after the response through `waitUntil`. An alert counts as sent only once its send succeeds; the Worker then writes a sent marker to R2 (`raw/newo/owner-alerts/<session>/failure.json`, or `handoff-<event>.json` for a callback request). Whether an alert is owed rests on that marker, not on the session state an event finds. A send that fails leaves a log line and no marker, and what retries it depends on the alert:

- The failure alert is owed on every accepted event of the failed session until it is recorded as sent, so the session's next event, Newo's retry included, sends it.
- The callback-request alert is attempted only while its own `handoff_requested` event is processed, Newo's retry of that event included. No later event repeats it; the D1 callback record keeps the callback open in the read model until a person closes it.

Each processing of an event sends its own attempt: the email ends with the event id and the processing attempt, so its content, and with it the Gmail effect's idempotency identity, is new each time. A send whose outcome is unknown (a timeout) stays unknown in the effect ledger and is never sent again as the same effect; the next attempt is a separate effect that says it may repeat an earlier alert, so the urgent alert never waits for that reconciliation. Two events of one session arriving together can both send an alert. No Frappe record or incident is written for a Newo session.

**The enablement gate.** `node tools/validate-newo-config.mjs` and the readiness contract (`contract.newo.callback_record_gate`) refuse `NEWO_ENABLED=true` unless the D1 callback record exists. `tools/newo-enablement.mjs` applies every migration in filename order to an in-memory SQLite and passes only when `sqlite_master` holds a `newo_callback_records` table with the columns a person needs; it never reads migration text, so a quoted alias, a comment, a string or a table a later statement drops does not count. With `0168` the gate passes. `NEWO_ENABLED` stays `false` in `wrangler.jsonc`, and switching it on is a separate change at go-live. The gate reads `NEWO_ENABLED` as the Worker does, so a JSON boolean `true` counts as on. No transfer number or transfer policy is configured.

Newo's in-call SMS tool stays disabled, and the AKB forbids Newo SMS. SMS confirmations belong to IronWrap, and customer SMS stays record-only until the A2P/carrier gate passes.

`production.expected.json` records both rules in its `handoff` and `sms` blocks. `node tools/validate-newo-config.mjs` fails if a live handoff (a transfer, an owner line, forwarding the call, or a forwarding number) returns to the expected config, tools, console proof, Worker config, AKB, or evaluation cases, if anything tells Newo to text the caller, if callback only uses `failed` as the routine handoff status, if an evaluation case promises an incident for a callback (`callback incident` however it is joined, or "opens", "creates", "raises", "files" or "logs" an incident), or if Newo SMS is turned on. The matching Newo console settings are the `handoff_callback_only` and `newo_in_call_sms_disabled` proofs in `console-proof.json`; the repository does not prove them.

## Booking truth

Launch mode is `request_only`. The only caller-safe success phrase is:

> Appointment request received.

Confirmed booking is not implemented as production authority until the real JobNimbus appointment API passes controlled create, read, collision, update, cancel, retry, and timezone tests with 100 percent correctness. No Make, GHL, or unowned calendar fallback may be substituted silently.

## Data and retention

- D1 stores event receipts, provider-neutral session snapshots, callback records and their resolutions, control actions, slot reservations, and reconciliation runs. A callback record keeps the caller's contact details the owner email carries, for the person who calls back.
- R2 stores validated raw provider events under `raw/newo/`, and the owner-alert sent markers under `raw/newo/owner-alerts/` (session and event ids, the attempt and the send time, no caller details).
- The Newo queue projects each accepted session into the D1 operating core (lead, customer, property, roof job). No Frappe record is written for a Newo session.
- Transcript and recording bodies are not copied. Only approved provider or R2 pointers are stored.
- The production R2 lifecycle gate is 30 days for `raw/newo/` and remains unproven until Cloudflare evidence is attached.

## Release truth

The repository proves local code and contract behavior. It does not prove a published production actor, AKB publication, phone connector, Newo-owned number, forwarding, provider webhook configuration, usage alert, Worker deployment, live JobNimbus landing, or real-call outcome.

The secret-free expected state is [production.expected.json](../config/newo/production.expected.json). Run:

```bash
node tools/validate-newo-config.mjs
node tools/validate-newo-config.mjs --production
```

The first command validates the current staging package. The second must remain red until all provider/admin/live evidence is complete. Operational activation and rollback are defined in [NEWO-PRODUCTION-RUNBOOK.md](NEWO-PRODUCTION-RUNBOOK.md).
