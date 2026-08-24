/**
 * Generic pipeline board domain (IRO-209).
 *
 * Everything in this module is vertical-neutral and side-effect free: the card template grammar,
 * the safe-movement matrix, and the role rules that decide who may see or move a board.  Roofing
 * appears nowhere; the stakeholder's seven Sales stages are seed data
 * (`config/pipelines/sales-pipeline.v1.json`), and the field bindings behind a card reach the
 * database only through the named relations an entity-type adapter publishes.
 */

import type { AppRole, AuthContext } from "./app-types.ts";

/**
 * How long the server keeps accepting an undo for a transition (IRO-209 safeguard contract).
 * The UI offers its Undo affordance for a deliberately shorter 5s; the shorter window has to be
 * the client's, so a user who reaches for Undo at the last visible moment is never refused.
 */
export const PIPELINE_UNDO_WINDOW_MS = 30_000;

/** Gap left between cards inside a stage so a future drop-between can bisect without a rewrite. */
export const PIPELINE_CARD_POSITION_STEP = 10;

export type PipelineSafeguard = "direct" | "confirmed" | "undo";

export interface PipelineRecord {
  pipeline_id: string;
  tenant_id: string;
  key: string;
  name: string;
  entity_type: string;
  owning_role: string | null;
  card_template_json: string;
  is_template: number;
  template_source_id: string | null;
  is_active: number;
  position: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PipelineStageRecord {
  stage_id: string;
  tenant_id: string;
  pipeline_id: string;
  key: string;
  name: string;
  color: string | null;
  position: number;
  is_won: number;
  is_lost: number;
  min_role_to_enter: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PipelineCardRecord {
  card_id: string;
  tenant_id: string;
  pipeline_id: string;
  stage_id: string;
  entity_type: string;
  entity_id: string;
  position_in_stage: number;
  stage_entered_at: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PipelineTransitionRecord {
  transition_id: string;
  tenant_id: string;
  pipeline_id: string;
  card_id: string;
  from_stage_id: string | null;
  to_stage_id: string;
  actor_type: string;
  actor_id: string;
  safeguard: PipelineSafeguard;
  reason_code: string | null;
  correlation_id: string | null;
  command_fingerprint: string;
  idempotency_key_hash: string;
  card_version: number;
  occurred_at: string;
  created_at: string;
}

/* ------------------------------------------------------------------ card template ------ */

/**
 * A card template says which SLOTS a card renders and where each one reads from, using
 * `<relation>.<field>` paths.  Relation names (`entity`, `job`, `estimate`, `quote`, `stage`) are
 * published by the entity-type adapter, so a Production board declares a different identifier pair
 * and no service chips without one line of per-vertical branching in the read model.
 *
 * The designer's requirement (ELEC-156 section 6) is that the read model expose value / up to two
 * identifiers / a tag list / activity counters / a won flag WITHOUT hardcoding those field names
 * per vertical.  These slot kinds are that contract; the field names live in the template row.
 */
export type PipelineCardSlotKind =
  | "title"
  | "amount"
  | "identifier"
  | "tag"
  | "counter"
  | "won_flag";

export interface PipelineCardSlot {
  slot: PipelineCardSlotKind;
  /** Ordered source paths; the first one that resolves to a usable value wins. */
  sources: string[];
  /** Display label for an `identifier` slot (for example "Job"). */
  label: string | null;
  /** Counter kind for a `counter` slot (for example "messages"). */
  kind: string | null;
}

export interface PipelineCardTemplate {
  version: number;
  slots: PipelineCardSlot[];
}

const SLOT_KINDS: readonly PipelineCardSlotKind[] = [
  "title",
  "amount",
  "identifier",
  "tag",
  "counter",
  "won_flag",
];

const SOURCE_PATH = /^[a-z][a-z0-9_]{0,39}\.[a-z][a-z0-9_]{0,63}$/;

export class PipelineTemplateError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "PipelineTemplateError";
  }
}

/**
 * Parses a card template from untrusted JSON.  Used both by the read model (against the stored
 * `pipelines.card_template_json`) and by the seeder (against a template document on disk), so a
 * document that would render nothing is rejected before it reaches the database.
 */
export function parsePipelineCardTemplate(value: unknown): PipelineCardTemplate {
  const document = value as Record<string, unknown> | null;
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new PipelineTemplateError("pipeline_card_template_invalid");
  if (document.version !== 1)
    throw new PipelineTemplateError("pipeline_card_template_version_unsupported");
  const rawSlots = document.slots;
  if (!Array.isArray(rawSlots) || rawSlots.length === 0 || rawSlots.length > 24)
    throw new PipelineTemplateError("pipeline_card_template_slots_invalid");

  const slots = rawSlots.map((entry): PipelineCardSlot => {
    const slot = entry as Record<string, unknown> | null;
    if (!slot || typeof slot !== "object" || Array.isArray(slot))
      throw new PipelineTemplateError("pipeline_card_template_slot_invalid");
    const kind = slot.slot;
    if (typeof kind !== "string" || !SLOT_KINDS.includes(kind as PipelineCardSlotKind))
      throw new PipelineTemplateError("pipeline_card_template_slot_kind_invalid");
    const sources = normalizedSources(slot.source, slot.sources);
    if (kind === "identifier" && !boundedLabel(slot.label))
      throw new PipelineTemplateError("pipeline_card_template_identifier_label_required");
    if (kind === "counter" && !boundedLabel(slot.kind))
      throw new PipelineTemplateError("pipeline_card_template_counter_kind_required");
    return {
      slot: kind as PipelineCardSlotKind,
      sources,
      label: boundedLabel(slot.label),
      kind: boundedLabel(slot.kind),
    };
  });

  for (const singleton of ["title", "amount", "won_flag"] as const) {
    if (slots.filter((slot) => slot.slot === singleton).length > 1)
      throw new PipelineTemplateError("pipeline_card_template_slot_duplicated");
  }
  if (!slots.some((slot) => slot.slot === "title"))
    throw new PipelineTemplateError("pipeline_card_template_title_required");
  return { version: 1, slots };
}

/** Every relation a template reads from, so an adapter can batch exactly those lookups. */
export function templateRelations(template: PipelineCardTemplate): string[] {
  const relations = new Set<string>();
  for (const slot of template.slots)
    for (const source of slot.sources) relations.add(source.split(".")[0] as string);
  return [...relations].sort();
}

function normalizedSources(source: unknown, sources: unknown): string[] {
  const candidates = Array.isArray(sources)
    ? sources
    : typeof source === "string"
      ? [source]
      : null;
  if (!candidates || candidates.length === 0 || candidates.length > 8)
    throw new PipelineTemplateError("pipeline_card_template_source_invalid");
  return candidates.map((candidate) => {
    if (typeof candidate !== "string" || !SOURCE_PATH.test(candidate))
      throw new PipelineTemplateError("pipeline_card_template_source_invalid");
    return candidate;
  });
}

function boundedLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= 1 && text.length <= 40 ? text : null;
}

