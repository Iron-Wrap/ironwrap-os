import { validAppCsrf } from "./app-auth.ts";
import {
  applyInventoryCommand,
  getInventoryCommand,
  getInventoryPosition,
  INVENTORY_TRANSITIONS,
  InventoryLedgerError,
  listInventoryPositions,
  recordInventoryScan,
  type EvidenceRef,
  type InventoryAllocationInput,
  type InventoryLayerInput,
  type InventoryMovement,
  type InventoryTransition,
} from "./inventory-control.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";

/**
 * Inventory routes.
 *
 * Writes are restricted to the same roles the ledger trigger admits, so a request that
 * would be refused by the database is refused at the edge with the same meaning. Every
 * refusal returns its exact machine-readable code: a caller must be able to tell a
 * conservation failure from an authorization failure without parsing prose.
 */

const MAX_BODY_BYTES = 64 * 1024;
const WRITE_ROLES = new Set(["owner", "ops", "field"]);
const READ_ROLES = new Set(["owner", "ops", "production", "field"]);

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const POSITION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,239}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function body(
  req: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerField(value: unknown): number | null {
  return Number.isSafeInteger(value) ? (value as number) : null;
}

function pathPart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return OPAQUE_ID.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function evidenceRefs(value: unknown): readonly EvidenceRef[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const refs: EvidenceRef[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const ref = stringField(entry.ref);
    const sha256 = stringField(entry.sha256);
    if (!ref || !sha256 || !SHA256.test(sha256)) return null;
    refs.push({ ref, sha256 });
  }
  return refs;
}

function movements(value: unknown): readonly InventoryMovement[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) return null;
  const parsed: InventoryMovement[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const positionId = stringField(entry.position_id);
    const itemId = stringField(entry.item_id);
    const lotId = stringField(entry.lot_id);
    const binId = stringField(entry.bin_id);
    const uomId = stringField(entry.uom_id);
    const jobCustody = stringField(entry.job_custody);
    const quantityDelta = integerField(entry.quantity_delta_scaled);
    if (!positionId || !POSITION_ID.test(positionId) || !itemId || !lotId || !binId ||
        !uomId || !jobCustody || quantityDelta === null) {
      return null;
    }
    const reservedDelta = entry.reserved_delta_scaled === undefined
      ? 0
      : integerField(entry.reserved_delta_scaled);
    const quarantinedDelta = entry.quarantined_delta_scaled === undefined
      ? 0
      : integerField(entry.quarantined_delta_scaled);
    const valueDelta = entry.value_delta_minor === undefined
      ? 0
      : integerField(entry.value_delta_minor);
    if (reservedDelta === null || quarantinedDelta === null || valueDelta === null) return null;
    parsed.push({
      positionId,
      itemId,
      lotId,
      binId,
      uomId,
      jobCustody,
      quantityDelta,
      reservedDelta,
      quarantinedDelta,
      valueDelta,
    });
  }
  return parsed;
}

function layers(value: unknown): readonly InventoryLayerInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) return null;
  const parsed: InventoryLayerInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const layerId = stringField(entry.layer_id);
    const movementIndex = integerField(entry.movement_index);
    const unitCostMinor = integerField(entry.unit_cost_minor);
    const layerKind = stringField(entry.layer_kind);
    if (!layerId || !OPAQUE_ID.test(layerId) || movementIndex === null || movementIndex < 0 ||
        unitCostMinor === null || unitCostMinor < 0 || !layerKind ||
        !["receipt", "return", "remnant", "adjustment"].includes(layerKind)) {
      return null;
    }
    const freightMinor = entry.freight_minor === undefined ? 0 : integerField(entry.freight_minor);
    const taxMinor = entry.tax_minor === undefined ? 0 : integerField(entry.tax_minor);
    const discountMinor = entry.discount_minor === undefined
      ? 0
      : integerField(entry.discount_minor);
    if (freightMinor === null || taxMinor === null || discountMinor === null) return null;
    parsed.push({
      layerId,
      movementIndex,
      layerKind: layerKind as InventoryLayerInput["layerKind"],
      unitCostMinor,
      freightMinor,
      taxMinor,
      discountMinor,
    });
  }
  return parsed;
}

function allocations(value: unknown): readonly InventoryAllocationInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 400) return null;
  const parsed: InventoryAllocationInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const allocationId = stringField(entry.allocation_id);
    const layerId = stringField(entry.layer_id);
    const movementIndex = integerField(entry.movement_index);
    const quantityScaled = integerField(entry.quantity_scaled);
    if (!allocationId || !OPAQUE_ID.test(allocationId) || !layerId || !OPAQUE_ID.test(layerId) ||
        movementIndex === null || movementIndex < 0 || quantityScaled === null ||
        quantityScaled <= 0) {
      return null;
    }
    parsed.push({ allocationId, layerId, movementIndex, quantityScaled });
  }
  return parsed;
}

/** A ledger refusal is a 409: the request was well-formed but the state refuses it. */
function ledgerErrorResponse(error: unknown): Response {
  if (error instanceof InventoryLedgerError) {
    return json({ error: error.code }, error.code.endsWith("_input_invalid") ? 400 : 409);
  }
  return json({ error: "inventory_store_unavailable" }, 502);
}

