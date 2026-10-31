import { describe, expect, it, vi } from "vitest";

import {
  createFacetLaunch,
  loadEstimatorWorkbench,
  navigateToFacetLaunch,
  newFacetLaunchKey,
} from "./estimator-api";
import type { FacetLaunchResponse } from "./estimator-contracts";
import legacyWorkbench from "./estimator-workbench-live-shape.fixture.json";

const TOKEN = `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(43)}`;
const response: FacetLaunchResponse = {
  version: 1,
  read_model_generated_at: "2027-01-15T08:00:00.000Z",
  permissions: ["facet:launch"],
  allowed_actions: ["facet_launch.create"],
  launch: {
    facet_project_id: "11111111-1111-4111-8111-111111111111",
    launch_url: `https://facet.example.invalid/#iwlaunch=${TOKEN}`,
    expires_at: "2027-01-15T08:10:00.000Z",
    state: "issued",
  },
};

describe("estimator job identity request", () => {
  it("opts in only the GET while an old Worker response remains readable and no-store", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(legacyWorkbench));
    const model = await loadEstimatorWorkbench("SYNTHETIC JOB/1", fetcher);
    expect(model.job).toMatchObject({ customer_display_name: null, address: null });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/api/v1/estimator/jobs/SYNTHETIC%20JOB%2F1?include_job_identity=1",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  });
});

describe("Facet launch API", () => {
  it("sends only an empty command with CSRF and caller-stable idempotency", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    await expect(
      createFacetLaunch("ROOF JOB/1", "csrf-token", "facet-launch:stable-0001", fetcher),
    ).resolves.toEqual(response);
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/api/v1/estimator/jobs/ROOF%20JOB%2F1/facet-launches");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe("csrf-token");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("facet-launch:stable-0001");
    expect(init?.body).toBe("{}");
  });

  it("generates bounded keys and navigates only to the exact HTTPS fragment capability", () => {
    const key = newFacetLaunchKey();
    expect(key).toMatch(/^facet-launch:[0-9a-f-]{36}$/);
    const navigate = vi.fn();
    navigateToFacetLaunch(response, navigate);
    expect(navigate).toHaveBeenCalledWith(response.launch.launch_url);
    expect(() =>
      navigateToFacetLaunch(
        {
          ...response,
          launch: {
            ...response.launch,
            launch_url: `https://facet.example.invalid/?token=x#iwlaunch=${TOKEN}`,
          },
        },
        navigate,
      ),
    ).toThrow();
  });
});
