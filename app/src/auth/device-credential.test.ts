import { afterEach, describe, expect, it } from "vitest";

import { resetDatabaseForTests } from "../storage/db";
import {
  clearDeviceSecret,
  createDeviceSecret,
  getDeviceSecret,
  storeDeviceSecret,
} from "./device-credential";

describe("field device credential", () => {
  afterEach(async () => {
    await resetDatabaseForTests();
  });

  it("stores a credential only after a pairing candidate is committed", async () => {
    const first = createDeviceSecret((bytes) => {
      bytes.fill(255);
      return bytes;
    });

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await getDeviceSecret()).toBeUndefined();
    await storeDeviceSecret(first);
    expect(await getDeviceSecret()).toBe(first);
    await storeDeviceSecret("x".repeat(43));
    expect(await getDeviceSecret()).toBe("x".repeat(43));
  });

  it("does not treat malformed values as proof and clears an unauthorized device credential", async () => {
    expect(await getDeviceSecret()).toBeUndefined();
    await storeDeviceSecret("x".repeat(43));
    await clearDeviceSecret();
    expect(await getDeviceSecret()).toBeUndefined();
  });
});
