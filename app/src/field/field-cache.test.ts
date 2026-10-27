import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { storeDeviceSecret } from "../auth/device-credential";
import { resetDatabaseForTests } from "../storage/db";
import {
  hasCachedJobPacket,
  loadFieldMeasurementPage,
  loadJob,
  loadOfficeContact,
  loadToday,
  loadWorkObject,
  prefetchAssignedPackets,
} from "./field-cache";
import type { JobResponse, TodayResponse, WorkObjectResponse } from "./field-contracts";

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
      next_action: "Add job proof",
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

  it("rejects malformed nested proof without replacing the verified offline packet", async () => {
    const packet = job("JOB-VALIDATED");
    packet.proof_stream = [
      {
        id: "EV-TEST",
        type: "Photo",
        proof_slot: null,
        occurred_at: null,
        summary: null,
        customer_safe: false,
        source: null,
        sync_state: "verified",
        blocker: false,
      },
    ];
    const online = await loadJob(
      session,
      packet.job.id,
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(packet)),
    );
    expect(online.proof_stream).toEqual(packet.proof_stream);

    const malformed = {
      ...packet,
      proof_stream: [{ ...packet.proof_stream[0], blocker: "false" }],
    };
    await expect(
      loadJob(
        session,
        packet.job.id,
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(malformed)),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });

    const offline = await loadJob(
      session,
      packet.job.id,
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")),
    );
    expect(offline.proof_stream).toEqual(packet.proof_stream);
    expect(offline.stale_fields).toContain("offline.cached_packet");
    expect(await hasCachedJobPacket(session, packet.job.id)).toBe(true);
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

  it("keeps the office contact of the newest job read for screens that carry none", async () => {
    const answer = (model: JobResponse) =>
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(model));
    expect(await loadOfficeContact(session)).toBeNull();

    // An older Worker sends no contact: the phone learns nothing.
    await loadJob(session, "JOB-A", answer(job("JOB-A")));
    expect(await loadOfficeContact(session)).toBeNull();

    const office = { phone: "+14035550100", email: "office@example.invalid" };
    await loadJob(
      session,
      "JOB-A",
      answer({
        ...job("JOB-A"),
        office_contact: office,
        read_model_generated_at: "2026-07-10T11:00:00.000Z",
      }),
    );
    expect(await loadOfficeContact(session)).toEqual({
      contact: office,
      synced_at: "2026-07-10T11:00:00.000Z",
    });

    // A failed profile read says nothing about the contact, so the known one stays.
    await loadJob(
      session,
      "JOB-B",
      answer({
        ...job("JOB-B"),
        office_contact: null,
        stale_fields: ["office_contact.unavailable"],
      }),
    );
    expect((await loadOfficeContact(session))?.contact).toEqual(office);

    // The owner removed the contact: the phone forgets it.
    await loadJob(
      session,
      "JOB-B",
      answer({
        ...job("JOB-B"),
        office_contact: null,
        read_model_generated_at: "2026-07-10T12:00:00.000Z",
      }),
    );
    expect((await loadOfficeContact(session))?.contact).toBeNull();

    // A cached packet read offline never writes it.
    const offlineFetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    await loadJob(session, "JOB-A", offlineFetcher);
    expect((await loadOfficeContact(session))?.contact).toBeNull();
  });

  it("keeps the contact of the read generated last when reads finish out of order", async () => {
    const answer = (model: JobResponse) =>
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(model));
    const newer = { phone: "+14035550199", email: null };
    const older = { phone: "+14035550100", email: "office@example.invalid" };
    await loadJob(
      session,
      "JOB-A",
      answer({
        ...job("JOB-A"),
        office_contact: newer,
        read_model_generated_at: "2026-07-10T12:00:00.000Z",
      }),
    );
    await loadJob(
      session,
      "JOB-B",
      answer({
        ...job("JOB-B"),
        office_contact: older,
        read_model_generated_at: "2026-07-10T11:00:00.000Z",
      }),
    );
    expect(await loadOfficeContact(session)).toEqual({
      contact: newer,
      synced_at: "2026-07-10T12:00:00.000Z",
    });

    // A removal reported by an older read does not undo the newer contact either.
    await loadJob(
      session,
      "JOB-B",
      answer({
        ...job("JOB-B"),
        office_contact: null,
        read_model_generated_at: "2026-07-10T11:30:00.000Z",
      }),
    );
    expect((await loadOfficeContact(session))?.contact).toEqual(newer);
  });

  it("settles two reads generated at the same instant the same way in either order", async () => {
    const first = { phone: "+14035550100", email: null };
    const second = { phone: null, email: "office@example.invalid" };
    const settle = async (contacts: (typeof first | typeof second)[]) => {
      await resetDatabaseForTests();
      for (const office_contact of contacts) {
        await loadJob(
          session,
          "JOB-A",
          vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
              ...job("JOB-A"),
              office_contact,
              read_model_generated_at: "2026-07-10T12:00:00.000Z",
            }),
          ),
        );
      }
      return (await loadOfficeContact(session))?.contact;
    };
    expect(await settle([first, second])).toEqual(await settle([second, first]));
  });

  it("keeps a job whose office contact is malformed, with the last good contact", async () => {
    const office = { phone: "+14035550100", email: "office@example.invalid" };
    await loadJob(
      session,
      "JOB-A",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          ...job("JOB-A"),
          office_contact: office,
          read_model_generated_at: "2026-07-10T11:00:00.000Z",
        }),
      ),
    );
    const model = await loadJob(
      session,
      "JOB-B",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          ...job("JOB-B"),
          office_contact: { phone: "403-555-0100", email: null },
          read_model_generated_at: "2026-07-10T12:00:00.000Z",
        }),
      ),
    );
    expect(model.job.id).toBe("JOB-B");
    expect(model.office_contact).toBeUndefined();
    expect(model.stale_fields).toEqual([
      "packet.contact.access_instructions",
      "office_contact.unavailable",
    ]);
    expect(await loadOfficeContact(session)).toEqual({
      contact: office,
      synced_at: "2026-07-10T11:00:00.000Z",
    });
  });

  it("returns the fresh job when keeping its office contact fails", async () => {
    await loadJob(
      session,
      "JOB-A",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(job("JOB-A"))),
    );
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if ((value as { key?: string }).key?.endsWith(":office-contact")) {
        throw new DOMException("The phone is out of space.", "QuotaExceededError");
      }
      return put.call(this, value, key);
    });

    const model = await loadJob(
      session,
      "JOB-A",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          ...job("JOB-A"),
          source_updated_at: "2026-07-10T12:00:00.000Z",
          office_contact: { phone: "+14035550100", email: null },
        }),
      ),
    );
    expect(model.source_updated_at).toBe("2026-07-10T12:00:00.000Z");
    expect(model.stale_fields).not.toContain("offline.cached_packet");
    expect(model.office_contact).toEqual({ phone: "+14035550100", email: null });
    expect(await loadOfficeContact(session)).toBeNull();
  });
});

