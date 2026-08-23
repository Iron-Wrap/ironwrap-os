/**
 * The owned company-setup aggregates: the tenant company profile, the per-person
 * notification preferences, and the setup-progress read model derived from both plus
 * the real state of the rest of the tenant.
 *
 * Everything an owner can say about their own company arrives here as untrusted input
 * and leaves as a versioned D1 row with an append-only revision beside it. The browser
 * supplies values; it never supplies authority, a version, a timestamp, or an actor.
 *
 * The setup progress model is a projector. It reads app_users, app_devices,
 * quickbooks_connections, operating_leads and the two tables migration 0110 adds, and
 * it reports only what those rows and the deployment's own capability flags say. It has
 * no state of its own, so it can never disagree with the facts it is derived from, and
 * it never reports a step as done because someone dismissed it.
 */
import { sha256Hex } from "./app-auth.ts";
import type { AppEnv, AppRole } from "./app-types.ts";

export const COMPANY_PROFILE_WEEK_STARTS = ["sunday", "monday", "saturday"] as const;
export type CompanyProfileWeekStart = (typeof COMPANY_PROFILE_WEEK_STARTS)[number];

/** Every step the Settings hub shows, in the order an owner works through them. */
export const SETUP_STEP_IDS = [
  "company",
  "people",
  "crew_phones",
  "money_and_intake",
  "notifications",
] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/**
 * The four statuses the canvas draws, derived the same way for every step:
 *
 * - `done`        every applicable requirement is met, and at least one applies here;
 * - `in_progress` some applicable requirement is met and some is not;
 * - `skipped`     no requirement applies to this deployment, so there is nothing to do;
 * - `later`       nothing is met yet and real work is still waiting.
 *
 * A requirement stops applying only because this deployment switched its capability
 * off, never because a person dismissed the row. There is no fifth "not started"
 * status: an untouched step with work waiting is `later`.
 */
export const SETUP_STEP_STATUSES = ["done", "in_progress", "skipped", "later"] as const;
export type SetupStepStatus = (typeof SETUP_STEP_STATUSES)[number];

export interface CompanyProfileFields {
  company_name: string;
  brand_name: string;
  phone: string;
  address_line1: string;
  city: string;
  region: string;
  postal_code: string;
  time_zone: string;
  currency: string;
  week_start: CompanyProfileWeekStart;
  logo_ref: string | null;
}

export interface CompanyProfile extends CompanyProfileFields {
  tenant_id: string;
  /** 0 until an owner has saved once; the value a writer must state to update. */
  profile_version: number;
  /** True while every field is still the deployment default rather than an owner's answer. */
  is_default: boolean;
  updated_at: string | null;
  updated_by_user_id: string | null;
}

export interface NotificationPreferences {
  work_stops: boolean;
  approvals_waiting: boolean;
  daily_summary: boolean;
  daily_summary_send_time: string | null;
  /** True while nothing has been saved and these are the defaults, not a choice. */
  is_default: boolean;
  updated_at: string | null;
}

export interface SetupStepRequirement {
  id: string;
  met: boolean;
  /** False when this deployment has the capability switched off. */
  applicable: boolean;
  detail: string;
}

export interface SetupStep {
  id: SetupStepId;
  title: string;
  status: SetupStepStatus;
  detail: string;
  requirements: SetupStepRequirement[];
}

export interface SetupProgress {
  generated_at: string;
  done: number;
  total: number;
  percent_complete: number;
  steps: SetupStep[];
}

export class CompanySetupError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
    this.name = "CompanySetupError";
  }
}

// ------------------------------------------------------------------------------ profile

interface CompanyProfileRow {
  tenant_id: string;
  profile_version: number;
  company_name: string;
  brand_name: string;
  phone: string;
  address_line1: string;
  city: string;
  region: string;
  postal_code: string;
  time_zone: string;
  currency: string;
  week_start: CompanyProfileWeekStart;
  logo_ref: string | null;
  updated_at: string;
  updated_by_user_id: string;
}

