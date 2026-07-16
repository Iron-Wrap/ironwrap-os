# 11 - Owner Signoff Checklist

> **Current authority (2026-07-16):** This retained signoff record is planning/provenance.
> [`18-phase-1-source-truth-and-build-contract.md`](./18-phase-1-source-truth-and-build-contract.md)
> prevails on conflict: Worker/D1/R2 is the first write, the operating core is Frappe-only, the
> Field Companion PWA is primary, and JobNimbus, GHL, Make, and Jotform are bridges. Legacy
> `erpnext-*` names do not authorize ERPNext or DocuSeal.

Use this as the final acceptance checklist with IronWrap.

## Business Decisions

- [ ] Remaining GHL routes retired after replacement proof; JobNimbus remains only a temporary bridge where owned IronWrap OS slices are not ready.
- [ ] Owned Cloudflare D1+R2 data layer is the system of record; JobNimbus/GHL are consumers only when still needed.
- [ ] IronWrap OS owns job truth; JobNimbus job number/stage can bridge until owned production records replace that slice.
- [ ] Worker bus is primary infrastructure; Make is bridge/observability only where useful (dead-letter, dedup, daily reconciliation, named owner remain mandatory).
- [ ] Instant-response / missed-call-text-back (MCTB) accepted as the headline deliverable (<60s touch, 24/7).
- [ ] QuickBooks owns accounting truth.
- [ ] Google Drive (Google Workspace) selected as storage authority, unless owner explicitly overrides.
- [ ] Renoworks deferred unless visualizer-led selling is approved.
- [ ] NaturalForms dropped; Field Companion PWA is the primary jobsite photo/geo capture path. Jotform remains a temporary structured-intake bridge until PWA real-device proof is complete.
- [ ] Design = free Canva + free Affinity (Designer/Photo/Publisher, Canva-owned, went 100% free Oct 2025); Canva Pro (~CAD $18/mo) only if brand-kit/team features needed; full Adobe Creative Cloud rejected.
- [ ] Paradigm deferred until material request flow is stable.
- [ ] Phone AI = JobNimbus AssistAI (P0) behind eval gate; managed Retell only on eval failure; 4-vendor custom voice stack killed.
- [ ] Call attribution deferred (UTM + manual Lead Source + one tracked number); CallRail only when paid ads start.
- [ ] GHL and JobNimbus are declined as keepers for new work; import-rescue/legacy routes are disabled only after replacement proof through the owned Worker/Frappe path.
- [ ] WooCommerce/B2C store deferred from Task 1.
- [ ] Calgary expansion structure deferred unless owner explicitly adds it to Task 1.

## Configuration

- [ ] JobNimbus bridge boards/stages/fields configured only for the slices still running there.
- [ ] Worker bus configured (canonical lead envelope {source, contact, job_ref, payload, ts}, write to owned store FIRST, then bridge systems only when needed).
- [ ] Owned Cloudflare D1+R2 store stood up; dual-write live and verified.
- [ ] Make error-handler → dead-letter (Google Sheet + email) and phone/email-keyed dedup configured.
- [ ] Daily reconciliation (source-event counts vs records landed) running; named weekly owner assigned.
- [ ] JobNimbus Engage configured for 2-way SMS only if it remains the temporary SMS bridge; Google Workspace brand mailboxes (SPF/DKIM/DMARC) for outbound email + bounce monitoring; dedicated ESP deferred; JobNimbus native email unused.
- [ ] Make scenarios audited and cleaned.
- [ ] Jotform "Jobsite Photo" form live as default (JobNimbus job picker + Geolocation widget for device GPS + multi-photo upload + auto timestamp) → webhook → Make → Google Drive job folder + JobNimbus + owned store; crew on Jotform Mobile App offline mode.
- [ ] Folder naming and subfolders approved.
- [ ] QuickBooks status visibility tested.
- [ ] Proposal template approved.
- [ ] Contract/signature platform decision approved: owned Proposal Evidence Pack first as it matures; JobNimbus native e-sign / HTML+PDF can bridge until JobNimbus retires; DocuSeal is retired permanently (AGPL); the commercial fallback is a proprietary e-sign API (e.g. Dropbox Sign or the DocuSign API).
- [ ] Material list design approved.
- [ ] Measurement/document upload convention approved.

## Phone AI Pilot

