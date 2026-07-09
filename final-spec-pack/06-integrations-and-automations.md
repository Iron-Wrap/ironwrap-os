# 06 - Integrations And Automations

## Automation Principles

- One owner per automation.
- One trigger per automation.
- One source of truth per data area.
- Every mutation has an idempotency key.
- Every failure creates alert or task.
- Every automation has a kill switch.
- No broad two-way sync unless required.

## Integration Matrix

| System | Needed Surface | Direction | Priority |
|---|---|---|---|
| JobNimbus | Contacts, jobs, tasks, notes, attachments, boards/statuses, API keys, automations; lead records from every inbound path | In/out | P0 |
| Make (connector/visibility layer) | Existing scenario triggers, native SaaS connectors, owner-visible runs, Make UI bridge/retire actions | In/out | P0 |
| Owned Worker bus (Cloudflare Workers + D1 + R2 + Queues + Cron) | Canonical lead envelope, raw submission store, idempotency/dedup, retry/dead-letter, source counts, reconciliation heartbeat | In/out | P0 |
| JobNimbus AssistAI | Inbound/missed/after-hours calls, transcripts, summaries, capture+book+route-flag, books natively into the JobNimbus calendar (Make used for route-flagging + the owned-store dual-write, not necessarily the booking call), lead-record creation | In/out | P0 |
| JobNimbus Engage | Two-way SMS, MCTB / instant-ack send, nurture, review-request sequences | In/out | P0 |
| Google Workspace email (brand mailboxes); JN native email unused; dedicated ESP deferred for bulk deliverability | All outbound email from brand mailboxes (JN native email unreliable); SPF/DKIM/DMARC, bounce monitoring, message IDs | Out | P0 |
| Jotform "Jobsite Photo" form | Sole jobsite photo/geo path ($0 incremental): JN job picker, Geolocation widget (device GPS at submit, offline-capable), multi-photo upload, auto timestamp; webhook -> Make -> Google Drive + JN + owned store | In/out | P0 |
| Google Business Profile | Profile fields, review link, source label, optional booking link | Manual/config | P0 |
| Google Drive (Google Workspace) | Folder create/rename, upload, permission links | Out | P0 |
| Email / Google mailbox | RoofRuler report emails (inbound report inbox; distinct from the Google Workspace brand mailboxes used for outbound), sender filters, PDF attachments, message IDs | In | P0 |
| Jotform | Structured field forms (offline app: photo/file, draw signature, device-GPS geotag), webhook -> Make -> JN | In/out | Deferred (add when a structured workflow hurts) |
| QuickBooks | Customers, invoice status, payment status, products/services | Mostly out/status back | P1 |
| OCR/parser | File input, extracted blocks/tables, confidence | In | P1 |
| Proposal generator | Job data in, HTML/PDF out, sent/accepted state | In/out | P1 |
| Renoworks | Lead, uploaded photo/model, roof/wall/product/color interest, visualizer link, engagement stats if exportable | In | Deferred |
| Paradigm | Material/production order import/API, rollformer model mapping, shop status | Out/in | Deferred |
| QuickBooks Payments | Invoice card/EFT payment status | Status back | P1 |
| FinanceIT | Financing application/status reference only | Status back | Approval required |

## Core Automations

