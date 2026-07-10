import {
  appBffConfigured,
  authenticateAppRequest,
  consumeDevicePairing,
  consumeMagicLink,
  expiredSessionCookie,
  logoutAppSession,
  issueDevicePairing,
  listDevicePairings,
  listFieldPairingUsers,
  parseProvisionAppUser,
  provisionAppUser,
  requestMagicLink,
  revokeDevicePairing,
  sessionPayload,
  unauthenticatedSessionPayload,
  validateAppOrigin,
  validAppCsrf,
} from "./app-auth.ts";
import {
  activeAssignmentForJob,
  buildJobProofReadModel,
  buildJobReadModel,
  buildOwnerNowReadModel,
  buildTodayReadModel,
} from "./app-read-models.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import { handleFieldAction } from "./field-actions.ts";

const MAX_ADMIN_BODY_BYTES = 8 * 1024;

export async function handleAppApi(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const appEnv = env as AppEnv;
  if (String(appEnv.APP_BFF_ENABLED) !== "true") return appJson({ error: "app_bff_disabled" }, 503);
  if (!appBffConfigured(appEnv)) return appJson({ error: "app_bff_not_configured" }, 503);

  const url = new URL(req.url);
  const mutation = req.method === "POST";
  const origin = validateAppOrigin(req, appEnv, req.method === "OPTIONS" || mutation);
  if (!origin.ok) return appJson({ error: "origin_not_allowed" }, 403);
  if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), origin.origin);

  let response: Response;
  if (req.method === "POST" && url.pathname === "/api/v1/auth/magic-link/request") {
    response = await requestMagicLink(req, appEnv, ctx);
  } else if (req.method === "POST" && url.pathname === "/api/v1/auth/magic-link/consume") {
    response = await consumeMagicLink(req, appEnv);
  } else if (req.method === "POST" && url.pathname === "/api/v1/auth/device-pairing/consume") {
    response = await consumeDevicePairing(req, appEnv);
  } else {
    const auth = await authenticateAppRequest(req, appEnv);
    if (!auth) {
      if (req.method === "GET" && url.pathname === "/api/v1/session") {
        response = appJson(unauthenticatedSessionPayload(appEnv));
        response.headers.set("cache-control", "private, no-store");
        response.headers.set("set-cookie", expiredSessionCookie());
      } else {
        response = appJson({ error: "unauthorized" }, 401);
        response.headers.set("set-cookie", expiredSessionCookie());
      }
    } else {
      response = await handleAuthenticatedRoute(req, appEnv, auth);
    }
  }
  return withCors(response, origin.origin);
}

export async function handleAdminAppUserProvision(req: Request, env: Env): Promise<Response> {
  const appEnv = env as AppEnv;
  if (String(appEnv.APP_BFF_ENABLED) !== "true") return appJson({ error: "app_bff_disabled" }, 503);
  if (!appBffConfigured(appEnv)) return appJson({ error: "app_bff_not_configured" }, 503);
  const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
  if (!parsed.ok) return appJson({ error: parsed.error }, parsed.status);
  const validated = parseProvisionAppUser(parsed.value, appEnv);
  if (!validated.ok) return appJson({ error: validated.error }, 400);
  const user = await provisionAppUser(appEnv, validated.value, req);
  return appJson({
    user: {
      user_id: user.user_id,
      tenant_id: user.tenant_id,
      email: user.email_normalized,
      display_name: user.display_name,
      role: user.role,
      frappe_user_id: user.frappe_user_id,
      active: user.active === 1,
      updated_at: user.updated_at,
    },
  });
}

