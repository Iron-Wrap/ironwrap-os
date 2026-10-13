// Codex through the Codex SDK. With a ChatGPT sign-in the CLI reads and refreshes
// `$CODEX_HOME/auth.json` itself, so CODEX_HOME must be a persistent, writable directory owned by
// the agent host. With an API key the key travels in the subprocess environment, never on argv.
// The run is isolated: shell and every optional tool disabled, read-only sandbox, no network, no
// web search, no AGENTS.md, no history, an empty working directory.

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexOptions, ThreadOptions, TurnOptions, RunResult } from "@openai/codex-sdk";
import type { GatewayConfig } from "./config.ts";
import { sha256 } from "./schema.ts";
import { ProviderError, classifyText, type ProviderAdapter, type ProviderCall, type ToolCall, type Usage } from "./types.ts";

export interface CodexLike {
  startThread(options: ThreadOptions): { run(input: string, options: TurnOptions): Promise<RunResult> };
}
export type CodexFactory = (options: CodexOptions) => CodexLike;

const MCP_SERVER = "ironwrap";

export function createCodexAdapter(
  config: GatewayConfig,
  stateDir: string,
  env: Record<string, string | undefined>,
  factory?: CodexFactory,
): ProviderAdapter {
  const provider = config.providers.codex;
  // The ChatGPT sign-in lives in CODEX_HOME; an API-key run only needs a private writable home.
  const codexHome = () =>
    env[provider.codexHomeEnv]?.trim() || (provider.auth === "api_key" ? join(stateDir, "codex-home") : null);
  const apiKey = () => env[provider.apiKeyEnv]?.trim() || null;

  return {
    id: "codex",
    authMode: provider.auth,
    async credential() {
      if (provider.auth === "api_key") {
        const key = apiKey();
        return { fingerprint: key ? sha256(`codex:api_key:${key}`) : null };
      }
      const home = codexHome();
      if (!home) return { fingerprint: null };
      let raw: string;
      try {
        raw = await readFile(join(home, "auth.json"), "utf8");
      } catch {
        return { fingerprint: null };
      }
      let refreshedAt: number | undefined;
      try {
        const parsed = JSON.parse(raw) as { last_refresh?: unknown; tokens?: unknown };
        if (!parsed.tokens) return { fingerprint: null };
        const at = typeof parsed.last_refresh === "string" ? Date.parse(parsed.last_refresh) : Number.NaN;
        refreshedAt = Number.isNaN(at) ? undefined : at;
      } catch {
        return { fingerprint: null };
      }
      return { fingerprint: sha256(`codex:chatgpt:${raw}`), ...(refreshedAt === undefined ? {} : { refreshedAt }) };
    },
    async call(request: ProviderCall) {
      const home = codexHome();
      if (!home) throw new ProviderError("fatal", `codex: ${provider.codexHomeEnv} is not set`);
      if (provider.auth === "api_key") await mkdir(home, { recursive: true });
      const key = provider.auth === "api_key" ? apiKey() : null;
      if (provider.auth === "api_key" && !key) throw new ProviderError("auth", "codex: API key is not configured");
      const price = config.pricingUsdPerMTok[request.model];
      if (!price) throw new ProviderError("fatal", `codex: no price entry for ${request.model}`);

      const childEnv: Record<string, string> = { CODEX_HOME: home };
      for (const name of ["PATH", "HOME", "LANG", "TMPDIR", ...(request.tools?.server.passEnv ?? [])]) {
        const value = env[name];
        if (value !== undefined) childEnv[name] = value;
      }
      const codexConfig: NonNullable<CodexOptions["config"]> = {
        developer_instructions: request.system,
        project_doc_max_bytes: 0,
        forced_login_method: provider.auth === "api_key" ? "api" : "chatgpt",
        cli_auth_credentials_store: "file",
        history: { persistence: "none" },
        features: {
          shell_tool: false,
          unified_exec: false,
          apps: false,
          hooks: false,
          memories: false,
          multi_agent: false,
          goals: false,
          remote_plugin: false,
          skill_mcp_dependency_install: false,
          view_image: false,
        },
      };
      if (request.tools) {
        codexConfig.mcp_servers = {
          [MCP_SERVER]: {
            command: request.tools.server.command,
            args: request.tools.server.args,
            env: request.tools.server.env,
            env_vars: request.tools.server.passEnv,
            enabled_tools: request.tools.allowed,
            required: true,
          },
        };
      }
      const create = factory ?? (await loadCodexFactory());
      const codex = create({ env: childEnv, config: codexConfig, ...(key ? { apiKey: key } : {}) });

      const cwd = await mkdtemp(join(tmpdir(), "ironwrap-codex-"));
      let turn: RunResult;
      try {
        const thread = codex.startThread({
          model: request.model,
          sandboxMode: "read-only",
          workingDirectory: cwd,
          skipGitRepoCheck: true,
          approvalPolicy: "never",
          networkAccessEnabled: false,
          webSearchMode: "disabled",
          modelReasoningEffort: request.effort,
        });
        turn = await thread.run(request.prompt, { outputSchema: request.outputSchema, signal: request.signal });
      } catch (error) {
        if (request.signal.aborted) throw new ProviderError("aborted", "the run was cancelled");
        throw new ProviderError(classifyText(String(error)), `codex: ${String(error)}`);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }

      const usage: Usage = {
        inputTokens: turn.usage?.input_tokens ?? 0,
        cachedInputTokens: turn.usage?.cached_input_tokens ?? 0,
        outputTokens: turn.usage?.output_tokens ?? 0,
      };
      const costUsd =
        ((usage.inputTokens - usage.cachedInputTokens) * price.input +
          usage.cachedInputTokens * price.cachedInput +
          usage.outputTokens * price.output) /
        1_000_000;
      const toolCalls: ToolCall[] = [];
      for (const item of turn.items) {
        if (item.type === "mcp_tool_call" && item.server === MCP_SERVER) {
          toolCalls.push({ tool: item.tool, arguments: item.arguments });
        }
      }
      if (costUsd > request.maxCostUsd) {
        throw new ProviderError("budget", "codex: the per-call cost ceiling was exceeded", { usage, costUsd });
      }
      let output: unknown;
      try {
        output = JSON.parse(turn.finalResponse);
      } catch {
        throw new ProviderError("invalid_output", "codex: the final response is not JSON", { usage, costUsd });
      }
      return { output, usage, costUsd, modelsUsed: [], toolCalls };
    },
  };
}

async function loadCodexFactory(): Promise<CodexFactory> {
  const { Codex } = await import("@openai/codex-sdk");
  return (options) => new Codex(options);
}