| Automation | Trigger | Action | Failure Handling |
|---|---|---|---|
| New lead via Make bus | Any inbound (web form, AssistAI, GBP, referral) | Build canonical lead envelope `{source, contact, job_ref, payload, ts}`; store raw submission pre-Make; dedup on phone/email; **dual-write to owned D1/R2 FIRST**, then create/update JobNimbus contact/job + assign owner | Error-handler -> dead-letter (Google Sheet + email); mandatory, every scenario |
| Instant-ack / MCTB | Same inbound event, separate pipe from nurture | Fire prospect SMS within ~10s + owner alert; target <60s human-or-AI touch, 24/7 | Dead-letter + email to owner if ack not confirmed |
| Qualified job to folder | JobNimbus job qualified and job number exists | Create folder once, store links | Admin alert, no retry without idempotency |
| Appointment booked | AssistAI books the appointment | AssistAI books natively into the JobNimbus calendar and creates the lead record in-CRM; Make is used for route-flagging + the owned-store dual-write, not necessarily the booking call | Alert if job not found |
| AssistAI call completed | AssistAI call completed | **Create a JobNimbus lead record** (not just a calendar event); store summary, booking status, route flag, follow-up trigger; dual-write envelope to owned store | Human follow-up task + dead-letter |
| Daily reconciliation | Scheduled daily | Compare source-event counts vs records landed in owned store + JobNimbus; flag gaps to named weekly owner | Alert owner; gap = investigate before clearing |
| Source attribution captured | Website form, tracked call, GBP, or campaign lead | Store landing/source/UTM/manual Lead Source and first-response metrics | Admin alert if required source fields missing |
| RoofRuler report email | RoofRuler email with PDF attachment received | Match job/address, archive PDF, parse or flag review | Review task + unmatched report queue |
| Measurement uploaded | File attached/uploaded | Parse/extract or flag review | Review-needed task |
| Structured form completed (Jotform, deferred) | Form completed/submitted | Archive PDF/output, update JobNimbus note/task/status, log event | Admin alert + manual archive task |
| Jobsite photos synced | Jotform "Jobsite Photo" submit (offline app, syncs on reconnect) | Webhook -> Make: dual-write envelope to owned store, archive photos to Google Drive job folder, attach to JobNimbus job with device-GPS geo + timestamp | Dead-letter + admin alert if webhook/sync fails |
| Proposal sent | Proposal generated/sent | Update status, archive PDF, start follow-up | Sales task |
| Proposal accepted | Customer accepts/signs | Update status, deposit workflow | Office task |
| Deposit paid | QuickBooks/payment event | Update JobNimbus deposit status | Finance task |
| Material request | Deposit/signed status | Create material request task | Production task |
| Materials ready | Staff marks ready | Move ready-to-schedule | Scheduling task |
| Completion form | Field completion | Create invoice/review path | Office task |
| Invoice paid | QuickBooks paid | Close/archive status | Finance task |
| Google review request | Completion + no issue | Send approved review link and source label | Stop on complaint/opt-out |
| Automation failed | Make/relay failure | Notify owner | Must include run link and recovery step |

## Integration Bus Standard (Mandatory)

Make is critical infrastructure, not plumbing. Every scenario MUST implement
these — they are no longer "if built":

- Error-handler -> dead-letter (Google Sheet + email; **not SMS-only** — the SMS leg
  rides the same A2P-gated path that may itself be down) on every scenario.
- Idempotency/dedup keyed on phone/email across all inbound paths.
- Raw submission stored pre-Make (in owned store) so nothing is lost upstream.
- Dual-write the canonical lead envelope to owned D1/R2 FIRST, then push to JobNimbus.
- Daily reconciliation: source-event counts (from an independent ground truth — form-provider/Cloudflare logs, Twilio call logs, GBP dashboard) vs records landed.
- A named weekly owner **plus a named backup** reviews dead-letter + reconciliation; a
  daily heartbeat ("reconciliation ran / dead-letter empty") escalates to the backup
  on silence (a missing run is itself the alert).

**Partial-write repair.** The JobNimbus push is an idempotent, auto-retried job
keyed on `envelope_id`, carrying a status field (`pending_jn_push` → `pushed` →
`reconciled`). A continuous retry sweep — not the once-daily count — re-drives any
envelope stuck in `pending_jn_push`. **Instant-ack/MCTB fires off the owned-store
write, never off the JobNimbus push**, so an acknowledgement still goes out when
JobNimbus is unavailable. The daily source-vs-landed count is the backstop that
*detects* gaps; the retry sweep is the mechanism that *repairs* them.

A small relay/Worker may sit alongside Make where it cannot natively handle:

- Dedupe reliably.
- Idempotent folder creation.
- Field validation.
- Detailed mutation logs.
- Retried webhook delivery.
- Health checks.

Relay responsibilities (mandatory wherever a relay is used):

- Validate incoming payloads.
- Normalize fields.
- Create idempotency key.
- Store event log.
- Dual-write to owned store before calling target.
- Call target system.
- Return success/failure.
- Emit alert on failure.

The relay must not become a CRM replacement; JobNimbus is the CRM, the owned
D1/R2 layer is the system of record.

Make's bus role may instead run on Cloudflare Workers (Workers + D1 + R2 + Queues
+ Cron) as a hybrid — the Worker does the heavy lifting and a cheap Make Core seat
is kept for native connectors + observability until the custom JobNimbus
integration is proven; this adds owned code, so name a build/maintenance owner
before committing (see 01).

