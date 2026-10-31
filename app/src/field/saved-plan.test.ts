import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { storeDeviceSecret } from "../auth/device-credential";
import { getDatabase, resetDatabaseForTests } from "../storage/db";
import { cacheFieldModel, loadJob } from "./field-cache";
import type { JobResponse, WorkObjectResponse } from "./field-contracts";
import { hasSavedPlan, loadSavedPlan, prefetchSavedPlans } from "./saved-plan";
import { savedPlanCacheKey, type SavedPlanTarget } from "./saved-plan-context";

const stamp = new Date(0).toISOString();
const session: AuthenticatedSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_synthetic_crew",
    email: "crew@example.invalid",
    display_name: "Synthetic crew",
    role: "field",
    frappe_user_id: "crew@example.invalid",
  },
  tenant: {
    id: "synthetic-tenant",
    name: "Synthetic tenant",
    brand: "Synthetic",
    locale: "en-CA",
    time_zone: "UTC",
    currency: "CAD",
  },
  permissions: ["jobs:read:assigned"],
  allowed_actions: ["field.checkin.create"],
  csrf_token: "synthetic-csrf",
  session_expires_at: stamp,
  source_updated_at: stamp,
  read_model_generated_at: stamp,
  stale_fields: [],
};
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

function savedPlanJobFixture(): JobResponse {
  return {
    version: 1,
    source_updated_at: stamp,
    read_model_generated_at: stamp,
    stale_fields: [],
    permissions: ["jobs:read:assigned"],
    allowed_actions: [
      "field.checkin.create",
      "work_package.acknowledge",
      "work_package.start",
      "work_package.complete",
    ],
    job: {
      id: "JOB-SYNTHETIC",
      roof_job_id: null,
      job_number: "IW-SYNTHETIC",
      brand: "Synthetic",
      service_type: "Roofing",
      status: "In Production",
      address: "Synthetic training site",
      current_gate_state: "Blocked",
    },
    assignment: {
      id: "ASSIGN-SYNTHETIC",
      assignment_id: "assignment-synthetic",
      type: "Production",
      status: "Assigned",
      crew_profile: null,
      scheduled_start: null,
      scheduled_end: null,
      blocker_reason: null,
    },
    gates: [
      {
        id: "CHECK-SYNTHETIC",
        name: "Independent work check",
        state: "Blocked",
        blocker_reason: "Office evidence pending",
        owner: "Synthetic office",
        due_at: null,
      },
    ],
    packet: {
      scope_clauses: [],
      measurements: [],
      materials: { takeoffs: [], supplier_orders: [] },
      change_orders: [],
      safety_plan: null,
      contact: null,
      work_package: {
        id: "WP-SYNTHETIC",
        version: 7,
        status: "Blocked",
        title: "Synthetic released work instructions",
        objective: "Inspect the synthetic work area",
        boundaries: "Training area only",
        prerequisites: "Inspect controls before access",
        expected_result: "Recorded inspection",
        stop_conditions: "Stop if the boundary is unsafe",
        make_safe_procedure: "Secure the training area and contact the office",
        issued_at: stamp,
        released_at: stamp,
        expires_at: stamp,
        work_object_type: "Roof Job",
        work_object_id: "JOB-SYNTHETIC",
        physical_context_type: "Roof Site",
        physical_context_id: "JOB-SYNTHETIC",
        release_attempt_id: "release-synthetic-7",
        supersession: null,
        acknowledgement: { current_user_acknowledged: false, acknowledged_at: null, workers: [] },
        evidence_slots: [],
        steps: [
          {
            sequence: 1,
            instruction: "Inspect the synthetic anchor",
            required_evidence: "Synthetic anchor record",
            acceptance_criteria: "The control is present",
          },
        ],
        hold_points: [
          {
            sequence: 1,
            hold_point: "Office control review",
            release_phase: "Pre-start",
            release_authority: "Office",
            required_evidence: "Verified control record",
            acceptance_criteria: "Office verifies the control",
            released: false,
          },
        ],
      },
    },
    proof_stream: [],
    proof_page: { next_cursor: null, page_size: 100 },
    required_proof: [],
  };
}

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
      code: "saved_plan_unavailable",
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
});
