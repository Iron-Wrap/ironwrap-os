import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return { ...actual, fetchSession: vi.fn() };
});

vi.mock("./field-bootstrap", () => ({
  fetchFieldBootstrap: vi.fn(),
  takePrimedFieldBootstrap: vi.fn(),
}));

vi.mock("./device-credential", () => ({
  clearDeviceSecret: vi.fn(),
  getDeviceSecret: vi.fn(),
}));

import { AuthBoundary } from "./auth-boundary";
import { clearDeviceSecret, getDeviceSecret } from "./device-credential";
import { fetchFieldBootstrap, takePrimedFieldBootstrap } from "./field-bootstrap";
import { fetchSession, type SessionResponse } from "./session";
import { ApiError } from "../lib/api";

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
    vi.mocked(getDeviceSecret).mockResolvedValue(undefined);
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

    expect(await screen.findByText("Pair this crew phone again")).toBeVisible();
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

    expect(await screen.findByText("Pair this crew phone")).toBeVisible();
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

    expect(await screen.findByText("Pair this crew phone")).toBeVisible();
    expect(screen.queryByText("Authenticated work")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Work email/i)).not.toBeInTheDocument();
  });

  it("admits an office session on a direct Today entry through the combined bootstrap", async () => {
    window.history.replaceState({}, "", "/today");
    vi.mocked(takePrimedFieldBootstrap).mockResolvedValue({
      session: {
        ...unpairedSession,
        authenticated: true,
        user: {
          id: "appu_ops",
          email: "ops@example.invalid",
          display_name: "Operations",
          role: "ops",
          frappe_user_id: "ops@example.invalid",
        },
        tenant: unpairedSession.tenant!,
        permissions: ["session:read", "today:read", "jobs:read:any"],
        allowed_actions: ["session.logout", "today.read", "job.read"],
        csrf_token: "csrf",
        session_expires_at: "2026-07-11T12:00:00.000Z",
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthBoundary>
          <div>Authenticated office work</div>
        </AuthBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Authenticated office work")).toBeVisible();
  });

  it("does not label an unavailable API as an offline device", async () => {
    window.history.replaceState({}, "", "/today");
    vi.mocked(takePrimedFieldBootstrap).mockRejectedValue(
      new ApiError({ status: 404, code: "not_found", message: "Not Found" }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthBoundary>
          <div>Authenticated work</div>
        </AuthBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: "IronWrap OS is not ready" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "This device needs the internet" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Not Found")).not.toBeInTheDocument();
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

  it("offers both office sign-in and supervised crew pairing at the unified entry", async () => {
    window.history.replaceState({}, "", "/now");
    vi.mocked(getDeviceSecret).mockResolvedValue(undefined);
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
    expect(screen.getByRole("heading", { name: "Crew phone" })).toBeVisible();
    expect(screen.getByText(/scan the QR code on this phone/i)).toBeVisible();
  });

  it("uses the combined field bootstrap at the unified entry when the phone is paired", async () => {
    window.history.replaceState({}, "", "/now");
    vi.mocked(getDeviceSecret).mockResolvedValue("a".repeat(43));
    vi.mocked(fetchFieldBootstrap).mockResolvedValue({ session: unpairedSession });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthBoundary>
          <div>Authenticated work</div>
        </AuthBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Crew phone" })).toBeVisible();
    expect(fetchFieldBootstrap).toHaveBeenCalledOnce();
    expect(fetchSession).not.toHaveBeenCalled();
  });

  it("recovers an office session from a stale field-device proof at the unified entry", async () => {
    window.history.replaceState({}, "", "/now");
    vi.mocked(getDeviceSecret).mockResolvedValue("a".repeat(43));
    vi.mocked(fetchFieldBootstrap).mockRejectedValue(
      new ApiError({
        status: 403,
        code: "today_read_required",
        message: "Forbidden",
      }),
    );
    const officeSession = {
      ...unpairedSession,
      authenticated: true as const,
      user: {
        id: "appu_production",
        email: "production@example.invalid",
        display_name: "Production",
        role: "production" as const,
        frappe_user_id: null,
      },
      tenant: unpairedSession.tenant!,
      csrf_token: "csrf",
      session_expires_at: "2026-07-11T12:00:00.000Z",
    };
    vi.mocked(fetchSession).mockResolvedValue(officeSession);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthBoundary>
          <div>Authenticated production work</div>
        </AuthBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Authenticated production work")).toBeVisible();
    expect(clearDeviceSecret).toHaveBeenCalledOnce();
    expect(fetchSession).toHaveBeenCalledOnce();
  });
});
