// Standing watches and owner reports (AI-TEAM-CONTRACT.md "Watches and reports").
//
// The five-minute cron evaluates every cadence watch whose deterministic condition is registered
// here: once per period of its cadence, the condition runs (no model call), the firing is recorded
// (migration 0204), and only when it holds is a watch signal appended for the owning specialist,
// whose run then composes the report or proposes its actions. Daily, weekly and monthly watches
// run at the tenant's local time. A condition holds on change, not on standing state, so an
// unchanged object never fires again before its cooldown. A watch whose condition is not
// registered yet never fires and is listed as such; event-triggered watches arrive with their
// committed D1 event mapping.

import { CATALOG, catalogSpecialist } from "./catalog.ts";
import { delegationCandidates, previewablePairs, proposalAwaitsOwner } from "./shadow.ts";
import type { Notify } from "./control.ts";
import { appendSignal, type AgentDb } from "./store.ts";

/** The source every scheduler watch signal carries; only this module writes it. */
export const WATCH_SIGNAL_SOURCE = "watch_scheduler";

/** Tenant policy defaults for when calendar watches run, in the tenant's time zone. */
export const WATCH_SCHEDULE = { dailyAt: "07:00", weeklyDay: 1 /* Monday */, weeklyAt: "08:00", monthlyAt: "07:00" };
export const DEFAULT_TIME_ZONE = "America/Edmonton";
/** How long an unacknowledged exception waits before it is raised again. */
export const EXCEPTION_REMINDER_MS = 4 * 3_600_000;

/** The owner reports (contract "Owner reports") and how each is delivered once composed. */
export const OWNER_REPORTS: Record<string, { title: string; delivery: "push" | "push_if_decision" | "email" }> = {
  new_leads: { title: "New inquiries", delivery: "push" },
  pipeline: { title: "Pipeline", delivery: "push_if_decision" },
  daily_owner_brief: { title: "Daily owner brief", delivery: "email" },
  weekly_review: { title: "Weekly market and portfolio review", delivery: "email" },
};

const MAX_OBJECTS = 24;
/**
 * How long after an import run's start its failed items are read: longer than an import takes to
 * write its issues (one Worker request). ponytail: raise it if imports grow past one request.
 */
export const IMPORT_SETTLE_MS = 10 * 60_000;
const DURATION = /^P(?:(\d+)M|(\d+)D|T(\d+)H|T(\d+)M)$/;

export interface ConditionOutcome {
  holds: boolean;
  objects: Array<{ aggregate: string; id: string }>;
  digest: unknown;
  summary: string;
}

export interface Condition {
  version: string;
  /** `since` is when this watch last fired, or one cadence back when it never has. */
  evaluate(db: AgentDb, tenantId: string, since: string, now: string): Promise<ConditionOutcome>;
}

async function rows<T>(db: AgentDb, sql: string, ...values: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...values).all<T>()).results ?? [];
}

async function count(db: AgentDb, sql: string, ...values: unknown[]): Promise<number> {
  return Number((await db.prepare(sql).bind(...values).first<{ n: number }>())?.n ?? 0);
}

const WAITING = "FROM agent_run_steps WHERE tenant_id = ? AND outcome IS NULL AND json_extract(policy_json, '$.result') = 'needs_approval'";

/** Steps waiting on a person: the "Needs you" part of every report, with the exact total. */
async function waitingOnPeople(db: AgentDb, tenantId: string) {
  const listed = await rows<{ step_id: string; specialist_id: string; action_id: string; needs_reviewer_role: string | null; created_at: string }>(
    db,
    `SELECT step_id, specialist_id, action_id, needs_reviewer_role, created_at ${WAITING} ORDER BY created_at ASC LIMIT 50`,
    tenantId,
  );
  return { total: await count(db, `SELECT COUNT(*) AS n ${WAITING}`, tenantId), listed };
}

async function receiptsSince(db: AgentDb, tenantId: string, since: string) {
  return await rows<{ outcome: string | null; n: number }>(
    db,
    "SELECT outcome, COUNT(*) AS n FROM agent_run_steps WHERE tenant_id = ? AND created_at >= ? GROUP BY outcome",
    tenantId,
    since,
  );
}

