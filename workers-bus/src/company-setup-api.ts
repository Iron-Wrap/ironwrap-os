/**
 * Company setup and the Settings hub: the server half of the screens that let an owner
 * describe their own company, see what is still left to do, and choose what they are
 * told about.
 *
 * Three route families, all same-origin BFF under `/api/v1/*`:
 *
 * - `/api/v1/admin/company-profile`      read and update the tenant company profile;
 * - `/api/v1/admin/setup-progress`       the derived checklist;
 * - `/api/v1/notification-preferences`   the signed-in person's own preferences.
 *
 * Authority, validation, versioning, and idempotency all live here and in
 * `company-setup-store.ts`. The browser sends values and an idempotency key; it never
 * sends a role, a tenant, an actor, a timestamp, or a version it was not given. Every
 * refusal returns a stable machine-readable code so a screen can say what to fix
 * instead of flattening everything into one failure.
 */
import { configuredTenantId, validAppCsrf } from "./app-auth.ts";
import {
  APP_API_VERSION,
  type AppEnv,
  type AuthContext,
} from "./app-types.ts";
import {
  COMPANY_PROFILE_WEEK_STARTS,
  CompanySetupError,
  buildSetupProgress,
  companyProfileDefaults,
  getCompanyProfile,
  getNotificationPreferences,
  missingCompanyFields,
  updateCompanyProfile,
  updateNotificationPreferences,
  type CompanyProfileFields,
  type CompanyProfileWeekStart,
  type NotificationPreferenceFields,
} from "./company-setup-store.ts";
import {
  COMPANY_LOGO_CONTENT_TYPES,
  COMPANY_LOGO_MAX_BYTES,
  companyLogoUrl,
  parseCompanyLogoInput,
  parseCompanyLogoRemovalInput,
  parseCompanyProfileInput,
  publicBrandDescriptors,
  removeCompanyLogo,
  saveCompanyLogo,
  type CompanyProfile,
} from "./company-profile.ts";
import { publicEstimateConfiguration } from "./public-estimator.ts";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_LOGO_BODY_BYTES = Math.ceil(COMPANY_LOGO_MAX_BYTES * 1.4) + 1024;

/** Company setup is office work: the same two roles that may provision a teammate. */
const COMPANY_READ_ROLES = new Set(["owner", "ops"]);
const COMPANY_WRITE_ROLES = new Set(["owner", "ops"]);

/**
 * `min` is the length a non-empty answer must reach; `optional` says whether an empty
 * answer is allowed at all.
 *
 * Identity is required from the first save. Contact and address are not, so an owner
 * can name the company now and find the postal code later -- which is also what makes
 * the setup checklist able to report a real "in progress" rather than demanding one
 * perfect save. What is still blank is reported by `missing_fields`, never guessed.
 */
const COMPANY_PROFILE_BODY_KEYS = new Set([
  "company_name", "brand_name", "service_area", "phone", "email", "website",
  "address_line1", "address_line2", "city", "region", "postal_code", "country",
  "brand_labels", "time_zone", "currency", "week_start", "expected_profile_version",
]);

const PUBLIC_PROFILE_BODY_KEYS = [
  "company_name", "brand_name", "service_area", "phone", "email", "website",
  "address_line1", "address_line2", "city", "region", "postal_code", "country",
  "brand_labels",
] as const;

const NOTIFICATION_BODY_KEYS = new Set([
  "work_stops", "approvals_waiting", "daily_summary", "daily_summary_send_time",
]);

