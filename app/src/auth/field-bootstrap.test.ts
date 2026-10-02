import { afterEach, describe, expect, it, vi } from "vitest";

import { resetDatabaseForTests } from "../storage/db";
import {
  awaitFieldBootstrapPreload,
  FIELD_BOOTSTRAP_PRELOAD_TIMEOUT_MS,
  fetchFieldBootstrap,
  fieldBootstrapResponseSchema,
  primeFieldBootstrap,
  takePrimedFieldBootstrap,
  type FieldBootstrap,
} from "./field-bootstrap";

const session = {
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
  allowed_actions: ["field.checkin.create"],
  csrf_token: "csrf-token",
  session_expires_at: "2030-07-11T12:00:00.000Z",
  source_updated_at: "2026-07-10T12:00:00.000Z",
  read_model_generated_at: "2026-07-10T12:00:01.000Z",
  stale_fields: [],
} as const;

const today = {
  version: 1,
  source_updated_at: "2026-07-10T12:00:00.000Z",
  read_model_generated_at: "2026-07-10T12:00:01.000Z",
  stale_fields: [],
  permissions: ["jobs:read:assigned"],
  allowed_actions: ["field.checkin.create"],
  date: "2026-07-10",
  jobs: [
    {
      id: "JOB-123",
      job_number: "IW-123",
      brand: "IronWrap Exteriors",
      status: "In Production",
      address: "123 Test Avenue, Calgary, AB",
      scheduled_start: "2026-07-10T16:00:00.000Z",
      scheduled_end: null,
      blocked_gate_count: 0,
      next_action: "Open field check-in",
      assignment: null,
    },
  ],
} as const;

const preloadWindow = window as Window & {
  __ironwrapFieldBootstrapResponse?: Promise<Response>;
  __ironwrapFieldBootstrapPreloadConsumed?: boolean;
};

describe("fieldBootstrapResponseSchema", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete preloadWindow.__ironwrapFieldBootstrapResponse;
    delete preloadWindow.__ironwrapFieldBootstrapPreloadConsumed;
    await resetDatabaseForTests();
  });

  it("accepts one authenticated response with the session and assigned run sheet", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ version: 1, session, today }));

    await expect(fetchFieldBootstrap(fetcher)).resolves.toMatchObject({ session, today });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/field/bootstrap",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
  });

  it("permits an unauthenticated response only when no job data is present", () => {
    const unauthenticated = {
      version: 1,
      authenticated: false,
      user: null,
      tenant: session.tenant,
      permissions: [],
      allowed_actions: ["auth.device_pairing.consume"],
      csrf_token: null,
      session_expires_at: null,
      source_updated_at: null,
      read_model_generated_at: "2026-07-10T12:00:01.000Z",
      stale_fields: [],
    } as const;

    expect(
      fieldBootstrapResponseSchema.safeParse({ version: 1, session: unauthenticated }).success,
    ).toBe(true);
    expect(
      fieldBootstrapResponseSchema.safeParse({ version: 1, session: unauthenticated, today })
        .success,
    ).toBe(false);
  });

  it("rejects an authenticated response that omits its run sheet", () => {
    expect(fieldBootstrapResponseSchema.safeParse({ version: 1, session }).success).toBe(false);
  });

  it("abandons a stalled head preload instead of blocking the field shell forever", async () => {
    vi.useFakeTimers();
    const preload = awaitFieldBootstrapPreload(new Promise<Response>(() => undefined));

    await vi.advanceTimersByTimeAsync(FIELD_BOOTSTRAP_PRELOAD_TIMEOUT_MS);

    await expect(preload).resolves.toBeUndefined();
  });

  it("shares only the entry-time bootstrap read, then allows fresh refetches", async () => {
    const bootstrap = { session, today } as unknown as FieldBootstrap;
    const loader = vi.fn<() => Promise<FieldBootstrap>>().mockResolvedValue(bootstrap);

    primeFieldBootstrap(loader);
    await expect(takePrimedFieldBootstrap(loader)).resolves.toMatchObject(bootstrap);
    expect(loader).toHaveBeenCalledTimes(1);

    await takePrimedFieldBootstrap(loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("consumes an early head response once and fetches fresh data afterward", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ version: 1, session, today }));
    vi.stubGlobal("fetch", fetcher);
    preloadWindow.__ironwrapFieldBootstrapResponse = Promise.resolve(
      Response.json({ version: 1, session, today }),
    );

    await expect(fetchFieldBootstrap()).resolves.toMatchObject({ session, today });
    expect(fetcher).not.toHaveBeenCalled();
    expect(preloadWindow.__ironwrapFieldBootstrapPreloadConsumed).toBe(true);
    expect(preloadWindow.__ironwrapFieldBootstrapResponse).toBeUndefined();

    await expect(fetchFieldBootstrap()).resolves.toMatchObject({ session, today });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("claims the missing head response before the entry's fallback and later refetch", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ version: 1, session, today }));
    vi.stubGlobal("fetch", fetcher);

    const initial = fetchFieldBootstrap();
    expect(preloadWindow.__ironwrapFieldBootstrapPreloadConsumed).toBe(true);
    await expect(initial).resolves.toMatchObject({ session, today });
    await expect(fetchFieldBootstrap()).resolves.toMatchObject({ session, today });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
