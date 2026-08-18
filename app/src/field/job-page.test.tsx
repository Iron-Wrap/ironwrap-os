import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { apiCommand } from "../lib/api";
import { getOutboxAction, queueOutboxAction, saveOutboxAction } from "../storage/outbox";
import { flushOutbox } from "../storage/outbox-processor";
import type { OutboxAction } from "../storage/outbox-types";
import type { JobResponse, WorkObjectResponse } from "./field-contracts";
import { loadJob, loadWorkObject } from "./field-cache";
import { JobPage, WorkObjectPage } from "./field-pages";

vi.mock("./field-cache", () => ({
  hasCachedJobPacket: vi.fn(),
  loadJob: vi.fn(),
  loadWorkObject: vi.fn(),
  loadProofPage: vi.fn(),
  loadToday: vi.fn(),
  prefetchAssignedPackets: vi.fn(),
}));

vi.mock("../storage/outbox", () => ({
  getOutboxAction: vi.fn(),
  queueOutboxAction: vi.fn(),
  saveOutboxAction: vi.fn(),
}));

vi.mock("../storage/outbox-processor", () => ({ flushOutbox: vi.fn() }));

vi.mock("../lib/api", () => ({ apiCommand: vi.fn() }));

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
    <a
      {...props}
      href={
        to === "/jobs/$jobId" && params?.jobId
          ? `/jobs/${params.jobId}`
          : to === "/check-in/$jobId" && params?.jobId
            ? `/check-in/${params.jobId}`
            : to
      }
    >
      {children}
    </a>
  ),
  useParams: () => routeParams,
}));

let routeParams: Record<string, string> = { jobId: "JOB-1" };

const fieldSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_field_user",
    email: "crew@example.com",
    display_name: "Crew",
    role: "field",
    frappe_user_id: "crew@example.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:assigned"],
  allowed_actions: ["field.checkin.create"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-11T12:00:00.000Z",
  source_updated_at: "2026-07-10T12:00:00.000Z",
  read_model_generated_at: "2026-07-10T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const productionSession = {
  ...fieldSession,
  user: {
    ...fieldSession.user,
    id: "appu_production",
    email: "production@example.invalid",
    display_name: "Production",
    role: "production",
    frappe_user_id: null,
  },
  permissions: ["jobs:read:any", "production:read"],
  allowed_actions: ["session.logout", "now.read", "production.read", "job.read"],
} satisfies AuthenticatedSession;

const ownerSession = {
  ...fieldSession,
  user: {
    ...fieldSession.user,
    id: "appu_owner",
    email: "owner@example.com",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@example.com",
  },
  permissions: ["jobs:read:any", "now:read"],
  allowed_actions: ["session.logout", "now.read", "job.read"],
} satisfies AuthenticatedSession;

