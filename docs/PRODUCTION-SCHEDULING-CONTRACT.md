## Production Scheduling Contract (IRO-50)

Status: Target — architecture spec only, no code shipped yet.
Owner: ironwrap-architect (design), production-controller domain (build).
Last verified: 2026-08-21 — full §2.1 inventory against `ironwrap-os@2c2a1d6`; the §7.1 migration
reservation, the "no `reschedule` in code" claim and the `SCHEDULING_PRODUCTION_GATES` citation
re-confirmed against `main@1f36c29`; the §2.1 gate-clearing entry added against `main@249c214`
plus the ELEC-122 branch.
Review trigger: re-verify before implementation starts, and again whenever IRO-45 (inventory) or a workforce/time lane merges to `main`.

Everything in this document is **Target** unless a paragraph says **Implemented** and cites a `path:line`. No implementation code accompanies this spec; short type/schema sketches below are illustrative, not shippable.

---

### 0. Implementation status

| Slice | Status | Evidence |
|---|---|---|
| All (S0–S11, §10) | Target | — |

Nothing described in §4–§9 exists yet. What already exists and this spec builds on is inventoried in §2.1.

---

### 1. Requirement

Linear IRO-50 (source of truth — its acceptance criteria outrank this summary): replace approval-led schedule snapshots with a constraint-aware plan/replan engine that can safely execute routine digital scheduling. Proven gap, quoting the issue: "Production schedule approval requests, broker execution and runway UI exist. There is no complete solver for competency, crew, material, shop, equipment, permit, weather, site/access, customer and predecessor constraints; `reschedule` has no execution path."

Acceptance criteria (verbatim from Linear, condensed):
- Deterministic constraint model consumes exact versioned authority/material/equipment/job facts and explains every conflict.
- Plans preserve commitments, travel/setup capacity, dependencies, buffers and work-package readiness.
- Weather/provider facts are time-bounded and reconciled; unknown state blocks rather than guesses.
- Routine policy-permitted replans execute through the effect runtime and notify affected parties through governed communication; customer/legal commitments require their actor.
- Manual overrides are versioned, attributed and revalidated.
- Tests cover double booking, expired competency, missing material, machine outage, permit expiry, weather change, offline crew and rollback to prior plan.
- Runtime/rollback: shadow comparison before activation, then prove one automatic reschedule with provider readback and a reversible prior-plan restore.

Blocked-by graph on IRO-50 (Linear): IRO-45 (inventory), IRO-38 (effect runtime), IRO-39 (audit), IRO-43 (authority records), IRO-42 (work packages), IRO-46 (shop work centres). §2.1/§3 resolve each against what's actually on `main` today.

Product-workflow anchor: this domain advances **step 6** (CRM/ordering/crew) of the six-step core workflow, consuming step-4 output (quantities/work/pricing — IRO-52 money lane) and step-2/3 job data.

---

### 2. Current state

#### 2.1 What exists on `main`

- **Production schedule approval broker** — human-gated, single-assignment creation. `workers-bus/src/production-schedule-approval-store.ts` (D1 ledger, state machine `pending → executing → executed|denied|expired|failed|audit_failed|execution_uncertain`), `workers-bus/src/production-schedule-approval-broker-client.ts` (HMAC-signed calls to a private broker; `previewProductionScheduleApproval`/`executeProductionScheduleApproval`, `production-schedule-approval-broker-client.ts:143-219`), `workers-bus/src/production-schedule-approval-authority.ts` (single named owner-approver + session-freshness gate, `:15-40`). Schema: `workers-bus/migrations/0020_production_schedule_approval_requests.sql` — two tables, immutability/transition triggers, and a partial unique index `idx_production_schedule_approvals_active_target` (`0020:192-194`) enforcing one active proposal per target assignment. Bus routes: `app-api.ts` `/api/v1/production-schedule-approvals[...]` (list/prepare/:id/approve/:id/reject/:id/reconcile/:id detail). The broker's own execution effect is deliberately narrow: `safeExecutedResult()` asserts `assigned_user_mutated: false, crew_notified: false, customer_notified: false, accounting_mutated: false` (`production-schedule-approval-broker-client.ts:478-507`) — creating one Job Assignment record is the *only* automatic effect today; no notification or dispatch fires.
- **`reschedule` literally does not exist in code.** Confirmed by full-repo grep: zero hits in `workers-bus/src` or `app/` beyond unrelated identifier collisions (`compareSchedule` sort comparator, `canPrepareSchedule` permission flag). A correction today is only representable as a brand-new approval request with `supersedes_assignment_id` set (`0020_production_schedule_approval_requests.sql:119-122`) — still human-initiated, never automatic.
- **Runway UI** — `app/src/production/production-runway-page.tsx` is a read-only, desktop/tablet kanban board (5 fixed lanes, `:29-77`) whose header states explicitly: "This view does not schedule, dispatch, or alter a job" (`:154`). It is not, and per `docs/APPROVAL-BROKER-CONTRACT.md:142-147` ("Production Runway remains a source-backed read") should not become, the scheduling engine's surface.
- **Existing manual gate checklist** — `SCHEDULING_PRODUCTION_GATES = ["Deposit","Materials","Safety","Access","Weather","Crew"]` (`app-read-models.ts:80-91`), a read-only projection of Frappe-side gate records (`Blocked|Ready|Waived|Done`). Gates whether `production_schedule_approval.prepare` is offered as an action — not a computed constraint check, not automated, and `"Weather"` here is a label with no backing provider.
- **Gate clearing rail (Implemented, ELEC-122)** — until this landed, the checklist above had validators, a correctly-enforcing scheduling fence, and **no producer at all**: transport created all six gates `Blocked` (`workers-bus/src/erpnext.ts:707-740`) and nothing in the product could move one, so `POST /api/v1/production-schedule-approvals` could never legitimately reach `202` (ELEC-120 finding 3). Now: `POST /api/v1/production/jobs/{jobId}/gates/{gate}/clearance` (`workers-bus/src/production-gate-clearance.ts`) → the bounded Frappe command `ironwrap_roofing.production_gate_api.record_production_gate_clearance`, with the office surface on the runway card (`app/src/production/production-gate-clearance-panel.tsx`). Two bases, and the difference is a claim about proof: `deposit_settlement` derives the Deposit clearance from the money lane's own settled `deposit_invoice` intent, stores an immutable R2 receipt of exactly what it read, and lands the gate in `Ready` bound to a Verified Evidence Item; `office_waiver` is a governed manual clearance that lands in `Waived` with actor, reason and time, which is what `domain_policy._validate_gate` asks of a clearance carrying no evidence. **Materials, Safety, Access, Weather and Crew have no derived basis yet** — that is the honest statement of what IronWrap can prove today, not a design preference, and each is a candidate producer for this spec's constraint model (§5). Authority is unchanged and uninvented: Frappe requires the `actor_user` to hold IronWrap Owner or IronWrap Production, exactly as `access_control.DOCTYPE_ROLE_MATRIX` already grants. Re-blocking a cleared gate is deliberately absent.
- **The approval rail cannot reach `202` on a tenanted site, and the reason is inside this lane (Implemented finding, ELEC-122).** With the six gates cleared, an active Crew Profile present and a Won job on the runway, `POST /api/v1/production-schedule-approvals` still answers `422 broker_production_schedule_preview_rejected`. Driven against Frappe directly on a real local stack, the Job Assignment insert the broker previews refuses with `[authority_tenant_unavailable]` on a site with no active White-Label Tenant, and with `[missing_authority_requirements] authority_requirements_json` once one exists (`domain_policy._require_canonical_authorities`, `:1945-1975`). The broker never sets that field: `dryRunArgsFromInput`/`writeArgsFromInput` (`mcp/erpnext-roofing-mcp/src/production-schedule-approval-broker.mjs:517-540`) do not include it, and `assertFullDraft` (`:560-576`) asserts the draft's key set *exactly*, so it cannot appear. Declaring what authority a production assignment requires is an IRO-43/IRO-50 decision - which authority kinds, whose, at what version - and is deliberately not answered here. This is the next producer gap after the gates, in the same shape.

