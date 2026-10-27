import { describe, expect, it } from "vitest";

import {
  dayLabel,
  instantFromLocal,
  localInputValue,
  officeStamp,
  proseTime,
  spanDays,
  windowDeadline,
} from "./gate-time";

const zone = "America/Edmonton";
const now = new Date("2026-10-21T16:45:00.000Z"); // Wed 21 Oct 10:45 in Edmonton

describe("office times on the gate screens", () => {
  it("stamps the same day as Today and any other day with its weekday, day and month, 24-hour", () => {
    expect(officeStamp("2026-10-21T14:40:00.000Z", { timeZone: zone, now })).toBe("Today 08:40");
    expect(officeStamp("2026-10-21T00:20:00.000Z", { timeZone: zone, now })).toBe(
      "Tue 20 Oct 18:20",
    );
    // 00:26 UTC on the 22nd is still the 21st in Edmonton: the business day decides.
    expect(officeStamp("2026-10-22T00:26:00.000Z", { timeZone: zone, now })).toBe("Today 18:26");
    expect(officeStamp(null, { timeZone: zone, now })).toBeNull();
    expect(officeStamp("not a time", { timeZone: zone, now })).toBeNull();
  });

  it("writes a time inside a sentence as today at, never a bare weekday", () => {
    expect(proseTime("2026-10-21T15:05:00.000Z", { timeZone: zone, now })).toBe("today at 09:05");
    expect(proseTime("2026-10-21T00:10:00.000Z", { timeZone: zone, now })).toBe("Tue 20 Oct 18:10");
  });

  it("reads the window's last day as a day, from last_day and never from the hold's end", () => {
    expect(dayLabel("2026-10-30")).toBe("Fri 30 Oct");
    expect(dayLabel("2026-02-30")).toBeNull();
    expect(
      windowDeadline(
        {
          last_day: "2026-10-30",
          ends_at: "2026-10-31T07:00:00.000Z",
          ends_on_calendar_day: true,
          time_zone: zone,
        },
        now,
      ),
    ).toEqual({ kind: "day", label: "Fri 30 Oct" });
  });

  it("shows the exact end only when the hold does not end with the last day", () => {
    expect(
      windowDeadline(
        {
          last_day: "2026-10-30",
          ends_at: "2026-11-01T08:00:00.000Z",
          ends_on_calendar_day: false,
          time_zone: zone,
        },
        now,
      ),
    ).toEqual({ kind: "exact", label: "Sun 1 Nov 02:00" });
    expect(
      windowDeadline(
        { last_day: null, ends_at: null, ends_on_calendar_day: null, time_zone: zone },
        now,
      ),
    ).toEqual({ kind: "none" });
  });

  it("turns a wall time typed in the business zone into the instant it names, with its offset", () => {
    expect(instantFromLocal("2026-10-20T18:26", zone)).toEqual({
      iso: "2026-10-21T00:26:00.000Z",
      withOffset: "2026-10-20T18:26:00-06:00",
    });
    expect(instantFromLocal("2026-10-20", zone)).toBeNull();
    expect(localInputValue("2026-10-21T00:26:00.000Z", zone)).toBe("2026-10-20T18:26");
  });

  it("counts a work window's days with its first and last day", () => {
    expect(spanDays("2026-11-03T13:00:00.000Z", "2026-11-04T23:00:00.000Z", zone)).toBe(2);
    expect(spanDays("2026-11-04T23:00:00.000Z", "2026-11-03T13:00:00.000Z", zone)).toBeNull();
  });
});
