import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Car, ShieldCheck, Truck, Wrench } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { getDeviceSecret } from "../auth/device-credential";
import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { Textarea } from "../components/ui/textarea";
import { apiRequest, ApiError, isRetryableApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { queueOutboxAction, saveOutboxAction } from "../storage/outbox";
import { flushOutbox } from "../storage/outbox-processor";
import type { JsonValue, OutboxActionKind } from "../storage/outbox-types";
import { cacheFieldModel, getCachedFieldModel } from "./field-cache";
import {
  checkPointsForAsset,
  fleetBlockerMessage,
  fleetCollisionEndpoint,
  fleetCollisionResponseSchema,
  fleetDefectEndpoint,
  fleetVerifiedActionSchema,
  fleetDefectSeverities,
  newFleetCollisionId,
  fleetDefectSeverityLabels,
  fleetInspectionEndpoint,
  fleetItemResultLabels,
  fleetItemResults,
  fleetPanelResponseSchema,
  fleetRefusalMessage,
  type FleetDefectSeverity,
  type FleetInspectionKind,
  type FleetItemResult,
  type FleetPanelAsset,
  type FleetPanelResponse,
} from "./fleet-contracts";
import { formatFieldSchedule, type FieldDateOptions } from "./field-formatting";
import { SavedWorkRecoveryPanel } from "./saved-work-recovery-panel";
import { uploadFleetPhotoEvidence } from "./fleet-photo";

const OBSERVATION_MAX_LENGTH = 1_200;
const DESCRIPTION_MAX_LENGTH = 1_200;

interface ChecklistRow {
  checkPoint: string;
  result: FleetItemResult;
  severity: FleetDefectSeverity;
  observation: string;
}

type Draft =
  | { kind: "pre_trip" | "post_trip"; rows: ChecklistRow[]; meterReading: string }
  | { kind: "defect"; severity: FleetDefectSeverity; description: string; photos: File[] }
  | { kind: "collision"; severity: FleetDefectSeverity; description: string };

/**
 * The driver's own vehicle.
 *
 * The capture rail (pre-trip, post-trip, defect) has existed since IRO-54 with
 * nothing calling it. This is the screen that calls it, and it is deliberately
 * built for one thumb at the side of a truck: one asset in view at a time, one
 * decision per check point, and every refusal said in words rather than as the
 * policy code the fence raises.
 *
 * Every capture is written to the durable outbox first and uploaded afterwards,
 * exactly like a check-in or a safety report, so a walk-around done in a yard
 * with no signal is never lost.
 */
export function FleetPage() {
  const session = useSession();
  const cacheKey = `${session.tenant.id}:${session.user.id}:fleet-panel`;
  const [selectedAssetId, setSelectedAssetId] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const selectId = useId();
  const meterId = useId();
  const descriptionId = useId();
  const offlineSession = isOfflineSession(session);
  const dateOptions: FieldDateOptions = {
    locale: session.tenant.locale,
    timeZone: session.tenant.time_zone,
  };

  const query = useQuery({
    queryKey: ["fleet-panel", session.tenant.id, session.user.id],
    queryFn: () => loadFleetPanel(session.user.role === "field", cacheKey),
  });

  const assets = useMemo(() => query.data?.assets ?? [], [query.data]);
  const asset = assets.find((row) => row.id === selectedAssetId) ?? assets[0];

  if (query.isPending) return <LoadingState label="Loading your vehicle…" />;
  if (query.isError) {
    return (
      <ErrorState
        message="Your vehicle list could not be loaded on this device yet."
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6 pb-4">
      <header className="border-b pb-5">
        <p className="text-sm font-semibold text-muted">Field Companion</p>
        <h1 className="mt-1 text-3xl font-bold tracking-[-0.03em]">Vehicle</h1>
        <p className="mt-2 leading-6 text-muted">
          Record a pre-trip, a post-trip, or a fault on the vehicle or equipment you hold. These
          save on this device first and go up on their own.
        </p>
      </header>

      <SavedWorkRecoveryPanel session={session} />

      {!asset ? (
        <EmptyState
          title="Nothing is signed out to you"
          message="No vehicle, trailer, or equipment is in your custody and no load names you as its driver. Ask dispatch to sign one out to you."
        />
      ) : (
        <>
          {assets.length > 1 ? (
            <label htmlFor={selectId} className="block text-sm font-bold">
              Which one
              <Select
                field
                id={selectId}
                className="mt-1"
                value={asset.id}
                onChange={(event) => {
                  setSelectedAssetId(event.target.value);
                  resetDraft();
                }}
              >
                {assets.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.display_name}
                    {row.unit_number ? ` · ${row.unit_number}` : ""}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}

          <AssetSummary asset={asset} dateOptions={dateOptions} />
          <DispatchStatus asset={asset} />

          {draft ? null : (
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                variant="accent"
                size="field"
                fullWidth
                onClick={() => startInspection("pre_trip", asset)}
              >
                <ShieldCheck aria-hidden="true" />
                Pre-trip inspection
              </Button>
              <Button
                type="button"
                variant="outline"
                size="field"
                fullWidth
                onClick={() => startInspection("post_trip", asset)}
              >
                <Truck aria-hidden="true" />
                Post-trip inspection
              </Button>
              <Button
                type="button"
                variant="outline"
                size="field"
                fullWidth
                className="sm:col-span-2"
                onClick={() =>
                  startDraft({ kind: "defect", severity: "Minor", description: "", photos: [] })
                }
              >
                <Wrench aria-hidden="true" />
                Report a fault
              </Button>
              <Button
                type="button"
                variant="outline"
                size="field"
                fullWidth
                className="sm:col-span-2"
                onClick={() =>
                  startDraft({ kind: "collision", severity: "Major", description: "" })
                }
              >
                <Car aria-hidden="true" />
                Report a collision
              </Button>
            </div>
          )}

          {draft?.kind === "defect" ? (
            <form
              className="space-y-4 border-t pt-5"
              aria-label="Report a fault"
              onSubmit={(event) => {
                event.preventDefault();
                void submitDefect(asset, draft);
              }}
            >
              <h2 className="text-xl font-bold tracking-[-0.025em]">Report a fault</h2>
              <label className="block text-sm font-bold">
                How bad is it
                <Select
                  field
                  className="mt-1"
                  value={draft.severity}
                  onChange={(event) =>
                    setDraft({ ...draft, severity: event.target.value as FleetDefectSeverity })
                  }
                >
                  {fleetDefectSeverities.map((severity) => (
                    <option key={severity} value={severity}>
                      {fleetDefectSeverityLabels[severity]}
                    </option>
                  ))}
                </Select>
              </label>
              <OutOfServiceWarning active={draft.severity === "Out of Service"} />
              <label htmlFor={descriptionId} className="block text-sm font-bold">
                What is wrong
                <Textarea
                  id={descriptionId}
                  className="mt-1 min-h-32"
                  maxLength={DESCRIPTION_MAX_LENGTH}
                  required
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <label className="block text-sm font-bold">
                Photos
                <input
                  className="mt-1 block w-full text-sm"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                  multiple
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])].slice(0, 4);
                    setDraft({ ...draft, photos: files });
                  }}
                />
              </label>
              {draft.photos.length > 0 ? (
                <p className="text-sm leading-6 text-muted">
                  {draft.photos.length === 1
                    ? "1 photo selected. It uploads when you have signal, then the fault goes up as JSON."
                    : `${draft.photos.length} photos selected. They upload when you have signal, then the fault goes up as JSON.`}
                </p>
              ) : (
                <p className="text-sm leading-6 text-muted">
                  Photos are optional. They never ride the offline outbox. Only JSON references do.
                </p>
              )}
              <FormActions busy={busy} onCancel={resetDraft} label="Save and send fault" />
            </form>
          ) : null}

          {draft?.kind === "collision" ? (
            <form
              className="space-y-4 border-t pt-5"
              aria-label="Report a collision"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCollision(asset, draft);
              }}
            >
              <h2 className="mt-1 text-xl font-bold tracking-[-0.025em]">Report a collision</h2>
              <p className="leading-6 text-muted">
                This is a vehicle incident, not a worker injury or near-miss. Those stay on the
                safety report.
              </p>
              <label className="block text-sm font-bold">
                How bad is it
                <Select
                  field
                  className="mt-1"
                  value={draft.severity}
                  onChange={(event) => {
                    const severity = parseFleetDefectSeverity(event.target.value);
                    if (severity) setDraft({ ...draft, severity });
                  }}
                >
                  {fleetDefectSeverities.map((severity) => (
                    <option key={severity} value={severity}>
                      {fleetDefectSeverityLabels[severity]}
                    </option>
                  ))}
                </Select>
              </label>
              <label htmlFor={`${descriptionId}-collision`} className="block text-sm font-bold">
                What happened
                <Textarea
                  id={`${descriptionId}-collision`}
                  className="mt-1 min-h-32"
                  maxLength={DESCRIPTION_MAX_LENGTH}
                  required
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </label>
              <FormActions busy={busy} onCancel={resetDraft} label="Save and send collision" />
            </form>
          ) : null}

          {draft && (draft.kind === "pre_trip" || draft.kind === "post_trip") ? (
            <form
              className="space-y-5 border-t pt-5"
              aria-label={
                draft.kind === "pre_trip" ? "Pre-trip inspection" : "Post-trip inspection"
              }
              onSubmit={(event) => {
                event.preventDefault();
                void submitInspection(asset, draft);
              }}
            >
              <h2 className="text-xl font-bold tracking-[-0.025em]">
                {draft.kind === "pre_trip" ? "Pre-trip inspection" : "Post-trip inspection"}
              </h2>
              <p className="leading-6 text-muted">
                Walk around it and mark every point. A fault needs a note and how bad it is.
              </p>

              <ol className="space-y-4">
                {draft.rows.map((row, index) => (
                  <ChecklistItem
                    key={row.checkPoint}
                    row={row}
                    index={index}
                    onChange={(next) =>
                      setDraft({
                        ...draft,
                        rows: draft.rows.map((current, position) =>
                          position === index ? next : current,
                        ),
                      })
                    }
                  />
                ))}
              </ol>

              <OutOfServiceWarning
                active={draft.rows.some(
                  (row) => row.result === "Fail" && row.severity === "Out of Service",
                )}
              />

              {asset.meter_kind ? (
                <label htmlFor={meterId} className="block text-sm font-bold">
                  {asset.meter_kind} (optional)
                  <Input
                    id={meterId}
                    className="mt-1"
                    inputMode="decimal"
                    value={draft.meterReading}
                    onChange={(event) => setDraft({ ...draft, meterReading: event.target.value })}
                  />
                </label>
              ) : null}

              <FormActions busy={busy} onCancel={resetDraft} label="Save and send inspection" />
            </form>
          ) : null}

          {status ? (
            <p className="text-sm font-semibold leading-6 text-ok" role="status">
              {status}
            </p>
          ) : null}
          {error ? (
            <p className="text-sm font-semibold leading-6 text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );

  function resetDraft() {
    setDraft(undefined);
    setStatus(undefined);
    setError(undefined);
  }

  function startDraft(next: Draft) {
    setDraft(next);
    setStatus(undefined);
    setError(undefined);
  }

  function startInspection(kind: FleetInspectionKind, target: FleetPanelAsset) {
    startDraft({
      kind,
      meterReading: "",
      rows: checkPointsForAsset(target.asset_kind).map((checkPoint) => ({
        checkPoint,
        result: "Pass" as FleetItemResult,
        severity: "Minor" as FleetDefectSeverity,
        observation: "",
      })),
    });
  }

  async function submitInspection(
    target: FleetPanelAsset,
    inspection: Extract<Draft, { kind: "pre_trip" | "post_trip" }>,
  ) {
    const missingNote = inspection.rows.find(
      (row) => row.result === "Fail" && row.observation.trim().length < 3,
    );
    if (missingNote) {
      setError(`Say what is wrong with "${missingNote.checkPoint}" before saving.`);
      return;
    }
    const meterReading = inspection.meterReading.trim();
    if (meterReading && !isNonNegativeNumber(meterReading)) {
      setError("The meter reading has to be a number of zero or more.");
      return;
    }
    await submit({
      kind:
        inspection.kind === "pre_trip" ? "fleet_pre_trip_inspection" : "fleet_post_trip_inspection",
      endpoint: fleetInspectionEndpoint(target.fleet_asset_id, inspection.kind),
      payload: {
        fleet_asset_id: target.fleet_asset_id,
        performed_at: new Date().toISOString(),
        ...(meterReading ? { meter_reading: Number(meterReading) } : {}),
        items: inspection.rows.map((row, index) => ({
          sequence: index + 1,
          check_point: row.checkPoint,
          result: row.result,
          ...(row.result === "Fail"
            ? {
                severity: row.severity,
                observation: row.observation.trim().slice(0, OBSERVATION_MAX_LENGTH),
              }
            : {}),
        })),
      },
      savedMessage:
        "Inspection saved on this device. It goes up on its own and keeps the same record if you retry.",
    });
  }

  async function submitDefect(target: FleetPanelAsset, defect: Extract<Draft, { kind: "defect" }>) {
    const description = defect.description.trim();
    if (description.length < 3) {
      setError("Say what is wrong in a few words before saving.");
      return;
    }
    let photoEvidence: Awaited<ReturnType<typeof uploadFleetPhotoEvidence>>[] = [];
    if (defect.photos.length > 0) {
      if (!navigator.onLine || offlineSession) {
        setError("Photos attach when you have signal. Save the fault without them, or wait.");
        return;
      }
      try {
        photoEvidence = [];
        for (const file of defect.photos) {
          photoEvidence.push(
            await uploadFleetPhotoEvidence({
              fleetAssetId: target.fleet_asset_id,
              file,
              csrfToken: session.csrf_token,
              deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
            }),
          );
        }
      } catch (caught) {
        setError(refusalMessage(caught));
        return;
      }
    }
    const payload = {
      fleet_asset_id: target.fleet_asset_id,
      detected_at: new Date().toISOString(),
      severity: defect.severity,
      description: description.slice(0, DESCRIPTION_MAX_LENGTH),
      ...(photoEvidence.length > 0 ? { photo_evidence: photoEvidence } : {}),
    };
    if (photoEvidence.length > 0) {
      await submitPhotoDefect(target, payload, defect.severity);
      return;
    }
    await submit({
      kind: "fleet_defect_report",
      endpoint: fleetDefectEndpoint(target.fleet_asset_id),
      payload,
      savedMessage:
        defect.severity === "Out of Service"
          ? "Fault saved on this device. Do not use this one. It goes up on its own."
          : "Fault saved on this device. It goes up on its own and keeps the same record if you retry.",
    });
  }

  async function submitPhotoDefect(
    target: FleetPanelAsset,
    payload: Record<string, unknown>,
    severity: FleetDefectSeverity,
  ) {
    const deviceActionId = crypto.randomUUID();
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      await apiRequest({
        path: fleetDefectEndpoint(target.fleet_asset_id),
        schema: fleetVerifiedActionSchema,
        method: "POST",
        csrfToken: session.csrf_token,
        deviceActionId,
        idempotencyKey: deviceActionId,
        deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
        body: {
          device_action_id: deviceActionId,
          payload,
        },
      });
      setStatus(
        severity === "Out of Service"
          ? "Fault and photos recorded. Do not use this one."
          : "Fault and photos recorded. The outbox never carried the images.",
      );
      setDraft(undefined);
      await query.refetch();
    } catch (caught) {
      setError(refusalMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitCollision(
    target: FleetPanelAsset,
    collision: Extract<Draft, { kind: "collision" }>,
  ) {
    const description = collision.description.trim();
    if (description.length < 3) {
      setError("Say what happened in a few words before saving.");
      return;
    }
    if (!navigator.onLine || offlineSession) {
      setError("A collision report needs a connection. It is not queued through the JSON outbox.");
      return;
    }
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      await apiRequest({
        path: fleetCollisionEndpoint(target.fleet_asset_id),
        schema: fleetCollisionResponseSchema,
        method: "POST",
        csrfToken: session.csrf_token,
        deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
        body: {
          collision_id: newFleetCollisionId(),
          occurred_at: new Date().toISOString(),
          severity: collision.severity,
          description: description.slice(0, DESCRIPTION_MAX_LENGTH),
        },
      });
      setStatus("Collision recorded. This is a vehicle incident, not a safety occurrence.");
      setDraft(undefined);
    } catch (caught) {
      setError(refusalMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submit(input: {
    kind: OutboxActionKind;
    endpoint: string;
    payload: JsonValue;
    savedMessage: string;
  }) {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const saved = await saveOutboxAction({
        tenantId: session.tenant.id,
        userId: session.user.id,
        kind: input.kind,
        endpoint: input.endpoint,
        payload: input.payload,
      });
      await queueOutboxAction(saved.deviceActionId);
      setStatus(input.savedMessage);
      setDraft(undefined);
      if (navigator.onLine && !offlineSession) {
        await flushOutbox({
          tenantId: session.tenant.id,
          userId: session.user.id,
          csrfToken: session.csrf_token,
          deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
        });
        // A capture that verified may have changed what the fence says about
        // this asset - a passing pre-trip clears an overdue inspection, an
        // out-of-service fault grounds it - so re-read rather than leave a
        // stale verdict on screen.
        await query.refetch();
      }
    } catch (caught) {
      setError(refusalMessage(caught));
    } finally {
      setBusy(false);
    }
  }
}

function AssetSummary({
  asset,
  dateOptions,
}: {
  asset: FleetPanelAsset;
  dateOptions: FieldDateOptions;
}) {
  return (
    <div className="border bg-surface-raised p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-[-0.03em]">{asset.display_name}</h2>
          <p className="mt-1 text-sm text-muted">
            {[
              asset.asset_kind,
              asset.unit_number ? `Unit ${asset.unit_number}` : null,
              asset.licence_plate,
              asset.relationship === "custody" ? "Signed out to you" : "You are its driver",
            ]
              .filter((value): value is string => Boolean(value))
              .join(" · ")}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex min-h-9 items-center rounded-full border px-3 text-sm font-bold",
            asset.status === "Active"
              ? "border-ok/35 bg-ok-soft text-ok"
              : "border-danger/35 bg-danger-soft text-danger",
          )}
        >
          {asset.status}
        </span>
      </div>
      <dl className="mt-4 grid gap-3 border-t pt-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-muted">Last pre-trip</dt>
          <dd className="mt-0.5 leading-6">
            {asset.last_pre_trip_at
              ? formatFieldSchedule(asset.last_pre_trip_at, dateOptions)
              : "None recorded"}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-muted">Last post-trip</dt>
          <dd className="mt-0.5 leading-6">
            {asset.last_post_trip_at
              ? formatFieldSchedule(asset.last_post_trip_at, dateOptions)
              : "None recorded"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function DispatchStatus({ asset }: { asset: FleetPanelAsset }) {
  if (asset.blockers.length === 0) {
    return (
      <p
        className="flex items-start gap-2 border border-ok/35 bg-ok-soft/40 p-4 leading-6"
        role="status"
      >
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <span>
          <strong className="font-bold">Cleared to go out.</strong> Nothing on its record stops it
          being scheduled today.
        </span>
      </p>
    );
  }
  return (
    <section
      className="border-2 border-danger/45 bg-danger-soft/40 p-4 sm:p-5"
      aria-labelledby="fleet-blockers-heading"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="fleet-blockers-heading" className="text-xl font-bold tracking-[-0.025em]">
            This one cannot go out yet
          </h2>
          <p className="mt-1 leading-6 text-muted">
            Dispatch will refuse it for the reasons below. You can still record what you find on it.
          </p>
        </div>
      </div>
      <ul className="mt-4 space-y-2">
        {asset.blockers.map((blocker) => (
          <li
            key={blocker.code}
            className="border border-danger/25 bg-surface-raised p-3 leading-6"
          >
            {fleetBlockerMessage(blocker)}
          </li>
        ))}
      </ul>
      {asset.out_of_service_reason ? (
        <p className="mt-3 text-sm leading-6 text-muted">
          Office note: {asset.out_of_service_reason}
        </p>
      ) : null}
    </section>
  );
}

function ChecklistItem({
  row,
  index,
  onChange,
}: {
  row: ChecklistRow;
  index: number;
  onChange: (next: ChecklistRow) => void;
}) {
  const groupName = `check-point-${index}`;
  return (
    <li className="border bg-surface-raised p-4">
      <fieldset>
        <legend className="font-bold">{row.checkPoint}</legend>
        <div className="mt-3 grid auto-cols-fr grid-flow-col gap-2">
          {fleetItemResults.map((result) => (
            <label
              key={result}
              className={cn(
                "flex min-h-14 cursor-pointer items-center justify-center rounded-lg border px-2 text-center text-base font-bold",
                row.result === result
                  ? result === "Fail"
                    ? "border-danger bg-danger-soft text-danger"
                    : "border-accent bg-accent text-accent-foreground"
                  : "bg-surface text-muted",
              )}
            >
              <input
                type="radio"
                className="sr-only"
                name={groupName}
                value={result}
                checked={row.result === result}
                onChange={() => onChange({ ...row, result })}
              />
              {fleetItemResultLabels[result]}
            </label>
          ))}
        </div>
        {row.result === "Fail" ? (
          <div className="mt-4 space-y-3">
            <label className="block text-sm font-bold">
              How bad is it
              <Select
                field
                className="mt-1"
                value={row.severity}
                onChange={(event) =>
                  onChange({ ...row, severity: event.target.value as FleetDefectSeverity })
                }
              >
                {fleetDefectSeverities.map((severity) => (
                  <option key={severity} value={severity}>
                    {fleetDefectSeverityLabels[severity]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block text-sm font-bold">
              What you found
              <Textarea
                className="mt-1"
                maxLength={OBSERVATION_MAX_LENGTH}
                required
                value={row.observation}
                onChange={(event) => onChange({ ...row, observation: event.target.value })}
              />
            </label>
          </div>
        ) : null}
      </fieldset>
    </li>
  );
}

function OutOfServiceWarning({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <p
      className="flex items-start gap-2 border-2 border-danger/45 bg-danger-soft/40 p-4 leading-6"
      role="note"
    >
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
      <span>
        <strong className="font-bold">This parks it straight away.</strong> Nothing on this device
        can put it back on the road. That takes a repair and a return-to-service inspection.
      </span>
    </p>
  );
}

function FormActions({
  busy,
  onCancel,
  label,
}: {
  busy: boolean;
  onCancel: () => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant="accent" size="field" busy={busy}>
        {label}
      </Button>
      <Button type="button" variant="ghost" size="field" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/**
 * The panel refreshes online and falls back to the last copy this device saw.
 * A driver in a shop with no signal still needs to know which asset to capture
 * against; losing the network must not remove the screen.
 */
async function loadFleetPanel(
  fieldRole: boolean,
  cacheKey: string,
  fetcher: typeof fetch = fetch,
): Promise<FleetPanelResponse> {
  try {
    const model = await apiRequest({
      path: "/api/v1/fleet/panel",
      schema: fleetPanelResponseSchema,
      fetcher,
      deviceProof: fieldRole ? getDeviceSecret : undefined,
    });
    await cacheFieldModel(cacheKey, model, model.read_model_generated_at);
    return model;
  } catch (error) {
    const cached = fleetPanelResponseSchema.safeParse(await getCachedFieldModel(cacheKey));
    if (cached.success) {
      return {
        ...cached.data,
        stale_fields: [...cached.data.stale_fields, "offline.cached_panel"],
      };
    }
    throw error;
  }
}

function refusalMessage(error: unknown): string {
  const fallback =
    error instanceof Error
      ? error.message
      : "This could not be saved on this device. Tell your supervisor directly.";
  if (error instanceof ApiError) {
    return fleetRefusalMessage(
      error.code,
      isRetryableApiError(error)
        ? "The office could not be reached. Your work is saved on this device and goes up on its own."
        : fallback,
    );
  }
  return fallback;
}

function isNonNegativeNumber(value: string): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

function parseFleetDefectSeverity(value: string): FleetDefectSeverity | null {
  for (const severity of fleetDefectSeverities) {
    if (severity === value) return severity;
  }
  return null;
}
