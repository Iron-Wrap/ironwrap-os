import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sessionFor } from "../admin/admin-test-harness";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadManualMeasurements, recordManualMeasurement } from "./manual-measurement-api";
import type {
  ManualMeasurementResult,
  ManualMeasurementsResponse,
  ManualObservation,
} from "./manual-measurement-contracts";
import { ManualMeasurementPanel } from "./manual-measurement-panel";

const router = vi.hoisted(() => ({
  search: {} as { measurementRequest?: string },
  listeners: new Set<() => void>(),
  navigate: vi.fn(),
}));
vi.mock("./manual-measurement-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manual-measurement-api")>()),
  loadManualMeasurements: vi.fn(),
  recordManualMeasurement: vi.fn(),
}));
vi.mock("@tanstack/react-router", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
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
const jobId = "roof_job_manual_test";
const requestId = "manual-measurement:11111111-1111-4111-8111-111111111111";
const oid = `mobs_${"1".repeat(64)}`;
const aid = `marea_${"a".repeat(64)}`;
function observation(overrides: Partial<ManualObservation> = {}): ManualObservation {
  return {
    id: oid,
    job_id: jobId,
    area_id: aid,
    area_label: "North roof",
    revision: 1,
    sequence: 1,
    area_sq_ft: 1200,
    area_basis: "roof_surface",
    pitch_rise_per_12: 6,
    method: "laser",
    uncertainty: "Eaves partly obscured",
    correction_reason: null,
    supersedes_observation_id: null,
    previous_head_id: null,
    job_version: 4,
    recorded_by: "appu_owner",
    recorded_at: "2026-09-30T10:00:00.000Z",
    sha256: "f".repeat(64),
    ...overrides,
  };
}
function model(overrides: Partial<ManualMeasurementsResponse> = {}): ManualMeasurementsResponse {
  return {
    version: 1,
    tenant_id: "freshco",
    read_model_generated_at: "2026-09-30T10:00:00.000Z",
    job: { id: jobId, version: 4, job_number: null },
    allowed_actions: ["manual_measurement.record"],
    observation_head: null,
    areas: [],
    history: { items: [], next_before: null },
    requested_request_id: null,
    receipt: null,
    ...overrides,
  };
}
function receipt(id = requestId, row = observation()): ManualMeasurementResult {
  return {
    version: 1,
    tenant_id: "freshco",
    job_id: row.job_id,
    receipt: { request_id: id, request_hash: "e".repeat(64), observation: row },
    replayed: false,
  };
}
function reads(value = model()) {
  vi.mocked(loadManualMeasurements).mockImplementation(async (_job, options) => ({
    ...value,
    requested_request_id: options?.requestId ?? null,
  }));
}
function setup(session = sessionFor("owner"), initialJob = jobId) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = (currentSession = session, currentJob = initialJob) => (
    <QueryClientProvider client={client}>
      <SessionProvider session={currentSession}>
        <ManualMeasurementPanel jobId={currentJob} />
      </SessionProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    switchTo: (nextSession: typeof session, nextJob = initialJob) =>
      view.rerender(tree(nextSession, nextJob)),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fill(user = userEvent.setup()) {
  await user.type(await screen.findByLabelText("Area label"), "North roof");
  await user.type(screen.getByLabelText("Area (sq ft)"), "1200");
  await user.selectOptions(screen.getByLabelText("Area basis"), "roof_surface");
  await user.selectOptions(screen.getByLabelText("Measurement method"), "laser");
  return user;
}
const unknown = () => new ApiError({ status: 0, code: "timeout", message: "Timed out" });
beforeEach(() => {
  vi.resetAllMocks();
  router.search = {};
  router.navigate.mockImplementation(async ({ search }) => {
    router.search = typeof search === "function" ? search(router.search) : search;
    router.listeners.forEach((listener) => listener());
  });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  onlineManager.setOnline(true);
  reads();
  vi.mocked(recordManualMeasurement).mockImplementation(async (_session, _job, _input, id) =>
    receipt(id),
  );
});

describe("manual measurements", () => {
  it("requires an explicit basis/method and saves a numberless job with exact version and receipt readback", async () => {
    setup();
    expect(
      await screen.findByText("No manual observations have been recorded for this job."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Save observation" })).toBeDisabled();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Area label"), "North roof");
    await user.type(screen.getByLabelText("Area (sq ft)"), "1200");
    expect(screen.getByRole("button", { name: "Save observation" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Area basis"), "roof_surface");
    expect(screen.getByRole("button", { name: "Save observation" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Measurement method"), "laser");
    await user.click(screen.getByRole("button", { name: "Save observation" }));
    const saved = await screen.findByRole("region", { name: "Saved observation" });
    expect(within(saved).getByText("6 / 12")).toBeVisible(); // Server receipt, not the empty submitted pitch.
    expect(saved).toHaveFocus();
    expect(recordManualMeasurement).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: "appu_owner" }) }),
      jobId,
      {
        expected_job_version: 4,
        expected_observation_head: null,
        target: { new_area_label: "North roof" },
        area_sq_ft: 1200,
        area_basis: "roof_surface",
        pitch_rise_per_12: null,
        method: "laser",
        uncertainty: null,
        correction_reason: null,
      },
      expect.stringMatching(/^manual-measurement:/),
    );
    expect(router.search.measurementRequest).toBeTruthy();
    expect(screen.queryByText(/IW-/)).not.toBeInTheDocument();
  });

  it("accepts zero pitch alone without inventing an area basis", async () => {
    setup();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Area label"), "Flat addition");
    await user.type(screen.getByLabelText("Pitch (rise per 12)"), "0");
    await user.selectOptions(screen.getByLabelText("Measurement method"), "plans");
    await user.click(screen.getByRole("button", { name: "Save observation" }));
    await screen.findByText("Observation recorded");
    expect(vi.mocked(recordManualMeasurement).mock.calls[0]?.[2]).toMatchObject({
      area_sq_ft: null,
      area_basis: "unknown",
      pitch_rise_per_12: 0,
      method: "plans",
    });
  });

  it.each(["250001", "-1"])("does not submit area outside bounds: %s", async (area) => {
    setup();
    await fill();
    fireEvent.change(screen.getByLabelText("Area (sq ft)"), { target: { value: area } });
    expect(screen.getByRole("button", { name: "Save observation" })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Area label").closest("form")!);
    expect(recordManualMeasurement).not.toHaveBeenCalled();
  });

  it("requires a correction reason and preserves the original observation in history", async () => {
    const first = observation();
    reads(
      model({
        observation_head: oid,
        areas: [first],
        history: { items: [first], next_before: null },
      }),
    );
    setup();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Correct observation: North roof" }),
    );
    expect(screen.getByLabelText("Area (sq ft)")).toHaveValue(1200);
    expect(screen.getByLabelText("Correction reason")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();
    await user.clear(screen.getByLabelText("Area (sq ft)"));
    await user.type(screen.getByLabelText("Area (sq ft)"), "1210");
    await user.type(screen.getByLabelText("Correction reason"), "Eaves remeasured");
    await user.click(screen.getByRole("button", { name: "Save correction" }));
    await screen.findByText("Observation recorded");
    expect(vi.mocked(recordManualMeasurement).mock.calls[0]?.[2]).toMatchObject({
      target: { area_id: aid },
      expected_observation_head: oid,
      area_sq_ft: 1210,
      correction_reason: "Eaves remeasured",
    });
    expect(
      within(screen.getByLabelText("Observation history")).getByText("North roof · Revision 1"),
    ).toBeInTheDocument();
  });

  it("recovers a lost acknowledgement by exact receipt without another write", async () => {
    vi.mocked(recordManualMeasurement).mockRejectedValue(unknown());
    setup();
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Save observation" }));
    await screen.findByText("Save outcome unconfirmed");
    const id = router.search.measurementRequest!;
    reads(model({ requested_request_id: id, receipt: receipt(id).receipt }));
    await user.click(screen.getByRole("button", { name: "Check saved observation" }));
    expect(await screen.findByText("Observation recorded")).toBeVisible();
    expect(loadManualMeasurements).toHaveBeenLastCalledWith(jobId, { requestId: id });
    expect(recordManualMeasurement).toHaveBeenCalledTimes(1);
  });

  it("only retries after an explicit successful check, with the same immutable body and key", async () => {
    vi.mocked(recordManualMeasurement).mockRejectedValueOnce(unknown());
    setup();
    const user = await fill();
    await user.dblClick(screen.getByRole("button", { name: "Save observation" }));
    await screen.findByText("Save outcome unconfirmed");
    expect(recordManualMeasurement).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Retry same observation" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Area label")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check saved observation" }));
    await user.click(await screen.findByRole("button", { name: "Retry same observation" }));
    await screen.findByText("Observation recorded");
    expect(recordManualMeasurement).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordManualMeasurement).mock.calls[1]).toEqual(
      vi.mocked(recordManualMeasurement).mock.calls[0],
    );
  });

  it("keeps an uncertain identity locked even if a later retry receives a refusal", async () => {
    vi.mocked(recordManualMeasurement)
      .mockRejectedValueOnce(unknown())
      .mockRejectedValueOnce(
        new ApiError({ status: 409, code: "manual_measurement_head_stale", message: "Stale" }),
      );
    setup();
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Save observation" }));
    await screen.findByText("Save outcome unconfirmed");
    await user.click(screen.getByRole("button", { name: "Check saved observation" }));
    await user.click(await screen.findByRole("button", { name: "Retry same observation" }));
    await screen.findByText("Save outcome unconfirmed");
    expect(router.search.measurementRequest).toBeTruthy();
    expect(screen.queryByLabelText("Area label")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry same observation" }),
    ).not.toBeInTheDocument();
  });

  it("reads a receipt after reload and never resubmits from the URL", async () => {
    router.search = { measurementRequest: requestId };
    reads(model({ requested_request_id: requestId, receipt: receipt().receipt }));
    setup();
    expect(await screen.findByText("Observation recorded")).toBeVisible();
    expect(recordManualMeasurement).not.toHaveBeenCalled();
  });

  it("keeps a missing reloaded receipt unresolved without a retry body", async () => {
    router.search = { measurementRequest: requestId };
    setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check saved observation" })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Check saved observation" }));
    expect(await screen.findByText(/reopened without the original entry/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Retry same observation" }),
    ).not.toBeInTheDocument();
    expect(recordManualMeasurement).not.toHaveBeenCalled();
  });

  it("preserves a draft but requires explicit restart after a new head is read", async () => {
    setup();
    const user = await fill();
    reads(model({ observation_head: oid, areas: [observation()] }));
    await user.click(screen.getByRole("button", { name: "Refresh measurements" }));
    expect(await screen.findByText("Measurements changed while you were editing")).toBeVisible();
    expect(screen.getByLabelText("Area (sq ft)")).toHaveValue(1200);
    expect(screen.getByRole("button", { name: "Save observation" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Restart with current readings" }));
    expect(screen.getByLabelText("Area label")).toHaveValue("");
    expect(recordManualMeasurement).not.toHaveBeenCalled();
  });

  it("refreshes after a definite first-attempt CAS refusal instead of silently rebasing", async () => {
    vi.mocked(recordManualMeasurement).mockImplementation(async () => {
      reads(model({ observation_head: oid, areas: [observation()] }));
      throw new ApiError({ status: 409, code: "manual_measurement_head_stale", message: "Stale" });
    });
    setup();
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Save observation" }));
    expect(await screen.findByText("Measurements changed while you were editing")).toBeVisible();
    expect(router.search.measurementRequest).toBeUndefined();
    expect(screen.getByRole("button", { name: "Save observation" })).toBeDisabled();
    expect(recordManualMeasurement).toHaveBeenCalledTimes(1);
  });

  it.each(["sales", "owner"] as const)(
    "enforces %s role and current server permission",
    async (role) => {
      if (role === "owner") reads(model({ allowed_actions: [] }));
      setup(sessionFor(role));
      expect(await screen.findByText("Manual measurements are read-only")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Save observation" })).not.toBeInTheDocument();
      expect(recordManualMeasurement).not.toHaveBeenCalled();
    },
  );

  it("blocks live offline writes while retaining the draft", async () => {
    setup();
    await fill();
    act(() => {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
      window.dispatchEvent(new Event("offline"));
    });
    expect(await screen.findByText("Measurements are offline")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save observation" })).toBeDisabled();
    expect(screen.getByLabelText("Area label")).toHaveValue("North roof");
    expect(recordManualMeasurement).not.toHaveBeenCalled();
  });

  it("retains cached observations but blocks saving after a failed read", async () => {
    setup();
    const user = await fill();
    vi.mocked(loadManualMeasurements).mockRejectedValue(unknown());
    await user.click(screen.getByRole("button", { name: "Refresh measurements" }));
    expect(await screen.findByText("Manual measurements could not be refreshed")).toBeVisible();
    expect(screen.getByLabelText("Area label")).toHaveValue("North roof");
    expect(screen.getByRole("button", { name: "Save observation" })).toBeDisabled();
  });

  it("does not reveal a receipt from an old account after an in-flight save", async () => {
    const pending = deferred<ManualMeasurementResult>();
    vi.mocked(recordManualMeasurement).mockReturnValue(pending.promise);
    const view = setup();
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Save observation" }));
    await waitFor(() => expect(recordManualMeasurement).toHaveBeenCalledTimes(1));
    const id = router.search.measurementRequest!;
    view.switchTo(sessionFor("sales"));
    await act(async () => pending.resolve(receipt(id)));
    expect(screen.queryByText("Observation recorded")).not.toBeInTheDocument();
    expect(recordManualMeasurement).toHaveBeenCalledTimes(1);
  });

  it("resets the form when the job changes and ignores the old job read", async () => {
    const oldRead = deferred<ManualMeasurementsResponse>();
    vi.mocked(loadManualMeasurements).mockReturnValueOnce(oldRead.promise);
    const view = setup();
    const nextJob = "roof_job_other_manual";
    reads(model({ job: { id: nextJob, version: 1, job_number: null } }));
    view.switchTo(sessionFor("owner"), nextJob);
    await screen.findByLabelText("Area label");
    await act(async () => oldRead.resolve(model({ areas: [observation()] })));
    expect(screen.queryByText("North roof · Revision 1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Area label")).toHaveValue("");
  });

  it("rejects a receipt with a mismatched job instead of presenting success", async () => {
    vi.mocked(recordManualMeasurement).mockResolvedValue(
      receipt(requestId, observation({ job_id: "roof_job_somebody_else" })),
    );
    setup();
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Save observation" }));
    expect(await screen.findByText("Save outcome unconfirmed")).toBeVisible();
    expect(screen.queryByText("Observation recorded")).not.toBeInTheDocument();
  });

  it("returns focus to a new empty form after a confirmed receipt", async () => {
    setup();
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Save observation" }));
    await user.click(await screen.findByRole("button", { name: "Record another observation" }));
    const label = await screen.findByLabelText("Area label");
    await waitFor(() => expect(label).toHaveFocus());
    expect(label).toHaveValue("");
    expect(router.search.measurementRequest).toBeUndefined();
  });

  it("does not write if the connection disappears while the receipt URL is being set", async () => {
    const navigation = deferred<void>();
    router.navigate.mockImplementation(async ({ search }) => {
      router.search = search(router.search);
      router.listeners.forEach((listener) => listener());
      await navigation.promise;
    });
    setup();
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Save observation" }));
    act(() => {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
      window.dispatchEvent(new Event("offline"));
    });
    await act(async () => navigation.resolve());
    expect(await screen.findByText("Measurements are offline")).toBeVisible();
    expect(recordManualMeasurement).not.toHaveBeenCalled();
    expect(router.search.measurementRequest).toBeTruthy();
  });

  it("does not enable a retry from a failed receipt check", async () => {
    vi.mocked(recordManualMeasurement).mockRejectedValue(unknown());
    setup();
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Save observation" }));
    await screen.findByText("Save outcome unconfirmed");
    vi.mocked(loadManualMeasurements).mockRejectedValue(unknown());
    await user.click(screen.getByRole("button", { name: "Check saved observation" }));
    await screen.findByText("Manual measurements could not be refreshed");
    expect(
      screen.queryByRole("button", { name: "Retry same observation" }),
    ).not.toBeInTheDocument();
    expect(recordManualMeasurement).toHaveBeenCalledTimes(1);
  });

  it("loads older history by cursor and preserves the current page on an older-page error", async () => {
    const current = observation({
      sequence: 3,
      revision: 2,
      supersedes_observation_id: `mobs_${"2".repeat(64)}`,
      correction_reason: "Remeasured",
    });
    const first = model({
      areas: [current],
      observation_head: current.id,
      history: { items: [current], next_before: 3 },
    });
    reads(first);
    setup();
    const user = userEvent.setup();
    const history = await screen.findByLabelText("Observation history");
    await user.click(within(history).getByText("Observation history"));
    vi.mocked(loadManualMeasurements).mockRejectedValueOnce(unknown());
    await user.click(screen.getByRole("button", { name: "Load older observations" }));
    expect(await within(history).findByRole("alert")).toHaveTextContent(
      "History could not be loaded consistently",
    );
    expect(within(history).getByText("North roof · Revision 2")).toBeVisible();
    reads({
      ...first,
      history: { items: [observation({ id: `mobs_${"2".repeat(64)}` })], next_before: null },
    });
    await user.click(screen.getByRole("button", { name: "Load older observations" }));
    expect(await within(history).findByText("North roof · Revision 1")).toBeVisible();
    expect(loadManualMeasurements).toHaveBeenLastCalledWith(jobId, { before: 3 });
  });
});
