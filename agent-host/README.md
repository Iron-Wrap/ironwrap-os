# agent-host

Long-running runtime for the IronWrap AI team: the orchestrator face and the specialists. It runs
outside the Cloudflare Worker, calls only the governed Worker action catalog, and never writes D1
or a provider directly. Every model output is an untrusted proposal under
[`docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md`](../docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md) and the
coordination loop in [`docs/AI-NATIVE-ARCHITECTURE.md`](../docs/AI-NATIVE-ARCHITECTURE.md).

This package holds the provider gateway (`src/gateway/`) and the host service (`src/host/`). The
Worker-side coordination record, signal transport, policy decisions and receipts live in
`workers-bus/src/agents/`. Shared-memory read models, standing-watch scheduling and the release
replay harness remain later slices. `specialists/` and `evals/` are owned by the specialist track.

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

## Host service

`src/host/main.ts` is the long-running process. Each pass it:

1. retries run closes that failed earlier (`<state>/pending-closes.jsonl`);
2. pulls signals from the Worker after the persisted cursor (`<state>/signal-cursor`);
3. runs each signal as one coordination run, with bounded concurrency;
4. advances the cursor only when the whole batch is handled, so a crash re-delivers at most one
   batch, and runs are idempotent by `host_run_key` (derived from the signal and specialist);
5. sends a heartbeat with the gateway's readiness and alerts to the Worker.

One run: the Worker opens it and returns the goal, the context snapshot and the run's tool list;
the host loads the specialist (`COMMON.md`, `playbook.md`, `allowlist.json`, failing closed on a
malformed file) and assembles the input in the order `specialists/README.md` defines. The context
snapshot and signal go in as data behind a per-run random marker, so untrusted text cannot forge
the end of the data block. The gateway call exposes only the tools both the Worker and the
allowlist permit, through the stdio action server `mcp/ironwrap-bus-mcp/src/agent-server.mjs`:
every tool call there becomes a proposed step that the Worker decides. The run is then closed with
the exact outcome; an abstention (provider down, ceiling, invalid output, unloadable specialist)
closes the run too, with its reason.

