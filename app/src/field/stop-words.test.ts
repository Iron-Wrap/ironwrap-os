import { describe, expect, it } from "vitest";

import { todayResponseSchema } from "./field-contracts";
import { crewStopStamp, STOP_WORDS, stopDetail, uniqueStops } from "./stop-words";

const zone = { timeZone: "America/Edmonton" };

describe("stop words", () => {
  it("stamps a stop from today as Today, and another day by weekday and date", () => {
    const now = new Date("2026-07-10T20:00:00.000Z");
    expect(crewStopStamp("2026-07-10T16:24:00.000Z", zone, now)).toMatch(/^Today 10:24\sa\.m\.$/);
    expect(crewStopStamp("2026-07-09T22:05:00.000Z", zone, now)).toMatch(
      /^Thu 9 Jul 4:05\sp\.m\.$/,
    );
    // The company's day, not UTC's: 5:30 p.m. and 8:00 p.m. Thursday in Calgary fall on two UTC days.
    expect(
      crewStopStamp("2026-07-09T23:30:00.000Z", zone, new Date("2026-07-10T02:00:00.000Z")),
    ).toMatch(/^Today 5:30\sp\.m\.$/);
    expect(crewStopStamp("2026-07-10T16:24:00.000Z", { timeZone: "Not/AZone" }, now)).toBeNull();
    expect(crewStopStamp("not a time", zone, now)).toBeNull();
  });

  it("says who stopped it, when and why, leaving out what the read lacks", () => {
    const now = new Date("2026-07-10T20:00:00.000Z");
    const stop = {
      occurrence_id: "so_1",
      scope: "job" as const,
      reported_at: "2026-07-10T16:24:00.000Z",
      summary: "Ice on the north slope",
      raiser_display_name: "Tom Lachance",
    };
    expect(stopDetail(stop, zone, now)).toMatch(
      /^Stopped today at 10:24\sa\.m\. by Tom Lachance · Ice on the north slope$/,
    );
    expect(stopDetail({ ...stop, summary: null, raiser_display_name: " " }, zone, now)).toMatch(
      /^Stopped today at 10:24\sa\.m\.$/,
    );
    expect(stopDetail({ ...stop, reported_at: "2026-07-09T22:05:00.000Z" }, zone, now)).toMatch(
      /^Stopped on Thu 9 Jul at 4:05\sp\.m\. by Tom Lachance/,
    );
  });

  it("lists each stop once, oldest first", () => {
    const a = {
      occurrence_id: "a",
      scope: "tenant" as const,
      reported_at: "2026-07-10T16:00:00Z",
      summary: null,
      raiser_display_name: null,
    };
    const b = { ...a, occurrence_id: "b", reported_at: "2026-07-10T15:00:00Z" };
    expect(uniqueStops([[a, b], [a]]).map((stop) => stop.occurrence_id)).toEqual(["b", "a"]);
  });

  it("reads every stop on a run sheet, never failing the run sheet for one it cannot read", () => {
    const job = {
      id: "JOB-1",
      job_number: "IW-1",
      brand: null,
      status: null,
      address: null,
      scheduled_start: null,
      scheduled_end: null,
      blocked_gate_count: 0,
      next_action: "Open job",
      assignment: null,
    };
    const envelope = {
      version: 1,
      authenticated: true,
      user: {},
      tenant: {},
      source_updated_at: null,
      read_model_generated_at: "2026-07-10T12:00:00.000Z",
      stale_fields: [],
      permissions: [],
      allowed_actions: [],
      date: "2026-07-10",
      work_objects: [],
    };
    const read = (stops: unknown) =>
      todayResponseSchema.safeParse({ ...envelope, jobs: [{ ...job, active_stops: stops }] });
    const good = {
      occurrence_id: "so_1",
      scope: "elsewhere",
      reported_at: "2026-07-10T16:24:00.000Z",
      summary: null,
      raiser_display_name: null,
    };
    const both = read([good, { occurrence_id: "so_2", scope: "tenant" }]);
    expect(both.success).toBe(true);
    expect(both.data?.jobs[0]?.active_stops).toEqual([
      { ...good, scope: "job" },
      {
        occurrence_id: "so_2",
        scope: "tenant",
        reported_at: "",
        summary: null,
        raiser_display_name: null,
      },
    ]);
    expect(read(null).data?.jobs[0]?.active_stops).toEqual([]);
    expect(read(undefined).data?.jobs[0]?.active_stops).toEqual([]);
    expect(read([42]).data?.jobs[0]?.active_stops[0]?.occurrence_id).toBe("unreadable_0");
    // A single stop sent without its list is still a stop, never dropped.
    expect(read(good).data?.jobs[0]?.active_stops).toEqual([{ ...good, scope: "job" }]);
    expect(read("stopped").data?.jobs[0]?.active_stops).toHaveLength(1);
  });

  it("words a separate work check without a doubled period or a next step as its name", () => {
    expect(STOP_WORDS.separateCheck("Delivery confirmation is missing.")).toBe(
      "Separate work check: Delivery confirmation is missing. Clearing it doesn't restart work.",
    );
    expect(STOP_WORDS.separateCheck(null)).toBe(
      "A separate work check is open. Clearing it doesn't restart work.",
    );
  });
});
