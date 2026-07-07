# 14 - Task 1 Coverage Audit

Date: 2026-06-27

This audit checks the final spec pack against the original Task 1 conversation
and the existing v9.1 brainstorm documents. The separate sellable SaaS idea for
metal panel layout is not part of this pack because the current scope is Task 1:
IronWrap's internal operating system.

## Original Task 1 Coverage

| Original Topic | Covered In | Status |
|---|---|---|
| Internal system for IronWrap with automations | README, 01, 02, 06, 12 | Covered |
| JobNimbus as operational CRM / job-truth spine (lead front door) | 00, 02, 03, 04, 06 | Covered; JobNimbus is the spine fronted by the Make bus + instant-ack |
| GoHighLevel for lead intake, nurture, SMS, reviews | 00, 02, 03, 04, 06 | **Removed/replaced** — GHL is experimental/legacy scaffolding; retire remaining routes after replacement proof. Roles are handled by JobNimbus + Engage (SMS) + Google Workspace brand mailboxes |
| Owned system of record (Cloudflare D1 + R2, dual-write FIRST) | 00, 01, 02, 03, 11, 12 | Added; canonical lead envelope `{source, contact, job_ref, payload, ts}`; JobNimbus is a consumer of IronWrap data, not the owner |
| Make as critical infrastructure (not plumbing) | 00, 01, 02, 03, 06, 10 | Covered; mandatory error-handler→dead-letter (Sheet+email), idempotency/dedup on phone/email, daily source-vs-landed reconciliation, raw pre-Make storage, named weekly owner |
| Instant-response / missed-call-text-back (MCTB) | 00, 04, 05, 06, 10 | Added as the headline deliverable; unanswered call→SMS ~10s, web form→prospect SMS + owner alert on a pipe separate from nurture; <60s human-or-AI touch, 24/7 |
| Google Drive folder automation | 00, 02, 03, 06 | Covered; already built (experimental, in Make) — migrate to JN spine; Google Drive (Google Workspace) is the first-deliverable default |
| QuickBooks accounting | 00, 03, 04, 06, 08 | Covered |
| Review chasing | 04, 06, 10, 11 | Covered; JobNimbus automation → Google review link via Google Workspace brand mailboxes / Engage |
| Payment chasing | 04, 08, 10, 11 | Covered |
| Booking agent | 02, 04, 05, 10 | Covered; books natively into the JobNimbus calendar |
| Phone AI automation layer | 05, 06, 08, 09, 10, 11, 12 | Covered; JobNimbus AssistAI is P0 behind a written scored eval gate (≥85% capture+routing, zero catastrophic), owner-set minute cap (budget alert), voicemail→JN-lead floor; managed Retell only if eval fails; 4-vendor stack killed |
| Field forms / structured field capture | 00, 02, 04, 06, 08, 11, 15 | **NaturalForms removed/replaced** — default ($0 incremental): a Jotform "Jobsite Photo" form (JN job picker + Geolocation widget capturing device GPS at submit, offline-capable via Jotform Mobile App) is the sole jobsite-photo/geo tool; iOS strips photo GPS by default, and direct camera-capture uploads lose metadata regardless — so capture device GPS at submit, don't depend on EXIF; if capture friction appears, fix the Jotform flow (kiosk mode, simpler/auto job-picker) rather than adding a vendor; Jotform also covers genuinely structured forms, deferred until a workflow hurts; a Jotform "Completion Form" field-capture workflow is already built (experimental, in Make) — migrate to JN spine |
| Design tooling | 00, 02, 07, 08 | Added; free Canva + free Affinity (Affinity went 100% free Oct 2025); Canva Pro (~CAD $18/mo) only if brand-kit/team features needed; full Adobe Creative Cloud rejected |
| Carrier/identity setup | 00, 02, 09, 10, 11, 12 | Added. Independent prerequisites: fresh A2P 10DLC + Canadian carrier registration for JobNimbus Engage SMS; maintain the CASL consent ledger in JobNimbus going forward; verify existing website forms' current post destinations and point them at the bus |
| Paradigm for shop/production | 00, 02, 06, 08, 13 | Covered as deferred bridge |
| Renoworks visualization | 00, 03, 06, 07, 08, 10 | Covered as gated add-on |
| Website visitor uploads photo and plays with roof/walls/colors | 03, 07, 09, 10 | Covered if Renoworks active |
| Website funnels and qualified-lead capture | 03, 10, 12, 16, 17 | Covered |
| Google Business Profile and local lead trust | 02, 06, 08, 10, 12, 17 | Added from current best-practice audit |
| UTM/source/call attribution | 03, 06, 10, 12, 16, 17 | Added from current best-practice audit |
| Renoworks shares product/color/engagement stats | 03, 06, 07, 10 | Covered if exportable |
| 3D models / selected home model | 03, 07 | Covered if Renoworks active |
| Embed or link visualizer in proposal/PDF/HTML | 04, 07, 10 | Covered as gated option |
| PDF/proposal export | 04, 07, 10, 12 | Covered |
| Measurement reports and document parsing | 07, 10, 12 | Covered; RoofRuler intake already built (experimental, in Make — AI Extract + legacy OneDrive) — migrate carefully to JN/Google Drive spine |
| Field forms and documents | 04, 11, 12 | Covered |
| Material request, supplier, shop flow | 04, 06, 12 | Covered |
| Payment methods, QBO Payments, FinanceIT | 08, 09, 10, 11, 13 | Covered as validation gates; Moneris deferred unless approved later |
| Security/access after build/config/test | 02, 09, 10, 11 | Covered, final phase |
| Separate SaaS for North America installers/suppliers | 00, 13, this file | Explicitly excluded from Task 1 |

