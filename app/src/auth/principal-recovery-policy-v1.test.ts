import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AuthenticatedSession } from "./session";
import type { SavedPlanTarget } from "../field/saved-plan-context";

const target: SavedPlanTarget = { kind: "job", jobId: "JOB-SYNTHETIC" };
let cleanup: typeof import("../storage/db") | undefined;

async function modules() {
  const [session, api, credential, epoch, context, db, plan, fixture] = await Promise.all([
    import("./session"),
    import("../lib/api"),
    import("./device-credential"),
    import("./principal-epoch"),
    import("./principal-context"),
    import("../storage/db"),
    import("../field/saved-plan"),
    import("../field/saved-plan-test-fixture"),
  ]);
  cleanup = db;
  return { session, api, credential, epoch, context, db, plan, fixture };
}

async function positive() {
  const app = await modules();
  await app.credential.storeDeviceSecret("a".repeat(43));
  const source = app.fixture.savedPlanSessionFixture();
  const live = await app.session.fetchSession(async () => Response.json(source));
  expect(live.authenticated).toBe(true);
  if (!live.authenticated) throw new Error("Positive A acquisition failed");
  const read = await app.plan.loadSavedPlan(live, target, async () =>
    Response.json(app.fixture.savedPlanJobFixture()),
  );
  expect(read).toMatchObject({ saved: true, plan: { version: 7 } });
  const saved = await app.session.readVerifiedSavedFieldSession();
  expect(saved).toBeDefined();
  const never = vi.fn<typeof fetch>();
  expect(await app.plan.loadSavedPlan(saved!, target, never)).toMatchObject({
    saved: true,
    offline: true,
    plan: { version: 7 },
  });
  expect(never).not.toHaveBeenCalled();
  return { ...app, source, live };
}

function failWrites(generation: boolean, epoch: boolean) {
  const set = window.localStorage.setItem.bind(window.localStorage);
  const storage = generation
    ? vi.spyOn(window.localStorage, "setItem").mockImplementation((key, value) => {
        if (key === "ironwrap.principal-read-generation-v1")
          throw new DOMException("Synthetic generation failure", "QuotaExceededError");
        set(key, value);
      })
    : undefined;
  const transaction = IDBDatabase.prototype.transaction;
  const database = epoch
    ? vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
        this: IDBDatabase,
        names,
        mode,
        options,
      ) {
        if (mode === "readwrite")
          throw new DOMException("Synthetic epoch failure", "QuotaExceededError");
        return transaction.call(this, names, mode, options);
      })
    : undefined;
  return () => {
    storage?.mockRestore();
    database?.mockRestore();
  };
}

async function fresh(app: Awaited<ReturnType<typeof modules>>) {
  (await app.db.getDatabase()).close();
  vi.resetModules();
  return modules();
}

function absent(source: AuthenticatedSession) {
  return {
    ...source,
    authenticated: false,
    user: null,
    csrf_token: null,
    session_expires_at: null,
  };
}

