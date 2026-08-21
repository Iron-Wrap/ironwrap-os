import assert from "node:assert/strict";
import test from "node:test";
import type { AppEnv } from "../src/app-types.ts";
import {
  FRAPPE_RAILS,
  railAuthorizationHeader,
  railCredentialBindings,
  railCredentialIsolationConfigured,
  railCredentialIsolationFailures,
  railFrappeCredentialConfigured,
  resolveRailFrappeCredential,
} from "../src/rail-frappe-credentials.ts";

function env(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "bus-key",
    ERPNEXT_API_SECRET: "bus-secret",
    FLEET_CAPTURE_FRAPPE_API_KEY: "fleet-key",
    FLEET_CAPTURE_FRAPPE_API_SECRET: "fleet-secret",
    WORK_PACKAGE_FRAPPE_API_KEY: "work-package-key",
    WORK_PACKAGE_FRAPPE_API_SECRET: "work-package-secret",
    ...overrides,
  } as AppEnv;
}

test("each rail authenticates with its own pair and never with the shared bus pair", () => {
  const headers = FRAPPE_RAILS.map((rail) => railAuthorizationHeader(env(), rail));
  assert.deepEqual(headers, [
    "token fleet-key:fleet-secret",
    "token work-package-key:work-package-secret",
  ]);
  assert.equal(new Set(headers).size, headers.length, "two rails must not share one identity");
  for (const header of headers) {
    assert.equal(header.includes("bus-key"), false);
    assert.equal(header.includes("bus-secret"), false);
  }
});

test("a rail whose binding holds the shared bus key is refused, not quietly accepted", () => {
  // The binding name alone is not isolation: pasting the bus pair in leaves the blast
  // radius exactly as wide as it was before the split (ELEC-48 audit section 3).
  for (const [rail, overrides] of [
    ["fleet_capture", { FLEET_CAPTURE_FRAPPE_API_KEY: "bus-key" }],
    ["fleet_capture", { FLEET_CAPTURE_FRAPPE_API_SECRET: "bus-secret" }],
    ["work_package", { WORK_PACKAGE_FRAPPE_API_KEY: "bus-key" }],
    ["work_package", { WORK_PACKAGE_FRAPPE_API_SECRET: "bus-secret" }],
  ] as const) {
    const resolved = resolveRailFrappeCredential(env(overrides), rail);
    assert.equal(resolved.ok, false, `${rail} accepted the shared pair via ${Object.keys(overrides)[0]}`);
    assert.equal(
      resolved.ok === false && resolved.code,
      `${rail === "fleet_capture" ? "fleet" : "work_package"}_frappe_shared_credential_rejected`,
    );
    assert.throws(() => railAuthorizationHeader(env(overrides), rail), /shared_credential_rejected/);
  }
});

test("a half-configured or blank rail pair fails closed with its own rail's code", () => {
  assert.throws(
    () => railAuthorizationHeader(env({ FLEET_CAPTURE_FRAPPE_API_SECRET: "   " }), "fleet_capture"),
    /^Error: fleet_frappe_not_configured$/,
  );
  assert.throws(
    () => railAuthorizationHeader(env({ WORK_PACKAGE_FRAPPE_API_KEY: "" }), "work_package"),
    /^Error: work_package_frappe_not_configured$/,
  );
});

test("surrounding whitespace never becomes part of the presented credential", () => {
  const header = railAuthorizationHeader(
    env({ FLEET_CAPTURE_FRAPPE_API_KEY: "  fleet-key\n", FLEET_CAPTURE_FRAPPE_API_SECRET: " fleet-secret " }),
    "fleet_capture",
  );
  assert.equal(header, "token fleet-key:fleet-secret");
});

test("readiness reports the isolation gap only for a Worker that actually serves the rails", () => {
  // A BFF that is switched off carries neither rail, so a missing pair is not a fault.
  assert.equal(railCredentialIsolationConfigured(env({ APP_BFF_ENABLED: "false" })), true);
  assert.deepEqual(railCredentialIsolationFailures(env({ APP_BFF_ENABLED: "false" })), []);

  const enabled = { APP_BFF_ENABLED: "true" } as Partial<AppEnv>;
  assert.equal(railCredentialIsolationConfigured(env(enabled)), true);
  assert.equal(
    railCredentialIsolationConfigured(env({ ...enabled, WORK_PACKAGE_FRAPPE_API_KEY: "" })),
    false,
  );
  assert.deepEqual(
    railCredentialIsolationFailures(
      env({ ...enabled, FLEET_CAPTURE_FRAPPE_API_KEY: "bus-key", WORK_PACKAGE_FRAPPE_API_SECRET: "" }),
    ),
    ["fleet_frappe_shared_credential_rejected", "work_package_frappe_not_configured"],
  );
});

test("the declared bindings are the ones operators are told to set", () => {
  assert.deepEqual(railCredentialBindings("fleet_capture"), {
    key: "FLEET_CAPTURE_FRAPPE_API_KEY",
    secret: "FLEET_CAPTURE_FRAPPE_API_SECRET",
  });
  assert.deepEqual(railCredentialBindings("work_package"), {
    key: "WORK_PACKAGE_FRAPPE_API_KEY",
    secret: "WORK_PACKAGE_FRAPPE_API_SECRET",
  });
  assert.equal(railFrappeCredentialConfigured(env(), "fleet_capture"), true);
});
