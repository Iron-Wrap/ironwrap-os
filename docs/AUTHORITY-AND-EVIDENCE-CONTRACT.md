# Authority and Evidence Contract

Status: canonical
Owner: IronWrap OS product owner
Last verified: 2026-10-18
Review trigger: any new actor, tool, side effect, state transition, or physical workflow

## Binding assumption

AI models are fallible interpreters and planners. Their output is untrusted input to the operating
system and cannot itself establish a fact, policy result, approval, permit, side effect, readback,
or completed transition.

IronWrap makes the overall loop reliable by requiring:

- source-bound facts with identity, version, hash, trust, and freshness;
- exact schemas and registered actions;
- deterministic policy evaluated again immediately before action;
- human authority where required and a bound, expiring permit otherwise;
- idempotent controlled execution without model-held credentials;
- authoritative readback, reconciliation, evidence, and durable exceptions; and
- step, time, cost, retry, and no-progress ceilings.

Customers, suppliers, weather feeds, sensors, documents, machines, credentials, laws, physical
conditions, models, prompts, and connector data may be wrong, unavailable, malicious, stale, or
changed.

## Human and agent boundary

AI may interpret, summarize, prioritize, draft, and propose routine cognitive and digital work:

- intake, qualification, planning, estimation, purchasing, scheduling, compliance evaluation;
- customer and internal communications within recorded consent and authority;
- work-package generation, document assembly, billing proposals, reconciliation, and warranty
  triage;
- monitoring, exception detection, audit, and continuous improvement.

Deterministic automation may commit a routine digital transition only through the exact policy,
permit, tool, readback, and reconciliation contract. Humans own:

- access-sensitive physical inspection until a validated machine can perform it;
- material handling, fabrication exceptions, installation, repair, and emergency stabilization;
- relationship-sensitive conversations where the customer or worker requests a person;
- licensed, statutory, contractual, or regulator-required human signoffs;
- physical stop-work and emergency decisions at the point of danger;
- ownership, capital allocation, risk appetite, ethics, and existential company decisions.

Routine duplicate review is not a permanent target control. A human remains in a transition when
policy requires approval or when the physical act, safety release, legal duty, customer choice,
relationship need, money/risk ceiling, or unresolved exception requires one.

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
| `agent` | scoped AI proposal or deterministic coordinator acting through a named role | versioned role, policy, and permit; AI output alone has no commit authority |
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

AI models receive at most `observe`, `derive`, and `propose`. A deterministic coordinator may
invoke `commit_internal` or `commit_external` only with an exact permit and may never infer the
permit from model confidence.

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

## Cross-service request correlation

`X-Request-ID` is the canonical synchronous HTTP correlation header. Services also accept
`X-Correlation-ID`; when both are valid, `X-Correlation-ID` wins, and both response headers carry
the selected value. An accepted value matches `[A-Za-z0-9._:-]{8,128}`; every other value is
discarded and replaced with a UUID.

At an asynchronous delivery boundary, the immutable event or envelope id becomes the request id.
Facet, the Worker, and Frappe therefore correlate a durable workflow without inventing unrelated
per-service identities. Each HTTP boundary emits exactly one bounded JSON completion record with
timestamp, level, message, service, request id, tenant, method, route path, status, duration,
envelope id, and a stable error code when applicable. Query strings, request/response bodies,
authorization values, credentials, contact data, and arbitrary exception text are forbidden.

A correlation match proves only that the named services observed the same synthetic or real
workflow. It does not prove customer acceptance, business completion, or production readiness.

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

## AI context and proposal contract

Every AI run receives a bounded `ContextSnapshot` whose facts carry stable id, fact-ledger version,
source/evidence hash, trust class, observed/effective time, freshness deadline, and tenant/job
scope. Untrusted document, connector, calendar, and message text is labelled data, never
instruction.

Every `PlanProposal` must contain:

- one declared goal and bounded step list;
- a registered action kind for each step;
- exact fact citations and required versions/hashes;
- preconditions, freshness, risk, expected result, and stop condition;
- required human role or machine-policy class;
- readback/reconciliation verifier; and
- step, time, cost, retry, and no-progress ceilings.

