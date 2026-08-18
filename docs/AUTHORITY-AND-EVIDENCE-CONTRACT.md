# Authority and Evidence Contract

Status: canonical
Owner: IronWrap OS product owner
Last verified: 2026-08-17
Review trigger: any new actor, tool, side effect, state transition, or physical workflow

## Binding assumption

IronWrap may use AI agents that are 100% reliable in the following precise sense:

- they do not fabricate facts;
- they follow their authority and policy exactly;
- they preserve provenance;
- they handle retries and failures deterministically;
- they stop when required evidence or authority is absent;
- they expose uncertainty instead of converting it into confidence.

Reliability does not make external facts perfect. Customers, suppliers, weather feeds, sensors,
documents, machines, credentials, laws, and physical conditions may still be wrong, unavailable,
malicious, or changed.

## Human and agent boundary

Agents own routine cognitive and digital execution:

- intake, qualification, planning, estimation, purchasing, scheduling, compliance evaluation;
- customer and internal communications within recorded consent and authority;
- work-package generation, document assembly, billing proposals, reconciliation, and warranty
  triage;
- monitoring, exception detection, audit, and continuous improvement.

Humans own:

- access-sensitive physical inspection until a validated machine can perform it;
- material handling, fabrication exceptions, installation, repair, and emergency stabilization;
- relationship-sensitive conversations where the customer or worker requests a person;
- licensed, statutory, contractual, or regulator-required human signoffs;
- physical stop-work and emergency decisions at the point of danger;
- ownership, capital allocation, risk appetite, ethics, and existential company decisions.

Routine human review is not a permanent target control. A human remains in a transition only when
the physical act, legal duty, customer choice, relationship need, or unresolved exception requires
one.

## Non-negotiable rights

No objective, schedule, margin, automation target, or customer promise overrides:

- worker stop-work authority;
- customer consent, cancellation, correction, complaint, and appeal rights;
- regulator, inspector, engineer, manufacturer, insurer, or permit-holder authority;
- privacy, accessibility, anti-discrimination, and employment rights;
- safe containment and emergency response.

## Actor model

Every action has exactly one authenticated actor:

| Actor class | Examples | Authority source |
|---|---|---|
| `agent` | concierge, estimator, scheduler, procurement, finance | versioned role and policy |
| `worker` | inspector, fabricator, installer, driver, supervisor | employment/contract, competency, assignment |
| `customer` | owner, tenant contact, property manager, GC | verified identity and decision authority |
| `external_authority` | City, WCB, CRA, engineer, manufacturer, insurer | authenticated external record |
| `device` | phone, camera, drone, machine, vehicle, sensor | registered device identity and calibration |
| `owner` | director or delegated executive | corporate delegation matrix |

Shared accounts and unattributed side effects are forbidden.

## Authority levels

| Level | Meaning | Example |
|---|---|---|
| `observe` | Read a bounded fact | Read a job gate |
| `derive` | Compute without changing external state | Calculate a takeoff |
| `propose` | Create an uncommitted option | Prepare a supplier order |
| `commit_internal` | Change owned internal state | Reserve inventory |
| `commit_external` | Cause a provider/customer/vendor/legal side effect | Send, order, invoice, file |
| `control_physical` | Command machinery, vehicle, access, or work | Release shop machine cycle |
| `emergency` | Make safe and notify under a predefined incident policy | Stop line and call emergency services |

Each role receives only the levels needed for its function. Authority is scoped by tenant, job,
customer, amount, geography, time, device, data class, and operation.

## Canonical transition envelope

Every state change must produce an immutable envelope equivalent to:

```json
{
  "transition_id": "globally unique and idempotent",
  "tenant_id": "isolated tenant",
  "aggregate_type": "job, order, work_package, asset, consent, etc.",
  "aggregate_id": "stable owned identifier",
  "from_state": "expected prior state",
  "to_state": "requested state",
  "actor": {
    "type": "agent, worker, customer, external_authority, device, owner",
    "id": "authenticated identity",
    "role_version": "version or null"
  },
  "authority_ref": "delegation, contract, policy, permit, or assignment",
  "policy_version": "exact evaluated policy",
  "evidence_refs": ["immutable evidence identifiers"],
  "input_hash": "hash of normalized transition input",
  "occurred_at": "trusted timestamp",
  "correlation_id": "end-to-end workflow identity",
  "result": "committed, blocked, rejected, compensated",
  "reason_codes": ["stable machine-readable codes"]
}
```

Free text may explain a transition but cannot supply missing authority or evidence.

## Transition rule

A transition commits only when:

