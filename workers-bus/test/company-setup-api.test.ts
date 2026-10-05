import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAppApi, handleAuthenticatedRoute } from "../src/app-api.ts";
import { handleCompanySetupRoute } from "../src/company-setup-api.ts";
import type { AppRole } from "../src/app-types.ts";
import {
  OTHER_TENANT,
  SqliteD1,
  USERS,
  VALID_PROFILE,
  auth,
  env,
  request,
} from "./company-setup-fixture.ts";

const PROFILE_PATH = "/api/v1/admin/company-profile";
const PROGRESS_PATH = "/api/v1/admin/setup-progress";
const NOTIFICATIONS_PATH = "/api/v1/notification-preferences";

function body(version = 0, overrides: Record<string, unknown> = {}) {
  return { ...VALID_PROFILE, expected_profile_version: version, ...overrides };
}

async function call(
  database: SqliteD1,
  role: AppRole,
  req: Request,
  options: { tenantId?: string } = {},
): Promise<Response> {
  const response = await handleCompanySetupRoute(
    req,
    env(database),
    auth(role, options.tenantId),
  );
  assert.ok(response, `expected ${req.method} ${new URL(req.url).pathname} to be routed here`);
  return response;
}

async function payload<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

test("a path this module does not own keeps routing", async () => {
  const database = new SqliteD1();
  const response = await handleCompanySetupRoute(
    request("GET", "/api/v1/now"),
    env(database),
    auth("owner"),
  );
  assert.equal(response, null);
});

test("an owner reads the deployment defaults with the actions they may take", async () => {
  const database = new SqliteD1();
  const response = await call(database, "owner", request("GET", PROFILE_PATH));
  const model = await payload<{
    version: number;
    allowed_actions: string[];
    profile: { profile_version: number; company_name: string; is_default: boolean };
    defaults: { company_name: string };
    missing_fields: string[];
    week_starts: string[];
    public_contact_preview: { phone: string | null; email: string | null } | null;
  }>(response);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(model.version, 1);
  assert.deepEqual(model.allowed_actions, [
    "company_profile.read", "setup_progress.read", "company_profile.update",
  ]);
  assert.equal(model.profile.profile_version, 0);
  assert.equal(model.profile.is_default, true);
  assert.equal(model.public_contact_preview, null);
  assert.equal(model.defaults.company_name, "IronWrap OS");
  assert.deepEqual(model.week_starts, ["sunday", "monday", "saturday"]);
  assert.ok(model.missing_fields.includes("phone"));
});

test("the production authenticated router reaches the canonical company profile contract", async () => {
  const response = await handleAuthenticatedRoute(
    request("GET", PROFILE_PATH),
    env(new SqliteD1()),
    auth("owner"),
  );
  const model = await payload<{
    profile: { profile_version?: number };
    defaults?: { company_name: string };
    week_starts?: string[];
  }>(response);

  assert.equal(response.status, 200);
  assert.equal(model.profile.profile_version, 0);
  assert.equal(model.defaults?.company_name, "IronWrap OS");
  assert.deepEqual(model.week_starts, ["sunday", "monday", "saturday"]);
});

test("a role without company authority cannot read or write the profile", async () => {
  const database = new SqliteD1({ seedUsers: ["owner", "sales"] });
  const read = await call(database, "sales", request("GET", PROFILE_PATH));
  assert.equal(read.status, 403);
  assert.deepEqual(await payload(read), { error: "company_profile_read_role_required" });

  const write = await call(
    database, "sales", request("PUT", PROFILE_PATH, { payload: body() }),
  );
  assert.equal(write.status, 403);
  assert.deepEqual(await payload(write), { error: "company_profile_read_role_required" });
});

test("a session for another tenant is refused before any row is read", async () => {
  const database = new SqliteD1();
  for (const path of [PROFILE_PATH, PROGRESS_PATH, NOTIFICATIONS_PATH]) {
    const response = await call(
      database, "owner", request("GET", path), { tenantId: OTHER_TENANT },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await payload(response), { error: "invalid_tenant" });
  }
});

test("a write with no CSRF token and a write with no idempotency key are both refused", async () => {
  const database = new SqliteD1();
  const noCsrf = await call(
    database, "owner", request("PUT", PROFILE_PATH, { payload: body(), csrf: false }),
  );
  assert.equal(noCsrf.status, 403);
  assert.deepEqual(await payload(noCsrf), { error: "csrf_failed" });

  const noKey = await call(
    database, "owner",
    request("PUT", PROFILE_PATH, { payload: body(), idempotencyKey: null }),
  );
  assert.equal(noKey.status, 400);
  assert.deepEqual(await payload(noKey), { error: "idempotency_key_required" });

  const shortKey = await call(
    database, "owner",
    request("PUT", PROFILE_PATH, { payload: body(), idempotencyKey: "short" }),
  );
  assert.equal(shortKey.status, 400);
  assert.deepEqual(await payload(shortKey), { error: "idempotency_key_required" });
});

