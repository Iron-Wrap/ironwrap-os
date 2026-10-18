# agent-host

Long-running runtime for the IronWrap AI team: the orchestrator face and the specialists. It runs
outside the Cloudflare Worker, calls only the governed Worker action catalog, and never writes D1
or a provider directly. Every model output is an untrusted proposal under
[`docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md`](../docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md) and the
coordination loop in [`docs/AI-NATIVE-ARCHITECTURE.md`](../docs/AI-NATIVE-ARCHITECTURE.md).

This package holds the provider gateway (`src/gateway/`), the host service (`src/host/`) and the
replay and qualification runner (`src/replay/`). The Worker-side coordination record, signal
transport, policy decisions and receipts live in `workers-bus/src/agents/`. Shared-memory read
models and standing-watch scheduling remain later slices. `specialists/` and `evals/` are owned by
the specialist track.

## Provider gateway

`src/gateway/` is one interface over Claude (Claude Agent SDK) and Codex (Codex SDK).
`ProviderGateway.run(request)` returns either a schema-valid output or an abstention with a stable
reason. It never throws for a provider failure and never switches provider or model to rescue a
call: when a provider is unavailable, the specialists routed to it abstain and say why.

Routing lives in [`config/gateway.json`](config/gateway.json) (`ironwrap_agent_gateway_config_v2`).
`routes` names each provider, model and effort once, and `tiers` maps each runtime tier to a route:

| Tier | Route | Provider and model | Used by |
|---|---|---|---|
| `routine` | `codex_sol` | Codex `gpt-6.1-sol` | every proposing specialist |
| `hard` | `codex_astra` | Codex `gpt-6-astra` | the same specialists, for pricing anomalies, fraud and disputes |
| `audit` | `claude_opus` | Claude `claude-opus-5-5` | `independent_auditor`, for a run that reviews no other run |

A run takes the route of its expected action (`specialists.<id>.actions`), else its specialist's
(`specialists.<id>.route`), else its tier's. `specialists.<id>.tiers` stays the allowlist, and only
the auditor may use `audit`; the auditor takes no route of its own.

Audit independence is per run. A run that reviews another names it in `reviewOf` (run id and the
provider that proposed it), and the auditor then runs on `audit_routes.<that provider>`:
`claude_opus` for Codex work, `codex_astra` for Claude work. The configuration refuses an audit
route on the family it audits and needs one for every family a proposer route uses, so a proposer
may run on Claude. The gateway checks again per run: with no route of another family it abstains
with `no_independent_route`, before any provider call or ceiling booking and without a fallback.
An audit that names no run under review uses `tiers.audit` only while no proposer route is on that
route's family; otherwise it abstains the same way.
Models, effort, ceilings and retry are configuration; dropping the auditor to another Claude model
needs no code change.

### Shadow and eval books

`scope` on a request picks the books it spends from:

- `production` (default): the live ceilings.
- `shadow`: `ceilings.shadow`, a separate low budget under `shadow:<specialist>` ledger keys. Team
  totals are per namespace, so shadow spend never counts toward the live ceilings, nor live spend
  toward shadow.
- `eval`: only on an eval gateway, one constructed with the `ledger` and `judge` blocks of
  [`evals/qualification.v1.json`](evals/qualification.v1.json) (option `qualification`, validated
  strictly; the ledger must be `isolated`). It books in `<state>/gateway-usage-eval.jsonl`, never
  the production file, under `eval:` keys against that block's team, specialist and judge
  ceilings, and treats a request of any other scope as a programming error; a production gateway
  refuses `eval` the same way. A judge request names `judge_key` as its specialist and the run it
  scores in `reviewOf`. It skips the tier allowlist and runs on `judge.default` for Codex work or
  `judge.for_claude_proposers` for Claude work, abstaining with `no_independent_route` when that
  route is of the scored run's family. `tierRoutes` replaces a proposing tier's route for one batch
  (the stage-0 model comparison), ahead of action and specialist routes; the auditor's routing is
  unchanged. For `per_stage`, the runner gives each stage its own state directory.

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

