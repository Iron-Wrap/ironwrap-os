import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { storeDeviceSecret } from "../auth/device-credential";
import { resetDatabaseForTests } from "../storage/db";
import { hasCachedJobPacket, loadJob, prefetchAssignedPackets } from "./field-cache";
import type { JobResponse, TodayResponse } from "./field-contracts";

const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_field_user",
    email: "crew@example.com",
    display_name: "Crew",
    role: "field",
    frappe_user_id: "crew@example.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap OS",
    brand: "IronWrap",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:assigned"],
  allowed_actions: ["field.checkin.create"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-11T10:00:00.000Z",
  source_updated_at: "2026-07-10T10:00:00.000Z",
  read_model_generated_at: "2026-07-10T10:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const assignment = {
  id: "ASSIGN-A",
  assignment_id: "assignment_a",
  type: "Production",
  status: "Assigned",
  crew_profile: null,
  scheduled_start: "2026-07-10T10:00:00.000Z",
  scheduled_end: null,
  blocker_reason: null,
};

function today(jobIds: string[]): TodayResponse {
  return {
    version: 1,
    source_updated_at: "2026-07-10T10:00:00.000Z",
    read_model_generated_at: "2026-07-10T10:00:00.000Z",
    stale_fields: [],
    permissions: ["jobs:read:assigned"],
    allowed_actions: ["field.checkin.create"],
    date: "2026-07-10",
    jobs: jobIds.map((id) => ({
      id,
      job_number: id,
      brand: "ironwrap",
      status: "In Production",
      address: "10 Test Ave, Calgary AB",
      scheduled_start: "2026-07-10T10:00:00.000Z",
      scheduled_end: null,
      blocked_gate_count: 0,
      next_action: "Open field check-in",
      assignment: { ...assignment, id: `ASSIGN-${id}` },
    })),
    work_objects: [],
  };
}

function job(id: string): JobResponse {
  return {
    version: 1,
    source_updated_at: "2026-07-10T10:00:00.000Z",
    read_model_generated_at: "2026-07-10T10:00:00.000Z",
    stale_fields: ["packet.contact.access_instructions"],
    permissions: ["jobs:read:assigned"],
    allowed_actions: ["field.checkin.create"],
    job: {
      id,
      roof_job_id: id.toLowerCase(),
      job_number: id,
      brand: "ironwrap",
      service_type: "Roofing",
      status: "In Production",
      address: "10 Test Ave, Calgary AB",
      current_gate_state: "Ready",
    },
    assignment: { ...assignment, id: `ASSIGN-${id}` },
    gates: [],
    packet: {
      scope_clauses: [],
      measurements: [],
      materials: { takeoffs: [], supplier_orders: [] },
      change_orders: [],
      safety_plan: null,
      contact: { display_name: "Homeowner", phone: "+14035550123", access_instructions: null },
      work_package: null,
    },
    proof_stream: [],
    proof_page: { next_cursor: null, page_size: 100 },
    required_proof: [],
  };
}

describe("field packet cache", () => {
  afterEach(async () => {
    await resetDatabaseForTests();
    vi.restoreAllMocks();
  });

  it("prefetches every Today job with bounded concurrency and opens it offline without a manual visit", async () => {
    let active = 0;
    let peak = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "https://app.example.com",
      );
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      return Response.json(job(id));
    });
    const models = today(["JOB-A", "JOB-B", "JOB-C", "JOB-D"]);
    const readiness = await prefetchAssignedPackets(session, models, { fetcher, concurrency: 2 });
    expect(readiness).toEqual({ "JOB-A": true, "JOB-B": true, "JOB-C": true, "JOB-D": true });
    expect(peak).toBeLessThanOrEqual(2);
    expect(await hasCachedJobPacket(session, "JOB-C")).toBe(true);

    const offlineFetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    const packet = await loadJob(session, "JOB-C", offlineFetcher);
    expect(packet.job.id).toBe("JOB-C");
    expect(packet.stale_fields).toContain("offline.cached_packet");
  });

  it("does not claim offline readiness when a packet has never been cached", async () => {
    const offlineFetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    await expect(loadJob(session, "JOB-Z", offlineFetcher)).rejects.toMatchObject({
      code: "offline_packet_unavailable",
    });
    expect(await hasCachedJobPacket(session, "JOB-Z")).toBe(false);
  });

  it("keeps a legacy cached packet without a Work Package readable but not authorized", async () => {
    const current = job("JOB-LEGACY");
    const { work_package: _workPackage, ...legacyPacket } = current.packet;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...current, packet: legacyPacket }));

    const online = await loadJob(session, "JOB-LEGACY", fetcher);
    expect(online.packet.work_package).toBeNull();

    const offline = await loadJob(
      session,
      "JOB-LEGACY",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")),
    );
    expect(offline.packet.work_package).toBeNull();
    expect(offline.stale_fields).toContain("offline.cached_packet");
  });

  it("sends the current device proof for every field packet request without caching it in the packet", async () => {
    await storeDeviceSecret("p".repeat(43));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-IronWrap-Device-Proof")).toBe("p".repeat(43));
      return Response.json(job("JOB-PROOF"));
    });

    await loadJob(session, "JOB-PROOF", fetcher);
    const cached = await loadJob(
      session,
      "JOB-PROOF",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")),
    );
    expect(JSON.stringify(cached)).not.toContain("p".repeat(43));
  });
});