/* --------------------------------------------------------------------- card summary ------ */

export interface PipelineCardSummary {
  title: string;
  /** Absent, never `0`, when the card has no value to show (PO decision D4). */
  amount_cents?: number;
  identifiers: Array<{ label: string; value: string }>;
  tags: string[];
  counters: Array<{ kind: string; count: number }>;
  is_won: boolean;
}

export type PipelineRelationBag = Record<string, Record<string, unknown> | null>;

/**
 * Renders one card summary from its template and the relation bag its adapter resolved.
 * A slot whose sources all come back empty contributes nothing: no blank identifier line, no
 * fabricated `$0.00` (PO decisions D4 and D6).
 */
export function renderCardSummary(
  template: PipelineCardTemplate,
  relations: PipelineRelationBag,
  fallbackTitle: string,
): PipelineCardSummary {
  const summary: PipelineCardSummary = {
    title: fallbackTitle,
    identifiers: [],
    tags: [],
    counters: [],
    is_won: false,
  };
  for (const slot of template.slots) {
    switch (slot.slot) {
      case "title": {
        const title = resolveText(slot.sources, relations);
        if (title) summary.title = title;
        break;
      }
      case "amount": {
        const amount = resolveInteger(slot.sources, relations);
        if (amount !== null) summary.amount_cents = amount;
        break;
      }
      case "identifier": {
        const value = resolveText(slot.sources, relations);
        if (value && slot.label && summary.identifiers.length < 4)
          summary.identifiers.push({ label: slot.label, value });
        break;
      }
      case "tag": {
        const value = resolveText(slot.sources, relations);
        if (value && !summary.tags.includes(value) && summary.tags.length < 8)
          summary.tags.push(value);
        break;
      }
      case "counter": {
        const count = resolveInteger(slot.sources, relations);
        if (count !== null && slot.kind && summary.counters.length < 4)
          summary.counters.push({ kind: slot.kind, count });
        break;
      }
      case "won_flag": {
        summary.is_won = resolveBoolean(slot.sources, relations);
        break;
      }
    }
  }
  return summary;
}

function resolveRaw(source: string, relations: PipelineRelationBag): unknown {
  const separator = source.indexOf(".");
  const relation = relations[source.slice(0, separator)];
  return relation ? relation[source.slice(separator + 1)] : undefined;
}

function resolveText(sources: string[], relations: PipelineRelationBag): string | null {
  for (const source of sources) {
    const raw = resolveRaw(source, relations);
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    if (text.length > 0) return text.slice(0, 160);
  }
  return null;
}