/** Jobs changed since `since`: the exact total and the most recent ones as objects. */
async function jobsChanged(db: AgentDb, tenantId: string, since: string) {
  const listed = await rows<{ roof_job_id: string }>(
    db,
    `SELECT roof_job_id FROM operating_roof_jobs WHERE tenant_id = ? AND updated_at >= ? ORDER BY updated_at DESC, roof_job_id ASC LIMIT ${MAX_OBJECTS}`,
    tenantId,
    since,
  );
  return { total: await count(db, "SELECT COUNT(*) AS n FROM operating_roof_jobs WHERE tenant_id = ? AND updated_at >= ?", tenantId, since), ids: listed.map((row) => row.roof_job_id) };
}

/**
 * The pairs that meet the earned-autonomy bar (minus those the face proposed and the owner has not
 * answered), and the pairs with a full counted window that do not meet it.
 */
async function earnedAutonomy(db: AgentDb, tenantId: string) {
  const all = await delegationCandidates(db, tenantId);
  const earned = new Set(all.map((row) => `${row.specialist_id} ${row.action_id}`));
  const below = (await previewablePairs(db, tenantId)).filter((row) => !earned.has(`${row.specialist_id} ${row.action_id}`));
  const awaiting: Array<{ specialist_id: string; action_id: string }> = [];
  const open = async <T extends { specialist_id: string; action_id: string }>(rows: T[]): Promise<T[]> => {
    const kept: T[] = [];
    for (const row of rows) {
      if (await proposalAwaitsOwner(db, tenantId, row.specialist_id, row.action_id)) awaiting.push({ specialist_id: row.specialist_id, action_id: row.action_id });
      else kept.push(row);
    }
    return kept;
  };
  return { candidates: await open(all), previewable: await open(below), awaiting };
}

