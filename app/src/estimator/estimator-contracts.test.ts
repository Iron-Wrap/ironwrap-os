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
});
