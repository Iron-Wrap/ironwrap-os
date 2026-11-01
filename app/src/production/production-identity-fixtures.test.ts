import { describe, expect, it } from "vitest";

import {
  malformedProductionIdentityFixture,
  nativeJobIdentityFixtures,
  productionIdentityFixture,
  syntheticNativeJobId,
} from "../../e2e/fixtures/production-identity";
import { jobResponseSchema } from "../field/field-contracts";
import { jobHistoryResponseSchema } from "../jobs/job-history-contracts";
import { productionRunwayResponseSchema } from "./production-contracts";

describe("Synthetic production-to-native identity route fixtures", () => {
  it.each(["known", "unknown", "legacy", "long"] as const)(
    "binds %s to one strictly parsed native job without granting work",
    (state) => {
      const production = productionRunwayResponseSchema.parse(productionIdentityFixture(state));
      const routes = nativeJobIdentityFixtures(state);
      const plan = jobResponseSchema.parse(routes.plan);
      const history = jobHistoryResponseSchema.parse(routes.history);
      expect([
        production.jobs[0]?.id,
        plan.job.id,
        plan.job.roof_job_id,
        history.job.id,
        history.job.roof_job_id,
      ]).toEqual(Array(5).fill(syntheticNativeJobId));
      expect(history.job).toEqual(plan.job);
      expect(plan.allowed_actions).toEqual([]);
      expect(history.allowed_actions).toEqual([]);
      expect(plan.packet.work_package).toBeNull();
      if (state === "legacy") {
        expect(production.jobs[0]?.customer_display_name).toBeNull();
        expect(history.customer?.display_name).toBe("Synthetic Customer One");
      } else {
        expect(history.customer?.display_name ?? null).toBe(
          production.jobs[0]?.customer_display_name,
        );
        expect(history.job.address).toBe(production.jobs[0]?.address);
      }
    },
  );

  it("keeps malformed refusal separate from the valid retry DTO", () => {
    expect(
      productionRunwayResponseSchema.safeParse(malformedProductionIdentityFixture()).success,
    ).toBe(false);
    expect(
      productionRunwayResponseSchema.safeParse(productionIdentityFixture("known")).success,
    ).toBe(true);
  });
});
