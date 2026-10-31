import { consumeDevicePairing } from "../pairing/pairing-api";
import type { AuthenticatedSession } from "./session";
import { createDeviceSecret, storeDeviceSecret } from "./device-credential";
import { beginPrincipalContextChange } from "./principal-context";
import { invalidatePrincipalEpoch } from "./principal-epoch";

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
  const finish = beginPrincipalContextChange();
  try {
    await invalidatePrincipalEpoch();
    const deviceProof = (dependencies.createDeviceProof ?? createDeviceSecret)();
    const session = await (dependencies.consume ?? consumeDevicePairing)(token, deviceProof);
    if (session.user.role !== "field") {
      throw new Error("This phone could not finish pairing. Ask the office for a new code.");
    }
    await (dependencies.storeDeviceProof ?? storeDeviceSecret)(deviceProof);
  } finally {
    finish();
  }
}
