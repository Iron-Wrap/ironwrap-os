import { getDatabase } from "../storage/db";

export const PRINCIPAL_EPOCH_KEY = "field-principal-epoch-v1";
const FORMAT = "field-principal-epoch-v2";
const DEADLINE_MS = 2_000;
const listeners = new Set<() => void>();
let current: string | undefined;
let uncertain = false;
let revision = 0;
let change = 0;
let channel: BroadcastChannel | undefined;

interface EpochState {
  format: typeof FORMAT;
  epoch: string;
  pending: string[];
}

/** A committed local refusal, not a server principal or permission. */
export interface PreparedPrincipalExchange {
  id: string;
  epoch: string;
}

function state(value: unknown): EpochState | undefined {
  if (typeof value === "string" && value) return { format: FORMAT, epoch: value, pending: [] };
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<EpochState>;
  if (
    candidate.format !== FORMAT ||
    typeof candidate.epoch !== "string" ||
    !candidate.epoch ||
    !Array.isArray(candidate.pending) ||
    candidate.pending.some((id) => typeof id !== "string" || !id) ||
    new Set(candidate.pending).size !== candidate.pending.length
  )
    return undefined;
  return candidate as EpochState;
}

function emit(broadcast = true): void {
  revision += 1;
  listeners.forEach((listener) => listener());
  if (!broadcast) return;
  const Channel = typeof window === "undefined" ? undefined : window.BroadcastChannel;
  try {
    if (Channel) {
      const outgoing = channel ?? new Channel("ironwrap-principal-context");
      outgoing.postMessage({ type: "epoch" });
      if (!channel) outgoing.close();
    }
  } catch {
    // Durable state, not delivery of this optional notification, decides admission.
  }
}

function remember(value: EpochState | undefined): void {
  current = value && value.pending.length === 0 ? value.epoch : undefined;
  uncertain = !current;
}

async function bounded<T>(operation: Promise<T>, cancel?: () => void): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          cancel?.();
          resolve(undefined);
        }, DEADLINE_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function readState(): Promise<EpochState | undefined> {
  return bounded(
    (async () => {
      const db = await getDatabase();
      const tx = db.transaction("meta", "readonly");
      const record = await tx.store.get(PRINCIPAL_EPOCH_KEY);
      await tx.done;
      return state(record?.value);
    })(),
  );
}

/** Commit, then read back in a separate transaction. A put request alone is insufficient. */
async function updateState(
  update: (value: EpochState) => EpochState | undefined,
  verify: (value: EpochState) => boolean,
): Promise<EpochState | undefined> {
  let cancelled = false;
  let abort: (() => void) | undefined;
  const operation = (async () => {
    const db = await getDatabase();
    if (cancelled) return undefined;
    const tx = db.transaction("meta", "readwrite", { durability: "strict" });
    abort = () => {
      try {
        tx.abort();
      } catch {
        // An already committed transaction is still subject to readback verification.
      }
    };
    void tx.done.catch(() => undefined);
    const record = await tx.store.get(PRINCIPAL_EPOCH_KEY);
    const parsed = state(record?.value);
    if (record && !parsed) {
      abort();
      return undefined;
    }
    const previous: EpochState = parsed ?? {
      format: FORMAT,
      epoch: crypto.randomUUID(),
      pending: [],
    };
    const next = update(previous);
    if (!next || cancelled) {
      abort();
      return undefined;
    }
    await tx.store.put({ key: PRINCIPAL_EPOCH_KEY, value: next, updatedAt: Date.now() });
    await tx.done;
    if (cancelled) return undefined;
    const read = db.transaction("meta", "readonly");
    const readback = await read.store.get(PRINCIPAL_EPOCH_KEY);
    await read.done;
    const verified = state(readback?.value);
    return verified && verify(verified) ? verified : undefined;
  })();
  return bounded(operation, () => {
    cancelled = true;
    abort?.();
  });
}

