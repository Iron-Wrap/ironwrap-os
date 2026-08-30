# Ruling: Field Evidence Before a Work Package Exists

Status: canonical
Owner: IronWrap OS product owner
Last verified: 2026-08-30
Review trigger: any change to `field_actions`, the field-companion evidence path, or Work Package
evidence-slot binding

## Question

Can field evidence legitimately exist before a Work Package does, and if so, what does it bind
to? Raised after a reported refusal attributed to `field_actions_work_package_binding_shape`
(`workers-bus/migrations/0044_work_package_evidence_slots.sql:27-70`). Current source and tests
show that an assigned field user can attach a photo before a Work Package exists.

## Ruling

**Pre-Work-Package field evidence is legitimate, and the schema already has a class for it: the
plain Field Check-in that has existed since `workers-bus/migrations/0012_field_companion.sql`.**
It is not new schema and does not widen the typed Work-Package evidence contract. The trigger and
the invariant it enforces are correct as written. One earlier implementation bug accidentally
collapsed the always-available Field Check-in class into an incomplete *typed* Work-Package
evidence submission; current source has fixed that boundary. A second suspected permission bug
was an incomplete trace: the base read envelope already grants an assigned field user the plain
check-in action, and the empty Work Package projection does not remove it. No source or schema fix
is currently required. PR #221 added the focused regression that preserves this behavior
(`workers-bus/test/app-read-models.test.ts:2024-2056`); do not touch `IRO-42`'s (Work Package /
evidence-slot) contract, and do not add a migration.

## Current-state analysis

### The schema already has two evidence classes on one table

`field_actions` (`workers-bus/migrations/0012_field_companion.sql:5-31`) requires `job_id` and
`assignment_id` NOT NULL on every row, `action_kind` is fixed to `'field_checkin'`, and media
attachments (`field_action_media`, same migration, lines 39-56) carry their own immutable
`evidence_id` independent of any work-package binding. This is the generic, always-on evidence
class: **tenant + job + assignment + authenticated actor + capture time**, no Work Package
required.

Migration `0044_work_package_evidence_slots.sql` layers a second, *typed*, opt-in class on the
same table: a Work-Package-scoped evidence slot. Its trigger
`field_actions_work_package_binding_shape` (lines 27-70) does exactly one thing: if **any** of 13
named columns (`work_package_id`, `work_package_version`, `evidence_slot_id`,
`evidence_requirement`, `evidence_source`, `evidence_device_id`, `evidence_freshness`,
`evidence_conflict_state`, `evidence_verification`, `evidence_disposition`,
`evidence_correction_of`, `evidence_item_correction_of`, `work_package_release_attempt_id`) is
non-NULL, then all of them must be present and well-formed. If **none** of the 13 are set, the
trigger is a no-op — a plain Field Check-in inserts freely. This is proven directly by the
migration's own test: `workers-bus/test/app-migration.test.ts:2675-2681` (`"field-action-0044-
orphan"`) shows that setting **one** guarded column alone (`evidence_source`, with everything else
NULL) throws `field_action_work_package_binding_invalid` — the trigger does not distinguish
"partially typed" from "accidentally contaminated."

Server-side, `workers-bus/src/field-actions.ts:594-596` computes `typedEvidence =
work_package_id != null || evidence_slot_id != null`. When `typedEvidence` is `false`, evidence
fields are left `null` and the insert (`workers-bus/src/field-actions.ts:928-963`) is the plain
class described above — no work package needed, and `proof_slot` is a fixed generic vocabulary
(`Safety`, `Access`, `Weather`, `Crew`, `Other`, …; `field-actions.ts:26-41`) that does not depend
on any work-package evidence slot. `0092_frappe_free_field_evidence.sql:7-8` later added
`work_object_type`/`work_object_id` (plus `physical_context_type`/`_id`) to the same table as a
generic scope anchor, independent of the typed columns above — this is the seam ELEC-172's memo
already routed schema-field evidence through, and it is the right binding target here too (see
Ruling on Q2 below).

### Historical root cause 1 — fixed in current source

An earlier `processFieldSubmission` implementation populated `evidence_device_id` from the paired
session even for a plain check-in. That single non-null typed-evidence column made the correct
`0044` trigger reject the otherwise untyped row.

Current source no longer has that defect. `workers-bus/src/field-actions.ts:805-843` gates every
typed evidence column, including `evidenceDeviceId` at lines 820-822, behind `typedEvidence`.
Untyped payloads that try to carry typed binding fields are also rejected before persistence at
lines 644-645. Repository E2E coverage now proves that a paired field device can submit a photo
before a Work Package exists (`app/e2e/field-checkin-refusals.spec.ts:29-85`). This is source and
test proof, not hosted runtime or customer proof.

### Suspected root cause 2 — disproved by the complete permission composition

`buildJobReadModel` (`workers-bus/src/app-read-models.ts:1537-1718`) first resolves the active
native assignment and returns `null` for an assigned-mode read without one. For an authorized
field read, `envelope()` grants the base actions `job.read.assigned`, `field.checkin.create`, and
`field.evidence.create` (`app-read-models.ts:3785-3806`). The final action set at lines 1652-1663
retains those base actions for every non-production role and then appends any Work Package actions.