- [ ] AI call notice approved.
- [ ] Knowledge base approved.
- [ ] Escalation triggers approved.
- [ ] AssistAI written scored eval gate passed (≥85% capture+routing, zero catastrophic failures) — OR managed-Retell escalation decision documented.
- [ ] AssistAI books natively into the JobNimbus calendar (creates a lead record, not just a calendar event).
- [ ] Hard monthly minute cap / budget alert enforced for AssistAI (verify native cap support — it bills pure-metered at ~$0.15/min; if there is no native cap, enforce via usage monitoring + an overage alert). Cap = owner-set, e.g. ~500 min/mo; keeps the spam/robocall buffer.
- [ ] Voicemail floor fallback (voicemail → JobNimbus lead + human callback) tested.
- [ ] Phone DID owned in Twilio so AssistAI → Retell swap is config-only.
- [ ] Post-call follow-up trigger tested.
- [ ] Ilya approved recordings/summaries.
- [ ] Human transfer tested.

## Automations

- [ ] New lead dual-writes to owned store, then lands in JobNimbus via an idempotent `envelope_id`-keyed push; a continuous retry sweep self-heals a transient JobNimbus outage (daily count only detects gaps).
- [ ] Instant-ack/MCTB fires off the owned-store write (never the JobNimbus push), on a pipe separate from nurture: interim pre-A2P channel = prospect email (Google Workspace brand mailbox) + owner phone/SMS alert holding the <60s touch; prospect-SMS leg switches on at A2P approval.
- [ ] Qualified job to folder works.
- [ ] Appointment to JobNimbus works.
- [ ] Proposal sent/accepted updates work.
- [ ] Deposit/payment status works.
- [ ] QuickBooks Payments / Interac / credit-card policy approved if displayed to customers; Moneris deferred unless an in-person terminal path is approved.
- [ ] FinanceIT wording and dealer economics approved if displayed to customers.
- [ ] Material request flow works.
- [ ] Completion/invoice/review flow works.
- [ ] Failure alerts work.
- [ ] Kill switches documented.

## Compliance And Security

- [ ] Privacy policy published.
- [ ] Privacy notice reviewed.
- [ ] Website/form consent language approved.
- [ ] CASL unsubscribe handling tested.
- [ ] A2P 10DLC + Canadian carrier registration for JobNimbus Engage SMS APPROVED — fresh registration, prerequisite before any automated texting, not a config flip and not a re-registration from GHL.
- [ ] DNCL/internal DNC handling approved for outbound calls.
- [ ] Vendor register complete.
- [ ] Cross-border processing notice decision complete.
- [ ] Retention schedule approved.
- [ ] Breach response steps documented.
- [ ] Pasted/shared credentials rotated.
- [ ] Shared logins replaced with named users where possible.
- [ ] MFA enabled where possible.
- [ ] API/service accounts scoped.
- [ ] Password manager holds production secrets.

## QA

- [ ] Website lead test passed.
- [ ] Manual lead test passed.
- [ ] Duplicate lead test passed.
- [ ] Phone AI test passed.
- [ ] Appointment test passed.
- [ ] Folder test passed.
- [ ] Jotform "Jobsite Photo" → Make → Google Drive/JobNimbus/owned-store photo+geo test passed (incl. offline-queue sync).
- [ ] Daily reconciliation (source-vs-landed) test passed.
- [ ] Instant-ack / MCTB test passed on every abandon/after-hours path.
- [ ] Email deliverability seed test passed.
- [ ] Proposal test passed.
- [ ] Contract/signature test passed.
- [ ] Measurement test passed.
- [ ] Material-list test passed.
- [ ] Payment-method display/reconciliation test passed.
- [ ] Deposit/invoice test passed.
- [ ] Material request test passed.
- [ ] Completion/review test passed.
- [ ] Automation failure test passed.

## Build-Out (Bridge Spend Controlled)

- [ ] Remaining GHL routes retired after replacement proof.
- [ ] Written JobNimbus/GHL all-in bridge cost obtained before renewing or expanding either service.
- [ ] TCO table reviewed with the current rule: pay only for delivery rails and temporary bridges that are cheaper than owning the risk now. Do not buy duplicate JobNimbus/GHL modules while the owned estimator/Hermes/ERPNext path is being proven.
- [ ] Engage A2P 10DLC + Canadian carrier registration filed first and approved before any automated texting.
- [ ] Business phone number provisioned/owned in Twilio for AssistAI/Engage (portable by design).
- [ ] CASL consent ledger maintained in JobNimbus going forward.
- [ ] Existing website forms' current post destinations verified and pointed at the Make bus.
- [ ] "Messaging is live" smoke test passed.

## Final Launch Approval

Owner:

```text
Name:
Date:
Approved for production launch: Yes / No
Exceptions:
```