// The same IANA shape `publicTenant()` demands of the deployment default this overrides,
// so an owner cannot save a time zone the rest of the Worker would reject.
const TIME_ZONE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/;
const CURRENCY = /^[A-Z]{3}$/;
const SEND_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,160}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readBody(
  req: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> {
  if (Number(req.headers.get("content-length") ?? "0") > maxBytes) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  const text = await req.text();
  if (text.length > maxBytes) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
}

function idempotencyKey(req: Request): string | null {
  const value = req.headers.get("idempotency-key")?.trim() ?? "";
  return IDEMPOTENCY_KEY.test(value) ? value : null;
}

/**
 * A session is only ever authoritative for the tenant this Worker is configured for.
 * A session carrying any other tenant is refused before a single row is read, so a
 * mis-issued or replayed cross-tenant session cannot enumerate or edit this company.
 */
function tenantDenial(env: AppEnv, auth: AuthContext): Response | null {
  const configured = configuredTenantId(env);
  return configured && auth.session.tenant_id === configured
    ? null
    : json({ error: "invalid_tenant" }, 403);
}

function companyAllowedActions(auth: AuthContext): string[] {
  const actions = ["company_profile.read", "setup_progress.read"];
  if (COMPANY_WRITE_ROLES.has(auth.session.role)) actions.push("company_profile.update");
  return actions;
}

function envelope(auth: AuthContext, body: Record<string, unknown>): Record<string, unknown> {
  return {
    version: APP_API_VERSION,
    read_model_generated_at: new Date().toISOString(),
    allowed_actions: companyAllowedActions(auth),
    ...body,
  };
}

function storeErrorResponse(error: unknown): Response {
  if (error instanceof CompanySetupError) return json({ error: error.code }, error.status);
  return json({ error: "company_setup_store_unavailable" }, 502);
}

// ------------------------------------------------------------------------------ parsing

type ParsedProfile =
  | { ok: true; fields: CompanyProfileFields; expectedProfileVersion: number }
  | { ok: false; error: string };

function parseCompanyProfileBody(value: unknown): ParsedProfile {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  // Exact keys. An unknown field is a contract drift, not something to ignore
  // quietly: silently dropping it is how a screen ships believing it saved something.
  for (const key of Object.keys(value)) {
    if (!COMPANY_PROFILE_BODY_KEYS.has(key)) return { ok: false, error: "unexpected_field" };
  }
  for (const key of COMPANY_PROFILE_BODY_KEYS) {
    if (!(key in value)) return { ok: false, error: `missing_${key}` };
  }

  const publicFields = Object.fromEntries(
    PUBLIC_PROFILE_BODY_KEYS.map((key) => [key, value[key]]),
  );
  const parsedPublicFields = parseCompanyProfileInput(publicFields);
  if (!parsedPublicFields.ok) return parsedPublicFields;

  const timeZone = typeof value.time_zone === "string" ? value.time_zone.trim() : "";
  if (!TIME_ZONE.test(timeZone) || timeZone.length > 64) {
    return { ok: false, error: "invalid_time_zone" };
  }
  const currency = typeof value.currency === "string"
    ? value.currency.trim().toUpperCase()
    : "";
  if (!CURRENCY.test(currency)) return { ok: false, error: "invalid_currency" };

  const weekStart = typeof value.week_start === "string" ? value.week_start.trim() : "";
  if (!COMPANY_PROFILE_WEEK_STARTS.includes(weekStart as CompanyProfileWeekStart)) {
    return { ok: false, error: "invalid_week_start" };
  }

  const expected = value.expected_profile_version;
  if (!Number.isSafeInteger(expected) || (expected as number) < 0 ||
      (expected as number) > 1_000_000) {
    return { ok: false, error: "invalid_expected_profile_version" };
  }

  return {
    ok: true,
    expectedProfileVersion: expected as number,
    fields: {
      ...parsedPublicFields.value,
      time_zone: timeZone,
      currency,
      week_start: weekStart as CompanyProfileWeekStart,
    },
  };
}

type ParsedPreferences =
  | { ok: true; fields: NotificationPreferenceFields }
  | { ok: false; error: string };

function parseNotificationBody(value: unknown): ParsedPreferences {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  for (const key of Object.keys(value)) {
    if (!NOTIFICATION_BODY_KEYS.has(key)) return { ok: false, error: "unexpected_field" };
  }
  for (const key of NOTIFICATION_BODY_KEYS) {
    if (!(key in value)) return { ok: false, error: `missing_${key}` };
  }
  for (const key of ["work_stops", "approvals_waiting", "daily_summary"] as const) {
    if (typeof value[key] !== "boolean") return { ok: false, error: `invalid_${key}` };
  }

  const dailySummary = value.daily_summary as boolean;
  const sendTime = value.daily_summary_send_time;
  if (dailySummary) {
    // A daily summary with no send time is half a schedule. It is refused here rather
    // than stored and guessed at by whatever eventually delivers it.
    if (typeof sendTime !== "string" || !SEND_TIME.test(sendTime.trim())) {
      return { ok: false, error: "invalid_daily_summary_send_time" };
    }
  } else if (sendTime !== null) {
    return { ok: false, error: "daily_summary_send_time_not_allowed" };
  }

  return {
    ok: true,
    fields: {
      work_stops: value.work_stops as boolean,
      approvals_waiting: value.approvals_waiting as boolean,
      daily_summary: dailySummary,
      daily_summary_send_time: dailySummary ? (sendTime as string).trim() : null,
    },
  };
}

// ------------------------------------------------------------------------------ routing

/**
 * Returns `null` for a path this module does not own, so the caller keeps routing.
 */
export async function handleCompanySetupRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path !== "/api/v1/admin/company-profile" &&
      path !== "/api/v1/admin/company-profile/logo" &&
      path !== "/api/v1/admin/setup-progress" &&
      path !== "/api/v1/notification-preferences") {
    return null;
  }

  const denied = tenantDenial(env, auth);
  if (denied) return denied;

  if (path === "/api/v1/notification-preferences") {
    // Deliberately open to every authenticated role, field included: a person's own
    // preferences are theirs, and a crew member must be able to ask for work stops.
    if (req.method === "GET") return await notificationRead(env, auth);
    if (req.method === "PUT") return await notificationWrite(req, env, auth);
    return json({ error: "method_not_allowed" }, 405);
  }

  if (!COMPANY_READ_ROLES.has(auth.session.role)) {
    return json({ error: "company_profile_read_role_required" }, 403);
  }

  if (path === "/api/v1/admin/setup-progress") {
    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    return await setupProgressRead(env, auth);
  }

  if (path === "/api/v1/admin/company-profile/logo") {
    if (req.method === "PUT") return await companyLogoWrite(req, env, auth);
    if (req.method === "DELETE") return await companyLogoRemove(req, env, auth);
    return json({ error: "method_not_allowed" }, 405);
  }

  if (req.method === "GET") return await companyProfileRead(env, auth);
  if (req.method === "PUT") return await companyProfileWrite(req, env, auth);
  return json({ error: "method_not_allowed" }, 405);
}

