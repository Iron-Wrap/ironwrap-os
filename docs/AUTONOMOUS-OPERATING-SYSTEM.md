# Autonomous Operating System

Status: canonical target
Owner: IronWrap OS product owner
Last verified: 2026-08-22
Review trigger: service, geography, physical workflow, authority, or business-model change

## Mission

IronWrap OS operates an Edmonton-based exterior-construction and metal-fabrication company with AI
interpreting and proposing routine cognitive and digital work through deterministic policy,
permits, controlled tools, readback, and reconciliation. Trained humans perform physical work and
retain customer-choice, safety-release, relationship-sensitive, legally required, and exceptional
business authority.

The system must:

- capture every authorized opportunity;
- create only evidence-backed customer promises;
- protect workers, customers, property, data, and cash;
- convert accepted work into exact material, shop, field, quality, and financial commitments;
- make every human physical task unambiguous and safely stoppable;
- reconcile every physical item, state change, side effect, and dollar;
- learn from actual cost, defects, incidents, and customer outcomes;
- operate two brands and future isolated tenants without data or authority mixing.

This is the company target. Implementation status is exclusively maintained in
[`CAPABILITY-MATRIX.md`](./CAPABILITY-MATRIX.md).

## Binding operating assumption

AI models, prompts, connector context, and tool suggestions are fallible and non-authoritative.
Reliability comes from the complete governed loop in
[`AI-NATIVE-ARCHITECTURE.md`](./AI-NATIVE-ARCHITECTURE.md): versioned facts, exact schemas,
deterministic policy, bounded permits, controlled execution, provider readback, reconciliation,
evidence, ceilings, and safe stops. External data and the physical world remain independently
fallible. Unknown, stale, or conflicting facts stop the affected transition.

## Owned operating authority

D1 plus the IronWrap Worker is the sole owned authority for normalized operational aggregates,
versions, transitions, policies, audit events, and reconciliation state. R2 retains raw immutable
evidence and large evidence objects. A projection may make that state easier to search or operate,
but it cannot originate, approve, or silently correct operating truth.

Frappe is a temporary compatibility projection while existing office, customer, field, Facet, and
accounting consumers move to D1-native contracts. No new workflow may make Frappe authoritative.
The compatibility projection is retired only after each consumer has replacement, reconciliation,
export, rollback, and acceptance proof. QuickBooks remains authoritative only for posted accounting
facts, and genuine external actors remain authoritative only for their legal, professional,
customer, physical, or issuer scopes.

The complete repository and cross-product authority map is maintained in
[`AI-NATIVE-ARCHITECTURE.md`](./AI-NATIVE-ARCHITECTURE.md). No AI plan, Frappe projection, Facet
artifact, provider acknowledgement, message, or calendar entry can silently replace the authority
defined there.

## Business scope

### Installed services

- Residential and commercial roof inspection and condition reporting.
- Leak diagnosis and temporary emergency stabilization.
- Storm/hail evidence and contractor estimates without unlicensed adjusting.
- Tear-off, disposal, deck/substrate assessment, and approved repair.
- Standing seam, mechanically seamed, metal shingle, metal tile, and approved exposed-fastener
  roof systems.
- Underlayment, ice/water protection, ventilation, clips, fasteners, closures, sealants, snow
  retention, and compatible accessories.
- Eaves, valleys, ridges, hips, rakes, transitions, walls, parapets, curbs, penetrations, skylights,
  chimneys, and custom flashings.
- Metal siding and architectural cladding.
- Soffit, fascia, trims, and chimney wraps.
- Gutters, downspouts, outlets, elbows, drainage extensions, and leaf protection.
- Repair, maintenance, inspection, warranty, and callback work.
- Commercial tendering, submittals, coordination, progress billing, and closeout.

### Shop and supply-only services

- Shearing, slitting, bending, notching, punching, and roll-forming.
- Custom panels, flashings, trims, caps, valleys, gutters, and replacement pieces.
- Coil, sheet, fasteners, sealants, closures, membranes, and accessories.
- Contractor orders, homeowner counter sales, web/phone orders, pickup, and delivery.
- Customer-supplied material processing under a separate risk agreement.

### Separate-authority or excluded work

The company does not silently assume authority for:

- structural engineering;
- asbestos or hazardous-material abatement;
- electrical, solar, plumbing, gas, or mechanical relocation;
- engineered lifting beyond approved competence and equipment;
- insurance coverage decisions or loss adjustment;
- consumer-credit underwriting;
- work outside current licence, trade authorization, insurance, permit, equipment, or demonstrated
  competence.

