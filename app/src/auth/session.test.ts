import { describe, expect, it } from "vitest";

import { sessionResponseSchema } from "./session";

const authenticatedSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_123",
    email: "crew@ironwrapexteriors.com",
    display_name: "Crew Member",
    role: "field",
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
  permissions: ["jobs:read:assigned"],
  allowed_actions: ["check_in:create"],
  csrf_token: "csrf-token",
  session_expires_at: "2026-07-11T12:00:00.000Z",
  source_updated_at: "2026-07-10T12:00:00.000Z",
  read_model_generated_at: "2026-07-10T12:00:01.000Z",
  stale_fields: [],
} as const;

describe("sessionResponseSchema", () => {
  it("accepts the exact authenticated BFF envelope", () => {
    expect(sessionResponseSchema.parse(authenticatedSession)).toEqual(authenticatedSession);
  });

  it("rejects unknown roles and missing CSRF truth", () => {
    expect(
      sessionResponseSchema.safeParse({
        ...authenticatedSession,
        user: { ...authenticatedSession.user, role: "admin" },
      }).success,
    ).toBe(false);
    expect(
      sessionResponseSchema.safeParse({ ...authenticatedSession, csrf_token: null }).success,
    ).toBe(false);
  });
});