export const WATCH_CONDITIONS: Record<string, Condition> = {
  import_failed_items: {
    version: "1",
    // An import run with failed items: crm_import_issues rows of kind `row_error`, each by its source
    // key. The face proposes retrying only those (import.retry_failed); there is no import-run object
    // for the run to read, so the digest carries each run's keys. An import writes its run row first
    // and its issues as it goes, under the run's start time, so each firing reads the runs that
    // started one settle time before its window: consecutive windows meet, and none reads a run whose
    // issues may still be arriving.
    async evaluate(db, tenantId, since, now) {
      const from = new Date(Date.parse(since) - IMPORT_SETTLE_MS).toISOString();
      const to = new Date(Date.parse(now) - IMPORT_SETTLE_MS).toISOString();
      const FAILED = "SELECT 1 FROM crm_import_issues i WHERE i.tenant_id = r.tenant_id AND i.run_id = r.run_id AND i.kind = 'row_error'";
      const runs = await rows<{ run_id: string; adapter: string; pipeline_key: string; source_label: string | null; created_at: string; source_row_count: number }>(
        db,
        `SELECT r.run_id, r.adapter, r.pipeline_key, r.source_label, r.created_at, r.source_row_count FROM crm_import_runs r
          WHERE r.tenant_id = ? AND r.created_at >= ? AND r.created_at < ? AND EXISTS (${FAILED})
          ORDER BY r.created_at DESC, r.run_id ASC LIMIT ${MAX_OBJECTS}`,
        tenantId,
        from,
        to,
      );
      const total = await count(
        db,
        `SELECT COUNT(*) AS n FROM crm_import_runs r WHERE r.tenant_id = ? AND r.created_at >= ? AND r.created_at < ? AND EXISTS (${FAILED})`,
        tenantId,
        from,
        to,
      );
      const importRuns = [];
      for (const run of runs) {
        const failed = await count(db, "SELECT COUNT(*) AS n FROM crm_import_issues WHERE tenant_id = ? AND run_id = ? AND kind = 'row_error'", tenantId, run.run_id);
        const keys = await rows<{ import_key: string }>(
          db,
          `SELECT DISTINCT import_key FROM crm_import_issues WHERE tenant_id = ? AND run_id = ? AND kind = 'row_error' AND import_key IS NOT NULL
            ORDER BY import_key ASC LIMIT 100`,
          tenantId,
          run.run_id,
        );
        // The keys a retry can name, all of them (a retry takes at most 100), and the failures with no key.
        const keyed = await count(
          db,
          "SELECT COUNT(DISTINCT import_key) AS n FROM crm_import_issues WHERE tenant_id = ? AND run_id = ? AND kind = 'row_error' AND import_key IS NOT NULL",
          tenantId,
          run.run_id,
        );
        const keyless = await count(
          db,
          "SELECT COUNT(*) AS n FROM crm_import_issues WHERE tenant_id = ? AND run_id = ? AND kind = 'row_error' AND import_key IS NULL",
          tenantId,
          run.run_id,
        );
        importRuns.push({
          import_run_id: run.run_id,
          adapter: run.adapter,
          pipeline_key: run.pipeline_key,
          source_label: run.source_label,
          recorded_at: run.created_at,
          source_row_count: run.source_row_count,
          failed_items: failed,
          source_keys: keys.map((key) => key.import_key),
          source_keys_total: keyed,
          keyless_failed: keyless,
        });
      }
      return {
        holds: total > 0,
        objects: [],
        digest: { import_runs: importRuns, total },
        summary: `${total} import ${total === 1 ? "run has" : "runs have"} failed items`,
      };
    },
  },
  new_leads: {
    version: "1",
    async evaluate(db, tenantId, since) {
      const listed = await rows<{ lead_id: string }>(
        db,
        `SELECT lead_id FROM operating_leads WHERE tenant_id = ? AND (created_at >= ? OR updated_at >= ?)
          ORDER BY updated_at DESC, lead_id ASC LIMIT ${MAX_OBJECTS}`,
        tenantId,
        since,
        since,
      );
      const total = await count(db, "SELECT COUNT(*) AS n FROM operating_leads WHERE tenant_id = ? AND (created_at >= ? OR updated_at >= ?)", tenantId, since, since);
      return {
        holds: total > 0,
        objects: listed.map((lead) => ({ aggregate: "lead", id: lead.lead_id })),
        digest: { leads: listed.map((lead) => lead.lead_id), total },
        summary: `${total} inquiries arrived or changed`,
      };
    },
  },
  pipeline: {
    version: "2",
    // Holds on change only: a job that moved, or a decision that started waiting, since the last
    // firing. Decisions already waiting are listed, but never make the report fire on their own.
    async evaluate(db, tenantId, since) {
      const jobs = await jobsChanged(db, tenantId, since);
      const waiting = await waitingOnPeople(db, tenantId);
      const newlyWaiting = await count(db, `SELECT COUNT(*) AS n ${WAITING} AND created_at >= ?`, tenantId, since);
      return {
        holds: jobs.total > 0 || newlyWaiting > 0,
        objects: jobs.ids.map((id) => ({ aggregate: "job", id })),
        digest: { jobs_changed: jobs.ids, jobs_changed_total: jobs.total, waiting: waiting.listed, waiting_total: waiting.total, newly_waiting: newlyWaiting },
        summary: `${jobs.total} jobs changed, ${newlyWaiting} new decisions waiting, ${waiting.total} waiting in all`,
      };
    },
  },
  daily_owner_brief: {
    version: "1",
    async evaluate(db, tenantId, since) {
      const jobs = await jobsChanged(db, tenantId, since);
      const waiting = await waitingOnPeople(db, tenantId);
      const receipts = await receiptsSince(db, tenantId, since);
      // The daily brief is always composed: a quiet day is still reported.
      return {
        holds: true,
        objects: jobs.ids.map((id) => ({ aggregate: "job", id })),
        digest: { receipts_by_outcome: receipts, waiting: waiting.listed, waiting_total: waiting.total, jobs_changed: jobs.ids, jobs_changed_total: jobs.total },
        summary: `${waiting.total} decisions waiting, ${receipts.reduce((sum, row) => sum + Number(row.n), 0)} receipts since the last brief`,
      };
    },
  },
  weekly_review: {
    version: "2",
    async evaluate(db, tenantId, since) {
      const receipts = await receiptsSince(db, tenantId, since);
      const { candidates, previewable, awaiting } = await earnedAutonomy(db, tenantId);
      return {
        holds: true,
        objects: [],
        digest: { receipts_by_outcome: receipts, delegation_candidates: candidates, previewable, awaiting_owner: awaiting },
        summary: `${candidates.length} delegation candidates this week`,
      };
    },
  },
  delegation_review: {
    version: "1",
    // An action meets the earned-autonomy bar for a specialist, or has enough counted decisions for
    // a preview (contract "Delegation" item 13): the face may propose a change with
    // delegation.propose_change, and the owner decides it with delegation.set after the preview.
    // A pair the face already proposed and the owner has not answered is listed apart, not again as
    // a candidate or a previewable pair. Each listed pair is an object, so the run reads its
    // `delegation/…` record.
    async evaluate(db, tenantId) {
      const { candidates, awaiting, previewable } = await earnedAutonomy(db, tenantId);
      const pairs = [...candidates, ...previewable].slice(0, MAX_OBJECTS);
      return {
        holds: candidates.length + previewable.length > 0,
        objects: pairs.map((row) => ({ aggregate: "delegation", id: `${row.specialist_id}:${row.action_id}` })),
        digest: { delegation_candidates: candidates, previewable, awaiting_owner: awaiting },
        summary: `${candidates.length} actions meet the earned-autonomy bar, ${previewable.length} more have enough compared decisions for a preview`,
      };
    },
  },
  unacknowledged_exception: {
    version: "2",
    // An immediate exception left unacknowledged for 30 minutes is raised once, and again only
    // after the reminder cooldown, never on every tick.
    async evaluate(db, tenantId, _since, now) {
      const stale = await rows<{ exception_id: string; reviewer_role: string; urgency: string; opened_at: string }>(
        db,
        `SELECT exception_id, reviewer_role, urgency, opened_at FROM agent_exceptions
          WHERE tenant_id = ? AND acknowledged_at IS NULL AND urgency = 'immediate' AND opened_at <= ?
          ORDER BY opened_at ASC LIMIT ${MAX_OBJECTS}`,
        tenantId,
        new Date(Date.parse(now) - 30 * 60_000).toISOString(),
      );
      if (stale.length === 0) return { holds: false, objects: [], digest: { exceptions: [] }, summary: "0 immediate exceptions unacknowledged for 30 minutes" };
      const recent = await rows<{ content_json: string }>(
        db,
        "SELECT content_json FROM agent_signals WHERE tenant_id = ? AND kind = 'watch' AND watch_id = 'unacknowledged_exception' AND source = ? AND received_at >= ?",
        tenantId,
        WATCH_SIGNAL_SOURCE,
        new Date(Date.parse(now) - EXCEPTION_REMINDER_MS).toISOString(),
      );
      const raised = new Set(recent.flatMap((signal) => ((JSON.parse(signal.content_json) as { digest?: { exceptions?: Array<{ exception_id: string }> } }).digest?.exceptions ?? []).map((entry) => entry.exception_id)));
      const due = stale.filter((exception) => !raised.has(exception.exception_id));
      return { holds: due.length > 0, objects: [], digest: { exceptions: due }, summary: `${due.length} immediate exceptions unacknowledged for 30 minutes` };
    },
  },
};