Such work is declined or assigned through an approved specialist contract.

## The company model

IronWrap is simultaneously:

1. A construction contractor.
2. A metal manufacturer and material retailer.
3. A sales, marketing, and customer-service company.
4. An employer, apprenticeship host, and subcontractor manager.
5. A safety, quality, and environmental-control organization.
6. A warehouse, fleet, equipment, and facility operator.
7. A financial, tax, contract, privacy, and warranty entity.
8. An owner-operated software and automation platform.

Every one of these businesses has independent authority, evidence, risk, and accounting needs.

## Permanent operating functions

Each function requires an accountable role, canonical objects, SOP, authority, evidence, controls,
KPI, retention rule, and exception path.

### 1. Ownership and governance

Own:

- entities, brands, directors, ownership, banking, delegation, and signing authority;
- mission, ethics, service scope, geography, customer classes, and refusal criteria;
- risk appetite, debt, cash reserves, margin policy, insurance, and capital allocation;
- installed versus supply-only mix, employee/subcontractor strategy, and shop capacity;
- succession, sale, shutdown, disaster recovery, and existential decisions.

Required records:

- corporate and beneficial-ownership register;
- board/shareholder decisions and delegation matrix;
- strategy, annual budget, capital plan, and risk register;
- related-party transactions, insurance schedule, and continuity plan.

### 2. Legal, licence, and compliance administration

Maintain:

- corporate registrations and annual returns;
- municipal business licence and approved premises use;
- provincial prepaid/direct-selling status and contract controls;
- permit/code/inspection register by jurisdiction and work type;
- trade credentials, apprentices, supervisors, and restricted-activity map;
- WCB account and contractor clearance lifecycle;
- OHS/COR system, audit, training, incidents, and corrective actions;
- vehicle/carrier/inspection obligations;
- insurance policies, limits, exclusions, certificates, claims, and renewal;
- privacy, CASL, DNCL, retention, access, recording, and breach controls;
- payroll, tax, GST, T5018, corporate, and filing calendar;
- manufacturer certifications, system approvals, bulletins, and warranty programs.

Current researched triggers are indexed in
[`COMPLIANCE-REGISTER.md`](./COMPLIANCE-REGISTER.md). The exact job record always carries the
applicable authority and evidence.

### 3. Market, brand, and claims

Perform:

- market and customer research;
- two-brand positioning and brand-safe routing;
- website, local search, maps, directories, content, signage, vehicle graphics, events, referrals,
  partnerships, canvassing, and paid campaigns;
- portfolio/case-study publication with authorization;
- campaign attribution, lead cost, conversion, and lifetime value;
- review solicitation and response without manipulation;
- competitor and product monitoring.

Every performance, lifespan, warranty, price, environmental, energy, insurance, code, and
maintenance claim has a claims record containing:

- exact approved wording;
- system/product/geography scope;
- evidence and issuer;
- limitations and required disclaimer;
- reviewer and review date;
- effective and expiry dates;
- every channel where it is used.

An expired or unscoped claim is automatically suppressed.

### 4. Lead intake and communication

Capture every:

- web form, call, missed call, voicemail, email, SMS, social message, referral, walk-in, event lead,
  commercial invitation, service request, and warranty request.

The canonical lead includes:

- tenant, brand, source, campaign, raw event, timestamp, and dedup identity;
- requester identity, preferred channel/language/accessibility, and communication restrictions;
- property, owner/tenant/manager role, decision-makers, and billing party;
- requested service, urgency, active leak, storm context, desired material, and known hazard;
- photos/documents with privacy classification;
- prior customer/job/warranty relationships;
- consent purpose, basis, scope, capture evidence, effective/expiry, revocation, and suppression.

Agents acknowledge within policy, distinguish emergency from routine, give no unsupported promise,
and keep every attempt and outcome.

### 5. Qualification and sales

Determine:

- service/geography/structure fit;
- requester access and decision authority;
- residential, commercial, GC, property manager, service, warranty, or supply-only workflow;
- repair versus replacement;
- rough size, height, slope, access, occupancy, timing, and equipment implications;
- budget/financing/insurance/tender context without discriminatory profiling;
- remote estimate, site visit, paid inspection, emergency response, nurture, referral, or decline.

Sales agents explain systems, gather preferences, book appointments, present options, follow up,
record loss reasons, and route a person whenever requested. No agent manufactures damage,
scarcity, discounts, approval, or urgency.

### 6. Property, inspection, and measurement

Before access:

