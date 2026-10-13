# agent-host

Long-running runtime for the IronWrap AI team: the orchestrator face and the specialists. It runs
outside the Cloudflare Worker, calls only the governed Worker action catalog, and never writes D1
or a provider directly. Every model output is an untrusted proposal under
[`docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md`](../docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md) and the
coordination loop in [`docs/AI-NATIVE-ARCHITECTURE.md`](../docs/AI-NATIVE-ARCHITECTURE.md).

This package currently holds the provider gateway. The host service, Worker-side coordination
record, shared memory, watch scheduler, and replay harness land in later slices.
`specialists/` and `evals/` are owned by the specialist track.

## Provider gateway

`src/gateway/` is one interface over Claude (Claude Agent SDK) and Codex (Codex SDK).
`ProviderGateway.run(request)` returns either a schema-valid output or an abstention with a stable
reason. It never throws for a provider failure and never switches provider or model to rescue a
call: when a provider is unavailable, the specialists routed to it abstain and say why.

Routing lives in [`config/gateway.json`](config/gateway.json):

| Tier | Provider | Default model | Used by |
|---|---|---|---|
| `routine` | Codex | `gpt-6.1-sol` | every proposing specialist |
| `hard` | Codex | `gpt-6-astra` | the same specialists, for pricing anomalies, fraud and disputes |
| `audit` | Claude | `claude-opus-5-5` | `independent_auditor` only |

The configuration refuses an audit route on the same provider as a proposer route, and an auditor
that may also propose, so audit always runs on a different model family. Models, effort, ceilings
and retry are configuration; dropping the auditor to another Claude model needs no code change.

### Credentials

The configuration names environment variables, never values (`*_env` keys).

| Provider | `auth` | Credential |
|---|---|---|
| Claude | `oauth` (default) | `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token` |
| Claude | `api_key` | `ANTHROPIC_API_KEY` |
| Codex | `chatgpt` (default) | ChatGPT sign-in in `$CODEX_HOME/auth.json`, from `codex login` |
| Codex | `api_key` | `CODEX_API_KEY` |

Changing `auth` swaps a provider to an API key; nothing else changes. Credentials are read on every
call, so a rotated token or a refreshed `auth.json` is picked up without a restart. The Codex CLI
refreshes `auth.json` itself, so `CODEX_HOME` must be persistent and writable by the host. A
credential the provider rejected is not retried until it changes or `auth_probe_after_ms` passes,
when one probe call is allowed. An API-key Codex run without `CODEX_HOME` uses a private home under
the state directory.

### Isolation

Each run gets an empty temporary working directory and a subprocess environment rebuilt from
`PATH`, `HOME`, `LANG`, `TMPDIR` and the one credential the auth mode names. Claude runs with no
built-in tools, no filesystem settings, hooks or `CLAUDE.md`, no session persistence, and a
gateway-owned `CLAUDE_CONFIG_DIR`. Codex runs with the shell and every optional tool disabled, a
read-only sandbox, no network or web search, no `AGENTS.md`, and no history. The only callable
tools are the allowlisted actions on one MCP server named `ironwrap`; their secrets are forwarded
by name (`passEnv`), never placed on a command line. Output must match a strict JSON Schema subset
(`src/gateway/schema.ts`) and is re-validated by the gateway; an unknown field is an abstention.

### Ceilings, retry and stop

- Call and cost ceilings per specialist and for the team over a rolling window, kept in the
  append-only `<state>/gateway-usage.jsonl`. Every attempt is booked at its per-call cost ceiling
  before it starts and settled to the actual cost after, so concurrent runs cannot overshoot and a
  crash or restart cannot reset a ceiling. If the file cannot be written, the gateway refuses
  every further run (`ledger_unavailable`). Codex cost is notional, from the configured price
  table; Claude cost is the SDK estimate.
- Short rate limits and transient failures retry with jittered exponential backoff. A rate limit
  longer than `max_delay_ms` puts the provider into a cooldown in which runs abstain without
  calling it.
- Kill switch: a `KILL` file in the state directory or `AGENT_HOST_KILL=1` stops every run before
  any provider call.
- Claude reports the models it used; any model other than the configured one, including the
  CLI's own refusal fallback, is an abstention (`model_mismatch`). Codex reports none, so its
  runs are recorded under the configured model.
- `ProviderGateway.health()` reports per-provider state and alerts: `kill_switch_engaged`,
  `ledger_unavailable`, `<provider>_credential_missing`, `<provider>_auth_failed`,
  `<provider>_cooldown`, and
  `codex_signin_not_refreshing` when `auth.json` has not refreshed within
  `signin_max_age_hours`.

## Commands

```bash
npm ci --omit=optional   # SDK code without the Claude and Codex CLI binaries
npm test
npm run typecheck
```

Tests use injected fakes for both SDKs and never call a provider. A live run needs the optional
platform binaries (`npm ci`) and a signed-in credential.

## Proof state

Locally-validated: `npm test` and `npm run typecheck` in this package. No live provider call has run
through the gateway yet; that is Blocked: an owner-provisioned `CLAUDE_CODE_OAUTH_TOKEN` and a
Codex ChatGPT sign-in on the host.
