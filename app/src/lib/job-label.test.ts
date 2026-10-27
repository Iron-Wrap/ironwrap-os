import { describe, expect, it } from "vitest";

import { jobLabel } from "./job-label";

describe("jobLabel", () => {
  it("names a job by customer and street, with its code last", () => {
    expect(
      jobLabel({
        customer: "Elena Ruiz",
        address: "118 Larkspur Way NW, Calgary, AB",
        code: "J-ELENA",
      }),
    ).toBe("Elena Ruiz · 118 Larkspur Way NW · J-ELENA");
  });

  it("leaves out a part the read does not have", () => {
    expect(jobLabel({ customer: null, address: "118 Larkspur Way NW", code: "J-ELENA" })).toBe(
      "118 Larkspur Way NW · J-ELENA",
    );
    expect(jobLabel({ customer: "Elena Ruiz", address: null, code: null })).toBe("Elena Ruiz");
    expect(jobLabel({ customer: " ", address: " ", code: null })).toBeNull();
  });
});