- Call and cost ceilings per specialist and for the team of each namespace (live, shadow, eval) over
  a rolling window, kept in the append-only `<state>/gateway-usage.jsonl`; records without a
  namespace prefix are live. Every attempt is booked at its per-call cost ceiling
  before it starts and settled to the actual cost after, so concurrent runs cannot overshoot and a
  crash or restart cannot reset a ceiling. If the file cannot be written, the gateway refuses
  every further run (`ledger_unavailable`). Codex cost is notional, from the configured price
  table; Claude cost is the SDK estimate.
- Short rate limits and transient failures retry with jittered exponential backoff. A rate limit
  longer than `max_delay_ms` puts the provider into a cooldown in which runs abstain without
  calling it.
- An abstention carries `retryAt` (epoch ms) when waiting can help: the cooldown end for
  `rate_limited`; for a ledger `call_ceiling` or `cost_ceiling`, the latest moment at which the
  oldest reservation counted against each refusing ceiling leaves the window (a call that settles
  below its reservation can free cost room sooner); the next probe (`auth_probe_after_ms` after
  the refusal) for a model the provider refused for the sign-in's plan; now plus the attempt's
  backoff for any other `provider_error` and for `model_mismatch`. `no_independent_route`,
  `ledger_unavailable`, the stop reasons, a sign-in on a plan outside `chatgpt_plans` and a single
  call stopped at its per-call cost ceiling (`cost_ceiling` from the provider) carry none.
- Kill switch: a `KILL` file in the state directory or `AGENT_HOST_KILL=1` stops every run before
  any provider call.
- Models used: Claude reports them in its result, and any model other than the configured one,
  including the CLI's own refusal fallback, is an abstention (`model_mismatch`). Codex's SDK
  events report none; the gateway records the model the Codex CLI ran the thread's turns with,
  from its session rollout under `$CODEX_HOME/sessions` (`turn_context.model`). That is the CLI's
  own record of the model it requested, not a provider confirmation, so `model_mismatch` cannot
  catch a provider-side substitution, and an unreadable rollout records none (the smoke then fails).
  `$CODEX_HOME/sessions` keeps every prompt the CLI ran, unpruned, so it holds run data.
- A Codex ChatGPT sign-in must be on a plan that includes the routed models. `chatgpt_plans` lists
  those plans; a sign-in whose id token claims another plan abstains without a call
  (`provider_error`, detail `codex: plan does not include model …`). A model the provider refused
  for a sign-in is not called again on that sign-in until it changes or, once per
  `auth_probe_after_ms`, a single probe succeeds.
- `ProviderGateway.health()` reports per-provider state and alerts: `kill_switch_engaged`,
  `ledger_unavailable`, `<provider>_credential_missing`, `<provider>_auth_failed`,
  `<provider>_cooldown`, `codex_plan_lacks_model` (the provider is then not ready), and
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