Unknown fields, absent citations, stale/conflicting facts, an unregistered action, missing policy,
or exhausted ceilings produce abstention and a durable exception. A model never receives provider
credentials or a generic database/provider mutation tool.

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
authority version, evidence, and (where required) genuine issuer receipt before committing the
versioned D1 aggregate and immutable transition atomically. It then reads the material D1 state
back, verifies its digest and all bound fields, and only then records the terminal receipt. An
internal Worker Competency has no external issuer, so the Worker is its executor: an Owner or
Production approver's command, or their approval of the compliance specialist's step, claims the
action, appends the new version that supersedes the identity's current head, completes the action,
and reads the stored version back in one D1 transaction. That transaction re-checks the expected
head, and that no login the worker's reference names shares a user id, email or Frappe user with
the approver's login. Two logins of one person that share none of those cannot be linked without a
person-to-user record, which does not exist yet; until it does, that self-approval is not
detected. Every change, including a verification or revocation, is a new version, never an edit,
and none is projected to Frappe. One identity holds at most 32 versions, the bound the fence reads
in one lineage, and its last slot is kept for a revocation. Once 31 versions exist only a
revocation may take the last slot, so when the 31st is already a revocation, or is not verified,
or once the 32nd revokes the competency, the identity is full: every further command
is refused and the fence keeps refusing the work that needs it, so it fails closed. A person can
start a new competency only as a new identity, by recording it under another scope reference such
as the next roof job. Nothing retires a full identity so that its scope can be reused, so a
requirement that names that scope stays refused; this is a known limit. Verification and
revocation references and correction reasons about a colleague are personnel and safety text: only
a reader holding `authority:approve` sees them, and a field login never does. A revocation is not terminal: a new
assessment may supersede it, and once another approver verifies that assessment, the worker is
admitted again. A
browser session cannot mint an issuer readback or set an applied result: for an external kind it
may only request or observe the action, and for an internal competency the Worker derives the
result from the approver's command. Frappe may receive a compatibility projection after the D1
commit, but a Frappe role, document, or readback cannot grant authority or make the D1 transition
succeed. External,
legal, customer, physical, and professional authority remains with the genuine actor or issuer and
blocks release when its readback is missing, stale, contradictory, or mismatched.

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

A crew member can stop work without first typing an explanation. An empty stop report keeps the
reason as not provided in the immutable event; it must never be presented as a crew-stated hazard.
The crew keeps work stopped while a saved offline report awaits delivery. Once the office receives
the stop, it must ask what happened and record the follow-up before any independent release.
The stop request may omit `blocker_reason`, send `null`, or send an empty string. The saved action
keeps the exact submitted value; the native event records `null` for no explanation. Submitted
words are never silently cut off: the request and offline outbox accept up to 4,000 characters.
If the crew needs to report a new hazard after the work package is already Blocked, a new durable
`report_occurrence` safety action scoped to that work package records it without trying to stop
the same package twice. The current native stop write records the absence; the office follow-up,
the second-hazard screen and the release route still need verified PWA consumers before this
workflow is accepted.

