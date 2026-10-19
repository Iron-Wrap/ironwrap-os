import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { loadGatewayConfig, type GatewayConfig } from "../src/gateway/config.ts";
import {
  ProviderError,
  type CredentialState,
  type ModelEntry,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderId,
  type ProviderOutcome,
  type QualifiedRoute,
} from "../src/gateway/types.ts";

export const CONFIG_PATH = new URL("../config/gateway.json", import.meta.url).pathname;
export const CONSUMER_CONFIG_PATH = new URL("../config/gateway.consumer.json", import.meta.url).pathname;

export function shippedConfig(): GatewayConfig {
  return loadGatewayConfig(CONFIG_PATH);
}

/**
 * The shipped configuration with a synthetic owner retention confirmation on the Codex account, so
 * live and shadow runs on both accounts pass the compliance gate and reach the checks under test.
 */
export function liveConfig(): GatewayConfig {
  const config = shippedConfig();
  config.providers.codex.confirmedRetention = { confirmedBy: "owner", reference: "synthetic retention confirmation" };
  return config;
}

/** A synthetic release_sha256 and a Worker qualification of every shipped route at it. */
export const RELEASE = "e".repeat(64);

export function qualifications(config: GatewayConfig = shippedConfig(), release = RELEASE): QualifiedRoute[] {
  return Object.entries(config.routes).map(([id, route]) => ({ id: `q-${id}`, ...route, release }));
}

/** A model's registry entry in the shipped configuration. */
export function entryOf(provider: ProviderId, model: string): ModelEntry {
  return shippedConfig().providers[provider].models[model];
}

export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-host-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "note"],
  properties: {
    decision: { type: "string", enum: ["propose", "abstain"] },
    note: { type: ["string", "null"], maxLength: 200 },
  },
};

export function outcome(output: unknown = { decision: "propose", note: null }): ProviderOutcome {
  return {
    output,
    usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 },
    costUsd: 0.25,
    modelsUsed: [],
    toolCalls: [],
  };
}

export type Step = ProviderOutcome | ProviderError | ((call: ProviderCall) => Promise<ProviderOutcome>);

export interface FakeAdapter extends ProviderAdapter {
  calls: ProviderCall[];
  steps: Step[];
  credentialState: CredentialState;
}

export function fakeAdapter(id: ProviderId, steps: Step[] = [], authMode = "oauth"): FakeAdapter {
  const adapter: FakeAdapter = {
    id,
    authMode,
    calls: [],
    steps,
    credentialState: { fingerprint: `${id}-credential-1` },
    async credential() {
      return adapter.credentialState;
    },
    async call(call) {
      adapter.calls.push(call);
      const step = adapter.steps.shift();
      if (!step) throw new Error(`no scripted step for ${id}`);
      if (step instanceof ProviderError) throw step;
      if (typeof step === "function") return await step(call);
      return step;
    },
  };
  return adapter;
}

export const QUALIFICATION_PATH = new URL("../evals/qualification.v1.json", import.meta.url).pathname;

/** A qualification block shaped like `evals/qualification.v1.json`, with synthetic numbers. */
export function qualification() {
  return {
    ledger: {
      isolated: true,
      namespace: "eval",
      requires_run_tag: "eval",
      per_stage: true,
      window_hours: 24,
      team: { calls: 3000, cost_usd: 450 },
      specialist: { calls: 300, cost_usd: 120, cost_usd_per_call: 3 },
      judge_key: "eval_judge",
      judge: { calls: 1500, cost_usd: 120, cost_usd_per_call: 1 },
    },
    judge: {
      instructions: "agent-host/evals/judge.md",
      default: { provider: "claude", model: "claude-sonnet-5-5", effort: "medium" },
      for_claude_proposers: { provider: "codex", model: "gpt-6.1-sol", effort: "high" },
      max_attempts: 3,
    },
  };
}
