# Newo Production Runbook

## Gate model

This runbook separates repository proof, Cloudflare deployment proof, Newo console proof, downstream proof, and real-call proof. None substitutes for another.

Launch order:

1. Staging actor and disposable API proof.
2. After-hours and missed-call forwarding.
3. Selected inbound calls.
4. All inbound calls only after owner sign-off.

The existing business-number human or voicemail route remains the rollback path at every phase. Customer-facing outbound calls and messages remain disabled.

### Enablement hardening blockers

`NEWO_ENABLED` stays false. A callback request with no delivered alert and no screen is a launch blocker: a D1 record alone does not prove that a person can find and work the callback. Before enablement, prove the missing-alert recovery sweep, operations attention state, people-only resolution, and the operator screen on the deployed candidate. The source sweep retries open callbacks with no confirmed sent marker, even when no later Newo event arrives, and both reconciliation schedules stay degraded until a person closes the callback.

The remaining source gates are corrected contact details in the durable callback record and redaction with the owner's three-year inbound retention contract, including age-gated deletion in foreign-key-safe order. Migration `0172` supplies tenant/event admission; its source review and actual predecessor/main integration are separate from installed runtime proof. Source replay and Worker readiness now check the complete installed callback contract, but deployed D1 readback, recovery proof, provider delivery and owner acceptance remain separate gates.

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

### Tenant/event migration and readiness

Keep `NEWO_ENABLED=false` while integrating `0172`. Merge all actual predecessor migrations, recount all twelve named schema pins and backup/restore bindings, and prove full installed SQL, autoindexes and per-table trigger order for filename order versus deployment order before migration readiness. A stacked source-order pass is provisional until that actual integration proof exists.

