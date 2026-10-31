import { describe, expect, it } from "vitest";

import { estimatorWorkbenchResponseSchema } from "./estimator-contracts";
import liveShape from "./estimator-workbench-live-shape.fixture.json";

/**
 * The workbench contract is strict on purpose, but strictness only protects the
 * reader if it tracks what the Worker actually sends. It did not: the Worker
 * returns non-operational takeoff/estimate previews and a job-economics block
 * this schema had never been told about, so every job carrying measurement
 * values failed the parse and the page rendered "Measurement workbench is
 * unavailable" instead of the job — including the job the customer-portal
 * traverse runs on.
 *
 * The fixture is a verbatim capture of `GET /api/v1/estimator/jobs/{job}` from
 * the deploy/local stack, so a Worker read model that grows another undeclared
 * block fails here instead of in a browser.
 */
describe("estimatorWorkbenchResponseSchema", () => {
  it("parses the read model the Worker actually returns", () => {
    const parsed = estimatorWorkbenchResponseSchema.safeParse(liveShape);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("carries the additive blocks that used to break the parse", () => {
    expect(liveShape).toHaveProperty("economics");
    expect(liveShape.measurements.selected).toHaveProperty("computed_takeoff");
    expect(liveShape.measurements.selected).toHaveProperty("computed_estimate");
  });

  it("still refuses a block nobody has declared", () => {
    const parsed = estimatorWorkbenchResponseSchema.safeParse({
      ...liveShape,
      totally_unmodelled_surface: { anything: true },
    });
    expect(parsed.success).toBe(false);
  });

  it("normalizes identity additions absent from older reads to null", () => {
    const parsed = estimatorWorkbenchResponseSchema.parse(liveShape);
    expect(parsed.job).toMatchObject({ customer_display_name: null, address: null });
  });

  it.each([
    ["Synthetic Cedar Household", "118 Example Way NW, Edmonton, AB, CA"],
    ["Synthetic Juniper Household", "Unit 4, 216 Example Lane NW, Edmonton, AB, CA"],
    [null, "118 Example Way NW, Edmonton, AB, CA"],
    ["Synthetic Cedar Household", null],
    [null, null],
  ])("accepts exact-job customer %s and site %s", (customer, address) => {
    const parsed = estimatorWorkbenchResponseSchema.parse({
      ...liveShape,
      job: { ...liveShape.job, customer_display_name: customer, address },
    });
    expect(parsed.job.customer_display_name).toBe(customer);
    expect(parsed.job.address).toBe(address);
  });

  it("normalizes blank identity without relaxing the job schema", () => {
    const job = { ...liveShape.job, customer_display_name: "  ", address: "\t" };
    expect(estimatorWorkbenchResponseSchema.parse({ ...liveShape, job }).job).toMatchObject({
      customer_display_name: null,
      address: null,
    });
    expect(
      estimatorWorkbenchResponseSchema.safeParse({
        ...liveShape,
        job: { ...job, customer_email: "synthetic@example.invalid" },
      }).success,
    ).toBe(false);
    expect(
      estimatorWorkbenchResponseSchema.safeParse({
        ...liveShape,
        job: { ...job, customer_display_name: 42 },
      }).success,
    ).toBe(false);
  });
});