function jobModel(overrides: Partial<JobResponse> = {}): JobResponse {
  return {
    version: 1,
    source_updated_at: "2026-07-10T12:00:00.000Z",
    read_model_generated_at: "2026-07-10T12:00:00.000Z",
    stale_fields: [],
    permissions: ["jobs:read:assigned"],
    allowed_actions: ["field.checkin.create"],
    job: {
      id: "JOB-1",
      roof_job_id: "roof-job-1",
      job_number: "IW-1042",
      brand: "IronWrap Exteriors",
      service_type: "Roofing",
      status: "In Production",
      address: "123 Example Avenue, Calgary, AB",
      current_gate_state: "Blocked",
    },
    assignment: {
      id: "ASSIGN-1",
      assignment_id: "assignment-1",
      type: "Production",
      status: "Assigned",
      crew_profile: null,
      scheduled_start: "2026-07-10T16:00:00.000Z",
      scheduled_end: null,
      blocker_reason: null,
    },
    gates: [
      {
        id: "GATE-1",
        name: "Materials",
        state: "Blocked",
        blocker_reason: "Delivery confirmation is missing",
        owner: "Production dispatch",
        due_at: "2026-07-10T17:00:00.000Z",
      },
    ],
    packet: {
      scope_clauses: [
        {
          id: "SCOPE-1",
          type: "Scope",
          title: "Replace shingles",
          text: "North slope",
          version: "1",
        },
      ],
      measurements: [
        {
          id: "MEASURE-1",
          provider: "RoofRuler",
          review_status: "Reviewed",
          parsed_at: "2026-07-10T15:00:00.000Z",
        },
      ],
      materials: { takeoffs: [], supplier_orders: [] },
      change_orders: [],
      safety_plan: {
        id: "SAFETY-1",
        version: 2,
        status: "Ready",
        effective_date: "2026-07-10",
        hazard_summary: "Steep-slope fall exposure",
        controls: "Use roof anchors and harnesses",
        emergency_plan: "Call dispatch and emergency services",
        ppe_requirements: "Harness and eye protection",
        weather_limits: "Stop above plan wind limit",
      },
      contact: {
        display_name: "Jamie Homeowner",
        phone: "+14035550123",
        access_instructions: null,
      },
      work_package: null,
    },
    proof_stream: [
      {
        id: "PROOF-1",
        type: "Photo",
        proof_slot: "Production",
        occurred_at: "2026-07-10T15:30:00.000Z",
        summary: "Arrival condition",
        customer_safe: false,
        source: "field_checkin",
        sync_state: "Verified",
        blocker: true,
      },
    ],
    proof_page: { next_cursor: "100", page_size: 100 },
    required_proof: [
      {
        id: "GATE-1",
        slot: "Materials",
        label: "Materials proof",
        state: "Blocked",
        blocker_reason: "Delivery confirmation is missing",
      },
    ],
    ...overrides,
  };
}

function releasedWorkPackage(): NonNullable<JobResponse["packet"]["work_package"]> {
  return {
    id: "WP-1",
    version: 3,
    status: "Released",
    title: "North slope replacement",
    objective: "Replace the north slope to the released drawing.",
    boundaries: "North slope only; no fascia scope.",
    prerequisites: "Materials staged and fall protection inspected.",
    expected_result: "Weather-tight completed north slope.",
    stop_conditions: "Stop for wind above the plan limit or unprotected edge exposure.",
    make_safe_procedure: "Secure loose materials and maintain the fall-protection boundary.",
    issued_at: "2026-07-10T15:00:00.000Z",
    released_at: "2026-07-10T15:15:00.000Z",
    expires_at: "2026-07-10T23:00:00.000Z",
    work_object_type: "Roof Job",
    work_object_id: "JOB-1",
    physical_context_type: "Roof Site",
    physical_context_id: "JOB-1",
    release_attempt_id: "wpe_release_attempt_00000001",
    supersession: null,
    acknowledgement: {
      current_user_acknowledged: false,
      acknowledged_at: null,
      workers: [
        {
          worker_user: "crew@example.com",
          worker_role: "Installer",
          required: true,
          acknowledged: false,
          acknowledged_at: null,
        },
      ],
    },
    evidence_slots: [],
    steps: [
      {
        sequence: 1,
        instruction: "Inspect anchors before roof access.",
        required_evidence: "Anchor inspection photo.",
        acceptance_criteria: "Anchor and harness connection are visible.",
      },
    ],
    hold_points: [
      {
        sequence: 1,
        hold_point: "Deck condition review",
        release_phase: "Pre-start",
        release_authority: "Production manager",
        required_evidence: "Deck condition photo.",
        acceptance_criteria: "Production manager independently releases the hold.",
        released: false,
      },
    ],
  };
}

function workPackageModel(overrides: Partial<JobResponse> = {}): JobResponse {
  const model = jobModel();
  return {
    ...model,
    gates: [],
    allowed_actions: [
      "field.checkin.create",
      "work_package.acknowledge",
      "work_package.stop_work",
      "work_package.start",
    ],
    packet: { ...model.packet, work_package: releasedWorkPackage() },
    ...overrides,
  };
}

