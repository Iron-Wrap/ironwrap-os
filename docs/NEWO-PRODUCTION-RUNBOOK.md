# Newo Production Runbook

## Gate model

This runbook separates repository proof, Cloudflare deployment proof, Newo console proof, downstream proof, and real-call proof. None substitutes for another.

Launch order:

1. Staging actor and disposable API proof.
2. After-hours and missed-call forwarding.
3. Selected inbound calls.
4. All inbound calls only after owner sign-off.

The existing business-number human or voicemail route remains the rollback path at every phase. Customer-facing outbound calls and messages remain disabled.

## 1. Repository gate

From the repository root:

```bash
node tools/validate-newo-config.mjs
node tools/validate-erpnext-doctypes.mjs
node tools/validate-hermes-config.mjs
npm test --prefix workers-bus
npm run typecheck --prefix workers-bus
npm test --prefix mcp/newo-mcp
```

Build `app/dist`, then validate the Worker bundle:

```bash
npm ci --prefix app
npm run build --prefix app
npm run deploy --prefix workers-bus -- --dry-run
```

Do not run the production gate successfully by weakening it. `node tools/validate-newo-config.mjs --production` must remain red until the evidence indexes are updated from real proof.

## 2. Cloudflare resources

Create the dedicated queues if they do not exist:

```bash
cd workers-bus
npx wrangler queues create ironwrap-newo-events
npx wrangler queues create ironwrap-newo-dlq
```

Apply all D1 migrations to the target database:

```bash
npm run db:migrate
```

Apply the 30-day R2 rule to only the Newo prefix, then list it:

```bash
npx wrangler r2 bucket lifecycle add ironwrap-bus-raw newo-raw-30d raw/newo/ --expire-days 30
npx wrangler r2 bucket lifecycle list ironwrap-bus-raw
```

Attach the time-bounded command output or Cloudflare console proof to `config/newo/console-proof.json`. Set `NEWO_R2_LIFECYCLE_PROVEN=true` only in the exact deployment that has that verified rule.

## 3. Secrets and non-secret configuration

Store values only as Cloudflare secrets:

```bash
cd workers-bus
npx wrangler secret put NEWO_API_KEY --env=""
npx wrangler secret put NEWO_WEBHOOK_TOKEN --env=""
npx wrangler secret put NEWO_BOOKING_TOKEN --env=""
npx wrangler secret put NEWO_CONTROL_SIGNING_SECRET --env=""
```

Production also requires the existing Frappe and notification secrets. `/ready` cannot pass with `NEWO_WEBHOOK_TOKEN` absent or Frappe disabled/unreachable.

Fill the reviewed non-secret values in `wrangler.jsonc` and `config/newo/production.expected.json`:

- project ID and dedicated production agent ID;
- report and handoff webhook IDs and exact Worker URLs;
- Newo-owned number (no transfer number: the receptionist is callback only);
- owner-approved usage limit and alert percent;
- callback owner Frappe user;
- expected tool, report, and AKB hashes.

Keep these launch values:

```text
NEWO_BOOKING_MODE=request_only
NEWO_OUTBOUND_ENABLED=false
NEWO_CONTROL_WRITE_ENABLED=false
NEWO_JOBNIMBUS_BOOKING_PROVEN=false
```

Control writes may be enabled later without enabling customer sends. Outbound customer operations require both governed approval and `NEWO_OUTBOUND_ENABLED=true`.

## 4. Newo sandbox proof

Use the Sofia onboarding/test actor only as staging input. Create a separate disposable sandbox actor for mutation tests and a dedicated production actor for release.

Exercise every operation in `config/newo/sandbox-fixtures.json`. Create, update, and delete only disposable actors and webhooks. Redact API keys, bearer/refresh tokens, real customer information, transcript text, and recording data. Preserve request method/path, allowlisted headers, redacted body shape, response status, provider IDs, and response shape.

Store each request and response under `config/newo/fixtures/`, update its index entry to `captured`, and rerun the validator. Never delete an active production actor or report webhook during a sandbox test.

