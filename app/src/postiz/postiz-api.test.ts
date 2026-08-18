import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import {
  approvePostizIntent,
  connectPostiz,
  loadPostizIntent,
  newPostizActionKey,
  rejectPostizIntent,
  reconcilePostizIntent,
  stopPostizIntent,
} from "./postiz-api";
import { postizIntentFixture } from "./postiz-test-fixture";

const facebookOAuthUrl = (() => {
  const query = new URLSearchParams({
    client_id: "client_123",
    redirect_uri: "https://postiz.example.invalid/integrations/social/facebook",
    state: "Ab12Cd",
    scope:
      "pages_show_list,business_management,pages_manage_posts,pages_manage_engagement,pages_read_engagement,read_insights",
  });
  return `https://www.facebook.com/v20.0/dialog/oauth?${query.toString()}`;
})();

const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@example.invalid",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@example.invalid",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["postiz.intent.read"],
  allowed_actions: ["postiz.intent.read"],
  csrf_token: "csrf-postiz",
  session_expires_at: "2026-08-14T12:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-13T08:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

describe("Postiz API", () => {
  it("uses only the bounded same-origin detail and command routes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(postizIntentFixture()))
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          connect_url: facebookOAuthUrl,
          callback_origin: "https://postiz.example.invalid",
          provider: "facebook",
        }),
      )
      .mockImplementation(async () => Response.json(postizIntentFixture()));

    const intentId = "11111111-1111-4111-8111-111111111111";
    await loadPostizIntent(intentId, fetcher);
    await connectPostiz(session, "facebook", "postiz:connect:test", fetcher);
    await approvePostizIntent(session, intentId, 7, "postiz:approve:test", fetcher);
    await rejectPostizIntent(session, intentId, 7, "postiz:reject:test", fetcher);
    await stopPostizIntent(session, intentId, 8, "postiz:stop:test", fetcher);
    await reconcilePostizIntent(session, intentId, 9, "postiz:reconcile:test", fetcher);

    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      `/api/v1/postiz/intents/${intentId}`,
      "/api/v1/postiz/connect",
      `/api/v1/postiz/intents/${intentId}/approve`,
      `/api/v1/postiz/intents/${intentId}/reject`,
      `/api/v1/postiz/intents/${intentId}/stop`,
      `/api/v1/postiz/intents/${intentId}/reconcile`,
    ]);
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }),
    );
    expect(fetcher.mock.calls.slice(1).map((call) => call[1]?.body)).toEqual([
      JSON.stringify({ provider: "facebook" }),
      JSON.stringify({ expected_version: 7 }),
      JSON.stringify({ expected_version: 7 }),
      JSON.stringify({ expected_version: 8 }),
      JSON.stringify({ expected_version: 9 }),
    ]);
    expect(
      fetcher.mock.calls.slice(1).map((call) => {
        const headers = new Headers(call[1]?.headers);
        return [headers.get("X-CSRF-Token"), headers.get("Idempotency-Key")];
      }),
    ).toEqual([
      ["csrf-postiz", "postiz:connect:test"],
      ["csrf-postiz", "postiz:approve:test"],
      ["csrf-postiz", "postiz:reject:test"],
      ["csrf-postiz", "postiz:stop:test"],
      ["csrf-postiz", "postiz:reconcile:test"],
    ]);
  });

  it("generates a distinct caller-stable action key prefix", () => {
    expect(newPostizActionKey("approve")).toMatch(/^postiz:approve:/);
  });
});
