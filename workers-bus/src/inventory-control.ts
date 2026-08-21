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

/** Tenant-scoped inventory rows safe for the overview screen. */
export interface InventoryOverviewPosition {
  position_id: string;
  item_id: string;
  item_code: string;
  item_kind: string;
  lot_id: string;
  lot_code: string;
  lot_status: string;
  lot_kind: string;
  parent_lot_id: string | null;
  bin_id: string;
  bin_code: string;
  location_code: string;
  location_name: string;
  job_custody: string;
  uom_id: string;
  uom_code: string;
  uom_dimension: string;
  uom_scale: number;
  quantity_scale: number;
  quantity_scaled: number;
  reserved_scaled: number;
  quarantined_scaled: number;
  value_minor: number;
  currency: string;
  version: number;
  last_event_id: string;
  updated_at: string;
}

export interface InventoryItemSummary {
  item_id: string;
  item_code: string;
  status: "draft" | "active" | "retired";
  item_kind: string;
  base_uom_id: string;
  base_uom_code: string;
  base_uom_dimension: string;
  base_uom_scale: number;
  quantity_scale: number;
  lot_controlled: number;
  valuation_method: "actual" | "fifo";
}

export interface InventoryValuationLayerSummary {
  layer_id: string;
  item_id: string;
  item_code: string;
  lot_id: string;
  lot_code: string;
  uom_code: string;
  uom_scale: number;
  layer_kind: InventoryValuationLayer["layer_kind"];
  quantity_scaled: number;
  remaining_scaled: number;
  unit_cost_minor: number;
  value_minor: number;
  currency: string;
  method: InventoryValuationLayer["method"];
}

export interface InventoryUomConversionSummary {
  conversion_id: string;
  from_uom_id: string;
  from_uom_code: string;
  to_uom_id: string;
  to_uom_code: string;
  dimension: string;
  numerator: number;
  denominator: number;
  version: number;
  source_ref: string;
}

export interface InventoryRecentScan {
  scan_id: string;
  barcode: string;
  scan_intent: string;
  observed_at: string;
  captured_offline: number;
  resolution: InventoryScan["resolution"];
  resolved_entity_type: string | null;
  resolved_entity_id: string | null;
}

