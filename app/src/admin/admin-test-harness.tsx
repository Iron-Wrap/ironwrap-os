import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import type { AppRole } from "../lib/roles";

export function sessionFor(
  role: AppRole,
  overrides: Partial<AuthenticatedSession> = {},
): AuthenticatedSession {
  return {
    version: 1,
    authenticated: true,
    user: {
      id: `appu_${role}`,
      email: `${role}@freshco.example`,
      display_name: "Ada Owner",
      role,
      frappe_user_id: null,
    },
    tenant: {
      id: "freshco",
      name: "FreshCo Exteriors",
      brand: "FreshCo",
      locale: "en-CA",
      time_zone: "America/Edmonton",
      currency: "CAD",
    },
    permissions: [],
    allowed_actions: [],
    csrf_token: "csrf",
    session_expires_at: "2036-08-22T00:00:00.000Z",
    source_updated_at: null,
    read_model_generated_at: "2026-08-22T12:00:00.000Z",
    stale_fields: [],
    ...overrides,
  } satisfies AuthenticatedSession;
}

export function renderWithSession(element: ReactElement, session: AuthenticatedSession) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session}>{element}</SessionProvider>
    </QueryClientProvider>,
  );
}
