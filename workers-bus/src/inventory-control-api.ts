import { sha256Hex, validAppCsrf } from "./app-auth.ts";
import {
  applyInventoryCommandIntent,
  getInventoryCommand,
  getInventoryPosition,
  inventoryOverviewSummary,
  listInventoryItems,
  listInventoryOverviewPositions,
  listInventoryValuationLayers,
  listInventoryUomConversions,
  listRecentInventoryScans,
  INVENTORY_TRANSITIONS,
  InventoryLedgerError,
  lookupInventoryBarcode,
  listInventoryPositions,
  recordInventoryScan,
  type EvidenceRef,
  type InventoryCommandIntentInput,
  type InventoryTransition,
} from "./inventory-control.ts";
import type { AppEnv, AppRole, AuthContext } from "./app-types.ts";

/**
 * Inventory routes.
 *
 * Writes use the transition-specific role matrix before reaching the ledger. Every refusal
 * returns its exact machine-readable code: a caller must be able to tell a conservation
 * failure from an authorization failure without parsing prose.
 */

const MAX_BODY_BYTES = 64 * 1024;
const WRITE_ROLES = new Set(["owner", "ops", "field"]);
const READ_ROLES = new Set(["owner", "ops", "production", "field"]);
const INVENTORY_POLICY_REF = "policy:inventory-command";
const INVENTORY_POLICY_VERSION = "1";
const INVENTORY_AUTHORITY_ISSUER_REFERENCE = "internal:inventory-authority:1";
const INVENTORY_AUTHORITY_ISSUER_SOURCE_VERSION = "inventory-authority:1";
const INVENTORY_AUTHORITY_SUBJECT_TYPE = "Organization";
const INVENTORY_AUTHORITY_SUBJECT_ROLE = "Inventory Authority";
const INVENTORY_AUTHORITY_KIND = "Inventory Command Authority";
const INVENTORY_AUTHORITY_SCOPE = "inventory-command";
const INVENTORY_AUTHORITY_SCOPE_TYPE = "Tenant";
const INVENTORY_AUTHORITY_PURPOSE = "inventory-command";
const INVENTORY_AUTHORITY_ALLOWED_ROLES = ["owner", "ops", "field"] as const;
const TRANSITIONS_BY_ROLE: ReadonlyMap<string, ReadonlySet<InventoryTransition>> = new Map([
  ["owner", new Set(INVENTORY_TRANSITIONS)],
  ["ops", new Set(INVENTORY_TRANSITIONS)],
  ["field", new Set<InventoryTransition>(["issue_use", "return", "quarantine"])],
]);

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

function optionalStringField(
  value: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in value)) return undefined;
  if (value[key] === null) return null;
  return stringField(value[key]);
}

function optionalIntegerField(
  value: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (!(key in value)) return undefined;
  if (value[key] === null) return null;
  return integerField(value[key]);
}

function optionalConditionStatus(
  value: Record<string, unknown>,
): "accepted" | "damaged" | "quarantined" | null | undefined {
  const condition = optionalStringField(value, "condition_status");
  if (condition === undefined || condition === null) return condition;
  return ["accepted", "damaged", "quarantined"].includes(condition)
    ? condition as "accepted" | "damaged" | "quarantined"
    : null;
}

/**
 * Evidence refs are receipts, not user assertions. Inventory accepts either a tenant-bound
 * inventory R2 key or an existing field-media receipt whose D1 row already binds the key and
 * checksum to this tenant. The object body is hashed again before any ledger batch is started.
 */
