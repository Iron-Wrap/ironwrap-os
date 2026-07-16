# Activation Checklist - Worker/Account Cutover

> **Scope:** This is a Worker/account cutover checklist, not full IronWrap OS launch authority.
> The release path is [`LAUNCH-RUNBOOK.md`](./LAUNCH-RUNBOOK.md); the Phase 1 acceptance gates are
> [`../final-spec-pack/18-phase-1-source-truth-and-build-contract.md`](../final-spec-pack/18-phase-1-source-truth-and-build-contract.md).
> Revalidate deployed resources and all external claims in the target account before checking an item done.

Everything in `workers-bus/` is buildable and locally verified. The remaining work is target-account
wiring, live-source cutover, Frappe/Hermes deployment, and the wider production proof set.

- Bus base URL: `https://ironwrap-bus.yellow-rain-7498.workers.dev`
- Set a secret from `workers-bus/`: `printf '%s' '<value>' | npx wrangler secret put <NAME>` using
  the approved IronWrap account identity; never pass a generic Cloudflare token through a repository script.
- Companion docs: `SETUP-CHECKLIST.md`, `WEBSITE-INTEGRATION.md`, `EMAIL-DUAL-DELIVERY.md`, `DELIVERY-PLAN.md`.
- Exhaustive Phase 1 contract: `final-spec-pack/18-phase-1-source-truth-and-build-contract.md`.

Legend: `[ ]` todo, `[x]` done/verified, `[~]` operating with a known temporary bridge.

## 0. Current Operating Baseline

- [x] Cloudflare Worker, D1, R2, queues, cron, and secrets exist.
- [~] Local Wrangler auth currently points at Mindburn Labs, not the configured IronWrap Cloudflare account; live resource inventory/deploy needs the IronWrap account token/login.
- [x] `JOBNIMBUS_ENABLED=true`; JobNimbus API write path was live-tested.
- [x] Gmail send path and Google Drive filing use `GOOGLE_SERVICE_ACCOUNT_JSON`.
- [x] Shared Drives exist: IW Jobs, IW Restricted, IW Archive.
- [x] Inbound `ironwrapexteriors.com` mail lands in Google Workspace.
- [~] `info@` and `quote@` are mirrored to Microsoft 365 until migration is closed; `ilya@` routes Microsoft-only. See `EMAIL-DUAL-DELIVERY.md`.
- [x] DocuSeal Worker route removed; DocuSeal itself is retired permanently (AGPL). E-sign: commercial e-sign API or owned signing; JobNimbus native e-sign bridges only until JobNimbus retires.
- [x] SMS sending removed from the Worker; prospect SMS belongs in JobNimbus Engage after A2P approval.

## 1. Feed Real Leads Into The Bus - Hard Go-Live Gate

Today this is the keystone. Choose exactly one first feed:

- [ ] Website forms -> server-side forward from `WEBSITE-INTEGRATION.md` to `POST /ingest/website`.
- [ ] Or Make UI bridge -> append one HTTP module after the working lead sync and POST the same payload to `/ingest/website` with an Ignore error handler.

Do Make edits in the UI, not via API.

Verify:

```bash
wrangler d1 execute ironwrap-bus --remote --command "SELECT envelope_id, source, status, created_at FROM envelopes ORDER BY created_at DESC LIMIT 5"
```

Expected: real test lead appears in D1, raw lands in R2, JobNimbus contact gets `brand:*` and `bus:*` tags, Gmail ack/owner alert sends.

## 2. Email And DNS

- [x] Google Workspace is primary for IronWrap inbound.
- [x] Bus sends from `sales@ironwrapexteriors.com` for now.
- [ ] Confirm/finish Google DKIM and DMARC monitoring for `ironwrapexteriors.com`.
- [ ] Keep Microsoft dual-delivery rules until owner confirms the M365 mirror can be disabled.
- [ ] Later: switch `FROM_EMAIL` from `sales@` only if the desired sender alias is verified and tested.

Verify: `POST /admin/reconcile` with `ADMIN_TOKEN` and confirm the digest reaches owner + backup.

## 3. Google Drive Job Files

- [x] Worker can file photos and measurement reports to Google Drive Shared Drives.
- [x] Measurement path decision made: the Worker owns canonical `POST /ingest/measurement`;
  Make/RoofRuler may bridge into it, but should not remain a separate source of truth.
- [ ] Point Jotform Jobsite Photo form at `POST /ingest/photo`.
- [ ] Point the measurement/report feed or Make bridge at `POST /ingest/measurement`.
- [ ] Migrate historical OneDrive files to Google Drive using `docs/DRIVE-STRUCTURE-AND-MIGRATION.md`.

Verify: photo/report test returns `uploaded > 0` and lands under the JobNimbus job-number folder.

## 4. A2P / Engage SMS

- [ ] Subscribe/configure JobNimbus Engage.
- [ ] Submit A2P 10DLC / Canadian carrier registration with legal name, CRA Business Number, address, website, opt-in language, and samples.
- [ ] Do not add Twilio SMS secrets to the Worker. Twilio is only for owning a portable voice DID if needed.

Verify: after approval, Engage can send/receive an opt-in transactional SMS and STOP is honored.

## 5. QuickBooks

- [ ] Set `QB_WEBHOOK_TOKEN`.
- [ ] Point QuickBooks Online webhook to `POST /webhook/quickbooks`.
- [ ] Enable QuickBooks Payments if that is the chosen invoice payment path.
- [~] QB OAuth read path is deliberately deferred; the current Worker accepts signed webhook
  events and records audit rows, but does not mirror invoice/payment status back to JobNimbus yet.

Verify: signed webhook returns `{ ok: true }`; wrong `intuit-signature` returns 401.

## 6. JobNimbus Admin

- [ ] Rotate the shared JobNimbus API key and store the dedicated bus key with `wrangler secret put JOBNIMBUS_API_KEY`.
- [ ] Confirm plan limits: automation count, integration count, Engage availability.
- [ ] Add/report Lead Sources: `website`, `gbp`, `ad`, `referral`, `manual`, `phone`.
- [ ] Add optional custom fields: `brand`, `envelope_id`, consent basis/date/source.
- [ ] Hard-delete archived `ZZZ ... DELETE ME` contacts in the UI.

## 7. Security And Compliance

- [ ] Confirm Cloudflare token rotation and old-token invalidation.
- [ ] Publish lawyer-approved privacy and consent notices on both brand sites.
- [ ] CASL unsubscribe/STOP tested before any automated SMS.
- [ ] AI/call-recording notice approved before AssistAI.
- [ ] Vendor register, DPAs/ZDR, retention schedule, breach playbook, and access hardening complete.

## 8. Phone AI

- [ ] Configure AssistAI only after lead capture and SMS/compliance basics are under control.
- [ ] Run `docs/ASSISTAI-EVAL.md`; pass threshold is >=85% and zero catastrophic failures.

## Fastest Path To First Real Value

1. Feed one real website or Make lead into `/ingest/website`.
2. Confirm D1/R2/JobNimbus/Gmail proof.
3. Start A2P/Engage in parallel.
4. Wire Jotform photos and QuickBooks webhook after the lead spine is visibly operating.