async function companyProfileRead(env: AppEnv, auth: AuthContext): Promise<Response> {
  try {
    const profile = await getCompanyProfile(env, auth.session.tenant_id);
    return json(companyProfileEnvelope(env, auth, profile));
  } catch (error) {
    return storeErrorResponse(error);
  }
}

async function companyProfileWrite(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!COMPANY_WRITE_ROLES.has(auth.session.role)) {
    return json({ error: "company_profile_write_role_required" }, 403);
  }
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const key = idempotencyKey(req);
  if (!key) return json({ error: "idempotency_key_required" }, 400);

  const parsedBody = await readBody(req);
  if (!parsedBody.ok) return json({ error: parsedBody.error }, parsedBody.status);
  const parsed = parseCompanyProfileBody(parsedBody.value);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  try {
    const result = await updateCompanyProfile(env, {
      tenantId: auth.session.tenant_id,
      fields: parsed.fields,
      expectedProfileVersion: parsed.expectedProfileVersion,
      idempotencyKey: key,
      actorUserId: auth.session.user_id,
      actorRole: auth.session.role,
      now: new Date().toISOString(),
    });
    return json(companyProfileEnvelope(env, auth, result.profile, result.outcome));
  } catch (error) {
    return storeErrorResponse(error);
  }
}

async function companyLogoWrite(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!COMPANY_WRITE_ROLES.has(auth.session.role)) {
    return json({ error: "company_profile_write_role_required" }, 403);
  }
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const key = idempotencyKey(req);
  if (!key) return json({ error: "idempotency_key_required" }, 400);
  const parsedBody = await readBody(req, MAX_LOGO_BODY_BYTES);
  if (!parsedBody.ok) return json({ error: parsedBody.error }, parsedBody.status);
  const parsed = parseCompanyLogoInput(parsedBody.value);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  try {
    const result = await saveCompanyLogo(env, auth.session.tenant_id, parsed.value, {
      actorUserId: auth.session.user_id,
      actorRole: auth.session.role,
      idempotencyKey: key,
      now: new Date().toISOString(),
    });
    return json(companyProfileEnvelope(env, auth, result.profile, result.outcome));
  } catch (error) {
    return storeErrorResponse(error);
  }
}