export async function handleInventoryRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/v1/inventory")) return null;

  if (req.method === "GET") {
    if (!READ_ROLES.has(auth.session.role)) {
      return json({ error: "inventory_read_role_required" }, 403);
    }
    const commandDetail = url.pathname.match(/^\/api\/v1\/inventory\/commands\/([^/]+)$/);
    if (commandDetail) {
      const commandId = pathPart(commandDetail[1] ?? "");
      if (!commandId) return json({ error: "not_found" }, 404);
      try {
        const command = await getInventoryCommand(env, auth.session.tenant_id, commandId);
        return command ? json({ version: 1, command }) : json({ error: "not_found" }, 404);
      } catch (error) {
        return ledgerErrorResponse(error);
      }
    }

    const positionDetail = url.pathname.match(/^\/api\/v1\/inventory\/positions\/([^/]+)$/);
    if (positionDetail) {
      const positionId = pathPart(positionDetail[1] ?? "");
      if (!positionId) return json({ error: "not_found" }, 404);
      try {
        const position = await getInventoryPosition(env, auth.session.tenant_id, positionId);
        return position ? json({ version: 1, position }) : json({ error: "not_found" }, 404);
      } catch (error) {
        return ledgerErrorResponse(error);
      }
    }

    if (url.pathname === "/api/v1/inventory/positions") {
      const itemId = stringField(url.searchParams.get("item_id"));
      if (!itemId) return json({ error: "item_id_required" }, 400);
      try {
        const positions = await listInventoryPositions(env, auth.session.tenant_id, itemId);
        return json({ version: 1, item_id: itemId, positions });
      } catch (error) {
        return ledgerErrorResponse(error);
      }
    }
    return json({ error: "not_found" }, 404);
  }

  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  if (!WRITE_ROLES.has(auth.session.role)) {
    return json({ error: "inventory_write_role_required" }, 403);
  }
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);

  if (url.pathname === "/api/v1/inventory/commands") {
    const parsed = await body(req);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    if (!isRecord(parsed.value)) return json({ error: "invalid_inventory_command" }, 400);

    const commandId = stringField(parsed.value.command_id);
    const idempotencyKey = stringField(parsed.value.idempotency_key);
    const fingerprint = stringField(parsed.value.request_fingerprint_sha256);
    const transition = stringField(parsed.value.transition) as InventoryTransition | null;
    const authorityRef = stringField(parsed.value.authority_ref);
    const policyRef = stringField(parsed.value.policy_ref);
    const policyVersion = stringField(parsed.value.policy_version);
    const refs = evidenceRefs(parsed.value.evidence_refs ?? []);
    const parsedMovements = movements(parsed.value.movements);
    const parsedLayers = layers(parsed.value.layers);
    const parsedAllocations = allocations(parsed.value.allocations);
    const approvalId = parsed.value.approval_id === undefined || parsed.value.approval_id === null
      ? null
      : stringField(parsed.value.approval_id);

    if (!commandId || !idempotencyKey || !fingerprint || !SHA256.test(fingerprint) ||
        !transition || !INVENTORY_TRANSITIONS.includes(transition) || !authorityRef ||
        !policyRef || !policyVersion || !refs || !parsedMovements || !parsedLayers ||
        !parsedAllocations) {
      return json({ error: "invalid_inventory_command" }, 400);
    }

    try {
      const result = await applyInventoryCommand(env, {
        commandId,
        tenantId: auth.session.tenant_id,
        transition,
        // The browser session is a worker acting under its own authenticated identity;
        // it can never assert a different actor.
        actorType: "worker",
        actorUserId: auth.session.user_id,
        authorityRef,
        policyRef,
        policyVersion,
        idempotencyKey,
        requestFingerprintSha256: fingerprint,
        approvalId,
        evidenceRefs: refs,
        payload: isRecord(parsed.value.payload) ? parsed.value.payload : {},
        movements: parsedMovements,
        layers: parsedLayers,
        allocations: parsedAllocations,
        now: new Date().toISOString(),
      });
      const status = result.kind === "applied"
        ? 201
        : result.kind === "replayed"
          ? 200
          : result.kind === "conflict"
            ? 409
            : 422;
      return json({ version: 1, ...result }, status);
    } catch (error) {
      return ledgerErrorResponse(error);
    }
  }

  if (url.pathname === "/api/v1/inventory/scans") {
    const parsed = await body(req);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    if (!isRecord(parsed.value)) return json({ error: "invalid_inventory_scan" }, 400);

    const scanId = stringField(parsed.value.scan_id);
    const deviceId = stringField(parsed.value.device_id);
    const deviceActionId = stringField(parsed.value.device_action_id);
    const barcode = stringField(parsed.value.barcode);
    const scanIntent = stringField(parsed.value.scan_intent);
    const fingerprint = stringField(parsed.value.request_fingerprint_sha256);
    const observedAt = stringField(parsed.value.observed_at);
    const capturedOffline = parsed.value.captured_offline === true;

    if (!scanId || !deviceId || !deviceActionId || !barcode || !scanIntent || !fingerprint ||
        !SHA256.test(fingerprint) || !observedAt ||
        !["receive", "issue_use", "return", "transfer", "count", "lookup"].includes(scanIntent)) {
      return json({ error: "invalid_inventory_scan" }, 400);
    }

    try {
      const result = await recordInventoryScan(env, {
        scanId,
        tenantId: auth.session.tenant_id,
        deviceId,
        deviceActionId,
        actorUserId: auth.session.user_id,
        barcode,
        scanIntent: scanIntent as "receive" | "issue_use" | "return" | "transfer" | "count" | "lookup",
        requestFingerprintSha256: fingerprint,
        observedAt,
        capturedOffline,
        payload: isRecord(parsed.value.payload) ? parsed.value.payload : {},
        now: new Date().toISOString(),
      });
      // A replayed offline capture is a success for the device: it must be able to stop
      // retrying without ever risking a second application.
      const status = result.kind === "recorded" ? 201 : result.kind === "duplicate" ? 200 : 409;
      return json({ version: 1, ...result }, status);
    } catch (error) {
      return ledgerErrorResponse(error);
    }
  }

  return json({ error: "not_found" }, 404);
}
