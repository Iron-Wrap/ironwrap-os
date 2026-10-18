// The qualification runner (agent-host/evals/README.md "Qualification run"). A stage of
// evals/qualification.v1.json runs through an eval gateway (the `qualification` option, `scope:
// "eval"`) on the stage's own state directory, so it books in its own eval ledger and never in
// production's. Each repetition is a production-shaped run (case-run.ts) served by the stdio
// action server, judged on the judge route of the other model family, and merged by
// evals/score.mjs; evals/report.mjs builds the report. A stage starts or resumes only when the
// caller says so.
//
// Gateway abstentions follow `gateway_reasons`: `pause` stops new work and records when resuming
// can help (the latest `retryAt`; an abstention without one means waiting alone cannot), `stop`
// stops the run, and `score` (invalid_output) is a failed repetition with a transcript. Calls in
// flight finish and are recorded. The manifest keys every finished step by specialist, route,
// case, repetition, prompt_sha256 and catalog_sha256, so a resume skips finished repetitions and
// re-runs any recorded under other hashes.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUDITOR, parseRoute, proposerRoutes } from "../gateway/config.ts";
import { ProviderGateway, type GatewayOptions } from "../gateway/gateway.ts";
import { sha256 } from "../gateway/schema.ts";
import type { GatewayRequest, GatewayResult, McpStdioServer, ProviderId, Route, Tier } from "../gateway/types.ts";
import { loadSpecialist, type Specialist } from "../host/specialists.ts";
import { caseClock, replayRun, replayTools, type ReplayTool } from "./case-run.ts";
import {
  buildQualificationReport,
  loadRubric,
  loadSuite,
  mergeJudgement,
  renderMarkdown,
  scoreCase,
  type Deterministic,
  type EvalCase,
  type Merged,
  type QualificationConfig,
  type QualificationReport,
  type ReplayEnvironment,
  type Rubric,
  type ScoringContext,
  type Suite,
  type Transcript,
} from "./evals.ts";
import { isValidJudgement, JUDGE_OUTPUT_SCHEMA, judgePrompt } from "./judge.ts";

const TOOL_SERVER = fileURLToPath(new URL("./tool-server.ts", import.meta.url));

/** Percent of each provider's usage window used; null when the meter is not visible. */
export type MeterReading = Record<ProviderId, number | null>;
const NOT_VISIBLE = async (): Promise<MeterReading> => ({ claude: null, codex: null });

export class StageRefusal extends Error {
  /** `paused`: the stage waits for its retry time. */
  readonly code: "refused" | "paused";

  constructor(message: string, code: "refused" | "paused" = "refused") {
    super(message);
    this.name = "StageRefusal";
    this.code = code;
  }
}

interface RunnerOptions {
  environment: ReplayEnvironment;
  outputDir: string;
  /** The gateway's process environment; credentials are read from it by name. */
  env: Record<string, string | undefined>;
  adapters?: GatewayOptions["adapters"];
  now?: () => number;
  signal?: AbortSignal;
  log?: (event: Record<string, unknown>) => void;
}

export interface StageOptions extends RunnerOptions {
  stage: string;
  /** The orchestrator's signal (`start_and_resume`): a stage never starts or resumes by itself. */
  mode: "start" | "resume";
  /** Reads the usage meters around the pilot and each comparison batch; the default sees neither. */
  readMeters?: () => Promise<MeterReading>;
  /** The commit the stage runs on, for the report. */
  mainSha?: string | null;
}

export interface Halt {
  class: "pause" | "stop";
  reason: string;
  detail: string;
  retry_at: number | null;
  /** The call that abstained; null for a runner fault. */
  call: "run" | "judge" | null;
  specialist_id: string;
  case_id: string;
  repetition: number;
}

export interface StageState {
  schema_version: "ironwrap.eval-stage-state.v1";
  stage: string;
  run_id: string;
  status: "running" | "paused" | "stopped" | "complete";
  halts: Halt[];
  /** The earliest moment a resume can help, also beside a stop; null when no pausing abstention named one. */
  retry_at: number | null;
  /** True only for a pause whose every abstention carried a retry time. */
  resumable_by_waiting: boolean;
  completed: number;
  /** Repetitions still to run (or to judge), per specialist. */
  pending: Record<string, number>;
  quota: { before: MeterReading; after: MeterReading | null } | null;
  batches: Array<{ route: Route; before: MeterReading | null; after: MeterReading | null }>;
  started_at: number;
  updated_at: number;
}

export interface StageResult {
  stageDir: string;
  state: StageState;
  report: QualificationReport;
}

interface Loaded {
  id: string;
  specialist: Specialist;
  tools: ReplayTool[];
  promptSha: string;
  wave: number;
  golden: EvalCase[];
  redteam: EvalCase[];
  rubric: Rubric;
  scoring: ScoringContext;
  /** The gateway route a run of this specialist takes in production. */
  production: Route;
  /** The auditor's runs name the family whose work they review; null for every other specialist. */
  reviews: ProviderId | null;
}

