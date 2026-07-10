# 12 - Implementation Backlog

This backlog turns the spec pack into buildable work. Each item should be
completed with evidence, not just marked done.

## Epic 1 - Audit And Containment

Active first-phase detail lives in `18-phase-1-source-truth-and-build-contract.md`.
Do not expand this epic from older GHL-first notes.

| ID | Task | Output | Acceptance |
|---|---|---|---|
| A1 | Inventory accounts and roles | Access inventory | JobNimbus, Make, Cloudflare, Jotform, QuickBooks, Google Workspace/Drive, website, AI/phone listed; Cloudflare account mismatch cleared or explicitly recorded |
| A2 | Inventory Make scenarios | Scenario map | Each scenario tagged keep/bridge/retire; edits made in Make UI only |
| A3 | Identify live webhooks/API keys | Integration register | Owner and purpose known for each connection |
| A4 | Create safe test records | Test data list | Staff can tell test records from real jobs |
| A5 | Pause dangerous duplicates | Disabled/paused list | No two automations mutate same folder/action |

## Epic 2 - JobNimbus Operating Core

| ID | Task | Output | Acceptance |
|---|---|---|---|
| J1 | Configure stages | Stage pipeline | Stages match spec and have owners/next actions |
| J2 | Configure fields | Field set | Lead/job/material/finance fields exist |
| J3 | Configure job number policy | Numbering rule | JobNimbus owns canonical job number |
| J4 | Configure task templates | Task templates | Lead, estimate, proposal, material, completion tasks available |
| J5 | Configure attachment categories | Categories | Docs/photos/proposals/materials/invoices organized |
| J6 | Configure division routing | Division fields and queues | Residential, commercial, shop/supply, and steel/distribution route correctly |

## Epic 2B - Field Capture Layer (Jotform Jobsite Photo)

NaturalForms is dropped (stagnant). The Jotform "Jobsite Photo" form is the
SOLE jobsite photo/geo tool ($0 incremental, reuses already-paid Jotform +
Make): it captures device GPS at submit via the Jotform Geolocation widget
(coordinates-only, works OFFLINE in the Jotform Mobile App; NOT the GeoStamp
widget, which needs internet/falls back to IP, and NOT the GPS Location widget,
which needs a Google Maps API key) plus a multi-photo File Upload and an auto
timestamp. Do NOT rely on photo EXIF for geo: iOS strips photo GPS by default, and
direct camera-capture uploads lose metadata regardless — so capture device GPS at
submit; don't depend on EXIF. Crews use Offline Mode (queues on-device, syncs on
reconnect) -> webhook -> Make -> Google Drive job folder + JobNimbus job + dual-write to
the owned store. If per-submission job-picking friction hurts photo-documentation
compliance, the fix is to improve the Jotform flow (kiosk mode, simpler/auto
job-picker) -- not a new photo vendor.

| ID | Task | Output | Acceptance |
|---|---|---|---|
| FC1 | Build Jotform "Jobsite Photo" form | Structured form | JobNimbus job picker, Jotform Geolocation widget (device GPS, offline-capable), multi-photo File Upload, auto timestamp |
| FC2 | Configure Jotform Make route | Webhook -> Make -> Google Drive/JN route | Completed form reaches Make, dual-writes to owned store, lands photos in the Google Drive job folder, and updates the correct JobNimbus job |
| FC3 | Train crews on Jotform Mobile App offline capture | Field adoption note | Crews capture photos + device-GPS geo on the right job in Offline Mode; queue syncs on reconnect without re-keying |

## Epic 3 - Lead Front Door (Owned Data Layer + JobNimbus)

GHL is legacy experimental scaffolding. JobNimbus is the operational CRM / lead
front door, fronted by the Worker/Make bus and an instant-ack branch. A thin
owned data layer (Cloudflare D1 + R2) is the system of record that every Make
scenario dual-writes to FIRST, then pushes to JobNimbus.

