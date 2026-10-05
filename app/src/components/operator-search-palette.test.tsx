import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadOperatorSearch } from "../search/operator-search-api";
import type { OperatorSearchReadModel } from "../search/operator-search-contracts";
import { OperatorSearchPalette, OperatorSearchPaletteTrigger } from "./operator-search-palette";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  online: true,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("../hooks/use-online-status", () => ({
  useOnlineStatus: () => mocks.online,
}));

vi.mock("../search/operator-search-api", () => ({
  loadOperatorSearch: vi.fn(),
}));

const session: AuthenticatedSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@example.invalid",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: null,
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:any", "sales:read"],
  allowed_actions: ["search.read"],
  csrf_token: "csrf",
  session_expires_at: "2030-08-24T10:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-24T10:00:00.000Z",
  stale_fields: [],
};

const model: OperatorSearchReadModel = {
  version: 1,
  source_updated_at: "2026-08-24T10:00:00.000Z",
  read_model_generated_at: "2026-08-24T10:00:01.000Z",
  stale_fields: [],
  permissions: ["jobs:read:any", "sales:read"],
  allowed_actions: ["search.read", "job.read", "lead.read", "navigation.read"],
  query: "iw",
  query_class: "text",
  outcome: "results",
  groups: [
    {
      group: "jobs",
      label: "Jobs",
      limit: 8,
      matched_fields: ["job_number"],
      results: [
        {
          id: "JOB-A",
          label: "IW-1001",
          detail: "Roofing · In production",
          href: "/jobs/JOB-A",
          matched_field: "job_number",
        },
        {
          id: "JOB-B",
          label: "IW-1002",
          detail: "Roofing · Qualified",
          href: "/jobs/JOB-B",
          matched_field: "job_number",
        },
      ],
      more_results: true,
    },
    {
      group: "leads",
      label: "Leads",
      limit: 8,
      matched_fields: ["contact_name"],
      results: [
        {
          id: "LEAD-A",
          label: "Maya Prospect",
          detail: "Website · New",
          href: "/sales/leads/LEAD-A/triage",
          matched_field: "contact_name",
        },
      ],
      more_results: false,
    },
  ],
};

function renderPalette(node: ReactNode = <OperatorSearchPalette open onOpenChange={vi.fn()} />) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider session={session}>{node}</SessionProvider>
    </QueryClientProvider>,
  );
}

function searchResult(overrides: Partial<OperatorSearchReadModel> = {}): OperatorSearchReadModel {
  return { ...model, ...overrides };
}

