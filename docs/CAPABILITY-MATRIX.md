# Capability Matrix

Status: canonical implementation gap register
Owner: IronWrap OS product owner
Last verified: 2026-07-30
Review trigger: merged capability, changed proof, deployment, or production acceptance

## Status vocabulary

- **Implemented**: code/configuration exists in the repository.
- **Repository-verified**: a fresh deterministic check passed against the named commit.
- **Partial**: useful implementation exists but a material target boundary is missing.
- **Target-only**: required by the autonomous operating system but not implemented.
- **External proof required**: completion depends on a live provider, device, authority, customer, or
  physical workflow.

This file does not claim current deployment or production state. Fresh live evidence must come from
the launch/readiness tooling and the named external authority.

## Repository baseline

Fresh checks on 2026-07-30 against this migration branch established:

| Contract | Result |
|---|---|
| Documentation | 43 registered documents; authority, privacy paths, review metadata, and internal links validated |
| Frappe model | 64 DocTypes: 48 top-level and 16 child |
| Hermes policy | 8 roles validated against 169 implemented MCP tools |
| Tenant isolation config | 2 tenant configs validated |
| Newo release config | 5 staged tools, 31 operations, 20 production blockers represented |
| Deployment contract | 198 checks passed, 0 failed |
| D1 backup/restore contract | 33 required production tables and 43 invariant-trigger bindings validated by the deployment verifier |
| D1 migration chain | 28 migrations applied to an isolated local database |
| PWA | 210 unit tests; typecheck, lint, format, build, and distribution checks passed |
| PWA browser | 15 Playwright tests passed; 3 WebGL estimator cases were skipped by the configured suite |
| Worker | 258 tests, typecheck, and explicit top-level-environment dry-run bundle passed |
| MCP | 100 tests across Frappe, bus, and Newo servers passed |
| Frappe | 102 unit tests passed |
| Deployment/recovery tools | 72 tests passed |
| Production Node dependencies | `npm audit --omit=dev` reported zero known vulnerabilities for app, Worker, and all three MCP packages |

These are branch-local repository facts, not exact-commit CI, deployed, runtime, business-accepted,
or production-proven facts. CI must repeat them against the committed head.

## Implemented substrate

### Owned intake and evidence spine

Implemented:

- Cloudflare Worker routing for health/readiness, public, BFF, ingest, webhook, admin, and scheduled
  work.
- Raw-first intake for lead, photo, measurement, estimate, QuickBooks, and Newo paths.
- D1 envelopes, audit, dead letter, source counts, heartbeat, dedup, replay, auth, field action,
  field Work Package action, approval, portal, measurement, rate-limit, outbox, and Newo ledgers.
- R2 raw/evidence references.
- Queue/retry/reconciliation behavior.
- Idempotency and approval ledgers.
- Backup/restore contracts with fail-closed target selection and immutable completion markers.

Missing for autonomous target:

- general event/transition envelope across every company aggregate;
- inventory/shop/fleet/workforce/safety/quality/accounting event ledgers;
- universal evidence freshness, revocation, conflict, and compensation semantics;
- production proof across one real end-to-end job.

### Frappe operating core

Implemented model families:

- lead, customer, property, roof job, appointment, receptionist, estimate;
- measurement, roof area, visual model, evidence, field check-in;
- takeoff, supplier quote/order, price rule, quote, option, scope;
- contract acceptance, customer decision, change order, insurance supplement;
- production gate, crew, assignment, safety plan/acknowledgement, job compliance;
- payment milestone, completion, warranty, review request;
- communication consent/event;
- versioned Work Package, step, hold point, and immutable Work Package event records;
- controlled item, material lot, shop order, nonconformance;
- reconciliation, automation incident, Hermes run, tenant export, white-label tenant, market watch.

Material target gaps:

