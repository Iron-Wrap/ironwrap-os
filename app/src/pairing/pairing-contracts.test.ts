import { describe, expect, it, vi } from "vitest";

const constructedShapes = vi.hoisted(() => [] as string[][]);

vi.mock("zod", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zod")>();
  return {
    ...actual,
    z: {
      ...actual.z,
      object: new Proxy(actual.z.object, {
        apply(target, receiver, args) {
          constructedShapes.push(Object.keys(args[0]));
          return Reflect.apply(target, receiver, args);
        },
      }),
    },
  };
});

import {
  devicePairingsResponseSchema,
  fieldUsersResponseSchema,
  issueDevicePairingResponseSchema,
} from "./pairing-contracts";

describe("device pairing BFF contracts", () => {
  it("builds its validators on first parse, not while the boot bundle loads", async () => {
    vi.resetModules();
    constructedShapes.length = 0;
    const contracts = await import("./pairing-contracts");
    expect(constructedShapes).toEqual([]);

    const revoked = {
      ok: true,
      device_id: "appd_device",
      revoked_at: "2026-07-10T12:00:00.000Z",
    } as const;
    expect(contracts.revokeDevicePairingResponseSchema.parse(revoked)).toEqual(revoked);
    expect(contracts.revokeDevicePairingResponseSchema.parse(revoked)).toEqual(revoked);
    expect(constructedShapes).toEqual([["ok", "device_id", "revoked_at"]]);
  });

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
