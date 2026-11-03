import { test } from "node:test";
import assert from "node:assert/strict";
import { frappeBaseUrl } from "../src/facet-design-frappe-projection.ts";
import type { AppEnv } from "../src/app-types.ts";

function env(overrides: Partial<AppEnv>): AppEnv {
  return {
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    ...overrides,
  } as never;
}

test("a deployed tenant must use https", () => {
  assert.equal(
    frappeBaseUrl(env({ ERPNEXT_BASE_URL: "https://frappe.tenant.example/" })),
    "https://frappe.tenant.example",
  );
  assert.throws(
    () => frappeBaseUrl(env({ ERPNEXT_BASE_URL: "http://frappe.tenant.example" })),
    /frappe_read_bad_base_url/,
  );
});

test("a second tenant's local Frappe site is reachable on its own .localhost name", () => {
  // One Frappe site per tenant is the isolation unit, and on the local compose stack the
  // tenant's site is reached by Host header at http://<tenant>.localhost:8000, so allowing only
  // the bare `localhost` would refuse every cloned tenant's site.
  const cloned = env({
    ERPNEXT_BASE_URL: "http://northline-metal.localhost:8000",
    APP_ALLOW_INSECURE_LOCAL: "true",
  });
  assert.equal(frappeBaseUrl(cloned), "http://northline-metal.localhost:8000");
});

test("the .localhost allowance is still gated on the explicit local-only flag", () => {
  // Every deployed environment pins APP_ALLOW_INSECURE_LOCAL to "false", so this stays a
  // loopback-only development escape hatch rather than a plaintext transport anyone can reach.
  const deployed = env({
    ERPNEXT_BASE_URL: "http://northline-metal.localhost:8000",
    APP_ALLOW_INSECURE_LOCAL: "false",
  });
  assert.throws(() => frappeBaseUrl(deployed), /frappe_read_bad_base_url/);
});

test("a hostname that merely ends in the word localhost is not loopback", () => {
  assert.throws(
    () =>
      frappeBaseUrl(
        env({ ERPNEXT_BASE_URL: "http://evillocalhost", APP_ALLOW_INSECURE_LOCAL: "true" }),
      ),
    /frappe_read_bad_base_url/,
  );
  assert.throws(
    () =>
      frappeBaseUrl(
        env({ ERPNEXT_BASE_URL: "http://not-localhost.example", APP_ALLOW_INSECURE_LOCAL: "true" }),
      ),
    /frappe_read_bad_base_url/,
  );
});

test("credentials in the base URL are refused however local it looks", () => {
  assert.throws(
    () =>
      frappeBaseUrl(
        env({
          ERPNEXT_BASE_URL: "http://user:pass@tenant.localhost:8000",
          APP_ALLOW_INSECURE_LOCAL: "true",
        }),
      ),
    /frappe_read_bad_base_url/,
  );
});