/** The tenant's time zone when the runtime knows it, else the default (an invalid one is never used). */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(0);
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** Local calendar parts of an instant in a time zone. */
function localParts(at: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { year: Number(parts.year), monthNumber: Number(parts.month), day: Number(parts.day), month: `${parts.year}-${parts.month}`, time: `${parts.hour}:${parts.minute}`, weekday };
}

/** A calendar date `back` days before a local date, by calendar arithmetic (never by milliseconds). */
function daysBefore(year: number, month: number, day: number, back: number): string {
  return new Date(Date.UTC(year, month - 1, day - back)).toISOString().slice(0, 10);
}

/**
 * The period a cadence is in at `now`, or null when its calendar time has not come yet today, this
 * week or this month. Sub-day cadences use fixed UTC slots; calendar cadences use the tenant's time,
 * computed on calendar dates so a daylight-saving change never shifts a period.
 */
export function periodKey(every: string, now: number, timeZone: string, schedule = WATCH_SCHEDULE): string | null {
  const match = DURATION.exec(every);
  if (!match) return null;
  const [, months, days, hours, minutes] = match.map((value) => (value === undefined ? undefined : Number(value)));
  if (hours !== undefined || minutes !== undefined) {
    const slot = ((hours ?? 0) * 60 + (minutes ?? 0)) * 60_000;
    return new Date(Math.floor(now / slot) * slot).toISOString();
  }
  const local = localParts(now, timeZone);
  // Day 1 waits for the monthly time; a later day catches up a missed month.
  if (months === 1) return local.day > 1 || local.time >= schedule.monthlyAt ? local.month : null;
  if (days === 1) return local.time >= schedule.dailyAt ? daysBefore(local.year, local.monthNumber, local.day, 0) : null;
  if (days === 7) {
    const back = (local.weekday - schedule.weeklyDay + 7) % 7;
    if (back === 0 && local.time < schedule.weeklyAt) return null;
    return daysBefore(local.year, local.monthNumber, local.day, back);
  }
  return null;
}

