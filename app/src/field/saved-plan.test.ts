import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { storeDeviceSecret } from "../auth/device-credential";
import { getDatabase, resetDatabaseForTests } from "../storage/db";
import { cacheFieldModel, loadJob } from "./field-cache";
import type { JobResponse, WorkObjectResponse } from "./field-contracts";
import { hasSavedPlan, loadSavedPlan, prefetchSavedPlans } from "./saved-plan";
import {
  savedPlanJobFixture,
  savedPlanSessionFixture,
  verifiedSavedPlanSessionFixture,
} from "./saved-plan-test-fixture";
import { fetchSession } from "../auth/session";
import { savedPlanCacheKey, type SavedPlanTarget } from "./saved-plan-context";

const stamp = new Date(0).toISOString();

let session = savedPlanSessionFixture();

const target: SavedPlanTarget = { kind: "job", jobId: "JOB-SYNTHETIC" };
const typedTarget: Extract<SavedPlanTarget, { kind: "work-object" }> = {
  kind: "work-object",
  scope: {
    workObjectType: "Shop Order",
    workObjectId: "SHOP-SYNTHETIC",
    physicalContextType: "Shop Floor",
    physicalContextId: "FLOOR-SYNTHETIC",
  },
};

function typedFixture(): WorkObjectResponse {
  const job = savedPlanJobFixture();
  return {
    version: 1,
    source_updated_at: stamp,
    read_model_generated_at: stamp,
    stale_fields: [],
    permissions: job.permissions,
    allowed_actions: job.allowed_actions,
    work_object: typedTarget.scope,
    assignment: job.assignment,
    work_package: {
      ...job.packet.work_package!,
      id: "WP-SHOP-SYNTHETIC",
      title: "Synthetic shop instructions",
      work_object_type: "Shop Order",
      work_object_id: "SHOP-SYNTHETIC",
      physical_context_type: "Shop Floor",
      physical_context_id: "FLOOR-SYNTHETIC",
    },
  };
}

const live = (model: unknown) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(model));
const disconnected = () =>
  vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Synthetic offline read"));