The context snapshot starts with the signal (`signal/<id>`, untrusted text) and then holds the
signal's subject and the canonical objects it links to, read by the Worker's shared-memory read
models (`workers-bus/src/agents/read-models.ts`) through the same readers as the role screens and
only as far as the specialist's reviewer role may read them. The face answering a person's ask
reads them as that person's role at ask time instead, on open, on resume and for every citation, so
it never sees a fact the asker could not. A role that may read part of an object gets one fact per
part, such as `job/<id>#/facts/commercial/quote`. Each fact carries `{fact_id,
kind, version, hash, trust, observed_at, fresh_until, data}`; its version comes from the Worker's
append-only fact-version ledger, so it moves whenever the value does. An object that belongs in the
snapshot but cannot be read or does not fit is named in `context.omitted` with its reason. A step
may cite a fact or one field of it (`job/<id>#/facts/production/gates/0`); the Worker reads every
cited fact again before deciding, and a changed fact abstains `fact_stale`, an unreadable one
`citation_unverifiable`. The run row keeps only each fact's id, version and hash, never its value:
a resumed run reads the values again, and a fact that changed meanwhile comes back with `data:
null` and `current: false`. Contact values, payee details, provider payloads and free-text notes
stay out of facts; names and references typed at intake are kept as identity fields.

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
| `GET /api/v1/agents/signals?after&limit` | host | `{signals[], next_cursor}`; a signal names its specialist, kind (`event`, `watch`, `owner_request`, `handoff`), subject and untrusted content, and `actor`: for a person's ask or request through the app, `source` is `ask` or `request` and `actor` is `{type: "owner" \| "staff" \| "worker", role, ref: "person:<user_id>", authenticated: true}` from the Worker's record (`owner` only for the owner, `worker` for a field person, `staff` for every other role); every other signal has `actor: null` |
| `POST /api/v1/agents/runs` | host | `{signal_id, specialist_id, host_run_key}` opens or returns the run: `{run_id, goal, context: {snapshot_hash, facts[], omitted[]}, tools[]}` with the routing hints `review_of: {run_id, provider} \| null` (when the auditor reviews another run, so the gateway picks a different family), `expected_action_id: string \| null` (the signal's single expected action) and `mode: "live" \| "shadow"` (`shadow` when every action the signal can lead to is in shadow; missing reads as null and live; any other mode closes the run `unknown_run_mode` with no model call), which reach the gateway as `reviewOf`, `action` and scope; a face run answering a person's ask also carries `output_extension: {view}`, the strict view spec schema, which the host adds to that run's output schema as a required, nullable `view` (every other run's input is unchanged); 409 when that key's run is already closed |
| `GET /api/v1/agents/runs/:id/tools` | action server | the run's tools: `action_id`, `tool_name`, `autonomy`, `side_effect_class`, `undo`, `description`, strict `args_schema` |
| `POST /api/v1/agents/runs/:id/steps` | action server | `{action_id, args, citations[{fact_id, version}], step_key}` returns the Worker's decision; `step_key` (SHA-256 of the canonical step) makes a repeated proposal answer once; unknown action, unknown field, missing or stale citation is an abstention; a shadowed action answers `decision: "shadowed"` with the decision policy would have made (`would_be`) and no receipt |
| `POST /api/v1/agents/runs/:id/close` | host | terminal outcome: status, abstention reason, structured output, model and models used, hashes, usage, cost, tool calls; `model` and `hashes` are null when no model ran, and `model` is null for `no_independent_route`; when the open carried any routing field, `model` also holds `route_id`, `review_of` and `mode`; only an ask run's output may carry `view`, which the Worker checks and records as the spec or null |
| `POST /api/v1/agents/host/heartbeat` | host | readiness, alerts, `in_flight` and the close and dead-letter `backlog`, so a sign-in that stopped refreshing or a stalled feed reaches the owner |

### Owner controls and human decisions

People use their authenticated app session on `/api/v1/agent-team/`; the host bearer cannot enter
that surface. Reviewers see only the receipts and exact proposals assigned to them; owner/ops retain
the team receipt queue. Every mutation requires CSRF and an `Idempotency-Key`. The Worker rechecks the live
session and role inside its atomic write, so revocation or a role change after authentication fails
closed. Delegation and pause/hold controls require an owner sign-in no older than five minutes;
request fields cannot claim that sign-in or a person's approval.