| ID | Task | Output | Acceptance |
|---|---|---|---|
| L1 | Stand up owned data layer | Cloudflare D1 + R2 + canonical lead envelope | Lead envelope `{source, contact, job_ref, payload, ts}` defined; D1/R2 dual-write live |
| L2 | Configure JobNimbus lead pipeline | Pipeline | New/contacted/booked/estimate/proposal/won/lost visible |
| L3 | Configure forms/intake | Intake forms | Website/manual/ad leads map to required envelope fields |
| L4 | Configure JobNimbus calendar | Calendar | Appointment types, buffers, confirmations work; AssistAI books natively into the calendar (Make webhook for route-flag/dual-write) |
| L5 | Verify brand-mailbox email + domain auth | Email config | Outbound email sends from **Google Workspace brand mailboxes** (IronWrap `sales@` with `info@`/`quote@` aliases; iRoof `info@iroofalberta.ca`); SPF/DKIM/DMARC pass on each domain; bounce monitoring on; JN native email unused. Dedicated ESP is deferred for bulk nurture/review only |
| L6 | Configure Engage SMS + review flow | Message templates + review sequence | Confirmation/follow-up via Engage; review request stop conditions implemented |
| L7 | Map website funnel sources | Source mapping table | Home, quote, contact, service pages, city pages, and blog CTAs preserve source URL/service intent |
| L8 | Add qualified-lead routing rules | Routing rules | Roof/siding/gutter/soffit/fascia/commercial/shop leads route to the correct owner/queue |
| L9 | Add attribution fields (deferred) | Attribution mapping | UTM + manual Lead Source + one tracked number captured; CallRail only when paid ads start |
| L10 | Audit Google Business Profile | GBP checklist | Categories, service areas, phone, website, hours, photos, services, review link, and source label are approved |
| L11 | Register A2P 10DLC + Canadian carrier | Registration approval | Fresh A2P 10DLC and Canadian carrier registration for JobNimbus Engage SMS approved before any automated texting |
| L12 | Provision owned business number | DID provisioning | Business phone number for AssistAI/Engage provisioned and owned in Twilio so it is portable |
| L13 | Stand up CASL consent ledger | Consent ledger | CASL consent captured and maintained in JobNimbus going forward |
| L14 | Verify + route website forms | Updated site | Existing website forms' current post destinations verified and pointed at the Make bus |
| L15 | Retire GHL routes | Cutover note | Remaining GHL routes disabled only after replacement proof through the bus |
| L16 | Define paid-lead readiness gate | Readiness checklist | LSA/paid campaigns stay off until attribution, response time, dedupe, reconciliation, and owner exceptions pass QA |

## Epic 4 - Make = Critical Integration Infrastructure

Make is critical infrastructure, not plumbing. Every inbound path stores the raw
submission pre-Make, dual-writes to the owned data layer FIRST, then pushes to
JobNimbus. A named weekly owner runs reconciliation.

**Bus-hybrid option (where the infra runs, not abandoning the discipline).** Make's
role can collapse into a **Cloudflare Workers + D1 + R2 + Queues + Cron** bus that an
AI agent builds (~CAD $7/mo vs scaling Make on its credit model): Queues gives native retry +
dead-letter, Cron gives the daily reconciliation, and the dual-write becomes a
**single write** (the owned store IS the bus), which also resolves the partial-write
problem (M9). **Recommended hybrid:** the Worker does the heavy lifting (envelope,
dedup, dead-letter, reconcile, single-write) and a cheap **Make Core seat (~$9/mo)**
is kept for its native JobNimbus/QuickBooks/Twilio connectors + owner-visible
observability, until the custom JobNimbus integration is proven. **Note:** this is owned
product code IronWrap builds, operates, and resells; the owner plus Claude Code is the
engineering/ops capacity (see docs/OPERATIONS-RUNBOOK.md).

