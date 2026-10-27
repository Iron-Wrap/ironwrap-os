import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError, apiCommand } from "../lib/api";
import { getDatabase } from "../storage/db";
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

// The job page also mounts the schema card, documents and customer history sections. This file
// tests the job page, so their reads refuse at once instead of reaching a network, and every
// other export (ApiError, which `messageFor` reads) stays real.
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiCommand: vi.fn(),
  apiRequest: vi.fn(() => Promise.reject(new Error("Reads are not under test."))),
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
      modified: "2026-07-10T14:55:00.000Z",
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

  it("retries an unsaved job update and confirms offline readiness only after it saves", async () => {
    const user = userEvent.setup();
    renderJob(jobModel({ stale_fields: ["offline.not_saved"] }));

    expect(await screen.findByRole("heading", { name: "Not ready offline" })).toBeVisible();
    expect(screen.queryByText("Up to date")).not.toBeInTheDocument();
    expect(screen.queryByText("Some job details may be old")).not.toBeInTheDocument();
    vi.mocked(loadJob).mockResolvedValueOnce(jobModel());
    await user.click(screen.getByRole("button", { name: "Try saving again" }));

    expect(await screen.findByRole("heading", { name: "Ready offline" })).toBeVisible();
    expect(loadJob).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Take photo for this job").closest("label")).not.toHaveClass(
      "field-capture-dock",
    );
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
    expect(screen.getByRole("button", { name: "I reviewed this plan" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop Work and save report" })).toBeVisible();
    expect(screen.getAllByRole("link", { name: /Add proof/ })[0]).toHaveAttribute(
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
    expect(screen.getByRole("heading", { name: "Finish this work plan" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Finish work" })).toBeVisible();

    const user = userEvent.setup();
    vi.mocked(apiCommand).mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "Finish work" }));
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
        screen.queryByRole("heading", { name: "Finish this work plan" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Finish work" })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "I reviewed this plan" }));
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

    await user.click(await screen.findByRole("button", { name: "Start work" }));
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

    expect(await screen.findByRole("heading", { name: "Work checks" })).toBeVisible();
    expect(screen.getByText("1 check blocks work")).toBeVisible();
    expect(screen.getByText("Delivery confirmation is missing")).toBeVisible();
    expect(screen.getByRole("link", { name: "Add blocker proof" })).toHaveAttribute(
      "href",
      "/check-in/JOB-1",
    );
    expect(screen.getByRole("link", { name: "Add blocker proof" })).toHaveClass(
      "min-h-[var(--control-height-primary)]",
    );
    expect(screen.getByRole("link", { name: "Add blocker proof" })).not.toHaveClass("fixed");
    expect(screen.queryByText("Gate owner: Production dispatch")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Proof obligations" })).not.toBeInTheDocument();
  });

  it("surfaces safety detail as read-only context and keeps proof provenance visible", async () => {
    renderJob();

    expect(await screen.findByText("Safety plan · v2")).toBeVisible();
    expect(screen.getByText("Your role")).toBeVisible();
    expect(screen.getByText("Production crew · Assigned")).toBeVisible();
    expect(screen.getByText("Steep-slope fall exposure")).toBeVisible();
    expect(screen.getByText("Use roof anchors and harnesses")).toBeVisible();
    expect(screen.getByText(/field_checkin · Team only/i)).toBeVisible();
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
    expect(screen.getByRole("heading", { name: "View only" })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Add .*proof/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "I reviewed this plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start work" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop Work and save report" }),
    ).not.toBeInTheDocument();
  });

  it("requires both the server capability and an active assignment before showing capture", async () => {
    const noAssignment = jobModel({ assignment: null, allowed_actions: [] });
    renderJob(noAssignment);

    expect(await screen.findByRole("heading", { name: "Current job needed" })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Add .*proof/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Take photo for this job")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Measurement evidence" })).not.toBeInTheDocument();
  });

  it("takes a photo from the job directly to review and retains its receipt when the plan refreshes", async () => {
    const user = userEvent.setup();
    const queued: OutboxAction = {
      ...queuedWorkPackageAction("work_package_acknowledgement"),
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-1/check-ins",
      payload: {},
    };
    const verified: OutboxAction = {
      ...queued,
      state: "verified",
      verification: { serverRef: "checkin-direct-photo", verifiedAt: 2000 },
    };
    vi.mocked(saveOutboxAction).mockResolvedValue({ ...queued, state: "saved_locally" });
    vi.mocked(queueOutboxAction).mockResolvedValue(queued);
    vi.mocked(getOutboxAction).mockResolvedValue(verified);
    vi.mocked(flushOutbox).mockResolvedValue({
      processed: 1,
      verified: 1,
      needsAttention: 0,
      requeued: 0,
    });
    renderJob();

    await user.upload(
      await screen.findByLabelText("Take photo for this job"),
      new File(["photo"], "flashing.jpg", { type: "image/jpeg" }),
    );
    expect(await screen.findByRole("heading", { name: "Add job details" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Add job details" })).toHaveFocus();
    expect(screen.getByText("flashing.jpg")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Continue to review" })).not.toBeInTheDocument();
    expect(saveOutboxAction).not.toHaveBeenCalled();

    vi.mocked(loadJob).mockResolvedValue({
      ...jobModel(),
      read_model_generated_at: "2026-07-10T17:00:00.000Z",
      allowed_actions: [],
    });
    const readsBeforeSave = vi.mocked(loadJob).mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Save on device" }));
    expect(await screen.findByRole("heading", { name: "Check-in saved" })).toBeVisible();
    expect(await screen.findByText("Sent", { exact: true })).toBeVisible();
    await waitFor(() =>
      expect(vi.mocked(loadJob).mock.calls.length).toBeGreaterThan(readsBeforeSave),
    );
    expect(screen.getByText("The server got this check-in.")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "You cannot add a check-in" }),
    ).not.toBeInTheDocument();
    expect(saveOutboxAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "field_checkin",
        endpoint: "/api/v1/jobs/JOB-1/check-ins",
        payload: expect.objectContaining({
          assignment_id: "ASSIGN-1",
          customer_safe_requested: false,
        }),
        attachments: [expect.objectContaining({ fileName: "flashing.jpg" })],
      }),
    );

    await user.click(screen.getByRole("button", { name: "Return to job" }));
    expect(await screen.findByRole("heading", { name: "Current job needed" })).toBeVisible();
  });

  it("lets office authority supersede an exact assignment-bound Work Package", async () => {
    const user = userEvent.setup();
    vi.mocked(apiCommand).mockResolvedValue(undefined);
    renderJob(
      workPackageModel({
        permissions: ["jobs:read:any", "production:read"],
        allowed_actions: ["job.read", "work_package.issue"],
      }),
      ownerSession,
    );

    await user.type(
      await screen.findByLabelText("What changed?"),
      "Deck damage changed the scope.",
    );
    await user.click(screen.getByRole("button", { name: "Issue Work Package v4" }));

    await waitFor(() => expect(apiCommand).toHaveBeenCalledTimes(1));
    const options = vi.mocked(apiCommand).mock.calls[0]?.[0];
    expect(options).toMatchObject({
      path: "/api/v1/jobs/JOB-1/work-package",
      csrfToken: "csrf",
      body: {
        assignment_id: "ASSIGN-1",
        assignment_modified: "2026-07-10T14:55:00.000Z",
        version: 4,
        title: "North slope replacement",
        correction_reason: "Deck damage changed the scope.",
        steps: [
          {
            instruction: "Inspect anchors before roof access.",
            required_evidence: "Anchor inspection photo.",
            acceptance_criteria: "Anchor and harness connection are visible.",
          },
        ],
        hold_points: [
          {
            hold_point: "Deck condition review",
            release_phase: "Pre-start",
            release_authority: "Production manager",
            required_evidence: "Deck condition photo.",
            acceptance_criteria: "Production manager independently releases the hold.",
          },
        ],
      },
    });
    expect(options?.deviceActionId).toEqual(expect.any(String));
    expect(options?.idempotencyKey).toBe(options?.deviceActionId);
  });

  it("shows first-issue authoring only when an office packet grants it", async () => {
    renderJob(
      jobModel({
        permissions: ["jobs:read:any", "production:read"],
        allowed_actions: ["job.read", "work_package.issue"],
      }),
      ownerSession,
    );

    expect(await screen.findByRole("heading", { name: "Issue Work Package" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "No work plan is ready" })).toBeVisible();
  });

  it("lets production open typed work authoring without receiving field capture", async () => {
    routeParams = {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    };
    renderWorkObject(
      {
        ...workObjectModel(),
        allowed_actions: ["work_package.issue"],
      },
      productionSession,
    );

    expect(
      await screen.findByRole("heading", { name: "Issue corrected Work Package v4" }),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: /Capture evidence/ })).not.toBeInTheDocument();
  });

  it("labels cached data as an offline packet and suppresses older-proof loading", async () => {
    renderJob(jobModel({ stale_fields: ["offline.cached_packet"] }));

    expect(await screen.findByText(/This is a saved copy from/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show older proof" })).not.toBeInTheDocument();
  });

  it("renders the exact cached Work Package while keeping offline work authority closed", async () => {
    renderJob(workPackageModel({ stale_fields: ["offline.cached_packet"] }));

    expect(await screen.findByRole("heading", { name: "North slope replacement" })).toBeVisible();
    expect(screen.getByText("v3 · Released")).toBeVisible();
    expect(screen.getByText(/Step 1.*Inspect anchors before roof access\./)).toBeVisible();
    expect(screen.getByText(/Waiting for Production manager/i)).toBeVisible();
    expect(screen.getByText(/saved plan may be old/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "I reviewed this plan" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop Work and save report" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start work" })).not.toBeInTheDocument();
    expect(screen.getByText(/Start work button will show/i)).toBeVisible();
  });

  it("binds field evidence controls to the exact package version and declared slots", async () => {
    renderJob(workPackageModel());

    expect(await screen.findByRole("heading", { name: "Proof needed" })).toBeVisible();
    expect(screen.getByText(/still needs to review this plan/i)).toBeVisible();
    const captureLinks = screen.getAllByRole("link", { name: /Add proof/ });
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

    const correction = await screen.findByRole("link", { name: "Fix proof for step 1" });
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

    expect(await screen.findByRole("heading", { name: "Proof needed" })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Add proof/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "I reviewed this plan" })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "I reviewed this plan" }));
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
    expect(await screen.findByRole("alert")).toHaveTextContent(/Stop now/i);
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
    expect(screen.getByText(/does not change the plan or unlock work/i)).toBeVisible();
  });

  it("removes Start after Stop Work until a fresh worker packet restores a server capability", async () => {
    const user = userEvent.setup();
    const stopWork = queuedWorkPackageAction("work_package_stop");
    vi.mocked(saveOutboxAction).mockResolvedValue(stopWork);
    vi.mocked(queueOutboxAction).mockResolvedValue(stopWork);
    renderJob(startableWorkPackageModel());

    expect(await screen.findByRole("button", { name: "Start work" })).toBeVisible();
    await user.type(
      screen.getByLabelText("What requires work to stop?"),
      "Wind exceeds the plan limit.",
    );
    await user.click(screen.getByRole("button", { name: "Stop Work and save report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Stop now/i);
    expect(screen.queryByRole("button", { name: "Start work" })).not.toBeInTheDocument();
    expect(screen.getByText(/Start work button will show/i)).toBeVisible();
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

    expect(await screen.findByText(/Waiting for Production manager/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start work" })).not.toBeInTheDocument();
  });

  it("offers Start only from a fresh server capability and sends it directly online", async () => {
    const user = userEvent.setup();
    vi.mocked(apiCommand).mockResolvedValue(undefined);
    renderJob(startableWorkPackageModel());

    await user.click(await screen.findByRole("button", { name: "Start work" }));

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

  it("says a refused Start is not this crew member's, never a fault on our side", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    vi.mocked(apiCommand).mockRejectedValue(
      new ApiError({
        status: 403,
        code: "work_package_actor_not_assigned",
        message: "The field actor is not assigned to this Work Package.",
      }),
    );
    renderJob(startableWorkPackageModel());

    await user.click(await screen.findByRole("button", { name: "Start work" }));

    const refusal = (
      await screen.findByText(
        "You are not on the crew for this work plan. Ask the office to add you to it.",
      )
    ).closest<HTMLElement>('[role="alert"]')!;
    expect(refusal).toBeVisible();
    expect(refusal).not.toHaveTextContent(/on our side|try again|field actor/i);
    // The code waits behind System details for whoever looks into it.
    expect(within(refusal).getByText("work_package_actor_not_assigned")).not.toBeVisible();
    quiet.mockRestore();
  });

  it("says a job the office will not open is not on this list, and offers no dead retry", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // What the job route answers for a job that is missing, closed or not assigned to this crew.
    vi.mocked(loadJob).mockRejectedValue(
      new ApiError({ status: 404, code: "not_found", message: "Not Found" }),
    );
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SessionProvider session={fieldSession}>
          <JobPage />
        </SessionProvider>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        "This job is not on your list. It may be finished, or not assigned to you. Ask the office if you should be on it.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/on our side/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    quiet.mockRestore();
  });
});

describe("Start work after a lost answer", () => {
  /**
   * Start goes straight to the office. When its answer is lost the work may already have started,
   * so the phone keeps the request and a second press resends it unchanged; the Worker replays its
   * recorded answer for a device action ID it has seen, so work cannot start twice.
   */
  const lost = () => new ApiError({ status: 0, code: "network_error", message: "No connection" });
  const sent = () => vi.mocked(apiCommand).mock.calls.map(([options]) => options);

  function laterPlan(): JobResponse {
    const model = startableWorkPackageModel();
    const workPackage = model.packet.work_package!;
    return {
      ...model,
      read_model_generated_at: "2026-07-10T16:00:00.000Z",
      packet: {
        ...model.packet,
        work_package: { ...workPackage, version: workPackage.version + 1 },
      },
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    routeParams = { jobId: "JOB-1" };
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.mocked(getOutboxAction).mockResolvedValue(undefined);
    // Kept requests live on the device; each test starts with none.
    await (await getDatabase()).clear("meta");
  });

  it("resends the same request, key and body after a lost answer, even after a reload", async () => {
    const user = userEvent.setup();
    vi.mocked(apiCommand).mockRejectedValueOnce(lost()).mockResolvedValue(undefined);
    const { unmount } = renderJob(startableWorkPackageModel());

    await user.click(await screen.findByRole("button", { name: "Start work" }));
    expect(
      await screen.findByText(
        "We could not confirm work started. Press Start work again: it sends the same request, so work cannot start twice.",
      ),
    ).toBeVisible();

    // The phone is closed and opened again: the kept request, and what it means, survive.
    unmount();
    renderJob(startableWorkPackageModel());
    expect(await screen.findByText(/We could not confirm work started/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Start work" }));

    await waitFor(() => expect(apiCommand).toHaveBeenCalledTimes(2));
    const [first, second] = sent();
    expect(second?.deviceActionId).toBe(first?.deviceActionId);
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.body).toEqual(first?.body);
    // Answered: nothing is kept, and the next Start is a new request.
    await waitFor(() =>
      expect(screen.queryByText(/We could not confirm work started/)).not.toBeInTheDocument(),
    );
  });

  it("never replays a kept request against a plan that has changed since", async () => {
    const user = userEvent.setup();
    vi.mocked(apiCommand).mockRejectedValueOnce(lost()).mockResolvedValue(undefined);
    const { unmount } = renderJob(startableWorkPackageModel());
    await user.click(await screen.findByRole("button", { name: "Start work" }));
    await screen.findByText(/We could not confirm work started/);

    // A fresh read shows a newer version of the plan: the old request is stale and is dropped.
    unmount();
    const fresh = laterPlan();
    renderJob(fresh);
    await user.click(await screen.findByRole("button", { name: "Start work" }));

    await waitFor(() => expect(apiCommand).toHaveBeenCalledTimes(2));
    const [first, second] = sent();
    expect(second?.deviceActionId).not.toBe(first?.deviceActionId);
    expect(second?.body).toMatchObject({
      payload: { work_package_version: fresh.packet.work_package!.version },
    });
  });

  it("keeps nothing once the office refuses a stale plan, and says so", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    vi.mocked(apiCommand)
      .mockRejectedValueOnce(
        new ApiError({ status: 409, code: "work_package_version_conflict", message: "stale" }),
      )
      .mockResolvedValue(undefined);
    renderJob(startableWorkPackageModel());

    await user.click(await screen.findByRole("button", { name: "Start work" }));
    expect(
      await screen.findByText(
        "The work plan changed after this phone opened it. Open the job again to see the new plan.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Start work" }));

    await waitFor(() => expect(apiCommand).toHaveBeenCalledTimes(2));
    const [first, second] = sent();
    // A refusal is a definite answer, so the next press is a new request, not a replay.
    expect(second?.deviceActionId).not.toBe(first?.deviceActionId);
    quiet.mockRestore();
  });

  it.each([
    {
      name: "the session ended",
      refused: new ApiError({ status: 401, code: "unauthorized", message: "Unauthorized" }),
      words:
        "Your session expired before the office answered. Sign in again, then press Start work again: it sends the same request, so work cannot start twice.",
    },
    {
      name: "the role changed",
      refused: new ApiError({ status: 403, code: "field_role_required", message: "Forbidden" }),
      words:
        "Your account lost access before the office answered. Ask the office to check your access, then press Start work again: it sends the same request, so work cannot start twice.",
    },
  ])(
    "keeps the request when $name before the replay, and resends it after signing in",
    async ({ refused, words }) => {
      const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const user = userEvent.setup();
      vi.mocked(apiCommand)
        .mockRejectedValueOnce(lost())
        // The Worker checks the session before it replays a verified answer, so the first send
        // may have committed even though this one is refused.
        .mockRejectedValueOnce(refused)
        .mockResolvedValue(undefined);
      const { unmount } = renderJob(startableWorkPackageModel());

      await user.click(await screen.findByRole("button", { name: "Start work" }));
      await screen.findByText(/We could not confirm work started/);
      await user.click(screen.getByRole("button", { name: "Start work" }));
      expect(await screen.findByText(words)).toBeVisible();

      // The person signs in again (or the office restores the role) and opens the job.
      unmount();
      renderJob(startableWorkPackageModel());
      await screen.findByText(/We could not confirm work started/);
      await user.click(screen.getByRole("button", { name: "Start work" }));

      await waitFor(() => expect(apiCommand).toHaveBeenCalledTimes(3));
      const [first, , third] = sent();
      expect(third?.deviceActionId).toBe(first?.deviceActionId);
      expect(third?.idempotencyKey).toBe(first?.idempotencyKey);
      expect(third?.body).toEqual(first?.body);
      await waitFor(() =>
        expect(screen.queryByText(/We could not confirm work started/)).not.toBeInTheDocument(),
      );
      quiet.mockRestore();
    },
  );

  it("drops a request that was refused on its first send: it never ran", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    vi.mocked(apiCommand)
      .mockRejectedValueOnce(new ApiError({ status: 401, code: "unauthorized", message: "x" }))
      .mockResolvedValue(undefined);
    renderJob(startableWorkPackageModel());

    await user.click(await screen.findByRole("button", { name: "Start work" }));
    expect(
      await screen.findByText("Your session expired. Sign in again to carry on."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Start work" }));

    await waitFor(() => expect(apiCommand).toHaveBeenCalledTimes(2));
    const [first, second] = sent();
    expect(second?.deviceActionId).not.toBe(first?.deviceActionId);
    quiet.mockRestore();
  });

  it("drops the request and reads the plan again when the ID belongs to a different request", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    vi.mocked(apiCommand)
      .mockRejectedValueOnce(lost())
      .mockRejectedValueOnce(
        new ApiError({ status: 409, code: "idempotency_conflict", message: "conflict" }),
      )
      .mockResolvedValue(undefined);
    renderJob(startableWorkPackageModel());

    await user.click(await screen.findByRole("button", { name: "Start work" }));
    await screen.findByText(/We could not confirm work started/);
    const readsBefore = vi.mocked(loadJob).mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Start work" }));
    expect(
      await screen.findByText(
        "The office already holds a different request from this phone for this plan. Check the plan, then press the button again.",
      ),
    ).toBeVisible();
    await waitFor(() => expect(vi.mocked(loadJob).mock.calls.length).toBeGreaterThan(readsBefore));

    await user.click(screen.getByRole("button", { name: "Start work" }));
    await waitFor(() => expect(apiCommand).toHaveBeenCalledTimes(3));
    const [first, , third] = sent();
    expect(third?.deviceActionId).not.toBe(first?.deviceActionId);
    quiet.mockRestore();
  });

  it("waits while the office is still working on the same request, then resends it unchanged", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const realSetTimeout = window.setTimeout.bind(window);
    let sendAfterWait: (() => void) | undefined;
    // Control only Retry-After. Device storage and user interactions keep their real clocks,
    // while a busy test runner cannot consume the warning before we inspect it.
    const retryClock = vi
      .spyOn(window, "setTimeout")
      .mockImplementation((handler, delay, ...args) => {
        if (delay === 50 && typeof handler === "function") {
          sendAfterWait = () => handler(...args);
          return 0;
        }
        return realSetTimeout(handler, delay, ...args);
      });
    try {
      const user = userEvent.setup();
      vi.mocked(apiCommand)
        .mockRejectedValueOnce(
          new ApiError({
            status: 503,
            code: "action_in_progress",
            message: "Service Unavailable",
            retryAfterMs: 50,
          }),
        )
        .mockResolvedValue(undefined);
      renderJob(startableWorkPackageModel());

      await user.click(await screen.findByRole("button", { name: "Start work" }));
      expect(
        await screen.findByText(
          "The office is still working on this. This phone sends the same request again in a second.",
        ),
      ).toBeVisible();
      expect(apiCommand).toHaveBeenCalledTimes(1);
      expect(sendAfterWait).toBeDefined();

      // No press needed: release Retry-After only after checking the visible waiting state.
      await act(async () => sendAfterWait?.());
      await waitFor(() => expect(apiCommand).toHaveBeenCalledTimes(2));
      const [first, second] = sent();
      expect(second?.deviceActionId).toBe(first?.deviceActionId);
      expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
      expect(second?.body).toEqual(first?.body);
      await waitFor(() =>
        expect(screen.queryByText(/still working on this/)).not.toBeInTheDocument(),
      );
    } finally {
      retryClock.mockRestore();
      quiet.mockRestore();
    }
  });

  it("sends one request for a double tap", async () => {
    let answer: (() => void) | undefined;
    vi.mocked(apiCommand).mockImplementation(
      () => new Promise<void>((resolve) => (answer = resolve)),
    );
    renderJob(startableWorkPackageModel());
    const start = await screen.findByRole("button", { name: "Start work" });

    fireEvent.click(start);
    fireEvent.click(start);

    await waitFor(() => expect(apiCommand).toHaveBeenCalledTimes(1));
    answer?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Start work" })).toBeEnabled());
    expect(apiCommand).toHaveBeenCalledTimes(1);
  });
});

describe("packet slots this system does not carry", () => {
  /**
   * Every empty panel used to read "No items are in this work plan" whatever the reason. On the
   * owned path several slots are hard-empty and the server says so in `stale_fields`, so a crew on
   * a roof was being told this job had no approved scope and no change orders — a claim about the
   * job, made by a screen that had simply not been given the data.
   */
  function emptyPacket(model = jobModel()): JobResponse {
    return {
      ...model,
      packet: {
        ...model.packet,
        scope_clauses: [],
        measurements: [],
        materials: { takeoffs: [], supplier_orders: [] },
        change_orders: [],
      },
    };
  }

  it("says a slot is not carried instead of reporting it as none", async () => {
    renderJob(emptyPacket(jobModel({ stale_fields: ["packet.change_orders.native_unavailable"] })));

    expect(
      await screen.findByText(/This screen does not carry change orders yet/),
    ).toBeInTheDocument();
    expect(screen.getByText(/ask the office before you rely on it/i)).toBeInTheDocument();
  });

  it("does not count an uncarried slot as zero items", async () => {
    renderJob(emptyPacket(jobModel({ stale_fields: ["packet.change_orders.native_unavailable"] })));

    await screen.findByText(/This screen does not carry change orders yet/);
    expect(screen.getByText("Not shown here")).toBeInTheDocument();
  });

  it("still reports a genuinely empty slot as empty", async () => {
    // The server looked and found none. That IS a fact about the job, and saying so is correct.
    renderJob(emptyPacket(jobModel({ stale_fields: [] })));

    const empties = await screen.findAllByText("No items are in this work plan.");
    expect(empties.length).toBeGreaterThan(0);
    expect(screen.queryByText(/does not carry/)).not.toBeInTheDocument();
  });

  it("treats either half of the materials slot as enough to stop claiming none", async () => {
    renderJob(
      emptyPacket(
        jobModel({ stale_fields: ["packet.materials.supplier_orders.native_unavailable"] }),
      ),
    );

    expect(await screen.findByText(/This screen does not carry materials yet/)).toBeInTheDocument();
  });
});

describe("what the stale-details disclosure is for", () => {
  it("keeps a marker the screen cannot explain anywhere else, in plain words", async () => {
    renderJob(jobModel({ stale_fields: ["job.address", "packet.contact.phone"] }));

    expect(await screen.findByText(/Some job details may be old/)).toBeInTheDocument();
    expect(screen.getByText(/these details: Job address, Job contact phone\./)).toBeInTheDocument();
  });

  it("hides a field key nobody has written words for instead of title-casing it", async () => {
    renderJob(jobModel({ stale_fields: ["job.address", "packet.crew.lead_badge_unverified"] }));

    expect(await screen.findByText(/these details: Job address\./)).toBeInTheDocument();
    expect(screen.queryByText(/Lead Badge|lead badge|unverified/i)).not.toBeInTheDocument();
  });

  it("does not repeat a slot the panel already explains", async () => {
    // Six lines of "Packet Materials Takeoffs Native Unavailable" on every job buried the rare
    // marker that actually means something.
    renderJob(
      jobModel({
        stale_fields: [
          "packet.scope_clauses.native_unavailable",
          "packet.materials.takeoffs.native_unavailable",
          "packet.change_orders.native_unavailable",
        ],
      }),
    );

    await screen.findByRole("heading", { name: /Job details/ });
    expect(screen.queryByText(/Some job details may be old/)).not.toBeInTheDocument();
  });
});
