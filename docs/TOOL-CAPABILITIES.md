# Tool & Service Capabilities — reference snapshot

This is a dated capability/account reference, not the current operating source of truth. Revalidate
vendor behavior, pricing, access, and live configurations before action. The binding launch contract is
[`LAUNCH-RUNBOOK.md`](./LAUNCH-RUNBOOK.md); the Phase 1 source of truth is
[`../final-spec-pack/18-phase-1-source-truth-and-build-contract.md`](../final-spec-pack/18-phase-1-source-truth-and-build-contract.md).
Markers: ✅ verified · ⚠️ gotcha/limit · ❓ confirm-with-vendor · 💲 cost.

---

## Make ↔ Cloudflare bus — the interop contract (READ FIRST)
Both directions are proven live this session. Make and the bus talk over **plain HTTPS**; Make does
NOT need a native Cloudflare app — the bus's HTTP endpoints ARE the integration surface.

- **Make → bus** (Make hands an event to the owned spine): Make **HTTP "Make a request"** module →
  `POST https://ironwrap-bus.yellow-rain-7498.workers.dev/ingest/website` (or `/ingest/photo`,
  `/ingest/measurement`) with header `Authorization: Bearer <INGEST_TOKEN>`, `content-type:
  application/json`, body = the fields. The bus stores raw → owned store → dedups → pushes to
  JobNimbus. ✅ This is how anything Ilia builds in Make lands in the owned store.
- **Bus → Make** (bus triggers a Make flow to use a connector Make is better at): bus `fetch()` →
  a Make **Custom Webhook** URL (`https://hook.us2.make.com/<udid>`). Ilia builds the scenario
  starting with a "Custom webhook" trigger. ✅ Proven (a webhook was created this session).
- **Coherence rule (the one that matters):** ONE owner per flow. If a flow starts in Make, it ends
  by calling the bus so the owned store has it; if it starts at the bus, it may call out to Make for
  one connector step then continue. **Never split the same flow's core logic across both** — that
  split is what caused this session's incident.
- ⚠️ **Edit Make scenarios in the Make UI, not through the API.** API blueprint edits unlinked
  connections and broke the live scenario this session. Claude Code can *build/read* via API but
  should hand Ilia UI steps for live-scenario changes.
- **Auth + reliability:** store `INGEST_TOKEN`/`ADMIN_TOKEN` as a Make keychain/connection, not
  hardcoded per module. Give the Make→bus HTTP module an error handler so a transient blip doesn't
  fail Ilia's scenario; the bus treats any bus→Make call as best-effort (Make Core has a 10k-ops/mo
  ceiling — don't let a Make failure block the bus's critical path).

---

## JobNimbus (temporary CRM bridge)
- ✅ **Record types (account-validated, live-checked):** contact `Customer`, job `Retail`. `"Lead"`
  is **rejected (HTTP 400)**. Contact status `New` exists.
- ✅ **Automation engine:** event-based (Settings → Automations). Can **send Engage SMS + email
  automatically on status/pipeline-stage change** (trigger = "Modified", "only if Status modified",
  target primary/related contacts). This is how the 5 stage scenarios run natively.
- ⚠️ **Tiers (third-party estimates — confirm on the real invoice):** *Growing* ~USD $225/mo,
  *Established* ~USD $550/mo, + ~$25-75/user/mo. Third-party pages claim Growing has no API and
  Established adds it — **BUT IronWrap's current plan ALREADY has working API access** (proven live
  2026-06: the bus + Make create/query/archive contacts and jobs with the account key). So do NOT
  assume the bus forces a tier upgrade for API; API is already on. The real thing to verify on the
  plan is the **automation/integration cap** (~10 automations / 5 integrations on lower tiers) —
  5-8 stage scenarios + Make + QuickBooks could hit that ceiling. 💲
- ✅ **Native e-signature / proposals:** estimates/documents support requested e-sign (email to
  signer, type name, mobile finger/stylus, multi-signer tracking, "legally binding"). **Bridge
  only: it dies with the JobNimbus retirement. DocuSeal is retired regardless (AGPL); the keeper
  path is a commercial e-sign API or owned signing.**
- ✅ **Native QuickBooks Online integration** (see QuickBooks). Contacts one-way (JN master);
  products/services + invoices sync; price/cost direction is **configurable via sync-priority**.
- ⚠️ **API (api1, live-verified):** `Bearer` auth, `{count,results}`, id `jnid`, `filter` param
  (~1s lag). **No hard DELETE** — archive via `PUT {is_archived:true}`. `source_name` must be an
  account-configured Lead Source or it 400s (carry source in tags/description otherwise). **Omit
  `source_name`** unless the source exists. Dedup blocks duplicate `display_name` (create 400s on
  dup — find-by-name + reuse). 429s enforced (exponential backoff); no public rate-limit number. ❓