/** One report row: a specialist on one route, over its cases and repetitions. */
interface Row {
  loaded: Loaded;
  route: Route;
  /** A model-comparison row: the route reaches the gateway as `tierRoutes` and the report as `route`. */
  compared: boolean;
  cases: Array<{ item: EvalCase; suite: Suite }>;
  repetitions: number;
}

/** Rows that run together; a comparison batch is one route, with the meters read around it. */
interface Group {
  batch: Route | null;
  rows: Row[];
}

interface WorkItem {
  row: Row;
  item: EvalCase;
  suite: Suite;
  repetition: number;
  key: string;
}

interface RecordKey {
  specialist_id: string;
  route: string;
  case_id: string;
  suite: Suite;
  repetition: number;
  prompt_sha256: string;
  catalog_sha256: string;
  imported_from?: string;
}

type TranscriptRecord = RecordKey & { type: "transcript"; at: number; transcript: Transcript };
type JudgementRecord = RecordKey & {
  type: "judgement";
  at: number;
  judge: { route_id: string | null; provider: ProviderId | null; model: string | null; valid: boolean; outputs: unknown[] };
  deterministic: Deterministic;
  merged: Merged;
};

interface Entry {
  transcript?: TranscriptRecord;
  judgement?: JudgementRecord;
}

interface CallLine {
  kind: "run" | "judge";
  specialist_id: string;
  route: string;
  compared: boolean;
  attempt: number;
  attempts: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  cost_usd: number;
}

interface Context {
  environment: ReplayEnvironment;
  gateway: ProviderGateway;
  slot: <T>(provider: ProviderId, call: () => Promise<T>) => Promise<T>;
  entries: Map<string, Entry>;
  manifest: string;
  calls: string;
  toolsDir: string;
  halts: Halt[];
  now: () => number;
  signal: AbortSignal | undefined;
  log: (event: Record<string, unknown>) => void;
}

const routeKey = (route: Route) => `${route.provider}/${route.model}/${route.effort}`;
const workKey = (specialistId: string, route: Route, caseId: string, repetition: number) => `${specialistId}|${routeKey(route)}|${caseId}|${repetition}`;
const done = (entries: Map<string, Entry>, work: WorkItem) => Boolean(entries.get(work.key)?.judgement);
const halted = (ctx: Context) => ctx.halts.length > 0 || ctx.signal?.aborted === true;

const MAPPING = "agent-host/evals/action-catastrophes.v1.json";
const UNMAPPED = `Mapped catastrophes were not checked deterministically: ${MAPPING} is missing.`;

/**
 * The status after a drain, once the runner's own halts are added: a cancellation is the `aborted`
 * stop even with no call in flight, and work left unfinished without any halt is a runner fault.
 */
function settle(ctx: Context, unfinished: number): "paused" | "stopped" | "complete" {
  const runnerStop = (reason: string, detail: string) =>
    ctx.halts.push({ class: "stop", reason, detail, retry_at: null, call: null, specialist_id: "", case_id: "", repetition: 0 });
  if (ctx.signal?.aborted && !ctx.halts.some((halt) => halt.class === "stop")) runnerStop("aborted", "the runner was cancelled");
  if (ctx.halts.length === 0 && unfinished > 0) runnerStop("runner_error", `${unfinished} repetition(s) left unfinished`);
  return ctx.halts.some((halt) => halt.class === "stop") ? "stopped" : ctx.halts.length > 0 ? "paused" : "complete";
}

