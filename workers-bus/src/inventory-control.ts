import { sha256Hex } from "./app-auth.ts";
import type { AppEnv } from "./app-types.ts";

/**
 * IRO-45 inventory control ledger.
 *
 * D1 owns the command/event/position ledger. Every material change is written as one
 * command, one or more equal-and-opposite movements, and the exact projection update the
 * movements imply. The 0046 triggers are the structural backstop; this module refuses the
 * same conditions earlier with a stable machine-readable code so a caller learns *why*
 * rather than seeing a raw constraint abort.
 *
 * Quantities are scaled integers and money is minor units throughout. There is no float
 * arithmetic and no tolerance anywhere in this file.
 */

export const INVENTORY_TRANSITIONS = [
  "receive",
  "reserve",
  "release_reservation",
  "issue_use",
  "return",
  "transfer",
  "quarantine",
  "release_quarantine",
  "count_freeze",
  "count_adjustment",
  "yield",
  "reversal",
] as const;

export type InventoryTransition = (typeof INVENTORY_TRANSITIONS)[number];

/** Transitions whose movements must net to exactly zero quantity. */
const QUANTITY_CONSERVING = new Set<InventoryTransition>([
  "transfer",
  "yield",
  "reversal",
  "reserve",
  "release_reservation",
  "quarantine",
  "release_quarantine",
  "count_freeze",
]);

/** Transitions where value travels with the goods and must also net to zero. */
const VALUE_CONSERVING = new Set<InventoryTransition>(["transfer", "yield", "reversal"]);

export type InventoryCommandStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "conflict"
  | "reconciliation_required";

export type InventoryActorType =
  | "agent"
  | "worker"
  | "customer"
  | "external_authority"
  | "device"
  | "owner";

export interface InventoryCommand {
  command_id: string;
  tenant_id: string;
  transition: InventoryTransition;
  actor_type: InventoryActorType;
  actor_user_id: string;
  authority_ref: string;
  policy_ref: string;
  policy_version: string;
  idempotency_key_sha256: string;
  request_fingerprint_sha256: string;
  approval_id: string | null;
  evidence_refs_json: string;
  payload_json: string;
  status: InventoryCommandStatus;
  result_json: string | null;
  rejection_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface InventoryPosition {
  position_id: string;
  tenant_id: string;
  item_id: string;
  lot_id: string;
  bin_id: string;
  job_custody: string;
  uom_id: string;
  quantity_scaled: number;
  reserved_scaled: number;
  quarantined_scaled: number;
  value_minor: number;
  currency: string;
  version: number;
  last_event_id: string;
  created_at: string;
  updated_at: string;
}

export interface InventoryValuationLayer {
  layer_id: string;
  tenant_id: string;
  item_id: string;
  lot_id: string;
  source_event_id: string;
  layer_kind: "receipt" | "return" | "remnant" | "adjustment" | "correction";
  quantity_scaled: number;
  remaining_scaled: number;
  unit_cost_minor: number;
  value_minor: number;
  method: "actual" | "fifo";
  created_at: string;
}

/** One movement of one position. Deltas are signed and are the only source of change. */
export interface InventoryMovement {
  positionId: string;
  itemId: string;
  lotId: string;
  binId: string;
  uomId: string;
  jobCustody: string;
  quantityDelta: number;
  reservedDelta?: number;
  quarantinedDelta?: number;
  valueDelta?: number;
  currency?: string;
  evidenceRefs?: readonly EvidenceRef[];
  payload?: Record<string, unknown>;
}

export interface EvidenceRef {
  ref: string;
  sha256: string;
}

/** An inbound movement that creates cost, i.e. a new valuation layer. */
export interface InventoryLayerInput {
  layerId: string;
  movementIndex: number;
  layerKind: "receipt" | "return" | "remnant" | "adjustment";
  unitCostMinor: number;
  freightMinor?: number;
  taxMinor?: number;
  discountMinor?: number;
}

/** An outbound movement draws named layers; the sum must equal the outbound quantity. */
export interface InventoryAllocationInput {
  allocationId: string;
  movementIndex: number;
  layerId: string;
  quantityScaled: number;
}

export interface ApplyInventoryCommandInput {
  commandId: string;
  tenantId: string;
  transition: InventoryTransition;
  actorType: InventoryActorType;
  actorUserId: string;
  authorityRef: string;
  policyRef: string;
  policyVersion: string;
  idempotencyKey: string;
  requestFingerprintSha256: string;
  approvalId?: string | null;
  evidenceRefs: readonly EvidenceRef[];
  payload: Record<string, unknown>;
  movements: readonly InventoryMovement[];
  layers?: readonly InventoryLayerInput[];
  allocations?: readonly InventoryAllocationInput[];
  /** Extra rows written atomically with the command, e.g. receipt or reservation rows. */
  companions?: readonly InventoryCompanionStatement[];
  now: string;
}

export interface InventoryCompanionStatement {
  sql: string;
  params: readonly unknown[];
}

export type ApplyInventoryCommandResult =
  | { kind: "applied"; command: InventoryCommand; eventIds: string[] }
  | { kind: "replayed"; command: InventoryCommand; eventIds: string[] }
  | { kind: "conflict"; command: InventoryCommand }
  | { kind: "rejected"; command: InventoryCommand; code: string };

export class InventoryLedgerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "InventoryLedgerError";
  }
}

const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const POSITION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,239}$/;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,139}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{7,255}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const CUSTODY = /^[^\u0000-\u001f]{1,160}$/;

