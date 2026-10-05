import { describe, expect, it } from "vitest";

import { describeInstallWindow } from "./install-window";

const window = (scheduled_start: string, scheduled_end: string | null) => ({
  scheduled_start,
  scheduled_end,
  confirmed: true as const,
  confirmation_basis: "office_committed_assignment" as const,
});

describe("describeInstallWindow", () => {
  it("keeps the office's wall-clock time from the timestamp offset", () => {
    expect(describeInstallWindow(window("2026-10-14T23:30:00-06:00", null))).toEqual({
      day: "Wednesday, October 14, 2026",
      time: "Work starts at 11:30 p.m.",
    });
  });

  it("names both days when the work runs past one day", () => {
    expect(
      describeInstallWindow(window("2026-10-14T08:00:00-06:00", "2026-10-15T17:00:00-06:00")),
    ).toEqual({
      day: "Wednesday, October 14, 2026",
      time: "Work planned from 8:00 a.m. to Thursday, October 15, 2026 at 5:00 p.m.",
    });
  });

  it("shares nothing when the window is absent, null or unreadable", () => {
    expect(describeInstallWindow(undefined)).toBeNull();
    expect(describeInstallWindow(null)).toBeNull();
    expect(describeInstallWindow(window("not a time", null))).toBeNull();
  });

  it("ignores an end that does not follow the start", () => {
    expect(
      describeInstallWindow(window("2026-10-14T08:00:00Z", "2026-10-14T07:00:00Z"))?.time,
    ).toBe("Work starts at 8:00 a.m.");
  });
});