`GET /health` always answers with the full state and alerts; `GET /ready` answers 503 until every
routed provider is usable and the Worker answered a recent poll. Both bind to loopback.

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_HOST_STATE_DIR` | required | Absolute, persistent, writable state directory |
| `AGENT_HOST_WORKER_URL` | required | Worker origin; HTTPS unless `AGENT_HOST_ALLOW_INSECURE_LOCAL=true` and loopback |
| `AGENT_HOST_WORKER_TOKEN` | required | Agent API token; equals the Worker secret `AGENT_HOST_TOKEN` |
| `AGENT_HOST_PORT`, `AGENT_HOST_BIND` | `8790`, `127.0.0.1` | Health server; a non-loopback bind also needs `AGENT_HOST_BIND_PUBLIC=true` (containers only) |
| `AGENT_HOST_POLL_MS`, `AGENT_HOST_BATCH_SIZE`, `AGENT_HOST_CONCURRENCY` | `15000`, `20`, `4` | Signal polling |
| `AGENT_HOST_GATEWAY_CONFIG`, `AGENT_HOST_SPECIALISTS_DIR`, `AGENT_HOST_ACTION_SERVER` | package paths | Overrides for tests and images |

### Worker agent API

The host and the action server call only these Worker routes, with
`Authorization: Bearer <AGENT_HOST_TOKEN>`. The Worker owns every decision
([`workers-bus/src/agents/`](../workers-bus/src/agents/api.ts)).

| Route | Caller | Contract |
|---|---|---|
| `GET /api/v1/agents/signals?after&limit` | host | `{signals[], next_cursor}`; a signal names its specialist, kind (`event`, `watch`, `owner_request`, `handoff`), subject and untrusted content |
| `POST /api/v1/agents/runs` | host | `{signal_id, specialist_id, host_run_key}` opens or returns the run: `{run_id, goal, context: {snapshot_hash, facts[]}, tools[]}`; 409 when that key's run is already closed |
| `GET /api/v1/agents/runs/:id/tools` | action server | the run's tools: `action_id`, `tool_name`, `autonomy`, `side_effect_class`, `undo`, `description`, strict `args_schema` |
| `POST /api/v1/agents/runs/:id/steps` | action server | `{action_id, args, citations[{fact_id, version}], step_key}` returns the Worker's decision; `step_key` (SHA-256 of the canonical step) makes a repeated proposal answer once; unknown action, unknown field, missing or stale citation is an abstention |
| `POST /api/v1/agents/runs/:id/close` | host | terminal outcome: status, abstention reason, structured output, model and models used, hashes, usage, cost, tool calls; `model` and `hashes` are null when no model ran |
| `POST /api/v1/agents/host/heartbeat` | host | readiness, alerts, `in_flight` and the close and dead-letter `backlog`, so a sign-in that stopped refreshing or a stalled feed reaches the owner |

Only a refusal of the request's own content (400, 410, 413, 422) is permanent: that signal goes to
`<state>/rejected-signals.jsonl` with its payload, or that close to `<state>/rejected-closes/`.
Every other failure (401, 403, 404, 429, 5xx, a non-JSON page) is retried, so a rotated token or a
route not deployed yet stalls the feed instead of dropping work. The `signals_rejected` and
`closes_rejected` alerts stay until an operator has dealt with the entries: move a rejected close
back into `<state>/pending-closes/` to resend it, and remove `rejected-signals.jsonl` once its
signals are re-raised or dismissed on the Worker.

## Running locally

```bash
(cd agent-host && npm ci)              # with the optional CLI binaries, for live calls
IRONWRAP_LOCAL_AGENT_HOST=on ./start-local-runtime.sh
```

The host starts without sign-ins and reports them as alerts. State goes to
`.runtime-logs/agent-host-state` unless `AGENT_HOST_STATE_DIR` is set. Local sign-ins live outside
the repository, and the host, the launcher and `npm run smoke` read them:

- Claude: `CLAUDE_CODE_OAUTH_TOKEN=<output of claude setup-token>` in
  `~/.config/ironwrap/agent-host.env` (KEY=value lines, `chmod 600`; any other mode is refused).
  Variables already in the environment win over the file.
- Codex: a dedicated `CODEX_HOME`, by default `~/.config/ironwrap/codex`, signed in once with
  `CODEX_HOME=~/.config/ironwrap/codex codex -c cli_auth_credentials_store=file login`; the sign-in
  must land in `auth.json` there, not in the OS keychain. A home with its own `config.toml` (such
  as a personal `~/.codex`) is refused, because its MCP servers and profiles cannot be overridden.

```bash
npm ci --prefix agent-host                # with the optional CLI binaries, for live calls
npm run smoke --prefix agent-host
```

`npm run smoke` makes one tiny structured call per routed tier through the real gateway and prints
status, provider, model and cost. It spends a few tokens of the sign-ins and never runs in CI.

## Production

The host runs as a container on the broker host, under systemd, with the same secret store,
tunnel and restart discipline as the approval brokers:
[`deploy/Containerfile`](deploy/Containerfile),
[`deploy/ironwrap-agent-host.service.example`](deploy/ironwrap-agent-host.service.example) and
[`deploy/agent-host.env.example`](deploy/agent-host.env.example). The volume
`/var/lib/ironwrap-agent-host` holds the state, the dedicated `CODEX_HOME` and `HOME`; it must be
persistent and writable (the unit creates it owned by the container's uid 1000) so the Codex
sign-in keeps refreshing across restarts. Build the image after `agent-host/specialists/` exists on
the built revision. Stopping the host leaves in-flight runs open; the Worker re-delivers their
signals and the restarted host resumes them, so a deploy does not drop work as "aborted". Sign Codex in once
inside the container with the device-code flow:

```bash
podman exec -it ironwrap-agent-host node agent-host/node_modules/@openai/codex/bin/codex.js login --device-auth
```

Use a sign-in made for the host; copying another machine's `auth.json` makes two holders share one
refresh token.

## Commands

```bash
npm ci --omit=optional   # SDK code without the Claude and Codex CLI binaries
npm test
npm run typecheck
```

Tests use injected fakes for both SDKs and never call a provider. A live run needs the optional
platform binaries (`npm ci`) and a signed-in credential.

## Proof state

Locally-validated: `npm test` and `npm run typecheck` in this package, and
`node --test tools/start-local-runtime.test.mjs` for the local launch. The Worker agent API is source-present and its authenticated host-client integration is tested
against SQLite with D1 transaction semantics. Unbound actions abstain with `policy_missing`; the
contract catalog alone does not implement their effects. Shared-memory read models, standing-watch
scheduling and provider replay remain open. Live proof is blocked on an owner-provisioned Worker
`AGENT_HOST_TOKEN`, Claude OAuth sign-in and a dedicated Codex ChatGPT sign-in, followed by the
authenticated runtime journey and `npm run smoke`. No provider or QA activation is established by
these local checks.
