# IronWrap AI-Native Architecture

Status: canonical architecture map and target
Owner: IronWrap OS product owner
Last source verification: 2026-08-22
Review trigger: authority, lifecycle, repository, integration, AI, capability, or proof-state change

## Purpose and truth boundary

This document is the canonical map of what IronWrap OS is, what the audited repository currently
implements, and how the system becomes AI-native without giving a model business authority.

It does not replace:

- [`AUTONOMOUS-OPERATING-SYSTEM.md`](./AUTONOMOUS-OPERATING-SYSTEM.md), which owns the complete
  company target and human work model;
- [`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](./AUTHORITY-AND-EVIDENCE-CONTRACT.md), which owns binding
  transition, evidence, safety, approval, side-effect, and reconciliation rules;
- [`CAPABILITY-MATRIX.md`](./CAPABILITY-MATRIX.md), which owns mutable implementation,
  configuration, and proof status; or
- [`COMPLIANCE-REGISTER.md`](./COMPLIANCE-REGISTER.md), which owns external-control review.

Repository prose never proves deployment, runtime health, customer acceptance, or production
operation. Code, configuration, CI, artifacts, deployments, provider readbacks, reference runs,
and customer outcomes are separate evidence classes.

## Definition

IronWrap OS is an evidence-first operating system for a roofing, exterior-construction, and metal
fabrication company. It turns signals into governed, reconciled business transitions:

```text
AI or a person interprets and proposes
  -> deterministic policy authorizes
  -> an exact permit binds the action
  -> a controlled tool executes
  -> the provider or owned store is read back
  -> reconciliation and evidence close the loop
```

AI is never the system of record, never holds provider credentials, never mints its own authority,
and never converts uncertainty into business truth.

## Current executable topology

```mermaid
flowchart LR
    Channels["Lead, customer, office, field,<br/>measurement and provider signals"]
    App["Role PWA<br/>Owner · Ops · Sales · Production · Accounting · Field"]
    Facet["Facet<br/>Design and customer-design evidence"]
    Worker["Cloudflare Worker<br/>Owned business control plane"]
    AI["Bounded AI adapters<br/>Measurement OCR · Hermes draft pilot"]
    D1[("D1<br/>Canonical operating state")]
    R2[("R2<br/>Raw evidence and artifacts")]
    Queue["Queues and scheduled recovery"]
    Effects["External-effect ledger<br/>attempt · readback · reconciliation"]
    Providers["QuickBooks · JobNimbus · communications · issuers"]
    Frappe["Frappe<br/>Compatibility projection"]

    Channels --> App
    App --> Worker
    Facet <-->|signed versioned evidence| Worker
    AI --> Worker
    Worker --> D1
    Worker --> R2
    Worker --> Queue
    Worker --> Effects
    Effects --> Providers
    Providers -->|readback| Effects
    Effects --> D1
    D1 -. rebuildable projection .-> Frappe
```

The primary executable modules are:

| Module | Interface and responsibility |
|---|---|
| [`workers-bus/`](../workers-bus/) | Worker routes, domain transitions, D1/R2 persistence, queues, effects, provider readback, and reconciliation |
| [`app/`](../app/) | Same-origin role and customer surfaces, offline field capture, and approval experiences |
| [`frappe-apps/ironwrap_roofing/`](../frappe-apps/ironwrap_roofing/) | Temporary compatibility projection and legacy command adapters; no new operating authority |
| [`mcp/`](../mcp/) | Bounded read, preview, compatibility, and recovery adapters; not a second policy or state layer |
| [`hermes/`](../hermes/) | Role/tool configuration and the narrow desktop drafting pilot; not a resident autonomous runtime |
| Facet repository | Separate design bounded context and signed evidence producer |
| Home Config 3D repository | Separate predecessor/lineage product; not an IronWrap OS runtime dependency |

## Authority map

| Fact or transition | Authority | Supporting evidence | AI role |
|---|---|---|---|
| Lead, customer, property, job | D1 plus Worker policy | Source receipts in R2 | Classify, summarize, propose |
| Measurement | Accepted D1 measurement version | Original reports/images in R2 | Extract review-required candidates |
| Design artifact and design decision | Facet inside its bounded context | Frozen artifacts and signed event | Design assistance only |
| Design-to-job commercial association | IronWrap D1 | Signed Facet receipt plus office association | None |
| Quote, proposal, publication | IronWrap D1 | Versioned artifacts and delivery receipts | Draft/explain only |
| Customer acceptance | IronWrap D1 bound to the exact current publication | Customer identity, challenge, terms, receipt | Prohibited |
| Production gates and assignment | IronWrap D1 | Permits, crew/gate versions, receipts | Recommend only |
| Work package and safety | IronWrap D1 | Field evidence, raw timestamps/media | Summarize and escalate only |
| Posted invoice/payment fact | Authenticated accounting-provider readback | Provider ID and response hash | None |
| Accounting intent and reconciliation | IronWrap D1 | Basis, approval, effect, provider readback | Explain exceptions only |
| AI plan | Append-only coordination audit | Context/model/prompt/schema hashes | Non-authoritative proposal |
| Policy decision and permit | Deterministic versioned policy | Exact inputs, actor, scope, expiry | None |

Facet cannot change a quote, proposal, contract acceptance, production schedule, or accounting
record. Frappe cannot originate or authorize operating truth. QuickBooks is authoritative only for
the posted facts it actually returns. External actors and issuers remain authoritative only for
their legal, professional, customer, physical, or issuer scope.

## Current maturity

The source audit represented by this document found:

| Area | Current code-grounded state | Required unusually-strong state |
|---|---|---|
| Core technical design | Strong | One authority per fact, explicit contracts, no bypass around effects or reconciliation |
| Lead/job/field foundation | Strong, lifecycle projection incomplete | Orthogonal state machines and a deterministic derived job phase |
| Safety/evidence/accounting control | Unusually strong in source | Preserve fail-closed controls and prove deployed failure/recovery cases |
| Repository and migration coherence | Mixed | Two active products, explicit compatibility retirement, governed migration ownership |
| Configured capability | Partial | Per-capability readiness, dependency/readback proof, TTL, and fallback |
| End-to-end commercial closure | Incomplete | No-seed native lead-to-reconciled-closeout journey |
| Production/customer proof | Not established by this audit | Technical reference proof may be established; customer proof remains false until real customers exist |

The machine-checked snapshot is intentionally conservative:

<!-- ai-native-architecture-contract:start -->

```json
{
  "schema": "ironwrap_ai_native_architecture_contract_v1",
  "authority": {
    "operating_state": "d1_worker",
    "raw_evidence": "r2",
    "frappe": "compatibility_projection",
    "facet": "design_evidence_producer",
    "quickbooks": "posted_accounting_facts",
    "ai": "non_authoritative_proposal"
  },
  "maturity": {
    "core_technical_design": "strong",
    "lead_job_field_foundation": "strong_with_projection_gaps",
    "safety_evidence_accounting_controls": "unusually_strong_in_source",
    "repository_migration_coherence": "mixed",
    "configured_capability": "partial",
    "end_to_end_commercial_closure": "incomplete",
    "production_customer_proof": "not_established"
  },
  "commercial_reachability": {
    "approved_quote_revision_writer": "test_only",
    "proposal_revision_writer": "production",
    "proposal_publication_settlement_writer": "test_only",
    "customer_acceptance_writer": "production",
    "acceptance_to_deposit_derivation": "not_wired"
  },
  "configuration": {
    "effect_runtime_enabled": true,
    "quickbooks_oauth_enabled": false,
    "quickbooks_final_invoice_enabled": false,
    "hermes_desktop_enabled": false,
    "public_estimator_enabled": false,
    "newo_enabled": false,
    "postiz_enabled": false,
    "facet_routes_configured": false,
    "proposal_template_configured": false
  },
  "proof": {
    "repository_verified_for_this_audit": true,
    "deployed_exact_source_verified": false,
    "provider_readback_journey_verified": false,
    "production_reference_journey_verified": false,
    "customer_validated": false
  }
}
```

<!-- ai-native-architecture-contract:end -->

`tools/validate-documentation.mjs` derives the checkable source/configuration facts and fails when
this snapshot drifts. A future implementation must update code and this contract together; it
must not merely change the prose to green.

## Existing control kernel

The target reuses these implemented deep modules:

- [`operating-core.ts`](../workers-bus/src/operating-core.ts) atomically materializes customer,
  property, job, estimate, gates, consent, events, and audit state.
- [`effect-runtime.ts`](../workers-bus/src/effect-runtime.ts) leases attempts, blocks blind retry of
  unknown outcomes, requires provider readback, reconciles, and creates durable exceptions.
- [`commercial-store.ts`](../workers-bus/src/commercial-store.ts) owns immutable quote/proposal
  revision chains, money checks, authority, publication, and acceptance bindings.
- [`customer-contract-acceptance.ts`](../workers-bus/src/customer-contract-acceptance.ts) binds a
  customer decision to the exact current publication and terms and rejects drift atomically.
- [`production-gate-clearance.ts`](../workers-bus/src/production-gate-clearance.ts) clears the
  deposit gate only from reconciled settlement evidence.
- [`native-final-invoice-producer.ts`](../workers-bus/src/native-final-invoice-producer.ts) derives
  final-invoice intent from completion, accepted commercial truth, prior invoices, provider
  mapping, tax policy, and evidence.
- [`safety-actions.ts`](../workers-bus/src/safety-actions.ts) and the field outbox preserve raw
  evidence, bound time, duplicate-safe replay, and protected stop/make-safe behavior.

The OS must deepen these modules, not create a second authority or orchestration stack beside them.

## Current closure gaps

The native commercial chain is not yet reachable from start to finish:

```text
lead intake
  -> triage
  -> measurement / Facet design
  -> approved quote revision          [test callers only]
  -> proposal revision                [production route]
  -> publication effect + settlement [test callers only]
  -> customer acceptance              [production path]
  -> deposit intent                   [not acceptance-driven]
  -> reconciled deposit / gate clear  [implemented]
  -> native assignment / work package [implemented]
  -> completion / final invoice       [implemented]
  -> QuickBooks execution/readback    [implemented but disabled]
```

Lifecycle projection is also incomplete: lead conversion, customer activation, and the coarse
roof-job phase are not consistently advanced from their authoritative commercial, gate, assignment,
work-package, completion, and accounting facts.

## Target AI coordination loop

```mermaid
flowchart LR
    Signal["Signals and observations"] --> Canonical["Canonical D1 facts/events<br/>Raw R2 evidence"]
    Canonical --> Context["ContextSnapshot<br/>fact id · version · hash · trust · freshness"]
    Context --> Plan["AI PlanProposal<br/>non-authoritative"]
    Plan --> Schema["Exact schema and action catalog"]
    Schema --> Policy["Deterministic policy"]
    Policy -->|deny or stale| Exception["Durable exception/manual path"]
    Policy --> Approval{"Human approval required?"}
    Approval --> Permit["Bound permit"]
    Permit --> Action["Existing domain transition or effect runtime"]
    Action --> Provider["Owned store or provider"]
    Provider --> Readback["Readback"]
    Readback --> Reconcile["Reconciliation and EvidencePack"]
    Reconcile --> Canonical
    Reconcile --> Complete{"Goal complete?"}
    Complete -->|no| Context
    Complete -->|yes| Done["Closed goal"]
    Complete -->|no progress / ceiling| Exception
```

Only one new generic append-only coordination aggregate is justified. A `coordination_run` records
the goal, context hash, model/prompt/schema hashes, proposed steps, fact citations, policy results,
existing permit/effect/transition references, progress ceilings, and terminal result. It must not
duplicate commercial permits, approval stores, effect attempts, provider receipts, or exceptions.

Every proposed action must cite exact current facts, use a registered action kind, declare
preconditions/freshness/risk/readback, and either obtain a deterministic permit or stop. Unknown
fields, stale context, missing citations, or an unregistered action cause abstention.

## Autonomy levels

| Level | Examples | Authorization |
|---|---|---|
| A0 observe/explain | Summaries, blockers, evidence lookup | Automatic; citations required |
| A1 draft | Lead follow-up, proposal narrative, exception explanation | Automatic draft; no effect |
| A2 reversible bounded action | Request missing evidence, send an approved consented template | Deterministic permit after technical proof |
| A3 consequential action | Publish proposal, schedule job, create provider invoice intent | Human approval plus exact permit/readback |
| Human-only | Customer acceptance, safety-stop release, waiver, refund/write-off, legal certification | AI prohibited |

Workers always retain unconditional report/stop/make-safe rights. AI cannot release a safety stop,
waive a gate, accept for a customer, approve its own output, or establish accounting truth.

## Orthogonal lifecycles and derived phase

Do not encode the entire company in one mutable job-status enum. Keep independent authoritative
state machines for:

1. lead qualification and conversion;
2. measurement/design/quote/proposal/publication/acceptance revisions;
3. production gates;
4. append-only crew assignment;
5. work-package acknowledgement/execution/hold points/completion;
6. safety occurrence, stop, make-safe, correction, and independent release;
7. accounting intent, execution, readback, and reconciliation; and
8. closeout, warranty, and service.

Expose a read-only derived `job_phase`:

| Phase | Deterministic predicate |
|---|---|
| `qualified` | Qualified lead/job exists and commercial work has not started |
| `commercial_in_progress` | Measurement, design, quote, or proposal exists without binding acceptance |
| `contracted` | Exact current publication has a binding customer acceptance |
| `deposit_pending` | Acceptance exists and required deposit is not reconciled |
| `production_ready` | Every required gate is currently cleared |
| `scheduled` | A current valid assignment exists |
| `in_progress` | A current work package has started |
| `substantially_complete` | Required completion packet is accepted |
| `financially_closed` | Final invoice and balance are reconciled |
| `warranty_active` | Closeout and warranty activation are complete |
| `cancelled` | An authoritative cancellation supersedes active progress |

The phase is a projector/read model. It is never a second writable truth.

## Role journeys

- **Owner:** exception-first `Now`, approvals, policy, cash/safety exposure, capability health, and
  source-linked explanations.
- **Sales:** qualification, missing evidence, measurement/Facet design, quote, proposal,
  publication, and customer handoff.
- **Operations/production:** gate blockers, crew/readiness, assignment, work packages, and
  reconciliation exceptions.
- **Field:** `Today`, acknowledgement, offline evidence, hold points, stop/make-safe, and completion.
- **Accounting:** provider mapping/tax basis, deposit/final intent, approval, provider readback, and
  reconciliation.
- **Customer:** the exact current proposal/terms, genuine acceptance, derived status, closeout, and
  warranty/service.

AI appears inside these scoped journeys as proposals and explanations. It is not a global chatbot
with ambient authority.

## Production reference journey without customers

The technical production bar uses an isolated `reference` tenant and company-controlled actors.
Every entity is visibly labelled `REFERENCE TEST - DO NOT SERVICE`. The run uses the exact
production artifact, APIs, queues, policy, storage, scheduler, and provider adapters without direct
database seeds or test-only business helpers.

The reference journey must prove:

1. signal -> raw receipt -> canonical lead/customer/property/job;
2. qualification -> measurement -> signed Facet design/customer-design evidence;
3. native approved quote -> proposal -> ledgered publication -> provider readback;
4. exact customer acceptance -> deposit intent -> provider readback -> gate clearance;
5. all gates -> assignment -> offline work packages -> hold points -> safety stop/release;
6. completion -> final invoice -> provider readback/reconciliation -> closeout/warranty; and
7. joined evidence, backup/restore, rollback, replay, and no-progress exception handling.

Required injected failures include duplicate/replay, stale facts, prompt injection, proposal drift,
lost provider response, provider refusal, permission denial, offline conflict, safety stop, gate
staleness, payment mismatch, and backup/rollback failure.

The permitted conclusion is **technical production reference journey established for exact source
and configuration**. Customer adoption, usability, conversion, willingness to pay, field
effectiveness, and business acceptance remain **not established** until independently evidenced by
real customers and workers.

## Capability readiness

Every capability advances independently through:

```text
implemented
  -> built
  -> configured
  -> provider_reachable_and_readback_verified
  -> enabled
  -> technically_proven
  -> customer_validated
```

Each state needs an owner, source SHA, configuration digest, dependencies, proof timestamp/TTL,
blocker, and safe fallback. Readiness profiles are `core`, `commercial_closure`, `field_closure`,
`accounting_closure`, and `reference_journey`. Optional Newo, Postiz, and public-estimator paths do
not block the core journey unless product policy explicitly adds them.

## Repository and migration coherence

- IronWrap is the company operating authority.
- Facet remains a separate active product and signed design-evidence producer.
- Home Config 3D is not an IronWrap runtime dependency; archive/freeze requires a separate owner
  decision after unique-code and shared-lineage inventory.
- Frappe is compatibility only. While its wheel ships, its required tests must be release-blocking;
  remove the wheel after the last consumer and rollback proof are gone.
- Retire old Frappe approval/scheduling broker paths after native equivalents have parity and live
  rollback evidence.
- Do not renumber historical D1 migrations. Record reserved gaps and authority cutovers in a
  machine-readable migration manifest.
- Migrate with expand -> dual-read comparison -> writer switch -> read-only projection -> parity
  proof -> deletion.

## Delivery order and gates

1. **Truth and authority:** architecture contract, capability states, migration ownership, one
   writer per fact.
2. **Commercial closure:** production quote writer, publication settlement, acceptance-driven
   deposit derivation, configured accounting readback.
3. **Lifecycle projection:** lead conversion, customer activation, derived phase and invariants.
4. **Thin AI coordinator:** context snapshot, action catalog, one coordination aggregate, bounded
   lead/exception use cases first.
5. **Configuration:** minimum provider set and readiness profiles.
6. **Reference proof:** exact-source journey plus failure/recovery drills and EvidencePack.
7. **Retirement:** Frappe brokers/wheel and duplicate predecessor paths after parity proof.
8. **Customer validation:** only real users may change `customer_validated` from false.

Machine gates must prove one writer per authority, contract hashes, effect/readback coverage,
no-seed commercial reachability, offline/safety behavior, accounting reconciliation, AI grounding
and abstention, recovery, and evidence-class claim discipline.
