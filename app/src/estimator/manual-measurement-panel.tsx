import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { useOnlineStatus } from "../hooks/use-online-status";
import { ApiError } from "../lib/api";
import {
  loadManualMeasurements,
  newManualMeasurementRequestId,
  recordManualMeasurement,
} from "./manual-measurement-api";
import {
  manualMeasurementInputSchema,
  type ManualMeasurementInput,
  type ManualMeasurementReceipt,
  type ManualMeasurementsResponse,
  type ManualObservation,
} from "./manual-measurement-contracts";

type Draft = {
  areaId: string;
  label: string;
  area: string;
  basis: ManualMeasurementInput["area_basis"] | "";
  pitch: string;
  method: ManualMeasurementInput["method"] | "";
  uncertainty: string;
  reason: string;
};
const EMPTY: Draft = {
  areaId: "",
  label: "",
  area: "",
  basis: "",
  pitch: "",
  method: "",
  uncertainty: "",
  reason: "",
};
type Baseline = { version: number; head: string | null };
type Attempt = { requestId: string; input: ManualMeasurementInput };
const basisLabels = {
  roof_surface: "Roof surface",
  horizontal_plan: "Horizontal plan",
  unknown: "Unknown",
};
const REFUSALS = new Set([
  "invalid_manual_measurement",
  "invalid_manual_measurement_version",
  "invalid_manual_measurement_target",
  "invalid_manual_measurement_area",
  "invalid_manual_measurement_pitch",
  "invalid_manual_measurement_basis",
  "invalid_manual_measurement_method",
  "invalid_manual_measurement_uncertainty",
  "invalid_manual_measurement_correction_reason",
  "invalid_manual_measurement_request_id",
  "manual_measurement_required",
  "manual_measurement_correction_reason_required",
  "estimator_read_required",
  "manual_measurement_record_required",
  "csrf_failed",
  "tenant_identity_required",
  "manual_measurement_job_not_found",
  "manual_measurement_area_not_found",
  "manual_measurement_job_stale",
  "manual_measurement_head_stale",
  "manual_measurement_area_stale",
  "manual_measurement_area_conflict",
]);
function parseDraft(draft: Draft, baseline: Baseline) {
  return manualMeasurementInputSchema.safeParse({
    expected_job_version: baseline.version,
    expected_observation_head: baseline.head,
    target: draft.areaId ? { area_id: draft.areaId } : { new_area_label: draft.label.trim() },
    area_sq_ft: draft.area.trim() ? Number(draft.area) : null,
    area_basis: draft.area.trim() ? draft.basis : "unknown",
    pitch_rise_per_12: draft.pitch.trim() ? Number(draft.pitch) : null,
    method: draft.method,
    uncertainty: draft.uncertainty.trim() || null,
    correction_reason: draft.areaId ? draft.reason.trim() || null : null,
  });
}

export function ManualMeasurementPanel({ jobId }: { jobId: string }) {
  const session = useSession();
  // A draft and its recovery snapshot never cross jobs, accounts, tenants, or role changes.
  return (
    <ManualMeasurementContent
      key={`${session.tenant.id}:${session.user.id}:${session.user.role}:${jobId}`}
      jobId={jobId}
    />
  );
}

