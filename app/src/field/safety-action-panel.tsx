import { AlertTriangle, LifeBuoy, ShieldAlert, Wrench } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { getDeviceSecret } from "../auth/device-credential";
import { isOfflineSession, type AuthenticatedSession } from "../auth/session";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { apiRequest, isRetryableApiError } from "../lib/api";
import { cacheFieldModel, getCachedFieldModel } from "./field-cache";
import { queueOutboxAction, saveOutboxAction } from "../storage/outbox";
import { flushOutbox } from "../storage/outbox-processor";
import type { JsonValue } from "../storage/outbox-types";
import {
  safetyBlockerLabels,
  safetyEquipmentStatusLabels,
  safetyOccurrenceKindLabels,
  safetyOccurrenceKinds,
  safetyPanelResponseSchema,
  safetySeverities,
  safetySeverityLabels,
  type SafetyActionKind,
  type SafetyActionPayload,
  type SafetyOccurrenceKind,
  type SafetyPanel,
  type SafetyScopeType,
  type SafetySeverity,
} from "./safety-contracts";

const SAFETY_ENDPOINT = "/api/v1/safety/actions";
const DETAIL_MAX_LENGTH = 4_000;

export interface SafetyActionPanelProps {
  session: AuthenticatedSession;
  /**
   * Where the worker currently is, when the app knows. The panel works without
   * it: an unassigned worker reports against the tenant.
   */
  scope?: { type: SafetyScopeType; id: string };
  fetcher?: typeof fetch;
}

type Draft =
  | { kind: "report_occurrence"; occurrenceKind: SafetyOccurrenceKind; severity: SafetySeverity }
  | { kind: "rescue_request" }
  | { kind: "make_safe"; occurrenceId: string }
  | { kind: "equipment_defect"; equipmentId: string };

/**
 * The global safety panel.
 *
 * It is mounted on every authenticated screen, not inside a job packet, because
 * the moment a worker most needs it is the moment they have no packet open, no
 * assignment, and no signal. Everything it submits is written to the durable
 * outbox first and uploaded afterwards, so a report survives a dead network, a
 * closed tab, and a dead battery.
 */