`fieldWorkPackageProjection` correctly returns no Work Package lifecycle actions when the package
is absent (`workers-bus/src/work-package.ts:626`), but an empty appended list does not subtract the
base check-in action. Office envelopes do not receive field actions, and unassigned field reads
have already failed closed. The focused read-model regression now covers the assigned-field/no-
package case and the non-field exclusion together
(`workers-bus/test/app-read-models.test.ts:2024-2056`, merged by PR #221 as
`1b5394e64da3d3709ef26154edaa5c97d0bbb638`). The existing paired-device E2E independently
removes the Work Package while preserving `field.checkin.create`
(`app/e2e/field-checkin-refusals.spec.ts:29-85,159-165`).

The original report is therefore explained by the historical write-path defect or by a checkout
that predates its repair, not by a live permission or schema defect in current source.

## Answers to the five questions

**1. Is a pre-Work-Package evidence class justified, or is this a workflow fix?**
Justified, and it is not new: it is the base Field Check-in class from `0012`, which the
0044/0092 typed-evidence layer was always meant to sit beside, not replace. Nothing here is a
"widen the schema" change. The current write path and read-model permission composition preserve
that distinction. No new workflow or implementation fix is justified by current source/tests.

**2. What does it bind to?**
`field_actions.job_id` + `field_actions.assignment_id` (both `NOT NULL` since `0012`) plus, when
available, the generic `work_object_type`/`work_object_id` + `physical_context_type`/`_id` scope
from `0092`. Actor is `field_actions.user_id` (`NOT NULL REFERENCES app_users`); device identity
for a plain check-in is recoverable from the session/audit log, not from the guarded
`evidence_device_id` column — that column is reserved for the typed Work-Package evidence
contract and must stay `NULL` on an untyped row per the trigger's own shape. Media keeps its own
`field_action_media.evidence_id`, unrelated to work-package slot identity. This preserves full
attribution (tenant, job, assignment, actor, capture time, immutable media hash) without a second,
weaker evidence path — it is the *same* path ELEC-172 already routed schema-field evidence
through.

**3. How does the trigger change?**
It does not change. The write caller already gates `evidenceDeviceId` behind `typedEvidence`, and
an untyped submission must continue inserting all 13 guarded columns as `NULL`. The read model
already preserves `field.checkin.create` for an authorized field envelope when the Work Package
projection contributes no actions. Keep the focused `buildJobReadModel` regression at
`workers-bus/test/app-read-models.test.ts:2024-2056` for that exact composition and the existing
paired-device E2E as the end-to-end guard for the fixed write path and the `0044` boundary.
- **No migration.** The trigger's invariant is already correct; nothing about its shape needs to
  change, and no new columns or tables are required.

**4. Correction, conflict, and retention when a Work Package is later issued?**
The pre-Work-Package check-in stays exactly where it is: immutable, untyped, bound to
job/assignment/work-object scope. `field_actions_work_package_binding_guard`
(`0044_work_package_evidence_slots.sql:73-99`) already forbids ever mutating a row's
work-package/evidence columns after insert, and evidence is immutable by contract
(`docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md:176`). It does not re-bind to the work package once one
is issued and does not migrate into an evidence slot. Once the work package exists, the check-in
remains persisted in its original generic field-check-in scope. Current
`buildJobReadModel.proof_stream` is sourced only from typed Work-Package evidence
(`app-read-models.ts:1570,3695`); it does not project the untyped check-in beside the new work
package's evidence slots. If production needs that cross-view, add a read-only projection or
reference that preserves the original row and authority boundary. Any explicit forward link
belongs on the append-only Work-Package definition, never as a rebind of the check-in.

**5. Interaction with IRO-42?**
None required. IRO-42 owns the typed Work-Package/evidence-slot contract: the `0044`/`0092`
columns, the release-attempt/slot binding shape, multi-worker acknowledgement, offline correction
of *typed* evidence. This ruling leaves every part of that untouched. The historical write fix in
`workers-bus/src/field-actions.ts` and the existing base-envelope permission composition both sit
beside, not inside, the Work Package aggregate.

## Rejected alternatives

- **Widen the 0044 trigger to allow `work_package_id IS NULL` with some evidence columns set.**
  Rejected: the trigger is not the bug. Widening it would let a genuinely malformed typed
  submission (e.g., `evidence_slot_id` set, everything else missing) through unattributed,
  weakening the exact invariant `docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md` calls load-bearing.
- **New `field_evidence_unbound` table for pre-Work-Package evidence.** Rejected: `field_actions`
  already models this class since `0012`; a parallel table would fork evidence storage, proof-
  stream rendering, and retention for no benefit, and contradicts ELEC-172's decision to reuse
  `work_object_type`/`work_object_id` rather than add a new evidence surface.
  ELEC-172's memo made the same call for schema-field evidence; do not now special-case field
  check-ins.
- **Require production to issue a Work Package before a crew is ever dispatched, and remove the
  untyped path entirely.** Rejected as the sole fix: it would still leave the true first-arrival
  case (crew shows up, no plan ready, needs to photograph why) with no evidence path, which is
  exactly the gap the stakeholder call flagged as real. The untyped class is what handles this;
  removing it does not solve the underlying need.

## Scope and scheduling

Ruling only; no code in this change. This document does not set release priority. The only
repository follow-up justified by the original evidence was the focused read-model regression; it
landed in PR #221 and now locks the already-correct permission composition. The typed write-path
repair and paired-device E2E proof are also present. No further permission/UI change, migration, or
Work Package aggregate change belongs in this slice.
