# IronWrap — Manual Setup Checklist

The human/UI configuration that happens **in the SaaS tools** (not in code). Companion to
[DELIVERY-PLAN.md](./DELIVERY-PLAN.md): the plan says *what gets built*; this says *what you click*.
Most of this is **not blocked by the Cloudflare account** and can be done now, in parallel.

Legend: ☐ to do · ✅ done/verified · ⏳ waiting on something.

## 1. JobNimbus configuration (UI → Settings) — do now
Grounded in the live API check (2026-06-28): the account **validates these values**, so the bus
and the Make imports only succeed with configured names.

- ✅ Contact record type **`Customer`** exists; job record type **`Retail`** exists.
- ✅ Contact status **`New`** exists.
- ☐ **Decide the lead record type:** the account currently **rejects `"Lead"`** (HTTP 400). Either
  (a) create a `Lead` contact record type in Settings, or (b) accept `Customer` (what the bus uses).
- ☐ **Configure Lead Sources** for: `website, gbp, ad, referral, manual, phone`. Until these exist,
  arbitrary `source_name` values 400, so the bus/imports carry source in **tags + description**
  instead. Add the sources if you want native, reportable Lead Source — then we map `source_name`.
- ☐ **Pipeline statuses** (per `final-spec-pack/02`): confirm/create the lead-funnel statuses you
  want (New → Contacted → Appointment Booked → Estimate Needed → Proposal Sent → Won → Lost). Any
  status the automations set must exist as a valid `status_name`.
- ☐ **Custom fields** (optional, for reporting): `brand` (ironwrap|iroof), `envelope_id`, UTM
  fields. The bus always tags records; custom fields make them filterable in JobNimbus.
- ☐ **Rotate the API key** (`mqalwrda6zbamv2x` was shared in chat) and issue a **dedicated key for
  the bus**; store it via `wrangler secret put JOBNIMBUS_API_KEY` (never in code).