## Existing v9.1 Doc Coverage

| v9.1 Detail | Final Pack Treatment |
|---|---|
| Residential, commercial, shop/supply, and raw steel divisions | Added to business context, data model, AI routing, and backlog |
| Owner/commercial sales, residential rep, receptionist/materials associate roles | Added to business context |
| 18% close-rate and lost-lead risk | Kept as planning context, not guaranteed current truth |
| 60 RoofRuler reports/month | Treated as expansion volume proof, not Task 1 spend |
| Renoworks CAD setup and annual cost | Included in cost gates |
| Paradigm setup/monthly cost | Included as deferred ERP/shop bridge |
| NaturalForms per-user planning cost | Obsolete — NaturalForms dropped; replaced by the default Jotform "Jobsite Photo" form (photos/geo, $0 incremental) + Jotform (structured, deferred) |
| AI receptionist setup/monthly planning cost | Included in pricing notes |
| 12 forms/document types | Added to Workflow 5B |
| Custom proposal tool | Covered as JobNimbus e-sign / HTML / PDF proposal first; if it fails the workflow, adopt DocuSeal (open-source) as the escape hatch — retires the PandaDoc/DocuSign line |
| Contract platform open decision | Added as build and QA gate; JobNimbus native e-sign first, then DocuSeal (open-source, audit-trail PDF valid in Canada; webhooks in the free edition) — permanently retires PandaDoc/DocuSign |
| Material list design open decision | Added as build and QA gate |
| Moneris payment options | Deferred; QBO Payments is the default invoice path |
| FinanceIT financing | Added as gated financing/payment option |
| WooCommerce/hosting | Explicitly deferred from Task 1 |
| Calgary expansion | Explicitly deferred unless owner adds to Task 1 |
| AppliCad XML structured measurement data | Added to measurement parsing spec |
| Image-heavy/sparse siding/gutter/soffit reports | Added to OCR/human review requirement |

## Remaining Owner Decisions

These are not gaps. They are decisions IronWrap must make before the related
workflow goes live.

1. Confirm Google Drive (Google Workspace) as the storage authority, unless owner explicitly overrides.
2. Choose contract/signature path: JobNimbus native e-sign / HTML+PDF first; if it fails the workflow, adopt DocuSeal (open-source, AGPLv3; managed DocuSeal Cloud ~CAD $30/mo or one self-hosted container) — legally valid in Canada (audit-trail PDF; PIPEDA / Alberta ETA recognize ordinary commercial e-signatures), webhooks in the free edition fire completion back through Make → JobNimbus. This permanently retires the PandaDoc/DocuSign line.
3. Choose material-list format: one multi-scope list or separate per-scope lists.
4. Approve AssistAI pilot scope and pass the written scored eval gate (≥85% capture+routing, zero catastrophic failures); enforce a hard monthly minute cap / budget alert (verify AssistAI's native cap support — it bills pure-metered at ~$0.15/min; if there is no native cap, enforce via usage monitoring + an overage alert; cap = owner-set, e.g. ~500 min/mo) to keep the spam/robocall buffer; confirm voicemail→JN-lead floor.
5. Decide whether Renoworks is part of the first paid production expansion.
6. Approve which payment methods appear in proposals.
7. Approve FinanceIT wording and dealer economics before showing financing.
8. Retire remaining GHL routes after replacement proof, and approve the independent carrier/identity setup: fresh A2P 10DLC + Canadian carrier registration started, CASL consent ledger maintained in JobNimbus going forward.
9. Add Paradigm only after the manual material workflow is stable; add Jotform only when a structured field workflow hurts.
10. Approve whether Local Services Ads or paid traffic should be tested after attribution and response-time QA pass (add CallRail only when paid ads start).

## Audit Result

No Task 1 topic from the original recap is intentionally missing from the final
spec pack now. The only major topic excluded is the separate SaaS product idea,
because the current instruction is to focus only on Task 1.
