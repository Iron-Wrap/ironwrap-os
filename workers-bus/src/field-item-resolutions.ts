/**
 * Office resolution of an unconfirmed crew item.
 *
 * A crew phone stops an item as "unconfirmed" when the office answered but the phone could not
 * verify that the office holds that exact item (`app/src/storage/outbox-failure.ts`). Nothing on
 * the phone can settle that alone, so a person in the office answers it here, against the stored
 * crew write, and the phone reads the answer back for the items it holds.
 *
 * Binding. A resolution names the device action id the phone used as its Idempotency-Key, the
 * item kind, and `payload_sha256`: the Worker's own stored request hash for that crew write, the
 * value each crew store committed atomically with the write under that key. The phone cannot
 * recompute that hash for most kinds (it covers server-normalized and server-derived fields, such
 * as the active assignment), and the Worker keeps no copy of the phone's raw request body, so the
 * stored hash is the only payload identity the Worker can verify against the stored write. The
 * phone binds the answer by its own device action id, which it generated, never changes for a
 * saved item, and which the Worker refuses to replay with a different payload; for an inventory
 * scan the phone computes the stored fingerprint itself and checks it too.
 *
 * Fail closed. `arrived` and `duplicate` require the settled crew write, its crew member, its
 * stored hash and its canonical record to match exactly what the request cites. `not_arrived`
 * requires that no crew write exists for that device action id in any bound store, checked again
 * inside the insert. Collision reports and corrective-action evidence are stored under their own
 * record ids without the device action id, so no answer can be bound to the exact saved item for
 * them and the route refuses both kinds.
 */
import { validAppCsrf } from "./app-auth.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export const FIELD_ITEM_RESOLUTION_REQUEST_ID =
  /^field-item-resolution:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The AI team specialist allowed to propose an answer (`docs/AI-TEAM-CONTRACT.md`). */
export const FIELD_ITEM_PROPOSING_AGENT = "field_safety";
/** The catalog action a proposal step must carry; the orchestrator owns adding it. */
export const FIELD_ITEM_PROPOSAL_ACTION = "field_item.propose_resolution";

const DEVICE_ACTION_ID = /^[A-Za-z0-9._:-]{8,200}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECORD_ID = /^[A-Za-z0-9._:-]{1,220}$/;
const USER_ID = /^[^\s]{1,160}$/;
const EVIDENCE_ID = /^[A-Za-z0-9._:-]{8,200}$/;
const MAX_BODY_BYTES = 4096;
const MAX_READ_ITEMS = 50;
const RESOLUTIONS = ["arrived", "not_arrived", "duplicate"] as const;
const INPUT_KEYS = [
  "device_action_id",
  "item_kind",
  "payload_sha256",
  "resolution",
  "linked_record",
  "crew_user_id",
  "ai_proposal",
] as const;
// Stored under their own record ids, not the device action id: never bindable to the exact item.
const UNBOUND_ITEM_KINDS = new Set(["fleet_collision_report", "safety_corrective_evidence"]);

export type FieldItemResolutionKind = (typeof RESOLUTIONS)[number];

type LinkedRecordType =
  | "field_action"
  | "work_package_action"
  | "fleet_asset_action"
  | "safety_device_action"
  | "inventory_scan"
  | "inventory_command"
  | "schema_field_value_revision";

/** How one outbox kind's crew write is found, keyed by tenant and a key derived from the id. */
interface CrewWriteBinding {
  linkedRecordType: LinkedRecordType;
  /** Selects crew_user_id, crew_device_id, payload_sha256, settled, linked_record_id. */
  select: string;
  key(tenantId: string, deviceActionId: string): Promise<string> | string;
}

interface CrewWriteRow {
  crew_user_id: string;
  crew_device_id: string | null;
  payload_sha256: string;
  settled: number;
  linked_record_id: string;
}

