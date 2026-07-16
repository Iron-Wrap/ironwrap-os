# 09 - Security, Privacy, And Canadian Compliance

> **Current authority (2026-07-16):** This retained compliance record is planning/provenance.
> [`18-phase-1-source-truth-and-build-contract.md`](./18-phase-1-source-truth-and-build-contract.md)
> prevails on conflict: Worker/D1/R2 is the first write, the operating core is Frappe-only, the
> Field Companion PWA is primary, and JobNimbus, GHL, Make, and Jotform are bridges. Legacy
> `erpnext-*` names do not authorize ERPNext or DocuSeal.

## Position

The system must be built compliant-by-design for Canadian operations. This pack
does not replace legal counsel. It defines the go-live gates we must satisfy
before production launch.

Official sources checked on 2026-06-27:

- OPC Canada PIPEDA fair information principles.
- Alberta PIPA.
- CRTC CASL guidance.
- National DNCL.
- OPC call-recording guidance.
- Alberta/OIPC breach guidance.

## Compliance Map

| Area | Requirement | Build Gate |
|---|---|---|
| Consent and notice | Customers must know why information is collected and how it is used | Website form, call script, SMS/email wording approved |
| Limited collection | Collect only information needed for the job | Field allowlist per integration |
| Limited use | Use personal information only for stated purposes | No broad sync into unrelated tools |
| Safeguards | Protect personal information with reasonable security | Named users, MFA, least privilege, secret storage |
| Access and correction | Customer information must be retrievable/correctable | Job/customer data map documented |
| Service providers | IronWrap remains accountable for vendors | Vendor register and terms review |
| Cross-border processing | Outside-Canada processors (Claude/OCR for measurement docs, Google Workspace/Drive, the temporary Microsoft 365 mirror, Cloudflare, Jotform, Make) handle data — Cloudflare (D1/R2) and Make hold canonical PII, the brand mailboxes handle lead PII; requires disclosure + written agreements | Privacy notice names outside-Canada processors; signed DPAs/ZDR on file (incl. Cloudflare, Make, Google Workspace, and Microsoft while the mirror remains active) |
| Breach response | Record and report qualifying breaches | Breach playbook approved |
| A2P 10DLC | SMS via Engage requires registered campaign/brand + Canadian carrier registration before any messaging. US framework; CA carriers (Rogers/Bell/Telus) filter unregistered A2P but don't run 10DLC per se; numbers bought before 2025-03-26 can send CA→CA unregistered; brand registration needs the CRA Business Number; ~$4 one-time low-volume registration | Fresh registration approved before any automated texting |
| CASL | Commercial electronic messages require consent, identification, unsubscribe | Per-contact consent ledger live in JobNimbus; unsubscribe handling tested |
| DNCL | Telemarketing-style outbound calls must respect DNCL/internal DNC | Outbound call policy approved |
| Call recording | Call recording/transcription needs notice and purpose | Start-of-call notice approved |

## Data Classification

| Class | Examples | Handling |
|---|---|---|
| Public | Website copy, public service list | Normal |
| Customer personal information | Name, phone, email, address, job details, photos, uploaded home visualizer media | Approved systems only |
| Sensitive operational | Insurance claim details, complaints, warranty issues | Limited access |
| Finance sensitive | Card/bank/PAD/financing docs | QuickBooks/payment processor only, not AI logs |
| Secrets | API keys, passwords, webhooks | Password manager only |

## AI And Privacy Rules

AI tools must not receive:

- Payment card details.
- Bank/PAD details.
- Financing documents.
- Unnecessary customer documents.
- Home photos or visualizer media unless the AI use and vendor are explicitly approved.
- Legal disputes.
- Warranty decisions.
- Insurance determinations beyond approved intake questions.

AI tools may receive:

- Customer contact details needed for the call if vendor is approved.
- Address/scope needed to book or qualify.
- Approved FAQ and service-area info.
- De-identified summaries for testing.

## Call Recording And AI Notice

Approved call opening must cover:

- The caller is speaking with an AI assistant if AI is used.
- The call may be recorded/transcribed if enabled.
- Purpose: scheduling, lead intake, service follow-up, quality, and recordkeeping.
- Caller can ask for a human.

No production AI call launch until wording is approved.

## CASL Requirements For SMS/Email

A2P 10DLC + Canadian carrier registration is a prerequisite, not a config flip.
This is a fresh registration for JobNimbus Engage SMS, not a re-registration from
any prior tool. Do not start any automated texting until the campaign is approved.

A2P 10DLC is a US framework; Canadian carriers (Rogers/Bell/Telus) filter
unregistered A2P traffic but don't run 10DLC per se. Numbers provisioned before
2025-03-26 can send CA→CA without registration; brand registration now requires
the CRA Business Number; low-volume standard registration is ~$4 one-time.

Before marketing, nurture, or review sequences:

- Store consent status.
- Store consent source/date if available.
- Each brand identifies itself (valid sender ID + physical mailing address) in
  every CEM — IronWrap Exteriors and iRoof Alberta each send under their own
  identification.