Current implementation note: this hybrid is already the active direction. The
Worker owns `/ingest/:source`, `/ingest/photo`, `/ingest/measurement`,
`/webhook/quickbooks`, queue push, DLQ, retry sweep, and reconcile. Make remains
the safe UI-controlled bridge for existing RoofRuler/GHL/Jotform routes until
replacement proof exists.

## Logging Standard (Mandatory)

Every automation MUST log to the owned store; each log includes:

- Timestamp.
- Automation name.
- Trigger event.
- Source record IDs.
- Target record IDs.
- Job number if known.
- Action taken.
- Result.
- Error message if failed.
- Manual recovery owner.

## Kill Switch Standard

Every automation needs:

- Where to disable it.
- Who can disable it.
- What breaks when disabled.
- Manual workaround.
- How to restart safely.

## Duplicate Prevention

Use these checks before creating records:

1. Exact phone match.
2. Exact email match.
3. Normalized address match.
4. JobNimbus external refs.
5. Owned-store envelope refs (idempotency key on phone/email).

Dedup runs in the Make bus on every inbound path, before the dual-write.
When uncertain, flag for human merge review.

## Field Capture First-Deliverable Integration

NaturalForms is dropped (stagnant). The default jobsite-photo/geo path from day
one is a single Jotform "Jobsite Photo" form ($0 incremental, reuses already-paid
tools): a JobNimbus job picker, the Jotform Geolocation widget (captures device
GPS lat/long at submit, coordinates-only, works offline in the Jotform Mobile App;
NOT the GeoStamp widget, which needs internet and falls back to IP, and NOT the
GPS Location widget, which needs a Google Maps API key), a multi-photo File Upload,
and an auto timestamp. Crew uses the Jotform Mobile App in Offline Mode (queues
on-device, syncs on reconnect). Do NOT rely on photo EXIF for geo — iOS strips
photo GPS by default, and direct camera-capture uploads lose metadata regardless
— so capture device GPS at submit; don't depend on EXIF.

If real-world crew adoption shows per-submission job-picking friction is tanking
photo-documentation compliance, fix the Jotform flow itself — kiosk mode, a
simpler/auto job-picker, fewer taps — rather than adding a second photo tool. Do
not self-host an OSS photo server (Immich/PhotoPrism/LibrePhotos) — wrong trade
for a no-devops shop. Do not build a custom photo PWA yet.

Integration order:

1. Jotform "Jobsite Photo" form (offline app: JN job picker, device-GPS
   Geolocation widget, multi-photo upload, auto timestamp) -> webhook -> Make ->
   Google Drive job folder + JobNimbus job + dual-write to owned store.
2. When a structured workflow hurts: Jotform offline app (photo/file, draw
   signature, device-GPS geotag) -> webhook -> Make -> JobNimbus.
3. Structured output files/exports archived to Google Drive via Make or the Worker.
4. Every structured-form event flows through the Make bus (envelope, dedup,
   dual-write to owned store) like any other inbound.

Structured forms to implement (when triggered, via Jotform):

- Work order.
- Additional work order / change order.
- Equipment and machinery request.
- Completion form.
- Inspection form.
- Materials request.
- Safety form.
- Contract/customer acceptance if approved.
- Material list.

Rules:

- Jotform "Jobsite Photo" form is the sole owner of jobsite photo/geo evidence ($0 incremental).
- Jotform owns structured completed-form evidence (when introduced).
- JobNimbus owns job status and next action.
- Owned D1/R2 layer is the system of record (dual-write first).
- Google Drive owns the archived PDF/output copy.
- QuickBooks invoices and receipts remain reviewed accounting actions.
- Adobe interactive PDFs are not a structured-capture tool (flat output;
  structured JSON only via the paid Adobe dev API + re-keying).

## Supplier / Shop Bridge

First deliverable:

- Material requests live in JobNimbus as tasks/forms and attachments.
- Supplier, product/profile, color, quantity, required date, and blocker fields are structured.
- JobNimbus supplier connectors can be reviewed, but they are not production-ready until one test order proves the data is correct.
- Shop/supply and steel/distribution inquiries are routed separately from residential install jobs.

Deferred Paradigm bridge:

- Send approved material/production orders only after human review.
- Map IronWrap product/profile names to Paradigm item names.
- Confirm rollformer model/profile compatibility before production use.
- Pull back shop status only: received, in production, ready, blocked, complete.
- Do not let Paradigm become the source of truth for customer/job stage.
