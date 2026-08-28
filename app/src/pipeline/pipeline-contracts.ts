import { z } from "zod";

/**
 * The pipeline board contract, transcribed from the architect's design (ELEC-155,
 * "Mobile-first read model" and "API route contract"). The server half ships on a
 * sibling task and lands in parallel with this surface, so these objects are
 * deliberately NOT `.strict()` the way the older read-model contracts are: an
 * additive field on the board payload must never blank a salesperson's board
 * mid-shift. Every field this surface actually renders is still validated, so drift
 * on the shape we depend on is still caught at the boundary rather than in a
 * component.
 *
 * `slot` and `format` are plain strings rather than enums for the same reason —
 * a card template that names a slot this build does not know yet renders the slots
 * it does know instead of failing the whole board.
 */

const nullableText = z.string().min(1).nullable();

const pipelineEnvelopeSchema = z.object({
  version: z.literal(1),
  source_updated_at: nullableText,
  read_model_generated_at: z.string().min(1),
  stale_fields: z.array(z.string()),
  permissions: z.array(z.string()),
  allowed_actions: z.array(z.string()),
});

export const cardTemplateBindingSchema = z.object({
  slot: z.string().min(1),
  label: nullableText.optional(),
  source_field: z.string().min(1),
  format: nullableText.optional(),
  limit: z.number().int().positive().optional(),
});

export const pipelineSummarySchema = z.object({
  pipeline_id: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  entity_type: z.string().min(1).optional(),
  owning_role: nullableText.optional(),
  position: z.number().int().nonnegative().optional(),
  /**
   * The server's own answer to "may this session move cards on this board" — it folds
   * `owning_role` AND the administrator-configured per-pipeline role grants (0122) into
   * one boolean, so the client never has to reconstruct the rule.  Optional because a
   * server that predates the grants still returns a readable list.
   */
  can_move: z.boolean().optional(),
  card_count: z.number().int().nonnegative().optional(),
  version: z.number().int().positive().optional(),
  card_template_json: z.array(cardTemplateBindingSchema).nullable().optional(),
});

export const pipelineListResponseSchema = pipelineEnvelopeSchema.extend({
  pipelines: z.array(pipelineSummarySchema),
});

export const boardStageSchema = z.object({
  stage_id: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  position: z.number().int().nonnegative(),
  is_won: z.boolean().optional(),
  is_lost: z.boolean().optional(),
  card_count: z.number().int().nonnegative().optional(),
  total_amount_cents: z.number().nullable().optional(),
  // Set by an administrator in M3; every M1-seeded stage carries null, which means
  // "anyone holding the pipeline's move permission may enter" (ELEC-155 section 4).
  min_role_to_enter: nullableText.optional(),
  /**
   * The server's decision on whether THIS session may move a card into this stage — it
   * already folds the move right and `min_role_to_enter` together
   * (`buildPipelineBoardReadModel`).  When present it wins over the client's mirror of
   * the same rule, so an administrator's stage restriction lands on the board without a
   * client release.
   */
  can_enter: z.boolean().optional(),
  color: nullableText.optional(),
});

/**
 * The card's display payload. `catchall` keeps fields this build does not name:
 * the card renderer reads slots out of it by the `source_field` its template
 * declares, so a Production board can bind a field no Sales card has.
 */
export const cardSummarySchema = z
  .object({
    title: z.string().min(1),
    amount_cents: z.number().nullable().optional(),
    identifiers: z
      .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
      .optional(),
    tags: z.array(z.string().min(1)).optional(),
    counters: z.array(z.object({ kind: z.string().min(1), count: z.number() })).optional(),
    is_won: z.boolean().optional(),
  })
  .catchall(z.unknown());

export const boardCardSchema = z.object({
  card_id: z.string().min(1),
  stage_id: z.string().min(1),
  position_in_stage: z.number().optional(),
  entity_type: z.string().min(1).optional(),
  entity_id: z.string().min(1).optional(),
  // The CAS token for a move. Optional only so a server that has not wired it into
  // the read model yet still renders a readable board; see the note in pipeline-api.ts.
  version: z.number().int().positive().optional(),
  summary: cardSummarySchema,
});

export const pipelineBoardResponseSchema = pipelineEnvelopeSchema.extend({
  pipeline: pipelineSummarySchema,
  stages: z.array(boardStageSchema),
  cards: z.array(boardCardSchema),
});

/**
 * What a committed transition (or undo) actually answers with, transcribed from
 * `transitionPayload` in `workers-bus/src/pipeline-board-api.ts`: a FLAT record, not a
 * nested card.  `card_version` is the card's version AFTER the move, and it is the value
 * the undo route demands back as its `expected_version` — without it the undo button is
 * a 400.  The older nested `card` shape stays optional so a server that still answers
 * that way keeps working.
 */
export const cardTransitionResponseSchema = z
  .object({
    transition_id: z.string().min(1).optional(),
    card_id: z.string().min(1).optional(),
    from_stage_id: nullableText.optional(),
    to_stage_id: z.string().min(1).optional(),
    safeguard: nullableText.optional(),
    card_version: z.number().int().positive().optional(),
    occurred_at: nullableText.optional(),
    undo_window_seconds: z.number().positive().optional(),
    replayed: z.boolean().optional(),
    card: z
      .object({
        card_id: z.string().min(1).optional(),
        stage_id: z.string().min(1).optional(),
        version: z.number().int().positive().optional(),
        stage_entered_at: nullableText.optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown());

export type CardTemplateBinding = z.infer<typeof cardTemplateBindingSchema>;
export type PipelineSummary = z.infer<typeof pipelineSummarySchema>;
export type PipelineListResponse = z.infer<typeof pipelineListResponseSchema>;
export type BoardStage = z.infer<typeof boardStageSchema>;
export type BoardCard = z.infer<typeof boardCardSchema>;
export type CardSummary = z.infer<typeof cardSummarySchema>;
export type PipelineBoardResponse = z.infer<typeof pipelineBoardResponseSchema>;
export type CardTransitionResponse = z.infer<typeof cardTransitionResponseSchema>;

/**
 * What `POST /api/v1/pipelines/{id}/cards` answers with, transcribed from
 * `handleCardPlacement` in `workers-bus/src/pipeline-board-api.ts`: a flat record of the card that
 * now exists, plus `replayed` — `false` on the 201 that created it, `true` on the 200 that found
 * the same entity already on this board. `card_id` is derived from
 * `(tenant, pipeline, entity_type, entity_id)`, which is why placing the same entity on the same
 * board twice is a replay rather than a second card.
 *
 * Non-strict for the same reason as the board payload: an additive field on the placement receipt
 * must never turn a committed placement into a client-side parse error.
 */
export const cardPlacementResponseSchema = z
  .object({
    card_id: z.string().min(1),
    pipeline_id: z.string().min(1).optional(),
    stage_id: z.string().min(1).optional(),
    entity_type: z.string().min(1).optional(),
    entity_id: z.string().min(1).optional(),
    card_version: z.number().int().positive().optional(),
    transition_id: nullableText.optional(),
    replayed: z.boolean().optional(),
  })
  .catchall(z.unknown());

export type CardPlacementResponse = z.infer<typeof cardPlacementResponseSchema>;
