import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render as renderUi, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { renderWithSession, sessionFor } from "../admin/admin-test-harness";
import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadJobHistory } from "./job-history-api";
import { jobHistoryQueryKey, type JobHistoryResponse } from "./job-history-contracts";
import { JobHistoryPage } from "./job-history-page";

const routing = vi.hoisted(() => ({ jobId: "JOB-FINISHED" }));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => routing,
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => (
    <a
      href={Object.entries(params ?? {}).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to,
      )}
      {...props}
    >
      {children}
    </a>
  ),
}));
vi.mock("./job-history-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./job-history-api")>()),
  loadJobHistory: vi.fn(),
}));

const loadJobHistoryMock = vi.mocked(loadJobHistory);

function model(overrides: Partial<JobHistoryResponse> = {}): JobHistoryResponse {
  return {
    version: 1,
    source_updated_at: "2024-11-02T10:00:00.000Z",
    read_model_generated_at: "2026-09-15T10:00:00.000Z",
    stale_fields: [],
    permissions: ["jobs:read:any"],
    allowed_actions: [],
    job: {
      id: "JOB-FINISHED",
      roof_job_id: "JOB-FINISHED",
      job_number: "IW-1001",
      brand: "ironwrap",
      service_type: "Metal re-roof",
      status: "Complete",
      address: "88 Riverbend Way, Calgary AB",
      current_gate_state: "Complete",
    },
    customer: { display_name: "Northside Holdings", phone: "+14035550111" },
    gates: [],
    proof: {
      items: [
        {
          id: "evi_1",
          type: "Job plan evidence",
          proof_slot: "North slope",
          occurred_at: "2024-11-02T10:00:00.000Z",
          summary: "Finished roof, north slope",
          customer_safe: false,
          source: "Device camera",
          sync_state: "Verified",
          blocker: false,
        },
      ],
      next_cursor: null,
    },
    openable: false,
    proof_unavailable: false,
    ...overrides,
  } as JobHistoryResponse;
}

function render() {
  return renderWithSession(<JobHistoryPage />, sessionFor("owner"));
}

function renderControlled() {
  const session = sessionFor("owner");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (current: AuthenticatedSession) => (
    <QueryClientProvider client={client}>
      <SessionProvider session={current}>
        <JobHistoryPage />
      </SessionProvider>
    </QueryClientProvider>
  );
  const rendered = renderUi(view(session));
  return {
    client,
    session,
    rerenderWithSession: (next: AuthenticatedSession) => rendered.rerender(view(next)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  routing.jobId = "JOB-FINISHED";
});

afterEach(() => focusManager.setFocused(undefined));

it("opens a finished job and shows what was done to it", async () => {
  loadJobHistoryMock.mockResolvedValue(model());
  render();

  expect(
    await screen.findByRole("heading", {
      name: /^Job record for: Northside Holdings\s· 88 Riverbend Way\s· Ref IW-1001$/,
    }),
  ).toBeInTheDocument();
  expect(screen.getByText(/Complete · Metal re-roof/)).toBeInTheDocument();
  expect(screen.getByText("88 Riverbend Way, Calgary AB")).toBeInTheDocument();
  expect(screen.getByText("Northside Holdings")).toBeInTheDocument();
  expect(screen.getByText("Finished roof, north slope")).toBeInTheDocument();
  expect(screen.getByText("Job plan evidence")).toBeInTheDocument();
});

it.each([
  {
    customer: null,
    address: "88 Riverbend Way, Calgary AB",
    code: "IW-1001",
    title: "Job record for: 88 Riverbend Way · Ref IW-1001",
  },
  {
    customer: "Northside Holdings",
    address: null,
    code: "IW-1001",
    title: "Job record for: Northside Holdings · Ref IW-1001",
  },
  {
    customer: "Northside Holdings",
    address: "88 Riverbend Way, Calgary AB",
    code: null,
    title: "Job record for: Northside Holdings · 88 Riverbend Way",
  },
  { customer: null, address: null, code: "IW-1001", title: "Job record · Reference IW-1001" },
  { customer: null, address: null, code: null, title: "Job record" },
  { customer: " ", address: " ", code: " ", title: "Job record" },
])(
  "names only the job identity the record supplies: $title",
  async ({ customer, address, code, title }) => {
    loadJobHistoryMock.mockResolvedValue(
      model({
        customer: customer === null ? null : { display_name: customer, phone: null },
        job: { ...model().job, address, job_number: code },
      }),
    );
    render();

    const heading = await screen.findByRole("heading", {
      level: 1,
      name: (name) => name.replace(/\s+/g, " ") === title,
    });
    expect(heading).not.toHaveTextContent("JOB-FINISHED");
    expect(loadJobHistoryMock).toHaveBeenCalledExactlyOnceWith("JOB-FINISHED");
  },
);

it("says plainly that nothing here is a control", async () => {
  loadJobHistoryMock.mockResolvedValue(model());
  render();

  expect(await screen.findByText(/Nothing on this page changes it/)).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Open the live job plan/ })).not.toBeInTheDocument();
});