describe("saved work-plan context and offline reads", () => {
  beforeEach(async () => {
    await storeDeviceSecret("a".repeat(43));
    session = await verifiedSavedPlanSessionFixture();
  });
  afterEach(async () => {
    await resetDatabaseForTests();
    vi.restoreAllMocks();
  });

  it("binds an actual paired GET to the null-roof-id job and complete version without a mutation", async () => {
    const fetcher = live(savedPlanJobFixture());
    const read = await loadSavedPlan(session, target, fetcher);
    expect(read.saved).toBe(true);
    expect(read.plan.version).toBe(7);
    expect(read.plan.steps[0]?.instruction).toBe("Inspect the synthetic anchor");
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/jobs/JOB-SYNTHETIC");
    expect(fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-IronWrap-Device-Proof")).toBe(
      "a".repeat(43),
    );
    const db = await getDatabase();
    const record = await db.get("field_cache", savedPlanCacheKey(session, target));
    expect(record?.savedPlanBinding).toMatchObject({
      tenantId: session.tenant.id,
      userId: session.user.id,
      packageId: "WP-SYNTHETIC",
      packageVersion: 7,
      releaseAttemptId: "release-synthetic-7",
    });
    expect(JSON.stringify(record?.savedPlanBinding)).not.toContain("a".repeat(43));
    expect(await db.getAll("outbox_actions")).toEqual([]);
  });

  it("opens the full bound saved version after a live acquisition, with stops and checks still open", async () => {
    await loadSavedPlan(session, target, live(savedPlanJobFixture()));
    const saved = await loadSavedPlan(session, target, disconnected());
    expect(saved.offline).toBe(true);
    expect(saved.plan.stop_conditions).toBe("Stop if the boundary is unsafe");
    expect(saved.plan.make_safe_procedure).toContain("contact the office");
    expect(saved.plan.status).toBe("Blocked");
    expect(saved.plan.hold_points[0]?.released).toBe(false);
    expect("job" in saved.model && saved.model.gates[0]?.state).toBe("Blocked");
    expect(saved.plan.acknowledgement.current_user_acknowledged).toBe(false);
  });

  it("selects the typed tuple online and offline without requesting a job with its ID", async () => {
    const fetcher = live(typedFixture());
    await loadSavedPlan(session, typedTarget, fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/v1/work-objects/Shop%20Order/SHOP-SYNTHETIC/physical-contexts/Shop%20Floor/FLOOR-SYNTHETIC",
    );
    expect((await loadSavedPlan(session, typedTarget, disconnected())).plan.id).toBe(
      "WP-SHOP-SYNTHETIC",
    );
    expect(await hasSavedPlan(session, target)).toBe(false);
  });

  it("refuses a legacy unbound saved packet while preserving ordinary job-detail compatibility", async () => {
    const model = savedPlanJobFixture();
    await cacheFieldModel(savedPlanCacheKey(session, target), model, model.source_updated_at);
    expect((await loadJob(session, "JOB-SYNTHETIC", disconnected())).job.id).toBe("JOB-SYNTHETIC");
    expect(await hasSavedPlan(session, target)).toBe(false);
    await expect(loadSavedPlan(session, target, disconnected())).rejects.toMatchObject({
      code: "saved_plan_unavailable",
    });
  });

  it.each(["job", "package", "area", "unknown", "empty", "missing", "assignment"])(
    "refuses %s content that cannot be bound to this work",
    async (fault) => {
      const model = savedPlanJobFixture();
      if (fault === "job") model.job.id = "JOB-FOREIGN";
      if (fault === "package") model.packet.work_package!.work_object_id = "JOB-FOREIGN";
      if (fault === "area") model.packet.work_package!.physical_context_id = "SITE-FOREIGN";
      if (fault === "unknown") model.packet.work_package!.work_object_id = "unknown";
      if (fault === "empty") model.packet.work_package!.steps = [];
      if (fault === "missing") model.packet.work_package = null;
      if (fault === "assignment") model.assignment = null;
      await expect(loadSavedPlan(session, target, live(model))).rejects.toMatchObject({
        code: "saved_plan_unavailable",
      });
      expect(await hasSavedPlan(session, target)).toBe(false);
    },
  );

  it("refuses a typed response or package for another physical context", async () => {
    const model = typedFixture();
    model.work_package!.physical_context_id = "ANOTHER-FLOOR";
    await expect(loadSavedPlan(session, typedTarget, live(model))).rejects.toMatchObject({
      code: "saved_plan_unavailable",
    });
  });

  it("does not borrow the saved plan for another tenant, actor, worker mapping or paired device", async () => {
    await loadSavedPlan(session, target, live(savedPlanJobFixture()));
    for (const principal of [
      { ...session, tenant: { ...session.tenant, id: "foreign-tenant" } },
      { ...session, user: { ...session.user, id: "foreign-actor" } },
      { ...session, user: { ...session.user, frappe_user_id: "other@example.invalid" } },
    ]) {
      expect(await hasSavedPlan(principal, target)).toBe(false);
      await expect(loadSavedPlan(principal, target, disconnected())).rejects.toBeDefined();
    }
    await storeDeviceSecret("b".repeat(43));
    expect(await hasSavedPlan(session, target)).toBe(false);
    await expect(loadSavedPlan(session, target, disconnected())).rejects.toMatchObject({
      code: "saved_plan_context_changed",
    });
  });

  it("refuses a stored version altered without its acquired context receipt", async () => {
    await loadSavedPlan(session, target, live(savedPlanJobFixture()));
    const db = await getDatabase();
    const record = (await db.get("field_cache", savedPlanCacheKey(session, target)))!;
    (record.value as JobResponse).packet.work_package!.version += 1;
    await db.put("field_cache", record);
    await expect(loadSavedPlan(session, target, disconnected())).rejects.toMatchObject({
      code: "saved_plan_unavailable",
    });
  });

  it("invalidates an old saved plan when the fresh actual read has none; a denied read cannot revive it", async () => {
    await loadSavedPlan(session, target, live(savedPlanJobFixture()));
    const missing = savedPlanJobFixture();
    missing.packet.work_package = null;
    await expect(loadSavedPlan(session, target, live(missing))).rejects.toMatchObject({
      code: "saved_plan_unavailable",
    });
    await expect(loadSavedPlan(session, target, disconnected())).rejects.toMatchObject({
      code: "saved_plan_unavailable",
    });
    await loadSavedPlan(session, target, live(savedPlanJobFixture()));
    await expect(
      loadSavedPlan(
        session,
        target,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ error: "forbidden" }, { status: 403 })),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("prepares both kinds through their actual reads and never marks a missing plan saved", async () => {
    const model = savedPlanJobFixture();
    const today = {
      ...model,
      date: stamp,
      jobs: [
        {
          ...model.job,
          scheduled_start: null,
          scheduled_end: null,
          blocked_gate_count: 1,
          next_action: "Check work",
          assignment: model.assignment,
          active_stops: [],
        },
      ],
      work_objects: [
        {
          work_object_type: "Shop Order",
          work_object_id: "SHOP-SYNTHETIC",
          physical_context_type: "Shop Floor",
          physical_context_id: "FLOOR-SYNTHETIC",
          scheduled_start: null,
          scheduled_end: null,
          next_action: "Review work",
          assignment: model.assignment,
          active_stops: [],
        },
      ],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (path) =>
        Response.json(
          String(path).startsWith("/api/v1/jobs/")
            ? model
            : { ...typedFixture(), work_package: null },
        ),
      );
    const onPacket = vi.fn();
    const ready = await prefetchSavedPlans(session, today, { fetcher, concurrency: 1, onPacket });
    expect(Object.values(ready)).toEqual([true, false]);
    expect(onPacket).toHaveBeenCalledTimes(2);
  });

  it("rejects an old paired response before it can be exposed or saved under a changed context", async () => {
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = loadSavedPlan(session, target, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await storeDeviceSecret("b".repeat(43));
    finish(Response.json(savedPlanJobFixture()));
    await expect(pending).rejects.toMatchObject({ code: "saved_plan_context_changed" });
    expect(await hasSavedPlan(session, target)).toBe(false);
  });

  it.each([1, 2, 3, 4, 5])(
    "rejects credential changes at digest boundary %i, including the final cache validation",
    async (boundary) => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let calls = 0;
      vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
        calls += 1;
        const result = await digest(...args);
        if (calls === boundary) await storeDeviceSecret("b".repeat(43));
        return result;
      });
      await expect(
        loadSavedPlan(session, target, live(savedPlanJobFixture())),
      ).rejects.toMatchObject({ code: "saved_plan_context_changed" });
      expect(await hasSavedPlan(session, target)).toBe(false);
    },
  );

  it("rejects expiry while the live response is pending", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    session = await verifiedSavedPlanSessionFixture({
      session_expires_at: new Date(now + 100).toISOString(),
    });
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = loadSavedPlan(session, target, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    clock.mockReturnValue(now + 101);
    finish(Response.json(savedPlanJobFixture()));
    await expect(pending).rejects.toMatchObject({ code: "saved_plan_context_changed" });
  });

  it("rejects worker identity replacement while a response is pending", async () => {
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = loadSavedPlan(session, target, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    session.user.frappe_user_id = "replacement@example.invalid";
    finish(Response.json(savedPlanJobFixture()));
    await expect(pending).rejects.toMatchObject({ code: "saved_plan_context_changed" });
  });

  it("uses an offline session only for existing bound data and never mints through a new live request", async () => {
    await loadSavedPlan(session, target, live(savedPlanJobFixture()));
    const offline = await fetchSession(disconnected());
    if (!offline.authenticated) throw new Error("Expected the verified offline snapshot");
    const fetcher = live(savedPlanJobFixture());
    expect((await loadSavedPlan(offline, target, fetcher)).offline).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects context drift during the cache write and removes only that read's context receipt", async () => {
    const db = await getDatabase();
    const write = db.put.bind(db);
    let switched = false;
    vi.spyOn(db, "put").mockImplementation(async (...args) => {
      const result = await Reflect.apply(write, db, args);
      if (args[0] === "field_cache" && !switched) {
        switched = true;
        await storeDeviceSecret("b".repeat(43));
      }
      return result;
    });
    await expect(loadSavedPlan(session, target, live(savedPlanJobFixture()))).rejects.toMatchObject(
      { code: "saved_plan_context_changed" },
    );
    const record = await db.get("field_cache", savedPlanCacheKey(session, target));
    expect(record?.savedPlanBinding).toBeUndefined();
  });
});