const byDeviceAction = (_tenantId: string, deviceActionId: string) => deviceActionId;
// `inventory-control.ts` keys a command by sha256(tenant + newline + Idempotency-Key).
const inventoryCommandKey = (tenantId: string, deviceActionId: string) =>
  sha256Hex(`${tenantId}\n${deviceActionId}`);
// `schema-forms.ts` keys a value revision by sha256(Idempotency-Key).
const schemaValueKey = (_tenantId: string, deviceActionId: string) => sha256Hex(deviceActionId);

const fieldActionSelect = (table: string, kind: string, device = "NULL") =>
  `SELECT user_id AS crew_user_id, ${device} AS crew_device_id, payload_hash AS payload_sha256,
          status = 'verified' AS settled, device_action_id AS linked_record_id
     FROM ${table}
    WHERE tenant_id = ? AND device_action_id = ?${kind ? ` AND action_kind = '${kind}'` : ""}`;

const BINDINGS: Readonly<Record<string, CrewWriteBinding>> = {
  field_checkin: {
    linkedRecordType: "field_action",
    select: fieldActionSelect("field_actions", "field_checkin", "evidence_device_id"),
    key: byDeviceAction,
  },
  work_package_acknowledgement: {
    linkedRecordType: "work_package_action",
    select: fieldActionSelect("field_work_package_actions", "acknowledge"),
    key: byDeviceAction,
  },
  work_package_stop: {
    linkedRecordType: "work_package_action",
    select: fieldActionSelect("field_work_package_actions", "stop_work"),
    key: byDeviceAction,
  },
  fleet_pre_trip_inspection: {
    linkedRecordType: "fleet_asset_action",
    select: fieldActionSelect("fleet_asset_actions", "pre_trip_inspection"),
    key: byDeviceAction,
  },
  fleet_post_trip_inspection: {
    linkedRecordType: "fleet_asset_action",
    select: fieldActionSelect("fleet_asset_actions", "post_trip_inspection"),
    key: byDeviceAction,
  },
  fleet_defect_report: {
    linkedRecordType: "fleet_asset_action",
    select: fieldActionSelect("fleet_asset_actions", "defect_report"),
    key: byDeviceAction,
  },
  safety_action: {
    linkedRecordType: "safety_device_action",
    select: fieldActionSelect("safety_device_actions", ""),
    key: byDeviceAction,
  },
  // A scan row is the recorded observation; its fingerprint is the one the phone computed.
  inventory_scan: {
    linkedRecordType: "inventory_scan",
    select: `SELECT actor_user_id AS crew_user_id, device_id AS crew_device_id,
                    request_fingerprint_sha256 AS payload_sha256, 1 AS settled,
                    scan_id AS linked_record_id
               FROM inventory_scans WHERE tenant_id = ? AND device_action_id = ?`,
    key: byDeviceAction,
  },
  // Only an applied command is what the phone would have verified; a pending, refused or
  // conflicting one must not read as "the office has this".
  inventory_command: {
    linkedRecordType: "inventory_command",
    select: `SELECT actor_user_id AS crew_user_id, NULL AS crew_device_id,
                    request_fingerprint_sha256 AS payload_sha256, status = 'applied' AS settled,
                    command_id AS linked_record_id
               FROM inventory_commands WHERE tenant_id = ? AND idempotency_key_sha256 = ?`,
    key: inventoryCommandKey,
  },
  schema_field_value: {
    linkedRecordType: "schema_field_value_revision",
    select: `SELECT provenance_actor_id AS crew_user_id, NULL AS crew_device_id,
                    command_fingerprint AS payload_sha256, 1 AS settled,
                    value_revision_id AS linked_record_id
               FROM schema_field_value_revisions WHERE tenant_id = ? AND idempotency_key_hash = ?`,
    key: schemaValueKey,
  },
};

