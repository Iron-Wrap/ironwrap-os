import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AuthContext,
} from "../src/app-types.ts";

const auth: AuthContext = {
  rawSessionToken: "s".repeat(43),
  csrfToken: "csrf",
  permissions: permissionsForRole("owner"),
  session: {
    session_hash: "a".repeat(64),
    session_created_at: "2026-08-21T00:00:00.000Z",
    session_expires_at: "2026-08-21T12:00:00.000Z",
    revoked_at: null,
    user_id: "appu_owner_0001",
    tenant_id: "ironwrap",
    email_normalized: "owner@example.com",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: null,
    active: 1,
    created_by: "bootstrap",
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:00.000Z",
  },
};

test("legacy production schedule approval routes are inert after native cutover", async () => {
  const env = new Proxy(
    {},
    {
      get() {
        throw new Error("legacy_schedule_route_touched_environment");
      },
    },
  ) as AppEnv;
  const routes = [
    ["GET", "/api/v1/production-schedule-approvals"],
    ["POST", "/api/v1/production-schedule-approvals"],
    ["GET", "/api/v1/production-schedule-approvals/approval-1"],
    ["POST", "/api/v1/production-schedule-approvals/approval-1/approve"],
    ["POST", "/api/v1/production-schedule-approvals/approval-1/reject"],
    ["POST", "/api/v1/production-schedule-approvals/approval-1/reconcile"],
  ] as const;

  for (const [method, path] of routes) {
    const response = await handleAuthenticatedRoute(
      new Request(`https://app.example.com${path}`, { method }),
      env,
      auth,
    );
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "not_found" });
  }
});