A correction reason alone cannot supersede a Blocked work package: office reissue returns
`work_package_stop_release_required` and the package stays Blocked until a person releases the
stop. Releasing a crew stop is people-only (`safety_stop.release`, class H) and has one write path,
`POST /api/v1/work-packages/{id}/stop-releases` (CSRF, and an `Idempotency-Key` equal to
`X-Device-Action-Id`). It admits only a person's own cookie session, never an agent, automation,
service token, effect runtime or MCP actor, in the owner, ops or production role, and never the
person who raised the stop or the user on its receipt. The request names the exact Blocked version
and stop event, cites one to ten verified, stored Work Package captures of the same tenant and job,
each captured after that stop, and gives a reason; until a structured office follow-up record
exists, that reason and evidence carry the follow-up. A capture taken before the stop shows what
the crew stopped on, never its correction, so however it was verified it can never release the
stop: its capture time, the device's capture completion or, when the device recorded none, the
server receipt, must be strictly later than the stop event's time, compared as instants. The
append-only `work_package_stop_releases` record (migration `0145`) keeps the version, the stop and
its device action, who raised and reported it, the releaser and their role at that moment, the
independence facts, the evidence references with their stored checksums, and the reason. D1
re-checks those facts, the capture order included (migration `0152`), then writes the record and
returns the version to the status the stop interrupted in one statement, beside an immutable
office-action manifest. An exact replay returns the original record, and a changed intent under the
same key conflicts. `GET` on the same route returns the stop holding the version and every release.
Only a release of the stop that holds that exact version lets the `0143` guards admit a status
change away from Blocked or a supersession; a release of another version, or of an earlier stop on
the same version, unlocks nothing. Refusals are distinct:
`work_package_stop_release_person_required`, `work_package_stop_release_role_required` and
`work_package_stop_release_independence_required` (403);
`work_package_stop_release_evidence_required` (400); `work_package_not_blocked`,
`work_package_stop_release_version_conflict`, `work_package_stop_release_stop_conflict`,
`work_package_stop_already_released`, `work_package_stop_release_evidence_invalid`,
`work_package_stop_release_evidence_before_stop` and `work_package_stop_release_replay_conflict`
(409).

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

## Schema-driven form fields and generated documents (Partial)

Status: **Partial source implementation**. The repository now contains the append-only field,
value, template, generation-attempt, and generation-receipt aggregates plus the authenticated
field/template HTTP boundary and default-off immutable R2 execution described below. The owner PWA,
merge/exact-main proof, deployment, named-environment activation, runtime verification, business
acceptance, customer validation, and production proof remain unproven. Track the wider product gap
in `CAPABILITY-MATRIX.md`.

The current authenticated HTTP boundary is deliberately narrow:

- `GET|POST /api/v1/admin/schema-fields` and
  `GET|POST /api/v1/admin/schema-fields/{field_id}` expose owner-only current configuration;
- `GET /api/v1/admin/schema-fields/{field_id}/revisions` exposes its immutable history;
- the equivalent owner-only routes under `/api/v1/admin/document-templates` expose current template
  configuration and revisions;
- `GET /api/v1/schema-fields/{entity_type}/{entity_id}` returns only fields the current session may
  read, and the value and revision routes beneath that record enforce current write/read authority;
- `POST /api/v1/document-generations` is an owner-only, CSRF- and idempotency-bound command that
  snapshots the exact authorized inputs, proposes the durable effect, persists the attempt, then
  authorizes R2 execution and accepts success only after exact HEAD checksum, byte-length, and
  content-type readback;
- `GET /api/v1/document-generations/{receipt_id}` reconstructs the browser-safe immutable receipt
  and input versions, while
  `POST /api/v1/document-generations/{generation_attempt_id}/reconcile` performs a fresh server-side
  R2 HEAD and never accepts browser-supplied provider evidence;
- every mutation requires the app CSRF proof and an `Idempotency-Key`; tenant, actor, role,
  authority reference, and exact user identities are derived from `AuthContext`, never from the
  browser. Ordinary record projections omit configuration command fingerprints, idempotency hashes,
  role matrices, and unrelated authority coordinates.

The generation route is separately fail-closed behind `APP_DOCUMENT_GENERATION_ENABLED=true`, the
universal effect runtime, and a real `RAW` binding; every checked-in environment keeps the capability
`false`. A PUT or HEAD ambiguity remains a durable `unknown` receipt and cannot mint attachment
evidence. A later server-side match can append a reconciled success; not-found becomes
`not_executed`, and mismatched metadata becomes a manual exception. Those two settled outcomes are
persisted separately from the original `unknown` terminal classification, so a later receipt GET
reconstructs the conclusion instead of reverting to ambiguity. If the command names a current
`attachment` field with `derived` evidence, the server—not the browser—atomically appends the exact
R2 object receipt and field-value revision only after verified readback. The generation receipt is
persisted first, so a stale attachment CAS returns a conflict without erasing provider truth or
minting attachment evidence.