function startableWorkPackageModel(): JobResponse {
  const model = workPackageModel();
  const workPackage = model.packet.work_package;
  if (!workPackage) throw new Error("Expected a Work Package fixture.");
  return {
    ...model,
    packet: {
      ...model.packet,
      work_package: {
        ...workPackage,
        status: "Acknowledged",
        acknowledgement: {
          current_user_acknowledged: true,
          acknowledged_at: "2026-07-10T15:20:00.000Z",
          workers: [
            {
              worker_user: "crew@example.com",
              worker_role: "Installer",
              required: true,
              acknowledged: true,
              acknowledged_at: "2026-07-10T15:20:00.000Z",
            },
          ],
        },
        hold_points: workPackage.hold_points.map((holdPoint) => ({
          ...holdPoint,
          released: true,
        })),
      },
    },
  };
}

function queuedWorkPackageAction(
  kind: "work_package_acknowledgement" | "work_package_stop",
): OutboxAction {
  return {
    deviceActionId: `${kind}-action`,
    tenantId: fieldSession.tenant.id,
    userId: fieldSession.user.id,
    kind,
    endpoint:
      kind === "work_package_acknowledgement"
        ? "/api/v1/jobs/JOB-1/work-package/acknowledgements"
        : "/api/v1/jobs/JOB-1/work-package/stop-work",
    method: "POST",
    payload:
      kind === "work_package_acknowledgement"
        ? {
            work_package_id: "WP-1",
            work_package_version: 3,
            release_attempt_id: "wpe_release_attempt_00000001",
          }
        : {
            work_package_id: "WP-1",
            work_package_version: 3,
            blocker_reason: "Wind exceeds the plan limit.",
          },
    attachments: [],
    state: "queued",
    attempts: 0,
    nextAttemptAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    version: 2,
  };
}

