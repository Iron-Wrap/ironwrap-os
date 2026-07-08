# IronWrap - Manual Setup Checklist

Human/UI configuration that happens in SaaS tools, not in repo code. This file tracks the current
Google Workspace / Google Drive / JobNimbus spine direction.

Legend: `[ ]` todo, `[x]` done/verified, `[~]` temporary bridge.

## 1. JobNimbus

Grounded in the live API check: valid contact record type is `Customer`, job record type is
`Retail`, contact status `New` exists, and `Lead` was rejected by this account.

- [x] JobNimbus API works on the current account.
- [x] Bus write path live-tested; `JOBNIMBUS_ENABLED=true`.
- [ ] Rotate the API key that was shared in chat and issue a dedicated bus key.
- [ ] Confirm current plan limits for automations/integrations/Engage.
- [ ] Add/report Lead Sources: `website`, `gbp`, `ad`, `referral`, `manual`, `phone`.
- [ ] Confirm pipeline statuses used by the six stage automations in `final-spec-pack/00`.
- [ ] Optional reporting fields: `brand`, `envelope_id`, consent basis/date/source.
- [ ] Hard-delete archived `ZZZ ... DELETE ME` test contacts in the UI.

## 2. Google Workspace Email

- [x] `ironwrapexteriors.com` MX points to Google.
- [x] Google user: `sales@ironwrapexteriors.com`.
- [x] Google aliases: `info@ironwrapexteriors.com`, `quote@ironwrapexteriors.com`.
- [x] Bus Gmail send path works through service account + domain-wide delegation.
- [~] Microsoft 365 mirrors `info@` and `quote@` until migration closes.
- [~] `ilya@ironwrapexteriors.com` routes to Microsoft only.
- [ ] Confirm DKIM enabled and clean DMARC reports before tightening policy.
- [ ] Disable Microsoft mirror rules only after owner confirms migration completion.

See `docs/EMAIL-DUAL-DELIVERY.md` for mailbox routing, GUID addresses, service logins, and off-switch.

## 3. Google Drive

- [x] Shared Drives exist: IW Jobs, IW Restricted, IW Archive.
- [x] Worker has Shared Drive ids in `workers-bus/wrangler.jsonc`.
- [x] Photos and measurement files use Google Drive through `GOOGLE_SERVICE_ACCOUNT_JSON`.
- [x] Measurement ownership decision: the Worker owns the canonical `POST /ingest/measurement`
  path; the existing RoofRuler Make route should forward there or be migrated to it, not stay a
  separate source of truth.
- [ ] Point Jotform Jobsite Photo form at `POST /ingest/photo`.
- [ ] Migrate historical OneDrive files using `docs/DRIVE-STRUCTURE-AND-MIGRATION.md`.

## 4. Cloudflare Worker Bus

Worker: `https://ironwrap-bus.yellow-rain-7498.workers.dev`

- [x] D1 `ironwrap-bus` schema applied.
- [x] R2 `ironwrap-bus-raw` stores raw inbound bodies first.
- [x] Queues `ironwrap-jn-push` and `ironwrap-jn-dlq` configured.
- [x] Cron retry/reconcile configured.
- [x] Secrets set for current code path: `INGEST_TOKEN`, `ADMIN_TOKEN`, `JOBNIMBUS_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`.
- [ ] Switch/refresh Wrangler auth for the configured IronWrap account `7ee5775bc1ba46f05c5a65235b60e939`; current local login reads Mindburn Labs and cannot inventory this account.
- [ ] Set `QB_WEBHOOK_TOKEN` when QuickBooks webhook is connected.
- [ ] Confirm old Cloudflare API tokens are revoked.

## 5. Website / Make Lead Feed

- [ ] Identify current post destination of each lead form on both brand sites.
- [ ] Best path: agency/server adds the server-side forward in `docs/WEBSITE-INTEGRATION.md`.
- [ ] Backup path: Make UI appends one HTTP forwarder to `/ingest/website` after the working lead sync.
- [ ] Do not edit live Make scenarios via API.

Verify with D1:

```bash
wrangler d1 execute ironwrap-bus --remote --command "SELECT envelope_id, source, status, created_at FROM envelopes ORDER BY created_at DESC LIMIT 5"
```

## 6. Make

- [x] Existing GHL -> JobNimbus imports were fixed to use `Customer` / `New` and omit invalid `source_name`.
- [x] Bulk rescue completed: JobNimbus went from 6 to 103 contacts; duplicates skipped.
- [~] RoofRuler currently sends directly to the Make mailhook; do not add a second Google routing feed unless the scenario gets dedup.
- [ ] Export/record the current scenario map from the Make UI and tag each scenario keep/bridge/retire.
- [ ] Re-save any stale/unlinked live scenario in the Make UI if the UI still shows a warning.
- [ ] Retire unused one-time rescue scenarios after owner confirms no re-run is needed.

## 7. QuickBooks / Payments

- [x] QuickBooks Online account exists.
- [ ] Confirm/enable the tier needed for purchase orders/inventory.
- [ ] Enable QuickBooks Payments if card/EFT invoice payment is the chosen path.
- [ ] Connect signed QuickBooks webhook to `POST /webhook/quickbooks`.
- [ ] Follow-up build only when needed: QB OAuth read path for JobNimbus status mirroring.

Moneris is not the current invoice-payment path.

## 8. A2P / SMS / Phone

- [ ] Subscribe/configure JobNimbus Engage for 2-way SMS.
- [ ] Submit A2P 10DLC / Canadian carrier registration.
- [ ] Provision/own a portable voice DID if AssistAI/voice routing needs it.
- [ ] Do not configure Worker Twilio SMS secrets; the Worker does not send SMS.

## 9. Jotform / Field Forms

- [x] Worker payload contract exists for Jobsite Photo: JobNimbus job number + photo URLs.
- [ ] Build/confirm the live Jotform Jobsite Photo form sends that payload.
- [ ] Connect webhook to `POST /ingest/photo` with `Authorization: Bearer <INGEST_TOKEN>`.
- [ ] Build Safety Form and Completion forms in Jotform when the JobNimbus stage fields are configured.
- [ ] Confirm offline/mobile behavior on a real device before field rollout.

## 10. Compliance / Legal

- [ ] Lawyer review of `docs/COMPLIANCE-NOTICES.md`.
- [ ] Privacy notice published on both brand sites.
- [ ] CASL consent capture and unsubscribe tested.
- [ ] AI/call-recording notice approved before AssistAI.
- [ ] Vendor register, DPAs/ZDR, retention schedule, breach playbook, MFA/least-privilege complete.

## 11. Retire Later

Retire only after replacement proof exists:

- Microsoft 365 / OneDrive mirror and archive.
- GoHighLevel live lead routes.
- BookIPI, Stripe, MileIQ.
- One-time Make rescue scenarios.