Tenant-configurable record fields and generated documents must follow the actor, authority level,
evidence class, freshness, conflict, and side-effect rules above at field and document granularity.

**Append-only configuration revisions.** Field definitions and document templates are tenant-scoped
configuration. Every create, relabel, reorder, retire, or template/binding change appends an
attributable revision recording the authenticated actor or bounded service authority, authority
reference, effective/supersession metadata, and the normalized command fingerprint. Revisions are
immutable; no in-place edit or deletion may erase configuration history. A field type or validator is
part of a closed, reviewed code vocabulary, not tenant-authored executable configuration.

**DB-enforced immutable value history.** Every accepted field-value write appends an immutable value
history record enforced at the database boundary. The server maintains the monotonic current value
and version for each tenant, entity type, entity id, and field, and rejects a write based on a stale
version rather than silently replacing a newer value. Each value records its provenance and the exact
field-definition revision used to accept it.

**Same-scope lineage and full command fingerprints.** Every `based-on` or correction reference must
match the same tenant, entity type, entity id, and field as the value it references. Database
constraints and server checks must reject cross-tenant, cross-entity, cross-record, and cross-field
lineage. A correction is a new value linked to the superseded value and its reason; it never mutates
or deletes the prior value. Each mutating command stores a normalized full-command fingerprint
alongside its idempotency key: an identical retry may replay the result, while the same key with any
different normalized input is rejected as a conflict.

**Closed safe validators only.** Field types, option vocabularies, visibility rules, and validators
come from bounded, reviewed registries. Validation may enforce declared types, ranges, formats,
options, and safe conditional rules. Tenant configuration must not supply arbitrary regular
expressions, formulas, scripts, code, or executable expressions.

**Server-side authority and conditional visibility.** Read and write authority is re-derived from
the current record and authenticated session immediately before every operation; it is never trusted
from a prior response or a client claim. Unauthorized fields are omitted server-side, not merely
hidden in a rendered form. Conditional visibility is evaluated again at write time, and a write to a
field that the current record does not make visible is refused.

**Immutable object and evidence references.** Image and attachment values must bind to immutable
object and evidence references carrying the content digest, tenant/entity/field scope, attributable
actor or device, capture time, and evidence class. A mutable URL, filename, or client-provided label
alone is not evidence. Corrections add new references and preserve the prior object/evidence link.

**Provider-derived facts require authoritative readback.** A value derived from a provider remains
untrusted until the provider's authoritative readback receipt confirms the exact request, scope,
identity, and value/version that the system is using. Missing, stale, contradictory, or mismatched
readback blocks the value from satisfying a field, document, transition, or side effect.

**Closed retention subordinate to holds.** Retention is a closed policy vocabulary with explicit
access and disposal behavior. It is always subordinate to legal holds and evidence holds: a hold may
extend retention, but no tenant policy, field retirement, correction, compaction, or deletion may
remove history or evidence required by a hold. Retiring a field stops new writes and new views while
preserving authorized access to its recorded values for the applicable retention period.

**Explicit bounded service authority for background document generation.** A generated document is a
governed side effect, not a static file. Resolution uses only current, read-authorized values and
exact field/template revisions. Background generation requires an explicit bounded service authority
with tenant, entity, document, action, policy, permit-expiry, idempotency, retry, stop, and
compensation limits; it cannot inherit a requester's authority or infer authority from model output.
External delivery follows the Side-effect contract, including provider reconciliation.

**Generation receipt.** Every generation attempt must end in a terminal receipt or a durable unknown
exception. The receipt binds the exact template revision, input and value versions, authenticated
actor or bounded service authority, policy/permit, provider doc id, output/readback digest, and
terminal reconciliation result. No document generation is complete until authoritative readback and
reconciliation satisfy that receipt; an unknown or mismatched result blocks the next transition.
`terminal_status` preserves the direct execution classification (`succeeded`, `failed`, or
`unknown`), while `reconciliation_outcome` preserves a later `not_executed` or `manual_exception`
conclusion on the immutable receipt.

## Uploaded file evidence