- legal entity, owner/delegation, licence, permit application/inspection, policy version;
- employee, applicant, apprenticeship, training, competency evidence, HR case, time/payroll;
- subcontractor agreement, WCB clearance lifecycle, insurance certificate, trade authorization;
- item master, warehouse/bin, lot/coil/sheet, reservation, remnant, scrap, count, transfer;
- work centre, machine, tooling, route/operation, calibration, maintenance, downtime;
- receiving inspection, first-piece/in-process/final inspection, NCR, quarantine, disposition;
- vehicle, trailer, driver, carrier status, inspection, maintenance, collision, cargo;
- complete multi-worker work-package acknowledgement, physical evidence-slot enforcement, and
  production-proven independent hold release;
- safety incident/near miss/property event distinct from automation incidents;
- controlled assembly/manufacturer document/technical bulletin/recall/claims substantiation;
- permit/code/authority object with effective/revocation checks;
- invoice/holdback/refund/filing/payroll mirrors and provider reconciliation;
- service case, complaint, callback diagnosis, responsibility, remedy, and recovery;
- insurance policy/claim, legal hold, continuity exercise, and audit finding.

### Hermes and MCP

Implemented:

- role-filtered reads, dry-runs, reviewed writes, policy checks, signed receipts, and audit.
- owner, lead, estimator, production, field, finance-reconciliation, closeout, and support roles.
- no direct accounting mutation.
- Frappe, bus, and Newo boundaries.

Current constraint:

- most consequential Frappe writes require a human approval receipt;
- customer communication is generally record-only;
- routine autonomous external supplier, customer, accounting, regulator, and machine side effects
  are not present.

Target changes:

- preserve the existing human-approved path as the safe compatibility level;
- add scoped policy-issued machine authority receipts for routine digital transitions;
- retain humans for physical work, customer choice/person request, exceptional judgment, and
  legally required signoff;
- add procurement, inventory, shop, safety, quality, workforce, fleet/facility, tax, customer
  success, security/privacy, and independent-audit roles;
- separate policy authoring, activation, execution, and audit;
- make all side effects idempotent and provider-reconciled.

### PWA

Implemented surfaces:

- public estimate;
- authentication, field bootstrap, device pairing;
- today, job detail, offline check-in, and proof;
- owner, approval inbox, sales, production, Newo operations;
- estimator workbench and quote revision;
- production schedule approval;
- customer portal links and resolution;
- settings.

Target gaps:

- exact versioned human work package with step/hold-point/evidence slots;
- shop floor, warehouse, receiving, inventory, counter sale, and delivery;
- employee/competency/training and subcontractor clearance;
- fleet/equipment inspection and maintenance;
- safety incident, emergency, NCR, quarantine, and corrective action;
- customer complaint/warranty service case;
- compliance/licence/permit/claims calendars;
- finance/cash/tax exception views;
- accessible human escalation and relationship-sensitive handoff across every customer surface;
- real-device, high-volume, offline, accessibility, and business acceptance proof.

### Provider integrations

Implemented or represented:

- JobNimbus bridge;
- Google email/Drive paths;
- QuickBooks webhook receipts/mirrors;
- Newo inbound/control/reconciliation;
- Cloudflare D1/R2/Queue/Workers;
- Frappe and Hermes;
- temporary Make/Jotform/RoofRuler compatibility paths.

Target gaps:

- proof-backed retirement of temporary CRM/automation bridges;
- direct customer send with consent/delivery/suppression reconciliation;
- direct supplier order and acknowledgement;
- permit/regulator submission/status;
- WCB clearance retrieval/status;
- accounting invoice/payment/refund/payroll/tax side-effect contracts;
- commercial e-sign or owned signing;
- machine, scanner, scale, printer, vehicle, wearable, and sensor identity/telemetry;
- vendor failure and provider-switch continuity.

## Capability-by-capability target