export async function handleAuthenticatedRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/api/v1/session") {
    const response = appJson(sessionPayload(auth, env));
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
  if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") {
    return await logoutAppSession(req, env, auth);
  }
  if (req.method === "GET" && url.pathname === "/api/v1/field-users") {
    if (auth.session.role !== "owner" && auth.session.role !== "ops") {
      return appJson({ error: "office_role_required" }, 403);
    }
    return appJson({ users: await listFieldPairingUsers(env, auth) });
  }
  if (url.pathname === "/api/v1/device-pairings") {
    if (auth.session.role !== "owner" && auth.session.role !== "ops") {
      return appJson({ error: "office_role_required" }, 403);
    }
    if (req.method === "GET") return appJson({ devices: await listDevicePairings(env, auth) });
    if (req.method === "POST") {
      const parsed = await readJson(req, MAX_ADMIN_BODY_BYTES);
      if (!parsed.ok) return appJson({ error: parsed.error }, parsed.status);
      if (!isRecord(parsed.value) || Object.keys(parsed.value).some((key) => key !== "field_user_id")) {
        return appJson({ error: "unexpected_field" }, 400);
      }
      const fieldUserId = typeof parsed.value.field_user_id === "string" ? parsed.value.field_user_id : "";
      const result = await issueDevicePairing(req, env, auth, fieldUserId);
      return result.ok ? appJson({
        pairing_url: result.pairing_url,
        expires_at: result.expires_at,
        field_user: result.field_user,
      }) : appJson({ error: result.error }, result.status);
    }
  }
  const revokeMatch = url.pathname.match(/^\/api\/v1\/device-pairings\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revokeMatch) {
    const deviceId = decodedPathSegment(revokeMatch[1]);
    if (!deviceId) return appJson({ error: "not_found" }, 404);
    const result = await revokeDevicePairing(req, env, auth, deviceId);
    return result.ok
      ? appJson({ ok: true, device_id: result.device_id, revoked_at: result.revoked_at })
      : appJson({ error: result.error }, result.status);
  }
  if (req.method === "GET" && url.pathname === "/api/v1/today") {
    try {
      return appJson(await buildTodayReadModel(env, auth));
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const proofMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/proof$/);
  if (req.method === "GET" && proofMatch) {
    const jobName = decodedPathSegment(proofMatch[1]);
    if (!jobName) return appJson({ error: "not_found" }, 404);
    try {
      const model = await buildJobProofReadModel(env, auth, jobName, url.searchParams.get("cursor"));
      return model ? appJson(model) : appJson({ error: "not_found" }, 404);
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const checkInMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/check-ins$/);
  if (req.method === "POST" && checkInMatch) {
    if (auth.session.role !== "field") return appJson({ error: "field_role_required" }, 403);
    if (!validAppCsrf(req, auth)) return appJson({ error: "csrf_failed" }, 403);
    const jobName = decodedPathSegment(checkInMatch[1]);
    if (!jobName) return appJson({ error: "not_found" }, 404);
    try {
      const assignment = await activeAssignmentForJob(env, auth, jobName);
      const assignmentName = typeof assignment?.name === "string" ? assignment.name : null;
      if (!assignmentName) return appJson({ error: "not_found" }, 404);
      return await handleFieldAction(req, env, auth, jobName, assignmentName);
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    const jobName = decodedPathSegment(jobMatch[1]);
    if (!jobName) return appJson({ error: "not_found" }, 404);
    try {
      const model = await buildJobReadModel(env, auth, jobName);
      return model ? appJson(model) : appJson({ error: "not_found" }, 404);
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/v1/owner/now") {
    if (auth.session.role !== "owner" && auth.session.role !== "ops") {
      return appJson({ error: "forbidden" }, 403);
    }
    try {
      return privateAppJson(await buildOwnerNowReadModel(env, auth));
    } catch {
      return privateAppJson({ error: "upstream_unavailable" }, 502);
    }
  }
  return appJson({ error: "not_found" }, 404);
}

function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "Content-Type, X-CSRF-Token, X-IronWrap-Device-Proof, X-Device-Action-Id, Idempotency-Key, X-Request-ID, X-Correlation-ID",
  );
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function decodedPathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readJson(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> {
  if (Number(req.headers.get("content-length") ?? "0") > maxBytes) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  const text = await req.text();
  if (text.length > maxBytes) return { ok: false, error: "payload_too_large", status: 413 };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
}

function appJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function privateAppJson(body: unknown, status = 200): Response {
  const response = appJson(body, status);
  response.headers.set("cache-control", "private, no-store");
  return response;
}