- verify requester/property relationship and permission;
- confirm occupants, tenants, pets, parking, neighbours, utilities, lines, ladders, roof access,
  weather, and known hazards;
- prepare competent personnel, PPE, calibrated equipment, drone authority, and emergency contact.

Capture:

- pre-existing property, landscape, interior, and adjacent-property condition;
- geometry, slope, elevations, surfaces, facets, penetrations, transitions, edges, drainage, and
  access;
- deck/substrate where visible, ventilation, attic moisture, insulation interface, flashings,
  corrosion, prior repair, and incompatible materials;
- structural, electrical, hazardous-material, fragile-surface, fall, and occupied-site flags;
- source confidence and unmeasured/hidden uncertainty.

Output:

- property digital twin;
- measurement report and roof graph;
- condition/photo map;
- hazard/access plan;
- explicit uncertainty and specialist referral.

No estimate may silently convert assumed geometry or hidden conditions into measured facts.

### 7. System design

Freeze the issued design basis:

- code, permit, engineer, manufacturer, product, assembly, and revision;
- profile, panel width, gauge, coating, colour, finish, lot constraints, and aesthetic tolerance;
- substrate/deck preparation;
- membrane, underlayment, insulation/moisture, ventilation, fastener, clip, closure, sealant, and
  snow-retention details;
- eave, valley, ridge, hip, rake, wall, curb, penetration, transition, and drainage details;
- purchased versus fabricated components;
- compatibility, expansion, corrosion, warranty, maintenance, and inspection requirements.

Substitutions create a new design decision; they are never a purchasing note.

### 8. Estimating and pricing

Calculate:

- source measurements and waste by geometry/product;
- material, freight, tariff, storage, shop setup/run, packaging, delivery, and scrap;
- human hours by task, skill, season, travel, and productivity;
- subcontractor, equipment, crane/lift/scaffold/bin, permit, engineering, and disposal;
- overhead, selling cost, financing cost, warranty reserve, contingency, tax, and target margin;
- availability, lead-time, weather, access, and uncertainty risk;
- good/better/best or other valid options;
- allowances, exclusions, price validity, escalation, and change rules.

Every quote is reproducible from versioned measurements, design, price book, vendor quotes, labour
model, tax rule, and approval policy.

### 9. Proposal, contract, and customer decision

Present:

- exact parties, property, scope, drawings/details, materials, quantities where appropriate, and
  exclusions;
- schedule assumptions and definitions of start, delay, completion, and substantial performance;
- permit, engineering, access, utilities, washroom, parking, storage, occupant, pet, and neighbour
  responsibilities;
- tear-off, debris, salvage, property protection, and hidden-condition procedures;
- options, allowances, substitutions, and signed change-order method;
- price, tax, deposit, progress, holdback, financing, interest, suspension, and collection terms;
- manufacturer versus workmanship warranty;
- cancellation, dispute, termination, privacy, recording, photography, and communication;
- licence, insurance, WCB, and other required disclosure.

Persist:

- every version shown;
- identity and authority of the decision-maker;
- selected/rejected options;
- questions and representations;
- executed bytes/hash, timestamps, and cancellation state.

### 10. Preconstruction

Do not release production until:

- contract is effective and cancellation treatment complete;
- required payment is reconciled;
- permit, engineering, hazardous-material, utility, and external approvals are valid;
- material takeoff/design review is released;
- suppliers and fabrication capacity are confirmed;
- employees/subcontractors, WCB, insurance, trade authorization, competencies, and assignments are
  valid;
- prime-contractor and site responsibilities are assigned;
- hazard assessment, fall/rescue, first aid, emergency, weather, and working-alone plans are issued;
- bin/recycling, crane/lift/scaffold, road occupancy, parking, washroom, storage, and delivery are
  arranged;
- customer access, occupants, pets, tenants, valuables, landscape, and interior protection are
  confirmed;
- the issued work packages are available offline.

### 11. Supplier and procurement

Manage:

- approved supplier identities, products, terms, capacity, quality, and risk;
- comparable quotes, freight, minimums, lead times, price validity, and credit;
- purchase orders bound to design, takeoff, job, budget, and idempotency key;
- approved substitutions only;
- acknowledgements, promised dates, expediting, backorders, shortages, and cancellation;
- receiving, damage, nonconformance, returns, credits, invoice match, and statement reconciliation;
- certificates, bulletins, recalls, technical changes, and warranty requirements;
- concentration, alternate source, and business-continuity risk.