async function verifyInventoryEvidence(
  env: AppEnv,
  tenantId: string,
  refs: readonly EvidenceRef[],
): Promise<string | null> {
  if (refs.length < 1) return "inventory_evidence_required";
  for (const ref of refs) {
    let r2Key: string | null = null;
    let receiptSha256: string | null = null;
    const inventoryKey = ref.ref.match(
      /^r2:\/\/inventory-evidence\/([a-z0-9][a-z0-9-]{1,63})\/([A-Za-z0-9._:-]{1,160})$/,
    );
    if (inventoryKey) {
      if (inventoryKey[1] !== tenantId) return "inventory_evidence_scope_mismatch";
      r2Key = `inventory-evidence/${inventoryKey[1]}/${inventoryKey[2]}`;
    } else {
      const fieldEvidenceId = ref.ref.match(/^field-media:\/\/([A-Za-z0-9._:-]{12,80})$/);
      const requestedR2Key = ref.ref.startsWith("r2://") ? ref.ref.slice(5) : null;
      const receipt = await env.DB.prepare(
        `SELECT media.r2_key, media.checksum_sha256
          FROM field_action_media AS media
           JOIN field_actions AS action ON action.device_action_id = media.device_action_id
          WHERE action.tenant_id = ?
            AND ((? IS NULL AND media.evidence_id = ?) OR
                 (? IS NOT NULL AND media.r2_key = ?))
          LIMIT 1`,
      ).bind(
        tenantId,
        fieldEvidenceId?.[1] ?? null,
        fieldEvidenceId?.[1] ?? "",
        requestedR2Key,
        requestedR2Key ?? "",
      ).first<{ r2_key: string; checksum_sha256: string }>();
      if (!receipt) return requestedR2Key ? "inventory_evidence_missing" : "inventory_evidence_scope_mismatch";
      r2Key = receipt.r2_key;
      receiptSha256 = receipt.checksum_sha256;
    }
    if (!r2Key || receiptSha256 && receiptSha256 !== ref.sha256) {
      return "inventory_evidence_hash_mismatch";
    }
    const object = await env.RAW?.get(r2Key);
    if (!object) return "inventory_evidence_unavailable";
    const actualSha256 = await sha256Hex(await object.text());
    if (actualSha256 !== ref.sha256 || receiptSha256 && actualSha256 !== receiptSha256) {
      return "inventory_evidence_hash_mismatch";
    }
  }
  return null;
}

/** A ledger refusal is a 409: the request was well-formed but the state refuses it. */
function ledgerErrorResponse(error: unknown): Response {
  if (error instanceof InventoryLedgerError) {
    return json({ error: error.code }, error.code.endsWith("_input_invalid") ? 400 : 409);
  }
  return json({ error: "inventory_store_unavailable" }, 502);
}

type InventoryAuthorityReadback = {
  readback_id: string;
  authority_record_id: string;
  authority_version: number;
  observed_at: string;
  subject_type: string | null;
  subject_role: string | null;
  person_user: string | null;
  organization: string | null;
  authority_kind: string | null;
  authority_scope: string | null;
  scope_type: string | null;
  scope_ref: string | null;
  roof_job: string | null;
  scope_json: string | null;
  issuer_reference: string;
  issuer_source_version: string;
  verification_state: "verified" | "revoked" | "contradictory" | "unavailable" | "missing";
};

type InventoryOperationalScope = {
  scopeType: string;
  scopeRef: string;
};

function inventoryScopeJsonMatches(
  value: string | null,
  tenantId: string,
  role: AppRole | null,
): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return false;
    if (Object.keys(parsed).sort().join(",") !==
        "allowed_roles,operational_scope,purpose,tenant_id") {
      return false;
    }
    if (parsed.purpose !== INVENTORY_AUTHORITY_PURPOSE || parsed.tenant_id !== tenantId) {
      return false;
    }
    const allowedRoles = parsed.allowed_roles;
    if (!Array.isArray(allowedRoles) ||
        allowedRoles.length !== INVENTORY_AUTHORITY_ALLOWED_ROLES.length ||
        !INVENTORY_AUTHORITY_ALLOWED_ROLES.every((allowedRole) =>
          allowedRoles.includes(allowedRole))) {
      return false;
    }
    if (role && !INVENTORY_AUTHORITY_ALLOWED_ROLES.some((allowedRole) => allowedRole === role)) {
      return false;
    }
    if (role && !allowedRoles.includes(role)) return false;
    if (!isRecord(parsed.operational_scope) ||
        Object.keys(parsed.operational_scope).sort().join(",") !== "scope_ref,scope_type" ||
        parsed.operational_scope.scope_type !== INVENTORY_AUTHORITY_SCOPE_TYPE ||
        parsed.operational_scope.scope_ref !== tenantId) {
      return false;
    }
    return allowedRoles.every((allowedRole) =>
      typeof allowedRole === "string" && INVENTORY_AUTHORITY_ALLOWED_ROLES.includes(
        allowedRole as (typeof INVENTORY_AUTHORITY_ALLOWED_ROLES)[number],
      ));
  } catch {
    return false;
  }
}

