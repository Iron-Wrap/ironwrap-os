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

`src/gateway/` is one interface over the tenant's provider accounts, each behind its adapter: the
Claude Agent SDK (`claude_agent_sdk`) or the Codex SDK (`codex`). `ProviderGateway.run(request)`
returns either a schema-valid output or an abstention with a stable reason. It never throws for a
provider failure and never switches provider or model to rescue a call, except along the route's
declared fallback chain (below); when no hop can serve a run, the specialist abstains and says why.

Routing lives in [`config/gateway.json`](config/gateway.json) (`ironwrap_agent_gateway_config_v3`),
one file per host and so per tenant (`AGENT_HOST_GATEWAY_CONFIG` selects another). `providers` holds
the accounts; `routes` names each account, model and effort once, with its `fallback`; `tiers` maps
each runtime tier to a route:

| Tier | Route | Account and model | Used by |
|---|---|---|---|
| `routine` | `codex_sol` | `codex`: `gpt-6.1-sol` | every proposing specialist |
| `hard` | `codex_astra` | `codex`: `gpt-6-astra` | the same specialists, for pricing anomalies, fraud and disputes |
| `audit` | `claude_opus` | `claude`: `claude-opus-5-5` | `independent_auditor`, for a run that reviews no other run |

A run takes the route of its expected action (`specialists.<id>.actions`), else its specialist's
(`specialists.<id>.route`), else its tier's. `specialists.<id>.tiers` stays the allowlist, and only
the auditor may use `audit`; the auditor takes no route of its own. A v2 file is refused with the
command that converts it: `node src/gateway/upgrade-config.ts v2.json > v3.json` keeps every route,
tier, ceiling and specialist, maps `claude` to the `anthropic` family and `codex` to `openai`, and
writes nulls for what v2 never held (context windows, output limits, compliance refs), which an
operator fills from provider docs before the file parses.

### Capability registry

Each account holds the models it serves (`providers.<id>.models.<model>`), because the same model
has other capabilities, limits and prices behind another account. An entry names the model's
`family` (the authority for independence), `tools`, `json_schema` (`native` or `validated`),
`context_tokens`, `max_output_tokens`, the `efforts` it takes, its `price` (`usd_per_mtok` on an API
account; on a subscription, the `subscription` and an optional `list_usd_per_mtok`, which the Codex
adapter books), and `rate_limits` per minute (null for none). Every figure is either cited in
`sources` with the provider doc and the date it was read, or listed in `unverified`; a live run
refuses an entry with an unverified figure. A route on a model or effort the registry does not hold
fails the load: unregistered models are never routed. Before any booking a hop must fit the run: a
run with tools needs `tools`, and the estimated input (characters / 3) plus `max_output_tokens`
must fit `context_tokens`.

### Families and audit independence

Audit independence is per run and per family. A run that reviews another names it in `reviewOf`
(run id and the family that proposed it), and the auditor runs on `audit_routes.<that family>`:
`claude_opus` for `openai` work, `codex_astra` for `anthropic` work. The configuration refuses an
audit route whose chain reaches the family it audits and needs one for every family a proposer
route (or its fallback) uses, so a proposer may run on Claude. The gateway checks again on every
hop: a hop of the reviewed family is skipped, and with none left the run abstains with
`no_independent_route`, before any provider call or ceiling booking. Work on a family the registry
does not hold has no reviewer. An audit that names no run under review uses `tiers.audit` only
while no proposer route is on that route's family; otherwise it abstains the same way. The v2
provider ids `claude` and `codex` are never family names; the Worker's legacy review hint
(`review_of.provider`) maps to its family the same way the converter does.

### Declared failover

`routes.<id>.fallback` names the next route to try, or null. A chain is at most two fallbacks
deep, acyclic and of one family, and `retry.max_attempts` times its hops stays within the ten
attempts the Worker counts on a run. Only production runs follow a chain; shadow and eval runs keep
their primary route, so their measurements stay on one model. Before any booking every hop is
screened, in this order: a hop of the reviewed family is skipped; a live or shadow run needs a
qualification for the hop (below), and every run a hop that fits it, else the primary abstains
`no_qualified_route` without failing over and a fallback is skipped; then the account must be one
the run may use, enabled and on terms that serve the run's class (`provider_disabled`), not cooling
down or at its rate window (`rate_limited`), with a present, unrejected credential on a plan that
includes the model. Only `rate_limited`, `provider_error`, `auth_failed`, `credential_missing` and
`provider_disabled` move on to the next hop; `invalid_output`, `model_mismatch`, the ceilings,
`ledger_unavailable`, `aborted` and the kill switch end the run, because failing over then would
switch models to rescue output or budget. The kill switch, a cancellation and the rate window are
checked again before every attempt, retries and later hops included, so a run engaged by `KILL`
mid-chain books nothing more. With every hop spent the run abstains with the primary's
reason and the earliest `retryAt` any hop named. Every result lists the hops it passed over or
failed on (`failover`), says whether its route is the `primary` or a `declared_fallback`, and
carries the configuration's SHA-256.

