import { humanGuard } from "./agents/control.ts";
import type { AgentDb } from "./agents/store.ts";
import { validAppCsrf } from "./app-auth.ts";
import { competencyCommandError, type CompetencyCommand } from "./agents/registry.ts";
import { actionWithoutPersonnelText, executeCompetencyCommand } from "./authority-record-native.ts";
import {
  AUTHORITY_EXPIRING_DAYS,
  claimAuthorityRecordAction,
  getAuthorityRecordAction,
  listAuthorityRecordReadbacks,
  listCurrentAuthorityHeads,
  type AuthorityRecordOperation,
} from "./authority-records.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";

const MAX_BODY_BYTES = 16 * 1024;
const AUTHORITY_WRITE_ROLES = new Set(["owner", "ops"]);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{7,255}$/;
const COMMAND_REFUSAL_STATUS: Record<string, number> = {
  authority_approver_required: 403,
  authority_self_approval_forbidden: 403,
  session_authority_changed: 403,
  authority_head_changed: 409,
  authority_ambiguous: 409,
  authority_contradictory: 409,
  authority_transition_invalid: 409,
  authority_version_limit_reached: 409,
  idempotency_conflict: 409,
  authority_readback_mismatch: 502,
};

function json(body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function body(req: Request): Promise<
  { ok: true; value: unknown } | { ok: false; error: string; status: number }
> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
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

function pathPart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,139}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function writeAllowed(auth: AuthContext): boolean {
  return AUTHORITY_WRITE_ROLES.has(auth.session.role);
}

function readAllowed(auth: AuthContext): boolean {
  return auth.permissions.includes("authority:read");
}