/** True when any bound crew store holds a write under this device action id in the tenant. */
const ANY_CREW_WRITE = `(
  EXISTS (SELECT 1 FROM field_actions WHERE tenant_id = ? AND device_action_id = ?)
  OR EXISTS (SELECT 1 FROM field_work_package_actions WHERE tenant_id = ? AND device_action_id = ?)
  OR EXISTS (SELECT 1 FROM fleet_asset_actions WHERE tenant_id = ? AND device_action_id = ?)
  OR EXISTS (SELECT 1 FROM safety_device_actions WHERE tenant_id = ? AND device_action_id = ?)
  OR EXISTS (SELECT 1 FROM inventory_scans WHERE tenant_id = ? AND device_action_id = ?)
  OR EXISTS (SELECT 1 FROM inventory_commands WHERE tenant_id = ? AND idempotency_key_sha256 = ?)
  OR EXISTS (SELECT 1 FROM schema_field_value_revisions
              WHERE tenant_id = ? AND idempotency_key_hash = ?))`;

async function anyCrewWriteBinds(tenantId: string, deviceActionId: string): Promise<string[]> {
  return [
    ...[1, 2, 3, 4, 5].flatMap(() => [tenantId, deviceActionId]),
    tenantId,
    await inventoryCommandKey(tenantId, deviceActionId),
    tenantId,
    await schemaValueKey(tenantId, deviceActionId),
  ];
}

export interface FieldItemResolutionInput {
  device_action_id: string;
  item_kind: string;
  payload_sha256: string | null;
  resolution: FieldItemResolutionKind;
  linked_record: { type: string; id: string } | null;
  crew_user_id: string;
  ai_proposal: { agent_id: string; evidence_id: string } | null;
}

/** Only a person's own app session may answer. Anything else is refused before any read. */
export type FieldItemResolutionActor =
  | { kind: "person"; tenantId: string; userId: string; role: string }
  | { kind: "agent" | "service" | "effect_runtime" | "mcp"; tenantId: string; id: string };

interface ResolutionRow {
  resolution_id: string;
  tenant_id: string;
  device_action_id: string;
  item_kind: string;
  payload_sha256: string | null;
  resolution: FieldItemResolutionKind;
  linked_record_type: string | null;
  linked_record_id: string | null;
  crew_user_id: string;
  crew_device_id: string | null;
  resolved_by_user_id: string;
  resolved_by_role: string;
  proposed_by_agent_id: string | null;
  proposal_evidence_id: string | null;
  request_id: string;
  request_sha256: string;
  created_at: string;
}

