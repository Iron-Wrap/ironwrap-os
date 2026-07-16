import { deleteMeta, getMeta, setMeta } from "../storage/db";

const DEVICE_SECRET_KEY = "field-device-secret-v1";
const DEVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface StoredDeviceSecret {
  value: string;
  createdAt: number;
}

export type DeviceProofProvider = () => Promise<string | undefined>;

/**
 * Creates a 256-bit, base64url-encoded credential. It deliberately has no
 * deterministic or low-entropy fallback: a browser that cannot supply secure
 * randomness must not pair a field device.
 */
export function createDeviceSecret(
  getRandomValues: (
    values: Uint8Array<ArrayBuffer>,
  ) => Uint8Array<ArrayBuffer> = secureRandomValues,
): string {
  const bytes = getRandomValues(new Uint8Array(new ArrayBuffer(32)));
  return toBase64Url(bytes);
}

/**
 * Stores a proof only after Worker has accepted a supervised pairing. Re-pairing
 * deliberately gets a fresh proof so a revoked device cannot regain access by
 * replaying its old local credential.
 */
export async function storeDeviceSecret(value: string): Promise<void> {
  if (!DEVICE_SECRET_PATTERN.test(value)) {
    throw new Error("The device credential did not meet the required format.");
  }
  await setMeta(DEVICE_SECRET_KEY, { value, createdAt: Date.now() } satisfies StoredDeviceSecret);
}

/**
 * Reads a paired-device credential without creating one. Ordinary field API
 * calls use this so a cleared browser cannot silently become a new device.
 */
export async function getDeviceSecret(): Promise<string | undefined> {
  const stored = await getMeta<StoredDeviceSecret | string>(DEVICE_SECRET_KEY);
  const value = typeof stored === "string" ? stored : stored?.value;
  return value && DEVICE_SECRET_PATTERN.test(value) ? value : undefined;
}

export async function clearDeviceSecret(): Promise<void> {
  await deleteMeta(DEVICE_SECRET_KEY);
}

function secureRandomValues(values: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("This browser cannot securely pair a device. Use a supported browser.");
  }
  return globalThis.crypto.getRandomValues(values) as Uint8Array<ArrayBuffer>;
}

function toBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
