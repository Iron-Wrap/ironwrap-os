import { describe, expect, it } from "vitest";

import { formatFieldStamp } from "./field-formatting";

const alberta = { locale: "en-CA", timeZone: "America/Edmonton" };
const now = Date.parse("2026-10-20T20:30:00.000Z"); // 14:30 in Alberta

describe("formatFieldStamp", () => {
  it("says Today and the 24-hour time for a moment on the company's today", () => {
    expect(formatFieldStamp("2026-10-20T20:05:00.000Z", alberta, { now })).toBe("Today 14:05");
    expect(formatFieldStamp("2026-10-20T15:15:00.000Z", alberta, { now })).toBe("Today 09:15");
  });

  it("names the weekday, day and month on any other day, and never a year", () => {
    expect(formatFieldStamp("2026-10-19T20:05:00.000Z", alberta, { now })).toBe("Mon 19 Oct 14:05");
    expect(formatFieldStamp("2026-07-10T15:15:00.000Z", alberta, { now })).toBe("Fri 10 Jul 09:15");
    expect(formatFieldStamp("2025-07-10T15:15:00.000Z", alberta, { now })).not.toMatch(/2025/);
  });

  it("reads a.m. and p.m. on the crew phone's clock", () => {
    expect(formatFieldStamp("2026-10-20T20:05:00.000Z", alberta, { now, clock: "12h" })).toBe(
      "Today 2:05 p.m.",
    );
    expect(formatFieldStamp("2026-07-10T15:15:00.000Z", alberta, { now, clock: "12h" })).toBe(
      "Fri 10 Jul 9:15 a.m.",
    );
  });

  it("counts days in the company's zone, not the phone's", () => {
    // 01:30 UTC on the 21st is still the 20th in Alberta.
    expect(formatFieldStamp("2026-10-21T01:30:00.000Z", alberta, { now })).toBe("Today 19:30");
  });

  it("says so in words when the moment cannot be read", () => {
    expect(formatFieldStamp("not a time", alberta, { now })).toBe("time unavailable");
  });
});