1. The aggregate exists and its current version/state matches.
2. The actor is authenticated and authorized for the exact action.
3. Required inputs are complete, valid, and from allowed sources.
4. Required evidence exists, is bound to the same tenant/aggregate/action, and is still valid.
5. The exact policy version returns `allow`.
6. No hard stop, suppression, legal hold, safety block, or unresolved conflict exists.
7. The side effect has an idempotency key and bounded retry/compensation rule.
8. The resulting state and audit event commit atomically or reconcile to a known partial-failure
   state.

An agent may not infer completion from a message, calendar entry, payment screenshot, uploaded
file, or another system's mutable status alone.

## Evidence classes

| Class | Examples | Minimum integrity |
|---|---|---|
| `source` | raw form, provider webhook, signed contract, supplier acknowledgement | original bytes or authenticated provider reference, timestamp, hash |
| `derived` | roof graph, estimate, schedule, compliance decision | source refs, algorithm/policy version, deterministic inputs |
| `physical` | site photo, scan, machine telemetry, delivery receipt | device/actor, capture time, job binding, integrity hash |
| `authority` | tenant-scoped Authority Record for a Person/Organization Worker/Subcontractor, licence, permit, WCB clearance, credential, inspection, or manufacturer record | immutable version, issuer/jurisdiction/source reference, subject and exact scope, evidence refs plus SHA-256 hashes, effective/expiry, verification/readback, revocation, contradiction, and supersession |
| `financial` | proper invoice, bank receipt, accounting entry | source system, amount/currency, entity, immutable external ID |
| `decision` | customer selection, owner capital decision, worker stop | authenticated decision-maker, options presented, timestamp |
| `negative` | failed inspection, rejected permit, no consent, unsafe weather | authoritative source, reason, observed time |

Evidence is immutable. Corrections create a new item linked to the superseded item; they do not
overwrite history.

Authority mutations use one governed proof chain: an authenticated Owner/Production request enters
one tenant-scoped D1 action, and the separately authenticated executor binds the exact command,
authority version, evidence, and (where required) genuine issuer receipt before applying it through
the exact Frappe business actor,
reads the material Frappe record back, verifies its state digest and all bound fields, and only then
records the terminal D1 receipt. A browser session may request or observe the action but cannot mint
an issuer readback or set an applied result. Frappe `System Manager` is an administrative capability,
not business verification authority: lifecycle verification is restricted to the mapped `IronWrap
Owner` or `IronWrap Production` role. External, legal, and professional authority remains with the
genuine issuer and blocks release when its readback is missing, stale, contradictory, or mismatched.

## Evidence freshness

Each evidence type defines:

- valid issuer and capture method;
- subject and scope;
- effective and expiry time;
- revocation/supersession lookup;
- required recheck event;
- acceptable clock skew;
- retention and access class.

A cached WCB clearance, permit status, weather observation, price, consent, or credential is not
valid merely because it once existed.

## Conflict handling

When sources disagree:

1. Do not average, vote, or choose the convenient result.
2. Classify each source by authority, scope, identity, time, and integrity.
3. Prefer the source with binding authority for the exact fact.
4. If no deterministic precedence resolves it, block the transition.
5. Create an exception with all conflicting evidence.
6. Route to the legally or operationally competent human/external authority.
7. Record the resolution as new evidence and rerun the transition.

## Human work-package contract

Every human physical task is delivered as a versioned work package containing:

- tenant, job, property, customer-safe contact, and emergency contacts;
- task objective, boundaries, prerequisites, and expected result;
- issued design, drawing, assembly, material, quantity, tolerances, and manufacturer version;
- exact location/sequence and dependencies;
- hazards, controls, PPE, fall protection, rescue, first aid, working-alone, and weather limits;
- required competency, trade authorization, supervisor, and equipment;
- inspection/hold points and who may release them;
- evidence slots with required photo/voice/measurement/device data;
- allowed field decisions and actions that require an exception/change order;
- stop conditions and make-safe procedure;
- customer/property protection and privacy instructions;
- offline copy, acknowledgement, issue time, expiry, and supersession rule.

The worker must be able to:

- accept or reject the assignment;
- declare the package incomplete;
- report changed conditions;
- stop work;
- request a person;
- capture evidence offline;
- see when a package was superseded;
- resume only after a valid release.

Productivity scoring must never penalize a valid stop, hazard report, injury report, accommodation,
or legally protected action.

## Physical completion

A task is not complete because a worker or agent says “done.” Completion requires the task's
evidence slots and independent rules, for example:

- required photographs or scans from the correct location and time;
- measured values within tolerance;
- material/lot and piece identity;
- machine cycle and first-piece/in-process inspection;
- supervisor or quality release where required;
- no unresolved nonconformance, safety event, or change;
- customer/authority signoff only when the contract or law requires it.

