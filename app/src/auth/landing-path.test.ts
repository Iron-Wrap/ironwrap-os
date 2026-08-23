import { describe, expect, it } from "vitest";

import type { AppRole } from "../lib/roles";
import { landingPathFor } from "./landing-path";
import type { SessionResponse } from "./session";

/**
 * ELEC-157. Sign-in sent every role to `/today`, which is the field run sheet and is
 * guarded to the field role — so the first screen a sales, production or accounting user
 * saw after a successful sign-in was "This work belongs to another role", with nothing to
 * do but click back out of it. Landing is role-shaped now, and this is the test that says
 * so out loud.
 */
function sessionFor(role: AppRole): SessionResponse {
  return {
    version: 1,
    authenticated: true,
    user: {
      id: "appu_landing",
      email: "person@example.invalid",
      display_name: "Person",
      role,
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
    permissions: [],
    allowed_actions: [],
    csrf_token: "csrf",
    session_expires_at: "2036-07-11T12:00:00.000Z",
    source_updated_at: null,
    read_model_generated_at: "2026-08-22T12:00:00.000Z",
    stale_fields: [],
  };
}

describe("landingPathFor", () => {
  it("sends a paired crew phone to its run sheet", () => {
    expect(landingPathFor(sessionFor("field"))).toBe("/today");
  });

  it("never drops an office role onto the field-guarded run sheet", () => {
    for (const role of ["owner", "ops", "sales", "production", "accounting"] as const) {
      expect(landingPathFor(sessionFor(role)), `${role} landing`).toBe("/now");
    }
  });

  it("treats an unauthenticated response as office-shaped rather than guessing field", () => {
    expect(
      landingPathFor({
        version: 1,
        authenticated: false,
        user: null,
        tenant: sessionFor("owner").tenant,
        permissions: [],
        allowed_actions: [],
        csrf_token: null,
        session_expires_at: null,
        source_updated_at: null,
        read_model_generated_at: "2026-08-22T12:00:00.000Z",
        stale_fields: [],
      }),
    ).toBe("/now");
  });
});