describe("OperatorSearchPalette", () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.online = true;
    vi.mocked(loadOperatorSearch).mockReset();
    vi.useRealTimers();
  });

  it("provides a named 44px trigger with the familiar shortcut", () => {
    const onOpen = vi.fn();
    render(<OperatorSearchPaletteTrigger onOpen={onOpen} />);
    const trigger = screen.getByRole("button", { name: "Open search (Command or Control K)" });
    expect(trigger).toHaveAttribute("title", "Search (⌘K / Ctrl+K)");
    expect(trigger).toHaveAttribute("aria-keyshortcuts", "Control+K Meta+K");
    expect(trigger).toHaveClass("size-11");
    trigger.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("does not render clear and close as the same glyph", async () => {
    // They sat side by side as identical X icons with different consequences:
    // one empties the field, the other loses your place. Only a screen reader
    // could tell them apart, so the close control names the key instead.
    const user = userEvent.setup();
    renderPalette();
    await user.type(screen.getByRole("combobox"), "ab");

    const clear = screen.getByRole("button", { name: "Clear search" });
    const close = screen.getByRole("button", { name: "Close search" });
    expect(close).toHaveTextContent("Esc");
    expect(clear.innerHTML).not.toEqual(close.innerHTML);
  });

  it("shows the real grouped order and more-results signal", async () => {
    vi.mocked(loadOperatorSearch).mockResolvedValue(model);
    renderPalette();
    const input = await screen.findByRole("combobox", {
      name: "Search jobs, leads, customers, or workspaces",
    });
    await userEvent.type(input, "iw");

    expect(await screen.findByRole("option", { name: /IW-1001/ })).toBeVisible();
    expect(screen.getByRole("group", { name: "Jobs" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Leads" })).toBeVisible();
    expect(
      screen.getByText("More results available. Keep typing to narrow the list."),
    ).toBeVisible();
    expect(
      screen
        .getByRole("group", { name: "Jobs" })
        .compareDocumentPosition(screen.getByRole("group", { name: "Leads" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("job_number", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /IW-1001/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls");
    expect(screen.getByRole("listbox")).toBeVisible();
    expect(loadOperatorSearch).toHaveBeenCalledWith(session, "iw", expect.any(AbortSignal));
  });

  it("does not reuse cached results when the permission scope changes", async () => {
    const jobsOnly = searchResult({
      permissions: ["jobs:read:any"],
      groups: model.groups.filter((group) => group.group === "jobs"),
    });
    vi.mocked(loadOperatorSearch).mockImplementation((activeSession) =>
      Promise.resolve(activeSession.permissions.includes("sales:read") ? model : jobsOnly),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function Harness() {
      const [activeSession, setActiveSession] = useState(session);
      return (
        <QueryClientProvider client={queryClient}>
          <SessionProvider session={activeSession}>
            <button
              type="button"
              onClick={() => setActiveSession({ ...session, permissions: ["jobs:read:any"] })}
            >
              Revoke sales access
            </button>
            <OperatorSearchPalette open onOpenChange={vi.fn()} />
          </SessionProvider>
        </QueryClientProvider>
      );
    }

    render(<Harness />);
    const input = await screen.findByRole("combobox", {
      name: "Search jobs, leads, customers, or workspaces",
    });
    await userEvent.type(input, "iw");
    await screen.findByRole("option", { name: /Maya Prospect/ });

    await userEvent.click(screen.getByRole("button", { name: "Revoke sales access" }));
    await waitFor(() => expect(loadOperatorSearch).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /Maya Prospect/ })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("group", { name: "Leads" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /IW-1001/ })).toBeVisible();
  });

  it("traverses the flattened grouped results and activates the server href", async () => {
    vi.mocked(loadOperatorSearch).mockResolvedValue(model);
    const onOpenChange = vi.fn();
    renderPalette(<OperatorSearchPalette open onOpenChange={onOpenChange} />);
    const input = await screen.findByRole("combobox", {
      name: "Search jobs, leads, customers, or workspaces",
    });
    await userEvent.type(input, "iw");
    await screen.findByRole("option", { name: /Maya Prospect/ });

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /IW-1002/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /Maya Prospect/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: /IW-1002/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/sales/leads/LEAD-A/triage" });
  });

  it("keeps the selected destination when delayed records arrive ahead of it", async () => {
    const user = userEvent.setup();
    let resolveSearch: ((value: OperatorSearchReadModel) => void) | undefined;
    vi.mocked(loadOperatorSearch).mockImplementation(
      () => new Promise((resolve) => (resolveSearch = resolve)),
    );
    renderPalette();
    const input = screen.getByRole("combobox");
    await user.type(input, "sa");
    await waitFor(() => expect(resolveSearch).toBeDefined());

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Safety" })).toHaveAttribute("aria-selected", "true");

    resolveSearch!(searchResult({ query: "sa" }));
    await screen.findByRole("option", { name: /IW-1001/ });
    const safety = screen.getByRole("option", { name: "Safety" });
    expect(safety).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", safety.id);

    await user.keyboard("{Enter}");
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/safety" });
  });

  it("supports pointer activation and Escape dismissal with focus return", async () => {
    vi.mocked(loadOperatorSearch).mockResolvedValue(model);
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open palette
          </button>
          <OperatorSearchPalette open={open} onOpenChange={setOpen} />
        </>
      );
    }
    renderPalette(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open palette" });
    await userEvent.click(trigger);
    const input = await screen.findByRole("combobox", {
      name: "Search jobs, leads, customers, or workspaces",
    });
    expect(input).toHaveFocus();
    await userEvent.type(input, "iw");
    const result = await screen.findByRole("option", { name: /IW-1001/ });
    await userEvent.click(result);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/jobs/JOB-A" });

    await userEvent.click(trigger);
    const reopenedInput = await screen.findByRole("combobox", {
      name: "Search jobs, leads, customers, or workspaces",
    });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(reopenedInput).not.toBeVisible();

    await userEvent.click(trigger);
    await screen.findByRole("combobox", {
      name: "Search jobs, leads, customers, or workspaces",
    });
    await userEvent.click(screen.getByRole("dialog"));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps short, empty, and role-safe states honest", async () => {
    vi.mocked(loadOperatorSearch).mockResolvedValue(
      searchResult({
        outcome: "no_matches",
        groups: model.groups.map((group) => ({ ...group, results: [], more_results: false })),
      }),
    );
    renderPalette();
    const input = await screen.findByRole("combobox", {
      name: "Search jobs, leads, customers, or workspaces",
    });
    await userEvent.type(input, "x");
    expect(screen.getByRole("status")).toHaveTextContent("Type at least 2 characters");
    expect(loadOperatorSearch).not.toHaveBeenCalled();
    await userEvent.type(input, "x");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No results for"));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-controls");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("reports loading, API failure with retry, and offline state without signing out", async () => {
    let resolveSearch: ((value: OperatorSearchReadModel) => void) | undefined;
    vi.mocked(loadOperatorSearch).mockImplementation(
      () => new Promise((resolve) => (resolveSearch = resolve)),
    );
    renderPalette();
    const input = await screen.findByRole("combobox", {
      name: "Search jobs, leads, customers, or workspaces",
    });
    await userEvent.type(input, "iw");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Searching"));
    await waitFor(() => expect(loadOperatorSearch).toHaveBeenCalledOnce());
    expect(resolveSearch).toBeDefined();
    resolveSearch!(model);
    await screen.findByRole("option", { name: /IW-1001/ });

    vi.mocked(loadOperatorSearch).mockRejectedValue(
      new ApiError({ status: 503, code: "upstream_unavailable", message: "Try again shortly." }),
    );
    await userEvent.clear(input);
    await userEvent.type(input, "zz");
    const alert = await screen.findByRole("alert");
    // A server fault, not a refusal: the person may try again.
    expect(alert).toHaveTextContent("Search is not answering right now. Try again in a moment.");
    // The server's own sentence is never shown (design/ZERO-LEARNING-GATE.md, Z2).
    expect(alert).not.toHaveTextContent("Try again shortly.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();

    mocks.online = false;
    await userEvent.clear(input);
    await userEvent.type(input, "zz");
    expect(screen.getByRole("status")).toHaveTextContent("No offline index is available");
  });

  it("cancels a stale in-flight query when the debounced text changes", async () => {
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: ((value: OperatorSearchReadModel) => void) | undefined;
    vi.mocked(loadOperatorSearch).mockImplementation((_session, query, signal) => {
      if (query === "ab") {
        firstSignal = signal;
        return new Promise((resolve) => (resolveFirst = resolve));
      }
      return Promise.resolve(searchResult({ query }));
    });
    renderPalette();
    const input = await screen.findByRole("combobox", {
      name: "Search jobs, leads, customers, or workspaces",
    });
    await userEvent.type(input, "ab");
    await waitFor(() => expect(firstSignal).toBeDefined());
    await userEvent.clear(input);
    await userEvent.type(input, "abc");
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    resolveFirst?.(model);
  });

  it("ignores the shortcut while typing in a text field", async () => {
    const onOpenChange = vi.fn();
    renderPalette(<OperatorSearchPalette open={false} onOpenChange={onOpenChange} />);
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(onOpenChange).not.toHaveBeenCalled();
    field.remove();
  });

  it("opens from the keyboard shortcut outside text entry", async () => {
    const onOpenChange = vi.fn();
    renderPalette(<OperatorSearchPalette open={false} onOpenChange={onOpenChange} />);
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
