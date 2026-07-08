# IronWrap OS Final Spec Pack

Date: 2026-06-27 (re-architected 2026-06-28; updated 2026-07-08 for Google Workspace/Drive and Phase 1 source truth).

This pack is the final implementation specification for **IronWrap OS**. It is
not the external metal-layout SaaS idea. It covers the internal system we should
set up, configure, build, test, and ship for IronWrap.

## Final Direction

Consolidate onto JobNimbus and the owned Cloudflare bus. Retire GoHighLevel as the
front door after the experimental/import-rescue paths are replaced. The exhaustive
first-phase build contract is `18-phase-1-source-truth-and-build-contract.md`; it wins
when older provenance docs disagree.

- JobNimbus as the operational CRM, job-truth, and lead front door (customer,
  property, job, stage, task, owner, job number). GHL was experimental/import
  scaffolding; the contact rescue has run, and remaining live routes should be
  retired only after the bus replacement path is proven.
- A thin owned data layer (Cloudflare D1 + R2) is the system of record: Make
  dual-writes every lead/event to it first, then to JobNimbus. JobNimbus is a
  consumer of IronWrap's data, not the owner.
- Make as connector/visibility infrastructure and the Cloudflare Worker as the
  owned bus: canonical lead envelope, dedup, dead-letter, retry, and daily
  source-vs-landed reconciliation so no lead is ever silently lost.
- Instant-response / missed-call-text-back (MCTB) is the headline deliverable:
  every call or form gets a touch in under a minute, 24/7.
- JobNimbus Engage for two-way SMS after A2P/carrier approval; email sends from
  Google Workspace brand mailboxes. IronWrap currently uses `sales@` with
  `info@`/`quote@` aliases, mirrored to Microsoft 365 during migration. JobNimbus
  native email stays unused. A dedicated transactional ESP is deferred.
- Phone AI = native JobNimbus AssistAI, behind a written scored eval gate;
  voicemail-to-lead floor; managed Retell only if AssistAI fails the gate. No
  custom multi-vendor voice stack; Google Voice is not usable (no media API).
- Field photos/geo = the Jotform "Jobsite Photo" form (JobNimbus job picker +
  Geolocation widget capturing device GPS at submit, coordinates-only, offline-capable
  in the Jotform Mobile App; multi-photo upload, auto timestamp, offline-queued →
  webhook → Make → Google Drive + JobNimbus + owned store; $0 incremental). iOS
  strips photo GPS by default, and direct camera-capture uploads lose metadata
  regardless — so capture device GPS at submit; don't depend on EXIF. Jotform for
  structured forms when a workflow needs it. NaturalForms dropped.
- Free Canva + free Affinity for design/marketing graphics — not full Adobe
  Creative Cloud (Canva Pro only if brand-kit/team features are needed).
- Google Drive (Google Workspace) as the first storage authority; QuickBooks for accounting truth.
- Deterministic document extraction first, free OCR second, paid OCR only when
  needed.
- GHL retirement is a cutover, not a rewrite: keep the existing working routes
  until `/ingest/website` is fed by website/server-side forwarding or one Make UI
  bridge, then retire GHL paths. Complete before automated texting goes live: a
  fresh A2P 10DLC + Canadian carrier registration for JobNimbus Engage SMS; maintain
  the CASL consent ledger in JobNimbus going forward.
- Security/access hardening last, after build/config/test, with basic access
  containment from the first production use.

