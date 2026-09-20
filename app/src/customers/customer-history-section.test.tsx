import { screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { renderWithSession, sessionFor } from "../admin/admin-test-harness";
import { loadCustomerJobHistory } from "./customer-history-api";
import type {
  CustomerJobHistoryEntry,
  CustomerJobHistoryResponse,
} from "./customer-history-contracts";
import { CustomerJobHistorySection } from "./customer-history-section";

vi.mock("@tanstack/react-router", () => ({
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
vi.mock("./customer-history-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./customer-history-api")>()),
  loadCustomerJobHistory: vi.fn(),
}));

const loadCustomerJobHistoryMock = vi.mocked(loadCustomerJobHistory);
const dateOptions = { locale: "en-CA", timeZone: "America/Edmonton" };

function entry(overrides: Partial<CustomerJobHistoryEntry> = {}): CustomerJobHistoryEntry {
  return {
    roof_job_id: "JOB-DONE",
    job_number: "IW-1001",
    service_type: "Metal re-roof",
    job_status: "Complete",
    brand: "ironwrap",
    property: {
      property_id: "PROPERTY-B",
      address_line1: "88 Riverbend Way",
      city: "Calgary",
      province: "AB",
      postal_code: "T2P 1A1",
      structure_type: "Detached",
    },
    is_anchor: false,
    openable: false,
    created_at: "2024-10-01T10:00:00.000Z",
    updated_at: "2024-11-02T10:00:00.000Z",
    ...overrides,
  };
}

function history(
  entries: CustomerJobHistoryEntry[],
  truncated = false,
): CustomerJobHistoryResponse {
  return {
    customer: {
      customer_id: "CUSTOMER-A",
      display_name: "Northside Holdings",
      lifecycle_status: "active",
    },
    anchor_job_id: "JOB-LIVE",
    entries: [entry({ roof_job_id: "JOB-LIVE", is_anchor: true, openable: true }), ...entries],
    truncated,
    generated_at: "2026-03-01T10:00:00.000Z",
  };
}

function render() {
  return renderWithSession(
    <CustomerJobHistorySection jobId="JOB-LIVE" dateOptions={dateOptions} />,
    sessionFor("owner"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("shows the finished job with the address it was done at, and offers no link to open it", async () => {
  loadCustomerJobHistoryMock.mockResolvedValue(history([entry()]));
  render();

  expect(await screen.findByText("Earlier work")).toBeInTheDocument();
  expect(screen.getByText("Northside Holdings")).toBeInTheDocument();
  expect(screen.getByText("IW-1001")).toBeInTheDocument();
  expect(screen.getByText("Complete")).toBeInTheDocument();
  expect(screen.getByText("88 Riverbend Way, Calgary, AB, T2P 1A1")).toBeInTheDocument();
  expect(screen.getByText(/Finished work/)).toBeInTheDocument();
  // A finished job has no live job plan; a link that 404s would be worse than no link.
  expect(screen.queryByRole("link", { name: /Open this job/ })).not.toBeInTheDocument();
});

it("links to earlier work that is still open", async () => {
  loadCustomerJobHistoryMock.mockResolvedValue(
    history([
      entry({
        roof_job_id: "JOB-OTHER",
        job_number: "IW-1002",
        job_status: "In Production",
        openable: true,
      }),
    ]),
  );
  render();

  const link = await screen.findByRole("link", { name: /Open this job/ });
  expect(link).toHaveAttribute("href", "/jobs/JOB-OTHER");
});

it("never shows the anchor job as earlier work", async () => {
  loadCustomerJobHistoryMock.mockResolvedValue(history([entry()]));
  render();

  await screen.findByText("Earlier work");
  expect(screen.queryByText("JOB-LIVE")).not.toBeInTheDocument();
});

it("says the customer is new rather than leaving the absence ambiguous", async () => {
  loadCustomerJobHistoryMock.mockResolvedValue(history([]));
  render();

  expect(
    await screen.findByText(/This is the first job on record for Northside Holdings/),
  ).toBeInTheDocument();
});

it("says a capped page is not the whole history", async () => {
  loadCustomerJobHistoryMock.mockResolvedValue(history([entry()], true));
  render();

  expect(await screen.findByText(/has more work on record than fits here/)).toBeInTheDocument();
});

it("renders nothing at all for a reader the server refuses", async () => {
  // `loadCustomerJobHistory` answers null for 403 and 404 alike: a crew member is not missing
  // something they were meant to have, so there is no explanation worth the screen space.
  loadCustomerJobHistoryMock.mockResolvedValue(null);
  const { container } = render();

  await waitFor(() => expect(loadCustomerJobHistoryMock).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByTestId("customer-job-history")).not.toBeInTheDocument());
  expect(container.textContent).toBe("");
});
