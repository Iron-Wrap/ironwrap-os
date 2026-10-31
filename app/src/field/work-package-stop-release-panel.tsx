import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";

import { isOfflineSession, type AuthenticatedSession } from "../auth/session";
import { Button } from "../components/ui/button";
import { useOnlineStatus } from "../hooks/use-online-status";
import { ApiError, apiRequest } from "../lib/api";
import { deleteMeta, getMeta, setMeta } from "../storage/db";
import { afterFailedSend } from "./work-plan-intent";
import type { JobResponse } from "./field-contracts";
import { formatFieldStamp } from "./field-formatting";

// These are projections of the existing person-only stop-releases route, not a new release rule.
const releaseSchema = z.object({
  release_id: z.string().min(1),
  work_package_id: z.string().min(1),
  work_package_version: z.number().int().positive(),
  stop_event_id: z.string().min(1),
});
const readSchema = z.object({
  work_package: z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    job_id: z.string().min(1),
    status: z.string(),
  }),
  current_stop: z
    .object({
      stop_event_id: z.string().min(1),
      stop_actor_user_id: z.string().min(1),
      occurred_at: z.string().min(1),
      blocker_reason: z.string().nullable(),
    })
    .nullable(),
  releases: z.array(releaseSchema),
});
const answerSchema = z.object({
  device_action_id: z.string().min(1),
  status: z.literal("verified"),
  release: releaseSchema,
});

type Plan = NonNullable<JobResponse["packet"]["work_package"]>;
const intentSchema = z.object({
  key: z.string().min(8),
  body: z.object({
    work_package_version: z.number().int().positive(),
    stop_event_id: z.string().min(8),
    reason: z.string().min(1).max(4000),
    evidence_ids: z
      .array(z.string().regex(/^evi_[0-9a-f]{32}$/))
      .min(1)
      .max(10),
  }),
});
type Intent = z.infer<typeof intentSchema>;