/** One cadence back from `now`, for a watch that has never fired. */
function oneCadenceBack(every: string, now: number): string {
  const match = DURATION.exec(every)!;
  const [, months, days, hours, minutes] = match.map((value) => (value === undefined ? 0 : Number(value)));
  const ms = ((months ?? 0) * 30 * 1440 + (days ?? 0) * 1440 + (hours ?? 0) * 60 + (minutes ?? 0)) * 60_000;
  return new Date(now - ms).toISOString();
}

/**
 * Fires every due cadence watch with a registered condition, at most once per period. Every watch
 * is isolated: one that throws is reported with its error and retried on the next tick, and the
 * others still run.
 */
export async function runWatches(
  db: AgentDb,
  tenantId: string,
  now: string,
  timeZone: string | null,
  conditions: Record<string, Condition> = WATCH_CONDITIONS,
): Promise<{ fired: string[]; empty: string[]; failed: Array<{ watch_id: string; error: string }>; time_zone: string }> {
  const zone = safeTimeZone(timeZone);
  const result = { fired: [] as string[], empty: [] as string[], failed: [] as Array<{ watch_id: string; error: string }>, time_zone: zone };
  const at = Date.parse(now);
  for (const watch of CATALOG.watches) {
    if (!watch.every || !Object.hasOwn(conditions, watch.watch_id)) continue;
    try {
      const period = periodKey(watch.every, at, zone);
      if (period === null) continue;
      const exists = await db
        .prepare("SELECT 1 AS found FROM agent_watch_firings WHERE tenant_id = ? AND watch_id = ? AND period_key = ?")
        .bind(tenantId, watch.watch_id, period)
        .first();
      if (exists) continue;
      const last = await db
        .prepare("SELECT fired_at FROM agent_watch_firings WHERE tenant_id = ? AND watch_id = ? ORDER BY fired_at DESC, rowid DESC LIMIT 1")
        .bind(tenantId, watch.watch_id)
        .first<{ fired_at: string }>();
      const condition = conditions[watch.watch_id];
      const outcome = await condition.evaluate(db, tenantId, last?.fired_at ?? oneCadenceBack(watch.every, at), now);
      let signalId: string | null = null;
      if (outcome.holds) {
        const signal = await appendSignal(
          db,
          tenantId,
          {
            kind: "watch",
            specialist_id: watch.owner,
            watch_id: watch.watch_id,
            source: WATCH_SIGNAL_SOURCE,
            subject: null,
            content: { watch_id: watch.watch_id, period_key: period, objects: outcome.objects, digest: outcome.digest, summary: outcome.summary },
            dedupe_key: `watch:${watch.watch_id}:${period}`,
          },
          now,
        );
        if ("error" in signal) throw new Error(signal.error);
        signalId = signal.signal_id;
      }
      await db
        .prepare(
          `INSERT INTO agent_watch_firings (firing_id,tenant_id,watch_id,specialist_id,period_key,condition_version,holds,signal_id,summary,fired_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(`wf_${crypto.randomUUID()}`, tenantId, watch.watch_id, watch.owner, period, condition.version, outcome.holds ? 1 : 0, signalId, outcome.summary, now)
        .run();
      (outcome.holds ? result.fired : result.empty).push(watch.watch_id);
    } catch (error) {
      if (String(error).includes("agent_watch_firings_append_only")) continue; // another tick fired it
      result.failed.push({ watch_id: watch.watch_id, error: String(error).slice(0, 200) });
    }
  }
  return result;
}

/** Every cadence and trigger watch, whether its condition is registered, and when it last fired. */
export async function watchStatus(db: AgentDb, tenantId: string) {
  const status = [];
  for (const watch of CATALOG.watches) {
    const last = await db
      .prepare("SELECT period_key, holds, signal_id, summary, fired_at FROM agent_watch_firings WHERE tenant_id = ? AND watch_id = ? AND specialist_id = ? ORDER BY fired_at DESC, rowid DESC LIMIT 1")
      .bind(tenantId, watch.watch_id, watch.owner)
      .first<{ period_key: string; holds: number; signal_id: string | null; summary: string; fired_at: string }>();
    status.push({
      watch_id: watch.watch_id,
      owner: watch.owner,
      owner_name: catalogSpecialist(watch.owner)?.display_name ?? watch.owner,
      every: watch.every ?? null,
      trigger: watch.trigger ?? null,
      condition: Object.hasOwn(WATCH_CONDITIONS, watch.watch_id) && watch.every ? "registered" : "not_registered",
      last_firing: last ? { ...last, holds: last.holds === 1 } : null,
    });
  }
  return status;
}

/** Recent owner reports: each firing that held, with its run's result, composed text and delivery. */
export async function ownerReports(db: AgentDb, tenantId: string, watchId: string | null, limit: number) {
  const ids = Object.keys(OWNER_REPORTS);
  const firings = await rows<{ watch_id: string; period_key: string; signal_id: string; summary: string; fired_at: string }>(
    db,
    `SELECT watch_id, period_key, signal_id, summary, fired_at FROM agent_watch_firings
      WHERE tenant_id = ? AND holds = 1 AND watch_id IN (${ids.map(() => "?").join(",")}) AND (? IS NULL OR watch_id = ?)
      ORDER BY fired_at DESC, rowid DESC LIMIT ?`,
    tenantId,
    ...ids,
    watchId,
    watchId,
    limit,
  );
  const reports = [];
  for (const firing of firings) {
    const run = await db
      .prepare("SELECT run_id, state, result, close_json FROM agent_runs WHERE tenant_id = ? AND signal_id = ? ORDER BY started_at DESC LIMIT 1")
      .bind(tenantId, firing.signal_id)
      .first<{ run_id: string; state: string; result: string | null; close_json: string | null }>();
    const output = run?.close_json ? (JSON.parse(run.close_json) as { output?: { final_text?: string } | null }).output : null;
    const delivery = run
      ? await db
          .prepare("SELECT outcome, detail, attempted_at FROM agent_report_deliveries WHERE tenant_id = ? AND run_id = ? ORDER BY attempted_at DESC, rowid DESC LIMIT 1")
          .bind(tenantId, run.run_id)
          .first<{ outcome: string; detail: string | null; attempted_at: string }>()
      : null;
    reports.push({
      ...firing,
      title: OWNER_REPORTS[firing.watch_id].title,
      run: run ? { run_id: run.run_id, state: run.state, result: run.result, text: output?.final_text ?? null } : null,
      delivery: delivery ?? null,
    });
  }
  return reports;
}

/** Whether a closed report run should reach the owner outside the app, and with what subject. */
export function reportDelivery(watchId: string | null, waitingDecisions: number): string | null {
  const report = watchId && Object.hasOwn(OWNER_REPORTS, watchId) ? OWNER_REPORTS[watchId] : null;
  if (!report) return null;
  if (report.delivery === "push_if_decision" && waitingDecisions === 0) return null;
  return report.title;
}

/** A failed delivery is retried after this long, at most this many attempts in all, for runs closed within a day. */
export const DELIVERY_RETRY = { afterMs: 15 * 60_000, attempts: 5, maxAgeMs: 24 * 60 * 60_000 };

/**
 * Sends a completed owner report outside the app once (contract "Owner reports") and records the
 * attempt; it is always in the app's report list. A failure never fails the close: it is recorded
 * and retried by the cron, and by the host's close replay.
 */
export async function deliverRunReport(
  db: AgentDb,
  tenantId: string,
  run: { run_id: string; signal_id: string },
  body: unknown,
  notify: Notify | null,
  now: string,
): Promise<"sent" | "failed" | "skipped"> {
  if (!notify) return "skipped";
  const signal = await db.prepare("SELECT watch_id, source FROM agent_signals WHERE tenant_id = ? AND signal_id = ?").bind(tenantId, run.signal_id).first<{ watch_id: string | null; source: string }>();
  if (!signal || signal.source !== WATCH_SIGNAL_SOURCE || !signal.watch_id) return "skipped";
  const sent = await db.prepare("SELECT 1 AS found FROM agent_report_deliveries WHERE tenant_id = ? AND run_id = ? AND outcome = 'sent'").bind(tenantId, run.run_id).first();
  if (sent) return "skipped";
  const waiting = await count(db, `SELECT COUNT(*) AS n ${WAITING}`, tenantId);
  const title = reportDelivery(signal.watch_id, waiting);
  const text = (body as { output?: { final_text?: unknown } | null } | null)?.output?.final_text;
  if (!title || typeof text !== "string" || !text.trim()) return "skipped";
  let outcome: "sent" | "failed" = "sent";
  let detail: string | null = null;
  try {
    await notify(title, text);
  } catch (error) {
    outcome = "failed";
    detail = String(error).slice(0, 300);
  }
  await db
    .prepare("INSERT INTO agent_report_deliveries (delivery_id, tenant_id, run_id, watch_id, outcome, detail, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(`rdl_${crypto.randomUUID()}`, tenantId, run.run_id, signal.watch_id, outcome, detail, now)
    .run()
    .catch(() => undefined); // a concurrent close recorded the send
  return outcome;
}

/** Retries owner reports whose delivery failed, after a pause and up to a bounded number of attempts. */
export async function retryReportDeliveries(db: AgentDb, tenantId: string, now: string, notify: Notify | null): Promise<{ sent: number; failed: number }> {
  const due = await rows<{ run_id: string; signal_id: string; close_json: string | null }>(
    db,
    `SELECT r.run_id, r.signal_id, r.close_json FROM agent_report_deliveries d
       JOIN agent_runs r ON r.tenant_id = d.tenant_id AND r.run_id = d.run_id
      WHERE d.tenant_id = ? AND r.result = 'completed' AND r.ended_at >= ?
      GROUP BY r.run_id
     HAVING SUM(d.outcome = 'sent') = 0 AND COUNT(*) < ? AND MAX(d.attempted_at) <= ?
      LIMIT 20`,
    tenantId,
    new Date(Date.parse(now) - DELIVERY_RETRY.maxAgeMs).toISOString(),
    DELIVERY_RETRY.attempts,
    new Date(Date.parse(now) - DELIVERY_RETRY.afterMs).toISOString(),
  );
  const result = { sent: 0, failed: 0 };
  for (const run of due) {
    const outcome = await deliverRunReport(db, tenantId, run, run.close_json ? JSON.parse(run.close_json) : null, notify, now).catch(() => "failed" as const);
    if (outcome === "sent") result.sent += 1;
    if (outcome === "failed") result.failed += 1;
  }
  return result;
}
