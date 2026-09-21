import { screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { renderWithSession, sessionFor } from "../admin/admin-test-harness";
import { loadJobHistory } from "./job-history-api";
import type { JobHistoryResponse } from "./job-history-contracts";
import { JobHistoryPage } from "./job-history-page";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ jobId: "JOB-FINISHED" }),
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
          type: "Work Package Evidence",
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

beforeEach(() => {
  vi.clearAllMocks();
});

it("opens a finished job and shows what was done to it", async () => {
  loadJobHistoryMock.mockResolvedValue(model());
  render();

  expect(await screen.findByRole("heading", { name: "IW-1001" })).toBeInTheDocument();
  expect(screen.getByText(/Complete · Metal re-roof/)).toBeInTheDocument();
  expect(screen.getByText("88 Riverbend Way, Calgary AB")).toBeInTheDocument();
  expect(screen.getByText("Northside Holdings")).toBeInTheDocument();
  expect(screen.getByText("Finished roof, north slope")).toBeInTheDocument();
});

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