### Qualification gate

A live or shadow run takes only a hop the owner qualified: the Worker sends the specialist's current
qualifications with the run (`qualifications`, from `agent_qualifications`), and one must name the
hop's provider, model and effort at the specialist's release, the `release_sha256` of
`src/host/release.ts` that the host hashes from the specialist's files on disk. The matching
`qualification_id` is recorded on the run. Eval runs and runs on a synthetic host need none.

Until the owner records a qualification for a route at the specialist's release, every live and
shadow run on a business host abstains `no_qualified_route` before any provider call. That
fail-closed outcome is intended: no specialist acts in production on a route nobody qualified. The
Worker checks the close too: output whose `qualification_ref` is not a passed record of the
specialist for the close's provider, model, effort and release, with no failure recorded for its key since,
is recorded as an abstention `no_qualified_route`, and a synthetic host's runs close only on a
Worker whose `AGENT_DATA_CLASS` is `synthetic`. Keep the QA host's unit stopped, or run it with
`AGENT_HOST_DATA_CLASS=synthetic`, until wave-1 qualifications are recorded.

### Provider terms per run class

Every account names its row of [`docs/COMPLIANCE-REGISTER.md`](../docs/COMPLIANCE-REGISTER.md) in
`compliance_ref`, and `src/gateway/compliance.ts` holds the register as code: which adapter and
credential mode each ref is, and which run classes it serves. A run's class is `live` or `shadow`
from its scope, `eval_history` or `synthetic` from an eval request's `data` (unset reads as
history), and `synthetic` for every run on a host whose `AGENT_HOST_DATA_CLASS` is `synthetic`.

| Ref | Serves |
|---|---|
| `ai.anthropic.api`, `ai.anthropic.claude-commercial`, `ai.openai.api` | every class |
| `ai.openai.chatgpt-commercial` | every class; live and shadow only once the owner's `confirmed_retention` is recorded on the account and the sign-in claims a plan (one of `chatgpt_plans`) |
| `ai.anthropic.claude-consumer`, `ai.openai.chatgpt-consumer` | `synthetic` only; `eval_history` under an owner risk acceptance; never live or shadow |

An account with no ref, or whose ref does not serve the run's class, is `provider_disabled` for that
run before anything is booked. `owner_risk_acceptances` may hold one entry per consumer ref, with
`run_class: "eval_history"` and `accepted_by: "owner"` only; the acceptance is recorded on the run
and in the ledger. The shipped configuration names the commercial refs (Claude Team or Enterprise,
ChatGPT Business or Enterprise, whose plan claims go in `chatgpt_plans`; a personal plan claim is
refused there). [`config/gateway.consumer.json`](config/gateway.consumer.json) is the same file with
the consumer refs and the `pro` plan, for a QA or dev host on synthetic data and for qualification
runs on the owner's personal sign-ins; a test keeps it equal to the shipped file apart from those
labels.

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
  scores in `reviewOf`. It skips the tier allowlist and runs on `judge.for_claude_proposers` for
  `anthropic` work or `judge.default` for any other family, abstaining with `no_independent_route`
  when that route is of the scored run's family. `tierRoutes` replaces a proposing tier's route for
  one batch (the stage-0 model comparison), ahead of action and specialist routes; the auditor's
  routing is unchanged. For `per_stage`, the runner gives each stage its own state directory.

### Credentials

The configuration names environment variables, never values (`secrets.*_env`).

| Adapter | `credential_mode` | `billing` | Credential |
|---|---|---|---|
| `claude_agent_sdk` | `oauth` (default) | `subscription` | `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token` |
| `claude_agent_sdk` | `api_key` | `api` | `ANTHROPIC_API_KEY` |
| `codex` | `oauth` (default) | `subscription` | ChatGPT sign-in in `$CODEX_HOME/auth.json`, from `codex login` |
| `codex` | `api_key` | `api` | `CODEX_API_KEY` |

