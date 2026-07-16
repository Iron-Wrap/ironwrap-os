import { createContext, useContext, type ReactNode } from "react";

import type { AuthenticatedSession } from "./session";

const SessionContext = createContext<AuthenticatedSession | undefined>(undefined);

export function SessionProvider({
  session,
  children,
}: {
  session: AuthenticatedSession;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): AuthenticatedSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside the authenticated app shell.");
  return session;
}