| Domain | Current state | Autonomous target gap | Proof required |
|---|---|---|---|
| Governance | Target prose and owner role | corporate/delegation/policy objects and activation separation | policy change audit |
| Legal/licence | job compliance authority records with effective/expiry/revocation fences and owner-attributed waivers | full authority register, jurisdiction rules, and issuer integration | issuer recheck and blocked release |
| Marketing | lead source + market watch | claims ledger, campaign side effects, suppression | unsupported claim rejected |
| Lead intake | Strong implemented spine | all real sources cut over and bridge retirement | real dual-brand lead, reconcile |
| Consent/comms | consent/event records and policy checks | autonomous provider send and response/suppression loop | opt-in/send/reply/STOP/reconcile |
| Qualification | lead triage + estimate session | complete service/authority/risk policy | adversarial lead suite |
| Survey | measurement/roof graph/evidence | field work package, calibration, conflict resolution | real site and conflicting source test |
| Design | scope/options/quote evidence | controlled assemblies, details, bulletins, engineer/permit | system/version conflict block |
| Estimate | takeoff/price/quote/revision | complete shop/labour/equipment/risk costing | estimate-to-actual closed job |
| Contract | acceptance/evidence | correct agreement selection, cancellation, e-sign, authority | residential/commercial scenarios |
| Preconstruction | seven gates plus current Crew/Safety/Access authority fences, including owner-attributed waivers | complete multi-domain readiness and issuer-backed freshness | stale permit/WCB/weather injection |
| Procurement | supplier quote/order records | vendor onboarding, PO transmit/ack, substitution, three-way match | duplicate/short/backorder test |
| Inventory | Partial: signed controlled-item approval, lot receipt, and Shop Order reservation | bin/remnant/count/valuation plus use and reconciliation | receive-reserve-use-reconcile |
| Shop | Partial: signed release, reservation, setup route, and independent first-piece pass/hold into fabrication | cutting/fabrication events, work-centre tooling, yield, label, maintenance, final QC, and handoff | physical synthetic/real shop batch |
| Scheduling | assignment and approval ledger | complete constraint solver and autonomous reschedule | conflict/weather/material test |
| Human field work | assignment-scoped Work Package, offline cached instructions, protected acknowledgement/stop intents, online start after every independently verified hold release | multi-worker acknowledgement, full physical evidence-slot enforcement, and real-device acceptance | full offline job/day |
| Safety | plan/acknowledgement plus Crew Profile competence, WCB, equipment, and active-stop release fences | individual equipment/incident/rescue registers and real-world proof | stop/emergency drill |
| Quality | Partial: signed independent first-piece pass or Quality Hold with verified evidence | ITP, final inspection, NCR, quarantine, and disposition | seeded defect containment |
| Change | change order/supplement | full design/work-package/order/schedule propagation | hidden-condition scenario |
| Closeout | completion/warranty/review records | inspection, as-built, registration, accounting and archive loop | real closeout and recovery |
| Warranty/service | warranty packet | service case, diagnosis, responsibility, remedy, recovery | callback end to end |
| Finance | payment mirror + reconciliation | invoice/holdback/payment/refund/tax/payroll contracts | provider sandbox and accountant signoff |
| Workforce | crew/assignment plus current competence and WCB summary controls | individual worker authority, HR, apprenticeship, time, accommodation | worker lifecycle |
| Fleet/equipment | none | asset/driver/inspection/maintenance/cargo/incident | unsafe asset release blocked |
| Facility | deployment infra only | shop/building/fire/security/environmental operations | facility inspection/drill |
| Privacy/security | strong technical controls, consent; production dependency audit clear | complete data inventory, DSAR, breach, retention/destruction; resolve or explicitly accept dev-toolchain advisories | restore, breach, access, production-audit tests |
| Insurance/risk | generic compliance | policy/claim/notification/recovery | claim tabletop |
| Audit | Hermes/audit/reconcile records | independent cross-domain audit and anomaly closure | reconstruct full job |
| White label | tenant config/export/isolation | complete operating-domain isolation and managed ops | second real tenant proof |