## 5. Newo console publication

Publish the dedicated production actor only after review of:

- the exact five tool definitions in `config/newo/tools.v1.json`;
- the structured report schema and immediate-handoff report;
- the versioned AKB, with owner and legal wording approval;
- AI and recording disclosure at call start;
- callback-only handoff: no call-transfer action, transfer number, or voicemail transfer on the actor, and `request_handoff` sends handoff status `failed` (console proof `handoff_callback_only`);
- Newo in-call SMS tool disabled (console proof `newo_in_call_sms_disabled`);
- Newo-owned number and written portability/exit terms;
- usage cap and threshold alert;
- phone connector, scenario lifecycle, and AKB version.

The documented API does not cover the complete phone-connector, AKB-publishing, or scenario-lifecycle surface. Complete those in the Newo console/provider workflow and attach expiring evidence in `config/newo/console-proof.json`.

## 6. Staging and failure proof

Run the 26 cases in `config/newo/evaluation-cases.v1.json` against the exact actor and Worker version. Pass requires at least 85 percent capture-and-routing accuracy and zero catastrophic failures.

Required failure evidence includes wrong job verification, prompt injection, exact replay and hash conflict, same-caller second session, report omission, and dependency outage. A dependency failure must preserve accepted D1/R2 state and must not produce a false booking, callback time, delivery, or downstream confirmation.

Prove before forwarding:

1. Wrong credentials create no R2/D1 business record.
2. A valid controlled call creates an R2 object, event receipt, session, Frappe record, downstream outcome, and readable operator state.
3. A missing report becomes one visible reconciliation exception.
4. Each immediate handoff creates an urgent callback incident and owner alert, and no call is transferred.
5. Forwarding rollback works from the real number.

## 7. Booking gate

Keep request-only mode unless JobNimbus exposes a supported appointment contract. Controlled proof must cover create, read, collision, update, cancel, retry, timezone, and session-bound idempotency with 100 percent correctness.

If supported, return opaque short-lived slot tokens, recheck the slot on booking, and mirror the confirmed appointment to Frappe. Only then set:

```text
NEWO_JOBNIMBUS_BOOKING_PROVEN=true
NEWO_BOOKING_MODE=confirmed
```

If the contract is absent or any test fails, remain request-only.

## 8. Cutover gates

After-hours forwarding requires the repository gate, production config gate, 26-case evaluation, wrong-credential proof, owned landing proof, urgent callback incident proof, usage alert proof, and owner approval.

Selected inbound requires reviewed real-call evidence from after-hours operation, no unresolved catastrophic incident, acceptable capture/routing accuracy, and demonstrated rollback.

All inbound requires owner sign-off, zero unresolved catastrophic incidents, working urgent callback incidents, no missing reports or DLQ failures, and another demonstrated rollback.

Record the exact Git commit, Worker version, D1 migration state, Newo actor ID, AKB hash, tool/report hashes, phone number, forwarding phase, reviewer, timestamps, and evidence references.

## 9. Runtime checks

Use the admin bearer for diagnostic readiness. The unauthenticated route intentionally returns only a generic result.

```bash
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker-origin>/ready
```

The five-minute cron retries Newo landing and detects missing reports. The daily cron checks actor/webhook/config drift, Frappe callback incidents, downstream failures, and records that call-minute usage is unavailable from the documented API. Provider-console usage alerts remain required evidence.

## 10. Rollback

1. Disable forwarding in the telephony/Newo control plane.
2. Restore the existing business-number human or voicemail route.
3. Set `NEWO_ENABLED=false` and leave `NEWO_PRODUCTION_REQUIRED=true` during recovery.
4. Disable Newo receptionist tools and keep outbound disabled.
5. Do not delete accepted D1/R2 records, sessions, receipts, incidents, or control evidence.
6. Leave queue and reconciliation processing enabled until every accepted event has landed or has an owned exception.
7. Record the rollback time, actor, reason, affected sessions, downstream state, and recovery decision.
