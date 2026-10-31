// The eval tree the runner reads (agent-host/evals/, Track D), used read-only. The scorer, the
// report builder and the validator are plain JavaScript, so they load through a computed specifier
// and take the types declared here.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadGatewayConfig, type GatewayConfig } from "../gateway/config.ts";
import type { ProviderId, Route } from "../gateway/types.ts";
import type { AllowlistEntry } from "../host/specialists.ts";
import type { Fact, SignalKind } from "../host/worker.ts";

export type Suite = "golden" | "redteam";
export type Decision = "propose" | "abstain" | "escalate" | "ignore";

export interface CaseFact {
  fact_id: string;
  kind: string;
  version: number;
  trust: Fact["trust"];
  /** ISO 8601 durations from the case clock. */
  observed_at: string;
  fresh_until?: string;
  data: unknown;
}

export interface EvalCase {
  id: string;
  title: string;
  tags: string[];
  signal: { kind: SignalKind; source: string; watch_id?: string; at: string; content: unknown; actor?: unknown; subject?: { aggregate: string; id: string } };
  facts: CaseFact[];
  attack: unknown;
  expected: { decision: Decision; [field: string]: unknown };
  catastrophic_if: string[];
  judge_notes: string;
  /** Edmonton local time the case runs at, with no calendar date (case-run.ts caseClock). */
  clock?: { season: "winter" | "spring" | "summer" | "fall"; weekday: string; local_time: string };
}

export interface Rubric {
  specialist_id: string;
  repetitions: number;
  weights: Record<string, number>;
  pass_bar: Record<string, unknown>;
  specialist_checks: string[];
}

export interface CatalogAction {
  action_id: string;
  /** The action's plain name, as the Worker words its tools and people-only acts. */
  name?: string;
  owners: string[];
  aggregate: string;
  autonomy: "A0" | "A1" | "A2" | "A3" | "H";
  human_only: boolean;
  side_effect_class: string;
  undo: string;
  requires_citations: boolean;
  protective: boolean;
}

/** `loadCatalog` of evals/validate.mjs: the contract catalog of docs/AI-TEAM-CONTRACT.md. */
export interface Catalog {
  sha256: string;
  specialists: Map<string, { specialist_id: string; wave: number }>;
  actions: Map<string, CatalogAction>;
}

export interface StageConfig {
  id: string;
  specialists?: string[];
  cases?: Record<string, number>;
  repetitions?: number;
  model_comparison?: { specialists: string[]; golden_cases: number; redteam_cases: number; routes: unknown[] };
}

/** evals/qualification.v1.json; its ledger and judge blocks are parsed strictly by the eval gateway. */
export interface QualificationConfig {
  repetitions: number;
  /** `for_claude_proposers` judges work proposed on the anthropic family, `default` every other family's. */
  judge: { instructions: string; default: Route; for_claude_proposers: Route; max_attempts: number };
  ledger: { judge_key: string; per_stage: boolean };
  /** Calls in flight per provider id; a provider it does not name gets no calls. */
  concurrency: Record<ProviderId, number>;
  gateway_reasons: Record<"pause" | "stop" | "score", string[]>;
  stages: StageConfig[];
  output_dir: string;
}

/** The minimum evals/README.md "Harness interface" asks for, plus what the judge needs to see. */
export interface Transcript {
  schema_version: "ironwrap.eval-transcript.v1";
  case_id: string;
  repetition: number;
  specialist_id: string;
  model: string;
  prompt_sha256: string;
  catalog_sha256: string;
  decision: Decision | null;
  escalate_to: string | null;
  reason_code: string | null;
  reason: string | null;
  tool_calls: Array<{ action_id: string; args: unknown; citations: unknown; autonomy: string | null }>;
  receipts: Array<Record<string, unknown>>;
  drafts: unknown[];
  final_text: string;
  models_used: string[];
  error: string | null;
}

export interface ScoringContext {
  allowlist: { actions: AllowlistEntry[] };
  catalog: { actions: CatalogAction[] };
  actionCatastrophes: unknown;
}

/** One entry of `scoreCase(...).repetitions`. */
export interface Deterministic {
  case_id: string;
  repetition: number;
  run_failed: boolean;
  caps: Record<string, number>;
  catastrophes: Array<{ id: string; evidence?: string }>;
  notes: string[];
}

/** `mergeJudgement` output. */
export interface Merged {
  repetition: number;
  dimensions: Record<string, number>;
  score: number;
  catastrophes: Array<{ id: string; evidence?: string }>;
  notes: string[];
}

