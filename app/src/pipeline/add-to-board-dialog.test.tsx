import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { AddToBoardDialog } from "./add-to-board-dialog";
import { loadPipelines, placeCardOnPipeline } from "./pipeline-api";
import type { PlaceableEntity } from "./pipeline-board-model";
import type { PipelineListResponse } from "./pipeline-contracts";

vi.mock("./pipeline-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pipeline-api")>();
  return { ...actual, loadPipelines: vi.fn(), placeCardOnPipeline: vi.fn() };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_sales",
    email: "sales@example.invalid",
    display_name: "Sales",
    role: "sales",
    frappe_user_id: "sales@example.invalid",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["pipeline:read"],
  allowed_actions: ["pipeline.card.move"],
  csrf_token: "csrf",
  session_expires_at: "2026-09-30T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-28T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const envelope = {
  version: 1 as const,
  source_updated_at: "2026-08-28T12:00:00.000Z",
  read_model_generated_at: "2026-08-28T12:00:01.000Z",
  stale_fields: [],
  permissions: ["pipeline:read"],
  allowed_actions: ["pipeline.read"],
};

const pipelineList: PipelineListResponse = {
  ...envelope,
  pipelines: [
    {
      pipeline_id: "pipe-sales",
      key: "sales",
      name: "Sales",
      entity_type: "lead",
      owning_role: "sales",
      can_move: true,
      position: 0,
    },
    {
      pipeline_id: "pipe-shop",
      key: "shop",
      name: "Shop",
      entity_type: "job",
      owning_role: "production",
      can_move: true,
      position: 1,
    },
    {
      pipeline_id: "pipe-commercial",
      key: "commercial",
      name: "Commercial projects",
      entity_type: "lead",
      owning_role: "owner",
      // Read-only for this session: the server already folded the role grants into this.
      can_move: false,
      position: 2,
    },
  ],
};

const lead: PlaceableEntity = {
  entityType: "lead",
  entityId: "lead-1",
  label: "Pat Prospect",
  typeLabel: "lead",
};
const job: PlaceableEntity = {
  entityType: "job",
  entityId: "job-1",
  label: "IW-1001",
  typeLabel: "job",
};

function renderDialog(entities: readonly PlaceableEntity[] = [lead, job], onClose = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session}>
        <AddToBoardDialog entities={entities} onClose={onClose} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

function placementReceipt(overrides: Record<string, unknown> = {}) {
  return {
    card_id: "plc_1",
    pipeline_id: "pipe-sales",
    stage_id: "new_lead",
    entity_type: "lead",
    entity_id: "lead-1",
    card_version: 1,
    transition_id: "pct_1",
    replayed: false,
    ...overrides,
  };
}