export interface InventoryBarcodeLookup {
  barcode: string;
  symbology: string;
  entity_type: "item" | "lot" | "bin";
  entity_id: string;
  item_code: string | null;
  lot_code: string | null;
  bin_code: string | null;
  location_code: string | null;
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

/**
 * Public inventory writes are business intents. The Worker resolves every position, layer,
 * valuation allocation and domain companion from the authenticated tenant before applying the
 * internal ledger input. Browser supplied movement/layer/allocation arrays are deliberately not
 * represented here.
 */
export interface InventoryCommandIntentInput {
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
  sourcePositionId?: string | null;
  targetPositionId?: string | null;
  itemId?: string | null;
  lotId?: string | null;
  binId?: string | null;
  uomId?: string | null;
  jobCustody?: string | null;
  quantityScaled?: number | null;
  countedQuantityScaled?: number | null;
  unitCostMinor?: number | null;
  currency?: string | null;
  jobId?: string | null;
  workPackageId?: string | null;
  reservationId?: string | null;
  receiptId?: string | null;
  poLineId?: string | null;
  countSessionId?: string | null;
  reversalReference?: string | null;
  conditionStatus?: "accepted" | "damaged" | "quarantined" | null;
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

interface IntentPosition {
  positionId: string;
  itemId: string;
  lotId: string;
  binId: string;
  uomId: string;
  jobCustody: string;
  currency: string;
  quantityScaled: number;
  reservedScaled: number;
  quarantinedScaled: number;
  valueMinor: number;
  version: number;
  existing: boolean;
}

interface InventoryIntentEntity {
  item_id: string;
  item_status: "draft" | "active" | "retired";
  valuation_method: "actual" | "fifo";
  lot_id: string;
  lot_item_id: string;
  lot_status: "observed_pending_validation" | "quarantined" | "available" | "consumed" | "rejected";
  parent_lot_id: string | null;
  bin_id: string;
  bin_status: "active" | "retired";
  freeze_state: "open" | "frozen";
  uom_id: string;
  uom_status: "active" | "retired";
  currency: string;
}

/**
 * Apply one public business intent after resolving its current tenant rows. This is the only
 * route-facing write seam; `applyInventoryCommand` remains the lower-level ledger primitive used
 * by existing domain tests and by this planner.
 */
export async function applyInventoryCommandIntent(
  env: AppEnv,
  input: InventoryCommandIntentInput,
): Promise<ApplyInventoryCommandResult> {
  validateCommandIntentInput(input);
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

  const planned = await planInventoryCommandIntent(env, input);
  return await applyInventoryCommand(env, planned);
}

async function planInventoryCommandIntent(
  env: AppEnv,
  input: InventoryCommandIntentInput,
): Promise<ApplyInventoryCommandInput> {
  if (input.transition === "reversal") {
    const reversal = await planReversalIntent(env, input);
    const payload: Record<string, unknown> = {
      ...input.payload,
      reversal_of: input.reversalReference ?? null,
      intent: {
        source_position_id: null,
        target_position_id: null,
        quantity_scaled: null,
        reversal_reference: input.reversalReference ?? null,
      },
    };
    return {
      commandId: input.commandId,
      tenantId: input.tenantId,
      transition: input.transition,
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      authorityRef: input.authorityRef,
      policyRef: input.policyRef,
      policyVersion: input.policyVersion,
      idempotencyKey: input.idempotencyKey,
      requestFingerprintSha256: input.requestFingerprintSha256,
      approvalId: input.approvalId ?? null,
      evidenceRefs: input.evidenceRefs,
      payload,
      movements: reversal.movements.map((movement) => ({ ...movement, payload })),
      layers: reversal.layers,
      allocations: reversal.allocations,
      companions: [],
      now: input.now,
    };
  }
  const source = await resolveIntentPosition(env, input, "source");
  const sourceEntity = await inventoryIntentEntity(
    env,
    input.tenantId,
    source.itemId,
    source.lotId,
    source.binId,
    source.uomId,
  );
  assertIntentEntity(sourceEntity);
  const sourceAvailable = source.quantityScaled - source.reservedScaled - source.quarantinedScaled;
  const quantity = input.quantityScaled ?? null;
  const movements: InventoryMovement[] = [];
  const layers: InventoryLayerInput[] = [];
  const allocations: InventoryAllocationInput[] = [];
  const companions: InventoryCompanionStatement[] = [];
  const payload: Record<string, unknown> = {
    ...input.payload,
    intent: {
      source_position_id: input.sourcePositionId ?? null,
      target_position_id: input.targetPositionId ?? null,
      item_id: input.itemId ?? null,
      lot_id: input.lotId ?? null,
      bin_id: input.binId ?? null,
      uom_id: input.uomId ?? null,
      quantity_scaled: input.quantityScaled ?? null,
      counted_quantity_scaled: input.countedQuantityScaled ?? null,
    },
  };

  const movement = (
    position: IntentPosition,
    quantityDelta: number,
    valueDelta = 0,
    reservedDelta = 0,
    quarantinedDelta = 0,
  ): InventoryMovement => ({
    positionId: position.positionId,
    itemId: position.itemId,
    lotId: position.lotId,
    binId: position.binId,
    uomId: position.uomId,
    jobCustody: position.jobCustody,
    quantityDelta,
    reservedDelta,
    quarantinedDelta,
    valueDelta,
    currency: position.currency,
    payload,
  });

  const draw = async (drawQuantity: number): Promise<{
    allocations: InventoryAllocationInput[];
    valueMinor: number;
  }> => {
    const method = await itemValuationMethod(env, input.tenantId, source.itemId);
    if (!method) throw new InventoryLedgerError("inventory_item_unknown");
    const plannedDraw = await planValuationDraw(env, {
      tenantId: input.tenantId,
      itemId: source.itemId,
      lotId: source.lotId,
      quantityScaled: drawQuantity,
      method,
    });
    if (!plannedDraw) throw new InventoryLedgerError("inventory_valuation_unavailable");
    return {
      allocations: plannedDraw.map((entry, index) => ({
        allocationId: `${input.commandId}.allocation${index + 1}`,
        movementIndex: 0,
        layerId: entry.layerId,
        quantityScaled: entry.quantityScaled,
      })),
      valueMinor: plannedDraw.reduce(
        (sum, entry) => sum + entry.quantityScaled * entry.unitCostMinor,
        0,
      ),
    };
  };

  if (input.transition === "receive" || input.transition === "return") {
    assertPositiveIntentQuantity(quantity, "inventory_command_quantity_required");
    if (input.unitCostMinor === null || input.unitCostMinor === undefined ||
        !Number.isSafeInteger(input.unitCostMinor) || input.unitCostMinor < 0) {
      throw new InventoryLedgerError("inventory_unit_cost_required");
    }
    const value = input.unitCostMinor * quantity;
    if (!Number.isSafeInteger(value)) throw new InventoryLedgerError("inventory_quantity_overflow");
    movements.push(movement(source, quantity, value));
    layers.push({
      layerId: `${input.commandId}.layer`,
      movementIndex: 0,
      layerKind: input.transition === "return" ? "return" : "receipt",
      unitCostMinor: input.unitCostMinor,
    });
    if (input.transition === "receive") {
      await planReceiptCompanion(env, input, source, sourceEntity, quantity, companions);
    }
  } else if (input.transition === "reserve") {
    assertPositiveIntentQuantity(quantity, "inventory_command_quantity_required");
    if (!input.jobId?.trim()) throw new InventoryLedgerError("inventory_job_required");
    if (quantity > sourceAvailable) throw new InventoryLedgerError("inventory_position_insufficient_available");
    const reservationId = input.reservationId ?? `${input.commandId}.reservation`;
    if (!OPAQUE_ID.test(reservationId)) throw new InventoryLedgerError("inventory_reservation_invalid");
    const existingReservation = await env.DB.prepare(
      `SELECT reservation_id FROM inventory_reservations WHERE tenant_id = ? AND reservation_id = ? LIMIT 1`,
    ).bind(input.tenantId, reservationId).first<{ reservation_id: string }>();
    if (existingReservation) throw new InventoryLedgerError("inventory_reservation_already_exists");
    movements.push(movement(source, 0, 0, quantity));
    companions.push({
      sql: `INSERT INTO inventory_reservations
              (reservation_id, tenant_id, position_id, job_id, work_package_id,
               reserved_quantity_scaled, issued_quantity_scaled, returned_quantity_scaled,
               uom_id, status, version, command_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 'reserved', 1, ?, ?, ?)`,
      params: [
        reservationId,
        input.tenantId,
        source.positionId,
        input.jobId.trim(),
        input.workPackageId?.trim() || null,
        quantity,
        source.uomId,
        input.commandId,
        input.now,
        input.now,
      ],
    });
  } else if (input.transition === "release_reservation") {
    assertPositiveIntentQuantity(quantity, "inventory_command_quantity_required");
    if (!input.reservationId?.trim()) throw new InventoryLedgerError("inventory_reservation_required");
    const reservation = await env.DB.prepare(
      `SELECT reservation_id, position_id, reserved_quantity_scaled,
              issued_quantity_scaled, status, version
         FROM inventory_reservations
        WHERE tenant_id = ? AND reservation_id = ?
        LIMIT 1`,
    ).bind(input.tenantId, input.reservationId.trim()).first<{
      reservation_id: string;
      position_id: string;
      reserved_quantity_scaled: number;
      issued_quantity_scaled: number;
      status: string;
      version: number;
    }>();
    if (!reservation || reservation.position_id !== source.positionId) {
      throw new InventoryLedgerError("inventory_reservation_unknown");
    }
    const releasable = Number(reservation.reserved_quantity_scaled) -
      Number(reservation.issued_quantity_scaled);
    if (reservation.status === "released" || reservation.status === "reversed" ||
        quantity !== releasable) {
      throw new InventoryLedgerError("inventory_reservation_release_invalid");
    }
    movements.push(movement(source, 0, 0, -quantity));
    companions.push({
      sql: `UPDATE inventory_reservations
               SET status = 'released', version = version + 1, updated_at = ?
             WHERE tenant_id = ? AND reservation_id = ? AND version = ?`,
      params: [input.now, input.tenantId, reservation.reservation_id, reservation.version],
    });
  } else if (input.transition === "issue_use") {
    assertPositiveIntentQuantity(quantity, "inventory_command_quantity_required");
    if (quantity > sourceAvailable) throw new InventoryLedgerError("inventory_position_insufficient_available");
    const plannedDraw = await draw(quantity);
    movements.push(movement(source, -quantity, -plannedDraw.valueMinor));
    allocations.push(...plannedDraw.allocations);
  } else if (input.transition === "quarantine" || input.transition === "release_quarantine") {
    assertPositiveIntentQuantity(quantity, "inventory_command_quantity_required");
    if (input.transition === "quarantine") {
      if (quantity > sourceAvailable) throw new InventoryLedgerError("inventory_position_insufficient_available");
      movements.push(movement(source, 0, 0, 0, quantity));
    } else {
      if (quantity > source.quarantinedScaled) {
        throw new InventoryLedgerError("inventory_position_insufficient_quarantine");
      }
      if (!input.approvalId?.trim() || !(await approvedInventoryApproval(
        env,
        input.tenantId,
        input.approvalId,
        "quarantine_release",
        source.positionId,
      ))) {
        throw new InventoryLedgerError("inventory_command_approval_required");
      }
      movements.push(movement(source, 0, 0, 0, -quantity));
    }
  } else if (input.transition === "count_freeze") {
    if (!source.existing) throw new InventoryLedgerError("inventory_count_position_required");
    const countSessionId = input.countSessionId ?? `${input.commandId}.count-session`;
    const countLineId = `${input.commandId}.count-line`;
    const bin = await env.DB.prepare(
      `SELECT freeze_state, version FROM inventory_bins WHERE tenant_id = ? AND bin_id = ? LIMIT 1`,
    ).bind(input.tenantId, source.binId).first<{ freeze_state: "open" | "frozen"; version: number }>();
    if (!bin) throw new InventoryLedgerError("inventory_bin_unknown");
    if (bin.freeze_state !== "open") throw new InventoryLedgerError("inventory_bin_already_frozen");
    movements.push(movement(source, 0, 0));
    companions.push(
      {
        sql: `INSERT INTO inventory_count_sessions
                (count_session_id, tenant_id, bin_id, count_type, status, version,
                 opened_by_user_id, opened_at, counted_by_user_id, counted_at, approval_id,
                 released_at, evidence_refs_json, updated_at)
              VALUES (?, ?, ?, 'spot', 'frozen', 1, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        params: [
          countSessionId,
          input.tenantId,
          source.binId,
          input.actorUserId,
          input.now,
          JSON.stringify(input.evidenceRefs),
          input.now,
        ],
      },
      {
        sql: `INSERT INTO inventory_count_lines
                (count_line_id, tenant_id, count_session_id, position_id,
                 expected_quantity_scaled, counted_quantity_scaled, variance_scaled,
                 uom_id, status, counted_by_user_id, counted_at, adjustment_command_id,
                 evidence_refs_json, version, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'pending', NULL, NULL, NULL, ?, 1, ?, ?)`,
        params: [
          countLineId,
          input.tenantId,
          countSessionId,
          source.positionId,
          source.quantityScaled,
          source.uomId,
          JSON.stringify(input.evidenceRefs),
          input.now,
          input.now,
        ],
      },
      {
        sql: `UPDATE inventory_bins
                 SET freeze_state = 'frozen', frozen_by = ?, frozen_at = ?,
                     freeze_count_session_id = ?, version = version + 1, updated_at = ?
               WHERE tenant_id = ? AND bin_id = ? AND version = ? AND freeze_state = 'open'`,
        params: [
          input.actorUserId,
          input.now,
          countSessionId,
          input.now,
          input.tenantId,
          source.binId,
          bin.version,
        ],
      },
    );
  } else if (input.transition === "count_adjustment") {
    if (!source.existing) throw new InventoryLedgerError("inventory_count_position_required");
    if (input.countedQuantityScaled === null || input.countedQuantityScaled === undefined ||
        !Number.isSafeInteger(input.countedQuantityScaled) || input.countedQuantityScaled < 0) {
      throw new InventoryLedgerError("inventory_count_quantity_required");
    }
    if (!input.countSessionId?.trim() || !input.approvalId?.trim()) {
      throw new InventoryLedgerError("inventory_command_approval_required");
    }
    const count = await env.DB.prepare(
      `SELECT session.count_session_id, session.status AS session_status,
              session.approval_id AS session_approval_id,
              line.count_line_id, line.position_id, line.expected_quantity_scaled,
              line.counted_quantity_scaled, line.version AS line_version
         FROM inventory_count_sessions AS session
         JOIN inventory_count_lines AS line
           ON line.tenant_id = session.tenant_id
          AND line.count_session_id = session.count_session_id
        WHERE session.tenant_id = ? AND session.count_session_id = ?
          AND line.position_id = ?
        LIMIT 1`,
    ).bind(input.tenantId, input.countSessionId.trim(), source.positionId).first<{
      count_session_id: string;
      session_status: string;
      session_approval_id: string | null;
      count_line_id: string;
      position_id: string;
      expected_quantity_scaled: number;
      counted_quantity_scaled: number | null;
      line_version: number;
    }>();
    if (!count || !["approved", "closed"].includes(count.session_status) ||
        count.session_approval_id !== input.approvalId ||
        count.counted_quantity_scaled !== null || !(await approvedInventoryApproval(
          env,
          input.tenantId,
          input.approvalId,
          "count_variance",
          input.countSessionId,
        ))) {
      throw new InventoryLedgerError("inventory_count_approval_invalid");
    }
    const delta = input.countedQuantityScaled - source.quantityScaled;
    if (delta > 0) {
      if (input.unitCostMinor === null || input.unitCostMinor === undefined ||
          !Number.isSafeInteger(input.unitCostMinor) || input.unitCostMinor < 0) {
        throw new InventoryLedgerError("inventory_unit_cost_required");
      }
      const value = delta * input.unitCostMinor;
      if (!Number.isSafeInteger(value)) throw new InventoryLedgerError("inventory_quantity_overflow");
      movements.push(movement(source, delta, value));
      layers.push({
        layerId: `${input.commandId}.layer`,
        movementIndex: 0,
        layerKind: "adjustment",
        unitCostMinor: input.unitCostMinor,
      });
    } else if (delta < 0) {
      const plannedDraw = await draw(-delta);
      movements.push(movement(source, delta, -plannedDraw.valueMinor));
      allocations.push(...plannedDraw.allocations);
    } else {
      movements.push(movement(source, 0, 0));
    }
    companions.push({
      sql: `UPDATE inventory_count_lines
               SET counted_quantity_scaled = ?, variance_scaled = ?, status = 'applied',
                   counted_by_user_id = ?, counted_at = ?, adjustment_command_id = ?,
                   evidence_refs_json = ?, version = version + 1, updated_at = ?
             WHERE tenant_id = ? AND count_line_id = ? AND version = ?
               AND counted_quantity_scaled IS NULL`,
      params: [
        input.countedQuantityScaled,
        input.countedQuantityScaled - count.expected_quantity_scaled,
        input.actorUserId,
        input.now,
        input.commandId,
        JSON.stringify(input.evidenceRefs),
        input.now,
        input.tenantId,
        count.count_line_id,
        count.line_version,
      ],
    });
  } else if (input.transition === "transfer" || input.transition === "yield") {
    assertPositiveIntentQuantity(quantity, "inventory_command_quantity_required");
    const target = await resolveIntentPosition(env, input, "target");
    const targetEntity = await inventoryIntentEntity(
      env,
      input.tenantId,
      target.itemId,
      target.lotId,
      target.binId,
      target.uomId,
    );
    assertIntentEntity(targetEntity);
    if (target.positionId === source.positionId) {
      throw new InventoryLedgerError("inventory_transfer_target_required");
    }
    if (input.transition === "transfer" &&
        (target.itemId !== source.itemId || target.lotId !== source.lotId || target.uomId !== source.uomId)) {
      throw new InventoryLedgerError("inventory_transfer_identity_mismatch");
    }
    if (input.transition === "yield" &&
        (target.itemId !== source.itemId || target.uomId !== source.uomId ||
          targetEntity.parent_lot_id !== source.lotId ||
          !["remnant", "scrap"].includes(
            (await lotKind(env, input.tenantId, target.lotId)) ?? "",
          ))) {
      throw new InventoryLedgerError("inventory_yield_scope_invalid");
    }
    if (quantity > sourceAvailable) throw new InventoryLedgerError("inventory_position_insufficient_available");
    const plannedDraw = await draw(quantity);
    movements.push(movement(source, -quantity, -plannedDraw.valueMinor));
    // A transfer conserves the item/lot valuation pool; its allocations carry layer
    // provenance to the destination without consuming the global layer. The later
    // issue/reversal path performs the actual draw. Yield creates a new layer, so its
    // outbound draw is consumed here.
    allocations.push(...plannedDraw.allocations);
    movements.push(movement(target, quantity, plannedDraw.valueMinor));
    if (input.transition === "yield") {
      if (plannedDraw.valueMinor % quantity !== 0) {
        throw new InventoryLedgerError("inventory_yield_value_inexact");
      }
      layers.push({
        layerId: `${input.commandId}.yield-layer`,
        movementIndex: 1,
        layerKind: "remnant",
        unitCostMinor: plannedDraw.valueMinor / quantity,
      });
    }
  } else if (input.transition === "reversal") {
    const reversal = await planReversalIntent(env, input);
    movements.push(...reversal.movements);
    allocations.push(...reversal.allocations);
    layers.push(...reversal.layers);
  }

  if (movements.length === 0) throw new InventoryLedgerError("inventory_command_intent_invalid");
  return {
    commandId: input.commandId,
    tenantId: input.tenantId,
    transition: input.transition,
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    authorityRef: input.authorityRef,
    policyRef: input.policyRef,
    policyVersion: input.policyVersion,
    idempotencyKey: input.idempotencyKey,
    requestFingerprintSha256: input.requestFingerprintSha256,
    approvalId: input.approvalId ?? null,
    evidenceRefs: input.evidenceRefs,
    payload,
    movements,
    layers,
    allocations,
    companions,
    now: input.now,
  };
}

async function resolveIntentPosition(
  env: AppEnv,
  input: InventoryCommandIntentInput,
  side: "source" | "target",
): Promise<IntentPosition> {
  const positionId = side === "source" ? input.sourcePositionId : input.targetPositionId;
  if (positionId) {
    if (!POSITION_ID.test(positionId)) throw new InventoryLedgerError("inventory_position_invalid");
    const position = await positionById(env, input.tenantId, positionId);
    // Receiving and returning may open a new exact identity. The caller's position token is
    // only a selection hint in that case; the server derives the durable position id below from
    // the tenant-scoped item/lot/bin/UOM rows and never inserts a browser-composed identity.
    if (!position && !["receive", "return"].includes(input.transition)) {
      throw new InventoryLedgerError("inventory_position_unknown");
    }
    if (!position) {
      // Continue through the canonical identity resolver below.
    } else {
      if (side === "source" && (
          input.itemId && input.itemId !== position.item_id ||
          input.lotId && input.lotId !== position.lot_id ||
          input.binId && input.binId !== position.bin_id ||
          input.uomId && input.uomId !== position.uom_id ||
          input.jobCustody && input.jobCustody !== position.job_custody
        )) {
        throw new InventoryLedgerError("inventory_position_identity_mismatch");
      }
      return {
        positionId: position.position_id,
        itemId: position.item_id,
        lotId: position.lot_id,
        binId: position.bin_id,
        uomId: position.uom_id,
        jobCustody: position.job_custody,
        currency: position.currency,
        quantityScaled: position.quantity_scaled,
        reservedScaled: position.reserved_scaled,
        quarantinedScaled: position.quarantined_scaled,
        valueMinor: position.value_minor,
        version: position.version,
        existing: true,
      };
    }
  }
  if (side === "target") throw new InventoryLedgerError("inventory_target_position_required");
  if (!input.itemId || !input.lotId || !input.binId || !input.uomId) {
    throw new InventoryLedgerError("inventory_position_identity_required");
  }
  const jobCustody = input.jobCustody?.trim() || SHARED_CUSTODY;
  if (!CUSTODY.test(jobCustody)) throw new InventoryLedgerError("inventory_job_custody_invalid");
  const existing = await env.DB.prepare(
    `SELECT position_id, item_id, lot_id, bin_id, uom_id, job_custody,
            quantity_scaled, reserved_scaled, quarantined_scaled, value_minor, currency, version
       FROM inventory_positions
      WHERE tenant_id = ? AND item_id = ? AND lot_id = ? AND bin_id = ?
        AND uom_id = ? AND job_custody = ?
      LIMIT 1`,
  ).bind(input.tenantId, input.itemId, input.lotId, input.binId, input.uomId, jobCustody)
    .first<{
      position_id: string;
      item_id: string;
      lot_id: string;
      bin_id: string;
      uom_id: string;
      job_custody: string;
      quantity_scaled: number;
      reserved_scaled: number;
      quarantined_scaled: number;
      value_minor: number;
      currency: string;
      version: number;
    }>();
  const currency = input.currency?.trim() || "CAD";
  if (!/^[A-Z]{3}$/.test(currency)) throw new InventoryLedgerError("inventory_currency_invalid");
  if (existing && existing.currency !== currency) {
    throw new InventoryLedgerError("inventory_position_currency_mismatch");
  }
  return existing
    ? {
        positionId: existing.position_id,
        itemId: existing.item_id,
        lotId: existing.lot_id,
        binId: existing.bin_id,
        uomId: existing.uom_id,
        jobCustody: existing.job_custody,
        currency: existing.currency,
        quantityScaled: existing.quantity_scaled,
        reservedScaled: existing.reserved_scaled,
        quarantinedScaled: existing.quarantined_scaled,
        valueMinor: existing.value_minor,
        version: existing.version,
        existing: true,
      }
    : {
        positionId: `${input.commandId}.position`,
        itemId: input.itemId,
        lotId: input.lotId,
        binId: input.binId,
        uomId: input.uomId,
        jobCustody,
        currency,
        quantityScaled: 0,
        reservedScaled: 0,
        quarantinedScaled: 0,
        valueMinor: 0,
        version: 0,
        existing: false,
      };
}

async function inventoryIntentEntity(
  env: AppEnv,
  tenantId: string,
  itemId: string,
  lotId: string,
  binId: string,
  uomId: string,
): Promise<InventoryIntentEntity | null> {
  return await env.DB.prepare(
    `SELECT item.item_id, item.status AS item_status, item.valuation_method,
            lot.lot_id, lot.item_id AS lot_item_id, lot.status AS lot_status,
            lot.parent_lot_id, bin.bin_id, bin.status AS bin_status,
            bin.freeze_state, uom.uom_id, uom.status AS uom_status,
            uom.code AS uom_code
       FROM inventory_items AS item
       JOIN inventory_lots AS lot
         ON lot.tenant_id = item.tenant_id AND lot.item_id = item.item_id
        AND lot.lot_id = ?
       JOIN inventory_bins AS bin
         ON bin.tenant_id = item.tenant_id AND bin.bin_id = ?
       JOIN inventory_uoms AS uom
         ON uom.tenant_id = item.tenant_id AND uom.uom_id = ?
      WHERE item.tenant_id = ? AND item.item_id = ?
      LIMIT 1`,
  ).bind(lotId, binId, uomId, tenantId, itemId).first<InventoryIntentEntity>();
}

function assertIntentEntity(entity: InventoryIntentEntity | null): asserts entity is InventoryIntentEntity {
  if (!entity) throw new InventoryLedgerError("inventory_identity_unknown");
  if (entity.item_status !== "active") throw new InventoryLedgerError("inventory_item_not_active");
  if (entity.lot_item_id !== entity.item_id) throw new InventoryLedgerError("inventory_lot_item_mismatch");
  if (["observed_pending_validation", "rejected"].includes(entity.lot_status)) {
    throw new InventoryLedgerError("inventory_lot_not_validated");
  }
  if (entity.bin_status !== "active") throw new InventoryLedgerError("inventory_bin_not_active");
  if (entity.uom_status !== "active") throw new InventoryLedgerError("inventory_uom_not_active");
}

async function lotKind(env: AppEnv, tenantId: string, lotId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT lot_kind FROM inventory_lots WHERE tenant_id = ? AND lot_id = ? LIMIT 1`,
  ).bind(tenantId, lotId).first<{ lot_kind: string }>();
  return row?.lot_kind ?? null;
}

async function approvedInventoryApproval(
  env: AppEnv,
  tenantId: string,
  approvalId: string,
  approvalKind: "quarantine_release" | "count_variance",
  subjectId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT approval_id
       FROM inventory_approvals
      WHERE tenant_id = ? AND approval_id = ? AND approval_kind = ?
        AND subject_id = ? AND decision = 'approved'
      LIMIT 1`,
  ).bind(tenantId, approvalId, approvalKind, subjectId).first<{ approval_id: string }>();
  return !!row;
}

async function planReceiptCompanion(
  env: AppEnv,
  input: InventoryCommandIntentInput,
  source: IntentPosition,
  sourceEntity: InventoryIntentEntity,
  quantity: number,
  companions: InventoryCompanionStatement[],
): Promise<void> {
  if (!input.poLineId?.trim() || !input.receiptId?.trim()) {
    throw new InventoryLedgerError("inventory_receipt_reference_required");
  }
  const po = await env.DB.prepare(
    `SELECT po_line_id, line_no, item_id, uom_id, ordered_quantity_scaled,
            unit_price_minor, tax_minor, freight_minor, currency
       FROM inventory_po_lines
      WHERE tenant_id = ? AND po_line_id = ? LIMIT 1`,
  ).bind(input.tenantId, input.poLineId.trim()).first<{
    po_line_id: string;
    line_no: number;
    item_id: string;
    uom_id: string;
    ordered_quantity_scaled: number;
    unit_price_minor: number;
    tax_minor: number;
    freight_minor: number;
    currency: string;
  }>();
  if (!po || po.item_id !== source.itemId || po.uom_id !== source.uomId ||
      po.currency !== source.currency) {
    throw new InventoryLedgerError("inventory_receipt_po_identity_mismatch");
  }
  const previouslyReceived = await env.DB.prepare(
    `SELECT COALESCE(SUM(received_quantity_scaled), 0) AS received_scaled
       FROM inventory_receipt_lines
      WHERE tenant_id = ? AND po_line_id = ?`,
  ).bind(input.tenantId, po.po_line_id).first<{ received_scaled: number }>();
  const unitCost = input.unitCostMinor ?? 0;
  const condition = input.conditionStatus ?? "accepted";
  if (condition !== "accepted") throw new InventoryLedgerError("inventory_receipt_condition_requires_exception");
  const exceptionStatus = classifyReceiptException({
    orderedQuantityScaled: Number(po.ordered_quantity_scaled),
    previouslyReceivedScaled: Number(previouslyReceived?.received_scaled ?? 0),
    receivedQuantityScaled: quantity,
    orderedUomId: po.uom_id,
    receivedUomId: source.uomId,
    orderedItemId: po.item_id,
    receivedItemId: source.itemId,
    orderedUnitPriceMinor: Number(po.unit_price_minor),
    receivedUnitPriceMinor: unitCost,
    orderedTaxMinor: Number(po.tax_minor),
    receivedTaxMinor: Number(po.tax_minor),
    orderedFreightMinor: Number(po.freight_minor),
    receivedFreightMinor: Number(po.freight_minor),
    conditionStatus: condition,
    lotBelongsToItem: sourceEntity.lot_item_id === source.itemId,
  });
  companions.push({
    sql: `INSERT INTO inventory_receipt_lines
            (receipt_line_id, tenant_id, receipt_id, po_line_id, line_no, item_id, lot_id,
             uom_id, received_quantity_scaled, unit_price_minor, tax_minor, freight_minor,
             currency, condition_status, exception_status, received_by_user_id, command_id,
             evidence_refs_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      `${input.commandId}.receipt-line`,
      input.tenantId,
      input.receiptId.trim(),
      po.po_line_id,
      po.line_no,
      source.itemId,
      source.lotId,
      source.uomId,
      quantity,
      unitCost,
      po.tax_minor,
      po.freight_minor,
      source.currency,
      condition,
      exceptionStatus,
      input.actorUserId,
      input.commandId,
      JSON.stringify(input.evidenceRefs),
      input.now,
    ],
  });
}

async function planReversalIntent(
  env: AppEnv,
  input: InventoryCommandIntentInput,
): Promise<{
  movements: InventoryMovement[];
  allocations: InventoryAllocationInput[];
  layers: InventoryLayerInput[];
}> {
  if (!input.reversalReference?.trim()) {
    throw new InventoryLedgerError("inventory_reversal_reference_required");
  }
  const original = await commandById(env, input.tenantId, input.reversalReference.trim());
  if (!original || original.status !== "applied" ||
      !["transfer", "yield", "reversal"].includes(original.transition)) {
    throw new InventoryLedgerError("inventory_reversal_transition_invalid");
  }
  const alreadyReversed = await env.DB.prepare(
    `SELECT command_id
       FROM inventory_commands
      WHERE tenant_id = ? AND transition = 'reversal' AND payload_json LIKE ?
      LIMIT 1`,
  ).bind(input.tenantId, `%"reversal_of":"${input.reversalReference.trim()}"%`)
    .first<{ command_id: string }>();
  if (alreadyReversed) throw new InventoryLedgerError("inventory_reversal_already_applied");
  const events = await env.DB.prepare(
    `SELECT position_id, item_id, lot_id, bin_id, uom_id, job_custody,
            quantity_delta_scaled, reserved_delta_scaled, quarantined_delta_scaled,
            value_delta_minor, currency
       FROM inventory_events
      WHERE tenant_id = ? AND command_id = ? ORDER BY movement_seq ASC`,
  ).bind(input.tenantId, input.reversalReference.trim()).all<{
    position_id: string;
    item_id: string;
    lot_id: string;
    bin_id: string;
    uom_id: string;
    job_custody: string;
    quantity_delta_scaled: number;
    reserved_delta_scaled: number;
    quarantined_delta_scaled: number;
    value_delta_minor: number;
    currency: string;
  }>();
  if (events.results.length < 1) throw new InventoryLedgerError("inventory_reversal_events_missing");
  const movements: InventoryMovement[] = [];
  const allocations: InventoryAllocationInput[] = [];
  for (const [index, event] of events.results.entries()) {
    const position = await positionById(env, input.tenantId, event.position_id);
    if (!position || position.item_id !== event.item_id || position.lot_id !== event.lot_id ||
        position.bin_id !== event.bin_id || position.uom_id !== event.uom_id ||
        position.job_custody !== event.job_custody) {
      throw new InventoryLedgerError("inventory_reversal_position_changed");
    }
    const inverseQuantity = -Number(event.quantity_delta_scaled);
    const inverseReserved = -Number(event.reserved_delta_scaled);
    const inverseQuarantined = -Number(event.quarantined_delta_scaled);
    let inverseValue = -Number(event.value_delta_minor);
    if (inverseQuantity < 0) {
      const method = await itemValuationMethod(env, input.tenantId, event.item_id);
      if (!method) throw new InventoryLedgerError("inventory_item_unknown");
      const draw = await planValuationDraw(env, {
        tenantId: input.tenantId,
        itemId: event.item_id,
        lotId: event.lot_id,
        quantityScaled: -inverseQuantity,
        method,
      });
      if (!draw) throw new InventoryLedgerError("inventory_reversal_valuation_unavailable");
      const drawValue = draw.reduce((sum, entry) => sum + entry.quantityScaled * entry.unitCostMinor, 0);
      if (drawValue !== -inverseValue) throw new InventoryLedgerError("inventory_reversal_value_changed");
      allocations.push(...draw.map((entry, allocationIndex) => ({
        allocationId: `${input.commandId}.allocation${index + 1}.${allocationIndex + 1}`,
        movementIndex: index,
        layerId: entry.layerId,
        quantityScaled: entry.quantityScaled,
      })));
    }
    if (position.quantity_scaled + inverseQuantity < 0 ||
        position.reserved_scaled + inverseReserved < 0 ||
        position.quarantined_scaled + inverseQuarantined < 0) {
      throw new InventoryLedgerError("inventory_reversal_position_insufficient");
    }
    movements.push({
      positionId: position.position_id,
      itemId: position.item_id,
      lotId: position.lot_id,
      binId: position.bin_id,
      uomId: position.uom_id,
      jobCustody: position.job_custody,
      quantityDelta: inverseQuantity,
      reservedDelta: inverseReserved,
      quarantinedDelta: inverseQuarantined,
      valueDelta: inverseValue,
      currency: position.currency,
      payload: { reversal_of: input.reversalReference.trim() },
    });
  }
  return { movements, allocations, layers: [] };
}

function assertPositiveIntentQuantity(
  quantity: number | null,
  code: string,
): asserts quantity is number {
  if (quantity === null || !Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new InventoryLedgerError(code);
  }
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
        if (input.transition !== "transfer") layerDraw.set(allocation.layerId, nextDrawn);
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

export async function inventoryOverviewSummary(
  env: AppEnv,
  tenantId: string,
): Promise<{
  position_count: number;
  item_count: number;
  quantity_scaled: number;
  reserved_scaled: number;
  quarantined_scaled: number;
  value_minor: number;
  quantity_by_uom: Array<{
    uom_id: string;
    uom_code: string;
    uom_scale: number;
    quantity_scaled: number;
    reserved_scaled: number;
    quarantined_scaled: number;
  }>;
  value_by_currency: Array<{ currency: string; value_minor: number }>;
}> {
  if (!TENANT_ID.test(tenantId)) {
    return {
      position_count: 0,
      item_count: 0,
      quantity_scaled: 0,
      reserved_scaled: 0,
      quarantined_scaled: 0,
      value_minor: 0,
      quantity_by_uom: [],
      value_by_currency: [],
    };
  }
  const [positions, items, quantities, values] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS position_count,
              COALESCE(SUM(quantity_scaled), 0) AS quantity_scaled,
              COALESCE(SUM(reserved_scaled), 0) AS reserved_scaled,
              COALESCE(SUM(quarantined_scaled), 0) AS quarantined_scaled,
              COALESCE(SUM(value_minor), 0) AS value_minor
         FROM inventory_positions
        WHERE tenant_id = ?`,
    ).bind(tenantId).first<{
      position_count: number;
      quantity_scaled: number;
      reserved_scaled: number;
      quarantined_scaled: number;
      value_minor: number;
    }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS item_count
         FROM inventory_items
        WHERE tenant_id = ? AND status != 'retired'`,
    ).bind(tenantId).first<{ item_count: number }>(),
    env.DB.prepare(
      `SELECT position.uom_id, uom.code AS uom_code, uom.scale AS uom_scale,
              COALESCE(SUM(position.quantity_scaled), 0) AS quantity_scaled,
              COALESCE(SUM(position.reserved_scaled), 0) AS reserved_scaled,
              COALESCE(SUM(position.quarantined_scaled), 0) AS quarantined_scaled
         FROM inventory_positions AS position
         JOIN inventory_uoms AS uom
           ON uom.tenant_id = position.tenant_id AND uom.uom_id = position.uom_id
        WHERE position.tenant_id = ?
        GROUP BY position.uom_id, uom.code, uom.scale
        ORDER BY uom.code ASC`,
    ).bind(tenantId).all<{
      uom_id: string;
      uom_code: string;
      uom_scale: number;
      quantity_scaled: number;
      reserved_scaled: number;
      quarantined_scaled: number;
    }>(),
    env.DB.prepare(
      `SELECT currency, COALESCE(SUM(value_minor), 0) AS value_minor
         FROM inventory_positions
        WHERE tenant_id = ?
        GROUP BY currency
        ORDER BY currency ASC`,
    ).bind(tenantId).all<{ currency: string; value_minor: number }>(),
  ]);
  const quantityByUom = quantities.results.map((row) => ({
    uom_id: row.uom_id,
    uom_code: row.uom_code,
    uom_scale: Number(row.uom_scale),
    quantity_scaled: Number(row.quantity_scaled),
    reserved_scaled: Number(row.reserved_scaled),
    quarantined_scaled: Number(row.quarantined_scaled),
  }));
  const valueByCurrency = values.results.map((row) => ({
    currency: row.currency,
    value_minor: Number(row.value_minor),
  }));
  return {
    position_count: Number(positions?.position_count ?? 0),
    item_count: Number(items?.item_count ?? 0),
    // These legacy scalar fields are meaningful only when the tenant has one unit/currency. A
    // mixed-unit overview intentionally exposes zero here and consumers must use the grouped
    // fields instead of summing incomparable scales.
    quantity_scaled: quantityByUom.length === 1
      ? quantityByUom[0]?.quantity_scaled ?? 0
      : 0,
    reserved_scaled: quantityByUom.length === 1
      ? quantityByUom[0]?.reserved_scaled ?? 0
      : 0,
    quarantined_scaled: quantityByUom.length === 1
      ? quantityByUom[0]?.quarantined_scaled ?? 0
      : 0,
    value_minor: valueByCurrency.length === 1 ? valueByCurrency[0]?.value_minor ?? 0 : 0,
    quantity_by_uom: quantityByUom,
    value_by_currency: valueByCurrency,
  };
}