export async function runStage(options: StageOptions): Promise<StageResult> {
  const { environment, stage } = options;
  const now = options.now ?? Date.now;
  const readMeters = options.readMeters ?? NOT_VISIBLE;
  if (!environment.config.stages.some((candidate) => candidate.id === stage)) throw new StageRefusal(`unknown stage ${stage}`);
  // A wave's verdict rests on every catastrophe check; only the pilot, which sets no verdict, may run without it.
  if (stage !== "pilot" && environment.actionCatastrophes === null) throw new StageRefusal(`stage ${stage} cannot qualify anyone: ${MAPPING} is missing, so mapped catastrophes would go unchecked`);
  const stageDir = join(options.outputDir, stage);
  const statePath = join(stageDir, "state.json");
  if (options.mode === "resume" && !existsSync(statePath)) throw new StageRefusal(`stage ${stage} has not started; start it with --start`);
  if (options.mode === "start" && existsSync(statePath)) throw new StageRefusal(`stage ${stage} has started already; resume it with --resume`);
  const unlock = lock(stageDir, `stage ${stage}`);
  try {
    const previous = existsSync(statePath) ? (readJson(statePath) as StageState) : null;
    if (options.mode === "start" && previous) throw new StageRefusal(`stage ${stage} has started already; resume it with --resume`);
    const retryAt = previous?.retry_at ?? null;
    if (retryAt !== null && now() < retryAt) {
      const reasons = [...new Set((previous?.halts ?? []).map((halt) => halt.reason))].join(", ");
      throw new StageRefusal(`stage ${stage} cannot resume before ${new Date(retryAt).toISOString()} (${reasons})`, "paused");
    }
    const groups = await planStage(environment, stage);
    const loaded = new Map(groups.flatMap((group) => group.rows.map((row) => [row.loaded.id, row.loaded] as const)));
    const hashOf = (id: string) => loaded.get(id)?.promptSha;
    const entries = readManifest(join(stageDir, "manifest.jsonl"), hashOf, environment.catalog.sha256);
    const ctx = context(options, stageDir, entries, environment.config.ledger.per_stage ? join(stageDir, "gateway") : join(options.outputDir, "gateway"));
    const all = groups.flatMap(workItems);
    if (stage !== "pilot") {
      // evals/README.md: pilot repetitions on production routes count as repetition 1 under the hash rule.
      const pilot = readManifest(join(options.outputDir, "pilot", "manifest.jsonl"), hashOf, environment.catalog.sha256);
      for (const work of all) {
        const found = pilot.get(work.key);
        if (work.repetition !== 1 || done(entries, work) || !found?.transcript || !found.judgement) continue;
        const transcript = record(ctx, { ...found.transcript, imported_from: "pilot", at: now() });
        entries.set(work.key, { transcript, judgement: record(ctx, { ...found.judgement, imported_from: "pilot", at: now() }) });
      }
    }

    const state: StageState = {
      schema_version: "ironwrap.eval-stage-state.v1",
      stage,
      run_id: previous?.run_id ?? `${stage}-${randomBytes(6).toString("hex")}`,
      status: "running",
      halts: [],
      retry_at: null,
      resumable_by_waiting: false,
      completed: previous?.completed ?? 0,
      pending: previous?.pending ?? {},
      quota: previous?.quota ?? (stage === "pilot" ? { before: await readMeters(), after: null } : null),
      batches: previous?.batches ?? [],
      started_at: previous?.started_at ?? now(),
      updated_at: now(),
    };
    writeJson(statePath, state);
    const width = ctx.environment.config.concurrency.claude + ctx.environment.config.concurrency.codex;
    for (const group of groups) {
      const todo = workItems(group).filter((work) => !done(entries, work));
      const meters = group.batch ? batchMeters(state, group.batch) : null;
      if (todo.length > 0) {
        if (meters && !meters.before) meters.before = await readMeters();
        writeJson(statePath, { ...state, updated_at: now() });
        await drain(ctx, todo, width);
        if (halted(ctx)) break;
      }
      // A reading pair spans any pause in between, so a long pause makes it less exact.
      if (meters?.before && !meters.after) meters.after = await readMeters();
    }

    const left = all.filter((work) => !done(entries, work));
    state.status = settle(ctx, left.length);
    const pauses = ctx.halts.filter((halt) => halt.class === "pause");
    state.halts = ctx.halts;
    // A pause's retry time holds even when a stop came with it: resuming sooner hits the same wait.
    state.retry_at = pauses.reduce<number | null>((latest, halt) => (halt.retry_at === null ? latest : Math.max(latest ?? 0, halt.retry_at)), null);
    state.resumable_by_waiting = state.status === "paused" && pauses.every((halt) => halt.retry_at !== null);
    state.completed = all.length - left.length;
    state.pending = Object.fromEntries([...loaded.keys()].map((id) => [id, left.filter((work) => work.row.loaded.id === id).length]).filter(([, count]) => count !== 0));
    if (state.status === "complete" && state.quota && !state.quota.after) state.quota.after = await readMeters();
    state.updated_at = now();
    writeJson(statePath, state);
    const warnings = environment.actionCatastrophes === null ? [UNMAPPED] : [];
    const report = { ...stageReport(environment, stage, groups, entries, ctx.calls, state, options.mainSha ?? null), warnings };
    writeJson(join(stageDir, "report.json"), report);
    const [title, ...rest] = renderMarkdown(report).split("\n");
    writeFileSync(join(stageDir, "report.md"), [title, ...warnings.flatMap((warning) => ["", `**${warning}**`]), ...rest].join("\n"));
    ctx.log({
      event: "stage",
      stage,
      status: state.status,
      completed: state.completed,
      pending: state.pending,
      retry_at: state.retry_at === null ? null : new Date(state.retry_at).toISOString(),
      resumable_by_waiting: state.resumable_by_waiting,
      halts: state.halts.map(({ class: kind, reason, detail, call, case_id, repetition }) => ({ class: kind, reason, detail, call, case_id, repetition })),
    });
    return { stageDir, state, report };
  } finally {
    unlock();
  }
}

export interface ReplayOptions extends RunnerOptions {
  specialistId: string;
  caseId: string;
  repetition?: number;
}

export interface ReplayResult {
  status: "complete" | "paused" | "stopped";
  halts: Halt[];
  transcript: Transcript | null;
  merged: Merged | null;
  warnings: string[];
}

