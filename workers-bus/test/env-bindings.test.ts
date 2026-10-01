import { test } from "node:test";
import assert from "node:assert/strict";

import { flattenEnv } from "../src/env-bindings.ts";

// IRO-268 R1.6: nothing asserted the two properties the whole .dev.vars story and the "old
// config + new code works" half of the rollback plan (spec section 7) rest on. `grep -rn
// flattenEnv workers-bus/test tools` found only the budget test's parity check and
// app-migration.test.ts's use of it as a helper - neither exercises precedence or the no-op.

test("a flat binding on env wins over the same name inside a CFG_* group", () => {
  const env = {
    ERPNEXT_BASE_URL: "https://flat.example.invalid",
    CFG_ERPNEXT: { ERPNEXT_BASE_URL: "https://grouped.example.invalid", ERPNEXT_INTEGRATION_USER: "Administrator" },
  } as unknown as Env;
  const flattened = flattenEnv(env);
  assert.equal((flattened as unknown as Record<string, unknown>).ERPNEXT_BASE_URL, "https://flat.example.invalid");
  assert.equal((flattened as unknown as Record<string, unknown>).ERPNEXT_INTEGRATION_USER, "Administrator");
});

test("an env with no CFG_* binding comes back as the same object", () => {
  const env = { DB: "not-a-real-binding", ADMIN_TOKEN: "secret" } as unknown as Env;
  assert.strictEqual(flattenEnv(env), env);
});

test("flattening is idempotent", () => {
  const env = {
    CFG_CORE: { OWNER_ALERT_EMAIL: "owner@example.invalid" },
  } as unknown as Env;
  const once = flattenEnv(env);
  const twice = flattenEnv(once) as unknown as Record<string, unknown>;
  assert.equal(twice.OWNER_ALERT_EMAIL, "owner@example.invalid");
  assert.deepEqual(Object.keys(twice).sort(), Object.keys(once as unknown as Record<string, unknown>).sort());
});

test("non-CFG_* bindings survive by reference", () => {
  const db = { marker: "db-binding" };
  const env = { DB: db, CFG_CORE: { OWNER_ALERT_EMAIL: "owner@example.invalid" } } as unknown as Env;
  const flattened = flattenEnv(env) as unknown as { DB: typeof db };
  assert.strictEqual(flattened.DB, db);
});
