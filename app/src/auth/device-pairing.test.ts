import { afterEach, describe, expect, it } from "vitest";

import { resetDatabaseForTests } from "../storage/db";
import { getDeviceSecret, storeDeviceSecret } from "./device-credential";
import { pairDevice } from "./device-pairing";
import type { AuthenticatedSession } from "./session";

const fieldSession = { user: { role: "field" } } as AuthenticatedSession;

describe("pairDevice", () => {
  afterEach(async () => {
    await resetDatabaseForTests();
  });

  it("does not replace a working proof when an expired or replayed QR is rejected", async () => {
    const existing = "e".repeat(43);
    const candidate = "c".repeat(43);
    await storeDeviceSecret(existing);

    await expect(
      pairDevice("t".repeat(43), {
        createDeviceProof: () => candidate,
        consume: async () => {
          throw new Error("invalid_or_expired_pairing");
        },
      }),
    ).rejects.toThrow("invalid_or_expired_pairing");

    expect(await getDeviceSecret()).toBe(existing);
  });

  it("commits the exact candidate only after pairing succeeds", async () => {
    const candidate = "c".repeat(43);
    await pairDevice("t".repeat(43), {
      createDeviceProof: () => candidate,
      consume: async () => fieldSession,
    });

    expect(await getDeviceSecret()).toBe(candidate);
  });
});
