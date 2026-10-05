import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { CrewShell } from "./crew-shell";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Outlet: () => <p>Assigned field work</p>,
  useRouterState: () => "/today",
}));
vi.mock("./shell-hooks", () => ({
  useCompanyLogoUrl: () => null,
  useSearchPalette: () => ({ loaded: false, open: false, setOpen: vi.fn(), openSearch: vi.fn() }),
}));
vi.mock("./shell-controls", () => ({
  PersonMenu: ({ trigger, triggerClassName }: { trigger: ReactNode; triggerClassName: string }) => (
    <button className={triggerClassName}>{trigger}</button>
  ),
  SearchPalette: () => null,
}));
vi.mock("./system-status", () => ({ SystemStatus: () => <p className="crew-status">All sent</p> }));

const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "crew-synthetic",
    email: "crew@example.invalid",
    display_name: "Sam Kennedy Long Example Name",
    role: "field",
    frappe_user_id: null,
  },
  tenant: {
    id: "ironwrap",
    name: "Iron Wrap Exteriors",
    brand: "Iron Wrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:assigned"],
  allowed_actions: ["field.checkin.create"],
  csrf_token: "csrf-synthetic",
  session_expires_at: "2026-10-03T12:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-10-02T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

describe("CrewShell", () => {
  beforeEach(() => window.localStorage.clear());

  it("retains the chosen Sun environment across reloads and shows the full crew name", async () => {
    const user = userEvent.setup();
    const first = render(
      <SessionProvider session={session}>
        <CrewShell />
      </SessionProvider>,
    );
    const name = screen.getByText(session.user.display_name);
    expect(name).not.toHaveClass("truncate");
    expect(name).toHaveClass("whitespace-normal");
    expect(first.container.querySelector(".crew")).toHaveAttribute("data-environment", "field");
    await user.click(screen.getByRole("button", { name: "Sun mode" }));
    expect(screen.getByRole("button", { name: "Sun mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(first.container.querySelector(".crew")).toHaveAttribute("data-environment", "field-sun");
    first.unmount();

    const reloaded = render(
      <SessionProvider session={session}>
        <CrewShell />
      </SessionProvider>,
    );
    expect(reloaded.container.querySelector(".crew")).toHaveAttribute(
      "data-environment",
      "field-sun",
    );
    await user.click(screen.getByRole("button", { name: "Sun mode" }));
    expect(reloaded.container.querySelector(".crew")).toHaveAttribute("data-environment", "field");
  });
});