function ManualMeasurementContent({ jobId }: { jobId: string }) {
  const session = useSession();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { measurementRequest?: string };
  const requestId = search.measurementRequest;
  const online = useOnlineStatus();
  const offline = isOfflineSession(session) || !online;
  const client = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [confirmed, setConfirmed] = useState<ManualMeasurementReceipt | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [older, setOlder] = useState<{
    head: string | null;
    items: ManualObservation[];
    before: number | null;
  } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  const currentRequest = useRef(requestId);
  const readEpoch = useRef(0);
  const resultRef = useRef<HTMLDivElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const focusForm = useRef(false);
  const focusCorrection = useRef(false);
  useEffect(() => {
    currentRequest.current = requestId;
  }, [requestId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readEpoch.current += 1;
    };
  }, []);
  const queryKey = ["manual-measurements", session.tenant.id, session.user.id, jobId, requestId];
  function assertRead(
    result: ManualMeasurementsResponse,
    requested: string | null = requestId ?? null,
  ) {
    if (
      result.tenant_id !== session.tenant.id ||
      result.job.id !== jobId ||
      result.requested_request_id !== (requested ?? null)
    )
      throw new Error("Measurement identity mismatch");
    return result;
  }
  const query = useQuery({
    queryKey,
    queryFn: async () => assertRead(await loadManualMeasurements(jobId, { requestId })),
    enabled: !offline && !posting,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const data = query.data;
  const receipt = confirmed?.request_id === requestId ? confirmed : data?.receipt;
  const mayRecord =
    (session.user.role === "owner" || session.user.role === "ops") &&
    Boolean(data?.allowed_actions.includes("manual_measurement.record"));
  const fresh = Boolean(data) && !query.isError && !query.isFetching && !offline;
  const staleDraft = Boolean(
    baseline &&
    data &&
    (baseline.version !== data.job.version || baseline.head !== data.observation_head),
  );
  const unresolved = Boolean(requestId && !receipt);
  const activeOlder = older?.head === data?.observation_head ? older : null;
  const history = [...(data?.history.items ?? []), ...(activeOlder?.items ?? [])];
  const nextBefore = activeOlder ? activeOlder.before : data?.history.next_before;
  const validDraft =
    data &&
    parseDraft(draft, baseline ?? { version: data.job.version, head: data.observation_head })
      .success;

  const available = useRef({ offline, mayRecord });
  useEffect(() => {
    // Changing only the receipt query key temporarily removes query data while the
    // command is pending. It is not a permission revocation; a new read is authoritative.
    available.current = { offline, mayRecord: data ? mayRecord : available.current.mayRecord };
  }, [offline, mayRecord, data]);
  const receiptId = receipt?.request_id;
  useEffect(() => {
    if (receiptId) resultRef.current?.focus();
  }, [receiptId]);
  useEffect(() => {
    if (focusForm.current && !requestId && firstField.current) {
      firstField.current.focus();
      focusForm.current = false;
    }
    if (focusCorrection.current && reasonField.current) {
      reasonField.current.focus();
      focusCorrection.current = false;
    }
  }, [requestId, draft.areaId, query.isFetching]);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    if (!baseline && data) setBaseline({ version: data.job.version, head: data.observation_head });
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError(null);
  }
  function selectArea(areaId: string) {
    const area = data?.areas.find((item) => item.area_id === areaId);
    setDraft(
      area
        ? {
            areaId,
            label: area.area_label,
            area: area.area_sq_ft?.toString() ?? "",
            basis: area.area_basis,
            pitch: area.pitch_rise_per_12?.toString() ?? "",
            method: area.method,
            uncertainty: area.uncertainty ?? "",
            reason: "",
          }
        : EMPTY,
    );
    if (data) setBaseline({ version: data.job.version, head: data.observation_head });
    setError(null);
  }
  async function setRequest(value: string | undefined) {
    await navigate({
      to: "/estimator/jobs/$jobId",
      params: { jobId },
      search: (previous) => ({ ...previous, measurementRequest: value }),
      replace: true,
    });
  }
  async function send(snapshot: Attempt, initial: boolean) {
    if (lock.current || !mayRecord || !fresh || offline) return;
    lock.current = true;
    readEpoch.current += 1;
    setPosting(true);
    setChecked(null);
    setError(null);
    setAttempt(snapshot);
    currentRequest.current = snapshot.requestId;
    try {
      await client.cancelQueries({
        queryKey: ["manual-measurements", session.tenant.id, session.user.id, jobId],
      });
      if (initial) await setRequest(snapshot.requestId);
      if (!mounted.current || currentRequest.current !== snapshot.requestId) return;
      if (available.current.offline || !available.current.mayRecord) {
        setError(
          "Access or connection changed before this save started. Check the saved observation before trying the same request again.",
        );
        return;
      }
      const result = await recordManualMeasurement(
        session,
        jobId,
        snapshot.input,
        snapshot.requestId,
      );
      if (!mounted.current || currentRequest.current !== snapshot.requestId) return;
      if (
        result.tenant_id !== session.tenant.id ||
        result.job_id !== jobId ||
        result.receipt.request_id !== snapshot.requestId
      )
        throw new Error("Measurement receipt identity mismatch");
      await client.cancelQueries({
        queryKey: ["manual-measurements", session.tenant.id, session.user.id, jobId],
      });
      if (!mounted.current || currentRequest.current !== snapshot.requestId) return;
      setConfirmed(result.receipt);
      setDraft(EMPTY);
      setBaseline(null);
      setAttempt(null);
    } catch (failure) {
      if (mounted.current && currentRequest.current === snapshot.requestId) {
        // Only a first attempt can be unlocked by a definite pre-write refusal. A refusal
        // after an uncertain attempt says nothing about that earlier request's outcome.
        if (
          initial &&
          failure instanceof ApiError &&
          [400, 403, 404, 409].includes(failure.status) &&
          REFUSALS.has(failure.code)
        ) {
          currentRequest.current = undefined;
          setAttempt(null);
          await client.invalidateQueries({
            queryKey: ["manual-measurements", session.tenant.id, session.user.id, jobId],
            refetchType: "none",
          });
          await setRequest(undefined);
          if (mounted.current)
            setError(
              "The server refused this save. Refresh measurements and review the current job and observation before saving again.",
            );
        } else
          setError(
            "The save result could not be confirmed. Check the saved observation before trying the same request again.",
          );
      }
    } finally {
      if (mounted.current) {
        lock.current = false;
        setPosting(false);
      }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!data || unresolved || receipt || staleDraft || !fresh || !mayRecord) return;
    if (draft.area.trim() && !draft.basis) {
      setError("Choose the area basis, including Unknown if it was not established.");
      return;
    }
    const parsed = parseDraft(
      draft,
      baseline ?? { version: data.job.version, head: data.observation_head },
    );
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the measurement fields.");
      return;
    }
    void send({ requestId: newManualMeasurementRequestId(), input: parsed.data }, true);
  }
  async function check() {
    if (lock.current || offline) return;
    setChecked(null);
    const epoch = ++readEpoch.current;
    const expected = requestId;
    const result = await query.refetch();
    if (!mounted.current || epoch !== readEpoch.current || currentRequest.current !== expected)
      return;
    if (!result.error && result.data && expected) {
      assertRead(result.data, expected);
      setChecked(expected);
      setError(null);
    }
  }
  async function another() {
    if (!receipt || lock.current) return;
    currentRequest.current = undefined;
    readEpoch.current += 1;
    setConfirmed(null);
    setChecked(null);
    setAttempt(null);
    setDraft(EMPTY);
    setBaseline(null);
    setError(null);
    focusForm.current = true;
    await setRequest(undefined);
  }
  async function moreHistory() {
    if (!data || !nextBefore || historyBusy || offline || query.isFetching) return;
    setHistoryBusy(true);
    setHistoryError(null);
    const epoch = readEpoch.current;
    const head = data.observation_head;
    try {
      const result = assertRead(await loadManualMeasurements(jobId, { before: nextBefore }), null);
      if (!mounted.current || epoch !== readEpoch.current) return;
      if (result.observation_head !== head || result.job.version !== data.job.version)
        throw new Error("History changed");
      setOlder({
        head,
        items: [...(activeOlder?.items ?? []), ...result.history.items],
        before: result.history.next_before,
      });
    } catch {
      if (mounted.current && epoch === readEpoch.current)
        setHistoryError(
          "History could not be loaded consistently. Refresh measurements before continuing.",
        );
    } finally {
      if (mounted.current) setHistoryBusy(false);
    }
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="min-w-0 space-y-5 border-t border-border pt-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`${id}-title`} className="text-lg font-bold">
            Manual measurements
          </h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            Record observed area or pitch for this job. Observations do not alter geometry, takeoff,
            or approved quotes.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void check()}
          disabled={offline || posting || query.isFetching}
        >
          Refresh measurements
        </Button>
      </div>
      {offline ? (
        <Notice tone="warning" title="Measurements are offline">
          Reconnect to read current measurements or save. Unsaved entries stay only in this open
          page.
        </Notice>
      ) : null}
      {query.isPending && !data && !offline ? (
        <p role="status">Loading manual measurements…</p>
      ) : null}
      {query.isError ? (
        <Notice tone="danger" title="Manual measurements could not be refreshed">
          Current access or records could not be verified. Saving is unavailable until a successful
          refresh.
        </Notice>
      ) : null}
      {error && !receipt ? (
        <Notice
          tone="danger"
          title={unresolved ? "Save outcome unconfirmed" : "Check the observation"}
        >
          {error}
        </Notice>
      ) : null}
      {receipt ? (
        <div
          ref={resultRef}
          tabIndex={-1}
          role="region"
          aria-label="Saved observation"
          className="space-y-3 outline-none"
        >
          <Notice tone="success" title="Observation recorded">
            This is the saved receipt for this request. The current area may have a later
            correction.
          </Notice>
          <Observation observation={receipt.observation} />
          <Button variant="secondary" onClick={() => void another()} disabled={posting}>
            Record another observation
          </Button>
        </div>
      ) : unresolved ? (
        <div className="space-y-3">
          <Notice
            tone="warning"
            title={posting ? "Saving observation" : "Check this request’s saved result"}
          >
            {posting
              ? "The original request is in progress."
              : "A missing receipt is not confirmation that a save failed. No new request will be sent automatically."}
          </Notice>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => void check()}
              disabled={offline || posting || query.isFetching}
            >
              Check saved observation
            </Button>
            {attempt && attempt.requestId === requestId && checked === requestId && !receipt ? (
              <Button
                onClick={() => void send(attempt, false)}
                disabled={!mayRecord || !fresh || posting}
              >
                Retry same observation
              </Button>
            ) : null}
          </div>
          {attempt?.requestId !== requestId ? (
            <p className="text-sm text-muted">
              This page was reopened without the original entry. Check the receipt; do not create a
              replacement while its outcome is unresolved.
            </p>
          ) : null}
        </div>
      ) : data ? (
        <>
          {!mayRecord ? (
            <Notice tone="info" title="Manual measurements are read-only">
              Recording requires owner or operations access and permission for this job.
            </Notice>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {staleDraft ? (
                <Notice
                  tone="warning"
                  title="Measurements changed while you were editing"
                  actions={
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={!fresh}
                      onClick={() => selectArea(draft.areaId)}
                    >
                      Restart with current readings
                    </Button>
                  }
                >
                  Review the current observations below. Restarting replaces this form with the
                  latest saved readings.
                </Notice>
              ) : null}
              <fieldset
                disabled={!fresh || posting || staleDraft}
                className="grid min-w-0 gap-4 sm:grid-cols-2 [&_input]:font-normal [&_select]:font-normal [&_textarea]:font-normal"
              >
                <legend className="mb-3 font-semibold">
                  {draft.areaId ? "Correct observation" : "Record observation"}
                </legend>
                <label className="space-y-1 text-sm font-semibold sm:col-span-2">
                  Area target
                  <Select value={draft.areaId} onChange={(event) => selectArea(event.target.value)}>
                    <option value="">New area</option>
                    {data.areas.map((area) => (
                      <option key={area.area_id} value={area.area_id}>
                        {area.area_label} — correction
                      </option>
                    ))}
                  </Select>
                </label>
                {!draft.areaId ? (
                  <label className="space-y-1 text-sm font-semibold sm:col-span-2">
                    Area label
                    <Input
                      ref={firstField}
                      value={draft.label}
                      maxLength={120}
                      required
                      onChange={(event) => update("label", event.target.value)}
                    />
                  </label>
                ) : null}
                <label className="space-y-1 text-sm font-semibold">
                  Area (sq ft)
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0.000001"
                    max="250000"
                    step="any"
                    value={draft.area}
                    onChange={(event) => update("area", event.target.value)}
                  />
                </label>
                <label className="space-y-1 text-sm font-semibold">
                  Area basis
                  <Select
                    value={draft.basis}
                    onChange={(event) => update("basis", event.target.value as Draft["basis"])}
                  >
                    <option value="">Choose basis</option>
                    {Object.entries(basisLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="space-y-1 text-sm font-semibold">
                  Pitch (rise per 12)
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max="24"
                    step="any"
                    value={draft.pitch}
                    onChange={(event) => update("pitch", event.target.value)}
                  />
                </label>
                <label className="space-y-1 text-sm font-semibold">
                  Measurement method
                  <Select
                    value={draft.method}
                    onChange={(event) => update("method", event.target.value as Draft["method"])}
                  >
                    <option value="">Choose method</option>
                    <option value="tape">Tape</option>
                    <option value="laser">Laser</option>
                    <option value="plans">Plans</option>
                    <option value="drone">Drone</option>
                  </Select>
                </label>
                <p className="text-sm text-muted sm:col-span-2">
                  Provide area, pitch, or both. Area must be greater than 0 and no more than 250,000
                  sq ft; pitch can be 0–24 per 12. Pitch alone does not establish area.
                </p>
                <label className="space-y-1 text-sm font-semibold sm:col-span-2">
                  Uncertainty or limitations
                  <Textarea
                    value={draft.uncertainty}
                    maxLength={500}
                    onChange={(event) => update("uncertainty", event.target.value)}
                  />
                </label>
                {draft.areaId ? (
                  <label className="space-y-1 text-sm font-semibold sm:col-span-2">
                    Correction reason
                    <Textarea
                      ref={reasonField}
                      required
                      minLength={3}
                      maxLength={500}
                      value={draft.reason}
                      onChange={(event) => update("reason", event.target.value)}
                    />
                  </label>
                ) : null}
              </fieldset>
              <Button type="submit" disabled={!fresh || posting || staleDraft || !validDraft}>
                {draft.areaId ? "Save correction" : "Save observation"}
              </Button>
            </form>
          )}
          <section aria-label="Current observations" className="space-y-3">
            <h4 className="font-semibold">Current observations</h4>
            {data.areas.length === 0 ? (
              <p className="text-sm text-muted">
                No manual observations have been recorded for this job.
              </p>
            ) : (
              data.areas.map((area) => (
                <div key={area.id} className="space-y-2 border-t border-border py-4">
                  <Observation observation={area} />
                  {mayRecord ? (
                    <Button
                      className="whitespace-normal text-left"
                      type="button"
                      variant="secondary"
                      disabled={!fresh}
                      onClick={() => {
                        focusCorrection.current = true;
                        selectArea(area.area_id);
                      }}
                    >
                      Correct observation: {area.area_label}
                    </Button>
                  ) : null}
                </div>
              ))
            )}
          </section>
        </>
      ) : null}
      {data && history.length > 0 ? (
        <details aria-label="Observation history" className="min-w-0 border-t border-border py-4">
          <summary className="cursor-pointer font-semibold">Observation history</summary>
          <ol className="mt-4 space-y-4">
            {history.map((item) => (
              <li key={item.id} className="border-t border-border pt-3">
                <Observation observation={item} />
              </li>
            ))}
          </ol>
          {historyError ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {historyError}
            </p>
          ) : null}
          {nextBefore ? (
            <Button
              className="mt-4"
              variant="secondary"
              disabled={offline || historyBusy || query.isFetching}
              onClick={() => void moreHistory()}
            >
              Load older observations
            </Button>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

function Observation({ observation }: { observation: ManualObservation }) {
  const { tenant } = useSession();
  // Two readings of one area are told apart by when they were recorded, never by a revision number.
  const recorded = new Intl.DateTimeFormat(tenant.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: tenant.time_zone,
  }).format(new Date(observation.recorded_at));
  return (
    <div className="min-w-0 space-y-2 text-sm leading-6">
      <p className="font-semibold break-words">
        {observation.area_label} · recorded {recorded}
      </p>
      <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-muted">Observed area</dt>
          <dd>
            {observation.area_sq_ft === null
              ? "Not recorded"
              : `${observation.area_sq_ft.toLocaleString()} sq ft`}{" "}
            · {basisLabels[observation.area_basis]}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Observed pitch</dt>
          <dd>
            {observation.pitch_rise_per_12 === null
              ? "Not recorded"
              : `${observation.pitch_rise_per_12} / 12`}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Method</dt>
          <dd className="capitalize">{observation.method}</dd>
        </div>
        <div>
          <dt className="text-muted">Recorded</dt>
          <dd className="break-words">
            {observation.recorded_at} · {observation.recorded_by}
          </dd>
        </div>
      </dl>
      {observation.uncertainty ? (
        <p className="break-words">
          <span className="font-semibold">Uncertainty: </span>
          {observation.uncertainty}
        </p>
      ) : null}
      {observation.correction_reason ? (
        <p className="break-words">
          <span className="font-semibold">Correction: </span>
          {observation.correction_reason}
        </p>
      ) : null}
    </div>
  );
}