const PROFILE_COLUMNS =
  `tenant_id, profile_version, company_name, brand_name, phone, address_line1, city,
   region, postal_code, time_zone, currency, week_start, logo_ref, updated_at,
   updated_by_user_id`;

/**
 * What the tenant looks like before an owner has answered for themselves.
 *
 * The generated Worker vars are the deployment-time defaults. They are returned as a
 * profile so the setup screen always has something to show, and `is_default` says
 * plainly that nobody has confirmed them yet. The three fields with no deployment
 * default at all -- phone, address, postal code -- come back empty rather than guessed.
 */
export function companyProfileDefaults(env: AppEnv, tenantId: string): CompanyProfile {
  return {
    tenant_id: tenantId,
    profile_version: 0,
    is_default: true,
    company_name: (env.APP_TENANT_NAME ?? "").trim(),
    brand_name: (env.APP_TENANT_BRAND ?? "").trim(),
    phone: "",
    address_line1: "",
    city: "",
    region: "",
    postal_code: "",
    time_zone: (env.APP_TIME_ZONE ?? "").trim(),
    currency: (env.APP_CURRENCY ?? "").trim().toUpperCase(),
    week_start: "monday",
    logo_ref: null,
    updated_at: null,
    updated_by_user_id: null,
  };
}

function profileFromRow(row: CompanyProfileRow): CompanyProfile {
  return {
    tenant_id: row.tenant_id,
    profile_version: Number(row.profile_version),
    is_default: false,
    company_name: row.company_name,
    brand_name: row.brand_name,
    phone: row.phone,
    address_line1: row.address_line1,
    city: row.city,
    region: row.region,
    postal_code: row.postal_code,
    time_zone: row.time_zone,
    currency: row.currency,
    week_start: row.week_start,
    logo_ref: row.logo_ref,
    updated_at: row.updated_at,
    updated_by_user_id: row.updated_by_user_id,
  };
}

export async function getCompanyProfile(
  env: AppEnv,
  tenantId: string,
): Promise<CompanyProfile> {
  const row = await env.DB.prepare(
    `SELECT ${PROFILE_COLUMNS} FROM tenant_company_profiles WHERE tenant_id = ? LIMIT 1`,
  ).bind(tenantId).first<CompanyProfileRow>();
  return row ? profileFromRow(row) : companyProfileDefaults(env, tenantId);
}

export interface UpdateCompanyProfileInput {
  tenantId: string;
  fields: CompanyProfileFields;
  expectedProfileVersion: number;
  idempotencyKey: string;
  actorUserId: string;
  actorRole: AppRole;
  now: string;
}

export interface UpdateCompanyProfileResult {
  outcome: "updated" | "replayed";
  profile: CompanyProfile;
}

/**
 * Apply one owner-stated profile.
 *
 * Three refusals, all of them checked against current D1 state rather than against
 * anything the browser asserted:
 *
 * - a replay of the same idempotency key with the same body returns the first outcome;
 * - the same key with a different body is a conflict, so a retried request that quietly
 *   changed cannot be mistaken for the original;
 * - a stated version that is not the current one is a conflict, so two office users
 *   editing the same tenant cannot silently overwrite each other.
 */
