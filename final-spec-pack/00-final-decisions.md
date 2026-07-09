# 00 - Final Decisions

## Decision Summary

IronWrap should build a low-volume internal operating spine first. Current lead
volume does not justify buying or building the full future stack.

The first deliverable must solve daily operational control:

- Capture every lead in one place.
- Prevent duplicate jobs and folders.
- Make the next action visible.
- Keep documents and proposals attached to the right job.
- Keep payment and review follow-up from being missed.
- Use AI where it saves missed opportunities, not where it creates operational risk.

## Final Stack Decision

| Area | Final Decision | Reason |
|---|---|---|
| Lead front door | Worker bus first; JobNimbus/GHL only as temporary bridges | Every inbound path normalizes into the owned store first. JobNimbus and GHL can continue only where they still keep operations running; do not expand either as keeper infrastructure. |
| System of record | Owned Cloudflare D1 + R2 (thin, write FIRST) | Every lead/event/estimate writes to the owned layer first, then to bridge systems only when still needed. JobNimbus/GHL are consumers of IronWrap's data, not owners. Canonical lead envelope = {source, contact, job_ref, payload, ts}. |
| Integration spine | Cloudflare Worker bus first; Make as bridge/observability | Mandatory dead-letter, idempotency/dedup keyed on phone/email where appropriate, daily reconciliation (source-event counts vs records landed), raw submission stored first, named owner. Keep Make Core only for useful connectors/visibility until owned replacements are proven. |
| Job/customer truth | IronWrap OS / ERPNext target; JobNimbus bridge | JobNimbus can bridge current CRM/job operations while owned ERPNext/Hermes slices mature. New estimator, evidence, takeoff, proposal, approval, and job-state work should land in the owned path first. |
| Accounting truth | QuickBooks: master catalog (products/services/pricing) + all real financial documents (invoices, purchase orders to suppliers, mileage via QuickBooks' built-in tracker) | Refines "accounting should not be recreated elsewhere" with the owner's concrete tool list (2026-07-01). Retires BookIPI (quotes/invoices/receipts/card payments), Stripe, and MileIQ once QuickBooks is live. **Payments: QuickBooks Payments only (owner decision 2026-07-02; Moneris DROPPED).** QBO Payments is native in Canada: card/Apple Pay/EFT on the invoice (card 2.9% + $0.25, EFT 1%) - no separate processor, no gateway connector. Progress payments use QBO's native progress invoicing off the estimate. The product/service catalog exported from BookIPI is the import seed; JobNimbus pulls live pricing from this catalog one-way (QuickBooks -> JobNimbus) rather than storing its own prices, so pricing never drifts between the two systems |
| Estimator / configurator | Owned route first: `POST /ingest/estimate` | The 3D estimator/configurator is part of IronWrap OS, not a JobNimbus/GHL/Roofr dependency. It stores raw estimator payloads in R2, creates a D1 envelope, and syncs ERPNext Instant Estimate Session rows when enabled. Totals/ranges remain non-binding until human review. |
| Automation | Make first (on Core, already subscribed) | Already has scenarios and app connectors; clean it before replacing it. Make's role may collapse into a Cloudflare Workers bus (hybrid) — see Integration spine row; the discipline (envelope, dedup, dead-letter, reconcile) is unchanged, only where the infra runs |
| Storage | Google Drive (Google Workspace), on a NEW Workspace built on the previously-unassigned `[]@ironwrapexteriors.com` mailbox | **Supersedes OneDrive/Microsoft 365 (2026-07-01, owner-directed).** Consolidates both brands onto one platform ahead of dropping the Microsoft 365 subscription. Storage stays archive-only (not job/payment truth); folder-per-job keyed by the JobNimbus job number is unchanged, only the platform moves. Use a Shared Drive, not a personal My Drive, so files are not stranded if an account is removed. Historical job files migrate from OneDrive during the GHL/Microsoft cutover (manual + scripted, some mapping will need hand-fixing) |
| Instant response / MCTB | Missed-call-text-back + instant web-form reply (headline deliverable) | Every unanswered call -> SMS within ~10s once Engage/A2P is live; every web form -> instant prospect email + owner alert on a pipe separate from nurture; target <60s human-or-AI touch, 24/7. Interim pre-A2P ack path: JobNimbus Engage SMS cannot send until the fresh A2P 10DLC + Canadian carrier registration is approved; until then instant-ack/MCTB runs on an interim channel — an email acknowledgement to the prospect (via the brand Google Workspace mailbox) + an owner phone/SMS alert from the owner's own line. The prospect-SMS leg switches on at A2P approval. |
| Phone AI | JobNimbus AssistAI (P0) | Native 24/7 receptionist; books natively into the JobNimbus calendar and creates the lead record in-CRM (Make is used for route-flagging + the owned-store dual-write, not necessarily the booking call). ~$0.15/voice-min, pure-metered; enforce a hard monthly minute cap / budget alert (verify AssistAI's native cap support — if there is no native cap, enforce via usage monitoring + an overage alert), cap = owner-set, e.g. ~500 min/mo, to keep the spam/robocall buffer; behind a written scored eval-call gate. Floor fallback = voicemail -> JobNimbus lead + human callback |
| Voice fallback | Ladder: AssistAI -> managed Retell -> managed-OSS (LiveKit Cloud / Pipecat Cloud) as "tier 2.5" if both fail the eval | One config (bundled telephony/LLM/voice). Managed-OSS hosting removes the "media server to babysit" problem so it's no longer an on-call disqualifier, but you still own the agent code/prompt/booking-glue, so it sits below the two fully-managed options. The hand-wired Retell+Twilio+Gemini+ElevenLabs 4-vendor DIY stack stays killed; Vapi excluded (needs on-call engineer); Google Voice excluded (no real-time media API — do not conflate with Google's Gemini Live API, a legitimate real-time voice backend). Voicemail -> JN-lead is the always-on floor. Own the phone DID in Twilio so swaps are config-only |
| SMS (nurture + Engage) | JobNimbus Engage (2-way SMS), gated on A2P 10DLC approval | **Reconfirmed, not a change** — this row always named Engage, never Twilio, for SMS. Twilio's sole role is owning the portable business DID for voice (see Voice fallback row); it does not send SMS, and any Twilio SMS-send code built for the instant-ack path is out of scope and should be treated as unused. Before locking the messaging build, confirm with JobNimbus: Engage's Canadian carrier/A2P registration coverage, whether sends can trigger from pipeline-stage automations (not manual-template-only), and per-message cost |
| Email | Google Workspace, BOTH brands (supersedes the Microsoft 365 / Gmail split) | **Owner-directed 2026-07-01; live as of 2026-07-03.** IronWrap uses Google Workspace user `sales@ironwrapexteriors.com` with `info@`/`quote@` aliases; those aliases mirror to Microsoft 365 until migration closes. `info@iroofalberta.ca` is already on Google. Transactional/instant-ack/notification email sends via Gmail API/domain-wide delegation. JN native email stays off; a dedicated ESP stays deferred |
| Call/source attribution | Deferred (UTM + manual Lead Source + one tracked number) | Add CallRail only when paid ads start |
| Google Business Profile | Audit and tighten in Task 1 | Free/low-cost source of qualified local intent and review trust |
| OCR | Ladder: (1) deterministic AppliCad XML / text-PDF parse, (2) Cloudflare `toMarkdown()`, (3) Claude/LLM read, (4) Mistral OCR 4 only for hard cases | Avoid paying for OCR when files are already machine-readable. Cloudflare `toMarkdown()` (Workers AI binding — free, on-stack) converts text PDFs/DOCX/etc. to clean Markdown and replaces standalone Tesseract for text PDFs; Claude/LLM read only when structured field extraction/reasoning is needed; Mistral OCR 4 (~$2-4 per 1,000 pages → cents/mo here) ONLY for image-heavy/scanned/handwritten/layout-sensitive docs. Do NOT self-host an OCR engine (Surya/PaddleOCR need a GPU box; Workers can't run them) |
| Field forms and signatures | Jotform "Jobsite Photo" form (sole jobsite-photo/geo tool, $0 incremental) for jobsite photos/geo + Jotform structured forms | NaturalForms is dropped (stagnant). The Jotform "Jobsite Photo" form is the SOLE jobsite-photo/geo tool (JN job picker, Geolocation widget capturing device GPS lat/long at submit — coordinates-only, works offline in the Jotform Mobile App; NOT GeoStamp/GPS Location widgets — multi-photo upload, auto timestamp; offline-queued -> webhook -> Make -> Google Drive + JN + owned-store dual-write). iOS strips photo GPS by default, and direct camera-capture uploads lose metadata regardless — so capture device GPS at submit; don't depend on EXIF. If crew capture friction shows up, the fix is to improve the Jotform flow (kiosk mode, simpler/auto job-picker) — not a new photo vendor. Adobe interactive PDFs are not a structured-capture tool. **The structured-forms buy gate below is now CLEARED (2026-07-01):** the owner has defined a concrete daily-pain workflow — a mandatory Safety Form gate at job start, and dual Completion forms (client + contractor) with a photo-count/warranty rule — so these build on Jotform now; see `04-core-workflows-and-sops.md` Workflow 5C and Workflow 6 |
| Design tooling | Free Canva + free Affinity | Affinity (Designer/Photo/Publisher) went 100% free (Oct 2025, Canva-owned); free Canva + free Affinity covers a roofer's marketing/proposal graphics. Canva Pro (~CAD $18/mo) only if brand-kit/background-remover/team features are needed. Full Adobe Creative Cloud (~CAD $92/mo) rejected |
| Proposals | JobNimbus native e-sign / HTML+PDF flow bridges only; keeper path is a commercial e-sign API or owned signing (DocuSeal retired 2026-07-09) | Avoid heavy proposal software until sales process proves need. DocuSeal is retired permanently: AGPLv3 plus additional terms conflict with the 100% IP-ownership posture, so it is not even a fallback. JobNimbus native e-sign dies with the JobNimbus retirement; the keeper path is a commercial e-sign API (a proprietary service, e.g. Dropbox Sign or the DocuSign API) or owned signing on the Proposal Evidence Pack. E-signatures remain legally valid in Canada for ordinary commercial docs (audit-trail PDF; PIPEDA / Alberta ETA). The old "retire PandaDoc/DocuSign" framing applied to the suites; the DocuSign API as a commercial e-sign service is an acceptable candidate |
| Dashboard | JobNimbus reports plus exceptions + reconciliation view | Custom dashboard only if reports fail the owner workflow |
| Shop/ERP | Manual material request first | Paradigm only after material request format is stable |
| Visualization | Manual photos/products first | Renoworks only if visualizer-led selling becomes an approved sales motion |
| Security hardening | Last phase after test | User requested security/access hardening after build/config/test |

## Buy Gates

| Item | Hold If | Approve When |
|---|---|---|
| AssistAI minute usage | Volume stays under the owner-set monthly minute cap (e.g. ~500 min/mo; enforce natively if supported, else via usage monitoring + overage alert) | Cap is being hit and per-minute spend is justified by booked-job value; review weekly recordings before raising cap. AssistAI minutes are a Phase-2 (post-eval) cost, not part of the first-deliverable incremental |
| Managed Retell (escalation voice) | AssistAI passes the written scored eval gate (>=85% capture+routing, zero catastrophic failures) | AssistAI fails the eval gate on booking, transcript, transfer, or call quality |
| A2P 10DLC registration / dedicated ESP | A2P 10DLC is a prerequisite, not optional; a dedicated ESP is DEFERRED | A2P: always — register A2P 10DLC + Canadian carrier before SMS goes live. ESP: outbound email runs on Google Workspace brand mailboxes (SPF/DKIM/DMARC); add a dedicated transactional ESP (e.g., Resend) only when high-volume nurture/review-request bulk needs bulk-grade deliverability |
| CallRail or other call attribution tool | No paid ads running; UTM + manual Lead Source + one tracked number suffice | Paid ads start and per-call source must be proven for paid traffic |
| Google Local Services Ads / paid local ads | Source tracking, response-time SLA, dedupe, and owner exceptions are not tested | The intake system can absorb more qualified leads without chaos |
| Renoworks | Visualizer is not a deliberate sales motion | Website/proposal visualizer demos help close real deals |
| RoofRuler volume | Qualified job volume is low | Per-report usage is predictable enough to forecast or negotiate |
| Jotform (structured field forms beyond photos) | **GATE CLEARED 2026-07-01** | Owner defined a concrete daily-pain workflow: Safety Form (job-start gate) and Completion forms (client + contractor, min. 6 photos, warranty issuance) are now in the build backlog — see `04-core-workflows-and-sops.md` Workflow 5C / Workflow 6 |
| Paradigm | Manual material request is not stable | Shop/material errors or volume justify ERP setup cost |
| Custom dashboard | Reports plus exceptions + reconciliation view are enough | Owner still cannot see daily blockers without manual chasing |

## Pipeline Stages (Sales + Production), Proposed 2026-07-01

Owner asked to finalize the JobNimbus pipeline/job-status shape. Proposed stage list, matching
the five locked business-process scenarios below one-to-one so each scenario is a stage
transition, not a side process. The owner configures these as JobNimbus job statuses (create
what's missing next to the live `Lead` / `Appointment Scheduled` / `Jobs In Progress` statuses).

Sales side: New Lead -> Contacted -> Appointment Booked -> Estimate/Proposal Sent -> Contract
Signed. Production side (same job record continues): Deposit Paid -> Materials Ordered ->
Materials Ready -> Job Scheduled -> Job Started (In Progress) -> Job Completed -> Invoiced ->
Paid/Closed Won. Lost/Cancelled is a valid off-ramp from any pre-signed stage.

## Business Process Scenarios, Locked 2026-07-01

Owner defined six stage-transition automations (five on 2026-07-01; progress check-in/payment
added 2026-07-02). Full SOP detail (mermaid flow, steps, acceptance criteria) lives in
`04-core-workflows-and-sops.md`; this is the locked scope summary and build order (each depends
on the previous stage existing):

1. **Proposal Sent** — reminder cadence until accepted/declined; PDF dual-archived (JobNimbus +
   Google Drive backup), not JobNimbus-only. Enriches Workflow 3.
2. **Contract Signed** — pipeline moves; customer gets a "thanks and welcome" message with the
   approximate start date; QuickBooks deposit invoice issued + reminders. New Workflow 3C.
3. **Deposit Paid** — pipeline moves; materials calculated -> material request form -> supplier
   purchase order (QuickBooks) -> subcontractor assigned -> work order issued; job holds until
   the shop fires the "Materials Ready" trigger. Enriches Workflow 5.
4. **Job Started** — "Let's GO!" message with an active-construction-site reminder; a mandatory
   Safety Form gate (job flagged INACTIVE until filed). New Workflow 5C. **Enforcement mechanism
   (owner asked "how"):** a JobNimbus custom field `safety_form_status` (Incomplete/Complete)
   defaults to Incomplete on entering this stage; every downstream automation for this stage
   checks the field and holds while Incomplete; the Jotform Safety Form submission flips it to
   Complete and releases the hold. **WCB: ALREADY OPERATIONAL (owner confirmed 2026-07-02)** -
   the WCB account is active and Automatic Clearance Notifications are configured: an automatic
   email arrives if a subcontractor's WCB is cancelled, checked daily. No WCB build needed;
   optionally auto-create a JN task at Job Scheduled to confirm the clearance letter is on file.
4b. **Progress check-in & progress payment** (owner-added 2026-07-02) — for multi-stage jobs:
   scheduled progress check-ins (crew photo/status form -> client progress update) and milestone
   **progress invoices via QuickBooks native progress invoicing** off the estimate, with
   reminders; an overdue progress payment holds further scheduling. New Workflow 5D.
5. **Completion** — client Completion Form triggers the contractor Completion Form (signature +
   "labor warranty" checkbox + minimum 6 photos required to submit); a valid submission issues
   the labor warranty and archives the package; the client copy excludes the contractor's
   jobsite photos; the contractor gets a confirmation copy back. Enriches Workflow 6.

These will keep being refined as real jobs run through them (owner's own expectation) — treat
this list as the v1 lock, not a frozen spec.

## Deliberate Non-Goals For Task 1

- Do not clone a generic CRM. Build only the owned IronWrap OS slices that replace specific
  JobNimbus/GHL duties with proof.
- Do not build replacement accounting.
- Do not build the external metal-layout SaaS.
- Do not automate final pricing decisions without human review.
- Do not sync finance data broadly into AI logs, transcripts, or public folders.
- Do not start paid local lead campaigns before attribution, speed-to-lead, dedupe, and owner exception checks pass.
- Do not make ERPNext a broad production ERP all at once; land estimator/evidence/takeoff/proposal
  slices first, then add production depth when the manual materials workflow proves the shape.
- Do not use free/cheap AI providers with customer personal information unless privacy terms, vendor register, and customer notice are approved.
- Do not make GHL the keeper. Treat it as legacy scaffolding and retire routes after replacement proof.
- Do not build or run a standing custom voice stack (no hand-wired Retell+Twilio+Gemini+ElevenLabs); AssistAI only, with managed Retell as the single fallback if the eval gate fails.
- Do not buy full Adobe Creative Cloud; free Canva + free Affinity cover design needs (Canva Pro only if brand-kit/team features are needed).

## First Deliverable Outcome

The first deliverable must answer:

1. What leads came in?
2. Who owns each lead?
3. Which jobs are stuck?
4. Which proposals are waiting?
5. Which deposits/invoices are late?
6. Which materials are not ready?
7. Which automations failed?
8. Which customer needs a human response?

These answers must be available without manually reconciling multiple systems.

## Business Context Carried Into Task 1

The final internal OS must support IronWrap's business mix, not only a generic
residential roofing flow.

Brands:

- The system serves two brands: IronWrap Exteriors (ironwrapexteriors.com) and
  iRoof Alberta (iroofalberta.ca). Intake, sender mailbox, Google Business Profile,
  and review link are brand-aware — brand is captured at intake and selects the
  sender mailbox (IronWrap Google Workspace `sales@` with `info@`/`quote@`
  aliases; iRoof = Google `info@iroofalberta.ca`), GBP, and review link.

Divisions to support:

- Residential roofing, install and supply.
- Metal siding, soffit, fascia, and gutters.
- Commercial exteriors.
- Shop services and materials supply.
- Raw steel distribution, slitting, and cutting.

Operating roles to support:

- Owner/commercial sales.
- Residential sales rep.
- Receptionist/materials associate.
- Office/admin.
- Field crew/subcontractor.
- Shop/materials.

Sales assumptions carried from v9.1, but gated by current low volume:

- Average residential job value: CAD $30,000-$35,000, with wider observed range.
- Previous close-rate assumption: 18%.
- Prior 60 RoofRuler reports/month assumption is not Task 1 budget truth.
- Lost-lead risk remains important, so phone intake and follow-up discipline stay in Task 1.

Out of the first deliverable:

- WooCommerce/B2C store.
- Calgary expansion structure.
- Full Paradigm ERP rollout.
- Renoworks purchase/setup unless visualizer-led selling is approved.