function inventoryAuthorityBindingDenial(
  readback: InventoryAuthorityReadback,
  tenantId: string,
  role: AppRole | null,
): "inventory_authority_subject_mismatch" | "inventory_authority_scope_mismatch" | null {
  if (readback.subject_type !== INVENTORY_AUTHORITY_SUBJECT_TYPE ||
      readback.subject_role !== INVENTORY_AUTHORITY_SUBJECT_ROLE ||
      readback.person_user !== null || readback.organization !== tenantId) {
    return "inventory_authority_subject_mismatch";
  }
  if (readback.authority_kind !== INVENTORY_AUTHORITY_KIND ||
      readback.authority_scope !== INVENTORY_AUTHORITY_SCOPE ||
      readback.scope_type !== INVENTORY_AUTHORITY_SCOPE_TYPE ||
      readback.scope_ref !== tenantId ||
      readback.roof_job !== null ||
      !inventoryScopeJsonMatches(readback.scope_json, tenantId, role)) {
    return "inventory_authority_scope_mismatch";
  }
  return null;
}

function commandOperationalScope(value: unknown): InventoryOperationalScope | "invalid" | null {
  if (!isRecord(value) || value.operational_scope === undefined) return null;
  if (!isRecord(value.operational_scope)) return "invalid";
  const scopeType = stringField(value.operational_scope.scope_type);
  const scopeRef = stringField(value.operational_scope.scope_ref);
  return scopeType && scopeRef ? { scopeType, scopeRef } : "invalid";
}

type InventoryAuthorityIdentity = {
  authority_ref: string | null;
  authority_record_id: string | null;
  authority_version: number | null;
  observed_at: string | null;
  verification_state: "verified" | "revoked" | "contradictory" | "unavailable" | "missing";
};

const missingInventoryAuthority: InventoryAuthorityIdentity = {
  authority_ref: null,
  authority_record_id: null,
  authority_version: null,
  observed_at: null,
  verification_state: "missing",
};

async function currentInventoryAuthority(
  env: AppEnv,
  tenantId: string,
): Promise<InventoryAuthorityIdentity> {
  const row = await env.DB.prepare(
    `SELECT candidate.readback_id, candidate.authority_record_id,
            candidate.authority_version, candidate.observed_at, candidate.verification_state,
            candidate.subject_type, candidate.subject_role, candidate.person_user,
            candidate.organization, candidate.authority_kind, candidate.authority_scope,
            candidate.scope_type, candidate.scope_ref, candidate.roof_job, candidate.scope_json,
            candidate.issuer_reference, candidate.issuer_source_version
       FROM authority_record_readbacks AS candidate
      WHERE candidate.tenant_id = ?
        AND candidate.issuer_reference = ?
        AND candidate.issuer_source_version = ?
        AND candidate.subject_type = ?
        AND candidate.subject_role = ?
        AND candidate.person_user IS NULL
        AND candidate.organization = ?
        AND candidate.authority_kind = ?
        AND candidate.authority_scope = ?
        AND candidate.scope_type = ?
        AND candidate.scope_ref = ?
        AND candidate.roof_job IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM authority_record_readbacks AS newer
           WHERE newer.tenant_id = candidate.tenant_id
             AND newer.authority_record_id = candidate.authority_record_id
             AND (
               newer.authority_version > candidate.authority_version
               OR (
                 newer.authority_version = candidate.authority_version
                 AND (
                   newer.observed_at > candidate.observed_at
                   OR (
                     newer.observed_at = candidate.observed_at
                     AND newer.readback_id > candidate.readback_id
                   )
                 )
               )
             )
        )
      ORDER BY candidate.authority_version DESC, candidate.observed_at DESC,
               candidate.readback_id DESC
      LIMIT 1`,
  ).bind(
    tenantId,
    INVENTORY_AUTHORITY_ISSUER_REFERENCE,
    INVENTORY_AUTHORITY_ISSUER_SOURCE_VERSION,
    INVENTORY_AUTHORITY_SUBJECT_TYPE,
    INVENTORY_AUTHORITY_SUBJECT_ROLE,
    tenantId,
    INVENTORY_AUTHORITY_KIND,
    INVENTORY_AUTHORITY_SCOPE,
    INVENTORY_AUTHORITY_SCOPE_TYPE,
    tenantId,
  ).first<{
    readback_id: string;
    authority_record_id: string;
    authority_version: number;
    observed_at: string;
    verification_state: InventoryAuthorityIdentity["verification_state"];
    subject_type: string | null;
    subject_role: string | null;
    person_user: string | null;
    organization: string | null;
    authority_kind: string | null;
    authority_scope: string | null;
    scope_type: string | null;
    scope_ref: string | null;
    roof_job: string | null;
    scope_json: string | null;
    issuer_reference: string;
    issuer_source_version: string;
  }>();
  if (!row) return missingInventoryAuthority;
  if (inventoryAuthorityBindingDenial(row, tenantId, null)) return missingInventoryAuthority;
  return {
    authority_ref: row.readback_id,
    authority_record_id: row.authority_record_id,
    authority_version: Number(row.authority_version),
    observed_at: row.observed_at,
    verification_state: row.verification_state,
  };
}

