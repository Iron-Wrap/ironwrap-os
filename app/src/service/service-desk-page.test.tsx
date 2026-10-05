import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
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

  it("says one plain sentence when the save fails and keeps the office's wording out of sight", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadServiceCases).mockResolvedValue(listResponse([]));
    vi.mocked(openServiceCase).mockRejectedValue(
      new ApiError({
        status: 400,
        code: "service_case_intake_invalid",
        message: "D1_ERROR: constraint failed: service_cases.consent_ref",
        requestId: "req-service-42",
      }),
    );
    const user = userEvent.setup();

    renderDesk();
    await screen.findByRole("heading", { name: "Service calls" });
    await fillIntake(user);
    await user.click(screen.getByRole("button", { name: /Save call/ }));

    expect(await screen.findByText("The call was not saved")).toBeInTheDocument();
    expect(screen.getByText(/Check the details and try again\./)).toBeVisible();
    expect(screen.queryByText(/D1_ERROR|constraint failed/)).not.toBeInTheDocument();
    // The code and the request reference wait behind the one disclosure.
    expect(screen.getByText("service_case_intake_invalid")).not.toBeVisible();
    await user.click(screen.getByText("System details"));
    expect(screen.getByText("service_case_intake_invalid")).toBeVisible();
    expect(screen.getByText("req-service-42")).toBeVisible();
    quiet.mockRestore();
  });

  it("does not claim the call was not saved when the server failed after it was sent", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadServiceCases).mockResolvedValue(listResponse([]));
    vi.mocked(openServiceCase).mockRejectedValue(
      new ApiError({ status: 502, code: "service_case_store_unavailable", message: "Bad Gateway" }),
    );
    const user = userEvent.setup();

    renderDesk();
    await screen.findByRole("heading", { name: "Service calls" });
    await fillIntake(user);
    await user.click(screen.getByRole("button", { name: /Save call/ }));

    // The Worker can write the call and still fail before it answers.
    expect(await screen.findByText("The call was not confirmed")).toBeVisible();
    expect(
      screen.getByText(
        "We could not confirm the call was saved. Check the list of calls before you save it again.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/was not saved|Nothing was changed/)).not.toBeInTheDocument();
    quiet.mockRestore();
  });

  it("does not promise saved work on this device when the connection drops during a save", async () => {
    vi.mocked(loadServiceCases).mockResolvedValue(listResponse([]));
    vi.mocked(openServiceCase).mockRejectedValue(
      new ApiError({
        status: 0,
        code: "network_error",
        message: "No connection to IronWrap OS. Your saved work stays on this device.",
      }),
    );
    const user = userEvent.setup();

    renderDesk();
    await screen.findByRole("heading", { name: "Service calls" });
    await fillIntake(user);
    await user.click(screen.getByRole("button", { name: /Save call/ }));

    expect(
      await screen.findByText(/The connection dropped before IronWrap OS answered/),
    ).toBeVisible();
    expect(screen.queryByText(/saved work stays/i)).not.toBeInTheDocument();
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
