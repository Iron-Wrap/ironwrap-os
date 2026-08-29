# Template / Marketplace Requirements (captured, not built)

Status: canonical
Owner: IronWrap OS product owner
Last verified: 2026-08-29
Review trigger: any change to the pipeline, schema-field, document-template, or automation domains
that packaging would need to snapshot

## Purpose

IRO-209 declares template/Operating-Pack packaging a **non-goal until governed configuration is
repeatedly proven with upgrade, rollback, and isolation evidence.** This document honors that: it
captures Ilya's requirement (recorded at the 2026-08-22 stakeholder call, relayed by Andrei Zolin)
so it is not lost, states what a template must carry, what "composable" has to mean concretely, and
— the actual point of this document — what upgrade, rollback, and isolation evidence Stages 1–2
would still need to produce before the non-goal can responsibly be lifted.

This is a **Target** document (per `docs/DOCUMENTATION-CONTRACT.md`). The marketplace/catalog,
composition, upgrade, and rollback layers described here are not built; the implemented
configuration primitives they would package are called out explicitly below. This document must
not be read as a design already accepted for implementation.

## The requirement, in the stakeholder's words

> "A roofer, a window guy, a tire shop all have different workflows." — Ilya, 2026-08-22

Ilya wants pre-built role, pipeline, and automation bundles per industry, composable — "templates
of templates" — so a second vertical (or a second office within the same vertical) starts from a
working configuration instead of an empty tenant. The onboarding target he described: select
templates, enter company details, upload a logo, start working.

## What a template must be able to carry

Based on what Stages 1–2 actually landed (verified from the cited code and tests on 2026-08-29), a
template package would need to snapshot every layer an admin can now configure by hand:

1. **Pipelines and stages** — `pipelines`, `pipeline_stages` shape (PR #153,
   `0113_pipeline_board_core.sql`; admin CRUD landed in `0122_pipeline_admin_configuration.sql`,
   `workers-bus/src/pipeline-board-store.ts`). Two existing primitives serve different scopes:
   `tools/seed-pipeline.mjs` additively installs a versioned repo-shipped document from
   `config/pipelines/` as ordinary tenant rows, while the tenant-local "Copy pipeline" action
   duplicates stages + role grants without cards or transition history. Future packaging should
   reuse both rather than conflate them: seeding is the operator-controlled baseline path; copy is
   the per-tenant duplication path. Neither is a marketplace catalog or template-upgrade engine.
2. **Role grants per pipeline** — `pipeline_role_grants` (owning role + explicit read/write grants
   per role). Confirmed configurable per pipeline via the Role access panel on
   `/settings/configuration/pipelines`.
3. **Schema field definitions** — `schema_fields`/`schema_field_revisions`
   (`workers-bus/src/schema-forms.ts`, `0124_schema_field_history.sql`): field key, type,
   validator + validator config, visibility rule + config, evidence class, retention policy,
   offline mode, read/write scope, and per-role read/write authority. Confirmed configurable via
   `/settings/configuration/fields` and covered by `app/e2e/owner-configuration.spec.ts`.
4. **Automation rules** — `pipeline_automation_rules`-equivalent domain
   (`workers-bus/src/pipeline-automation.ts`, `0123_pipeline_stage_automation.sql`,
   `0127_pipeline_automation_action_registry.sql`): trigger stage, action (from the registered
   action list), template reference, recipient reference. Confirmed configurable via
   `/settings/configuration/automations`.
5. **Document templates** — `document-templates.ts` (`0125_document_templates_and_generation.sql`)
   is a REQUIRED companion layer: an automation rule that generates-and-delivers a document is
   only meaningful with a template attached. Owners can create, revise, retire, and inspect
   history at `/settings/configuration/documents` through
   `app/src/admin/document-templates-configuration-page.tsx` and the
   `/api/v1/admin/document-templates` endpoints. The automation rule builder selects an existing
   template rather than authoring one inline; that is a cross-screen workflow constraint, not a
   missing admin capability. A package therefore can and should treat document templates as
   catalog content, applying them before rules that reference them.
6. **Company profile and branding** — name, short name, description, contact details, logo
   (`app/src/admin/company-profile-page.tsx`). Already reachable per-tenant from Setup; a template
   would leave these tenant-specific fields blank/prompted at instantiation time, matching Ilya's
   stated onboarding target ("enter company details, upload a logo").
7. **NOT in scope for a template**: people/team membership (`app/src/admin/team-page.tsx`) and
   crew device pairings are tenant-specific identity, never template content.

## What "composable — templates of templates" has to mean concretely

Ilya's phrase implies two distinct capabilities, and they should not be conflated:

- **Bundle composition**: a named "Roofing starter" package is itself an ordered list of smaller,
  independently named packages — "Sales pipeline template," "Production pipeline template,"
  "Materials-list automation template" — so a second vertical can reuse the parts that transfer
  (e.g. a generic "field-service sales pipeline" template) while swapping the parts that don't
  (a roofing-specific stage vocabulary). This requires a template to reference other templates by
  a stable id/version, not just inline every field.
