import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSetupProgress,
  companyProfileDefaults,
  getCompanyProfile,
  getNotificationPreferences,
  missingCompanyFields,
  updateCompanyProfile,
  updateNotificationPreferences,
  CompanySetupError,
  type CompanyProfileFields,
  type SetupStepId,
  type SetupStepStatus,
} from "../src/company-setup-store.ts";
import {
  NOW,
  SqliteD1,
  TENANT,
  USERS,
  VALID_PROFILE,
  env,
} from "./company-setup-fixture.ts";
import { findSavedCompanyPhone } from "../src/app-auth-store.ts";

const FIELDS: CompanyProfileFields = { ...VALID_PROFILE };

function key(suffix: string): string {
  return `company-profile-key-${suffix}`.padEnd(20, "0");
}

async function saveProfile(
  database: SqliteD1,
  overrides: Partial<CompanyProfileFields> = {},
  options: { expected?: number; idempotencyKey?: string } = {},
) {
  return await updateCompanyProfile(env(database), {
    tenantId: TENANT,
    fields: { ...FIELDS, ...overrides },
    expectedProfileVersion: options.expected ?? 0,
    idempotencyKey: options.idempotencyKey ?? key("001"),
    actorUserId: USERS.owner,
    actorRole: "owner",
    now: NOW,
  });
}

function statusOf(steps: Array<{ id: SetupStepId; status: SetupStepStatus }>, id: SetupStepId) {
  return steps.find((step) => step.id === id)?.status;
}

test("an unsaved tenant reads the deployment defaults, not an invented profile", async () => {
  const database = new SqliteD1();
  const profile = await getCompanyProfile(env(database), TENANT);

  assert.equal(profile.profile_version, 0);
  assert.equal(profile.is_default, true);
  assert.equal(profile.company_name, "IronWrap OS");
  assert.equal(profile.time_zone, "America/Edmonton");
  assert.equal(profile.currency, "CAD");
  // The three details no deployment can supply come back empty rather than guessed.
  assert.equal(profile.phone, "");
  assert.equal(profile.address_line1, "");
  assert.equal(profile.postal_code, "");
  assert.deepEqual(
    missingCompanyFields(profile),
    ["phone", "address_line1", "city", "region", "postal_code"],
  );
  assert.deepEqual(companyProfileDefaults(env(database), TENANT), profile);
});

test("the first save records version 1 with an append-only revision", async () => {
  const database = new SqliteD1();
  const result = await saveProfile(database);

  assert.equal(result.outcome, "updated");
  assert.equal(result.profile.profile_version, 1);
  assert.equal(result.profile.is_default, false);
  assert.equal(result.profile.company_name, "FreshCo Exteriors Ltd.");
  assert.equal(result.profile.week_start, "monday");
  assert.equal(result.profile.updated_by_user_id, USERS.owner);
  assert.deepEqual(missingCompanyFields(result.profile), []);

  const revision = database.raw.prepare(
    "SELECT * FROM tenant_company_profile_revisions WHERE tenant_id = ?",
  ).get(TENANT) as Record<string, unknown>;
  assert.equal(revision.profile_version, 1);
  assert.equal(revision.from_profile_version, null);
  assert.equal(revision.actor_role, "owner");
  assert.equal(JSON.parse(String(revision.accepted_json)).city, "Edmonton");
});

test("a second save supersedes the row and keeps both revisions", async () => {
  const database = new SqliteD1();
  await saveProfile(database);
  const second = await saveProfile(
    database,
    { city: "Calgary", week_start: "sunday" },
    { expected: 1, idempotencyKey: key("002") },
  );

  assert.equal(second.profile.profile_version, 2);
  assert.equal(second.profile.city, "Calgary");
  assert.equal(second.profile.week_start, "sunday");

  const versions = (database.raw.prepare(
    "SELECT profile_version, from_profile_version FROM tenant_company_profile_revisions ORDER BY profile_version",
  ).all() as Array<{ profile_version: number; from_profile_version: number | null }>)
    .map((row) => [row.profile_version, row.from_profile_version]);
  assert.deepEqual(versions, [[1, null], [2, 1]]);
});