export class FieldItemResolutionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const refuse = (code: string, status: number): never => {
  throw new FieldItemResolutionError(code, status);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

export function parseFieldItemResolutionInput(value: unknown): FieldItemResolutionInput {
  if (!isRecord(value) || !exactKeys(value, INPUT_KEYS)) refuse("invalid_field_item_resolution", 400);
  const input = value as Record<string, unknown>;
  const {
    device_action_id: deviceActionId,
    item_kind: itemKind,
    payload_sha256: payloadSha256,
    resolution,
    linked_record: linkedRecord,
    crew_user_id: crewUserId,
    ai_proposal: aiProposal,
  } = input;
  if (
    typeof deviceActionId !== "string" ||
    !DEVICE_ACTION_ID.test(deviceActionId) ||
    typeof itemKind !== "string" ||
    typeof resolution !== "string" ||
    !(RESOLUTIONS as readonly string[]).includes(resolution) ||
    typeof crewUserId !== "string" ||
    !USER_ID.test(crewUserId) ||
    !(payloadSha256 === null || (typeof payloadSha256 === "string" && SHA256.test(payloadSha256)))
  ) {
    refuse("invalid_field_item_resolution", 400);
  }
  if (
    !(
      linkedRecord === null ||
      (isRecord(linkedRecord) &&
        exactKeys(linkedRecord, ["type", "id"]) &&
        typeof linkedRecord.type === "string" &&
        typeof linkedRecord.id === "string" &&
        RECORD_ID.test(linkedRecord.id))
    )
  ) {
    refuse("invalid_field_item_resolution", 400);
  }
  // Nothing was stored for an item that did not arrive, so there is no hash or record to cite.
  // An item that arrived must cite both.
  const notArrived = resolution === "not_arrived";
  if (notArrived !== (payloadSha256 === null) || notArrived !== (linkedRecord === null)) {
    refuse("invalid_field_item_resolution", 400);
  }
  if (
    !(
      aiProposal === null ||
      (isRecord(aiProposal) &&
        exactKeys(aiProposal, ["agent_id", "evidence_id"]) &&
        typeof aiProposal.agent_id === "string" &&
        typeof aiProposal.evidence_id === "string" &&
        EVIDENCE_ID.test(aiProposal.evidence_id))
    )
  ) {
    refuse("invalid_field_item_resolution", 400);
  }
  return {
    device_action_id: deviceActionId as string,
    item_kind: itemKind as string,
    payload_sha256: payloadSha256 as string | null,
    resolution: resolution as FieldItemResolutionKind,
    linked_record: linkedRecord === null
      ? null
      : { type: (linkedRecord as { type: string }).type, id: (linkedRecord as { id: string }).id },
    crew_user_id: crewUserId as string,
    ai_proposal: aiProposal === null
      ? null
      : {
          agent_id: (aiProposal as { agent_id: string }).agent_id,
          evidence_id: (aiProposal as { evidence_id: string }).evidence_id,
        },
  };
}

async function crewIsFieldUser(env: AppEnv, tenantId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM app_users
      WHERE tenant_id = ? AND user_id = ? AND COALESCE(access_role, role) = 'field'`,
  )
    .bind(tenantId, userId)
    .first<{ present: number }>();
  return Boolean(row);
}

async function readByRequest(
  env: AppEnv,
  tenantId: string,
  requestId: string,
): Promise<ResolutionRow | null> {
  return await env.DB.prepare(
    "SELECT * FROM field_item_resolutions WHERE tenant_id = ? AND request_id = ?",
  )
    .bind(tenantId, requestId)
    .first<ResolutionRow>();
}

/** The proposal step must be the field coordinator's own proposal about this exact answer. */
async function proposalVerified(
  env: AppEnv,
  tenantId: string,
  input: FieldItemResolutionInput,
  evidenceId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM agent_run_steps
      WHERE tenant_id = ? AND step_id = ? AND specialist_id = ? AND action_id = ?
        AND CASE WHEN json_valid(args_json)
                 THEN json_extract(args_json, '$.device_action_id') END = ?
        AND CASE WHEN json_valid(args_json)
                 THEN json_extract(args_json, '$.resolution') END = ?`,
  )
    .bind(
      tenantId,
      evidenceId,
      FIELD_ITEM_PROPOSING_AGENT,
      FIELD_ITEM_PROPOSAL_ACTION,
      input.device_action_id,
      input.resolution,
    )
    .first<{ present: number }>();
  return Boolean(row);
}

export interface RecordedFieldItemResolution {
  replayed: boolean;
  resolution: ReturnType<typeof officeView>;
}

