import { useEffect, useState } from "react";

import type { AuthenticatedSession } from "../auth/session";
import { cacheFieldModel, getCachedFieldModel } from "./field-cache";
import { jobResponseSchema, todayResponseSchema } from "./field-contracts";

/** The job a crew phone stops work on: the scope it sends and what the sheet names. */
export interface StopJob {
  /** The `/jobs/{job}` id, which is the `roof_job` scope the Worker's gates read. */
  id: string;
  code: string;
  address: string | null;
}

/** A stop this phone raised on a job, kept so the job shows "Work stopped" after a reload. */
export interface RaisedStop {
  deviceActionId: string;
  occurrenceId: string;
  raisedAt: string;
  /** What the person typed as unsafe, or null when they sent the stop without words. */
  unsafe: string | null;
  madeSafeAt?: string;
}

const JOB_PATH = /^\/jobs\/([^/]+)(?:\/|$)/;

/** The open job's id, from the route alone. */
export function jobIdFromPath(pathname: string): string | undefined {
  const open = JOB_PATH.exec(pathname)?.[1];
  return open ? decodeURIComponent(open) : undefined;
}

function key(session: AuthenticatedSession, suffix: string): string {
  return `${session.tenant.id}:${session.user.id}:${suffix}`;
}

/**
 * The job the person is on, from what this phone already holds: the open job, or the one job on
 * today's run sheet. With no job, or more than one, there is no job to stop, and the caller keeps
 * the panel that reports without one.
 */
export async function resolveStopJob(
  session: AuthenticatedSession,
  pathname: string,
): Promise<StopJob | undefined> {
  const id = jobIdFromPath(pathname);
  if (id) {
    const cached = jobResponseSchema.safeParse(
      await getCachedFieldModel(key(session, `job:${id}`)),
    );
    const job = cached.success ? cached.data.job : undefined;
    return { id, code: job?.job_number ?? id, address: job?.address ?? null };
  }
  const today = todayResponseSchema.safeParse(await getCachedFieldModel(key(session, "today")));
  if (!today.success || today.data.jobs.length !== 1) return undefined;
  const [job] = today.data.jobs;
  return { id: job!.id, code: job!.job_number ?? job!.id, address: job!.address };
}

/** The Worker derives the occurrence id from the device action id (`so_` + SHA-256, 32 hex). */
export async function occurrenceIdFor(deviceActionId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceActionId));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `so_${hex.slice(0, 32)}`;
}

export async function loadRaisedStop(
  session: AuthenticatedSession,
  jobId: string,
): Promise<RaisedStop | undefined> {
  const value = (await getCachedFieldModel(key(session, `job-stop:${jobId}`))) as
    RaisedStop | undefined;
  return value && typeof value.occurrenceId === "string" ? value : undefined;
}

export async function saveRaisedStop(
  session: AuthenticatedSession,
  jobId: string,
  stop: RaisedStop,
): Promise<void> {
  await cacheFieldModel(key(session, `job-stop:${jobId}`), stop, null);
}

/** "Tue 7:40 a.m." in the company's time zone. */
export function stopTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  const weekday = new Intl.DateTimeFormat("en-CA", { weekday: "short", timeZone }).format(date);
  const time = new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(date);
  return `${weekday} ${time}`;
}

/** The job to stop while `active` (the help sheet is open), resolved from this phone's own data. */
export function useStopJob(
  session: AuthenticatedSession,
  pathname: string,
  active: boolean,
): StopJob | undefined {
  const [job, setJob] = useState<StopJob>();
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void resolveStopJob(session, pathname).then(
      (resolved) => {
        if (!cancelled) setJob(resolved);
      },
      () => {
        if (!cancelled) setJob(undefined);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session, pathname, active]);
  return active ? job : undefined;
}