Moving an account to an API key changes its `credential_mode`, `billing` (the price becomes
`usd_per_mtok`) and `compliance_ref`; nothing else changes. Credentials are read on every
call, so a rotated token or a refreshed `auth.json` is picked up without a restart. The Codex CLI
refreshes `auth.json` itself, so `CODEX_HOME` must be persistent and writable by the host. A
credential the provider rejected is not retried until it changes or `auth_probe_after_ms` passes,
when one probe call is allowed. An API-key Codex run without `CODEX_HOME` uses a private home under
the state directory.

### Isolation

Each run gets an empty temporary working directory and a subprocess environment rebuilt from
`PATH`, `HOME`, `LANG`, `TMPDIR` and the one credential the credential mode names. Claude runs with no
built-in tools, no filesystem settings, hooks or `CLAUDE.md`, no session persistence, and a
gateway-owned `CLAUDE_CONFIG_DIR`. Codex runs with the shell and every optional tool disabled, a
read-only sandbox, no network or web search, no `AGENTS.md`, and no history. The only callable
tools are the allowlisted actions on one MCP server named `ironwrap`; their secrets are forwarded
by name (`passEnv`), never placed on a command line. Output must match a strict JSON Schema subset
(`src/gateway/schema.ts`) and is re-validated by the gateway; an unknown field is an abstention.

### Ceilings, retry and stop

- Call and cost ceilings per specialist and for the team of each namespace (live, shadow, eval) over
  a rolling window, kept in the append-only `<state>/gateway-usage.jsonl`; records without a
  namespace prefix are live. Every attempt on every hop is booked at its per-call cost ceiling
  before it starts and settled to the actual cost after, so concurrent runs cannot overshoot and a
  crash or restart cannot reset a ceiling; each record carries its route, `primary` or
  `declared_fallback`, billing, run class, compliance ref and any risk acceptance. If the file
  cannot be written, the gateway refuses every further run (`ledger_unavailable`). Codex cost is
  notional, from the registry price (cache writes at `cache_write`); Claude cost is the SDK
  estimate. A model with no USD figure books 0 USD and `tokens_per_call` tokens instead, so the
  configuration then needs `tokens` ceilings on every set of books its routes reach; past one the
  run abstains `cost_ceiling`.
- Short rate limits and transient failures retry with jittered exponential backoff. A rate limit
  longer than `max_delay_ms` puts that model of the account into a cooldown in which runs skip it
  without a call. A model's `rate_limits` are kept in memory over a sliding minute; a full window
  is `rate_limited` until its oldest call leaves it.
- An abstention carries `retryAt` (epoch ms) when waiting can help: the cooldown or window end for
  `rate_limited`; for a ledger `call_ceiling` or `cost_ceiling`, the latest moment at which the
  oldest reservation counted against each refusing ceiling leaves the window (a call that settles
  below its reservation can free cost room sooner); the next probe (`auth_probe_after_ms` after
  the refusal) for a model the provider refused for the sign-in's plan; now plus the attempt's
  backoff for any other `provider_error` and for `model_mismatch`; after a failover, the earliest
  of its hops'. `no_independent_route`, `no_qualified_route`, `ledger_unavailable`, the stop
  reasons, a sign-in on a plan outside `chatgpt_plans` and a single call stopped at its per-call
  cost ceiling (`cost_ceiling` from the provider) carry none.
- Kill switch: a `KILL` file in the state directory or `AGENT_HOST_KILL=1` stops every run before
  any provider call.
- Models used: Claude reports them in its result, and any model other than the configured one
  (a dated `-20260901` or `-2026-09-01` id and a `[1m]` suffix are the same model), including the
  CLI's own refusal fallback, is an abstention (`model_mismatch`). Codex's SDK
  events report none; the gateway records the model the Codex CLI ran the thread's turns with,
  from its session rollout under `$CODEX_HOME/sessions` (`turn_context.model`). That is the CLI's
  own record of the model it requested, not a provider confirmation, so `model_mismatch` cannot
  catch a provider-side substitution, and an unreadable rollout records none (the smoke then fails).
  `$CODEX_HOME/sessions` keeps every prompt the CLI ran, unpruned, so it holds run data.
- A Codex ChatGPT sign-in must be on a plan that includes the routed models. `chatgpt_plans` lists
  those plans' claims; a sign-in whose id token claims another plan abstains without a call
  (`provider_error`, detail `codex: plan does not include model …`, naming the claimed plan). A
  model the provider refused for a sign-in is not called again on that sign-in until it changes or,
  once per `auth_probe_after_ms`, a single probe succeeds.