function resolveInteger(sources: string[], relations: PipelineRelationBag): number | null {
  for (const source of sources) {
    const raw = resolveRaw(source, relations);
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const value = Math.trunc(raw);
    if (value >= 0) return value;
  }
  return null;
}

function resolveBoolean(sources: string[], relations: PipelineRelationBag): boolean {
  for (const source of sources) {
    const raw = resolveRaw(source, relations);
    if (raw === true || raw === 1) return true;
    if (raw === false || raw === 0 || raw === null) continue;
  }
  return false;
}

/* -------------------------------------------------------------------- safe movement ------ */

export type PipelineMoveJump = "backward" | "skip" | "restricted";

export type PipelineSafeguardDecision =
  | { outcome: "allowed"; safeguard: Exclude<PipelineSafeguard, "undo"> }
  | { outcome: "confirmation_required"; jump: PipelineMoveJump }
  | { outcome: "stage_entry_role_required"; requiredRole: string }
  | { outcome: "noop" };

/**
 * The safe-movement matrix, decided once and enforced before anything commits.
 *
 * PO decision D2 narrows the architect's draft: a move that is forward by exactly one stage is
 * always direct, INCLUDING into a stage flagged won or lost, because on the stakeholder's board
 * that is the ordinary move a salesperson makes all day and they asked for drag-and-drop to be
 * direct.  Undo (D1) is the accident protection there, not a dialog.  Confirmation is reserved for
 * backward, skip-ahead, and role-restricted stages.
 *
 * `stageOrder` is the board's ordered stage list; adjacency is index distance, not raw position.
 */
export function evaluateSafeguard(input: {
  stageOrder: readonly PipelineStageRecord[];
  fromStageId: string;
  toStageId: string;
  actorRole: AppRole;
  confirmed: boolean;
}): PipelineSafeguardDecision {
  const fromIndex = input.stageOrder.findIndex((stage) => stage.stage_id === input.fromStageId);
  const toIndex = input.stageOrder.findIndex((stage) => stage.stage_id === input.toStageId);
  if (fromIndex < 0 || toIndex < 0) return { outcome: "noop" };
  if (fromIndex === toIndex) return { outcome: "noop" };

  const target = input.stageOrder[toIndex] as PipelineStageRecord;
  const requiredRole = target.min_role_to_enter?.trim() || null;
  if (requiredRole && !satisfiesStageRole(input.actorRole, requiredRole))
    return { outcome: "stage_entry_role_required", requiredRole };

  const jump: PipelineMoveJump | null = requiredRole
    ? "restricted"
    : toIndex < fromIndex
      ? "backward"
      : toIndex > fromIndex + 1
        ? "skip"
        : null;
  if (!jump) return { outcome: "allowed", safeguard: "direct" };
  if (!input.confirmed) return { outcome: "confirmation_required", jump };
  return { outcome: "allowed", safeguard: "confirmed" };
}

/**
 * A restricted stage names the one role allowed in.  The owner is the account's superset role and
 * always satisfies it; no new fine-grained permission set ships in M1 (PO decision D8), so this
 * stays a role comparison rather than a `pipeline:*` capability lookup.
 */
export function satisfiesStageRole(actorRole: AppRole, requiredRole: string): boolean {
  return actorRole === "owner" || actorRole === requiredRole.trim().toLowerCase();
}

/* ------------------------------------------------------------------- board access ------ */

/** Roles that read every pipeline in the tenant regardless of who owns it. */
const CROSS_PIPELINE_READ_ROLES: readonly AppRole[] = ["owner", "ops"];

/**
 * Board visibility, role-scoped through `pipelines.owning_role` (PO decision D8).
 *
 * `field` has no board at all and falls out here because it holds no office read permission: a
 * crew member's surface is their task list, not a Sales pipeline (ELEC-156 section 4).  Accounting
 * keeps its money-exception and QuickBooks surfaces and gets no board in M1 (D10), which is what
 * an unmatched `owning_role` already produces.
 */
export function canViewPipeline(auth: AuthContext, pipeline: PipelineRecord): boolean {
  if (!auth.permissions.includes("now:read")) return false;
  const role = auth.session.role;
  if (CROSS_PIPELINE_READ_ROLES.includes(role)) return true;
  return pipeline.owning_role !== null && pipeline.owning_role === role;
}

/**
 * Move rights.  `ops` reads every board and moves nothing on it, matching the posture it already
 * has on the production runway and the money desk (`ROLE_PERMISSIONS` in app-types.ts).
 */
export function canMoveCards(auth: AuthContext, pipeline: PipelineRecord): boolean {
  if (!canViewPipeline(auth, pipeline)) return false;
  const role = auth.session.role;
  return role === "owner" || (pipeline.owning_role !== null && pipeline.owning_role === role);
}

/** The transition actor vocabulary the audit table accepts, from the acting session's role. */
export function transitionActorType(role: AppRole): "owner" | "worker" {
  return role === "owner" ? "owner" : "worker";
}