| ID | Task | Output | Acceptance |
|---|---|---|---|
| M1 | Build lead handoff (envelope -> D1/R2 -> JN) | Inbound bus flow | Qualified test lead dual-writes to owned store, then creates/updates correct JobNimbus job |
| M2 | Add idempotency/dedup | Dedup checks | Duplicate test lead keyed on phone/email does not create duplicate record across any inbound path |
| M3 | Add error-handler -> dead-letter | Dead-letter route | Failed test event lands in dead-letter on a **redundant** channel (Google Sheet + email, **not SMS-only** — the SMS leg rides the A2P-gated path that may itself be down); nothing fails silently |
| M4 | Store raw submission pre-Make | Raw capture | Every inbound submission is stored before Make processing |
| M5 | Build daily reconciliation | Reconciliation job + named owner + backup + heartbeat | Source-event counts from an **independent ground truth** (form-provider/Cloudflare logs, Twilio call logs, GBP dashboard) vs records landed, compared daily; referral/manual reconciled by owner attestation; mismatch alerts; weekly owner **and a named backup**; a daily heartbeat ("reconciliation ran / dead-letter empty") escalates to the backup on silence |
| M6 | Build instant-ack + MCTB scenarios | Instant-response flows | Every unanswered call -> SMS within ~10s once Engage/A2P is live; every web form -> instant prospect email + owner alert on a pipe SEPARATE from nurture; <60s human-or-AI touch, 24/7. **Interim pre-A2P ack path:** until the fresh A2P 10DLC + Canadian carrier registration is approved, instant-ack/MCTB runs on Gmail acknowledgement to the prospect + owner alert; the prospect-SMS leg switches on in JobNimbus Engage at A2P approval |
| M7 | Rebuild folder flow | Folder automation | One job creates one folder after job number exists |
| M8 | Add automation run log | Log table/sheet/Make log discipline | Critical mutations are traceable |
| M9 | Build dual-write partial-write repair | Idempotent JN push + retry sweep | JobNimbus push is an idempotent, auto-retried job keyed on `envelope_id` carrying a status field (`pending_jn_push` -> `pushed` -> `reconciled`); a continuous retry sweep (not the once-daily count) re-drives any envelope stuck in `pending_jn_push`; instant-ack/MCTB fires off the owned-store write, never off the JN push, so an ack still goes out when JobNimbus is unavailable; the daily source-vs-landed count detects gaps, the retry sweep repairs them |
| M10 | Execute Phase 1 contract | Source-truth proof pack | `18-phase-1-source-truth-and-build-contract.md` definition of Phase 1 done is satisfied |

## Epic 5 - Phone AI (JobNimbus AssistAI)

AssistAI is the P0 native 24/7 receptionist (books natively into the JN calendar,
~$0.15/voice-min pure-metered), gated behind a written scored eval-call battery.
Because it bills pure-metered, **enforce a hard monthly minute cap / budget alert**
(verify AssistAI's native cap support; if there is no native cap, enforce via usage
monitoring + an overage alert; cap = owner-set, e.g. ~500 min/mo). Floor fallback =
voicemail -> JobNimbus lead + human callback. The escalation ladder if the eval gate
fails is managed Retell (one config) -> managed-OSS (LiveKit Cloud / Pipecat Cloud)
"tier 2.5"; the hand-assembled 4-vendor voice stack is killed; Vapi and the consumer
Google Voice product are excluded. The DID is owned in Twilio so swaps are
config-only.

| ID | Task | Output | Acceptance |
|---|---|---|---|
| AI1 | Approve call script and notice | AI script | AI/recording/human-transfer wording approved |
| AI2 | Configure AssistAI + minute cap | AssistAI agent | Test call qualifies, books natively into the JN calendar, creates a JN lead record; hard monthly minute cap / budget alert set (native cap if supported, else usage monitoring + overage alert; cap = owner-set, e.g. ~500 min/mo) |
| AI3 | Configure voicemail floor fallback | Floor fallback | No-answer -> voicemail -> JobNimbus lead + human callback; never breaks |
| AI4 | Configure escalation | Human transfer/task | Angry/legal/warranty/payment calls escalate |
| AI5 | Configure summaries | Summary template | Staff can read summary without recording |
| AI6 | Configure post-call follow-up | Follow-up trigger map | Eligible calls trigger the correct JobNimbus follow-up |
| AI7 | Run written scored eval-call battery | Eval report | >=85% capture+routing, zero catastrophic failures; pass = go live, fail = escalate to managed Retell -> managed-OSS (LiveKit Cloud / Pipecat Cloud) "tier 2.5" |

## Epic 6 - Documents And Proposal