Every consumed supplier price comes from an immutable catalog snapshot carrying supplier/material
external identity, unit and currency, price/freight/minimum, effective and expiry time, availability
and lead time, catalog version/source hash, and authenticated provider readback. The estimate,
takeoff, substitution, and purchase order retain the exact snapshot revision they consumed; a later
catalog refresh cannot silently change an approved commercial artifact.

Vendor creation, bank-detail change, order release, receiving, and payment remain separated.

### 12. Inventory and warehouse

Track:

- SKU, unit, location, owner, available/reserved/quarantined/damaged/returned state;
- coil/sheet lot, colour, coating, gauge, width, length/weight, supplier, cost, and certificate;
- full stock, partial stock, remnant, scrap, customer-owned stock, and salvage;
- fasteners, clips, closures, membranes, sealants, chemicals, blades, dies, PPE, packaging, and
  consumables;
- shelf life, temperature, SDS, incompatibility, and hazardous storage;
- reorder, safety stock, cycle count, annual count, shrinkage, obsolescence, and valuation.

Receiving reconciles purchase order, physical count, lot, damage evidence, packing slip, and
invoice. Negative inventory is prohibited.

### 13. Shop manufacturing

The canonical shop route is:

1. Receive released design/cut list or supply-only customer instruction.
2. Validate profile, dimensions, tolerance, material, finish direction, colour lot, quantity,
   orientation, intended use, and design responsibility.
3. Reserve the exact coil/sheet and record lot identity.
4. Nest/optimize cuts and classify resulting remnants.
5. Schedule work centre, machine, operator, tooling, material movement, and pickup/delivery.
6. Inspect stock for moisture, white rust, scratches, edge damage, colour mismatch, and film.
7. Store dry, supported, separated, restrained, and protected from contamination or tip-over.
8. Verify operator authorization, machine guard, emergency stop, lift, tooling, and pre-use state.
9. Apply hazardous-energy isolation for setup/service/clearing when required.
10. Set and record machine, tooling, profile, calibration, dimensions, and counters.
11. Produce and independently inspect the first piece.
12. Shear, slit, form, roll, notch, punch, or otherwise fabricate.
13. Inspect dimension, profile, hem, angle, count, finish, and damage in process.
14. Quarantine nonconforming material and issue an NCR.
15. Label every piece/bundle with tenant, job/order, piece ID, sequence, orientation, dimensions,
    material, colour, lot, and quantity.
16. Protect edges/finish and record protective-film requirements.
17. Package and load in physical installation/use order.
18. Record yield, remnant, scrap, rework, actual labour, machine time, and downtime.
19. Use approved lifting, pedestrian separation, and cargo securement.
20. Capture pickup/proof of delivery and visible-condition acceptance.
21. Reconcile inventory, job cost, invoice, payment, and tax.
22. Clean, inspect, maintain, and release the machine/work centre.

Supply-only controls additionally cover customer measurements, templates, tolerances,
non-returnable custom work, customer-supplied material, loading assistance, storage fees, abandoned
orders, and responsibility for design/installation suitability.

### 14. Production planning and dispatch

Schedule across:

- contract, payment, permit, design, material, fabrication, inspection, and customer readiness;
- human skills, fatigue, availability, apprenticeship/supervision, and subcontractor terms;
- shop capacity, vehicles, trailers, lift/crane/scaffold/bin, tools, and consumables;
- weather and system/site-specific safe-work limits;
- travel, access, occupants, commercial milestones, predecessor work, dry-in risk, and buffer;
- supplier commitments, cash, and downstream customer promises.

Rescheduling updates every affected person, reservation, delivery, provider, cash forecast, and
customer promise. A calendar entry is never a release to work.

### 15. Human field work

