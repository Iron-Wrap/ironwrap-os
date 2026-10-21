import { afterEach, describe, expect, it, vi } from "vitest";

import { getDeviceSecret, storeDeviceSecret } from "./device-credential";
import { resetDatabaseForTests } from "../storage/db";
import {
  clearSessionSnapshot,
  fetchSession,
  officeSessionIsLive,
  persistAuthenticatedSession,
  sessionResponseSchema,
} from "./session";

const authenticatedSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_123",
    email: "crew@ironwrapexteriors.com",
    display_name: "Crew Member",
    role: "field",
    frappe_user_id: null,
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:assigned"],
  allowed_actions: ["check_in:create"],
  csrf_token: "csrf-token",
  session_expires_at: "2026-07-11T12:00:00.000Z",
  source_updated_at: "2026-07-10T12:00:00.000Z",
  read_model_generated_at: "2026-07-10T12:00:01.000Z",
  stale_fields: [],
} as const;

describe("sessionResponseSchema", () => {
  afterEach(async () => {
    await resetDatabaseForTests();
  });

  it("accepts the exact authenticated BFF envelope", () => {
    expect(sessionResponseSchema.parse(authenticatedSession)).toEqual(authenticatedSession);
  });

  it("rejects unknown roles and missing CSRF truth", () => {
    expect(
      sessionResponseSchema.safeParse({
        ...authenticatedSession,
        user: { ...authenticatedSession.user, role: "admin" },
      }).success,
    ).toBe(false);
    expect(
      sessionResponseSchema.safeParse({ ...authenticatedSession, csrf_token: null }).success,
    ).toBe(false);
  });

  it("accepts the intended accounting office role", () => {
    const accountingSession = {
      ...authenticatedSession,
      user: { ...authenticatedSession.user, role: "accounting" },
      permissions: ["quickbooks:read"],
      allowed_actions: ["quickbooks:read"],
    } as const;

    expect(sessionResponseSchema.parse(accountingSession)).toEqual(accountingSession);
  });

  it("accepts the Worker public tenant for an unauthenticated session", () => {
    expect(
      sessionResponseSchema.parse({
        version: 1,
        authenticated: false,
        user: null,
        tenant: authenticatedSession.tenant,
        permissions: [],
        allowed_actions: ["auth.device_pairing.consume"],
        csrf_token: null,
        session_expires_at: null,
        source_updated_at: null,
        read_model_generated_at: "2026-07-10T12:00:01.000Z",
        stale_fields: [],
      }),
    ).toMatchObject({ authenticated: false, tenant: { id: "ironwrap" } });
  });

  it("clears a revoked field proof and tells the auth boundary that re-pairing is required", async () => {
    const activeFieldSession = {
      ...authenticatedSession,
      session_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    await fetchSession(vi.fn<typeof fetch>().mockResolvedValue(Response.json(activeFieldSession)));
    await storeDeviceSecret("d".repeat(43));
    const unauthenticated = await fetchSession(
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          version: 1,
          authenticated: false,
          user: null,
          tenant: authenticatedSession.tenant,
          permissions: [],
          allowed_actions: ["auth.device_pairing.consume"],
          csrf_token: null,
          session_expires_at: null,
          source_updated_at: null,
          read_model_generated_at: "2026-07-10T12:00:01.000Z",
          stale_fields: [],
        }),
      ),
    );

    expect(unauthenticated).toMatchObject({
      authenticated: false,
      stale_fields: ["field_device_repair_required"],
    });
    expect(await getDeviceSecret()).toBeUndefined();
  });
});

describe("officeSessionIsLive", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDatabaseForTests();
  });

  it("is true only while this browser keeps an unexpired sign-in", async () => {
    expect(await officeSessionIsLive()).toBe(false);

    const expiresAt = Date.now() + 60 * 60_000;
    await persistAuthenticatedSession({
      ...authenticatedSession,
      user: { ...authenticatedSession.user, role: "owner" },
      session_expires_at: new Date(expiresAt).toISOString(),
    });
    expect(await officeSessionIsLive()).toBe(true);

    vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
    expect(await officeSessionIsLive()).toBe(false);
    vi.restoreAllMocks();

    await clearSessionSnapshot();
    expect(await officeSessionIsLive()).toBe(false);
  });
});
