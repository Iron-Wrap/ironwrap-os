import { useQuery } from "@tanstack/react-query";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { loadCapabilitySignal } from "./capability-api";
import { capabilityCopy } from "./capability-copy";
import type { Capability, CapabilitySignalResponse } from "./capability-contracts";

/**
 * What a surface actually knows about one capability, kept as four distinguishable answers.
 *
 * `unreadable` exists because the alternative is the defect this task removes one level up: if a
 * failed or unattempted read collapsed into "off", every screen would confidently announce that a
 * working capability is switched off the moment the network blinked. A capability whose state was
 * never read is not off, and IronWrap says so instead of guessing.
 *
 * `not_visible` is the contract's own rule ("treat a missing capability id as 'not visible to this
 * role', never as 'off'"): a sales role does not receive the QuickBooks pair, and that is a
 * privacy boundary, not evidence about QuickBooks.
 */
export type CapabilityRead =
  | { status: "pending" }
  /** `offline` distinguishes "we did not ask" from "we asked and could not read the answer". */
  | { status: "unreadable"; offline: boolean }
  | { status: "not_visible" }
  | { status: "known"; capability: Capability };

export function capabilitySignalQueryKey(tenantId: string, userId: string) {
  return ["capabilities", tenantId, userId] as const;
}

/**
 * The whole role-scoped read model.
 *
 * Not fetched at all on an offline session: the endpoint answers from live bindings, so a cached
 * copy could only restate what was true when the device last had a connection. A field device
 * receives the same read model inside `GET /api/v1/field/bootstrap` for exactly that reason — one
 * call before it goes offline — and the contract keeps a cached state a rendering hint, never an
 * authority: the server re-derives and re-enforces on every write.
 */
export function useCapabilitySignal(): {
  model: CapabilitySignalResponse | undefined;
  isPending: boolean;
  isError: boolean;
  offline: boolean;
} {
  const session = useSession();
  const offline = isOfflineSession(session);
  const query = useQuery({
    queryKey: capabilitySignalQueryKey(session.tenant.id, session.user.id),
    queryFn: () => loadCapabilitySignal(),
    enabled: !offline,
    staleTime: 30_000,
    // One read, one answer. A capability that is switched off answers the same way every time, so
    // retrying only delays the honest "state could not be read" this falls back to.
    retry: false,
  });
  return {
    model: query.data,
    isPending: !offline && !query.data && query.isPending,
    isError: query.isError,
    offline,
  };
}

/** One capability, by the id from the server registry (`docs/CAPABILITY-SIGNAL-CONTRACT.md`). */
export function useCapability(id: string): CapabilityRead {
  const { model, isPending, isError, offline } = useCapabilitySignal();
  if (offline) return { status: "unreadable", offline: true };
  if (model) {
    const capability = model.capabilities.find((item) => item.id === id);
    return capability ? { status: "known", capability } : { status: "not_visible" };
  }
  if (isError) return { status: "unreadable", offline: false };
  if (isPending) return { status: "pending" };
  return { status: "unreadable", offline: false };
}

/**
 * True when using the capability would fail, so the control in front of it must not be live.
 *
 * `unknown` is deliberately absent: a state IronWrap could not determine is not evidence that the
 * action fails, and disabling on it would be the same guess in the opposite direction. `absent`
 * is absent too — nothing renders for it at all, so there is no control to disable.
 */
export function capabilityPreventsUse(read: CapabilityRead): boolean {
  if (read.status !== "known") return false;
  const { state } = read.capability;
  return state === "off" || state === "unconfigured" || state === "dependency_blocked";
}

/**
 * Whether `CapabilityUnavailable` would render anything for this read. Lets a surface choose
 * between the capability panel and its own ordinary empty state without restating which states
 * produce copy.
 */
export function capabilityHasNotice(read: CapabilityRead): boolean {
  return read.status === "known" && capabilityCopy(read.capability, "") !== undefined;
}
