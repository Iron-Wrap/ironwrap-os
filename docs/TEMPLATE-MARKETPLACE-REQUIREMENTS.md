# Template / Marketplace Requirements (captured, not built)

Status: canonical
Owner: IronWrap OS product owner
Last verified: 2026-08-28
Review trigger: any change to the pipeline, schema-field, or automation domains that packaging
would need to snapshot

## Purpose

IRO-209 declares template/Operating-Pack packaging a **non-goal until governed configuration is
repeatedly proven with upgrade, rollback, and isolation evidence.** This document honors that: it
captures Ilya's requirement (recorded at the 2026-08-22 stakeholder call, relayed by Andrei Zolin)
so it is not lost, states what a template must carry, what "composable" has to mean concretely, and
— the actual point of this document — what upgrade, rollback, and isolation evidence Stages 1–2
would still need to produce before the non-goal can responsibly be lifted.

This is a **Target** document (per `docs/DOCUMENTATION-CONTRACT.md`). Nothing here is built. It
must not be read as a design already accepted for implementation.

## The requirement, in the stakeholder's words

> "A roofer, a window guy, a tire shop all have different workflows." — Ilya, 2026-08-22

Ilya wants pre-built role, pipeline, and automation bundles per industry, composable — "templates
of templates" — so a second vertical (or a second office within the same vertical) starts from a
working configuration instead of an empty tenant. The onboarding target he described: select
templates, enter company details, upload a logo, start working.

## What a template must be able to carry

Based on what Stages 1–2 actually landed (verified 2026-08-28, this issue's live audit), a
template package would need to snapshot every layer an admin can now configure by hand:

1. **Pipelines and stages** — `pipelines`, `pipeline_stages` shape (PR #153,
   `0113_pipeline_board_core.sql`; admin CRUD landed in `0122_pipeline_admin_configuration.sql`,
   `workers-bus/src/pipeline-board-store.ts`). A template's pipeline entry is exactly the shape the
   "Copy pipeline" action already produces (stages + role grants, no cards, no transition
   history) — that existing copy operation is the nearest thing to a template instantiator the
   system has today, and any templating design should treat it as the primitive, not reinvent it.
2. **Role grants per pipeline** — `pipeline_role_grants` (owning role + explicit read/write grants
   per role). Confirmed configurable per pipeline via the Role access panel on
   `/settings/configuration/pipelines`.
3. **Schema field definitions** — `schema_fields`/`schema_field_revisions`
   (`workers-bus/src/schema-forms.ts`, `0124_schema_field_history.sql`): field key, type,
   validator + validator config, visibility rule + config, evidence class, retention policy,
   offline mode, read/write scope, and per-role read/write authority. Confirmed configurable via
   `/settings/configuration/fields`, live-tested end to end (dropdown, image, and multi-field
   composition all admin-reachable — see this issue's verdict table).
4. **Automation rules** — `pipeline_automation_rules`-equivalent domain
   (`workers-bus/src/pipeline-automation.ts`, `0123_pipeline_stage_automation.sql`,
   `0127_pipeline_automation_action_registry.sql`): trigger stage, action (from the registered
   action list), template reference, recipient reference. Confirmed configurable via
   `/settings/configuration/automations`.
5. **Document templates** — `document-templates.ts` (`0125_document_templates_and_generation.sql`)
   is a REQUIRED companion layer: an automation rule that generates-and-delivers a document is
   only meaningful with a template attached, and template authoring currently has **no admin UI
   at all** (see the "engineer-only" finding on the parent verdict — the automation rule builder's
   template picker only *selects* from existing templates; nothing in `app/` creates one). A
   template package's document layer cannot be captured as "what the admin configured," because
   nothing today lets the admin configure it. This is a **blocking gap**, not a detail — see
   "Missing prerequisite" below.
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
  inputs are a working precedent for this: instantiation already asks for the two identifiers a
  copy needs before committing.

Both of these are unbuilt. Nothing in the current admin surfaces treats a pipeline, field set, or
automation rule as a *referenceable, versioned unit* independent of the tenant that owns it — every
one of them is created directly inside a tenant's own rows. Templating would need a tenant-less
(or platform-tenant) catalog layer that the per-tenant admin surfaces read from, which is new
schema, not a UI feature on top of what exists.

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

## Missing prerequisite found during this audit (2026-08-28)

Document-template authoring (`workers-bus/src/schema-forms-api.ts`'s
`/api/v1/admin/document-templates/*` routes) has **no `app/` UI** — confirmed by reading
`app/src/admin/configuration-page.tsx` (exactly three configuration links: Pipelines, Fields,
Automations; no Documents) and `app/src/admin/automation-configuration-page.tsx` (the automation
rule builder's Template picker is a read-only `<select>` over an existing catalog — it cannot
create a new template). This means the "materials list" recipe Ilya specifically demonstrated
cannot be fully composed by an administrator today: the automation SIDE is configurable, but the
document CONTENT side needs a direct API call. Any template package that includes an automation
referencing a document template inherits this same gap — a template cannot travel with a document
template inside it until an admin can create one without a shell. This is reported as its own
finding on the parent Multica issue (ELEC-184) for the PO to route; it is repeated here because a
template catalog design would need to decide whether document templates are catalog content too
(most likely yes, since they are exactly the kind of "reusable, composable" unit templates exist
to carry).

## Non-goals of this document

- This is not a schema design. No table, migration, or API shape is proposed here.
- This is not a commitment to build templating in any specific milestone.
- This does not change IRO-209's non-goal status. It exists so that status stays an informed
  decision rather than a forgotten one.