/** The shared, uncommitted tenant pool. Job custody is always an explicit string. */
export const SHARED_CUSTODY = "-";

/**
 * Convert an exact scaled quantity through a versioned rational conversion.
 * A conversion that does not land on an exact integer is refused, never rounded:
 * an unexplained remainder is precisely the tolerance this ledger must not have.
 */
export function convertQuantity(
  quantityScaled: number,
  numerator: number,
  denominator: number,
): number {
  if (!Number.isSafeInteger(quantityScaled)) {
    throw new InventoryLedgerError("inventory_quantity_not_integer");
  }
  if (!Number.isSafeInteger(numerator) || numerator <= 0 ||
      !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new InventoryLedgerError("inventory_uom_conversion_invalid");
  }
  const scaled = quantityScaled * numerator;
  if (!Number.isSafeInteger(scaled)) {
    throw new InventoryLedgerError("inventory_quantity_overflow");
  }
  if (scaled % denominator !== 0) {
    throw new InventoryLedgerError("inventory_uom_conversion_inexact");
  }
  return scaled / denominator;
}

/** Resolve the current active conversion between two units, newest version first. */
export async function activeUomConversion(
  env: AppEnv,
  tenantId: string,
  fromUomId: string,
  toUomId: string,
): Promise<{ numerator: number; denominator: number; version: number } | null> {
  if (!TENANT_ID.test(tenantId)) return null;
  return await env.DB.prepare(
    `SELECT numerator, denominator, version
       FROM inventory_uom_conversions
      WHERE tenant_id = ? AND from_uom_id = ? AND to_uom_id = ? AND status = 'active'
      ORDER BY version DESC
      LIMIT 1`,
  ).bind(tenantId, fromUomId, toUomId).first<{
    numerator: number;
    denominator: number;
    version: number;
  }>();
}

/**
 * FIFO draw for a commodity item, or the lot's own actual-cost layer for a lot-controlled
 * item. Returns null when the available layers cannot cover the quantity, because an
 * uncovered issue must be refused rather than valued at an invented cost.
 */
export async function planValuationDraw(
  env: AppEnv,
  input: {
    tenantId: string;
    itemId: string;
    lotId: string;
    quantityScaled: number;
    method: "actual" | "fifo";
  },
): Promise<{ layerId: string; quantityScaled: number; unitCostMinor: number }[] | null> {
  if (input.quantityScaled <= 0) return null;
  const layers = input.method === "actual"
    ? await env.DB.prepare(
        `SELECT layer_id, remaining_scaled, unit_cost_minor
           FROM inventory_valuation_layers
          WHERE tenant_id = ? AND item_id = ? AND lot_id = ? AND remaining_scaled > 0
          ORDER BY created_at ASC, layer_id ASC`,
      ).bind(input.tenantId, input.itemId, input.lotId)
        .all<{ layer_id: string; remaining_scaled: number; unit_cost_minor: number }>()
    : await env.DB.prepare(
        `SELECT layer_id, remaining_scaled, unit_cost_minor
           FROM inventory_valuation_layers
          WHERE tenant_id = ? AND item_id = ? AND remaining_scaled > 0
          ORDER BY created_at ASC, layer_id ASC`,
      ).bind(input.tenantId, input.itemId)
        .all<{ layer_id: string; remaining_scaled: number; unit_cost_minor: number }>();

  const draw: { layerId: string; quantityScaled: number; unitCostMinor: number }[] = [];
  let outstanding = input.quantityScaled;
  for (const layer of layers.results) {
    if (outstanding === 0) break;
    const take = Math.min(outstanding, layer.remaining_scaled);
    if (take <= 0) continue;
    draw.push({
      layerId: layer.layer_id,
      quantityScaled: take,
      unitCostMinor: layer.unit_cost_minor,
    });
    outstanding -= take;
  }
  return outstanding === 0 ? draw : null;
}

/**
 * Apply one inventory command atomically.
 *
 * The whole command is one D1 batch: either every movement, projection update, valuation
 * row and companion row commits, or none does. A partially applied movement would be
 * exactly the phantom stock this ledger exists to prevent.
 */
export async function applyInventoryCommand(
  env: AppEnv,
  input: ApplyInventoryCommandInput,
): Promise<ApplyInventoryCommandResult> {
  validateCommandInput(input);
  const idempotencyHash = await sha256Hex(`${input.tenantId}\n${input.idempotencyKey}`);
  const existing = await commandByIdempotency(env, input.tenantId, idempotencyHash);
  if (existing) {
    if (existing.request_fingerprint_sha256 !== input.requestFingerprintSha256 ||
        existing.transition !== input.transition) {
      return { kind: "conflict", command: existing };
    }
    if (existing.status === "rejected") {
      return {
        kind: "rejected",
        command: existing,
        code: existing.rejection_code ?? "inventory_command_rejected",
      };
    }
    return {
      kind: "replayed",
      command: existing,
      eventIds: await eventIdsForCommand(env, existing.command_id),
    };
  }

  const plan = await planMovements(env, input);
  if (!plan.ok) {
    const rejected = await persistRejectedCommand(env, input, idempotencyHash, plan.code);
    return { kind: "rejected", command: rejected, code: plan.code };
  }

  const statements = [
    insertCommandStatement(env, input, idempotencyHash),
    ...plan.statements,
    env.DB.prepare(
      `UPDATE inventory_commands
          SET status = 'applied', result_json = ?, updated_at = ?, completed_at = ?
        WHERE tenant_id = ? AND command_id = ? AND status = 'pending'`,
    ).bind(
      JSON.stringify({
        movements: plan.eventIds.length,
        quantity_delta_total: plan.quantityTotal,
        value_delta_total: plan.valueTotal,
      }),
      input.now,
      input.now,
      input.tenantId,
      input.commandId,
    ),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    // A trigger abort here means the structural invariant caught something this module
    // did not. Surface the exact code; never fall back to a partial write.
    throw new InventoryLedgerError(triggerCode(error));
  }

  const command = await commandById(env, input.tenantId, input.commandId);
  if (!command) throw new InventoryLedgerError("inventory_command_missing_after_apply");
  return { kind: "applied", command, eventIds: plan.eventIds };
}