| Route | Behavior |
|---|---|
| `GET /api/v1/agent-team/specialists/:id` | Current controls, delegation revisions, bounded settings and decision history |
| `POST /api/v1/agent-team/specialists/:id/delegation` | Owner-only setting or revocation, exact expected revision and required ceiling |
| `POST /api/v1/agent-team/specialists/:id/control` | Owner pause/resume or hold clearance, exact expected revision |
| `GET /api/v1/agent-team/steps/:id` | Owner or named reviewer reads the exact arguments, version, hash and receipt |
| `POST /api/v1/agent-team/steps/:id/decision` | Current reviewer role or owner approves, declines or takes over the exact step version and argument hash |
| `GET /api/v1/agent-team/exceptions` | Owner/ops queue with the assigned person and acknowledgement state |
| `POST /api/v1/agent-team/exceptions/:id/acknowledge` | The assigned person, reviewer role or owner acknowledges the exception |
| `POST /api/v1/agent-team/ask` | Anyone signed in asks the face: `{question, context: {route, object} \| null}` becomes an `owner_request` to `orchestrator` from `ask:<user_id>`, answering 202 `{ask_id, status: "pending"}`; a replay returns the same ask, another request under the key conflicts. A run never starts on an ask older than 15 minutes (the run open answers 409 `ask_expired`) |
| `GET /api/v1/agent-team/ask/:id` | The asker or the owner (404 for anyone else): `pending`; `done` with the answer, its sources (every fact the steps and the shown view cite), the checked view, the answer receipt and each offered action's delegation; or `abstained` with the close's receipt, whose `needs_from_you` is always null here (a close that names a person reaches that person's Needs you, not the asker). `reason` is `null`, `not_answered` (no run took the ask up within 15 minutes, or its run outlived the run lifetime; no receipt) or `cancelled` |
| `POST /api/v1/agent-team/facts/current` | A read, so CSRF but no Idempotency-Key: `{fact_ids[]}` (100 at most) returns `{facts: [{fact_id, version, hash}], unreadable[]}` as the viewer's role reads them now, never a value. A part keeps the version it is cited at for every reader; an ask's own `signal/<ask_id>` reads for its asker and the owner, no other signal |
| `POST /api/v1/agent-team/requests` | A press on a view's action: `{action_id, target, ask_id}` becomes an `owner_request` to the action's owning specialist, answering 202 `{signal_id}`; it executes nothing, and refuses an unknown, unowned or people-only action, one a view may not offer, and a role that may not request it |

Each person may make 20 asks and 20 requests in any ten minutes, and have 5 asks waiting at once
(those that still read `pending`). The signal insert checks both limits itself, so parallel
requests cannot pass them together; past either the route answers 429 `rate_limited` or
`too_many_pending_asks` with `Retry-After`, the seconds until the window's oldest leaves or the
first waiting ask stops counting. A replay of an earlier request is never limited.

| `POST /api/v1/agent-team/specialists/:id/shadow` | Owner turns shadow on or off for one A1-A3 non-protective action the specialist owns, exact expected revision |
| `GET /api/v1/agent-team/shadow` | Owner/ops agreement per specialist and action: counts per verdict, match and partial rates, catastrophes, recent divergences (`specialist`, `action`, `since` filters) |
| `GET /api/v1/agent-team/shadow/candidates` | Owner/ops list of actions that meet the bar for more delegation; the owner still sets it |
| `POST /api/v1/agent-team/qualifications` | Owner records a qualification report's outcome for a specialist on one route (provider, model, effort) at one release (release and report SHA-256) |

Earned autonomy (migration 0203): a shadowed action's proposals are decided by policy and recorded
as shadow steps, never as receipts, so no permit, person, handoff or effect comes of them while
people keep doing the work. Agreement records compare the agent's proposal with what a person did:
approving the exact proposal is a match, declining it a divergence, taking it over unscored until a
comparator sees what the person did; a shadow step with no comparable action within seven days is
recorded unscored, never counted as agreement. A decline or take-over can flag Track D catastrophes
(`catastrophes` on the decision). A catastrophe opens an owner exception and, for a within-limits
action, writes an asks-first setting as `system:auto_demotion`, the one automatic delegation change.
A candidate needs at least the last 50 compared agreements at a 95 % match rate, none of them a
catastrophe, a passed latest qualification for the provider and model the specialist actually runs
on (its most recent closed run), and a delegable A2/A3 action that
does not already act within limits. An auditor's review that comes back from the reviewed run's own
provider family closes abstained.

Pause and auditor hold remain independent. Either makes non-protective actions ask first; pause
also stops drafting. An off or revoked action stays off. Protective exceptions and holds remain
available under these controls.

An auditor hold executes with an owned-store readback and cannot target the auditor. Its replay
cannot reapply a hold after the owner cleared it. Clearing restores no old delegation: each action
stays asks first until the owner confirms it again. Revocation, pause and a hold cancel unexecuted
delegated permits. Policy/catalog changes and unknown or mismatched delegated readbacks also fall
back to asks first. No H action is registered as an agent tool.

Human decisions are records of a person's choice, never proof that an unbound adapter executed.
Approving the current receipt-only `note.add` stops with `policy_missing`, no tool or readback
success, and a named person still takes over. Business adapters and effect-specific evaluation
remain open. Emergency paging has a strict canonical argument schema, allowing explicit null
unknown job/contact IDs, but remains unavailable until its provider readback path is implemented.
It is absent from active run tools. The owned exception queue does not claim a page was delivered.

Host OAuth-failure and stale-sign-in alerts open one immediate exception for a named owner. A
person acknowledges it; a continuing alert opens another exception after that acknowledgement.
A vacant reviewer assignment stays null and visible; the Worker never invents a person.
No credential renewal or provider switch is performed by the Worker. A replayed run close repairs
its exception queue entry without adding another run or receipt. An ask that ends without an answer
opens no exception and waits in no one's Needs you, and a step the face stops on a question names
nobody either: the asker reads it as abstained. A question that raises an emergency, a safety event
or suspected injection still names a person and opens an exception, as on any run, unless the face's
own escalation already did; the face's protective escalations name their role as on any run.
`access.prepare_change` is refused (`out_of_scope`) unless the run's signal is a signed-in owner's or
staff member's own ask or request.

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

`npm run smoke` makes one tiny structured call per routed tier through the real gateway, plus one
audit of Codex-proposed work that must run on Claude, and prints status, route, provider, model,
the models used and cost; a call fails when its run reports no model used.
It spends a few tokens of the sign-ins and never runs in CI.

## Replay and qualification runner

`src/replay/` runs the specialist evaluations on the production routes, as
[`evals/README.md`](evals/README.md) "Harness interface" and "Qualification run" define them. It
reads the local sign-ins like `npm run smoke` and never runs in CI.

A qualification binds a route (provider, model, effort) and a release. `src/host/release.ts`
defines the release hash once: the SHA-256 of the canonical JSON of {specialist_id,
playbook_sha256, allowlist_sha256, common_sha256, catalog_sha256}, each file hashed over its exact
bytes. The owner records it with the report hash (`POST /api/v1/agent-team/qualifications`).

```bash
npm run qualify --prefix agent-host -- --stage pilot --start     # --resume to continue; one is required
npm run replay --prefix agent-host -- --specialist orchestrator --case orchestrator.golden.001
```

- A case becomes a production-shaped run: its signal and facts form the Signal and the context
  snapshot (case times resolved against the case clock, the signal first as untrusted text), the
  specialist loads as in production, and the production `buildRunInput` assembles the input. The
  replay offers the specialist's full allowlist, worded and ordered as the Worker words its tools,
  with open arguments: the cases follow the contract's argument conventions, and the Worker registry
  has strict schemas for only a few actions, some under other names. A production run sees only the
  actions the registry binds, so `prompt_sha256` matches production only once the registry exposes
  the same actions.
- The case clock is a fixed instant, 14:00 in Edmonton on a summer weekday, unless the case carries
  `clock`: `{ "season": "winter|spring|summer|fall", "weekday": "monday".."sunday", "local_time":
  "HH:MM" }` in Edmonton local time, with no calendar date. The season picks a month (winter
  January, spring April, summer July, fall October, in the default instant's year), the weekday the
  first such day on or after the 8th, and the time is Edmonton's on that day, standard or daylight
  time as Intl reports it. A stage refuses a malformed clock before any run.
- Like every production audit, an auditor run names the run it reviews (`reviewOf`), here with the
  one family all proposer routes use, so it runs on that family's audit route (`claude_opus` for
  Codex work). A stage refuses to qualify the auditor while proposer routes span both families.
- The provider CLI reaches the stdio action server `src/replay/tool-server.ts`, which answers from
  the case alone. An A0 read returns the case facts it names. Every other call is captured, never
  executed, and answered with the Worker's deterministic decision: drafted for A1, escalated for a
  protective action, awaiting approval for other A2 and A3 actions, abstained for an unknown,
  wrong-version or stale citation.
- Runs go through an eval gateway (`qualification` option, `scope: "eval"`) whose state directory
  is `<output_dir>/<stage>/gateway` (`<output_dir>/replay/gateway` for a single-case replay, and
  `<output_dir>/gateway` when `ledger.per_stage` is false), so each stage books in its own
  `gateway-usage-eval.jsonl` and the production ledger is never written. That gateway looks for its `KILL` file there as well: the
  host's `KILL` file does not stop qualification, while `AGENT_HOST_KILL=1` does.
  `concurrency` caps the calls in flight per provider.
  Each repetition is judged with `evals/judge.md` through the judge key on the other family's
  route, and an invalid answer is asked again up to `judge.max_attempts`; `evals/score.mjs` merges
  it and `evals/report.mjs` builds the report.
- `gateway_reasons` decide what an abstention does. `pause` stops new work, keeps progress and
  records `retry_at`, the latest `retryAt`; an abstention without one sets
  `resumable_by_waiting: false`, because waiting alone cannot clear it. `stop` stops the stage.
  `invalid_output` is a failed repetition with a transcript. A resume before `retry_at` is refused,
  also when a stop came with the pause.
- Output goes under `output_dir` (git-ignored; `--output` overrides it). Each stage directory holds
  `state.json` (status, halts, pending repetitions), `manifest.jsonl` (transcripts and judgements
  keyed by specialist, route, case, repetition, `prompt_sha256` and `catalog_sha256`), `calls.jsonl`
  (the usage of every gateway call), `report.json` and `report.md`. A resume skips finished
  repetitions and re-runs those recorded under other hashes; pilot repetitions on production routes
  count as repetition 1 of the waves. A report's usage counts only its own stage's calls, so a wave
  that took pilot repetitions shows fewer runs and judge calls than repetitions scored; the pilot
  report holds their cost. Single-case replays go to `replay/` and always run.
- A wave refuses to start while `evals/action-catastrophes.v1.json` is missing, because its verdict
  needs the mapped catastrophe checks. The pilot runs without it and its report says so in
  `warnings`.
- The CLI refuses a tree that fails `evals/validate.mjs --require-complete` before it reads any
  sign-in. Exit codes: 0 complete, 2 refused, 3 paused, 4 stopped.

Not automated: the orchestrator's start and resume signals; the usage meters (no reader is wired,
so the pilot reports the quota as not visible and leaves that half of its gate to the orchestrator);
picking production routes from the model comparison; re-sizing ledger ceilings after the pilot
gate; and the history evaluation (`evals/history.v1.json`).

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
contract catalog alone does not implement their effects. Shared-memory read models and
standing-watch scheduling remain open. The replay and qualification runner is tested with injected
fakes only; no qualification stage has run on a provider. Live proof is blocked on an owner-provisioned Worker
`AGENT_HOST_TOKEN`, Claude OAuth sign-in and a dedicated Codex ChatGPT sign-in, followed by the
authenticated runtime journey and `npm run smoke`. No provider or QA activation is established by
these local checks.