## Gap audit of the previous operating model

The previous high-level model correctly identified the broad company functions but was
insufficient as an implementation contract in these areas:

1. It did not define the machine authority receipt that replaces routine human approval.
2. It did not specify a canonical transition envelope or aggregate version precondition.
3. It did not define evidence freshness, revocation, correction, and source conflict.
4. It treated human evidence capture as a concept rather than an exact work-package schema.
5. It did not separate AI reliability from device, sensor, provider, customer, or physical
   reliability.
6. It did not define offline/degraded physical execution.
7. It did not define shop work centres, routes, tooling, first-piece inspection, NCR, or yield
   objects.
8. It did not define inventory lot/remnant/quarantine/count/valuation transitions.
9. It did not define employee, apprenticeship, competency, WCB, and subcontractor lifecycles.
10. It did not define fleet/carrier/cargo/equipment/facility control objects.
11. It did not define controlled assemblies and manufacturer/code revision propagation.
12. It did not define service-case diagnosis, responsibility, remedy, and cost recovery.
13. It did not define customer correction/appeal/person-request mechanics.
14. It did not define side-effect ambiguous-result and compensation behavior.
15. It did not distinguish repository, deployment, runtime, business acceptance, and production
    proof in a machine-enforced documentation policy.

The canonical operating and authority contracts now close the specification gaps. The
implementation gaps in this matrix remain real.

## Build order

Build in dependency order. Do not create all agents first.

### Gate 0: documentation and authority

- canonical contracts and documentation validator;
- no legacy/generated/customer documents in Git;
- implementation versus live proof vocabulary;
- policy, transition, evidence, and human work-package schemas.

### Gate 1: work package and evidence

- generic versioned work package, step, hold point, evidence slot, stop, supersession;
- offline field execution and duplicate-safe replay;
- evidence freshness/conflict/correction;
- independent release.

Why first: every physical domain consumes this contract.

### Gate 2: people, safety, and external authority

- person/employee/subcontractor/competency/trade/apprenticeship/WCB;
- licence/permit/inspection/manufacturer authority;
- safety equipment, incident, emergency, corrective action;
- expiry/revocation/freshness checks.

### Gate 3: item, inventory, shop, and quality

- item/lot/bin/reservation/remnant/scrap/count;
- receiving and three-way identity;
- work centre/machine/tooling/route/operation;
- first-piece/in-process/final inspection, NCR, quarantine, disposition;
- labels, bundles, loading, delivery, and yield.

### Gate 4: end-to-end commercial autonomy

- design/estimate/quote/contract machine authority;
- procurement transmit/ack/reconcile;
- schedule/reschedule;
- customer communication send/suppression;
- accounting invoice/payment/refund/holdback/tax reconciliation.

### Gate 5: workforce, fleet, facility, and service

- HR/time/payroll interfaces;
- vehicle/equipment/facility operations;
- complaint/warranty/service;
- insurance/claim/continuity.

### Gate 6: independent autonomous audit

- cross-domain invariants;
- anomaly and fraud controls;
- recovery/compensation;
- complete job reconstruction;
- autonomous policy proposals with separate owner activation.

### Gate 7: production proof

- one real job through every applicable state;
- one supply-only shop order;
- one warranty/service case;
- one outage/offline recovery;
- one safety stop and one quality NCR drill;
- one second-tenant isolation/export/restore proof.

## Completion definition

The repository supports the complete reliable-agent/human-physical model only when:

- every target gap above is implemented or explicitly excluded by owner policy;
- every row has fresh repository evidence;
- live external dependencies pass their own gates;
- a real business-accepted workflow proves the eleven end-to-end criteria in
  [`AUTONOMOUS-OPERATING-SYSTEM.md`](./AUTONOMOUS-OPERATING-SYSTEM.md);
- no current operation depends on a hidden spreadsheet, private chat, untracked checklist, or
  historical document.
