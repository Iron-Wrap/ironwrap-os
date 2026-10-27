import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadSafetyDesk } from "./safety-desk-api";
import type { SafetyDeskResponse } from "./safety-desk-contracts";
import { SafetyDeskPage } from "./safety-desk-page";
import { SafetyEquipmentPage } from "./safety-equipment-page";
import { inspectSafetyEquipment, loadSafetyEquipment } from "./safety-equipment-api";

vi.mock("./safety-equipment-api", () => ({
  inspectSafetyEquipment: vi.fn(),
  loadSafetyEquipment: vi.fn(),
}));

vi.mock("./safety-desk-api", async () => {
  const actual = await vi.importActual<typeof import("./safety-desk-api")>("./safety-desk-api");
  return { ...actual, loadSafetyDesk: vi.fn() };
});

const opsSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_ops",
    email: "ops@example.invalid",
    display_name: "Operations",
    role: "ops",
    frappe_user_id: "ops@example.invalid",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: [],
  allowed_actions: [],
  csrf_token: "csrf",
  session_expires_at: "2036-08-20T09:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-20T09:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const equipment = (over: Partial<NonNullable<SafetyDeskResponse["equipment"]>[number]> = {}) => ({
  equipment_id: "eq_harness_0001",
  equipment_kind: "fall_arrest_harness",
  serial_number: "SN-0001",
  status: "in_service",
  assigned_user_id: "appu_crew_member_0001",
  inspection_due_at: "2027-01-01T00:00:00.000Z",
  last_inspection_result: "pass" as const,
  verdict: "serviceable" as const,
  detail: null,
  days_left: 120,
  ...over,
});

const action = (
  over: Partial<NonNullable<SafetyDeskResponse["corrective_actions"]>[number]> = {},
) => ({
  corrective_action_id: "ca_ladder_control01",
  occurrence_id: "so_ladder_slip_0001",
  state: "open",
  risk_level: "high",
  owner_user_id: "appu_crew_member_0002",
  due_at: "2026-08-16T12:00:00.000Z",
  description: "Install a permanent ladder tie-off point.",
  blocking: true,
  days_left: -1,
  ...over,
});

const desk = (over: Partial<SafetyDeskResponse> = {}): SafetyDeskResponse => ({
  version: 1,
  read_model_generated_at: "2026-08-20T09:00:00.000Z",
  expiring_within_days: 30,
  actor_role: "ops",
  equipment: [equipment()],
  corrective_actions: [],
  ...over,
});

function renderPage(page: React.ReactNode = <SafetyDeskPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={opsSession}>{page}</SessionProvider>
    </QueryClientProvider>,
  );
}

