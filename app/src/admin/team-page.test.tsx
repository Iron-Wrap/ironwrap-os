import { screen, waitFor, within } from "@testing-library/react";
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
        changed_at: "2026-10-20T09:00:00.000Z",
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
    await user.click(screen.getByRole("button", { name: "Add to the company" }));

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
    const user = userEvent.setup();
    renderWithSession(<TeamPage />, sessionFor("owner"));

    await user.click(await screen.findByRole("button", { name: "See access for Ada Owner" }));
    const own = screen.getByRole("region", { name: "Ada Owner’s access" });
    expect(within(own).getByText("Nobody can change their own access.")).toBeInTheDocument();
    expect(within(own).queryByRole("radio")).toBeNull();
    expect(within(own).queryByRole("button")).toBeNull();
    // No row link starts with "Open"; the open row says how to close it.
    expect(screen.getByRole("button", { name: "Hide access for Ada Owner" })).toHaveAttribute(
      "aria-expanded",
      "true",
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
    expect(screen.getByText("Not saved")).toBeInTheDocument();
    // Opening someone else's access hides Grace's; her change still waits.
    await user.click(screen.getByRole("button", { name: "See access for Ada Owner" }));
    await user.click(screen.getByRole("button", { name: "See access for Grace Obi" }));
    expect(screen.queryByRole("region", { name: "Ada Owner’s access" })).toBeNull();
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
    expect(within(panel()).getByText("Not saved")).toBeInTheDocument();
    expect(
      screen.getByText("The greyed roles wait until their access reloads."),
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

    // 3 · After reload.
    await user.click(screen.getByRole("button", { name: "Reload Grace’s access" }));
    expect(await screen.findByText("Chosen somewhere else a moment ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Grace’s access" })).toHaveFocus();
    expect(
      within(screen.getByText("Chosen somewhere else a moment ago").closest("label")!).getByRole(
        "radio",
      ),
    ).toHaveAccessibleName(/^Operations/);
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
        change: { before: { role: "sales", active: true }, after: { role: "ops", active: true } },
      }),
    );
    const user = userEvent.setup();
    await openGrace(user);
    await user.click(screen.getByRole("radio", { name: /^Production/ }));
    await user.click(screen.getByRole("button", { name: "Save Grace’s access" }));

    expect(
      await screen.findByText(
        "Priya Nand changed Grace Obi’s access a moment ago: their role is now Operations, not Sales.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload Grace’s access" }));
    expect(await screen.findByText("Chosen by Priya Nand a moment ago")).toBeInTheDocument();
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

    expect(await screen.findByText("Your change: remove Grace from the team.")).toBeInTheDocument();
    expect(within(panel()).getByText("Not saved")).toBeInTheDocument();
    expect(
      screen.getByText(
        "You changed Grace Obi’s access somewhere else a moment ago: their role is now Operations, not Sales.",
      ),
    ).toBeInTheDocument();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.queryByText("The greyed roles wait until their access reloads.")).toBeNull();
    expect(primaryButtons()).toEqual(["Reload Grace’s access"]);
    const later = screen.getByRole("button", { name: "Remove Grace from the team · after reload" });
    expect(later).toBeDisabled();
    expect(later).toHaveAttribute("data-variant", "secondary");
    expect(
      paragraph(
        "Reload Grace’s access: shows their access as it is now and keeps your change until you remove them or leave this page. It does not undo anything.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload Grace’s access" }));
    const remove = await screen.findByRole("button", { name: "Remove Grace from the team" });
    expect(remove).toBeEnabled();
    expect(primaryButtons()).toEqual(["Remove Grace from the team"]);
    expect(screen.getByText("Your change: remove Grace from the team.")).toBeInTheDocument();
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
      .mockResolvedValueOnce(people(ada, grace({ active: false, access_version: 2 })) as never);
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
      screen.getByText("Your change: Grace’s role changes from Sales to Production."),
    ).toBeInTheDocument();
    expect(within(panel()).getByText("Not saved")).toBeInTheDocument();
    expect(within(panel()).queryByRole("radio")).toBeNull();
    expect(primaryButtons()).toEqual(["Give Grace access back"]);
    const later = screen.getByRole("button", { name: "Save Grace’s access · after they’re back" });
    expect(later).toBeDisabled();
    expect(later).toHaveAttribute("data-variant", "secondary");
    expect(
      paragraph(
        "Give Grace access back: they can sign in again with the access they had (Sales). Then save to add your change: their role changes from Sales to Production.",
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
      screen.getByText("The greyed roles wait until their access reloads."),
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
    expect(screen.getByText("Chosen somewhere else a moment ago")).toBeInTheDocument();
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
      paragraph("Give Grace access back: they can sign in again with the access they had (Sales)."),
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
    await user.click(screen.getByRole("button", { name: "Add to the company" }));

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
