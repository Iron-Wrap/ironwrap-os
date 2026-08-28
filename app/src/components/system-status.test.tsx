import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../auth/session-context";
import { sessionFor } from "../admin/admin-test-harness";
import { useReadOnlyOfflineSurface } from "./offline-write-mode";
import { SystemStatus } from "./system-status";

vi.mock("virtual:pwa-register", () => ({ registerSW: () => async () => {} }));
vi.mock("../hooks/use-install-prompt", () => ({
  useInstallPrompt: () => ({ canInstall: false, promptInstall: async () => {} }),
}));
vi.mock("../storage/durability", () => ({ useStorageDurability: () => ({ checked: false }) }));
vi.mock("../storage/outbox-processor", () => ({ flushOutbox: vi.fn() }));

const outbox = { pending: 0, uploading: 0, needsAttention: 0, unclaimed: 0 };
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
