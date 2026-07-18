import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return { ...actual, fetchSession: vi.fn() };
});

vi.mock("./field-bootstrap", () => ({ takePrimedFieldBootstrap: vi.fn() }));

import { AuthBoundary } from "./auth-boundary";
import { takePrimedFieldBootstrap } from "./field-bootstrap";
import { fetchSession, type SessionResponse } from "./session";

const pairingRequiredSession: SessionResponse = {
  version: 1,
  authenticated: false,
  user: null,
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: [],
  allowed_actions: ["auth.device_pairing.consume"],
  csrf_token: null,
  session_expires_at: null,
  source_updated_at: null,
  read_model_generated_at: "2026-07-10T12:00:00.000Z",
  stale_fields: ["field_device_repair_required"],
};

const unpairedSession: SessionResponse = {
  ...pairingRequiredSession,
  stale_fields: [],
};

describe("AuthBoundary", () => {
  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("directs a revoked field device to supervised QR re-pairing instead of office magic link", async () => {
    vi.mocked(fetchSession).mockResolvedValue(pairingRequiredSession);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthBoundary>
          <div>Authenticated work</div>
        </AuthBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("This field device needs a new pairing")).toBeVisible();
    expect(screen.queryByLabelText(/Email address/i)).not.toBeInTheDocument();
  });

  it("directs a fresh Field Companion visit to office-issued QR pairing instead of a magic link", async () => {
    window.history.replaceState({}, "", "/jobs/JOB-ACCEPTANCE");
    vi.mocked(fetchSession).mockResolvedValue(unpairedSession);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthBoundary>
          <div>Authenticated work</div>
        </AuthBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Pair this Field Companion device")).toBeVisible();
    expect(screen.queryByLabelText(/Work email/i)).not.toBeInTheDocument();
  });

  it("directs the primary Field Companion entry to QR pairing before a run sheet can load", async () => {
    window.history.replaceState({}, "", "/today");
    vi.mocked(takePrimedFieldBootstrap).mockResolvedValue({ session: unpairedSession });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthBoundary>
          <div>Authenticated work</div>
        </AuthBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Pair this Field Companion device")).toBeVisible();
    expect(screen.queryByText("Authenticated work")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Work email/i)).not.toBeInTheDocument();
  });

  it("retains email sign-in for an unpaired office route", async () => {
    window.history.replaceState({}, "", "/owner");
    vi.mocked(fetchSession).mockResolvedValue(unpairedSession);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthBoundary>
          <div>Authenticated work</div>
        </AuthBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Sign in to IronWrap OS")).toBeVisible();
    expect(screen.getByLabelText("Work email")).toBeVisible();
  });
});
