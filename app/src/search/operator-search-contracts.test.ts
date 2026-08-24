import { describe, expect, it } from "vitest";

import {
  operatorSearchReadModelSchema,
  operatorSearchResultSchema,
} from "./operator-search-contracts";

const result = {
  id: "JOB-A",
  label: "IW-1001",
  detail: "Roofing · In production",
  href: "/jobs/JOB-A",
  matched_field: "job_number",
};

const model = {
  version: 1,
  source_updated_at: "2026-08-24T10:00:00.000Z",
  read_model_generated_at: "2026-08-24T10:00:01.000Z",
  stale_fields: [],
  permissions: ["jobs:read:any"],
  allowed_actions: ["search.read", "job.read"],
  query: "iw",
  query_class: "text" as const,
  outcome: "results" as const,
  groups: [
    {
      group: "jobs" as const,
      label: "Jobs",
      limit: 8,
      matched_fields: ["job_number"],
      results: [result],
      more_results: true,
    },
  ],
};

describe("operator search contract", () => {
  it("keeps grouped order, matched fields, capped results, and more-results truth", () => {
    const parsed = operatorSearchReadModelSchema.parse(model);
    expect(parsed.groups[0]).toMatchObject({
      group: "jobs",
      matched_fields: ["job_number"],
      results: [result],
      more_results: true,
    });
  });

  it("rejects unknown response fields and non-local destinations", () => {
    expect(
      operatorSearchReadModelSchema.safeParse({
        ...model,
        unexpected: "not part of the read model",
      }).success,
    ).toBe(false);
    expect(
      operatorSearchResultSchema.safeParse({ ...result, href: "https://example.invalid" }).success,
    ).toBe(false);
    expect(
      operatorSearchResultSchema.safeParse({ ...result, href: "//example.invalid" }).success,
    ).toBe(false);
  });
});
