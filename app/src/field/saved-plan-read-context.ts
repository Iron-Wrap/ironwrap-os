import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { getDeviceSecret } from "../auth/device-credential";
import { useFieldReadObservation } from "../auth/session-context";
import {
  getPrincipalContextRevision,
  principalContextIsChanging,
  subscribePrincipalContextChanges,
  sessionReadContextIdentity,
  sessionReadContextIsCurrent,
  getSessionReadObservation,
  principalCredentialHash,
  type PrincipalReadObservation,
} from "../auth/principal-context";
import type { AuthenticatedSession } from "../auth/session";
import { ApiError } from "../lib/api";

export interface SavedPlanReadContext {
  deviceSecret: string | undefined;
  assertCurrent: () => Promise<void>;
  observation: PrincipalReadObservation | undefined;
}

export function savedPlanContextChanged(): ApiError {
  return new ApiError({
    status: 409,
    code: "saved_plan_context_changed",
    message:
      "Your sign-in or paired device changed or expired. Keep work stopped. Go online and reload to verify the current work list and plan.",
  });
}

export function isSavedPlanContextError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "saved_plan_context_changed";
}

/** Capture before any request. Recheck after every asynchronous parse/digest/cache boundary. */
export async function captureSavedPlanReadContext(
  session: AuthenticatedSession,
  isCurrent: () => boolean = () => true,
  observation = getSessionReadObservation(session),
): Promise<SavedPlanReadContext> {
  const snapshot = JSON.stringify(session);
  const revision = getPrincipalContextRevision();
  const check = () => {
    if (
      !isCurrent() ||
      !sessionReadContextIsCurrent(session, observation) ||
      JSON.stringify(session) !== snapshot ||
      !Number.isFinite(Date.parse(session.session_expires_at)) ||
      Date.parse(session.session_expires_at) <= Date.now() ||
      principalContextIsChanging() ||
      getPrincipalContextRevision() !== revision
    )
      throw savedPlanContextChanged();
  };
  check();
  const deviceSecret = session.user.role === "field" ? await getDeviceSecret() : undefined;
  check();
  if (session.user.role === "field" && !deviceSecret) throw savedPlanContextChanged();
  if (
    session.user.role === "field" &&
    observation?.deviceHash !== (await principalCredentialHash(deviceSecret!))
  )
    throw savedPlanContextChanged();
  check();
  return {
    deviceSecret,
    observation,
    async assertCurrent() {
      check();
      if (session.user.role === "field" && (await getDeviceSecret()) !== deviceSecret)
        throw savedPlanContextChanged();
      check();
    },
  };
}

/** A new authenticated session object is required after pairing changes; old data is withdrawn. */
export function useSavedPlanReadContext(session: AuthenticatedSession) {
  const observation = useFieldReadObservation();
  const revision = useSyncExternalStore(
    subscribePrincipalContextChanges,
    getPrincipalContextRevision,
  );
  const expiresAt = Date.parse(session.session_expires_at);
  const subscribeExpiry = useCallback(
    (listener: () => void) => {
      let timer: number;
      const schedule = () => {
        timer = window.setTimeout(
          wake,
          Math.max(0, Math.min(expiresAt - Date.now() + 1, 2_147_483_647)),
        );
      };
      const wake = () => {
        listener();
        if (expiresAt > Date.now()) schedule();
      };
      schedule();
      return () => window.clearTimeout(timer);
    },
    [expiresAt],
  );
  const expired = useSyncExternalStore(
    subscribeExpiry,
    useCallback(() => !Number.isFinite(expiresAt) || expiresAt <= Date.now(), [expiresAt]),
  );
  const instance = sessionReadContextIdentity(session);
  const id = JSON.stringify([
    instance,
    observation?.id ?? "unverified",
    session.tenant.id,
    session.user.id,
    session.user.role,
    session.user.frappe_user_id,
    session.session_expires_at,
    revision,
  ]);
  const current = useRef<string | null>(id);
  useLayoutEffect(() => {
    current.current = id;
    return () => {
      current.current = null;
    };
  }, [id]);
  const blocked =
    expired ||
    principalContextIsChanging() ||
    !observation ||
    !sessionReadContextIsCurrent(session, observation);
  const isCurrent = useCallback(
    () =>
      current.current === id &&
      !blocked &&
      getPrincipalContextRevision() === revision &&
      !principalContextIsChanging() &&
      Date.parse(session.session_expires_at) > Date.now(),
    [id, blocked, revision, session],
  );
  return { id, blocked, isCurrent, observation };
}
