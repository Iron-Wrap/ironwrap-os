import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithSession, sessionFor } from "../admin/admin-test-harness";
import { ApiError } from "../lib/api";
import type { CorrectiveActionDetail } from "../field/safety-contracts";
import type { OutboxAction } from "../storage/outbox-types";
import {
  loadCorrectiveAction,
  listQueuedCorrectiveEvidence,
  queueCorrectiveEvidence,
  decideCorrectiveAction,
} from "./corrective-action-api";
import { CorrectiveActionPage } from "./corrective-action-page";

vi.mock("./corrective-action-api", () => ({
  loadCorrectiveAction: vi.fn(),
  listQueuedCorrectiveEvidence: vi.fn(),
  queueCorrectiveEvidence: vi.fn(),
  decideCorrectiveAction: vi.fn(),
}));

const action: CorrectiveActionDetail["corrective_action"] = {
  corrective_action_id: "ca_fix",
  occurrence_id: "so_hazard",
  version: 1,
  state: "open",
  risk_level: "high",
  owner_user_id: "appu_field",
  description: "Install a ladder tie-off.",
  due_at: "2026-09-01T00:00:00.000Z",
  evidence_refs_json: null,
  evidence_sha256: null,
  evidence_captured_by_user_id: null,
  evidence_submitted_at: null,
  verified_by_user_id: null,
  verified_at: null,
  closed_at: null,
};
const model = (over: Partial<CorrectiveActionDetail> = {}, offline = false) => ({
  response: {
    version: 1 as const,
    corrective_action: action,
    allowed_actions: ["submit_evidence" as const],
    verification_unavailable_reason: null,
    ...over,
  },
  offline,
});

const queuedEvidence = (state: OutboxAction["state"]): OutboxAction =>
  ({
    deviceActionId: "device-action-1",
    tenantId: "tenant",
    userId: "appu_field",
    kind: "safety_corrective_evidence",
    endpoint: "/api/v1/safety/corrective-actions/ca_fix/evidence",
    payload: {},
    state,
    attempts: 1,
    createdAt: 1,
    updatedAt: 1,
  }) as OutboxAction;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listQueuedCorrectiveEvidence).mockResolvedValue([]);
});

