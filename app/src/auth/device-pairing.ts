import { consumeDevicePairing } from "../pairing/pairing-api";
import type { AuthenticatedSession } from "./session";
import { createDeviceSecret, storeDeviceSecret } from "./device-credential";
import { beginPrincipalContextChange } from "./principal-context";
import { preparePrincipalExchange, settlePrincipalExchange } from "./principal-epoch";
import { ApiError } from "../lib/api";

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
  let prepared: Awaited<ReturnType<typeof preparePrincipalExchange>>;
  let consumed = false;
  try {
    prepared = await preparePrincipalExchange(true);
    if (!prepared)
      throw new ApiError({
        status: 0,
        code: "principal_prepare_failed",
        message: "This device could not safely prepare pairing. No request was sent.",
        details: { dispatched: false },
      });
    const deviceProof = (dependencies.createDeviceProof ?? createDeviceSecret)();
    const session = await (dependencies.consume ?? consumeDevicePairing)(token, deviceProof);
    consumed = true;
    if (session.user.role !== "field") {
      throw new Error("This phone could not finish pairing. Ask the office for a new code.");
    }
    await (dependencies.storeDeviceProof ?? storeDeviceSecret)(deviceProof);
    if (prepared) await settlePrincipalExchange(prepared, "unchanged");
  } catch (error) {
    if (
      prepared &&
      !consumed &&
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    )
      await settlePrincipalExchange(prepared, "unchanged");
    throw error;
  } finally {
    finish();
  }
}