The stock, service-intake, service-step, and corrective-evidence HTTP boundaries accept immutable
Worker upload receipt IDs. The bounded multipart route computes SHA256 from actual binary bytes,
writes R2 conditionally, verifies readback, and then commits an immutable tenant/actor/target/action
receipt in D1. Domain writes resolve the current authorization and the exact stored bytes again;
a browser-supplied digest, file name, or R2 pointer cannot stand in for a verified receipt.

Upload and receipt linking are off by default behind `APP_EVIDENCE_UPLOADS_ENABLED="true"`.
When it is off, the Worker returns `503 evidence_uploads_disabled` before accepting a file or
linking a receipt, even if a caller supplies an existing receipt ID. Legacy HTTP evidence fields
retain their existing behavior without claiming uploaded-file verification or entering the
immutable receipt/manifest stores. A separate `APP_EVIDENCE_RECEIPTS_REQUIRED="true"` flag
requires receipts instead of legacy inputs; both switches must be true for required receipt
operation. With uploads enabled, receipt IDs resolve actual files and mixed legacy fields plus
receipt IDs are refused. Enable either switch only through the deployment owner's normal
configuration authority after the privacy, UI and recovery gates pass.

R2 success with D1 failure is retained raw evidence only. An exact upload retry can finish the
original receipt; changed scope or bytes cannot overwrite it. Receipt-based intake also binds an immutable
normalized request hash to a stable case identity, so a lost-response retry cannot create another
linked duplicate. Receipt resolution does not replace stock conservation, required approval,
current safety authority, or independent verification.

The accepted business link also governs reads. Stock, service, and corrective detail responses
expose linked file metadata only; the private receipt content route rechecks the active tenant
actor, current role, persisted domain link, R2 metadata, and actual-byte digest before serving an
attachment. If only the linked-file index is unavailable, the detail read keeps the business
record and its actions with `evidence_files: []` and `evidence_files_unavailable: true`; the
content route still reports its actual failure. A healthy empty list carries `false`. An uploaded
but abandoned receipt grants no read access. A historical digest never
becomes an uploaded file. Neither a successful upload nor this read path resolves retention,
legal hold, subject destruction, or abandoned-object cleanup; those A11 controls remain a
production-enforcement gate.

