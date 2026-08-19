import { describe, expect, it } from "vitest";

import { dateTimeFormatter } from "./intl-cache";

const instant = new Date("2026-07-10T18:30:00.000Z");

describe("dateTimeFormatter", () => {
  it("reuses one formatter for a repeated locale, time zone and format", () => {
    const first = dateTimeFormatter("en-CA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Edmonton",
    });
    const second = dateTimeFormatter("en-CA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Edmonton",
    });

    expect(second).toBe(first);
  });

  it("keeps a separate formatter per time zone, so a cached one never formats the wrong offset", () => {
    const edmonton = dateTimeFormatter("en-CA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Edmonton",
    });
    const utc = dateTimeFormatter("en-CA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    });

    expect(utc).not.toBe(edmonton);
    expect(edmonton.format(instant)).not.toBe(utc.format(instant));
  });

  it("keeps a separate formatter per locale and per format", () => {
    const base = { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" } as const;

    expect(dateTimeFormatter("fr-CA", base)).not.toBe(dateTimeFormatter("en-CA", base));
    expect(dateTimeFormatter("en-CA", { ...base, dateStyle: "full" })).not.toBe(
      dateTimeFormatter("en-CA", base),
    );
  });

  it("matches a freshly constructed formatter's output", () => {
    const options: Intl.DateTimeFormatOptions = {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    };

    expect(dateTimeFormatter("en-CA", options).format(instant)).toBe(
      new Intl.DateTimeFormat("en-CA", options).format(instant),
    );
  });

  it("propagates a construction error so callers can fall back to the default locale", () => {
    expect(() => dateTimeFormatter("en-CA", { timeZone: "Not/AZone" })).toThrow(RangeError);
  });
});
