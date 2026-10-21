import { Camera, Phone } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { getDeviceSecret } from "../auth/device-credential";
import { isOfflineSession, type AuthenticatedSession } from "../auth/session";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
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
import type { SafetyActionPayload } from "./safety-contracts";

const SAFETY_ENDPOINT = "/api/v1/safety/actions";
const DETAIL_MAX_LENGTH = 4_000;

/** Saved on the phone, not yet confirmed by the office (the panel's own words for this). */
const SAVED_ON_DEVICE =
  "Saved on this device. It uploads on its own and keeps the same record if you retry.";

/**
 * Stop work on one job from a crew phone (P33 S20), then say the area is safe (S23). A stop whose
 * job the office could not find holds every job, and says so (S21). Every action goes to the
 * durable outbox first, so a stop survives no signal; the stop is scoped to this job, never the
 * whole company.
 */
export function JobStopSheet({
  session,
  job,
  fetcher,
}: {
  session: AuthenticatedSession;
  job: StopJob;
  fetcher?: typeof fetch;
}) {
  const [raised, setRaised] = useState<RaisedStop>();
  const [delivery, setDelivery] = useState<"saved" | "sent" | "unresolved">("saved");
  const [unsafe, setUnsafe] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [closed, setClosed] = useState(false);
  const unsafeId = useId();
  const doneId = useId();
  const timeZone = session.tenant.time_zone;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stop = await loadRaisedStop(session, job.id);
      if (cancelled || !stop) return;
      setRaised(stop);
      setDelivery(await deliveryOf(stop.deviceActionId));
    })();
    return () => {
      cancelled = true;
    };
  }, [session, job.id]);

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
      const raisedAt = new Date().toISOString();
      // An empty field still sends a stop: the Worker needs a detail, kind and severity.
      const deviceActionId = await record({
        kind: "report_occurrence",
        scope_type: "roof_job",
        scope_id: job.id,
        captured_at: raisedAt,
        detail: words.length >= 3 ? words : `Work stopped on ${job.code}`,
        occurrence_kind: "hazard",
        severity: "high",
      });
      const stop: RaisedStop = {
        deviceActionId,
        occurrenceId: await occurrenceIdFor(deviceActionId),
        raisedAt,
        unsafe: words.length > 0 ? words : null,
      };
      await saveRaisedStop(session, job.id, stop);
      setRaised(stop);
      setDelivery(await deliveryOf(deviceActionId));
    } catch (caught) {
      setError(
        messageFor(caught, {
          fallback:
            "This phone could not confirm it saved this report. Tell your supervisor directly.",
        }),
      );
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
        detail: words.length >= 3 ? words : `Area made safe on ${job.code}`,
        occurrence_id: raised.occurrenceId,
      });
      const stop = { ...raised, madeSafeAt: new Date().toISOString() };
      await saveRaisedStop(session, job.id, stop);
      setRaised(stop);
      setDone("");
      setStatus(SAVED_ON_DEVICE);
    } catch (caught) {
      setError(
        messageFor(caught, {
          fallback:
            "This phone could not confirm it saved this report. Tell your supervisor directly.",
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  const jobLine = job.address ? `Job ${job.code}, ${job.address}` : `Job ${job.code}`;

  if (raised && delivery === "unresolved") {
    if (closed) return null;
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
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm">
          Job: not found · The owner fixes it
        </p>
        <Button type="button" size="field" onClick={() => setClosed(true)}>
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
        ) : (
          <Notice tone="local" title={SAVED_ON_DEVICE} />
        )}
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm">
          {["Stop", stopTime(raised.raisedAt, timeZone), raised.unsafe, jobLine]
            .filter(Boolean)
            .join(" · ")}
        </p>
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
        <p className="text-sm">This doesn't restart work. The office releases the stop.</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary" size="field">
            <a href={`/check-in/${encodeURIComponent(job.id)}`}>
              <Camera aria-hidden="true" />
              Take photo
            </a>
          </Button>
          <Button type="button" size="field" busy={busy} onClick={() => void madeSafe()}>
            I've made the area safe
          </Button>
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

/** Whether the office has the stop yet, and whether its job was found. */
async function deliveryOf(deviceActionId: string): Promise<"saved" | "sent" | "unresolved"> {
  const action = await getOutboxAction(deviceActionId);
  if (action?.state !== "verified") return "saved";
  return action.verification?.scopeUnresolved ? "unresolved" : "sent";
}
