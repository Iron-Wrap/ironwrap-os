import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../auth/session-context";
import type { AuthenticatedSession } from "../auth/session";
import type { OwnerNowResponse } from "./owner-contracts";
import { loadOwnerNow } from "./owner-api";
import { OwnerNowPage } from "./owner-now-page";
import { formatOwnerDate, groupOwnerExceptions, validJobId } from "./owner-now-utils";

vi.mock("./owner-api", () => ({ loadOwnerNow: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: { jobId?: string };
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} href={to === "/jobs/$jobId" && params?.jobId ? `/jobs/${params.jobId}` : to}>
      {children}
    </a>
  ),
}));

const ownerSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@ironwrapexteriors.com",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@example.test",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["owner.now.read"],
  allowed_actions: ["job.read"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-11T12:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-10T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const noLeadEvidence = {
  received_at: null,
  bus_status: null,
  triage_status: null,
  mctb: null,
} as const;

function ownerNowModel(): OwnerNowResponse {
  return {
    version: 1,
    source_updated_at: null,
    read_model_generated_at: "2026-07-10T12:01:00.000Z",
    stale_fields: ["exceptions.next_action", "exceptions.due_at"],
    permissions: ["owner.now.read"],
    allowed_actions: ["job.read"],
    exceptions: [
      {
        id: "checkin_blocked",
        kind: "field_blocker",
        severity: null,
        title: "Weather work-stop reported",
        why: "Wind exceeds the site plan limit.",
        next_action: null,
        job_id: "JOB-A",
        occurred_at: "2026-07-10 10:05:00",
        due_at: null,
        ...noLeadEvidence,
      },
      {
        id: "lead_a",
        kind: "untriaged_lead",
        severity: null,
        title: "Untriaged lead: Leslie",
        why: "Website estimate request",
        next_action: null,
        job_id: null,
        occurred_at: "2026-07-10T11:00:00.000Z",
        due_at: null,
        received_at: "2026-07-10T11:00:00.000Z",
        bus_status: "pushed",
        triage_status: "Untriaged",
        mctb: {
          state: "provider_accepted_within_sla",
          deadline_at: "2026-07-10T11:01:00.000Z",
          observed_at: "2026-07-10T11:00:45.000Z",
          channel: "email",
          proof_kind: "provider_receipt",
        },
      },
      {
        id: "lead_unknown",
        kind: "lead_triage_unknown",
        severity: null,
        title: "Lead triage is unknown: Morgan",
        why: "Website estimate request",
        next_action: null,
        job_id: null,
        occurred_at: "2026-07-10T11:05:00.000Z",
        due_at: null,
        received_at: "2026-07-10T11:05:00.000Z",
        bus_status: "pushed",
        triage_status: "Unknown",
        mctb: {
          state: "unproven_after_sla",
          deadline_at: "2026-07-10T11:06:00.000Z",
          observed_at: null,
          channel: null,
          proof_kind: null,
        },
      },
      {
        id: "gate_later",
        kind: "blocked_gate",
        severity: null,
        title: "Permit gate blocked",
        why: "Permit confirmation missing",
        next_action: null,
        job_id: "JOB-LATER",
        occurred_at: null,
        due_at: "2026-07-12 09:00:00",
        ...noLeadEvidence,
      },
      {
        id: "incident_a",
        kind: "automation_incident",
        severity: "Critical",
        title: "QuickBooks replay stalled",
        why: "Webhook receipt is unresolved",
        next_action: "Review the receipt evidence.",
        job_id: "JOB-A",
        occurred_at: "2026-07-10T17:30:00.000Z",
        due_at: "2026-07-10T18:00:00.000Z",
        ...noLeadEvidence,
      },
      {
        id: "gate_first",
        kind: "blocked_gate",
        severity: null,
        title: "Materials gate blocked",
        why: "Delivery not confirmed",
        next_action: null,
        job_id: "JOB-A",
        occurred_at: null,
        due_at: "2026-07-11 12:00:00",
        ...noLeadEvidence,
      },
      {
        id: "material_a",
        kind: "material_exception",
        severity: null,
        title: "Supplier order shortage",
        why: "Shingle quantity mismatch",
        next_action: null,
        job_id: "JOB-A",
        occurred_at: null,
        due_at: null,
        ...noLeadEvidence,
      },
      {
        id: "payment_a",
        kind: "finance_exception",
        severity: null,
        title: "Deposit needs review",
        why: "Webhook received",
        next_action: null,
        job_id: "../../not-a-job",
        occurred_at: null,
        due_at: null,
        ...noLeadEvidence,
      },
    ],
    partial_sources: ["field_blockers", "material_exceptions"],
    summary: {
      active_jobs: 3,
      field_blockers: 1,
      blocked_gates: 2,
      open_incidents: 1,
      finance_exceptions: 1,
      untriaged_leads: 1,
      lead_triage_unknown: 1,
      mctb_unproven_due: 1,
      material_exceptions: 1,
    },
  };
}

function renderOwner(session: AuthenticatedSession = ownerSession) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session}>
        <OwnerNowPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("OwnerNowPage", () => {
  beforeEach(() => {
    vi.mocked(loadOwnerNow).mockResolvedValue(ownerNowModel());
  });

  it("puts the work-stoppage groups first, signals stale source data, and avoids fake actions", async () => {
    const { container } = renderOwner();

    await screen.findByRole("heading", { name: "Crew-reported work stops" });

    expect(
      Array.from(container.querySelectorAll('section[aria-labelledby^="owner-exceptions-"]')).map(
        (section) => section.getAttribute("aria-labelledby"),
      ),
    ).toEqual([
      "owner-exceptions-field_blocker",
      "owner-exceptions-blocked_gate",
      "owner-exceptions-automation_incident",
      "owner-exceptions-material_exception",
      "owner-exceptions-finance_exception",
      "owner-exceptions-untriaged_lead",
      "owner-exceptions-lead_triage_unknown",
    ]);
    expect(screen.getByText("Source update time is unavailable.")).toBeVisible();
    expect(
      screen.getByText(/Stale fields: exceptions.next_action, exceptions.due_at/i),
    ).toBeVisible();
    expect(
      screen.getByText(
        /Some totals are lower bounds because these sources reached their query limit/i,
      ),
    ).toBeVisible();
    expect(screen.getByText(/Recorded .*10:05/)).toBeVisible();
    expect(screen.getByText("provider accepted within 60s")).toBeVisible();
    expect(screen.getByText("no provider proof after 60s")).toBeVisible();
    expect(screen.getByText(formatOwnerDate("2026-07-10T11:01:00.000Z"))).toBeVisible();
    expect(screen.getAllByText(formatOwnerDate("2026-07-10T11:00:45.000Z")).length).toBeGreaterThan(
      1,
    );
    expect(screen.getAllByText("Untriaged leads").length).toBeGreaterThan(0);
    expect(screen.queryByText("New leads")).not.toBeInTheDocument();
    expect(screen.queryByText(/sent|delivered|human follow-up/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("No verified next action was returned.").length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);

    expect(screen.getAllByRole("link", { name: "Open job JOB-A" })[0]!).toHaveAttribute(
      "href",
      "/jobs/JOB-A",
    );
    expect(screen.queryByRole("link", { name: /not-a-job/i })).not.toBeInTheDocument();
  });

  it("keeps the existing owner/ops access semantics for operations", async () => {
    const opsSession = {
      ...ownerSession,
      user: { ...ownerSession.user, role: "ops" as const },
    };

    renderOwner(opsSession);

    expect(await screen.findByRole("heading", { name: "Owner Now" })).toBeVisible();
    expect(loadOwnerNow).toHaveBeenCalledOnce();
  });

  it("keeps grouping and job links deterministic and defensive", () => {
    const groups = groupOwnerExceptions(ownerNowModel().exceptions);

    expect(groups.map((group) => group.kind)).toEqual([
      "field_blocker",
      "blocked_gate",
      "automation_incident",
      "material_exception",
      "finance_exception",
      "untriaged_lead",
      "lead_triage_unknown",
    ]);
    expect(groups[1]?.exceptions.map((exception) => exception.id)).toEqual([
      "gate_first",
      "gate_later",
    ]);
    expect(validJobId("JOB-A")).toBe(true);
    expect(validJobId("../../not-a-job")).toBe(false);
    expect(formatOwnerDate("2026-02-30")).toBe("Date unavailable");
  });
});
