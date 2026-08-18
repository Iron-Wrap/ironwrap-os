import { validAppCsrf } from "./app-auth.ts";
import {
  claimAuthorityRecordAction,
  getAuthorityRecordAction,
  listAuthorityRecordReadbacks,
  type AuthorityRecordOperation,
} from "./authority-records.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";

const MAX_BODY_BYTES = 16 * 1024;
const AUTHORITY_WRITE_ROLES = new Set(["owner", "ops"]);

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
): Promise<Response | null> {
  const url = new URL(req.url);
  const actionDetail = url.pathname.match(/^\/api\/v1\/authority-records\/actions\/([^/]+)$/);
  if (req.method === "GET" && actionDetail) {
    if (!readAllowed(auth)) return json({ error: "authority_read_required" }, 403);
    const actionId = pathPart(actionDetail[1] ?? "");
    if (!actionId) return json({ error: "not_found" }, 404);
    try {
      const action = await getAuthorityRecordAction(env, auth.session.tenant_id, actionId);
      return action ? json({ version: 1, action }) : json({ error: "not_found" }, 404);
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
      return json({ version: 1, ...result }, result.kind === "claimed" ? 201 : result.kind === "conflict" ? 409 : 200);
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