The executable contract and recovery procedure are in
[`workers-bus/README.md`](../workers-bus/README.md#file-evidence-contract), implemented by
`workers-bus/src/evidence-uploads.ts` and migrations `0139_evidence_upload_receipts.sql` and
`0141_evidence_privacy_disposition.sql` plus `0149_evidence_upload_write_claims.sql`.
Owner-only hold and manual correction commands preserve
immutable provenance while an independent disposition blocks replay and reads after disposal.
The manual correction route permits a manifest with no durable domain link, then D1 guards
prevent later stock, corrective and service attachment. It refuses durable business references.
For service cases, this includes a persisted last-evidence digest even when no transition event
was written; a missing event never makes an existing case reference disposable.
For corrective actions, a persisted upload-manifest digest also counts when the reference list
uses a legacy format; later inserts and updates cannot revive that digest after disposal.
Subject-request and approved-retention disposal remain blocked pending validated policy and
identity proof.
Cold uploads acquire an exact per-attempt D1 write claim before any RAW await. Disposal cannot
start, retry or verify while a claim is unsettled; a disposition prevents any later claim.
Successful writers settle once only after no further PUT is possible. A rejected PUT retains
an inspectable `unknown` claim; interrupted requests may retain `active`. No elapsed time,
lease stealing, empty-object read or compensating deletion resolves that uncertainty. The
owner receives an explicit pending-write refusal and may inspect tenant-scoped claims through
`GET /api/v1/privacy/evidence-uploads/write-claims`, including attempts with no receipt.
Holds remain available while writers are pending, and their existing disposal guards still apply.
Claims and guards are mandatory backup/restore objects. Activation, restore and rollback require
an approved runtime quiescence procedure covering old unclaimed requests and pending provider
writes. D1/R2 are separate systems; this source neither proves that quiescence nor grants a way
to clear an ambiguous claim. A future operator resolution needs its own verified evidence and
authority contract. Until then, the visible exception fails closed.
If R2 bytes reappear after verified destruction, the exact owner decision records a pending
recheck, removes them again, verifies absence and appends immutable detection and re-verification
events. A failed provider or D1 step remains visible and retryable under that decision. The
separate privacy R2 bucket stores an exact-decision marker after D1 blocks new manifests and
before RAW deletion. An older D1
snapshot with no disposition then quarantines the receipt and blocks retries and reads, including
after RAW bytes reappear. The marker is outside D1/RAW restore scope and is never deleted by the
Worker. It keeps only the tenant and receipt locator, receipt digest, R2 key, decision ID and
an exact-decision digest; the policy must still cover that retained metadata. A conflicting
decision is rejected before D1 can record it. An exact owner retry may recreate the D1 decision;
if its original text is lost, the owner can record a separate manual reconciliation bound to
the marker digest and verify RAW removal without claiming to recover the original reason or
actor. A failed marker
write leaves the D1 decision pending without deleting bytes. An owner-only, tenant-scoped
marker inventory exposes markers missing from a restored D1 receipt inventory, but does not
reconstruct the receipt or authorize deletion. Privacy bucket outage, generic
D1 writers, orphan-marker recovery and production restore still need operational recovery
and release proof; the marker does not authorize production enforcement by itself.
Legacy safety, authority, commercial, deposit, inventory, marketing, schema-form and external-effect
reference fields cannot claim the reserved `evidence-upload://` scheme. The Worker trusts an
uploaded-file reference only when receipt resolution binds its tenant, actor, target, action,
operation and digest to an immutable manifest.
Corrective receipt references require their exact tenant, target and digest manifest in D1;
the legacy request path cannot create that manifest or bypass a disposal decision. The D1
guard also refuses a direct corrective-action insert with an upload reference and rejects
padded or recased upload references on update.
Historical syntactic digests remain historical assertions; this change cannot retroactively grant
them verified file provenance. Focused deterministic tests establish local storage/domain behavior;
deployment, authenticated real-device operation, and human acceptance require their own evidence.

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
the safe implemented baseline. The target may replace routine duplicate human approval with a
policy-issued machine authority receipt only after the corresponding capability is implemented and
independently proven. Legal, customer-choice, safety-release, physical, and exceptional financial
signoffs remain human where required.

An owned business transition commits in D1 before any compatibility projection. Projection failure
creates reconciliation work; it never rolls back, replaces, or becomes evidence for the committed
authority decision. New operating workflows must not add a Frappe write or read dependency.

Software release authority is generation-bound. The protected predecessor policy and executable
enforcer must validate the exact PR, CI run/check identities, independent findings, complete
manifest, isolated qa/recovery proof, provider reconciliation, and business-evidence
references before issuing a short-lived single-use permit. Candidate policy cannot authorize its
own weakening. Source admission, provider promotion, post-smoke readback, durable success, durable
rollback, and post-admission recovery-required state are separate receipts. An unknown, drifted,
expired, replayed, or unresolved P0/P1 state stops the transition; a partial/unknown migration may
not be described as rollback.

## Segregation of duties

Governed automation does not eliminate separation:

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

Stops may be cleared only by the actor and evidence defined in policy. Model confidence, a plan,
or an AI explanation is never a clearance reason.

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

### Unconfirmed crew items

A crew phone stops a saved item as unconfirmed when the office answered but the phone could not
verify that the office holds that exact item (`verification_mismatch`,
`fleet_collision_storage_mismatch` in `app/src/storage/outbox-failure.ts`). The phone keeps the item
and tells the crew member to call the office. A person in the office answers it; an agent never
does.

- `POST /api/v1/field-item-resolutions` records the answer: `arrived`, `duplicate` or
  `not_arrived`. It takes an owner or ops session (the roles that already pair and revoke crew
  devices), the CSRF token and an `Idempotency-Key` of the form `field-item-resolution:<uuid>`. An
  exact replay returns the original answer; the same key with a changed request conflicts; a second
  answer for the same item conflicts. Any request carrying a machine credential (an
  `Authorization` header, or the Hermes desktop headers) is refused as `person_session_required`,
  and so is any in-process actor that is not a person.
- The answer is bound to the exact saved item: the device action id the phone used as its
  `Idempotency-Key`, the item kind, and `payload_sha256`, which is the Worker's own stored request
  hash for that crew write (`payload_hash`, an inventory `request_fingerprint_sha256`, or a
  configured value's `command_fingerprint`). The phone cannot recompute that hash for most kinds
  and the Worker keeps no copy of the raw request, so the stored hash is the only payload identity
  the Worker can check against the stored write; the phone binds the answer by its own device
  action id, and for an inventory scan it also checks the fingerprint it computed itself.
- `arrived` and `duplicate` must cite the stored crew write as the linked record, and the Worker
  checks that the write exists in this tenant, is settled (a verified action, an applied
  inventory command, a recorded scan or configured value), belongs to the named crew member, and
  carries the cited hash. `not_arrived` cites nothing and is written only while no crew write
  exists for that device action id in any bound store, checked again inside the insert.
- The AI field coordinator may propose an answer. The person sends its proposal reference (the
  `field_safety` agent id and the agent run step id) in the same request; the Worker checks that
  the step is that coordinator's `field_item.propose_resolution` proposal about the same item and
  answer, and records the person as the resolver. The reference is provenance only.
- `field_item_resolutions` (migration `0150`) is append-only and tenant-scoped, with one answer
  per tenant, device action id and payload hash; each answer writes an `audit_log` event in the
  same batch.
- `GET /api/v1/field-item-resolutions?device_action_id=…` (up to 50 ids, field sessions only)
  returns the answers for items the caller created (never by device id, which an inventory scan
  supplies itself), with a minimal link for an item the office holds. When online, the phone settles `arrived` and `duplicate`
  without a resend and shows "The office confirmed it has this."; on `not_arrived` it sends the
  item once more under the same key and the normal verification decides; with no answer it keeps
  the call-the-office guidance.
- Collision reports and corrective-action evidence are stored under their own record ids without
  the device action id, so the route refuses both kinds (`field_item_kind_unbound`) and those items
  stay on the call-the-office path. A crew write that exists but is not settled cannot be answered
  either way.

### Failed Newo handoffs

A failed handoff (`newo_sessions.handoff_status = 'failed'`) is a caller's request for a person
that did not arrive or could not be processed. It stays open until a person records how it ended;
there is no lookback window, because a window would retire a failure nobody decided. The
receptionist is callback only and never transfers a call live: a callback it requests is
`requested`, opens a callback incident, and is not a failed handoff
([`NEWO-INTEGRATION.md`](./NEWO-INTEGRATION.md#handoff-and-sms)).

- `POST /api/v1/newo/operations/handoffs/{session_id}/resolution` (CSRF + `Idempotency-Key`)
  records `outcome` = `called_back`, `unreachable` or `not_needed` and an optional note, with
  `resolved_by` (the person's user id), their role and `resolved_at`. `GET` on the same path returns
  the handoff and its resolution.
- People-only: a person's own cookie session in the owner or ops role, read from the live session
  (`newo_handoff_resolution_person_required`, `newo_handoff_resolution_role_required`). Agents,
  automations, connectors, service tokens, the effect runtime and MCP actors are refused.
- `newo_handoff_resolutions` (migration `0151`) is append-only and tenant-scoped with at most one
  resolution per failed handoff. D1 re-checks that the session is failed and that the resolver is an
  active owner or ops user holding that role; an exact replay returns the stored record and a
  changed intent conflicts (`newo_handoff_resolution_replay_conflict`, `newo_handoff_already_resolved`).
- The Newo reconcile count (`failed_handoffs`) and the operations exception list count only failed
  handoffs with no resolution, through one shared predicate.

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
- the evidence bundle can reconstruct who did what, under which authority, from which facts;
- no required operating transition, readiness verdict, or release artifact depends on Frappe;
- an isolated technical reference tenant completes the exact production loop and required
  failure/recovery drills without being described as customer validation; and
- `customer_validated` remains false until independent real-customer evidence exists.