- **Work packages** (IRO-42, merged `861610a`) — Frappe-owned, D1 only holds the action ledger (`field_work_package_actions`, `workers-bus/migrations/0028_work_package_actions.sql`) and evidence-slot columns on `field_actions` (`0044_work_package_evidence_slots.sql`). Already industry-agnostic: scoped by `workObjectType`/`workObjectId` (generalized from a legacy `roof_job` field, `work-package.ts:180-196`), not a roofing-specific job type. No scheduling-date fields beyond issuance lifecycle timestamps (`issuedAt`/`expiresAt`/`releasedAt`).
- **Fleet assets** (merged under IRO-54, `3ed3e40`, `df1800b` — see §2.3 note on the IRO-46 label) — Frappe-owned; D1 only stores inspection/defect action receipts (`fleet_asset_actions`, `workers-bus/migrations/0046_fleet_asset_actions.sql`). **No availability, booking, or capacity concept exists anywhere in the codebase** — confirmed by an empty grep for "capacity" and "work centre/center" across all of `workers-bus/src`.
- **Safety lifecycle** (IRO-47-equivalent, `0047_safety_lifecycle.sql`) — `safetyReleaseGate()` (`safety-release-gate.ts:96-138`) is already "the one place a release decision consults safety," and its snapshot table's consumer enum already includes `schedule_release` alongside `work_package_release` (`0047:725-727`) — i.e. **the safety gate is already wired for scheduling to consult**, this spec just needs to call it. Weather is *not* modeled in the safety lifecycle: no weather occurrence kind, blocker code, or table exists; it's only a free-text field on the Frappe Safety Plan doc.
- **Authority records** (IRO-43, merged `0263a2d`/`a931043`) — Frappe-owned normalized record; D1 owns only a command ledger (`authority_record_actions`) and issuer readbacks (`authority_record_readbacks`), `workers-bus/migrations/0045_authority_record_actions.sql`. Versioning is a full-record content digest (`authorityStateDigestAsync`, `authority-record-executor-api.ts:187-192`) checked before any command applies — this is the "exact versioned facts" mechanism the new constraint model should key off. Kinds already include Trade Licence, WCB Clearance, Insurance, Permit, Inspection, Manufacturer Cert/Bulletin (`authority-record-executor-api.ts:67-75`). `docs/CAPABILITY-MATRIX.md:391` already names scheduling as a target consumer of these records. **workers-bus exposes no "current valid authority for actor X" query route** — only command/readback proof. Resolving "is this crew member currently certified" is a Frappe-side read the new domain must call out to, not something workers-bus can answer standalone today.
- **Effect runtime** (IRO-38, `0042_external_effect_runtime.sql`, `0062_external_effect_insert_replace_guards.sql`) — generic `runExternalEffect` port, `EffectExecutor<T>` interface (`effect-runtime.ts:126-149`: `preconditions()`, `dispatch()`, `readback()`, `replay()`), claim/settle pattern for remote MCP-hosted executors that hold provider credentials (`effect-runtime-admin.ts:16-20`). Two existing integration patterns to imitate: (a) **accounting wraps the runtime behind its own narrow port type** rather than importing it raw (`accounting-effect-port.ts:1-9`, per `docs/ACCOUNTING-RECONCILIATION-CONTRACT.md` §3.1); (b) **Newo governed-communication** — `executeNewoMutationThroughRuntime` (`newo-control.ts:579-657`) drives `chat.user.send`/`conversation.agent_message.send` as one `runExternalEffect` call — this is the direct precedent for "notify affected parties through governed communication."
- **Transition kernel** (`workers-bus/src/transition-kernel.ts`, `0027_transition_kernel.sql`) is **not a reusable generic workflow engine** — its schema and types hardcode `subject_kind='approval_request'`, `request_kind='lead_triage'`, `transition_kind='approval_execution'` (`0027:18,23-26`; `transition-kernel.ts:22-23`), and only `app-api.ts` imports it. Work packages, safety, and accounting each independently implement their own `version` column + attribution, following the **canonical transition envelope** convention in `docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md` (lines 86-112: `transition_id, tenant_id, aggregate_type/id, from_state/to_state, actor{type,id,role_version}, authority_ref, policy_version, evidence_refs, input_hash, occurred_at, correlation_id, result, reason_codes`). **This spec follows the same house convention — implement our own versioned aggregate, do not attempt to reuse `transition-kernel.ts`.**
- **Crew day view (mobile)** — `app/src/field/today-page.tsx`, route `/today`, is already the PWA's `start_url` and already is the "crew's day" surface: run sheet of assigned jobs (`TodayJobRow`), offline-packet readiness panel, saved-work recovery. `app/src/field/field-pages.tsx` `JobPage` (route `/jobs/$jobId`) is the linked work-package detail view. Offline infrastructure already in place: IndexedDB cache (`app/src/field/field-cache.ts`), a durable mutation outbox with retry/backoff (`app/src/storage/outbox.ts`), `vite-plugin-pwa` service worker tuned specifically for `/today`'s mobile boot path (`app/vite.config.ts`), and a Lighthouse mobile-performance CI gate (`scripts/lighthouse-field.mjs`). **This spec extends `/today`, it does not build a new crew day-view surface from scratch.**
- **Money lane (IRO-52)** — fully merged through S8+S9 (`2c2a1d6`). Its authority-ceiling + separation-of-duty pattern (`accounting-authority-policy.ts`: server-owned, versioned, per-tenant `max_amount`; fails closed to a conservative default if unconfigured; magnitude-compared so signed amounts can't dodge it) is the direct precedent §6 reuses for "what may autonomous rescheduling do alone."

#### 2.2 What exists only on unmerged heads

| Artifact | Branch / PR | On `main`? | Relevance to IRO-50 |
|---|---|---|---|
| Inventory ledger (`inventory_po_lines`, `inventory_receipt_lines`, 23 more tables) | PR #60, `codex/iro-45-inventory-control` | No — CI-green but 17 commits stale, and its migration `0046_inventory_control.sql` **collides in number** with main's `0046_fleet_asset_actions.sql` | Material-arrival facts for the constraint model. See §3. |
| `field_time_entry_actions`, `payroll_preparation_effects` (workforce/time lane) | local-only ref `codex/iro-53-workforce-lifecycle`, not on `origin`, not an ancestor of `main` | No | Would give per-worker time-punch facts as a crew-availability proxy. See §3. |

#### 2.3 Reconciled against the canonical contracts

- `docs/AUTONOMOUS-OPERATING-SYSTEM.md` §14 "Production planning and dispatch" (lines 363-375) is, almost verbatim, this issue's target state: schedule across contract/permit/material/inspection readiness, human skills/fatigue/availability, shop/vehicle/tool capacity, weather and site safe-work limits, travel/access/predecessor work/buffer, supplier/cash/customer commitments — and states plainly: **"Rescheduling updates every affected person, reservation, delivery, provider, cash forecast, and customer promise. A calendar entry is never a release to work."** The Agent-organization table (line 651) scopes the agent's role explicitly: "Scheduling and dispatch | constraint-based plan | cannot schedule through a hard gate" — an agent may compute and propose, but a computed schedule is only real once it clears the same release gates (safety, authority, material) a manual schedule would.
- `docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md` (lines 23-44, "Human and agent boundary") states routine scheduling/planning and communications are explicitly agent-owned "within recorded consent and authority"; humans retain licensed/statutory/regulator-required signoffs, physical stop-work/emergency decisions, and relationship-sensitive conversations on request. This is the textual basis for §6's autonomy tiers.
- `docs/CAPABILITY-MATRIX.md` line 383, Scheduling row: current state = "assignment and approval ledger"; target gap = "complete constraint solver and autonomous reschedule"; proof required = "conflict/weather/material test." This spec is that gap being closed, using the matrix's own five-level vocabulary (Implemented / Repository-verified / Partial / Target-only / External proof required) for every future implementation-status update to this doc.
- **Blocker resolution against Linear's blockedBy list:** IRO-42 (work packages) and IRO-43 (authority records) are merged and read in §2.1. IRO-38 (effect runtime) is merged. IRO-46 (shop work centres) has no matching commit trail by that number; the matching merged work is tagged **IRO-54** ("fleet, equipment, driver, cargo, and maintenance operations," `3ed3e40`) — flagged as an open question in §12, since it covers fleet/equipment but still has no work-centre-capacity concept (§2.1). IRO-39 ("audit the exact integration head against Gate 0-6") reads as a review/audit deliverable, not a code dependency that blocks architecture — treated as non-blocking here; flagged in §12 for PO confirmation. IRO-45 (inventory) is genuinely not on `main` — handled via the escape-hatch seam in §3, mirroring the accounting contract's own §3 pattern for its external dependency.

---

### 3. The IRO-45 / workforce dependency — verdict

**Verdict:** do not block IRO-50 implementation on either IRO-45 (inventory) or a workforce/time-entry lane landing. Both are designed against through a port, exactly as the accounting contract's §3.1 unblocked itself against its own external dependency (`#46`) by defining the seam first and binding a real implementation later.

#### 3.1 The seam that lets implementation start anyway

Two fact sources the solver needs are not fully backed on `main` today:

- **Material readiness.** Define a `MaterialReadinessFactSource` port: `resolve(workPackageId) -> { state: "ready"|"blocked"|"unknown", observedAt, expiresAt, source }`. Bind it in S3 (§10) to a stub that always returns `"unknown"` (which, per the acceptance criteria's own rule — "unknown state blocks rather than guesses" — makes every material constraint fail closed, not silently pass). When IRO-45 merges, bind the same port to real reads of `inventory_receipt_lines`/`inventory_reservations`; no solver code changes, only the binding.
- **Crew availability.** Define a `CrewAvailabilityFactSource` port. Bind it in S4 (§10) to a fallback implementation using only what's on `main` today: overlapping `Job Assignment` windows (read via the existing production-schedule-approval read model) plus Authority Record validity — i.e. a crew member is "available" if they have no overlapping active assignment and no expired/revoked authority for the job's required kind. When a workforce/time-entry lane lands, rebind to also exclude punched-out/on-leave time.

Rules that make the seam safe (mirroring the accounting contract's own rules for its equivalent seam):
1. Every fact returned through a port carries `observedAt`/`expiresAt` (or is explicitly `unknown`) — never a bare boolean with no freshness.
2. A stub/fallback binding must be conservative (fails toward "blocks/unknown"), never optimistic.
3. Rebinding a port to a real implementation is additive and requires no migration to the solver's own tables — only to the port's own binding module.
4. The spec's task breakdown (§10) states, per slice, which binding is used and what improves when the real dependency lands.

---

### 4. Domain model and system of record

#### 4.1 The split

| Concept | System of record | This domain's role |
|---|---|---|
| Job / Work Object | Frappe (`Roof Job` today; generalized as `workObjectType`/`workObjectId` per work-package.ts) | Reads only |
| Work Package | Frappe | Reads scheduling-relevant fields (scope, issuance window); does not write work-package state |
| Crew / Job Assignment | Frappe, created via existing production-schedule-approval broker | This domain proposes assignments; execution still goes through the existing broker (Tier 2) or a new governed-notify path (Tier 1) — see §6 |
| Authority Record (competency/permit/licence) | Frappe, D1 owns command/readback ledger only | Reads only, via Frappe |
| Material readiness | Frappe/D1 inventory ledger (IRO-45, not yet merged) | Reads only, through the port in §3.1 |
| Fleet asset identity | Frappe, D1 owns inspection/defect ledger | Reads identity/inspection status only |
| **Fleet asset booking** (new) | **D1, owned by this domain** | New — no existing owner |
| **Work Centre + daily capacity** (new) | **D1, owned by this domain** | New — no existing owner |
| **Schedule Version / candidate assignments** (new) | **D1, owned by this domain** | New — the solver's own output |
| **Weather fact** (new) | **D1, owned by this domain, sourced via effect-runtime `EffectExecutor`** | New |
| Governed notification | Effect runtime (Newo binding) | Reused as-is |
| Safety readiness | `safety-release-gate.ts` (already accepts a `schedule_release` consumer) | Reused as-is, called not owned |

#### 4.2 Aggregates this domain owns

- **`ScheduleVersion`** — an immutable, append-only snapshot: which candidate assignments it proposes, which constraint facts (with their own versions/digests) it was computed against, a `solver_run_id`, and a status (`draft | shadow | proposed | active | superseded | rolled_back`). Every activation supersedes the prior active version for the same scope (job or crew-day), the same pattern work packages use for their own supersession chain (`work-package.ts:328,381,389,525`). Carries the canonical transition envelope fields from `AUTHORITY-AND-EVIDENCE-CONTRACT.md` (actor, authority_ref, policy_version, evidence_refs, input_hash, reason_codes) — this is what makes "manual overrides versioned, attributed and revalidated" concrete: an override is just a `ScheduleVersion` whose actor is a human owner and whose `reason_codes` records why, and it is still run back through the same constraint check before being accepted as `active` (never blind-trusted).
- **`ScheduleAssignmentCandidate`** — one row per (work package, crew, optional fleet asset, optional work centre, start, end) inside a `ScheduleVersion`, plus which constraints it satisfies/violates and why (the "explain every conflict" acceptance criterion — each candidate carries a `conflicts: ConflictExplanation[]` array, never a bare pass/fail).
- **`ConstraintFactSnapshot`** — one row per fact pulled in from a port (weather, material, crew availability, authority) at solve time: `kind, subject_ref, state, observed_at, expires_at, source, raw_digest`. This is what makes facts "exact and versioned" rather than live-queried at read time — a `ScheduleVersion` references specific snapshot ids, so re-explaining a past decision never depends on a fact that has since changed.
- **`WorkCentre`** — a named physical resource pool with a per-day capacity (e.g. metal-panel brake, dump-trailer slots). Generic entity; which centres exist for a tenant is config data, not a hardcoded enum (see §12 Q1 for the one place this needs a PO call).
- **`FleetAssetBooking`** — reserves an existing (Frappe-owned) fleet asset for a date range against a work package; additive, does not touch `fleet_asset_actions`.
- **`WorkPackagePredecessor`** — a directed edge `(work_package_id, depends_on_work_package_id, buffer_hours)` for sequencing (e.g. tear-off before dry-in before install). Generic mechanism; roofing supplies the actual sequences as config/data, not code.

Illustrative shape only (not shippable):

```ts
interface ScheduleVersion {
  scheduleVersionId: string;
  tenantId: string;
  scope: { kind: "crew_day" | "job"; crewProfileId?: string; workObjectId?: string; date?: string };
  status: "draft" | "shadow" | "proposed" | "active" | "superseded" | "rolled_back";
  supersedes: string | null;
  solverRunId: string;
  factSnapshotIds: string[];
  actor: { type: "agent" | "owner"; id: string; roleVersion: string };
  authorityRef: string;
  policyVersion: string;
  reasonCodes: string[];
  inputHash: string;
  occurredAt: string;
}
```

---

### 5. Semantics

#### 5.1 What a valid schedule means

> A `ScheduleAssignmentCandidate` is **valid** only if every constraint it depends on resolved to a definite pass against a fact snapshot no older than that fact's own freshness window; any `unknown` fact makes the candidate invalid, not merely "unscored." An `active` `ScheduleVersion` contains only valid candidates.

Three non-negotiable rules (mirroring the accounting contract's own §5.1 discipline):
1. A candidate is never activated on a stale fact — every `ConstraintFactSnapshot` referenced by an active version must be within its own `expires_at` at activation time, re-checked at activation, not just at solve time.
2. Weather and material facts default to blocking, never to permissive, on absence or ambiguity (acceptance criterion, restated here as a hard rule).
3. Activation always calls `safetyReleaseGate()` with `consumer: "schedule_release"` immediately before commit — the solver's own pass does not substitute for it (§2.1 notes this consumer value already exists in the schema).

#### 5.2 Constraint types and their fact source

| Constraint | Fact source | Freshness discipline |
|---|---|---|
| Competency / certification | Authority Record (Frappe read) | Digest-versioned already (`authorityStateDigestAsync`); re-read at solve and re-verify at activation |
| Crew availability | `CrewAvailabilityFactSource` port (§3.1) | Snapshot with `observed_at`/`expires_at`; fallback binding treats overlap as immediate/no-freshness-window |
| Material arrival | `MaterialReadinessFactSource` port (§3.1) | Stub returns `unknown` (blocks) until IRO-45 binds |
| Shop / work centre capacity | New `WorkCentre` daily capacity table | Computed at solve time from existing bookings, no external staleness |
| Fleet / equipment availability | New `FleetAssetBooking` table + existing fleet-asset identity | Computed at solve time |
| Permit | Authority Record, `authority_kind = "Permit"` | Same as competency |
| Weather | New `WeatherEffectExecutor` (effect-runtime binding, mocked provider — no live GCP/weather API per project rules) | Explicitly time-bounded per acceptance criteria; reconciled on a re-check cadence; `unknown` blocks |
| Site / access | Existing `SCHEDULING_PRODUCTION_GATES` "Access" gate (Frappe read) | Read-only projection, as today |
| Customer commitment | Existing promised-date field on the job (Frappe read) | Any candidate that would move a promised date is never Tier-1 eligible (§6) |
| Predecessor / sequencing | New `WorkPackagePredecessor` table | Computed at solve time |

#### 5.3 Verdicts

| Verdict | Condition | Terminal? |
|---|---|---|
| `valid` | All constraints pass against fresh facts | No — still needs authority tier resolution (§6) |
| `conflict` | One or more constraints fail against fresh facts | Yes for that candidate; solver must propose an alternative or surface the conflict |
| `stale` | A referenced fact snapshot has expired since solve | No — triggers re-solve before activation |
| `unknown` | A fact source returned `unknown` | Treated as `conflict` per the blocking rule in §5.1 |

#### 5.4 Required failure cases (from the acceptance criteria — all Target)

Each must have a deterministic fixture-driven test and an explicit `ConflictExplanation` reason code: double booking (two candidates claim the same crew/asset/work-centre slot), expired competency (Authority Record `expires_at` before assignment start), missing material (`MaterialReadinessFactSource` returns `blocked`/`unknown`), machine outage (a `WorkCentre` or fleet asset marked unavailable mid-window), permit expiry (Authority Record kind `Permit` expired), weather change (a fresh `WeatherEffectExecutor` fact invalidates an already-`active` version, forcing a new `ScheduleVersion`), offline crew (a crew member's device hasn't synced — treated as `unknown` availability, not "assumed present"), rollback to prior plan (activating the immediately-prior `ScheduleVersion` in the supersession chain, proven reversible per the issue's runtime/rollback requirement).

#### 5.5 Implementation status of each failure case

All Target — none implemented yet (§0).

---

### 6. Authority and evidence

Mirrors the money-lane precedent (`accounting-authority-policy.ts`) and the explicit human/agent boundary in `AUTHORITY-AND-EVIDENCE-CONTRACT.md` (§2.3).

| Transition | May be autonomous? | Required authority | Evidence |
|---|---|---|---|
| Compute/propose a new `ScheduleVersion` (`draft`/`shadow`) | Yes — always, this is `derive`, not a side effect | Agent, `observe`/`derive` level | `ConstraintFactSnapshot` refs |
| Activate a routine replan (Tier 1) | Yes, **only if all of**: every constraint is `valid`, no customer-promised date moves, no crew/asset pairing crosses a competency boundary it didn't already clear, magnitude of change is within a server-owned, versioned policy envelope (mirroring `accounting_authority_policies`, fails closed if unconfigured) | Agent, `commit_internal` level | `ScheduleVersion` + governed notification receipt (Newo effect) to every affected party |
| Activate a schedule that breaks a customer commitment, crosses the policy envelope, or requires overriding a hard/safety gate (Tier 2) | No | Owner (the existing configured `APP_PRODUCTION_SCHEDULE_APPROVER_ID`, reused as-is) | Routed through the existing production-schedule-approval broker unchanged — this spec does not modify that broker's authority model, only feeds it better-informed proposals |
| First assignment of a job to any schedule | No (matches today's behavior) | Owner, via the existing broker | Existing `production_schedule_approval_requests` flow |
| Manual override of an `active` `ScheduleVersion` | Human-initiated only | Owner | New `ScheduleVersion` with `actor.type = "owner"`; still re-run through §5.1's validity check before acceptance — an override that would violate a hard gate (safety, expired authority) is rejected, not rubber-stamped |
| Rollback to a prior `ScheduleVersion` | Autonomous within Tier-1 envelope, else Tier 2 | Same tiering as activation | Supersession chain proves reversibility |

Standing rules (carried from `AUTHORITY-AND-EVIDENCE-CONTRACT.md`):
- No shared/unattributed actor may activate a version — every `ScheduleVersion.actor` is one authenticated actor from the closed class (`agent | owner`).
- The policy envelope for Tier-1 magnitude (how much a routine replan may move a start time, how many crew-days it may touch) is server-owned and versioned, never caller-declared — same discipline as the money ceiling.
- Segregation of duty: the actor proposing a Tier-2 replan (agent) is never the actor approving it (owner) — already true structurally, since Tier 2 always routes through the existing broker's single-approver gate.
- `AUTONOMOUS-OPERATING-SYSTEM.md`'s explicit boundary — "cannot schedule through a hard gate" — is enforced by §5.1 rule 3: `safetyReleaseGate()` is called at activation regardless of tier, and its result can never be bypassed by policy envelope alone.

#### 6.1 The Job Assignment authority declaration (**Implemented**, ELEC-124 ruling / ELEC-125)

`domain_policy._require_canonical_authorities` (`domain_policy.py:1983-2062`) has always required a
Production Job Assignment with a crew to declare, in `authority_requirements_json`, exactly which
IRO-43 Authority Records must resolve as current before the assignment is admitted — and it stops
being optional the moment any White-Label Tenant is Active (`_locked_authority_records`,
`document_validation.py:2370-2414`). Nothing produced that field, so every fully-gate-cleared `Won`
job was still refused with `[missing_authority_requirements]`. It is now compiled, deterministically,
by the schedule broker:

- **Producer** — `compileCrewAuthorityRequirements`
  (`mcp/erpnext-roofing-mcp/src/production-schedule-approval-broker.mjs`). One row per **active**
  Crew Member: `{subject_type: "Person", subject_role: "Worker", subject_ref: <crew_user>,
  authority_kind: "Worker Competency", scope_type: "Roof Job", scope_ref: <roofJobId>}`.
- **Scope is the job, not the assignment.** A competency record is a fact about a worker on a job, so
  one record covers every assignment *and* work package on it — the same shape Work Package's own
  call site (`domain_policy.py:2597`) needs. Assignment scope would force re-issuing the identical
  competency per assignment.
- **Roster source** — `get_crew_authority_roster`, a read tool exposing three Crew Member columns
  (`crew_user`, `crew_role`, `active`) and nothing else. `get_crew_profile` deliberately still drops
  the whole `members` child table.
- **Nothing new is enforced.** The compiler states an existing expectation ("every worker on a
  Production crew needs current competency", today checked only as the crew-level `competency_status`
  summary) in the individually-versioned form IRO-43 introduced. No Frappe change, no migration.
- **Roster drift refuses.** The compiled list travels inside the approved write args, and those args
  are recompiled from a **fresh** roster read at execution and compared byte-for-byte against what
  the approver signed. A member added or deactivated between approval and execution fails the write
  closed with `broker_production_schedule_execution_args_mismatch` — the approval contract's existing
  integrity guard, not a second mechanism.
- **Still out of scope, unchanged from the ruling:** WCB Clearance, Trade Licence, Permit and
  Inspection are *not* compiled here. `_require_current_compliance_authority`
  (`domain_policy.py:1891-1980`) already resolves them independently off Job Compliance Records, and
  Crew Profile carries no link a jurisdiction-scoped requirement could name a `subject_ref` from
  (`docs/CAPABILITY-MATRIX.md` still lists complete jurisdiction rules as an open target gap).

**What a real `202` still needs at runtime.** Compiling the declaration is necessary, not sufficient:
`require_authority_gate` (`authority_policy.py:733-`) resolves every compiled row against the locked,
tenant-scoped Authority Record snapshot, so the site must carry, for **each active crew member**, a
`Worker Competency` Authority Record that is current-version, `Verified`, effective, unexpired, and
scoped to the same Roof Job — plus one Active White-Label Tenant. With none seeded, the refusal moves
from `missing_authority_requirements` to the gate's own unresolved-authority code. The working
example of the intended record shape is IRO-43's own fixture,
`test_canonical_authorities_bind_schedule_and_work_package_consumers`
(`frappe-apps/ironwrap_roofing/tests/test_domain_policy.py:5496-5545`); a real-stack traverse to `202`
seeds from that shape.

---

### 7. Schema

#### 7.1 Reserved migration numbers

Confirmed maximum migration number, re-checked 2026-08-20 against `main@1f36c29` (`0066_dev_outbox_contract_acceptance.sql`, landed with ELEC-86) and every open PR head (#22 → 0047, #60 → 0046 [stale/colliding, see §2.2], #70/#71 → 0057, #72 → 0047, #79/#80 → 0065, #82 → 0066), is **66**. Reserve from **0067**, additive/expand-only, never editing a shipped file:

| # | File | Contents | Slice |
|---|---|---|---|
| 0067 | `schedule_constraint_fact_snapshots.sql` | `ConstraintFactSnapshot` table | S2 |
| 0068 | `schedule_versions.sql` | `ScheduleVersion` table + supersession/transition triggers | S1 |
| 0069 | `schedule_assignment_candidates.sql` | `ScheduleAssignmentCandidate` table | S1 |
| 0070 | `work_centres.sql` | `WorkCentre` + daily capacity table | S5 |
| 0071 | `fleet_asset_bookings.sql` | `FleetAssetBooking` table | S5 |
| 0072 | `work_package_predecessors.sql` | `WorkPackagePredecessor` edges | S6 |

No new effect-runtime tables are needed — the existing generic ledger (`0042`, `0062`) accepts new `provider`/domain tags (e.g. `weather`, `schedule-notify`) without a migration.

#### 7.2 Shape conventions

- Follow the closure-based idempotent-action-store pattern used by the two domains closest in shape to this one (`d1WorkPackageActionStore`, `d1FleetActionStore`) for any offline-originated action (e.g. a crew acknowledging a reschedule from the field) — not the flat free-function style of generic `store.ts`.
- Every new table gets `tenant_id`, append-only triggers blocking `UPDATE`/`DELETE` on terminal rows (matching `0020`'s and `0047`'s pattern), and a `version` column plus the canonical transition envelope fields on `schedule_versions` specifically.
- `schedule_assignment_candidates` and `schedule_constraint_fact_snapshots` are children of a `schedule_version_id` FK — never mutated independently of their parent version.

#### 7.3 Frappe

No new Frappe DocTypes required for this domain's own state (it is D1-owned per §4.1); only additive read access to existing DocTypes (Roof Job, Job Assignment, Authority Record, Safety Plan, and — once merged — the inventory DocTypes from IRO-45).

---

### 8. API and PWA surfaces

#### 8.1 Bus routes (new, additive — existing `/api/v1/production-schedule-approvals/*` routes are untouched)

| Method | Path | Purpose | Tier |
|---|---|---|---|
| POST | `/api/v1/schedule-versions/solve` | Compute a new `draft`/`shadow` version for a scope | Autonomous (derive) |
| GET | `/api/v1/schedule-versions/:id` | Read a version + its candidates + conflict explanations | — |
| POST | `/api/v1/schedule-versions/:id/activate` | Activate a Tier-1-eligible version | Autonomous, policy-gated |
| POST | `/api/v1/schedule-versions/:id/propose` | Hand a Tier-2 version to the existing broker as a `production-schedule-approval` request | Human (existing broker) |
| POST | `/api/v1/schedule-versions/:id/rollback` | Activate the immediately-prior version in the chain | Same tiering as activation |
| GET | `/api/v1/crew-day/:crewProfileId/:date` | Read model backing the mobile day view (§8.2) | — |

#### 8.2 PWA screens

| Route | Screen | What changes |
|---|---|---|
| `/today` (existing) | Crew day view / run sheet | **Extend, don't replace**: add a reschedule-change banner (old vs. new, reason) when an activation touches today's assignments for this crew; source from `GET /crew-day/:id/:date` |
| `/jobs/$jobId` (existing) | Work package detail | No change — scheduling remains upstream of this view |
| New: `/schedule/review` | Tier-2 proposal review (mobile-capable card list, not a kanban port) | Owner reviews/approves proposals awaiting Tier-2 confirmation; built from the same `ui/` primitives (`Card`, `Button`, `StatePanel`) already used across the app for consistency, and must clear the same mobile-performance bar as `/today` (Hover benchmark, gating per product rules) |
| `production-runway-page.tsx` (existing) | Desktop runway board | Unchanged contract ("does not schedule, dispatch, or alter a job"); at most gains a read-only link into `/schedule/review` for a job's current proposal, no logic changes |

---

### 9. Test strategy — proving it without a live weather/GPS provider

- **Solver core is pure** — `core.ts`'s convention ("no I/O, no Workers globals, unit-testable with `node --test`") applies directly to the constraint-solving function itself: it takes a scope + a list of `ConstraintFactSnapshot`s and returns candidates + conflicts, with no D1/network access, making the §5.4 failure-case matrix fully deterministic and fast.
- **Port contract tests** — `MaterialReadinessFactSource` and `CrewAvailabilityFactSource` each get a conformance test suite run against both their stub/fallback binding (today) and, once available, their real binding (post IRO-45 / workforce lane) — same shape as the accounting contract's provider-fixture conformance tests.
- **Weather** — mocked `EffectExecutor`, no live provider call, per project rule 5; contract test asserts `unknown`/stale facts block rather than default-permit.
- **D1 invariant tests** — append-only/immutability triggers on `schedule_versions`; the "one active version per scope" invariant (mirroring `0020`'s partial unique index).
- **Shadow-comparison harness** (the issue's own runtime/rollback requirement) — run the solver read-only against real production data, diff its output against what the existing production-schedule-approval broker actually produced, log divergences, activate nothing. This is S7 in §10 and is the gate before any Tier-1 autonomous activation ships.
- **One proven automatic reschedule** — an end-to-end test (still local, no live provider) that triggers a Tier-1 replan, asserts the governed-notification effect fired through the Newo-pattern binding with a readback, and then asserts rollback to the prior version restores the exact prior candidate set.
- **PWA** — Playwright test extending existing `/today` coverage for the new reschedule banner; Lighthouse budget re-run against `/today` to confirm the addition doesn't regress the existing mobile-boot budget.
- **What this cannot prove locally**: real weather-provider behavior, real GCP-backed measurement/photo triggers for site-access facts, and human-perceived UX quality of the mobile review surface — flagged, not silently assumed.

---

### 10. Task breakdown

Dependency-ordered, mirroring the IRO-52 S0–S9 pattern (doc lands first; a zero-schema seam slice unblocks everything else; core aggregate before engine; engine before dispatch; backend before frontend).

| Slice | Depends on | Delivers |
|---|---|---|
| S0 | — | This doc merged; `MaterialReadinessFactSource`/`CrewAvailabilityFactSource`/`WeatherEffectExecutor` port interfaces + stub bindings only, no schema — unblocks everything without waiting on IRO-45 or a workforce lane |
| S1 | S0 | Migrations 0068+0069; pure solver core; candidates computed from facts already fully available on `main` today (Authority Records, existing Job Assignment overlap, `SCHEDULING_PRODUCTION_GATES` reads) |
| S2 | S1 | Migration 0067; `WeatherEffectExecutor` real (mocked-provider) binding with staleness/drift handling |
| S3 | S1 | `MaterialReadinessFactSource` stub binding wired in (still `unknown`/blocking until IRO-45 merges — explicitly the slice that "improves when IRO-45 lands") |
| S4 | S1 | `CrewAvailabilityFactSource` fallback binding wired in (upgrades automatically when a workforce/time lane lands) |
| S5 | S1 | Migrations 0070+0071; `WorkCentre` capacity + `FleetAssetBooking` constraints |
| S6 | S1 | Migration 0072; predecessor/sequencing constraint |
| S7 | S2–S6 | Shadow-comparison harness (§9); no activation capability yet — this is the proof gate before S8 |
| S8 | S7 (must show clean shadow comparison) | Tier-1 autonomous activation route + governed-notification dispatch + rollback route |
| S9 | S8 | `/schedule/review` Tier-2 review PWA surface (mobile-capable) |
| S10 | S8 | `/today` extension: reschedule-change banner, backed by `/crew-day/:id/:date` |
| S11 | S8, S9, S10 | Full §5.4 failure-case test matrix + the one proven automatic reschedule with provider readback and reversible rollback (issue's own runtime/rollback bar) |

Backend (S1–S8, S11) and frontend (S9, S10) can run in parallel once the `ScheduleVersion`/candidate response shape is fixed at the end of S1, matching how the money lane split its backend and PWA slices.

---

### 11. Rejected alternatives

- **Reuse `transition-kernel.ts` for schedule versioning** — rejected: its schema and types hardcode `lead_triage`/`approval_execution` (`0027_transition_kernel.sql:18,23-26`), not generalizable without rewriting it; every other domain (work packages, safety, accounting) already independently implements its own versioned aggregate instead, and this spec follows that established house pattern rather than generalizing shared infrastructure nobody asked for.
- **Overload the existing `production_schedule_approval_requests` table for multi-day/multi-crew optimization** — rejected: its schema and triggers (partial unique index, append-only guards) are built for exactly one proposal per target assignment; bending it to hold a full constraint-solved plan would break the invariants that make it safe for its current single-assignment human-approval use. Keep it untouched as the Tier-2 execution primitive this domain calls into.
- **Build a real weather-provider integration now** — rejected: no live external providers per project rules until credentials exist on the runtime; ship the mocked `EffectExecutor` binding first (S2), swap the binding later.
- **Block all implementation until IRO-45 and a workforce lane land** — rejected: both are designed around via ports (§3), unblocking S1–S8 immediately; blocking on either would stall the entire domain on lanes this squad doesn't own.
- **Give the agent authority to move a customer-promised date autonomously** — rejected outright by the acceptance criteria ("customer/legal commitments require their actor") and by `AUTHORITY-AND-EVIDENCE-CONTRACT.md`'s human/agent boundary; not even offered as a policy-envelope option in §6.

---

### 12. Open questions for the product owner

1. **Work-centre / weather-threshold config location** — should `WorkCentre` definitions and weather-threshold policy (e.g. "no metal roofing above 25mph wind") live in a general JSON policy table (industry-agnostic, config-driven per tenant) or a Frappe DocType scoped to the roofing vertical? This is a genuine core-vs-module boundary call flagged per Agent Identity rule 6a — either costs about the same to build, and the answer affects how cleanly a future non-roofing vertical (siding, windows) can supply its own centres/thresholds without touching core code.
2. **IRO-46 vs IRO-54** — Linear lists IRO-46 ("shop work centres") as a blocker, but the merged commit trail matching that scope is tagged IRO-54 ("fleet, equipment, driver, cargo, and maintenance operations"). Confirm whether IRO-46 was relabeled/superseded by IRO-54, or whether IRO-46 covers a distinct shop-work-centre scope that's still genuinely unbuilt (in which case §4.2's new `WorkCentre` entity is this spec's answer to it, not a separate blocker).
3. **IRO-39 status** — reads as an audit/review deliverable ("audit the exact integration head against every Gate 0-6 capability"), not a code dependency. Confirming it's non-blocking for implementation start would remove one line from IRO-50's blocked-by graph.
4. **Tier-1 policy envelope magnitude** — how many hours/crew-days may a routine autonomous replan move before it must escalate to Tier 2? No existing precedent gives a default (the money lane's ceiling is a dollar amount, not a time/scope measure) — needs a PO-set starting value, expected to start conservative and loosen with proven reliability.
5. **IRO-45 (PR #60) staleness/migration collision** — flagged for whoever owns that lane, not scheduling: it's CI-green but 17 commits behind `main` and its `0046_inventory_control.sql` collides in number with main's `0046_fleet_asset_actions.sql`; it will need renumbering (above 0072 per this spec's reservations) on rebase. Not scheduling's problem to fix, but noted here since S3 depends on it eventually landing cleanly.
