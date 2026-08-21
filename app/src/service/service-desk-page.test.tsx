import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadServiceCases, openServiceCase } from "./service-api";
import { DIGEST_A, listResponse, serviceCase } from "./service-fixtures";
import { ServiceDeskPage } from "./service-desk-page";

vi.mock("./service-api", () => ({
  loadServiceCases: vi.fn(),
  openServiceCase: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: { caseId?: string };
  }) => (
    <a href={to.replace("$caseId", params?.caseId ?? "$caseId")} {...props}>
      {children}
    </a>
  ),
}));

const opsSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_ops",
    email: "ops@ironwrapexteriors.com",
    display_name: "Operations",
    role: "ops",
    frappe_user_id: "ops@ironwrapexteriors.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: [],
  allowed_actions: [],
  csrf_token: "csrf",
  session_expires_at: "2036-08-19T10:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-20T09:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function renderDesk() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={opsSession}>
        <ServiceDeskPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

async function fillIntake(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Customer ID"), "CUST-0001");
  await user.type(screen.getByLabelText("Property ID"), "PROP-0001");
  await user.type(screen.getByLabelText("Job ID"), "JOB-0001");
  await user.type(screen.getByLabelText("Problem code"), "interior_water_stain");
  await user.type(screen.getByLabelText("Contact rule ID"), "CONSENT-0001");
  await user.type(screen.getByLabelText("Proof code"), DIGEST_A);
}

describe("callback desk", () => {
  beforeEach(() => {
    vi.mocked(loadServiceCases).mockReset();
    vi.mocked(openServiceCase).mockReset();
  });

  it("lists every live callback with its severity, state, and response window", async () => {
    vi.mocked(loadServiceCases).mockResolvedValue(
      listResponse([
        serviceCase(),
        serviceCase({
          service_case_id: "svc_case_0002",
          symptom_code: "active_leak_occupied_room",
          severity: "emergency",
          state: "triaged",
          response_due_at: "2026-08-18T14:00:00.000Z",
        }),
      ]),
    );

    renderDesk();

    expect(await screen.findByText("interior water stain")).toBeInTheDocument();
    expect(screen.getByText("active leak occupied room")).toBeInTheDocument();
    expect(screen.getByText(/Emergency · Checked/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /active leak occupied room/ })).toHaveAttribute(
      "href",
      "/service/svc_case_0002",
    );
  });

  it("files a complaint and reports that the callback is only in intake", async () => {
    vi.mocked(loadServiceCases).mockResolvedValue(listResponse([]));
    vi.mocked(openServiceCase).mockResolvedValue({
      version: 1,
      read_model_generated_at: "2026-08-20T09:00:00.000Z",
      allowed_actions: [],
      result: "opened",
      service_case: serviceCase(),
      original_case: null,
    });
    const user = userEvent.setup();

    renderDesk();
    await screen.findByRole("heading", { name: "Service calls" });
    await fillIntake(user);
    await user.click(screen.getByRole("button", { name: /Save call/ }));

    await waitFor(() => expect(openServiceCase).toHaveBeenCalledTimes(1));
    expect(vi.mocked(openServiceCase).mock.calls[0]?.[1]).toMatchObject({
      customerId: "CUST-0001",
      roofJobId: "JOB-0001",
      symptomCode: "interior_water_stain",
      responseSlaMinutes: 1440,
    });
    expect(await screen.findByText("Callback saved")).toBeInTheDocument();
  });

  it("says plainly when a second report was kept as a linked duplicate", async () => {
    vi.mocked(loadServiceCases).mockResolvedValue(listResponse());
    vi.mocked(openServiceCase).mockResolvedValue({
      version: 1,
      read_model_generated_at: "2026-08-20T09:00:00.000Z",
      allowed_actions: [],
      result: "duplicate",
      service_case: serviceCase({
        service_case_id: "svc_case_0002",
        state: "closed",
        closure_reason: "duplicate",
        duplicate_of_case_id: "svc_case_0001",
        closed_at: "2026-08-18T10:30:00.000Z",
        last_event_type: "duplicate_linked",
      }),
      original_case: serviceCase(),
    });
    const user = userEvent.setup();

    renderDesk();
    await screen.findByRole("heading", { name: "Service calls" });
    await fillIntake(user);
    await user.click(screen.getByRole("button", { name: /Save call/ }));

    expect(await screen.findByText("This call is already open")).toBeInTheDocument();
  });

  it("will not let an emergency callback be filed behind a routine response window", async () => {
    vi.mocked(loadServiceCases).mockResolvedValue(listResponse([]));
    const user = userEvent.setup();

    renderDesk();
    await screen.findByRole("heading", { name: "Service calls" });
    await fillIntake(user);
    await user.selectOptions(screen.getByLabelText("Need level"), "emergency");

    expect(await screen.findByText("An emergency cannot wait that long")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save call/ })).toBeDisabled();
    expect(openServiceCase).not.toHaveBeenCalled();
  });
});
