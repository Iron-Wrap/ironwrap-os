# 10 - QA, Launch, And Acceptance

## QA Principle

No workflow is shipped until a test record proves it works and a failure test
proves staff can recover.

## Test Matrix

| Test | Expected Result | Pass |
|---|---|---|
| Website lead | Lead envelope `{source, contact, job_ref, payload, ts}` lands in the Make bus and creates a JobNimbus contact/lead |  |
| Dual-write to owned store | Every inbound lead is written to Cloudflare D1+R2 FIRST; the JobNimbus push is keyed on `envelope_id` (status `pending_jn_push` → `pushed`). On a transient JN failure the idempotent retried push reconciles it, and instant-ack still fires off the completed owned-store write |  |
| Retry sweep reconciles stuck push | A continuous retry sweep (not the daily count) re-drives any envelope stuck in `pending_jn_push` until `pushed`/`reconciled`; an injected transient JN outage clears without manual intervention |  |
| Raw submission stored pre-Make | Raw form/webhook payload is captured before Make processing so nothing is lost on a scenario error |  |
| Instant-ack on web form (interim, pre-A2P) | Until A2P approval, the web form fires an interim email acknowledgement to the prospect (via ESP) + an owner phone/SMS alert from the owner's own line on the instant-response pipe (separate from nurture) within the <60s touch SLA |  |
| Instant-ack prospect-SMS leg (at A2P) | Once A2P 10DLC + Canadian carrier registration is approved, the prospect-SMS leg of instant-ack/MCTB switches on via Engage on the owned number |  |
| Service-page lead | Source URL, service intent, city, message, and attachment are preserved in the envelope and on the JobNimbus lead |  |
| Quote-page lead | Full quote form maps through the Make bus to a qualified JobNimbus lead/job |  |
| UTM/source attribution | Landing page, page type, UTM fields, and manual Lead Source are preserved when available (deferred call-tracking) |  |
| Google Business Profile lead | Lead source, review link/source label, and next action are captured into the envelope + JobNimbus |  |
| First-response tracking | First response timestamp and elapsed response time are visible; <60s human-or-AI touch target met |  |
| Daily lead reconciliation | Reconciliation job compares source-event counts vs records landed; an intentionally dropped lead is flagged (dead-letter + email to named weekly owner) |  |
| Idempotency / dedup | Same phone/email arriving across two inbound paths updates the existing record, no duplicate job/folder |  |
| Phone lead | Inbound call captured as a JobNimbus lead/conversation via AssistAI or human |  |
| MCTB on missed/abandoned/after-hours call | Any unanswered, abandoned, or after-hours call creates a JobNimbus lead and fires the interim ack (owner alert + prospect email pre-A2P) within the <60s SLA; the SMS text-back leg switches on at A2P approval |  |
| AssistAI phone AI lead | AssistAI qualifies, books natively into the JobNimbus calendar, and creates a JobNimbus lead record (not just a calendar event) |  |
| AssistAI written eval gate | Scripted call battery scores >=85% capture+routing with zero catastrophic failures; result recorded in writing before AssistAI goes live |  |
| Voicemail floor fallback | When AssistAI is unavailable, call falls to voicemail -> JobNimbus lead + human callback task; nothing breaks |  |
| Phone AI follow-up | Eligible call triggers the correct follow-up sequence |  |
| Existing customer call | Existing job found or human task created |  |
| Complaint/escalation call | Human escalation, no review sequence |  |
| Appointment booking | JobNimbus calendar event created (native booking) + JobNimbus task |  |
| Cancel/reschedule | Calendar and task updated |  |
| Job qualification | JobNimbus job updated and owner assigned |  |
| Folder creation | One folder created after job number exists |  |
| Email deliverability seed test | Seed/inbox-placement test passes via the Google Workspace brand mailboxes; SPF/DKIM/DMARC verified; bounce monitoring active |  |
| Jobsite Photo form | Jotform "Jobsite Photo" form captures device GPS (Geolocation widget) offline, correct job picked, multi-photos + timestamp; webhooks Make -> lands in correct JobNimbus job + Google Drive folder; no duplicate job |  |
| Jotform structured form (if active) | Completed structured form (photo/file, drawn signature, GPS) webhooks Make -> JobNimbus job; no duplicate job |  |
| RoofRuler email intake | Incoming RoofRuler PDF is matched, archived, extracted or flagged |  |
| Measurement upload | Extracted or review-needed flag |  |
| Proposal sent | Customer link, PDF archive, status update |  |
| Proposal accepted | Signed/accepted status and deposit workflow |  |
| Contract path | Approved signing/contract path works and archives correctly |  |
| Deposit paid | QuickBooks status visible in JobNimbus |  |
| Payment method validation | Approved payment options display correctly and finance-sensitive data stays out of AI/logs |  |
| Material request | Task/form created and visible |  |
| Material list design | Selected material-list format can be reviewed and used by office/shop |  |
| Materials ready | Job ready-to-schedule status |  |
| Completion form | Job completion status and invoice/review path |  |
| Invoice paid | Job close/archive path |  |
| Review request | Sent only when eligible |  |
| Opt-out | SMS/email stops |  |
| Automation failure | Make error-handler routes to dead-letter (Google Sheet + email alert); owner task created; no silent loss |  |
| API key revoked | Failure visible, no silent data loss |  |
| A2P 10DLC Canadian registration | Fresh A2P 10DLC + Canadian carrier registration for JobNimbus Engage SMS is approved before any automated texting (lead time ~1-3 wks; not a re-registration) |  |
| Business number in Twilio | Business phone number for AssistAI/Engage is provisioned/owned in Twilio so it stays portable |  |
| "Messaging is live" smoke test | A test SMS and a test call route correctly through Engage/AssistAI on the owned number |  |
| CASL consent ledger in JobNimbus | CASL consent is captured and maintained in JobNimbus going forward (no historical export needed) |  |
| Website form post destinations | Existing website forms' current post destinations are verified and pointed at the Make bus |  |
| Renoworks lead if active | Visualizer lead, product/color interest, photo/model reference, and proposal link map correctly |  |