export async function listInventoryOverviewPositions(
  env: AppEnv,
  tenantId: string,
  limit = 100,
): Promise<InventoryOverviewPosition[]> {
  if (!TENANT_ID.test(tenantId)) return [];
  const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100;
  const rows = await env.DB.prepare(
    `SELECT position.position_id, position.item_id, item.item_code, item.item_kind,
            position.lot_id, lot.lot_code, lot.status AS lot_status,
            lot.lot_kind, lot.parent_lot_id,
            position.bin_id, bin.bin_code, location.location_code, location.name AS location_name,
            position.job_custody, position.uom_id, uom.code AS uom_code,
            uom.dimension AS uom_dimension, uom.scale AS uom_scale,
            item.quantity_scale, position.quantity_scaled,
            position.reserved_scaled, position.quarantined_scaled, position.value_minor,
            position.currency, position.version, position.last_event_id, position.updated_at
       FROM inventory_positions AS position
       JOIN inventory_items AS item
         ON item.tenant_id = position.tenant_id AND item.item_id = position.item_id
       JOIN inventory_lots AS lot
         ON lot.tenant_id = position.tenant_id AND lot.lot_id = position.lot_id
       JOIN inventory_bins AS bin
         ON bin.tenant_id = position.tenant_id AND bin.bin_id = position.bin_id
       JOIN inventory_locations AS location
         ON location.tenant_id = position.tenant_id AND location.location_id = bin.location_id
       JOIN inventory_uoms AS uom
         ON uom.tenant_id = position.tenant_id AND uom.uom_id = position.uom_id
      WHERE position.tenant_id = ?
      ORDER BY item.item_code ASC, bin.bin_code ASC, lot.lot_code ASC, position.job_custody ASC
      LIMIT ?`,
  ).bind(tenantId, bounded).all<InventoryOverviewPosition>();
  return rows.results;
}

