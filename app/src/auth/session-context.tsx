import { createContext, useContext, type ReactNode } from "react";

import type { AuthenticatedSession } from "./session";
import type { TodayResponse } from "../field/field-contracts";
import { setSessionReadObservation, type PrincipalReadObservation } from "./principal-context";

const SessionContext = createContext<AuthenticatedSession | undefined>(undefined);
const InitialTodayContext = createContext<TodayResponse | undefined>(undefined);
const FieldReadObservationContext = createContext<PrincipalReadObservation | undefined>(undefined);

export function SessionProvider({
  session,
  initialToday,
  readObservation,
  children,
}: {
  session: AuthenticatedSession;
  initialToday?: TodayResponse;
  readObservation?: PrincipalReadObservation;
  children: ReactNode;
}) {
  setSessionReadObservation(session, readObservation);
  return (
    <SessionContext.Provider value={session}>
      <FieldReadObservationContext.Provider value={readObservation}>
        <InitialTodayContext.Provider value={initialToday}>{children}</InitialTodayContext.Provider>
      </FieldReadObservationContext.Provider>
    </SessionContext.Provider>
  );
}

export function useSession(): AuthenticatedSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside the authenticated app shell.");
  return session;
}

export function useInitialToday(): TodayResponse | undefined {
  return useContext(InitialTodayContext);
}
export function useFieldReadObservation(): PrincipalReadObservation | undefined {
  return useContext(FieldReadObservationContext);
}
