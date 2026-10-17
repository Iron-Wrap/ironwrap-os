// Codex through the Codex SDK. With a ChatGPT sign-in the CLI reads and refreshes
// `$CODEX_HOME/auth.json` itself, so CODEX_HOME must be a persistent, writable directory owned by
// the agent host. With an API key the key travels in the subprocess environment, never on argv.
// The run is isolated: shell and every optional tool disabled, read-only sandbox, no network, no
// web search, no AGENTS.md, no history, an empty working directory.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexOptions, ThreadOptions, TurnOptions, RunResult } from "@openai/codex-sdk";
import type { GatewayConfig } from "./config.ts";
import { sha256 } from "./schema.ts";
import { ProviderError, classifyText, type ProviderAdapter, type ProviderCall, type ToolCall, type Usage } from "./types.ts";

export interface CodexLike {
  startThread(options: ThreadOptions): { readonly id?: string | null; run(input: string, options: TurnOptions): Promise<RunResult> };
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
      let plan: string | undefined;
      try {
        const parsed = JSON.parse(raw) as { last_refresh?: unknown; tokens?: { id_token?: unknown } };
        if (!parsed.tokens) return { fingerprint: null };
        const at = typeof parsed.last_refresh === "string" ? Date.parse(parsed.last_refresh) : Number.NaN;
        refreshedAt = Number.isNaN(at) ? undefined : at;
        plan = planClaim(parsed.tokens.id_token);
      } catch {
        return { fingerprint: null };
      }
      return {
        fingerprint: sha256(`codex:chatgpt:${raw}`),
        ...(refreshedAt === undefined ? {} : { refreshedAt }),
        ...(plan === undefined ? {} : { plan }),
      };
    },
    async call(request: ProviderCall) {
      const home = codexHome();
      if (!home) throw new ProviderError("fatal", `codex: ${provider.codexHomeEnv} is not set`);
      // A personal CODEX_HOME carries its own config.toml (MCP servers, profiles, trust) that
      // command-line overrides cannot remove; the host needs a home of its own.
      if (existsSync(join(home, "config.toml"))) {
        throw new ProviderError("fatal", `codex: ${provider.codexHomeEnv} holds a config.toml; give the agent host a dedicated home`);
      }
      if (provider.auth === "api_key") await mkdir(home, { recursive: true });
      const key = provider.auth === "api_key" ? apiKey() : null;
      if (provider.auth === "api_key" && !key) throw new ProviderError("auth", "codex: API key is not configured");
      // Own entries only: a model named like a prototype member (`toString`) has no price.
      const price = Object.hasOwn(config.pricingUsdPerMTok, request.model) ? config.pricingUsdPerMTok[request.model] : undefined;
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
      const startedAt = Date.now();
      let turn: RunResult;
      let threadId: string | null = null;
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
        threadId = thread.id ?? null;
      } catch (error) {
        if (request.signal.aborted) throw new ProviderError("aborted", "the run was cancelled");
        const kind = classifyText(String(error));
        if (kind === "plan") {
          throw new ProviderError("plan", `codex: plan does not include model ${request.model}; sign the agent host's ${provider.codexHomeEnv} in with a ChatGPT plan that includes it`);
        }
        throw new ProviderError(kind, `codex: ${String(error)}`);
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
      const modelsUsed = threadId ? await rolloutModels(home, threadId, startedAt) : [];
      return { output, usage, costUsd, modelsUsed, toolCalls };
    },
  };
}

/** The subscription plan an id token claims; the token is read for this one field and nothing else. */
function planClaim(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"] as { chatgpt_plan_type?: unknown } | undefined;
    return typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The models the CLI ran the thread's turns with, from its session rollout
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl`, `turn_context.model`). The SDK's
 * events do not carry the model, so this is the provider-side record of it; none found is empty.
 */
async function rolloutModels(home: string, threadId: string, startedAt: number): Promise<string[]> {
  const days = new Set<string>();
  for (const at of [startedAt - 86_400_000, startedAt, Date.now(), Date.now() + 86_400_000]) {
    const day = new Date(at);
    days.add(join(String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0")));
  }
  const models = new Set<string>();
  for (const day of days) {
    const dir = join(home, "sessions", day);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((entry) => entry.startsWith("rollout-") && entry.endsWith(`-${threadId}.jsonl`))) {
      // The turn is already billed: an unreadable record loses the model, never the answer.
      let text: string;
      try {
        text = await readFile(join(dir, name), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.includes('"turn_context"')) continue;
        try {
          const record = JSON.parse(line) as { type?: unknown; payload?: { model?: unknown } };
          if (record.type === "turn_context" && typeof record.payload?.model === "string") models.add(record.payload.model);
        } catch {
          // A partial last line is not a record.
        }
      }
    }
  }
  return [...models];
}

async function loadCodexFactory(): Promise<CodexFactory> {
  const { Codex } = await import("@openai/codex-sdk");
  return (options) => new Codex(options);
}