describe("the safety desk", () => {
  beforeEach(() => {
    vi.mocked(loadSafetyDesk).mockReset();
  });

  it("prints the release gate's own sentence rather than inventing its own", async () => {
    vi.mocked(loadSafetyDesk).mockResolvedValue(
      desk({
        equipment: [
          equipment({
            verdict: "unserviceable",
            detail: "fall_arrest_harness SN-0001 has no recorded inspection.",
            inspection_due_at: null,
            last_inspection_result: null,
            days_left: null,
          }),
        ],
      }),
    );
    renderPage();
    expect(
      await screen.findByText("fall_arrest_harness SN-0001 has no recorded inspection."),
    ).toBeInTheDocument();
    expect(screen.getByText("Not usable")).toBeInTheDocument();
    expect(screen.getByText(/Stops work now, 1/)).toBeInTheDocument();
  });

  it("separates what stops work from what is merely due soon", async () => {
    vi.mocked(loadSafetyDesk).mockResolvedValue(
      desk({
        equipment: [
          equipment({
            equipment_id: "eq_harness_0002",
            serial_number: "SN-0002",
            verdict: "expiring",
            detail: "fall_arrest_harness SN-0002 inspection is due 2026-09-20T00:00:00.000Z.",
            days_left: 10,
          }),
        ],
      }),
    );
    renderPage();
    expect(await screen.findByText(/Due soon, 1/)).toBeInTheDocument();
    expect(screen.getByText("Inspection due")).toBeInTheDocument();
    // An expiry is not a stop, and the desk must not imply that it is.
    expect(screen.queryByText(/Stops work now, /)).not.toBeInTheDocument();
  });

  it("marks an overdue high-risk action as stopping and says why in words", async () => {
    vi.mocked(loadSafetyDesk).mockResolvedValue(
      desk({ equipment: [], corrective_actions: [action()] }),
    );
    renderPage();
    expect(
      await screen.findByText("Install a permanent ladder tie-off point."),
    ).toBeInTheDocument();
    expect(screen.getByText("Stops work")).toBeInTheDocument();
    expect(screen.getByText(/Was due 2026-08-16, 1 day ago/)).toBeInTheDocument();
    expect(screen.getByText(/A release is refused while this stays open/)).toBeInTheDocument();
  });

  it("shows an overdue low-risk action without claiming it stops work", async () => {
    vi.mocked(loadSafetyDesk).mockResolvedValue(
      desk({
        equipment: [],
        corrective_actions: [
          action({
            corrective_action_id: "ca_ladder_signage1",
            description: "Add a reminder sign at the ladder base.",
            risk_level: "low",
            blocking: false,
          }),
        ],
      }),
    );
    renderPage();
    expect(await screen.findByText(/Open, not stopping work, 1/)).toBeInTheDocument();
    expect(screen.queryByText("Stops work")).not.toBeInTheDocument();
  });

  it("says a rail is not on this desk rather than showing it as empty", async () => {
    vi.mocked(loadSafetyDesk).mockResolvedValue(
      desk({ actor_role: "shop", corrective_actions: null }),
    );
    renderPage();
    expect(await screen.findByText("Corrective actions are not on your desk")).toBeInTheDocument();
    expect(screen.getByText(/needs response authority/)).toBeInTheDocument();
  });

  it("keeps role restrictions visible when the permitted equipment list is empty", async () => {
    vi.mocked(loadSafetyDesk).mockResolvedValue(
      desk({ actor_role: "shop", equipment: [], corrective_actions: null }),
    );
    renderPage();
    expect(await screen.findByText("No safety records on this desk")).toBeInTheDocument();
    expect(screen.getByText("Corrective actions are not on your desk")).toBeInTheDocument();
    expect(screen.getByText(/needs response authority/)).toBeInTheDocument();
  });

  it("says nothing is issued rather than showing an empty page", async () => {
    vi.mocked(loadSafetyDesk).mockResolvedValue(desk({ equipment: [], corrective_actions: [] }));
    renderPage();
    expect(await screen.findByText("No safety records on this desk")).toBeInTheDocument();
    expect(screen.getByText(/not the same as a safe one/)).toBeInTheDocument();
  });

  it("refuses without pretending the screen is broken", async () => {
    vi.mocked(loadSafetyDesk).mockRejectedValue(
      new ApiError({ message: "forbidden", status: 403, code: "safety_desk_role_required" }),
    );
    renderPage();
    expect(await screen.findByText(/read by the people who can act on it/)).toBeInTheDocument();
    expect(screen.queryByText(/did not load/)).not.toBeInTheDocument();
  });

  it("offers a retry when the store does not answer", async () => {
    vi.mocked(loadSafetyDesk).mockRejectedValue(
      new ApiError({ message: "bad gateway", status: 502, code: "safety_store_unavailable" }),
    );
    renderPage();
    expect(await screen.findByText(/The safety store did not answer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});

describe("equipment inspections", () => {
  const record = {
    ...equipment(),
    version: 1,
    inspection_interval_days: 180,
    last_inspection_at: "2026-08-20T09:00:00.000Z",
    replaced_by_equipment_id: null,
    updated_at: "2026-08-20T09:00:00.000Z",
    status: "in_service" as const,
  };
  beforeEach(() => {
    vi.mocked(loadSafetyDesk).mockReset().mockResolvedValue(desk());
    vi.mocked(loadSafetyEquipment).mockReset().mockResolvedValue({ version: 1, equipment: record });
    vi.mocked(inspectSafetyEquipment).mockReset();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("records a failed inspection and reads the server's new equipment revision", async () => {
    const changed = {
      ...record,
      status: "quarantined" as const,
      version: 2,
      last_inspection_result: "fail" as const,
    };
    vi.mocked(inspectSafetyEquipment).mockImplementation(async () => {
      vi.mocked(loadSafetyEquipment).mockResolvedValue({ version: 1, equipment: changed });
      return { version: 1, equipment: changed };
    });
    renderPage(<SafetyEquipmentPage equipmentId={record.equipment_id} />);
    fireEvent.change(await screen.findByLabelText("Inspection findings"), {
      target: { value: "Webbing is damaged." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record inspection" }));
    expect(await screen.findByText("Inspection recorded")).toBeInTheDocument();
    expect(screen.getByText("Quarantined")).toBeInTheDocument();
    expect(inspectSafetyEquipment).toHaveBeenCalledWith(opsSession, record.equipment_id, {
      result: "fail",
      detail: "Webbing is damaged.",
      expected_version: record.version,
    });
    expect(screen.queryByText(/revision \d/)).not.toBeInTheDocument();
  });

  it("blocks a draft started on an older revision once the record refetches, until explicit reconsideration", async () => {
    const quarantinedByOther = {
      ...record,
      status: "quarantined" as const,
      version: 2,
      last_inspection_result: "fail" as const,
    };
    renderPage(<SafetyEquipmentPage equipmentId={record.equipment_id} />);
    fireEvent.change(await screen.findByLabelText("Inspection findings"), {
      target: { value: "Looked fine this morning." },
    });
    fireEvent.change(screen.getByLabelText("Inspection result"), { target: { value: "pass" } });
    expect(screen.getByRole("button", { name: "Record inspection" })).toBeEnabled();

    // Someone else quarantines the item; a focus/background refetch brings revision 2 in
    // BEFORE the inspector submits.
    vi.mocked(loadSafetyEquipment).mockResolvedValue({ version: 1, equipment: quarantinedByOther });
    fireEvent.click(screen.getByRole("button", { name: "Refresh equipment" }));
    expect(await screen.findByText(/Record eq_harness_0001\. Updated/)).toBeInTheDocument();
    expect(screen.getByText("Quarantined")).toBeInTheDocument();
    expect(screen.getByText("This record changed while you were writing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record inspection" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Record inspection" }).closest("form")!);
    expect(inspectSafetyEquipment).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Inspection findings")).toHaveValue("Looked fine this morning.");

    // Only an explicit re-read re-binds the draft, and then to revision 2, never silently.
    fireEvent.click(
      screen.getByRole("button", { name: "I have read the current record, decide again" }),
    );
    expect(screen.getByRole("button", { name: "Record inspection" })).toBeEnabled();
    vi.mocked(inspectSafetyEquipment).mockResolvedValue({
      version: 1,
      equipment: {
        ...quarantinedByOther,
        version: 3,
        status: "in_service",
        last_inspection_result: "pass",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record inspection" }));
    await waitFor(() => expect(inspectSafetyEquipment).toHaveBeenCalledTimes(1));
    expect(inspectSafetyEquipment).toHaveBeenCalledWith(opsSession, record.equipment_id, {
      result: "pass",
      detail: "Looked fine this morning.",
      expected_version: 2,
    });
  });

  it("shows the conflict and the current revision when the record changed under a stale pass", async () => {
    const quarantinedByOther = {
      ...record,
      status: "quarantined" as const,
      version: 2,
      last_inspection_result: "fail" as const,
    };
    vi.mocked(inspectSafetyEquipment).mockImplementation(async () => {
      vi.mocked(loadSafetyEquipment).mockResolvedValue({
        version: 1,
        equipment: quarantinedByOther,
      });
      throw new ApiError({
        status: 409,
        code: "safety_equipment_version_conflict",
        message: "This equipment changed since it was read (revision 1 read, revision 2 on file).",
      });
    });
    renderPage(<SafetyEquipmentPage equipmentId={record.equipment_id} />);
    fireEvent.change(await screen.findByLabelText("Inspection findings"), {
      target: { value: "Looked fine this morning." },
    });
    fireEvent.change(screen.getByLabelText("Inspection result"), { target: { value: "pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Record inspection" }));
    expect(
      await screen.findByText("This record changed before your inspection arrived"),
    ).toBeInTheDocument();
    expect(inspectSafetyEquipment).toHaveBeenCalledWith(opsSession, record.equipment_id, {
      result: "pass",
      detail: "Looked fine this morning.",
      expected_version: 1,
    });
    expect(await screen.findByText(/Record eq_harness_0001\. Updated/)).toBeInTheDocument();
    expect(screen.getByText("Quarantined")).toBeInTheDocument();
    expect(screen.getByLabelText("Inspection findings")).toHaveValue("Looked fine this morning.");
    expect(screen.getByRole("button", { name: "Record inspection" })).toBeDisabled();
    expect(inspectSafetyEquipment).toHaveBeenCalledTimes(1);
  });

  it("keeps the findings on screen when the sign-in ends before the inspection is recorded", async () => {
    vi.mocked(inspectSafetyEquipment).mockRejectedValue(
      new ApiError({ status: 401, code: "session_invalid", message: "Sign in again." }),
    );
    renderPage(<SafetyEquipmentPage equipmentId={record.equipment_id} />);
    fireEvent.change(await screen.findByLabelText("Inspection findings"), {
      target: { value: "Webbing is damaged." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record inspection" }));
    expect(
      await screen.findByText("Your sign-in ended before this was recorded"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Inspection findings")).toHaveValue("Webbing is damaged.");
    expect(screen.getByRole("button", { name: "Record inspection" })).toBeDisabled();
    expect(inspectSafetyEquipment).toHaveBeenCalledTimes(1);
  });

  it("preserves findings and requires readback before retrying an uncertain submission", async () => {
    vi.mocked(inspectSafetyEquipment).mockRejectedValue(
      new ApiError({ status: 0, code: "timeout", message: "No confirmation arrived." }),
    );
    renderPage(<SafetyEquipmentPage equipmentId={record.equipment_id} />);
    fireEvent.change(await screen.findByLabelText("Inspection findings"), {
      target: { value: "Webbing is damaged." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record inspection" }));
    expect(await screen.findByText("Inspection not confirmed")).toBeInTheDocument();
    expect(screen.getByLabelText("Inspection findings")).toHaveValue("Webbing is damaged.");
    expect(screen.getByRole("button", { name: "Record inspection" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh equipment" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record inspection" })).toBeEnabled(),
    );
    expect(inspectSafetyEquipment).toHaveBeenCalledTimes(1);
  });

  it.each(["field", "estimator"])("does not offer inspection to %s", async (actor_role) => {
    vi.mocked(loadSafetyDesk).mockResolvedValue(desk({ actor_role }));
    renderPage(<SafetyEquipmentPage equipmentId={record.equipment_id} />);
    expect(await screen.findByText("Equipment authority required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record inspection" })).not.toBeInTheDocument();
  });

  it("keeps inspection unavailable offline and points to durable defect reporting", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    renderPage(<SafetyEquipmentPage equipmentId={record.equipment_id} />);
    expect(await screen.findByText("Connect before inspecting")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record inspection" })).not.toBeInTheDocument();
    expect(inspectSafetyEquipment).not.toHaveBeenCalled();
  });
});