## 2. A2P 10DLC + Canadian carrier registration (Twilio) — the long pole, start now
Gates Engage SMS (1–3 wks). Prepare this content so submission is one sitting:
- ☐ **Brand:** legal entity name, **CRA Business Number**, address, support email, website. (Both
  brands if you'll text under both: IronWrap Exteriors + iRoof Alberta.)
- ☐ **Campaign / use-case:** customer care + lead follow-up + appointment reminders (transactional).
- ☐ **Sample messages:** the MCTB ack, the appointment confirmation, the review request.
- ☐ **Opt-in description** (how consent is collected: web form, phone, in-person) + **STOP/HELP**
  opt-out language in every message.
- ⏳ Note: numbers provisioned **before 2025-03-26** can send CA→CA unregistered; low-volume
  standard registration is ~$4 one-time.

## 3. Twilio number — do now
- ☐ **Provision & own the business DID(s)** in Twilio (portable; AssistAI/Engage later re-point to it).

## 4. Email deliverability (Microsoft 365 / Gmail) — do now
- ☐ **SPF + DKIM + DMARC** on `ironwrapexteriors.com` (Microsoft 365, `quote@…`) and on
  `iroofalberta.ca` (Gmail/Google Workspace, `info@…`).
- ☐ Turn on **bounce monitoring**; confirm a seed/inbox-placement test passes.
- ☐ Leave JobNimbus native email **off** (unreliable). Dedicated ESP stays deferred.

## 5. Website forms — do now (discovery)
- ☐ Identify the **current post destination** of every lead form on both brand sites (home, quote,
  contact, service pages). These get repointed to the bus `POST /ingest/website` once it's deployed.
- ☐ Confirm hidden fields capture `source_url, page_type, service intent, brand, UTM`.

## 6. Google Business Profile — do now
- ☐ Audit both brands' GBP: categories, service areas, hours, phone, website, photos, review link.

## 7. Cloudflare — ✅ DEPLOYED (2026-06-30)
Worker **live**: `https://ironwrap-bus.yellow-rain-7498.workers.dev` (dedicated account
`Info@ironwrapexteriors.com's`, id `7ee5775b…`). D1 `ironwrap-bus` (schema applied) + R2
`ironwrap-bus-raw` + queues `ironwrap-jn-push`/`-dlq` + cron (5-min retry sweep, daily reconcile)
all bound. Secrets set (INGEST_TOKEN, ADMIN_TOKEN, JOBNIMBUS_API_KEY). **End-to-end verified:**
test lead → D1 (`status=pushed`) → queue → JobNimbus contact (`Customer`).
- ☐ **Wire the website forms** → `POST .../ingest/website` with header
  `Authorization: Bearer <INGEST_TOKEN>` (token shown once in chat — store it in your password manager).
- ⚙️ **Instant-ack email is code-complete, pending credentials.** `notify.ts` now sends via
  **Microsoft 365 Graph** (preferred, per spec) or **Resend** (fallback); prospect **SMS** via Twilio
  once A2P is on. All credential-gated — with no creds, email/SMS are skipped and lead capture is
  unaffected. To turn email on, set ONE:
  - **MS365:** Azure app registration with **Mail.Send** application permission for `FROM_EMAIL`'s
    mailbox → `wrangler secret put MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET`.
  - **Resend:** verify the brand domain → `wrangler secret put RESEND_API_KEY`.
- ✅ **Brand tagging live + verified:** website `brand` (`ironwrap`|`iroof`) flows to JobNimbus contact
  tags (`brand:iroof` confirmed) and the owner alert. SMS leg ready (`TWILIO_*` secrets) for post-A2P.
- ✅ **Admin/cron paths verified:** `/admin/reconcile` (daily heartbeat), `/admin/replay` (dead-letter
  drain), `/admin/source-count`, all `ADMIN_TOKEN`-guarded; email sends are best-effort (non-fatal).
- ☐ **Rotate the Cloudflare API token + the JobNimbus key** (both were pasted in chat).
- Note: D1 landed in **WEUR**; relocatable to WNAM pre-launch if write latency matters.

## 8. Make
- ✅ **Both** GHL→JobNimbus imports fixed (5490009 bulk + 5489498 live per-contact sync):
  `record_type_name`=`Customer`, `status_name`=`New`, invalid `source_name` removed.
- ✅ **Bulk GHL→JobNimbus rescue COMPLETE** (via API, 2026-06-28): added a `builtin:Ignore` error
  handler to the createContact module (so JobNimbus's duplicate-name rejections are skipped, not
  fatal) and re-ran — execution **status 1 (success), 402 ops**; **JobNimbus went 6 → 103 contacts
  (~97 GHL contacts imported), duplicates skipped.** (The Workers bus handles the same dup case in
  code: dedup by tag/email/phone + find-by-name fallback.)
- ☐ Optional: disable/retire scenario 5490009 now the one-time rescue is done (avoids accidental
  re-runs; re-running is harmless — all would now be skipped as dups — just wastes operations).
- ☐ Hard-delete the archived test contacts ("ZZZ TEST/DEDUP … DELETE ME") in the JobNimbus UI.

## 9. OneDrive document spine + Jotform photos (Phase 3) — ⚙️ code live, pending connect
The bus now exposes `POST /ingest/photo` (Jotform jobsite photos → OneDrive folder **keyed by the
JobNimbus job number**). Verified live; credential-gated (stores raw + audits now, files once Graph
is connected).
- ☐ **Azure app registration** (can be the **same app as email**): add application permission
  **Files.ReadWrite.All** (or **Sites.ReadWrite.All** for a SharePoint library) + admin consent →
  `wrangler secret put MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET`.
- ☐ **Pick the target drive/library** → set `wrangler.jsonc` var `ONEDRIVE_DRIVE_ID` (+ `ONEDRIVE_ROOT`,
  default `IronWrap Jobs`; the root folder must pre-exist) → redeploy.
- ☐ **Jotform "Jobsite Photo" form** → webhook/POST to `.../ingest/photo` with header
  `Authorization: Bearer <INGEST_TOKEN>`; include the **JobNimbus job number** field + the photo
  upload field. Photo URLs must be Worker-fetchable (public Jotform CDN or a normalized payload);
  unreachable URLs are skipped + logged, raw is always retained for re-processing.
- ✅ **Also shipped + verified (credential-gated):**
  - `POST /ingest/measurement` — RoofRuler/AppliCad report → OneDrive job folder + captures structured
    measurements (squares, pitch, ridge/valley ft…). Uses the **same Graph creds** as photos.
  - **OneDrive folder auto-creates** when the bus mints a JobNimbus job (no photo needed first).
  - `POST /proposal/create` (ADMIN_TOKEN) — proposal e-sign via **DocuSeal**. Connect:
    `wrangler secret put DOCUSEAL_API_KEY` + set `DOCUSEAL_TEMPLATE_ID` (wrangler.jsonc var;
    `DOCUSEAL_BASE_URL` only for a self-hosted instance).
  - `POST /webhook/quickbooks` — Intuit-signature-verified receiver for invoice/payment events.
    Connect: `wrangler secret put QB_WEBHOOK_TOKEN` (Intuit verifier token) + point the QB webhook here.
- ☐ **Phase 3 follow-ups (not built):** the OCR ladder (deterministic → toMarkdown → Mistral) for
  hard measurement docs; QuickBooks→JobNimbus status sync (needs QB OAuth to read entity detail);
  JobNimbus measurement custom-field write.

## Decisions already locked
- ✅ Maintainer: Ilia via Claude Code. ✅ Two brands. ✅ GHL: experimental, being retired. ✅ Make: Core plan.
- **Superseded 2026-07-01 (owner-directed, see `final-spec-pack/00`):** ✅ Storage: **Google Drive**
  (was OneDrive/Microsoft 365) — migration pending a new Google Workspace on the unassigned
  `[]@ironwrapexteriors.com` mailbox. ✅ Email: **Google Workspace, both brands** (was M365/Gmail
  split) — `quote@` and `info@ironwrapexteriors.com` migrate onto the new Workspace. ✅ SMS:
  **JobNimbus Engage** (reconfirmed — this was always the plan, not a change; Twilio stays
  DID-only). ✅ Accounting: **QuickBooks** (catalog + invoices + POs + mileage) + **Moneris**
  (payments); BookIPI/Stripe/MileIQ retire. Sections 4 and 9 below still describe the interim
  Microsoft-based setup — treat them as superseded once the Google Workspace exists.