/** Makes IndexedDB refuse to store any field-cache record whose key ends with `suffix`. */
function failCachePuts(matches: (key: string) => boolean) {
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    const recordKey = (value as { key?: string }).key;
    if (recordKey && matches(recordKey)) {
      throw new DOMException("The phone is out of space.", "QuotaExceededError");
    }
    return put.call(this, value, key);
  });
}

function workObject(): WorkObjectResponse {
  return {
    version: 1,
    source_updated_at: "2026-07-10T10:00:00.000Z",
    read_model_generated_at: "2026-07-10T10:00:00.000Z",
    stale_fields: [],
    permissions: ["jobs:read:assigned"],
    allowed_actions: [],
    work_object: {
      workObjectType: "Roof Job",
      workObjectId: "JOB-A",
      physicalContextType: "Roof Site",
      physicalContextId: "SITE-A",
    },
    assignment: null,
    work_package: null,
  };
}

describe("a live read this phone cannot keep", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDatabaseForTests();
  });

  const fresh = "2026-07-10T12:00:00.000Z";
  const answer = (model: unknown) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(model));

  it("shows the fresh Today list, marked not saved, instead of an older copy or an error", async () => {
    await loadToday(session, answer(today(["JOB-OLD"])));
    failCachePuts((key) => key.endsWith(":today"));

    const model = await loadToday(
      session,
      answer({ ...today(["JOB-NEW"]), source_updated_at: fresh }),
    );
    expect(model.jobs.map((job) => job.id)).toEqual(["JOB-NEW"]);
    expect(model.stale_fields).toEqual(["offline.not_saved"]);
  });

  it("shows the fresh job, marked not saved, and still keeps its office contact", async () => {
    await loadJob(session, "JOB-A", answer(job("JOB-A")));
    failCachePuts((key) => key.endsWith(":job:JOB-A"));
    const office = { phone: "+14035550100", email: null };

    const model = await loadJob(
      session,
      "JOB-A",
      answer({ ...job("JOB-A"), source_updated_at: fresh, office_contact: office }),
    );
    expect(model.source_updated_at).toBe(fresh);
    expect(model.stale_fields).toContain("offline.not_saved");
    expect(model.stale_fields).not.toContain("offline.cached_packet");
    expect((await loadOfficeContact(session))?.contact).toEqual(office);
  });

  it("shows the fresh work plan, marked not saved", async () => {
    failCachePuts((key) => key.includes(":work-object:"));
    const scope = workObject().work_object;

    const model = await loadWorkObject(
      session,
      scope,
      answer({ ...workObject(), source_updated_at: fresh }),
    );
    expect(model.source_updated_at).toBe(fresh);
    expect(model.stale_fields).toEqual(["offline.not_saved"]);
  });

  it("does not count a job the phone could not keep as saved for offline use", async () => {
    failCachePuts((key) => key.endsWith(":job:JOB-B"));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        Response.json(job(String(input).endsWith("JOB-A") ? "JOB-A" : "JOB-B")),
      );
    const onPacket = vi.fn();

    const result = await prefetchAssignedPackets(session, today(["JOB-A", "JOB-B"]), {
      fetcher,
      onPacket,
    });
    expect(result).toEqual({ "JOB-A": true, "JOB-B": false });
    expect(onPacket).toHaveBeenCalledWith(
      "JOB-B",
      false,
      expect.objectContaining({ job: expect.objectContaining({ id: "JOB-B" }) }),
    );
    expect(await hasCachedJobPacket(session, "JOB-B")).toBe(false);
  });
});

