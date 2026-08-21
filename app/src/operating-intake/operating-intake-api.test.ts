import { describe, expect, it, vi } from "vitest";

import { API_PATHS } from "../lib/api-paths";
import { loadOperatingIntake } from "./operating-intake-api";
import { operatingIntakePayload } from "./operating-intake-fixture";

describe("Operating intake API client", () => {
  it("uses the shared same-origin client for the D1 intake read", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(operatingIntakePayload()));

    await loadOperatingIntake(fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      API_PATHS.operatingIntake,
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }),
    );
  });

  it("rejects an incomplete response instead of inferring a job", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ...operatingIntakePayload(), leads: undefined }));

    await expect(loadOperatingIntake(fetcher)).rejects.toMatchObject({ code: "invalid_response" });
  });
});
