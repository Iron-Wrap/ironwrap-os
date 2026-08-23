import { test } from "node:test";
import assert from "node:assert/strict";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { parseOfficeLead, officeLeadPayload } from "../src/lead-intake.ts";
import { apiRequest, authFor, onboardingEnv } from "./onboarding-fixture.ts";

const TEAMMATE = {
  tenant_id: "freshco",
  email: "sam.sales@freshco.example",
  display_name: "Sam Sales",
  role: "sales",
  frappe_user_id: null,
  active: true,
};

test("an owner adds a teammate and sees them on the list, with themselves marked", async () => {
  const { env } = onboardingEnv();
  const owner = authFor("owner");
  const created = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/app-users", { method: "POST", body: TEAMMATE }),
    env,
    owner,
  );
  assert.equal(created.status, 200);

  const listed = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/app-users"),
    env,
    owner,
  );
  assert.equal(listed.status, 200);
  const body = await listed.json() as {
    users: Array<{ email: string; role: string; active: boolean; is_self: boolean }>;
  };
  const sam = body.users.find((user) => user.email === "sam.sales@freshco.example");
  assert.ok(sam, "the new teammate is on the list");
  assert.equal(sam.role, "sales");
  assert.equal(sam.active, true);
  assert.equal(sam.is_self, false);
});

test("deactivating a teammate keeps them listed so access can be restored", async () => {
  const { env } = onboardingEnv();
  const owner = authFor("owner");
  await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/app-users", { method: "POST", body: TEAMMATE }),
    env,
    owner,
  );
  await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/app-users", {
      method: "POST",
      body: { ...TEAMMATE, active: false },
    }),
    env,
    owner,
  );
  const listed = await handleAuthenticatedRoute(
    apiRequest("/api/v1/admin/app-users"),
    env,
    owner,
  );
  const body = await listed.json() as { users: Array<{ email: string; active: boolean }> };
  const sam = body.users.find((user) => user.email === "sam.sales@freshco.example");
  assert.equal(sam?.active, false);
});

test("the teammates list is closed to every non-office role", async () => {
  const { env } = onboardingEnv();
  for (const role of ["sales", "production", "accounting", "field"] as const) {
    const response = await handleAuthenticatedRoute(
      apiRequest("/api/v1/admin/app-users"),
      env,
      authFor(role),
    );
    assert.equal(response.status, 403, role);
  }
});

test("a fresh tenant takes its first lead from the app, not from a bearer-token curl", async () => {
  const { env, db, queued } = onboardingEnv();
  const response = await handleAuthenticatedRoute(
    apiRequest("/api/v1/sales/leads", {
      method: "POST",
      body: {
        name: "Grace Green",
        email: "grace@example.com",
        phone: "+1 403 555 0117",
        address: "10 Roofline Way",
        city: "Edmonton",
        province: "AB",
        service: "metal roofing",
        message: "Hail damage on the south slope.",
      },
    }),
    env,
    authFor("owner"),
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    lead: { envelope_id: string; status: string; duplicate: boolean; tenant_id: string };
  };
  assert.equal(body.lead.duplicate, false);
  assert.equal(body.lead.status, "pending_jn_push");
  assert.equal(body.lead.tenant_id, "freshco");
  assert.match(body.lead.envelope_id, /^ow_/);

  // Same envelope path as `POST /ingest/<source>`: one D1 row, and the queue message that makes
  // the native operating core (and therefore the sales desk) materialize.
  assert.equal(db.envelopes.length, 1);
  assert.equal(db.envelopes[0]!.source, "manual");
  assert.deepEqual(queued, [{ envelope_id: body.lead.envelope_id }]);
});

test("the same person entered twice returns the original lead instead of a second one", async () => {
  const { env, db } = onboardingEnv();
  const request = () =>
    handleAuthenticatedRoute(
      apiRequest("/api/v1/sales/leads", {
        method: "POST",
        body: { name: "Grace Green", email: "grace@example.com" },
      }),
      env,
      authFor("sales"),
    );
  const first = await request();
  const second = await request();
  const firstBody = await first.json() as { lead: { envelope_id: string } };
  const secondBody = await second.json() as { lead: { envelope_id: string; duplicate: boolean } };
  assert.equal(secondBody.lead.duplicate, true);
  assert.equal(secondBody.lead.envelope_id, firstBody.lead.envelope_id);
  assert.equal(db.envelopes.length, 1);
});

test("lead creation refuses a role without the right, a missing CSRF header, and an unworkable lead", async () => {
  const { env } = onboardingEnv();
  const denied = await handleAuthenticatedRoute(
    apiRequest("/api/v1/sales/leads", { method: "POST", body: { name: "Grace Green", email: "g@example.com" } }),
    env,
    authFor("field"),
  );
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "sales_lead_create_required" });

  const noCsrf = await handleAuthenticatedRoute(
    apiRequest("/api/v1/sales/leads", {
      method: "POST",
      body: { name: "Grace Green", email: "g@example.com" },
      csrf: null,
    }),
    env,
    authFor("sales"),
  );
  assert.equal(noCsrf.status, 403);
  assert.deepEqual(await noCsrf.json(), { error: "csrf_failed" });

  const noContact = await handleAuthenticatedRoute(
    apiRequest("/api/v1/sales/leads", { method: "POST", body: { name: "Grace Green" } }),
    env,
    authFor("sales"),
  );
  assert.equal(noContact.status, 400);
  assert.deepEqual(await noContact.json(), { error: "contact_required" });
});

test("office lead parsing keeps a custom service as typed and records who entered it", () => {
  const parsed = parseOfficeLead({
    name: "Grace Green",
    phone: "403-555-0117",
    service: "Cedar shake restoration",
  });
  assert.equal(parsed.ok, true);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.service, "Cedar shake restoration");
  assert.equal(parsed.value.email, null);

  const payload = officeLeadPayload(parsed.value, "sales@freshco.example");
  assert.equal(payload.service, "Cedar shake restoration");
  assert.equal(payload.entered_by, "sales@freshco.example");
  assert.equal(payload.entered_in, "office_app");
  assert.equal("email" in payload, false);
});

test("office lead parsing refuses an unknown field and an over-long value", () => {
  assert.deepEqual(parseOfficeLead({ name: "Grace", email: "g@example.com", owner_id: "x" }), {
    ok: false,
    error: "unexpected_field",
  });
  assert.deepEqual(parseOfficeLead({ name: "G", email: "g@example.com" }), {
    ok: false,
    error: "invalid_name",
  });
  assert.deepEqual(parseOfficeLead({ name: "Grace", email: "g".repeat(200) }), {
    ok: false,
    error: "invalid_email",
  });
});
