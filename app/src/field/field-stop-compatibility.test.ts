import { afterEach, describe, expect, it, vi } from "vitest";

import { fieldBootstrapResponseSchema } from "../auth/field-bootstrap";
import type { AuthenticatedSession } from "../auth/session";
import { resetDatabaseForTests } from "../storage/db";
import { loadJob, loadToday, loadWorkObject } from "./field-cache";
import {
  jobResponseSchema,
  todayResponseSchema,
  workObjectResponseSchema,
} from "./field-contracts";

const envelope = {
  version: 1 as const,
  source_updated_at: null,
  read_model_generated_at: "2026-07-10T16:00:00Z",
  stale_fields: [] as string[],
  permissions: [],
  allowed_actions: [],
};
const session = {
  ...envelope,
  authenticated: true,
  user: {
    id: "crew-stop-seam",
    email: "crew@example.invalid",
    display_name: "Synthetic crew",
    role: "field",
    frappe_user_id: null,
  },
  tenant: {
    id: "stop-seam",
    name: "Synthetic tenant",
    brand: "Synthetic",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  csrf_token: "synthetic-csrf",
  session_expires_at: "2030-07-10T16:00:00Z",
} satisfies AuthenticatedSession;
const holdingStop = {
  occurrence_id: "unresolved-tenant-stop",
  scope: "tenant",
  reported_at: "2026-07-10T15:00:00Z",
  summary: "Synthetic unresolved safety hold",
  raiser_display_name: null,
};
const scope = {
  workObjectType: "Service Work Order",
  workObjectId: "SERVICE-SEAM",
  physicalContextType: "Building",
  physicalContextId: "BUILDING-SEAM",
};
const projection = (value: unknown) => (value === undefined ? {} : { active_stops: value });
function jobRead(value: unknown, stale_fields: string[] = []) {
  return {
    ...envelope,
    stale_fields,
    job: {
      id: "JOB-SEAM",
      roof_job_id: null,
      job_number: null,
      brand: null,
      service_type: null,
      status: null,
      address: null,
      current_gate_state: null,
      ...projection(value),
    },
    assignment: null,
    gates: [],
    packet: {
      scope_clauses: [],
      measurements: [],
      materials: { takeoffs: [], supplier_orders: [] },
      change_orders: [],
      safety_plan: null,
      contact: null,
      work_package: null,
    },
    proof_stream: [],
    proof_page: { next_cursor: null, page_size: 100 },
    required_proof: [],
  };
}
function todayRead(value: unknown, stale_fields: string[] = []) {
  const assignment = {
    scheduled_start: null,
    scheduled_end: null,
    next_action: "Read the synthetic plan",
    assignment: null,
    ...projection(value),
  };
  return {
    ...envelope,
    stale_fields,
    date: "2026-07-10",
    jobs: [{ ...jobRead(value).job, ...assignment, blocked_gate_count: 0 }],
    work_objects: [
      {
        ...assignment,
        work_object_type: scope.workObjectType,
        work_object_id: scope.workObjectId,
        physical_context_type: scope.physicalContextType,
        physical_context_id: scope.physicalContextId,
      },
    ],
  };
}
function typedRead(value: unknown, stale_fields: string[] = []) {
  return {
    ...envelope,
    stale_fields,
    work_object: scope,
    assignment: null,
    work_package: null,
    ...projection(value),
  };
}
const answer = (value: unknown) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
const offline = () => vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));

afterEach(async () => {
  await resetDatabaseForTests();
});

