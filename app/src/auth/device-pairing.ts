import { consumeDevicePairing } from "../pairing/pairing-api";
import type { AuthenticatedSession } from "./session";
import { createDeviceSecret, storeDeviceSecret } from "./device-credential";

export interface PairDeviceDependencies {
  createDeviceProof?: () => string;
  consume?: (token: string, deviceProof: string) => Promise<AuthenticatedSession>;
  storeDeviceProof?: (deviceProof: string) => Promise<void>;
}

/**
 * Holds a fresh proof in memory until the Worker has claimed the one-time QR.
 * A failed, expired, or replayed pairing cannot overwrite a browser's
 * previously working field credential.
 */
export async function pairDevice(
  token: string,
  dependencies: PairDeviceDependencies = {},
): Promise<void> {
  const deviceProof = (dependencies.createDeviceProof ?? createDeviceSecret)();
  const session = await (dependencies.consume ?? consumeDevicePairing)(token, deviceProof);
  if (session.user.role !== "field") {
    throw new Error("The pairing response did not create a Field Companion session.");
  }
  await (dependencies.storeDeviceProof ?? storeDeviceSecret)(deviceProof);
}
