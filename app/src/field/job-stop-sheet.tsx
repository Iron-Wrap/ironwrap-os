import { Camera, Phone } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { getDeviceSecret } from "../auth/device-credential";
import { isOfflineSession, type AuthenticatedSession } from "../auth/session";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { apiRequest } from "../lib/api";
import { messageFor } from "../lib/plain-error";
import { getOutboxAction, queueOutboxAction, saveOutboxAction } from "../storage/outbox";
import { flushOutbox } from "../storage/outbox-processor";
import type { JsonValue } from "../storage/outbox-types";
import {
  loadRaisedStop,
  occurrenceIdFor,
  saveRaisedStop,
  stopTime,
  type RaisedStop,
  type StopJob,
} from "./job-stop";
import { safetyPanelResponseSchema, type SafetyActionPayload } from "./safety-contracts";

const SAFETY_ENDPOINT = "/api/v1/safety/actions";
const DETAIL_MAX_LENGTH = 4_000;
const DETAIL_MIN_LENGTH = 3;
/** How often an unsent stop looks again for the office's answer while the sheet is open. */
const DELIVERY_RECHECK_MS = 5_000;
/** The safety panel read returns at most this many open stops (safety-lifecycle.ts, panel read). */
const OPEN_STOPS_READ_LIMIT = 50;

/** Saved on the phone, not yet confirmed by the office (the panel's own words for this). */
const SAVED_ON_DEVICE =
  "Saved on this device. It uploads on its own and keeps the same record if you retry.";
/** The office refused it or the phone could not send it (the panel's own words for this). */
const NOT_CONFIRMED =
  "This phone could not confirm it saved this report. Tell your supervisor directly.";

/** `unresolved`: the office has it, but the job it names was not found, so it holds every job. */
type Delivery = "saved" | "sent" | "unresolved" | "attention";

/**
 * Stop work on one job from a crew phone (P33 S20), then say the area is safe (S23). Every action
 * goes to the durable outbox first, so a stop survives no signal; the stop is scoped to this job,
 * never the whole company. A stop whose job the office could not find holds every job, and says so
 * (S21, `scope_unresolved`).
 *
 * `onStage` tells the host which view shows, so it can keep its own 911 call beside the made-safe
 * view (S20 carries its own).
 */