describe("corrective action", () => {
  it("does not ask for evidence again while this device still holds a saved submission", async () => {
    vi.mocked(loadCorrectiveAction).mockResolvedValue(model({}, true));
    vi.mocked(listQueuedCorrectiveEvidence).mockResolvedValue([queuedEvidence("queued")]);
    renderWithSession(<CorrectiveActionPage actionId="ca_fix" />, sessionFor("field"));
    expect(
      await screen.findByText("Evidence saved on this device is waiting to upload"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save evidence" })).not.toBeInTheDocument();
  });

  it("keeps the form but warns when a saved submission stopped and needs attention", async () => {
    vi.mocked(loadCorrectiveAction).mockResolvedValue(model());
    vi.mocked(listQueuedCorrectiveEvidence).mockResolvedValue([queuedEvidence("needs_attention")]);
    renderWithSession(<CorrectiveActionPage actionId="ca_fix" />, sessionFor("field"));
    expect(
      await screen.findByText("A saved submission for this action needs attention"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save evidence" })).toBeInTheDocument();
  });

  it("queues evidence on a saved field record without claiming server acceptance", async () => {
    vi.mocked(loadCorrectiveAction).mockResolvedValue(model({}, true));
    vi.mocked(queueCorrectiveEvidence).mockResolvedValue({
      state: "queued",
      deviceActionId: "test-action",
    });
    renderWithSession(<CorrectiveActionPage actionId="ca_fix" />, sessionFor("field"));
    fireEvent.change(await screen.findByLabelText("Stored evidence reference"), {
      target: { value: "r2://safety/tie-off.pdf" },
    });
    fireEvent.change(screen.getByLabelText("Evidence SHA-256"), {
      target: { value: "a".repeat(64) },
    });
    fireEvent.change(screen.getByLabelText("What was fixed"), {
      target: { value: "Tie-off installed and checked." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save evidence" }));
    expect(await screen.findByText("Evidence saved on this device")).toBeInTheDocument();
    expect(screen.queryByText("Evidence accepted by the server")).not.toBeInTheDocument();
    expect(queueCorrectiveEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ role: "field" }) }),
      "ca_fix",
      expect.objectContaining({
        detail: "Tie-off installed and checked.",
        evidence_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("shows the server's separation reason without a verification control", async () => {
    vi.mocked(loadCorrectiveAction).mockResolvedValue(
      model({
        corrective_action: { ...action, state: "evidence_submitted" },
        allowed_actions: [],
        verification_unavailable_reason:
          "The reporter, owner, and evidence capturer cannot verify this closure.",
      }),
    );
    renderWithSession(<CorrectiveActionPage actionId="ca_fix" />, sessionFor("owner"));
    expect(
      await screen.findByText(/The reporter, owner, and evidence capturer/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify the fix" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close action" })).not.toBeInTheDocument();
  });

  it("never offers verification from an offline copy of an allowed action", async () => {
    vi.mocked(loadCorrectiveAction).mockResolvedValue(
      model(
        {
          corrective_action: { ...action, state: "evidence_submitted" },
          allowed_actions: ["verify", "reject"],
        },
        true,
      ),
    );
    renderWithSession(<CorrectiveActionPage actionId="ca_fix" />, sessionFor("owner"));
    expect(await screen.findByText("Current state is not confirmed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify the fix" })).not.toBeInTheDocument();
  });

  it("explains the disabled decision buttons and ties the explanation to the controls", async () => {
    vi.mocked(loadCorrectiveAction).mockResolvedValue(
      model({ corrective_action: { ...action, state: "verified" }, allowed_actions: ["close"] }),
    );
    renderWithSession(<CorrectiveActionPage actionId="ca_fix" />, sessionFor("owner"));
    const close = await screen.findByRole("button", { name: "Close action" });
    const hint = screen.getByText(/Write at least three characters of findings/);
    expect(close).toBeDisabled();
    expect(close).toHaveAttribute("aria-describedby", hint.id);
    expect(screen.getByLabelText("Decision findings")).toHaveAttribute("aria-describedby", hint.id);
    expect(close).toHaveAccessibleDescription(/at least three characters/);
    fireEvent.change(screen.getByLabelText("Decision findings"), {
      target: { value: "Checked on site." },
    });
    expect(close).toBeEnabled();
    expect(screen.queryByText(/Write at least three characters/)).not.toBeInTheDocument();
    expect(close).toHaveAccessibleDescription("Your findings are recorded with the decision.");
  });

  it("keeps the findings and the action on screen when the sign-in ends mid-decision", async () => {
    vi.mocked(loadCorrectiveAction).mockResolvedValue(
      model({ corrective_action: { ...action, state: "verified" }, allowed_actions: ["close"] }),
    );
    vi.mocked(decideCorrectiveAction).mockRejectedValue(
      new ApiError({ status: 401, code: "session_invalid", message: "Sign in again." }),
    );
    renderWithSession(<CorrectiveActionPage actionId="ca_fix" />, sessionFor("owner"));
    fireEvent.change(await screen.findByLabelText("Decision findings"), {
      target: { value: "Checked on site." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close action" }));
    expect(
      await screen.findByText("Your sign-in ended before this was recorded"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Decision findings")).toHaveValue("Checked on site.");
    expect(screen.getByText(/Action ca_fix, revision 1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close action" })).toBeDisabled();
    expect(decideCorrectiveAction).toHaveBeenCalledTimes(1);
  });

  it("reads the closed record after an authorized closure", async () => {
    vi.mocked(loadCorrectiveAction).mockResolvedValue(
      model({ corrective_action: { ...action, state: "verified" }, allowed_actions: ["close"] }),
    );
    vi.mocked(decideCorrectiveAction).mockImplementation(async () => {
      const closed = {
        ...action,
        version: 4,
        state: "closed" as const,
        closed_at: "2026-09-05T12:00:00.000Z",
      };
      vi.mocked(loadCorrectiveAction).mockResolvedValue(
        model({ corrective_action: closed, allowed_actions: [] }),
      );
      return { version: 1, corrective_action: closed };
    });
    renderWithSession(<CorrectiveActionPage actionId="ca_fix" />, sessionFor("owner"));
    fireEvent.change(await screen.findByLabelText("Decision findings"), {
      target: { value: "Independent verification reviewed." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close action" }));
    expect(await screen.findByText("Decision recorded")).toBeInTheDocument();
    expect(screen.getByText(/revision 4/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close action" })).not.toBeInTheDocument();
    expect(decideCorrectiveAction).toHaveBeenCalledWith(
      expect.anything(),
      "ca_fix",
      "close",
      "Independent verification reviewed.",
    );
  });
});
