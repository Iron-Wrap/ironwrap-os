import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadAuthorityDesk } from "./authority-api";
import type { AuthorityDeskResponse } from "./authority-contracts";
import { PeoplePage } from "./people-page";

vi.mock("./authority-api", async () => {
  const actual = await vi.importActual<typeof import("./authority-api")>("./authority-api");
  return { ...actual, loadAuthorityDesk: vi.fn() };
});

const opsSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_ops",
    email: "ops@example.invalid",
    display_name: "Operations",
    role: "ops",
    frappe_user_id: "ops@example.invalid",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["authority:read"],
  allowed_actions: [],
  csrf_token: "csrf",
  session_expires_at: "2036-08-20T09:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-20T09:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const head = (
  over: Partial<AuthorityDeskResponse["subjects"][number]["records"][number]> = {},
) => ({
  authority_record_id: "Authority-Record-0001",
  authority_version: 1,
  authority_kind: "Fall Protection",
  authority_scope: "field installation",
  scope_type: "Field",
  scope_ref: "field:job-1",
  issuer_name: "Alberta issuer",
  issuer_jurisdiction: "AB-CA",
  verification_state: "verified" as const,
  authority_effective_from: "2026-01-01",
  authority_expires_at: "2027-01-01",
  authority_revoked_at: null,
  observed_at: "2026-08-20T09:00:00.000Z",
  verdict: "clear" as const,
  denial_code: null,
  days_left: 120,
  ...over,
});

const desk = (over: Partial<AuthorityDeskResponse> = {}): AuthorityDeskResponse => ({
  version: 1,
  read_model_generated_at: "2026-08-20T09:00:00.000Z",
  expiring_within_days: 30,
  subjects: [
    {
      subject_key: "Person|Worker|clear@example.invalid|",
      subject_type: "Person",
      subject_role: "Worker",
      person_user: "clear@example.invalid",
      organization: null,
      records: [head()],
    },
  ],
  ...over,
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={opsSession}>
        <PeoplePage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("the People desk", () => {
  beforeEach(() => {
    vi.mocked(loadAuthorityDesk).mockReset();
  });

  it("shows every fact from the API and never invents one", async () => {
    vi.mocked(loadAuthorityDesk).mockResolvedValue(desk());
    renderPage();
    expect(await screen.findByText("clear@example.invalid")).toBeInTheDocument();
    expect(screen.getByText("Fall Protection")).toBeInTheDocument();
    expect(screen.getByText("Clear")).toBeInTheDocument();
    expect(screen.getByText(/Expires 2027-01-01, in 120 days/)).toBeInTheDocument();
    expect(screen.getByText(/Alberta issuer, AB-CA/)).toBeInTheDocument();
  });

  it("puts what is blocked before what is clear, and says why in words", async () => {
    vi.mocked(loadAuthorityDesk).mockResolvedValue(
      desk({
        subjects: [
          {
            subject_key: "a",
            subject_type: "Person",
            subject_role: "Worker",
            person_user: "expired@example.invalid",
            organization: null,
            records: [
              head({
                authority_record_id: "Authority-Record-0002",
                verdict: "expired",
                denial_code: "authority_expired",
                authority_expires_at: "2026-01-01",
                days_left: -231,
              }),
            ],
          },
          {
            subject_key: "b",
            subject_type: "Person",
            subject_role: "Worker",
            person_user: "clear@example.invalid",
            organization: null,
            records: [head()],
          },
        ],
      }),
    );
    renderPage();
    expect(await screen.findByText(/Needs attention, 1 of 2/)).toBeInTheDocument();
    expect(screen.getByText("Clear, 1")).toBeInTheDocument();
    expect(screen.getByText(/The expiry date has passed/)).toBeInTheDocument();
    expect(screen.getByText(/Expired 2026-01-01, 231 days ago/)).toBeInTheDocument();
  });

  it("says nothing is on file rather than showing an empty page", async () => {
    vi.mocked(loadAuthorityDesk).mockResolvedValue(desk({ subjects: [] }));
    renderPage();
    expect(await screen.findByText("Nothing has been read back yet")).toBeInTheDocument();
    expect(screen.getByText(/not the same as nobody being qualified/)).toBeInTheDocument();
  });

  it("refuses without pretending the screen is broken", async () => {
    vi.mocked(loadAuthorityDesk).mockRejectedValue(
      new ApiError({ message: "forbidden", status: 403, code: "authority_read_required" }),
    );
    renderPage();
    // "Not your role" is both the heading and the state label, so assert on the sentence.
    expect(await screen.findByText(/read by the owner and by operations/)).toBeInTheDocument();
    expect(screen.queryByText(/did not load/)).not.toBeInTheDocument();
  });

  it("offers a retry when the store does not answer", async () => {
    vi.mocked(loadAuthorityDesk).mockRejectedValue(
      new ApiError({
        message: "bad gateway",
        status: 502,
        code: "authority_record_store_unavailable",
      }),
    );
    renderPage();
    expect(await screen.findByText(/The authority store did not answer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("counts what an operator has to act on", async () => {
    vi.mocked(loadAuthorityDesk).mockResolvedValue(
      desk({
        subjects: [
          {
            subject_key: "a",
            subject_type: "Person",
            subject_role: "Worker",
            person_user: "one@example.invalid",
            organization: null,
            records: [
              head({ verdict: "expiring", days_left: 12, authority_expires_at: "2026-09-01" }),
            ],
          },
          {
            subject_key: "b",
            subject_type: "Person",
            subject_role: "Worker",
            person_user: "two@example.invalid",
            organization: null,
            records: [
              head({
                verdict: "revoked",
                denial_code: "authority_revoked",
                authority_revoked_at: "2026-07-01",
              }),
            ],
          },
        ],
      }),
    );
    renderPage();
    expect(await screen.findByText("Blocked now")).toBeInTheDocument();
    expect(screen.getByText("Expiring in 30 days")).toBeInTheDocument();
    expect(screen.getByText(/Revoked 2026-07-01/)).toBeInTheDocument();
  });
});