- `ProviderGateway.health()` reports every configured account's state and alerts:
  `kill_switch_engaged`, `ledger_unavailable`, `<provider>_credential_missing`,
  `<provider>_auth_failed`, `<provider>_cooldown`, `<provider>_plan_lacks_model` (the account is
  then not ready), and `<provider>_signin_not_refreshing` when a Codex `auth.json` has not refreshed
  within `signin_max_age_hours`. The heartbeat sends at most 32 alerts, the Worker's limit.

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
| `AGENT_HOST_GATEWAY_CONFIG`, `AGENT_HOST_SPECIALISTS_DIR`, `AGENT_HOST_ACTION_SERVER` | package paths | Overrides for tests and images; a QA or dev host on personal sign-ins sets `AGENT_HOST_GATEWAY_CONFIG=config/gateway.consumer.json` |
| `AGENT_HOST_DATA_CLASS` | `business` | What the Worker holds. `business` keeps live and shadow runs to qualified routes on accounts whose terms serve them; `synthetic`, for a QA or dev host on seed data only, runs every Worker run as a synthetic run (no qualification needed, consumer refs allowed; ceilings, independence, the kill switch and the model check still apply). Any other value refuses to start |

### Worker agent API

The host and the action server call only these Worker routes, with
`Authorization: Bearer <AGENT_HOST_TOKEN>`. The Worker owns every decision
([`workers-bus/src/agents/`](../workers-bus/src/agents/api.ts)).