export async function updateCompanyProfile(
  env: AppEnv,
  input: UpdateCompanyProfileInput,
): Promise<UpdateCompanyProfileResult> {
  if (input.actorRole !== "owner" && input.actorRole !== "ops") {
    throw new CompanySetupError("company_profile_write_role_required", 403);
  }
  const fingerprint = await companyProfileFingerprint(input.tenantId, input.fields);

  const replay = await env.DB.prepare(
    `SELECT profile_version, request_fingerprint_sha256
       FROM tenant_company_profile_revisions
      WHERE tenant_id = ? AND idempotency_key = ?
      LIMIT 1`,
  ).bind(input.tenantId, input.idempotencyKey)
    .first<{ profile_version: number; request_fingerprint_sha256: string }>();
  if (replay) {
    if (replay.request_fingerprint_sha256 !== fingerprint) {
      throw new CompanySetupError("company_profile_idempotency_conflict", 409);
    }
    return { outcome: "replayed", profile: await getCompanyProfile(env, input.tenantId) };
  }

  const current = await env.DB.prepare(
    "SELECT profile_version, created_at FROM tenant_company_profiles WHERE tenant_id = ? LIMIT 1",
  ).bind(input.tenantId).first<{ profile_version: number; created_at: string }>();
  const currentVersion = current ? Number(current.profile_version) : 0;
  if (input.expectedProfileVersion !== currentVersion) {
    throw new CompanySetupError("company_profile_version_conflict", 409);
  }

  const nextVersion = currentVersion + 1;
  const createdAt = current?.created_at ?? input.now;
  const revisionId = `tcpr_${input.tenantId}_${String(nextVersion).padStart(6, "0")}`;
  const statements = [
    env.DB.prepare(
      `INSERT INTO tenant_company_profiles
         (tenant_id, profile_version, company_name, brand_name, phone, address_line1,
          city, region, postal_code, time_zone, currency, week_start, logo_ref,
          created_at, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id) DO UPDATE SET
         profile_version = excluded.profile_version,
         company_name = excluded.company_name,
         brand_name = excluded.brand_name,
         phone = excluded.phone,
         address_line1 = excluded.address_line1,
         city = excluded.city,
         region = excluded.region,
         postal_code = excluded.postal_code,
         time_zone = excluded.time_zone,
         currency = excluded.currency,
         week_start = excluded.week_start,
         logo_ref = excluded.logo_ref,
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id
       WHERE tenant_company_profiles.profile_version = ?`,
    ).bind(
      input.tenantId, nextVersion, input.fields.company_name, input.fields.brand_name,
      input.fields.phone, input.fields.address_line1, input.fields.city,
      input.fields.region, input.fields.postal_code, input.fields.time_zone,
      input.fields.currency, input.fields.week_start, input.fields.logo_ref,
      createdAt, input.now, input.actorUserId, currentVersion,
    ),
    env.DB.prepare(
      `INSERT INTO tenant_company_profile_revisions
         (revision_id, tenant_id, profile_version, from_profile_version, idempotency_key,
          request_fingerprint_sha256, accepted_json, actor_user_id, actor_role, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      revisionId, input.tenantId, nextVersion, currentVersion === 0 ? null : currentVersion,
      input.idempotencyKey, fingerprint, JSON.stringify(input.fields),
      input.actorUserId, input.actorRole, input.now,
    ),
  ];
  // One batch, so a rejected revision can never leave a bumped profile behind.
  //
  // Two writers that both read version N race here. `UNIQUE (tenant_id,
  // profile_version)` on the revision ledger admits exactly one of them; the loser's
  // whole batch aborts, so it neither bumps the profile nor records a revision. The
  // guarded `WHERE ... profile_version = ?` on the upsert is the same fence stated on
  // the profile row itself, and the read-back below refuses anything that still got
  // past both.
  await env.DB.batch(statements);

  const stored = await getCompanyProfile(env, input.tenantId);
  if (stored.profile_version !== nextVersion) {
    throw new CompanySetupError("company_profile_version_conflict", 409);
  }
  return { outcome: "updated", profile: stored };
}

async function companyProfileFingerprint(
  tenantId: string,
  fields: CompanyProfileFields,
): Promise<string> {
  // Key order is fixed here rather than taken from the request, so two bodies that
  // differ only in key order produce the same fingerprint and replay cleanly.
  return await sha256Hex(JSON.stringify([
    tenantId, fields.company_name, fields.brand_name, fields.phone, fields.address_line1,
    fields.city, fields.region, fields.postal_code, fields.time_zone, fields.currency,
    fields.week_start, fields.logo_ref,
  ]));
}

/** The exact fields an owner must answer before the company step can read `done`. */
export const REQUIRED_COMPANY_FIELDS = [
  "company_name", "brand_name", "phone", "address_line1", "city", "region",
  "postal_code", "time_zone", "currency", "week_start",
] as const;

export function missingCompanyFields(profile: CompanyProfile): string[] {
  return REQUIRED_COMPANY_FIELDS.filter(
    (field) => String(profile[field] ?? "").trim().length === 0,
  );
}

// ------------------------------------------------------------ notification preferences

interface NotificationPreferencesRow {
  work_stops: number;
  approvals_waiting: number;
  daily_summary: number;
  daily_summary_send_time: string | null;
  request_fingerprint_sha256: string;
  idempotency_key: string;
  updated_at: string;
}

/** Off, with no send time. A person opts in; nothing is opted in on their behalf. */
export function notificationPreferenceDefaults(): NotificationPreferences {
  return {
    work_stops: false,
    approvals_waiting: false,
    daily_summary: false,
    daily_summary_send_time: null,
    is_default: true,
    updated_at: null,
  };
}

export async function getNotificationPreferences(
  env: AppEnv,
  tenantId: string,
  userId: string,
): Promise<NotificationPreferences> {
  const row = await env.DB.prepare(
    `SELECT work_stops, approvals_waiting, daily_summary, daily_summary_send_time,
            request_fingerprint_sha256, idempotency_key, updated_at
       FROM app_user_notification_preferences
      WHERE tenant_id = ? AND user_id = ?
      LIMIT 1`,
  ).bind(tenantId, userId).first<NotificationPreferencesRow>();
  if (!row) return notificationPreferenceDefaults();
  return {
    work_stops: Number(row.work_stops) === 1,
    approvals_waiting: Number(row.approvals_waiting) === 1,
    daily_summary: Number(row.daily_summary) === 1,
    daily_summary_send_time: row.daily_summary_send_time,
    is_default: false,
    updated_at: row.updated_at,
  };
}

export interface NotificationPreferenceFields {
  work_stops: boolean;
  approvals_waiting: boolean;
  daily_summary: boolean;
  daily_summary_send_time: string | null;
}

export interface UpdateNotificationPreferencesInput {
  tenantId: string;
  userId: string;
  fields: NotificationPreferenceFields;
  idempotencyKey: string;
  now: string;
}

export interface UpdateNotificationPreferencesResult {
  outcome: "updated" | "replayed";
  preferences: NotificationPreferences;
}

export async function updateNotificationPreferences(
  env: AppEnv,
  input: UpdateNotificationPreferencesInput,
): Promise<UpdateNotificationPreferencesResult> {
  const fingerprint = await sha256Hex(JSON.stringify([
    input.tenantId, input.userId, input.fields.work_stops, input.fields.approvals_waiting,
    input.fields.daily_summary, input.fields.daily_summary_send_time,
  ]));
  const existing = await env.DB.prepare(
    `SELECT work_stops, approvals_waiting, daily_summary, daily_summary_send_time,
            request_fingerprint_sha256, idempotency_key, updated_at
       FROM app_user_notification_preferences
      WHERE tenant_id = ? AND user_id = ?
      LIMIT 1`,
  ).bind(input.tenantId, input.userId).first<NotificationPreferencesRow>();

  if (existing && existing.idempotency_key === input.idempotencyKey) {
    if (existing.request_fingerprint_sha256 !== fingerprint) {
      throw new CompanySetupError("notification_preferences_idempotency_conflict", 409);
    }
    return {
      outcome: "replayed",
      preferences: await getNotificationPreferences(env, input.tenantId, input.userId),
    };
  }

  // The FK to app_users is what refuses a session whose user row is gone; it surfaces
  // as a store failure rather than a silent orphan preference.
  await env.DB.prepare(
    `INSERT INTO app_user_notification_preferences
       (tenant_id, user_id, work_stops, approvals_waiting, daily_summary,
        daily_summary_send_time, idempotency_key, request_fingerprint_sha256,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET
       work_stops = excluded.work_stops,
       approvals_waiting = excluded.approvals_waiting,
       daily_summary = excluded.daily_summary,
       daily_summary_send_time = excluded.daily_summary_send_time,
       idempotency_key = excluded.idempotency_key,
       request_fingerprint_sha256 = excluded.request_fingerprint_sha256,
       updated_at = excluded.updated_at`,
  ).bind(
    input.tenantId, input.userId,
    input.fields.work_stops ? 1 : 0,
    input.fields.approvals_waiting ? 1 : 0,
    input.fields.daily_summary ? 1 : 0,
    input.fields.daily_summary_send_time,
    input.idempotencyKey, fingerprint,
    existing?.updated_at ?? input.now, input.now,
  ).run();

  return {
    outcome: "updated",
    preferences: await getNotificationPreferences(env, input.tenantId, input.userId),
  };
}

// ------------------------------------------------------------------------ setup progress

function stepStatus(requirements: readonly SetupStepRequirement[]): SetupStepStatus {
  const applicable = requirements.filter((requirement) => requirement.applicable);
  if (applicable.length === 0) return "skipped";
  const met = applicable.filter((requirement) => requirement.met).length;
  if (met === applicable.length) return "done";
  return met === 0 ? "later" : "in_progress";
}

interface SetupCounts {
  active_office_users: number;
  active_field_users: number;
  other_active_users: number;
  paired_devices: number;
  quickbooks_connected: number;
  leads_recorded: number;
}

/**
 * One statement, so every count in a checklist comes from the same read of D1 and the
 * rows cannot disagree with each other. Positional binds are repeated rather than
 * numbered: `?NNN` is valid SQLite but is used nowhere else in this Worker.
 */
async function setupCounts(
  env: AppEnv,
  tenantId: string,
  userId: string,
): Promise<SetupCounts> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM app_users
         WHERE tenant_id = ? AND active = 1
           AND COALESCE(access_role, role) IN
               ('owner', 'ops', 'sales', 'production', 'accounting')
       ) AS active_office_users,
       (SELECT COUNT(*) FROM app_users
         WHERE tenant_id = ? AND active = 1
           AND COALESCE(access_role, role) = 'field') AS active_field_users,
       (SELECT COUNT(*) FROM app_users
         WHERE tenant_id = ? AND active = 1 AND user_id != ?) AS other_active_users,
       (SELECT COUNT(*) FROM app_devices
         WHERE tenant_id = ? AND revoked_at IS NULL) AS paired_devices,
       (SELECT COUNT(*) FROM quickbooks_connections
         WHERE tenant_id = ? AND state = 'connected') AS quickbooks_connected,
       (SELECT COUNT(*) FROM operating_leads WHERE tenant_id = ?) AS leads_recorded`,
  ).bind(tenantId, tenantId, tenantId, userId, tenantId, tenantId, tenantId)
    .first<Record<keyof SetupCounts, number>>();
  return {
    active_office_users: Number(row?.active_office_users ?? 0),
    active_field_users: Number(row?.active_field_users ?? 0),
    other_active_users: Number(row?.other_active_users ?? 0),
    paired_devices: Number(row?.paired_devices ?? 0),
    quickbooks_connected: Number(row?.quickbooks_connected ?? 0),
    leads_recorded: Number(row?.leads_recorded ?? 0),
  };
}

export interface SetupProgressInput {
  tenantId: string;
  userId: string;
  now: string;
  /** True when this deployment can complete a QuickBooks connection at all. */
  quickBooksAvailable: boolean;
  /** True when this deployment serves the public customer request form. */
  publicIntakeAvailable: boolean;
}

/**
 * Build the checklist from real rows only.
 *
 * The detail strings say what was counted, not what someone hopes is true, so an owner
 * looking at an `in_progress` row can see the exact fact that is still missing.
 */
export async function buildSetupProgress(
  env: AppEnv,
  input: SetupProgressInput,
): Promise<SetupProgress> {
  const [profile, counts, preferences] = await Promise.all([
    getCompanyProfile(env, input.tenantId),
    setupCounts(env, input.tenantId, input.userId),
    getNotificationPreferences(env, input.tenantId, input.userId),
  ]);
  const missing = missingCompanyFields(profile);

  const steps: SetupStep[] = [
    {
      id: "company",
      title: "Company details",
      status: "later",
      detail: "",
      requirements: [
        {
          id: "company_profile_saved",
          met: profile.profile_version > 0,
          applicable: true,
          detail: profile.profile_version > 0
            ? `Saved ${profile.profile_version} time${profile.profile_version === 1 ? "" : "s"}, last on ${profile.updated_at ?? "an unknown date"}.`
            : "Nobody has saved the company details yet.",
        },
        {
          id: "company_profile_complete",
          met: profile.profile_version > 0 && missing.length === 0,
          applicable: true,
          detail: missing.length === 0
            ? "Every required detail is filled in."
            : `Still missing: ${missing.join(", ")}.`,
        },
      ],
    },
    {
      id: "people",
      title: "People",
      status: "later",
      detail: "",
      requirements: [
        {
          id: "office_account_active",
          met: counts.active_office_users > 0,
          applicable: true,
          detail: `${counts.active_office_users} active office account${counts.active_office_users === 1 ? "" : "s"}.`,
        },
        {
          id: "teammate_added",
          met: counts.other_active_users > 0,
          applicable: true,
          detail: counts.other_active_users > 0
            ? `${counts.other_active_users} teammate${counts.other_active_users === 1 ? "" : "s"} besides you.`
            : "You are the only active account.",
        },
      ],
    },
    {
      id: "crew_phones",
      title: "Crew phones",
      status: "later",
      detail: "",
      requirements: [
        {
          id: "field_account_exists",
          met: counts.active_field_users > 0,
          applicable: true,
          detail: `${counts.active_field_users} active crew account${counts.active_field_users === 1 ? "" : "s"}.`,
        },
        {
          id: "device_paired",
          met: counts.paired_devices > 0,
          applicable: true,
          detail: `${counts.paired_devices} paired phone${counts.paired_devices === 1 ? "" : "s"}.`,
        },
      ],
    },
    {
      id: "money_and_intake",
      title: "Money and intake",
      status: "later",
      detail: "",
      requirements: [
        {
          id: "quickbooks_connected",
          met: counts.quickbooks_connected > 0,
          applicable: input.quickBooksAvailable,
          detail: input.quickBooksAvailable
            ? counts.quickbooks_connected > 0
              ? "QuickBooks is connected."
              : "QuickBooks is not connected yet."
            : "QuickBooks is switched off in this deployment.",
        },
        {
          id: "work_arriving",
          // A recorded lead is the fact; the public form being on is the other way to
          // reach it. Either one means work can arrive without an engineer.
          met: counts.leads_recorded > 0 || input.publicIntakeAvailable,
          applicable: true,
          detail: counts.leads_recorded > 0
            ? `${counts.leads_recorded} lead${counts.leads_recorded === 1 ? "" : "s"} recorded.`
            : input.publicIntakeAvailable
              ? "The public request form is on; no lead has arrived yet."
              : "No lead has arrived and the public request form is off.",
        },
      ],
    },
    {
      id: "notifications",
      title: "Notifications",
      status: "later",
      detail: "",
      requirements: [
        {
          id: "own_preferences_saved",
          met: !preferences.is_default,
          applicable: true,
          detail: preferences.is_default
            ? "You have not chosen what to be told about."
            : `Saved on ${preferences.updated_at ?? "an unknown date"}.`,
        },
      ],
    },
  ];

  for (const step of steps) {
    step.status = stepStatus(step.requirements);
    const blocking = step.requirements.filter(
      (requirement) => requirement.applicable && !requirement.met,
    );
    step.detail = blocking.length === 0
      ? step.requirements.filter((requirement) => requirement.applicable)
        .map((requirement) => requirement.detail).join(" ") ||
        "Nothing to do here in this deployment."
      : blocking.map((requirement) => requirement.detail).join(" ");
  }

  const done = steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  return {
    generated_at: input.now,
    done,
    total: steps.length,
    percent_complete: Math.round((done / steps.length) * 100),
    steps,
  };
}