- ⚠️ **Webhooks for stage change:** job created/updated/deleted events exist but a clean
  "on-stage-change" webhook isn't clearly advertised — **treat polling as the safe path**, or drive
  stage automations natively inside JobNimbus.

## JobNimbus Engage (2-way SMS)
- ✅ Two-way **SMS** (texting only — not email/voice), tied to contacts/jobs. Available in **Canada**
  (select Canada + enter CBN at registration).
- ⚠️ **You register A2P/10DLC yourself.** JobNimbus gives a submission flow but does NOT register on
  your behalf. Engage rides the same carriers as Twilio → **same mandatory registration** (see A2P).
- ⚠️ Texts only send **8am-9pm local**; recipients must have **opted in**.
- 💲 ~USD $49 Basic / $149 / $249 per month + ~$20 setup, on top of CRM + seats.

## JobNimbus AssistAI (AI phone receptionist)
- ✅ Shipping product. Answers 24/7, basic Q&A, captures leads, **books into JN calendar**. 💲 **$0.15/
  voice-min**, 14-day trial. Pure-metered → set an owner minute cap / budget alert.
- ❓ **Canadian-number support not confirmed on the page — verify with sales before relying on it.**
- Design: behind a written scored eval gate; voicemail→JN-lead is the always-on floor.

## QuickBooks Online (Canada — accounting + invoicing + catalog)
- ✅ **QBO Payments EXISTS natively in Canada.** Pay-enabled invoice ("Pay now"): card, Apple Pay,
  bank/EFT; auto-records payment + fees. 💲 card **2.9% + $0.25**, EFT **1%** (EFT cap $100k). ⚠️
  Visa/MC **debit** sometimes fails address check. **No third-party gateway needed for card-on-invoice.**
- ✅ **Products & Services** = the catalog; required for invoices/estimates. Syncs with JobNimbus,
  **linked by name**, cost/price updates per whichever system has **sync priority** — so QBO-as-price-
  master is workable. ⚠️ name-match fragility; JN products push to QB typed as "Service".
- ✅ **Built-in GPS mileage tracker** in the mobile app (CRA per-km) — **replaces MileIQ.**
- ⚠️ **Purchase Orders + inventory require the Plus tier** (~CAD $60+/mo, ≤5 users). Estimates are in
  all tiers. A roofer needing POs/inventory → **Plus.** 💲
- ✅ Retires **BookIPI** (invoices/quotes/receipts/Tap-to-Pay) and **Stripe** once live.

## Moneris (card processor — Canada)
- ❌ **Not the current invoice-payment path.** Owner decision moved invoice payments to
  **QuickBooks Payments**. Keep Moneris only as a future/in-person terminal option if the business
  deliberately approves it.
- ⚠️ The native Moneris↔QBO connector is reconciliation/data-sync only; it does not put a Moneris
  pay button on QBO invoices.

## Google Workspace (email + storage — replaces Microsoft 365)
- ✅ **Server email send, 3 paths:** **SMTP relay** (`smtp-relay.gmail.com`, ~10,000/day,
  IP/domain-authed — best for automation); **Gmail API + service account + domain-wide delegation**
  (impersonate the mailbox); **SMTP + app password** (simplest, needs the mailbox + 2FA).
- ⚠️ **Limits:** standard mailbox ~**2,000 msgs/day, 2,000 external recipients/day** (Gmail API draws
  the same quota). Fine at our volume; it's a hard ceiling.
- ⚠️ New domain needs **SPF + DKIM (off by default — enable in Admin, 2048-bit) + DMARC (start
  `p=none`).** Sending "from `quote@`" while impersonating another user needs a **verified `sendAs`
  alias** (same-domain aliases you control are fine).
- ✅ **Google Drive = Shared Drive** (org-owned, nothing stranded when a user leaves). Make has robust
  native Drive modules (create folder, upload, move, search). ⚠️ Make's **Move can't pull a My-Drive
  file INTO a Shared Drive** — write straight into the Shared Drive. Drive API quotas are a non-issue
  at our volume.

## Cloudflare (the bus)
- ✅ **Workers + D1 + R2 + Queues + Cron** = the owned spine (deployed, current test suite passes, live). Queues =
  native retry + dead-letter; Cron = reconcile/heartbeat; single owned-store write (no dual-write).
  💲 ~CAD $7/mo at this volume.
- ✅ **`env.AI.toMarkdown()`** (Workers AI binding + REST): converts PDF/Office/ODF/CSV/HTML/images to
  Markdown; **text PDFs extract structurally with no OCR + no model cost**; only *image* conversion
  is billable Workers AI. ⚠️ ~**4 MB** file limit. **Needed only as an edge-case fallback** now that
  measurement providers export structured data (see RoofRuler).

