# IronWrap OS: Product and Delivery Specification

> **Document class:** Developer synthesis and implementation guide<br>
> **Snapshot:** `main` at `1e1d7ab0da3d5cb4b46b7a52dd4e332fdc68d956`, reviewed 2026-08-30<br>
> **Audience:** Product, design, frontend, backend, data, AI, security, QA, operations, compliance, and leadership<br>
> **Status:** Working specification for team alignment; it does not create business, legal, safety, accounting, or release authority<br>
> **Operational companion:** [Roles, Processes, Integrations, Scenarios, and UI Evidence Annex](./IRONWRAP-OS-OPERATIONS-AND-UI-ANNEX.md)<br>
> **Visual companion:** [IronWrap OS Product Atlas](./diagrams/ironwrap-os-product-atlas.html)

[Русская версия](./IRONWRAP-OS-PRODUCT-TEAM-SPEC.ru.md)

## 1. How to use this specification

This document turns the canonical IronWrap contracts and the current executable source into one
team-facing product description. It is intentionally a synthesis, not a second source of truth.
When it conflicts with an owning document, the owning document wins:

1. [`DOCUMENTATION-CONTRACT.md`](./DOCUMENTATION-CONTRACT.md) governs documentation and proof claims.
2. [`AI-NATIVE-ARCHITECTURE.md`](./AI-NATIVE-ARCHITECTURE.md) governs architecture and product boundaries.
3. [`AUTONOMOUS-OPERATING-SYSTEM.md`](./AUTONOMOUS-OPERATING-SYSTEM.md) governs company scope and operating functions.
4. [`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](./AUTHORITY-AND-EVIDENCE-CONTRACT.md) governs actors, authority, evidence, transitions, effects, and degraded operation.
5. [`CAPABILITY-MATRIX.md`](./CAPABILITY-MATRIX.md) governs mutable implementation maturity, gaps, and delivery gates.
6. [`COMPLIANCE-REGISTER.md`](./COMPLIANCE-REGISTER.md) governs researched regulatory triggers and required human signoffs.

Every capability statement uses one of these proof states:

| Label | Meaning |
|---|---|
| **Source-present** | Executable route, component, handler, schema, or test exists in this checkout. |
| **Locally validated** | A named local check passed against an exact checkout. |
| **Configured** | Required tenant/provider/policy configuration exists in a named environment. |
| **Runtime-proven** | The deployed route and its dependencies were exercised with readback. |
| **Business-proven** | A controlled end-to-end operating scenario passed with accountable human acceptance. |
| **Customer-validated** | A real customer scenario passed its separate legal, operational, and experience criteria. |
| **Partial** | Some authoritative path exists, but a required surface, provider, policy, or proof remains open. |
| **Target** | Required product behavior that is not yet fully source-present and proven. |

Source presence never implies merge, deployment, configuration, runtime health, business acceptance,
or production proof.

## 2. Product definition

### 2.1 Vision

IronWrap OS is the evidence-first operating system for an owner-operated roofing, exteriors,
service, metal-fabrication, and material-supply business. It should let a small accountable team run
the company through one governed operating thread, from first contact to accepted scope, safe field
execution, accounting reconciliation, closeout, and service, without giving software or AI authority
that belongs to a person, regulator, customer, professional, or provider.

### 2.2 Product promise

For every consequential job decision, IronWrap OS should answer:

1. **What is true?** The current versioned fact and its owning system.
2. **Who may act?** The authenticated actor, role, delegation, assignment, or external authority.
3. **What evidence supports it?** Immutable source, derived, physical, authority, financial,
   decision, or negative evidence.
4. **What policy allowed or blocked it?** The exact evaluated version and reason codes.
5. **What happened outside the system?** Provider/customer/vendor effect, readback, reconciliation,
   or known ambiguity.
6. **What must happen next?** A bounded task, gate, exception, or human decision with an owner.

### 2.3 Strategic outcomes

The product is successful when it:

- compresses lead-to-decision and accepted-job-to-ready-work time without skipping evidence;
- protects margin by binding measurements, scope, revisions, price, changes, procurement, yield,
  completion, and accounting readback;
- makes unsafe, unauthorized, stale, contradictory, or unreconciled work visibly impossible to
  release;
- gives each role a small daily surface instead of a general-purpose database;
- keeps field work safe and attributable during network loss;
- lets the owner manage policy, capital, and material exceptions instead of routine data entry;
- replaces mutable provider status and integration folklore with owned IDs, manifests, receipts,
  and reconciliation;
- adds AI as a bounded proposal and coordination layer, never as an unreviewable source of truth.

### 2.4 Non-goals

IronWrap OS is not:

- a generic horizontal CRM, ERP, accounting package, project-management board, or chatbot;
- a replacement for QuickBooks posted accounting truth or external regulatory/professional authority;
- an autonomous physical-work controller;
- an insurance adjuster, lender, structural engineer, legal adviser, or authority issuer;
- a second design authority for Facet projects;
- a promise that every source-visible route is configured or operating in production;
- a writable universal `job_status` that collapses independent business lifecycles.

## 3. Business and service boundary

IronWrap operates as eight connected businesses: construction contractor; metal manufacturer and
material retailer; sales, marketing, and customer-service organization; employer and subcontractor
manager; safety, quality, and environmental-control organization; warehouse, fleet, equipment, and
facility operator; financial, tax, contract, privacy, and warranty entity; and owner-operated
software and automation platform.

### 3.1 Included product scope

- Residential and commercial roofing and exterior work within declared company competence.
- Inspection, measurement, estimating, controlled system design, quoting, contracting, and changes.
- Repair, deficiency, warranty, complaint, and service-case operations.
- Preconstruction, procurement, inventory, warehouse, scheduling, dispatch, and field execution.
- Sheet-metal shop planning, controlled fabrication, quality, bundle custody, and supply-only work.
- Fleet, trailer, equipment, cargo, inspection, defect, maintenance, and custody controls.
- Customer, supplier, subcontractor, employee, authority, safety, quality, finance, and audit loops.
- Dual-brand and tenant-scoped operating configuration where the owning contracts permit it.

### 3.2 Separate-authority or excluded work

The system must refuse, route, or require genuine external authority for work outside declared
competence, including structural engineering, hazardous-material abatement, restricted electrical,
solar, plumbing, gas, or mechanical relocation, engineered lifting, insurance adjustment, credit
underwriting, and any work outside licence, permit, manufacturer, insurer, geographic, or delegated
authority.

## 4. Product principles

1. **Owned authority first.** D1 plus the Worker control plane own internal operating facts and
   transitions. Provider records are scoped external truth, not replacement IDs.
2. **Evidence before effect.** A side effect must bind exact input, actor, authority, evidence,
   policy, idempotency, and expected readback before execution.
3. **Orthogonal state.** Lead, commercial revisions, production gates, assignments, work packages,
   safety, accounting, closeout, warranty, and service remain independently authoritative.
4. **Derived views are read-only.** Boards, Now, dashboards, and `job_phase` explain facts; moving a
   card or changing a projection cannot bypass the owning command.
5. **Human and external rights remain hard boundaries.** No objective overrides stop-work,
   customer, accessibility, privacy, employment, regulator, engineer, insurer, or issuer authority.
6. **Offline means safe, not optimistic.** Cached instructions and stop controls remain available;
   new consequential work does not begin from stale authority.
7. **Ambiguity is a durable state.** Timeouts and uncertain provider results become exceptions;
   they are not silently retried into duplicate effects.
8. **Configuration is versioned product behavior.** Pipelines, fields, forms, documents, recipients,
   integrations, roles, and operating profiles require history, authority, rollback, and proof.
9. **One event, many views.** Channels may differ, but commands and durable facts converge on the
   same governed kernel.
10. **Proof classes do not collapse.** Source, tests, CI, merge, deploy, runtime, business acceptance,
    and customer validation are reported separately.

## 5. Users, roles, and jobs to be done

### 5.1 Authenticated product roles

| Role | Primary job to be done | Default product focus | Authority boundary |
|---|---|---|---|
| `owner` | See material exceptions, policy/capital decisions, risk, cash, and operating health | Now, Reception, Board, Sales, Designs, Production, Service, Today, Inventory, Approvals, Settings | Delegation and segregation of duties still apply; owner cannot manufacture external authority. |
| `ops` | Convert demand into complete, scheduled, unblocked work and resolve operating exceptions | Same broad operating surfaces as owner, within granted permissions | Cannot waive hard safety, legal, customer, accounting, or evidence gates. |
| `sales` | Qualify legitimate work and produce an exact, reviewable customer decision | Now, Sales, Board | Cannot bind unsupported claims, outdated revisions, deposits, or work outside authority. |
| `production` | Release and coordinate safe, ready, attributable physical work | Now, Production | Cannot schedule through an uncleared gate or independently approve own quality where separation is required. |
| `accounting` | Turn approved intents into provider-posted, reconciled financial truth | Money, Exceptions, Now, QuickBooks settings | Cannot infer payment or posting from webhooks, screenshots, or requested effects. |
| `field` | Execute the current work package safely and capture required evidence with minimal friction | Now, Check-in, Vehicle, Inventory | May stop work; may not invent scope, hidden-condition changes, completion, or authority. |

### 5.2 Other actors

| Actor | Product relationship | Required treatment |
|---|---|---|
| Customer or authorized contact | Estimate, selection, acceptance, service, correction, complaint, status | Verify identity and decision authority; preserve exactly what was presented and decided. |
| Supplier/subcontractor | Quote, order, acknowledgement, delivery, clearance, work evidence | Bind company identity, scope, versions, evidence, and reconciliation. |
| External authority | Permit, inspection, WCB, manufacturer, engineer, insurer, tax, legal | Treat as authoritative only for exact scope; verify freshness, revocation, and issuer readback. |
| Device | Camera, phone, machine, vehicle, sensor | Register identity, user/custody, calibration where relevant, time, and integrity. |
| AI agent | Analyze, derive, draft, compare, and propose bounded plans | Maximum model authority is `observe`, `derive`, and `propose`; no credentials or generic mutation tools. |
| Deterministic coordinator | Evaluate policy, consume permits, execute registered actions, reconcile | May commit only the exact permitted action and must record terminal readback or exception. |

## 6. Experience architecture

### 6.1 Product surfaces

The PWA is the principal role-based user surface. Current source includes:

- public entry, authentication verification/pairing, portal, contract acceptance, and estimator;
- role home at `/now`, daily queue at `/today`, job packet, universal work-object pages;
- field check-in, vehicle, and inventory;
- owner view, approvals, Newo administration, service, marketing intent review;
- accounting intents, exceptions, QuickBooks connection, and final-invoice detail;
- Facet designs, production, sales desk, sales board, owner board, lead capture/triage,
  measurement/estimate, and quote-revision approval;
- settings for company, team, devices, integrations, configuration, pipelines, fields,
  automations, recipients, and documents;
- a permission-scoped operator search palette with keyboard access in current source.

Routes expose interfaces; they do not prove provider configuration or deployed behavior.

### 6.2 Navigation by role

| Surface | Owner | Ops | Sales | Production | Accounting | Field |
|---|---:|---:|---:|---:|---:|---:|
| Now | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Reception | ✓ | ✓ | No | No | No | No |
| Board | ✓ | ✓ | ✓ | No | No | No |
| Sales | ✓ | ✓ | ✓ | No | No | No |
| Designs | ✓ | ✓ | No | No | No | No |
| Production | ✓ | ✓ | No | ✓ | No | No |
| Service | ✓ | ✓ | No | No | No | No |
| Today | ✓ | ✓ | No | No | No | No |
| Inventory | ✓ | ✓ | No | No | No | ✓ |
| Approvals | ✓ | ✓ | No | No | No | No |
| Money / Exceptions | Via permissions | Via permissions | No | No | ✓ | No |
| Check-in / Vehicle | Via permissions | Via permissions | No | No | No | ✓ |
| Settings | ✓ | ✓ | No | No | QuickBooks scope | No |

Exact route access remains enforced by `app/src/lib/roles.ts` and server-side permissions; this
table is a product summary, not an authorization implementation.

### 6.3 Interaction contract

- Every screen states the current fact, source, version/freshness, and next valid action.
- A destructive or external action shows impact, actor, exact target, evidence, and approval state.
- Disabled actions explain the blocking reason and the accountable resolution path.
- An unavailable capability is named as absent, switched off, on-but-unconfigured, blocked on a
  dependency, or indeterminate — never as one "unavailable", and never as an ordinary fault. Every
  role reads that state from `GET /api/v1/capabilities`, scoped to the capabilities its permissions
  reach; a reachable capability is never presented as proven. The response shape and the
  presentation rules are in `docs/CAPABILITY-SIGNAL-CONTRACT.md`.
- Board movement issues a typed versioned command; it never writes a presentation status directly.
- Forms declare required evidence, offline policy, sensitivity, correction behavior, and field-level
  authority.
- Consequential customer decisions preserve the exact revision, terms, assumptions, exclusions,
  price, and content presented.
- All surfaces provide a clear path to a person for customer, worker, and exception scenarios.

## 7. End-to-end operating lifecycle

IronWrap is a graph of state machines, but the ordinary happy path is:

1. Capture a lead with channel, consent, identity, brand, property, need, and source evidence.
2. Triage service fit, urgency, location, authority, risk, duplication, and next action.
3. Qualify or disqualify with reason; create/activate owned customer, property, and job identity only
   through the accepted transition.
4. Schedule and perform inspection/measurement; record source provenance, uncertainty, hazards,
   calibration, and conflicts. Facet may produce attributable design evidence.
5. Build controlled scope/options and a versioned quote from accepted inputs, assemblies, pricing,
   exclusions, and risk rules.
6. Approve the exact quote revision where required, create the exact proposal/publication revision,
   and record delivery readback.
7. Verify customer identity and authority; bind acceptance, rejection, cancellation, or requested
   change to the exact current publication.
8. Derive the deposit intent from accepted commercial truth; execute through the accounting
   provider only when configured and reconcile provider readback.
9. Evaluate independent production gates: contract, deposit, permit/authority, design/scope,
   materials, crew/competency/WCB, safety/weather/access, equipment/cargo, and other work-specific
   controls.
10. Create a versioned assignment, release the exact work package, and capture acknowledgements.
11. Execute physical work with check-in, evidence slots, safety stops, hold points, quality,
    inventory/material movement, changes, delays, incidents, and custody.
12. Accept the completion packet only when required physical, quality, customer, document, and
    deficiency facts are satisfied.
13. Derive the final-invoice intent; execute and reconcile posting, payment, credit/refund,
    holdback, and tax according to approved provider policy.
14. Deliver closeout, archive controlled evidence, declare warranty facts, and open service cases
    without rewriting the original job history.

### 7.1 Entry and exit gates

| Stage | Entry predicate | Exit evidence | Representative hard stop |
|---|---|---|---|
| Intake | Authenticated channel or bounded public session | Attributed lead and consent/source evidence | missing identity, suppression, duplicate ambiguity |
| Qualification | Triage context exists | qualified/disqualified decision with reason | out-of-scope work or authority |
| Survey/design | Qualified opportunity/job and permitted visit | attributable measurement/design revision | unsafe access, conflict, uncalibrated source |
| Commercial | Accepted source inputs and pricing policy | current published revision and delivery readback | unsupported claim, stale inputs, unapproved floor breach |
| Customer decision | Verified decision-maker sees exact revision | immutable acceptance/rejection/change decision | identity/authority mismatch, revision drift |
| Deposit | Binding acceptance and configured accounting mapping | provider posting/payment reconciliation or explicit exception | tax/mapping/provider ambiguity |
| Production readiness | Accepted scope plus relevant gate set | all required current gates ready | stale permit/WCB/weather, material/crew/access gap |
| Dispatch | Ready job and conflict-free capacity | current append-only assignment and acknowledged package | predecessor/version/custody conflict |
| Execution | Valid assignment, work package, hazard plan, hold releases | required physical/quality/change evidence | safety stop, hidden condition, unapproved change |
| Closeout | Substantial completion facts | accepted completion packet and controlled archive | deficiency, missing inspection/document |
| Financial closure | Accepted completion and current invoice intent | reconciled provider balance | mismatch, dispute, open credit/holdback |
| Service/warranty | Valid customer/property/job/asset relationship | verified remedy/customer decision/recovery reconciliation | responsibility/coverage/authority ambiguity |

## 8. Detailed user flows

### UF-01: Owner exception to governed resolution

**Trigger:** A material exception, approval, stop, provider ambiguity, policy decision, or overdue
control enters the owner scope.

1. Owner authenticates and opens **Now** or **Approvals**.
2. System groups exceptions by severity, deadline, job/customer, accountable function, and reason
   code without hiding source conflicts.
3. Owner opens the item and sees current facts, versions, evidence, prior decisions, policy result,
   financial/customer/safety impact, and recommended options.
4. Owner may approve, reject, request information, assign, contain, or abstain within exact authority.
5. The system records an immutable decision and, if applicable, creates a permitted internal or
   external effect; the browser never marks the provider effect successful.
6. The executor obtains readback and reconciliation or records an ambiguous/manual exception.
7. Now removes the item only after the owning state reaches a terminal, independently verifiable
   condition.

**Acceptance:** no approval can bypass a hard stop; every resolved item retains decision-maker,
evidence, policy, effect, readback, and closure proof.

### UF-02: Reception/ops lead intake to qualified job

1. Capture phone, web, portal, import, or internal lead with brand, identity, contact preference,
   consent, property, request, urgency, and raw source.
2. Detect likely duplicate person/property/lead and present reconciliation choices.
3. Triage serviceability, geography, customer authority, safety, claim language, complexity, and
   required inspection.
4. Request missing information through an allowed channel; respect suppression and timing rules.
5. Qualify, disqualify, or hold with stable reasons.
6. On accepted conversion, create/activate the owned customer, property, and roof-job relationship
   atomically; provider IDs remain mappings.
7. Create the next appointment/work item with actor, deadline, and prerequisites.

**Failure behavior:** retries are duplicate-safe; conflicting identity or consent fails closed into
an owned exception.

### UF-03: Sales lead to accepted commercial revision

1. Open a qualified lead/job in Sales Desk.
2. Confirm customer/property identity, authority, need, service fit, and current evidence.
3. Request or review measurements, Facet evidence, hazards, scope assumptions, controlled products,
   and exclusions.
4. Build a quote revision; the system shows price inputs, uncertainty, margin/risk controls, and
   evidence lineage.
5. Submit the exact revision for required approval; stale or superseded revisions cannot publish.
6. Create and publish the proposal/contract revision through a configured channel and record delivery
   readback.
7. Customer sees the exact current revision, disclosures, options, consequences, and person path.
8. Verified customer accepts, rejects, cancels, or requests change; decision binds to that revision.
9. Acceptance derives the deposit intent and commercial facts; it does not assert provider payment.

**Acceptance:** price/scope/terms cannot drift between approval, publication, customer display, and
acceptance; all changes create new revisions.

### UF-04: Production accepted job to released work package

1. Production opens the job and reads the derived phase plus independent gate statuses.
2. System evaluates the current required gate set for work type, jurisdiction, brand, customer,
   property, crew, materials, weather, access, equipment, and authority.
3. Production resolves missing facts through the owning workflow; a waiver is only possible where a
   policy explicitly permits it and records the accountable actor.
4. Create or supersede an assignment after conflict, capacity, competence, WCB, vehicle/cargo, and
   predecessor checks.
5. Generate/release a work package containing exact scope, location, versions, hazard plan,
   instructions, evidence slots, hold points, emergency contacts, stop conditions, and expiry.
6. Assigned workers acknowledge on their devices; changed packages require new acknowledgement.
7. Job appears in Today/field views only within current assignment and package authority.

**Acceptance:** schedule presentation cannot release blocked work; stale evidence invalidates the
relevant gate before start.

### UF-05: Field daily assignment, offline execution, stop, and completion

1. Worker signs in on a paired device and loads **Now/Today** while online.
2. Device caches the last valid assigned work package, hazard plan, emergency contacts, evidence
   requirements, and stop controls.
3. Worker checks in to the exact job/assignment and acknowledges the current package.
4. Start is accepted online only after all independent hold releases remain valid.
5. During network loss, the worker can read cached instructions, capture ordered attributable
   evidence, record allowed progress, and issue a stop/emergency action.
6. The worker cannot start new consequential scope, approve a change, release a safety stop, or infer
   completion from an offline queue.
7. On reconnect, queued actions replay in order with stable idempotency keys and version checks.
8. Conflicts become explicit exceptions; nothing silently overwrites newer authority.
9. Completion requires the declared evidence slots, hold-point/quality decisions, material/change
   facts, and responsible actor attestations.

**Acceptance:** a valid stop is immediate and cannot be overridden; replay produces at most one
committed transition per idempotency key.

### UF-06: Accounting intent to provider reconciliation

1. Accounting opens Money/Exceptions and selects a deposit, final-invoice, credit, refund, tax, or
   other supported intent.
2. System displays the exact source commercial/completion facts, amount/currency/entity, mapping,
   tax policy, provider identity, approvals, and prior attempts.
3. Accounting corrects missing configuration or approves within segregation-of-duties rules.
4. Executor consumes a registered permit and sends one idempotent provider action.
5. Provider acknowledgement/webhook is stored as evidence but does not by itself prove posting or
   payment.
6. System reads provider detail back, binds immutable external IDs, compares material fields, and
   records reconciled, rejected, compensated, not-executed, ambiguous, or manual-exception outcome.
7. Derived job phase updates only from authoritative accounting and completion facts.

**Acceptance:** duplicates, partial failure, amount/entity/tax mismatch, and unknown timeout are
visible and recoverable without inventing success.

### UF-07: Customer estimate, contract decision, status, and service

1. Customer enters through an approved public estimator, portal, proposal, or service link.
2. System identifies the business/brand, describes automation/recording where required, and captures
   consent and accessibility/channel preferences.
3. Estimate experience distinguishes assumptions and non-binding range from quote, contract,
   invoice, receipt, and warranty.
4. For a consequential decision, verify identity and authority and display the exact immutable
   revision with exclusions, changes, consequences, cancellation/correction/complaint paths.
5. Preserve the customer decision and content presented.
6. Portal status exposes only authorized, customer-safe facts and offers a person path.
7. Service intake binds customer/property/job/asset/warranty/consent, detects duplicates, and enters
   triage rather than promising coverage or fault.

**Acceptance:** no manufactured urgency, damage, scarcity, approval, warranty, or authority; all
customer decisions are correctable through governed history.

### UF-08: Service case to verified remedy and recovery

1. Create/deduplicate service case against owned customer, property, job, asset, warranty, and consent.
2. Human-authority triage classifies safety/containment, urgency, responsibility uncertainty, and
   required visit.
3. Diagnosis records attributable evidence and issues a service work package where permitted.
4. Field executes remedy through the normal safety/evidence controls.
5. A separate verification decision confirms remedy outcome; customer acceptance is recorded
   independently.
6. Supplier/manufacturer/insurer recovery creates an intent, not a claimed settlement.
7. Provider execution/readback reconciles the recovery, or a durable exception remains.
8. Reopen preserves the prior history and reason.

### UF-09: Tenant/company onboarding and configuration

1. Owner creates or accepts tenant/company setup with brand, legal entity, geography, service scope,
   users, roles, devices, and integration profile.
2. System validates required authorities and blocks unsupported scope from activation.
3. Configure pipelines/stages, schema fields/forms, documents, recipients, automations, and role
   grants as versioned histories.
4. Configure provider manifests with tenant/provider identity, scopes, directions, actions,
   idempotency, readback, fallback, proof TTL, and secret references outside user-visible data.
5. Run readiness checks and a non-customer reference journey.
6. Activate only the capabilities whose configuration and proof gates pass; leave others visibly
   disabled.
7. Export/restore/rollback and second-tenant isolation must be proven before claiming reusable
   Operating Packs or white-label maturity.

### UF-10: Governed AI proposal to verified effect

1. A role supplies one bounded goal.
2. Context builder provides a tenant/job-scoped snapshot with stable IDs, versions, source hashes,
   trust class, observed/effective time, and freshness deadlines.
3. Model derives or proposes registered actions with citations, preconditions, expected result,
   risk, stop condition, and ceilings.
4. Deterministic validator rejects unknown actions, missing/stale/conflicting facts, absent policy,
   or exhausted ceilings.
5. Policy engine returns allow, deny, or required human role; a permit binds the exact action input.
6. Coordinator executes only the permitted internal/external action through the registered adapter.
7. Readback and reconciliation verify the material result.
8. Audit records terminal outcome; no-progress, ambiguity, or conflict becomes an exception.

### UF-11: Integration failure and recovery

1. Adapter records requested effect with correlation and idempotency identity before sending.
2. On transport failure before execution, retry only inside the registered bounded policy.
3. On timeout/unknown outcome, stop automatic duplication and query provider readback.
4. If deterministic matching succeeds, reconcile; if it disproves success, compensate/retry as
   policy permits; if still ambiguous, assign manual exception.
5. Degraded product surfaces show the unavailable capability and safe fallback while preserving
   owned operation.
6. Recovery rebuilds projections from owned truth and replays only duplicate-safe pending work.

## 9. Capability model

### 9.1 Permanent operating functions

Every function requires an accountable role, canonical objects, SOP, authority, evidence, controls,
KPI, retention rule, and exception path.

| Group | Permanent functions |
|---|---|
| Govern | 1 Ownership and governance; 2 Legal/licence/compliance administration; 3 Market, brand, and claims |
| Win work | 4 Lead intake and communication; 5 Qualification and sales; 6 Property, inspection, and measurement; 7 System design; 8 Estimating and pricing; 9 Proposal, contract, and customer decision |
| Prepare | 10 Preconstruction; 11 Supplier and procurement; 12 Inventory and warehouse; 13 Shop manufacturing; 14 Production planning and dispatch |
| Execute | 15 Human field work; 16 Safety; 17 Quality; 18 Change, delay, incident, and dispute; 19 Completion and closeout |
| Sustain | 20 Warranty, service, and customer success; 21 Finance, accounting, tax, and cash; 22 People and subcontractors; 23 Fleet, equipment, and facility |
| Assure | 24 Data, software, privacy, security, and continuity; 25 Insurance, legal claims, and continuity; 26 Performance and improvement |

### 9.2 Product capability inventory and maturity

Snapshot state uses the six canonical proof classes from
[`DOCUMENTATION-CONTRACT.md`](./DOCUMENTATION-CONTRACT.md#required-truth-labels) — Source-present,
Locally-validated, Configured, Runtime-proven, Business-accepted, Customer-validated — never a prior
vocabulary and never a bare "Strong"/"Partial" qualifier standing in for a class. Where a capability's
covered scope has a named, reproducible check, that check is cited and earns Locally-validated for the
scope it covers; the class recorded here is the weakest class any part of that covered scope earns.
`Partial` is an orthogonal qualifier describing scope, not proof strength, and never substitutes for a
class. As of this pass no capability below cites Configured, Runtime-proven, Business-accepted, or
Customer-validated evidence: no capability's flags, secrets, and deployment are all bound in a named
environment per `docs/IRONWRAP-OS-PRODUCT-TEAM-SPEC.md` §9.3's verified flag-state audit, and no row in
`docs/CAPABILITY-MATRIX.md` or `docs/AI-NATIVE-ARCHITECTURE.md` asserts a fresh authenticated readback,
a named accountable human's acceptance of the capability itself, or real customer use.

| Capability | User outcome | Snapshot state | Required closure evidence |
|---|---|---|---|
| Identity, session, role navigation, device pairing | Right actor reaches a bounded surface | Source-present. Device pairing/invites reach Locally-validated (`workers-bus/test/app-user-invites.test.ts`, 23 cases); session and role-navigation cite no passing check. | Deployed tenant isolation, revocation, recovery, real-device proof |
| Now, Today, approvals, exceptions, search | Each role sees prioritized valid work | Source-present. The search backend reaches Locally-validated (`workers-bus/test/app-search.test.ts`) but is wired to no PWA surface; Now/Today/approvals/exceptions boards cite no passing check. | Runtime permission, staleness, and exception-resolution scenarios |
| Intake, lead triage, customer/property/job conversion | One owned demand thread without duplicate provider identity | Source-present. The JobNimbus/CRM import path reaches Locally-validated against a synthetic fixture only; the owned D1 import adapter, real dual-brand intake, and bridge retirement remain absent. | Real dual-brand intake, import reconciliation, bridge retirement |
| Survey, measurement, Facet evidence | Attributable geometry/design inputs and uncertainty | Source-present. The Facet v2 blank-quote contract reaches Locally-validated (`tools/validate-facet-blank-quote-contract.mjs`); live measurement OCR remains blocked on a live staging URL, owner participation, and a usable OCR provider, and real-site calibration is untested. | Real-site calibration, conflicting-source tests, configured Facet delivery |
| Estimate, quote, revisions, proposal publication | Exact reviewable commercial option | Source-present. Quote/proposal/publication routes are reachable; no named passing check is cited for the commercial path itself, and configured provider/tax/readback reconciliation is explicitly not proven. | Configured template/delivery/tax/readback and deterministic reference journey |
| Customer acceptance and deposit derivation | Exact decision creates the right financial intent | Source-present. Acceptance and deposit-derivation are production-reachable and transactionally sound; provider mapping, tax policy, and authority-ceiling configuration remain blocked, and no named passing check is cited. | Identity/revision scenarios plus QuickBooks sandbox/readback |
| Production gates and derived phase | Readiness is explainable and cannot be bypassed | Source-present. Authority-refusal messaging is pinned by captures against a live local stack; the PWA has no production-schedule approval surface at all, so an approver remains an API client. | Live issuer freshness, stale/conflict injection, phase vocabulary decision |
| Assignments and work packages | Field receives exact current authority | Source-present. The `0028` work-package-actions schema shipped to production (deploy `987ccbc6`, 2026-08-13); its later widening fix reaches Locally-validated (`workers-bus/test/app-migration.test.ts`), which is schema/storage evidence, not capability proof. Multi-worker acknowledgement, full evidence-slot enforcement, and real-device acceptance remain open. | Multi-worker, real-device offline full-day proof |
| Safety | Stops, incidents, readiness, corrective action remain authoritative | Locally-validated (repository tests including one emergency drill covering rescue, failed PPE, a duplicate offline report, a late corrective action, and independent release — `app/src/field/safety-action-panel.test.tsx` plus Worker-side coverage). No deployment, runtime, business-acceptance, or real-device proof. | Real-device drill and live reporting/readback where required |
| Quality, change, closeout | Work and deviations close with independent evidence | Source-present. No narrative implementation section or named passing check exists for quality, change, or closeout beyond the maturity-table summary. | Defect/hold/change propagation and real closeout/recovery |
| Inventory, warehouse, procurement | Materials and custody conserve through work | Locally-validated (`workers-bus/test/inventory-control.test.ts`, `workers-bus/test/inventory-control-api.test.ts` — conservation invariants and conserving movements). No PWA surface, no provider adapter, no deployment, no business-acceptance proof; supplier packets remain internal-only. | Receiving PWA, supplier transmission, AP adapter, live reconciliation |
| Shop manufacturing | Controlled release, QC, yield, bundle handover | Locally-validated, Partial (corrected 2026-08-31, ELEC-244). `frappe-apps/ironwrap_roofing/tests/test_shop_fabrication_api.py` covers the release/reservation/setup-route/first-piece/final-QC/yield/bundle/handover/billing-basis chain in 29 cases; that CI step is `continue-on-error: true`, so it is a local pass, not a merge gate. Shop travelers and assemblies are a different scope and remain Target — no `shop_traveler` or assembly DocType exists — which settles the scope mismatch filed below. | Physical event capture, tooling/maintenance, dispatch and billing proof |
| Scheduling/dispatch | Conflict-free assignment from current facts | Source-present. The D1 assignment-revision/conflict-check ledger exists; scheduler capacity remains target-only and no solver or booking surface exists. No named passing check is cited. | Capacity/weather/material inputs and dispatcher acceptance |
| Fleet/equipment/cargo | Unsafe or wrong-custody assets cannot release | Locally-validated (`frappe-apps/ironwrap_roofing/tests/test_fleet_operations_policy.py`, `.../test_fleet_panel_api.py` pin the release fence exactly). Photo evidence capture is absent, not merely unproven — no code path writes it. No deployment, runtime, real-vehicle, or business-accepted proof. | Photo evidence, telematics identity, collision lifecycle, real vehicle day |
| Accounting and QuickBooks | Approved intent becomes provider-posted reconciled truth | Source-present. QuickBooks OAuth and final-invoice execution are off in every environment (`docs/AI-NATIVE-ARCHITECTURE.md` machine-checked snapshot); provider mapping, tax, and readback remain incomplete and no accountable human has signed off. | OAuth, mapping/tax, sandbox effect/readback, accountant signoff |
| Service/warranty/recovery | Complaint becomes attributable verified remedy | Locally-validated (Multica ELEC-21 drove the lifecycle end to end from a real browser against a local stack, found two defects, both fixed and now covered by tests; named suites: 867 Worker tests, 337 Frappe tests, 474 PWA tests, 267/267 deployment-contract checks). Cost recovery is not yet an effect-runtime adapter; no supplier, manufacturer, or insurer is called from any code path; Playwright/MCP evidence was not re-run on this branch. No deployment, runtime, or business-acceptance proof. | Dispatch/portal/mobile integration, provider recovery settlement |
| Customer portal/public estimator | Customer can decide and self-serve safely | Locally-validated (`app/e2e/customer-portal-materials.spec.ts` drives the comparison and decision on a Pixel 5 viewport with no-horizontal-scroll and 44px-target assertions). Public estimator is off in production and staging (`docs/AI-NATIVE-ARCHITECTURE.md` machine-checked snapshot). No deployment, runtime, business-acceptance, or customer proof. | Accessibility, identity, real customer scenarios, public config proof |
| Pipeline/form/document configuration | Operating views evolve without bypassing authority | Source-present. The documents read model reaches Locally-validated (`workers-bus/test/record-documents-api.test.ts`); the administrator-facing drag-and-drop, schema-form, and document-generation PWA surfaces are not built, and the document-generation flag is false in every checked-in environment. | Merged UI, typed command proof, runtime document generation/readback |
| Provider manifests and readiness | Capabilities fail visibly and safely | Source-present. This is repository capability only: no tenant is configured or proven until a governed external path appends approved manifests and fresh provider readbacks, and no named passing check is cited for the readiness evaluator's own claims. | Named-environment dependency health, proof TTL, degraded/recovery drills |
| Hermes/MCP/AI coordination | Bounded drafting and proposals reduce routine work | Source-present. Hermes is a disabled, single-pilot draft path with no resident context-plan-policy-permit-action-readback-reconciliation coordinator; no named passing check is cited for the coordination claim itself. | Deterministic reference journey before model-assisted trials |
| Frappe compatibility and retirement | Legacy projection does not regain authority | Source-present. Frappe remains an optional, non-blocking projection; the release-admission chain names "no reachable adapter, provider command, staging/production Frappe identity, or live receipt" as proven; cutover is incomplete. | Consumer inventory, parity/cutover proof, restore/rebuild, disabled writes |
| White label / Operating Packs | Repeat safe tenant setup without drift | Source-present. Only a single maturity-table line and one DocType mention exist in the matrix; no narrative implementation or named passing check is cited. | Second real tenant, isolation, upgrade/rollback compatibility |
| Governance, workforce, facility, insurance, compliance | Whole-company controls join operating facts | Source-present. Legal/licence (Authority Records) and workforce (Crew Profile projections) sub-areas have real substrate; governance, facility, and insurance sub-areas are almost entirely target/absent. No named passing check is cited for any sub-area. | Owning objects, issuer readbacks, drills, accountable signoffs |

Open items this pass could not settle, reported per the rule that an unsettled label is filed, not left
silently at its prior value:

- **Shop manufacturing scope mismatch — SETTLED 2026-08-31 (ELEC-244), no product decision needed.**
  The settling evidence this item named was collected: `frappe-apps/ironwrap_roofing` has seven shop
  DocTypes (`shop_order`, `shop_order_line`, `shop_operation`, `shop_material_allocation`,
  `shop_inspection`, `shop_yield`, `shop_bundle`) covered by 29 cases in
  `tests/test_shop_fabrication_api.py`, and it has no `shop_traveler` or assembly DocType — the string
  "traveler" appears nowhere in the tree. The two sections describe different objects, so both were
  accurate and neither was overclaiming. `docs/CAPABILITY-MATRIX.md` now says so explicitly in both
  places, and its Shop row is Locally-validated, Partial.
- **Production-plan schedule-check and owner-onboarding rows.** ELEC-233 (G1.4) is in flight and may
  move the production gates/derived-phase row (schedule-check) and the identity/session row
  (owner-onboarding, i.e. the Settings/company-setup surface). Both are labeled here at what they earn
  today; re-check against ELEC-233's green assertion once it lands. Owner: ELEC-233.
- **CAPABILITY-MATRIX.md's own domain tables — CLOSED 2026-08-31 by ELEC-244.** The fast-follow ran:
  the "Capability-by-capability target" table (30 domain rows, not the 26 estimated here) and the
  "Seven-area maturity snapshot" (7 rows) now carry the six canonical classes, and
  `docs/DOCUMENTATION-CONTRACT.md`'s migration pointer records the migration as complete. No tracked
  document still asserts proof in a prior vocabulary.
- **Two default-off/unconfigured findings G1.3 (ELEC-232) parked under this goal**: the `ERPNEXT_BASE_URL`
  split between `deploy/env.example:19` and `workers-bus/wrangler.jsonc:180`, and
  `tools/production-readiness.mjs` covering none of the eight capabilities G1.3 named. Neither is a
  proof-label judgment call; both need an engineering fix. Owner: PO to assign to the platform seat.

### 9.3 Verified capability flag state of the reference configuration

Verified against the repository at `main` @ `3da7ee2b`, not against a live environment. The
reference configuration is `workers-bus/wrangler.jsonc`: top-level `vars` is the production
deployment, and `env.local` / `env.staging` replace those vars wholesale rather than inheriting
them. Worker secrets are never in the repository, so every claim below about a secret is `unknown`
and marked as such. `docs/AI-NATIVE-ARCHITECTURE.md` is a documentation claim about these flags,
not evidence of them; the bindings and code paths cited here are the evidence.

Three states, and they never merge:

- **absent** — no code path in `workers-bus/src` reads the name; nothing is switched off because
  there is nothing behind it.
- **present, default-off** — the code path exists and its flag is `"false"` in the reference
  configuration. The surface refuses before doing any work (`404` or `503`).
- **present and on but unconfigured** — the flag is `"true"`, or there is no flag at all, but a
  required value is empty. The surface is reachable and fails at first use with a named code.

| Capability | Controlling binding (`file:line`) | Reference default | State | What a user must be shown |
|---|---|---|---|---|
| QuickBooks OAuth | `workers-bus/wrangler.jsonc:183` `QB_OAUTH_ENABLED` | `"false"` (local `:383`, staging `:565` also `"false"`) | present, default-off; unconfigured underneath | Not connected; connecting is an administrator action that needs Intuit credentials |
| QuickBooks final-invoice execution | `workers-bus/wrangler.jsonc:184` `QB_FINAL_INVOICE_ENABLED` | `"false"` (local `:384`, staging `:566` also `"false"`) | present, default-off; unconfigured underneath | Off — no invoice reaches QuickBooks; approved intent waits |
| Hermes desktop | `workers-bus/wrangler.jsonc:209` `APP_HERMES_DESKTOP_ENABLED` | `"false"` (local `:403`, staging `:585` also `"false"`) | present, default-off | Not available |
| Hermes hosted reference execution | `workers-bus/src/hermes-desktop.ts:1629` `APP_HERMES_HOSTED_REFERENCE_ENABLED` | undeclared in every environment | present, default-off by omission | Not available |
| Public estimator | `workers-bus/wrangler.jsonc:194` `PUBLIC_ESTIMATE_ENABLED` | `"false"` production and staging (`:574`); `"true"` in `env.local` (`:392`) | present, default-off in the deployed configuration | Off in production; the local stack is not evidence for it |
| Newo | `workers-bus/wrangler.jsonc:130` `NEWO_ENABLED` | `"false"` (local `:339`, staging `:526` also `"false"`) | present, default-off; unconfigured underneath | Off |
| Postiz | `workers-bus/wrangler.jsonc:224` `POSTIZ_ENABLED` | `"false"` (local `:418`, staging `:600` also `"false"`) | present, default-off; unconfigured underneath | Off |
| Facet v2 design ingest | `workers-bus/wrangler.jsonc:215` `FACET_V2_INGEST_ENABLED` plus `:216` `FACET_V2_ROUTES_JSON` | `"true"` with routes `"[]"` | **present and on but unconfigured** | On but not configured — no Facet route is registered, so delivery fails |
| Facet launch | `workers-bus/wrangler.jsonc:221` `APP_FACET_LAUNCH_ENABLED` plus `:222` `APP_FACET_LAUNCH_BASE_URL`, `:223` `APP_FACET_LAUNCH_SOURCE_TENANT_ID` | `"true"` with both values empty | **present and on but unconfigured** | On but not configured — launching a Facet design fails |
| Facet v2 native projection | `workers-bus/wrangler.jsonc:217` `FACET_V2_NATIVE_PROJECTION_ENABLED` | `"true"` in every environment | present and on; idle because it projects only accepted ingest rows | Available, with nothing to project until ingest is configured |
| Facet design → Frappe projection | `workers-bus/wrangler.jsonc:218` `FACET_DESIGN_FRAPPE_PROJECTION_ENABLED` | `"false"` in every environment | present, default-off | Off (a retiring projection) |
| Facet v1 design ingest | `workers-bus/wrangler.jsonc:213` `FACET_DESIGN_INGEST_ENABLED` | `"false"` in every environment | **absent** — no consumer in `workers-bus/src`; only `tools/production-readiness.mjs:938` reads it | Nothing; the name must not appear as a capability |
| Facet quote-revision prepare | `workers-bus/wrangler.jsonc:219` `APP_FACET_QUOTE_REVISION_PREPARE_ENABLED` | `"false"` in every environment | **absent as a control** — declared at `workers-bus/src/app-types.ts:101` but read nowhere in `src`; the surface it names is gated by broker configuration instead | Nothing; the flag does not describe what the user gets |
| Proposal-template configuration | `workers-bus/wrangler.jsonc:236` `PROPOSAL_TEMPLATE_DOC_ID` | `""`; not declared at all in `env.local` or `env.staging` | **present and on but unconfigured** — no flag exists; the route is mounted unconditionally at `workers-bus/src/app-api.ts:884` | Generate proposal is offered and fails with `proposal_doc_not_configured`; the action must be shown as not configured, not as unavailable |
| Proposal publication | `workers-bus/wrangler.jsonc:220` `APP_PROPOSAL_PUBLICATION_ENABLED` | `"false"` production and staging (`:596`); `"true"` in `env.local` (`:414`) | present, default-off in the deployed configuration | Off |
| Document generation | `workers-bus/wrangler.jsonc:123` `APP_DOCUMENT_GENERATION_ENABLED` | `"false"` in every environment | present, default-off | Off |

Code paths and refusal behaviour behind each row:

- **QuickBooks.** Both flags are read at `workers-bus/src/quickbooks-final-invoice.ts:411` and
  `:415`; OAuth start refuses with `quickbooks_oauth_disabled` (`:838`) and dispatch with
  `quickbooks_final_invoice_disabled` (`:1234`). The callback route is
  `workers-bus/src/index.ts:572` and the Intuit webhook `:771`. Flipping either flag alone does
  not enable the capability: `configuration()` (`:3089`) also requires
  `QB_TOKEN_ENCRYPTION_KEY_VERSION`, which is `""` at
  `workers-bus/wrangler.jsonc:188`, and the `QB_CLIENT_ID` / `QB_CLIENT_SECRET` /
  `QB_TOKEN_ENCRYPTION_KEY` secrets.
- **Hermes desktop.** Every desktop route refuses with `404` at
  `workers-bus/src/hermes-desktop.ts:220`, `:307` and `:334`; the pairing route is wired at
  `workers-bus/src/app-api.ts:553`. Reference execution needs a second flag and
  `APP_HERMES_PROVIDER_MODEL` (`workers-bus/src/hermes-desktop.ts:1633`); neither name appears in
  any environment of `wrangler.jsonc`.
- **Public estimator.** `workers-bus/src/public-estimator.ts:226` reads the flag; readiness treats
  deactivated as healthy (`:210`). Enabling it in production additionally requires allowed origins,
  allowed brands, a consent jurisdiction, a Turnstile site key, an empty legacy range list — all
  `""` at `workers-bus/wrangler.jsonc:195-203` — and the `PUBLIC_ESTIMATE_TURNSTILE_SECRET` and
  `PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER` secrets.
- **Newo.** The webhook plane refuses with `newo_disabled` at `workers-bus/src/newo.ts:169` and the
  control plane at `workers-bus/src/newo-control.ts:747`. Enabling it also requires
  `NEWO_PROJECT_ID`, `NEWO_AGENT_ID`, both webhook ids and URLs and `NEWO_PHONE_NUMBER` — all `""`
  at `workers-bus/wrangler.jsonc:135-140` and `:147` — plus the `NEWO_API_KEY`,
  `NEWO_WEBHOOK_TOKEN` and `NEWO_BOOKING_TOKEN` secrets (`workers-bus/src/operations.ts:505`,
  `:522`).
- **Postiz.** `workers-bus/src/postiz.ts:151`; every entry point separates `postiz_disabled` from
  `postiz_not_configured` (`:453`, `:523`, `:600`, `:644`). Configuration additionally requires
  `POSTIZ_API_BASE_URL`, `""` at `workers-bus/wrangler.jsonc:226`, and the `POSTIZ_API_KEY` secret
  (`workers-bus/src/postiz.ts:1242`).
- **Facet routes.** `/ingest/facet-design` (`workers-bus/src/index.ts:668`) and
  `/ingest/facet-estimator-ready` (`:676`) are switched **on**, so they do not answer `404`; they
  answer `503 facet_v2_ingest_unavailable` / `facet_estimator_ready_unavailable` because
  `facetV2StaticRoutes` rejects an empty array (`workers-bus/src/facet-design-ingest.ts:389-394`)
  and the `FACET_V2_KEYS_JSON` secret is absent (`workers-bus/src/facet-design-ingest.ts:368`).
  The office launch route (`workers-bus/src/app-api.ts:1490`) answers
  `503 facet_launch_not_configured` for the same reason
  plus the empty base URL and source tenant (`workers-bus/src/facet-launch.ts:658`).
- **Proposal template.** There is no enable flag. `workers-bus/src/proposal-doc-action.ts:81-83`
  returns `503 proposal_doc_not_configured` when the template id is empty or Google is
  unconfigured. This is the one row where "disabled" would be actively misleading: the action is
  offered to an estimator and fails at first use.

**Is the effect runtime actually enabled?** Yes, in all three environments:
`EFFECT_RUNTIME_ENABLED` is `"true"` at `workers-bus/wrangler.jsonc:122` (production), `:331`
(local) and `:518` (staging). It is not decoration — `assertEffectLedgerReady`
(`workers-bus/src/effect-runtime.ts:195`) refuses every provider mutation with
`effect_runtime_required` unless the flag is `"true"`, and with `effect_ledger_unavailable` unless
the D1 binding resolves; the QuickBooks, JobNimbus, Google, Newo, Postiz, Frappe and Facet
projection adapters all call it. Its schema is
`workers-bus/migrations/0042_external_effect_runtime.sql` and
`0062_external_effect_insert_replace_guards.sql`. What the repository cannot show is whether
those migrations are applied in the deployed database; that is a runtime readback, and
`canonicalEffectLedgerSchemaReady` (`workers-bus/src/capability-readiness.ts:658`) is the probe
that would answer it.

**Runtime-readable versus build-time.** None of these flags is build-time: `app/` contains no
`import.meta.env` feature gate, so the PWA bundle is identical whatever the configuration says, and
every state above is decided per request in the Worker. That makes an honest UI possible, but not
automatic:

- `GET /api/v1/integrations/readiness` (`workers-bus/src/app-api.ts:1616`, office roles only) is
  the one composed capability read model. It covers sixteen capability ids
  (`workers-bus/src/capability-readiness.ts:11-29`) and reports `newo`, `postiz`,
  `public_estimator`, `quickbooks` and `facet_association` among them. Note that its `quickbooks`
  signal is credentials-and-realm, not `QB_OAUTH_ENABLED` (`:637`) — flag state and readiness
  signal are different facts and must not be shown as one.
- Per-surface signals exist for a few others: `quickBooksAvailable` in the company-setup read model
  (`workers-bus/src/company-setup-api.ts:448`) and `allowed_actions` omission for proposal
  publication (`workers-bus/src/app-api.ts:5497`).
- `GET /api/v1/session` (`workers-bus/src/app-api.ts:640`) carries no capability flags at all, so a
  non-office role has no runtime way to learn that Hermes desktop, the proposal template or the
  Facet routes are unavailable; those surfaces discover it only from a `404`/`503` at first use.
  Hermes desktop, proposal-template configuration and the Facet ingest routes have no entry in the
  readiness read model either.

**Unknown from the repository.** Each of these needs a named-environment readback, not another
document: whether any Worker secret is actually set (`QB_*`, `NEWO_*`, `POSTIZ_API_KEY`,
`FACET_V2_KEYS_JSON`, `FACET_LAUNCH_HMAC_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`); whether the deployed
D1 has migrations `0042`, `0062` and `0118` applied; whether any `capability_integration_manifests`
or `capability_proof_facts` row exists for this tenant, since the repository seeds none; and
whether the deployed Worker's live vars still match this file, which only a `/ready` or
`/api/v1/integrations/readiness` readback can settle. Until then every row above is a
source-present configuration fact, and the UI must present it as such.

## 10. Functional requirements

### 10.1 Control kernel

- **FR-CTL-001:** Every mutable aggregate has owned tenant ID, stable ID, version, state machine,
  immutable events, and retention class.
- **FR-CTL-002:** Every transition validates expected version/state, authenticated actor, exact
  action permission, required inputs/evidence/freshness, policy version, hard stops, and idempotency.
- **FR-CTL-003:** State and audit event commit atomically or enter a named partial-failure state.
- **FR-CTL-004:** Corrections append or supersede; ordinary users and agents cannot rewrite history.
- **FR-CTL-005:** All denials return stable reason codes plus a safe human-readable resolution path.
- **FR-CTL-006:** Tenant isolation is enforced at storage, query, object, cache, queue, effect,
  evidence, and provider-mapping boundaries.
- **FR-CTL-007:** Shared accounts and unattributed effects are rejected.

### 10.2 Evidence and documents

- **FR-EVD-001:** Evidence supports `source`, `derived`, `physical`, `authority`, `financial`,
  `decision`, and `negative` classes with class-specific integrity metadata.
- **FR-EVD-002:** Raw evidence bytes live immutably in R2 or an authenticated external reference;
  D1 stores identity, hashes, binding, version, and lifecycle metadata.
- **FR-EVD-003:** Evidence freshness includes issuer, subject/scope, effective/expiry, revocation,
  recheck, clock tolerance, retention, and access class.
- **FR-EVD-004:** Conflicting sources are resolved by exact authority/scope/time/integrity or become a
  blocking exception; the system never averages or chooses convenience.
- **FR-EVD-005:** Generated documents bind template/version, schema values, source facts, actor,
  digest, object key, effect/readback, and terminal receipt.
- **FR-EVD-006:** A missing or ambiguous document/effect readback cannot create a duplicate object or
  false completion.

### 10.3 Side effects and integrations

- **FR-EFX-001:** Each external action uses a registered action kind and versioned integration
  manifest with exact provider/tenant identity, scopes, direction, data class, retry, readback,
  reconciliation, fallback, readiness, and proof TTL.
- **FR-EFX-002:** The effect ledger records requested, permitted, attempted, acknowledged, read back,
  reconciled, compensated, rejected, not-executed, ambiguous, and manual-exception outcomes.
- **FR-EFX-003:** Provider credentials are unavailable to models and ordinary browser code.
- **FR-EFX-004:** Webhook receipt or transport success is evidence, not business completion.
- **FR-EFX-005:** Retries are bounded and duplicate-safe; unknown outcomes require readback before
  another consequential attempt.
- **FR-EFX-006:** Readiness is dependency-specific and user-visible; one healthy provider cannot mask
  another required provider's failure.

### 10.4 Commercial and customer decision

- **FR-COM-001:** Quote, proposal, publication, acceptance, cancellation, and change are immutable
  revision chains with exact cross-references.
- **FR-COM-002:** Published customer content derives only from approved current facts and controlled
  templates/claims.
- **FR-COM-003:** Customer acceptance verifies identity/authority and binds the exact displayed
  revision and content digest.
- **FR-COM-004:** Acceptance derives deposit intent through policy; it cannot claim payment/posting.
- **FR-COM-005:** Scope, price, assumptions, exclusions, tax, cancellation, warranty, and change
  consequences remain visible at decision time.
- **FR-COM-006:** Customer correction, complaint, appeal, and immediate person paths are preserved.

### 10.5 Production, field, safety, and quality

- **FR-OPS-001:** Production gates are independent versioned facts with exact evidence and freshness.
- **FR-OPS-002:** Assignments append/supersede and reject crew, capacity, custody, predecessor, or
  version conflicts.
- **FR-OPS-003:** Work packages bind scope, location, versions, actors, instructions, hazards,
  evidence slots, hold points, stop conditions, emergency contacts, and expiry.
- **FR-OPS-004:** Worker acknowledgement is actor/device/package-version specific.
- **FR-OPS-005:** Start validates all current holds online; offline cache cannot mint a release.
- **FR-OPS-006:** Stop-work is always available, immediate, durable, and not overridable by schedule,
  margin, AI, or ordinary approval.
- **FR-OPS-007:** Completion requires declared evidence and independent hold/quality decisions; a
  message, photo alone, or mutable status is insufficient.
- **FR-OPS-008:** Material, custody, yield, change, incident, deficiency, and closeout facts reconcile
  across physical and financial quantities.

### 10.6 Finance and accounting

- **FR-FIN-001:** Accounting actions begin as owned intents derived from authoritative commercial or
  completion facts.
- **FR-FIN-002:** QuickBooks remains posted accounting truth; IronWrap owns intent, policy, mapping,
  effect, readback, mirror, reconciliation, and exception.
- **FR-FIN-003:** Provider detail readback must match entity, amount, currency, tax, document identity,
  and source intent before reconciliation.
- **FR-FIN-004:** Payment, refund, credit, holdback, payroll, tax, and filing capabilities remain
  disabled until their exact policy and posting target are approved and proven.
- **FR-FIN-005:** Segregation of duties prevents one actor from creating sensitive master data,
  releasing the effect, and independently closing the audit finding where policy requires separation.

### 10.7 Configuration and administration

- **FR-CFG-001:** Company, role, device, pipeline, stage, field, form, template, recipient,
  automation, provider, and operating-profile changes are versioned and attributable.
- **FR-CFG-002:** Pipeline cards are read models over domain facts; drag/drop maps to a registered
  versioned command and preserves gate blockers.
- **FR-CFG-003:** Field definitions declare type, validation, sensitivity, authority, evidence,
  offline behavior, correction, and retention.
- **FR-CFG-004:** Activation requires validation, preview/dry run where possible, rollback path, and
  affected-surface traceability.
- **FR-CFG-005:** Exports never include plaintext secrets; imports are validated, tenant-scoped, and
  upgrade/rollback compatible.

### 10.8 AI and automation

- **FR-AI-001:** Models can observe, derive, and propose only; deterministic code owns policy,
  permits, transitions, effects, readback, and reconciliation.
- **FR-AI-002:** Context snapshots label untrusted text as data and include stable fact citations,
  versions, trust, time, and freshness.
- **FR-AI-003:** Plan proposals declare one goal, bounded steps, registered actions, citations,
  preconditions, risk, expected result, stop condition, reviewer class, and ceilings.
- **FR-AI-004:** Unknown actions, missing citations, stale/conflicting facts, absent policy, and
  exhausted ceilings produce abstention plus a durable exception.
- **FR-AI-005:** Agent-to-agent coordination uses canonical objects/events, not unbounded peer chat.
- **FR-AI-006:** Agent/tool/model/policy versions are recorded for every consequential proposal and
  audited outcome.

## 11. Domain and state model

### 11.1 Canonical object families

| Family | Representative objects |
|---|---|
| Identity and governance | tenant, brand, legal entity, owner, delegation, authority, policy, licence, permit |
| Relationship | person, organization, customer, property, contact point, consent, suppression |
| Demand and commercial | lead, opportunity, appointment, survey, measurement, design, option, estimate, quote, proposal/publication, contract, acceptance, cancellation, change |
| Product and supply | controlled product, assembly, manufacturer document, supplier, catalog snapshot, supplier quote, purchase order, receipt, credit, recall |
| Inventory and shop | item, lot, coil/sheet, bin/location, reservation, remnant, scrap, count, work centre, machine, tooling, calibration, route, operation, first piece, NCR, bundle |
| People and assets | employee, subcontractor, competency, credential, apprenticeship, training, WCB, assignment, vehicle, trailer, equipment, inspection, maintenance, incident, custody |
| Delivery | roof job, gate, schedule, work package, field event, hazard, hold point, evidence, completion |
| Finance | intent, invoice, holdback, payment, refund, payroll, tax filing, provider mirror, reconciliation |
| Aftercare | warranty declaration, service case, complaint, remedy, review request, recovery intent |
| Platform and assurance | workflow view, pipeline, form/schema, template, integration manifest, operating profile/pack, audit finding, risk, exception, corrective action, recovery test |

### 11.2 Independent authoritative lifecycles

1. Lead: `captured → triaged → qualified | disqualified → converted`.
2. Measurement/design/quote/proposal/publication/acceptance: immutable revision chains.
3. Production gates: one lifecycle per required gate, with freshness and revocation.
4. Assignment: append-only revisions and supersession.
5. Work package: `Draft → Released → Acknowledged → In Progress → Blocked | Completed | Superseded`.
6. Safety: report/stop/rescue/make-safe/corrective action/independent release.
7. Accounting: intent/approval/execution/readback/reconciliation/exception.
8. Closeout/warranty/service: completion packet, warranty facts, service diagnosis/remedy/verification,
   customer decision, recovery reconciliation, and reopen history.

### 11.3 Derived job phase

`job_phase` is a read-only projection. Current executable source defines:

`cancelled`, `qualification_pending`, `qualified`, `commercial_in_progress`, `deposit_pending`,
`production_blocked`, `safety_blocked`, `production_ready`, `scheduled`, `in_progress`,
`substantially_complete`, and `financially_closed`.

The canonical operating document also describes a distinct `contracted` phase. Current
`derivePhase` does not emit it; accepted work without a reconciled deposit becomes
`deposit_pending`. Product and architecture owners must either align the canonical vocabulary or
add the missing derived predicate before treating phase names as a stable external contract.
No command may use the projection as its source of authority.

## 12. System architecture

### 12.1 Current target topology

- **PWA:** role and customer interaction, offline cache/outbox, typed commands, read models.
- **Worker application API:** authentication, tenant/role checks, validation, policies, transitions,
  effects, provider adapters, reconciliation, and read models.
- **D1:** owned operating aggregates, immutable transitions, effects, receipts, configuration, and
  projections needed for deterministic reads.
- **R2:** immutable raw evidence and generated controlled objects; D1 stores bindings and digests.
- **QuickBooks:** posted accounting truth reached through bounded accounting intents and readback.
- **Facet:** separate project/design authority that can deliver attributable design evidence to an
  IronWrap roof job; it does not own quote, contract, deposit, schedule, invoice, or accounting truth.
- **Frappe:** temporary compatibility projection scheduled for evidence-backed retirement; it must
  not regain writes or authority.
- **Google Drive:** human-readable controlled archive where configured, not an operating database.
- **Email/SMS/voice, Postiz, Newo, JobNimbus/imports, suppliers, authorities:** bounded adapters or
  sources under manifests, identity mapping, idempotency, readback, and retirement rules.
- **Hermes/MCP:** bounded read/dry-run/proposal adapters and a default-off narrow drafting pilot;
  never the resident operating authority.

### 12.2 Trust boundaries

| Boundary | Required control |
|---|---|
| Browser → Worker | Authenticated session, CSRF/origin controls as applicable, tenant/role permission, validation, expected version, idempotency |
| Worker → D1 | Prepared/scoped access, atomic transition plus audit, no tenantless mutation |
| Worker → R2 | Content hash, tenant/aggregate binding, immutable key, controlled access/retention |
| Worker → provider | Registered adapter, secret isolation, exact permit, bounded retry, provider identity, readback/reconciliation |
| Facet → IronWrap | Signed attributable evidence delivery, project/job mapping, version/hash, acceptance/refusal; no commercial mutation |
| Frappe ↔ IronWrap | D1-to-projection only for allowed compatibility data; rebuildable and non-authoritative |
| AI → control kernel | Bounded context/proposal schema; no raw credentials, generic SQL, provider mutation, or inferred permit |
| Offline device → Worker | Paired identity, signed/ordered queue item, allowed offline action class, replay idempotency, version/conflict checks |

### 12.3 API behavior conventions

- Versioned `/api/v1` contracts, stable machine reason codes, structured validation errors.
- Tenant and actor context derived from authenticated server state, never trusted request fields.
- Mutations require exact aggregate version or other explicit precondition.
- `Idempotency-Key` or equivalent is mandatory for retryable consequential commands.
- Read models include generation time and stale reasons when facts are incomplete.
- Capability state is derived per request from live bindings, never from a build-time constant or a
  cached value that could survive a configuration change, and flag state stays a separate field from
  configuration readiness.
- External-effect endpoints return requested/pending/exception state; they do not claim provider
  completion before readback.
- Pagination, filtering, and search remain permission-scoped and bounded.
- Logs and telemetry carry correlation IDs but redact secrets and protected content.

## 13. Offline, degraded, and emergency operation

- Cache only the last valid assignment/work package, hazard plan, emergency contacts, and needed
  reference data for the authenticated worker/device.
- Declare each action as online-only, offline-capturable, or emergency-safe; default to online-only.
- Permit offline evidence capture, bounded progress facts, stop, and emergency stabilization under
  the owning policy.
- Prohibit new consequential starts, releases, approvals, customer decisions, accounting effects,
  inventory assumptions, and provider claims while authority cannot be verified.
- Preserve queue order, actor/device identity, local time plus server receipt time, payload digest,
  and stable idempotency identity.
- Reconnect performs authentication, revocation/freshness, version, and conflict checks before
  committing each item.
- Surface partial replay and manual exception; never discard or silently overwrite field evidence.
- Recovery must restore D1, evidence, identity, and configuration to an isolated target and rebuild
  compatibility projections without treating them as authority.

## 14. Security, privacy, and compliance requirements

### 14.1 Security and privacy

- Least privilege by actor, role, tenant, job, customer, amount, geography, time, device, data class,
  and operation.
- Strong session lifecycle, device pairing/revocation, credential rotation, secret isolation, and
  auditable privilege changes.
- Input validation and output encoding at every trust boundary; safe file type/size/content handling.
- Encryption in transit and at rest using platform controls; no secrets in exports, logs, prompts,
  evidence metadata, or client bundles.
- Data inventory, purpose/consent, retention, legal hold, access, correction, export, destruction,
  breach, and recovery behavior for every sensitive object class.
- Model context minimization and prompt-injection isolation: connector/document/message text is data,
  never instruction.
- Independent audit findings require a separate verifier where the originating actor cannot close
  its own finding.

### 14.2 Compliance domains

The product must support, but never self-issue, the following control families:

- Edmonton/Alberta business, facility, municipal, permit, code, and inspection authority;
- residential consumer contracting, disclosures, cancellation, and direct/prepaid-sales triggers;
- Alberta OHS, stop-work, incidents, training, rescue, fall protection, and COR evidence;
- WCB accounts, subcontractor clearance, worker/subcontractor status, and rechecks;
- trade competency, restricted activities, apprentices, supervisors, manufacturer requirements;
- employment, accommodation, payroll/time/records, protected decisions, and human review;
- prompt payment, proper invoice, holdback, lien, change, dispute, and billing control;
- GST/tax, accounting, T5018/payroll/filing calendars, reconciliation, and record retention;
- privacy, recordings, access, cybersecurity, breach, retention, and destruction;
- CASL, DNCL, channel/purpose/timing consent and suppression;
- advertising, reviews, warranty, damage, price, scarcity, approval, and performance claims;
- asbestos/hazardous material, waste, recycling, environmental, and disposal authority;
- fleet, driver, carrier, inspection, cargo, custody, collision, and maintenance;
- insurance policies, certificates, limits/exclusions, claims, notification, recovery, and warranty.

Legal/compliance owners must convert researched triggers into approved policy and evidence rules;
software must not infer legal conclusions from this synthesis.

## 15. Accessibility and content requirements

- Target WCAG 2.2 AA for authenticated and customer-facing web surfaces.
- Full keyboard operation, visible focus, semantic landmarks/headings, programmatic names,
  live-region restraint, error association, and focus return for dialogs.
- Touch targets and mobile layouts suitable for gloved/field use where practicable; do not encode
  status by color alone.
- Reduced-motion support and no safety-critical meaning dependent on animation.
- Plain-language blocking reasons with stable technical reason code available for support.
- Estimates, quotes, contracts, invoices, receipts, warranties, and service decisions use distinct
  labels and content models.
- Customer/worker language and accessibility preferences are facts, not free-text assumptions.
- Evidence capture describes purpose, required view/quality, privacy implications, and correction
  path before submission.

## 16. Non-functional requirements

| ID | Requirement | Acceptance evidence |
|---|---|---|
| NFR-REL-001 | Consequential mutations are idempotent and recover to a named outcome. | Duplicate, timeout, partial-failure, and replay tests. |
| NFR-REL-002 | Read models expose stale/missing dependencies instead of optimistic progress. | Stale evidence and unavailable-provider scenarios. |
| NFR-DUR-001 | Immutable evidence, transitions, effects, and receipts survive restore. | Isolated restore plus hash/reconstruction verification. |
| NFR-SEC-001 | Tenant/role/object isolation is deny-by-default. | Cross-tenant and horizontal/vertical privilege tests. |
| NFR-SEC-002 | Secrets and protected data are excluded from prompts, logs, client bundles, exports, and receipts. | Static/runtime redaction tests and review. |
| NFR-OFF-001 | Field-safe cached data and allowed queue actions work on supported real devices. | Full offline job/day exercise. |
| NFR-A11Y-001 | Critical role and customer journeys meet WCAG 2.2 AA. | Automated checks plus keyboard/screen-reader/manual review. |
| NFR-OBS-001 | Requests, transitions, effects, and readbacks share correlation IDs and stable reason codes. | Trace reconstruction from one scenario. |
| NFR-PERF-001 | Performance budgets are defined per route/query/evidence operation before release. | Named p50/p95/p99 and payload/render budgets with measured results. |
| NFR-BCP-001 | RPO, RTO, outage tolerance, escalation, and safe degraded behavior are approved per capability. | Timed restore and dependency-outage drills. |
| NFR-COMP-001 | Retention/access/destruction and issuer recheck are policy-driven per data/evidence class. | Policy tests and sampled audit. |

Numeric availability, latency, RPO, and RTO targets are intentionally not invented here. Product,
operations, compliance, and cost owners must approve them for each named environment before a
production-readiness claim.

## 17. Analytics, telemetry, and product KPIs

Metrics inform humans; they never bypass authority or become unreviewed worker/customer scoring.

| Outcome | Candidate metric | Required segmentation/guardrail |
|---|---|---|
| Demand quality | lead response time, qualification time, qualified/disqualified reasons | brand, channel, geography; consent and fairness review |
| Commercial flow | measurement-to-quote, quote-to-publication, decision cycle, revision count | work type, evidence completeness; never reward hidden scope |
| Production readiness | time in each gate, stale/blocked reasons, reschedule causes | job/work type; safety and authority stops excluded from “speed” pressure |
| Field execution | acknowledged/start/stop/completion cycle, offline replay outcomes | crew/job/device; no unsafe productivity ranking |
| Safety/quality | stops, near misses, hold/NCR/deficiency, independent closure time | severity and recurrence; reward reporting, not silence |
| Material/shop | reservation accuracy, shortage, yield/scrap, custody mismatch | item/lot/job/work centre; preserve measurement uncertainty |
| Finance | intent-to-post, reconciliation lag, exception/mismatch, cash/AR aging | provider/entity/job; posted truth only |
| Customer | decision clarity, person escalations, complaints, service reopen, accepted remedy | channel/accessibility/work type; no dark-pattern optimization |
| Reliability | error/timeout/ambiguous outcomes, queue age, dependency readiness, restore results | environment/provider/action kind |
| AI | abstention, citation failure, policy denial, human edit/acceptance, effect reconciliation | action/risk/model/policy version; never model confidence alone |

Each metric needs an owner, exact event definition, denominator, freshness, retention, access,
anti-gaming note, and baseline before a target is approved.

## 18. Quality strategy and acceptance

### 18.1 Validation ladder

1. Pure domain/state/policy tests for deterministic predicates and reason codes.
2. Storage tests for versioning, tenant isolation, atomic event writes, idempotency, and migrations.
3. Adapter contract tests for signatures, retries, readback, ambiguity, compensation, and redaction.
4. API tests for authentication, permission, validation, conflicts, stale evidence, and error shape.
5. PWA component/route tests for role navigation, forms, offline states, focus, and plain-language
   blockers.
6. Integration tests with provider sandboxes or controlled fakes that preserve provider semantics.
7. Real-device offline, camera/evidence, pairing/revocation, and replay exercises.
8. Named-environment dependency/readiness, restore, and degraded-operation drills.
9. Controlled non-customer reference journey across the full lifecycle.
10. Separate accountable customer validation after legal, operational, and readiness gates.

This ladder is not a second proof vocabulary. It coarsens onto the six proof classes defined in
[`DOCUMENTATION-CONTRACT.md`](./DOCUMENTATION-CONTRACT.md#required-truth-labels): rungs 1–5 are
Locally-validated; rung 6 is Configured once its sandbox is credentialed and named, and only reaches
Runtime-proven if a live authenticated call and its readback actually executed against it; rungs 7–9
are Runtime-proven, with rung 9 its fullest single-capability instance; rung 10 is Customer-validated.
Business-accepted has no numbered rung — it is a named accountable human reviewing and accepting the
evidence gathered at rung 8 or 9, not an eleventh rung.

### 18.2 Required adversarial scenarios

- Cross-tenant identifiers, stale versions, duplicate requests, replayed webhook, and revoked device.
- Customer accepts a superseded publication or lacks decision authority.
- Measurement sources conflict or a source/evidence hash changes.
- Permit, WCB, competency, weather, equipment, or evidence expires after scheduling and before start.
- Valid worker stop during time pressure; unauthorized actor attempts release.
- Offline queue reconnects after assignment/package supersession.
- Provider times out after possible effect; webhook arrives before/after readback; amount/entity differs.
- Supplier shortage/substitution, inventory unit mismatch, shop defect/yield mismatch, and custody gap.
- Hidden condition/change order affects scope, schedule, material, price, and work package.
- Completion packet exists but final invoice is not reconciled; accounting readback exists but
  physical completion is missing.
- AI receives prompt injection, stale context, missing citations, unsupported action, or no-progress loop.
- Backup restores without a projection, with projection drift, or with pending effects.

### 18.3 End-to-end acceptance package

A capability is complete only when its package names:

- objective and owning canonical requirement;
- exact source commit, test checkout, CI run, and artifact digest;
- configured environment and dependency/readiness readback;
- authenticated actors, roles, tenant, devices, provider accounts, and data classification;
- scenario inputs, versions, evidence, policy, transitions, effects, readbacks, and reconciliation;
- expected and observed negative/degraded cases;
- accessibility, privacy, security, retention, restore, and support evidence;
- accountable business acceptance and, separately, customer validation where applicable.

## 19. Delivery plan and gates

The canonical mutable program remains in `CAPABILITY-MATRIX.md`. Team delivery should follow these
gates without treating a later gate as evidence for an earlier one:

| Gate | Outcome | Exit condition |
|---|---|---|
| 0: Documentation and authority | One vocabulary and non-bypassable actor/evidence/effect contract | Docs validation and reviewed authority rules |
| 1: Work package and evidence | Exact attributable human work unit | Assignment/package/evidence/offline negative tests |
| 2: People, safety, external authority | Current competency/WCB/permit/stop controls | Freshness/revocation/stop scenarios |
| 3: Item, inventory, shop, quality | Conserving physical material/fabrication truth | Receive-to-yield/quality/custody reconciliation |
| 4: Deterministic commercial closure | Exact quote/publication/acceptance/accounting intents | No-seed reference path through configured provider readback |
| 5: Physical and service loops | Completion, closeout, warranty/service and recovery | Realistic field/service scenarios and restore |
| 6: Thin governed AI coordinator | Bounded proposals over deterministic controls | Citation/abstention/policy/permit/readback trials |
| 7: Configured reference environment | Minimum providers, policies, profiles, readiness | Named-environment manifests and proof TTLs |
| 8: Technical production-reference proof | Full controlled non-customer journey | Exact evidence bundle and accountable review |
| 9: Customer validation | Real customer journey within approved scope | Separate legal, operational, experience acceptance |

### 19.1 Recommended team workstreams

| Workstream | Primary ownership | Must coordinate with |
|---|---|---|
| Product/operations | Scope, personas, workflows, policies, success measures | All domain owners, design, engineering, QA |
| Design/content/accessibility | Information architecture, role journeys, forms, decision content, field/customer usability | Product, compliance, frontend, QA |
| Control-plane/backend | Aggregates, policies, transitions, effects, readbacks, projections | Data, integrations, security, domain owners |
| PWA/frontend | Role surfaces, typed commands, offline, evidence capture, accessibility | Backend, design, QA, field operators |
| Data/evidence | D1/R2 schemas, migrations, lineage, retention, restore, analytics | Backend, security, compliance, QA |
| Integrations/accounting | Manifests, mappings, adapters, provider semantics, reconciliation | Accounting, backend, security, QA |
| AI/automation | Context/proposal schemas, evaluation, bounded tools, audit | Backend, security, product, QA |
| Security/privacy/compliance | Threat model, controls, policy mapping, audits, incident/retention | Every workstream and accountable human authorities |
| QA/release/SRE | Test strategy, environment proof, observability, backup/restore, release receipts | Engineering, product, operations, support |
| Adoption/support | Training, SOPs, migration, support playbooks, business/customer acceptance | Product, operations, design, QA |

## 20. Release, migration, and operational readiness

- Release admission must bind authored source, base, exact tested checkout/tree, CI run/attempt/job,
  migration set, artifact, and required approvals.
- Concurrency cancellation or a mutable branch comparison cannot upgrade an old green run into proof
  for a new head.
- Migrations are forward-controlled, tenant-safe, observable, and restore-tested; structural counts
  remain governed by the capability contract.
- Frappe retirement requires consumer inventory, D1 parity, cutover/export, rebuild/restore, write
  disablement, and post-cutover reconciliation before removal.
- JobNimbus/temporary CRM/automation bridges require owned import mapping, duplicate/conflict
  handling, reconciliation, and retirement evidence; no indefinite dual-write.
- Provider capabilities remain disabled until credentials, scopes, mappings, policy, webhook/readback,
  reconciliation, safe fallback, and accountable acceptance pass.
- Runbooks cover dependency outage, effect ambiguity, queue backlog, provider revocation, security/
  privacy incident, data restore, field offline day, and emergency stabilization.
- Rollback never rewrites committed business history; use compensation, supersession, feature
  disablement, and projection rebuild.

## 21. Risks, decisions, and explicit gaps

| ID | Item | Current implication | Required owner/decision |
|---|---|---|---|
| DEC-001 | Canonical `contracted` phase vs current executable phase vocabulary | External consumers could bind to inconsistent names | Product + architecture: align projector or canonical wording |
| DEC-002 | Holdback and payroll posting target/policy | Related actions remain intentionally unavailable | Owner + accounting + legal/compliance |
| DEC-003 | QuickBooks provider/tax/mapping/readback configuration | Source route cannot prove financial closure | Accounting + integration owner |
| DEC-004 | Proposal template and delivery provider | Customer publication path cannot be runtime-proven | Sales/product + compliance + integration owner |
| DEC-005 | Facet delivery routes and acceptance contract in environment | Design evidence remains unconfigured externally | Facet + IronWrap product/architecture |
| DEC-006 | Frappe consumer retirement sequence | Compatibility duplication and drift risk remain | Architecture + operations + data |
| DEC-007 | JobNimbus/import bridge cutover | Dual-source identity and reconciliation risk | Operations + data/integrations |
| DEC-008 | Shop, facility, workforce, and external-authority breadth | Whole-company vision remains partly target | Owner + operations + compliance |
| DEC-009 | Public estimator, Newo, Postiz, Hermes activation | Capabilities must stay visibly default-off | Product + security/compliance + channel owner |
| DEC-010 | Numeric SLO/RPO/RTO and support model | Production-readiness cannot be claimed | Owner + SRE/operations + cost owner |
| DEC-011 | Real-customer validation cohort and authority | Technical proof cannot substitute for customer proof | Owner + operations + legal/compliance |

Top systemic risks are authority drift, provider ambiguity, duplicate identities/effects,
configuration-presented-as-capability, Frappe/provider projection regaining authority, stale field
evidence, offline conflict loss, privacy leakage into prompts/logs, and KPI pressure that suppresses
safety or truthful exception reporting.

## 22. Definition of done

A story is done when:

- its owning requirement and actor/authority/evidence boundaries are named;
- happy, negative, stale, duplicate, unauthorized, offline/degraded, and ambiguous paths appropriate
  to its risk are implemented;
- schema/migration, API, UI, content, accessibility, telemetry, privacy/retention, and support impact
  are addressed;
- focused tests pass, broader required gates pass, and no unrelated user work is included;
- documentation and diagrams are updated without creating competing authority;
- the claim's proof class is reported using the six-class vocabulary in
  [`DOCUMENTATION-CONTRACT.md`](./DOCUMENTATION-CONTRACT.md#required-truth-labels) — Source-present,
  Locally-validated, Configured, Runtime-proven, Business-accepted, Customer-validated — never rounded
  up past what its evidence actually earns;
- a provider or physical capability includes readback/reconciliation, not only request success;
- accountable product/domain owner accepts the behavior in the correct environment.

A capability is done only when all constituent stories plus configuration, dependency readiness,
restore/degraded operation, end-to-end proof, and accountable acceptance pass. A release is done only
when required artifacts are published and the named environment is verified. Customer validation is
never inferred from either.

## 23. Traceability index

| Concern | Primary authority | Key implementation evidence in this snapshot |
|---|---|---|
| Product topology and AI loop | `AI-NATIVE-ARCHITECTURE.md` | `app/src/router.tsx`, `app/src/components/app-shell.tsx`, `workers-bus/src/app-api.ts` |
| Company scope and 26 functions | `AUTONOMOUS-OPERATING-SYSTEM.md` | Domain modules across `workers-bus/src`, role PWA routes |
| Actors, authority, transitions, evidence, effects | `AUTHORITY-AND-EVIDENCE-CONTRACT.md` | D1 migrations, policy/authority/effect/readback modules, offline outbox |
| Current maturity and gates | `CAPABILITY-MATRIX.md` | Current source plus exact validation receipts; never docs alone |
| Compliance triggers and human signoffs | `COMPLIANCE-REGISTER.md` | Authority records, gates, safety, consent, finance, fleet/service modules |
| PWA roles and routes | Owning contracts above | `app/src/lib/roles.ts`, `app/src/router.tsx`, `app/README.md` |
| Derived phase | Architecture/operating contracts | `workers-bus/src/commercial-job-phase.ts` |
| Customer/service surfaces | Authority and capability contracts | portal, contract, estimate, and service routes/components |
| Visual system map and journeys | This synthesis, subordinate to all above | `docs/diagrams/ironwrap-os-product-atlas.html` |
| Complete role, process, integration, scenario, and UI evidence catalog | This synthesis, subordinate to all above | `docs/IRONWRAP-OS-OPERATIONS-AND-UI-ANNEX.md` |

## 24. Glossary

| Term | Meaning |
|---|---|
| Authority | Verifiable right to perform the exact action in scope; never model confidence. |
| Evidence | Immutable attributable support for a fact or decision, with class-specific integrity. |
| Effect | A consequential internal, provider, customer, vendor, legal, or physical action attempt. |
| Readback | An independent query/receipt that verifies what materially happened after an effect. |
| Reconciliation | Deterministic comparison of intent, effect, external result, and owned mirror. |
| Permit | Machine-consumable authorization binding exact action, input, scope, policy, time, and limits. |
| Gate | Independent readiness condition whose current evidence must pass before release. |
| Projection/read model | Rebuildable view derived from authoritative facts; not independently writable. |
| Work package | Versioned, assigned, acknowledged unit of physical work with instructions, evidence, holds, and stop controls. |
| Operating profile | Versioned configuration for a tenant/environment; not proof that providers work. |
| Operating Pack | Reusable configuration only after repeated tenant, upgrade, rollback, and isolation proof. |
| Technical reference proof | Controlled full-system journey without implying real customer validation. |