export function SafetyActionPanel({ session, scope, fetcher }: SafetyActionPanelProps) {
  const cacheKey = `${session.tenant.id}:${session.user.id}:safety-panel`;
  const [panel, setPanel] = useState<SafetyPanel>();
  const [draft, setDraft] = useState<Draft>();
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const detailId = useId();
  const subjectId = useId();
  const offlineSession = isOfflineSession(session);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = safetyPanelResponseSchema.shape.panel.safeParse(
        await getCachedFieldModel(cacheKey),
      );
      if (!cancelled && cached.success) setPanel(cached.data);
      try {
        const response = await apiRequest({
          path: "/api/v1/safety/panel",
          schema: safetyPanelResponseSchema,
          fetcher: fetcher ?? fetch,
          deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
        });
        if (cancelled) return;
        setPanel(response.panel);
        await cacheFieldModel(cacheKey, response.panel, null);
      } catch (caught) {
        // A panel that cannot refresh still renders from cache and still
        // accepts a report. Losing the network never removes the right.
        if (!cancelled && !isRetryableApiError(caught) && !cached.success) {
          setError("Safety information could not be loaded on this device yet.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, fetcher, session.user.role]);

  const activeScope = scope ?? { type: "tenant" as SafetyScopeType, id: session.tenant.id };
  const unserviceable = (panel?.assigned_equipment ?? []).filter(
    (item) => item.status !== "in_service",
  );
  const stops = (panel?.open_occurrences ?? []).filter((item) => item.stop_active);

  async function submit() {
    if (!draft) return;
    const trimmed = detail.trim();
    if (trimmed.length < 3) {
      setError("Describe what you saw in a few words before saving.");
      return;
    }
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const payload: SafetyActionPayload = {
        kind: draft.kind,
        scope_type: activeScope.type,
        scope_id: activeScope.id,
        captured_at: new Date().toISOString(),
        detail: trimmed.slice(0, DETAIL_MAX_LENGTH),
        ...(draft.kind === "report_occurrence"
          ? { occurrence_kind: draft.occurrenceKind, severity: draft.severity }
          : {}),
        ...(draft.kind === "make_safe" ? { occurrence_id: draft.occurrenceId.trim() } : {}),
        ...(draft.kind === "equipment_defect" ? { equipment_id: draft.equipmentId.trim() } : {}),
      };
      const saved = await saveOutboxAction({
        tenantId: session.tenant.id,
        userId: session.user.id,
        kind: "safety_action",
        endpoint: SAFETY_ENDPOINT,
        payload: payload as unknown as JsonValue,
      });
      await queueOutboxAction(saved.deviceActionId);
      setStatus(
        "Saved on this device. It uploads on its own and keeps the same record if you retry.",
      );
      setDraft(undefined);
      setDetail("");
      if (navigator.onLine && !offlineSession) {
        await flushOutbox({
          tenantId: session.tenant.id,
          userId: session.user.id,
          csrfToken: session.csrf_token,
          deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
          fetcher: fetcher ?? fetch,
        });
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "This report could not be saved on this device. Tell your supervisor directly.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="safety-actions"
      className="bg-surface p-4 sm:p-5"
      aria-labelledby="safety-actions-heading"
    >
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0">
          {/* The rail's summary already shows this title. Keep the heading for the
              region's accessible name without repeating it on screen. */}
          <h2 id="safety-actions-heading" className="sr-only">
            Safety
          </h2>
          <p className="mt-1 max-w-3xl leading-6 text-muted">
            Report a danger, make an area safe, mark equipment unsafe, or call for rescue. You can
            do this with no job open and no signal. Safety reports do not count against you.
          </p>
        </div>
      </div>

      {stops.length > 0 ? (
        <ul className="mt-4 space-y-2" aria-label="Active safety stops">
          {stops.map((stop) => (
            <li
              key={stop.occurrence_id}
              className="flex items-start gap-2 border border-danger/30 bg-danger-soft/40 p-3 text-sm leading-6"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
              <span>
                <strong className="font-bold">
                  {safetyBlockerLabels.safety_stop_active} ·{" "}
                  {safetyOccurrenceKindLabels[stop.occurrence_kind]}
                </strong>{" "}
                {stop.summary}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {unserviceable.length > 0 ? (
        <ul className="mt-3 space-y-2" aria-label="Equipment you cannot use">
          {unserviceable.map((item) => (
            <li
              key={item.equipment_id}
              className="flex items-start gap-2 border border-warning/35 bg-warning-soft/40 p-3 text-sm leading-6"
            >
              <Wrench className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              <span>
                <strong className="font-bold">
                  {item.equipment_kind.replaceAll("_", " ")} {item.serial_number}
                </strong>{" "}
                is {safetyEquipmentStatusLabels[item.status].toLowerCase()}. Do not use it.
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {panel?.my_corrective_actions.length ? (
        <section className="mt-4 space-y-2" aria-label="Your corrective actions">
          <h3 className="font-bold">Your corrective actions</h3>
          <ul className="space-y-2">
            {panel.my_corrective_actions.map((action) => (
              <li key={action.corrective_action_id} className="space-y-1 border p-3">
                <p className="break-all text-sm">{action.description}</p>
                <Button asChild variant="outline">
                  <a
                    href={`/safety/corrective-actions/${encodeURIComponent(action.corrective_action_id)}`}
                  >
                    Open corrective action
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        <Button
          type="button"
          variant="danger"
          size="field"
          fullWidth
          onClick={() => startDraft({ kind: "rescue_request" })}
        >
          <LifeBuoy aria-hidden="true" />
          Call for rescue
        </Button>
        <Button
          type="button"
          variant="outline"
          size="field"
          fullWidth
          onClick={() =>
            startDraft({
              kind: "report_occurrence",
              occurrenceKind: "hazard",
              severity: "high",
            })
          }
        >
          <ShieldAlert aria-hidden="true" />
          Report a hazard or injury
        </Button>
        <Button
          type="button"
          variant="outline"
          size="field"
          fullWidth
          onClick={() =>
            startDraft({
              kind: "make_safe",
              occurrenceId: panel?.open_occurrences[0]?.occurrence_id ?? "",
            })
          }
        >
          Record making it safe
        </Button>
        <Button
          type="button"
          variant="outline"
          size="field"
          fullWidth
          onClick={() =>
            startDraft({
              kind: "equipment_defect",
              equipmentId: panel?.assigned_equipment[0]?.equipment_id ?? "",
            })
          }
        >
          <Wrench aria-hidden="true" />
          Mark equipment unsafe
        </Button>
      </div>

      {draft ? (
        <form
          className="mt-5 space-y-4 border-t pt-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm font-bold">{draftHeading(draft.kind)}</p>

          {draft.kind === "report_occurrence" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-semibold">
                What happened
                <Select
                  field
                  className="mt-1"
                  value={draft.occurrenceKind}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      occurrenceKind: event.target.value as SafetyOccurrenceKind,
                    })
                  }
                >
                  {safetyOccurrenceKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {safetyOccurrenceKindLabels[kind]}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block text-sm font-semibold">
                How serious
                <Select
                  field
                  className="mt-1"
                  value={draft.severity}
                  onChange={(event) =>
                    setDraft({ ...draft, severity: event.target.value as SafetySeverity })
                  }
                >
                  {safetySeverities.map((severity) => (
                    <option key={severity} value={severity}>
                      {safetySeverityLabels[severity]}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
          ) : null}

          {draft.kind === "make_safe" ? (
            <label htmlFor={subjectId} className="block text-sm font-semibold">
              Which safety report
              <Input
                id={subjectId}
                className="mt-1"
                value={draft.occurrenceId}
                required
                onChange={(event) => setDraft({ ...draft, occurrenceId: event.target.value })}
              />
            </label>
          ) : null}

          {draft.kind === "equipment_defect" ? (
            <label htmlFor={subjectId} className="block text-sm font-semibold">
              Which item
              <Input
                id={subjectId}
                className="mt-1"
                value={draft.equipmentId}
                required
                onChange={(event) => setDraft({ ...draft, equipmentId: event.target.value })}
              />
            </label>
          ) : null}

          <label htmlFor={detailId} className="block text-sm font-semibold">
            What you saw
            <Textarea
              id={detailId}
              className="mt-1 min-h-32"
              maxLength={DETAIL_MAX_LENGTH}
              required
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" size="field" busy={busy}>
              Save and send
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="field"
              onClick={() => {
                setDraft(undefined);
                setDetail("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {status ? (
        <p className="mt-4 text-sm font-semibold leading-6 text-ok" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 text-sm font-semibold leading-6 text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );

  function startDraft(next: Draft) {
    setDraft(next);
    setDetail("");
    setStatus(undefined);
    setError(undefined);
  }
}

function draftHeading(kind: SafetyActionKind): string {
  return kind === "rescue_request"
    ? "Call for rescue"
    : kind === "report_occurrence"
      ? "Report a hazard or injury"
      : kind === "make_safe"
        ? "Record making it safe"
        : "Mark equipment unsafe";
}