async function companyLogoRemove(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!COMPANY_WRITE_ROLES.has(auth.session.role)) {
    return json({ error: "company_profile_write_role_required" }, 403);
  }
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const key = idempotencyKey(req);
  if (!key) return json({ error: "idempotency_key_required" }, 400);
  const parsedBody = await readBody(req);
  if (!parsedBody.ok) return json({ error: parsedBody.error }, parsedBody.status);
  const parsed = parseCompanyLogoRemovalInput(parsedBody.value);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  try {
    const result = await removeCompanyLogo(
      env,
      auth.session.tenant_id,
      parsed.expectedProfileVersion,
      {
        actorUserId: auth.session.user_id,
        actorRole: auth.session.role,
        idempotencyKey: key,
        now: new Date().toISOString(),
      },
    );
    return json(companyProfileEnvelope(env, auth, result.profile, result.outcome));
  } catch (error) {
    return storeErrorResponse(error);
  }
}

function companyProfileEnvelope(
  env: AppEnv,
  auth: AuthContext,
  profile: CompanyProfile,
  outcome?: "updated" | "replayed",
): Record<string, unknown> {
  const defaults = companyProfileDefaults(env, auth.session.tenant_id);
  const allowedBrands = (env.PUBLIC_ESTIMATE_ALLOWED_BRANDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return envelope(auth, {
    ...(outcome ? { outcome } : {}),
    profile: profileView(profile),
    defaults: profileView(defaults),
    missing_fields: missingCompanyFields(profile),
    week_starts: [...COMPANY_PROFILE_WEEK_STARTS],
    logo_url: companyLogoUrl(profile),
    logo_limits: {
      max_bytes: COMPANY_LOGO_MAX_BYTES,
      content_types: [...COMPANY_LOGO_CONTENT_TYPES],
    },
    public_brands: publicBrandDescriptors(profile, allowedBrands),
  });
}

function profileView(profile: CompanyProfile): Record<string, unknown> {
  return { ...profile, updated_by: profile.updated_by_user_id };
}

async function setupProgressRead(env: AppEnv, auth: AuthContext): Promise<Response> {
  try {
    const publicEstimate = publicEstimateConfiguration(env);
    const progress = await buildSetupProgress(env, {
      tenantId: auth.session.tenant_id,
      userId: auth.session.user_id,
      now: new Date().toISOString(),
      // Capability availability is the deployment's, never the browser's. A step whose
      // capability is off is reported as not applicable rather than as failing.
      quickBooksAvailable: String(env.QB_OAUTH_ENABLED) === "true",
      publicIntakeAvailable: publicEstimate.activated && publicEstimate.ready,
    });
    return json(envelope(auth, { progress }));
  } catch (error) {
    return storeErrorResponse(error);
  }
}

function notificationEnvelope(
  auth: AuthContext,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: APP_API_VERSION,
    read_model_generated_at: new Date().toISOString(),
    allowed_actions: ["notification_preferences.read", "notification_preferences.update"],
    user_id: auth.session.user_id,
    ...body,
  };
}

async function notificationRead(env: AppEnv, auth: AuthContext): Promise<Response> {
  try {
    return json(notificationEnvelope(auth, {
      preferences: await getNotificationPreferences(
        env,
        auth.session.tenant_id,
        auth.session.user_id,
      ),
    }));
  } catch (error) {
    return storeErrorResponse(error);
  }
}

async function notificationWrite(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const key = idempotencyKey(req);
  if (!key) return json({ error: "idempotency_key_required" }, 400);

  const parsedBody = await readBody(req);
  if (!parsedBody.ok) return json({ error: parsedBody.error }, parsedBody.status);
  const parsed = parseNotificationBody(parsedBody.value);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  try {
    const result = await updateNotificationPreferences(env, {
      tenantId: auth.session.tenant_id,
      userId: auth.session.user_id,
      fields: parsed.fields,
      idempotencyKey: key,
      now: new Date().toISOString(),
    });
    return json(notificationEnvelope(auth, {
      outcome: result.outcome,
      preferences: result.preferences,
      // Storing a preference is not a promise to deliver anything. The Worker has no
      // notification delivery capability yet, and saying so here keeps a screen from
      // implying one exists.
      delivery: { enabled: false, reason: "notification_delivery_not_implemented" },
    }));
  } catch (error) {
    return storeErrorResponse(error);
  }
}
