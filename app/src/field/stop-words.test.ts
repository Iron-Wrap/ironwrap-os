import { describe, expect, it } from "vitest";

import { crewStopStamp, stopDetail, uniqueStops } from "./stop-words";

const zone = { timeZone: "America/Edmonton" };

describe("stop words", () => {
  it("stamps a stop from today as Today, and another day by weekday and date", () => {
    const now = new Date("2026-07-10T20:00:00.000Z");
    expect(crewStopStamp("2026-07-10T16:24:00.000Z", zone, now)).toBe("Today 10:24 a.m.");
    expect(crewStopStamp("2026-07-09T22:05:00.000Z", zone, now)).toBe("Thu 9 Jul 4:05 p.m.");
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
    expect(stopDetail(stop, zone, now)).toBe(
      "Tom Lachance stopped it · Today 10:24 a.m. · Ice on the north slope",
    );
    expect(stopDetail({ ...stop, summary: null, raiser_display_name: " " }, zone, now)).toBe(
      "Today 10:24 a.m.",
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
});