export function WorkPackageStopReleasePanel({
  session,
  workPackage,
  jobId,
  activeStops,
  offline,
  onReleased,
}: {
  session: AuthenticatedSession;
  workPackage: Plan;
  jobId: string;
  activeStops: JobResponse["active_stops"];
  offline: boolean;
  onReleased: () => Promise<void>;
}) {
  const connected = useOnlineStatus();
  const online = connected && !offline && !isOfflineSession(session);
  const authorizedRole = ["owner", "ops", "production"].includes(session.user.role);
  const [opened, setOpened] = useState(false);
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const path = `/api/v1/work-packages/${encodeURIComponent(workPackage.id)}/stop-releases`;
  const storageKey = `job-plan-stop-release:${session.tenant.id}:${session.user.id}:${path}`;
  useEffect(() => {
    let active = true;
    void getMeta<unknown>(storageKey).then(
      (saved) => {
        if (!active) return;
        if (saved !== undefined) {
          const intent = intentSchema.safeParse(saved);
          if (!intent.success) {
            setError(
              "A saved release request could not be read. Keep work stopped; do not send another release from this device.",
            );
            return;
          }
          setPending(intent.data);
          setReason(intent.data.body.reason);
          setSelected(intent.data.body.evidence_ids);
          setOpened(true);
          setError(
            "An earlier release is not confirmed on this page. Retry the same release to check its saved result.",
          );
        }
        setRestored(true);
      },
      () => {
        if (active)
          setError(
            "This device could not read saved release requests. Keep work stopped and reload the page before trying again.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [storageKey]);
  const read = () => apiRequest({ path, schema: readSchema });
  const query = useQuery({
    queryKey: [
      "job-plan-stop-release",
      session.tenant.id,
      session.user.id,
      workPackage.id,
      workPackage.version,
    ],
    queryFn: read,
    enabled: opened && online && authorizedRole,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 0,
  });
  const head = query.data?.work_package;
  const stop = query.data?.current_stop;
  const current = Boolean(
    head &&
    stop &&
    head.id === workPackage.id &&
    head.version === workPackage.version &&
    head.job_id === jobId &&
    head.status === "Blocked",
  );
  const ownStop = Boolean(
    stop &&
    [session.user.id, session.user.email, session.user.frappe_user_id].includes(
      stop.stop_actor_user_id,
    ),
  );
  const eligible =
    current && stop
      ? workPackage.evidence_slots.filter(
          (item) =>
            item.verification === "Verified" &&
            !item.superseded &&
            /^evi_[0-9a-f]{32}$/.test(item.evidence_item) &&
            Date.parse(item.captured_at) > Date.parse(stop.occurred_at),
        )
      : [];
  const proofIds = [...new Set(selected)].filter((id) =>
    eligible.some((item) => item.evidence_item === id),
  );
  const otherStops = Boolean(
    stop && activeStops.some((item) => item.occurrence_id !== stop.stop_event_id),
  );
  const dates = { locale: session.tenant.locale, timeZone: session.tenant.time_zone };
  const canRelease =
    restored &&
    online &&
    current &&
    !ownStop &&
    !query.isError &&
    !query.isFetching &&
    proofIds.length > 0 &&
    proofIds.length <= 10 &&
    reason.trim().length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !restored || !online || (!pending && !canRelease) || (!pending && !stop))
      return;
    // A lost answer retains the exact intent and key. Editing never creates a second release.
    const intent = pending ?? {
      key: crypto.randomUUID(),
      body: {
        work_package_version: workPackage.version,
        stop_event_id: stop!.stop_event_id,
        reason: reason.trim(),
        evidence_ids: proofIds,
      },
    };
    sending.current = true;
    setPending(intent);
    setBusy(true);
    setError(null);
    let accepted = false;
    let recorded = false;
    let sent = false;
    const resend = pending !== null;
    try {
      // Storage must succeed before the POST, so reload and a lost answer keep the same request.
      await setMeta(storageKey, intent);
      sent = true;
      const answer = await apiRequest({
        path,
        method: "POST",
        schema: answerSchema,
        csrfToken: session.csrf_token,
        idempotencyKey: intent.key,
        deviceActionId: intent.key,
        body: intent.body,
      });
      accepted = true;
      if (
        answer.device_action_id !== intent.key ||
        answer.release.work_package_id !== workPackage.id ||
        answer.release.work_package_version !== intent.body.work_package_version ||
        answer.release.stop_event_id !== intent.body.stop_event_id
      ) {
        throw new Error("stop_release_answer_mismatch");
      }
      const fresh = (await query.refetch({ throwOnError: true })).data!;
      if (
        !fresh.releases.some(
          (item) =>
            item.release_id === answer.release.release_id &&
            item.work_package_id === workPackage.id &&
            item.work_package_version === intent.body.work_package_version &&
            item.stop_event_id === intent.body.stop_event_id,
        )
      ) {
        throw new Error("stop_release_readback_missing");
      }
      recorded = true;
      await deleteMeta(storageKey);
      setPending(null);
      setDone(true);
      await onReleased();
    } catch (caught) {
      const refused = !accepted && sent && afterFailedSend(caught, resend) === "drop";
      if (recorded) {
        setError(
          "The release is recorded, but the job could not be reloaded. Keep work stopped until current job details are available. Reload the job.",
        );
      } else if (!sent) {
        setError(
          "The release request could not be kept on this device. Nothing was sent. Retry the same release after device storage is available.",
        );
      } else if (refused && caught instanceof ApiError) {
        try {
          await deleteMeta(storageKey);
          setPending(null);
        } catch {
          // Keeping a refused exact request is safe; do not replace it while storage is unavailable.
        }
        setError(releaseRefusal(caught));
        void query.refetch();
      } else {
        setError(
          "The release is not confirmed on this page. Keep work stopped. Retry the same release to check its saved result.",
        );
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  if (!authorizedRole) return null;
  return (
    <section
      id="job-plan-stop-release"
      aria-labelledby="job-plan-stop-release-heading"
      className="scroll-mt-4 space-y-3 border-2 border-warning/45 bg-warning-soft p-4 sm:p-5"
    >
      <h2 id="job-plan-stop-release-heading" className="text-xl font-bold">
        Release this plan’s stop
      </h2>
      <p>
        Work stays stopped until an owner, operations or production person who did not report this
        stop records its release with verified proof of the correction.
      </p>
      <p className="text-sm">
        This releases only the crew stop on this job plan. Other safety stops and work checks still
        apply. It does not start work.
      </p>
      {!online ? (
        <p role="status">Go online to review this stop. No release can be sent offline.</p>
      ) : null}
      {!opened ? (
        <Button type="button" variant="outline" disabled={!online} onClick={() => setOpened(true)}>
          Review stop for release
        </Button>
      ) : null}
      {opened && query.isPending ? <p role="status">Loading the current stop…</p> : null}
      {opened && query.isError ? (
        <p role="alert">
          The current stop could not be loaded. Keep work stopped and reload the stop.
        </p>
      ) : null}
      {opened ? (
        <Button
          type="button"
          variant="outline"
          disabled={!online || busy || Boolean(pending)}
          onClick={() => {
            setDone(false);
            setSelected([]);
            setReason("");
            void query.refetch();
          }}
        >
          Reload stop
        </Button>
      ) : null}
      {opened && query.data && !current && !done ? (
        <p role="alert">
          This plan or its stop has changed. Reload the job before reviewing a release.
        </p>
      ) : null}
      {opened && (pending || (stop && current)) && !done ? (
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <p className="font-semibold">
            Stopped {stop ? formatFieldStamp(stop.occurred_at, dates) : "on this plan"} ·{" "}
            {stop?.blocker_reason ??
              "No reason was given. Ask the crew what happened before release."}
          </p>
          {otherStops ? (
            <p role="status">
              A separate safety stop also holds this job. This release will not clear it.
            </p>
          ) : null}
          {ownStop ? (
            <p role="alert">
              You reported this stop. A different authorized person must review and release it.
            </p>
          ) : null}
          {pending ? (
            <p>
              This retry checks the stop named in your saved request. It cannot release a newer
              stop.
            </p>
          ) : null}
          <fieldset disabled={busy || Boolean(pending) || ownStop} className="space-y-3">
            <legend className="font-bold">
              Verified proof captured after this stop (choose 1–10)
            </legend>
            {eligible.length === 0 ? (
              <p>
                No verified proof captured after this stop is available on this plan. Keep work
                stopped. The correction needs verified photos or notes before release.
              </p>
            ) : (
              eligible.map((item) => (
                <label
                  key={item.event_id}
                  className="flex items-start gap-3 border border-border bg-surface p-3"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.includes(item.evidence_item)}
                    onChange={(event) =>
                      setSelected((old) =>
                        event.target.checked
                          ? [...old, item.evidence_item]
                          : old.filter((id) => id !== item.evidence_item),
                      )
                    }
                  />
                  <span>
                    {item.requirement} · Captured {formatFieldStamp(item.captured_at, dates)}
                  </span>
                </label>
              ))
            )}
            <label htmlFor="job-plan-stop-release-reason" className="block font-bold">
              What was corrected and why is this stop safe to release? (required)
            </label>
            <textarea
              id="job-plan-stop-release-reason"
              className="min-h-28 w-full border bg-surface p-3"
              required
              maxLength={4000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="text-sm">
              Record the follow-up with the crew and the correction shown by the selected proof. The
              server checks your authority and independence before recording the release.
            </p>
          </fieldset>
          <Button
            type="submit"
            variant="outline"
            busy={busy}
            disabled={!restored || !online || (!pending && !canRelease)}
          >
            {pending ? "Retry same release" : "Record release of this plan’s stop"}
          </Button>
        </form>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {done ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void onReleased().then(
              () => setError(null),
              () =>
                setError(
                  "The release is recorded, but job details are still unavailable. Keep work stopped and try Reload job details again.",
                ),
            );
          }}
        >
          Reload job details
        </Button>
      ) : null}
      {done ? (
        <p role="status">
          {query.data?.current_stop
            ? "The earlier stop’s release is recorded. Another stop now holds this plan. Work stays stopped; reload the stop to review it."
            : "The release is recorded and checked. Reloaded job details determine the next action; other stops and work checks still apply."}
        </p>
      ) : null}
    </section>
  );
}

function releaseRefusal(error: ApiError): string {
  if (error.code === "work_package_stop_release_independence_required")
    return "You raised or reported this stop. A different authorized person must release it. Work stays stopped.";
  if (
    error.code === "work_package_stop_release_person_required" ||
    error.code === "work_package_stop_release_role_required"
  )
    return "Only an owner, operations or production person using their own signed-in account may release this stop. Work stays stopped.";
  if (error.code.startsWith("work_package_stop_release_evidence"))
    return "The selected proof cannot release this stop. Use verified proof captured after the stop. Work stays stopped.";
  return "The release was refused. Reload the stop and review its current details before trying again. Work stays stopped.";
}
