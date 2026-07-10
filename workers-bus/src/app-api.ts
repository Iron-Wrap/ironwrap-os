import {
  appBffConfigured,
  authenticateAppRequest,
  consumeMagicLink,
  expiredSessionCookie,
  logoutAppSession,
  parseProvisionAppUser,
  provisionAppUser,
  requestMagicLink,
  sessionPayload,
  unauthenticatedSessionPayload,
  validateAppOrigin,
} from "./app-auth.ts";
import { buildJobReadModel, buildOwnerNowReadModel, buildTodayReadModel } from "./app-read-models.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";

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

async function handleAuthenticatedRoute(
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
  if (req.method === "GET" && url.pathname === "/api/v1/today") {
    try {
      return appJson(await buildTodayReadModel(env, auth));
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
    }
  }
  const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    let jobName: string;
    try {
      jobName = decodeURIComponent(jobMatch[1]);
    } catch {
      return appJson({ error: "not_found" }, 404);
    }
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
      return appJson(await buildOwnerNowReadModel(env, auth));
    } catch {
      return appJson({ error: "upstream_unavailable" }, 502);
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
  headers.set("access-control-allow-headers", "Content-Type, X-CSRF-Token, X-Request-ID, X-Correlation-ID");
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
