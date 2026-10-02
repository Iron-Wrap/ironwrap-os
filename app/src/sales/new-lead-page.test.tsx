import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { onlineManager } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderWithSession, sessionFor } from "../admin/admin-test-harness";
import { ApiError } from "../lib/api";
import { createOfficeLead, loadOfficeLeadReceipt, resumeOfficeLeadIntake } from "./sales-api";
import type { OfficeLeadReceipt, OfficeLeadReceiptResponse } from "./sales-contracts";
import { NewLeadPage } from "./new-lead-page";

const router = vi.hoisted(() => ({
  search: {} as { receipt?: string },
  listeners: new Set<() => void>(),
  navigate: vi.fn(),
}));
vi.mock("./sales-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sales-api")>()),
  createOfficeLead: vi.fn(),
  loadOfficeLeadReceipt: vi.fn(),
  resumeOfficeLeadIntake: vi.fn(),
}));
vi.mock("@tanstack/react-router", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    Link: ({
      to,
      params,
      children,
      ...props
    }: {
      to: string;
      params?: Record<string, string>;
      children: ReactNode;
    }) => (
      <a
        href={to.replace(/\$(\w+)/g, (_match, key: string) =>
          encodeURIComponent(params?.[key] ?? key),
        )}
        {...props}
      >
        {children}
      </a>
    ),
    useNavigate: () => router.navigate,
    useSearch: () =>
      useSyncExternalStore(
        (listener) => {
          router.listeners.add(listener);
          return () => router.listeners.delete(listener);
        },
        () => router.search,
      ),
  };
});
const requestId = "office-lead:11111111-1111-4111-8111-111111111111";
function accepted(overrides: Partial<OfficeLeadReceipt> = {}): OfficeLeadReceiptResponse {
  return {
    version: 1,
    receipt: {
      request_id: requestId,
      state: "recorded",
      outcome: "created",
      canonical_envelope_id: "ow_11111111-1111-4111-8111-111111111111",
      lead_id: "lead_synthetic_1",
      submitted_details_applied: true,
      captured_at: "2026-09-30T10:00:00.000Z",
      details: {
        name: "Synthetic Caller",
        email: "caller@example.invalid",
        phone: "403-555-0117",
        address: null,
        city: "Edmonton",
        province: null,
        postal_code: null,
        service: "Cedar shake restoration",
        message: "Loose shingles beside the chimney",
        intake_source: "referral",
        source: "manual",
        preferred_contact_channel: "email",
        email_consent: {
          status: "granted",
          purpose: "estimate_follow_up",
          recorded_at: "2026-09-30T10:00:00.000Z",
          captured_by: "appu_sales",
          jurisdiction: "CA-AB",
          wording_version: "office-estimate-follow-up-v1",
        },
      },
      ...overrides,
    },
  };
}
function renderPage(overrides: Parameters<typeof sessionFor>[1] = {}) {
  return renderWithSession(
    <NewLeadPage />,
    sessionFor("sales", { allowed_actions: ["sales.lead.create"], ...overrides }),
  );
}
function processing(id = requestId): OfficeLeadReceiptResponse {
  return accepted({
    request_id: id,
    state: "processing",
    outcome: null,
    canonical_envelope_id: null,
    lead_id: null,
    details: null,
    submitted_details_applied: null,
  });
}
function changeReceipt(id: string) {
  act(() => {
    router.search = { receipt: id };
    router.listeners.forEach((listener) => listener());
  });
}
async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Full name"), "Synthetic Caller");
  await user.type(screen.getByRole("textbox", { name: "Phone" }), "403-555-0117");
}
function serverAccepts(overrides: Partial<OfficeLeadReceipt> = {}) {
  vi.mocked(createOfficeLead).mockImplementation(async (_session, _input, id) =>
    accepted({ ...overrides, request_id: id }),
  );
}
const unknown = () => new ApiError({ status: 0, code: "timeout", message: "Timed out" });
beforeEach(() => {
  vi.clearAllMocks();
  router.search = {};
  router.navigate.mockImplementation(async ({ search }: { search: { receipt?: string } }) => {
    router.search = search;
    router.listeners.forEach((listener) => listener());
  });
  vi.mocked(createOfficeLead).mockReset();
  vi.mocked(loadOfficeLeadReceipt).mockReset();
  vi.mocked(resumeOfficeLeadIntake).mockReset();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  onlineManager.setOnline(true);
});

