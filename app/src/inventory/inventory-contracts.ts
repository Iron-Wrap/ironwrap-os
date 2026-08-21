import { z } from "zod";

export const inventoryTransitions = [
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

export type InventoryTransition = (typeof inventoryTransitions)[number];

const inventoryAuthoritySchema = z.object({
  authority_ref: z.string().nullable(),
  authority_record_id: z.string().nullable(),
  authority_version: z.number().int().nullable(),
  observed_at: z.string().nullable(),
  verification_state: z.enum(["verified", "revoked", "contradictory", "unavailable", "missing"]),
});

export type InventoryAuthority = z.infer<typeof inventoryAuthoritySchema>;

const inventoryOverviewPositionSchema = z.object({
  position_id: z.string(),
  item_id: z.string(),
  item_code: z.string(),
  item_kind: z.string(),
  lot_id: z.string(),
  lot_code: z.string(),
  lot_status: z.string(),
  lot_kind: z.string(),
  parent_lot_id: z.string().nullable(),
  bin_id: z.string(),
  bin_code: z.string(),
  location_code: z.string(),
  location_name: z.string(),
  job_custody: z.string(),
  uom_id: z.string(),
  uom_code: z.string(),
  uom_dimension: z.string(),
  uom_scale: z.number().int().nonnegative(),
  quantity_scale: z.number().int().nonnegative(),
  quantity_scaled: z.number().int(),
  reserved_scaled: z.number().int(),
  quarantined_scaled: z.number().int(),
  value_minor: z.number().int(),
  currency: z.string(),
  version: z.number().int(),
  last_event_id: z.string(),
  updated_at: z.string(),
});

export type InventoryOverviewPosition = z.infer<typeof inventoryOverviewPositionSchema>;

const inventoryItemSchema = z.object({
  item_id: z.string(),
  item_code: z.string(),
  status: z.enum(["draft", "active", "retired"]),
  item_kind: z.string(),
  base_uom_id: z.string(),
  base_uom_code: z.string(),
  base_uom_dimension: z.string(),
  base_uom_scale: z.number().int().nonnegative(),
  quantity_scale: z.number().int().nonnegative(),
  lot_controlled: z.number().int().min(0).max(1),
  valuation_method: z.enum(["actual", "fifo"]),
});

export type InventoryItem = z.infer<typeof inventoryItemSchema>;

const inventoryValuationLayerSchema = z.object({
  layer_id: z.string(),
  item_id: z.string(),
  item_code: z.string(),
  lot_id: z.string(),
  lot_code: z.string(),
  uom_code: z.string(),
  uom_scale: z.number().int().nonnegative(),
  layer_kind: z.enum(["receipt", "return", "remnant", "adjustment", "correction"]),
  quantity_scaled: z.number().int().positive(),
  remaining_scaled: z.number().int().nonnegative(),
  unit_cost_minor: z.number().int().nonnegative(),
  value_minor: z.number().int().nonnegative(),
  currency: z.string(),
  method: z.enum(["actual", "fifo"]),
});

export type InventoryValuationLayer = z.infer<typeof inventoryValuationLayerSchema>;

const inventoryUomConversionSchema = z.object({
  conversion_id: z.string(),
  from_uom_id: z.string(),
  from_uom_code: z.string(),
  to_uom_id: z.string(),
  to_uom_code: z.string(),
  dimension: z.string(),
  numerator: z.number().int().positive(),
  denominator: z.number().int().positive(),
  version: z.number().int().positive(),
  source_ref: z.string(),
});

export type InventoryUomConversion = z.infer<typeof inventoryUomConversionSchema>;

const inventoryRecentScanSchema = z.object({
  scan_id: z.string(),
  barcode: z.string(),
  scan_intent: z.string(),
  observed_at: z.string(),
  captured_offline: z.number().int(),
  resolution: z.enum([
    "resolved",
    "duplicate",
    "conflict",
    "observed_pending_validation",
    "rejected",
  ]),
  resolved_entity_type: z.string().nullable(),
  resolved_entity_id: z.string().nullable(),
});

export type InventoryRecentScan = z.infer<typeof inventoryRecentScanSchema>;

export const inventoryOverviewResponseSchema = z.object({
  version: z.literal(1),
  read_model_generated_at: z.string(),
  allowed_transitions: z.array(z.enum(inventoryTransitions)),
  authority_ref: z.string().nullable(),
  policy_ref: z.string(),
  policy_version: z.string(),
  authority: inventoryAuthoritySchema,
  summary: z.object({
    position_count: z.number().int().nonnegative(),
    item_count: z.number().int().nonnegative(),
    quantity_scaled: z.number().int().nonnegative(),
    reserved_scaled: z.number().int().nonnegative(),
    quarantined_scaled: z.number().int().nonnegative(),
    value_minor: z.number().int().nonnegative(),
    quantity_by_uom: z.array(
      z.object({
        uom_id: z.string(),
        uom_code: z.string(),
        uom_scale: z.number().int().nonnegative(),
        quantity_scaled: z.number().int().nonnegative(),
        reserved_scaled: z.number().int().nonnegative(),
        quarantined_scaled: z.number().int().nonnegative(),
      }),
    ),
    value_by_currency: z.array(
      z.object({
        currency: z.string(),
        value_minor: z.number().int().nonnegative(),
      }),
    ),
  }),
  items: z.array(inventoryItemSchema),
  positions: z.array(inventoryOverviewPositionSchema),
  valuation_layers: z.array(inventoryValuationLayerSchema),
  uom_conversions: z.array(inventoryUomConversionSchema),
  recent_scans: z.array(inventoryRecentScanSchema),
});

export type InventoryOverviewResponse = z.infer<typeof inventoryOverviewResponseSchema>;

export const inventoryLookupResponseSchema = z.object({
  version: z.literal(1),
  barcode: z.string(),
  result: z
    .object({
      barcode: z.string(),
      symbology: z.string(),
      entity_type: z.enum(["item", "lot", "bin"]),
      entity_id: z.string(),
      item_code: z.string().nullable(),
      lot_code: z.string().nullable(),
      bin_code: z.string().nullable(),
      location_code: z.string().nullable(),
    })
    .nullable(),
});

export type InventoryLookupResponse = z.infer<typeof inventoryLookupResponseSchema>;

const inventoryCommandSchema = z.object({
  command_id: z.string(),
  tenant_id: z.string(),
  transition: z.enum(inventoryTransitions),
  actor_type: z.string(),
  actor_user_id: z.string(),
  authority_ref: z.string(),
  policy_ref: z.string(),
  policy_version: z.string(),
  idempotency_key_sha256: z.string(),
  request_fingerprint_sha256: z.string(),
  approval_id: z.string().nullable(),
  evidence_refs_json: z.string(),
  payload_json: z.string(),
  status: z.enum(["pending", "applied", "rejected", "conflict", "reconciliation_required"]),
  result_json: z.string().nullable(),
  rejection_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});

export type InventoryCommand = z.infer<typeof inventoryCommandSchema>;

export const inventoryCommandResponseSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["applied", "replayed", "conflict", "rejected"]),
  command: inventoryCommandSchema,
  eventIds: z.array(z.string()).optional(),
  code: z.string().optional(),
});

