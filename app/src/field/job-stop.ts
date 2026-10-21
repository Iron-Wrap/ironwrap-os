import { useEffect, useState } from "react";
import { z } from "zod";

import type { AuthenticatedSession } from "../auth/session";
import { cacheFieldModel, getCachedFieldModel } from "./field-cache";

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
  /** What the person typed as unsafe and was sent, or null when the stop went without words. */
  unsafe: string | null;
  madeSafeAt?: string;
}

/**
 * A live job's own screens: its packet and its check-in. A finished job's history is not one: a
 * stop there would hold nothing.
 */
const LIVE_JOB_PATH = /^\/(?:jobs|check-in)\/([^/]+)\/?$/;
/** The crew's home screens, where the one job on today's run sheet is the job they are on. */
const HOME_PATHS = new Set(["/today", "/now", "/"]);

/** The open live job's id, from the route alone. */
export function jobIdFromPath(pathname: string): string | undefined {
  const open = LIVE_JOB_PATH.exec(pathname)?.[1];
  return open ? decodeURIComponent(open) : undefined;
}

// Only the fields the sheet names: a packet or run sheet saved by an older release still names it.
const cachedJobSchema = z.object({
  job: z.object({
    id: z.string().min(1),
    job_number: z.string().nullable(),
    address: z.string().nullable(),
  }),
});
const cachedTodaySchema = z.object({
  date: z.string().min(1),
  jobs: z.array(
    z.object({
      id: z.string().min(1),
      job_number: z.string().nullable(),
      address: z.string().nullable(),
    }),
  ),
});

function key(session: AuthenticatedSession, suffix: string): string {
  return `${session.tenant.id}:${session.user.id}:${suffix}`;
}

/** Today's date where the company works, as the run sheet's `date` writes it. */
function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * The job the person is on, from what this phone already holds: the open live job, or on a home
 * screen the one job on today's run sheet. With no job, more than one, or a run sheet from another
 * day, there is no job to stop, and the caller keeps the panel that reports without one.
 */
export async function resolveStopJob(
  session: AuthenticatedSession,
  pathname: string,
  now: Date = new Date(),
): Promise<StopJob | undefined> {
  const id = jobIdFromPath(pathname);
  if (id) {
    const cached = cachedJobSchema.safeParse(await getCachedFieldModel(key(session, `job:${id}`)));
    const job = cached.success ? cached.data.job : undefined;
    return { id, code: job?.job_number ?? id, address: job?.address ?? null };
  }
  if (!HOME_PATHS.has(pathname)) return undefined;
  const today = cachedTodaySchema.safeParse(await getCachedFieldModel(key(session, "today")));
  if (!today.success || today.data.jobs.length !== 1) return undefined;
  if (today.data.date !== todayIn(session.tenant.time_zone, now)) return undefined;
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
    RaisedStop | null | undefined;
  return value && typeof value.occurrenceId === "string" ? value : undefined;
}

export async function saveRaisedStop(
  session: AuthenticatedSession,
  jobId: string,
  stop: RaisedStop | null,
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

/**
 * The job to stop while `active` (the help sheet is open), resolved from this phone's own data.
 * Undefined until the lookup for this screen ends, so the sheet never shows another screen's job.
 */
export function useStopJob(
  session: AuthenticatedSession,
  pathname: string,
  active: boolean,
): StopJob | undefined {
  const [state, setState] = useState<{ job?: StopJob; for?: string }>({});
  const lookup = `${pathname}|${active}`;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void resolveStopJob(session, pathname).then(
      (job) => {
        if (!cancelled) setState({ job, for: lookup });
      },
      () => {
        if (!cancelled) setState({ for: lookup });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session, pathname, active, lookup]);
  return active && state.for === lookup ? state.job : undefined;
}
