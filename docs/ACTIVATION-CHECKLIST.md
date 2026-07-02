# Activation Checklist — built → operating

Everything in `workers-bus/` is **built, deployed, unit-verified** (26 tests pass). **Nothing captures
live traffic yet** — each feature is gated on a credential or integration only you can provide. This is
the ordered punch-list to light each one up. Each item says **what to do → what lights up → how to verify.**

- Bus base URL: `https://ironwrap-bus.yellow-rain-7498.workers.dev`
- Set a secret (from `workers-bus/`): `printf '%s' '<value>' | CLOUDFLARE_API_TOKEN='<cf-token>' npx wrangler secret put <NAME>`
- Companion docs: `SETUP-CHECKLIST.md` (per-tool detail), `WEBSITE-INTEGRATION.md` (forms), `DELIVERY-PLAN.md` (phases).

> Legend: 🔴 hard blocker for go-live · 🟠 needed to operate a feature · ⚪ cleanup/optional.

---

## 0. ⚪ Make UI — re-save the lead pipeline (5 min) — DO FIRST
Today's API edits left scenario **5489498 "GHL → JobNimbus Import"** reporting a stale `invalid/unlinked`
state (it's still processing, but make it clean): open it in Make → click the **JobNimbus + GHL** modules
to confirm their connections → **Save** → confirm it's **ON**. Also delete the unused webhook **"Bus →
OneDrive Job Folder" (id 2520195)** I created. → *Restores a clean baseline; nothing of mine remains in it.*

## 1. 🟠 Email — lights up instant-ack + owner alerts + daily heartbeat
Pick ONE:
- **M365 (per spec):** Azure app registration → application permission **Mail.Send** for
  `quote@ironwrapexteriors.com` → admin consent → set `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET`.
- **Resend (simpler):** verify the brand domain in Resend → set `RESEND_API_KEY`.

**Verify:** `POST /admin/reconcile` (Bearer ADMIN_TOKEN) → the daily digest email arrives.
**Lights up:** prospect "we got your request" email, owner new-lead alert, daily reconcile heartbeat.

## 2. 🔴 Lead capture into the owned store — THE keystone
Today nothing feeds the bus. Choose the path:
- **(a) Website forms → bus** (cleanest): agency adds the server-side forward from `WEBSITE-INTEGRATION.md`;
  set host env `IRONWRAP_BUS_INGEST_TOKEN = <INGEST_TOKEN>`.
- **(b) Make UI forward** (no website change): in scenario 5489498, *after* the JobNimbus module, add one
  HTTP **"Make a request"** module → `POST .../ingest/website`, header `Authorization: Bearer <INGEST_TOKEN>`,
  Body type Raw / JSON = the GHL contact fields, and set its **error handler to "Ignore"**.
  ⚠️ Do this **in the Make UI**, not the API — I tried the API and it destabilized the scenario.

**Verify:** submit a real test lead → it appears in the bus within seconds (`wrangler d1 execute ironwrap-bus
--remote --command "SELECT * FROM envelopes ORDER BY created_at DESC LIMIT 3"`).
**Lights up:** the entire owned spine on live traffic — dedup, reconcile, instant-ack, brand tagging.

## 3. 🟠 OneDrive / Microsoft Graph — lights up photos + measurements + auto job folders
Same Azure app as step 1 **+ add `Files.ReadWrite.All`** (or `Sites.ReadWrite.All` for a SharePoint library)
+ consent. Set `wrangler.jsonc` vars **`ONEDRIVE_DRIVE_ID`** (target drive id) + **`ONEDRIVE_ROOT`**
(default `IronWrap Jobs`, must pre-exist) → `npx wrangler deploy`. Then point your **Jotform "Jobsite Photo"**
and **RoofRuler report** forms at `POST .../ingest/photo` and `.../ingest/measurement`
(`Authorization: Bearer <INGEST_TOKEN>`, include the **JobNimbus job number** field).

**Verify:** test photo → lands in the OneDrive job folder; bus returns `uploaded > 0`.
**Lights up:** Phase 3 field ops — photos, measurement reports, per-job folders, folder-on-job-mint.

## 4. 🔴 A2P 10DLC — the long pole (START NOW; 1–3 weeks) — lights up SMS
Submit brand (legal name, **CRA Business Number**, address) + campaign (customer care / lead follow-up) +
sample messages + opt-in/STOP language. Provision a **Twilio business DID**. Then set `TWILIO_ACCOUNT_SID`
/ `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` + `wrangler.jsonc` var `A2P_SMS_ENABLED="true"` → deploy.
**Lights up:** the prospect-SMS leg of the instant-ack (MCTB).

## 5. 🟠 Proposals (DocuSeal) — lights up `/proposal/create`
DocuSeal account + a proposal template → set `DOCUSEAL_API_KEY` + `wrangler.jsonc` var
`DOCUSEAL_TEMPLATE_ID` (+ `DOCUSEAL_BASE_URL` only if self-hosted) → deploy.
**Lights up:** send proposals for e-signature.

## 6. 🟠 QuickBooks — lights up `/webhook/quickbooks`
Set `QB_WEBHOOK_TOKEN` (Intuit verifier token); point the QuickBooks Online webhook at
`.../webhook/quickbooks`. (Full QB↔JobNimbus status sync also needs QB OAuth — a follow-up build.)
**Lights up:** invoice/payment events captured + audited.

## 7. 🔴 Security — required before any real go-live
- **Rotate the JobNimbus API key** (`mqalwrda6zbamv2x` was shared in chat) → issue a dedicated bus key →
  `wrangler secret put JOBNIMBUS_API_KEY`.
- **Rotate the Cloudflare API token** (also shared in chat).
- Optionally rotate `INGEST_TOKEN` / `ADMIN_TOKEN` (regenerate → re-set → update the forwarder).

## 8. 🟠 JobNimbus config (UI)
- Add **Lead Sources**: `website, gbp, ad, referral, manual, phone` (then source becomes reportable).
- Add custom fields: `brand` (ironwrap|iroof), `envelope_id` (optional).
- **Hard-delete** the archived `ZZZ … DELETE ME` test contacts (api1 has no delete).

## 9. 🔴 Compliance gate (hard launch blocker) — lawyer review
Get `docs/COMPLIANCE-NOTICES.md` reviewed/approved → publish privacy notice on both brand sites · web-form
consent · AI/recording notice · CASL unsubscribe tested · DNCL policy. **Nothing texts/calls before this + A2P.**

## 10. 🟠 Phone AI (AssistAI) — gated
Configure AssistAI → run the scored eval (`docs/ASSISTAI-EVAL.md`, **≥85%, 0 catastrophic**) before production.

---

## Everything above is a blocker on *your* accounts / decisions / lawyer — not on code.
**Already done (no action needed):** bus deployed (D1/R2/queues/cron/secrets) · all ingest/admin/proposal/
webhook endpoints built + verified · brand tagging · GHL→JobNimbus rescue (103 contacts) · 26 tests passing.

**Fastest path to first real value:** Step 0 → Step 1 (email) → Step 2 (lead capture). That alone makes a
real lead travel website → owned store → JobNimbus with an instant-ack — the spec's keystone, live.