test("a replayed save returns the first outcome and writes no second revision", async () => {
  const database = new SqliteD1();
  await saveProfile(database);
  const replay = await saveProfile(database);

  assert.equal(replay.outcome, "replayed");
  assert.equal(replay.profile.profile_version, 1);
  const count = database.raw.prepare(
    "SELECT COUNT(*) AS n FROM tenant_company_profile_revisions",
  ).get() as { n: number };
  assert.equal(count.n, 1);
});

test("the same idempotency key with a different body is a conflict, not a replay", async () => {
  const database = new SqliteD1();
  await saveProfile(database);

  await assert.rejects(
    () => saveProfile(database, { city: "Red Deer" }, { expected: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof CompanySetupError);
      assert.equal(error.code, "company_profile_idempotency_conflict");
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test("a stale expected version is refused rather than overwriting the other editor", async () => {
  const database = new SqliteD1();
  await saveProfile(database);

  await assert.rejects(
    () => saveProfile(database, { city: "Leduc" }, { expected: 0, idempotencyKey: key("003") }),
    (error: unknown) => {
      assert.ok(error instanceof CompanySetupError);
      assert.equal(error.code, "company_profile_version_conflict");
      return true;
    },
  );
  const stored = await getCompanyProfile(env(database), TENANT);
  assert.equal(stored.city, "Edmonton");
  assert.equal(stored.profile_version, 1);
});

test("a role without company authority cannot write even with a valid body", async () => {
  const database = new SqliteD1({ seedUsers: ["owner", "sales"] });
  await assert.rejects(
    () => updateCompanyProfile(env(database), {
      tenantId: TENANT,
      fields: FIELDS,
      expectedProfileVersion: 0,
      idempotencyKey: key("004"),
      actorUserId: USERS.sales,
      actorRole: "sales",
      now: NOW,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CompanySetupError);
      assert.equal(error.code, "company_profile_write_role_required");
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test("a profile is scoped to its tenant and never leaks across one", async () => {
  const database = new SqliteD1();
  await saveProfile(database);

  const other = await getCompanyProfile(env(database), "other-tenant");
  assert.equal(other.profile_version, 0);
  assert.equal(other.is_default, true);
});

test("the session's office-line read sees the saved phone of its own tenant only", async () => {
  const database = new SqliteD1();
  // Nothing saved yet: the deployment defaults carry no phone, so there is none to hand out.
  assert.equal(await findSavedCompanyPhone(env(database), TENANT), null);

  await saveProfile(database, { phone: "780-555-0142" });
  assert.equal(await findSavedCompanyPhone(env(database), TENANT), "780-555-0142");
  assert.equal(await findSavedCompanyPhone(env(database), "other-tenant"), null);

  // A saved profile may leave the phone blank; the session then turns "" into null.
  await saveProfile(database, { phone: "" }, { expected: 1, idempotencyKey: key("002") });
  assert.equal(await findSavedCompanyPhone(env(database), TENANT), "");
});

test("the migration refuses a stored profile that the API would never accept", async () => {
  const database = new SqliteD1();
  await saveProfile(database);
  // Defence in depth: the CHECK constraints are the last line if a future caller
  // reaches the table without going through the parser.
  assert.throws(() => database.raw.exec(
    "UPDATE tenant_company_profiles SET week_start = 'wednesday'",
  ));
  assert.throws(() => database.raw.exec(
    "UPDATE tenant_company_profiles SET currency = 'cad'",
  ));
  assert.throws(() => database.raw.exec(
    "UPDATE tenant_company_profiles SET logo_ref = 'https://evil.example.invalid/logo.png'",
  ));
  assert.throws(() => database.raw.exec(
    "UPDATE tenant_company_profiles SET logo_ref = '//evil.example.invalid/logo.png'",
  ));
});

test("notification preferences default to off and are stored per person", async () => {
  const database = new SqliteD1({ seedUsers: ["owner", "field"] });
  const before = await getNotificationPreferences(env(database), TENANT, USERS.owner);
  assert.equal(before.is_default, true);
  assert.equal(before.work_stops, false);
  assert.equal(before.daily_summary_send_time, null);

  const saved = await updateNotificationPreferences(env(database), {
    tenantId: TENANT,
    userId: USERS.owner,
    fields: {
      work_stops: true,
      approvals_waiting: false,
      daily_summary: true,
      daily_summary_send_time: "07:30",
    },
    idempotencyKey: key("101"),
    now: NOW,
  });
  assert.equal(saved.outcome, "updated");
  assert.equal(saved.preferences.work_stops, true);
  assert.equal(saved.preferences.daily_summary_send_time, "07:30");
  assert.equal(saved.preferences.is_default, false);

  // The crew member's own record is untouched by the owner's choice.
  const crew = await getNotificationPreferences(env(database), TENANT, USERS.field);
  assert.equal(crew.is_default, true);
});

test("a replayed preference save is idempotent and a changed body conflicts", async () => {
  const database = new SqliteD1();
  const fields = {
    work_stops: true,
    approvals_waiting: true,
    daily_summary: false,
    daily_summary_send_time: null,
  };
  await updateNotificationPreferences(env(database), {
    tenantId: TENANT, userId: USERS.owner, fields, idempotencyKey: key("102"), now: NOW,
  });
  const replay = await updateNotificationPreferences(env(database), {
    tenantId: TENANT, userId: USERS.owner, fields, idempotencyKey: key("102"), now: NOW,
  });
  assert.equal(replay.outcome, "replayed");

  await assert.rejects(
    () => updateNotificationPreferences(env(database), {
      tenantId: TENANT,
      userId: USERS.owner,
      fields: { ...fields, approvals_waiting: false },
      idempotencyKey: key("102"),
      now: NOW,
    }),
    (error: unknown) => {
      assert.ok(error instanceof CompanySetupError);
      assert.equal(error.code, "notification_preferences_idempotency_conflict");
      return true;
    },
  );
});

test("the migration refuses a daily summary with no send time and a send time with no summary", async () => {
  const database = new SqliteD1();
  const insert = (dailySummary: number, sendTime: string | null) => () => database.raw.prepare(
    `INSERT INTO app_user_notification_preferences
       (tenant_id, user_id, work_stops, approvals_waiting, daily_summary,
        daily_summary_send_time, idempotency_key, request_fingerprint_sha256,
        created_at, updated_at)
     VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(TENANT, USERS.owner, dailySummary, sendTime, key("103"), "a".repeat(64), NOW, NOW);

  assert.throws(insert(1, null));
  assert.throws(insert(0, "07:30"));
  assert.throws(insert(1, "24:00"));
});

test("setup progress starts as real work waiting, never as done", async () => {
  const database = new SqliteD1();
  const progress = await buildSetupProgress(env(database), {
    tenantId: TENANT,
    userId: USERS.owner,
    now: NOW,
    quickBooksAvailable: true,
    publicIntakeAvailable: false,
  });

  assert.equal(progress.total, 5);
  assert.equal(progress.done, 0);
  assert.equal(progress.percent_complete, 0);
  assert.equal(statusOf(progress.steps, "company"), "later");
  // One active office account exists (the owner), so people has started.
  assert.equal(statusOf(progress.steps, "people"), "in_progress");
  assert.equal(statusOf(progress.steps, "crew_phones"), "later");
  assert.equal(statusOf(progress.steps, "money_and_intake"), "later");
  assert.equal(statusOf(progress.steps, "notifications"), "later");
});

test("setup progress reports a half-answered company as in progress", async () => {
  const database = new SqliteD1();
  // Identity now, address later: exactly the partial save the optional columns allow.
  await saveProfile(database, { city: "", region: "", postal_code: "" });

  const progress = await buildSetupProgress(env(database), {
    tenantId: TENANT,
    userId: USERS.owner,
    now: NOW,
    quickBooksAvailable: true,
    publicIntakeAvailable: true,
  });
  const company = progress.steps.find((step) => step.id === "company");
  assert.equal(company?.status, "in_progress");
  assert.match(company?.detail ?? "", /Still missing: city, region, postal_code\./);
});

test("setup progress is derived from real rows only", async () => {
  const database = new SqliteD1({ seedUsers: ["owner", "ops", "field"] });
  await saveProfile(database);
  database.addDevice(USERS.field, "device_crew_0001");
  database.addLead("ow_lead_000001");
  database.addQuickBooksConnection("connected");
  await updateNotificationPreferences(env(database), {
    tenantId: TENANT,
    userId: USERS.owner,
    fields: {
      work_stops: true,
      approvals_waiting: true,
      daily_summary: false,
      daily_summary_send_time: null,
    },
    idempotencyKey: key("104"),
    now: NOW,
  });

  const progress = await buildSetupProgress(env(database), {
    tenantId: TENANT,
    userId: USERS.owner,
    now: NOW,
    quickBooksAvailable: true,
    publicIntakeAvailable: true,
  });
  assert.deepEqual(
    progress.steps.map((step) => [step.id, step.status]),
    [
      ["company", "done"],
      ["people", "done"],
      ["crew_phones", "done"],
      ["money_and_intake", "done"],
      ["notifications", "done"],
    ],
  );
  assert.equal(progress.done, 5);
  assert.equal(progress.percent_complete, 100);
});

test("a revoked device and an unreconciled QuickBooks connection do not count as done", async () => {
  const database = new SqliteD1({ seedUsers: ["owner", "field"] });
  database.addDevice(USERS.field, "device_crew_0002", NOW);
  database.addQuickBooksConnection("reconciliation_required");

  const progress = await buildSetupProgress(env(database), {
    tenantId: TENANT,
    userId: USERS.owner,
    now: NOW,
    quickBooksAvailable: true,
    publicIntakeAvailable: true,
  });
  assert.equal(statusOf(progress.steps, "crew_phones"), "in_progress");
  assert.equal(statusOf(progress.steps, "money_and_intake"), "in_progress");
});

test("a step whose every capability is switched off reads skipped, not failed", async () => {
  const database = new SqliteD1();
  const progress = await buildSetupProgress(env(database), {
    tenantId: TENANT,
    userId: USERS.owner,
    now: NOW,
    quickBooksAvailable: false,
    publicIntakeAvailable: false,
  });
  const money = progress.steps.find((step) => step.id === "money_and_intake");
  // QuickBooks is off, so that requirement does not apply; no lead has arrived and
  // the public form is off, so the intake half is still real work.
  assert.equal(money?.status, "later");
  assert.equal(
    money?.requirements.find((requirement) => requirement.id === "quickbooks_connected")?.applicable,
    false,
  );

  database.addLead("ow_lead_000002");
  const after = await buildSetupProgress(env(database), {
    tenantId: TENANT,
    userId: USERS.owner,
    now: NOW,
    quickBooksAvailable: false,
    publicIntakeAvailable: false,
  });
  // Everything this deployment can do on that step is now done.
  assert.equal(statusOf(after.steps, "money_and_intake"), "done");
});

test("a deactivated teammate stops counting toward the people step", async () => {
  const database = new SqliteD1({ seedUsers: ["owner", "sales"] });
  const before = await buildSetupProgress(env(database), {
    tenantId: TENANT, userId: USERS.owner, now: NOW,
    quickBooksAvailable: true, publicIntakeAvailable: true,
  });
  assert.equal(statusOf(before.steps, "people"), "done");

  database.deactivateUser(USERS.sales);
  const after = await buildSetupProgress(env(database), {
    tenantId: TENANT, userId: USERS.owner, now: NOW,
    quickBooksAvailable: true, publicIntakeAvailable: true,
  });
  assert.equal(statusOf(after.steps, "people"), "in_progress");
});
