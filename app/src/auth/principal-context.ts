import type { AuthenticatedSession } from "./session";

export const PRINCIPAL_GENERATION_KEY = "ironwrap.principal-read-generation-v1";
export interface PrincipalReadStart {
  revision: number;
  generation: string | null;
}
export interface PrincipalReadObservation extends PrincipalReadStart {
  format: "principal-read-v1";
  id: string;
  sessionKey: string;
  deviceHash: string | null;
  source: "live" | "offline";
}
const listeners = new Set<() => void>();
const observations = new WeakMap<AuthenticatedSession, PrincipalReadObservation>();
const instances = new WeakMap<AuthenticatedSession, number>();
let nextInstance = 0;
let revision = 0;
let changes = 0;
let channel: BroadcastChannel | undefined;

export function getPrincipalContextRevision(): number {
  return revision;
}
export function principalContextIsChanging(): boolean {
  return changes > 0;
}
export function getPrincipalGeneration(): string | null {
  try {
    let generation = window.localStorage.getItem(PRINCIPAL_GENERATION_KEY);
    if (!generation) generation = crypto.randomUUID();
    // A readable old generation is insufficient if auth transitions can no longer rotate it.
    // Same-value writes do not notify other tabs; unavailable provenance stays unverified.
    window.localStorage.setItem(PRINCIPAL_GENERATION_KEY, generation);
    return window.localStorage.getItem(PRINCIPAL_GENERATION_KEY) === generation ? generation : null;
  } catch {
    return null;
  }
}
export function principalReadStart(): PrincipalReadStart {
  return { revision, generation: getPrincipalGeneration() };
}
function storageChanged(event: StorageEvent) {
  if (event.key === PRINCIPAL_GENERATION_KEY) notify(false);
}
export function subscribePrincipalContextChanges(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", storageChanged);
  const Channel = typeof window === "undefined" ? undefined : window.BroadcastChannel;
  if (Channel && !channel) {
    try {
      channel = new Channel("ironwrap-principal-context");
      channel.addEventListener("message", () => notify(false));
    } catch {
      channel = undefined;
    }
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      channel?.close();
      channel = undefined;
      window.removeEventListener("storage", storageChanged);
    }
  };
}
function notify(broadcast = true) {
  if (broadcast) {
    try {
      window.localStorage.setItem(PRINCIPAL_GENERATION_KEY, crypto.randomUUID());
    } catch {
      /* unverified field context */
    }
  }
  revision += 1;
  listeners.forEach((listener) => listener());
  const Channel = typeof window === "undefined" ? undefined : window.BroadcastChannel;
  if (broadcast && Channel) {
    try {
      const outgoing = channel ?? new Channel("ironwrap-principal-context");
      outgoing.postMessage("changed");
      if (!channel) outgoing.close();
    } catch {
      /* An optional observer cannot change the auth request. */
    }
  }
}
export function beginPrincipalContextChange(): () => void {
  changes += 1;
  notify();
  let finished = false;
  return () => {
    if (!finished) {
      finished = true;
      changes -= 1;
      notify();
    }
  };
}
export function principalSessionKey(session: AuthenticatedSession): string {
  return JSON.stringify([
    session.tenant.id,
    session.user.id,
    session.user.role,
    session.user.frappe_user_id,
    session.session_expires_at,
    session.source_updated_at,
    session.read_model_generated_at,
    session.permissions,
    session.allowed_actions,
  ]);
}
export async function principalCredentialHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function observePrincipalRead(
  session: AuthenticatedSession,
  start: PrincipalReadStart,
  secret: string | undefined,
): Promise<PrincipalReadObservation> {
  const observation: PrincipalReadObservation = {
    format: "principal-read-v1",
    id: crypto.randomUUID(),
    ...start,
    sessionKey: principalSessionKey(session),
    deviceHash:
      session.user.role === "field" && secret ? await principalCredentialHash(secret) : null,
    source: "live",
  };
  observations.set(session, observation);
  return observation;
}
export function getSessionReadObservation(
  session: AuthenticatedSession,
): PrincipalReadObservation | undefined {
  return observations.get(session);
}
export function setSessionReadObservation(
  session: AuthenticatedSession,
  observation?: PrincipalReadObservation,
): void {
  if (observation) observations.set(session, observation);
  else observations.delete(session);
}
export function sessionReadContextIdentity(session: AuthenticatedSession): string {
  if (!instances.has(session)) instances.set(session, ++nextInstance);
  return `${instances.get(session)}:${observations.get(session)?.id ?? "unverified"}`;
}
export function sessionReadContextIsCurrent(
  session: AuthenticatedSession,
  observed = observations.get(session),
): boolean {
  return Boolean(
    observed &&
    observed.format === "principal-read-v1" &&
    observed.generation &&
    observed.generation === getPrincipalGeneration() &&
    observed.revision === revision &&
    observed.sessionKey === principalSessionKey(session) &&
    !principalContextIsChanging() &&
    (session.user.role !== "field" || observed.deviceHash),
  );
}
export async function restorePrincipalObservation(
  session: AuthenticatedSession,
  value: unknown,
  secret: string | undefined,
): Promise<PrincipalReadObservation | undefined> {
  if (!value || typeof value !== "object") return undefined;
  const observed = value as Partial<PrincipalReadObservation>;
  const start = principalReadStart();
  if (
    observed.format !== "principal-read-v1" ||
    typeof observed.id !== "string" ||
    !observed.id ||
    !Number.isInteger(observed.revision) ||
    (observed.source !== "live" && observed.source !== "offline") ||
    !observed.generation ||
    observed.generation !== start.generation ||
    observed.sessionKey !== principalSessionKey(session) ||
    !Number.isFinite(Date.parse(session.session_expires_at)) ||
    Date.parse(session.session_expires_at) <= Date.now() ||
    principalContextIsChanging()
  )
    return undefined;
  if (
    session.user.role === "field" &&
    (!secret || observed.deviceHash !== (await principalCredentialHash(secret)))
  )
    return undefined;
  if (session.user.role !== "field" && observed.deviceHash !== null) return undefined;
  if (
    revision !== start.revision ||
    getPrincipalGeneration() !== start.generation ||
    principalContextIsChanging() ||
    Date.parse(session.session_expires_at) <= Date.now()
  )
    return undefined;
  const restored: PrincipalReadObservation = {
    ...observed,
    format: "principal-read-v1",
    id: crypto.randomUUID(),
    revision,
    generation: observed.generation,
    sessionKey: observed.sessionKey,
    deviceHash: typeof observed.deviceHash === "string" ? observed.deviceHash : null,
    source: "offline",
  };
  observations.set(session, restored);
  return restored;
}
