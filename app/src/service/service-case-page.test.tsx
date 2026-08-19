import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadServiceCase, recordServiceTriage, verifyServiceRemedy } from "./service-api";
import {
  DIGEST_B,
  OWNER_ACTIONS,
  claim,
  detailResponse,
  diagnosis,
  remedy,
  serviceCase,
  triage,
} from "./service-fixtures";
import { ServiceCasePage } from "./service-case-page";

vi.mock("./service-api", () => ({
  loadServiceCase: vi.fn(),
  recordServiceTriage: vi.fn(),
  recordServiceDiagnosis: vi.fn(),
  issueServiceRemedy: vi.fn(),
  verifyServiceRemedy: vi.fn(),
  recordCustomerServiceDecision: vi.fn(),
  closeServiceCase: vi.fn(),
  reopenServiceCase: vi.fn(),
  openCostRecoveryClaim: vi.fn(),
  reconcileCostRecoveryClaim: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ caseId: "svc_case_0001" }),
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

function session(role: "owner" | "ops"): AuthenticatedSession {
  return {
    version: 1,
    authenticated: true,
    user: {
      id: role === "owner" ? "appu_owner" : "appu_ops",
      email: `${role}@ironwrapexteriors.com`,
      display_name: role,
      role,
      frappe_user_id: `${role}@ironwrapexteriors.com`,
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
}

function renderCase(role: "owner" | "ops" = "ops") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session(role)}>
        <ServiceCasePage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("service case", () => {
  beforeEach(() => {
    vi.mocked(loadServiceCase).mockReset();
    vi.mocked(recordServiceTriage).mockReset();
    vi.mocked(verifyServiceRemedy).mockReset();
  });

  it("offers triage, and only triage, on a case still in intake", async () => {
    vi.mocked(loadServiceCase).mockResolvedValue(detailResponse());
    renderCase();

    expect(await screen.findByRole("form", { name: "Triage this callback" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Record the diagnosis" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Verify the remedy" })).toBeNull();
    expect(screen.getByText("case opened")).toBeInTheDocument();
  });

  it("records a triage decision without ever naming the decision maker in the form", async () => {
    vi.mocked(loadServiceCase).mockResolvedValue(detailResponse());
    vi.mocked(recordServiceTriage).mockResolvedValue({
      version: 1,
      read_model_generated_at: "2026-08-20T09:00:00.000Z",
      allowed_actions: [],
      service_case: serviceCase({ state: "triaged", version: 2, last_event_type: "triaged" }),
      triage: triage(),
    });
    const user = userEvent.setup();

    renderCase();
    await screen.findByRole("form", { name: "Triage this callback" });
    await user.type(screen.getByLabelText("Triage evidence digest"), DIGEST_B);
    await user.click(screen.getByRole("button", { name: "Record triage" }));

    await waitFor(() => expect(recordServiceTriage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(recordServiceTriage).mock.calls[0]?.[2]).toEqual({
      advisorySource: "none",
      finalCategory: "workmanship",
      responsibility: "ironwrap_workmanship",
      evidenceDigest: DIGEST_B,
    });
  });

  it("refuses to send a triage that would let an unknown category assign blame", async () => {
    vi.mocked(loadServiceCase).mockResolvedValue(detailResponse());
    const user = userEvent.setup();

    renderCase();
    await screen.findByRole("form", { name: "Triage this callback" });
    await user.type(screen.getByLabelText("Triage evidence digest"), DIGEST_B);
    await user.selectOptions(screen.getByLabelText("Category"), "unknown");

    expect(await screen.findByText(/An unknown category may not assign blame/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record triage" })).toBeDisabled();
  });

  it("asks the supervisor to verify once a remedy has been issued", async () => {
    vi.mocked(loadServiceCase).mockResolvedValue(
      detailResponse({
        service_case: serviceCase({
          state: "remedy_issued",
          version: 4,
          last_event_type: "remedy_issued",
        }),
        triage: [triage()],
        diagnoses: [diagnosis()],
        remedies: [remedy()],
      }),
    );
    vi.mocked(verifyServiceRemedy).mockResolvedValue({
      version: 1,
      read_model_generated_at: "2026-08-20T09:00:00.000Z",
      allowed_actions: [],
      service_case: serviceCase({
        state: "diagnosed",
        version: 5,
        last_event_type: "remedy_failed",
      }),
      remedy: remedy({ verification_state: "failed", failure_code: "leak_persists" }),
    });
    const user = userEvent.setup();

    renderCase();
    await screen.findByRole("form", { name: "Verify the remedy" });
    await user.selectOptions(screen.getByLabelText("Outcome"), "failed");
    await user.type(screen.getByLabelText("Field evidence digest"), DIGEST_B);
    await user.type(screen.getByLabelText("Failure code"), "leak_persists");
    await user.click(screen.getByRole("button", { name: "Record verification" }));

    await waitFor(() => expect(verifyServiceRemedy).toHaveBeenCalledTimes(1));
    expect(vi.mocked(verifyServiceRemedy).mock.calls[0]?.[2]).toBe("svc_remedy_0001");
    expect(vi.mocked(verifyServiceRemedy).mock.calls[0]?.[3]).toMatchObject({
      outcome: "failed",
      failureCode: "leak_persists",
    });
  });

  it("shows measured cost and keeps claiming money back with the owner", async () => {
    const withCost = {
      triage: [triage()],
      diagnoses: [diagnosis()],
      remedies: [remedy({ verification_state: "verified", cost_actual_cents: 98_000 })],
      cost_recovery_claims: [claim({ state: "succeeded", recovered_amount_cents: 110_000 })],
      cost: {
        warranty_reserve_cents: 120_000,
        actual_cost_cents: 98_000,
        recovered_cents: 110_000,
        net_cost_cents: 0,
        recurrence_count: 1,
      },
      service_case: serviceCase({
        state: "closed",
        closure_reason: "remedied_accepted",
        closed_at: "2026-08-27T09:00:00.000Z",
        version: 7,
        last_event_type: "closed",
      }),
    };
    vi.mocked(loadServiceCase).mockResolvedValue(detailResponse(withCost));

    const { unmount } = renderCase("ops");
    expect(await screen.findByText("$1,200.00")).toBeInTheDocument();
    expect(screen.getByText("$980.00")).toBeInTheDocument();
    expect(screen.getByText("$1,100.00")).toBeInTheDocument();
    expect(
      screen.getByText(/Claiming money back from a supplier, manufacturer, or insurer/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Claim this cost back" })).toBeNull();
    unmount();

    vi.mocked(loadServiceCase).mockResolvedValue(
      detailResponse({ ...withCost, allowed_actions: OWNER_ACTIONS }),
    );
    renderCase("owner");
    expect(await screen.findByRole("form", { name: "Claim this cost back" })).toBeInTheDocument();
  });

  it("offers reconciliation as the only exit from an uncertain claim", async () => {
    vi.mocked(loadServiceCase).mockResolvedValue(
      detailResponse({
        allowed_actions: OWNER_ACTIONS,
        triage: [triage()],
        diagnoses: [diagnosis()],
        cost_recovery_claims: [
          claim({
            state: "uncertain",
            attempt_count: 1,
            attempt_mode: "leased",
            attempted_at: "2026-08-20T09:20:00.000Z",
            lease_ref: "svc-recovery:0123456789abcdef",
            result_ref: "supplier-claim:unknown",
            result_code: "submission_timeout",
          }),
        ],
      }),
    );

    renderCase("owner");
    expect(
      await screen.findByRole("form", { name: "Reconcile this uncertain claim" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/one attempt permitted/)).toBeInTheDocument();
  });

  it("shows the rule that refused a step instead of a generic failure", async () => {
    vi.mocked(loadServiceCase).mockResolvedValue(detailResponse());
    vi.mocked(recordServiceTriage).mockRejectedValue(
      new ApiError({
        status: 409,
        code: "service_case_transition_conflict",
        message: "service_case_transition_conflict",
      }),
    );
    const user = userEvent.setup();

    renderCase();
    await screen.findByRole("form", { name: "Triage this callback" });
    await user.type(screen.getByLabelText("Triage evidence digest"), DIGEST_B);
    await user.click(screen.getByRole("button", { name: "Record triage" }));

    expect(await screen.findByText("That step was refused")).toBeInTheDocument();
    expect(screen.getByText("service_case_transition_conflict")).toBeInTheDocument();
  });
});