Every crew receives a work package defined by
[`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](./AUTHORITY-AND-EVIDENCE-CONTRACT.md).

Daily mobilization verifies:

- identity, competency, assignment, time, fatigue, and supervision;
- toolbox talk, changed-condition hazard assessment, weather, fall/rescue, first aid, emergency,
  working alone, and stop authority;
- tool, ladder, scaffold, lift, machine, cord, battery, PPE, and vehicle state;
- property condition/protection, access, signage, pedestrians, occupants, neighbours, and debris;
- material identity, count, damage, unloading, staging, and securement.

Physical work uses released hold points:

- existing condition and tear-off;
- deck/substrate and hidden conditions;
- dry-in;
- water, air, thermal, and ventilation layers;
- edges, valleys, flashings, transitions, curbs, walls, and penetrations;
- first panel/course and alignment;
- clip/fastener/seam/profile/expansion details;
- ridge, hip, rake, closure, sealant, siding, soffit, fascia, gutter, and drainage;
- progressive protection/cleaning;
- final physical and water-management inspection.

Workers capture quantities, time, weather, photographs, measurements, inspections, hazards,
incidents, blockers, customer interactions, deficiencies, and next plan. A field change cannot
silently alter scope, price, safety, or warranty.

### 16. Safety

Control:

- employer, supervisor, worker, contractor, prime-contractor, visitor, and owner duties;
- orientation, competency, apprentices, supervision, and training expiry;
- hazard assessment and hierarchy of controls;
- fall prevention/arrest, anchors, rescue, dropped objects, and exclusion;
- ladders, scaffolds, lifts, cranes, hoisting, forklifts, and trailers;
- guards, lockout, hot work, compressed gas, fire watch, and extinguishers;
- electrical/overhead line, WHMIS/SDS, chemical, fuel, dust, noise, and sharp-edge hazards;
- heat, cold, wind, lightning, smoke, ice, snow, hydration, and fatigue;
- first aid, emergency, working alone, incident, near miss, property damage, collision,
  investigation, reporting, corrective action, and modified work;
- inspection, audit, COR, management review, and trend learning.

Every valid stop is protected from schedule or performance penalty.

### 17. Quality

Maintain:

- controlled assemblies and manufacturer/code/permit/engineering revisions;
- inspection and test plan;
- incoming, first-piece, in-process, concealed-work, and final hold points;
- calibrated measurement tools and device identities;
- material certificates and lot traceability;
- required evidence slots and customer-safe classification;
- nonconformance, containment, disposition, rework, concession, and verification;
- independent release separate from the producing actor where material;
- punch list, commissioning, customer walkthrough, and completion evidence;
- callback/warranty root cause linked to design, supplier, shop, crew, and training.

No defect is erased. It is corrected through a linked disposition.

### 18. Change, delay, incident, and dispute

Every change records:

- trigger and source evidence;
- scope/material/design/quantity delta;
- price, tax, schedule, safety, permit, and warranty effect;
- customer/GC/external approval;
- superseded work packages, purchase/shop orders, and schedule;
- billing and closeout consequences.

Controlled exception processes cover:

- weather/access delay;
- hidden damage, structure, asbestos, or incompatible material;
- customer cancellation, complaint, nonpayment, or dispute;
- neighbour/property damage;
- leak or emergency stabilization;
- supplier failure, theft, vandalism, outage, or insolvency;
- permit rejection, regulator direction, injury, vehicle collision, fire, or privacy/security event.

### 19. Completion and closeout

Complete:

- independent deficiency inspection and correction;
- removal of debris, fasteners, packaging, temporary controls, equipment, and surplus;
- scrap/waste classification and receipt;
- gutter/drainage and water-management check;
- final photos, measurements, and as-built deviation;
- required permit/authority/manufacturer inspection;
- customer walkthrough and maintenance/care instruction;
- product, lot, coating, colour, installer, job date, and certificate record;
- manufacturer registration and contractor warranty;
- completion/substantial-performance evidence;
- invoice, holdback, payment, supplier credit, subcontractor clearance, and job-cost reconciliation;
- archive, retention, review/referral eligibility, and warranty handoff.

### 20. Warranty, service, and customer success

Retain:

- original design, executed contract, material/lot, evidence, weather, maintenance instructions,
  changes, inspections, payment, and prior service.

For each request:

- authenticate customer/property;
- distinguish emergency, workmanship, material, excluded condition, maintenance, third-party
  damage, and unrelated work;
- triage safety/property containment;
- schedule an exact service work package;
- diagnose from evidence;
- assign responsibility without prejudging;
- quote non-covered work;
- complete, verify, communicate, and recover supplier/manufacturer/subcontractor cost;
- feed root cause into design, price, training, procurement, and quality.

### 21. Finance, accounting, tax, and cash

Manage:

- estimate, budget, commitment, PO, bill, invoice, credit, deposit, progress, holdback, payment,
  refund, chargeback, and collection;
- job cost by service, phase, shop, crew, material, equipment, and subcontractor;
- bank, card, loan, supplier, customer, payroll, and inventory reconciliation;
- time, overtime, vacation, holiday, benefit, allowance, reimbursement, and ROE;
- GST, payroll remittance, T4, T5018, corporate tax, instalment, and annual return;
- inventory, work in progress, revenue recognition, bad debt, warranty reserve, fixed asset,
  depreciation, and disposal;
- cash forecast, borrowing covenant, capital budget, and owner distribution;
- fraud controls for payee, bank detail, payroll, credit note, refund, and payment authority.

The accounting system is authoritative for posted financial transactions. Operational records
must reconcile to it; agents do not invent accounting truth.

### 22. People and subcontractors

Manage:

- workforce plan, role, competency, job description, recruiting, reference, eligibility, and
  driver record;
- employee versus genuine contractor classification;
- offer, pay, overtime, travel, per diem, tool, uniform, PPE, benefit, and policy;
- onboarding, apprenticeship, mentoring, training, expiry, and progression;
- schedule, time, absence, vacation, accommodation, complaint, harassment/violence, and privacy;
- performance, discipline, investigation, injury, modified work, layoff/termination, final pay,
  ROE, asset/key return, and access revocation;
- subcontractor identity, agreement, scope, price, WCB, insurance, trade authorization, competency,
  orientation, performance, deficiency, invoice, and final clearance.

No autonomous optimization may discriminate, retaliate, suppress injury/hazard reporting, or
misclassify employment.

### 23. Fleet, equipment, and facility

Fleet:

- registration, insurance, licence class, driver file, carrier status, inspection, maintenance,
  tire, fuel, key, GPS/privacy, parking, toll, collision, theft, trailer, load, securement,
  dimension/weight, and replacement.

Equipment:

- identity, ownership/lease, authorization, inspection, maintenance, calibration, service,
  warranty, guard, blade, die, roller, battery, charger, cord, spare, checkout, loss, damage,
  breakdown, and substitute capacity.

Facility:

- lease, zoning, utility, heat, ventilation, light, access, camera, fire, emergency, snow/ice,
  housekeeping, rack, coil restraint, loading, pedestrian separation, waste, scrap, chemical,
  pest, security, and business interruption.

### 24. Data, software, privacy, security, and continuity

Control:

- customer, property, worker, applicant, supplier, financial, photo, voice, video, GPS, vehicle,
  device, and warranty data;
- purpose, consent, minimization, classification, access, correction, disclosure, retention,
  destruction, and legal hold;
- tenant isolation, identity, role, least privilege, MFA, device, recovery, and offboarding;
- encryption, secret handling, patching, backup, restore, offline, audit, vulnerability, and
  incident response;
- vendor/subprocessor authority and data-processing terms;
- domain, email, phone, website, cloud, provider, accounting, and automation continuity;
- versioned agents, prompts, tools, policy, models, evaluations, and rollback.

Structured operational forms are versioned domain schemas, not uploaded PDF/Word documents or a
generic low-code database. Each field has a type, read/write authority, provenance, validation,
conditional evidence requirement, retention class, offline policy, and correction trail. A form may
collect facts and request an existing command; it cannot define new authority or mutate lifecycle
state directly.

Customer/job evidence belongs in approved D1/R2/Drive/accounting/provider systems, not the
source repository.

### 25. Insurance, legal claims, and continuity

Maintain broker/counsel-reviewed:

- CGL/completed operations;
- property/business interruption;
- tools/equipment and installation floater;
- commercial auto/trailer;
- excess/umbrella;
- cyber/privacy and crime;
- equipment breakdown;
- professional/design liability when design is assumed;
- pollution/asbestos when in scope;
- builder's risk/course of construction when assigned;
- bonds for applicable commercial/public work.

Each event has notification deadlines, evidence preservation, insurer/counsel/adjuster authority,
reserve, recovery, customer communication, remediation, and learning.

### 26. Performance and improvement

Measure:

- capture completeness, response, appointment, estimate cycle, win/loss/cancellation;
- revenue, backlog, margin, cash, AR, bad debt, commitment, and forecast accuracy;
- estimated versus actual quantity, labour, shop, material, waste, duration, and margin;
- schedule reliability, supplier OTIF, inventory accuracy, shop yield/scrap/rework/downtime;
- hazards, observations, training, near misses, incidents, and corrective-action closure;
- defects, punch, callback, leak, warranty cost, and repeated failure;
- customer effort, complaint, response, referral, and review integrity;
- turnover, absence, training, apprenticeship, capacity, and retention;
- compliance expiry/miss, evidence completeness, security incident, backup/restore result;
- autonomous transition success, stops, retries, duplicates, reconciliations, and human exception
  load.

Never optimize a metric in a way that degrades a protected right or hidden outcome.

## Orthogonal lifecycles and derived job phase

The company is not one writable job-state machine. Lead, commercial, gate, assignment, work,
safety, accounting, and closeout facts have different actors, evidence, correction rules, and
failure modes. They remain separate authoritative state machines:

1. lead `captured -> triaged -> qualified | disqualified -> converted`;
2. measurement, design, quote, proposal, publication, and acceptance revision chains;
3. independent production gates and evidence freshness;
4. append-only crew assignment and supersession;
5. work package `Draft -> Released -> Acknowledged -> In Progress -> Blocked | Completed | Superseded`;
6. safety report/stop/rescue/make-safe/corrective-action/independent-release;
7. accounting intent/approval/execution/readback/reconciliation/exception; and
8. completion/closeout/warranty/service.

The product exposes one read-only `job_phase` derived from those facts:

| Phase | Required authoritative predicate | Typical stop |
|---|---|---|
| `qualified` | Qualified lead/job; no commercial work started | scope, identity, authority |
| `commercial_in_progress` | Measurement/design/quote/proposal exists; no binding acceptance | missing/conflicting evidence |
| `contracted` | Exact current publication has binding customer acceptance | drift, cancellation, invalid authority |
| `deposit_pending` | Accepted contract; required deposit not reconciled | provider uncertainty or mismatch |
| `production_ready` | Every required gate currently cleared | stale permit, safety, material, crew, access |
| `scheduled` | Current valid append-only assignment exists | version, roster, capacity, predecessor |
| `in_progress` | Current work package started | stop, hidden condition, dispute |
| `substantially_complete` | Required completion packet accepted | deficiency or unreleased hold point |
| `financially_closed` | Final invoice and balance reconciled | mismatch, dispute, open credit |
| `warranty_active` | Closeout and warranty activation complete | missing registration or evidence |
| `cancelled` | Authoritative cancellation supersedes active work | containment/compensation incomplete |

The phase is a deterministic projector, never an independently writable truth. Corrections and
compensation append/supersede history; no actor edits history to make a job appear complete.

## Agent organization

The table describes target coordination responsibilities. An AI plan itself owns no business fact
and cannot activate policy or execute a side effect.

| Agent domain | Coordinates or proposes | Hard boundary |
|---|---|---|
| Corporate governor | policy, delegated budgets, objectives | cannot activate its own policy |
| Demand and claims | campaigns, content, substantiation | cannot publish unsupported claim |
| Concierge | intake, consent routing, qualification, booking | cannot invent authority or binding price |
| Survey and geometry | source evidence, digital twin, uncertainty | cannot resolve missing physical fact |
| Solution design | valid assemblies and options | cannot override code/manufacturer/engineer |
| Estimating and pricing | cost, risk, capacity, price | cannot silently alter measurements or floor |
| Contract and customer decision | terms, disclosures, identity, signatures | cannot waive customer/legal rights |
| Compliance | licences, permits, WCB, trade, safety, privacy | cannot self-create external authority |
| Procurement | quotes, PO, expediting | cannot create payee and release payment |
| Inventory | stock, lot, reservation, count | cannot allow negative/unverified stock |
| Shop orchestration | routing, machine, QC, bundle | cannot release failed safety/quality gate |
| Scheduling and dispatch | constraint-based plan | cannot schedule through a hard gate |
| Safety | hazards, plan, stop, incident | no one can override a valid stop |
| Field coordination | work packages, progress, exceptions | cannot authorize hidden-condition change |
| Quality | hold points, NCR, commissioning | cannot approve own production |
| Finance and tax | billing, cash, reconciliation, filing | accounting provider remains posted truth |
| Workforce | capacity, training, assignments, HR workflow | protected decisions follow employment policy |
| Fleet/facility | safe asset availability | cannot release unsafe asset |
| Customer success | status, complaint, closeout, warranty | person available on request |
| Security/privacy | access, retention, incident | cannot approve own privilege change |
| Independent audit | transitions, reconciliation, anomalies | cannot execute audited action |

Agents communicate through canonical objects and events, not unbounded peer chat. Every
consequential proposal crosses the policy/permit/effect/readback loop before it can become truth.

## Owner operating cadence

### Immediate only

- fatality/serious injury or uncontrolled hazard;
- major leak/property damage/fire/collision;
- material privacy/security incident;
- regulator, insurer, counsel, or bank escalation;
- solvency or existential supplier/system failure;
- exceptional customer/worker matter requiring the owner.

### Weekly

- exceptions and overdue stops;
- cash, commitments, backlog, capacity, margin, and forecast;
- safety, quality, customer, people, shop, supplier, and asset exceptions;
- policy changes proposed by agents;
- evidence/reconciliation completeness.

### Monthly

- financial close and job-cost learning;
- capital, inventory, warranty reserve, and cash risk;
- compliance, privacy/security, insurance, and continuity;
- workforce and apprenticeship;
- product/service/pricing changes.

### Quarterly and annual

- strategy, geography, service mix, capital, supplier concentration, insurance, risk, succession;
- regulatory and canonical-contract review;
- full recovery/continuity exercise;
- independent audit of authority, agent behavior, physical evidence, and financial reconciliation.

The owner manages policies, capital, values, and material exceptions, not routine dispatch or data
entry.

## Canonical business objects

The complete target requires at least:

- tenant, brand, legal entity, owner, delegation, licence, permit, authority, policy;
- person, organization, customer, property, contact point, consent, suppression;
- lead, opportunity, appointment, survey, measurement, digital twin, hazard;
- controlled product, assembly, manufacturer document, design, option, claim;
- price rule, estimate, quote, contract, acceptance, cancellation, change;
- supplier, catalog snapshot, quote, purchase order, receipt, credit, recall;
- item, lot, coil/sheet, location, reservation, remnant, scrap, count;
- work centre, machine, tooling, calibration, route, operation, first piece, NCR;
- employee, subcontractor, competency, credential, apprenticeship, training, WCB, assignment;
- vehicle, trailer, equipment, inspection, maintenance, incident;
- job, gate, schedule, work package, field event, hold point, evidence;
- invoice, holdback, payment, refund, payroll, tax filing, reconciliation;
- completion, warranty, service case, complaint, review request;
- workflow view, form definition, integration manifest, operating profile, operating pack;
- audit finding, risk, exception, corrective action, recovery test.

Each aggregate has a stable owned ID, tenant boundary, version, state machine, immutable events, and
retention class.

## External systems

External services are bounded authorities or side-effect providers, not universal truth:

- D1/Worker/R2: owned operating authority, transition/event persistence, and raw evidence.
- Frappe: temporary read-only compatibility projection scheduled for evidence-backed retirement;
  it is not an operating authority.
- Google Shared Drive: human-readable controlled job archive.
- QuickBooks: posted accounting truth.
- Email/SMS/voice providers: delivery/interaction evidence.
- City, WCB, CRA, insurer, engineer, manufacturer, and lender: authoritative only for their scope.
- Temporary CRM/automation bridges: consumers scheduled for retirement after replacement proof.

Each integration is declared by a versioned manifest defining provider/tenant identity, supported
directions and actions, auth scopes, data class, authority boundary, retry/idempotency, required
readback/reconciliation, safe fallback, readiness, and proof TTL. An integration listing or webhook
success is not proof that the business outcome occurred.

No provider-specific identifier replaces the owned tenant/job/property/customer identity.

## Degraded and emergency operation

Critical human work remains safe when cloud systems fail:

- workers retain the last valid work package, hazard plan, emergency contacts, and stop controls
  offline;
- no new consequential work begins from stale or unverifiable authority;
- field evidence queues locally with identity, order, and duplicate-safe replay;
- emergency stabilization follows a bounded offline plan;
- accounting, provider, inventory, and job state reconcile after recovery;
- the business can restore D1, evidence, configuration, and identity to an isolated target;
- until Frappe is retired, its compatibility projection can be rebuilt from D1 or restored from a
  cutover export without treating the projection as authority.

## End-to-end acceptance

### Technical production reference proof

Before real customers, an isolated, visibly synthetic reference tenant must complete the same
production artifact, APIs, queues, policy, storage, scheduled work, provider adapters, readback,
reconciliation, backup, restore, and rollback path without direct business-state seeding. It must
also prove duplicate, stale, malicious, lost-response, offline, safety-stop, payment-mismatch, and
recovery failures. This establishes technical reference proof only.

### Customer and business proof

The customer-validated target is not complete until a real, reconciled job proves:

1. Lead capture and consent without loss or duplication.
2. Evidence-backed survey and uncertainty handling.
3. Valid design, estimate, price, proposal, and contract with the required customer and human
   authority and no unnecessary duplicate review.
4. Permit, WCB, trade, safety, material, customer, and capacity gates.
5. Supplier order, receiving, inventory, and shop routing with lot/yield/NCR evidence.
6. Exact offline-capable human work packages and protected stop-work.
7. Field execution, change, quality hold points, and independent completion.
8. Customer communication, billing, payment, tax/accounting reconciliation, and closeout.
9. Warranty/service handoff and root-cause feedback.
10. Safe operation under missing, conflicting, duplicate, malicious, expired, and offline inputs.
11. Complete audit reconstruction with no hidden manual spreadsheet, chat, or status.

Until all eleven are proven with real customers and workers in the named environment, the company
may be technically reference-proven but is not customer-validated or operationally autonomous.
