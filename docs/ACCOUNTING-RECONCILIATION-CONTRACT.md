# Accounting Reconciliation Contract (IRO-52)

Status: historical implementation/design snapshot, restored 2026-09-02; non-authoritative for
current capability, migration numbering, configuration, or delivery status.
Owner: IronWrap OS product owner
Snapshot verified: 2026-08-20 against the commits and branches named below.
Restored: 2026-09-02 (ELEC-270) from git history at `1b821b2^`, byte-identical below this header.
Review trigger: any change to the accounting intent, readback, reconciliation, exception or
compensation modules under `workers-bus/src/accounting-*.ts`, or an owner decision under DEC-003.

This file was deleted on 2026-08-22 (#148, "retire superseded markdown snapshots") while
`workers-bus/src/accounting-*.ts`, `workers-bus/test/accounting-*.ts` and `app/src/accounting/*`
kept citing it by section number. It is restored so that those citations resolve to the text the
code was written against. The section numbers are therefore frozen: amend a section in place, never
renumber. The sections the code cites are 3.1, 4.1, 4.2, 5.1, 5.2, 5.4, 6, 8.1, 8.2, 9, 11 and 12.

This file is preserved for reconciliation invariants, design rationale, and rejected alternatives.
Sections 0, 2, 3 (except 3.1), 5.5, 7 and 10 describe the repository as it was on 2026-08-20 and
have been overtaken by later native accounting and final-invoice work. Current authority,
implementation reachability, configuration, and proof state live in
[`AI-NATIVE-ARCHITECTURE.md`](./AI-NATIVE-ARCHITECTURE.md),
[`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](./AUTHORITY-AND-EVIDENCE-CONTRACT.md) and
[`CAPABILITY-MATRIX.md`](./CAPABILITY-MATRIX.md). Nothing in this snapshot is evidence of deployment,
runtime operation, technical-reference completion, business acceptance, or customer validation.

## 0. Implementation status

Repository facts as of 2026-08-20, on `main` plus the S4+S5 branch. Source-green only: nothing here
is deployed, runtime-verified, or business-accepted, and slice S12 remains the only route to those.

S4 and S5 add no migration. Section 7.1 reserves the next free numbers for S6 and S7, and neither
slice needs a table: a reversal is an ordinary `accounting_intents` row carrying
`compensates_intent_id` and `compensates_effect_id`, and a compensation plan is the remedy set
`0061` already stores on the exception.

| Slice | State | Where |
|---|---|---|
| S0 | **Implemented** | `workers-bus/src/accounting-effect-port.ts`, `workers-bus/src/quickbooks-auth-port.ts`, `workers-bus/test/accounting-port-fixture.ts` |
| S1 | **Implemented** | `workers-bus/migrations/0058_accounting_money_intents.sql`, `workers-bus/src/accounting-intents.ts` |
| S2 | **Implemented** | `workers-bus/migrations/0059_tax_policy_snapshots.sql`, `workers-bus/src/accounting-tax-snapshots.ts` |
| S3 | **Implemented** | `workers-bus/migrations/0060_accounting_provider_observations.sql`, `workers-bus/migrations/0061_accounting_exceptions.sql`, `workers-bus/src/accounting-normalizers.ts`, `workers-bus/src/accounting-reconciliation.ts`, `workers-bus/src/accounting-exceptions.ts`, `workers-bus/src/accounting-provider-read.ts` |
| S4 | **Implemented** | `workers-bus/src/accounting-submission.ts`, `workers-bus/src/accounting-payments.ts` |
| S5 | **Implemented** | `workers-bus/src/accounting-compensation.ts` |
| S8a | **Implemented** | `workers-bus/src/accounting-dispatch.ts`, `workers-bus/src/accounting-expectations.ts`, `workers-bus/src/accounting-compensation-authorizations.ts`, `workers-bus/migrations/0063_accounting_dispatch_evidence.sql` |
| S11 | **Implemented** | `workers-bus/src/accounting-reobservation.ts`, the bound sweep in `workers-bus/src/index.ts`, the re-reading `reconcile` route and `POST /tax/snapshots` in `workers-bus/src/accounting-api.ts` |
| S6, S7, S10, S12 | Target | — |

**S11 — the re-observation rail (ELEC-81).** S8a made an approved intent reach the provider, and
ELEC-77 proved on the running stack that nothing carried it any further: `ingestObservedPayment` had
zero callers in `src/`, `runAccountingSweeps` ran with no bound reader, and `reconcile` on the BFF
was a state-trigger flip that compared nothing. A genuinely dispatched, fully-matching invoice
therefore stopped at `partially_settled` for good — `reconciled` was unreachable in the shipped
product — and the reconciliation-drift exception could not be raised at all, so ELEC-75's hardening
of exception resolution had never been exercised end to end. `accounting-reobservation.ts` is the
caller that was missing, shared by the accountant's `reconcile` route and the cron's due-observation
sweep so the two cannot drift: read the entity by its exact id, observe each Payment that entity
declares, judge once. Unbound stays a first-class state in both.

S11 adds no migration. The original plan called it "a small binding PR gated on #46 and #43"; both
merged, and what was left was not a binding but the missing caller described above.

**S8a — the dispatcher (ELEC-72).** S1–S5 built the money engine and S8 built the routes, and
nothing joined them: `submitAccountingIntent` had no production caller, `deriveCompensationIntent`
and `submitAccountingCompensation` had none at all, and every approved intent stopped at
`submission_pending` for good. ELEC-71 proved that on the running stack. `accounting-dispatch.ts`
is the caller, on the frequent cron beside the sweeps, with its provider binding injected so an
unbound Worker reports what is waiting and dispatches nothing. Binding a real provider adapter to
it remains S11.

Five deviations from this document, all deliberate and each argued at the point it occurs:

1. **Migration numbers.** Section 7.1's reserved block was chosen on 2026-08-18 against the heads in
   flight then, and `main` has since shipped through `0057`. The real mapping is in section 7.1.
2. **The exception uniqueness key.** Section 7.1 specifies
   `UNIQUE (tenant_id, subject_ref, reason_code, status)`. Taken literally with three statuses that
   key makes the *second* occurrence of a recurring exception impossible to resolve, so
   `0061_accounting_exceptions.sql` enforces the dedupe the contract wants — one **live** exception
   per subject and reason — with a partial unique index. The reasoning is recorded in the migration
   header.
3. **Two extra state badges.** Section 8.2 names six badges. `accounting_intents` also holds
   `rejected` and `failed`, so `accounting-desk.ts` declares `rejected` and `failed` alongside the
   six. A screen that could not render a state its own aggregate holds would have to hide or
   mislabel those intents, and both are worse than naming them. `test/accounting-desk.test.ts`
   asserts every state in `ACCOUNTING_INTENT_STATES` maps to a declared badge, so the two cannot
   drift apart.
4. **Six routes are served, gated, and answer `501`.** Section 8.1's holdback and payroll routes
   belong to slices S6 and S7, which have not shipped. `accounting-api.ts` serves all six,
   enforces the permission each row names, and then answers `501` with the slice named. A 404
   would be indistinguishable from a typo and a stub that pretended to work would be worse than
   either; the gate is real today, so the slice that lands behind it inherits a tested boundary.
5. **The third cron sweep is exception ageing, not the holdback lien period.** Section 8.1's third
   sweep needs the S6 holdback ledger. Its place is taken by the ageing sweep the desk's queue
   needs; the lien-period sweep lands with S6. A fourth sweep was added by ELEC-72:
   `sweepStuckAccountingDispatches` surfaces an intent that has stopped moving in
   `submission_pending` or `compensating`. Those two states are deliberately **not** added to
   `OBSERVED_STATES` — that list means "expected to have a current provider observation", and an
   intent with no provider entity id yet has nothing to re-read by exact id.
6. **An eighteenth route: `POST /api/v1/accounting/intents`.** Section 8.1's table has no create
   row, because an intent is derived from local facts rather than typed in. But nothing outside a
   test could derive one either, so no journey in the shipped product could start (ELEC-71,
   journey 1). The route is a *derivation* request — the caller names the job, the customer and the
   figures, and the engine computes the payload, the expectation, the tax binding and the hashes —
   gated on `accounting:review`, because section 6 says derivation is not a side effect and the
   approval is still the gate. It reaches no provider and lands in `pending_review` like any other
   candidate. Deriving deposit and progress invoices from the job/quote domain automatically
   remains the better long-term origin and is not built here.
7. **The provider `Id` is not hashed for an entity IronWrap creates.** Section 5.2 puts `Id` inside
   the comparison fact set, and Intuit assigns it — so an intent for an entity IronWrap is about to
   create could never bind a reconcilable `expected_sha256` at derivation, and `0058`'s own CHECK
   (`reconciled` requires `observed_sha256 = expected_sha256`, and `expected_sha256` is immutable)
   closes the other exit. Such an intent therefore binds an **identity-free** expectation
   (`localFactEnvelope`) and its observations are hashed on the same basis
   (`accounting-expectations.ts`, `omits_identity`). Identity is not thereby unchecked: section
   5.1's other half — provider identity equals the identity recorded on the settled effect attempt
   — is enforced directly by `accounting-reconciliation.ts` before any hash is compared. Hashing the
   id as well stated that check twice and made the create case impossible. An intent that bound a
   complete envelope, which is every intent derived before this, is compared exactly as before.
8. **An eighteenth and nineteenth origin, for the same reason as deviation 6.** Section 8.1's route
   table has no create row for a tax policy snapshot, and `recordTaxPolicySnapshot` (slice S2)
   accordingly had no production caller. That was not cosmetic: `deriveIntent` refuses with
   `tax_mapping_missing` when no current snapshot binds the jurisdiction and code it was given, so
   on a tenant nobody had hand-inserted a row for, **no money intent could be derived at all** and
   the whole lane was unreachable from zero. `POST /api/v1/accounting/tax/snapshots` is that origin,
   gated on `accounting:review` like the derive route, recording a statutory rate with the citation
   it was read from. It is a policy command, not a money one: it reaches no provider, creates no
   entity, moves no intent, and cannot touch a snapshot that already exists. Its `Idempotency-Key`
   is enforced by the facts hash rather than by a receipts table, and the difference from
   deviation 6's derivation receipts is argued at the handler: two different rates are two
   legitimately different snapshots, so one key standing for two bodies causes no harm here.
   Separately, `reconcile` is no longer only a trigger — see deviation 9.
9. **`reconcile` performs the re-read it names.** Before S11 the command wrote a receipt, the D1
   trigger moved the intent to `reconciliation_required`, and no code compared anything with the
   provider. Both halves are kept, because both are true: the receipt records that a named
   accountant asked for a re-read, and the authenticated re-read that immediately follows is what
   section 5.1 admits as the only route to a settled state. A tenant with no connected realm still
   gets the receipt and an explicit `re_read.status = "provider_unbound"` at `202` rather than a
   verdict nobody checked. Two consequences elsewhere follow from the receipt landing first, and
   both are recorded at their code: provider drift is judged by `provider_reconciled_at` rather than
   by the current state (the receipt has already moved it), and an exception now carries the hash
   **this** read produced rather than the one the intent still held.
10. **Two remedies refuse rather than accept an unverifiable claim.** `resolveAccountingException`
   now looks a claimed `compensating_effect_id` up against `accounting_intents.effect_id` — the
   only place a dispatched money effect is ever recorded — and refuses a reference that is not a
   real, settled, matching reversal of that exception's own intent. `void_provider_entity` and
   `adjusting_entry_posted` have no dispatch path in any shipped slice, so no ledger evidence for
   them can exist; they refuse with `accounting_exception_remedy_dispatch_unavailable` until one
   does. Before this, presence of any 8–160 character string closed any exception, and ELEC-71
   closed a real $240 overpayment on the live UI with an invented reference.

## 1. Requirement

Complete the IronWrap money lane so that invoice, payment, deposit, credit/refund, holdback and its
release, tax, and payroll all: bind exact local commercial and time facts; execute every provider
mutation through the one canonical external-effect runtime with idempotency and post-write
authenticated readback; treat webhooks as raw evidence only; expose an explicit accountant
exception and approval policy; surface pending, uncertain, mismatched, compensated and reconciled
states to a roofing office manager with a safe recovery path; and roll back only through
provider-supported void/credit/correction, never local deletion.

Source: Linear IRO-52 (Urgent, blocked by IRO-38/IRO-39/IRO-48/IRO-53, blocking IRO-30/IRO-31/IRO-58).

## 2. Current state

### 2.1 What exists on `main`

**Implemented — inbound webhook and outbound final-invoice, source-green only.** As of 2026-08-20
(`c59fad4536e33fe6a885bda9c6be8e45b69f1ff6`), `main` is not inbound-only. Nothing below is Deployed,
Runtime-verified, or Business-accepted. A live QuickBooks post is flag-gated and off.

**Inbound webhook** (raw evidence, not posted truth):

- `workers-bus/src/index.ts` routes `POST /webhook/quickbooks`.
- `workers-bus/src/quickbooks.ts` accepts four entity types (`Invoice`, `Payment`, `CreditMemo`,
  `RefundReceipt`). A webhook "must never be used to infer paid, posted, reconciled, or amount facts".
- Every successful response reports `provider_truth_reconciled: false`.
- `workers-bus/migrations/0031_quickbooks_projection_outbox.sql` is a durable, leased, retryable
  per-entity projection outbox into Frappe. It projects *that an event was seen*, not *what is true*.
- Frappe holds the mirrors: `Payment Milestone` with `milestone_type` in
  `Invoice | Payment | Credit | Refund | Other` and `status` in
  `Webhook Seen | Needs Review | Matched | Ignored`, and `Integration Reconciliation` with
  `Pending | Matched | Mismatch | Resolved | Ignored | Superseded`.
  `frappe-apps/ironwrap_roofing/ironwrap_roofing/quickbooks_reconciliation_api.py` is the bounded
  issuer that writes them.

**Outbound final-invoice is on `main`.** The 2026-08-18 sentence "There is no outbound QuickBooks
write path on `main` at all" is false.

- `workers-bus/src/quickbooks-final-invoice.ts` — OAuth connect/disconnect, candidate discover,
  approve/reject, authenticated readback, Frappe bind. Submit goes through `runExternalEffect`.
- `workers-bus/migrations/0041_quickbooks_final_invoice.sql` — `quickbooks_connections`,
  final-invoice intents, observations, outbox, and command receipts.
- PWA: `app/src/accounting/quickbooks-page.tsx` (`/accounting/quickbooks` and final-invoice review).
- `workers-bus/src/effect-runtime.ts` and `workers-bus/migrations/0042_external_effect_runtime.sql`
  are on `main`. There is an external-effect ledger.

**What still blocks a live post** is committed Worker vars, not a missing module:

- `QB_OAUTH_ENABLED` and `QB_FINAL_INVOICE_ENABLED` are `"false"` in production, local, and staging
  (`workers-bus/wrangler.jsonc`).
- Production vars set `QB_API_ENVIRONMENT` to `production` with empty `QB_EXPECTED_REALM_ID`. Local
  and staging use `sandbox`.
- Discover is a no-op while the final-invoice flag is off. Approve stays a human click after a flag
  flip and a connected realm. This contract does not authorize that flip.

**IRO-52 money aggregate on `main`:** PR #65 (S0+S1) merged 2026-08-19.
`workers-bus/src/accounting-effect-port.ts`, `workers-bus/src/quickbooks-auth-port.ts`,
`workers-bus/src/accounting-intents.ts`, and `workers-bus/migrations/0058_accounting_money_intents.sql`
are on `main`. Later S2–S5 / S8a / S11 files are also on the tree; see §0. That is source presence,
not a live reconciliation run.

**Holdback** remains Target (S6). S6/S7/S10/S12 stay Target per §0. `docs/CAPABILITY-MATRIX.md` may
still score Finance as *Partial*; treat that score as a claim to re-verify, not as proof that
outbound code is absent.

### 2.2 What exists only on unmerged heads

> Stale as of 2026-08-20. The artefacts in the table below are on `main`. See §2.1. The table is
> kept as the 2026-08-18 branch snapshot so the later slices can see what they reused.

The IRO-52 Linear description says final-invoice OAuth/create/readback "is implemented and
source-green". That is now true of `main` as well (flags off; see §2.1). The 2026-08-18 table:

| Artefact | Where it lives | On `main`? |
|---|---|---|
| `workers-bus/src/effect-runtime.ts` (966 lines) | PR #46 `codex/iro-38-side-effect-runtime` | No |
| `workers-bus/migrations/0042_external_effect_runtime.sql` | PR #46, #48, #49, #52 | No |
| `workers-bus/migrations/0054_external_effect_envelope_authority.sql` | PR #46 | No |
| `workers-bus/src/quickbooks-final-invoice.ts` (3242 lines) | PR #46 (also #43/#47/#52) | No |
| `workers-bus/migrations/0041_quickbooks_final_invoice.sql` | PR #43, #46, #47, #48, #49, #50, #51, #52 | No |
| `app/src/accounting/quickbooks-page.tsx` + `/accounting/quickbooks` route | PR #43, #52 | No |
| `access_role = 'accounting'` (`0038_app_access_roles.sql`) | PR #43 and successors | No |
| `quickbooks:read` / `quickbooks:review` / `quickbooks:reconcile` permissions | PR #46 `workers-bus/src/app-types.ts:196` | No |
| `PayrollAccountingAdapter` interface, no implementation | PR #55 `workers-bus/src/payroll-preparation-effects.ts:49` | No |

The pieces IRO-52 must reuse rather than reinvent, all on PR #46:

- `runExternalEffect` (`workers-bus/src/effect-runtime.ts:263`) — propose → authorize → execute → settle,
  keyed on `UNIQUE (tenant_id, idempotency_key)` with an immutable envelope hash.
- `EffectAuthority` (`:14`) already carries `amount` / `maxAmount`, and authorization rejects a
  money ceiling breach with `effect_policy_amount_ceiling_exceeded` (`:394`). Money policy ceilings
  are a solved problem; IRO-52 must not build a second one.
- `effect_unknown_requires_reconciliation` (`:284`) — an `unknown` provider outcome can never be
  retried, only reconciled. This is the lost-response rule IRO-52 needs.
- The twelve-state ledger and its transition trigger in `0042_external_effect_runtime.sql`
  (`proposed → authorized → executing → reconciling → succeeded/failed/unknown → reconciled →
  retry/compensating → compensated | manual_exception`), append-only events, and an
  `external_effect_exceptions` table with `UNIQUE (effect_id, reason_code, status)`.
- The final-invoice control plane in `0041_quickbooks_final_invoice.sql` — encrypted OAuth bundle in
  `quickbooks_connections` with a partial unique index enforcing one active connection per tenant,
  an intents table whose state may only reach `matched` through an exact-id readback, plus
  observations, attempts, outbox, and command receipts.
- The injected-`fetch` convention: the final-invoice module takes `fetcher: typeof fetch = fetch`
  (`workers-bus/src/quickbooks-final-invoice.ts:475`, `:688`, `:788`). Provider mocking is already
  a parameter, not a global patch.
- `workers-bus/test/effect-runtime-fixture.ts:41` runs the real migration SQL in an in-memory
  `node:sqlite` database behind a D1-shaped facade. IRO-52's tests extend this, they do not fork it.

### 2.3 Reconciled against the canonical contracts

- `docs/AUTONOMOUS-OPERATING-SYSTEM.md:730` — "QuickBooks: posted accounting truth".
- `docs/AUTONOMOUS-OPERATING-SYSTEM.md:517` — operational records "must reconcile to it; agents do
  not invent accounting truth".
- `docs/AUTONOMOUS-OPERATING-SYSTEM.md:655` — the Finance and tax agent's hard boundary is
  "accounting provider remains posted truth".
- `docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md:79` — every provider mutation here is authority level
  `commit_external`.
- `docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md:130` — an agent may not infer completion from "a message,
  calendar entry, payment screenshot, uploaded file, or another system's mutable status alone".
- `docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md:141` — the `financial` evidence class requires source
  system, amount/currency, entity, and immutable external ID.
- `docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md:221` — the side-effect contract: exact normalized intent,
  authority and policy proof, idempotency key, request/response fingerprint without secrets, timeout
  and duplicate and ambiguous-result behaviour, compensation or human recovery path, reconciliation
  against the provider's authoritative state.

## 3. The #46 dependency — verdict

**IRO-52 has a hard dependency and cannot ship against the effect surface that exists on `main`
today.** The dependency is on two unmerged artefacts, not one:

1. **The effect runtime (PR #46 / IRO-38).** IRO-52's acceptance requires that "every provider
   mutation uses the canonical effect runtime, idempotency and post-write provider detail readback".
   That runtime does not exist on `main`. Project rule "one external side-effect runtime" forbids
   building a second one.
2. **The QuickBooks connection and token plane (`0041_quickbooks_final_invoice.sql` + the OAuth half
   of `quickbooks-final-invoice.ts`, on PR #43/#46/#47/#52).** Without it there is no realm, no
   access token, and therefore no authenticated provider-detail read — the single mechanism this
   contract uses to define "reconciled".

Both live inside the #43–#52 human carve-out that this squad may not merge, and #46 is entangled in
the IRO-62 0042-migration reconciliation. **Do not assume either lands.**

### 3.1 The seam that lets implementation start anyway

Implementation is *not* blocked. Every IRO-52 module depends on two narrow ports, never on
`effect-runtime.ts` or `quickbooks-final-invoice.ts` directly.

```ts
// workers-bus/src/accounting-effect-port.ts — the ONLY money-side dependency on #46.
// Field-for-field compatible with effect-runtime.ts so the production adapter is a pass-through.
export interface MoneyEffectRequest {
  tenantId: string;
  actor: { type: "agent" | "worker" | "customer" | "external_authority" | "device" | "owner"; id: string };
  taskId: string;
  authority: { permitRef: string; policyRef: string; policyVersion: string; expiresAt: string;
               allowedActions: readonly string[]; amount?: number; maxAmount?: number };
  aggregate: { type: string; id: string; version: number };
  intentId: string;
  action: string;              // e.g. "quickbooks.payment.create"
  request: unknown;            // normalized provider intent; hashed by the runtime
  provider: "quickbooks";
  providerAccountRef: string | null;   // realmId
  idempotencyKey: string;      // business key, stable across retries
  deadlineAt: string;
  preconditions?: unknown;
  evidenceRefs?: readonly string[];
  expectedReadback?: unknown;  // the normalized fact set we expect to read back
  retryLimit?: number;
  compensationPlan?: unknown;  // provider-supported reversal only
  correlationId: string;
}

export interface MoneyEffectExecutor<T> {
  preconditions?(i: { effectId: string }): Promise<{ ok: boolean; detailCode?: string }>;
  dispatch(i: { effectId: string; attemptId: string; businessIdempotencyKey: string }): Promise<MoneyDispatchResult<T>>;
  readback(i: { effectId: string; providerExternalId: string | null }): Promise<MoneyReadback>;
  replay(i: { effectId: string }): Promise<T>;
}

export interface MoneyEffectPort {
  assertReady(): void;
  run<T>(input: MoneyEffectRequest, executor: MoneyEffectExecutor<T>): Promise<MoneyEffectOutcome<T>>;
}

// workers-bus/src/quickbooks-auth-port.ts — the ONLY dependency on 0041's connection plane.
export interface QuickBooksAuthPort {
  /** Resolve the single active connection for a tenant, refreshing under lease if needed. */
  activeRealm(tenantId: string): Promise<{ realmId: string; accessToken: string; apiBase: string;
                                           minorVersion: string; connectionId: string }>;
}
```

Two bindings exist for each port:

- **Test binding** (`workers-bus/test/accounting-port-fixture.ts`): an in-memory ledger implementing
  the same twelve states and the same `UNIQUE (tenantId, idempotencyKey)` rule, plus a fixed-token
  auth stub. Every scenario test in section 8 runs against this and is provable on `main` today.
- **Production binding** (`workers-bus/src/accounting-effect-runtime-binding.ts`, roughly 60 lines):
  delegates `run` to `runExternalEffect` and `assertReady` to `assertEffectLedgerReady`, and
  `activeRealm` to the `quickbooks_connections` reader. **This file is the only thing that waits for
  #46 and #43.** It is slice S11 and nothing else depends on it.

Three rules make the seam safe:

1. **IRO-52 migrations must never declare `external_effects`, `external_effect_attempts`,
   `external_effect_events`, `external_effect_exceptions`, `quickbooks_oauth_states`,
   `quickbooks_connections`, `quickbooks_connection_events`, or any `quickbooks_final_invoice_*`
   table.** Re-creating them under a fresh number guarantees a collision the day #46 or #43 merges.
2. **No foreign key from an IRO-52 table into a 0041/0042 table.** Cross-plane references are TEXT
   columns with a documented invariant and a runtime check, so the new migrations apply on `main`
   unchanged. The one place this costs us — `accounting_intents.final_invoice_intent_id` — is
   validated in the reconciliation engine instead of by D1.
3. If the PO decides #46 will never land, the test binding is promoted to the production binding by
   moving one file. The port shape does not change, so no slice is rewritten.

**Consequence for planning:** slices S0–S10 are fully implementable and CI-provable against `main`.
Slice S11 is a small binding PR gated on #46 and #43. Slice S12 (sandbox + accountant acceptance) is
**Blocked** on credentials that project rule 5 forbids this squad from holding.

## 4. Domain model and system of record

### 4.1 The split

| Money aggregate | System of record | IronWrap's role |
|---|---|---|
| Invoice (final balance) | QuickBooks | Owns the commercial basis + the intent; already modelled on PR #43 |
| Invoice (deposit, progress) | QuickBooks | Owns the basis + the intent (new in IRO-52) |
| Payment | QuickBooks | Observes by default; creates only for payments IronWrap itself captured — see open question 4 |
| Credit memo / refund | QuickBooks | Owns the intent and its authority; the posting is the provider's |
| **Holdback** | **IronWrap** | **Sole system of record — QuickBooks has no holdback entity** |
| Tax liability | QuickBooks | Owns the bound rate snapshot per intent; reconciles our snapshot against QB's TaxCode |
| Tax filing / remittance | CRA, via the accountant | Out of scope — propose and reconcile only, never file |
| Payroll time facts | IronWrap (IRO-53) | `field_time_entry_actions`, PR #55 |
| Posted payroll | QuickBooks or an external payroll provider | Never posts payroll unilaterally; accountant approval is mandatory — see open question 2 |

Holdback is the one deliberate exception to "QuickBooks is posted accounting truth", and it is
flagged rather than smuggled. The justification: Alberta construction holdback is a *statutory
entitlement schedule* (a percentage withheld, a substantial-performance date, a lien period, a
release condition), and QuickBooks Online has no entity that carries any of those facts. If IronWrap
does not own them, they live nowhere. The **amounts** still become posted truth the moment they are
projected into QuickBooks as invoice lines and a release invoice; IronWrap is system of record only
for the **entitlement and the schedule**, never for the posted balance. Section 6 records the
authority for a release accordingly.

### 4.2 Aggregates IronWrap owns

`accounting_intent` — one aggregate covering the six new money intent kinds
(`deposit_invoice`, `progress_invoice`, `payment`, `credit_memo`, `refund`, `holdback_release`,
`tax_remittance_proposal`, `payroll_journal`). It carries: tenant, roof job, the exact local basis
(`basis_sha256` over the bound commercial facts, plus the source document ids and versions), the
bound tax snapshot, the normalized provider payload and its hash, a `provider_request_id` for
Intuit's `requestid` de-duplication, the state, an integer `version` for optimistic concurrency, the
authority and command receipts, and the provider identity once known. It deliberately mirrors
`quickbooks_final_invoice_intents` rather than inventing a second shape.

`holdback_ledger` — per roof job: contract value, approved change-order delta, statutory percentage
and its policy version, computed entitlement, amount withheld to date, amount released to date,
substantial-performance date, lien-period expiry, and release state. Append-only `holdback_events`
record every basis change with the evidence that caused it.

`accounting_observation` — an authenticated provider-detail snapshot: realm, entity type, entity id,
the normalized comparison fact set, `observed_sha256`, `read_at`, and the effect attempt that
produced it. Immutable. A later read creates a new observation that supersedes; it never overwrites.

`accounting_reconciliation` — the verdict binding one intent to one observation:
`expected_sha256`, `observed_sha256`, `verdict`, `reason_code`, and the resolving authority.

`accounting_exception` — the accountant queue: reason code, the two hashes, status
`open | acknowledged | resolved`, the resolution action, and the compensating effect id if one was
raised.

`tax_policy_snapshot` — jurisdiction, tax code, rate, effective window, source reference,
`snapshot_sha256`, and version. Immutable; a rate change creates a new snapshot.

`payroll_posting_intent` — the receiving half of IRO-53's handoff: payroll run, period, the artifact
hash IRO-53 already computes, line count, total, the accountant approval, the posting target, and
the reconciliation state.

## 5. Reconciliation semantics

### 5.1 What "reconciled" means

> An IronWrap money intent is **reconciled** when, after the provider mutation, an authenticated
> provider-detail read of the exact provider entity id returns a normalized comparison fact set
> whose SHA-256 equals the `expected_sha256` computed from the intent's bound local facts, and whose
> provider identity (`realmId`, entity type, entity id) equals the identity recorded on the settled
> effect attempt.

Three things must agree: the **local basis** (what we said should be true), the **effect ledger**
(what we asked the provider to do), and the **provider detail** (what the provider says exists). Two
out of three is not reconciled.

Three rules follow, and they are non-negotiable:

- **A webhook is a trigger, never evidence.** Receiving a QuickBooks webhook enqueues an
  authenticated re-read of the named entity. It may not change any money state by itself. This is
  already the implemented posture (`workers-bus/src/quickbooks.ts:5`) and IRO-52 must not weaken it.
- **Only a readback can reach a settled state.** `submitted` means the provider acknowledged;
  `reconciled` means we re-read and matched. A lost acknowledgement produces `unknown`, and
  `unknown` may only be resolved by querying the provider on the business idempotency key — the
  runtime already forbids retrying it (`workers-bus/src/effect-runtime.ts:284`).
- **Never adjust local truth to match the provider.** A difference is an exception, not a
  correction. `docs/AUTONOMOUS-OPERATING-SYSTEM.md:517`.

### 5.2 Normalized comparison fact sets

Per kind, the exact fields hashed. Anything not listed is ignored, so provider metadata churn
(`SyncToken`, `MetaData.LastUpdatedTime`, display names) never manufactures a false mismatch.

| Kind | Comparison fields |
|---|---|
| Invoice | `realmId`, `Id`, `CustomerRef.value`, `CurrencyRef.value`, `TxnDate`, `DueDate`, `TotalAmt`, `TxnTaxDetail.TotalTax`, `Line[].{DetailType,Amount,ItemRef.value,TaxCodeRef.value}` |
| Payment | `realmId`, `Id`, `CustomerRef.value`, `CurrencyRef.value`, `TxnDate`, `TotalAmt`, `Line[].LinkedTxn[].{TxnId,TxnType}`, `Line[].Amount`, `UnappliedAmt` |
| CreditMemo | as Invoice, plus `RemainingCredit` |
| RefundReceipt | `realmId`, `Id`, `CustomerRef.value`, `TxnDate`, `TotalAmt`, `DepositToAccountRef.value`, `Line[].Amount` |
| JournalEntry (payroll, holdback) | `realmId`, `Id`, `TxnDate`, `Line[].{Amount,JournalEntryLineDetail.PostingType,AccountRef.value}` |
| TimeActivity (payroll) | `realmId`, `Id`, `EmployeeRef.value`, `TxnDate`, `Hours`, `Minutes`, `CustomerRef.value` |
| TaxCode / TaxRate | `realmId`, `Id`, `RateValue`, `EffectiveTaxRate[].{RateValue,EffectiveDate,EndDate}` |

`expected_sha256` is computed with the same canonical JSON helper the effect runtime already uses,
so hashing is not re-implemented.

### 5.3 Verdicts

| Verdict | Condition | Terminal? |
|---|---|---|
| `reconciled` | hashes equal, identity matches | Yes, until a drift re-read says otherwise |
| `partially_settled` | cumulative settlement invariant holds, target not yet met | No — legitimate waiting state |
| `mismatch` | hashes differ, identity matches | No — opens an exception |
| `identity_conflict` | provider entity id does not match the settled attempt | No — opens an exception, blocks compensation |
| `not_found` | authenticated read returns 404 for an id we recorded | No — opens an exception |
| `unavailable` | provider unreachable or 5xx | No — retryable, never a verdict of record |

### 5.4 Required failure cases

**Duplicate create.** Every mutation carries Intuit's `requestid` (bound to
`provider_request_id`, unique per `(realm_id, provider_request_id)` in D1) and the runtime's business
idempotency key (`UNIQUE (tenant_id, idempotency_key)`). A retried dispatch with an identical
envelope replays the stored provider entity rather than creating a second one; an envelope that
differs is rejected as `effect_idempotency_conflict`. A second entity created despite this (provider
duplicate-document-number error 6240, or a duplicate observed at readback) is an
`duplicate_provider_entity` exception, never an auto-delete.

**Duplicate payment.** Two provider Payments link the same Invoice. Detected by the invariant
`sum(linked payment amounts for invoice) <= invoice TotalAmt at intent time`, re-evaluated on every
observation. The system opens `duplicate_provider_payment`, marks the intent `mismatch`, and offers
the accountant exactly two provider-supported remedies: void the surplus Payment, or issue a
CreditMemo/RefundReceipt for it. The system proposes; the accountant authorizes; the remedy runs as
a compensating effect with `compensates_effect_id` set. No database row is ever deleted.

**Partial payment.** Observed total < expected and the invoice `Balance > 0`. This is
`partially_settled`, not a mismatch. The reconciliation target for an invoice is the cumulative
invariant `sum(observed settlements) + Balance == TotalAmt`, evaluated across all observations, not
a single-shot equality. An invoice reaches `reconciled` only when `Balance == 0` and the cumulative
invariant holds. Over-payment (`sum > TotalAmt`) is a mismatch, not a partial.

**Refund after holdback release.** Holdback entitlement is derived from contract value net of
approved change orders, never from cash received. A refund therefore emits a
`holdback_basis_changed` event and forces recomputation of entitlement. If
`amount_released > recomputed entitlement`, the system opens `holdback_over_released`, blocks any
further release for that job, and routes to the accountant with both figures and the refund
evidence. The system does not net, claw back, or auto-adjust — recovery from the customer versus
write-off is an owner decision under section 6.

**Tax rate change mid-project.** Each intent binds `tax_policy_snapshot_sha256` at derivation time
and the snapshot is immutable. A rate change creates a new snapshot; already-submitted intents keep
theirs (that is what was posted, and it is correct). Un-submitted intents whose snapshot is no
longer current get the `candidate_changed` blocker and must be re-derived and re-approved before
submission — reusing PR #43's existing blocker vocabulary rather than inventing one. Separately,
every submission preflight reads QuickBooks' `TaxCode`/`TaxRate` for the bound code; if the
provider's rate differs from the snapshot the intent is blocked with `tax_rate_drift` and an
exception is opened. The local snapshot is never silently rewritten to match QuickBooks.

**Lost response.** Dispatch times out or the connection drops after the provider committed. The
effect settles `unknown`. Retry is forbidden. Recovery is a provider *query* by `requestid` (Intuit
returns the original entity for a repeated `requestid` within its dedupe window) or by a bounded
entity search on the intent's identity. Finding it transitions `unknown → succeeded → reconciled`;
not finding it after the deadline transitions `unknown → manual_exception` for accountant decision.

**Provider drift.** A previously reconciled entity re-read (on webhook trigger or scheduled sweep)
whose `observed_sha256` no longer matches. The new observation supersedes, the intent moves to
`reconciliation_required`, and a `provider_readback_drift` exception opens. Someone changed a posted
transaction in QuickBooks; that is an accounting event, not a bug to paper over.

**Payroll correction.** A corrected payroll artifact from IRO-53 has a different `artifact_hash` and
is therefore a different effect (PR #55 states this rule for its own side). The prior posting is not
edited: the correction posts as a provider-supported adjusting entry linked to the original via
`compensates_effect_id`, and both remain visible. Reconciliation compares the *net* of the original
and its adjustments against the corrected artifact.

### 5.5 Which of these are implemented, and where

**Implemented** — each row names the code that enforces the rule and the test that executes it.
Every test runs the real 0058–0061 SQL in `node:sqlite`, so the D1 CHECKs and triggers execute
rather than being described.

| Failure case | Enforced by | Test |
|---|---|---|
| Duplicate create (duplicate observed at readback) | `accounting-reconciliation.ts` → `duplicate_provider_entity` | `test/accounting-reconciliation.test.ts` "a duplicate provider entity observed at readback is an exception, never an auto-delete" |
| Duplicate payment | `invoiceSettlement` + `duplicate_provider_payment`, two remedies | "two payments against one invoice are `duplicate_provider_payment` with exactly two remedies" |
| Partial payment | cumulative invariant, `partially_settled` | "partial payment is `partially_settled` with no exception, and the cumulative invariant holds" |
| Full settlement after partial | `Balance == 0` gate | "full settlement after a partial reaches `reconciled` only when the balance is zero" |
| Over-payment | `provider_overpayment`, a mismatch not a partial | "over-payment is a mismatch, not a partial" |
| Refund race | one invariant over recorded facts, order-independent | "a refund and a payment settling concurrently produce one deterministic verdict" |
| Tax snapshot stale at submission | `assessTaxSnapshotStaleness` → `candidate_changed` | `test/accounting-tax-snapshots.test.ts` "an un-submitted intent whose snapshot was superseded is stale; a submitted one never is" |
| Provider tax rate differs from snapshot | `detectTaxRateDrift` → `tax_rate_drift`, snapshot unchanged | "a provider rate that differs from the bound snapshot is drift, and the snapshot is untouched" |
| Tax rate change mid-project | the two rules together | "mid-project rate change: what was posted keeps its rate, what is still a candidate is re-derived" |
| Lost response | `resolveUncertainAccountingIntent`, retry never offered | "a lost response is resolved by finding the entity, never by retrying" |
| Lost response, entity never created | deadline → `unknown_effect_deadline_expired` | "a lost response whose entity never appears becomes the accountant's decision at the deadline" |
| Provider drift | new observation supersedes → `reconciliation_required` | "a previously reconciled entity that changed is drift: the new observation supersedes" |
| Provider drift, raised through a production surface | `accounting-reobservation.ts` → the `reconcile` route and the bound sweep | `test/accounting-reobservation.test.ts` "a re-observation that disagrees raises the drift exception through the production path" |
| Identity conflict | `provider_identity_conflict`, compensation refused in both layers | "an entity id that is not the one we created is `identity_conflict`, and it blocks compensation" |

Slices S4 and S5 add the path that reaches those verdicts from a live dispatch rather than from a
hand-recorded observation, and the reversal path out of them. Each row names the code and the test
that executes it; every test runs the real 0058–0062 SQL and the real in-memory ledger.

| Behaviour | Enforced by | Test |
|---|---|---|
| Approved intent dispatches through the port, reaching `submitted` and no further | `accounting-submission.ts` → `submitAccountingIntent` | `test/accounting-submission.test.ts` "an approved deposit invoice dispatches once and reaches `submitted`, never `reconciled`" |
| Payments are observed, never created | `ACCOUNTING_PROVIDER_ACTIONS.payment = null` → `accounting_payment_observe_only` | "a payment intent refuses to dispatch: IronWrap observes Payments, it does not create them" |
| Tax remittance is proposed, never filed | `ACCOUNTING_PROVIDER_ACTIONS.tax_remittance_proposal = null` → `accounting_tax_remittance_propose_only` | same test |
| The ledger's expectation is the one the intent bound | `expected_sha256` re-checked before dispatch → `accounting_intent_expected_readback_mismatch` | "an expectation that is not the one the intent bound is refused before dispatch" |
| Duplicate create, and envelope changed on retry | port replay on the business idempotency key; `effect_idempotency_conflict` | "a retried dispatch with the same envelope replays; a changed one is an idempotency conflict" |
| Tax preflight blocks a submission before the ledger sees it | `preflightAccountingIntentTax` in the dispatch path | "a stale tax snapshot blocks the submission, and nothing reaches the ledger" |
| Payment ingest re-reads the invoice it settles | `accounting-payments.ts` → `ingestObservedPayment` | `test/accounting-payments.test.ts` "a partial payment settles the invoice partially, with no exception and the invariant holding" |
| Duplicate, partial and over-payment reached end to end | ingest → `reconcileAccountingIntent` | "two payments against one invoice are `duplicate_provider_payment`…", "the remainder after a partial reaches `reconciled` only once the balance is zero", "an over-sized single payment is `provider_overpayment`, a mismatch and not a partial" |
| A payment line split across two invoices is refused, not attributed | `linkedInvoiceIds` → `provider_payment_line_ambiguous` | "a payment line split across two invoices is refused rather than attributed by guess" |
| Compensation is proposed, never automatic | `accounting-compensation.ts` → `planAccountingCompensation` writes nothing | `test/accounting-compensation.test.ts` "a plan proposes exactly the surplus, and names the exception it answers" |
| Only a remedy the exception offered, and only a reversing one, may be planned | `offeredRemedies` → `accounting_compensation_remedy_not_offered` / `_not_reversal` | "a remedy the exception never offered, and one that is not a reversal, are both refused" |
| A reversal may not exceed what was posted | magnitude compare → `accounting_compensation_amount_exceeds_original` | "a reversal larger than what was posted is refused on magnitude, not on sign" |
| Money ceilings compare magnitudes, so a reversal cannot sign its way under one | `magnitudeCents` on every port authority; `abs()` in `deriveAccountingIntent` and in `0058`'s owner-authority trigger | `test/accounting-submission.test.ts` "the authority the port receives carries magnitudes…", "a reversal above the ceiling is refused on magnitude, at derivation and at the ledger" |
| A reversal that did not reach the provider closes nothing | `submitAccountingCompensation` resolves only on `submitted` | "a reversal that does not reach the provider leaves the exception open and the original uncompensated" |
| Refund race: refund intent and payment observation, either order | one invariant over recorded facts; the compensated original is reported, not reopened | "a refund and a payment observed in either order produce one deterministic outcome" |

Slice S8a adds the production path that reaches all of the above from an accountant's own actions,
and the check that stops an exception being closed on a reversal nobody performed.

| Behaviour | Enforced by | Test |
|---|---|---|
| An approved intent dispatches with no further human step | `accounting-dispatch.ts` → `runAccountingDispatch` on the frequent cron | `test/accounting-dispatch.test.ts` "journey 1: derive, approve, and the dispatcher carries it to reconciled with no human step" |
| A re-run neither re-dispatches nor moves anything | `submission_pending` is the queue, so a drained queue is empty | "the dispatcher is idempotent: a second run neither re-dispatches nor moves anything" |
| An unbound Worker dispatches nothing and hides nothing | the injected binding; `dispatcher_unbound` in the report | "an unbound dispatcher reports what is waiting and dispatches nothing" |
| An authorized compensation derives, approves and dispatches its reversal | `runAccountingCompensationDispatch` over `accounting_compensation_authorizations` | "journey 2: authorizing a compensation dispatches the reversal and closes the exception on it" |
| A claimed reversal that never happened closes nothing | `verifyCompensatingEffect` → `accounting_exception_compensating_effect_unknown` | "the fabricated-reference repro is refused: closing an exception now needs a real reversal" |
| A real reversal of a different intent closes nothing either | the same check, on `compensates_intent_id` | "a real reversal of a different intent does not close this exception" |
| A dispatch that stopped moving is surfaced rather than silent | `sweepStuckAccountingDispatches` | "an intent stuck in submission_pending is surfaced by the staleness sweep, and a re-run is a no-op" |

Slice S11 adds the surfaces that reach all of the above after the dispatch readback, and the origin
the lane needs before any of it can start.

| Behaviour | Enforced by | Test |
|---|---|---|
| An accountant's re-read reaches the provider and settles the verdict inside the request | `accounting-api.ts` `reconcile` → `reobserveAccountingIntent` | `test/accounting-reobservation.test.ts` "the reconcile route re-reads the provider and carries a paid invoice to reconciled" |
| A paid invoice reaches `reconciled` on the cron, with no human step | `index.ts` binds `accountingIntentReobserver` into `runAccountingSweeps` | "the due-observation sweep re-reads through the bound rail and reconciles what it finds" |
| An invoice's Payments are discovered from what the invoice itself declares, and observed by exact id | `linkedPaymentIds` → `ingestObservedPayment` | "linked payments are read from the invoice's own declaration, and only Payments" |
| A re-run inside the staleness window reads nothing and moves no version | the sweep's own due window | "the due-observation sweep re-reads through the bound rail and reconciles what it finds" |
| An unconnected tenant gets a receipt and an honest refusal, never an unchecked verdict | `resolveAccountingObservationBinding` → `null` | "an unbound tenant gets a receipt and an honest refusal, never an unchecked verdict" |
| An outage writes no observation, no verdict and no exception | `readProviderEntity` → `unavailable` short-circuit | "a provider outage writes nothing at all: not an observation, not a verdict, not an exception" |
| The $240 over-payment loop, raised by a production re-read and closed only by a real reversal | the rail → `verifyCompensatingEffect` | "the $240 over-payment loop: raised by a real re-observation, closed only by a real reversal" |
| A tenant with no recorded rate can record one, and only then derive | `POST /tax/snapshots` → `recordTaxPolicySnapshot` | `test/accounting-api.test.ts` "the money lane starts from zero: the statutory rate has a route, so a derivation can bind one" |

**Target, not implemented.** Refund after holdback release (`holdback_over_released`) waits on the
holdback ledger in S6, and payroll correction waits on S7 and PR #55. Their reason codes are already
declared by `0061_accounting_exceptions.sql` so neither slice has to edit a shipped migration.

## 6. Authority and evidence

Every provider mutation in this contract is authority level `commit_external`
(`docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md:79`) and every state change emits the canonical transition
envelope.

| Transition | Who may authorize | Policy ceiling | Required evidence |
|---|---|---|---|
| Derive an intent candidate | `agent` (finance) | none — derivation is not a side effect | source document ids + versions, `basis_sha256`, tax snapshot |
| Approve deposit/progress/final invoice | `accounting` or `owner` | per-intent `maxAmount` | approved quote or change order, completion packet where applicable |
| Record a payment IronWrap captured | `accounting` | `maxAmount` | capture receipt (`financial` class) with immutable external id |
| Approve a credit memo | `accounting` | `maxAmount` | the dispute/return decision record |
| Approve a refund | `owner` only above the policy ceiling; `accounting` below | `maxAmount`, enforced by `effect_policy_amount_ceiling_exceeded` | the credit basis and the customer decision record |
| Withhold holdback on an invoice | `agent` (derivation) | statutory percentage from the versioned holdback policy | contract, approved change orders, holdback policy version |
| **Release holdback** | `owner`, with `external_authority` evidence | full released amount | substantial-performance certificate, lien-period expiry date, subcontractor/WCB clearance, no open lien |
| Propose a tax remittance figure | `agent` | none — proposal only | the bound tax snapshots for the period |
| File a tax return | **Not IronWrap.** The accountant files. | — | out of scope |
| Approve a payroll posting | `accounting` (accountant) — **mandatory, never an agent** | period total | IRO-53 artifact hash, approved time facts, employee register |
| Resolve an exception | `accounting`; `owner` where a money reversal is involved | — | the resolution decision and any provider correction receipt |
| Compensate any effect | the same authority that authorized the original, or higher | original amount | the exception, the chosen provider-supported remedy |

**Where the ceiling comes from.** The `maxAmount` in the table above is **server-derived and never
caller-supplied**. `POST /api/v1/accounting/intents` rejects a request body carrying
`authority_max_amount` (`unexpected_field`, 400) and reads the ceiling from the tenant's own policy
instead: `accounting_authority_policies` (migration `0064`), newest in-force row for the tenant,
narrowed by intent kind where a kind-specific row exists. A tenant with no recorded policy gets the
conservative platform default in `accounting-authority-policy.ts`
(`DEFAULT_ACCOUNTING_AUTHORITY_MAX_AMOUNT`), never "unlimited" — an absent ceiling fails closed. The
ceiling in force at derivation is copied onto the intent row (`authority_max_amount`) and is what
every later comparison uses, so an intent derived under one policy version stays explainable after
the policy moves. Policy rows are append-only and versioned: raising a ceiling is a new row naming
who raised it and from when.

This replaces the caller-declared value ELEC-73 finding 2 identified, where the only ceiling check
(`|total_amount| > |authority_max_amount|`) compared two numbers that both came from the same
request and could always be satisfied by declaring a bigger ceiling.

Three standing rules:

- **Agents may not invent chart-of-accounts, tax, or payroll truth.** Account refs, item refs, tax
  codes, terms and employee records are read from Frappe/QuickBooks mapping, and a missing mapping is
  a blocker (`customer_mapping_missing`, `item_mapping_missing`, `tax_mapping_missing`,
  `terms_mapping_missing` already exist on PR #43 and are reused), never a guess.
- **Separation of duty.** The actor that derived a candidate may not be the actor that approves it.
  Enforced in the command handler against `app_users.user_id` and in D1 by a CHECK on the intent row.
  Both layers depend on the derivation being attributed to somebody: `POST
  /api/v1/accounting/intents` records the session that derived (`owner` or `accounting`, with its
  `user_id`), because an unattributed derivation makes the check `NULL = <user id>` and it can never
  refuse — which is what it did until ELEC-79. An agent-derived intent, such as a reversal the
  compensation dispatcher derives from an authorization row, still carries no user and is therefore
  approvable by any human: nobody has claimed the deriving half of the duty.
- **Rollback is provider-supported only.** Void, credit memo, refund receipt, or adjusting journal
  entry. Deleting a D1 row or flipping a Frappe status is never a reversal, and the append-only
  triggers make it impossible anyway.

Evidence left by every money transition, all `financial` class per
`docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md:141`: the effect's `request_hash`,
`provider_response_hash`, `readback_hash`, `provider_external_id`, `authority_ref`, `policy_ref`,
`policy_version`, `attempt_id`, and correlation id — no provider payload bodies and no credentials,
matching the ledger's existing discipline. Raw webhook bytes stay in R2 under `raw/quickbooks/…` as
`source` evidence.

## 7. Schema

### 7.1 Reserved migration numbers

`main` holds `0001`–`0035`. Open PR heads declare, verified by listing
`workers-bus/migrations/` on every open head on 2026-08-18: `0036`, `0037`, `0038`, `0039`, `0040`,
`0041` (#43/#46/#47/#48/#49/#50/#51/#52), `0042` (#46/#48/#49/#52), `0043` (#48/#52), `0044`
(#50/#52), `0045` (#51/#52), `0046` (#54, merged 2026-08-18), `0047` (#59), `0048` (#60), `0053`
(#55), `0054` (#46), `0055` (#56), `0056` (#53). The original 2026-08-18 listing misattributed
`0050` to #53 and `0051` to #56; both branches actually held `0046` until the 2026-08-18 renumber.
The highest number in flight anywhere is **0056**.

That reservation is superseded. The numbers above were taken on 2026-08-18; `main` has since
shipped through `0057`, so each slice re-listed `workers-bus/migrations/` on `main` and on every
open PR head as it started and took the next free number above all of them. What actually shipped,
and what the remaining slices will take:

| Number | File | Contents | Slice |
|---|---|---|---|
| 0058 | `0058_accounting_money_intents.sql` | `accounting_intents`, `accounting_intent_events`, `accounting_intent_command_receipts`, state-transition and version guards | S1, **shipped** |
| 0059 | `0059_tax_policy_snapshots.sql` | `tax_policy_snapshots` (immutable), `accounting_intent_tax_bindings` | S2, **shipped** |
| 0060 | `0060_accounting_provider_observations.sql` | `accounting_observations` and `accounting_observation_links` (append-only), `accounting_reconciliations` | S3, **shipped** |
| 0061 | `0061_accounting_exceptions.sql` | `accounting_exceptions`, one live row per subject and reason, plus the compensation guard an `identity_conflict` needs | S3, **shipped** |
| — | none | S8 and S9 need no table: the desk reads the S1-S5 aggregates and the sweeps write only through them. Re-verified at push: `main` at `0062`, and no open head claims `0063`. | S8, S9 |
| 0063 | `0063_accounting_dispatch_evidence.sql` | `accounting_intent_expectations`, `accounting_compensation_authorizations` (both append-only) | ELEC-72, **shipped on this head** |
| 0064 | `0064_accounting_authority_policy.sql` | `accounting_authority_policies` (append-only, versioned): the server-owned section 6 ceiling | ELEC-75, **shipped on this head** |
| 0065 | `0065_accounting_intent_derivation_receipts.sql` | `accounting_intent_derivation_receipts` (append-only): the derive route's `Idempotency-Key`, enforced rather than only required | ELEC-79, **shipped on this head** |
| next free | `…_holdback_ledger.sql` | `holdback_ledger`, `holdback_events` (append-only), release-precondition guard | S6 |
| next free | `…_payroll_posting_intents.sql` | `payroll_posting_intents`, accountant approval receipts | S7 |

`accounting_exceptions.reason_code` already declares `holdback_over_released` and
`payroll_posting_mismatch`, because a shipped migration is never edited and S6 and S7 must be able
to raise against the same queue without one.

Discipline, per project rule 4 and the confirmed 0042 collision (ELEC-3 finding 1 / IRO-62):

- Additive expand-only. No shipped migration is edited, ever.
- **Re-verify the ceiling immediately before opening each implementation PR.** Other lanes move; if
  a head has claimed a number in this range by then, take the next free block and record the shift
  in the PR body.
- **Do not declare any table already declared by `0041` or `0042`** (listed in section 3.1, rule 1).
- No foreign keys into 0041/0042 tables. Cross-plane references are TEXT with a runtime invariant.

### 7.2 Shape conventions

Follow `0041_quickbooks_final_invoice.sql` and `0042_external_effect_runtime.sql` exactly, because
consistency here is what makes the money plane auditable:

- Money as TEXT decimal strings with length CHECKs (as `0041` does for `subtotal`, `tax_amount`,
  `total_amount`), or integer cents where a total is summed (as PR #55's
  `payroll_preparation_effects.total_amount_cents` does). Never a float.
- Hash columns CHECKed as 64 lowercase hex.
- An integer `version` per aggregate with a transition guard trigger, mirroring
  `quickbooks_final_invoice_intents_version_guard`.
- Binding-immutability triggers so identity, basis, authority and amount can never be edited after
  insert.
- Append-only triggers on every event, observation, and exception table.
- Command receipts (`*_command_receipts`) carrying an idempotency hash and a request fingerprint, so
  a retried PWA command is idempotent at the storage layer, not just in the handler.

### 7.3 Frappe

Additive only:

- Extend `Payment Milestone.milestone_type` with `Deposit`, `Holdback`, `Holdback Release`,
  `Tax Remittance`, `Payroll`. Frappe Select options widen without a data migration.
- New DocType `Holdback Register` mirroring `holdback_ledger` for accountant-facing reporting; D1
  stays the system of record and Frappe is the projection, matching the existing bus→Frappe direction.
- New bounded issuer methods in `frappe-apps/ironwrap_roofing/ironwrap_roofing/quickbooks_reconciliation_api.py`
  for the new entity kinds, reusing the issuer-readiness preflight already at
  `workers-bus/src/erpnext.ts:135`.
- `tools/validate-erpnext-doctypes.mjs` gains the new required-field assertions; the repo already
  enforces DocType shape there.

## 8. API and PWA surfaces

A domain with no production caller is the defect ELEC-7 caught on PR #53. These surfaces are the
caller, and a roofing office manager reaches all of them from the nav.

### 8.1 Bus routes

**Implemented** (slice S8) in `workers-bus/src/accounting-api.ts`, wired into
`workers-bus/src/app-api.ts:352`, with the read models in `workers-bus/src/accounting-desk.ts`, the
sweeps in `workers-bus/src/accounting-sweeps.ts`, and the dispatcher in
`workers-bus/src/accounting-dispatch.ts`. All seventeen routes below are served and
permission-gated, plus the eighteenth that deviation 6 in section 0 records; the six holdback and payroll rows answer `501` naming their slice, per deviation
4 in section 0. Route-level cover is `workers-bus/test/accounting-api.test.ts`, which drives the
real dispatch path through `handleAuthenticatedRoute` and speaks D1's own error dialect so a
refused transition is asserted at `409` rather than `502`.

All under `/api/v1/accounting/`, behind the app BFF session, CSRF, and an `Idempotency-Key` header on
every command — the exact conventions of `handleQuickBooksFinalInvoiceCommand`
(PR #46 `workers-bus/src/app-api.ts:990`). Commands return `202` when they enqueue an effect and
`200` when they settle locally.

The header is enforced, not merely required. `approve`, `reject`, `reconcile` and `compensate` are
enforced through `accounting_intent_command_receipts` and the derive route through
`accounting_intent_derivation_receipts` (migration `0065`): the same key with the same request
replays the intent it already derived and answers `200` with `replayed: true`, and the same key with
a different request is refused `409 accounting_intent_derivation_conflict` rather than deriving a
second intent for money nobody asked for twice. A request that refused before it derived anything
writes no receipt, so its key can be retried. Derivation's idempotency on `basis_sha256` is a
separate guarantee and does not replace this one: it makes the same figures converge on one intent,
and says nothing about one key standing for two different sets of figures (ELEC-79).

| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/accounting/summary` | `accounting:read` |
| GET | `/api/v1/accounting/intents?kind=&state=&job=` | `accounting:read` |
| POST | `/api/v1/accounting/intents` (deviation 6) | `accounting:review` |
| GET | `/api/v1/accounting/intents/{intentId}` | `accounting:read` |
| POST | `/api/v1/accounting/intents/{intentId}/approve` | `accounting:approve` |
| POST | `/api/v1/accounting/intents/{intentId}/reject` | `accounting:review` |
| POST | `/api/v1/accounting/intents/{intentId}/reconcile` | `accounting:reconcile` |
| POST | `/api/v1/accounting/intents/{intentId}/compensate` | `accounting:compensate` (owner-gated above ceiling) |
| GET | `/api/v1/accounting/holdback` | `accounting:read` |
| GET | `/api/v1/accounting/holdback/{roofJobId}` | `accounting:read` |
| POST | `/api/v1/accounting/holdback/{holdbackId}/release` | `accounting:holdback_release` (owner only) |
| GET | `/api/v1/accounting/exceptions?status=` | `accounting:read` |
| POST | `/api/v1/accounting/exceptions/{exceptionId}/resolve` | `accounting:reconcile` |
| GET | `/api/v1/accounting/tax/snapshots?period=` | `accounting:read` |
| POST | `/api/v1/accounting/tax/snapshots` (deviation 8) | `accounting:review` |
| GET | `/api/v1/accounting/tax/remittance/{period}` | `accounting:read` |
| GET | `/api/v1/accounting/payroll/runs/{payrollRunId}` | `accounting:payroll` |
| POST | `/api/v1/accounting/payroll/runs/{payrollRunId}/approve` | `accounting:payroll` |
| POST | `/api/v1/accounting/payroll/runs/{payrollRunId}/reject` | `accounting:payroll` |

New permissions added to `ROLE_PERMISSIONS` in `workers-bus/src/app-types.ts` (which on PR #46
already gives `accounting` its `quickbooks:*` set at `:226`): `accounting:read`,
`accounting:review`, `accounting:approve`, `accounting:reconcile`, `accounting:compensate`,
`accounting:holdback_release`, `accounting:payroll`. `owner` receives all of them; `accounting`
receives all except `accounting:compensate` and `accounting:holdback_release` above the ceiling;
`ops` receives `accounting:read` only.

Scheduled work joins the existing cron in `workers-bus/src/index.ts` beside
`recoverDueQuickBooksProjections`: a due-observation sweep (re-read entities whose reconciliation is
stale), a deadline sweep (expire `unknown` effects into `manual_exception`), and a holdback
lien-period sweep (surface releases that have become eligible).

**The dispatcher runs on that same cron** (`runAccountingDispatch`,
`runAccountingCompensationDispatch`). `submission_pending` is its queue — the money plane already
has an outbox, so it does not need a second one — and a compensation authorization row is the
queue for a reversal. This follows `quickbooks-final-invoice.ts`, whose outbox is likewise drained
by the frequent cron rather than by a Cloudflare Queue; a new queue binding would be a production
configuration change, and the ordering guarantees a money dispatch needs come from the effect
ledger's idempotency key rather than from the transport. The binding that reaches the provider is
injected, so an unbound Worker reports what is waiting and dispatches nothing, and project rule 5
holds by construction.

### 8.2 PWA screens

**Implemented** (slice S9) for the Money Desk, intent detail, exception queue, and the settings
extension: `app/src/accounting/money-desk-page.tsx`, `money-intent-page.tsx`,
`money-exceptions-page.tsx`, and the reconciliation-health card added to `quickbooks-page.tsx`.
Routes are registered in `app/src/router.tsx` and the accounting role's navigation lands on
`/accounting` (`app/src/lib/roles.ts`). The holdback register, release wizard, and payroll review
rows remain **Target**: they are slice S10 and are gated on S6 and S7.

Mobile-first is proven rather than asserted. `app/e2e/accounting-money-desk.spec.ts` runs every
screen at a Pixel 5 viewport and fails on horizontal overflow or on any control under 44 CSS px,
which is what caught the reconciliation-health link at 41 px before it shipped. The shared office
navigation is deliberately unchanged: it already carries nine mobile tabs, and a tenth would put
every office role under the touch-target floor.

New directory `app/src/accounting/` alongside the `quickbooks-page.tsx` that PR #43 already puts
there, with routes registered in `app/src/router.tsx`:

| Route | Screen | What the office manager does |
|---|---|---|
| `/accounting` | **Money Desk** | The default landing page for `access_role = 'accounting'`. Four queues: *Needs approval*, *Awaiting provider*, *Mismatched*, *Exceptions*. Each row: job, customer, kind, amount, state, age, and the single next step. |
| `/accounting/intents/$intentId` | Intent detail | Bound facts with evidence citations, expected-vs-observed diff rendered field by field, the effect attempt history, and the action buttons the current role is allowed. |
| `/accounting/holdback` | Holdback register | Every job with holdback: entitled, withheld, released, substantial-performance date, lien-period expiry, release eligibility. |
| `/accounting/holdback/$roofJobId` | Release wizard | Statutory checklist (certificate, lien expiry, clearances, no open lien) with each item bound to its evidence; the release button stays disabled until all are satisfied, and the wizard states which one is missing. |
| `/accounting/exceptions` | Exception queue | Reason code, both hashes, the proposed provider-supported remedies, and the resolve action. |
| `/accounting/payroll/$payrollRunId` | Payroll review | The IRO-53 artifact, its hash, per-line totals, the posting target, and the accountant approve/reject. |
| `/accounting/quickbooks` | Connection settings | Extends PR #43's page with reconciliation health: stale observations, open exceptions, oldest unreconciled intent. |

State vocabulary shown to the user, one badge per intent, mapped straight from the effect ledger so
the screen cannot drift from the truth: **Pending** (proposed/authorized), **In flight**
(executing/reconciling), **Uncertain** (unknown — "we do not know whether this reached QuickBooks;
we are checking"), **Mismatched** (verdict `mismatch`/`identity_conflict`), **Compensated**, and
**Reconciled**. Every non-terminal badge carries a plain-language next step, not a reason code.

Safe recovery, on every screen: the user can always (a) re-read the provider, (b) open an exception,
(c) see exactly which evidence is missing. No screen offers a destructive action, because there
isn't one — reversal is a compensating effect, presented as "issue a credit memo" or "void the
payment", never as "delete".

## 9. Test strategy — proving it without touching Intuit

Project rule 5 forbids live provider credentials. The mocked contract test is therefore the
**primary** proof, and this section is explicit about what it does and does not establish.

**Harness.** Extend `workers-bus/test/effect-runtime-fixture.ts:41` — its `EffectLedgerTestD1` runs
real migration SQL in an in-memory `node:sqlite` database behind a D1-shaped facade — into
`workers-bus/test/accounting-fixture.ts`, loading migrations 0058–0061 (the money plane's own),
with `workers-bus/test/accounting-scenario-fixture.ts` adding the S4/S5 lifecycle choreography. Tests run under
`node --test` (`workers-bus/package.json`), so the D1 CHECKs and triggers are executed, not mocked.
PWA tests run under `vitest` in `app/`.

**Provider fixtures.** `workers-bus/test/fixtures/quickbooks/` holds synthetic Intuit-shaped
responses — no real realm, customer, account, or credential — for create and read of Invoice,
Payment, CreditMemo, RefundReceipt, JournalEntry, TimeActivity, TaxCode, plus the error shapes that
drive behaviour: `6240` duplicate document number, `5010` stale object, `3200` auth failure, `429`,
`500`, and a socket-level timeout. A `fakeIntuit(fixtures)` function of type `typeof fetch` is
injected through the existing parameter convention
(`workers-bus/src/quickbooks-final-invoice.ts:475`), so no global patching is needed.

**Contract conformance.** A checked-in shape descriptor per entity, asserted two ways: every fixture
validates against it, and the normalizer reads no field absent from it. This is the honest proxy for
"we match Intuit's contract" — it proves our reader and our fixtures agree, and it catches the class
of bug where a normalizer quietly depends on an undocumented field.

**Scenario matrix.** One executable test per row, each asserting the final intent state, the effect
ledger states traversed, the exception raised (or not), and that no row was deleted.

| Scenario | Assertion |
|---|---|
| Duplicate create (same `requestid` retried) | one provider entity, effect replays, no second attempt row |
| Envelope changed on retry | `effect_idempotency_conflict`, nothing dispatched |
| Duplicate payment against one invoice | `duplicate_provider_payment` exception, intent `mismatch`, two remedies offered |
| Partial payment | `partially_settled`, no exception, cumulative invariant holds |
| Full settlement after partial | `reconciled` only when `Balance == 0` |
| Over-payment | `mismatch`, not `partially_settled` |
| Refund race (refund and payment settle concurrently) | both observed, cumulative invariant evaluated once, deterministic verdict |
| Holdback withheld then released | ledger arithmetic, release blocked until every precondition is satisfied |
| Refund after holdback release | `holdback_over_released`, further releases blocked, no auto-adjustment |
| Tax snapshot stale at submission | `candidate_changed` blocker, re-derivation required |
| Provider tax rate differs from snapshot | `tax_rate_drift`, blocked, snapshot unchanged |
| Payroll correction | new effect, adjusting entry linked by `compensates_effect_id`, original intact |
| Lost response | `unknown`, retry refused, resolved by `requestid` query |
| Lost response, entity never created | `unknown → manual_exception` at deadline |
| Provider drift after reconciliation | new observation supersedes, `reconciliation_required`, drift exception |
| Authority ceiling breach on a refund | `effect_policy_amount_ceiling_exceeded`, nothing dispatched |
| Separation of duty violated | approval rejected before any effect is proposed |

**D1 invariant tests.** Execute each new migration against `node:sqlite` and assert the triggers
fire: binding immutability, forbidden state transitions, append-only deletes and updates, and the
uniqueness constraints. The repo already tests migrations this way (`workers-bus/test/app-migration.test.ts`).

**PWA tests.** One test per screen per state badge (Pending, In flight, Uncertain, Mismatched,
Compensated, Reconciled), plus the release wizard's disabled-until-complete behaviour and the
exception queue's remedy rendering, following `app/src/accounting/quickbooks-page.test.tsx` on PR #43.

**What this cannot prove.** That Intuit's live API behaves as the fixtures describe; that a real
realm's chart of accounts maps as expected; that the accountant accepts the reconciliation output as
a basis for filing. IRO-52's acceptance already separates these as two distinct receipts —
"QuickBooks sandbox proof and accountant business acceptance are separate required receipts" — and
both are **Blocked** until the runtime holds sandbox credentials and an accountant is engaged. They
are slice S12 and no other slice depends on them.

## 10. Task breakdown

Dependency order. S0–S10 are provable against `main` today. Every slice ends green under
`node --test` in `workers-bus/` and `vitest run` in `app/`.

| # | Slice | Depends on | Notes |
|---|---|---|---|
| S0 | Effect and auth **ports** + test doubles (`accounting-effect-port.ts`, `quickbooks-auth-port.ts`, `test/accounting-port-fixture.ts`) | — | **Implemented.** No schema. Unblocks everything. |
| S1 | Migration **0058** + intent state machine + command receipts + D1 invariant tests | S0 | **Implemented.** The core aggregate. |
| S2 | Migration **0059** + tax snapshot binding, staleness and drift detection | S1 | **Implemented.** Cheap, and every other slice binds a snapshot. |
| S3 | Migrations **0060 + 0061** + the reconciliation engine (normalizers, expected/observed hashing, verdicts, exception raising) | S1, S2 | **Implemented.** The heart of the issue. |
| S4 | Payment and deposit intents through the port + fixtures + duplicate/partial/over-payment scenarios | S3 | **Implemented.** First end-to-end money path. No migration. |
| S5 | Credit memo and refund intents + compensation plans + refund-race scenario + ceiling enforcement | S4 | **Implemented.** First reversal path. No migration. |
| S6 | Next free migration + holdback ledger, entitlement computation, release preconditions, refund-after-release | S5 | The domain-specific slice; largest design surface. |
| S7 | Next free migration + `PayrollAccountingAdapter` implementation + payroll correction scenario | S3, **PR #55** | Gated on IRO-53 landing. Posting target per open question 2. |
| S8 | Bus BFF routes + permissions + cron sweeps | S3 | **Implemented.** Backend surface. |
| S9 | PWA Money Desk, intent detail, exception queue | S8 | **Implemented.** Frontend surface. |
| S10 | PWA holdback register + release wizard + payroll review | S6, S7, S9 | Frontend surface. |
| S11 | **Shipped (ELEC-81)**: the re-observation rail — bound sweep, re-reading `reconcile`, statutory-rate origin | #46 and #43 merged | No migration. What was actually missing was the caller, not the binding. |
| S12 | Sandbox proof + accountant business acceptance | credentials, accountant | **Blocked** by project rule 5. |

Backend versus frontend split: S0–S8 and S11 are `workers-bus/` plus `frappe-apps/`; S9–S10 are
`app/`. S8 and S9 are the seam — S9 consumes only the envelopes S8 emits, so they can proceed in
parallel once the envelope shapes in section 8.1 are fixed.

## 11. Rejected alternatives

- **Six per-kind intent tables mirroring `0041`.** Rejected: one shared state machine implemented as
  six near-identical trigger sets triples the audit surface for no isolation benefit.
- **Holdback as a pure QuickBooks projection with no local system of record.** Rejected: QuickBooks
  Online has no holdback entity, so entitlement, substantial-performance date and lien period would
  have nowhere to live.
- **Trusting webhooks for payment or posting state.** Rejected by IRO-52's acceptance, by
  `docs/CAPABILITY-MATRIX.md:177`, and by the implemented posture at `workers-bus/src/quickbooks.ts:5`.
- **A private effect runtime inside the accounting module.** Rejected: violates the one-runtime rule
  and guarantees a collision with `0042` the day #46 merges.
- **Waiting for #46 to merge before starting.** Rejected: #46 is a human-carve-out lane this squad
  cannot merge, entangled in IRO-62. The port seam removes the block at the cost of one small
  binding PR.
- **Auto-compensating a duplicate payment or an over-release.** Rejected: money reversal is
  accountant-authorized and provider-supported only.
- **Netting a refund against an outstanding holdback.** Rejected: it silently merges two
  independently authorized money movements and destroys the audit trail for both.
- **Filing GST/T5018 from IronWrap.** Rejected as out of scope: filing is a licensed act performed
  by the accountant. IronWrap proposes and reconciles the figures.

## 12. Open questions for the product owner

1. **Document class (resolved 2026-08-22).** This file is a developer/historical design reference.
   It does not state current target authority; the canonical AI-native architecture and capability
   matrix own that role.
2. **Payroll posting target.** QuickBooks Online's public Accounting API exposes `TimeActivity`,
   `JournalEntry`, `Employee` and `Purchase`, but no payroll run or paycheque write. "Payroll
   posting" must therefore mean either an accountant-approved summary `JournalEntry` plus
   `TimeActivity` projection, or a handoff to an external payroll provider. Confirm which before S7.
   The port is designed to accept both (`PayrollPostingTarget = "journal_entry" | "external_handoff"`).
3. **Holdback statute parameters.** The percentage, substantial-performance definition, and lien
   period under Alberta's Prompt Payment and Construction Lien Act must be confirmed by the
   accountant or counsel and become a **versioned policy record**, not a constant in code. Who signs
   off, and what is the initial version?
4. **Does IronWrap ever create Payments in QuickBooks**, or only observe them? Section 4.1 defaults
   to observe-only, with creation reserved for payments IronWrap itself captured (portal deposit,
   card capture). Confirm, because it changes S4's scope materially. **S4 shipped on the default**:
   `accounting-payments.ts` is an observation path with no create, and a `payment`-kind dispatch is
   refused outright with `accounting_payment_observe_only`. Answering this "yes" is additive — a
   provider action for `payment` plus its executor — and does not unwind anything built.
5. **Tax scope.** Confirmed out of scope: no CRA filing, propose-and-reconcile only. Please confirm
   that the accountant accepts a reconciled remittance figure as the deliverable.
6. **Accountant identity.** Is the accountant an `app_users` row with `access_role = 'accounting'`,
   or an `external_authority` whose approvals arrive as evidence? This determines whether payroll and
   refund approvals are PWA commands or evidence ingestion, and it affects S7 and S9.
7. **PR #46 contingency.** If the PO's judgement is that #46 will not land in a useful timeframe,
   say so before S1 — the same port then gets a minimal first-party ledger implementation, which is
   a scope addition of roughly one slice.
