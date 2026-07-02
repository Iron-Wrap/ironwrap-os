# IronWrap End-To-End Summary And Plan

Date: 2026-06-27  
Scope: notes from the Ilia discussion, local files in `/Users/ivan/Code/ironwrap`,
and current public web/vendor research. No shared credentials were used.

## Bottom Line

There are two separate opportunities and they should stay separate.

1. **Task 1: IronWrap internal operating system.** Build the operating spine for
   IronWrap first: lead capture, booking, JobNimbus cleanup, Make automations,
   folders, proposals, payment/review follow-up, measurement intake, AI
   missed-call handling, and launch controls. The local `final-spec-pack` already
   defines this well and explicitly excludes the external SaaS.
2. **Task 2: external metal-layout/material-takeoff product.** The broad claim
   that "nothing exists" is not literally true. AppliCad, The EDGE, SmartBuild,
   HOVER, Roofr/GAF/RoofSnap, and other takeoff/report tools already cover parts
   of the market. The real possible gap is narrower: a modern, mobile-first,
   installer/supplier workflow for metal roof/siding panel layout, cut lists,
   trim/accessories, material requests, supplier/shop handoff, and CRM/ERP
   integration for small to mid-sized North American contractors.

The correct sequence is: ship Task 1 as IronWrap's own proof environment, then
use IronWrap's real jobs to validate Task 2 before building a full SaaS.

## Clean Recap Of Ilia's Notes

Ilia's view:

- Metal roofing, standing seam, metal siding, soffit/fascia/gutter workflows are
  still handled with too much manual measuring, paper, spreadsheets, and ad hoc
  installer knowledge.
- For shingles there are mature calculators and report workflows. For metal,
  the business logic is more specialized: panel profile, panel width, seam type,
  cut lengths, trim, valleys, hips, waste/offcuts, coil yield, supplier/shop
  constraints, and field fabrication all matter.
- Installers lose money through material overage, wrong measurements, unclear
  cut lists, and poor handoff from sales to production/shop.
- Manufacturers/suppliers would benefit from cleaner order data, fewer support
  calls, and more demand capture.
- There is also an immediate internal need at IronWrap: clean CRM, automations,
  lead follow-up, booking, proposals, visualization, reviews, payment follow-up,
  and materials workflow.

Important correction:

- The "20% annual demand growth" claim should not be used publicly without a
  source. Public market estimates found in this pass are lower: one global
  metal-roofing forecast projects **5.6% CAGR for 2026-2034**; one U.S. forecast
  projects about **3.99% CAGR for 2025-2035**. The stronger evidence is long-term
  share gain: U.S. residential metal roofing rose from **12% in 2019 to 17% in
  2021**, and 2024 trade coverage says metal claimed **18% of the residential
  market**, with steel making up 82% of that share. Sources: [The Insight
  Partners](https://www.theinsightpartners.com/reports/metal-roofing-market),
  [Market Research Future](https://www.marketresearchfuture.com/reports/us-metal-roofing-market-13700),
  [Build Using Steel](https://www.buildusingsteel.org/2022/11/residential-metal-roofing-continues-to-make-strong-gains-in-u-s-according-to-latest-industry-report/),
  [Metal Construction News](https://www.metalconstructionnews.com/news/metal-roofing-continues-to-grow-its-presence-in-the-residential-market/).

## What The Local Repo Already Proves

The repo is not a normal code repo; it is mostly PDFs, extracted text, and a
planning/spec pack.

Key local files:

- `final-spec-pack/README.md`: final direction for Task 1.
- `final-spec-pack/00-final-decisions.md`: stack decisions, buy gates, non-goals.
- `final-spec-pack/01-system-architecture.md`: GHL -> Make -> JobNimbus ->
  folders/proposals/QuickBooks/reviews flow.
- `final-spec-pack/06-integrations-and-automations.md`: integration matrix and
  automation contracts.
- `final-spec-pack/07-documents-measurements-proposals.md`: XML/PDF/OCR proposal
  flow.
- `final-spec-pack/08-costs-vendors-buy-gates.md`: low-volume budget and vendor
  gates.
- `final-spec-pack/12-implementation-backlog.md`: buildable backlog.
- `final-spec-pack/15-first-deliverable-existing-stack-plan.md`: minimum-spend
  first deliverable using existing subscriptions/access.
- `TASK1_INTERNAL_OS_EXECUTION_PLAN.md`: larger execution plan and diagrams.

Local measurement evidence:

- `1013 Moville St.xml` is structured AppliCad XML. It includes roof faces,
  polygon paths, sizes, pitch, orientation, and typed lines such as `GABLE`,
  `FASCIA`, `RIDGE`, `VALLEY`, `STEP`, and `TUCK-UNDER`. That supports the
  "XML before OCR" decision.
- RoofRuler-style text PDFs expose useful fields: roof area, facets, pitch,
  eaves, valleys, hips, ridges, rakes, wall flashing, step flashing, squares,
  and waste tables.
- The siding, gutter, and soffit/fascia sample text extracts are much weaker.
  They justify OCR plus human review for non-roof reports.

Caveats:

- AppliCad XML is parseable, but some metadata is dirty; for example, the sample
  has date-like values in `STATE`/`POSTAL`. Use geometry and line data, but
  validate customer/address metadata.
- The NaturalForms decision has an important nuance: the first-deliverable plan
  assumes IronWrap already has access, so use it for field/document forms if
  available. Do not buy upgrades or REST/API access until native JobNimbus
  integration, web apps, or webhook output fail a real test.

## Task 1 Plan: IronWrap Internal OS

### Goal

Make IronWrap's daily operations visible, deduped, and recoverable:

- Every lead lands in one front-door queue.
- Qualified leads create/update the right JobNimbus contact/job.
- JobNimbus owns job number, job stage, tasks, owner, and next action.
- One storage system holds job folders and archive PDFs.
- QuickBooks owns accounting truth.
- AI handles missed-call/after-hours intake only after tests pass.
- Every critical automation has a test record, owner, failure alert, and kill
  switch.

### Stack Decision

Keep the stack boring:

- **GHL / HighLevel**: lead capture, SMS, booking, nurture, reviews, missed-call
  and after-hours AI pilot.
- **JobNimbus**: canonical contact/job/property/stage/task/job number.
- **Make**: automation glue while volume is low.
- **Google Drive or OneDrive**: one archive authority, not both.
- **QuickBooks Online**: invoices, payments, accounting status.
- **Simple proposal HTML/PDF** first; do not buy heavy proposal software until
  the sales process proves the need.
- **NaturalForms** can be used immediately if it is already available for
  mobile/offline forms, photos, sketches, signatures, and repeatable PDFs.
- **Renoworks, Paradigm, heavy proposal tools, custom dashboards, custom voice
  infrastructure, and paid OCR** are gated add-ons, not first moves.

### Immediate Security Note

Credentials were shared in the notes. Do not use them for build work. Before
production launch, rotate shared passwords, revoke stale sessions/API keys,
replace shared logins with named users where supported, enable MFA, and store
secrets in a password manager.

### Build Phases

**Phase 0: Containment**

- Inventory GHL, JobNimbus, Make, QuickBooks, storage, website, phone, and AI
  access.
- Identify live webhooks, API keys, Make scenarios, and folder automations.
- Create test records.
- Pause duplicate/dangerous automations.

Exit: we know what is live and no new production dependency relies on a shared
login.

**Phase 1: JobNimbus operating core**

- Configure boards/stages/fields for residential, commercial, shop/supply, and
  steel/distribution.
- Define canonical job-number policy.
- Configure task templates, attachment categories, owner/assignee rules, and
  required fields per stage.

Exit: a test job can move lead -> appointment -> estimate -> proposal ->
materials -> completion without free-text hacks.

**Phase 2: GHL front door**

- Configure lead pipeline, intake forms, calendar, SMS/email confirmations,
  no-show/rebook flow, lead source fields, and review sequence stop conditions.
- Website, manual, phone/SMS, ad, referral, and later Renoworks leads should land
  in GHL first.

Exit: every lead has owner/queue, source, next action, and qualification status.

**Phase 3: Make integration cleanup**

- Rebuild GHL -> JobNimbus lead handoff with dedupe by phone, email, address,
  and external refs.
- Rebuild folder creation only after JobNimbus job number exists.
- Add idempotency keys, failure alerts, test records, and kill switches.

Exit: duplicate test lead does not create duplicate JobNimbus jobs or folders.

**Phase 4: AI missed-call / booking pilot**

- Start with GHL Voice AI / AI Employee because GHL is already in stack.
- Pilot missed-call recovery and after-hours only.
- Escalate angry, legal, warranty, payment, insurance, low-confidence, and
  human-request calls.
- Run scripted eval calls before real production.

Exit: AI qualifies, books, summarizes, escalates, and does not create duplicates.

**Phase 5: documents, measurements, proposal**

- Use NaturalForms templates for work orders, change orders, equipment requests,
  completion forms, inspections, materials requests, safety forms, contract or
  acceptance capture, and material lists when that avoids custom build.
- Parse AppliCad XML first.
- Extract RoofRuler text PDFs next.
- OCR image-heavy siding/gutter/soffit/fascia reports only when needed.
- Keep human review before pricing/material truth.
- Build simple mobile-friendly HTML/PDF proposal with versioning and archive.

Exit: measurement package is extracted or flagged; proposal PDF archives; status
returns to JobNimbus.

**Phase 6: payments, reviews, exceptions**

- QuickBooks remains finance truth.
- Mirror only status fields into JobNimbus: deposit requested/paid, invoice
  created/paid/overdue.
- Validate customer-facing payment methods before showing them in proposals.
- Build owner exceptions view: unassigned leads, stale stages, missed calls,
  pending proposals, missing deposits, material blockers, completed-not-invoiced,
  overdue invoices, failed automations.

Exit: owner can see daily blockers without opening five systems and guessing.

**Phase 7: QA, hardening, launch**

- Run the QA matrix in `final-spec-pack/10-qa-launch-acceptance.md`.
- Rotate credentials and harden access.
- Confirm privacy notice, CASL unsubscribe, DNCL/internal DNC, AI/call recording
  notice, retention, breach response, vendor register, and kill switches.

Exit: owner signoff and controlled real pilot passed.

## Task 2 Plan: External Metal Layout / Material Takeoff SaaS

### Opportunity Hypothesis

Build a metal-specific takeoff and material planning product for contractors,
installers, suppliers, and rollforming shops who need more than shingle-style
roof reports:

- panel layout by roof/wall surface,
- standing seam / snap-lock / exposed-fastener profile rules,
- cut list and panel schedule,
- trim/accessory quantities,
- waste/offcut optimization,
- coil yield planning,
- material request and supplier/shop handoff,
- PDF/order export,
- CRM/ERP integration.

This is not a Renoworks clone and not a satellite-measurement company at first.
The wedge should be "turn existing roof/report/field data into metal-specific
material output."

### Market Evidence

Useful evidence:

- Metal roofing adoption is real. Trade sources point to U.S. residential metal
  share moving from 12% in 2019 to 17% in 2021, and 18% in 2024. That supports
  a growing niche, but not a blanket 20% annual-growth claim.
- Market growth forecasts found in public sources are closer to 4%-6% CAGR, not
  20% broad-market CAGR.
- Existing roof measurement tools are often oriented around roof area, pitch,
  eaves/valleys, waste, reports, proposals, and shingles. Example: GAF
  QuickMeasure reports include measurements, bill of materials, interactive 3D,
  XML data, and pricing from USD $20/single-family parcel for non-Master Elite
  pros. Source: [GAF QuickMeasure](https://www.gaf.com/en-us/resources/business-services/quickmeasure).
- Standing seam workflows need panel profile, coil width, rib/seam allowances,
  trim, and cut lists. Sheffield Metals publishes separate guidance for coil and
  trim estimating, which is a sign that this remains a specialized workflow.
  Sources: [coil estimating](https://sheffieldmetals.com/learning-center/video/metal-roof-install-material-estimation-video/),
  [trim estimating](https://sheffieldmetals.com/learning-center/video/how-to-estimate-metal-roofing-trim-video/).

Pain signals:

- Contractors on Reddit discuss commercial/standing-seam estimating gaps,
  shingle-oriented software, multi-day estimating work, waste assumptions, and
  reliance on report outputs for pitch/waste. These are anecdotal, not proof of
  purchase intent.
- Local IronWrap files show roof reports can be parsed, but siding/gutter/soffit
  reports are weaker under text extraction. That is a real implementation wedge:
  make the first product review-assisted, not fully automatic.

### Competitive Reality

The "nothing exists" claim should be reframed.

Existing or adjacent tools:

- **AppliCad Roof Wizard** already claims metal roof/wall takeoff, 3D modeling,
  material quantification, offcut reuse optimization, cutting lists, quotes,
  order forms, and rollformer CSV export. Sources:
  [AppliCad Roof Wizard](https://www.applicad.com/roof-estimating-software/),
  [AppliCad home](https://www.applicad.com/),
  [panel cut lists](https://www.applicad.com/generate-panels-automatically/).
- **The EDGE** has commercial roofing estimating/takeoff and a standing seam
  module with cut lists. Source:
  [The EDGE roofing](https://www.estimatingedge.com/construction/roofing/).
- **SmartBuild Systems** claims web-based metal building/roofing design,
  takeoffs, pricing, and proposals. Sources:
  [SmartBuild](https://smartbuildsystems.com/),
  [METALCON profile](https://expo.metalcon.com/metalcon25/public/eBooth.aspx?BoothID=127926&Task=Products).
- **HOVER** claims visual takeoffs and order-ready material lists for complex
  siding and roofing. Source:
  [HOVER construction takeoffs](https://hover.to/construction-takeoffs).
- **Roofr, GAF QuickMeasure, RoofSnap, RoofRuler, EagleView-like providers** cover
  measurements/reports but are not obviously full metal panel-layout operating
  systems for small metal installers/suppliers.
- **Paradigm ERP** is shop/rollforming ERP, not an installer-first layout SaaS.
  It can matter later for production handoff. Source:
  [Paradigm ERP](https://goparagon.com/paradigm-erp/).

So the wedge is not "first metal roof software." The wedge is:

> a simpler, modern, report/field-input driven metal material planner for
> installers and suppliers who cannot justify or operate heavy estimating/ERP
> systems.

### MVP

Build the smallest product that proves the value:

1. Import RoofRuler/AppliCad/Roofr/GAF-style measurement exports where available.
2. Allow manual correction of roof/wall planes, dimensions, pitch, panel
   direction, openings, and edge types.
3. Select product/profile: panel width, seam type, coil width, gauge, color,
   trim catalog, fastener/accessory assumptions.
4. Generate:
   - panel schedule,
   - cut list,
   - trim/accessory list,
   - waste/offcut estimate,
   - material request,
   - customer/internal PDF,
   - supplier/shop CSV.
5. Keep human approval before order output.
6. Store job history and revisions.

Do not build in V1:

- satellite reconstruction,
- full 3D visualizer,
- generic CRM,
- accounting,
- full supplier marketplace,
- ERP replacement,
- autonomous pricing.

### Product Modules

**V1: estimator workbench**

- Import measurement files.
- Draw/correct planes on tablet/desktop.
- Assign panel direction and profile.
- Generate panel/cut list and PDF.

**V1.5: supplier/order package**

- Supplier catalog/profile mapping.
- Shop order export.
- Rollformer-friendly CSV where feasible.
- JobNimbus/GHL/QuickBooks status references only, no deep finance sync.

**V2: field mobile capture**

- Finger/stylus sketch with snap-to-angle, dimension entry, and autocorrect.
- Photos annotated with dimensions.
- Offline draft mode.

**V3: marketplace/integrations**

- Supplier quote requests.
- Manufacturer product libraries.
- Paradigm/Nexus/rollforming integration.
- Public API and webhooks.

**V4: visual/satellite**

- Integrate or embed Renoworks/HOVER/measurement vendors first.
- Only build own satellite/3D reconstruction if vendor economics or control
  become the bottleneck.

### Validation Plan

Before building SaaS infrastructure:

- Get 30 IronWrap historical jobs: roof, siding, gutter, soffit/fascia, full wrap.
- For each job, compare actual ordered material vs report-derived quantities vs
  install corrections/waste.
- Interview 15-20 metal contractors/suppliers in Alberta, BC, Ontario, Texas,
  Florida, and Northeast U.S.
- Demo competitor workflows: AppliCad, The EDGE, SmartBuild, HOVER, Roofr,
  RoofSnap/GAF, RoofRuler, Paradigm.
- Ask for pre-commitment: "Would you pay CAD/USD $X per report/month if it
  reduces waste/rework by Y and exports your supplier order?"

Go/no-go gates:

- At least 5 design partners with real jobs.
- At least 3 agree to pay or exchange real data for pilot access.
- The MVP output beats their current spreadsheet/manual method on time or
  material accuracy.
- We can explain why they would not simply buy AppliCad/The EDGE/SmartBuild.

## Vendor / Changelog / Update Ledger

This is the public update-source map for the mentioned tools. Re-check before
purchase or implementation.

| Tool | Public changelog / update signal | Integration relevance | Planning note |
|---|---|---|---|
| HighLevel / GHL | Official [HighLevel changelog](https://ideas.gohighlevel.com/changelog), active with June 27, 2026 updates; AI docs updated recently in support portal | Contacts, opportunities, workflows, calendars, conversations, Voice AI, inbound webhooks | Keep as front door and AI pilot. AI Employee pricing has plan/usage details; phone charges can still apply. |
| LeadConnector | [Private Integrations](https://help.leadconnectorhq.com/support/solutions/articles/155000002774-private-integrations-everything-you-need-to-know) and [inbound webhook trigger](https://help.leadconnectorhq.com/support/solutions/articles/48001237402-how-to-use-the-inbound-webhook-workflow-premium-trigger-) docs | API v2/private integrations, scopes, inbound lead capture | Use scoped private integrations instead of old unrestricted API-key style where possible. |
| JobNimbus | No single public changelog found. [Product News newsletter](https://www.jobnimbus.com/newsletters), support docs, and [pricing page](https://www.jobnimbus.com/pricing) show current feature surfaces. [Open API docs](https://support.jobnimbus.com/how-do-i-create-an-integration-using-jobnimbuss-open-api) link to Postman docs. | Contacts, jobs, boards, tasks, documents/photos, automations, webhooks, API keys | JobNimbus owns job truth. Use webhooks/API carefully with access profiles. |
| Make | Official [release notes](https://help.make.com/release-notes), updated June 5, 2026; [pricing](https://www.make.com/en/pricing) current | Scenarios, webhooks, JobNimbus module, logs/error handling | Use first; custom relay only if Make cannot do dedupe/idempotency/logging reliably. |
| QuickBooks Online | [Product updates](https://quickbooks.intuit.com/accountants/news-community/product-updates/), [developer release notes](https://developer.intuit.com/app/developer/qbo/docs/release-notes/general-release-notes), [webhooks docs](https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks) | Customers, invoices, payments/status, webhooks | Accounting truth only. Avoid broad finance data sync into AI/CRM logs. |
| Renoworks | No conventional public changelog found. Active [investor/news](https://www.renoworks.com/investors/) updates; Q1 2026 release mentions AI visualization, data analytics, predictive lead scoring, workflow automation. | Visualizer links, uploaded photos/models, product/color interest, lead analytics | Buy only if visualizer-led selling is a real sales motion. Capture data into GHL/JobNimbus if active. |
| NaturalForms | No public changelog found. Official product pages show forms, signatures, photo/sketch, offline mode, JobNimbus sync, webhooks, REST API. Sources: [home](https://naturalforms.com/), [JobNimbus support](https://support.naturalformsapp.com/hc/en-us/articles/360010507894-JobNimbus-naturalForms-Integration), [webhooks](https://naturalforms.com/integrations/webhooks), [REST API](https://naturalforms.com/integrations/rest-api). | Field forms, photos, signatures, offline work, JobNimbus sync | Use if already available; gate paid upgrades/API use until native integration/webhook tests fail. |
| Paradigm ERP / Paragon | Public product pages and gated knowledge base. Public [knowledge-base page](https://myparadigm.com/resources/paradigm-knowledge-base/) says release notes exist for monthly releases. Public [API page](https://docs.goparagon.com/kb/paradigm-api/) says contact support for API/webhook options. | Rollforming ERP, order import, production, inventory, dispatch, rollformer integrations | Later bridge after manual material request stabilizes. |
| RoofRuler | No public changelog found. Public [home](https://roofruler.com/) and [features](https://roofruler.com/features) describe roof measurement from aerial imagery, pitch, area, building height, estimates/material orders/contracts. | Measurement report input | Treat as report source, not system of record. Confirm pricing/API directly. |
| Moneris | [Developer Hub](https://developer.moneris.com/), [API product page](https://www.moneris.com/en/solutions/ecommerce/moneris-api), public [news releases](https://www.moneris.com/en/media-room/news) including June 2026 Konek/API news | Payment processing, tokenization, preauth/refunds/voids, wallets, online pay-by-bank | Add after payment policy. Do not store card/bank data in CRM/AI/Make logs. |
| Financeit | No public changelog found. Public [site](https://www.financeit.io/) and [API v3 docs](https://www.financeit.ca/api/v3/) exist; current public materials state home-improvement financing up to $100,000 and direct merchant funding. | Financing application/status reference | Gate on dealer economics and approved customer wording. |

## Recommended Next Moves

1. **Do not start Task 2 build yet.** Finish Task 1 enough to generate real
   operational data and sample jobs.
2. **Run a 2-week Task 1 audit/build sprint**: account inventory, Make scenario
   map, JobNimbus stage/field cleanup, GHL intake/calendar cleanup, safe test
   records.
3. **Build the measurement parser prototype inside Task 1**: AppliCad XML +
   RoofRuler PDF extraction + review status. This becomes reusable evidence for
   Task 2.
4. **Create a Task 2 validation pack**: competitor screenshots/demos, 30 IronWrap
   jobs, 15-20 contractor interviews, and a one-page MVP mock output.
5. **Only after validation**, decide whether Task 2 is:
   - an internal IronWrap tool,
   - a service-assisted takeoff product,
   - or a real self-serve SaaS.