/** Every pending id survives restart until its own determinate exchange settles. */
export async function preparePrincipalExchange(
  replacesPrincipal: boolean,
): Promise<PreparedPrincipalExchange | undefined> {
  ++change;
  uncertain = true;
  current = undefined;
  emit(false);
  const id = crypto.randomUUID();
  const value = await updateState(
    (previous) => ({
      ...previous,
      epoch: replacesPrincipal ? crypto.randomUUID() : previous.epoch,
      pending: [...previous.pending, id],
    }),
    (readback) => readback.pending.includes(id),
  );
  remember(value);
  emit();
  return value ? { id, epoch: value.epoch } : undefined;
}

export async function preparedPrincipalExchangeExists(
  prepared: PreparedPrincipalExchange,
): Promise<boolean> {
  const value = await readState();
  remember(value);
  return Boolean(value?.pending.includes(prepared.id));
}

/** Remove only our id in the current transaction; never write an earlier epoch back. */
export async function settlePrincipalExchange(
  prepared: PreparedPrincipalExchange,
  outcome: "unchanged" | "changed",
): Promise<void> {
  ++change;
  const value = await updateState(
    (previous) =>
      previous.pending.includes(prepared.id)
        ? {
            ...previous,
            epoch: outcome === "changed" ? crypto.randomUUID() : previous.epoch,
            pending: previous.pending.filter((id) => id !== prepared.id),
          }
        : undefined,
    (readback) => !readback.pending.includes(prepared.id),
  );
  remember(value);
  emit();
}

/** Local credential changes also retain every other exchange's durable pending id. */
export async function invalidatePrincipalEpoch(): Promise<void> {
  ++change;
  uncertain = true;
  current = undefined;
  const epoch = crypto.randomUUID();
  const value = await updateState(
    (previous) => ({ ...previous, epoch }),
    (readback) => readback.epoch === epoch,
  );
  remember(value);
  emit();
}

async function readyState(): Promise<EpochState | undefined> {
  const deadline = performance.now() + DEADLINE_MS;
  do {
    const value = await readState();
    if (!value || value.pending.length === 0) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  return undefined;
}

export async function capturePrincipalEpoch(): Promise<string | undefined> {
  const captured = change;
  let value = await readState();
  if (!value) {
    value = await updateState(
      (previous) => previous,
      (readback) => readback.pending.length === 0,
    );
  }
  if (change !== captured) return undefined;
  remember(value);
  // Acquisition may be contingent on another in-flight read. It cannot be used or restored
  // until matches/current prove that every pending exchange has actually settled.
  return value?.epoch;
}

export function principalEpochIsCurrent(epoch: unknown): boolean {
  return !uncertain && typeof epoch === "string" && epoch === current;
}

/** Storage of a contingent observation is safe; this does not admit a pending field read. */
export async function principalEpochRefersTo(epoch: unknown): Promise<boolean> {
  return typeof epoch === "string" && (await readState())?.epoch === epoch;
}

export function principalEpochRecordRefersTo(value: unknown, epoch: unknown): boolean {
  return typeof epoch === "string" && state(value)?.epoch === epoch;
}

export async function principalEpochMatches(epoch: unknown): Promise<boolean> {
  if (typeof epoch !== "string") return false;
  let captured: number;
  let value: EpochState | undefined;
  do {
    captured = change;
    value = await readyState();
  } while (value && captured !== change);
  remember(value);
  return current === epoch;
}

export function getPrincipalEpochRevision(): number {
  return revision;
}

export function subscribePrincipalEpochChanges(listener: () => void): () => void {
  listeners.add(listener);
  const Channel = typeof window === "undefined" ? undefined : window.BroadcastChannel;
  if (Channel && !channel) {
    try {
      channel = new Channel("ironwrap-principal-context");
      channel.addEventListener("message", () => {
        const captured = ++change;
        uncertain = true;
        current = undefined;
        emit(false);
        void readState().then((value) => {
          if (captured !== change) return;
          remember(value);
          emit(false);
        });
      });
    } catch {
      channel = undefined;
    }
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      channel?.close();
      channel = undefined;
    }
  };
}