The first deliverable reuses Make (on Core, already subscribed), Google Workspace,
RoofRuler, QuickBooks, JobNimbus, and Jotform, which IronWrap already pays for or
has set up. The first-deliverable incremental is ~CAD $120–220/mo (loaded, incl.
~1.40 FX + GST), and is Engage-driven. The driver is JobNimbus Engage (~CAD
$90–140 loaded with SMS usage); the rest is small — Twilio DID + usage (~CAD
$5–30) and the A2P monthly campaign fee (~CAD $5–15). Email = Google Workspace
and storage = Google Drive Shared Drives; Make is on the existing Core plan, and
the bus can run on Cloudflare Workers (D1/R2/Workers ≈ $0). A dedicated ESP is
deferred, design = $0 (free Canva + free Affinity). AssistAI minutes are a Phase-2 (post-eval) cost (~CAD $35–70
loaded when live), not part of the first-deliverable incremental. One-time setup
~CAD $700–2,100 (A2P registration, DID provisioning, Make/Workers bus build
labor, domain auth, form re-pointing, training). Renoworks, Paradigm, CallRail,
paid OCR, DocuSeal, and any custom voice stack remain gated until a tested workflow
proves the need.

## Pack Index

1. [Final Decisions](./00-final-decisions.md)
2. [System Architecture](./01-system-architecture.md)
3. [Build And Configuration Plan](./02-build-and-configuration-plan.md)
4. [Data Model And Source Of Truth](./03-data-model-and-source-of-truth.md)
5. [Core Workflows And SOPs](./04-core-workflows-and-sops.md)
6. [Phone AI Automation Layer](./05-ai-receptionist-and-booking-agent.md)
7. [Integrations And Automations](./06-integrations-and-automations.md)
8. [Documents, Measurements, Proposals](./07-documents-measurements-proposals.md)
9. [Costs, Vendors, And Buy Gates](./08-costs-vendors-buy-gates.md)
10. [Security, Privacy, And Canadian Compliance](./09-security-privacy-compliance.md)
11. [QA, Launch, And Acceptance](./10-qa-launch-acceptance.md)
12. [Owner Signoff Checklist](./11-owner-signoff-checklist.md)
13. [Implementation Backlog](./12-implementation-backlog.md)
14. [Source Verification Notes](./13-source-verification-notes.md)
15. [Task 1 Coverage Audit](./14-task1-coverage-audit.md)
16. [First Deliverable Existing-Stack Plan](./15-first-deliverable-existing-stack-plan.md)
17. [Website Funnels & Qualified-Lead Capture](./16-website-funnels-qualified-leads.md)
18. [US Best-Practice Cross-Reference](./17-us-best-practices-cross-reference.md)
19. [Phase 1 Source Truth And Build Contract](./18-phase-1-source-truth-and-build-contract.md)

## What Counts As Shipped

Task 1 is shipped only when:

- Leads from website, phone, SMS, ads, referrals, and manual entry land in one
  queue via the Make bus.
- Every lead is dual-written to the owned store and JobNimbus, the instant-ack
  fires, and the daily reconciliation is green (no silent lead loss).
- Website and service-page leads retain source page, service intent, location,
  attachment, and next-step data.
- Qualified leads create/update JobNimbus without duplicates.
- JobNimbus owns the canonical job number and job stage.
- Job folders are created once and linked back to JobNimbus and the owned store.
- Appointment, proposal, deposit, material request, completion, invoice, and
  review paths work end to end.
- Default field forms/photos (Jotform "Jobsite Photo" form, offline device-GPS)
  can be dispatched/completed, archived, and reflected back into JobNimbus/Google
  without manual retyping.
- AssistAI (behind the eval gate) can qualify, book, update CRM records,
  summarize, trigger follow-up, and escalate; MCTB covers missed/after-hours calls.
- GHL lead routes are retired after replacement proof; A2P 10DLC + Canadian
  carrier registration is approved, the CASL consent ledger is live in JobNimbus,
  and website forms post to the bus.
- Staff can run test jobs without developer support.
- Every critical automation has an owner, test record, kill switch, failure alert,
  and dead-letter path.
- Final security/access hardening is complete.
- Canadian privacy, CASL, call-recording, DNCL, retention, and vendor-processing
  gates are approved.

## Build Governance

Each implementation slice must end with:

- Configuration/code changed.
- Test record created.
- Result checked in JobNimbus / owned store / storage / QuickBooks as applicable.
- Dual-write and daily reconciliation verified.
- Failure path tested.
- SOP updated if staff behavior changes.
- Owner signoff captured for production-sensitive workflow changes.