| Route | Caller | Contract |
|---|---|---|
| `GET /api/v1/agents/signals?after&limit` | host | `{signals[], next_cursor}`; a signal names its specialist, kind (`event`, `watch`, `owner_request`, `handoff`), subject and untrusted content, and `actor`: for a person's ask or request through the app, `source` is `ask` or `request` and `actor` is `{type: "owner" \| "staff" \| "worker", role, ref: "person:<user_id>", authenticated: true}` from the Worker's record (`owner` only for the owner, `worker` for a field person, `staff` for every other role); every other signal has `actor: null` |
| `POST /api/v1/agents/runs` | host | `{signal_id, specialist_id, host_run_key}` opens or returns the run: `{run_id, goal, context: {snapshot_hash, facts[], omitted[]}, tools[], people_only[]}` (`people_only` is `{action_id, name}` for each people-only act the specialist owns, names the run may use in receipts and never tools; a run on a handoff also has the person's ask or request at the root of its chain as fact `signal/<root_id>`, version 1, hashed over its own data (`signal_id`, `kind`, `source`, `actor`, and `content` only when the run reads as the owner), so its hash differs from the face run's `signal/<id>`, which hashes the ask's content; `facts/current` serves the face's form) with the routing hints `review_of: {run_id, provider} \| null` (when the auditor reviews another run, so the gateway picks a different family; a Worker on the v3 close model adds `family`, and a legacy `provider` maps to its family), `expected_action_id: string \| null` (the signal's single expected action) and `mode: "live" \| "shadow"` (`shadow` when every action the signal can lead to is in shadow; missing reads as null and live; any other mode closes the run `unknown_run_mode` with no model call), which reach the gateway as `reviewOf`, `action` and scope; `qualifications: [{qualification_id, provider, model, effort, release_sha256}]`, the specialist's current passing owner records, which a live or shadow run needs (without one for its route it abstains `no_qualified_route`); and `close_model: 3` when the Worker takes the v3 close (below). The host sends the specialist's release with the run; a face run answering a person's ask also carries `output_extension: {view}`, the strict view spec schema, which the host adds to that run's output schema as a required, nullable `view` (every other run's input is unchanged); 409 when that key's run is already closed |
| `GET /api/v1/agents/runs/:id/tools` | action server | the run's tools: `action_id`, `tool_name`, `autonomy`, `side_effect_class`, `undo`, `description` (`<action_id> on <aggregate>: <catalog name>.`, with ` (protective)` before the full stop for a protective action), strict `args_schema` |
| `POST /api/v1/agents/runs/:id/steps` | action server | `{action_id, args, citations[{fact_id, version}], step_key}` returns the Worker's decision; `step_key` (SHA-256 of the canonical step) makes a repeated proposal answer once; unknown action, unknown field, missing or stale citation is an abstention; an admitted `authority.evaluate` also returns `evaluation`, the authority records as the run's reader may read them (`authority:read` and `production:read` or `jobs:read:any`); a read the reader may not make, or one that fails, abstains (`out_of_scope`, `fact_missing`) and returns `evaluation: {reason: "role_may_not_read" | "read_failed"}`; a shadowed action answers `decision: "shadowed"` with the decision policy would have made (`would_be`) and no receipt |
| `POST /api/v1/agents/runs/:id/close` | host | terminal outcome: status, abstention reason, structured output, model and models used, hashes, usage, cost, tool calls; `model` and `hashes` are null when no model ran, and `model` is null for `no_independent_route`; when the open carried any routing field, `model` also holds `route_id`, `review_of` and `mode`, and a run for such a Worker may use only the provider ids it records (`claude`, `codex`; another is `provider_disabled`); a Worker that advertised `close_model: 3` gets the v3 block instead: `provider`, `adapter`, `family`, `model`, `effort` (the effort of the route that answered), `models_used`, `auth_mode` (the credential mode), `billing`, `tier`, `route_id`, `route` (`primary` or `declared_fallback`), `failover` (at most three hops, each with its family, null when its route has no registry entry, its reason and retry time; the Worker refuses an audit when any hop is of the reviewed run's family or names none), `qualification_ref`, `release_sha256`, `gateway_config_sha256`, `review_of {run_id, family}`, `mode`, `compliance_ref`, `run_class` and `risk_acceptance`; only an ask run's output may carry `view`, which the Worker checks and records as the spec or null |
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
| `GET /api/v1/agent-team/watches` | Owner/ops: every catalog watch, whether its condition is registered, and its last firing |
| `GET /api/v1/agent-team/reports` | Owner/ops: recent owner reports (new inquiries, pipeline, daily brief, weekly review) with their run's result and composed text (`watch`, `limit`) |

Watches (migration 0204): the five-minute cron evaluates every cadence watch whose deterministic
condition is registered (`workers-bus/src/agents/watches.ts`: `new_leads`, `pipeline`,
`daily_owner_brief`, `weekly_review`, `unacknowledged_exception`), once per period: sub-day cadences
use fixed UTC slots, daily, weekly and monthly ones run at the tenant's local time (company profile
time zone; 07:00 daily, Monday 08:00 weekly by default). The condition costs no model call; when it
holds, a watch signal naming the objects it found goes to the owning specialist, whose run starts
from those objects (whole, within one snapshot's limits); when it does not, the firing is recorded as
an empty run. Conditions hold on change since the last firing, never on standing state: a decision
already waiting does not fire the pipeline again, and an unacknowledged exception is raised again
only after a four-hour cooldown. Periods are computed on calendar dates, so a daylight-saving change
never shifts or repeats one, and an invalid tenant time zone falls back to the default. A completed
owner report also reaches the owner outside the app: the daily brief and weekly review always, new
inquiries when there are any, the pipeline only when a decision waits. Each attempt is recorded
(`agent_report_deliveries`). A failed delivery is retried by the Worker cron after fifteen minutes,
up to five attempts in all; a close that never reached delivery delivers on the host's close replay;
a report recorded as sent is not sent again. Watches without a registered condition, and event-triggered watches, do
not fire yet.

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
on (its most recent closed run), at the effort and release its close names when it is a v3 close,
and a delegable A2/A3 action that
does not already act within limits. An auditor's review that comes back from the reviewed run's own
model family, from a family the Worker cannot name, or past a failover hop of that family or one that
names no family closes abstained.

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
- Personal (consumer) sign-ins are labelled by `config/gateway.consumer.json`: set
  `AGENT_HOST_GATEWAY_CONFIG=config/gateway.consumer.json`, and `AGENT_HOST_DATA_CLASS=synthetic`
  for a host whose Worker holds seed data only. The host and `npm run smoke` read both from
  `~/.config/ironwrap/agent-host.env` too; `npm run qualify` takes `AGENT_HOST_GATEWAY_CONFIG`
  from the command line only, because it reads no local file before the eval tree validates.

```bash
npm ci --prefix agent-host                # with the optional CLI binaries, for live calls
npm run smoke --prefix agent-host
```

`npm run smoke` makes one tiny structured call per routed tier, plus one audit of `openai`-proposed
work that must run on another family, and prints status, route, provider, family, model, the models
used, the compliance ref and cost; a call fails when its run reports no model used. It runs through
an eval gateway on synthetic data under `<state>/smoke`, so it needs no qualification and books its
own eval ledger, never the production one (the host's `KILL` file does not stop it;
`AGENT_HOST_KILL=1` does). It spends a few tokens of the sign-ins and never runs in CI.

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
  snapshot (case times resolved against the case clock, the signal first as untrusted text), a
  case signal's `subject` (`{aggregate, id}`, as the inbound producer sets it) reaches the run's
  signal and goal as in production, the specialist loads as in production, and the production `buildRunInput` assembles the input. The
  replay offers the specialist's full allowlist, worded and ordered as the Worker words its tools,
  with open arguments: the cases follow the contract's argument conventions, and the Worker registry
  has strict schemas for only a few actions, some under other names. A production run sees only the
  actions the registry binds, so `prompt_sha256` matches production only once the registry exposes
  the same actions.
- The case clock is a fixed instant, 14:00 in Edmonton on a summer weekday, unless the case carries
  `clock`: `{ "season": "winter|spring|summer|fall", "weekday": "monday".."sunday", "local_time":
  "HH:MM" }` in Edmonton local time, with no calendar date. The season picks a month (winter
  January, spring April, summer July, fall October, in the default instant's year), the weekday the
  first such day on or after the 8th, and the time is Edmonton's on that day at the offset Intl
  reports for that day (Alberta keeps UTC-6 all year from tzdata 2026c on; the repository pins Node
  in `.nvmrc` to a release that carries it). A stage refuses a malformed clock before any run.
  Inside a case's fact data or `expected`, `{"$case_date": "<signed ISO 8601 duration>"}` and
  `{"$case_time": "…"}` resolve against that clock (calendar days in Edmonton, or an exact
  instant), so cases carry no calendar dates; any other `$` key, or a malformed duration, refuses
  the stage.
- Like every production audit, an auditor run names the run it reviews (`reviewOf`), here with the
  one family all proposer routes use (read from the registry), so it runs on that family's audit
  route (`claude_opus` for `openai` work). A stage refuses to qualify the auditor while proposer
  routes span two families.
- Every eval request says its data is `synthetic` (golden and red-team cases), so any account the
  configuration labels may serve it. Qualifying on personal sign-ins takes
  `AGENT_HOST_GATEWAY_CONFIG=config/gateway.consumer.json` on the command line, the same variable
  the host reads; the stage then runs on the same routes under the consumer refs.
- The provider CLI reaches the stdio action server `src/replay/tool-server.ts`, which answers from
  the case alone. An A0 read returns the case facts it names. Every other call is captured, never
  executed, and answered with the Worker's deterministic decision: drafted for A1, escalated for a
  protective action, awaiting approval for other A2 and A3 actions, abstained for an unknown,
  wrong-version or stale citation. An inbound-only action (`lead_fact.propose`) stops `out_of_scope`
  as the Worker's policy stops it: unless the case signal is an event from an inbound channel about
  a lead, the step names that lead and it cites only the signal. The tool file carries the signal's
  kind, source and subject for that (`requester`); no other requester rule is mirrored.
- Runs go through an eval gateway (`qualification` option, `scope: "eval"`) whose state directory
  is `<output_dir>/<stage>/gateway` (`<output_dir>/replay/gateway` for a single-case replay, and
  `<output_dir>/gateway` when `ledger.per_stage` is false), so each stage books in its own
  `gateway-usage-eval.jsonl` and the production ledger is never written. That gateway looks for its `KILL` file there as well: the
  host's `KILL` file does not stop qualification, while `AGENT_HOST_KILL=1` does.
  `concurrency` caps the calls in flight per provider id; a provider it does not name gets no calls.
  Each repetition is judged with `evals/judge.md` through the judge key on the other family's
  route (`judge.for_claude_proposers` for `anthropic` work, `judge.default` for any other family),
  and an invalid answer is asked again up to `judge.max_attempts`; `evals/score.mjs` merges
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
fakes only; no qualification stage has run on a provider. Gateway config v3 (registry, declared
failover, the qualification gate, provider terms per run class) is tested with fake providers only;
until the owner records qualifications, which the Worker sends with each run and checks at close,
every live and shadow run on a business host abstains `no_qualified_route`. Live proof is blocked on an owner-provisioned Worker
`AGENT_HOST_TOKEN`, Claude OAuth sign-in and a dedicated Codex ChatGPT sign-in, followed by the
authenticated runtime journey and `npm run smoke`. No provider or QA activation is established by
these local checks.
