import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { resetDatabaseForTests } from "../storage/db";
import {
  getOutboxAction,
  markOutboxNeedsAttention,
  queueOutboxAction,
  saveOutboxAction,
} from "../storage/outbox";
import { flushOutbox } from "../storage/outbox-processor";
import { SavedWorkRecoveryPanel } from "./saved-work-recovery-panel";

vi.mock("../storage/outbox-processor", () => ({
  flushOutbox: vi
    .fn()
    .mockResolvedValue({ processed: 1, verified: 0, requeued: 0, needsAttention: 0 }),
}));

const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_field_user",
    email: "crew@example.com",
    display_name: "Crew",
    role: "field",
    frappe_user_id: "crew@example.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:assigned"],
  allowed_actions: ["field.checkin.create"],
  csrf_token: "csrf",
  session_expires_at: "2026-07-11T12:00:00.000Z",
  source_updated_at: "2026-07-10T12:00:00.000Z",
  read_model_generated_at: "2026-07-10T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const principal = { tenantId: session.tenant.id, userId: session.user.id };

async function saveAttentionItem(
  deviceActionId: string,
  detail: Parameters<typeof markOutboxNeedsAttention>[1],
) {
  await saveOutboxAction({
    ...principal,
    deviceActionId,
    kind: "field_checkin",
    endpoint: "/api/v1/jobs/JOB-1042/check-ins",
    payload: { proof_slot: "Safety" },
  });
  await queueOutboxAction(deviceActionId, 1_000);
  await markOutboxNeedsAttention(deviceActionId, detail, 2_000);
}

describe("SavedWorkRecoveryPanel", () => {
  const originalOnline = navigator.onLine;

  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: originalOnline });
    await resetDatabaseForTests();
  });

  it("names a preserved conflict and never exposes a blind retry", async () => {
    await saveAttentionItem("assignment-conflict", {
      error: {
        code: "assignment_changed",
        message: "The active assignment changed in the office.",
        status: 409,
        occurredAt: 2_000,
      },
      conflict: {
        status: 409,
        code: "assignment_changed",
        message: "The active assignment changed in the office.",
        detectedAt: 2_000,
      },
    });

    render(<SavedWorkRecoveryPanel session={session} />);

    const heading = await screen.findByRole("heading", { name: "One saved item needs review" });
    expect(heading.closest("section")).toHaveAttribute("id", "saved-work");
    expect(screen.getByRole("heading", { name: "Field check-in · job JOB-1042" })).toBeVisible();
    expect(screen.getByText("The active assignment changed in the office.")).toBeVisible();
    expect(screen.getByText(/office copy changed \(assignment_changed\)/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry saved item" })).not.toBeInTheDocument();
    expect((await getOutboxAction("assignment-conflict"))?.state).toBe("needs_attention");
  });

  it("offers an explicit retry only for a transient non-conflict item", async () => {
    await saveAttentionItem("safe-retry", {
      error: {
        code: "http_503",
        message: "The server was temporarily unavailable.",
        status: 503,
        occurredAt: 2_000,
      },
    });
    const user = userEvent.setup();
    render(<SavedWorkRecoveryPanel session={session} />);

    await screen.findByRole("button", { name: "Retry saved item" });
    await user.click(screen.getByRole("button", { name: "Retry saved item" }));

    await waitFor(async () => {
      expect((await getOutboxAction("safe-retry"))?.state).toBe("queued");
    });
    expect(flushOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: session.tenant.id,
        userId: session.user.id,
        csrfToken: session.csrf_token,
      }),
    );
  });

  it("labels a pending Stop Work report with its exact Work Package", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "stop-work-review",
      kind: "work_package_stop",
      endpoint: "/api/v1/jobs/JOB-1042/work-package/stop-work",
      payload: { work_package_id: "WP-1042-v3", blocker_reason: "Wind exceeds the plan limit." },
    });
    await queueOutboxAction("stop-work-review", 1_000);
    await markOutboxNeedsAttention(
      "stop-work-review",
      {
        error: {
          code: "offline_timeout",
          message: "The stop report remains saved for office review.",
          status: 503,
          occurredAt: 2_000,
        },
      },
      2_000,
    );

    render(<SavedWorkRecoveryPanel session={session} />);

    expect(
      await screen.findByRole("heading", {
        name: "Stop Work report · package WP-1042-v3 · job JOB-1042",
      }),
    ).toBeVisible();
  });
});
