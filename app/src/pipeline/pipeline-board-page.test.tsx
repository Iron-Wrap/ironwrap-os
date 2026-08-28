import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadPipelineBoard, loadPipelines, moveCardToStage, undoCardMove } from "./pipeline-api";
import type { BoardStage, PipelineBoardResponse, PipelineListResponse } from "./pipeline-contracts";
import { SalesPipelineBoardPage } from "./pipeline-board-page";
import { applyOptimisticMove, UNDO_WINDOW_MS } from "./pipeline-board-model";

vi.mock("./pipeline-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pipeline-api")>();
  return {
    ...actual,
    loadPipelines: vi.fn(),
    loadPipelineBoard: vi.fn(),
    moveCardToStage: vi.fn(),
    undoCardMove: vi.fn(),
  };
});

const salesSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_sales",
    email: "sales@ironwrapexteriors.com",
    display_name: "Sales",
    role: "sales",
    frappe_user_id: "sales@ironwrapexteriors.com",
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
  read_model_generated_at: "2026-08-22T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const envelope = {
  version: 1 as const,
  source_updated_at: "2026-08-22T12:00:00.000Z",
  read_model_generated_at: "2026-08-22T12:00:01.000Z",
  stale_fields: [],
  permissions: ["pipeline:read"],
  allowed_actions: ["pipeline.card.move"],
};

function stage(
  stageId: string,
  name: string,
  position: number,
  overrides: Partial<BoardStage> = {},
): BoardStage {
  return {
    stage_id: stageId,
    key: stageId,
    name,
    position,
    is_won: false,
    is_lost: false,
    card_count: 0,
    total_amount_cents: 0,
    min_role_to_enter: null,
    ...overrides,
  };
}

const pipelineList: PipelineListResponse = {
  ...envelope,
  pipelines: [
    {
      pipeline_id: "pipe-sales",
      key: "sales",
      name: "Sales · Marketing Pipeline",
      entity_type: "lead",
      owning_role: "sales",
      position: 0,
    },
  ],
};

function boardModel(overrides: Partial<PipelineBoardResponse> = {}): PipelineBoardResponse {
  return {
    ...envelope,
    pipeline: {
      pipeline_id: "pipe-sales",
      key: "sales",
      name: "Sales · Marketing Pipeline",
      owning_role: "sales",
    },
    stages: [
      stage("new_lead", "New Lead", 0, { card_count: 1 }),
      stage("visit_booked", "Visit Booked", 1),
      stage("need_quote", "Need Quote", 2, { card_count: 1, total_amount_cents: 400_000 }),
      stage("quote_sent", "Quote Sent", 3),
      stage("contract_signed", "Contract signed", 4, { is_won: true }),
    ],
    cards: [
      {
        card_id: "card-lead",
        stage_id: "new_lead",
        position_in_stage: 10,
        version: 3,
        summary: { title: "Jubril Mcgregor" },
      },
      {
        card_id: "card-quote",
        stage_id: "need_quote",
        position_in_stage: 10,
        version: 7,
        summary: {
          title: "Naina Tamang",
          amount_cents: 400_000,
          identifiers: [{ label: "Lead", value: "26-219-ER" }],
          tags: ["Metal Roofing"],
          counters: [{ kind: "messages", count: 2 }],
          is_won: false,
        },
      },
    ],
    ...overrides,
  };
}

function renderBoard(session: AuthenticatedSession = salesSession) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session}>
        <SalesPipelineBoardPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

async function openMoveMenuFor(name: string) {
  const user = userEvent.setup();
  const card = await screen.findByRole("article", { name });
  await user.click(within(card).getByRole("button", { name: /^Move/ }));
  return { user, dialog: await screen.findByRole("dialog") };
}

