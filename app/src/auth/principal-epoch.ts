import { getDatabase } from "../storage/db";

export const PRINCIPAL_EPOCH_KEY = "field-principal-epoch-v1";
let current: string | undefined;
let uncertain = false;
let pending: Promise<unknown> = Promise.resolve();
let change = 0;

async function bounded<T>(operation: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function writeEpoch(rotate: boolean): Promise<string> {
  const tx = (await getDatabase()).transaction("meta", "readwrite");
  const record = await tx.store.get(PRINCIPAL_EPOCH_KEY);
  const epoch = !rotate && typeof record?.value === "string" ? record.value : crypto.randomUUID();
  await tx.store.put({ key: PRINCIPAL_EPOCH_KEY, value: epoch, updatedAt: Date.now() });
  await tx.done;
  return epoch;
}

/** Field metadata only. Ordinary auth still owns its existing response/error policy. */
export async function invalidatePrincipalEpoch(): Promise<void> {
  const captured = ++change;
  uncertain = true;
  current = undefined;
  const operation = pending.catch(() => undefined).then(() => writeEpoch(true));
  pending = operation;
  const epoch = await bounded(operation);
  if (epoch && change === captured) {
    current = epoch;
    uncertain = false;
  }
}

export async function capturePrincipalEpoch(): Promise<string | undefined> {
  await bounded(pending);
  const captured = change;
  const epoch = await bounded(writeEpoch(uncertain));
  if (epoch && change === captured) {
    current = epoch;
    uncertain = false;
    return epoch;
  }
  return undefined;
}

export function principalEpochIsCurrent(epoch: unknown): boolean {
  return !uncertain && typeof epoch === "string" && epoch === current;
}

export async function principalEpochMatches(epoch: unknown): Promise<boolean> {
  if (uncertain || typeof epoch !== "string") return false;
  const captured = change;
  const value = await bounded(
    (async () => {
      const record = await (await getDatabase()).get("meta", PRINCIPAL_EPOCH_KEY);
      return typeof record?.value === "string" ? record.value : undefined;
    })(),
  );
  if (uncertain || captured !== change) return false;
  current = value;
  return value === epoch;
}
