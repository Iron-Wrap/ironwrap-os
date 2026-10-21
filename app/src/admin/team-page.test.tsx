import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import type { AppRole } from "../lib/roles";
import { LinkStub } from "./admin-link-stub";
import { renderWithSession, sessionFor } from "./admin-test-harness";
import { listAppUsers, provisionAppUser } from "./admin-api";
import type { AccessConflict } from "./admin-contracts";
import { TeamPage } from "./team-page";

vi.mock("./admin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./admin-api")>()),
  listAppUsers: vi.fn(),
  provisionAppUser: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ Link: LinkStub }));

interface Row {
  user_id?: string;
  email?: string;
  display_name: string;
  role?: AppRole;
  active?: boolean;
  access_version?: number;
  is_self?: boolean;
  crew_phone_unpaired?: boolean;
}

function people(...rows: Row[]) {
  return {
    version: 1 as const,
    users: rows.map((row, index) => ({
      user_id: row.user_id ?? `appu_${index}`,
      email: row.email ?? `${row.display_name.split(" ")[0]!.toLowerCase()}@freshco.example`,
      display_name: row.display_name,
      role: row.role ?? "sales",
      active: row.active ?? true,
      access_version: row.access_version ?? 1,
      updated_at: "2026-08-22T12:00:00.000Z",
      is_self: row.is_self ?? false,
      crew_phone_unpaired: row.crew_phone_unpaired ?? false,
    })),
  };
}

const ada: Row = { user_id: "appu_ada", display_name: "Ada Owner", role: "owner", is_self: true };
const grace = (row: Partial<Row> = {}): Row => ({
  user_id: "appu_grace",
  display_name: "Grace Obi",
  ...row,
});

function saved(role: AppRole, active: boolean, accessVersion: number) {
  return {
    user: {
      user_id: "appu_grace",
      email: "grace@freshco.example",
      display_name: "Grace Obi",
      role,
      active,
      access_version: accessVersion,
      crew_phone_unpaired: false,
    },
  };
}

function refused(conflict: Partial<AccessConflict> & Pick<AccessConflict, "change">) {
  return new ApiError({
    status: 409,
    code: "access_version_conflict",
    message: "access_version_conflict",
    details: {
      conflict: {
        user_id: "appu_grace",
        access_version: 2,
        changed_at: new Date(Date.now() - 5_000).toISOString(),
        changed_by: { user_id: "appu_ada", display_name: "Ada Owner", is_self_actor: true },
        ...conflict,
      },
    },
  });
}

const PRIMARY = new Set(["primary", "default", "accent"]);
/** Every primary button on the page; each state has exactly one. */
function primaryButtons(): string[] {
  return screen
    .getAllByRole("button")
    .filter((button) => PRIMARY.has(button.getAttribute("data-variant") ?? ""))
    .map((button) => button.textContent ?? "");
}

/** A paragraph read whole, the way a person reads it (a bold lead-in included). */
function paragraph(text: string) {
  return screen.getByText((_, element) => element?.tagName === "P" && element.textContent === text);
}

function panel() {
  return screen.getByRole("region", { name: "Grace Obi’s access" });
}

async function openGrace(user: ReturnType<typeof userEvent.setup>) {
  renderWithSession(<TeamPage />, sessionFor("owner"));
  await user.click(await screen.findByRole("button", { name: "See access for Grace Obi" }));
}