export type InventoryCommandResponse = z.infer<typeof inventoryCommandResponseSchema>;

const inventoryScanSchema = z.object({
  scan_id: z.string(),
  tenant_id: z.string(),
  device_id: z.string(),
  device_action_id: z.string(),
  actor_user_id: z.string(),
  barcode: z.string(),
  scan_intent: z.string(),
  request_fingerprint_sha256: z.string(),
  observed_at: z.string(),
  captured_offline: z.number().int(),
  resolution: z.enum([
    "resolved",
    "duplicate",
    "conflict",
    "observed_pending_validation",
    "rejected",
  ]),
  resolved_entity_type: z.string().nullable(),
  resolved_entity_id: z.string().nullable(),
  command_id: z.string().nullable(),
  exception_id: z.string().nullable(),
  payload_json: z.string(),
  created_at: z.string(),
});

export const inventoryScanResponseSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["recorded", "duplicate", "conflict"]),
  scan: inventoryScanSchema,
});

export type InventoryScanResponse = z.infer<typeof inventoryScanResponseSchema>;

export interface InventoryCommandInput {
  command_id: string;
  idempotency_key: string;
  request_fingerprint_sha256?: string;
  transition: InventoryTransition;
  authority_ref: string;
  policy_ref: string;
  policy_version: string;
  evidence_refs: Array<{ ref: string; sha256: string }>;
  approval_id?: string | null;
  source_position_id?: string | null;
  target_position_id?: string | null;
  item_id?: string | null;
  lot_id?: string | null;
  bin_id?: string | null;
  uom_id?: string | null;
  job_custody?: string | null;
  quantity_scaled?: number | null;
  counted_quantity_scaled?: number | null;
  unit_cost_minor?: number | null;
  currency?: string | null;
  job_id?: string | null;
  work_package_id?: string | null;
  reservation_id?: string | null;
  receipt_id?: string | null;
  po_line_id?: string | null;
  count_session_id?: string | null;
  reversal_reference?: string | null;
  condition_status?: "accepted" | "damaged" | "quarantined" | null;
  payload?: Record<string, unknown>;
}

export interface InventoryScanInput {
  scan_id: string;
  device_id: string;
  device_action_id: string;
  barcode: string;
  scan_intent: "receive" | "issue_use" | "return" | "transfer" | "count" | "lookup";
  observed_at: string;
  captured_offline: boolean;
  payload?: Record<string, unknown>;
  request_fingerprint_sha256?: string;
}

export function inventoryTransitionLabel(transition: InventoryTransition): string {
  return transition === "issue_use"
    ? "Issue for use"
    : transition === "release_reservation"
      ? "Release reservation"
      : transition === "release_quarantine"
        ? "Release quarantine"
        : transition === "count_freeze"
          ? "Freeze count"
          : transition === "count_adjustment"
            ? "Adjust count"
            : transition.charAt(0).toUpperCase() + transition.slice(1).replaceAll("_", " ");
}

export function inventoryStatusLabel(status: InventoryAuthority["verification_state"]): string {
  return status === "verified"
    ? "Verified"
    : status === "missing"
      ? "No current authority"
      : status.charAt(0).toUpperCase() + status.slice(1);
}