export interface QualificationReport {
  schema_version: string;
  stage: string;
  specialists: Array<{ specialist_id: string; verdict: string; [field: string]: unknown }>;
  [field: string]: unknown;
}

interface ScoreModule {
  DIMENSIONS: readonly string[];
  scoreCase(item: EvalCase, transcripts: Transcript[], context: ScoringContext): { case_id: string; repetitions: Deterministic[] };
  mergeJudgement(repetition: Deterministic, judge: unknown, weights: Record<string, number>): Merged;
}

interface ReportModule {
  buildQualificationReport(input: Record<string, unknown>): QualificationReport;
  renderMarkdown(report: QualificationReport): string;
}

interface ValidateModule {
  loadCatalog(root: string): Catalog | null;
  validate(root: string, options: { requireComplete: boolean }): { failures: string[]; notes: string[] };
}

const load = async <T>(name: string): Promise<T> => (await import(new URL(`../../evals/${name}`, import.meta.url).href)) as T;
export const { DIMENSIONS, scoreCase, mergeJudgement } = await load<ScoreModule>("score.mjs");
export const { buildQualificationReport, renderMarkdown } = await load<ReportModule>("report.mjs");
export const { loadCatalog, validate: validateEvals } = await load<ValidateModule>("validate.mjs");

/** Everything one stage reads; the CLI loads it from the repository, tests build a synthetic one. */
export interface ReplayEnvironment {
  specialistsRoot: string;
  evalsRoot: string;
  catalog: Catalog;
  config: QualificationConfig;
  gatewayConfig: GatewayConfig;
  /** judge.md, the judge's system text. */
  judgeInstructions: string;
  /** catastrophes.v1.json, shown to the judge. */
  catastrophes: unknown;
  /** action-catastrophes.v1.json; null while it is absent, so mapped catastrophes go unchecked. */
  actionCatastrophes: unknown | null;
}

/**
 * `gatewayConfigPath` is `AGENT_HOST_GATEWAY_CONFIG` as the host reads it, relative to the package:
 * qualifying on personal sign-ins takes the configuration that labels them (config/gateway.consumer.json).
 */
export function loadEnvironment(repoRoot: string, gatewayConfigPath?: string): ReplayEnvironment {
  const agentHost = join(repoRoot, "agent-host");
  const evalsRoot = join(agentHost, "evals");
  const config = readJson(join(evalsRoot, "qualification.v1.json")) as QualificationConfig;
  const catalog = loadCatalog(repoRoot);
  if (!catalog) throw new Error("docs/AI-TEAM-CONTRACT.md holds no contract catalog");
  const mapping = join(evalsRoot, "action-catastrophes.v1.json");
  return {
    specialistsRoot: join(agentHost, "specialists"),
    evalsRoot,
    catalog,
    config,
    gatewayConfig: loadGatewayConfig(resolve(agentHost, gatewayConfigPath?.trim() || "config/gateway.json")),
    judgeInstructions: readFileSync(join(repoRoot, config.judge.instructions), "utf8"),
    catastrophes: readJson(join(evalsRoot, "catastrophes.v1.json")),
    // Written at catalog binding (evals/README.md); stage.ts refuses a wave without it.
    actionCatastrophes: existsSync(mapping) ? readJson(mapping) : null,
  };
}

/** A specialist's case file, refused when it was written against another catalog. */
export function loadSuite(environment: ReplayEnvironment, specialistId: string, suite: Suite): EvalCase[] {
  const path = join(environment.evalsRoot, specialistId, `${suite}.v1.json`);
  const file = readJson(path) as { schema_version?: unknown; specialist_id?: unknown; suite?: unknown; catalog_sha256?: unknown; cases?: unknown };
  if (file.schema_version !== "ironwrap.specialist-cases.v1" || file.specialist_id !== specialistId || file.suite !== suite || !Array.isArray(file.cases)) {
    throw new Error(`${path} is not the ${suite} case file of ${specialistId}`);
  }
  if (file.catalog_sha256 !== environment.catalog.sha256) throw new Error(`${path} was written against another catalog`);
  return file.cases as EvalCase[];
}

export function loadRubric(environment: ReplayEnvironment, specialistId: string): Rubric {
  const path = join(environment.evalsRoot, specialistId, "rubric.v1.json");
  const rubric = readJson(path) as Rubric & { schema_version?: unknown };
  if (rubric.schema_version !== "ironwrap.specialist-rubric.v1" || rubric.specialist_id !== specialistId || !Number.isInteger(rubric.repetitions)) {
    throw new Error(`${path} is not the rubric of ${specialistId}`);
  }
  return rubric;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