export async function listInventoryItems(
  env: AppEnv,
  tenantId: string,
  limit = 100,
): Promise<InventoryItemSummary[]> {
  if (!TENANT_ID.test(tenantId)) return [];
  const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100;
  const rows = await env.DB.prepare(
    `SELECT item.item_id, item.item_code, item.status, item.item_kind, item.base_uom_id,
            base_uom.code AS base_uom_code, base_uom.dimension AS base_uom_dimension,
            base_uom.scale AS base_uom_scale, item.quantity_scale, item.lot_controlled,
            item.valuation_method
       FROM inventory_items AS item
       JOIN inventory_uoms AS base_uom
         ON base_uom.tenant_id = item.tenant_id AND base_uom.uom_id = item.base_uom_id
      WHERE item.tenant_id = ? AND item.status != 'retired'
      ORDER BY item.item_code ASC, item.revision DESC
      LIMIT ?`,
  ).bind(tenantId, bounded).all<InventoryItemSummary>();
  return rows.results;
}

export async function listInventoryValuationLayers(
  env: AppEnv,
  tenantId: string,
  limit = 100,
): Promise<InventoryValuationLayerSummary[]> {
  if (!TENANT_ID.test(tenantId)) return [];
  const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100;
  const rows = await env.DB.prepare(
    `SELECT layer.layer_id, layer.item_id, item.item_code, layer.lot_id, lot.lot_code,
            uom.code AS uom_code, uom.scale AS uom_scale, layer.layer_kind, layer.quantity_scaled,
            layer.remaining_scaled, layer.unit_cost_minor, layer.value_minor, layer.currency,
            layer.method
       FROM inventory_valuation_layers AS layer
       JOIN inventory_items AS item
         ON item.tenant_id = layer.tenant_id AND item.item_id = layer.item_id
       JOIN inventory_lots AS lot
         ON lot.tenant_id = layer.tenant_id AND lot.lot_id = layer.lot_id
       JOIN inventory_uoms AS uom
         ON uom.tenant_id = layer.tenant_id AND uom.uom_id = item.base_uom_id
      WHERE layer.tenant_id = ? AND layer.remaining_scaled > 0
      ORDER BY layer.created_at ASC, layer.layer_id ASC
      LIMIT ?`,
  ).bind(tenantId, bounded).all<InventoryValuationLayerSummary>();
  return rows.results;
}

