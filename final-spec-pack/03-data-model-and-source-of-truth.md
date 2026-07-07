# 03 - Data Model And Source Of Truth

## Source Of Truth Map

The owned store (Cloudflare D1 + R2) is the canonical system of record for raw
inbound events: every Make scenario dual-writes the canonical lead envelope to the
owned store FIRST, then pushes to JobNimbus. JobNimbus is the operational CRM /
job-truth consumer of IronWrap's data, not the owner of the raw event stream.

| Data Area | System Of Record | Mirror Allowed In | Notes |
|---|---|---|---|
| Raw inbound events | **Owned store (D1+R2)** (canonical) | JobNimbus, Make logs | Dual-write FIRST, then push to JobNimbus; canonical lead envelope |
| Brand | **Owned store (D1+R2)** (on the envelope) | JobNimbus | `ironwrap \| iroof`, captured at intake; selects sender mailbox / GBP / review link |
| Lead source and marketing attribution | **Owned store (D1+R2)** + JobNimbus | JobNimbus Lead Source field | Preserve original source/campaign; attribution via UTM + manual Lead Source (call-tracking deferred) |
| Conversations | JobNimbus (Engage SMS) + Google Workspace brand mailboxes (email sender) + **owned store** | JobNimbus notes summary | Store summaries, not every raw log everywhere; raw envelope retained in owned store; email sends from brand mailboxes (dedicated ESP deferred) |
| Customer/contact | JobNimbus after qualification | Owned store | JobNimbus is the operational CRM and job-facing truth |
| Property | JobNimbus | Owned store | Normalize address early |
| Job | JobNimbus | Owned store | JobNimbus owns job number and stage |
| Appointment | JobNimbus Calendar | Owned store, AssistAI booking event | Booked via Make webhook; avoid competing calendars |
| Files | Google Drive (Google Workspace) + R2 | Links in JobNimbus | Archive only; R2 holds raw submission payloads |
| Measurements | JobNimbus + folder | Proposal workspace | Extracted values need review status |
| Proposal | JobNimbus/proposal generator | Folder, JobNimbus status | Versioned |
| Field forms/signatures | Jotform "Jobsite Photo" form (photos/geo, sole tool, $0 incremental) + Jotform (structured) | JobNimbus notes/tasks, folder PDFs | Webhook -> Make -> Google Drive + JobNimbus + owned store; JobNimbus owns job state |
| Materials | JobNimbus | Jotform material-request form | Manual flow first; Paradigm deferred |
| Invoice/payment | QuickBooks | JobNimbus status fields | QuickBooks owns accounting truth |
| Reviews/nurture | JobNimbus automation + Engage (SMS) + Google Workspace brand mailboxes (email sender) | Owned store event/status | Must respect consent/stop conditions; nurture on a pipe separate from instant-ack; email from brand mailboxes (SPF/DKIM/DMARC), dedicated ESP deferred for bulk |
| CASL consent | JobNimbus (consent ledger) | Owned store | Per-contact consent basis + date + source; required to keep texting/emailing |
| Automation logs | Make plus owned-store audit table | Exceptions view + dead-letter | Every critical mutation logged; failures route to dead-letter |

## IDs And External References

Do not force every system to use the same ID. Use one canonical job reference and
store external references.

Canonical:

- `job_number`: owned by JobNimbus.
- `envelope_id`: owned by the owned store (D1); the canonical raw-event identity.

External references:

```json
{
  "job_number": "26-171-ABN",
  "external_refs": [
    {"system": "owned_store", "type": "envelope", "id": "ow_envelope_id"},
    {"system": "make", "type": "run", "id": "make_run_id"},
    {"system": "jobnimbus", "type": "contact", "id": "jn_contact_id"},
    {"system": "jobnimbus", "type": "job", "id": "jn_job_id"},
    {"system": "drive", "type": "folder", "id": "folder_id"},
    {"system": "quickbooks", "type": "invoice", "id": "qb_invoice_id"}
  ]
}
```

### Lead Envelope (canonical)

The canonical normalized object every inbound path produces and every Make
scenario dual-writes to the owned store FIRST, before pushing to JobNimbus.

```json
{
  "source": "website|phone|gbp|ad|referral|manual",
  "brand": "ironwrap|iroof",
  "contact": {"name": "", "phone": "", "email": ""},
  "job_ref": "26-171-ABN",
  "payload": {},
  "ts": "2026-06-28T14:03:00-06:00"
}
```

Rules:

- Written to the owned store (D1+R2) before any downstream push; JobNimbus is a
  consumer of the envelope, not its owner.
- `brand` (`ironwrap | iroof`) is captured at intake and selects the sender
  mailbox / GBP / review link.