describe("crew tape readings", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDatabaseForTests();
  });

  const reading = {
    checkin_id: "CHK-TEST-1",
    device_action_id: "device-action-0001",
    assignment_id: "ASSIGN-JOB-A",
    measurement: {
      feet: 12,
      inches: 3,
      eighths: 5,
      area_label: "north valley",
      total_eighth_inches: 12 * 96 + 3 * 8 + 5,
    },
    captured_at: "2026-07-10T11:00:00.000Z",
    recorded_by: "appu_field_test",
    recorded_by_name: null,
    device_id: "device-test-1",
    correction_of: null,
    correction_reason: null,
    superseded_by: null,
    work_package_id: null,
    work_package_version: null,
    evidence_slot_id: null,
    evidence_item_correction_of: null,
    work_package_release_attempt_id: null,
    allowed_actions: [],
    correction_target: null,
  };

  it("keeps a job's readings with its packet, offline too", async () => {
    await loadJob(
      session,
      "JOB-A",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ ...job("JOB-A"), field_measurements: [reading] })),
    );
    const offline = await loadJob(
      session,
      "JOB-A",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")),
    );
    expect(offline.field_measurements).toEqual([reading]);
    expect(offline.stale_fields).toContain("offline.cached_packet");
  });

  it("never lets a reading it cannot vouch for hide the job", async () => {
    const model = await loadJob(
      session,
      "JOB-A",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          ...job("JOB-A"),
          field_measurements: [
            { ...reading, measurement: { ...reading.measurement, total_eighth_inches: 1 } },
          ],
        }),
      ),
    );
    expect(model.job.id).toBe("JOB-A");
    expect(model.field_measurements).toEqual([]);
    expect(model.stale_fields).toContain("field_measurements.native_unavailable");
  });

  it("asks for the first page plainly and a later page by its cursor", async () => {
    const page = {
      version: 1,
      source_updated_at: null,
      read_model_generated_at: "2026-07-10T12:00:00.000Z",
      stale_fields: [],
      permissions: ["jobs:read:assigned"],
      allowed_actions: [],
      items: [reading],
      page_size: 100,
      next_cursor: null,
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(page));
    expect((await loadFieldMeasurementPage(session, "JOB A/1", null, fetcher)).items).toEqual([
      reading,
    ]);
    await loadFieldMeasurementPage(session, "JOB A/1", "abc+/=", fetcher);
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/jobs/JOB%20A%2F1/field-measurements",
      "/api/v1/jobs/JOB%20A%2F1/field-measurements?cursor=abc%2B%2F%3D",
    ]);
  });
});