export function JobStopSheet({
  session,
  job,
  fetcher,
  onStage,
}: {
  session: AuthenticatedSession;
  job: StopJob;
  fetcher?: typeof fetch;
  onStage?: (stage: "loading" | "stop" | "stopped") => void;
}) {
  const [raised, setRaised] = useState<RaisedStop>();
  // Until this phone has looked for a stop it already raised, offer nothing: never a second stop.
  const [loaded, setLoaded] = useState(false);
  // S21 is read and closed with Done, which leads on to the made-safe step; S21 comes back on the
  // next open while the stop holds.
  const [acknowledged, setAcknowledged] = useState(false);
  const [delivery, setDelivery] = useState<Delivery>("saved");
  const [unsafe, setUnsafe] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const unsafeId = useId();
  const doneId = useId();
  const timeZone = session.tenant.time_zone;

  useEffect(() => {
    onStage?.(!loaded ? "loading" : raised ? "stopped" : "stop");
  }, [loaded, raised, onStage]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stop = await loadRaisedStop(session, job.id);
      const answer = stop ? await deliveryOf(stop.deviceActionId) : undefined;
      if (cancelled) return;
      setLoaded(true);
      if (!stop || !answer) return;
      // A stop the office refused is not in force: offer the stop again, and say why.
      if (answer === "attention") {
        await forgetStop(session, job.id, stop);
        setError(NOT_CONFIRMED);
        return;
      }
      // Show the stop at once, so nobody raises it twice while the office's read is on its way.
      setRaised(stop);
      setDelivery(answer);
      // A stop the office has lifted is over: the job offers a new stop again.
      const delivered = answer === "sent" || answer === "unresolved";
      if (delivered && (await stopLifted(session, stop.occurrenceId, fetcher))) {
        await forgetStop(session, job.id, stop);
        if (!cancelled) setRaised((current) => (current === stop ? undefined : current));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, job.id, fetcher]);

  // While the stop waits on this phone, look again for the office's answer.
  useEffect(() => {
    if (!raised || delivery !== "saved") return;
    const timer = window.setInterval(() => {
      void deliveryOf(raised.deviceActionId).then(async (answer) => {
        if (answer !== "attention") return setDelivery(answer);
        await forgetStop(session, job.id, raised);
        setRaised(undefined);
        setError(NOT_CONFIRMED);
      });
    }, DELIVERY_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [raised, delivery, session, job.id]);

  async function record(payload: SafetyActionPayload): Promise<string> {
    const saved = await saveOutboxAction({
      tenantId: session.tenant.id,
      userId: session.user.id,
      kind: "safety_action",
      endpoint: SAFETY_ENDPOINT,
      payload: payload as unknown as JsonValue,
    });
    await queueOutboxAction(saved.deviceActionId);
    if (navigator.onLine && !isOfflineSession(session)) {
      await flushOutbox({
        tenantId: session.tenant.id,
        userId: session.user.id,
        csrfToken: session.csrf_token,
        deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
        fetcher: fetcher ?? fetch,
      });
    }
    return saved.deviceActionId;
  }

  async function sendStop() {
    setBusy(true);
    setError(undefined);
    try {
      const words = unsafe.trim().slice(0, DETAIL_MAX_LENGTH);
      const sent = words.length >= DETAIL_MIN_LENGTH ? words : null;
      const raisedAt = new Date().toISOString();
      // With no words the phone still sends a stop: the Worker needs a detail, kind and severity.
      const deviceActionId = await record({
        kind: "report_occurrence",
        scope_type: "roof_job",
        scope_id: job.id,
        captured_at: raisedAt,
        detail: sent ?? `Work stopped on ${job.code}`,
        occurrence_kind: "hazard",
        severity: "high",
      });
      const stop: RaisedStop = {
        deviceActionId,
        occurrenceId: await occurrenceIdFor(deviceActionId),
        raisedAt,
        unsafe: sent,
      };
      const answer = await deliveryOf(deviceActionId);
      if (answer === "attention") {
        // Refused at once (a word the office does not take): the stop is not in force.
        setError(NOT_CONFIRMED);
        return;
      }
      await saveRaisedStop(session, job.id, stop);
      setAcknowledged(false);
      setRaised(stop);
      setDelivery(answer);
    } catch (caught) {
      setError(messageFor(caught, { fallback: NOT_CONFIRMED }));
    } finally {
      setBusy(false);
    }
  }

  async function madeSafe() {
    if (!raised) return;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const words = done.trim().slice(0, DETAIL_MAX_LENGTH);
      await record({
        kind: "make_safe",
        scope_type: "roof_job",
        scope_id: job.id,
        captured_at: new Date().toISOString(),
        detail: words.length >= DETAIL_MIN_LENGTH ? words : `Area made safe on ${job.code}`,
        occurrence_id: raised.occurrenceId,
      });
      const stop = { ...raised, madeSafeAt: new Date().toISOString() };
      await saveRaisedStop(session, job.id, stop);
      setRaised(stop);
      setDone("");
      setStatus(SAVED_ON_DEVICE);
    } catch (caught) {
      setError(messageFor(caught, { fallback: NOT_CONFIRMED }));
    } finally {
      setBusy(false);
    }
  }

  const jobLine = job.address ? `Job ${job.code}, ${job.address}` : `Job ${job.code}`;

  if (!loaded) return null;

  if (raised && delivery === "unresolved" && !acknowledged) {
    return (
      <section className="space-y-3" aria-label="Stop work">
        <Notice
          tone="danger"
          title="Work is stopped on every job: this stop's job wasn't found. The office is told and fixes the job on it."
        />
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm">
          {["Stop", stopTime(raised.raisedAt, timeZone), session.user.display_name, raised.unsafe]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {/* The frame names the owner; no read gives a crew phone that name yet. */}
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm">
          Job: not found · The owner fixes it
        </p>
        <Button type="button" size="field" onClick={() => setAcknowledged(true)}>
          Done
        </Button>
      </section>
    );
  }

  if (raised) {
    return (
      <section className="space-y-3" aria-label="Work stopped">
        {delivery === "sent" ? (
          <Notice tone="info" title="Stop sent. When the area is safe, say so here." />
        ) : delivery === "attention" ? (
          <Notice tone="danger" title={NOT_CONFIRMED} />
        ) : delivery === "saved" ? (
          <Notice tone="local" title={SAVED_ON_DEVICE} />
        ) : null}
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm">
          {["Stop", stopTime(raised.raisedAt, timeZone), raised.unsafe, jobLine]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {raised.madeSafeAt ? null : (
          <label htmlFor={doneId} className="block text-sm text-muted">
            What you did (optional)
            <Input
              id={doneId}
              className="mt-1"
              value={done}
              maxLength={DETAIL_MAX_LENGTH}
              onChange={(event) => setDone(event.target.value)}
            />
          </label>
        )}
        <p className="text-sm">This doesn't restart work. The office releases the stop.</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary" size="field">
            <a href={`/check-in/${encodeURIComponent(job.id)}`}>
              <Camera aria-hidden="true" />
              Take photo
            </a>
          </Button>
          {raised.madeSafeAt ? null : (
            <Button type="button" size="field" busy={busy} onClick={() => void madeSafe()}>
              I've made the area safe
            </Button>
          )}
        </div>
        {status ? (
          <p className="text-sm font-semibold text-ok" role="status">
            {status}
          </p>
        ) : null}
        {error ? (
          <p className="text-sm font-semibold text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <form
      className="space-y-3"
      aria-label="Stop work"
      onSubmit={(event) => {
        event.preventDefault();
        void sendStop();
      }}
    >
      <p className="rounded-md bg-surface-muted px-3 py-2 text-sm">
        {job.address ? `Job ${job.code} · ${job.address}` : `Job ${job.code}`}
      </p>
      <label htmlFor={unsafeId} className="block text-sm text-muted">
        What is unsafe (optional)
        <Input
          id={unsafeId}
          className="mt-1"
          value={unsafe}
          maxLength={DETAIL_MAX_LENGTH}
          onChange={(event) => setUnsafe(event.target.value)}
        />
      </label>
      <p className="text-sm">
        {`Sending stops work on job ${job.code} on every crew phone until the office releases it.`}
      </p>
      <p className="text-sm">
        Emergency: call 911. Stopping work is always OK. You never get in trouble for it.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="secondary" size="field">
          <a href="tel:911">
            <Phone aria-hidden="true" />
            Call 911
          </a>
        </Button>
        <Button type="submit" size="field" busy={busy}>
          Send stop report
        </Button>
      </div>
      {error ? (
        <p className="text-sm font-semibold text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** Clears the kept stop, but only if it is still this one: a stop raised meanwhile stays. */
async function forgetStop(session: AuthenticatedSession, jobId: string, stop: RaisedStop) {
  const kept = await loadRaisedStop(session, jobId);
  if (kept?.deviceActionId === stop.deviceActionId) await saveRaisedStop(session, jobId, null);
}

/** Whether the office has the stop yet, or it needs a person. */
async function deliveryOf(deviceActionId: string): Promise<Delivery> {
  const action = await getOutboxAction(deviceActionId);
  if (action?.state === "verified")
    return action.verification?.scopeUnresolved ? "unresolved" : "sent";
  if (action?.state === "needs_attention") return "attention";
  return "saved";
}

/**
 * True only when the office's own read says this stop no longer holds work. With no signal, or a
 * read that fails, the stop stays on screen: a stop is never cleared on a guess.
 */
async function stopLifted(
  session: AuthenticatedSession,
  occurrenceId: string,
  fetcher: typeof fetch | undefined,
): Promise<boolean> {
  if (!navigator.onLine || isOfflineSession(session)) return false;
  try {
    const { panel } = await apiRequest({
      path: "/api/v1/safety/panel",
      schema: safetyPanelResponseSchema,
      fetcher: fetcher ?? fetch,
      deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
    });
    const listed = panel.open_occurrences.find((stop) => stop.occurrence_id === occurrenceId);
    if (listed) return !listed.stop_active;
    // The read lists at most 50 open stops: missing from a full list proves nothing.
    return panel.open_occurrences.length < OPEN_STOPS_READ_LIMIT;
  } catch {
    return false;
  }
}