## Make (integration layer — minimized, but the connector/observability home)
- ✅ **HTTP "Make a request"** module → calls the bus (Make→bus). **Custom Webhook** trigger → bus
  calls Make (bus→Make). Native connectors for **JobNimbus, QuickBooks, Google Drive, Jotform, GHL**.
- 💲 On **Core** (~USD $9/mo, credit model, **10,000 ops/mo** ceiling) — enough at our volume; watch
  the ceiling as scenarios grow.
- ⚠️ **Edit in the UI, not via API** (see interop contract). Live scenarios: `builtin:Ignore` handler
  is only valid at the END of a flow, not mid-flow.

## Jotform (field forms)
- ✅ Offline mobile app (Offline/Kiosk mode); webhooks to POST submissions; multi-photo upload.
- ⚠️ **Geolocation/GPS widget needs internet (Google Maps API) — does NOT work truly offline.** On a
  roof with no signal, coordinates can be missing. Capture address as a backup; don't gate on GPS.
- ⚠️ **No native "minimum N files" rule** (e.g., require 6 photos). Workaround: N separate required
  upload fields, or a custom widget/JS.
- ✅ **Conditional emails** (the "client copy without contractor photos" requirement): attach photos
  to the contractor **Notification** email; send the client a photo-less **Autoresponder** (file
  attachments work on Notifications, not Autoresponders — use that to your advantage).
- 💲 ~USD $39/mo paid tier for offline app / volume.

## DocuSeal (e-sign, RETIRED)
- ⛔ **Retired permanently (2026-07-09), not even a fallback:** open-source **AGPLv3** plus
  additional terms conflict with the 100% IP-ownership posture. Never adopt. E-sign stays valid
  in Canada (PIPEDA + Alberta ETA, ordinary commercial docs); the replacement is a **commercial
  e-sign API** (a proprietary service, e.g. Dropbox Sign or the DocuSign API) or **owned signing**
  on the Proposal Evidence Pack. JobNimbus native e-sign bridges only until JobNimbus retires.

## RoofRuler / AppliCad (measurements)
- ✅ **RoofRuler** = order-a-measurement service. **Exports structured XML + ESX (Xactimate-native) +
  CSV/DXF, not only PDF** (owner-confirmed + industry-standard). → **Parse the XML/ESX directly, no
  OCR.** ESX feeds Xactimate for the hail/insurance motion. ❓ **Confirm whether the XML/ESX export is
  auto-delivered (email/API/webhook) or a manual download** — that decides how automated intake is.
- ✅ **AppliCad Roof Wizard** = desktop estimating; imports/exports machine-readable **XML/RXF/DXF**;
  reports write to Word/Excel. No OCR needed.
- ➜ **Consequence:** switch the existing Make RoofRuler scenario OFF AI-Extract → deterministic
  XML parse. OCR (`toMarkdown`/Mistral) drops to rare-scanned-document fallback only.

## WCB Alberta (compliance — Job Started scenario)
- ⚠️ **No API.** Roofing is **compulsory** — WCB account required within **15 days of first worker**;
  owners/directors need optional **personal coverage** (2026 min $34,200).
- ✅ **Clearance letter** = the standard way to verify a subcontractor's coverage **before** they
  work — **manual** portal/mobile lookup (email/fax/print delivery). **ACN (Automatic Clearance
  Notifications)** = daily **email** alerts of status changes for a saved sub list (no API).
- ➜ Scenario 4 "auto WCB" = **manual clearance letter per sub + subscribe to ACN**, routed to office
  admin. No in-app integration. ("Notice of project" is an **OHS** concept, not WCB.)

## A2P 10DLC + CASL (Canada SMS)
- ⚠️ **Mandatory, carrier-level, provider-independent** (Twilio OR Engage). Numbers bought after
  **2025-03-26** must register before texting Canadian recipients. 💲 ~**$44 brand** (+$4 low-vol),
  **$15 campaign vetting**, ~$1.50-10/campaign/mo. Brand approves in minutes; **campaigns ~10-15
  days** → the real long pole. **Start now.**
- ✅ **CASL:** transactional texts are consent-*exempt* but still need **sender identification incl. a
  valid mailing address** (name alone insufficient — stricter than US) + **STOP/unsubscribe honored
  60 days**. Marketing content inside a transactional text voids the exemption.

---

## Open "confirm-with-vendor" items (the only things left to verify)
1. ❓ JobNimbus AssistAI — Canadian phone-number support.
2. ❓ RoofRuler — is XML/ESX export auto-delivered (email/API/webhook) or manual download?
3. ❓ JobNimbus Engage — can automations trigger it on stage change at our tier (confirmed possible in general; verify on the account's plan).