- `payload` carries the raw submission (form fields, call transcript/summary,
  upload links); the raw body is also archived in R2.
- Dedup/idempotency is keyed on `contact.phone` / `contact.email` across all
  inbound paths.

### CASL Consent Ledger

Per-contact consent record; system of record is JobNimbus, mirrored to the owned
store. Required to keep texting/emailing legally (CASL). Maintained in JobNimbus
going forward; any remaining GHL route is legacy and retires after replacement proof.

```json
{
  "contact_ref": "jn_contact_id",
  "consent_basis": "express|implied|inquiry|none",
  "consent_date": "2026-06-28",
  "consent_source": "website_form|phone",
  "channels": ["sms", "email"],
  "withdrawn": false,
  "withdrawn_date": null
}
```

Rules:

- Consent provenance must be recorded at point of capture and maintained in
  JobNimbus going forward (no GHL export needed — GHL was trial-only, never
  production).
- A withdrawn/expired consent blocks outbound SMS/email regardless of CRM state.

## Core Objects

### Contact

Required fields:

- First name.
- Last name or company.
- Phone.
- Email if available.
- Preferred contact method.
- Consent status.
- Lead source.
- Owned-store envelope ID.
- JobNimbus contact ID.

Rules:

- Phone number is the strongest dedupe key.
- Email is secondary.
- Same address with similar name must be flagged for review before merge.

### Property

Required fields:

- Street address.
- City.
- Province.
- Postal code.
- Country.
- Property type.
- Service area status.

Rules:

- Store normalized address once.
- Do not parse property details out of notes if structured fields exist.

### Lead

Required fields:

- Brand (`ironwrap | iroof`, captured at intake; selects sender mailbox / GBP / review link).
- Source.
- Source URL/page.
- Landing page.
- Page type.
- Campaign/referral.
- UTM source.
- UTM medium.
- UTM campaign.
- UTM content.
- UTM term.
- Call source/number if the lead came by phone.
- Service interest.
- Urgency.
- Insurance/hail flag.
- Uploaded file/photo link if provided.
- Initial notes.
- Lead owner.
- Next action.
- First response timestamp.
- First response time.
- Qualification status.

Qualification statuses:

- New.
- Contacted.
- Qualified.
- Not qualified.
- Duplicate.
- Lost.

### Job

Required fields:

- JobNimbus job ID.
- Canonical job number.
- Customer.
- Property.
- Division: Residential, Commercial, Shop/Supply, Steel/Distribution.
- Scope: roof, siding, gutter, soffit, fascia, commercial, supply/shop.
- Stage.
- Owner.
- Appointment date.
- Estimate due date.
- Proposal status.
- Deposit status.
- Materials status.
- Schedule status.
- Invoice status.

### Measurement Package

Required fields:

- Provider: AppliCad, RoofRuler, photos, manual, other.
- Source: RoofRuler email, manual upload, folder watcher, or field capture.
- Files.
- Original email sender/message ID if received by email.
- Extracted values.
- Confidence.
- Review status.
- Reviewed by.
- Reviewed at.

Rules:

- Use structured XML before OCR.
- OCR cannot create final pricing without human review.

### Proposal

Required fields:

- Version.
- Proposal URL.
- PDF URL.
- Options.
- Products/colors.
- Visualizer link if active.
- Sent date.
- Viewed date if available.
- Accepted/signed date.
- Deposit requested date.

### Materials

Required fields:

- Material request status.
- Product/profile.
- Color.
- Supplier.
- Required date.
- Shop/supplier notes.
- Ready status.
- Blocking issue.

### Field Forms And Photos (Jotform)

The Jotform "Jobsite Photo" form is the sole jobsite-photo/geo source ($0
incremental, reuses already-paid tooling): a JobNimbus job picker, the Jotform
Geolocation widget (captures device GPS lat/long at submit, coordinates-only,
works offline in the Jotform Mobile App; not the GeoStamp widget, which needs
internet/falls back to IP, and not the GPS Location widget, which needs a Google
Maps API key), a multi-photo File Upload, and an auto timestamp. Crews use the
Jotform Mobile App in Offline Mode (queues on-device, syncs on reconnect) ->
webhook -> Make -> Google Drive job folder + JobNimbus job + dual-write to the
owned store. If crew job-picking friction tanks photo compliance, the fix is to
improve the Jotform flow (kiosk mode, simpler/auto job-picker), not a new photo
vendor. Jotform also covers genuinely structured forms.

Jotform jobsite-photo record — required fields:

- Jotform submission ID.
- JobNimbus job ID (from the in-form job picker).
- Job number.
- Customer/property reference.
- Assigned user/crew.
- Photo/document references (multi-photo File Upload).
- Device-GPS geotag (Geolocation widget lat/long captured at submit).
- Capture timestamp (auto).
- Make scenario/run ID (webhook -> Make -> Google Drive + JobNimbus + owned store).

