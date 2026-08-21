import { AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";

import { getDeviceSecret } from "../auth/device-credential";
import type { AuthenticatedSession } from "../auth/session";
import { OutboxStateBadge } from "../components/outbox-state-badge";
import { Button } from "../components/ui/button";
import { dateTimeFormatter } from "../lib/intl-cache";
import { isOutboxActionSafeToRetry, retryOutboxAction } from "../storage/outbox";
import { flushOutbox } from "../storage/outbox-processor";
import type { OutboxAction } from "../storage/outbox-types";
import { useOutboxActionsNeedingAttention } from "../storage/use-outbox";

export function SavedWorkRecoveryPanel({ session }: { session: AuthenticatedSession }) {
  const actions = useOutboxActionsNeedingAttention({
    tenantId: session.tenant.id,
    userId: session.user.id,
  });
  const [retryingActionId, setRetryingActionId] = useState<string>();
  const [retryError, setRetryError] = useState<Record<string, string>>({});

  if (actions.length === 0) return null;

  async function retry(action: OutboxAction) {
    setRetryingActionId(action.deviceActionId);
    setRetryError((current) => {
      const { [action.deviceActionId]: _cleared, ...rest } = current;
      return rest;
    });
    try {
      await retryOutboxAction(action.deviceActionId);
      if (navigator.onLine && session.csrf_token !== "offline-session-no-csrf") {
        await flushOutbox({
          tenantId: session.tenant.id,
          userId: session.user.id,
          csrfToken: session.csrf_token,
          deviceProof: getDeviceSecret,
        });
      }
    } catch (error) {
      setRetryError((current) => ({
        ...current,
        [action.deviceActionId]: messageFor(error),
      }));
    } finally {
      setRetryingActionId(undefined);
    }
  }

  return (
    <section
      id="saved-work"
      className="border-2 border-danger/55 bg-danger-soft/45 p-4 sm:p-5"
      aria-labelledby="saved-work-heading"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-danger">Saved work</p>
          <h2 id="saved-work-heading" className="mt-1 text-2xl font-black tracking-[-0.03em]">
            {actions.length === 1
              ? "One saved item needs review"
              : `${actions.length} saved items need review`}
          </h2>
          <p className="mt-2 max-w-3xl leading-6 text-muted">
            Each saved item and any attached files remain on this device. Review why it stopped
            before trying anything again.
          </p>
        </div>
      </div>

      <ol className="mt-5 space-y-3">
        {actions.map((action) => {
          const conflict = action.conflict;
          const retryable = isOutboxActionSafeToRetry(action);
          const busy = retryingActionId === action.deviceActionId;
          return (
            <li
              key={action.deviceActionId}
              className="border border-danger/25 bg-surface-raised p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-black">{actionLabel(action)}</h3>
                  <p className="mt-1 text-sm text-muted">
                    Saved {formatSavedAt(action.updatedAt, session.tenant.locale)}
                  </p>
                </div>
                <OutboxStateBadge state={action.state} />
              </div>

              <dl className="mt-4 border-y border-border/80 py-3 text-sm">
                <div className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
                  <dt className="font-semibold text-muted">Why it stopped</dt>
                  <dd className="leading-6">
                    {conflict
                      ? "The office copy changed after this item was saved."
                      : retryable
                        ? "The server could not take this item yet."
                        : "The office must check this item before it can send."}
                  </dd>
                </div>
              </dl>

              {conflict ? (
                <p className="mt-3 text-sm leading-6 text-danger" role="note">
                  The office copy changed. Keep this item saved. Ask the office to check both copies
                  before you make a new one.
                </p>
              ) : retryable ? (
                <div className="mt-4">
                  <Button
                    type="button"
                    size="compact"
                    variant="outline"
                    busy={busy}
                    onClick={() => void retry(action)}
                  >
                    <RefreshCw aria-hidden="true" />
                    Try again
                  </Button>
                  <p className="mt-2 text-sm leading-6 text-muted" role="status">
                    This only tries to send the same saved item again. It does not make a copy.
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-sm leading-6 text-muted" role="note">
                  Do not try again from this phone. Keep the item saved for the office.
                </p>
              )}
              {retryError[action.deviceActionId] ? (
                <p className="mt-3 text-sm font-semibold text-danger" role="alert">
                  {retryError[action.deviceActionId]}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const actionNames: Record<OutboxAction["kind"], string> = {
  field_checkin: "Field check-in",
  work_package_acknowledgement: "Work plan review",
  work_package_stop: "Stop Work report",
  safety_action: "Safety report",
  fleet_pre_trip_inspection: "Pre-trip inspection",
  fleet_post_trip_inspection: "Post-trip inspection",
  fleet_defect_report: "Fault report",
};

function actionLabel(action: OutboxAction): string {
  const workPackageId = workPackageIdFromPayload(action);
  const assetId = fleetAssetIdFromEndpoint(action.endpoint);
  const jobId = jobIdFromEndpoint(action.endpoint);
  return [
    actionNames[action.kind],
    workPackageId ? `plan ${workPackageId}` : null,
    assetId ? `vehicle ${assetId}` : null,
    jobId ? `job ${jobId}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

function workPackageIdFromPayload(action: OutboxAction): string | undefined {
  if (
    action.kind === "field_checkin" ||
    !action.payload ||
    Array.isArray(action.payload) ||
    typeof action.payload !== "object"
  ) {
    return undefined;
  }
  const workPackageId = action.payload.work_package_id;
  return typeof workPackageId === "string" && workPackageId.trim() ? workPackageId : undefined;
}

function jobIdFromEndpoint(endpoint: string): string | undefined {
  return pathSegment(endpoint, /^\/api\/v1\/jobs\/([^/]+)/);
}

function fleetAssetIdFromEndpoint(endpoint: string): string | undefined {
  return pathSegment(endpoint, /^\/api\/v1\/fleet\/assets\/([^/]+)/);
}

function pathSegment(endpoint: string, pattern: RegExp): string | undefined {
  const match = endpoint.match(pattern);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function formatSavedAt(value: number, locale: string): string {
  try {
    return dateTimeFormatter(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );
  } catch {
    return new Date(value).toLocaleString();
  }
}

function messageFor(_error: unknown): string {
  return "This item could not try again. Keep it saved and tell the office.";
}