test("the profile body is validated key by key", async () => {
  const database = new SqliteD1();
  const cases: Array<[Record<string, unknown> | unknown, string]> = [
    [body(0, { nickname: "boss" }), "unexpected_field"],
    [(() => { const value = body() as Record<string, unknown>; delete value.city; return value; })(), "missing_city"],
    [body(0, { company_name: "   " }), "invalid_company_name"],
    [body(0, { brand_name: "b".repeat(81) }), "invalid_brand_name"],
    [body(0, { phone: "555" }), "invalid_phone"],
    [body(0, { phone: "call me maybe" }), "invalid_phone"],
    [body(0, { time_zone: "Mars/Olympus Mons" }), "invalid_time_zone"],
    [body(0, { time_zone: "Edmonton" }), "invalid_time_zone"],
    [body(0, { currency: "dollars" }), "invalid_currency"],
    [body(0, { week_start: "wednesday" }), "invalid_week_start"],
    [body(0, { logo_ref: "https://evil.example.invalid/logo.png" }), "unexpected_field"],
    [body(0, { expected_profile_version: -1 }), "invalid_expected_profile_version"],
    [body(0, { expected_profile_version: "1" }), "invalid_expected_profile_version"],
    ["not an object", "invalid_body"],
  ];

  for (const [payloadValue, expected] of cases) {
    const response = await call(
      database, "owner", request("PUT", PROFILE_PATH, { payload: payloadValue }),
    );
    assert.equal(response.status, 400, `${expected} should be a 400`);
    assert.deepEqual(await payload(response), { error: expected });
  }
  // Nothing was written by any of them.
  const read = await call(database, "owner", request("GET", PROFILE_PATH));
  const model = await payload<{ profile: { profile_version: number } }>(read);
  assert.equal(model.profile.profile_version, 0);
});

