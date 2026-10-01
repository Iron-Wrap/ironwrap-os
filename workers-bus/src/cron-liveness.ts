// cron-liveness.ts — IRO-262. The pure verdict over `cron_heartbeat`, shared by `/admin/status`
// (evidence, never a gate) and `/ready?scope=ops` (the token-less liveness probe).
//
// Freshness is measured from `started_at`, not `finished_at`: the `*/5` tick's parallel sweeps can
// be cut short by the free plan's CPU budget, and a tick that started but did not finish still
// proves the scheduler and the Worker are alive. `finished_at` and `status` stay visible as
// evidence.

import type { CronHeartbeatRecord } from "./store.ts";
import { listCronHeartbeats } from "./store.ts";

/** The two crons this contract knows about, and how old a `started_at` may be and still be fresh. */
export const CRON_LIVENESS_WINDOW_SECONDS: Readonly<Record<string, number>> = {
  "*/5 * * * *": 10 * 60,
  "0 14 * * *": 26 * 3_600,
};

/** The deploy stretch during which no tick can be written: migration-apply → cutover → first tick
 * a deployed revision can write. A never-started row needs this PLUS the cron's own freshness
 * window — see `cronStartupGraceSeconds`. */
export const CRON_STARTUP_GRACE_SECONDS = 20 * 60;

/** The deploy stretch during which no tick can be written, plus the window the cron gets once it is
 * running: a never-started row needs both. */
export function cronStartupGraceSeconds(cron: string): number {
  return CRON_STARTUP_GRACE_SECONDS + (CRON_LIVENESS_WINDOW_SECONDS[cron] ?? 0);
}

/** Same skew guard as `operations.ts`'s `ageSeconds`: a `started_at` more than this far in the
 * future is unusable, not evidence of freshness. */
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export type CronState = "fresh" | "starting" | "stale";

export interface CronLivenessEntry {
  cron: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  age_seconds: number | null;
  freshness_window_seconds: number;
  state: CronState;
}

export interface CronLivenessReport {
  ok: boolean;
  crons: CronLivenessEntry[];
}

function ageSeconds(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  if (Number.isNaN(value)) return null;
  if (value - nowMs > MAX_CLOCK_SKEW_SECONDS * 1_000) return null;
  return Math.max(0, Math.floor((nowMs - value) / 1_000));
}

/** Pure verdict over whatever rows were read. One entry per key of
 * `CRON_LIVENESS_WINDOW_SECONDS`, in that order; a row whose `cron` is not a key of the contract
 * is ignored — it can never widen the verdict. */
export function cronLivenessReport(
  rows: readonly CronHeartbeatRecord[],
  now: Date,
): CronLivenessReport {
  const nowMs = now.getTime();
  const byCron = new Map(rows.map((row) => [row.cron, row] as const));
  const crons: CronLivenessEntry[] = [];

  for (const [cron, freshnessWindowSeconds] of Object.entries(CRON_LIVENESS_WINDOW_SECONDS)) {
    const row = byCron.get(cron) ?? null;
    const startedAgeSeconds = ageSeconds(row?.started_at ?? null, nowMs);
    const seededAgeSeconds = row === null ? null : ageSeconds(row.seeded_at, nowMs);
    const fresh = startedAgeSeconds !== null && startedAgeSeconds <= freshnessWindowSeconds;
    const starting = !fresh && row !== null && row.started_at === null &&
      seededAgeSeconds !== null && seededAgeSeconds <= cronStartupGraceSeconds(cron);
    const state: CronState = fresh ? "fresh" : starting ? "starting" : "stale";
    crons.push({
      cron,
      started_at: row?.started_at ?? null,
      finished_at: row?.finished_at ?? null,
      status: row?.status ?? "missing",
      age_seconds: startedAgeSeconds,
      freshness_window_seconds: freshnessWindowSeconds,
      state,
    });
  }

  return { ok: crons.every((entry) => entry.state === "fresh" || entry.state === "starting"), crons };
}

const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

/** Fails closed, like `checkDatabaseReadiness` at `operations.ts:301-308`: an unreadable
 * `cron_heartbeat` makes `/ready?scope=ops` a 503 and leaves `/admin/status` answering with a stale
 * `crons` block — never a 500 on either. */
export async function getCronLiveness(env: Env, now: Date = new Date()): Promise<CronLivenessReport> {
  try {
    return cronLivenessReport(await listCronHeartbeats(env), now);
  } catch (error) {
    log({ at: "cron_liveness_unreadable", error: String(error) });
    return cronLivenessReport([], now);
  }
}
