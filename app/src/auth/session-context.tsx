import { createContext, useContext, type ReactNode } from "react";

import type { AuthenticatedSession } from "./session";
import type { TodayResponse } from "../field/field-contracts";

const SessionContext = createContext<AuthenticatedSession | undefined>(undefined);
const InitialTodayContext = createContext<TodayResponse | undefined>(undefined);

export function SessionProvider({
  session,
  initialToday,
  children,
}: {
  session: AuthenticatedSession;
  initialToday?: TodayResponse;
  children: ReactNode;
}) {
  return (
    <SessionContext.Provider value={session}>
      <InitialTodayContext.Provider value={initialToday}>{children}</InitialTodayContext.Provider>
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
