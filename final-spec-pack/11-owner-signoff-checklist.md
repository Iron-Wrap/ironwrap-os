# 11 - Owner Signoff Checklist

Use this as the final acceptance checklist with IronWrap.

## Business Decisions

- [ ] GHL trial declined (trial-evaluated only, never used in production — nothing to migrate); JobNimbus is the operational CRM / job-truth / lead front door (fronted by Make bus + instant-ack branch).
- [ ] Owned Cloudflare D1+R2 data layer is the system of record; JobNimbus is a consumer (dual-write FIRST, then push to JobNimbus).
- [ ] JobNimbus owns canonical job number.
- [ ] Make is treated as critical infrastructure, not plumbing (dead-letter, dedup, daily reconciliation, named weekly owner).
- [ ] Instant-response / missed-call-text-back (MCTB) accepted as the headline deliverable (<60s touch, 24/7).
- [ ] QuickBooks owns accounting truth.
- [ ] OneDrive (Microsoft 365) selected as storage authority, unless owner explicitly overrides.
- [ ] Renoworks deferred unless visualizer-led selling is approved.
- [ ] NaturalForms dropped; Jotform "Jobsite Photo" form = sole jobsite photo/geo capture ($0 incremental; device-geolocation widget + offline mobile capture; coordinates-only, not photo EXIF). Jotform for other structured forms deferred until a workflow hurts.
- [ ] Design = free Canva + free Affinity (Designer/Photo/Publisher, Canva-owned, went 100% free Oct 2025); Canva Pro (~CAD $18/mo) only if brand-kit/team features needed; full Adobe Creative Cloud rejected.
- [ ] Paradigm deferred until material request flow is stable.
- [ ] Phone AI = JobNimbus AssistAI (P0) behind eval gate; managed Retell only on eval failure; 4-vendor custom voice stack killed.
- [ ] Call attribution deferred (UTM + manual Lead Source + one tracked number); CallRail only when paid ads start.
- [ ] No GHL migration needed — GHL was trial-evaluated only and is being declined before any production use; end the trial.
- [ ] WooCommerce/B2C store deferred from Task 1.
- [ ] Calgary expansion structure deferred unless owner explicitly adds it to Task 1.

## Configuration

- [ ] JobNimbus boards/stages/fields configured.
- [ ] Make bus configured (canonical lead envelope {source, contact, job_ref, payload, ts}, dual-write to owned store FIRST, then JobNimbus).
- [ ] Owned Cloudflare D1+R2 store stood up; dual-write live and verified.
- [ ] Make error-handler → dead-letter (Google Sheet + email) and phone/email-keyed dedup configured.
- [ ] Daily reconciliation (source-event counts vs records landed) running; named weekly owner assigned.
- [ ] JobNimbus Engage configured for 2-way SMS; Microsoft 365 brand mailboxes (SPF/DKIM/DMARC) for outbound email + bounce monitoring; dedicated ESP deferred; JobNimbus native email unused.
- [ ] Make scenarios audited and cleaned.
- [ ] Jotform "Jobsite Photo" form live as default (JobNimbus job picker + Geolocation widget for device GPS + multi-photo upload + auto timestamp) → webhook → Make → OneDrive job folder + JobNimbus + owned store; crew on Jotform Mobile App offline mode.
- [ ] Folder naming and subfolders approved.
- [ ] QuickBooks status visibility tested.
- [ ] Proposal template approved.
- [ ] Contract/signature platform decision approved (JobNimbus native e-sign / HTML+PDF first; if it fails the workflow, adopt DocuSeal — open-source, managed Cloud ~CAD $30/mo or one self-hosted container, audit-trail PDF valid in Canada, webhooks back through Make → JobNimbus; this retires the PandaDoc/DocuSign line).
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
- [ ] Instant-ack/MCTB fires off the owned-store write (never the JobNimbus push), on a pipe separate from nurture: interim pre-A2P channel = prospect email (Microsoft 365 brand mailbox) + owner phone/SMS alert holding the <60s touch; prospect-SMS leg switches on at A2P approval.
- [ ] Qualified job to folder works.
- [ ] Appointment to JobNimbus works.
- [ ] Proposal sent/accepted updates work.
- [ ] Deposit/payment status works.
- [ ] Moneris/Interac/credit-card policy approved if displayed to customers.
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
- [ ] A2P 10DLC + Canadian carrier registration for JobNimbus Engage SMS APPROVED — fresh registration (~1-3 wk lead time), prerequisite before any automated texting, not a config flip and not a re-registration from GHL.
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
- [ ] Jotform "Jobsite Photo" → Make → OneDrive/JobNimbus/owned-store photo+geo test passed (incl. offline-queue sync).
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

## Build-Out (No Migration — GHL Trial Declined)

- [ ] GHL was trial-evaluated only and is being declined before any production use; nothing to migrate — end the trial.
- [ ] Written JobNimbus all-in quote obtained.
- [ ] All-in CAD TCO table reviewed. First-deliverable incremental ≈ CAD $120-220/mo loaded (incl. ~1.40 FX + GST) — driver is JobNimbus Engage (~CAD $90-140 with SMS usage); Twilio DID + usage ~CAD $5-30, Make is the existing Core seat (~CAD $13, already subscribed) or the bus on Cloudflare Workers ~CAD $20-30, A2P monthly campaign fee ~CAD $5-15; Cloudflare D1/R2/Workers ≈ $0, email = existing Microsoft 365 brand mailboxes ($0 incremental; dedicated ESP deferred), storage = existing OneDrive (Microsoft 365) ($0 incremental), design = $0 (free Canva + free Affinity). AssistAI minutes are a Phase-2 (post-eval) cost (~CAD $35-70 loaded when live), not part of the first-deliverable incremental. One-time setup ~CAD $700-2,100. "$0 new vendor setup" is false (Cloudflare, the owned Twilio number, and — if adopted — DocuSeal are new vendor lines). GHL was never adopted, so this avoids ~CAD $135-415/mo of GHL cost; frame as "simpler, more portable, avoids GHL's cost," not a dramatic saving.
- [ ] Engage A2P 10DLC + Canadian carrier registration filed first and approved before any automated texting.
- [ ] Business phone number provisioned/owned in Twilio for AssistAI/Engage (portable by design).
- [ ] CASL consent ledger maintained in JobNimbus going forward (no historical export needed).
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
