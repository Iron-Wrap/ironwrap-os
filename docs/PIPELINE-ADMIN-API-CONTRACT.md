# Pipeline administration API contract

Status: source-level route contract
Owner: IronWrap OS product owner
Last verified: 2026-08-26
Review trigger: any change to `workers-bus/src/pipeline-board-api.ts` administration routes, their
store commands, or `workers-bus/migrations/0122_pipeline_admin_configuration.sql`

## Truth boundary

This page is the request/response contract for `/api/v1/admin/pipelines`, the surface an
administrator configures pipelines through. It exists so the PWA can be built against a written
shape rather than against a reading of the handler. Exact dispatch, validation order and status
codes live in `workers-bus/src/pipeline-board-api.ts`; the D1 commands live in
`workers-bus/src/pipeline-board-store.ts`; the schema lives in
`workers-bus/migrations/0113_pipeline_board_core.sql` and `0122_pipeline_admin_configuration.sql`.

A route in source is only **Implemented**. Use
[`CAPABILITY-MATRIX.md`](CAPABILITY-MATRIX.md) for current implementation gaps and
[`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](AUTHORITY-AND-EVIDENCE-CONTRACT.md) for the proof boundary.

## What the surface is for

Every board a company runs — sales, production and shop, commercial projects, material resale, one
per office — is data an administrator creates and reshapes. Nothing about a board is code: stage
names, colours, order, won/lost flags, entry restrictions, card templates, entity types and role
scope are all rows. There is no cap on how many pipelines a tenant may hold.

## Rules that hold on every route here

1. **Authority.** The account owner is the administrator (`canAdministerPipelines`). Every other
   role, including `ops`, is refused with `pipeline_admin_forbidden` (403) before any path is
   matched against a real row, so an unauthorized session cannot map the tenant by probing ids.
2. **Method and CSRF.** Reads are `GET`; every command is `POST` with the `x-csrf-token` header.
   `POST` was chosen over `PATCH`/`DELETE` because the Worker's CORS policy admits
   `GET, POST, PUT, DELETE, OPTIONS` and the rest of the administration surface
   (`/api/v1/admin/app-users/:id/role`, `/access`, `/user-invites/:id/revoke`) is already `POST`.
3. **One version per board.** The pipeline row's `version` is the concurrency token for its whole
   configuration — the board, its stages and its role grants. Every command carries
   `expected_version`; a stale one is refused with `pipeline_version_conflict` (409) carrying
   `pipeline_version` (the value the caller should have held). The store makes the event receipt an
   in-batch assertion, so a zero-row CAS cannot be discovered only after earlier statements have
   committed: a failed proof aborts the D1 batch and leaves the aggregate, dependent rows and
   evidence unchanged.
4. **Tenant isolation.** Every query binds the session's tenant. Another tenant's board answers
   `not_found` (404) on every route, read and write alike.
5. **Body limit.** 32 KiB; a card template normalises to at most 8 KiB.
6. **Server-owned roles.** `owning_role`, stage `min_role_to_enter`, and every role grant must be
   one of the roles returned by `GET /api/v1/admin/pipelines`; unknown role-shaped strings fail
   closed with `pipeline_role_unknown`.
7. **Errors** are `{ "error": "<code>", ...detail }`. Codes are listed per route and collected at
   the end.

## Reads

### `GET /api/v1/admin/pipelines`

Everything the administration screen needs in one request, archived boards and copy templates
included.

```json
{
  "version": 1,
  "entity_types": [{ "entity_type": "job", "label": "Job" },
                   { "entity_type": "lead", "label": "Lead" }],
  "roles": ["owner", "ops", "sales", "production", "accounting", "field"],
  "stage_limit": 200,
  "pipelines": [
    {
      "pipeline_id": "pl_<40 hex>",
      "key": "sales",
      "name": "Sales",
      "entity_type": "lead",
      "owning_role": "sales",
      "is_active": true,
      "is_template": false,
      "template_source_id": null,
      "position": 0,
      "version": 1,
      "card_count": 14,
      "card_template": { "version": 1, "slots": [] },
      "stages": [
        {
          "stage_id": "pls_<40 hex>",
          "key": "new_lead",
          "name": "New Lead",
          "color": "slate",
          "position": 0,
          "is_won": false,
          "is_lost": false,
          "min_role_to_enter": null,
          "is_active": true,
          "card_count": 3,
          "updated_at": "2026-08-26T10:00:00.000Z"
        }
      ],
      "role_grants": [{ "role": "production", "can_write": false }],
      "updated_at": "2026-08-26T10:00:00.000Z"
    }
  ]
}
```

`entity_types` and `roles` are **server-owned vocabularies**. Render the choosers from them; do not
hardcode either list, or a module that registers a new entity type will need a UI release to become
selectable. `entity_types[].label` is generic business vocabulary and safe to show as-is.

Stages are returned live-first, then archived, each in `position` order. An archived stage
(`is_active: false`) appears here and nowhere else — it is off every board route.

## Commands

Every command below returns the **full pipeline object** (the same shape as one `pipelines[]`
entry) under `pipeline`, re-read after the write, so the caller's next command carries the version
this one produced instead of guessing at it.

### `POST /api/v1/admin/pipelines` — create

```json
{
  "key": "shop_production",
  "name": "Shop production",
  "entity_type": "job",
  "owning_role": "production",
  "position": 3,
  "is_template": false,
  "card_template": { "version": 1, "slots": [{ "slot": "title", "sources": ["entity.contact_name"] }] },
  "stages": [
    { "key": "queued", "name": "Queued", "color": "slate" },
    { "key": "cutting", "name": "Cutting", "color": "sky" },
    { "key": "ready", "name": "Ready", "color": "emerald", "is_won": true }
  ],
  "role_grants": [{ "role": "ops", "can_write": true }]
}
```

`key`, `name`, `entity_type`, `card_template` and a non-empty `stages` are required;
`owning_role` (default `null`), `position` (default: after the last board), `is_template`
(default `false`) and `role_grants` (default `[]`) are optional. Stage `position` is the array
index. → **201** `{ "pipeline": { ... } }`.

`key` matches `^[a-z0-9_]{1,60}$` and is immutable for the life of the board (enforced by
`pipelines_identity_guard`), so an automation rule or a saved view keyed on it survives a rename.
Derive it client-side from the name and let the administrator correct it before submitting — that
is the only moment it is editable.

Blockers: `pipeline_key_exists` (409), `pipeline_entity_type_unknown` (400, echoes
`entity_types`), `pipeline_stages_required` (400), `pipeline_stage_key_duplicated` (409),
`pipeline_stage_won_and_lost` (400), `pipeline_card_template_*` (400), `invalid_pipeline_*` (400).

### `POST /api/v1/admin/pipelines/{pipeline_id}` — rename, reposition, re-scope, archive

```json
{ "expected_version": 3, "name": "Sales — Calgary", "position": 1,
  "owning_role": "sales", "is_active": false, "card_template": { "version": 1, "slots": [] } }
```

Only `expected_version` is required; an omitted field keeps its stored value. `owning_role: null`
clears the owner (send the key explicitly to clear it; omitting it leaves it alone). `is_active:
false` archives the board: it disappears from `GET /api/v1/pipelines` and every
`/api/v1/pipelines/{id}/…` route answers 404, for the owner too. `is_active: true` restores it.
`key`, `entity_type` and `template_source_id` cannot be changed. → **200**.

### `POST /api/v1/admin/pipelines/order` — reorder boards

```json
{ "pipelines": [{ "pipeline_id": "pl_…", "expected_version": 2 },
                { "pipeline_id": "pl_…", "expected_version": 1 }] }
```

The array is the intended order; array index becomes `position`. Every named board must exist in
the tenant, present its own current version, and the array must contain every administrator-visible
board exactly once. A partial order is refused before the write batch opens. → **200**
`{ "pipelines": [ ... ] }`.

Blockers: `invalid_pipeline_order` (400), `not_found` (404), `pipeline_order_incomplete` (409),
`pipeline_version_conflict` (409).

### `POST /api/v1/admin/pipelines/{pipeline_id}/copy` — duplicate

```json
{ "key": "sales_second_office", "name": "Sales — second office",
  "position": 4, "owning_role": "sales", "is_template": false, "copy_role_grants": true }
```

`key` and `name` are required. **Copies**: stage keys, names, colours, order, won/lost flags,
`min_role_to_enter`; the card template; the entity type; the owning role (unless overridden); the
role grants (unless `copy_role_grants: false`, in which case `role_grants` from the body is used).
**Never copies**: cards, transition history, card counts — the new board starts empty.

The copy is a normal, independently editable pipeline from the moment it exists.
`template_source_id` records where its stage list came from and nothing follows that edge: editing
the copy can never reach back into the original. → **201**.

Blockers: `pipeline_key_exists` (409), `not_found` (404), `pipeline_stages_required` (409).

### `POST /api/v1/admin/pipelines/{pipeline_id}/stages` — add a stage

```json
{ "expected_version": 3, "key": "site_visit", "name": "Site visit",
  "color": "amber", "is_won": false, "is_lost": false, "min_role_to_enter": "ops" }
```

The stage is appended after the last live stage; reorder afterwards. → **201**
`{ "stage": { ... }, "pipeline": { ... } }`.

Blockers: `pipeline_stage_key_exists` (409 — including against an *archived* stage holding that
key; restore it instead), `pipeline_stage_limit_reached` (409, echoes `stage_limit`),
`pipeline_stage_won_and_lost` (400), `invalid_pipeline_stage_*` (400).

### `POST /api/v1/admin/pipelines/{pipeline_id}/stages/{stage_id}` — rename, recolour, restore

```json
{ "expected_version": 4, "name": "On-site visit", "color": "info",
  "is_won": false, "is_lost": false, "min_role_to_enter": null, "is_active": true }
```

Only `expected_version` is required; an omitted field keeps its stored value. `is_active: true` on
an archived stage restores it to the board. A stage `key` is immutable. → **200**
`{ "stage": { ... }, "pipeline": { ... } }`.

### `POST /api/v1/admin/pipelines/{pipeline_id}/stages/order` — reorder stages

```json
{ "expected_version": 5, "stage_ids": ["pls_…", "pls_…", "pls_…"] }
```

`stage_ids` must name **every live stage exactly once**; a partial list is refused rather than
silently applied. Array index becomes `position`. → **200** `{ "stages": [ ... ], "pipeline": {} }`.

Board adjacency — the "forward by exactly one stage" rule behind safe card movement — is the
ordered index of this live list, so a reorder genuinely changes which moves need a confirmation.

Blockers: `pipeline_stage_order_incomplete` (409, echoes `expected_stage_ids`),
`invalid_pipeline_stage_order` (400).

### `POST /api/v1/admin/pipelines/{pipeline_id}/stages/{stage_id}/remove` — remove a stage

```json
{ "expected_version": 6, "move_cards_to_stage_id": "pls_…" }
```

→ **200** `{ "outcome": "archived" | "deleted", "moved_cards": 6, "stages": [ ... ], "pipeline": {} }`.

Three behaviours the UI has to render:

- **The stage holds cards and no destination was named** → refused, 409
  `pipeline_stage_has_cards` with `card_count` and `available_stage_ids`. Show the count, offer the
  destinations, resend with `move_cards_to_stage_id`.
- **A destination was named** → the re-home and the removal commit in one batch; there is never a
  moment where the column is gone and the work is nowhere. Each moved card gets its own
  append-only transition row (`reason_code: "stage_removed"`, `safeguard: "confirmed"`). No
  automation-outbox row is written: reshaping a board is a configuration change, not work moving
  through the business.
- **`outcome`** is `"archived"` when the append-only trail already names the stage (it cannot be
  deleted without destroying evidence) and `"deleted"` when nothing ever touched it. Either way it
  is off the board.

The stage leaves the board only if it is empty at commit time. A card that arrived between the
command being accepted and the batch committing is refused with `pipeline_stage_changed` (409)
rather than stranded in a column nobody can see; re-read the board and retry.

Blockers: `pipeline_stage_last_remaining` (409 — a board with no stages is not a board; add another
stage or archive the whole pipeline), `pipeline_stage_destination_invalid` (409, echoes
`available_stage_ids`), `pipeline_stage_has_cards` (409), `not_found` (404).

### `POST /api/v1/admin/pipelines/{pipeline_id}/roles` — per-pipeline role scope

```json
{ "expected_version": 7,
  "grants": [{ "role": "production", "can_write": false }, { "role": "ops", "can_write": true }] }
```

**Replace, not merge**: the list is the complete scope, and sending `[]` revokes every grant. A
grant row *is* read access; `can_write` adds card movement on top. More than one role per pipeline
is supported by the schema from day one. → **200** `{ "pipeline": { ... } }`.

Blockers: `pipeline_role_unknown` (400, echoes `roles`), `pipeline_role_grant_duplicated` (409),
`invalid_pipeline_role_grants` (400).

## How role scope resolves on the board routes

Deny by default, in this order:

1. No `now:read` permission → nothing. (`field` never reaches a board.)
2. Pipeline archived or a copy template → nothing, for every role.
3. `owner` and `ops` read every live board in the tenant.
4. The pipeline's `owning_role` equals the session role → read and move.
5. A grant names the session role → read; move only if `can_write` is true.
6. Otherwise → **the empty state**, never a widened view. This is the fail-closed shape PR #171
   established, and it holds on the pipeline list, the board read, card placement, transitions and
   undo alike.

`owning_role` remains the primary, single-role scope the administration UI edits first; grants are
the additive multi-role extension beside it. A board with no grants behaves exactly as it did
before 0122.

## Evidence

Every command writes one row to `pipeline_configuration_events` in the same D1 batch as the change
it describes — action, actor role, actor id, the pipeline version it landed on, and a JSON detail
blob. The table refuses `UPDATE` and `DELETE`. Detail JSON is bounded at 4,000 characters. A stage
reorder that would exceed that bound stores `{ "order_count": N, "order_sha256": "<sha256>" }`,
which is valid JSON and still proves the exact submitted order without slicing a serialized array.
No route exposes the event table yet; it is there so "who archived my board" is answerable from D1
rather than reconstructed from a diff. For a stale or failed dependent mutation, the receipt's
in-batch proof fails and the whole D1 batch rolls back; no event is written.

Card templates resolve through explicit adapter projections, not arbitrary table columns. The
published board-safe fields are the identity/contact/status fields needed by the template, job and
estimate identifiers/status/value fields, and quote total/status/revision fields. Raw payloads,
source pointers, provider metadata and evidence fields are not exposed through relation bags.

## Codes

| Code | Status | Meaning |
| --- | --- | --- |
| `pipeline_admin_forbidden` | 403 | The session is not the administrator |
| `csrf_failed` | 403 | Missing or wrong `x-csrf-token` |
| `not_found` | 404 | No such board or stage **in this tenant** |
| `expected_version_required` | 400 | The command carried no usable `expected_version` |
| `pipeline_version_conflict` | 409 | Stale write; echoes `pipeline_version` |
| `pipeline_key_exists` | 409 | The tenant already has a board with that key |
| `pipeline_entity_type_unknown` | 400 | Not in the entity-type registry; echoes `entity_types` |
| `pipeline_stages_required` | 400/409 | A board needs at least one stage |
| `pipeline_stage_key_exists` | 409 | Live or archived stage already holds that key |
| `pipeline_stage_key_duplicated` | 409 | The submitted stage list repeats a key |
| `pipeline_stage_limit_reached` | 409 | `stage_limit` live stages already exist |
| `pipeline_stage_won_and_lost` | 400 | A stage cannot be both |
| `pipeline_stage_order_incomplete` | 409 | Order did not name every live stage exactly once |
| `pipeline_order_incomplete` | 409 | Board order did not name every administrator-visible board exactly once |
| `pipeline_stage_has_cards` | 409 | Echoes `card_count` and `available_stage_ids` |
| `pipeline_stage_destination_invalid` | 409 | Destination is not another live stage of this board |
| `pipeline_stage_last_remaining` | 409 | Cannot remove the only stage |
| `pipeline_stage_changed` | 409 | The stage gained a card between accepting the command and committing it; re-read and retry |
| `pipeline_role_unknown` | 400 | Not an account role; echoes `roles` |
| `pipeline_role_grant_duplicated` | 409 | The submitted grant list repeats a role |
| `pipeline_configuration_detail_too_large` | 400 | The command's bounded evidence detail could not be represented safely |
| `pipeline_card_template_*` | 400 | Card template failed the shared parser |
| `invalid_pipeline_*` | 400 | Field failed validation |
| `payload_too_large` | 413 | Body over 32 KiB |