interface MovementPlan {
  ok: true;
  statements: D1PreparedStatement[];
  eventIds: string[];
  quantityTotal: number;
  valueTotal: number;
}

async function planMovements(
  env: AppEnv,
  input: ApplyInventoryCommandInput,
): Promise<MovementPlan | { ok: false; code: string }> {
  const quantityTotal = input.movements.reduce((sum, move) => sum + move.quantityDelta, 0);
  const valueTotal = input.movements.reduce((sum, move) => sum + (move.valueDelta ?? 0), 0);
  const reservedTotal = input.movements.reduce((sum, move) => sum + (move.reservedDelta ?? 0), 0);
  const quarantinedTotal = input.movements.reduce(
    (sum, move) => sum + (move.quarantinedDelta ?? 0),
    0,
  );

  if (QUANTITY_CONSERVING.has(input.transition) && quantityTotal !== 0) {
    return { ok: false, code: "inventory_command_quantity_not_conserved" };
  }
  if (VALUE_CONSERVING.has(input.transition) && valueTotal !== 0) {
    return { ok: false, code: "inventory_command_value_not_conserved" };
  }
  if ((input.transition === "reserve" || input.transition === "release_reservation") &&
      quarantinedTotal !== 0) {
    return { ok: false, code: "inventory_command_reservation_not_conserved" };
  }
  if ((input.transition === "quarantine" || input.transition === "release_quarantine") &&
      reservedTotal !== 0) {
    return { ok: false, code: "inventory_command_quarantine_not_conserved" };
  }
  if ((input.transition === "receive" || input.transition === "return") &&
      input.movements.some((move) => move.quantityDelta < 0)) {
    return { ok: false, code: "inventory_command_direction_invalid" };
  }
  if (input.transition === "issue_use" &&
      input.movements.some((move) => move.quantityDelta > 0)) {
    return { ok: false, code: "inventory_command_direction_invalid" };
  }
  if (VALUE_CONSERVING.has(input.transition) &&
      new Set(input.movements.map((move) => move.uomId)).size > 1) {
    return { ok: false, code: "inventory_command_uom_mixed" };
  }
  if (input.transition === "count_adjustment" && !input.approvalId) {
    return { ok: false, code: "inventory_command_approval_required" };
  }

  const statements: D1PreparedStatement[] = [];
  const eventIds: string[] = [];
  const layerByMovement = new Map<number, InventoryLayerInput>();
  for (const layer of input.layers ?? []) {
    if (layerByMovement.has(layer.movementIndex)) {
      return { ok: false, code: "inventory_valuation_layer_duplicate" };
    }
    layerByMovement.set(layer.movementIndex, layer);
  }
  const allocationsByMovement = new Map<number, InventoryAllocationInput[]>();
  for (const allocation of input.allocations ?? []) {
    const list = allocationsByMovement.get(allocation.movementIndex) ?? [];
    list.push(allocation);
    allocationsByMovement.set(allocation.movementIndex, list);
  }

  // A layer's remaining quantity is drawn down across the whole command, so several
  // movements may legitimately consume the same layer within one transaction.
  const layerDraw = new Map<string, number>();

  for (const [index, move] of input.movements.entries()) {
    const eventId = `${input.commandId}.m${index + 1}`;
    eventIds.push(eventId);
    const position = await positionById(env, input.tenantId, move.positionId);

    if (position) {
      if (position.item_id !== move.itemId || position.lot_id !== move.lotId ||
          position.bin_id !== move.binId || position.uom_id !== move.uomId ||
          position.job_custody !== move.jobCustody) {
        return { ok: false, code: "inventory_position_identity_mismatch" };
      }
      const nextQuantity = position.quantity_scaled + move.quantityDelta;
      const nextReserved = position.reserved_scaled + (move.reservedDelta ?? 0);
      const nextQuarantined = position.quarantined_scaled + (move.quarantinedDelta ?? 0);
      const nextValue = position.value_minor + (move.valueDelta ?? 0);
      if (nextQuantity < 0) return { ok: false, code: "inventory_position_negative_quantity" };
      if (nextReserved < 0 || nextQuarantined < 0) {
        return { ok: false, code: "inventory_position_negative_commitment" };
      }
      if (nextValue < 0) return { ok: false, code: "inventory_position_negative_value" };
      if (nextReserved + nextQuarantined > nextQuantity) {
        return { ok: false, code: "inventory_position_overcommitted" };
      }
      statements.push(
        eventStatement(env, input, move, eventId, index + 1, position.version + 1),
        env.DB.prepare(
          `UPDATE inventory_positions
              SET quantity_scaled = ?, reserved_scaled = ?, quarantined_scaled = ?,
                  value_minor = ?, version = ?, last_event_id = ?, updated_at = ?
            WHERE tenant_id = ? AND position_id = ? AND version = ?`,
        ).bind(
          nextQuantity,
          nextReserved,
          nextQuarantined,
          nextValue,
          position.version + 1,
          eventId,
          input.now,
          input.tenantId,
          move.positionId,
          position.version,
        ),
      );
    } else {
      if (move.quantityDelta < 0) return { ok: false, code: "inventory_position_negative_quantity" };
      const reserved = move.reservedDelta ?? 0;
      const quarantined = move.quarantinedDelta ?? 0;
      const value = move.valueDelta ?? 0;
      if (reserved < 0 || quarantined < 0 || value < 0) {
        return { ok: false, code: "inventory_position_negative_commitment" };
      }
      if (reserved + quarantined > move.quantityDelta) {
        return { ok: false, code: "inventory_position_overcommitted" };
      }
      statements.push(
        eventStatement(env, input, move, eventId, index + 1, 1),
        env.DB.prepare(
          `INSERT INTO inventory_positions
             (position_id, tenant_id, item_id, lot_id, bin_id, job_custody, uom_id,
              quantity_scaled, reserved_scaled, quarantined_scaled, value_minor, currency,
              version, last_event_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).bind(
          move.positionId,
          input.tenantId,
          move.itemId,
          move.lotId,
          move.binId,
          move.jobCustody,
          move.uomId,
          move.quantityDelta,
          reserved,
          quarantined,
          value,
          move.currency ?? "CAD",
          eventId,
          input.now,
          input.now,
        ),
      );
    }

    const layer = layerByMovement.get(index);
    if (layer) {
      if (move.quantityDelta <= 0) {
        return { ok: false, code: "inventory_valuation_layer_requires_inbound" };
      }
      const goods = layer.unitCostMinor * move.quantityDelta;
      const freight = layer.freightMinor ?? 0;
      const tax = layer.taxMinor ?? 0;
      const discount = layer.discountMinor ?? 0;
      const capitalized = goods + freight - discount;
      if (capitalized < 0) return { ok: false, code: "inventory_valuation_negative_value" };
      if (capitalized !== (move.valueDelta ?? 0)) {
        return { ok: false, code: "inventory_valuation_layer_value_mismatch" };
      }
      const method = await itemValuationMethod(env, input.tenantId, move.itemId);
      if (!method) return { ok: false, code: "inventory_item_unknown" };
      statements.push(
        env.DB.prepare(
          `INSERT INTO inventory_valuation_layers
             (layer_id, tenant_id, item_id, lot_id, source_event_id, layer_kind,
              quantity_scaled, remaining_scaled, unit_cost_minor, goods_value_minor,
              freight_minor, tax_minor, discount_minor, value_minor, currency, method, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          layer.layerId,
          input.tenantId,
          move.itemId,
          move.lotId,
          eventId,
          layer.layerKind,
          move.quantityDelta,
          move.quantityDelta,
          layer.unitCostMinor,
          goods,
          freight,
          tax,
          discount,
          capitalized,
          move.currency ?? "CAD",
          method,
          input.now,
        ),
      );
    }

    const allocations = allocationsByMovement.get(index) ?? [];
    if (move.quantityDelta < 0) {
      const allocated = allocations.reduce((sum, entry) => sum + entry.quantityScaled, 0);
      if (allocated !== -move.quantityDelta) {
        return { ok: false, code: "inventory_command_valuation_not_allocated" };
      }
      let allocatedValue = 0;
      for (const allocation of allocations) {
        const layerRow = await layerById(env, input.tenantId, allocation.layerId);
        if (!layerRow) return { ok: false, code: "inventory_valuation_layer_unknown" };
        if (layerRow.item_id !== move.itemId) {
          return { ok: false, code: "inventory_valuation_layer_item_mismatch" };
        }
        const alreadyDrawn = layerDraw.get(allocation.layerId) ?? 0;
        const nextDrawn = alreadyDrawn + allocation.quantityScaled;
        if (nextDrawn > layerRow.remaining_scaled) {
          return { ok: false, code: "inventory_valuation_layer_exhausted" };
        }
        layerDraw.set(allocation.layerId, nextDrawn);
        const value = layerRow.unit_cost_minor * allocation.quantityScaled;
        allocatedValue += value;
        statements.push(
          env.DB.prepare(
            `INSERT INTO inventory_valuation_allocations
               (allocation_id, tenant_id, layer_id, event_id, job_custody,
                quantity_scaled, unit_cost_minor, value_minor, currency, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            allocation.allocationId,
            input.tenantId,
            allocation.layerId,
            eventId,
            move.jobCustody,
            allocation.quantityScaled,
            layerRow.unit_cost_minor,
            value,
            move.currency ?? "CAD",
            input.now,
          ),
        );
      }
      // The value that leaves the position must equal the value drawn from the layers.
      if (allocatedValue !== -(move.valueDelta ?? 0)) {
        return { ok: false, code: "inventory_valuation_allocation_value_mismatch" };
      }
    } else if (allocations.length > 0) {
      return { ok: false, code: "inventory_valuation_allocation_requires_outbound" };
    }
  }

  for (const [layerId, drawn] of layerDraw) {
    statements.push(
      env.DB.prepare(
        `UPDATE inventory_valuation_layers
            SET remaining_scaled = remaining_scaled - ?
          WHERE tenant_id = ? AND layer_id = ? AND remaining_scaled >= ?`,
      ).bind(drawn, input.tenantId, layerId, drawn),
    );
  }

  for (const companion of input.companions ?? []) {
    statements.push(env.DB.prepare(companion.sql).bind(...companion.params));
  }

  return { ok: true, statements, eventIds, quantityTotal, valueTotal };
}

function eventStatement(
  env: AppEnv,
  input: ApplyInventoryCommandInput,
  move: InventoryMovement,
  eventId: string,
  movementSeq: number,
  version: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO inventory_events
       (event_id, tenant_id, command_id, movement_seq, position_id, version, transition,
        item_id, lot_id, bin_id, uom_id, job_custody, quantity_delta_scaled,
        reserved_delta_scaled, quarantined_delta_scaled, value_delta_minor, currency,
        evidence_refs_json, payload_json, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    eventId,
    input.tenantId,
    input.commandId,
    movementSeq,
    move.positionId,
    version,
    input.transition,
    move.itemId,
    move.lotId,
    move.binId,
    move.uomId,
    move.jobCustody,
    move.quantityDelta,
    move.reservedDelta ?? 0,
    move.quarantinedDelta ?? 0,
    move.valueDelta ?? 0,
    move.currency ?? "CAD",
    JSON.stringify(move.evidenceRefs ?? input.evidenceRefs),
    JSON.stringify(move.payload ?? {}),
    input.now,
  );
}

function insertCommandStatement(
  env: AppEnv,
  input: ApplyInventoryCommandInput,
  idempotencyHash: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO inventory_commands
       (command_id, tenant_id, transition, actor_type, actor_user_id, authority_ref,
        policy_ref, policy_version, idempotency_key_sha256, request_fingerprint_sha256,
        approval_id, evidence_refs_json, payload_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(
    input.commandId,
    input.tenantId,
    input.transition,
    input.actorType,
    input.actorUserId,
    input.authorityRef,
    input.policyRef,
    input.policyVersion,
    idempotencyHash,
    input.requestFingerprintSha256,
    input.approvalId ?? null,
    JSON.stringify(input.evidenceRefs),
    JSON.stringify(input.payload),
    input.now,
    input.now,
  );
}

/**
 * A refused command is still durable where the schema permits the row to exist, so a
 * retry of the same idempotency key returns the same refusal instead of quietly
 * re-running the check.
 *
 * Some refusals are structural: a `count_adjustment` without an approved variance may not
 * exist as a row at all, and the insert trigger says so. In that case the refusal is
 * returned without a stored receipt rather than weakening the trigger — a request that was
 * never admissible does not need to be replayable.
 */
async function persistRejectedCommand(
  env: AppEnv,
  input: ApplyInventoryCommandInput,
  idempotencyHash: string,
  code: string,
): Promise<InventoryCommand> {
  try {
    await env.DB.batch([
      insertCommandStatement(env, input, idempotencyHash),
      env.DB.prepare(
        `UPDATE inventory_commands
            SET status = 'rejected', rejection_code = ?, updated_at = ?, completed_at = ?
          WHERE tenant_id = ? AND command_id = ? AND status = 'pending'`,
      ).bind(code, input.now, input.now, input.tenantId, input.commandId),
    ]);
  } catch {
    return inadmissibleCommand(input, idempotencyHash, code);
  }
  const command = await commandById(env, input.tenantId, input.commandId);
  return command ?? inadmissibleCommand(input, idempotencyHash, code);
}

/** The refusal receipt for a command the schema refuses to store at all. */
function inadmissibleCommand(
  input: ApplyInventoryCommandInput,
  idempotencyHash: string,
  code: string,
): InventoryCommand {
  return {
    command_id: input.commandId,
    tenant_id: input.tenantId,
    transition: input.transition,
    actor_type: input.actorType,
    actor_user_id: input.actorUserId,
    authority_ref: input.authorityRef,
    policy_ref: input.policyRef,
    policy_version: input.policyVersion,
    idempotency_key_sha256: idempotencyHash,
    request_fingerprint_sha256: input.requestFingerprintSha256,
    approval_id: input.approvalId ?? null,
    evidence_refs_json: JSON.stringify(input.evidenceRefs),
    payload_json: JSON.stringify(input.payload),
    status: "rejected",
    result_json: null,
    rejection_code: code,
    created_at: input.now,
    updated_at: input.now,
    completed_at: input.now,
  };
}

/**
 * Record one barcode scan. Offline capture is duplicate-safe by construction: the same
 * (device, device_action_id) always converges on the first stored observation, so an
 * unbounded replay of a queued scan can never double-apply.
 */
export async function recordInventoryScan(
  env: AppEnv,
  input: {
    scanId: string;
    tenantId: string;
    deviceId: string;
    deviceActionId: string;
    actorUserId: string;
    barcode: string;
    scanIntent: "receive" | "issue_use" | "return" | "transfer" | "count" | "lookup";
    requestFingerprintSha256: string;
    observedAt: string;
    capturedOffline: boolean;
    payload: Record<string, unknown>;
    now: string;
  },
): Promise<{
  kind: "recorded" | "duplicate" | "conflict";
  scan: InventoryScan;
}> {
  if (!TENANT_ID.test(input.tenantId) || !OPAQUE_ID.test(input.scanId) ||
      !USER_ID.test(input.actorUserId) || !SHA256.test(input.requestFingerprintSha256) ||
      !ISO_INSTANT.test(input.observedAt) || !ISO_INSTANT.test(input.now)) {
    throw new InventoryLedgerError("inventory_scan_input_invalid");
  }

  const existing = await scanByDeviceAction(env, input.tenantId, input.deviceId, input.deviceActionId);
  if (existing) {
    return {
      kind: existing.request_fingerprint_sha256 === input.requestFingerprintSha256
        ? "duplicate"
        : "conflict",
      scan: existing,
    };
  }

  const identity = await barcodeIdentity(env, input.tenantId, input.barcode);
  // An unknown identity captured in the field is an observation pending validation. It
  // never silently creates stock and never resolves to a guessed item.
  const resolution = identity ? "resolved" : "observed_pending_validation";

  await env.DB.prepare(
    `INSERT INTO inventory_scans
       (scan_id, tenant_id, device_id, device_action_id, actor_user_id, barcode, scan_intent,
        request_fingerprint_sha256, observed_at, captured_offline, resolution,
        resolved_entity_type, resolved_entity_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, device_id, device_action_id) DO NOTHING`,
  ).bind(
    input.scanId,
    input.tenantId,
    input.deviceId,
    input.deviceActionId,
    input.actorUserId,
    input.barcode,
    input.scanIntent,
    input.requestFingerprintSha256,
    input.observedAt,
    input.capturedOffline ? 1 : 0,
    resolution,
    identity?.entity_type ?? null,
    identity?.entity_id ?? null,
    JSON.stringify(input.payload),
    input.now,
  ).run();

  const stored = await scanByDeviceAction(env, input.tenantId, input.deviceId, input.deviceActionId);
  if (!stored) throw new InventoryLedgerError("inventory_scan_missing_after_insert");
  return {
    kind: stored.scan_id === input.scanId ? "recorded" : "duplicate",
    scan: stored,
  };
}

export interface InventoryScan {
  scan_id: string;
  tenant_id: string;
  device_id: string;
  device_action_id: string;
  actor_user_id: string;
  barcode: string;
  scan_intent: string;
  request_fingerprint_sha256: string;
  observed_at: string;
  captured_offline: number;
  resolution: "resolved" | "duplicate" | "conflict" | "observed_pending_validation" | "rejected";
  resolved_entity_type: string | null;
  resolved_entity_id: string | null;
  command_id: string | null;
  exception_id: string | null;
  payload_json: string;
  created_at: string;
}

/**
 * Classify one physical receipt against its order line. Shortage, overage, unit, price,
 * tax, freight and lot differences are exceptions, not silently absorbed variances.
 */
export function classifyReceiptException(input: {
  orderedQuantityScaled: number;
  previouslyReceivedScaled: number;
  receivedQuantityScaled: number;
  orderedUomId: string;
  receivedUomId: string;
  orderedItemId: string;
  receivedItemId: string;
  orderedUnitPriceMinor: number;
  receivedUnitPriceMinor: number;
  orderedTaxMinor: number;
  receivedTaxMinor: number;
  orderedFreightMinor: number;
  receivedFreightMinor: number;
  conditionStatus: "accepted" | "damaged" | "quarantined";
  lotBelongsToItem: boolean;
}):
  | "none"
  | "shortage"
  | "overage"
  | "backorder"
  | "substitution"
  | "unit_difference"
  | "price_difference"
  | "tax_difference"
  | "freight_difference"
  | "wrong_lot" {
  if (!input.lotBelongsToItem) return "wrong_lot";
  if (input.orderedItemId !== input.receivedItemId) return "substitution";
  if (input.orderedUomId !== input.receivedUomId) return "unit_difference";
  if (input.orderedUnitPriceMinor !== input.receivedUnitPriceMinor) return "price_difference";
  if (input.orderedTaxMinor !== input.receivedTaxMinor) return "tax_difference";
  if (input.orderedFreightMinor !== input.receivedFreightMinor) return "freight_difference";
  const cumulative = input.previouslyReceivedScaled + input.receivedQuantityScaled;
  if (cumulative > input.orderedQuantityScaled) return "overage";
  if (cumulative < input.orderedQuantityScaled) return "backorder";
  return "none";
}

/**
 * Three-way match on exact line identity. A partial delivery is matchable for the quantity
 * actually received and invoiced; the order shortfall is a backorder on the PO line, never
 * a falsified full match.
 */
export function classifyThreeWayMatch(input: {
  orderedQuantityScaled: number;
  receivedQuantityScaled: number;
  invoicedQuantityScaled: number;
  orderedItemId: string;
  receivedItemId: string;
  invoicedItemId: string;
  orderedUomId: string;
  receivedUomId: string;
  invoicedUomId: string;
  orderedUnitPriceMinor: number;
  receivedUnitPriceMinor: number;
  invoicedUnitPriceMinor: number;
  receivedTaxMinor: number;
  invoicedTaxMinor: number;
  receivedFreightMinor: number;
  invoicedFreightMinor: number;
  orderedCurrency: string;
  receivedCurrency: string;
  invoicedCurrency: string;
  conditionStatus: "accepted" | "damaged" | "quarantined";
  receiptExceptionStatus: string;
}): { state: "matched"; matchedQuantityScaled: number } | { state: "exception"; code: string } {
  if (input.orderedCurrency !== input.receivedCurrency ||
      input.orderedCurrency !== input.invoicedCurrency) {
    return { state: "exception", code: "currency_difference" };
  }
  if (input.orderedItemId !== input.receivedItemId ||
      input.orderedItemId !== input.invoicedItemId) {
    return { state: "exception", code: "substitution" };
  }
  if (input.orderedUomId !== input.receivedUomId || input.orderedUomId !== input.invoicedUomId) {
    return { state: "exception", code: "unit_difference" };
  }
  if (input.conditionStatus !== "accepted") {
    return { state: "exception", code: "condition_not_accepted" };
  }
  if (input.receiptExceptionStatus !== "none") {
    return { state: "exception", code: input.receiptExceptionStatus };
  }
  if (input.orderedUnitPriceMinor !== input.receivedUnitPriceMinor ||
      input.orderedUnitPriceMinor !== input.invoicedUnitPriceMinor) {
    return { state: "exception", code: "price_difference" };
  }
  if (input.receivedTaxMinor !== input.invoicedTaxMinor) {
    return { state: "exception", code: "tax_difference" };
  }
  if (input.receivedFreightMinor !== input.invoicedFreightMinor) {
    return { state: "exception", code: "freight_difference" };
  }
  if (input.receivedQuantityScaled > input.invoicedQuantityScaled) {
    return { state: "exception", code: "shortage" };
  }
  if (input.receivedQuantityScaled < input.invoicedQuantityScaled) {
    return { state: "exception", code: "overage" };
  }
  if (input.receivedQuantityScaled > input.orderedQuantityScaled) {
    return { state: "exception", code: "overage" };
  }
  return { state: "matched", matchedQuantityScaled: input.receivedQuantityScaled };
}

/** Sum of on-hand quantity and value for a tenant, used by conservation assertions. */
export async function inventoryTotals(
  env: AppEnv,
  tenantId: string,
): Promise<{ quantity_scaled: number; value_minor: number }> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(quantity_scaled), 0) AS quantity_scaled,
            COALESCE(SUM(value_minor), 0) AS value_minor
       FROM inventory_positions
      WHERE tenant_id = ?`,
  ).bind(tenantId).first<{ quantity_scaled: number; value_minor: number }>();
  return {
    quantity_scaled: Number(row?.quantity_scaled ?? 0),
    value_minor: Number(row?.value_minor ?? 0),
  };
}

/** Sum of every movement written by an applied command, for the same assertion. */
export async function appliedLedgerTotals(
  env: AppEnv,
  tenantId: string,
): Promise<{ quantity_scaled: number; value_minor: number }> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(movement.quantity_delta_scaled), 0) AS quantity_scaled,
            COALESCE(SUM(movement.value_delta_minor), 0) AS value_minor
       FROM inventory_events AS movement
       JOIN inventory_commands AS command
         ON command.command_id = movement.command_id AND command.tenant_id = movement.tenant_id
      WHERE movement.tenant_id = ? AND command.status = 'applied'`,
  ).bind(tenantId).first<{ quantity_scaled: number; value_minor: number }>();
  return {
    quantity_scaled: Number(row?.quantity_scaled ?? 0),
    value_minor: Number(row?.value_minor ?? 0),
  };
}

export async function getInventoryCommand(
  env: AppEnv,
  tenantId: string,
  commandId: string,
): Promise<InventoryCommand | null> {
  if (!TENANT_ID.test(tenantId) || !OPAQUE_ID.test(commandId)) return null;
  return await commandById(env, tenantId, commandId);
}

export async function getInventoryPosition(
  env: AppEnv,
  tenantId: string,
  positionId: string,
): Promise<InventoryPosition | null> {
  if (!TENANT_ID.test(tenantId) || !POSITION_ID.test(positionId)) return null;
  return await positionById(env, tenantId, positionId);
}

export async function listInventoryPositions(
  env: AppEnv,
  tenantId: string,
  itemId: string,
  limit = 50,
): Promise<InventoryPosition[]> {
  if (!TENANT_ID.test(tenantId)) return [];
  const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
  const rows = await env.DB.prepare(
    `SELECT position_id, tenant_id, item_id, lot_id, bin_id, job_custody, uom_id,
            quantity_scaled, reserved_scaled, quarantined_scaled, value_minor, currency,
            version, last_event_id, created_at, updated_at
       FROM inventory_positions
      WHERE tenant_id = ? AND item_id = ?
      ORDER BY bin_id ASC, lot_id ASC, job_custody ASC
      LIMIT ?`,
  ).bind(tenantId, itemId, bounded).all<InventoryPosition>();
  return rows.results;
}

async function commandById(
  env: AppEnv,
  tenantId: string,
  commandId: string,
): Promise<InventoryCommand | null> {
  return await env.DB.prepare(
    `SELECT command_id, tenant_id, transition, actor_type, actor_user_id, authority_ref,
            policy_ref, policy_version, idempotency_key_sha256, request_fingerprint_sha256,
            approval_id, evidence_refs_json, payload_json, status, result_json,
            rejection_code, created_at, updated_at, completed_at
       FROM inventory_commands
      WHERE tenant_id = ? AND command_id = ?
      LIMIT 1`,
  ).bind(tenantId, commandId).first<InventoryCommand>();
}

async function commandByIdempotency(
  env: AppEnv,
  tenantId: string,
  idempotencyHash: string,
): Promise<InventoryCommand | null> {
  return await env.DB.prepare(
    `SELECT command_id, tenant_id, transition, actor_type, actor_user_id, authority_ref,
            policy_ref, policy_version, idempotency_key_sha256, request_fingerprint_sha256,
            approval_id, evidence_refs_json, payload_json, status, result_json,
            rejection_code, created_at, updated_at, completed_at
       FROM inventory_commands
      WHERE tenant_id = ? AND idempotency_key_sha256 = ?
      LIMIT 1`,
  ).bind(tenantId, idempotencyHash).first<InventoryCommand>();
}

async function positionById(
  env: AppEnv,
  tenantId: string,
  positionId: string,
): Promise<InventoryPosition | null> {
  return await env.DB.prepare(
    `SELECT position_id, tenant_id, item_id, lot_id, bin_id, job_custody, uom_id,
            quantity_scaled, reserved_scaled, quarantined_scaled, value_minor, currency,
            version, last_event_id, created_at, updated_at
       FROM inventory_positions
      WHERE tenant_id = ? AND position_id = ?
      LIMIT 1`,
  ).bind(tenantId, positionId).first<InventoryPosition>();
}

async function layerById(
  env: AppEnv,
  tenantId: string,
  layerId: string,
): Promise<InventoryValuationLayer | null> {
  return await env.DB.prepare(
    `SELECT layer_id, tenant_id, item_id, lot_id, source_event_id, layer_kind,
            quantity_scaled, remaining_scaled, unit_cost_minor, value_minor, method, created_at
       FROM inventory_valuation_layers
      WHERE tenant_id = ? AND layer_id = ?
      LIMIT 1`,
  ).bind(tenantId, layerId).first<InventoryValuationLayer>();
}

async function itemValuationMethod(
  env: AppEnv,
  tenantId: string,
  itemId: string,
): Promise<"actual" | "fifo" | null> {
  const row = await env.DB.prepare(
    `SELECT valuation_method FROM inventory_items WHERE tenant_id = ? AND item_id = ? LIMIT 1`,
  ).bind(tenantId, itemId).first<{ valuation_method: "actual" | "fifo" }>();
  return row?.valuation_method ?? null;
}

async function barcodeIdentity(
  env: AppEnv,
  tenantId: string,
  barcode: string,
): Promise<{ entity_type: string; entity_id: string } | null> {
  return await env.DB.prepare(
    `SELECT entity_type, entity_id
       FROM inventory_barcodes
      WHERE tenant_id = ? AND barcode = ? AND status = 'active'
      LIMIT 1`,
  ).bind(tenantId, barcode).first<{ entity_type: string; entity_id: string }>();
}

async function scanByDeviceAction(
  env: AppEnv,
  tenantId: string,
  deviceId: string,
  deviceActionId: string,
): Promise<InventoryScan | null> {
  return await env.DB.prepare(
    `SELECT scan_id, tenant_id, device_id, device_action_id, actor_user_id, barcode,
            scan_intent, request_fingerprint_sha256, observed_at, captured_offline,
            resolution, resolved_entity_type, resolved_entity_id, command_id, exception_id,
            payload_json, created_at
       FROM inventory_scans
      WHERE tenant_id = ? AND device_id = ? AND device_action_id = ?
      LIMIT 1`,
  ).bind(tenantId, deviceId, deviceActionId).first<InventoryScan>();
}

async function eventIdsForCommand(env: AppEnv, commandId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT event_id FROM inventory_events WHERE command_id = ? ORDER BY movement_seq ASC`,
  ).bind(commandId).all<{ event_id: string }>();
  return rows.results.map((row) => row.event_id);
}

function triggerCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/inventory_[a-z0-9_]+/);
  return match?.[0] ?? "inventory_ledger_write_failed";
}