| ID | Task | Output | Acceptance |
|---|---|---|---|
| D1 | Define folder convention | Folder template | Subfolders match spec |
| D2 | Build XML/parser path | Parser output | AppliCad XML proof exists in `tools/applicad-xml-proof.mjs`; production path promotes reviewed fields into the job/proposal record |
| D3 | Build RoofRuler email intake | Email attachment route | RoofRuler PDFs are matched, archived, and queued for extraction/review |
| D4 | Build PDF extraction path | Extractor output | Extraction order: (1) deterministic AppliCad XML / text-PDF parse, then (2) **Cloudflare `toMarkdown()`** (Workers AI binding -- free, on-stack; replaces standalone Tesseract for text PDFs), then (3) Claude/LLM read only when structured field extraction/reasoning is needed; text PDF values extracted or flagged |
| D5 | Add OCR fallback | OCR queue | (4) **Mistral OCR 4** (~$2-4 per 1,000 pages -> cents/mo at this volume) ONLY for image-heavy/scanned/handwritten/layout-sensitive docs; do NOT self-host an OCR engine (Surya/PaddleOCR need a GPU box Workers can't run, not warranted at this volume); image-heavy docs flagged or processed |
| D6 | Build proposal template | HTML/PDF proposal | Customer can view and PDF archives |
| D7 | Decide contract path | Approved signing/contract flow | JobNimbus native e-sign / HTML+PDF bridges only until the JobNimbus retirement. **DocuSeal retired permanently (2026-07-09) and Documenso rejected (2026-07-10): both AGPL-3.0, not even escape hatches.** Keeper path (verified 2026-07-10): PRIMARY is owned click-to-accept signing on the Proposal Evidence Pack (typed name + timestamp + IP + SHA-256 hash + audit trail + retainable PDF copy; valid under Alberta ETA SA 2001 c E-5.5 ss.10/11/16(1) with the s.8 consent clause; in-home sales with deposits also need the Consumer Protection Act prescribed contents, both signatures, and the 10-day cooling-off notice in 12-point bold). Alberta opened a direct-selling/prepaid-contracting modernization engagement in May 2026, so the licence/contract policy adapter must be revalidated against current law before production release. Optional vendor bridge by verified 2026 low-volume pricing: SignWell (25 free API docs/month then $0.85/doc, no minimum) or BoldSign ($30/month incl 40 envelopes); Dropbox Sign ($75/month) and DocuSign Starter ($600/year) are not competitive at this volume. Contract archives and updates job status |
| D8 | Decide material-list design | Approved material-list template | Office/shop can review and use the selected format |

## Epic 7 - Payments, Reviews, Exceptions

| ID | Task | Output | Acceptance |
|---|---|---|---|
| P1 | Configure QuickBooks status visibility | Finance fields/status sync | Deposit/invoice status visible in JobNimbus |
| P2 | Configure payment follow-up | Follow-up rules | Missing deposit/invoice creates task |
| P3 | Configure review request | Review sequence | Eligible completed jobs get review request; complaints/disputes do not |
| P4 | Build exceptions view | Sheet/report/page | Owner sees daily blockers |
| P5 | Staff SOP review | SOP checklist | Staff can run workflow without developer |
| P6 | Validate payment stack | Approved payment method map | Cash/cheque/direct deposit, QBO Payments card/EFT, and FinanceIT are approved or deliberately hidden; Moneris stays deferred unless an in-person terminal need is approved |
| P7 | Add response-time visibility | Owner exception metric | New leads/calls show first-response timestamp and overdue follow-up status |
| P8 | Add reconciliation visibility | Owner reconciliation view | Daily source-vs-landed reconciliation result, instant-ack/MCTB firing, and dead-letter count are visible to the named weekly owner |

## Epic 8 - QA And Launch

| ID | Task | Output | Acceptance |
|---|---|---|---|
| Q1 | Run full test matrix | QA report | P0/P1 tests pass |
| Q2 | Fix launch blockers | Fix list | No P0/P1 open |
| Q3 | Run controlled real pilot | Pilot report | Owner approves workflow |
| Q4 | Final security hardening | Security checklist | Credentials rotated, MFA/roles/secrets complete |
| Q5 | Launch signoff | Signed checklist | Owner approves production launch |

## Evidence Standard

For every completed backlog item, record:

- Test record name/ID.
- Systems touched.
- Screenshot or exported evidence where useful.
- Pass/fail result.
- Remaining risk.
- Owner approval if production-sensitive.
