# Pipeline board card placement — as-built contract

Status: implemented source contract
Owner: IronWrap OS product owner
Last verified: 2026-08-29
Implementation: PR #209 (`5442e80b` on `main`)
Review trigger: changes to `AddToBoardDialog`, `boardPlacementOptions`, `placeCardOnPipeline`,
`handleCardPlacement`, or a record surface that exposes placement.

## Truth boundary

IronWrap has a product-UI path for placing leads and linked jobs onto configured pipeline boards.
The current entry point is the Sales Desk; the Worker remains authoritative for tenant, role,
pipeline, entity-type, entity-existence, stage, version, and idempotency checks.

This document records the behavior shipped in source and covered by repository tests. It is not a
deployment, business-acceptance, or customer-proof claim. Future changes listed below are gaps, not
features that may be presented as already implemented.

## Shipped user flow

1. Sales Desk loads the pipelines visible to the signed-in user.
2. Each lead row derives placeable entities: the lead and, when present, its linked job.
3. `boardPlacementOptions` pairs an entity only with a pipeline whose `entity_type` matches and
   whose server-provided `can_move` value is true.
4. The row renders **Add to board** only when at least one such pair exists.
5. The action always opens `AddToBoardDialog`. Even one eligible board is chosen through a dialog
   row; there is no one-board direct-submit shortcut.
6. Selecting a row posts the entity to that pipeline. The client deliberately omits `stage_key`, so
   the server selects the first active stage in position order.
7. Success stays in the dialog and offers **Open the board** or **Stay here**. The client invalidates
   cached pipeline lists and board reads.

The Production runway does not expose an Add-to-board action. A linked job can be placed from its
lead's Sales Desk dialog, while a Production job card currently exposes **Open job** only.

## Command and authority contract

The client calls:

```text
POST /api/v1/pipelines/{pipeline_id}/cards
idempotency-key: <client-generated key>

{
  "entity_type": "lead | job",
  "entity_id": "<tenant-owned entity id>"
}
```

`placeCardOnPipeline` supports an optional `stageKey` for reuse by a future surface, but the shipped
Sales Desk flow does not send it. `handleCardPlacement` and the store re-check authority; client
filtering is only an affordance filter and never substitutes for server enforcement.

The store derives the card id from tenant, pipeline, entity type, and entity id. Repeating the same
valid placement therefore cannot create a second card for that pair. A matching repeat is returned
as a replay. A conflicting idempotency fingerprint is refused rather than guessed at by the client.
The same entity may still be placed on a different compatible pipeline because the pipeline id is
part of the identity.

Initial placement has no origin stage. The existing transition undo route therefore cannot undo
placement, and there is no card-delete route. The UI does not present a false local undo.

## Dialog states and accessibility

`AddToBoardDialog` is portalled to `document.body`, renders as a bottom sheet on a phone and a
centered dialog from the `sm` breakpoint, and has `role="dialog"`, `aria-modal="true"`, and the
accessible name **Add to a board**.

Current interactions are:

- backdrop click and Escape close the dialog;
- the first enabled pipeline row receives focus when options load;
- ArrowDown and ArrowUp cycle through enabled pipeline rows;
- rows, close, **Open the board**, and **Stay here** use labelled controls with at least 44px touch
  targets;
- placement buttons are disabled while a placement is pending or the session is offline;
- offline, loading, load failure, no-option, server-refusal, replay/already-placed, and success
  states are narrated inside the dialog;
- offline placement is never queued on the device.

The dialog does not currently implement Home/End row navigation, a MoveToast-style success toast,
or a direct focus/scroll link to the new card. Its success link opens the role-appropriate board and
does not claim a stage name returned from a fresh board read.

## Zero-option behavior

On the Sales Desk, zero eligible pairs means **Add to board** is not rendered. The dialog also has a
**No board takes this yet** state because it refetches the pipeline list and can observe a stale or
changed configuration after the row action was derived, or be reused by another caller later.

That fallback does not make zero-option placement discoverable from the current row. Adding a
disabled/explanatory row action is a future product decision, not shipped behavior.

## Board empty state

The board renders configured stage columns and uses **No cards in this stage** for an empty column.
There is no whole-board onboarding panel or record-surface call to action today. Placement begins on
the Sales Desk rather than from a board-side entity search.

## Explicit future gaps

These items may be planned independently; none is implied by the shipped contract:

- placement directly from a Production job row;
- a discoverable explanation when a record has no compatible writable board;
- a whole-board empty-state panel linking back to the correct record surface;
- Home/End navigation and an independently verified focus trap for the placement dialog;
- success navigation to the exact card/stage rather than the board root;
- board-side record search and placement;
- governed placement undo or card removal;
- offline placement queuing.

Each gap needs its own authority, stale-state, accessibility, and test acceptance. In particular,
undo/removal and offline queuing require server/data contracts; they cannot be supplied honestly as
client-only affordances.

## Source and regression evidence

- `app/src/sales/sales-desk-page.tsx`: record entry point, lead/linked-job entities, and visibility
  guard.
- `app/src/pipeline/add-to-board-dialog.tsx`: dialog states, submit path, keyboard handling, offline
  refusal, and success navigation.
- `app/src/pipeline/pipeline-board-model.ts`: compatible writable-board filtering and refusal copy.
- `app/src/pipeline/pipeline-api.ts`: typed placement request and response parsing.
- `workers-bus/src/pipeline-board-api.ts` and `workers-bus/src/pipeline-board-store.ts`: authoritative
  placement, deterministic identity, replay/conflict, and active pipeline/stage enforcement.
- `app/src/pipeline/add-to-board-dialog.test.tsx` and
  `app/src/pipeline/pipeline-board-model.test.ts`: component and pure-model regression coverage.
- `app/e2e/pipeline-card-placement.spec.ts`: signed-in product-flow coverage through board readback.
- `workers-bus/test/pipeline-board-api.test.ts` and `workers-bus/test/pipeline-board-store.test.ts`:
  server contract and persistence invariants.

## Change rule

When the implementation changes, update this contract in the same reviewed slice. Keep shipped
behavior, planned deltas, hosted validation, deployment evidence, and customer proof separate.