function validateCommandInput(input: ApplyInventoryCommandInput): void {
  if (!TENANT_ID.test(input.tenantId) || !OPAQUE_ID.test(input.commandId) ||
      !INVENTORY_TRANSITIONS.includes(input.transition) ||
      !USER_ID.test(input.actorUserId) ||
      !boundedText(input.authorityRef, 1, 280) ||
      !boundedText(input.policyRef, 1, 280) ||
      !boundedText(input.policyVersion, 1, 80) ||
      !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
      !SHA256.test(input.requestFingerprintSha256) ||
      !ISO_INSTANT.test(input.now) ||
      !Array.isArray(input.movements) || input.movements.length < 1 ||
      input.movements.length > 200) {
    throw new InventoryLedgerError("inventory_command_input_invalid");
  }
  if (input.approvalId !== undefined && input.approvalId !== null &&
      !OPAQUE_ID.test(input.approvalId)) {
    throw new InventoryLedgerError("inventory_command_input_invalid");
  }
  if (!validEvidenceRefs(input.evidenceRefs)) {
    throw new InventoryLedgerError("inventory_command_evidence_invalid");
  }
  const seen = new Set<string>();
  for (const move of input.movements) {
    if (!POSITION_ID.test(move.positionId) || !CUSTODY.test(move.jobCustody) ||
        !Number.isSafeInteger(move.quantityDelta) ||
        !Number.isSafeInteger(move.reservedDelta ?? 0) ||
        !Number.isSafeInteger(move.quarantinedDelta ?? 0) ||
        !Number.isSafeInteger(move.valueDelta ?? 0)) {
      throw new InventoryLedgerError("inventory_movement_invalid");
    }
    // Two movements on one position inside one command would need two CAS versions and
    // would make the projection update ambiguous; split them into separate commands.
    if (seen.has(move.positionId)) {
      throw new InventoryLedgerError("inventory_movement_position_repeated");
    }
    seen.add(move.positionId);
  }
}

function validEvidenceRefs(value: unknown): value is readonly EvidenceRef[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const ref = (entry as EvidenceRef).ref;
    const sha256 = (entry as EvidenceRef).sha256;
    return typeof ref === "string" && ref.trim().length >= 3 && ref.trim().length <= 512 &&
      !/[\u0000-\u001f]/.test(ref) && typeof sha256 === "string" && SHA256.test(sha256);
  });
}

function boundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.trim().length >= min &&
    value.trim().length <= max && !/[\u0000-\u001f]/.test(value);
}
