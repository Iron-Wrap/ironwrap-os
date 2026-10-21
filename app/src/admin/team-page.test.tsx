import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import { LinkStub } from "./admin-link-stub";
import { renderWithSession, sessionFor } from "./admin-test-harness";
import { listAppUsers, provisionAppUser } from "./admin-api";
import { TeamPage } from "./team-page";

vi.mock("./admin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./admin-api")>()),
  listAppUsers: vi.fn(),
  provisionAppUser: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ Link: LinkStub }));

function users(
  ...rows: Array<Partial<{ email: string; role: string; active: boolean; is_self: boolean }>>
) {
  return {
    version: 1 as const,
    users: rows.map((row, index) => ({
      user_id: `appu_${index}`,
      email: row.email ?? `person${index}@freshco.example`,
      display_name: row.email?.split("@")[0] ?? `Person ${index}`,
      role: row.role ?? "sales",
      active: row.active ?? true,
      updated_at: "2026-08-22T12:00:00.000Z",
      is_self: row.is_self ?? false,
    })),
  };
}

describe("TeamPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a teammate with a role, from the app, with no curl call in sight", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(
      users({ email: "ada@freshco.example", role: "owner", is_self: true }) as never,
    );
    vi.mocked(provisionAppUser).mockResolvedValue({
      user: {
        user_id: "appu_new",
        email: "sam@freshco.example",
        display_name: "Sam Sales",
        role: "sales" as const,
        active: true,
      },
    });
    const user = userEvent.setup();
    renderWithSession(<TeamPage />, sessionFor("owner"));

    await screen.findByRole("heading", { name: "People" });
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

  it("will not let an owner take away their own access", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(
      users(
        { email: "ada@freshco.example", role: "owner", is_self: true },
        { email: "sam@freshco.example", role: "sales" },
      ) as never,
    );
    renderWithSession(<TeamPage />, sessionFor("owner"));

    await screen.findByRole("heading", { name: "Who has access" });
    expect(screen.getByText("You")).toBeInTheDocument();
    // One row can be removed — the other one, their own, cannot.
    expect(screen.getAllByRole("button", { name: "Remove access" })).toHaveLength(1);
    expect(screen.getByLabelText("Role for ada")).toBeDisabled();
  });

  it("asks before removing access and only then sends it", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(
      users({ email: "sam@freshco.example", role: "sales" }) as never,
    );
    vi.mocked(provisionAppUser).mockResolvedValue({
      user: {
        user_id: "appu_0",
        email: "sam@freshco.example",
        display_name: "sam",
        role: "sales" as const,
        active: false,
      },
    });
    const user = userEvent.setup();
    renderWithSession(<TeamPage />, sessionFor("owner"));

    await screen.findByRole("heading", { name: "Who has access" });
    await user.click(screen.getByRole("button", { name: "Remove access" }));
    expect(provisionAppUser).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(provisionAppUser).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Remove access" }));
    await user.click(screen.getByRole("button", { name: "Remove access" }));
    await waitFor(() => expect(provisionAppUser).toHaveBeenCalledOnce());
    expect(vi.mocked(provisionAppUser).mock.calls[0]![1]!.active).toBe(false);
  });

  it("offers access back to someone who was removed", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(
      users({ email: "sam@freshco.example", role: "sales", active: false }) as never,
    );
    renderWithSession(<TeamPage />, sessionFor("owner"));

    await screen.findByRole("heading", { name: "Who has access" });
    expect(screen.getByText("No access")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Give access back" })).toBeInTheDocument();
  });

  it("explains a rejected addition instead of showing the server's code", async () => {
    vi.mocked(listAppUsers).mockResolvedValue(users() as never);
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
