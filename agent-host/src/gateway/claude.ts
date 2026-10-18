// Claude through the Claude Agent SDK. The CLI subprocess runs isolated: no built-in tools, no
// filesystem settings, hooks or CLAUDE.md, no session persistence, an empty working directory, a
// gateway-owned config directory, and an environment rebuilt from scratch that carries only the
// one credential the configured auth mode names. Only allowlisted MCP tools are callable.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { GatewayConfig } from "./config.ts";
import { sha256 } from "./schema.ts";
import {
  ProviderError,
  classifyText,
  limitResetMs,
  zeroUsage,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderErrorKind,
  type ToolCall,
  type Usage,
} from "./types.ts";

export type ClaudeQuery = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

const MCP_PREFIX = "mcp__ironwrap__";
const AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "billing_error"]);

export function createClaudeAdapter(
  config: GatewayConfig,
  stateDir: string,
  env: Record<string, string | undefined>,
  query?: ClaudeQuery,
): ProviderAdapter {
  const provider = config.providers.claude;
  const credentialName = provider.auth === "oauth" ? provider.oauthTokenEnv : provider.apiKeyEnv;
  const readCredential = () => env[credentialName]?.trim() || null;

  return {
    id: "claude",
    authMode: provider.auth,
    async credential() {
      const value = readCredential();
      return { fingerprint: value ? sha256(`claude:${provider.auth}:${value}`) : null };
    },
    async call(request: ProviderCall) {
      const secret = readCredential();
      if (!secret) throw new ProviderError("auth", "claude credential is not configured");
      const run = query ?? ((await import("@anthropic-ai/claude-agent-sdk")).query as ClaudeQuery);
      const cwd = await mkdtemp(join(tmpdir(), "ironwrap-claude-"));
      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      if (request.signal.aborted) abortController.abort();
      else request.signal.addEventListener("abort", onAbort, { once: true });

      const childEnv: Record<string, string | undefined> = {
        PATH: env.PATH,
        HOME: env.HOME,
        LANG: env.LANG,
        TMPDIR: env.TMPDIR,
        CLAUDE_CONFIG_DIR: join(stateDir, "claude-config"),
        CLAUDE_AGENT_SDK_CLIENT_APP: "ironwrap-agent-host/0.1.0",
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        [provider.auth === "oauth" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"]: secret,
      };
      for (const name of request.tools?.server.passEnv ?? []) childEnv[name] = env[name];

      const options: Options = {
        model: request.model,
        systemPrompt: request.system,
        tools: [],
        allowedTools: (request.tools?.allowed ?? []).map((name) => MCP_PREFIX + name),
        mcpServers: request.tools
          ? {
              ironwrap: {
                type: "stdio",
                command: request.tools.server.command,
                args: request.tools.server.args,
                env: request.tools.server.env,
              },
            }
          : {},
        strictMcpConfig: true,
        settingSources: [],
        persistSession: false,
        permissionMode: "dontAsk",
        maxTurns: request.maxTurns,
        maxBudgetUsd: request.maxCostUsd,
        effort: request.effort,
        outputFormat: { type: "json_schema", schema: request.outputSchema },
        cwd,
        abortController,
        env: childEnv,
        ...(provider.executablePath ? { pathToClaudeCodeExecutable: provider.executablePath } : {}),
      };

      let result: SDKResultMessage | undefined;
      let assistantError: string | undefined;
      let rateLimitResetMs: number | undefined;
      const fallbackModels: string[] = [];
      const toolCalls: ToolCall[] = [];
      try {
        for await (const message of run({ prompt: request.prompt, options })) {
          if (message.type === "assistant") {
            if (message.error) assistantError = message.error;
            if (message.parent_tool_use_id !== null) continue;
            for (const block of message.message.content) {
              if (block.type === "tool_use" && block.name.startsWith(MCP_PREFIX)) {
                toolCalls.push({ tool: block.name.slice(MCP_PREFIX.length), arguments: block.input });
              }
            }
          } else if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected") {
            const resetsAt = message.rate_limit_info.resetsAt;
            rateLimitResetMs = resetsAt === undefined ? undefined : resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
          } else if (message.type === "system" && message.subtype === "model_refusal_fallback") {
            // The CLI answered on another model after a refusal; report it so the gateway abstains.
            fallbackModels.push(message.fallback_model);
          } else if (message.type === "result") {
            result = message;
          }
        }
      } catch (error) {
        if (request.signal.aborted) throw new ProviderError("aborted", "the run was cancelled");
        const now = Date.now();
        const resetsAt = rateLimitResetMs ?? limitResetMs(String(error), now);
        throw new ProviderError(resetsAt !== undefined ? "rate_limit" : classifyText(String(error)), `claude: ${String(error)}`, resetsAt === undefined ? {} : { retryAfterMs: Math.max(0, resetsAt - now) });
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        await rm(cwd, { recursive: true, force: true });
      }

      if (!result) throw new ProviderError("transient", "claude: the run ended without a result");
      const usage = sumUsage(result);
      const extra = {
        usage,
        costUsd: result.total_cost_usd,
        retryAfterMs: rateLimitResetMs === undefined ? undefined : Math.max(0, rateLimitResetMs - Date.now()),
      };
      if (result.subtype === "success" && !result.is_error) {
        if (result.structured_output === undefined) {
          throw new ProviderError("invalid_output", "claude: no structured output was returned", extra);
        }
        return {
          output: result.structured_output,
          usage,
          costUsd: result.total_cost_usd,
          modelsUsed: [
            ...new Set([
              ...Object.entries(result.modelUsage).map(([key, value]) => value.canonicalModel ?? key),
              ...fallbackModels,
            ]),
          ],
          toolCalls,
        };
      }
      if (result.subtype === "error_max_budget_usd") {
        throw new ProviderError("budget", "claude: the per-call cost ceiling was reached", extra);
      }
      if (result.subtype === "error_max_turns" || result.subtype === "error_max_structured_output_retries") {
        throw new ProviderError("invalid_output", `claude: ${result.subtype}`, extra);
      }
      const detail = result.subtype === "success" ? result.result : result.errors.join("; ");
      const status = result.subtype === "success" ? result.api_error_status ?? undefined : undefined;
      // A subscription limit can arrive only as text ("You've hit your weekly limit · resets …").
      if (rateLimitResetMs === undefined) {
        const now = Date.now();
        const resetsAt = limitResetMs(detail, now);
        if (resetsAt !== undefined) {
          rateLimitResetMs = resetsAt;
          extra.retryAfterMs = Math.max(0, resetsAt - now);
        }
      }
      const kind = rateLimitResetMs !== undefined ? "rate_limit" : classify(assistantError, status, detail);
      throw new ProviderError(kind, `claude: ${assistantError ?? result.subtype}: ${detail}`, extra);
    },
  };
}

function classify(assistantError: string | undefined, status: number | undefined, detail: string): ProviderErrorKind {
  if (assistantError === "rate_limit" || status === 429) return "rate_limit";
  if ((assistantError && AUTH_ERRORS.has(assistantError)) || status === 401 || status === 403) return "auth";
  if (assistantError === "overloaded" || assistantError === "server_error" || (status !== undefined && status >= 500)) {
    return "transient";
  }
  if (assistantError === "max_output_tokens") return "invalid_output";
  if (assistantError === "model_not_found" || assistantError === "invalid_request") return "fatal";
  return classifyText(detail);
}

function sumUsage(result: SDKResultMessage): Usage {
  const usage = zeroUsage();
  for (const model of Object.values(result.modelUsage)) {
    usage.inputTokens += model.inputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens;
    usage.cachedInputTokens += model.cacheReadInputTokens;
    usage.outputTokens += model.outputTokens;
  }
  return usage;
}
