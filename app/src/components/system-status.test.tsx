import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../auth/session-context";
import { sessionFor } from "../admin/admin-test-harness";
import { useReadOnlyOfflineSurface } from "./offline-write-mode";
import type { OutboxReadState } from "../storage/use-outbox";
import { SystemStatus } from "./system-status";

vi.mock("virtual:pwa-register", () => ({ registerSW: () => async () => {} }));
const environment = vi.hoisted(() => ({
  canInstall: false,
  promptInstall: vi.fn(),
  storage: {
    checked: false,
    persistent: null as boolean | null,
    warning: undefined as string | undefined,
  },
}));
vi.mock("../hooks/use-install-prompt", () => ({ useInstallPrompt: () => environment }));
vi.mock("../storage/durability", () => ({ useStorageDurability: () => environment.storage }));
vi.mock("../storage/outbox-processor", () => ({ flushOutbox: vi.fn() }));

const outbox = {
  pending: 0,
  uploading: 0,
  needsAttention: 0,
  unclaimed: 0,
  readState: "ready" as OutboxReadState,
};
vi.mock("../storage/use-outbox", () => ({
  useOutboxSummary: () => outbox,
  useAppOpenOutboxSync: () => {},
}));

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value });
}

function ReadOnlySurface() {
  useReadOnlyOfflineSurface();
  return null;
}

function renderStatus(surface?: React.ReactNode) {
  return render(
    <SessionProvider session={sessionFor("owner")}>
      {surface}
      <SystemStatus />
    </SessionProvider>,
  );
}

describe("offline banner claim", () => {
  beforeEach(() => {
    outbox.pending = 0;
    outbox.uploading = 0;
    outbox.needsAttention = 0;
    outbox.unclaimed = 0;
    outbox.readState = "ready";
    setOnline(false);
  });

  it("keeps the queued-work promise for a surface that really queues offline work", () => {
    renderStatus();
    expect(screen.getByText(/New work stays on this device/)).toBeVisible();
  });

  it("stops promising a sync on a surface that discards offline edits", () => {
    renderStatus(<ReadOnlySurface />);
    expect(screen.getByText(/This screen is read-only until you reconnect/)).toBeVisible();
    expect(screen.queryByText(/New work stays on this device/)).toBeNull();
  });

  it("still names already-queued work when a read-only surface is open over it", () => {
    outbox.pending = 2;
    renderStatus(<ReadOnlySurface />);
    expect(screen.getByText(/New work stays on this device/)).toBeVisible();
  });

  it("returns to the queued-work promise once the read-only surface unmounts", () => {
    const { rerender } = renderStatus(<ReadOnlySurface />);
    expect(screen.getByText(/This screen is read-only until you reconnect/)).toBeVisible();
    rerender(
      <SessionProvider session={sessionFor("owner")}>
        <SystemStatus />
      </SessionProvider>,
    );
    expect(screen.getByText(/New work stays on this device/)).toBeVisible();
  });
});

describe("crew sync truth", () => {
  it.each([
    ["checking", 0, 0, "Checking saved work"],
    ["error", 0, 0, "Check saved work"],
    ["ready", 0, 0, "Nothing to send"],
    ["ready", 1, 1, "Sending 1"],
    ["ready", 3, 1, "Sending 3"],
    ["ready", 2, 0, "2 to send"],
  ] as const)(
    "reports %s with %i pending and %i uploading",
    (readState, pending, uploading, label) => {
      setOnline(true);
      Object.assign(outbox, { readState, pending, uploading, needsAttention: 0, unclaimed: 0 });
      render(
        <SessionProvider session={sessionFor("field")}>
          <SystemStatus variant="crew" />
        </SessionProvider>,
      );
      expect(screen.getByRole("status", { name: `Sync: ${label}` })).toBeVisible();
      if (readState !== "ready") expect(screen.queryByText("Nothing to send")).toBeNull();
    },
  );
});