describe("TeamPage", () => {
  beforeEach(() => {
    // Reset, not clear: an answer queued for one case must never reach the next.
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds a teammate with a role, from the app, with no curl call in sight", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(people(ada) as never);
    vi.mocked(provisionAppUser).mockResolvedValue({
      user: {
        user_id: "appu_new",
        email: "sam@freshco.example",
        display_name: "Sam Sales",
        role: "sales" as const,
        active: true,
        access_version: 1,
        crew_phone_unpaired: false,
      },
    });
    const user = userEvent.setup();
    renderWithSession(<TeamPage />, sessionFor("owner"));

    await screen.findByRole("heading", { name: "People" });
    expect(
      screen.getByText("Choose what each person can do. Nobody can change their own access."),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Their name"), "Sam Sales");
    await user.type(screen.getByLabelText("Their work email"), "sam@freshco.example");
    await user.selectOptions(screen.getByLabelText("What they can see"), "production");
    await user.click(screen.getByRole("button", { name: "Add to the team" }));

    await waitFor(() => expect(provisionAppUser).toHaveBeenCalledOnce());
    expect(vi.mocked(provisionAppUser).mock.calls[0]![1]).toEqual({
      email: "sam@freshco.example",
      displayName: "Sam Sales",
      role: "production",
      active: true,
    });
    expect(await screen.findByText("Sam Sales can sign in now")).toBeInTheDocument();
  });

  it("will not let an owner change their own access", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(people(ada, grace()) as never);
    renderWithSession(<TeamPage />, sessionFor("owner"));

    // The viewer's own row has no controls, only the line.
    expect(await screen.findByText("Nobody can change their own access.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /access for Ada Owner/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Ada Owner’s access" })).toBeNull();
    // No row link starts with "Open"; everyone else's row says how to see their access.
    expect(screen.getByRole("button", { name: "See access for Grace Obi" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
  });

  it("1 · holds a role change until Save and saves it against the version it was decided on", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(people(ada, grace()) as never);
    vi.mocked(provisionAppUser).mockResolvedValue(saved("production", true, 2));
    const user = userEvent.setup();
    await openGrace(user);

    expect(within(panel()).getByRole("group", { name: "What Grace can do" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Sales/ })).toBeChecked();
    expect(primaryButtons()).toEqual([]);
    await user.click(screen.getByRole("radio", { name: /^Production/ }));

    expect(provisionAppUser).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /^Production/ })).toBeChecked();
    expect(within(panel()).getByText("Not saved")).toBeInTheDocument();
    expect(
      paragraph("Your change is not saved yet: Grace’s role changes from Sales to Production."),
    ).toBeInTheDocument();
    expect(primaryButtons()).toEqual(["Save Grace’s access"]);
    expect(screen.getByRole("button", { name: "Remove Grace from the team" })).toHaveAttribute(
      "data-variant",
      "secondary",
    );
    // Pending Track B's re-gate (build 9): what removing does, under the buttons.
    expect(
      paragraph(
        "Remove Grace from the team: signs them out everywhere and unpairs any crew phone they use. Giving them access back undoes it; a crew phone must then be paired again.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save Grace’s access" }));
    await waitFor(() => expect(provisionAppUser).toHaveBeenCalledOnce());
    expect(vi.mocked(provisionAppUser).mock.calls[0]![1]).toEqual({
      email: "grace@freshco.example",
      displayName: "Grace Obi",
      role: "production",
      active: true,
      expectedAccessVersion: 1,
    });
    await waitFor(() => expect(within(panel()).queryByText("Not saved")).toBeNull());
    expect(screen.getByRole("radio", { name: /^Production/ })).toBeChecked();
  });

  it("keeps a held change when the access is hidden and shown, and drops it with the page", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(people(ada, grace()) as never);
    const user = userEvent.setup();
    const page = renderWithSession(<TeamPage />, sessionFor("owner"));
    await user.click(await screen.findByRole("button", { name: "See access for Grace Obi" }));
    await user.click(screen.getByRole("radio", { name: /^Production/ }));

    await user.click(screen.getByRole("button", { name: "Hide access for Grace Obi" }));
    expect(screen.queryByRole("region", { name: "Grace Obi’s access" })).toBeNull();
    // The collapsed row says a change is waiting, beside the name.
    expect(screen.getByText("Not saved").closest("p")).toHaveTextContent("Grace Obi");
    await user.click(screen.getByRole("button", { name: "See access for Grace Obi" }));
    expect(screen.getByRole("radio", { name: /^Production/ })).toBeChecked();
    expect(within(panel()).getByText("Not saved")).toBeInTheDocument();

    // Choosing the saved role again is no change at all.
    await user.click(screen.getByRole("radio", { name: /^Sales/ }));
    expect(within(panel()).queryByText("Not saved")).toBeNull();
    await user.click(screen.getByRole("radio", { name: /^Production/ }));

    // Leaving the page and coming back.
    page.unmount();
    renderWithSession(<TeamPage />, sessionFor("owner"));
    await user.click(await screen.findByRole("button", { name: "See access for Grace Obi" }));
    expect(screen.getByRole("radio", { name: /^Sales/ })).toBeChecked();
    expect(screen.queryByText("Not saved")).toBeNull();
    expect(provisionAppUser).not.toHaveBeenCalled();
  });

  it("2 and 3 · a refused save says what changed elsewhere; the reload keeps the change unsaved", async () => {
    vi.mocked(listAppUsers)
      .mockResolvedValueOnce(people(ada, grace()) as never)
      .mockResolvedValueOnce(people(ada, grace({ role: "ops", access_version: 2 })) as never);
    vi.mocked(provisionAppUser)
      .mockRejectedValueOnce(
        refused({
          change: { before: { role: "sales", active: true }, after: { role: "ops", active: true } },
        }),
      )
      .mockResolvedValueOnce(saved("production", true, 3));
    const user = userEvent.setup();
    await openGrace(user);
    await user.click(screen.getByRole("radio", { name: /^Production/ }));
    await user.click(screen.getByRole("button", { name: "Save Grace’s access" }));

    // 2 · Conflict.
    expect(
      await screen.findByText(
        "You changed Grace Obi’s access somewhere else a moment ago: their role is now Operations, not Sales.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Production/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /^Production/ })).toBeChecked();
    for (const other of [/^Owner/, /^Operations/, /^Sales/, /^Accounting/, /^Crew/]) {
      expect(screen.getByRole("radio", { name: other })).toBeDisabled();
    }
    // The role this page showed may have changed since.
    expect(screen.getByRole("radio", { name: /^Sales · may be out of date/ })).toBeDisabled();
    expect(within(panel()).getByText("Not saved")).toBeInTheDocument();
    expect(
      screen.getByText("Values marked “may be out of date” update when their access reloads."),
    ).toBeInTheDocument();
    expect(primaryButtons()).toEqual(["Reload Grace’s access"]);
    expect(
      paragraph(
        "Reload Grace’s access: shows their access as it is now and keeps your change until you save it or leave this page. It does not undo anything.",
      ),
    ).toBeInTheDocument();
    // The reload is the only action: nothing saves or removes over the access shown.
    expect(within(panel()).queryByRole("button", { name: /Save|Remove/ })).toBeNull();
    // Save is gone, so the next action holds the focus rather than the top of the page.
    expect(screen.getByRole("button", { name: "Reload Grace’s access" })).toHaveFocus();
    // The conflict line describes the action that answers it.
    expect(
      screen.getByRole("button", { name: "Reload Grace’s access" }),
    ).toHaveAccessibleDescription(
      "You changed Grace Obi’s access somewhere else a moment ago: their role is now Operations, not Sales.",
    );

    // 3 · After reload.
    await user.click(screen.getByRole("button", { name: "Reload Grace’s access" }));
    expect(
      await screen.findByRole("radio", {
        name: /^Operations · changed somewhere else a moment ago/,
      }),
    ).not.toBeChecked();
    // Only a refusal moves the focus; the reload leaves it where it was.
    expect(screen.getByRole("button", { name: "Save Grace’s access" })).not.toHaveFocus();
    expect(screen.getByRole("radio", { name: /^Production/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^Sales/ })).toBeEnabled();
    expect(within(panel()).getByText("Not saved")).toBeInTheDocument();
    expect(
      paragraph(
        "Your change is not saved yet: Grace’s role changes from Operations to Production.",
      ),
    ).toBeInTheDocument();
    expect(primaryButtons()).toEqual(["Save Grace’s access"]);
    expect(provisionAppUser).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Save Grace’s access" }));
    await waitFor(() => expect(provisionAppUser).toHaveBeenCalledTimes(2));
    expect(vi.mocked(provisionAppUser).mock.calls[1]![1]).toMatchObject({
      role: "production",
      active: true,
      expectedAccessVersion: 2,
    });
  });

  it("names another administrator who changed the access, in the line and after the reload", async () => {
    vi.mocked(listAppUsers)
      .mockResolvedValueOnce(people(ada, grace()) as never)
      .mockResolvedValueOnce(people(ada, grace({ role: "ops", access_version: 2 })) as never);
    vi.mocked(provisionAppUser).mockRejectedValueOnce(
      refused({
        changed_by: { user_id: "appu_priya", display_name: "Priya Nand", is_self_actor: false },
        changed_at: new Date(Date.now() - 5 * 60_000 - 10_000).toISOString(),
        change: { before: { role: "sales", active: true }, after: { role: "ops", active: true } },
      }),
    );
    const user = userEvent.setup();
    await openGrace(user);
    await user.click(screen.getByRole("radio", { name: /^Production/ }));
    await user.click(screen.getByRole("button", { name: "Save Grace’s access" }));

    expect(
      await screen.findByText(
        "Priya Nand changed Grace Obi’s access 5 min ago: their role is now Operations, not Sales.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload Grace’s access" }));
    expect(
      await screen.findByRole("radio", { name: /^Operations · changed by Priya Nand 5 min ago/ }),
    ).toBeInTheDocument();
  });

  it("4 · a refused remove waits for the reload, then removes against the reloaded version", async () => {
    vi.mocked(listAppUsers)
      .mockResolvedValueOnce(people(ada, grace()) as never)
      .mockResolvedValueOnce(people(ada, grace({ role: "ops", access_version: 2 })) as never);
    vi.mocked(provisionAppUser)
      .mockRejectedValueOnce(
        refused({
          change: { before: { role: "sales", active: true }, after: { role: "ops", active: true } },
        }),
      )
      .mockResolvedValueOnce(saved("ops", false, 3));
    const user = userEvent.setup();
    await openGrace(user);
    await user.click(screen.getByRole("button", { name: "Remove Grace from the team" }));
    await waitFor(() => expect(provisionAppUser).toHaveBeenCalledOnce());
    expect(vi.mocked(provisionAppUser).mock.calls[0]![1]).toMatchObject({
      role: "sales",
      active: false,
      expectedAccessVersion: 1,
    });

    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent === "Your change: remove Grace from the team. Not saved.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "You changed Grace Obi’s access somewhere else a moment ago: their role is now Operations, not Sales.",
      ),
    ).toBeInTheDocument();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    // Frame 4 carries the note too, and the role this page showed is marked.
    expect(
      screen.getByText("Values marked “may be out of date” update when their access reloads."),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Sales · may be out of date/ })).toBeChecked();
    expect(primaryButtons()).toEqual(["Reload Grace’s access"]);
    const later = screen.getByRole("button", { name: "Remove Grace from the team · after reload" });
    expect(later).toBeDisabled();
    expect(later).toHaveAttribute("data-variant", "secondary");
    expect(
      paragraph(
        "Reload Grace’s access: shows their access as it is now and keeps your change until you remove them or leave this page. It does not undo anything.",
      ),
    ).toBeInTheDocument();
    const removing = screen.getByText(
      "Removing them signs them out everywhere and unpairs any crew phone they use.",
    );
    expect(
      paragraph(
        "Reload Grace’s access: shows their access as it is now and keeps your change until you remove them or leave this page. It does not undo anything.",
      ).compareDocumentPosition(removing) & Node.DOCUMENT_POSITION_FOLLOWING,
      "after the reload's line",
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Reload Grace’s access" }));
    const remove = await screen.findByRole("button", { name: "Remove Grace from the team" });
    expect(remove).toBeEnabled();
    expect(primaryButtons()).toEqual(["Remove Grace from the team"]);
    expect(paragraph("Your change: remove Grace from the team. Not saved.")).toBeInTheDocument();
    expect(
      paragraph(
        "Remove Grace from the team: signs them out everywhere and unpairs any crew phone they use. Giving them access back undoes it; a crew phone must then be paired again.",
      ),
    ).toBeInTheDocument();
    await user.click(remove);
    await waitFor(() => expect(provisionAppUser).toHaveBeenCalledTimes(2));
    expect(vi.mocked(provisionAppUser).mock.calls[1]![1]).toMatchObject({
      role: "ops",
      active: false,
      expectedAccessVersion: 2,
    });
  });

  it("5 · a change that cannot apply gives access back first, then saves on the restored version", async () => {
    vi.mocked(listAppUsers)
      .mockResolvedValueOnce(people(ada, grace()) as never)
      .mockResolvedValueOnce(
        people(
          ada,
          grace({ active: false, access_version: 2, crew_phone_unpaired: true }),
        ) as never,
      );
    vi.mocked(provisionAppUser)
      .mockRejectedValueOnce(
        refused({
          change: {
            before: { role: "sales", active: true },
            after: { role: "sales", active: false },
          },
        }),
      )
      .mockResolvedValueOnce(saved("sales", true, 3))
      .mockResolvedValueOnce(saved("production", true, 4));
    const user = userEvent.setup();
    await openGrace(user);
    await user.click(screen.getByRole("radio", { name: /^Production/ }));
    await user.click(screen.getByRole("button", { name: "Save Grace’s access" }));
    expect(
      await screen.findByText(
        "You changed Grace Obi’s access somewhere else a moment ago: they no longer have access.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload Grace’s access" }));

    expect(
      await screen.findByText(
        "Your change cannot apply: you removed Grace Obi from the team somewhere else a moment ago.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("No access")).toBeInTheDocument();
    expect(
      paragraph("Your change: Grace’s role changes from Sales to Production. Not saved."),
    ).toBeInTheDocument();
    expect(within(panel()).queryByRole("radio")).toBeNull();
    expect(primaryButtons()).toEqual(["Give Grace access back"]);
    expect(
      screen.getByRole("button", { name: "Give Grace access back" }),
    ).toHaveAccessibleDescription(
      "Your change cannot apply: you removed Grace Obi from the team somewhere else a moment ago.",
    );
    const later = screen.getByRole("button", {
      name: "Save Grace’s access · after their access is back",
    });
    expect(later).toBeDisabled();
    expect(later).toHaveAttribute("data-variant", "secondary");
    // The removal unpaired a crew phone, but Save leaves her off Crew, so the line asks for none.
    expect(
      paragraph(
        "Give Grace access back: it returns the access they had (Sales) right away. Then save to add your change: their role moves from Sales to Production. You don’t need to wait for them to sign in.",
      ),
    ).toBeInTheDocument();

    // The restore names the version the removal left and gives back the role she had, not the
    // waiting change; that one still needs Save, on the version the restore produced.
    await user.click(screen.getByRole("button", { name: "Give Grace access back" }));
    await waitFor(() => expect(provisionAppUser).toHaveBeenCalledTimes(2));
    expect(vi.mocked(provisionAppUser).mock.calls[1]![1]).toMatchObject({
      role: "sales",
      active: true,
      expectedAccessVersion: 2,
    });
    const save = await screen.findByRole("button", { name: "Save Grace’s access" });
    expect(primaryButtons()).toEqual(["Save Grace’s access"]);
    expect(
      paragraph("Your change is not saved yet: Grace’s role changes from Sales to Production."),
    ).toBeInTheDocument();
    await user.click(save);
    await waitFor(() => expect(provisionAppUser).toHaveBeenCalledTimes(3));
    expect(vi.mocked(provisionAppUser).mock.calls[2]![1]).toMatchObject({
      role: "production",
      active: true,
      expectedAccessVersion: 3,
    });
  });

  it("5 · when Save makes them Crew, the give-back line asks for the crew phone a removal unpaired", async () => {
    // An earlier removal unpaired Grace's crew phone and none has been paired since.
    const before = { role: "production", crew_phone_unpaired: true } as const;
    vi.mocked(listAppUsers)
      .mockResolvedValueOnce(people(ada, grace(before)) as never)
      .mockResolvedValueOnce(
        people(ada, grace({ ...before, active: false, access_version: 2 })) as never,
      );
    vi.mocked(provisionAppUser).mockRejectedValueOnce(
      refused({
        change: {
          before: { role: "production", active: true },
          after: { role: "production", active: false },
        },
      }),
    );
    const user = userEvent.setup();
    await openGrace(user);
    await user.click(screen.getByRole("radio", { name: /^Crew/ }));
    await user.click(screen.getByRole("button", { name: "Save Grace’s access" }));
    await user.click(await screen.findByRole("button", { name: "Reload Grace’s access" }));

    expect(await screen.findByRole("button", { name: "Give Grace access back" })).toBeEnabled();
    expect(
      paragraph(
        "Give Grace access back: it returns the access they had (Production) right away. Then save to add your change: their role moves from Production to Crew; a crew phone must then be paired again in Settings › Crew devices. You don’t need to wait for them to sign in.",
      ),
    ).toBeInTheDocument();
  });

  it("a give-back refused because they have access again says so, and the held role change waits for Save", async () => {
    vi.mocked(listAppUsers)
      .mockResolvedValueOnce(people(ada, grace()) as never)
      .mockResolvedValueOnce(people(ada, grace({ active: false, access_version: 2 })) as never)
      .mockResolvedValueOnce(people(ada, grace({ access_version: 3 })) as never);
    vi.mocked(provisionAppUser)
      .mockRejectedValueOnce(
        refused({
          change: {
            before: { role: "sales", active: true },
            after: { role: "sales", active: false },
          },
        }),
      )
      // Meanwhile Grace accepted an invitation: her access is back, at version 3.
      .mockRejectedValueOnce(
        refused({
          access_version: 3,
          change: {
            before: { role: "sales", active: false },
            after: { role: "sales", active: true },
          },
        }),
      )
      .mockResolvedValueOnce(saved("production", true, 4));
    const user = userEvent.setup();
    await openGrace(user);
    await user.click(screen.getByRole("radio", { name: /^Production/ }));
    await user.click(screen.getByRole("button", { name: "Save Grace’s access" }));
    await user.click(await screen.findByRole("button", { name: "Reload Grace’s access" }));
    await user.click(await screen.findByRole("button", { name: "Give Grace access back" }));

    expect(
      await screen.findByText(
        "You changed Grace Obi’s access somewhere else a moment ago: they have access again.",
      ),
    ).toBeInTheDocument();
    expect(
      paragraph("Your change: Grace’s role changes from Sales to Production. Not saved."),
    ).toBeInTheDocument();
    expect(primaryButtons()).toEqual(["Reload Grace’s access"]);
    expect(vi.mocked(provisionAppUser).mock.calls[1]![1]).toMatchObject({
      role: "sales",
      active: true,
      expectedAccessVersion: 2,
    });

    await user.click(screen.getByRole("button", { name: "Reload Grace’s access" }));
    expect(
      await screen.findByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent ===
            "Your change is not saved yet: Grace’s role changes from Sales to Production.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Grace’s access" }));
    await waitFor(() => expect(provisionAppUser).toHaveBeenCalledTimes(3));
    expect(vi.mocked(provisionAppUser).mock.calls[2]![1]).toMatchObject({
      role: "production",
      active: true,
      expectedAccessVersion: 3,
    });
  });

  it("a give-back with nothing held reloads in place and marks what changed, without a conflict line", async () => {
    vi.mocked(listAppUsers)
      .mockResolvedValueOnce(people(ada, grace({ active: false })) as never)
      .mockResolvedValueOnce(people(ada, grace({ access_version: 2 })) as never);
    vi.mocked(provisionAppUser).mockRejectedValueOnce(
      refused({
        change: {
          before: { role: "sales", active: false },
          after: { role: "sales", active: true },
        },
      }),
    );
    const user = userEvent.setup();
    await openGrace(user);
    await user.click(screen.getByRole("button", { name: "Give Grace access back" }));

    await waitFor(() => expect(listAppUsers).toHaveBeenCalledTimes(2));
    // The changed value is Grace's access: the label sits beside her chip, which now says Active.
    const label = await screen.findByText("Changed somewhere else a moment ago");
    expect(label.parentElement).toHaveTextContent("Active");
    expect(screen.queryByText("No access")).toBeNull();
    expect(screen.queryByText(/changed Grace Obi’s access/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reload/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /^Sales/ })).toBeChecked();
  });

  it("6a · a reload that fails keeps the change and offers the reload again", async () => {
    vi.mocked(listAppUsers)
      .mockResolvedValueOnce(people(ada, grace()) as never)
      .mockRejectedValueOnce(
        new ApiError({ status: 503, code: "http_503", message: "Service Unavailable" }),
      )
      .mockResolvedValueOnce(people(ada, grace({ role: "ops", access_version: 2 })) as never);
    vi.mocked(provisionAppUser).mockRejectedValueOnce(
      refused({
        change: { before: { role: "sales", active: true }, after: { role: "ops", active: true } },
      }),
    );
    const user = userEvent.setup();
    await openGrace(user);
    await user.click(screen.getByRole("radio", { name: /^Production/ }));
    await user.click(screen.getByRole("button", { name: "Save Grace’s access" }));
    await user.click(await screen.findByRole("button", { name: "Reload Grace’s access" }));

    expect(
      await screen.findByText(
        "Grace’s access did not reload; your change is kept until you save it or leave this page.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Values marked “may be out of date” update when their access reloads."),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Production/ })).toBeChecked();
    expect(within(panel()).getByText("Not saved")).toBeInTheDocument();
    expect(primaryButtons()).toEqual(["Reload Grace’s access again"]);
    const later = screen.getByRole("button", { name: "Save Grace’s access · after reload" });
    expect(later).toBeDisabled();
    expect(later).toHaveAttribute("data-variant", "secondary");
    expect(
      paragraph(
        "Reload Grace’s access again: shows their access as it is now and keeps your change until you save it or leave this page. It does not undo anything.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload Grace’s access again" }));
    expect(await screen.findByRole("button", { name: "Save Grace’s access" })).toBeEnabled();
    expect(
      screen.getByRole("radio", { name: /^Operations · changed somewhere else a moment ago/ }),
    ).toBeInTheDocument();
  });

  it("6b · offline, the reload says so and how to finish once back online", async () => {
    vi.mocked(listAppUsers)
      .mockResolvedValueOnce(people(ada, grace()) as never)
      .mockRejectedValueOnce(
        new ApiError({ status: 0, code: "network_error", message: "No connection" }),
      );
    vi.mocked(provisionAppUser).mockRejectedValueOnce(
      refused({
        change: { before: { role: "sales", active: true }, after: { role: "ops", active: true } },
      }),
    );
    const user = userEvent.setup();
    await openGrace(user);
    await user.click(screen.getByRole("radio", { name: /^Production/ }));
    await user.click(screen.getByRole("button", { name: "Save Grace’s access" }));
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await user.click(await screen.findByRole("button", { name: "Reload Grace’s access" }));

    expect(
      await screen.findByText(
        "You are offline, so Grace’s access cannot reload; your change is kept until you save it or leave this page. When you’re back online, reload their access.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Production/ })).toBeChecked();
    expect(primaryButtons()).toEqual(["Reload Grace’s access again"]);
    expect(
      screen.getByRole("button", { name: "Save Grace’s access · after reload" }),
    ).toBeDisabled();
  });

  it("offers access back to someone who was removed, with the role they had", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(people(ada, grace({ active: false })) as never);
    vi.mocked(provisionAppUser).mockResolvedValue(saved("sales", true, 2));
    const user = userEvent.setup();
    await openGrace(user);

    expect(screen.getByText("No access")).toBeInTheDocument();
    expect(primaryButtons()).toEqual(["Give Grace access back"]);
    expect(
      paragraph("Give Grace access back: it returns the access they had (Sales) right away."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Give Grace access back" }));
    await waitFor(() => expect(provisionAppUser).toHaveBeenCalledOnce());
    expect(vi.mocked(provisionAppUser).mock.calls[0]![1]).toMatchObject({
      role: "sales",
      active: true,
      expectedAccessVersion: 1,
    });
    await waitFor(() => expect(screen.queryByText("No access")).toBeNull());
    expect(screen.getAllByText("Active")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /^Sales/ })).toBeChecked();
  });

  it.each([
    [
      "field",
      "Give Grace access back: it returns the access they had (Crew) right away; a crew phone must be paired again in Settings › Crew devices.",
    ],
    ["sales", "Give Grace access back: it returns the access they had (Sales) right away."],
  ] as const)(
    "asks for the crew phone a removal unpaired only when giving access back restores Crew (%s)",
    async (role, line) => {
      vi.mocked(listAppUsers).mockResolvedValue(
        people(ada, grace({ role, active: false, crew_phone_unpaired: true })) as never,
      );
      const user = userEvent.setup();
      await openGrace(user);

      expect(primaryButtons()).toEqual(["Give Grace access back"]);
      expect(paragraph(line)).toBeInTheDocument();
    },
  );

  it("explains a refusal that is not a conflict and keeps the change", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(people(ada, grace()) as never);
    vi.mocked(provisionAppUser).mockRejectedValue(
      new ApiError({ status: 403, code: "office_role_required", message: "office_role_required" }),
    );
    const user = userEvent.setup();
    await openGrace(user);
    await user.click(screen.getByRole("radio", { name: /^Production/ }));
    await user.click(screen.getByRole("button", { name: "Save Grace’s access" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only an owner or operations account can change this.",
    );
    expect(screen.getByRole("radio", { name: /^Production/ })).toBeChecked();
    expect(within(panel()).getByText("Not saved")).toBeInTheDocument();
  });

  it("leaves the focus alone while a role is chosen on a browser that does not focus on click", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(people(ada, grace()) as never);
    const user = userEvent.setup();
    await openGrace(user);
    (document.activeElement as HTMLElement | null)?.blur();

    // Safari and iOS leave the focus on the page when a radio is pressed.
    fireEvent.click(screen.getByRole("radio", { name: /^Production/ }));
    expect(await screen.findByRole("button", { name: "Save Grace’s access" })).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it.each([
    ["an address already on the team", 400, "expected_access_version_required"],
    ["two people adding the same address at once", 409, "access_version_conflict"],
  ])(
    "says when %s is added again, keeps the address, and offers no retry",
    async (_, status, code) => {
      vi.mocked(listAppUsers).mockResolvedValue(people(ada, grace()) as never);
      vi.mocked(provisionAppUser).mockRejectedValue(new ApiError({ status, code, message: code }));
      const user = userEvent.setup();
      renderWithSession(<TeamPage />, sessionFor("owner"));

      await screen.findByRole("heading", { name: "People" });
      await user.type(screen.getByLabelText("Their name"), "Grace Obi");
      await user.type(screen.getByLabelText("Their work email"), "grace@freshco.example");
      await user.click(screen.getByRole("button", { name: "Add to the team" }));

      const line = await screen.findByText(
        "grace@freshco.example is already on your team, so nothing was added.",
      );
      expect(
        screen.getByText("To change their access, use “See access” on their row."),
      ).toBeInTheDocument();
      // Information, never an error, and no retry: the typed address stays to be corrected.
      expect(line.closest("section")).toHaveAttribute("role", "status");
      expect(screen.queryByText("That person was not added")).toBeNull();
      expect(screen.queryByRole("button", { name: /try again|retry/i })).toBeNull();
      expect(screen.getByLabelText("Their work email")).toHaveValue("grace@freshco.example");
      // The list is read again, so the row it points to is there.
      await waitFor(() => expect(listAppUsers).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("button", { name: "See access for Grace Obi" })).toBeInTheDocument();
    },
  );

  it("explains a rejected addition instead of showing the server's code", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(people(ada) as never);
    vi.mocked(provisionAppUser).mockRejectedValue(
      new ApiError({ status: 400, code: "invalid_email", message: "invalid_email" }),
    );
    const user = userEvent.setup();
    renderWithSession(<TeamPage />, sessionFor("owner"));

    await screen.findByRole("heading", { name: "People" });
    await user.type(screen.getByLabelText("Their name"), "Sam Sales");
    await user.type(screen.getByLabelText("Their work email"), "sam@nope");
    await user.click(screen.getByRole("button", { name: "Add to the team" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
  });

  it("is closed to a role that cannot manage access", async () => {
    renderWithSession(<TeamPage />, sessionFor("sales"));
    expect(
      await screen.findByRole("heading", { name: "This work belongs to another role" }),
    ).toBeInTheDocument();
    expect(listAppUsers).not.toHaveBeenCalled();
  });
});
