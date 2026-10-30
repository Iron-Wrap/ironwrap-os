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
    ).toBe("Elena Ruiz · 118 Larkspur Way NW · Ref J-ELENA");
  });

  it("leaves out a part the read does not have", () => {
    expect(jobLabel({ customer: null, address: "118 Larkspur Way NW", code: "J-ELENA" })).toBe(
      "118 Larkspur Way NW · Ref J-ELENA",
    );
    expect(jobLabel({ customer: "Elena Ruiz", address: null, code: null })).toBe("Elena Ruiz");
    expect(jobLabel({ customer: " ", address: " ", code: null })).toBeNull();
  });

  it("keeps a unit that comes before the street, and trims around commas", () => {
    expect(
      jobLabel({ customer: "Jo", address: "Unit 4, 118 Larkspur Way NW, Calgary AB", code: "J-1" }),
    ).toBe("Jo · Unit 4, 118 Larkspur Way NW · Ref J-1");
    expect(jobLabel({ address: "#12 , 9 Main St, Calgary", code: null })).toBe("#12, 9 Main St");
    expect(jobLabel({ address: "  118 Larkspur Way NW  , Calgary", code: null })).toBe(
      "118 Larkspur Way NW",
    );
    // A number-led street is not a unit.
    expect(jobLabel({ address: "118 Larkspur Way NW, Calgary", code: null })).toBe(
      "118 Larkspur Way NW",
    );
  });
});
