import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
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
import { useSession } from "./session-context";
import { ApiError } from "../lib/api";
import { getOutboxAction, queueOutboxAction, saveOutboxAction } from "../storage/outbox";

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

describe("AuthBoundary after an offline reload", () => {
  const liveSession: SessionResponse = {
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
    permissions: ["session:read"],
    allowed_actions: ["session.logout"],
    csrf_token: "csrf-live",
    session_expires_at: "2026-07-11T12:00:00.000Z",
  };
  const offlineSnapshot: SessionResponse = {
    ...liveSession,
    csrf_token: "offline-session-no-csrf",
    stale_fields: ["session.offline_snapshot"],
  };
  function ShowToken() {
    const session = useSession();
    return <div>token: {session.csrf_token}</div>;
  }
  async function queueOneAction() {
    const saved = await saveOutboxAction({
      tenantId: liveSession.tenant!.id,
      userId: "appu_ops",
      kind: "safety_action",
      endpoint: "/api/v1/safety/actions",
      payload: { kind: "hazard_report", description: "Loose guard rail on the east scaffold." },
    });
    await queueOutboxAction(saved.deviceActionId);
    return saved.deviceActionId;
  }
  function renderBoundary() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuthBoundary>
          <ShowToken />
        </AuthBoundary>
      </QueryClientProvider>,
    );
  }

  it("re-checks the sign-in when the network returns so queued work can upload", async () => {
    vi.mocked(fetchSession)
      .mockResolvedValueOnce(offlineSnapshot)
      .mockResolvedValueOnce(liveSession);
    const deviceActionId = await queueOneAction();
    renderBoundary();
    expect(await screen.findByText("token: offline-session-no-csrf")).toBeVisible();

    act(() => window.dispatchEvent(new Event("online")));

    expect(await screen.findByText("token: csrf-live")).toBeVisible();
    expect(fetchSession).toHaveBeenCalledTimes(2);
    expect((await getOutboxAction(deviceActionId))?.state).toBe("queued");
  });

  it("closes the authenticated content when the held snapshot has expired and the re-check cannot reach the server", async () => {
    const expired: SessionResponse = {
      ...offlineSnapshot,
      session_expires_at: "2020-01-01T00:00:00.000Z",
    };
    vi.mocked(fetchSession)
      .mockResolvedValueOnce(expired)
      // Status 0 is retried once by the boundary; every attempt fails the same way.
      .mockRejectedValue(
        new ApiError({ status: 0, code: "network_unavailable", message: "Offline." }),
      );
    const deviceActionId = await queueOneAction();
    renderBoundary();
    expect(await screen.findByText("token: offline-session-no-csrf")).toBeVisible();

    act(() => window.dispatchEvent(new Event("online")));

    expect(await screen.findByText("This device needs the internet")).toBeVisible();
    expect(screen.queryByText(/token:/)).not.toBeInTheDocument();
    expect((await getOutboxAction(deviceActionId))?.state).toBe("queued");
  });

  it("closes the authenticated content when the server rejects the held sign-in outright", async () => {
    vi.mocked(fetchSession)
      .mockResolvedValueOnce(offlineSnapshot)
      .mockRejectedValueOnce(
        new ApiError({ status: 401, code: "session_invalid", message: "Sign in again." }),
      );
    const deviceActionId = await queueOneAction();
    renderBoundary();
    expect(await screen.findByText("token: offline-session-no-csrf")).toBeVisible();

    act(() => window.dispatchEvent(new Event("online")));

    expect(await screen.findByText("IronWrap OS is not ready")).toBeVisible();
    expect(screen.queryByText(/token:/)).not.toBeInTheDocument();
    const kept = await getOutboxAction(deviceActionId);
    expect(kept?.state).toBe("queued");
    expect(kept?.payload).toMatchObject({ kind: "hazard_report" });
  });

  it("keeps the offline sign-in and every queued item when the re-check fails", async () => {
    vi.mocked(fetchSession)
      .mockResolvedValueOnce(offlineSnapshot)
      .mockRejectedValueOnce(
        new ApiError({ status: 503, code: "session_unavailable", message: "Try again later." }),
      );
    const deviceActionId = await queueOneAction();
    renderBoundary();
    expect(await screen.findByText("token: offline-session-no-csrf")).toBeVisible();

    act(() => window.dispatchEvent(new Event("online")));

    await waitFor(() => expect(fetchSession).toHaveBeenCalledTimes(2));
    expect(screen.getByText("token: offline-session-no-csrf")).toBeVisible();
    expect(screen.queryByText("This device needs the internet")).not.toBeInTheDocument();
    const kept = await getOutboxAction(deviceActionId);
    expect(kept?.state).toBe("queued");
    expect(kept?.payload).toMatchObject({ kind: "hazard_report" });
  });
});