- **Instantiation-time override**: applying a template must let the admin rename stages, adjust
  role grants, or skip an automation before it lands — otherwise "templates of templates" degrades
  into "one giant fixed bundle per vertical," which contradicts the generic-core rule this project
  already treats as load-bearing. The existing "Copy pipeline" flow's `Copy key` / `Copy name`
  inputs are a working tenant-local precedent for this: duplication already asks for the two
  identifiers a copy needs before committing. The repo-shipped `config/pipelines/` seed documents
  are the separate precedent for a versioned, operator-controlled baseline.

Both composition capabilities are unbuilt. Repo-shipped pipeline seed documents are versioned
configuration inputs, but the current admin surfaces do not expose pipelines, field sets,
document templates, or automation rules as catalog entries that can be composed, upgraded, or
rolled back as one unit. Runtime rows remain tenant-owned. A marketplace would therefore need a
tenant-less (or platform-tenant) catalog layer that per-tenant admin surfaces read from, which is
new governed state, not just a UI feature on top of existing rows.

## Upgrade, rollback, and isolation evidence still required before the non-goal can lift

IRO-209's bar is explicit: "repeatedly proven with upgrade, rollback, and isolation evidence."
Based on what actually exists after Stages 1–2, here is what each of those three would need to
demonstrate, and why none of them can be demonstrated yet:

### Isolation
**What it would need to prove:** applying a template to tenant A never reads, writes, or leaks
into tenant B's rows, even when both instantiate the same template at the same version.
**Why it's unproven today:** there is no template catalog to instantiate FROM yet — every pipeline,
field, and rule row is tenant-scoped from creation (`tenant_id` on every table verified in
`0113_pipeline_board_core.sql`, `0124_schema_field_history.sql`,
`0123_pipeline_stage_automation.sql`). Per-tenant row isolation is already a strength of the
landed schema (composite `(id, tenant_id[, pipeline_id])` foreign keys per the verified repo
facts), which is a good sign for isolation once a catalog exists, but "no template layer exists"
is not the same claim as "isolation is proven" — there is nothing to prove yet.

### Upgrade
**What it would need to prove:** a tenant that instantiated template v1 can move to template v2
without an engineer, without silently discarding the tenant's own edits to what v1 produced, and
with the tenant told exactly what changed.
**Why it's unproven today:** the closest existing precedent is the schema field's own **immutable
revision history** (`schema_field_revisions`, confirmed live via the "History" panel on
`/settings/configuration/fields`) and the automation rule's equivalent immutable history panel —
both already solve "what changed and when" for a SINGLE row. Template upgrade is a different,
harder problem: propagating a catalog-level change across many already-instantiated, possibly
tenant-edited rows, deciding whether a tenant's local edit blocks or survives the upgrade. Nothing
in the landed domains attempts multi-row propagation; the versioning that exists is per-row
optimistic concurrency (the `expected_version` CAS pattern), not template-level diffing.

### Rollback
**What it would need to prove:** an admin who applied a template (or a template upgrade) can
revert to the pre-apply state without an engineer and without a support ticket to reconstruct
what "before" looked like.
**Why it's unproven today:** every domain's mutation is additive/versioned (pipelines, schema
fields, automation rules all keep immutable history per revision), which is a genuine asset for a
future rollback design — the audit trail already exists. But rollback of a MULTI-DOMAIN,
MULTI-ROW template application (pipelines + stages + role grants + fields + rules all applied
together) is not the same as reverting one row to its prior revision; nothing today composes
per-row history into one all-or-nothing "undo this template apply" operation.

### The pattern across all three
Every one of upgrade, rollback, and isolation depends on a **template catalog existing as
addressable, versioned rows** — and none of the three has anything to test against until that
catalog is designed. That catalog is itself the first deliverable any future templating work would
need, before upgrade/rollback/isolation evidence can even be attempted. Recording this now is the
point of this document: the next time someone proposes lifting IRO-209's non-goal, "have you
designed the catalog layer" is the first question, not "have you built a nice UI on top of the
existing per-tenant admin pages."

## Remaining document-to-automation workflow constraint (2026-08-29)

Document-template authoring is available in `app/`: `app/src/admin/configuration-page.tsx` links
to `/settings/configuration/documents`, and
`app/src/admin/document-templates-configuration-page.tsx` provides create, revise, retire, and
history actions backed by `workers-bus/src/schema-forms-api.ts`'s
`/api/v1/admin/document-templates/*` routes. The automation builder's Template picker remains a
selection control over that existing catalog; it does not create a document inline.

That separation does not block an administrator from composing the workflow today, but a future
package apply must preserve referential order and evidence: install or resolve each document
template first, then install automation rules that reference it, and fail the whole package apply
if any reference cannot be resolved. Inline document creation inside Automations is a possible UX
improvement, not a prerequisite for catalog correctness.

## Non-goals of this document

- This is not a schema design. No table, migration, or API shape is proposed here.
- This is not a commitment to build templating in any specific milestone.
- This does not change IRO-209's non-goal status. It exists so that status stays an informed
  decision rather than a forgotten one.
