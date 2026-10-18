import type { AppEnv, AuthContext } from "./app-types.ts";
import { validAppCsrf } from "./app-auth.ts";
import {
  PricingCatalogError,
  pricingCatalogEnabled,
  activateCatalogRevision,
  catalogActivationView,
  catalogRevisionView,
  createCatalogRevision,
  parseCatalogActivate,
  parseCatalogCreate,
  readPricingCatalog,
} from "./pricing-catalog.ts";

const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
async function readBody(req: Request): Promise<unknown> {
  if (
    !req.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new PricingCatalogError("pricing_catalog_content_type_invalid", 415);
  if (Number(req.headers.get("content-length") ?? 0) > 68000)
    throw new PricingCatalogError("pricing_catalog_body_too_large", 413);
  const reader = req.body?.getReader();
  if (!reader)
    throw new PricingCatalogError("pricing_catalog_input_invalid", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > 68000) {
      await reader.cancel();
      throw new PricingCatalogError("pricing_catalog_body_too_large", 413);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new PricingCatalogError("pricing_catalog_input_invalid", 400);
  }
}
export async function handlePricingCatalog(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  action?: string,
): Promise<Response> {
  if (!pricingCatalogEnabled(env)) return reply({ error: "not_found" }, 404);
  if (!auth.permissions.includes("estimator:read"))
    return reply({ error: "estimator_read_required" }, 403);
  if (env.APP_TENANT_ID !== auth.session.tenant_id)
    return reply({ error: "tenant_identity_required" }, 403);
  const actor = {
    tenantId: auth.session.tenant_id,
    userId: auth.session.user_id,
    role: auth.session.role,
  };
  try {
    if (req.method === "GET" && !action) {
      const url = new URL(req.url),
        before = url.searchParams.get("activation_before");
      if (
        before &&
        (!/^[1-9][0-9]*$/.test(before) || !Number.isSafeInteger(Number(before)))
      )
        return reply({ error: "pricing_catalog_cursor_invalid" }, 400);
      const model = await readPricingCatalog(
        env,
        actor.tenantId,
        url.searchParams.get("revision_cursor") ?? undefined,
        before ? Number(before) : undefined,
      );
      return reply({
        ...model,
        allowed_actions:
          auth.permissions.includes("pricing:manage") &&
          ["owner", "ops"].includes(actor.role)
            ? ["pricing_catalog.create", "pricing_catalog.approve_activate"]
            : [],
      });
    }
    if (
      req.method !== "POST" ||
      !["revisions", "activations"].includes(action ?? "")
    )
      return reply({ error: "method_not_allowed" }, 405);
    if (
      !auth.permissions.includes("pricing:manage") ||
      !["owner", "ops"].includes(actor.role)
    )
      return reply({ error: "pricing_catalog_actor_forbidden" }, 403);
    if (!validAppCsrf(req, auth)) return reply({ error: "csrf_failed" }, 403);
    const value = await readBody(req),
      key = req.headers.get("idempotency-key") ?? "";
    if (action === "revisions") {
      const result = await createCatalogRevision(
        env,
        actor,
        parseCatalogCreate(value),
        key,
      );
      return reply(
        {
          replayed: result.replayed,
          revision: catalogRevisionView(result.revision),
        },
        result.replayed ? 200 : 201,
      );
    }
    const result = await activateCatalogRevision(
      env,
      actor,
      parseCatalogActivate(value),
      key,
    );
    return reply(
      {
        replayed: result.replayed,
        activation: catalogActivationView(result.activation),
      },
      result.replayed ? 200 : 201,
    );
  } catch (error) {
    return error instanceof PricingCatalogError
      ? reply({ error: error.code }, error.status)
      : reply({ error: "pricing_catalog_unavailable" }, 503);
  }
}