describe("PR74 holding-stop read compatibility", () => {
  const states = [
    {
      name: "known tenant hold",
      input: [holdingStop],
      expected: [holdingStop],
      unavailable: false,
    },
    { name: "successful empty", input: [], expected: [], unavailable: false },
    { name: "failed projection", input: null, expected: null, unavailable: true },
    { name: "legacy absence", input: undefined, expected: null, unavailable: false },
  ];
  it.each(states)(
    "preserves $name in nested job, Today, bootstrap and typed schemas",
    ({ input, expected, unavailable }) => {
      const job = jobResponseSchema.parse(
        jobRead(input, unavailable ? ["job.active_stops_unavailable"] : []),
      );
      expect(job.job.active_stops).toEqual(expected);
      expect(job.stale_fields).toEqual(unavailable ? ["job.active_stops_unavailable"] : []);
      const today = todayRead(input, unavailable ? ["jobs.active_stops_unavailable"] : []);
      for (const parsed of [
        todayResponseSchema.parse(today),
        fieldBootstrapResponseSchema.parse({ version: 1, session, today }).today!,
      ]) {
        expect(parsed.jobs[0]!.active_stops).toEqual(expected);
        expect(parsed.work_objects[0]!.active_stops).toEqual(expected);
        expect(parsed.stale_fields).toEqual(today.stale_fields);
      }
      const typed = typedRead(input, unavailable ? ["work_object.active_stops_unavailable"] : []);
      expect(workObjectResponseSchema.parse(typed).active_stops).toEqual(expected);
    },
  );

  it("retains malformed optional stop entries conservatively without hiding the packet", () => {
    const malformed = { occurrence_id: "partly-readable-stop", scope: "tenant", summary: 42 };
    for (const model of [
      jobResponseSchema.parse(jobRead([malformed])).job,
      todayResponseSchema.parse(todayRead([malformed])).jobs[0]!,
      todayResponseSchema.parse(todayRead([malformed])).work_objects[0]!,
      workObjectResponseSchema.parse(typedRead([malformed])),
    ]) {
      expect(model.active_stops).toEqual([
        { ...holdingStop, occurrence_id: "partly-readable-stop", reported_at: "", summary: null },
      ]);
    }
    expect(
      workObjectResponseSchema.parse(typedRead({ unexpected: true })).active_stops,
    ).toHaveLength(1);
  });

  it.each(states)(
    "keeps $name through real job/Today/typed loaders and saved reads",
    async ({ input, expected, unavailable }) => {
      const job = await loadJob(
        session,
        "JOB-SEAM",
        answer(jobRead(input, unavailable ? ["job.active_stops_unavailable"] : [])),
      );
      const today = await loadToday(
        session,
        answer(todayRead(input, unavailable ? ["jobs.active_stops_unavailable"] : [])),
      );
      const typed = await loadWorkObject(
        session,
        scope,
        answer(typedRead(input, unavailable ? ["work_object.active_stops_unavailable"] : [])),
      );
      expect(job.job.active_stops).toEqual(expected);
      expect(today.jobs[0]!.active_stops).toEqual(expected);
      expect(today.work_objects[0]!.active_stops).toEqual(expected);
      expect(typed.active_stops).toEqual(expected);
      expect(typed.stale_fields).not.toContain("offline.cached_packet");
      const savedJob = await loadJob(session, "JOB-SEAM", offline());
      const savedToday = await loadToday(session, offline());
      const savedTyped = await loadWorkObject(session, scope, offline());
      expect(savedJob.job.active_stops).toEqual(expected);
      expect(savedToday.jobs[0]!.active_stops).toEqual(expected);
      expect(savedToday.work_objects[0]!.active_stops).toEqual(expected);
      expect(savedTyped.active_stops).toEqual(expected);
      for (const saved of [savedJob, savedToday, savedTyped])
        expect(saved.stale_fields).toContain("offline.cached_packet");
      if (unavailable)
        expect(savedTyped.stale_fields).toContain("work_object.active_stops_unavailable");
    },
  );

  it("returns a fresh partial typed read instead of rejecting it or substituting a saved known list", async () => {
    await loadWorkObject(session, scope, answer(typedRead([holdingStop])));
    const fresh = await loadWorkObject(
      session,
      scope,
      answer({
        ...typedRead(null, ["work_object.active_stops_unavailable"]),
        read_model_generated_at: "2026-07-10T17:00:00Z",
      }),
    );
    expect(fresh.active_stops).toBeNull();
    expect(fresh.read_model_generated_at).toBe("2026-07-10T17:00:00Z");
    expect(fresh.stale_fields).toEqual(["work_object.active_stops_unavailable"]);
    const saved = await loadWorkObject(session, scope, offline());
    expect(saved.active_stops).toBeNull();
    expect(saved.stale_fields).toEqual([
      "work_object.active_stops_unavailable",
      "offline.cached_packet",
    ]);
  });
});