- Include unsubscribe/stop handling.
- Honour unsubscribe within 10 business days; stop messages after opt-out.
- Stop review pressure if customer complains or disputes invoice/job.

SMS sent through Engage and outbound nurture/review email through the ESP are
commercial electronic messages (CEMs) and require express or valid implied
consent before sending. Implied consent has a clock and does not authorize
unrelated marketing.

Transactional messages such as appointment confirmations still need sensible
handling and should not become hidden marketing.

### Per-Contact CASL Consent Ledger (System Of Record)

JobNimbus holds the authoritative per-contact consent ledger maintained going
forward; every consent state is dual-written through the Make bus to the owned
data layer (D1/R2) like all other lead data, so consent provenance survives any
future vendor change. GHL remains legacy scaffolding only; retire remaining routes
after replacement proof.

Each contact record must carry:

- Consent basis (express / implied / inquiry / none).
- Consent date and expiry (implied consent has a clock).
- Consent source (website form, phone, referral, import).
- Channel scope (SMS, email, both) and message-type scope (transactional vs CEM).
- Unsubscribe/opt-out status, date, and channel.

GHL was experimental scaffolding, not the target system. The contact rescue has run; any
remaining GHL lead routes are retired only after the replacement bus path is proven. The consent
ledger is built and maintained in JobNimbus going forward.

## Cross-Border Processing And Vendor Agreements

Several processors operate outside Canada (primarily the US): Claude (Anthropic)
and the OCR provider (for measurement docs), Google Workspace/Drive, Microsoft 365
while the migration mirror remains active, Cloudflare (D1/R2/Pages), Jotform, and
Make. The jobsite-photo path runs through Jotform (already listed above). The Google
and temporary Microsoft mailboxes are also processors — they handle lead PII
(prospect name/email/contact details in instant-ack, confirmation, and nurture mail)
and belong on the DPA/vendor-register list. Cloudflare (D1/R2) and
Make hold the canonical lead/customer PII — the owned data layer and the
integration bus — so they are not edge-only processors and require DPAs on the
same footing as the rest. This requires:

- Privacy notice that names outside-Canada processing and the categories of data
  involved.
- A written DPA (data processing agreement) with each outside-Canada processor,
  with zero-data-retention (ZDR) terms where the vendor offers it — required for the
  Claude/OCR path that reads customer measurement documents, and on file for
  Cloudflare and Make, which store canonical PII, and for Google Workspace plus
  Microsoft 365 while the mirror remains active.
- Vendor register entry per processor — incl. Google Workspace and the temporary
  Microsoft mirror — (location, data handled, DPA/ZDR status).

## DNCL / Outbound Call Rules

Before outbound telemarketing-style campaigns:

- Check National DNCL obligations.
- Maintain internal do-not-call list.
- Honor human requests not to be called.
- Keep call purpose and source documented.

## Retention Rules

Define before launch:

- Lead records.
- Call recordings.
- Transcripts.
- SMS/email history.
- Photos.
- Renoworks/home visualizer uploads if active.
- Measurement reports.
- Proposals/contracts.
- Accounting records.
- Warranty/service records.

Default:

- Keep what is needed for job delivery, accounting, warranty, legal, and customer service.
- Delete or archive what is no longer needed.
- Limit transcript/recording access.

## Payment Compliance Notes

- Card data must stay inside QuickBooks Payments or another explicitly approved payment processor.
- Bank/PAD/direct-deposit details must not enter AI logs, broad CRM notes, or Make logs unless explicitly required and approved.
- FinanceIT applications and financing documents are sensitive and should stay in the approved financing/accounting flow.
- AI and staff scripts must not imply financing approval, insurance approval, or guaranteed premium discounts.
- Customer-facing payment and financing wording must be approved before proposal launch.

## Final Security Hardening Phase

After build/config/test, before launch:

1. Rotate every credential pasted in chat or used during testing.
2. Revoke old sessions and stale API keys.
3. Replace shared logins with named users.
4. Enable MFA where available.
5. Create service/API accounts where supported.
6. Store secrets in password manager.
7. Set least-privilege roles.
8. Lock down JobNimbus, Make, the owned data layer (Cloudflare D1/R2), QuickBooks, storage, AssistAI/voice, ESP, OCR, Jotform, proposal tools.
9. Confirm field allowlists per integration.
10. Confirm no finance-sensitive data leaks into AI/transcripts/logs.
11. Approve vendor register and privacy notice.
12. Confirm call-recording, CASL, DNCL, retention, and breach rules.
13. Confirm kill switches and owners.

## Go-Live Compliance Gate

No production launch until these are complete:

- Privacy notice reviewed.
- Website form consent language approved.
- AI/call recording notice approved.
- CASL consent/unsubscribe tested; per-contact consent ledger live in JobNimbus + dual-written.
- A2P 10DLC + Canadian carrier registration approved before any automated texting.
- DNCL/internal DNC policy approved for outbound calls.
- Vendor register complete.
- Cross-border/service-provider notice complete; signed DPAs/ZDR with US processors on file.
- Retention schedule approved.
- Breach response steps documented.
- Access hardening complete.
