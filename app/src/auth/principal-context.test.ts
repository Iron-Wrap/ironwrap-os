import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiCommand, apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { resetDatabaseForTests } from "../storage/db";
import { captureSavedPlanReadContext } from "../field/saved-plan-read-context";
import {
  savedPlanSessionFixture,
  verifiedSavedPlanSessionFixture,
} from "../field/saved-plan-test-fixture";
import { storeDeviceSecret, getDeviceSecret } from "./device-credential";
import { pairDevice } from "./device-pairing";
import { fetchSession, sessionResponseSchema } from "./session";
import { fetchFieldBootstrap } from "./field-bootstrap";
import {
  beginPrincipalContextChange,
  sessionReadContextIsCurrent,
  getPrincipalGeneration,
} from "./principal-context";

describe("auth observations used by the saved-plan reader", () => {
  beforeEach(async () => {
    await storeDeviceSecret("a".repeat(43));
  });
  afterEach(async () => {
    await resetDatabaseForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves ordinary sign-in but refuses field provenance when an existing generation becomes read-only", async () => {
    const source = savedPlanSessionFixture();
    expect(getPrincipalGeneration()).toBeTruthy();
    const storage = window.localStorage;
    vi.spyOn(window, "localStorage", "get").mockReturnValue({
      length: storage.length,
      clear: storage.clear.bind(storage),
      key: storage.key.bind(storage),
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem() {
        throw new DOMException("Synthetic read-only storage", "SecurityError");
      },
    });
    const result = await fetchSession(async () => Response.json(source));
    expect(result).toEqual(source);
    expect(getPrincipalGeneration()).toBeNull();
    if (!result.authenticated) throw new Error("Expected unchanged ordinary sign-in");
    expect(sessionReadContextIsCurrent(result)).toBe(false);
    await expect(captureSavedPlanReadContext(result)).rejects.toMatchObject({
      code: "saved_plan_context_changed",
    });
  });

  it("preserves the ordinary offline DTO but refuses its old field observation after local generation writes recover", async () => {
    const source = savedPlanSessionFixture();
    await verifiedSavedPlanSessionFixture(source);
    const generation = getPrincipalGeneration();
    const storage = window.localStorage;
    const readonly = vi.spyOn(window, "localStorage", "get").mockReturnValue({
      length: storage.length,
      clear: storage.clear.bind(storage),
      key: storage.key.bind(storage),
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem() {
        throw new DOMException("Synthetic read-only storage", "SecurityError");
      },
    });
    await apiCommand({
      path: API_PATHS.magicLinkConsume,
      body: { token: "synthetic-token" },
      fetcher: async () => Response.json({}),
    });
    readonly.mockRestore();
    expect(getPrincipalGeneration()).toBe(generation);
    const offline = await fetchSession(async () => {
      throw new TypeError("Synthetic offline");
    });
    expect(offline.authenticated).toBe(true);
    if (!offline.authenticated) throw new Error("Expected unchanged ordinary offline sign-in");
    expect(offline.user).toEqual(source.user);
    await expect(captureSavedPlanReadContext(offline)).rejects.toMatchObject({
      code: "saved_plan_context_changed",
    });
    const fresh = await fetchSession(async () => Response.json(source));
    if (!fresh.authenticated) throw new Error("Expected unchanged ordinary fresh sign-in");
    await expect(captureSavedPlanReadContext(fresh)).resolves.toBeDefined();
  });

  it.each(["session", "bootstrap"])(
    "observes the implicit no_session cookie expiry on friendly %s responses",
    async (path) => {
      const office = savedPlanSessionFixture();
      office.user = { ...office.user, role: "ops", frappe_user_id: null };
      const verified = await verifiedSavedPlanSessionFixture(office);
      const held = await captureSavedPlanReadContext(verified);
      const absent = {
        ...office,
        authenticated: false,
        user: null,
        csrf_token: null,
        session_expires_at: null,
      };
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(path === "session" ? absent : { version: 1, session: absent }),
        );
      const result =
        path === "session"
          ? await fetchSession(fetcher)
          : (await fetchFieldBootstrap(fetcher)).session;
      expect(result.authenticated).toBe(false);
      await expect(held.assertCurrent()).rejects.toMatchObject({
        code: "saved_plan_context_changed",
      });
    },
  );

  it.each(["unauthorized", "device_proof_required"])(
    "preserves the %s error and distinguishes cookie expiry from a proof-only refusal",
    async (code) => {
      const held = await captureSavedPlanReadContext(await verifiedSavedPlanSessionFixture());
      const generation = getPrincipalGeneration();
      await expect(
        apiRequest({
          path: "/api/v1/jobs/JOB-SYNTHETIC",
          schema: sessionResponseSchema,
          fetcher: async () => Response.json({ error: code }, { status: 401 }),
        }),
      ).rejects.toMatchObject({ status: 401, code });
      if (code === "unauthorized") {
        expect(getPrincipalGeneration()).not.toBe(generation);
        await expect(held.assertCurrent()).rejects.toMatchObject({
          code: "saved_plan_context_changed",
        });
      } else {
        expect(getPrincipalGeneration()).toBe(generation);
        await expect(held.assertCurrent()).resolves.toBeUndefined();
      }
    },
  );

  it.each([API_PATHS.magicLinkConsume, API_PATHS.logout])(
    "withdraws a held read before %s can change the cookie, without changing command results",
    async (path) => {
      const held = await captureSavedPlanReadContext(await verifiedSavedPlanSessionFixture());
      let finish: (response: Response) => void = () => {};
      const fetcher = vi.fn<typeof fetch>(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = apiCommand({ path, body: { token: "synthetic-token" }, fetcher });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      await expect(held.assertCurrent()).rejects.toMatchObject({
        code: "saved_plan_context_changed",
      });
      finish(Response.json({}));
      await expect(pending).resolves.toBeUndefined();
      await expect(held.assertCurrent()).rejects.toMatchObject({
        code: "saved_plan_context_changed",
      });
    },
  );

  it("withdraws before pairing consumes its cookie and keeps the old proof until consumption succeeds", async () => {
    const held = await captureSavedPlanReadContext(await verifiedSavedPlanSessionFixture());
    const next = savedPlanSessionFixture();
    let finish: (session: typeof next) => void = () => {};
    const consume = vi.fn(
      () =>
        new Promise<typeof next>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = pairDevice("synthetic-token", {
      createDeviceProof: () => "b".repeat(43),
      consume,
    });
    await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce());
    expect(await getDeviceSecret()).toBe("a".repeat(43));
    await expect(held.assertCurrent()).rejects.toMatchObject({
      code: "saved_plan_context_changed",
    });
    finish(next);
    await pending;
    expect(await getDeviceSecret()).toBe("b".repeat(43));
    await expect(held.assertCurrent()).rejects.toMatchObject({
      code: "saved_plan_context_changed",
    });
  });

  it("preserves an ordinary session read result while tagging its crossed auth context as unusable by field readers", async () => {
    const source = savedPlanSessionFixture();
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = fetchSession(fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const changed = beginPrincipalContextChange();
    changed();
    finish(Response.json(source));
    const result = await pending;
    expect(result).toEqual(source);
    if (!result.authenticated) throw new Error("Expected the unchanged authenticated response");
    expect(sessionReadContextIsCurrent(result)).toBe(false);
    await expect(captureSavedPlanReadContext(result)).rejects.toMatchObject({
      code: "saved_plan_context_changed",
    });
  });

  it("covers the actual pairing API response before the newly generated proof is stored", async () => {
    const held = await captureSavedPlanReadContext(await verifiedSavedPlanSessionFixture());
    const next = savedPlanSessionFixture();
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const pending = pairDevice("synthetic-token", { createDeviceProof: () => "b".repeat(43) });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls[0]?.[0]).toBe(API_PATHS.devicePairingConsume);
    expect(await getDeviceSecret()).toBe("a".repeat(43));
    await expect(held.assertCurrent()).rejects.toMatchObject({
      code: "saved_plan_context_changed",
    });
    finish(Response.json(next));
    await pending;
    expect(await getDeviceSecret()).toBe("b".repeat(43));
    await expect(held.assertCurrent()).rejects.toMatchObject({
      code: "saved_plan_context_changed",
    });
  });

  it("preserves an ordinary bootstrap response while tagging a crossed verification context for field refusal", async () => {
    const source = savedPlanSessionFixture();
    const today = {
      version: 1,
      source_updated_at: source.source_updated_at,
      read_model_generated_at: source.read_model_generated_at,
      stale_fields: [],
      permissions: source.permissions,
      allowed_actions: source.allowed_actions,
      date: new Date(0).toISOString().slice(0, 10),
      jobs: [],
      work_objects: [],
    };
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = fetchFieldBootstrap(fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const changed = beginPrincipalContextChange();
    changed();
    finish(Response.json({ version: 1, session: source, today }));
    const result = await pending;
    expect(result.session).toEqual(source);
    if (!result.session.authenticated)
      throw new Error("Expected the unchanged authenticated response");
    expect(sessionReadContextIsCurrent(result.session)).toBe(false);
    await expect(captureSavedPlanReadContext(result.session)).rejects.toMatchObject({
      code: "saved_plan_context_changed",
    });
  });
});