function csrfFailed(req: Request, auth: AuthContext): Response | null {
  return validAppCsrf(req, auth) ? null : json({ error: "csrf_failed" }, 403);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function handleAuthorityRecordRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  clock = () => Date.now(),
): Promise<Response | null> {
  const url = new URL(req.url);

  // The desk: every current head this tenant holds, with the fence's own verdict on each.
  // No live issuer is called; these are the readbacks already on file.
  if (req.method === "GET" && url.pathname === "/api/v1/authority-records") {
    if (!readAllowed(auth)) return json({ error: "authority_read_required" }, 403);
    const now = new Date().toISOString();
    try {
      const subjects = await listCurrentAuthorityHeads(env, auth.session.tenant_id, now);
      return json({
        version: 1,
        read_model_generated_at: now,
        expiring_within_days: AUTHORITY_EXPIRING_DAYS,
        subjects,
      });
    } catch {
      return json({ error: "authority_record_store_unavailable" }, 502);
    }
  }

  const actionDetail = url.pathname.match(/^\/api\/v1\/authority-records\/actions\/([^/]+)$/);
  if (req.method === "GET" && actionDetail) {
    if (!readAllowed(auth)) return json({ error: "authority_read_required" }, 403);
    const actionId = pathPart(actionDetail[1] ?? "");
    if (!actionId) return json({ error: "not_found" }, 404);
    try {
      const action = await getAuthorityRecordAction(env, auth.session.tenant_id, actionId);
      if (!action) return json({ error: "not_found" }, 404);
      return json({
        version: 1,
        action: auth.permissions.includes("authority:approve") ? action : actionWithoutPersonnelText(action),
      });
    } catch {
      return json({ error: "authority_record_store_unavailable" }, 502);
    }
  }

  const readbackList = url.pathname.match(/^\/api\/v1\/authority-records\/([^/]+)\/readbacks$/);
  if (req.method === "GET" && readbackList) {
    if (!readAllowed(auth)) return json({ error: "authority_read_required" }, 403);
    const recordId = pathPart(readbackList[1] ?? "");
    if (!recordId) return json({ error: "not_found" }, 404);
    try {
      const readbacks = await listAuthorityRecordReadbacks(env, auth.session.tenant_id, recordId);
      return json({ version: 1, authority_record_id: recordId, readbacks });
    } catch {
      return json({ error: "authority_record_store_unavailable" }, 502);
    }
  }

  // An internal worker competency command: the signed-in approver's own decision, which the
  // Worker records natively in D1 (authority-record-native.ts). External kinds are refused here.
  if (req.method === "POST" && url.pathname === "/api/v1/authority-records/commands") {
    if (!auth.permissions.includes("authority:approve")) return json({ error: "authority_approve_required" }, 403);
    const csrfError = csrfFailed(req, auth);
    if (csrfError) return csrfError;
    const parsed = await body(req);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    if (!isRecord(parsed.value)) return json({ error: "authority_command_invalid" }, 400);
    const { idempotency_key: idempotencyKey, ...command } = parsed.value;
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return json({ error: "authority_command_invalid" }, 400);
    }
    const invalid = competencyCommandError(command);
    if (invalid) return json({ error: invalid }, invalid === "authority_command_invalid" ? 400 : 422);
    const db = env.DB as unknown as AgentDb;
    const tenantId = auth.session.tenant_id;
    const now = new Date(clock()).toISOString();
    try {
      const result = await executeCompetencyCommand(
        db,
        { tenantId, command: command as unknown as CompetencyCommand, approverUserId: auth.session.user_id, idempotencyKey, now },
        [humanGuard(db, tenantId, { user_id: auth.session.user_id, role: auth.session.role, session_hash: auth.session.session_hash }, now, false)],
      );
      if ("refusal" in result) return json({ error: result.refusal }, COMMAND_REFUSAL_STATUS[result.refusal] ?? 422);
      return json(
        { version: 1, kind: result.kind, action: result.action, readback: result.readback },
        result.kind === "recorded" ? 201 : 200,
      );
    } catch {
      return json({ error: "authority_record_store_unavailable" }, 502);
    }
  }

  if (req.method !== "POST" || !url.pathname.startsWith("/api/v1/authority-records")) {
    return null;
  }
  if (!writeAllowed(auth)) return json({ error: "authority_business_role_required" }, 403);
  const csrfError = csrfFailed(req, auth);
  if (csrfError) return csrfError;

  if (url.pathname === "/api/v1/authority-records/actions") {
    const parsed = await body(req);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    if (!isRecord(parsed.value) || !exactKeys(parsed.value, [
      "action_id",
      "authority_record_id",
      "expected_version",
      "idempotency_key",
      "operation",
      "request_fingerprint_sha256",
    ])) return json({ error: "invalid_authority_action" }, 400);
    const actionId = stringField(parsed.value.action_id);
    const recordId = stringField(parsed.value.authority_record_id);
    const idempotencyKey = stringField(parsed.value.idempotency_key);
    const fingerprint = stringField(parsed.value.request_fingerprint_sha256);
    const operation = parsed.value.operation as AuthorityRecordOperation;
    const expectedVersion: number | null | undefined = parsed.value.expected_version === null
      ? null
      : Number.isInteger(parsed.value.expected_version)
        ? parsed.value.expected_version as number
        : undefined;
    if (!actionId || !recordId || !idempotencyKey || !fingerprint || expectedVersion === undefined ||
        !["record", "verify", "renew", "supersede", "revoke", "resolve_exception"].includes(operation)) {
      return json({ error: "invalid_authority_action" }, 400);
    }
    try {
      const result = await claimAuthorityRecordAction(env, {
        actionId,
        tenantId: auth.session.tenant_id,
        authorityRecordId: recordId,
        operation,
        expectedVersion: expectedVersion as number | null,
        idempotencyKey,
        requestFingerprintSha256: fingerprint,
        actorUserId: auth.session.user_id,
        now: new Date().toISOString(),
      });
      // A replay or conflict returns the recorded action; its personnel text stays with approvers.
      const action = auth.permissions.includes("authority:approve") ? result.action : actionWithoutPersonnelText(result.action);
      return json({ version: 1, ...result, action }, result.kind === "claimed" ? 201 : result.kind === "conflict" ? 409 : 200);
    } catch {
      return json({ error: "authority_record_store_unavailable" }, 502);
    }
  }

  const completion = url.pathname.match(/^\/api\/v1\/authority-records\/actions\/([^/]+)\/complete$/);
  if (req.method === "POST" && completion) {
    // A browser session may request and observe a governed action, but it can
    // never manufacture an executor result, Frappe readback, or issuer proof.
    // Terminalization is restricted to the separately authenticated executor
    // route in authority-record-executor-api.ts.
    return json({ error: "authority_executor_required" }, 403);
  }

  if (url.pathname === "/api/v1/authority-records/readbacks") {
    // Issuer readbacks are materialized by the issuer/executor rail only. An
    // Owner or Ops browser can request the action and inspect its result, but
    // cannot turn self-authored metadata into external proof.
    return json({ error: "issuer_adapter_required" }, 403);
  }
  return json({ error: "not_found" }, 404);
}