/** One case once, on the specialist's production route, judged and scored; never skipped. */
export async function replayCase(options: ReplayOptions): Promise<ReplayResult> {
  const loaded = await loadForRun(options.environment, options.specialistId);
  const golden = loaded.golden.find((item) => item.id === options.caseId);
  const item = golden ?? loaded.redteam.find((candidate) => candidate.id === options.caseId);
  if (!item) throw new StageRefusal(`${options.specialistId} has no case ${options.caseId}`);
  const repetition = options.repetition ?? 1;
  const row: Row = { loaded, route: loaded.production, compared: false, cases: [{ item, suite: golden ? "golden" : "redteam" }], repetitions: repetition };
  const work: WorkItem = { row, item, suite: row.cases[0].suite, repetition, key: workKey(loaded.id, loaded.production, item.id, repetition) };
  const dir = join(options.outputDir, "replay");
  const unlock = lock(dir, "replay");
  try {
    const ctx = context(options, dir, new Map(), join(dir, "gateway"));
    await drain(ctx, [work], 1);
    const entry = ctx.entries.get(work.key);
    const status = settle(ctx, entry?.judgement ? 0 : 1);
    const warnings = options.environment.actionCatastrophes === null ? [UNMAPPED] : [];
    return { status, halts: ctx.halts, transcript: entry?.transcript?.transcript ?? null, merged: entry?.judgement?.merged ?? null, warnings };
  } finally {
    unlock();
  }
}

async function loadForRun(environment: ReplayEnvironment, id: string): Promise<Loaded> {
  const specialist = await loadSpecialist(environment.specialistsRoot, id);
  const roster = environment.catalog.specialists.get(id);
  if (!roster) throw new Error(`${id} is not in the contract roster`);
  const golden = loadSuite(environment, id, "golden");
  const redteam = loadSuite(environment, id, "redteam");
  const first = golden[0] ?? redteam[0];
  if (!first) throw new Error(`${id} has no eval cases`);
  for (const item of [...golden, ...redteam]) {
    try {
      caseClock(item);
    } catch (error) {
      throw new StageRefusal(`${item.id}: ${(error as Error).message}`);
    }
  }
  const tools = replayTools(specialist, environment.catalog);
  const gateway = environment.gatewayConfig;
  let production = gateway.routes[(Object.hasOwn(gateway.specialists, id) ? gateway.specialists[id].route : null) ?? gateway.tiers[specialist.tier]];
  let reviews: ProviderId | null = null;
  if (id === AUDITOR) {
    // A production audit always names the run it reviews, so the auditor runs on the audit route
    // for the proposers' family, which the gateway checks per run. Proposers on both families
    // would need a qualification per audit route, which no stage plans.
    const families = [...new Set(proposerRoutes(gateway).map((routeId) => gateway.routes[routeId].provider))];
    const audit = families.length === 1 && Object.hasOwn(gateway.auditRoutes, families[0]) ? gateway.auditRoutes[families[0]] : undefined;
    if (audit === undefined) throw new StageRefusal(`${id}: proposer routes run on ${families.join(" and ")}; qualifying the auditor needs the audit route of one proposer family`);
    reviews = families[0];
    production = gateway.routes[audit];
  }
  return {
    id,
    specialist,
    tools,
    // The assembled instructions do not depend on the case (runRepetition checks), so any case
    // gives the stage's hash.
    promptSha: sha256(replayRun(specialist, tools, first, "run_hash").input.system),
    wave: roster.wave,
    golden,
    redteam,
    rubric: loadRubric(environment, id),
    scoring: { allowlist: { actions: specialist.allowlist }, catalog: { actions: [...environment.catalog.actions.values()] }, actionCatastrophes: environment.actionCatastrophes ?? { actions: {} } },
    production,
    reviews,
  };
}

async function planStage(environment: ReplayEnvironment, id: string): Promise<Group[]> {
  const { config } = environment;
  const stage = config.stages.find((candidate) => candidate.id === id) as QualificationConfig["stages"][number];
  const cache = new Map<string, Loaded>();
  const load = async (specialistId: string) => {
    const loaded = cache.get(specialistId) ?? (await loadForRun(environment, specialistId));
    cache.set(specialistId, loaded);
    return loaded;
  };
  const tag = (suite: Suite) => (item: EvalCase) => ({ item, suite });
  if (id !== "pilot") {
    const rows: Row[] = [];
    for (const specialistId of stage.specialists ?? []) {
      const loaded = await load(specialistId);
      // evals/README.md: a wave's repetitions equal every rubric's.
      if (loaded.rubric.repetitions !== config.repetitions) throw new Error(`${specialistId} rubric repetitions ${loaded.rubric.repetitions} differ from ${config.repetitions}`);
      const cases = [...loaded.golden.map(tag("golden")), ...loaded.redteam.map(tag("redteam"))];
      rows.push({ loaded, route: loaded.production, compared: false, cases, repetitions: config.repetitions });
    }
    return [{ batch: null, rows }];
  }
  const repetitions = stage.repetitions ?? 1;
  const production: Row[] = [];
  for (const [specialistId, count] of Object.entries(stage.cases ?? {})) {
    const loaded = await load(specialistId);
    production.push({ loaded, route: loaded.production, compared: false, cases: loaded.golden.slice(0, count).map(tag("golden")), repetitions });
  }
  const groups: Group[] = [{ batch: null, rows: production }];
  const comparison = stage.model_comparison;
  for (const [index, raw] of (comparison?.routes ?? []).entries()) {
    const route = parseRoute(raw, `stages.pilot.model_comparison.routes[${index}]`);
    const rows: Row[] = [];
    for (const specialistId of comparison?.specialists ?? []) {
      const loaded = await load(specialistId);
      if (loaded.specialist.tier === "audit") throw new Error(`${specialistId} runs on the audit tier, which takes no comparison route`);
      const cases = [...loaded.golden.slice(0, comparison?.golden_cases).map(tag("golden")), ...loaded.redteam.slice(0, comparison?.redteam_cases).map(tag("redteam"))];
      rows.push({ loaded, route, compared: true, cases, repetitions: 1 });
    }
    groups.push({ batch: route, rows });
  }
  return groups;
}