describe("PipelineBoardPage", () => {
  beforeEach(() => {
    vi.mocked(loadPipelines).mockResolvedValue(pipelineList);
    vi.mocked(loadPipelineBoard).mockResolvedValue(boardModel());
    // The shape `transitionPayload` actually answers with: flat, and carrying the card's
    // version AFTER the move — the token the undo route demands back.
    vi.mocked(moveCardToStage).mockResolvedValue({
      transition_id: "tr-1",
      card_version: 8,
      undo_window_seconds: 30,
    });
    vi.mocked(undoCardMove).mockResolvedValue({ transition_id: "tr-2", card_version: 9 });
  });

  it("renders every seeded stage as its own column with counts and roll-ups", async () => {
    renderBoard();

    await screen.findByRole("region", { name: "New Lead column" });
    for (const name of [
      "New Lead",
      "Visit Booked",
      "Need Quote",
      "Quote Sent",
      "Contract signed",
    ]) {
      expect(screen.getByRole("region", { name: `${name} column` })).toBeVisible();
    }
    const needQuote = screen.getByRole("region", { name: "Need Quote column" });
    const card = within(needQuote).getByRole("article", { name: "Naina Tamang" });
    // Once as the column's roll-up, once as the card's own value.
    expect(within(needQuote).getAllByText("$4,000.00")).toHaveLength(2);
    expect(within(card).getByRole("heading", { name: "Naina Tamang" })).toBeVisible();
    expect(within(card).getByText("Lead:")).toBeVisible();
    expect(within(card).getByText("26-219-ER")).toBeVisible();
    expect(within(card).getByText("Metal Roofing")).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Visit Booked column" })).getByText(
        "No cards in this stage",
      ),
    ).toBeVisible();
  });

  // PO decision D4: no $ field exists before "Need Quote", and a fabricated $0.00 is
  // worse than a blank line.
  it("renders no value line on a card the server sent no amount for", async () => {
    renderBoard();

    const card = await screen.findByRole("article", { name: "Jubril Mcgregor" });
    expect(within(card).queryByText(/\$/)).toBeNull();
  });

  it("commits an adjacent-forward move with no confirmation step", async () => {
    renderBoard();
    const { user, dialog } = await openMoveMenuFor("Naina Tamang");

    await user.click(within(dialog).getByRole("button", { name: /Quote Sent/ }));

    await waitFor(() => expect(moveCardToStage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(moveCardToStage).mock.calls[0]?.[1]).toMatchObject({
      pipelineId: "pipe-sales",
      cardId: "card-quote",
      toStageId: "quote_sent",
      expectedVersion: 7,
      confirmed: false,
    });
    expect(await screen.findByText("Moved to Quote Sent")).toBeVisible();
    expect(screen.queryByText(/Confirm move/)).toBeNull();
  });

  // Also PO decision D2: the WON stage is two forward from "Need Quote", so this is a
  // skip — the confirm is for the skip, not for the WON flag.
  it("takes one explicit confirm before a backward move, and sends confirmed only then", async () => {
    renderBoard();
    const { user, dialog } = await openMoveMenuFor("Naina Tamang");

    await user.click(within(dialog).getByRole("button", { name: /New Lead/ }));

    expect(await screen.findByText(/Move backward to New Lead\?/)).toBeVisible();
    expect(moveCardToStage).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Confirm move/ }));

    await waitFor(() => expect(moveCardToStage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(moveCardToStage).mock.calls[0]?.[1]).toMatchObject({
      toStageId: "new_lead",
      confirmed: true,
    });
  });

  it("cancels a pending confirm without moving anything", async () => {
    renderBoard();
    const { user, dialog } = await openMoveMenuFor("Naina Tamang");

    await user.click(within(dialog).getByRole("button", { name: /New Lead/ }));
    await user.click(await within(dialog).findByRole("button", { name: "Cancel" }));

    expect(await within(dialog).findByRole("button", { name: /New Lead/ })).toBeVisible();
    expect(moveCardToStage).not.toHaveBeenCalled();
  });

  it("rolls the optimistic move back and renders the exact role the server reserved the stage for", async () => {
    vi.mocked(moveCardToStage).mockRejectedValue(
      new ApiError({
        status: 403,
        code: "stage_entry_role_required",
        message: "refused",
        details: { required_role: "production" },
      }),
    );
    renderBoard();
    const { user, dialog } = await openMoveMenuFor("Naina Tamang");

    await user.click(within(dialog).getByRole("button", { name: /Quote Sent/ }));

    // The server named the stage and the role. Neither is swallowed into "move failed".
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Your role cannot move a card into Quote Sent — it is reserved for production/,
    );
    const needQuote = screen.getByRole("region", { name: "Need Quote column" });
    expect(within(needQuote).getByRole("heading", { name: "Naina Tamang" })).toBeVisible();
  });

  // Acceptance criterion 2: a stale-version move renders the server's exact blocker,
  // including the version the server says the card is actually on.
  it("rolls back and reports the stale-version blocker with the server's own version", async () => {
    vi.mocked(moveCardToStage).mockRejectedValue(
      new ApiError({
        status: 409,
        code: "pipeline_card_version_conflict",
        message: "conflict",
        details: { card_version: 9 },
      }),
    );
    renderBoard();
    const { user, dialog } = await openMoveMenuFor("Naina Tamang");

    await user.click(within(dialog).getByRole("button", { name: /Quote Sent/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Someone else changed this card first — it is now at version 9\. The board has been refreshed/,
    );
    const needQuote = screen.getByRole("region", { name: "Need Quote column" });
    expect(within(needQuote).getByRole("heading", { name: "Naina Tamang" })).toBeVisible();
  });

  // The server owns the safeguard rule. If it asks for a confirm this client thought it
  // could skip, the UI surfaces the confirm and re-sends the SAME idempotency key.
  it("shows the confirm step when the server answers confirmation_required, reusing the key", async () => {
    vi.mocked(moveCardToStage).mockRejectedValueOnce(
      new ApiError({ status: 409, code: "confirmation_required", message: "confirm" }),
    );
    renderBoard();
    const { user, dialog } = await openMoveMenuFor("Naina Tamang");

    await user.click(within(dialog).getByRole("button", { name: /Quote Sent/ }));

    expect(await screen.findByText(/Move to Quote Sent\?/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Confirm move/ }));

    await waitFor(() => expect(moveCardToStage).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(moveCardToStage).mock.calls;
    expect(first?.[2]).toBe(second?.[2]);
    expect(second?.[1]).toMatchObject({ confirmed: true });
  });

  it("offers Undo for exactly the five-second window and calls the undo route inside it", async () => {
    renderBoard();
    const { user, dialog } = await openMoveMenuFor("Naina Tamang");
    await user.click(within(dialog).getByRole("button", { name: /Quote Sent/ }));
    await screen.findByText("Moved to Quote Sent");

    const undo = screen.getByRole("button", { name: "Undo" });
    await user.click(undo);

    await waitFor(() => expect(undoCardMove).toHaveBeenCalledTimes(1));
    // `expectedVersion` is the card's version AFTER the move. Without it `handleUndo`
    // answers 400 `invalid_pipeline_transition` before it looks at anything else, so this
    // assertion is the difference between a working Undo and a button that never worked.
    expect(vi.mocked(undoCardMove).mock.calls[0]?.[1]).toMatchObject({
      pipelineId: "pipe-sales",
      cardId: "card-quote",
      transitionId: "tr-1",
      expectedVersion: 8,
    });
  });

  it("withdraws the Undo affordance once the window closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderBoard();
      const card = await screen.findByRole("article", { name: "Naina Tamang" });
      await user.click(within(card).getByRole("button", { name: /^Move/ }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: /Quote Sent/ }));
      await screen.findByText("Moved to Quote Sent");
      expect(screen.getByRole("button", { name: "Undo" })).toBeVisible();

      await act(async () => {
        vi.advanceTimersByTime(UNDO_WINDOW_MS + 50);
      });

      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
      expect(screen.queryByText("Moved to Quote Sent")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lifts a card into the move sheet only after the long-press threshold", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderBoard();
      const card = await screen.findByRole("article", { name: "Naina Tamang" });

      fireEvent.pointerDown(card, { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 20 });
      await act(async () => {
        vi.advanceTimersByTime(240);
      });
      expect(screen.queryByRole("dialog")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(20);
      });
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(card).toHaveAttribute("data-lifted", "true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not lift a card when the finger travels first — that gesture is a scroll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderBoard();
      const card = await screen.findByRole("article", { name: "Naina Tamang" });

      fireEvent.pointerDown(card, { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 20 });
      fireEvent.pointerMove(window, {
        pointerId: 1,
        pointerType: "touch",
        clientX: 90,
        clientY: 20,
      });
      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaches the move menu and a backward confirm with the keyboard alone", async () => {
    const user = userEvent.setup();
    renderBoard();
    const card = await screen.findByRole("article", { name: "Naina Tamang" });
    const moveButton = within(card).getByRole("button", { name: /^Move/ });

    moveButton.focus();
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: /New Lead/ })).toHaveFocus(),
    );
    await user.keyboard("{Enter}");

    expect(await screen.findByText(/Move backward to New Lead\?/)).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: /Confirm move/ })).toHaveFocus());
    await user.keyboard("{Enter}");

    await waitFor(() => expect(moveCardToStage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(moveCardToStage).mock.calls[0]?.[1]).toMatchObject({
      toStageId: "new_lead",
      confirmed: true,
    });
  });

  it("walks the stage rows with the arrow keys", async () => {
    const user = userEvent.setup();
    renderBoard();
    const { dialog } = await openMoveMenuFor("Naina Tamang");

    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: /New Lead/ })).toHaveFocus(),
    );
    await user.keyboard("{ArrowDown}");
    expect(within(dialog).getByRole("button", { name: /Visit Booked/ })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(within(dialog).getByRole("button", { name: /New Lead/ })).toHaveFocus();
  });

  it("marks the card's own stage as current and unpickable", async () => {
    renderBoard();
    const { dialog } = await openMoveMenuFor("Naina Tamang");
    expect(within(dialog).getByRole("button", { name: /Need Quote \(current\)/ })).toBeDisabled();
  });

  // Acceptance criterion 4, UI half: a role the read model gives no move action to has
  // no way to move a card from this surface. The API half is enforced server-side.
  it("gives a read-only role no move affordance at all", async () => {
    vi.mocked(loadPipelineBoard).mockResolvedValue(
      boardModel({ allowed_actions: ["pipeline.read"] }),
    );
    renderBoard();

    expect(await screen.findByText("Read only")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Move/ })).toBeNull();
    const card = screen.getByRole("article", { name: "Naina Tamang" });
    fireEvent.pointerDown(card, { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 20 });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("locks a stage the actor's role may not enter", async () => {
    vi.mocked(loadPipelineBoard).mockResolvedValue(
      boardModel({
        stages: [
          stage("new_lead", "New Lead", 0, { card_count: 1 }),
          stage("need_quote", "Need Quote", 2, { card_count: 1, total_amount_cents: 400_000 }),
          stage("deposit", "Deposit", 3, { min_role_to_enter: "accounting" }),
        ],
      }),
    );
    renderBoard();
    const { dialog } = await openMoveMenuFor("Naina Tamang");

    expect(within(dialog).getByRole("button", { name: /Deposit/ })).toBeDisabled();
  });

  // Acceptance criterion 4. The fail-closed empty state is the SERVER's answer, not a
  // client-side filter: `GET /api/v1/pipelines` is deny-by-default (`canViewPipeline`), so
  // a role that owns nothing and was granted nothing gets an empty list, and the board
  // read is never even attempted.
  it("renders the fail-closed empty state for a role the server grants no pipeline", async () => {
    vi.mocked(loadPipelines).mockResolvedValue({ ...pipelineList, pipelines: [] });
    renderBoard();

    expect(await screen.findByText("No pipeline yet")).toBeVisible();
    expect(screen.getByText(/An administrator adds one in Settings/)).toBeVisible();
    expect(loadPipelineBoard).not.toHaveBeenCalled();
  });

  /**
   * The counterpart to the criterion above, and the reason the old `owning_role` filter had
   * to go. Since 0122 an administrator can grant one role write on ONE other pipeline —
   * "the shop board is read by production and written by ops". The server puts that board
   * in this session's list; a client that re-filtered by `owning_role` would drop it and
   * make the administrator's configuration unreachable.
   */
  it("opens a board the administrator granted this role, instead of hiding it", async () => {
    const salesPipeline = pipelineList.pipelines[0]!;
    vi.mocked(loadPipelines).mockResolvedValue({
      ...pipelineList,
      pipelines: [
        { ...salesPipeline, pipeline_id: "pipe-shop", name: "Shop", owning_role: "production" },
      ],
    });
    vi.mocked(loadPipelineBoard).mockResolvedValue(
      boardModel({
        pipeline: {
          pipeline_id: "pipe-shop",
          key: "shop",
          name: "Shop",
          owning_role: "production",
        },
      }),
    );
    renderBoard();

    expect(await screen.findByRole("heading", { name: "Shop" })).toBeVisible();
    expect(loadPipelineBoard).toHaveBeenCalledWith("pipe-shop");
    expect(screen.queryByText("No pipeline yet")).toBeNull();
  });

  // An account may hold any number of pipelines, so the switcher is not owner-only: a
  // salesperson who works two boards reaches the second one here.
  it("switches between every board the server returned for this role", async () => {
    const salesPipeline = pipelineList.pipelines[0]!;
    vi.mocked(loadPipelines).mockResolvedValue({
      ...pipelineList,
      pipelines: [
        salesPipeline,
        { ...salesPipeline, pipeline_id: "pipe-resale", key: "resale", name: "Material resale" },
      ],
    });
    vi.mocked(loadPipelineBoard).mockImplementation(async (pipelineId: string) =>
      boardModel({
        pipeline:
          pipelineId === "pipe-resale"
            ? { pipeline_id: "pipe-resale", key: "resale", name: "Material resale" }
            : { pipeline_id: "pipe-sales", key: "sales", name: "Sales · Marketing Pipeline" },
      }),
    );
    const user = userEvent.setup();
    renderBoard();

    // Sales opens on the board Sales owns, and the other one is one control away.
    expect(
      await screen.findByRole("heading", { name: "Sales · Marketing Pipeline" }),
    ).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox", { name: "Pipeline" }), "pipe-resale");

    expect(await screen.findByRole("heading", { name: "Material resale" })).toBeVisible();
    expect(loadPipelineBoard).toHaveBeenCalledWith("pipe-resale");
  });

  /**
   * `can_enter` is the server's own decision on the stage, folding the move right and
   * `min_role_to_enter` together. It wins over the client's mirror of the same rule — an
   * administrator restricting a stage must land on the board without a client release.
   */
  it("locks a stage the server closed, even when the client's own rule would open it", async () => {
    vi.mocked(loadPipelineBoard).mockResolvedValue(
      boardModel({
        stages: [
          stage("new_lead", "New Lead", 0, { card_count: 1 }),
          stage("visit_booked", "Visit Booked", 1),
          stage("need_quote", "Need Quote", 2, { card_count: 1, total_amount_cents: 400_000 }),
          // No `min_role_to_enter`, so the client's fallback would say "open".
          stage("quote_sent", "Quote Sent", 3, { can_enter: false }),
        ],
      }),
    );
    renderBoard();
    const { dialog } = await openMoveMenuFor("Naina Tamang");

    expect(within(dialog).getByRole("button", { name: /Quote Sent/ })).toBeDisabled();
    expect(within(dialog).getByLabelText("Restricted stage")).toBeVisible();
  });

  // Acceptance criterion 3, end to end against a server that actually moves the card.
  it("restores the card to its previous stage when the move is undone", async () => {
    let state = boardModel();
    vi.mocked(loadPipelineBoard).mockImplementation(async () => structuredClone(state));
    vi.mocked(moveCardToStage).mockImplementation(async (_session, input) => {
      state = applyOptimisticMove(state, input.cardId, input.toStageId);
      return { transition_id: "tr-1", card_version: 8, undo_window_seconds: 30 };
    });
    vi.mocked(undoCardMove).mockImplementation(async (_session, input) => {
      state = applyOptimisticMove(state, input.cardId, "need_quote");
      return { transition_id: "tr-2", card_version: 9 };
    });
    renderBoard();
    const { user, dialog } = await openMoveMenuFor("Naina Tamang");

    await user.click(within(dialog).getByRole("button", { name: /Quote Sent/ }));
    await screen.findByText("Moved to Quote Sent");
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Quote Sent column" })).getByRole("heading", {
          name: "Naina Tamang",
        }),
      ).toBeVisible(),
    );

    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Move undone. Card is back in Need Quote.")).toBeVisible();
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Need Quote column" })).getByRole("heading", {
          name: "Naina Tamang",
        }),
      ).toBeVisible(),
    );
  });

  it("renders the undo route's own blocker rather than a generic failure", async () => {
    vi.mocked(undoCardMove).mockRejectedValue(
      new ApiError({
        status: 409,
        code: "pipeline_undo_window_expired",
        message: "expired",
        details: { undo_window_seconds: 30 },
      }),
    );
    renderBoard();
    const { user, dialog } = await openMoveMenuFor("Naina Tamang");
    await user.click(within(dialog).getByRole("button", { name: /Quote Sent/ }));
    await screen.findByText("Moved to Quote Sent");

    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /undo window of 30 seconds has closed\. Move the card back to Need Quote instead/,
    );
  });

  // No version, no undo we could actually perform: offering the button would only produce
  // a 400 from `handleUndo`.
  it("offers no Undo when the server's response carried no card version", async () => {
    vi.mocked(moveCardToStage).mockResolvedValue({ transition_id: "tr-1" });
    renderBoard();
    const { user, dialog } = await openMoveMenuFor("Naina Tamang");

    await user.click(within(dialog).getByRole("button", { name: /Quote Sent/ }));

    expect(await screen.findByText("Moved to Quote Sent")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});
