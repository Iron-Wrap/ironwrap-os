import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { CrewShell } from "./crew-shell";

const route = vi.hoisted(() => ({ pathname: "/today" }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Outlet: () => <p>Assigned field work</p>,
  useRouterState: () => route.pathname,
}));
vi.mock("../field/safety-action-panel", () => ({
  SafetyActionPanel: ({ scope }: { scope?: { type: string; id: string } }) => (
    <p>Safety panel scope: {scope ? `${scope.type} ${scope.id}` : "company"}</p>
  ),
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
  beforeEach(() => {
    window.localStorage.clear();
    route.pathname = "/today";
  });

  it("stops work on the open job from Help, never the whole company", async () => {
    route.pathname = "/jobs/JOB-ELENA";
    const user = userEvent.setup();
    render(
      <SessionProvider session={session}>
        <CrewShell />
      </SessionProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(await screen.findByRole("button", { name: "Send stop report" })).toBeVisible();
    expect(screen.getByText("Safety panel scope: roof_job JOB-ELENA")).toBeInTheDocument();
  });

  it("keeps the company-wide panel when no job is known", async () => {
    const user = userEvent.setup();
    render(
      <SessionProvider session={session}>
        <CrewShell />
      </SessionProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(await screen.findByText("Safety panel scope: company")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send stop report" })).toBeNull();
  });

  it("opens in Sun mode on a touch scope, even when the phone is set to dark", () => {
    const darkPhone = vi.spyOn(window, "matchMedia").mockImplementation(
      (media) =>
        ({
          media,
          matches: media === "(prefers-color-scheme: dark)",
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    const { container } = render(
      <SessionProvider session={session}>
        <CrewShell />
      </SessionProvider>,
    );
    const crew = container.querySelector(".crew");
    expect(crew).toHaveAttribute("data-mode", "field-sun");
    expect(crew).toHaveAttribute("data-density", "touch");
    // In sun the control offers the other look by name.
    expect(screen.getByRole("button", { name: "Use night mode" })).not.toHaveAttribute(
      "aria-pressed",
    );
    darkPhone.mockRestore();
  });

  it("retains the crew's own night choice across reloads and shows the full crew name", async () => {
    const user = userEvent.setup();
    const first = render(
      <SessionProvider session={session}>
        <CrewShell />
      </SessionProvider>,
    );
    const name = screen.getByText(session.user.display_name);
    expect(name).not.toHaveClass("truncate");
    expect(name).toHaveClass("whitespace-normal");
    await user.click(screen.getByRole("button", { name: "Use night mode" }));
    expect(screen.queryByRole("button", { name: "Use night mode" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use sun mode" })).toBeInTheDocument();
    expect(first.container.querySelector(".crew")).toHaveAttribute("data-mode", "field-night");
    expect(first.container.querySelector(".crew")).toHaveAttribute("data-density", "touch");
    first.unmount();

    const reloaded = render(
      <SessionProvider session={session}>
        <CrewShell />
      </SessionProvider>,
    );
    expect(reloaded.container.querySelector(".crew")).toHaveAttribute("data-mode", "field-night");
    await user.click(screen.getByRole("button", { name: "Use sun mode" }));
    expect(reloaded.container.querySelector(".crew")).toHaveAttribute("data-mode", "field-sun");
    expect(window.localStorage.getItem("ironwrap.field.night-mode")).toBeNull();
  });

  it("ignores the Sun setting an earlier release stored, so night is only ever chosen", () => {
    window.localStorage.setItem("ironwrap.field.sun-mode", "off");
    const { container } = render(
      <SessionProvider session={session}>
        <CrewShell />
      </SessionProvider>,
    );
    expect(container.querySelector(".crew")).toHaveAttribute("data-mode", "field-sun");
  });
});