Read installed `checks.newo_callback_schema` and `checks.newo_tenant_binding` on the exact candidate, without treating either as provider delivery. The second check requires an explicit `APP_TENANT_ID` and nine zero hold counts in `newo.tenant_binding_holds`; a missing query, incomplete result or unresolved original identity fails closed. Counts contain no caller details. Use the conservative backfill rules in [NEWO-INTEGRATION.md](NEWO-INTEGRATION.md#handoff-and-sms); do not adopt the deployment tenant for historical rows, infer it from a callback label, or let another incoming call resolve a hold. Preserve conflicting history for a separately reviewed owner mapping.

`newo_event_admissions` is the durable business acceptance record. Receipt acknowledgement may be failed after a queue outage even though the callback obligation committed; recovery reuses the admitted fact and original callback. Verify both a late accepted failure after a newer normal report and queue failure/retry without changing the newer session or prior unknown email effects.

This migration is forward-only. Older Workers cannot supply its required admission facts and must not be restored as enabled producers. Keep Newo off during a coordinated Worker/database rollback; retain the existing human or voicemail path. D1 backup/restore admission includes the new table, indexes and guard bindings, but a source comparison is not a restored production database. Corrected-contact and Newo child privacy changes require their own review; the separate signal-erasure migration does not provide this lifecycle.

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
- expected tool, report, and AKB hashes.

Keep these launch values:

```text
NEWO_BOOKING_MODE=request_only
NEWO_OUTBOUND_ENABLED=false
NEWO_CONTROL_WRITE_ENABLED=false
NEWO_JOBNIMBUS_BOOKING_PROVEN=false
```

`node tools/validate-newo-config.mjs` and the readiness contract refuse `NEWO_ENABLED=true` unless applying the migrations builds the complete reviewed callback/resolution schema. The shared contract binds all 15 callback columns, types, CHECKs, primary/unique keys, foreign keys, all eight guard definitions and table bindings, their per-table creation order, and the session, receipt and actor dependency tables. A table name or synthetic column marker is insufficient. Installed SQL fingerprints preserve literal whitespace and fail closed on changed definitions; a migration changing the contract needs matching fingerprints and behavioral evidence.

The Worker reads the installed contract from its own D1 connection as `checks.newo_callback_schema`, without provider calls or business writes. This result joins the general D1/schema checks in Newo operations' `owned_database` readiness. A static pass proves only repository migration replay. Before enablement, verify the exact deployed candidate's D1 schema and Newo readiness, then complete the separate recovery, screen, provider and owner gates. A JSON boolean `true` counts as on, as it does in the Worker; all shipped Wrangler environments keep `NEWO_ENABLED=false`.

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
- callback-only handoff: no call-transfer action, transfer number, or voicemail transfer on the actor, and `request_handoff` sends handoff status `requested` (console proof `handoff_callback_only`);
- Newo in-call SMS tool disabled (console proof `newo_in_call_sms_disabled`);
- Newo-owned number and written portability/exit terms;
- usage cap and threshold alert;
- phone connector, scenario lifecycle, and AKB version.

The documented API does not cover the complete phone-connector, AKB-publishing, or scenario-lifecycle surface. Complete those in the Newo console/provider workflow and attach expiring evidence in `config/newo/console-proof.json`.

## 6. Staging and failure proof

Run the 31 cases in `config/newo/evaluation-cases.v1.json` against the exact actor and Worker version. Pass requires at least 85 percent capture-and-routing accuracy and zero catastrophic failures.

Required failure evidence includes wrong job verification, prompt injection, exact replay and hash conflict, same-caller second session, report omission, and dependency outage. A dependency failure must preserve accepted D1/R2 state and must not produce a false booking, callback time, delivery, or downstream confirmation.

Prove before forwarding:

1. Wrong credentials create no R2/D1 business record.
2. A valid controlled call creates an R2 object, event receipt, session, D1 operating-core record, downstream outcome, and readable operator state.
3. A missing report becomes one visible reconciliation exception.
4. A requested handoff records the callback request on its D1 session (handoff status `requested`, highest urgency kept) and emails the owner the caller's name, phone, address, and reason; the email is best effort. No call is transferred. A handoff request that cannot be processed, or an emergency session that closes without one, is recorded as `failed` and raises the urgent failure email and the failed-handoff exception.
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

Before the change that sets `NEWO_ENABLED=true`, apply the D1 migrations through `0168_newo_callback_records.sql` to the production database (`npm run db:migrate --prefix workers-bus`) and confirm that none is pending. Without 0168 the D1 batch that writes a session and its callback record fails, so every event that owes a callback gets a 500 and nothing holds that caller's callback. Flip `NEWO_ENABLED` only after that.

After-hours forwarding requires the repository gate, production config gate, 31-case evaluation, wrong-credential proof, owned landing proof, callback request proof, usage alert proof, and owner approval.

Selected inbound requires reviewed real-call evidence from after-hours operation, no unresolved catastrophic incident, acceptable capture/routing accuracy, and demonstrated rollback.

All inbound requires owner sign-off, zero unresolved catastrophic incidents, working callback requests, no missing reports or DLQ failures, and another demonstrated rollback.

Record the exact Git commit, Worker version, D1 migration state, Newo actor ID, AKB hash, tool/report hashes, phone number, forwarding phase, reviewer, timestamps, and evidence references.

## 9. Runtime checks

Use the admin bearer for diagnostic readiness. The unauthenticated route intentionally returns only a generic result.

```bash
curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker-origin>/ready
```

The five-minute cron retries unconfirmed alerts for open callbacks before queue recovery, retries Newo landing and detects missing reports. The alert sweep handles at most 25 records per run and continues from a tenant-scoped cursor; a confirmed alert is skipped, while a timed-out send remains unknown in the effect ledger and a later sweep uses a distinct attempt. Both the five-minute and daily runs stay degraded while callbacks or failed handoffs remain open. The daily cron also checks actor/webhook/config drift, open Newo `Automation Incident` records in Frappe (no Worker code writes them since the native D1 cutover), downstream failures, and records that call-minute usage is unavailable from the documented API. Provider-console usage alerts remain required evidence.

## 10. Rollback

1. Disable forwarding in the telephony/Newo control plane.
2. Restore the existing business-number human or voicemail route.
3. Set `NEWO_ENABLED=false` and leave `NEWO_PRODUCTION_REQUIRED=true` during recovery.
4. Disable Newo receptionist tools and keep outbound disabled.
5. Do not delete accepted D1/R2 records, sessions, receipts, incidents, or control evidence.
6. Leave queue and reconciliation processing enabled until every accepted event has landed or has an owned exception.
7. Record the rollback time, actor, reason, affected sessions, downstream state, and recovery decision.

Migration `0168` makes the callback-resolution write incompatible with an older Worker that writes `resolved_at` from its JavaScript clock and allows an empty note: the installed guard requires D1's clock and a nonempty note. The release rollback probes exercise `/health` and `/ready`, not that resolution write. Keep Newo off during recovery and verify a synthetic callback read and people-only resolution on the rollback candidate before treating it as compatible. Do not remove the guard to accommodate the older write path; use a compatible Worker or a forward repair. A successful health/readiness rollback probe does not prove callback resolution or recovery-alert delivery.