it("offers the live plan only while the work is still running", async () => {
  loadJobHistoryMock.mockResolvedValue(model({ openable: true }));
  render();

  const link = await screen.findByRole("link", { name: /Open the live job plan/ });
  expect(link).toHaveAttribute("href", "/jobs/JOB-FINISHED");
});

it("never lets unreadable proof render as no proof", async () => {
  // These look identical and mean opposite things. "Nothing was photographed on this roof" is a
  // claim the page would be in no position to make.
  loadJobHistoryMock.mockResolvedValue(
    model({ proof_unavailable: true, proof: { items: [], next_cursor: null } }),
  );
  render();

  expect(await screen.findByText(/The proof could not be read/)).toBeInTheDocument();
  expect(screen.getByText(/This is not the same as none/)).toBeInTheDocument();
  expect(screen.queryByText(/No sent job proof yet/)).not.toBeInTheDocument();
});

it("shows an empty record as empty when the read did work", async () => {
  loadJobHistoryMock.mockResolvedValue(model({ proof: { items: [], next_cursor: null } }));
  render();

  expect(await screen.findByText(/No sent job proof yet/)).toBeInTheDocument();
  expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
});

it("says so when the reader may not open this job", async () => {
  loadJobHistoryMock.mockResolvedValue(null);
  render();

  expect(await screen.findByText(/not one you can open/)).toBeInTheDocument();
});

it("keeps gate holders and event saved state tied to their recorded sources", async () => {
  loadJobHistoryMock.mockResolvedValue(
    model({
      gates: [
        {
          id: "gate:materials",
          name: "Materials",
          state: "Blocked",
          blocker_reason: "Delivery receipt missing",
          owner: "Dispatch desk",
          due_at: "2026-10-02T13:00:00.000Z",
        },
      ],
    }),
  );
  render();

  expect(await screen.findByText("Delivery receipt missing")).toBeVisible();
  expect(screen.getByText("Holder: Dispatch desk")).toBeVisible();
  expect(screen.getByLabelText("Materials: Blocked")).toBeVisible();
  expect(screen.getByRole("list", { name: "Received job events" })).toHaveTextContent(
    "VerifiedDevice camera · North slope",
  );
  expect(screen.getByText(/do not provide a named actor or approval version/)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /clear|approve|release|dispatch/i }),
  ).not.toBeInTheDocument();
});

it("preserves loaded job events and the cursor when an older page cannot be read", async () => {
  loadJobHistoryMock
    .mockResolvedValueOnce(
      model({ proof: { items: model().proof.items, next_cursor: "older:001" } }),
    )
    .mockRejectedValueOnce(new Error("evidence read failed"));
  render();
  await userEvent.click(await screen.findByRole("button", { name: "Load older events" }));

  expect(await screen.findByText("Older events unavailable")).toBeVisible();
  expect(screen.getByText("Finished roof, north slope")).toBeVisible();
  expect(screen.getByRole("button", { name: "Load older events" })).toBeEnabled();
  expect(loadJobHistoryMock).toHaveBeenLastCalledWith("JOB-FINISHED", "older:001");
});

it("does not splice another job's events into this spine", async () => {
  const other = model({
    job: { ...model().job, id: "OTHER-JOB" },
    proof: {
      items: [{ ...model().proof.items[0]!, id: "other-evi", summary: "Other job event" }],
      next_cursor: null,
    },
  });
  loadJobHistoryMock
    .mockResolvedValueOnce(
      model({ proof: { items: model().proof.items, next_cursor: "older:001" } }),
    )
    .mockResolvedValueOnce(other);
  render();
  await userEvent.click(await screen.findByRole("button", { name: "Load older events" }));

  expect(await screen.findByText("Older events unavailable")).toBeVisible();
  expect(screen.queryByText("Other job event")).not.toBeInTheDocument();
});