describe("NewLeadPage", () => {
  it("saves real source/preference/narrow consent with one opaque identity and renders persisted facts", async () => {
    serverAccepts();
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.type(screen.getByRole("textbox", { name: "Email" }), "caller@example.invalid");
    await user.type(screen.getByLabelText(/^Kind of work/), "Cedar shake restoration");
    await user.type(screen.getByLabelText(/^What they need/), "Loose shingles beside the chimney");
    await user.click(screen.getByRole("radio", { name: "Referral" }));
    await user.click(screen.getByRole("radio", { name: "Email" }));
    await user.click(
      screen.getByRole("checkbox", { name: "They agreed to receive estimate follow-up by email" }),
    );
    await user.click(screen.getByRole("button", { name: "Save lead" }));
    expect(await screen.findByText("Lead intake recorded")).toBeInTheDocument();
    expect(createOfficeLead).toHaveBeenCalledOnce();
    const [, submitted, id] = vi.mocked(createOfficeLead).mock.calls[0]!;
    expect(submitted).toMatchObject({
      service: "Cedar shake restoration",
      message: "Loose shingles beside the chimney",
      intake_source: "referral",
      preferred_contact_channel: "email",
      email_estimate_follow_up_consent: true,
    });
    expect(id).toMatch(/^office-lead:[0-9a-f-]{36}$/);
    expect(router.search).toEqual({ receipt: id });
    expect(screen.getByRole("link", { name: "Review this lead" })).toHaveAttribute(
      "href",
      "/sales/leads/lead_synthetic_1/triage",
    );
    const saved = within(screen.getByRole("region", { name: "Saved lead details" }));
    expect(saved.getByText("Estimate follow-up permission recorded")).toBeInTheDocument();
    expect(saved.getByText("Referral")).toBeInTheDocument();
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });
  it("blocks a direct form submission without reachable contact", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Full name"), "Synthetic Caller");
    fireEvent.submit(screen.getByRole("button", { name: "Save lead" }).closest("form")!);
    expect(screen.getByRole("button", { name: "Save lead" })).toBeDisabled();
    expect(createOfficeLead).not.toHaveBeenCalled();
  });
  it("Either and unchecked permission do not assert consent or require both contacts", async () => {
    serverAccepts();
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Save lead" }));
    await screen.findByText("Lead intake recorded");
    expect(vi.mocked(createOfficeLead).mock.calls[0]![1]).toMatchObject({
      preferred_contact_channel: null,
      email_estimate_follow_up_consent: false,
      email: "",
    });
  });
  it("requires the preferred contact and an email for email permission", async () => {
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole("radio", { name: "Email" }));
    expect(screen.getByRole("button", { name: "Save lead" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Either" }));
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Save lead" })).toBeDisabled();
    expect(createOfficeLead).not.toHaveBeenCalled();
  });
  it("locks two synchronous submit events to one immutable snapshot", async () => {
    vi.mocked(createOfficeLead).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    const form = screen.getByRole("button", { name: "Save lead" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(createOfficeLead).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Save lead" })).not.toBeInTheDocument();
  });
  it.each([
    unknown(),
    new ApiError({ status: 200, code: "invalid_json", message: "Unreadable" }),
    new ApiError({ status: 400, code: "unfamiliar_write_error", message: "Unknown refusal" }),
  ])(
    "reads back an uncertain write and never treats a 404 as proof of no save: %s",
    async (error) => {
      vi.mocked(createOfficeLead).mockRejectedValue(error);
      vi.mocked(loadOfficeLeadReceipt).mockRejectedValueOnce(
        new ApiError({ status: 404, code: "not_found", message: "No receipt" }),
      );
      const user = userEvent.setup();
      renderPage();
      await fillRequired(user);
      await user.click(screen.getByRole("button", { name: "Save lead" }));
      await screen.findByText("We haven’t confirmed whether this lead was saved");
      const id = router.search.receipt!;
      expect(loadOfficeLeadReceipt).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Retry same request" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Check saved result" }));
      expect(
        await screen.findByText(/This does not confirm that the lead was not saved/),
      ).toBeInTheDocument();
      expect(loadOfficeLeadReceipt).toHaveBeenCalledWith(id);
      vi.mocked(loadOfficeLeadReceipt).mockResolvedValueOnce(accepted({ request_id: id }));
      await user.click(screen.getByRole("button", { name: "Check saved result" }));
      expect(await screen.findByRole("link", { name: "Review this lead" })).toBeInTheDocument();
      expect(createOfficeLead).toHaveBeenCalledOnce();
      expect(router.search.receipt).toBe(id);
    },
  );
  it("allows only an explicit same-key exact-snapshot retry after a receipt check", async () => {
    vi.mocked(createOfficeLead).mockRejectedValueOnce(unknown());
    vi.mocked(loadOfficeLeadReceipt).mockRejectedValueOnce(
      new ApiError({ status: 404, code: "not_found", message: "No receipt" }),
    );
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Save lead" }));
    await screen.findByText("We haven’t confirmed whether this lead was saved");
    const original = vi.mocked(createOfficeLead).mock.calls[0]!;
    await user.click(screen.getByRole("button", { name: "Check saved result" }));
    serverAccepts();
    await user.click(await screen.findByRole("button", { name: "Retry same request" }));
    await screen.findByText("Lead intake recorded");
    const retry = vi.mocked(createOfficeLead).mock.calls[1]!;
    expect(retry[1]).toBe(original[1]);
    expect(retry[2]).toBe(original[2]);
    expect(createOfficeLead).toHaveBeenCalledTimes(2);
    expect(router.search.receipt).toBe(original[2]);
  });
  it("recovers after a fresh mount using only the URL and never submits automatically", async () => {
    vi.mocked(createOfficeLead).mockRejectedValueOnce(unknown());
    const user = userEvent.setup();
    const first = renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Save lead" }));
    await screen.findByText("We haven’t confirmed whether this lead was saved");
    const id = router.search.receipt!;
    first.unmount();
    vi.mocked(loadOfficeLeadReceipt).mockResolvedValueOnce(
      accepted({
        request_id: id,
        state: "processing",
        outcome: null,
        canonical_envelope_id: null,
        lead_id: null,
        details: null,
        submitted_details_applied: null,
      }),
    );
    renderPage();
    expect(await screen.findByText("This intake is still processing")).toBeInTheDocument();
    expect(loadOfficeLeadReceipt).toHaveBeenCalledWith(id);
    expect(screen.queryByRole("button", { name: "Retry same request" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review this lead" })).not.toBeInTheDocument();
    vi.mocked(loadOfficeLeadReceipt).mockResolvedValueOnce(
      accepted({ request_id: id, lead_id: "lead_exact_after_reload" }),
    );
    await user.click(screen.getByRole("button", { name: "Check saved result" }));
    expect(await screen.findByRole("link", { name: "Review this lead" })).toHaveAttribute(
      "href",
      "/sales/leads/lead_exact_after_reload/triage",
    );
    expect(createOfficeLead).toHaveBeenCalledOnce();
    expect(resumeOfficeLeadIntake).not.toHaveBeenCalled();
  });
  it("explicitly resumes a processing intake after reload using only its receipt identity", async () => {
    router.search = { receipt: requestId };
    vi.mocked(loadOfficeLeadReceipt).mockResolvedValueOnce(processing());
    let finish!: (value: OfficeLeadReceiptResponse) => void;
    vi.mocked(resumeOfficeLeadIntake).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    renderPage();
    const button = await screen.findByRole("button", { name: "Resume saved intake" });
    expect(resumeOfficeLeadIntake).not.toHaveBeenCalled();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(resumeOfficeLeadIntake).toHaveBeenCalledOnce());
    expect(resumeOfficeLeadIntake).toHaveBeenCalledWith(
      expect.objectContaining({ csrf_token: "csrf" }),
      requestId,
    );
    expect(screen.getByRole("button", { name: "Check saved result" })).toBeDisabled();
    await act(async () => {
      finish(accepted());
    });
    expect(await screen.findByRole("link", { name: "Review this lead" })).toHaveAttribute(
      "href",
      "/sales/leads/lead_synthetic_1/triage",
    );
    expect(screen.queryByRole("button", { name: "Resume saved intake" })).not.toBeInTheDocument();
    expect(router.search).toEqual({ receipt: requestId });
    expect(createOfficeLead).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
    await user.click(screen.getByRole("button", { name: "Add another lead" }));
    expect(await screen.findByLabelText("Full name")).toHaveValue("");
  });
  it("keeps a lost resume acknowledgement locked until a fresh successful processing read", async () => {
    router.search = { receipt: requestId };
    vi.mocked(loadOfficeLeadReceipt).mockResolvedValueOnce(processing());
    vi.mocked(resumeOfficeLeadIntake).mockRejectedValueOnce(unknown());
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Resume saved intake" }));
    expect(await screen.findByText("The resume result is unconfirmed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume saved intake" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save lead" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add another lead" })).not.toBeInTheDocument();
    vi.mocked(loadOfficeLeadReceipt).mockRejectedValueOnce(
      new ApiError({ status: 404, code: "intake_not_found", message: "No receipt" }),
    );
    await user.click(screen.getByRole("button", { name: "Check saved result" }));
    await screen.findByText("The latest saved status could not be checked");
    expect(screen.queryByRole("button", { name: "Resume saved intake" })).not.toBeInTheDocument();
    vi.mocked(loadOfficeLeadReceipt).mockResolvedValueOnce(processing());
    await user.click(screen.getByRole("button", { name: "Check saved result" }));
    vi.mocked(resumeOfficeLeadIntake).mockResolvedValueOnce(accepted());
    await user.click(await screen.findByRole("button", { name: "Resume saved intake" }));
    await screen.findByRole("link", { name: "Review this lead" });
    expect(resumeOfficeLeadIntake).toHaveBeenCalledTimes(2);
    expect(vi.mocked(resumeOfficeLeadIntake).mock.calls.every(([, id]) => id === requestId)).toBe(
      true,
    );
    expect(createOfficeLead).not.toHaveBeenCalled();
    expect(router.search.receipt).toBe(requestId);
  });
  it("never offers resume for a reopened unknown receipt or a failed read", async () => {
    router.search = { receipt: requestId };
    vi.mocked(loadOfficeLeadReceipt).mockRejectedValue(
      new ApiError({ status: 404, code: "intake_not_found", message: "No receipt" }),
    );
    renderPage();
    await screen.findByText(/This does not confirm that the lead was not saved/);
    expect(screen.queryByRole("button", { name: "Resume saved intake" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry same request" })).not.toBeInTheDocument();
    expect(resumeOfficeLeadIntake).not.toHaveBeenCalled();
  });
  it("does not reuse a reconnect read started during an uncertain resume", async () => {
    router.search = { receipt: requestId };
    vi.mocked(loadOfficeLeadReceipt).mockResolvedValueOnce(processing());
    let failResume!: (reason: unknown) => void;
    vi.mocked(resumeOfficeLeadIntake).mockReturnValue(
      new Promise((_resolve, reject) => {
        failResume = reject;
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Resume saved intake" }));
    let finishRead!: (value: OfficeLeadReceiptResponse) => void;
    vi.mocked(loadOfficeLeadReceipt).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(loadOfficeLeadReceipt).toHaveBeenCalledTimes(2));
    await act(async () => {
      failResume(unknown());
    });
    await screen.findByText("The resume result is unconfirmed");
    await act(async () => {
      finishRead(processing());
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check saved result" })).toBeEnabled(),
    );
    expect(screen.queryByRole("button", { name: "Resume saved intake" })).not.toBeInTheDocument();
    vi.mocked(loadOfficeLeadReceipt).mockResolvedValueOnce(processing());
    await user.click(screen.getByRole("button", { name: "Check saved result" }));
    expect(await screen.findByRole("button", { name: "Resume saved intake" })).toBeEnabled();
    expect(resumeOfficeLeadIntake).toHaveBeenCalledOnce();
  });
  it("keeps the confirmed resume result when an older reconnect read finishes later", async () => {
    router.search = { receipt: requestId };
    vi.mocked(loadOfficeLeadReceipt).mockResolvedValueOnce(processing());
    let finishResume!: (value: OfficeLeadReceiptResponse) => void;
    vi.mocked(resumeOfficeLeadIntake).mockReturnValue(
      new Promise((resolve) => {
        finishResume = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Resume saved intake" }));
    let finishRead!: (value: OfficeLeadReceiptResponse) => void;
    vi.mocked(loadOfficeLeadReceipt).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(loadOfficeLeadReceipt).toHaveBeenCalledTimes(2));
    await act(async () => {
      finishResume(accepted());
    });
    await screen.findByRole("link", { name: "Review this lead" });
    await act(async () => {
      finishRead(processing());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("link", { name: "Review this lead" })).toBeInTheDocument();
    expect(screen.queryByText("This intake is still processing")).not.toBeInTheDocument();
  });
  it.each(["permission", "network"] as const)(
    "blocks processing resume without %s",
    async (gate) => {
      router.search = { receipt: requestId };
      vi.mocked(loadOfficeLeadReceipt).mockResolvedValueOnce(processing());
      renderPage(gate === "permission" ? { allowed_actions: [] } : {});
      await screen.findByText("This intake is still processing");
      if (gate === "network")
        act(() => {
          window.dispatchEvent(new Event("offline"));
        });
      const button = screen.getByRole("button", { name: "Resume saved intake" });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(resumeOfficeLeadIntake).not.toHaveBeenCalled();
    },
  );
  it("does not authorize another receipt from an earlier read or late resume response", async () => {
    router.search = { receipt: requestId };
    vi.mocked(loadOfficeLeadReceipt).mockResolvedValueOnce(processing());
    let finish!: (value: OfficeLeadReceiptResponse) => void;
    vi.mocked(resumeOfficeLeadIntake).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Resume saved intake" }));
    const otherId = "office-lead:22222222-2222-4222-8222-222222222222";
    vi.mocked(loadOfficeLeadReceipt).mockRejectedValueOnce(
      new ApiError({ status: 404, code: "intake_not_found", message: "No receipt" }),
    );
    changeReceipt(otherId);
    await screen.findByText(/This does not confirm that the lead was not saved/);
    await act(async () => {
      finish(accepted());
    });
    expect(screen.queryByRole("button", { name: "Resume saved intake" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review this lead" })).not.toBeInTheDocument();
    expect(router.search.receipt).toBe(otherId);
    expect(createOfficeLead).not.toHaveBeenCalled();
  });
  it("keeps a recorded intake pending until an exact lead identity is returned", async () => {
    serverAccepts({ lead_id: null });
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Save lead" }));
    expect(await screen.findByText(/The lead is not ready for review yet/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Review this lead" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check saved result" })).toBeInTheDocument();
  });
  it("restores useful focus when a recorded intake gains its review link", async () => {
    serverAccepts({ lead_id: null });
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Save lead" }));
    await screen.findByText(/The lead is not ready for review yet/);
    vi.mocked(loadOfficeLeadReceipt).mockResolvedValueOnce(
      accepted({ request_id: router.search.receipt! }),
    );
    await user.click(screen.getByRole("button", { name: "Check saved result" }));
    const review = await screen.findByRole("link", { name: "Review this lead" });
    expect(review.closest(".new-lead-result")).toHaveFocus();
  });
  it("keeps an explicit pre-write consent setup refusal editable instead of treating it as unknown", async () => {
    vi.mocked(createOfficeLead).mockRejectedValueOnce(
      new ApiError({
        status: 503,
        code: "office_consent_jurisdiction_unconfigured",
        message: "Unavailable",
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.type(screen.getByRole("textbox", { name: "Email" }), "caller@example.invalid");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Save lead" }));
    expect(
      await screen.findByText(/The office must configure estimate follow-up permission recording/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toHaveValue("Synthetic Caller");
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(router.search).toEqual({});
    expect(loadOfficeLeadReceipt).not.toHaveBeenCalled();
  });
  it("shows canonical duplicate facts and explicitly unapplied submitted preference and consent", async () => {
    const details = accepted().receipt.details!;
    serverAccepts({
      outcome: "duplicate",
      submitted_details_applied: false,
      lead_id: "lead_existing",
      details: {
        ...details,
        name: "Existing Synthetic Person",
        email_consent: { ...details.email_consent, status: "not_recorded" },
      },
    });
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.type(screen.getByRole("textbox", { name: "Email" }), "caller@example.invalid");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Save lead" }));
    expect(await screen.findByText(/were not applied to the existing lead/)).toBeInTheDocument();
    const saved = within(screen.getByRole("region", { name: "Existing lead details" }));
    expect(saved.getByText("Existing Synthetic Person")).toBeInTheDocument();
    expect(saved.getByText("No estimate follow-up permission recorded")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review this lead" })).toHaveAttribute(
      "href",
      "/sales/leads/lead_existing/triage",
    );
  });
  it("retains a definitely refused form and gives a corrected intent a new key", async () => {
    vi.mocked(createOfficeLead).mockRejectedValueOnce(
      new ApiError({ status: 400, code: "contact_required", message: "contact_required" }),
    );
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Save lead" }));
    expect(await screen.findByText("Check these details before saving")).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toHaveValue("Synthetic Caller");
    const oldKey = vi.mocked(createOfficeLead).mock.calls[0]![2];
    await user.type(screen.getByRole("textbox", { name: "Email" }), "corrected@example.invalid");
    serverAccepts();
    await user.click(screen.getByRole("button", { name: "Save lead" }));
    await screen.findByText("Lead intake recorded");
    expect(vi.mocked(createOfficeLead).mock.calls[1]![2]).not.toBe(oldKey);
  });
  it("clears a recorded intent before adding another lead", async () => {
    serverAccepts();
    const user = userEvent.setup();
    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Save lead" }));
    await user.click(await screen.findByRole("button", { name: "Add another lead" }));
    expect(await screen.findByLabelText("Full name")).toHaveValue("");
    expect(screen.getByLabelText("Full name")).toHaveFocus();
    expect(router.search).toEqual({});
  });
  it.each(["snapshot", "network"] as const)(
    "keeps offline drafts in memory but blocks writes and checks (%s)",
    async (mode) => {
      const user = userEvent.setup();
      renderPage(mode === "snapshot" ? { csrf_token: "offline-session-no-csrf" } : {});
      await fillRequired(user);
      if (mode === "network")
        act(() => {
          window.dispatchEvent(new Event("offline"));
        });
      expect(screen.getByRole("button", { name: "Save lead" })).toBeDisabled();
      expect(createOfficeLead).not.toHaveBeenCalled();
      act(() => {
        router.search = { receipt: requestId };
        router.listeners.forEach((listener) => listener());
      });
      expect(screen.getByRole("button", { name: "Check saved result" })).toBeDisabled();
      expect(loadOfficeLeadReceipt).not.toHaveBeenCalled();
    },
  );
  it("blocks writes when the role lacks the advertised create action", async () => {
    const user = userEvent.setup();
    renderPage({ allowed_actions: [] });
    await fillRequired(user);
    fireEvent.submit(screen.getByRole("button", { name: "Save lead" }).closest("form")!);
    expect(createOfficeLead).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save lead" })).toBeDisabled();
  });
  it("does not even read a receipt for a crew role", async () => {
    router.search = { receipt: requestId };
    renderWithSession(<NewLeadPage />, sessionFor("field"));
    expect(
      await screen.findByRole("heading", { name: "This work belongs to another role" }),
    ).toBeInTheDocument();
    expect(loadOfficeLeadReceipt).not.toHaveBeenCalled();
  });
});