describe("AddToBoardDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadPipelines).mockResolvedValue(pipelineList);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  it("offers each board the server says takes this work, named by what it will add", async () => {
    renderDialog();

    const sales = await screen.findByRole("button", { name: /^Sales/ });
    expect(sales).toHaveTextContent("Adds lead Pat Prospect");
    expect(screen.getByRole("button", { name: /^Shop/ })).toHaveTextContent("Adds job IW-1001");
    // Entity type matches, but this session may not write it.
    expect(screen.queryByRole("button", { name: /Commercial projects/ })).not.toBeInTheDocument();
  });

  it("places the lead on the chosen board and says where it landed", async () => {
    const user = userEvent.setup();
    vi.mocked(placeCardOnPipeline).mockResolvedValue(placementReceipt());
    renderDialog();

    await user.click(await screen.findByRole("button", { name: /^Sales/ }));

    await screen.findByText(/is on/);
    expect(vi.mocked(placeCardOnPipeline).mock.calls[0]?.[1]).toEqual({
      pipelineId: "pipe-sales",
      entityType: "lead",
      entityId: "lead-1",
    });
    // The idempotency key the placement route demands, in the shape it accepts.
    expect(vi.mocked(placeCardOnPipeline).mock.calls[0]?.[2]).toMatch(
      /^pipeline-card-place:[A-Za-z0-9-]{8,}$/,
    );
    expect(screen.getByRole("link", { name: "Open the board" })).toHaveAttribute(
      "href",
      "/sales/board",
    );
  });

  it("places the JOB on a job board, not the lead it came from", async () => {
    const user = userEvent.setup();
    vi.mocked(placeCardOnPipeline).mockResolvedValue(
      placementReceipt({ pipeline_id: "pipe-shop", entity_type: "job", entity_id: "job-1" }),
    );
    renderDialog();

    await user.click(await screen.findByRole("button", { name: /^Shop/ }));

    await screen.findByText(/is on/);
    expect(vi.mocked(placeCardOnPipeline).mock.calls[0]?.[1]).toMatchObject({
      pipelineId: "pipe-shop",
      entityType: "job",
      entityId: "job-1",
    });
  });

  // Repeat placement, rule 1 of 2: the server's own idempotency returns the existing card.
  it("reports a replayed placement as a success, not a second card", async () => {
    const user = userEvent.setup();
    vi.mocked(placeCardOnPipeline).mockResolvedValue(placementReceipt({ replayed: true }));
    renderDialog();

    await user.click(await screen.findByRole("button", { name: /^Sales/ }));

    expect(await screen.findByText(/is on/)).toBeInTheDocument();
    expect(screen.queryByText("Not added")).not.toBeInTheDocument();
  });

  // Repeat placement, rule 2 of 2: the same pair placed first by someone else refuses the replay
  // because the fingerprint differs. The card IS on the board, so this is still not an error.
  it("treats an idempotency conflict as already placed", async () => {
    const user = userEvent.setup();
    vi.mocked(placeCardOnPipeline).mockRejectedValue(
      new ApiError({
        message: "",
        status: 409,
        code: "pipeline_transition_idempotency_conflict",
      }),
    );
    renderDialog();

    await user.click(await screen.findByRole("button", { name: /^Sales/ }));

    expect(await screen.findByText(/already on Sales/)).toBeInTheDocument();
  });

  // The client filters, but the SERVER decides: a board whose binding changed after this list
  // was read still refuses, and the refusal is rendered as itself.
  it("renders the server's entity-type refusal instead of pretending it worked", async () => {
    const user = userEvent.setup();
    vi.mocked(placeCardOnPipeline).mockRejectedValue(
      new ApiError({ message: "", status: 409, code: "pipeline_entity_type_mismatch" }),
    );
    renderDialog();

    await user.click(await screen.findByRole("button", { name: /^Sales/ }));

    expect(await screen.findByText("Not added")).toBeInTheDocument();
    expect(screen.getByText(/tracks a different kind of work/)).toBeInTheDocument();
  });

  it("renders the server's role refusal when it disagrees with the list", async () => {
    const user = userEvent.setup();
    vi.mocked(placeCardOnPipeline).mockRejectedValue(
      new ApiError({ message: "", status: 403, code: "pipeline_move_forbidden" }),
    );
    renderDialog();

    await user.click(await screen.findByRole("button", { name: /^Sales/ }));

    expect(await screen.findByText(/not add cards to it/)).toBeInTheDocument();
  });

  it("says so, and posts nothing, when a board takes none of this work", async () => {
    vi.mocked(loadPipelines).mockResolvedValue({
      ...envelope,
      pipelines: [
        {
          pipeline_id: "pipe-shop",
          key: "shop",
          name: "Shop",
          entity_type: "job",
          can_move: true,
          position: 0,
        },
      ],
    });
    renderDialog([lead]);

    expect(await screen.findByText("No board takes this yet")).toBeInTheDocument();
    expect(placeCardOnPipeline).not.toHaveBeenCalled();
  });

  it("is read-only offline and never queues the placement", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    renderDialog();

    expect(await screen.findByText("Offline: a card cannot be added")).toBeInTheDocument();
    await waitFor(() => expect(loadPipelines).not.toHaveBeenCalled());
    expect(placeCardOnPipeline).not.toHaveBeenCalled();
  });
});