async function inventoryAuthorityDenial(
  env: AppEnv,
  session: AuthContext["session"],
  authorityRef: string,
  operationalScope: InventoryOperationalScope | "invalid" | null,
): Promise<string | null> {
  const tenantId = session.tenant_id;
  try {
    const requested = await env.DB.prepare(
      `SELECT readback_id, authority_record_id, authority_version, observed_at,
              subject_type, subject_role, person_user, organization, authority_kind,
              authority_scope, scope_type, scope_ref, roof_job, scope_json,
              issuer_reference, issuer_source_version, verification_state
         FROM authority_record_readbacks
        WHERE tenant_id = ? AND readback_id = ?
        LIMIT 1`,
    ).bind(tenantId, authorityRef).first<InventoryAuthorityReadback>();
    // Tenant scoping deliberately makes a cross-tenant reference indistinguishable from a
    // missing reference; no authority contents or existence are disclosed to the caller.
    if (!requested) return "inventory_authority_missing";

    const latest = await env.DB.prepare(
      `SELECT readback_id, authority_record_id, authority_version, observed_at,
              subject_type, subject_role, person_user, organization, authority_kind,
              authority_scope, scope_type, scope_ref, roof_job, scope_json,
              issuer_reference, issuer_source_version, verification_state
         FROM authority_record_readbacks
        WHERE tenant_id = ? AND authority_record_id = ?
        ORDER BY authority_version DESC, observed_at DESC, readback_id DESC
        LIMIT 1`,
    ).bind(tenantId, requested.authority_record_id).first<InventoryAuthorityReadback>();
    if (!latest) return "inventory_authority_missing";
    // A newer negative readback is the terminal state for this authority record. Check it
    // before identity comparisons so revocation, contradiction, and unavailability cannot
    // be hidden behind a generic stale/superseded response.
    if (latest.verification_state !== "verified") {
      return `inventory_authority_${latest.verification_state}`;
    }
    if (latest.issuer_reference !== INVENTORY_AUTHORITY_ISSUER_REFERENCE ||
        latest.issuer_source_version !== INVENTORY_AUTHORITY_ISSUER_SOURCE_VERSION ||
        requested.issuer_reference !== INVENTORY_AUTHORITY_ISSUER_REFERENCE ||
        requested.issuer_source_version !== INVENTORY_AUTHORITY_ISSUER_SOURCE_VERSION) {
      return "inventory_authority_scope_mismatch";
    }
    const latestBindingDenial = inventoryAuthorityBindingDenial(latest, tenantId, session.role);
    if (latestBindingDenial) return latestBindingDenial;
    const requestedBindingDenial = inventoryAuthorityBindingDenial(requested, tenantId, session.role);
    if (requestedBindingDenial) return requestedBindingDenial;
    if (latest.readback_id !== requested.readback_id) {
      return latest.authority_version > requested.authority_version
        ? "inventory_authority_superseded"
        : "inventory_authority_stale";
    }
    if (requested.verification_state !== "verified") {
      return `inventory_authority_${requested.verification_state}`;
    }
    if (operationalScope === "invalid" || operationalScope &&
        (operationalScope.scopeType !== INVENTORY_AUTHORITY_SCOPE_TYPE ||
          operationalScope.scopeRef !== tenantId)) {
      return "inventory_authority_scope_mismatch";
    }
    return null;
  } catch {
    return "inventory_authority_unavailable";
  }
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
    if (url.pathname === "/api/v1/inventory/overview") {
      try {
        const [summary, items, positions, valuationLayers, uomConversions, recentScans, authority] = await Promise.all([
          inventoryOverviewSummary(env, auth.session.tenant_id),
          listInventoryItems(env, auth.session.tenant_id),
          listInventoryOverviewPositions(env, auth.session.tenant_id),
          listInventoryValuationLayers(env, auth.session.tenant_id),
          listInventoryUomConversions(env, auth.session.tenant_id),
          listRecentInventoryScans(env, auth.session.tenant_id),
          currentInventoryAuthority(env, auth.session.tenant_id),
        ]);
        const allowedTransitions = TRANSITIONS_BY_ROLE.get(auth.session.role) ?? new Set();
        return json({
          version: 1,
          read_model_generated_at: new Date().toISOString(),
          allowed_transitions: [...allowedTransitions],
          authority_ref: authority.authority_ref,
          policy_ref: INVENTORY_POLICY_REF,
          policy_version: INVENTORY_POLICY_VERSION,
          authority,
          summary,
          items,
          positions,
          valuation_layers: valuationLayers,
          uom_conversions: uomConversions,
          recent_scans: recentScans,
        });
      } catch (error) {
        return ledgerErrorResponse(error);
      }
    }
    if (url.pathname === "/api/v1/inventory/lookup") {
      const barcode = stringField(url.searchParams.get("barcode"));
      if (!barcode) return json({ error: "barcode_required" }, 400);
      try {
        const result = await lookupInventoryBarcode(env, auth.session.tenant_id, barcode);
        return json({ version: 1, barcode, result });
      } catch (error) {
        return ledgerErrorResponse(error);
      }
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
    const approvalId = parsed.value.approval_id === undefined || parsed.value.approval_id === null
      ? null
      : stringField(parsed.value.approval_id);

    // The public boundary accepts intent only. A browser-composed movement, valuation layer or
    // allocation is an untrusted ledger write and is rejected before authority or D1 state is
    // consulted. The Worker derives those structures from current tenant rows below.
    if ("movements" in parsed.value || "layers" in parsed.value || "allocations" in parsed.value) {
      return json({ error: "inventory_command_intent_required" }, 400);
    }
    const sourcePositionId = optionalStringField(parsed.value, "source_position_id");
    const targetPositionId = optionalStringField(parsed.value, "target_position_id");
    const itemId = optionalStringField(parsed.value, "item_id");
    const lotId = optionalStringField(parsed.value, "lot_id");
    const binId = optionalStringField(parsed.value, "bin_id");
    const uomId = optionalStringField(parsed.value, "uom_id");
    const jobCustody = optionalStringField(parsed.value, "job_custody");
    const quantityScaled = optionalIntegerField(parsed.value, "quantity_scaled");
    const countedQuantityScaled = optionalIntegerField(parsed.value, "counted_quantity_scaled");
    const unitCostMinor = optionalIntegerField(parsed.value, "unit_cost_minor");
    const currency = optionalStringField(parsed.value, "currency");
    const jobId = optionalStringField(parsed.value, "job_id");
    const workPackageId = optionalStringField(parsed.value, "work_package_id");
    const reservationId = optionalStringField(parsed.value, "reservation_id");
    const receiptId = optionalStringField(parsed.value, "receipt_id");
    const poLineId = optionalStringField(parsed.value, "po_line_id");
    const countSessionId = optionalStringField(parsed.value, "count_session_id");
    const reversalReference = optionalStringField(parsed.value, "reversal_reference");
    const conditionStatus = optionalConditionStatus(parsed.value);
    const optionalStrings = [
      ["source_position_id", sourcePositionId], ["target_position_id", targetPositionId],
      ["item_id", itemId], ["lot_id", lotId], ["bin_id", binId], ["uom_id", uomId],
      ["job_custody", jobCustody], ["currency", currency], ["job_id", jobId],
      ["work_package_id", workPackageId], ["reservation_id", reservationId],
      ["receipt_id", receiptId], ["po_line_id", poLineId], ["count_session_id", countSessionId],
      ["reversal_reference", reversalReference],
    ] as const;
    const optionalIntegers = [
      ["quantity_scaled", quantityScaled], ["counted_quantity_scaled", countedQuantityScaled],
      ["unit_cost_minor", unitCostMinor],
    ] as const;

    if (!commandId || !idempotencyKey || !fingerprint || !SHA256.test(fingerprint) ||
        !transition || !INVENTORY_TRANSITIONS.includes(transition) || !authorityRef ||
        !policyRef || !policyVersion || !refs ||
        optionalStrings.some(([key, value]) => value === null &&
          (parsed.value as Record<string, unknown>)[key] !== null) ||
        optionalIntegers.some(([key, value]) => value === null &&
          (parsed.value as Record<string, unknown>)[key] !== null) ||
        conditionStatus === null && (parsed.value as Record<string, unknown>).condition_status !== null) {
      return json({ error: "invalid_inventory_command" }, 400);
    }

    const allowedTransitions = TRANSITIONS_BY_ROLE.get(auth.session.role);
    if (!allowedTransitions?.has(transition)) {
      return json({ error: "inventory_transition_role_required" }, 403);
    }
    if (policyRef !== INVENTORY_POLICY_REF) {
      return json({ error: "inventory_policy_reference_mismatch" }, 403);
    }
    if (policyVersion !== INVENTORY_POLICY_VERSION) {
      return json({ error: "inventory_policy_version_mismatch" }, 403);
    }
    const commandPayload = isRecord(parsed.value.payload) ? parsed.value.payload : {};
    const operationalScope = commandOperationalScope(commandPayload);
    const authorityDenial = await inventoryAuthorityDenial(
      env,
      auth.session,
      authorityRef,
      operationalScope,
    );
    if (authorityDenial) return json({ error: authorityDenial }, 403);

    const evidenceDenial = await verifyInventoryEvidence(env, auth.session.tenant_id, refs);
    if (evidenceDenial) return json({ error: evidenceDenial }, 403);

    try {
      const intent: InventoryCommandIntentInput = {
        commandId,
        tenantId: auth.session.tenant_id,
        transition,
        // The browser session is bound to its authenticated role; it can never assert a
        // different actor type.
        actorType: auth.session.role === "owner" ? "owner" : "worker",
        actorUserId: auth.session.user_id,
        authorityRef,
        policyRef,
        policyVersion,
        idempotencyKey,
        requestFingerprintSha256: fingerprint,
        approvalId,
        evidenceRefs: refs,
        payload: commandPayload,
        sourcePositionId: sourcePositionId ?? null,
        targetPositionId: targetPositionId ?? null,
        itemId: itemId ?? null,
        lotId: lotId ?? null,
        binId: binId ?? null,
        uomId: uomId ?? null,
        jobCustody: jobCustody ?? null,
        quantityScaled: quantityScaled ?? null,
        countedQuantityScaled: countedQuantityScaled ?? null,
        unitCostMinor: unitCostMinor ?? null,
        currency: currency ?? null,
        jobId: jobId ?? null,
        workPackageId: workPackageId ?? null,
        reservationId: reservationId ?? null,
        receiptId: receiptId ?? null,
        poLineId: poLineId ?? null,
        countSessionId: countSessionId ?? null,
        reversalReference: reversalReference ?? null,
        conditionStatus: conditionStatus ?? null,
        now: new Date().toISOString(),
      };
      const result = await applyInventoryCommandIntent(env, intent);
      const status = result.kind === "applied"
        ? 201
        : result.kind === "replayed"
          ? 200
          : result.kind === "conflict"
            ? 409
            : 422;
      return json({
        version: 1,
        device_action_id: idempotencyKey,
        status: "verified",
        ...result,
      }, status);
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
      return json({
        version: 1,
        device_action_id: deviceActionId,
        status: "verified",
        ...result,
      }, status);
    } catch (error) {
      return ledgerErrorResponse(error);
    }
  }

  return json({ error: "not_found" }, 404);
}