/** A group's work, repetition by repetition, so a paused stage has covered its cases evenly. */
function workItems(group: Group): WorkItem[] {
  const items: WorkItem[] = [];
  const most = Math.max(0, ...group.rows.map((row) => row.repetitions));
  for (let repetition = 1; repetition <= most; repetition += 1) {
    for (const row of group.rows) {
      if (repetition > row.repetitions) continue;
      for (const { item, suite } of row.cases) items.push({ row, item, suite, repetition, key: workKey(row.loaded.id, row.route, item.id, repetition) });
    }
  }
  return items;
}

function context(options: RunnerOptions, dir: string, entries: Map<string, Entry>, gatewayDir: string): Context {
  const { environment } = options;
  mkdirSync(join(dir, "tools"), { recursive: true });
  return {
    environment,
    gateway: new ProviderGateway({
      config: environment.gatewayConfig,
      stateDir: gatewayDir,
      env: options.env,
      qualification: { ledger: environment.config.ledger, judge: environment.config.judge },
      ...(options.adapters ? { adapters: options.adapters } : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
    slot: providerSlots(environment.config.concurrency),
    entries,
    manifest: join(dir, "manifest.jsonl"),
    calls: join(dir, "calls.jsonl"),
    toolsDir: join(dir, "tools"),
    halts: [],
    now: options.now ?? Date.now,
    signal: options.signal,
    log: options.log ?? (() => {}),
  };
}

async function drain(ctx: Context, items: WorkItem[], width: number): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (!halted(ctx) && next < items.length) {
      const work = items[next];
      next += 1;
      try {
        await runRepetition(ctx, work);
      } catch (error) {
        // A runner fault stops the stage like a stop reason; what finished stays recorded.
        const detail = error instanceof Error ? error.message : String(error);
        ctx.halts.push({ class: "stop", reason: "runner_error", detail, retry_at: null, call: null, specialist_id: work.row.loaded.id, case_id: work.item.id, repetition: work.repetition });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
}

async function runRepetition(ctx: Context, work: WorkItem): Promise<void> {
  const { loaded, route, compared } = work.row;
  const { config, catalog } = ctx.environment;
  const runId = `run_${sha256(work.key).slice(0, 32)}`;
  const key: RecordKey = {
    specialist_id: loaded.id,
    route: routeKey(route),
    case_id: work.item.id,
    suite: work.suite,
    repetition: work.repetition,
    prompt_sha256: loaded.promptSha,
    catalog_sha256: catalog.sha256,
  };
  const entry = ctx.entries.get(work.key) ?? {};
  if (!entry.transcript) {
    if (halted(ctx)) return;
    const replay = replayRun(loaded.specialist, loaded.tools, work.item, runId);
    if (sha256(replay.input.system) !== loaded.promptSha) throw new Error(`${loaded.id}: the assembled instructions differ between cases`);
    const toolFile = join(ctx.toolsDir, `${runId}.json`);
    writeFileSync(toolFile, JSON.stringify(replay.toolFile));
    let result: GatewayResult | null;
    try {
      result = await gatewayCall(ctx, route.provider, work, "run", 1, {
        specialist: loaded.id,
        tier: loaded.specialist.tier,
        scope: "eval",
        ...(compared ? { tierRoutes: { [loaded.specialist.tier]: route } as GatewayRequest["tierRoutes"] } : {}),
        ...(loaded.reviews ? { reviewOf: { runId: `${runId}-reviewed`, provider: loaded.reviews } } : {}),
        system: replay.input.system,
        prompt: replay.input.prompt,
        outputSchema: replay.input.outputSchema,
        ...(loaded.tools.length > 0 ? { tools: { server: toolServer(toolFile), allowed: loaded.tools.map((tool) => tool.tool_name) } } : {}),
      });
    } finally {
      rmSync(toolFile, { force: true });
    }
    if (result === null) return;
    // The judge's family and the report's route both rest on this.
    if (result.provider !== route.provider || result.model !== route.model) {
      throw new Error(`${loaded.id} ran on ${result.provider}/${result.model}, not the planned ${routeKey(route)}`);
    }
    entry.transcript = record(ctx, { ...key, type: "transcript", at: ctx.now(), transcript: transcriptOf(work, result, catalog.sha256) });
    ctx.entries.set(work.key, entry);
  }
  if (entry.judgement) return;

  const transcript = entry.transcript.transcript;
  const [deterministic] = scoreCase(work.item, [transcript], loaded.scoring).repetitions;
  // The judge is always of another family than the run it scores; the gateway refuses otherwise.
  const judgeRoute = route.provider === "claude" ? config.judge.for_claude_proposers : config.judge.default;
  const outputs: unknown[] = [];
  let accepted: unknown = null;
  let judged: GatewayResult | null = null;
  for (let attempt = 1; attempt <= config.judge.max_attempts && accepted === null; attempt += 1) {
    const result = await gatewayCall(ctx, judgeRoute.provider, work, "judge", attempt, {
      specialist: config.ledger.judge_key,
      tier: loaded.specialist.tier,
      scope: "eval",
      reviewOf: { runId, provider: route.provider },
      system: ctx.environment.judgeInstructions,
      prompt: judgePrompt({ item: work.item, rubric: loaded.rubric, catastrophes: ctx.environment.catastrophes, transcript, deterministic }),
      outputSchema: JUDGE_OUTPUT_SCHEMA,
    });
    if (result === null) return;
    // The provider cap above was this route's; the gateway resolves the same one from reviewOf.
    if (result.provider !== judgeRoute.provider || result.model !== judgeRoute.model) {
      throw new Error(`the judge of ${work.item.id} ran on ${result.provider}/${result.model}, not ${routeKey(judgeRoute)}`);
    }
    judged = result;
    // An answer the schema refused (invalid_output) or that scores outside 0, 0.5 and 1 is asked again.
    outputs.push(result.status === "ok" ? result.output : null);
    if (result.status === "ok" && isValidJudgement(result.output, work.item.id, work.repetition)) accepted = result.output;
  }
  // Still invalid after max_attempts: mergeJudgement scores the repetition 0.
  const merged = mergeJudgement(deterministic, accepted ?? outputs.at(-1) ?? null, loaded.rubric.weights);
  const judge = { route_id: judged?.routeId ?? null, provider: judged?.provider ?? null, model: judged?.model ?? null, valid: accepted !== null, outputs };
  entry.judgement = record(ctx, { ...key, type: "judgement", at: ctx.now(), judge, deterministic, merged });
  ctx.log({ event: "repetition", specialist_id: loaded.id, route: key.route, case_id: work.item.id, repetition: work.repetition, score: merged.score, catastrophes: merged.catastrophes.length, judge_valid: judge.valid });
}

/**
 * One gateway call under its provider's cap. It returns null when the stage halted before the call
 * started or because of it: the halt is checked once the slot is free and recorded before the slot
 * passes on, so no call queued behind the cap starts after a pause or a stop.
 */
async function gatewayCall(ctx: Context, provider: ProviderId, work: WorkItem, kind: "run" | "judge", attempt: number, request: GatewayRequest): Promise<GatewayResult | null> {
  return await ctx.slot(provider, async () => {
    if (halted(ctx)) return null;
    const result = await ctx.gateway.run({ ...request, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    logCall(ctx, kind, work, result, attempt);
    if (result.status === "ok") return result;
    const reason = classify(ctx.environment.config, result.reason);
    if (reason === "score") return result;
    halt(ctx, reason, kind, work, result);
    return null;
  });
}

interface RunOutput {
  decision: Transcript["decision"];
  escalate_to: string | null;
  reason_code: string | null;
  reason: string;
  receipts: Array<Record<string, unknown>>;
  drafts: unknown[];
  final_text: string;
}

function transcriptOf(work: WorkItem, result: GatewayResult, catalogSha: string): Transcript {
  const { loaded } = work.row;
  const byName = new Map(loaded.tools.map((tool) => [tool.tool_name, tool]));
  const autonomy = new Map(loaded.tools.map((tool) => [tool.action_id, tool.autonomy]));
  const output = result.status === "ok" ? (result.output as RunOutput) : null;
  const stopped = output?.decision === "abstain" || output?.decision === "escalate";
  return {
    schema_version: "ironwrap.eval-transcript.v1",
    case_id: work.item.id,
    repetition: work.repetition,
    specialist_id: loaded.id,
    model: `${result.provider}/${result.model}`,
    prompt_sha256: loaded.promptSha,
    catalog_sha256: catalogSha,
    decision: output?.decision ?? null,
    escalate_to: output?.escalate_to ?? null,
    reason_code: output?.reason_code ?? null,
    reason: output?.reason ?? null,
    // Every call the model made, reads included; a failed run's proposals are scored too.
    tool_calls: result.toolCalls.map(({ tool, arguments: raw }) => {
      // The Codex SDK types MCP arguments as unknown; a JSON string is read as its value.
      const input = typeof raw === "string" ? parseJson(raw) : raw;
      const step = isObject(input) && Object.hasOwn(input, "args") ? input : { args: input, citations: [] };
      const known = byName.get(tool);
      return { action_id: known?.action_id ?? tool.replaceAll("__", "."), args: step.args, citations: step.citations ?? [], autonomy: known?.autonomy ?? null };
    }),
    // A receipt's outcome is the Worker's, as evals/README.md states it: a stop records an
    // abstention, an A0 or A1 output succeeded, an A2 or A3 step stays open (null).
    receipts: (output?.receipts ?? []).map((receipt) => {
      const level = autonomy.get(String(receipt.action_id));
      return { ...receipt, outcome: stopped ? "abstained" : level === "A0" || level === "A1" ? "succeeded" : null };
    }),
    drafts: output?.drafts ?? [],
    final_text: output?.final_text ?? "",
    models_used: result.modelsUsed,
    error: result.status === "ok" ? null : `${result.reason}: ${result.detail}`,
  };
}

function halt(ctx: Context, kind: "pause" | "stop", call: "run" | "judge", work: WorkItem, result: Extract<GatewayResult, { status: "abstained" }>): void {
  const entry: Halt = {
    class: kind,
    reason: result.reason,
    detail: result.detail,
    retry_at: result.retryAt ?? null,
    call,
    specialist_id: work.row.loaded.id,
    case_id: work.item.id,
    repetition: work.repetition,
  };
  ctx.halts.push(entry);
  ctx.log({ event: kind === "pause" ? "paused" : "stopped", ...entry });
}

/** `gateway_reasons`; a reason it does not classify stops, never guessed at. */
function classify(config: QualificationConfig, reason: string): "pause" | "stop" | "score" {
  for (const kind of ["pause", "stop", "score"] as const) if (config.gateway_reasons[kind]?.includes(reason)) return kind;
  return "stop";
}

function providerSlots(concurrency: Record<ProviderId, number>) {
  const free = {} as Record<ProviderId, number>;
  for (const provider of ["claude", "codex"] as const) {
    const limit = concurrency[provider];
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`concurrency.${provider} must be a positive integer`);
    free[provider] = limit;
  }
  const waiting: Record<ProviderId, Array<() => void>> = { claude: [], codex: [] };
  return async <T>(provider: ProviderId, call: () => Promise<T>): Promise<T> => {
    if (free[provider] > 0) free[provider] -= 1;
    else await new Promise<void>((resolve) => waiting[provider].push(resolve));
    try {
      return await call();
    } finally {
      // The slot passes straight to the next waiter, so the cap always holds.
      const next = waiting[provider].shift();
      if (next) next();
      else free[provider] += 1;
    }
  };
}

function toolServer(toolFile: string): McpStdioServer {
  return { command: process.execPath, args: [TOOL_SERVER, toolFile], env: {}, passEnv: [] };
}

function record<T extends TranscriptRecord | JudgementRecord>(ctx: Context, value: T): T {
  appendFileSync(ctx.manifest, `${JSON.stringify(value)}\n`);
  return value;
}

function logCall(ctx: Context, kind: "run" | "judge", work: WorkItem, result: GatewayResult, attempt: number): void {
  const line = {
    at: ctx.now(),
    kind,
    specialist_id: work.row.loaded.id,
    route: routeKey(work.row.route),
    compared: work.row.compared,
    case_id: work.item.id,
    repetition: work.repetition,
    attempt,
    status: result.status,
    reason: result.status === "abstained" ? result.reason : null,
    route_id: result.routeId,
    provider: result.provider,
    model: result.model,
    attempts: result.attempts,
    input_tokens: result.usage.inputTokens,
    cached_input_tokens: result.usage.cachedInputTokens,
    output_tokens: result.usage.outputTokens,
    duration_ms: result.durationMs,
    cost_usd: result.costUsd,
  };
  appendFileSync(ctx.calls, `${JSON.stringify(line)}\n`);
}

/** Records under the current hashes only (evals/README.md "Hashes"); a later transcript starts its key over. */
function readManifest(path: string, hashOf: (specialistId: string) => string | undefined, catalogSha: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const value of readLines<TranscriptRecord | JudgementRecord>(path)) {
    if (value.catalog_sha256 !== catalogSha || value.prompt_sha256 !== hashOf(value.specialist_id)) continue;
    const key = `${value.specialist_id}|${value.route}|${value.case_id}|${value.repetition}`;
    if (value.type === "transcript") entries.set(key, { transcript: value });
    else if (value.type === "judgement" && entries.get(key)?.transcript) entries.set(key, { ...entries.get(key), judgement: value });
  }
  return entries;
}

function batchMeters(state: StageState, route: Route): StageState["batches"][number] {
  const found = state.batches.find((batch) => routeKey(batch.route) === routeKey(route));
  if (found) return found;
  const batch = { route, before: null, after: null };
  state.batches.push(batch);
  return batch;
}

function stageReport(
  environment: ReplayEnvironment,
  stage: string,
  groups: Group[],
  entries: Map<string, Entry>,
  callsPath: string,
  state: StageState,
  mainSha: string | null,
): QualificationReport {
  const { config, gatewayConfig } = environment;
  const calls = readLines<CallLine>(callsPath);
  const specialists = groups.flatMap((group) =>
    group.rows.map((row) => {
      const { loaded, route } = row;
      const cases = row.cases
        .map(({ item, suite }) => {
          const merged = Array.from({ length: row.repetitions }, (_, index) => entries.get(workKey(loaded.id, route, item.id, index + 1))?.judgement?.merged);
          return { case_id: item.id, suite, repetitions: merged.filter((value) => value !== undefined) };
        })
        .filter((result) => result.repetitions.length > 0);
      return {
        specialist_id: loaded.id,
        wave: loaded.wave,
        tier: loaded.specialist.tier,
        ...(row.compared ? { route } : {}),
        model: route.model,
        judge_model: (route.provider === "claude" ? config.judge.for_claude_proposers : config.judge.default).model,
        prompt_sha256: loaded.promptSha,
        rubric: loaded.rubric,
        expectedIds: { golden: loaded.golden.map((item) => item.id), redteam: loaded.redteam.map((item) => item.id) },
        cases,
        usage: usageOf(calls, row),
      };
    }),
  );
  const tierRoute = (tier: Tier) => gatewayConfig.routes[gatewayConfig.tiers[tier]];
  const reading = (before: MeterReading | null, after: MeterReading | null) => (provider: ProviderId) => ({
    used_pct_before: before?.[provider] ?? null,
    used_pct_after: after?.[provider] ?? null,
  });
  const pair = (before: MeterReading | null, after: MeterReading | null) => ({ claude: reading(before, after)("claude"), codex: reading(before, after)("codex") });
  const pilot = stage === "pilot";
  return buildQualificationReport({
    runId: state.run_id,
    stage,
    source: { main_sha: mainSha, catalog_sha256: environment.catalog.sha256 },
    routes: { routine: tierRoute("routine"), hard: tierRoute("hard"), audit: tierRoute("audit") },
    judge: { default: config.judge.default, for_claude_proposers: config.judge.for_claude_proposers },
    quota: pilot && state.quota ? pair(state.quota.before, state.quota.after) : null,
    batches: pilot ? state.batches.map((batch) => ({ model: batch.route.model, route: batch.route, ...pair(batch.before, batch.after) })) : null,
    config,
    specialists,
  });
}

/**
 * Every call a row made in this stage that reached a provider, failed and paused ones included. A
 * run a pilot row shares with an equal comparison route counts for the row that made it.
 */
function usageOf(calls: CallLine[], row: Row) {
  const route = routeKey(row.route);
  const mine = calls.filter((call) => call.specialist_id === row.loaded.id && call.route === route && call.compared === row.compared && call.attempts > 0);
  const runs = mine.filter((call) => call.kind === "run");
  const judges = mine.filter((call) => call.kind === "judge");
  const sum = (list: CallLine[], field: "input_tokens" | "cached_input_tokens" | "output_tokens" | "duration_ms" | "cost_usd") =>
    list.reduce((total, call) => total + call[field], 0);
  return {
    runs: runs.length,
    judge_calls: judges.length,
    rejudges: judges.filter((call) => call.attempt > 1).length,
    input_tokens: sum(runs, "input_tokens"),
    cached_input_tokens: sum(runs, "cached_input_tokens"),
    output_tokens: sum(runs, "output_tokens"),
    wall_time_ms: sum(runs, "duration_ms"),
    cost_usd: sum(runs, "cost_usd"),
    judge_cost_usd: sum(judges, "cost_usd"),
  };
}

/**
 * One runner per directory: two would book the same work twice. The lock is a hard link to a file
 * already holding this process id, so it never exists empty; empty or unreadable content counts as
 * held. A dead holder's lock is moved aside under a unique name, and only the runner whose move
 * took exactly that holder's lock goes on to take it.
 */
function lock(dir: string, name: string): () => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "lock");
  const mine = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(mine, String(process.pid));
  try {
    for (;;) {
      try {
        linkSync(mine, file);
        return () => rmSync(file, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const seen = readText(file);
      const holder = Number(seen);
      if (seen === null || !Number.isInteger(holder) || holder <= 0 || running(holder)) {
        throw new StageRefusal(`${name} is running (lock held by ${seen ? `process ${seen}` : "an unreadable lock"})`);
      }
      const aside = `${mine}.stale`;
      try {
        renameSync(file, aside);
      } catch {
        continue; // Another runner moved it first.
      }
      const moved = readText(aside);
      if (moved !== seen) {
        // The lock changed hands before the move: give it back to its new holder.
        try {
          linkSync(aside, file);
        } catch {
          // A third runner holds the path now.
        }
        rmSync(aside, { force: true });
        throw new StageRefusal(`${name} is running (lock taken by process ${moved ?? "unknown"})`);
      }
      rmSync(aside, { force: true });
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

function readText(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

function running(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  // A torn last line from a crash is skipped; the lines before it stay authoritative.
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