test("malformed JSON and an oversized body are refused before parsing", async () => {
  const database = new SqliteD1();
  const broken = new Request(`https://app.example.invalid${PROFILE_PATH}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "csrf",
      "idempotency-key": "setup-key-00000000001",
    },
    body: "{not json",
  });
  const response = await call(database, "owner", broken);
  assert.equal(response.status, 400);
  assert.deepEqual(await payload(response), { error: "invalid_json" });

  const oversized = await call(
    database, "owner",
    request("PUT", PROFILE_PATH, { payload: body(0, { city: "x".repeat(9000) }) }),
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(await payload(oversized), { error: "payload_too_large" });
});

test("a valid save is readable, replayable, and refuses a stale version", async () => {
  const database = new SqliteD1();
  const saved = await call(
    database, "owner", request("PUT", PROFILE_PATH, { payload: body() }),
  );
  const savedModel = await payload<{
    outcome: string;
    profile: { profile_version: number; city: string; logo_ref: string | null };
    missing_fields: string[];
    public_contact_preview: { phone: string | null; email: string | null } | null;
  }>(saved);
  assert.equal(saved.status, 200);
  assert.equal(savedModel.outcome, "updated");
  assert.equal(savedModel.profile.profile_version, 1);
  assert.equal(savedModel.profile.logo_ref, null);
  assert.deepEqual(savedModel.public_contact_preview, {
    phone: "+15875550100", email: "hello@freshco.example",
  });
  assert.deepEqual(savedModel.missing_fields, []);

  const read = await call(database, "owner", request("GET", PROFILE_PATH));
  const readModel = await payload<{ profile: { city: string; profile_version: number };
    public_contact_preview: { phone: string | null; email: string | null } | null }>(read);
  assert.equal(readModel.profile.city, "Edmonton");
  assert.equal(readModel.profile.profile_version, 1);
  assert.deepEqual(readModel.public_contact_preview, savedModel.public_contact_preview);

  const replay = await call(
    database, "owner", request("PUT", PROFILE_PATH, { payload: body() }),
  );
  const replayModel = await payload<{ outcome: string; profile: { profile_version: number } }>(replay);
  assert.equal(replay.status, 200);
  assert.equal(replayModel.outcome, "replayed");
  assert.equal(replayModel.profile.profile_version, 1);

  const stale = await call(
    database, "owner",
    request("PUT", PROFILE_PATH, {
      payload: body(0, { city: "Calgary" }),
      idempotencyKey: "setup-key-00000000002",
    }),
  );
  assert.equal(stale.status, 409);
  assert.deepEqual(await payload(stale), { error: "company_profile_version_conflict" });

  const changedReplay = await call(
    database, "owner", request("PUT", PROFILE_PATH, { payload: body(1, { city: "Calgary" }) }),
  );
  assert.equal(changedReplay.status, 409);
  assert.deepEqual(
    await payload(changedReplay), { error: "company_profile_idempotency_conflict" },
  );
});

test("owner preview withholds a local phone without a known dialling country", async () => {
  const database = new SqliteD1();
  const saved = await call(database, "owner", request("PUT", PROFILE_PATH, {
    payload: body(0, { phone: "403 555 0100", country: "Bulgaria" }),
  }));
  assert.equal(saved.status, 200);
  const model = await payload<{ public_contact_preview: { phone: string | null; email: string | null } | null }>(saved);
  assert.deepEqual(model.public_contact_preview, { phone: null, email: "hello@freshco.example" });
});

test("an owner may save identity now and the address later", async () => {
  const database = new SqliteD1();
  const partial = await call(
    database, "owner",
    request("PUT", PROFILE_PATH, {
      payload: body(0, { phone: "", address_line1: "", city: "", region: "", postal_code: "" }),
    }),
  );
  const model = await payload<{ missing_fields: string[] }>(partial);
  assert.equal(partial.status, 200);
  assert.deepEqual(
    model.missing_fields, ["phone", "address_line1", "city", "region", "postal_code"],
  );
});

test("an unsupported method on an owned path is a 405, not a silent fallthrough", async () => {
  const database = new SqliteD1();
  for (const [method, path] of [
    ["POST", PROFILE_PATH],
    ["DELETE", PROFILE_PATH],
    ["PUT", PROGRESS_PATH],
    ["POST", NOTIFICATIONS_PATH],
  ] as const) {
    const response = await call(database, "owner", request(method, path));
    assert.equal(response.status, 405);
    assert.deepEqual(await payload(response), { error: "method_not_allowed" });
  }
});

test("setup progress answers what is done and what is left", async () => {
  const database = new SqliteD1({ seedUsers: ["owner", "field"] });
  await call(database, "owner", request("PUT", PROFILE_PATH, { payload: body() }));

  const response = await call(database, "owner", request("GET", PROGRESS_PATH));
  const model = await payload<{
    progress: {
      done: number;
      total: number;
      percent_complete: number;
      steps: Array<{ id: string; status: string; detail: string; requirements: unknown[] }>;
    };
  }>(response);

  assert.equal(response.status, 200);
  assert.equal(model.progress.total, 5);
  assert.deepEqual(
    model.progress.steps.map((step) => step.id),
    ["company", "people", "crew_phones", "money_and_intake", "notifications"],
  );
  const company = model.progress.steps.find((step) => step.id === "company");
  assert.equal(company?.status, "done");
  // A field account exists but nothing is paired to it yet.
  assert.equal(
    model.progress.steps.find((step) => step.id === "crew_phones")?.status,
    "in_progress",
  );
  assert.equal(model.progress.done, 2);
  assert.equal(model.progress.percent_complete, 40);
});

test("setup progress is readable by ops and refused to a crew account", async () => {
  const database = new SqliteD1({ seedUsers: ["owner", "ops", "field"] });
  const ops = await call(database, "ops", request("GET", PROGRESS_PATH));
  assert.equal(ops.status, 200);

  const crew = await call(database, "field", request("GET", PROGRESS_PATH));
  assert.equal(crew.status, 403);
  assert.deepEqual(await payload(crew), { error: "company_profile_read_role_required" });
});

test("every authenticated person owns their notification preferences", async () => {
  const database = new SqliteD1({ seedUsers: ["owner", "field"] });
  const read = await call(database, "field", request("GET", NOTIFICATIONS_PATH));
  const readModel = await payload<{
    allowed_actions: string[];
    user_id: string;
    preferences: { is_default: boolean; work_stops: boolean };
  }>(read);
  assert.equal(read.status, 200);
  assert.equal(readModel.user_id, USERS.field);
  assert.deepEqual(readModel.allowed_actions, [
    "notification_preferences.read", "notification_preferences.update",
  ]);
  assert.equal(readModel.preferences.is_default, true);
  assert.equal(readModel.preferences.work_stops, false);

  const saved = await call(
    database, "field",
    request("PUT", NOTIFICATIONS_PATH, {
      payload: {
        work_stops: true,
        approvals_waiting: false,
        daily_summary: true,
        daily_summary_send_time: "06:45",
      },
    }),
  );
  const savedModel = await payload<{
    outcome: string;
    preferences: { work_stops: boolean; daily_summary_send_time: string };
    delivery: { enabled: boolean; reason: string };
  }>(saved);
  assert.equal(saved.status, 200);
  assert.equal(savedModel.outcome, "updated");
  assert.equal(savedModel.preferences.daily_summary_send_time, "06:45");
  // Saving a preference is never a claim that anything will be delivered.
  assert.deepEqual(savedModel.delivery, {
    enabled: false, reason: "notification_delivery_not_implemented",
  });

  // The owner's own record is untouched.
  const owner = await call(database, "owner", request("GET", NOTIFICATIONS_PATH));
  const ownerModel = await payload<{ preferences: { is_default: boolean } }>(owner);
  assert.equal(ownerModel.preferences.is_default, true);
});

test("a half-scheduled daily summary is refused in both directions", async () => {
  const database = new SqliteD1();
  const cases: Array<[Record<string, unknown> | unknown, string]> = [
    [{
      work_stops: true, approvals_waiting: true,
      daily_summary: true, daily_summary_send_time: null,
    }, "invalid_daily_summary_send_time"],
    [{
      work_stops: true, approvals_waiting: true,
      daily_summary: true, daily_summary_send_time: "25:00",
    }, "invalid_daily_summary_send_time"],
    [{
      work_stops: true, approvals_waiting: true,
      daily_summary: false, daily_summary_send_time: "07:30",
    }, "daily_summary_send_time_not_allowed"],
    [{
      work_stops: "yes", approvals_waiting: true,
      daily_summary: false, daily_summary_send_time: null,
    }, "invalid_work_stops"],
    [{
      work_stops: true, approvals_waiting: true, daily_summary: false,
      daily_summary_send_time: null, sms: true,
    }, "unexpected_field"],
    [{ work_stops: true, approvals_waiting: true, daily_summary: false },
      "missing_daily_summary_send_time"],
  ];

  for (const [payloadValue, expected] of cases) {
    const response = await call(
      database, "owner", request("PUT", NOTIFICATIONS_PATH, { payload: payloadValue }),
    );
    assert.equal(response.status, 400, `${expected} should be a 400`);
    assert.deepEqual(await payload(response), { error: expected });
  }
});

test("a replayed preference save returns the first outcome; a changed one conflicts", async () => {
  const database = new SqliteD1();
  const fields = {
    work_stops: true,
    approvals_waiting: false,
    daily_summary: false,
    daily_summary_send_time: null,
  };
  await call(database, "owner", request("PUT", NOTIFICATIONS_PATH, { payload: fields }));
  const replay = await call(
    database, "owner", request("PUT", NOTIFICATIONS_PATH, { payload: fields }),
  );
  assert.equal((await payload<{ outcome: string }>(replay)).outcome, "replayed");

  const changed = await call(
    database, "owner",
    request("PUT", NOTIFICATIONS_PATH, { payload: { ...fields, approvals_waiting: true } }),
  );
  assert.equal(changed.status, 409);
  assert.deepEqual(
    await payload(changed), { error: "notification_preferences_idempotency_conflict" },
  );
});

test("a PUT with no Origin header is refused as a mutation, not waved through as a read", async () => {
  // The router treated only POST as a mutation. A PUT arriving without an `Origin`
  // header would have skipped origin validation entirely; this is that regression.
  const appEnv = env(new SqliteD1(), {
    APP_PUBLIC_ORIGIN: "https://app.example.invalid",
    APP_ALLOWED_ORIGINS: "https://app.example.invalid",
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_AUTH_PEPPER: "p".repeat(48),
  });

  const noOrigin = await handleAppApi(
    request("PUT", PROFILE_PATH, { payload: body() }),
    appEnv as never,
    {} as never,
  );
  assert.equal(noOrigin.status, 403);
  assert.deepEqual(await payload(noOrigin), { error: "origin_not_allowed" });

  const foreignOrigin = new Request(`https://app.example.invalid${PROFILE_PATH}`, {
    method: "PUT",
    headers: { origin: "https://attacker.example.invalid", "content-type": "application/json" },
    body: JSON.stringify(body()),
  });
  const rejected = await handleAppApi(foreignOrigin, appEnv as never, {} as never);
  assert.equal(rejected.status, 403);
  assert.deepEqual(await payload(rejected), { error: "origin_not_allowed" });

  // The same request from the configured origin gets past origin validation and is
  // then refused for the real reason: it carries no session.
  const allowed = new Request(`https://app.example.invalid${PROFILE_PATH}`, {
    method: "PUT",
    headers: { origin: "https://app.example.invalid", "content-type": "application/json" },
    body: JSON.stringify(body()),
  });
  const unauthorized = await handleAppApi(allowed, appEnv as never, {} as never);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await payload(unauthorized), { error: "unauthorized" });
});
