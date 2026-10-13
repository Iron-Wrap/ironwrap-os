import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { loadGatewayConfig, type GatewayConfig } from "../src/gateway/config.ts";
import {
  ProviderError,
  type CredentialState,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderId,
  type ProviderOutcome,
} from "../src/gateway/types.ts";

export const CONFIG_PATH = new URL("../config/gateway.json", import.meta.url).pathname;

export function shippedConfig(): GatewayConfig {
  return loadGatewayConfig(CONFIG_PATH);
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

export function fakeAdapter(id: ProviderId, steps: Step[] = [], authMode = id === "claude" ? "oauth" : "chatgpt"): FakeAdapter {
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