function renderJob(model = jobModel(), session: AuthenticatedSession = fieldSession) {
  vi.mocked(loadJob).mockResolvedValue(model);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={session}>
        <JobPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

function workObjectModel(): WorkObjectResponse {
  const model = workPackageModel();
  const workPackage = model.packet.work_package;
  if (!workPackage) throw new Error("Expected a Work Package fixture.");
  return {
    version: model.version,
    source_updated_at: model.source_updated_at,
    read_model_generated_at: model.read_model_generated_at,
    stale_fields: model.stale_fields,
    permissions: model.permissions,
    allowed_actions: [
      "field.checkin.create",
      "work_package.acknowledge",
      "work_package.stop_work",
      "work_package.start",
      "work_package.complete",
    ],
    work_object: {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    },
    assignment: model.assignment,
    work_package: {
      ...workPackage,
      work_object_type: "Shop Order",
      work_object_id: "SHOP-001",
      physical_context_type: "Shop Floor",
      physical_context_id: "SHOP-FLOOR-1",
    },
  };
}

function renderWorkObject(model = workObjectModel(), session: AuthenticatedSession = fieldSession) {
  vi.mocked(loadWorkObject).mockResolvedValue(model);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={session}>
        <WorkObjectPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("JobPage", () => {
  const originalOnline = navigator.onLine;

  beforeEach(() => {
    vi.clearAllMocks();
    routeParams = { jobId: "JOB-1" };
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.mocked(getOutboxAction).mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: originalOnline });
  });

  it("renders a typed Shop Order packet as an actionable field surface", async () => {
    routeParams = {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    };
    renderWorkObject();

    expect(await screen.findByRole("heading", { name: "SHOP-001" })).toBeVisible();
    expect(screen.getAllByText("Shop Floor · SHOP-FLOOR-1")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Acknowledge this package" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop Work and save report" })).toBeVisible();
    expect(screen.getAllByRole("link", { name: /Capture evidence/ })[0]).toHaveAttribute(
      "href",
      expect.stringContaining(
        "work_object_type=Shop+Order&work_object_id=SHOP-001&physical_context_type=Shop+Floor&physical_context_id=SHOP-FLOOR-1",
      ),
    );
    expect(loadWorkObject).toHaveBeenCalledWith(fieldSession, {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    });
  });

  it("renders typed completion only when the server grants the exact capability", async () => {
    routeParams = {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    };
    const model = workObjectModel();
    const workPackage = model.work_package;
    if (!workPackage) throw new Error("Expected a Work Package fixture.");
    renderWorkObject(
      {
        ...model,
        allowed_actions: ["work_package.complete"],
        work_package: {
          ...workPackage,
          status: "In Progress",
        },
      },
      ownerSession,
    );

    expect(await screen.findByRole("heading", { name: "SHOP-001" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Complete work package" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Complete from current ledger" })).toBeVisible();

    const user = userEvent.setup();
    vi.mocked(apiCommand).mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "Complete from current ledger" }));
    await waitFor(() => expect(apiCommand).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiCommand).mock.calls[0]?.[0]).toMatchObject({
      path: "/api/v1/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1/work-package/complete",
      body: {
        payload: {
          work_package_id: "WP-1",
          work_package_version: 3,
          release_attempt_id: "wpe_release_attempt_00000001",
          work_object_type: "Shop Order",
          work_object_id: "SHOP-001",
          physical_context_type: "Shop Floor",
          physical_context_id: "SHOP-FLOOR-1",
        },
      },
    });
  });

  it("hides typed completion from unrelated office sessions", async () => {
    routeParams = {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    };
    const unrelatedSessions: AuthenticatedSession[] = [
      ownerSession,
      {
        ...ownerSession,
        user: {
          ...ownerSession.user,
          id: "appu_ops",
          email: "ops@example.invalid",
          display_name: "Operations",
          role: "ops",
          frappe_user_id: "ops@example.invalid",
        },
      },
      {
        ...productionSession,
        user: {
          ...productionSession.user,
          frappe_user_id: "production@example.invalid",
        },
      },
    ];
    for (const session of unrelatedSessions) {
      const model = workObjectModel();
      const rendered = renderWorkObject({ ...model, allowed_actions: [] }, session);
      expect(
        await screen.findByRole("heading", {
          name: /SHOP-001|This work belongs to another role/,
        }),
      ).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "Complete work package" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Complete from current ledger" }),
      ).not.toBeInTheDocument();
      rendered.unmount();
    }
    expect(apiCommand).not.toHaveBeenCalled();
  });

  it("binds typed acknowledgement and Stop Work outbox intents to the exact parent/context", async () => {
    routeParams = {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    };
    const user = userEvent.setup();
    const acknowledgement = queuedWorkPackageAction("work_package_acknowledgement");
    const stopWork = queuedWorkPackageAction("work_package_stop");
    vi.mocked(saveOutboxAction)
      .mockResolvedValueOnce(acknowledgement)
      .mockResolvedValueOnce(stopWork);
    vi.mocked(queueOutboxAction)
      .mockResolvedValueOnce(acknowledgement)
      .mockResolvedValueOnce(stopWork);
    renderWorkObject();

    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Acknowledge this package" }));
    await waitFor(() => {
      expect(saveOutboxAction).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          endpoint:
            "/api/v1/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1/work-package/acknowledgements",
          payload: {
            work_package_id: "WP-1",
            work_package_version: 3,
            release_attempt_id: "wpe_release_attempt_00000001",
            work_object_type: "Shop Order",
            work_object_id: "SHOP-001",
            physical_context_type: "Shop Floor",
            physical_context_id: "SHOP-FLOOR-1",
          },
        }),
      );
    });

    await user.type(
      screen.getByLabelText("What requires work to stop?"),
      "Machine guard is missing.",
    );
    await user.click(screen.getByRole("button", { name: "Stop Work and save report" }));
    await waitFor(() => {
      expect(saveOutboxAction).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          endpoint:
            "/api/v1/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1/work-package/stop-work",
          payload: {
            work_package_id: "WP-1",
            work_package_version: 3,
            blocker_reason: "Machine guard is missing.",
            work_object_type: "Shop Order",
            work_object_id: "SHOP-001",
            physical_context_type: "Shop Floor",
            physical_context_id: "SHOP-FLOOR-1",
          },
        }),
      );
    });
  });

  it("binds typed Start Work to the same online parent/context", async () => {
    routeParams = {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    };
    const model = workObjectModel();
    const workPackage = model.work_package;
    if (!workPackage) throw new Error("Expected a Work Package fixture.");
    const user = userEvent.setup();
    vi.mocked(apiCommand).mockResolvedValue(undefined);
    renderWorkObject(
      {
        ...model,
        allowed_actions: ["work_package.start"],
        work_package: {
          ...workPackage,
          status: "Acknowledged",
          acknowledgement: {
            ...workPackage.acknowledgement,
            current_user_acknowledged: true,
            acknowledged_at: "2026-07-10T15:20:00.000Z",
            workers: workPackage.acknowledgement.workers.map((worker) => ({
              ...worker,
              acknowledged: true,
              acknowledged_at: "2026-07-10T15:20:00.000Z",
            })),
          },
          hold_points: workPackage.hold_points.map((holdPoint) => ({
            ...holdPoint,
            released: true,
          })),
        },
      },
      fieldSession,
    );

    await user.click(await screen.findByRole("button", { name: "Start work from current packet" }));
    await waitFor(() => expect(apiCommand).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiCommand).mock.calls[0]?.[0]).toMatchObject({
      path: "/api/v1/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1/work-package/start",
      body: {
        payload: {
          work_package_id: "WP-1",
          work_package_version: 3,
          release_attempt_id: "wpe_release_attempt_00000001",
          work_object_type: "Shop Order",
          work_object_id: "SHOP-001",
          physical_context_type: "Shop Floor",
          physical_context_id: "SHOP-FLOOR-1",
        },
      },
    });
  });

  it("turns a blocked gate into a work lock while preserving the permitted blocker-capture path", async () => {
    renderJob();

    expect(await screen.findByRole("heading", { name: "Work status" })).toBeVisible();
    expect(screen.getByText("1 gate blocks scheduled work")).toBeVisible();
    expect(screen.getByText("Delivery confirmation is missing")).toBeVisible();
    expect(screen.getByRole("link", { name: "Capture blocker proof" })).toHaveAttribute(
      "href",
      "/check-in/JOB-1",
    );
    expect(screen.getByRole("link", { name: "Capture blocker proof" })).toHaveClass("min-h-16");
    expect(screen.getByRole("link", { name: "Capture blocker proof" })).toHaveClass("fixed");
    expect(screen.queryByText("Gate owner: Production dispatch")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Proof obligations" })).not.toBeInTheDocument();
  });

  it("surfaces safety detail as read-only context and keeps proof provenance visible", async () => {
    renderJob();

    expect(await screen.findByText("Safety plan · v2")).toBeVisible();
    expect(screen.getByText("Steep-slope fall exposure")).toBeVisible();
    expect(screen.getByText("Use roof anchors and harnesses")).toBeVisible();
    expect(screen.getByText(/field_checkin · Internal/i)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /acknowledge|clear work|override/i }),
    ).not.toBeInTheDocument();
  });

  it("lets production inspect a job packet without inheriting field commands", async () => {
    renderJob(
      workPackageModel({
        permissions: ["jobs:read:any", "production:read"],
        allowed_actions: ["job.read"],
      }),
      productionSession,
    );

    expect(
      await screen.findByRole("heading", { name: "123 Example Avenue, Calgary, AB" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Production" })).toHaveAttribute("href", "/production");
    expect(screen.getByRole("heading", { name: "Read-only job packet" })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Capture .*proof/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Acknowledge this package" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start work from current packet" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop Work and save report" }),
    ).not.toBeInTheDocument();
  });

  it("requires both the server capability and an active assignment before showing capture", async () => {
    const noAssignment = jobModel({ assignment: null, allowed_actions: [] });
    renderJob(noAssignment);

    expect(
      await screen.findByRole("heading", { name: "Active assignment required" }),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: /Capture .*proof/i })).not.toBeInTheDocument();
  });

  it("labels cached data as an offline packet and suppresses older-proof loading", async () => {
    renderJob(jobModel({ stale_fields: ["offline.cached_packet"] }));

    expect(await screen.findByText(/Offline packet from/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load older proof" })).not.toBeInTheDocument();
  });

  it("renders the exact cached Work Package while keeping offline work authority closed", async () => {
    renderJob(workPackageModel({ stale_fields: ["offline.cached_packet"] }));

    expect(await screen.findByRole("heading", { name: "North slope replacement" })).toBeVisible();
    expect(screen.getByText("v3 · Released")).toBeVisible();
    expect(screen.getByText(/Step 1.*Inspect anchors before roof access\./)).toBeVisible();
    expect(screen.getByText(/Pending independent release by Production manager/i)).toBeVisible();
    expect(screen.getByText(/may be expired or superseded/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Acknowledge this package" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop Work and save report" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Start work from current packet" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/never resumes work itself/i)).toBeVisible();
  });

  it("binds field evidence controls to the exact package version and declared slots", async () => {
    renderJob(workPackageModel());

    expect(await screen.findByRole("heading", { name: "Evidence slots" })).toBeVisible();
    expect(
      screen.getByText(/Awaiting acknowledgement of this exact package version/i),
    ).toBeVisible();
    const captureLinks = screen.getAllByRole("link", { name: /Capture evidence/ });
    expect(captureLinks).toHaveLength(2);
    expect(captureLinks[0]).toHaveAttribute(
      "href",
      expect.stringContaining(
        "/check-in/JOB-1?work_package_id=WP-1&work_package_version=3&evidence_slot_id=step%3A1",
      ),
    );
    expect(captureLinks[0]).toHaveAttribute(
      "href",
      expect.stringContaining("evidence_requirement=Anchor+inspection+photo."),
    );
  });

  it("shows a correction link with both immutable prior evidence identities", async () => {
    const model = workPackageModel();
    const workPackage = model.packet.work_package;
    if (!workPackage) throw new Error("Expected a Work Package fixture.");
    renderJob({
      ...model,
      packet: {
        ...model.packet,
        work_package: {
          ...workPackage,
          evidence_slots: [
            {
              event_id: "WPE-EVIDENCE-001",
              evidence_item: "EVIDENCE-ITEM-001",
              slot_id: "step:1",
              requirement: "Anchor inspection photo.",
              source: "worker-camera",
              actor_user: "crew@example.com",
              device_id: "paired-device-1",
              captured_at: "2026-07-10T09:15:00.000Z",
              freshness: "Current",
              conflict_state: "None",
              correction_of: null,
              evidence_item_correction_of: null,
              review_reason: null,
              verification: "Verified",
              disposition: "Open",
              correction_reason: null,
              superseded: false,
            },
          ],
        },
      },
    });

    const correction = await screen.findByRole("link", { name: "Correct evidence for step 1" });
    expect(correction).toHaveAttribute(
      "href",
      expect.stringContaining("evidence_correction_of=WPE-EVIDENCE-001"),
    );
    expect(correction).toHaveAttribute(
      "href",
      expect.stringContaining("evidence_item_correction_of=EVIDENCE-ITEM-001"),
    );
  });

  it("keeps acknowledgement and capture controls closed when the release attempt is unknown", async () => {
    const model = workPackageModel();
    const workPackage = model.packet.work_package;
    if (!workPackage) throw new Error("Expected a Work Package fixture.");
    renderJob({
      ...model,
      packet: {
        ...model.packet,
        work_package: { ...workPackage, release_attempt_id: null },
      },
    });

    expect(await screen.findByRole("heading", { name: "Evidence slots" })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Capture evidence/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Acknowledge this package" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop Work and save report" })).toBeVisible();
  });

  it("queues acknowledgement and Stop Work intents offline without a local work-state change", async () => {
    const user = userEvent.setup();
    const acknowledgement = queuedWorkPackageAction("work_package_acknowledgement");
    const stopWork = queuedWorkPackageAction("work_package_stop");
    vi.mocked(saveOutboxAction)
      .mockResolvedValueOnce(acknowledgement)
      .mockResolvedValueOnce(stopWork);
    vi.mocked(queueOutboxAction)
      .mockResolvedValueOnce(acknowledgement)
      .mockResolvedValueOnce(stopWork);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    renderJob(workPackageModel({ stale_fields: ["offline.cached_packet"] }));

    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Acknowledge this package" }));
    await waitFor(() => {
      expect(saveOutboxAction).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          kind: "work_package_acknowledgement",
          endpoint: "/api/v1/jobs/JOB-1/work-package/acknowledgements",
          payload: {
            work_package_id: "WP-1",
            work_package_version: 3,
            release_attempt_id: "wpe_release_attempt_00000001",
          },
        }),
      );
    });

    await user.type(
      screen.getByLabelText("What requires work to stop?"),
      "Wind exceeds the plan limit.",
    );
    await user.click(screen.getByRole("button", { name: "Stop Work and save report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Stop work now/i);
    await waitFor(() => {
      expect(saveOutboxAction).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          kind: "work_package_stop",
          endpoint: "/api/v1/jobs/JOB-1/work-package/stop-work",
          payload: {
            work_package_id: "WP-1",
            work_package_version: 3,
            blocker_reason: "Wind exceeds the plan limit.",
          },
        }),
      );
    });
    expect(flushOutbox).not.toHaveBeenCalled();
    expect(screen.getByText(/does not change package status or unlock work/i)).toBeVisible();
  });

  it("removes Start after Stop Work until a fresh worker packet restores a server capability", async () => {
    const user = userEvent.setup();
    const stopWork = queuedWorkPackageAction("work_package_stop");
    vi.mocked(saveOutboxAction).mockResolvedValue(stopWork);
    vi.mocked(queueOutboxAction).mockResolvedValue(stopWork);
    renderJob(startableWorkPackageModel());

    expect(
      await screen.findByRole("button", { name: "Start work from current packet" }),
    ).toBeVisible();
    await user.type(
      screen.getByLabelText("What requires work to stop?"),
      "Wind exceeds the plan limit.",
    );
    await user.click(screen.getByRole("button", { name: "Stop Work and save report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Stop work now/i);
    expect(
      screen.queryByRole("button", { name: "Start work from current packet" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/never resumes work itself/i)).toBeVisible();
  });

  it("does not advertise Start while any server packet hold remains pending", async () => {
    const startable = startableWorkPackageModel();
    const workPackage = startable.packet.work_package;
    if (!workPackage) throw new Error("Expected a Work Package fixture.");
    renderJob({
      ...startable,
      packet: {
        ...startable.packet,
        work_package: {
          ...workPackage,
          hold_points: workPackage.hold_points.map((holdPoint) => ({
            ...holdPoint,
            released: false,
          })),
        },
      },
    });

    expect(
      await screen.findByText(/Pending independent release by Production manager/i),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Start work from current packet" }),
    ).not.toBeInTheDocument();
  });

  it("offers Start only from a fresh server capability and sends it directly online", async () => {
    const user = userEvent.setup();
    vi.mocked(apiCommand).mockResolvedValue(undefined);
    renderJob(startableWorkPackageModel());

    await user.click(await screen.findByRole("button", { name: "Start work from current packet" }));

    await waitFor(() => expect(apiCommand).toHaveBeenCalledTimes(1));
    const options = vi.mocked(apiCommand).mock.calls[0]?.[0];
    expect(options).toMatchObject({
      path: "/api/v1/jobs/JOB-1/work-package/start",
      csrfToken: "csrf",
      body: {
        payload: {
          work_package_id: "WP-1",
          work_package_version: 3,
          release_attempt_id: "wpe_release_attempt_00000001",
        },
      },
    });
    expect(options?.deviceActionId).toEqual(expect.any(String));
    expect(options?.idempotencyKey).toBe(options?.deviceActionId);
    expect(options?.body).toMatchObject({ device_action_id: options?.deviceActionId });
    expect(saveOutboxAction).not.toHaveBeenCalled();
  });
});
