import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { loadOperatorSearch } from "./operator-search-api";

const session: AuthenticatedSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@example.invalid",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: null,
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:any"],
  allowed_actions: ["search.read"],
  csrf_token: "csrf",
  session_expires_at: "2030-08-24T10:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-24T10:00:00.000Z",
  stale_fields: [],
};

const response = {
  version: 1,
  source_updated_at: null,
  read_model_generated_at: "2026-08-24T10:00:00.000Z",
  stale_fields: [],
  permissions: ["jobs:read:any"],
  allowed_actions: ["search.read"],
  query: "iw",
  query_class: "text" as const,
  outcome: "no_matches" as const,
  groups: [],
};

describe("loadOperatorSearch", () => {
  it("uses the real versioned search path and forwards cancellation", async () => {
    const signal = new AbortController().signal;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));

    await loadOperatorSearch(session, "iw", signal, fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/search?q=iw",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
    expect(fetcher.mock.calls[0]?.[1]?.signal).not.toBe(signal);
  });
});