Missing physical evidence creates `needs_evidence`, not `complete`.

## Side-effect contract

External writes must have:

- exact normalized intent;
- authority and policy proof;
- idempotency key;
- provider request/response fingerprint without secrets;
- timeout, retry, duplicate, and ambiguous-result behavior;
- compensation or human recovery path;
- reconciliation against the provider's authoritative state.

Examples include customer messages, appointments, supplier orders, permit submissions, invoices,
payments, refunds, payroll, filings, access changes, machine release, and dispatch.

The current repository uses reviewed dry-run and signed approval receipts for many writes. That is
the safe implemented baseline. The autonomous target may replace routine human approval with a
policy-issued machine authority receipt only after the corresponding capability is implemented and
independently proven. Legal/customer/physical signoffs remain human where required.

Software release authority is generation-bound. The protected predecessor policy and executable
enforcer must validate the exact PR, CI run/check identities, independent findings, complete
manifest, isolated staging/recovery proof, provider reconciliation, and business-evidence
references before issuing a short-lived single-use permit. Candidate policy cannot authorize its
own weakening. Source admission, provider promotion, post-smoke readback, durable success, durable
rollback, and post-admission recovery-required state are separate receipts. An unknown, drifted,
expired, replayed, or unresolved P0/P1 state stops the transition; a partial/unknown migration may
not be described as rollback.

## Segregation of duties

Reliability does not eliminate separation:

- an estimator may not independently alter source measurements;
- procurement may not create a vendor and release payment to it;
- an installer may not approve its own concealed-work quality evidence;
- finance may not change bank details and approve the payment;
- a communications agent may not invent consent;
- an audit agent may not execute the operation it audits;
- a policy author may not silently activate the policy in production;
- a machine controller may not override a safety stop.

Separation protects against compromised credentials, malicious inputs, defective external systems,
and institutional error.

## Stop taxonomy

| Stop | Examples | Required response |
|---|---|---|
| `safety` | fall control absent, lightning, equipment defect | halt, make safe, notify, investigate |
| `legal` | licence/permit/consent/signatory absent | block side effect, obtain authority |
| `technical` | conflicting geometry, structural defect, incompatible system | contain, specialist review |
| `quality` | failed first piece, damaged lot, failed inspection | quarantine, NCR, disposition |
| `financial` | payment ambiguity, margin breach, payee mismatch | freeze affected commitment, reconcile |
| `privacy_security` | wrong recipient, device loss, suspected breach | contain access/data, preserve evidence, assess notice |
| `customer` | cancellation, dispute, access withdrawn, person requested | stop affected work, route to authorized human |
| `external` | supplier failure, permit rejection, outage | replan without falsifying readiness |

Stops may be cleared only by the actor and evidence defined in policy. “AI is reliable” is not a
clearance reason.

## Degraded operation

Every critical workflow defines:

- safe state when network, power, identity, provider, sensor, or agent service is unavailable;
- offline human work-package access;
- actions allowed offline;
- actions prohibited until reconnected;
- durable local queue and duplicate-safe replay;
- reconciliation after recovery;
- maximum tolerable outage and escalation.

No critical safety instruction or emergency contact may depend solely on a live cloud response.

## Customer-facing behavior

Agents must:

- identify the business and disclose automation/recording where required;
- respect channel, purpose, timing, language, and accessibility preferences;
- distinguish estimate, quote, contract, invoice, receipt, and warranty;
- show assumptions, exclusions, changes, and consequences;
- never manufacture scarcity, damage, urgency, approval, or authority;
- provide an immediate path to a person;
- preserve the exact content presented for consequential decisions.

## Audit and reconciliation

The independent audit function continuously verifies:

- every state transition has authority and evidence;
- every external side effect reconciles;
- no aggregate has impossible or skipped states;
- no required evidence expired after scheduling but before execution;
- no consent suppression was violated;
- inventory, shop output, delivery, installation, invoice, and accounting quantities agree;
- all exceptions have owners, deadlines, containment, and closure evidence;
- agent/tool/policy versions match the recorded transition.

Audit findings cannot be closed by the actor that created them without independent verification.

## Acceptance

This contract is implemented only when tests demonstrate:

- a complete routine job can progress without routine human digital approval;
- every physical task arrives as a complete offline-capable work package;
- injected missing, stale, conflicting, malicious, and duplicate evidence blocks safely;
- all customer/vendor/accounting/machine side effects are idempotent and reconciled;
- legal, safety, customer, and relationship-sensitive human gates remain intact;
- an outage can recover without lost, duplicated, or falsely completed work;
- the evidence bundle can reconstruct who did what, under which authority, from which facts.