it("offers installation and warns the crew before capturing on low storage", () => {
  setOnline(true);
  Object.assign(outbox, {
    pending: 0,
    uploading: 0,
    needsAttention: 0,
    unclaimed: 0,
    readState: "ready",
  });
  environment.canInstall = true;
  environment.storage = { checked: true, persistent: false, warning: "low_storage" };
  render(
    <SessionProvider session={sessionFor("field")}>
      <SystemStatus variant="crew" />
    </SessionProvider>,
  );
  expect(screen.getByText(/low on space/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  expect(environment.promptInstall).toHaveBeenCalledOnce();
});

describe("crew storage status from first render", () => {
  beforeEach(() => {
    setOnline(true);
    Object.assign(outbox, {
      pending: 0,
      uploading: 0,
      needsAttention: 0,
      unclaimed: 0,
      readState: "ready",
    });
    environment.canInstall = false;
    environment.storage = { checked: false, persistent: null, warning: undefined };
  });

  it("retains the same status region when the pending storage check reports a warning", () => {
    Object.assign(outbox, { pending: 1 });
    const status = (
      <SessionProvider session={sessionFor("field")}>
        <SystemStatus variant="crew" />
      </SessionProvider>
    );
    const { rerender } = render(status);
    const region = screen.getByText(/Checking device storage/).closest('[role="status"]');
    expect(screen.queryByText(/Device storage is protected/)).toBeNull();
    environment.storage = { checked: true, persistent: false, warning: "persistence_denied" };
    rerender(
      <SessionProvider session={sessionFor("field")}>
        <SystemStatus variant="crew" />
      </SessionProvider>,
    );
    expect(
      screen
        .getByText(
          "This device did not lock storage in place. Capture still works. Send saved work soon.",
        )
        .closest('[role="status"]'),
    ).toBe(region);
  });

  it.each([
    [{ checked: false, persistent: null, warning: undefined }],
    [{ checked: true, persistent: true, warning: undefined }],
    [{ checked: true, persistent: false, warning: undefined }],
    [{ checked: true, persistent: null, warning: undefined }],
    [{ checked: true, persistent: false, warning: "persistence_denied" }],
    [{ checked: true, persistent: null, warning: "check_failed" }],
  ])("says only that everything went when nothing is left on the phone: %o", (storage) => {
    environment.storage = storage;
    render(
      <SessionProvider session={sessionFor("field")}>
        <SystemStatus variant="crew" />
      </SessionProvider>,
    );
    const region = screen
      .getByText("Everything you took or filled in has reached the office, photos included.")
      .closest('[role="status"]');
    expect(screen.getByRole("status", { name: "Sync: Nothing to send" })).toBeVisible();
    // Beside "Nothing to send", any prompt to send or keep the app open would contradict it.
    expect(region?.textContent).not.toMatch(/send|keep this app open|storage/i);
    expect(region).toHaveClass("text-muted");
  });

  it("neither warns nor claims while saved work is still being read", () => {
    environment.storage = { checked: true, persistent: false, warning: "persistence_denied" };
    Object.assign(outbox, { readState: "checking" });
    render(
      <SessionProvider session={sessionFor("field")}>
        <SystemStatus variant="crew" />
      </SessionProvider>,
    );
    expect(screen.getByRole("status", { name: "Sync: Checking saved work" })).toBeVisible();
    const region = screen.getByText("Checking saved work.").closest('[role="status"]');
    expect(region).toHaveClass("text-muted");
    expect(region?.textContent).not.toMatch(/reached|storage/i);
  });

  it("still warns about low space when everything went, since the next photo needs it", () => {
    environment.storage = { checked: true, persistent: false, warning: "low_storage" };
    render(
      <SessionProvider session={sessionFor("field")}>
        <SystemStatus variant="crew" />
      </SessionProvider>,
    );
    expect(screen.getByText(/low on space/).closest('[role="status"]')).toHaveClass("text-warning");
  });

  it("keeps the storage prompt while saved work waits on this device", () => {
    environment.storage = { checked: true, persistent: false, warning: "persistence_denied" };
    Object.assign(outbox, { pending: 2 });
    render(
      <SessionProvider session={sessionFor("field")}>
        <SystemStatus variant="crew" />
      </SessionProvider>,
    );
    expect(
      screen.getByText(
        "This device did not lock storage in place. Capture still works. Send saved work soon.",
      ),
    ).toBeVisible();
  });

  it.each([true, false, null])(
    "reports storage protection truthfully while work waits: %s",
    (persistent) => {
      environment.storage = { checked: true, persistent, warning: undefined };
      Object.assign(outbox, { pending: 1 });
      render(
        <SessionProvider session={sessionFor("field")}>
          <SystemStatus variant="crew" />
        </SessionProvider>,
      );
      expect(
        screen.getByText(
          persistent === true ? /Device storage is protected/ : /Storage protection is unavailable/,
        ),
      ).toBeVisible();
    },
  );

  it("keeps healthy office status compact", () => {
    renderStatus();
    expect(screen.queryByText(/Checking device storage/)).toBeNull();
  });
});