Jotform structured-form record — required fields:

- Jotform submission ID.
- Template/form type.
- JobNimbus job ID.
- Job number.
- Customer/property reference.
- Assigned user/crew.
- Form status.
- Completion timestamp.
- Signature status if applicable (drawn signature).
- PDF/output URL.
- Photos/files attached + device-GPS geotag.
- Make scenario/run ID (webhook -> Make -> JobNimbus).

Rules:

- Completed Jotform records are evidence/field records.
- Geo comes from device GPS (Jotform Geolocation widget at submit), not a photo-EXIF workaround: iOS strips photo GPS by default, and direct camera-capture uploads lose metadata regardless - so capture device GPS at submit; don't depend on EXIF.
- The recorded submission date = the **sync** date, not capture time - add an explicit capture-time/Date field; validate on a real device that the Geolocation widget returns **device GPS (not IP)** in offline app mode.
- JobNimbus still owns job stage, owner, and canonical job number.
- QuickBooks still owns invoice/receipt truth.
- Do not create QuickBooks invoices directly from a field form without office review.

### Finance

Required fields:

- Deposit requested.
- Deposit paid.
- Invoice created.
- Invoice paid.
- Payment overdue.
- Payment method: cash, cheque/draft/direct deposit, Interac e-Transfer, Interac debit, credit card, FinanceIT, other.
- Financing interest.
- QuickBooks customer ID.
- QuickBooks invoice ID.

Rules:

- Do not store card, banking, PAD, or financing documents in AI tools or broad CRM notes.
- QuickBooks owns final accounting state.

### Visualization Lead Intent

Required if Renoworks is active:

- Renoworks session ID/link.
- Uploaded home photo or selected model.
- Surface changed: roof, siding/walls, soffit/fascia/gutter if available.
- Product/profile clicked.
- Color clicked.
- Engagement/interest stats if exportable.
- Proposal embed/link state.
- Mapped owned-store envelope ID.
- Mapped JobNimbus job ID after qualification.

Rules:

- Renoworks is lead intent and visual sales data, not job truth.
- Product/color interest must become structured CRM fields if used by sales.
- The proposal may embed/link the visualizer only after privacy and customer-facing content review.

## Event Model

Every event needs an idempotency key. Every event is dual-written to the owned
store (D1+R2) FIRST, then pushed to JobNimbus / downstream consumers.

| Event | Producer | Consumer | Idempotency Key |
|---|---|---|---|
| `lead.created` | Website, ad, phone, GBP, Renoworks (via Make) | Owned store, JobNimbus, instant-ack | source + contact phone/email + created day |
| `call.completed` | AssistAI (or managed Retell on eval failure) | Owned store, JobNimbus | call provider ID |
| `appointment.booked` | AssistAI / Make webhook | Owned store, JobNimbus calendar | appointment ID |
| `job.qualified` | Sales/JobNimbus | Owned store, Folder automation | JobNimbus job ID |
| `measurement.email_received` | RoofRuler email | Make/parser/folder, owned store | email message ID + attachment hash |
| `measurement.uploaded` | Staff/folder watcher | Parser/OCR, owned store | file hash + job ID |
| `form.completed` | Jotform (via Make) | Owned store, JobNimbus, folder | submission ID |
| `proposal.sent` | Proposal tool | Owned store, JobNimbus, folder | proposal ID + version |
| `proposal.accepted` | Proposal/signature | Owned store, JobNimbus, QuickBooks task | proposal ID + version |
| `deposit.paid` | QuickBooks/payment flow | Owned store, JobNimbus | QuickBooks payment ID |
| `materials.ready` | Office/shop | Owned store, JobNimbus | material request ID |
| `job.completed` | Field/JobNimbus | Owned store, QuickBooks/review flow | job ID + completion date |
| `invoice.paid` | QuickBooks | Owned store, JobNimbus | QuickBooks invoice/payment ID |
| `automation.failed` | Make/relay | Dead-letter (Google Sheet + email), Admin | scenario run ID |

Rules:

- **Partial-write repair.** The JobNimbus push is an idempotent, auto-retried job
  keyed on `envelope_id`, carrying a status field (`pending_jn_push` -> `pushed` ->
  `reconciled`). A continuous retry sweep - not the once-daily count - re-drives any
  envelope stuck in `pending_jn_push`. **Instant-ack/MCTB fires off the owned-store
  write, never off the JobNimbus push**, so an acknowledgement still goes out when
  JobNimbus is unavailable. The daily source-vs-landed count is the backstop that
  *detects* gaps; the retry sweep is the mechanism that *repairs* them.