## Launch Stages

### Stage 1 - Internal Test

Use fake/test records only.

Exit criteria:

- All P0 workflows pass.
- No duplicate jobs/folders.
- Failure alerts work.

### Stage 2 - Controlled Real Pilot

Use a small number of real leads/jobs with human monitoring.

Exit criteria:

- Staff can operate workflow.
- Owner approves summaries and exceptions.
- No compliance blocker.
- No severe duplicate/data-loss issue.

### Stage 3 - Production Launch

Enable production workflows after final security/access hardening.

Exit criteria:

- Signoff checklist complete.
- Old credentials rotated.
- Staff SOPs delivered.
- Kill switches documented.

## Acceptance Criteria

Task 1 is accepted when:

- All active lead sources normalize through the Make bus into the owned store (D1+R2) and JobNimbus.
- Every inbound lead is dual-written to the owned store FIRST, then pushed to JobNimbus via an idempotent, `envelope_id`-keyed job; a continuous retry sweep re-drives any envelope stuck in `pending_jn_push` so a transient JobNimbus outage self-heals (the daily count only detects gaps).
- Instant-ack/MCTB fires off the owned-store write, never off the JobNimbus push: pre-A2P it runs on the interim channel (prospect email via ESP + owner phone/SMS alert) so the <60s touch holds from day one; the prospect-SMS leg switches on at A2P approval.
- Daily source-vs-landed reconciliation runs green with a named weekly owner; dead-letter + email alert proven.
- Idempotency/dedup keyed on phone/email prevents duplicate records across inbound paths.
- Website source page, service intent, UTM/manual Lead Source data are preserved when available (call-tracking deferred).
- Google Business Profile source/review flow is verified.
- Qualified leads reach JobNimbus.
- JobNimbus owns job number and stage.
- Folder creation is idempotent.
- Jobsite photos: the Jotform "Jobsite Photo" form (sole jobsite-photo/geo tool, $0 incremental) captures device GPS offline + correct job and lands in the right JobNimbus job + Google Drive folder. Jotform structured forms (if active) webhook Make -> JobNimbus correctly.
- RoofRuler email reports are matched, archived, and reviewed.
- Appointments work (JobNimbus calendar; native booking).
- AssistAI passes the written scored eval gate (>=85% capture+routing, zero catastrophic failures); voicemail floor fallback verified.
- Google Workspace brand-mailbox email passes the seed/inbox-placement test; SPF/DKIM/DMARC + bounce monitoring active; temporary Microsoft mirror rules are either verified or disabled after migration close.
- GHL lead routes are retired after replacement proof. Fresh A2P 10DLC + Canadian carrier registration approved, Engage "messaging is live" smoke test passes, CASL consent ledger maintained in JobNimbus going forward, and website form post destinations verified/pointed at the bus.
- Proposal/PDF flow works.
- Contract/signature path works.
- Measurement extraction or review flag works.
- Material-list decision is implemented and tested.
- Payment method policy is approved and tested.
- Renoworks lead/proposal flow is tested if Renoworks is active.
- Deposit/invoice/review follow-up works.
- Owner exceptions view exists.
- Staff can operate without developer support.
- Compliance and access hardening gates are complete.

## Defect Severity

| Severity | Meaning | Launch Impact |
|---|---|---|
| P0 | Data loss, privacy issue, duplicate production jobs/folders, payments wrong | Blocks launch |
| P1 | Workflow cannot be completed without developer | Blocks launch |
| P2 | Staff can work around temporarily | Launch possible with owner approval |
| P3 | Cosmetic/docs/minor reporting issue | Does not block |

## Rollback

For each production automation document:

- How to disable.
- Who disables.
- Manual replacement step.
- What data may need cleanup.
- How to restart.

No launch without rollback notes.