export async function listInventoryUomConversions(
  env: AppEnv,
  tenantId: string,
  limit = 100,
): Promise<InventoryUomConversionSummary[]> {
  if (!TENANT_ID.test(tenantId)) return [];
  const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100;
  const rows = await env.DB.prepare(
    `SELECT conversion.conversion_id, conversion.from_uom_id,
            from_uom.code AS from_uom_code, conversion.to_uom_id,
            to_uom.code AS to_uom_code, conversion.dimension,
            conversion.numerator, conversion.denominator, conversion.version,
            conversion.source_ref
       FROM inventory_uom_conversions AS conversion
       JOIN inventory_uoms AS from_uom
         ON from_uom.tenant_id = conversion.tenant_id AND from_uom.uom_id = conversion.from_uom_id
       JOIN inventory_uoms AS to_uom
         ON to_uom.tenant_id = conversion.tenant_id AND to_uom.uom_id = conversion.to_uom_id
      WHERE conversion.tenant_id = ? AND conversion.status = 'active'
      ORDER BY from_uom.code ASC, to_uom.code ASC, conversion.version DESC
      LIMIT ?`,
  ).bind(tenantId, bounded).all<InventoryUomConversionSummary>();
  return rows.results;
}

export async function listRecentInventoryScans(
  env: AppEnv,
  tenantId: string,
  limit = 20,
): Promise<InventoryRecentScan[]> {
  if (!TENANT_ID.test(tenantId)) return [];
  const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20;
  const rows = await env.DB.prepare(
    `SELECT scan_id, barcode, scan_intent, observed_at, captured_offline,
            resolution, resolved_entity_type, resolved_entity_id
       FROM inventory_scans
      WHERE tenant_id = ?
      ORDER BY observed_at DESC, scan_id DESC
      LIMIT ?`,
  ).bind(tenantId, bounded).all<InventoryRecentScan>();
  return rows.results;
}

