import { describe, expect, it } from "vitest";

import {
  devicePairingsResponseSchema,
  fieldUsersResponseSchema,
  issueDevicePairingResponseSchema,
} from "./pairing-contracts";

describe("device pairing BFF contracts", () => {
  it("accepts the exact office device list shapes including nullable activity", () => {
    expect(
      fieldUsersResponseSchema.parse({
        users: [
          {
            id: "appu_crew",
            display_name: "Crew One",
            email: "crew@example.test",
            frappe_user_id: null,
          },
        ],
      }),
    ).toMatchObject({ users: [{ id: "appu_crew" }] });
    expect(
      devicePairingsResponseSchema.parse({
        devices: [
          {
            id: "appd_device",
            field_user_id: "appu_crew",
            field_user_name: "Crew One",
            paired_at: "2026-07-10T12:00:00.000Z",
            last_seen_at: null,
            revoked_at: null,
            revoked_by: null,
          },
        ],
      }),
    ).toMatchObject({ devices: [{ id: "appd_device", last_seen_at: null }] });
  });

  it("requires a URL, expiry, and explicitly named field user before rendering a QR", () => {
    expect(
      issueDevicePairingResponseSchema.safeParse({
        pairing_url: "not-a-url",
        expires_at: "",
        field_user: { id: "", display_name: "" },
      }).success,
    ).toBe(false);
  });
});