it("merges a focus refresh without losing older events or rewinding their cursor", async () => {
  const original = model().proof.items[0]!;
  const older = { ...original, id: "older-evi", summary: "Older received event" };
  const refreshed = { ...original, summary: "Updated first-page event" };
  const newest = { ...original, id: "newest-evi", summary: "Newly received event" };
  loadJobHistoryMock
    .mockResolvedValueOnce(model({ proof: { items: [original], next_cursor: "older:001" } }))
    .mockResolvedValueOnce(model({ proof: { items: [older], next_cursor: "older:002" } }))
    .mockResolvedValueOnce(
      model({ proof: { items: [newest, refreshed], next_cursor: "refreshed:001" } }),
    )
    .mockResolvedValueOnce(model({ proof: { items: [older], next_cursor: null } }));
  renderControlled();
  await userEvent.click(await screen.findByRole("button", { name: "Load older events" }));
  expect(await screen.findByText("Older received event")).toBeVisible();

  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  expect(await screen.findByText("Newly received event")).toBeVisible();
  expect(screen.getByText("Updated first-page event")).toBeVisible();
  expect(screen.queryByText("Finished roof, north slope")).not.toBeInTheDocument();
  expect(screen.getAllByText("Older received event")).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: "Load older events" }));
  await waitFor(() =>
    expect(loadJobHistoryMock).toHaveBeenLastCalledWith("JOB-FINISHED", "older:002"),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Load older events" })).not.toBeInTheDocument(),
  );
  expect(screen.getAllByText("Older received event")).toHaveLength(1);
});

it("retains paginated events with an explicit limit when a background refresh fails", async () => {
  const original = model().proof.items[0]!;
  loadJobHistoryMock
    .mockResolvedValueOnce(model({ proof: { items: [original], next_cursor: "older:001" } }))
    .mockResolvedValueOnce(
      model({
        proof: {
          items: [{ ...original, id: "older-evi", summary: "Older received event" }],
          next_cursor: "older:002",
        },
      }),
    )
    .mockRejectedValueOnce(new Error("background read failed"));
  const { client, session } = renderControlled();
  await userEvent.click(await screen.findByRole("button", { name: "Load older events" }));
  expect(await screen.findByText("Older received event")).toBeVisible();

  await act(async () => {
    await client.refetchQueries({
      queryKey: jobHistoryQueryKey(session.tenant.id, session.user.id, "JOB-FINISHED"),
    });
  });
  expect(await screen.findByText("The latest job record could not be checked")).toBeVisible();
  expect(screen.getByText("Older received event")).toBeVisible();
  expect(screen.getByRole("button", { name: "Load older events" })).toBeEnabled();
});

it.each(["job", "tenant", "user"] as const)(
  "resets loaded pagination when the %s identity changes",
  async (identity) => {
    const original = model().proof.items[0]!;
    loadJobHistoryMock
      .mockResolvedValueOnce(model({ proof: { items: [original], next_cursor: "older:001" } }))
      .mockResolvedValueOnce(
        model({
          proof: {
            items: [{ ...original, id: "older-evi", summary: "Previous identity event" }],
            next_cursor: "older:002",
          },
        }),
      );
    const { client, session, rerenderWithSession } = renderControlled();
    await userEvent.click(await screen.findByRole("button", { name: "Load older events" }));
    expect(await screen.findByText("Previous identity event")).toBeVisible();

    const next = {
      ...session,
      ...(identity === "tenant" ? { tenant: { ...session.tenant, id: "other-tenant" } } : {}),
      ...(identity === "user" ? { user: { ...session.user, id: "other-user" } } : {}),
    };
    if (identity === "job") routing.jobId = "OTHER-JOB";
    const fresh = model({
      job: {
        ...model().job,
        id: routing.jobId,
        roof_job_id: routing.jobId,
        job_number: "IW-NEW-IDENTITY",
      },
      proof: {
        items: [{ ...original, id: "fresh-evi", summary: "Current identity event" }],
        next_cursor: null,
      },
    });
    loadJobHistoryMock.mockResolvedValue(fresh);
    client.setQueryData(jobHistoryQueryKey(next.tenant.id, next.user.id, routing.jobId), fresh);
    rerenderWithSession(next);

    expect(await screen.findByText("Current identity event")).toBeVisible();
    expect(screen.queryByText("Previous identity event")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older events" })).not.toBeInTheDocument();
  },
);