export async function recordFieldItemResolution(
  env: AppEnv,
  actor: FieldItemResolutionActor,
  requestId: string,
  input: FieldItemResolutionInput,
  now: () => Date = () => new Date(),
): Promise<RecordedFieldItemResolution> {
  // A person confirms; an agent, service, effect runtime or MCP actor never answers on its own.
  if (actor.kind !== "person") refuse("person_session_required", 403);
  const person = actor as Extract<FieldItemResolutionActor, { kind: "person" }>;
  if (person.role !== "owner" && person.role !== "ops") {
    refuse("field_item_resolution_role_required", 403);
  }
  if (!FIELD_ITEM_RESOLUTION_REQUEST_ID.test(requestId)) {
    refuse("invalid_field_item_resolution_request_id", 400);
  }
  const tenantId = person.tenantId;
  const requestSha256 = await sha256Hex(canonicalJson(input));
  const replay = async (): Promise<RecordedFieldItemResolution | null> => {
    const row = await readByRequest(env, tenantId, requestId);
    if (!row) return null;
    if (row.request_sha256 !== requestSha256 || row.resolved_by_user_id !== person.userId) {
      refuse("field_item_resolution_idempotency_conflict", 409);
    }
    return { replayed: true, resolution: officeView(row) };
  };
  const prior = await replay();
  if (prior) return prior;

  const resolver = await env.DB.prepare(
    `SELECT 1 AS present FROM app_users
      WHERE tenant_id = ? AND user_id = ? AND active = 1 AND COALESCE(access_role, role) = ?`,
  )
    .bind(tenantId, person.userId, person.role)
    .first<{ present: number }>();
  if (!resolver) refuse("field_item_resolution_role_required", 403);

  if (UNBOUND_ITEM_KINDS.has(input.item_kind)) refuse("field_item_kind_unbound", 422);
  // Own keys only: an item kind such as "constructor" must never reach a prototype member.
  const binding = Object.hasOwn(BINDINGS, input.item_kind) ? BINDINGS[input.item_kind] : undefined;
  if (!binding) refuse("invalid_field_item_resolution", 400);
  const bound = binding as CrewWriteBinding;

  if (input.ai_proposal) {
    if (input.ai_proposal.agent_id !== FIELD_ITEM_PROPOSING_AGENT) {
      refuse("ai_proposal_agent_refused", 403);
    }
    if (!(await proposalVerified(env, tenantId, input, input.ai_proposal.evidence_id))) {
      refuse("ai_proposal_not_found", 422);
    }
  }
  if (!(await crewIsFieldUser(env, tenantId, input.crew_user_id))) {
    refuse("field_item_crew_user_not_found", 404);
  }

  const existing = await env.DB.prepare(
    `SELECT resolution_id FROM field_item_resolutions
      WHERE tenant_id = ? AND device_action_id = ? AND payload_sha256 IS ?`,
  )
    .bind(tenantId, input.device_action_id, input.payload_sha256)
    .first<{ resolution_id: string }>();
  if (existing) refuse("field_item_already_resolved", 409);

  let crewDeviceId: string | null = null;
  const anyWriteBinds = await anyCrewWriteBinds(tenantId, input.device_action_id);
  if (input.resolution === "not_arrived") {
    const present = await env.DB.prepare(`SELECT ${ANY_CREW_WRITE} AS present`)
      .bind(...anyWriteBinds)
      .first<{ present: number }>();
    if (present?.present) refuse("field_item_crew_write_exists", 409);
  } else {
    const rows = await env.DB.prepare(bound.select)
      .bind(tenantId, await bound.key(tenantId, input.device_action_id))
      .all<CrewWriteRow>();
    if (rows.results.length === 0) refuse("field_item_crew_write_not_found", 404);
    // Two devices that used one action id (possible only for scans) is not one exact item.
    if (rows.results.length > 1) refuse("field_item_ambiguous", 409);
    const write = rows.results[0] as CrewWriteRow;
    if (!write.settled) refuse("field_item_crew_write_unsettled", 409);
    if (write.crew_user_id !== input.crew_user_id) refuse("field_item_crew_mismatch", 409);
    if (write.payload_sha256 !== input.payload_sha256) refuse("field_item_payload_mismatch", 409);
    if (
      input.linked_record?.type !== bound.linkedRecordType ||
      input.linked_record.id !== write.linked_record_id
    ) {
      refuse("field_item_linked_record_mismatch", 409);
    }
    const device = write.crew_device_id;
    crewDeviceId = device && device.length >= 8 && device.length <= 160 ? device : null;
  }

  const resolutionId = `fir_${await sha256Hex(canonicalJson({ tenant: tenantId, request: requestId }))}`;
  const createdAt = now().toISOString();
  const values = [
    resolutionId,
    tenantId,
    input.device_action_id,
    input.item_kind,
    input.payload_sha256,
    input.resolution,
    input.linked_record?.type ?? null,
    input.linked_record?.id ?? null,
    input.crew_user_id,
    crewDeviceId,
    person.userId,
    person.role,
    input.ai_proposal?.agent_id ?? null,
    input.ai_proposal?.evidence_id ?? null,
    requestId,
    requestSha256,
    createdAt,
  ];
  const columns = `(resolution_id, tenant_id, device_action_id, item_kind, payload_sha256,
      resolution, linked_record_type, linked_record_id, crew_user_id, crew_device_id,
      resolved_by_user_id, resolved_by_role, proposed_by_agent_id, proposal_evidence_id,
      request_id, request_sha256, created_at)`;
  const placeholders = values.map(() => "?").join(", ");
  // A `not_arrived` answer is written only while no crew write exists, inside the same statement,
  // so a write that lands between the check above and this insert is never contradicted.
  const insert = input.resolution === "not_arrived"
    ? env.DB.prepare(
      `INSERT INTO field_item_resolutions ${columns}
       SELECT ${placeholders} WHERE NOT ${ANY_CREW_WRITE}`,
    ).bind(...values, ...anyWriteBinds)
    : env.DB.prepare(`INSERT INTO field_item_resolutions ${columns} VALUES (${placeholders})`)
      .bind(...values);
  // The audit event commits with the answer or not at all.
  const audit = env.DB.prepare(
    `INSERT INTO audit_log
       (ts, automation, trigger, envelope_id, source_ids, target_ids, action, result,
        approved_by, reason)
     SELECT ?, 'field_item_resolution', ?, ?, ?, ?, ?, 'ok', ?, ?
      WHERE EXISTS (SELECT 1 FROM field_item_resolutions WHERE tenant_id = ? AND resolution_id = ?)`,
  ).bind(
    createdAt,
    input.ai_proposal ? "office_confirmed_ai_proposal" : "office",
    resolutionId,
    `device_action:${input.device_action_id},kind:${input.item_kind}`,
    input.linked_record ? `${input.linked_record.type}:${input.linked_record.id}` : null,
    `resolve_${input.resolution}`,
    person.userId,
    input.ai_proposal ? `${input.ai_proposal.agent_id}:${input.ai_proposal.evidence_id}` : null,
    tenantId,
    resolutionId,
  );
  let changes = 0;
  try {
    const results = (await env.DB.batch([insert, audit])) as Array<{ meta?: { changes?: number } }>;
    changes = Number(results[0]?.meta?.changes ?? 0);
  } catch (error) {
    const concurrent = await replay();
    if (concurrent) return concurrent;
    const detail = String(error);
    if (detail.includes("field_item_resolution_immutable")) refuse("field_item_already_resolved", 409);
    if (detail.includes("field_item_resolution_person_required")) {
      refuse("field_item_resolution_role_required", 403);
    }
    if (detail.includes("field_item_resolution_crew_required")) {
      refuse("field_item_crew_user_not_found", 404);
    }
    refuse("field_item_resolution_unavailable", 503);
  }
  if (changes !== 1) refuse("field_item_crew_write_exists", 409);
  const written = await readByRequest(env, tenantId, requestId);
  if (!written || written.request_sha256 !== requestSha256 || written.resolution_id !== resolutionId) {
    refuse("field_item_resolution_unavailable", 503);
  }
  return { replayed: false, resolution: officeView(written as ResolutionRow) };
}