export async function lookupInventoryBarcode(
  env: AppEnv,
  tenantId: string,
  barcode: string,
): Promise<InventoryBarcodeLookup | null> {
  if (!TENANT_ID.test(tenantId) || !barcode.trim()) return null;
  return await env.DB.prepare(
    `SELECT barcode.barcode, barcode.symbology, barcode.entity_type, barcode.entity_id,
            COALESCE(direct_item.item_code, lot_item.item_code) AS item_code,
            lot.lot_code, bin.bin_code, location.location_code
       FROM inventory_barcodes AS barcode
       LEFT JOIN inventory_items AS direct_item
         ON direct_item.tenant_id = barcode.tenant_id
        AND barcode.entity_type = 'item'
        AND direct_item.item_id = barcode.entity_id
       LEFT JOIN inventory_lots AS lot
         ON lot.tenant_id = barcode.tenant_id
        AND barcode.entity_type = 'lot'
        AND lot.lot_id = barcode.entity_id
       LEFT JOIN inventory_items AS lot_item
         ON lot_item.tenant_id = lot.tenant_id AND lot_item.item_id = lot.item_id
       LEFT JOIN inventory_bins AS bin
         ON bin.tenant_id = barcode.tenant_id
        AND barcode.entity_type = 'bin'
        AND bin.bin_id = barcode.entity_id
       LEFT JOIN inventory_locations AS location
         ON location.tenant_id = bin.tenant_id AND location.location_id = bin.location_id
      WHERE barcode.tenant_id = ? AND barcode.barcode = ? AND barcode.status = 'active'
      LIMIT 1`,
  ).bind(tenantId, barcode.trim()).first<InventoryBarcodeLookup>();
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

function validateCommandIntentInput(input: InventoryCommandIntentInput): void {
  if (!TENANT_ID.test(input.tenantId) || !OPAQUE_ID.test(input.commandId) ||
      input.commandId.length > 150 || !INVENTORY_TRANSITIONS.includes(input.transition) ||
      !USER_ID.test(input.actorUserId) || !boundedText(input.authorityRef, 1, 280) ||
      !boundedText(input.policyRef, 1, 280) || !boundedText(input.policyVersion, 1, 80) ||
      !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
      !SHA256.test(input.requestFingerprintSha256) || !ISO_INSTANT.test(input.now) ||
      !Array.isArray(input.evidenceRefs) || input.evidenceRefs.length < 1 ||
      !validEvidenceRefs(input.evidenceRefs)) {
    throw new InventoryLedgerError("inventory_command_intent_invalid");
  }
  if (input.approvalId !== undefined && input.approvalId !== null &&
      !OPAQUE_ID.test(input.approvalId)) {
    throw new InventoryLedgerError("inventory_command_intent_invalid");
  }
  for (const value of [
    input.sourcePositionId,
    input.targetPositionId,
    input.itemId,
    input.lotId,
    input.binId,
    input.uomId,
    input.reservationId,
    input.receiptId,
    input.poLineId,
    input.countSessionId,
    input.reversalReference,
  ]) {
    if (value !== undefined && value !== null && !OPAQUE_ID.test(value)) {
      throw new InventoryLedgerError("inventory_command_intent_invalid");
    }
  }
  if (input.jobCustody !== undefined && input.jobCustody !== null &&
      !CUSTODY.test(input.jobCustody)) {
    throw new InventoryLedgerError("inventory_command_intent_invalid");
  }
  if (input.jobId !== undefined && input.jobId !== null && !boundedText(input.jobId, 1, 160) ||
      input.workPackageId !== undefined && input.workPackageId !== null &&
        !boundedText(input.workPackageId, 1, 160)) {
    throw new InventoryLedgerError("inventory_command_intent_invalid");
  }
  for (const value of [input.quantityScaled, input.countedQuantityScaled, input.unitCostMinor]) {
    if (value !== undefined && value !== null && !Number.isSafeInteger(value)) {
      throw new InventoryLedgerError("inventory_command_intent_invalid");
    }
  }
  if (input.quantityScaled !== undefined && input.quantityScaled !== null && input.quantityScaled < 0 ||
      input.countedQuantityScaled !== undefined && input.countedQuantityScaled !== null &&
        input.countedQuantityScaled < 0 ||
      input.unitCostMinor !== undefined && input.unitCostMinor !== null && input.unitCostMinor < 0) {
    throw new InventoryLedgerError("inventory_command_intent_invalid");
  }
  if (input.currency !== undefined && input.currency !== null &&
      !/^[A-Z]{3}$/.test(input.currency)) {
    throw new InventoryLedgerError("inventory_command_intent_invalid");
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
