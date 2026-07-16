#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tenantDir = join(root, "config", "tenants");

try {
  validateTenantRuntime(process.env);
  console.log("ok tenant runtime preflight");
} catch (error) {
  console.error(error instanceof Error ? error.message : "tenant runtime preflight failed");
  process.exitCode = 1;
}

export function validateTenantRuntime(env) {
  const tenant = selectedTenant(env);
  const expected = [
    ["APP_TENANT_ID", tenant.tenant?.id],
    ["APP_TENANT_NAME", tenant.runtime?.app_tenant_name],
    ["APP_TENANT_BRAND", tenant.brand?.name],
    ["APP_LOCALE", tenant.locale?.language_tag],
    ["APP_TIME_ZONE", tenant.locale?.timezone],
    ["APP_CURRENCY", tenant.locale?.currency],
  ];

  for (const [name, value] of expected) {
    if (!nonEmptyString(value)) fail(`selected tenant config is missing ${name} metadata`);
    if (env[name] !== value) fail(`${name} does not match the selected tenant config`);
  }

  const senderMailboxes = (Array.isArray(tenant.brand?.brands) ? tenant.brand.brands : [])
    .flatMap((brand) => [
      brand?.sender_mailbox,
      ...(Array.isArray(brand?.sender_aliases) ? brand.sender_aliases : []),
    ])
    .filter(nonEmptyString);
  if (!nonEmptyString(env.FROM_EMAIL) || !senderMailboxes.includes(env.FROM_EMAIL)) {
    fail("FROM_EMAIL is not a declared sender mailbox or alias");
  }

  const bffEnabled = env.APP_BFF_ENABLED === "true";
  if (env.APP_CUSTOMER_PORTAL_ENABLED === "true" && !bffEnabled) {
    fail("APP_CUSTOMER_PORTAL_ENABLED requires APP_BFF_ENABLED");
  }
  if (!bffEnabled) return;

  const publicOrigin = canonicalHttpsOrigin(env.APP_PUBLIC_ORIGIN);
  if (!publicOrigin) fail("APP_PUBLIC_ORIGIN must be a canonical HTTPS origin");
  if (!(env.APP_ALLOWED_ORIGINS ?? "").split(",").includes(publicOrigin)) {
    fail("APP_ALLOWED_ORIGINS must include APP_PUBLIC_ORIGIN exactly");
  }
}

function selectedTenant(env) {
  const id = env.IRONWRAP_TENANT_CONFIG;
  if (!nonEmptyString(id) || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) {
    fail("IRONWRAP_TENANT_CONFIG must select a known tenant config");
  }

  let files;
  try {
    files = readdirSync(tenantDir).filter((file) => file.endsWith(".json"));
  } catch {
    fail("tenant config directory is unavailable");
  }

  for (const file of files) {
    try {
      const tenant = JSON.parse(readFileSync(join(tenantDir, file), "utf8"));
      if (tenant.tenant?.id === id) return tenant;
    } catch {
      fail("tenant config could not be read");
    }
  }
  fail("IRONWRAP_TENANT_CONFIG must select a known tenant config");
}

function canonicalHttpsOrigin(value) {
  if (!nonEmptyString(value) || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(message) {
  throw new Error(`tenant runtime preflight failed: ${message}`);
}