function linkedRecord(row: ResolutionRow) {
  return row.linked_record_type && row.linked_record_id
    ? { type: row.linked_record_type, id: row.linked_record_id }
    : null;
}

/** What the phone needs: the answer and, for an item the office holds, a minimal link. */
function crewView(row: ResolutionRow) {
  return {
    resolution_id: row.resolution_id,
    device_action_id: row.device_action_id,
    item_kind: row.item_kind,
    payload_sha256: row.payload_sha256,
    resolution: row.resolution,
    linked_record: linkedRecord(row),
    resolved_at: row.created_at,
  };
}

function officeView(row: ResolutionRow) {
  return {
    ...crewView(row),
    crew_user_id: row.crew_user_id,
    resolved_by: { user_id: row.resolved_by_user_id, role: row.resolved_by_role },
    ai_proposal: row.proposed_by_agent_id && row.proposal_evidence_id
      ? { agent_id: row.proposed_by_agent_id, evidence_id: row.proposal_evidence_id }
      : null,
    request_id: row.request_id,
  };
}

/**
 * The crew read: answers for device action ids this phone holds, only within the caller's tenant
 * and only for items the caller created. A device id is not used: an inventory scan's device id is
 * client-supplied, so it never widens who may read an answer.
 */
export async function readFieldItemResolutionsForCrew(
  env: AppEnv,
  crew: { tenantId: string; userId: string },
  deviceActionIds: readonly string[],
) {
  if (deviceActionIds.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM field_item_resolutions
      WHERE tenant_id = ?
        AND device_action_id IN (${deviceActionIds.map(() => "?").join(", ")})
        AND crew_user_id = ?
      ORDER BY device_action_id, created_at, resolution_id`,
  )
    .bind(crew.tenantId, ...deviceActionIds, crew.userId)
    .all<ResolutionRow>();
  return rows.results.map(crewView);
}

const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/**
 * A machine credential or an agent marker on the request. App sessions are cookie-only, so an
 * `Authorization` header is always a machine caller (agent host, MCP, effect runtime, service);
 * the Hermes desktop agent announces itself with its own headers.
 */
function machineActorMarker(req: Request): boolean {
  if (req.headers.has("authorization")) return true;
  for (const name of req.headers.keys()) if (name.startsWith("x-ironwrap-hermes-")) return true;
  return false;
}

async function readBody(req: Request): Promise<unknown> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    refuse("invalid_field_item_resolution_content_type", 415);
  }
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    refuse("field_item_resolution_body_too_large", 413);
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    refuse("field_item_resolution_body_too_large", 413);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return refuse("invalid_field_item_resolution", 400);
  }
}

export async function handleFieldItemResolutions(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  try {
    if (env.APP_TENANT_ID !== auth.session.tenant_id) {
      return reply({ error: "tenant_identity_required" }, 403);
    }
    const url = new URL(req.url);
    if (req.method === "GET") {
      if (auth.session.role !== "field") return reply({ error: "field_role_required" }, 403);
      const keys = [...url.searchParams.keys()];
      const ids = [...new Set(url.searchParams.getAll("device_action_id"))];
      if (
        keys.some((key) => key !== "device_action_id") ||
        ids.length === 0 ||
        ids.length > MAX_READ_ITEMS ||
        ids.some((id) => !DEVICE_ACTION_ID.test(id))
      ) {
        return reply({ error: "invalid_field_item_resolution_query" }, 400);
      }
      const resolutions = await readFieldItemResolutionsForCrew(
        env,
        {
          tenantId: auth.session.tenant_id,
          userId: auth.session.user_id,
        },
        ids,
      );
      return reply({ version: 1, resolutions });
    }
    if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    if (machineActorMarker(req)) return reply({ error: "person_session_required" }, 403);
    if (auth.session.role !== "owner" && auth.session.role !== "ops") {
      return reply({ error: "field_item_resolution_role_required" }, 403);
    }
    if (url.search) return reply({ error: "invalid_field_item_resolution_query" }, 400);
    if (!validAppCsrf(req, auth)) return reply({ error: "csrf_failed" }, 403);
    const requestId = req.headers.get("idempotency-key") ?? "";
    if (!FIELD_ITEM_RESOLUTION_REQUEST_ID.test(requestId)) {
      return reply({ error: "invalid_field_item_resolution_request_id" }, 400);
    }
    const input = parseFieldItemResolutionInput(await readBody(req));
    const result = await recordFieldItemResolution(
      env,
      {
        kind: "person",
        tenantId: auth.session.tenant_id,
        userId: auth.session.user_id,
        role: auth.session.role,
      },
      requestId,
      input,
    );
    return reply({ version: 1, ...result }, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof FieldItemResolutionError) return reply({ error: error.code }, error.status);
    return reply({ error: "field_item_resolution_unavailable" }, 503);
  }
}