describe("root-adopted principal recovery policy v1", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await cleanup?.resetDatabaseForTests();
    cleanup = undefined;
    for (const key of Object.keys(window))
      if (key.startsWith("__ironwrapFieldBootstrap")) Reflect.deleteProperty(window, key);
  });

  it.each(["magic", "pair", "logout"])(
    "refuses %s before any HTTP effect when neither durable preparation can survive",
    async (kind) => {
      const app = await positive();
      const snapshot = await app.db.getMeta("authenticated-session-v1");
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(app.source));
      vi.stubGlobal("fetch", fetcher);
      const restore = failWrites(true, true);
      const operation =
        kind === "pair"
          ? (await import("./device-pairing")).pairDevice("synthetic-token")
          : app.api.apiCommand({
              path: kind === "magic" ? "/api/v1/auth/magic-link/consume" : "/api/v1/auth/logout",
              body: kind === "magic" ? { token: "synthetic-token" } : undefined,
              csrfToken: kind === "logout" ? app.source.csrf_token : undefined,
              fetcher,
            });
      await expect(operation).rejects.toMatchObject({
        code: "principal_prepare_failed",
        details: { dispatched: false },
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(await app.db.getMeta("authenticated-session-v1")).toEqual(snapshot);
      restore();
      const reloaded = await fresh(app);
      const saved = await reloaded.session.readVerifiedSavedFieldSession();
      expect(saved).toBeDefined();
      expect(await reloaded.plan.loadSavedPlan(saved!, target)).toMatchObject({
        saved: true,
        plan: { version: 7 },
      });
    },
  );

  it("also refuses an epoch-only failure; localStorage capability is not transactional settlement", async () => {
    const app = await positive();
    const fetcher = vi.fn<typeof fetch>();
    const restore = failWrites(false, true);
    await expect(
      app.api.apiCommand({ path: "/api/v1/auth/magic-link/consume", fetcher }),
    ).rejects.toMatchObject({ code: "principal_prepare_failed" });
    expect(fetcher).not.toHaveBeenCalled();
    restore();
  });

  it.each(["magic", "pair", "logout"])(
    "keeps old A closed after a completed %s HTTP transition and every later write fails",
    async (kind) => {
      const app = await positive();
      let restore = () => {};
      let effects = 0;
      const fetcher = vi.fn<typeof fetch>(async () => {
        const value = await app.db.getMeta<{ pending: string[] }>(app.epoch.PRINCIPAL_EPOCH_KEY);
        expect(value?.pending.length).toBeGreaterThan(0);
        effects += 1; // Models the pinned Worker's cookie effect before the observer runs.
        restore = failWrites(true, true);
        return kind === "pair" ? Response.json(app.source) : new Response(null, { status: 204 });
      });
      if (kind === "pair") {
        vi.stubGlobal("fetch", fetcher);
        await expect(
          (await import("./device-pairing")).pairDevice("synthetic-token"),
        ).rejects.toBeDefined(); // Cookie consume completed; proof storage did not.
      } else {
        await expect(
          app.api.apiCommand({
            path: kind === "magic" ? "/api/v1/auth/magic-link/consume" : "/api/v1/auth/logout",
            csrfToken: kind === "logout" ? app.source.csrf_token : undefined,
            fetcher,
          }),
        ).resolves.toBeUndefined();
      }
      expect(effects).toBe(1);
      restore();
      const reloaded = await fresh(app);
      expect(await reloaded.session.readVerifiedSavedFieldSession()).toBeUndefined();
    },
  );

  it.each([
    ["session", "GET"],
    ["bootstrap", "GET"],
    ["protected", "GET"],
    ["protected", "POST"],
  ] as const)(
    "prepares the actual implicit no_session %s %s family before dispatch",
    async (kind, method) => {
      const app = await positive();
      let restore = () => {};
      let cookieExpired = false;
      const noSession = absent(app.source);
      const fetcher = vi.fn<typeof fetch>(async () => {
        const value = await app.db.getMeta<{ pending: string[] }>(app.epoch.PRINCIPAL_EPOCH_KEY);
        expect(value?.pending.length).toBe(1);
        cookieExpired = true;
        restore = failWrites(true, true);
        return kind === "protected"
          ? Response.json({ error: "unauthorized" }, { status: 401 })
          : Response.json(kind === "bootstrap" ? { version: 1, session: noSession } : noSession);
      });
      const request = app.api.apiRequest<unknown>({
        path:
          kind === "session"
            ? "/api/v1/session?synthetic=1"
            : kind === "bootstrap"
              ? "/api/v1/field/bootstrap"
              : "/api/v1/jobs/JOB-SYNTHETIC",
        method,
        schema:
          kind === "session"
            ? app.session.sessionResponseSchema
            : kind === "bootstrap"
              ? (await import("./field-bootstrap")).fieldBootstrapResponseSchema
              : z.object({ ok: z.boolean() }),
        fetcher,
      });
      if (kind === "protected")
        await expect(request).rejects.toMatchObject({ status: 401, code: "unauthorized" });
      else await expect(request).resolves.toBeDefined();
      expect(cookieExpired).toBe(true);
      restore();
      const reloaded = await fresh(app);
      expect(await reloaded.session.readVerifiedSavedFieldSession()).toBeUndefined();
    },
  );

  it.each(["network", "server", "lost-body", "invalid-json", "malformed-friendly"])(
    "never settles an indeterminate %s result by generic retryability or recovered storage",
    async (cut) => {
      const app = await positive();
      const fetcher = vi.fn<typeof fetch>(async () => {
        if (cut === "network") throw new TypeError("Synthetic transport loss");
        if (cut === "server") return Response.json({ error: "unavailable" }, { status: 503 });
        if (cut === "lost-body") {
          const response = Response.json(app.source);
          response.text = async () => {
            throw new TypeError("Synthetic lost response body");
          };
          return response;
        }
        return cut === "invalid-json" ? new Response("{") : Response.json({ authenticated: false });
      });
      const snapshot = await app.db.getMeta("authenticated-session-v1");
      try {
        const held = await app.session.fetchSession(fetcher);
        expect(held).toMatchObject({ authenticated: true, csrf_token: "offline-session-no-csrf" });
        if (held.authenticated) expect(app.context.sessionReadContextIsCurrent(held)).toBe(false);
      } catch (error) {
        expect(error).toMatchObject({
          code: cut === "malformed-friendly" ? "invalid_response" : expect.any(String),
        });
      }
      expect(fetcher).toHaveBeenCalledOnce();
      expect(await app.db.getMeta("authenticated-session-v1")).toEqual(snapshot);
      const reloaded = await fresh(app);
      expect(await reloaded.session.readVerifiedSavedFieldSession()).toBeUndefined();
    },
  );

  it("does not mistake a successful put request followed by transaction abort for committed preparation", async () => {
    const app = await positive();
    const put = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      const request = put.call(this, value, key);
      if (value?.key === app.epoch.PRINCIPAL_EPOCH_KEY && value.value?.pending?.length)
        request.addEventListener("success", () => this.transaction.abort(), { once: true });
      return request;
    });
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      app.api.apiCommand({ path: "/api/v1/auth/magic-link/consume", fetcher }),
    ).rejects.toMatchObject({ code: "principal_prepare_failed" });
    expect(fetcher).not.toHaveBeenCalled();
    fault.mockRestore();
  });

  it("times out without dispatch when preparation is queued behind an uncommitted transaction", async () => {
    const app = await positive();
    const db = await app.db.getDatabase();
    const blocker = db.transaction("meta", "readwrite");
    let held = true;
    const pump = async () => {
      while (held) await blocker.store.get("synthetic-transaction-hold");
    };
    const pumping = pump();
    const fetcher = vi.fn<typeof fetch>();
    const operation = app.api.apiCommand({
      path: "/api/v1/auth/magic-link/consume",
      timeoutMs: 25,
      fetcher,
    });
    const observed = expect(operation).rejects.toMatchObject({ code: "principal_prepare_failed" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetcher).not.toHaveBeenCalled();
      await observed;
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      held = false;
      await pumping;
      await blocker.done;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("leaves the prepared refusal durable on reload before the response settles", async () => {
    const app = await positive();
    let answer: ((value: Response) => void) | undefined;
    const operation = app.api.apiRequest({
      path: "/api/v1/session",
      schema: app.session.sessionResponseSchema,
      fetcher: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    await vi.waitFor(() => expect(answer).toBeDefined());
    const reloaded = await fresh(app);
    expect(await reloaded.session.readVerifiedSavedFieldSession()).toBeUndefined();
    answer!(Response.json(app.source));
    await operation;
    expect(await reloaded.session.readVerifiedSavedFieldSession()).toBeUndefined();
  });

  it("does not reset malformed durable state to manufacture permission to dispatch", async () => {
    const app = await positive();
    await app.db.setMeta(app.epoch.PRINCIPAL_EPOCH_KEY, {
      format: "field-principal-epoch-v2",
      epoch: "invalid",
      pending: null,
    });
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      app.api.apiCommand({ path: "/api/v1/auth/logout", fetcher }),
    ).rejects.toMatchObject({ code: "principal_prepare_failed" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fences the actual raw document caller and preserves its successful text and refusal contract", async () => {
    const app = await positive();
    const { loadGeneratedDocument } = await import("../documents/document-api");
    const fetcher = vi.fn<typeof fetch>(async (_path, init) => {
      const state = await app.db.getMeta<{ pending: string[] }>(app.epoch.PRINCIPAL_EPOCH_KEY);
      expect(state?.pending).toHaveLength(1);
      expect(new Headers(init?.headers).has("Accept")).toBe(false);
      expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
      return new Response("<p>Synthetic approved document</p>");
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      loadGeneratedDocument("synthetic-receipt", new AbortController().signal),
    ).resolves.toBe("<p>Synthetic approved document</p>");
    fetcher.mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
    await expect(
      loadGeneratedDocument("synthetic-receipt", new AbortController().signal),
    ).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      message: "The document could not be opened.",
    });
    const calls = fetcher.mock.calls.length;
    const restore = failWrites(true, true);
    await expect(
      loadGeneratedDocument("synthetic-receipt", new AbortController().signal),
    ).rejects.toMatchObject({ code: "principal_prepare_failed" });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    restore();
  });

  it("keeps the proven public no-cookie routes outside the storage-failure refusal policy", async () => {
    const app = await positive();
    const restore = failWrites(true, true);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    for (const path of [
      "/api/v1/auth/magic-link/request",
      "/api/v1/auth/invites/accept",
      "/api/v1/customer-portal/resolve",
    ])
      await expect(app.api.apiCommand({ path, fetcher })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
    restore();
  });

  it("settles only its own pending id and never restores an epoch over a concurrent auth change", async () => {
    const app = await positive();
    const before = await app.epoch.capturePrincipalEpoch();
    let first: ((response: Response) => void) | undefined;
    let second: ((response: Response) => void) | undefined;
    const one = app.api.apiRequest({
      path: "/api/v1/jobs/ONE",
      schema: z.object({ ok: z.boolean() }),
      fetcher: () =>
        new Promise((resolve) => {
          first = resolve;
        }),
    });
    const two = app.api.apiRequest({
      path: "/api/v1/jobs/TWO",
      schema: z.object({ ok: z.boolean() }),
      fetcher: () =>
        new Promise((resolve) => {
          second = resolve;
        }),
    });
    await vi.waitFor(() => expect(first && second).toBeTruthy());
    expect(
      (await app.db.getMeta<{ pending: string[] }>(app.epoch.PRINCIPAL_EPOCH_KEY))?.pending,
    ).toHaveLength(2);
    await app.api.apiCommand({
      path: "/api/v1/auth/magic-link/consume",
      fetcher: async () => new Response(null, { status: 204 }),
    });
    second!(Response.json({ ok: true }));
    await two;
    expect(
      (await app.db.getMeta<{ pending: string[] }>(app.epoch.PRINCIPAL_EPOCH_KEY))?.pending,
    ).toHaveLength(1);
    first!(Response.json({ ok: true }));
    await one;
    expect(await app.epoch.capturePrincipalEpoch()).not.toBe(before);
    expect(await app.session.readVerifiedSavedFieldSession()).toBeUndefined();
    const freshLive = await app.session.fetchSession(async () => Response.json(app.source));
    expect(freshLive.authenticated && app.context.sessionReadContextIsCurrent(freshLive)).toBe(
      true,
    );
  });

  it("can acquire and save a genuinely fresh B plan after a settled transition despite generation-store failure", async () => {
    const app = await positive();
    const restore = failWrites(true, false);
    await app.api.apiCommand({
      path: "/api/v1/auth/magic-link/consume",
      fetcher: async () => new Response(null, { status: 204 }),
    });
    restore();
    const sourceB = {
      ...app.source,
      user: {
        ...app.source.user,
        id: "appu_synthetic_B",
        frappe_user_id: "new-crew@example.invalid",
      },
    };
    const B = await app.session.fetchSession(async () => Response.json(sourceB));
    expect(B.authenticated).toBe(true);
    if (!B.authenticated) throw new Error("Fresh B acquisition failed");
    const model = app.fixture.savedPlanJobFixture();
    model.packet.work_package!.version = 8;
    model.assignment!.id = "ASSIGN-SYNTHETIC-B";
    expect(await app.plan.loadSavedPlan(B, target, async () => Response.json(model))).toMatchObject(
      { saved: true, plan: { version: 8 } },
    );
    const reloaded = await fresh(app);
    const offlineB = await reloaded.session.readVerifiedSavedFieldSession();
    expect(offlineB?.user.id).toBe(sourceB.user.id);
    expect(await reloaded.plan.loadSavedPlan(offlineB!, target)).toMatchObject({
      saved: true,
      offline: true,
      plan: { version: 8 },
    });
  });

  it.each(["ordinary protected GET", "magic consume"])(
    "reports the producer boundary after %s: fresh online DTO/plan bytes do not resolve the lost exchange",
    async (kind) => {
      const app = await positive();
      const { loadJob } = await import("../field/field-cache");
      const cut = vi.fn<typeof fetch>(async () => {
        throw new TypeError("Synthetic indeterminate dispatched exchange");
      });
      if (kind === "magic consume") {
        await expect(
          app.api.apiCommand({ path: "/api/v1/auth/magic-link/consume", fetcher: cut }),
        ).rejects.toMatchObject({ code: "network_error" });
      } else {
        const ordinaryFallback = await loadJob(app.live, target.jobId, cut);
        expect(ordinaryFallback.stale_fields).toContain("offline.cached_packet");
      }
      expect(cut).toHaveBeenCalledOnce();
      const sourceB = { ...app.source, user: { ...app.source.user, id: "appu_synthetic_B" } };
      const B = await app.session.fetchSession(async () => Response.json(sourceB));
      expect(B).toEqual(sourceB);
      if (!B.authenticated) throw new Error("Expected the genuinely successful raw online DTO");
      const model = app.fixture.savedPlanJobFixture();
      model.packet.work_package!.version = 8;
      expect(
        (await loadJob(B, target.jobId, async () => Response.json(model))).packet.work_package
          ?.version,
      ).toBe(8);
      expect(await app.plan.hasSavedPlan(B, target)).toBe(false);
      await expect(app.plan.loadSavedPlan(B, target)).rejects.toMatchObject({
        code: "saved_plan_context_changed",
      });
      expect(await app.session.readVerifiedSavedFieldSession()).toBeUndefined();
      const record = await app.db.getMeta<{ pending: string[] }>(app.epoch.PRINCIPAL_EPOCH_KEY);
      expect(record?.pending).toHaveLength(1);
      const reloaded = await fresh(app);
      const onlineAgain = await reloaded.session.fetchSession(async () => Response.json(sourceB));
      expect(onlineAgain).toEqual(sourceB);
      if (!onlineAgain.authenticated)
        throw new Error("Expected the genuine fresh online DTO after restart");
      await expect(reloaded.plan.loadSavedPlan(onlineAgain, target)).rejects.toMatchObject({
        code: "saved_plan_context_changed",
      });
      expect(await reloaded.session.readVerifiedSavedFieldSession()).toBeUndefined();
    },
  );

  it("opens a verified saved packet from a held live session without any speculative HTTP attempt", async () => {
    const app = await positive();
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Unreachable transport despite any online hint");
    });
    expect(
      await app.plan.loadSavedPlan(app.live, target, fetcher, undefined, undefined, "prefer-saved"),
    ).toMatchObject({ offline: true, saved: true, plan: { version: 7 } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the latest observed B snapshot when an older authenticated A response arrives last", async () => {
    const app = await positive();
    let answerA: ((response: Response) => void) | undefined;
    const older = app.session.fetchSession(
      () =>
        new Promise((resolve) => {
          answerA = resolve;
        }),
    );
    await vi.waitFor(() => expect(answerA).toBeDefined());
    const sourceB = {
      ...app.source,
      user: {
        ...app.source.user,
        id: "appu_synthetic_B",
        frappe_user_id: "new-crew@example.invalid",
      },
    };
    const B = await app.session.fetchSession(async () => Response.json(sourceB));
    expect(B.authenticated).toBe(true);
    if (!B.authenticated) throw new Error("Fresh B acquisition failed");
    const model = app.fixture.savedPlanJobFixture();
    model.packet.work_package!.version = 8;
    const acquiringB = app.plan.loadSavedPlan(B, target, async () => Response.json(model));
    answerA!(Response.json(app.source));
    expect(await older).toEqual(app.source); // Raw DTO contract, without field authority.
    expect(await acquiringB).toMatchObject({ saved: true, plan: { version: 8 } });
    const reloaded = await fresh(app);
    const cachedB = await reloaded.session.readVerifiedSavedFieldSession();
    expect(cachedB?.user.id).toBe(sourceB.user.id);
    expect(await reloaded.plan.loadSavedPlan(cachedB!, target)).toMatchObject({
      saved: true,
      offline: true,
      plan: { version: 8 },
    });
  });

  it.each([false, true])(
    "separates proof-only401 from cookie expiry, with supplied-proof cleanup=%s",
    async (supplied) => {
      const app = await positive();
      const generation = app.context.getPrincipalGeneration();
      await expect(
        app.api.apiRequest({
          path: "/api/v1/jobs/JOB-SYNTHETIC",
          schema: z.object({ ok: z.boolean() }),
          deviceProof: supplied ? app.credential.getDeviceSecret : undefined,
          fetcher: async () => Response.json({ error: "device_proof_required" }, { status: 401 }),
        }),
      ).rejects.toMatchObject({ status: 401, code: "device_proof_required" });
      expect(await app.credential.getDeviceSecret()).toBe(supplied ? undefined : "a".repeat(43));
      expect(app.context.getPrincipalGeneration() === generation).toBe(!supplied);
      expect(await app.session.readVerifiedSavedFieldSession()).toEqual(
        supplied ? undefined : expect.any(Object),
      );
    },
  );
});
