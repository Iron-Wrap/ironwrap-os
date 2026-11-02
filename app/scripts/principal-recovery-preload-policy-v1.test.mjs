import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const script = () => new Function(readFileSync("public/field-bootstrap-preload.js", "utf8"))();
const target = { kind: "job", jobId: "JOB-SYNTHETIC" };
let cleanup;

async function app() {
  const [session, credential, epoch, context, db, plan, fixture, bootstrap] = await Promise.all([
    import("../src/auth/session"),
    import("../src/auth/device-credential"),
    import("../src/auth/principal-epoch"),
    import("../src/auth/principal-context"),
    import("../src/storage/db"),
    import("../src/field/saved-plan"),
    import("../src/field/saved-plan-test-fixture"),
    import("../src/auth/field-bootstrap"),
  ]);
  cleanup = db;
  await credential.storeDeviceSecret("a".repeat(43));
  return { session, credential, epoch, context, db, plan, fixture, bootstrap };
}

describe("root-adopted principal recovery head preload policy v1", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/today");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await cleanup?.resetDatabaseForTests();
    for (const key of Object.keys(window))
      if (key.startsWith("__ironwrapFieldBootstrap")) Reflect.deleteProperty(window, key);
  });

  it("keeps healthy saved entry and its full plan genuinely local before the head HTTP optimization", async () => {
    const a = await app();
    const source = a.fixture.savedPlanSessionFixture();
    const live = await a.session.fetchSession(async () => Response.json(source));
    expect(live.authenticated).toBe(true);
    expect(
      await a.plan.loadSavedPlan(live, target, async () =>
        Response.json(a.fixture.savedPlanJobFixture()),
      ),
    ).toMatchObject({ saved: true, plan: { version: 7 } });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    script();
    a.bootstrap.primeFieldBootstrap();
    const value = await a.bootstrap.settlePrimedFieldBootstrap();
    expect(value.session).toMatchObject({
      authenticated: true,
      csrf_token: "offline-session-no-csrf",
    });
    expect(value.field_read_observation.source).toBe("offline");
    expect(await a.plan.loadSavedPlan(value.session, target, fetcher)).toMatchObject({
      saved: true,
      offline: true,
      plan: { version: 7 },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("commits the cold head refusal before HTTP and hands the same prepared exchange through prime/seed parsing", async () => {
    const a = await app();
    const source = a.fixture.savedPlanSessionFixture();
    const today = {
      version: 1,
      source_updated_at: null,
      read_model_generated_at: new Date(0).toISOString(),
      stale_fields: [],
      permissions: [],
      allowed_actions: [],
      date: new Date(0).toISOString().slice(0, 10),
      jobs: [],
    };
    const fetcher = vi.fn(async () => {
      const state = await a.db.getMeta(a.epoch.PRINCIPAL_EPOCH_KEY);
      expect(state.pending).toHaveLength(1);
      return Response.json({ version: 1, session: source, today });
    });
    vi.stubGlobal("fetch", fetcher);
    script();
    a.bootstrap.primeFieldBootstrap();
    const value = await a.bootstrap.settlePrimedFieldBootstrap();
    expect(value.session).toEqual(source);
    expect(value.field_read_observation.source).toBe("live");
    expect(a.context.sessionReadContextIsCurrent(value.session)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    const state = await a.db.getMeta(a.epoch.PRINCIPAL_EPOCH_KEY);
    expect(state.pending).toEqual([]);
  });
});
