#!/usr/bin/env node
// Run tools/validate-tenant-runtime.mjs for one tenant, with the runtime env derived from that
// tenant's own config.
//
// The validator compares APP_TENANT_* / FROM_EMAIL against the selected tenant config, so every
// caller has to build the same eight-variable env first. Building it in shell means quoting a
// display name that contains spaces, which silently truncates and turns a real mismatch into a
// "missing metadata" error about a different variable. Building it here is one place, and the
// values come from the config rather than from whoever typed the command.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function runtimeEnvFor(tenant, { workerOrigin } = {}) {
  const env = {
    IRONWRAP_TENANT_CONFIG: tenant.tenant.id,
    APP_TENANT_ID: tenant.tenant.id,
    APP_TENANT_NAME: tenant.runtime.app_tenant_name,
    APP_TENANT_BRAND: tenant.brand.name,
    APP_LOCALE: tenant.locale.language_tag,
    APP_TIME_ZONE: tenant.locale.timezone,
    APP_CURRENCY: tenant.locale.currency,
    FROM_EMAIL: tenant.brand.brands[0].sender_mailbox,
  };
  // The BFF half of the preflight only accepts a canonical HTTPS origin, which a local stack
  // on http://localhost never is. Enabling it for a local origin would fail on the transport
  // rather than on anything about the tenant, so the local run checks the tenant identity and
  // sender mailbox with the BFF off, exactly as CI already checks the IronWrap tenant. A real
  // tenant deployment passes its https origin here and gets the origin/allowlist check too.
  if (!workerOrigin || !workerOrigin.startsWith("https://")) {
    return { ...env, APP_BFF_ENABLED: "false", APP_CUSTOMER_PORTAL_ENABLED: "false" };
  }
  return {
    ...env,
    APP_BFF_ENABLED: "true",
    APP_CUSTOMER_PORTAL_ENABLED: "true",
    APP_PUBLIC_ORIGIN: workerOrigin,
    APP_ALLOWED_ORIGINS: workerOrigin,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tenantId, workerOrigin] = process.argv.slice(2);
  if (!tenantId) {
    console.error("usage: tenant-runtime-preflight.mjs <tenant-id> [worker-origin]");
    process.exit(2);
  }
  const tenant = JSON.parse(readFileSync(join(root, "config", "tenants", `${tenantId}.json`), "utf8"));
  const result = spawnSync(process.execPath, [join(root, "tools", "validate-tenant-runtime.mjs")], {
    env: { ...process.env, ...runtimeEnvFor(tenant, { workerOrigin }) },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
