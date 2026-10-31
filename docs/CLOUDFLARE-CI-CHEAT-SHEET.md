# Cloudflare Workers CI Cheat Sheet

Status: current command, permission and GitHub-settings reference for the push path
(`.github/workflows/deploy.yml`, qa) and the tag path (`.github/workflows/deploy-production.yml`,
production).
Owner: IronWrap OS product owner
Last verified: 2026-10-02
Review trigger: Wrangler pin change, Cloudflare plan change, token rotation, or a change to
`.github/workflows/deploy.yml`, `deploy-production.yml` or `release-please.yml`

Evidence base: `Iron-Wrap/ironwrap-os@6a1318a1` (`main`) merged into this branch, Wrangler 4.131.0
(`workers-bus/node_modules/.bin/wrangler` after `npm ci --ignore-scripts --prefix workers-bus`),
Node 22.22.3. First written against `84de440`, before #305 (IRO-260) and #312 (IRO-264) landed;
every anchor below was re-checked on `6a1318a1`.
No remote Cloudflare call was made to produce this page: the agent that wrote it holds no
Cloudflare token. Authority:
[`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](./AUTHORITY-AND-EVIDENCE-CONTRACT.md).

## 1. Command table

Global flags present on every command in 4.131.0: `-c, --config`, `--cwd`, `-e, --env`,
`--env-file`, `--profile`. Production commands take **no** `--env`
(`deploy-production.yml:387-389`, `:503`, `:509`, `:520`); `--env=""` in
`workers-bus/package.json:14` is the npm-script equivalent.

Environment variables:

| Variable | Read by | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | every remote call | required for authentication |
| `CLOUDFLARE_ACCOUNT_ID` | the REST readbacks below | Wrangler itself resolves the account from `account_id` in `wrangler.jsonc:4`, not from this variable |
| `WRANGLER_SEND_METRICS` | Wrangler | `false` suppresses telemetry; neither workflow sets it |
| `WRANGLER_OUTPUT_FILE_PATH` | Wrangler | writes the ND-JSON structured-output log (see Proof) |
| `CLOUDFLARE_ENV` | Wrangler | alternative to `--env` |
| `WRANGLER_LOG` | Wrangler | log verbosity |

Source: https://developers.cloudflare.com/workers/wrangler/system-environment-variables/

### Push path: `deploy.yml` — `admission` -> `build` -> `qa`

The workflow is `on: workflow_run` of `CI` on `main` (`deploy.yml:3-7`). Three jobs run in order.

- `admission` (`:34-133`) makes no Cloudflare call. It checks that the CI run succeeded on a push to
  `main` of this repository, recovers the squash commit's parent, and writes the admission context.
- `build` (`:135-261`) builds one bundle: `wrangler deploy --env qa --dry-run --strict` into an
  absolute `--outdir` (`:179-190`). It archives the bundle with the PWA and keeps the artifact for
  30 days so the tag path can reuse it (`:223-226`).
- `qa` (`:263-589`) runs with `environment: qa` and `concurrency: deploy-qa` (`:266-269`).

One line per Cloudflare call in `qa`, in the order the job makes it, with what run 37022977020
(the latest on `6a1318a1`) did with it:

1. `wrangler secret list --config … --env qa --format json` (`:329-330`) — executed, step 9.
2. `environment-preflight` (`:338-341`), a repository tool with no Cloudflare call — executed, step
   10.
3. `wrangler d1 migrations apply DB --config workers-bus/wrangler.jsonc --remote --env qa`
   (`:346`) — executed, step 11. See the note under this list.
4. `wrangler deployments list --config … --env qa --json` (`:354-355`) — executed, step 12.
5. `wrangler versions upload "<bundle>/index.js" --config … --env qa --no-bundle --assets
   "<pwa>" --strict --message "<msg>"` (`:368-371`); the version id is scraped from the log by
   `release-promotion.mjs parse-version` (`:372-373`) — executed, step 13.
6. `wrangler versions view <id> --config … --env qa --json` (`:382-383`) — executed, step 14.
7. `wrangler versions deploy --config … --env qa --version-id <id> --yes` (`:398`) — executed,
   step 15.
8. `deployments list` again, then `GET /health` and `GET /ready?scope=core` (`:406-417`) —
   executed, step 16.
9. `wrangler triggers deploy --config … --env qa` (`:426-427`), after pointing `app/dist` at the
   artifact's PWA, because Wrangler checks `assets.directory` even for triggers (#322) — executed,
   step 17.
10. `GET /accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/ironwrap-bus-qa/schedules`
    (`:434-437`) — executed, step 18.
11. The authenticated smoke (`:443-448`) — **failed**, step 19. Steps 20-23 were skipped.
12. `wrangler d1 export ironwrap-bus-qa --config … --env qa --remote --output <file>` and the local
    restore (`deploy.yml:466-504`) — never executed.
13. The rollback drill, `versions deploy --version-id <previous> --yes`, then the candidate again
    (`:515`, `:524`) — never executed.
14. Failure cleanup, `versions deploy --version-id <previous> --yes` (`:569-570`) — executed,
    step 24.

Deploy has not succeeded since #305 merged (2026-09-30 22:19 UTC): 14 runs failed, none passed.

**Migrations (line 3).** The pipeline passes the binding `DB` together with `--env qa`. `DB` is
declared at the top level (`wrangler.jsonc:35-36`, database `ironwrap-bus`, production), in
`env.local` (`:319-320`) and in `env.qa` (`:525-526`, `ironwrap-bus-qa`). With `--env qa` it
resolves to the qa database. If that flag were lost it would resolve to **production**:
`wrangler deploy --dry-run` with no `--env` prints `env.DB (ironwrap-bus)`, and the command would
apply qa's pending migrations to production, `--remote`, forward-only, with a token that can write
it (§2). The line is safe only while `--env qa` stays on it. Passing the database **name**
`ironwrap-bus-qa` (declared only under `env.qa`, `:526`) fails closed instead: without `--env` it
exits 1, "Couldn't find a D1 DB with the name or binding". This is a property of the line, not a
change this page makes. `workers-bus/package.json:18` has the same shape. The `--help` note:
"When running the apply command in a CI/CD environment or another non-interactive command line,
the confirmation step will be skipped, but the backup will still be captured." No `--json`.
Readback: `wrangler d1 migrations list ironwrap-bus-qa --config … --env qa --remote` must report
nothing to apply.

**`versions upload` (line 5).** Uploads code, assets and bindings as a new immutable version: no
traffic, no routes, no crons. `--strict` = "prevents uploads when there are conflicting remote
changes". Other flags: `--tag`, `--secrets-file` ("Applies additively with secrets from previous
deployments — omitted secrets will not be deleted"), `--keep-vars` ("When not used (or set to
false), Wrangler will delete all vars before setting those found in the Wrangler configuration",
default `false` — a destructive default that the pipeline's var handling depends on; the guard is
`environment_preflight_var_inventory_drift`, raised at `tools/release-permit.mjs:2071` inside
`validateReleaseEnvironmentPreflight` (`:2061`) and run by `deploy.yml:338-341` and
`deploy-production.yml:375-378`), `--preview-alias`, `--dry-run`, `--outdir`. A relative `--outdir`
resolves against the config file's directory, here `workers-bus/`, not the working directory;
`deploy.yml:185-189` passes an absolute `$RUNNER_TEMP/worker-bundle` and is unaffected. Restriction
from Cloudflare: "Service worker syntax is not supported for versions that are uploaded through
`wrangler versions upload`. You must use ES modules format," and it cannot be the first upload of a
Worker — the first one must be `wrangler deploy`. Readback: the ND-JSON `version-upload` record
(Proof below), or `versions view <id> --json`.

**`versions deploy` (line 7).** Puts a version on 100% of traffic. Supports `--percentage`,
`--version-tag`, the `[<version-id>@<percentage>..]` shorthand and `--dry-run`, but `--dry-run`
**authenticates first** and fails without a token (Proof below). Readback:
`wrangler deployments list --json` (10 most recent) or `wrangler deployments status`.

**`triggers deploy` (line 9).** The **only** command besides `wrangler deploy` that writes routes,
custom domains and cron triggers. Cloudflare: "To apply changes to a Worker's triggers (routes,
domains, or cron triggers), use the `wrangler triggers deploy` command." Marked `[experimental]`
in 4.131.0 and prints a warning (Proof below). Supports `--triggers/--schedule/--schedules`,
`--routes/--route` and `--dry-run` (works offline).

**Schedules readback (line 10).** REST, no Wrangler equivalent. Executed once against the live
account, in run 37022977020 step 18; `result.schedules[].cron` is what `cron-readback` consumes.
Docs:
https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/get/

**`/subdomain` readback.** `GET /accounts/<account_id>/workers/scripts/ironwrap-bus-qa/subdomain`
→ `result.enabled`. Docs-cited only, no local proof: no step in either workflow calls it. Docs:
https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/

### Tag path: `deploy-production.yml` — production

**Written, never run.** The workflow has no run (`total_count` 0) and there is no `v*` tag. The
`production` Environment exists since 2026-10-21 (see Not verified and §4).

**Account split (2026-10-30, IRO-221).** Production runs in the **Mindburn Labs** account
`5023dd22…` as `ironwrap.mindburn.org` (zone `mindburn.org`, Workers Paid); qa stays in IronWrap's
account `7ee5775b…` on Free. `CLOUDFLARE_ACCOUNT_ID` in `deploy-production.yml` and `deploy.yml`
differ accordingly, `env.qa.account_id` pins qa in `wrangler.jsonc`, and the provider policy (v2)
carries `account_id` per environment. A qa token therefore cannot reach production at all.

- Trigger: `workflow_dispatch` only, with required `tag` and `declaration_sha` inputs
  (`deploy-production.yml:21-31`). There is no `push` trigger: a tag alone does not deploy. The
  caller is `promote-production.yml` in `Iron-Wrap/iron-wrap-infra`, after a promotion PR
  changes `environments/production/stand.yml` on its `main` (GitOps, owner decision 2026-10-21).
  The first step requires `github.ref_type == tag`, the shape `^v[0-9]+\.[0-9]+\.[0-9]+$`, and that
  the `tag` input equals the ref (`deploy-production.yml:81-99`). The second reads the declaration
  with `RELEASE_DECLARATION_READ_TOKEN` and fails `release_production_declaration_mismatch:<reason>`
  unless `stand.yml` at `declaration_sha` and on `main` both name this tag and `declaration_sha` is
  an ancestor of `main` (`GET /repos/…/compare/<sha>...main` → `ahead` or `identical`)
  (`deploy-production.yml:101-138`). Both run before the checkout.
- One job, `production`, with `environment: production` (`deploy-production.yml:69`) and
  `concurrency:
  deploy-production`, `cancel-in-progress: false` (`deploy-production.yml:35-37`).
- It **never builds** (`deploy-production.yml:5-6`). It finds the tagged commit's CI run and Deploy
  run (`deploy-production.yml:171-191`),
  downloads that Deploy run's release artifact and qa proof (`deploy-production.yml:193-204`),
requires the proof to
  carry this commit and tree (`deploy-production.yml:209-221`), and re-verifies the artifact digest
(`deploy-production.yml:299-314`). It
  promotes the bytes qa proved.

One line per Cloudflare call, with its anchor:

1. Ledger: `POST /accounts/{id}/d1/database/{id}/query` with `RELEASE_POLICY_LEDGER_API_TOKEN`
   (`deploy-production.yml:266-278`; the endpoint is built at `tools/release-permit.mjs:2299`).
2. `wrangler secret list --config … --format json` (`deploy-production.yml:366-367`).
3. `environment-preflight` (`deploy-production.yml:375-378`).
4. `wrangler versions upload "<artifact>/worker/index.js" --config … --no-bundle --assets
   "<artifact>/app/dist" --strict --message "<msg>"` (`deploy-production.yml:387-389`); version id
scraped from the log
   (`deploy-production.yml:391-392`).
5. `wrangler versions view <id> --json` (`deploy-production.yml:400`).
6. `deployments list --json` and `versions view <previous> --json`
   (`deploy-production.yml:418-422`).
7. `wrangler d1 time-travel info ironwrap-bus --json` (`deploy-production.yml:433-434`) — the
   recovery bookmark.
   `--timestamp` accepts Unix seconds or RFC3339.
8. The signed permit is assembled and consumed once through the D1 ledger
   (`deploy-production.yml:440-479`).
9. `wrangler d1 migrations apply ironwrap-bus --config … --remote` (`deploy-production.yml:503`) —
   the database
   **name**, no `--env`.
10. `wrangler versions deploy --config … --version-id <id> --yes` (`deploy-production.yml:509`).
11. `wrangler triggers deploy --config …` (`deploy-production.yml:519-520`).
12. `GET /accounts/{id}/workers/domains` (`deploy-production.yml:529-533`) — docs-cited only.
13. `GET /accounts/{id}/workers/scripts/ironwrap-bus/schedules` (`deploy-production.yml:550-553`).
14. Smoke (`deploy-production.yml:559-582`), then the durable generation advance
    (`deploy-production.yml:603-617`).
15. On failure, `wrangler rollback <previous> --config … --message "<reason>" --yes`
    (`deploy-production.yml:630`); a
    nonzero exit is reconciled by readback with `deployments list --json`
(`deploy-production.yml:630-633`), the
    receipt and the D1 outcome (`deploy-production.yml:619-658`).

### Rollback and recovery

- qa: `versions deploy … --env qa --version-id <previous> --yes` is both the rollback drill
  (`deploy.yml:515`) and the failure cleanup (`:569-570`), because it is the same idempotent
  promote path.
- production: `wrangler rollback <version-id> --config workers-bus/wrangler.jsonc --message
  "<reason>" --yes` (`deploy-production.yml:630`). Flags in 4.131.0: `--name`, `-m/--message`,
  `-y/--yes` only. **No `--dry-run`, no `--json`** — it cannot be proven offline and its result
  must be read back with `deployments list --json`.
- `wrangler d1 time-travel restore <db> --config … --bookmark <b>` or `--timestamp <t>`. The
  `--help` text says "within the last 30 days"; the **Free plan gives 7 days** (§3) — the flag text
  is the paid ceiling, not an entitlement. Docs:
  https://developers.cloudflare.com/d1/reference/time-travel/
- `wrangler d1 export <name> --config … --env qa --remote --output <file.sql>` — `--output` is
  required; `--table`, `--no-schema`, `--no-data`, `-y/--skip-confirmation` available
  (`deploy.yml:472-474`).

### Secrets

- `wrangler secret put <KEY> --config workers-bus/wrangler.jsonc --env qa` — reads the value from
  stdin; one round trip per key.
- `wrangler secret bulk <file> --config … --env qa` — "up to 100 secrets per command"; JSON
  `{"key":"value"}` or `.env` `KEY=VALUE`; `null` in JSON deletes a key, deletion is not supported
  with `.env`; with no file argument it reads stdin.
- `wrangler secret list --config … --env qa --format json` — `--format` is `json|pretty`, default
  `json`. Names only, never values. Both workflows run it (`deploy.yml:329-330`,
  `deploy-production.yml:366-367`) and feed it to `tools/release-promotion.mjs secret-readback`.
- `wrangler versions secret put|bulk|delete|list` — the version-scoped variants. Not used by either
  workflow.

### Proof — every command above ran as `--help` or `--dry-run` on pinned Wrangler 4.131.0

Captured 2026-10-02 on the merged tree, from the repository root, `aarch64`. `--help` exits 0 for
all nineteen: `versions upload`, `versions deploy`, `versions view`, `versions list`,
`versions secret`, `triggers deploy`, `deployments list`, `deployments status`, `rollback`,
`d1 migrations apply`, `d1 migrations list`, `d1 info`, `d1 execute`, `d1 export`,
`d1 time-travel info`, `d1 time-travel restore`, `secret put`, `secret bulk`, `secret list`. In
zsh/bash an unquoted variable holding `"versions upload"` collapses to one word and yields
`Unknown argument: versions upload`; write the subcommand words literally, not through a variable.
The REST readbacks (`…/schedules`, `…/subdomain`, `/workers/domains`) have no `--help`.
`…/schedules`
for qa ran in run 37022977020; the production one has never run, and `…/subdomain` and
`/workers/domains` are docs-cited only.

`versions upload --dry-run --config workers-bus/wrangler.jsonc --env qa --outdir <dir>` exits 0.
The non-secret vars are grouped into `CFG_*` JSON bindings (IRO-268). Binding table (trimmed):

```
env.JN_QUEUE (ironwrap-qa-jn-push)                                     Queue
env.MEASUREMENT_QUEUE (ironwrap-qa-measurements)                       Queue
env.NEWO_QUEUE (ironwrap-qa-newo-events)                               Queue
env.DB (ironwrap-bus-qa)                                               D1 Database
env.RAW (ironwrap-bus-qa-raw)                                          R2 Bucket
env.ASSETS                                                             Assets
env.CFG_APP, CFG_CORE, CFG_ERPNEXT, CFG_FACET, CFG_JN, CFG_MEASUREMENT, CFG_NEWO,
env.CFG_POSTIZ, CFG_PUBLIC, CFG_QB, CFG_SHARED                         Environment Variable
--dry-run: exiting now.
```

`deploy --dry-run --strict --config workers-bus/wrangler.jsonc --env qa --outdir <dir>` exits 0
and additionally prints:

```
✨ Read 98 files from the assets directory <repo>/app/dist
--dry-run: exiting now.
```

`triggers deploy --dry-run --config workers-bus/wrangler.jsonc --env qa` exits 0 and prints:

```
🚧 `wrangler triggers deploy` is an experimental command. Please report any issues to
https://github.com/cloudflare/workers-sdk/issues/new/choose
--dry-run: exiting now.
```

**Identical-bundle proof.** The tag path never builds: it uploads the bundle `deploy.yml:187-189`
built with `--env qa`. That is sound only if the `--env` choice does not change the bundle.
`deploy --config workers-bus/wrangler.jsonc --dry-run --strict --outdir <dir>` with `--env qa` and
with no `--env`, then `sha256sum` on each `index.js`:

```
406c3a23a45ad252647be80168f414fff9004586582c8f3e639949f1c0bcc46b  index.js  (qa)
406c3a23a45ad252647be80168f414fff9004586582c8f3e639949f1c0bcc46b  index.js  (production)
```

The digests match. Environment `vars` are upload-time bindings, not inlined code, which is why one
artifact can serve both environments. Both captures are two builds on one machine; the published
`ubuntu-latest` (x64) digest has never been produced here (see Not verified).

**D1 resolution, offline.** `deploy --dry-run --config workers-bus/wrangler.jsonc --outdir <dir>`
prints `env.DB (ironwrap-bus)`; with `--env qa` it prints `env.DB (ironwrap-bus-qa)`.
`d1 migrations list ironwrap-bus-qa --config workers-bus/wrangler.jsonc --local` with no `--env`
exits 1: "Couldn't find a D1 DB with the name or binding 'ironwrap-bus-qa' in your wrangler.jsonc
file."

**No-token boundary.** With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` unset,
`versions deploy --env qa --version-id 00000000-0000-0000-0000-000000000000 --yes --dry-run`,
`d1 migrations apply ironwrap-bus-qa --env qa --remote`, and `secret list --env qa --format json`
each exit 1. They start with:

```
In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment
variable for wrangler to work. Please go to
https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ for instructions on
how to create an api token, and assign its value to CLOUDFLARE_API_TOKEN.
```

Wrangler then adds a hint to rerun with `--temporary`; ignore it in CI. These three commands cannot
be dry-run at all — they authenticate before doing anything else. Their row in this sheet is proven
by `--help` only; do not read the exit above as a passing dry run. `wrangler rollback` shares this
limitation and has no `--dry-run` or `--json` in 4.131.0 at all.

**Structured-output proof.**
`WRANGLER_OUTPUT_FILE_PATH=<path> versions upload --dry-run --config workers-bus/wrangler.jsonc
--env qa --outdir <dir>` writes an ND-JSON session record and this record:

```json
{
  "type": "version-upload",
  "version": 1,
  "worker_name": "ironwrap-bus-qa",
  "worker_tag": null,
  "version_id": null,
  "wrangler_environment": "qa",
  "worker_name_overridden": false,
  "bundle_size": { "raw_bytes": 3661540, "gzip_bytes": 699080 },
  "timestamp": "2026-10-02T16:59:51.680Z"
}
```

`version_id` is `null` because this is a dry run; a real upload carries the UUID. This is the
readback that would replace log-scraping: today `tools/release-promotion.mjs parse-version` reads
the upload log (`deploy.yml:372-373`, `deploy-production.yml:391-392`).

## 2. Token permission matrix

Every group below is **account-scoped** per
https://developers.cloudflare.com/fundamentals/api/reference/permissions/ — Cloudflare API tokens
scope to accounts and zones, not to an individual Worker, database or queue. Consequence, stated
plainly: **a qa token that cannot touch production does not exist in one account.** A qa token with
`Workers Scripts:Edit` can overwrite `ironwrap-bus`; a qa token with `D1:Edit` can restore
`ironwrap-bus`. Real isolation needs a second Cloudflare account. The only partial exception is R2,
which has its own bucket-scoped token flow
(https://developers.cloudflare.com/r2/api/tokens/).

Which Cloudflare token each workflow uses:

- `RELEASE_QA_CLOUDFLARE_API_TOKEN`: every Cloudflare call in the `qa` job (for example
  `deploy.yml:309`).
- `RELEASE_PRODUCTION_CLOUDFLARE_API_TOKEN`: every production Wrangler and REST call
  (`deploy-production.yml:341` onward).
- `RELEASE_POLICY_LEDGER_API_TOKEN`: the D1 ledger only (`deploy-production.yml:268`, `:469`,
  `:606`, `:663`, `:678`).

| Command / endpoint | Group | Status |
| --- | --- | --- |
| `versions upload`, `versions deploy`, `triggers deploy`, `rollback`, `secret put/bulk/delete`, `versions secret *` | Workers Scripts — Edit ("Grants write access to Cloudflare Workers scripts") | Documented |
| `versions view`, `versions list`, `deployments list`, `deployments status`, `secret list` | Workers Scripts — Read | Documented |
| `GET /accounts/{id}/workers/scripts/{name}/schedules` | Workers Scripts — Write **or** Read (the endpoint page states either) | Documented |
| `GET /accounts/{id}/workers/scripts/{name}/subdomain` | Workers Scripts — Read (the endpoint page accepts `Workers Tail Read`, `Workers Scripts Write` or `Workers Scripts Read`) | Documented |
| `POST …/subdomain` — not used by either workflow | Workers Scripts — Write | Documented |
| `GET /accounts/{id}/workers/domains` | Workers Scripts (account-scoped); routes on a zone are the separate zone-scoped **Workers Routes** group | Inferred |
| `d1 migrations apply --remote`, `d1 execute --remote`, `d1 time-travel restore` | D1 — Edit ("Grants write access to D1") | Documented |
| `d1 migrations list --remote`, `d1 info`, `d1 time-travel info` | D1 — Read | Documented |
| `d1 export --remote` | D1 — Edit (export starts a server-side job) | Inferred |
| `POST /accounts/{id}/d1/database/{id}/query` (the ledger, `tools/release-permit.mjs:2299`) | D1 — Edit | Inferred — a query endpoint that runs writes |
| queue producer/consumer bindings resolved at `versions upload` | Queues — Read | Inferred — the config already carries queue **names**, so Wrangler may not need a lookup |
| R2 bucket binding resolved at `versions upload` | Workers R2 Storage — Read | Inferred — `bucket_name` is in the config; may not need a lookup |
| D1 binding resolved at `versions upload` | none | Inferred — `database_id` is in `wrangler.jsonc`, so no D1 lookup should be required |
| `wrangler tail` | Workers Tail — Read ("Grants wrangler tail read permissions") | Documented |
| `wrangler whoami`, account resolution when no `account_id`/`CLOUDFLARE_ACCOUNT_ID` is present | Account Settings — Read | Documented — **not needed here**: `account_id` is at `wrangler.jsonc:4`, `CLOUDFLARE_ACCOUNT_ID` at `deploy.yml:25` and `deploy-production.yml:51` |
| nothing in this repository | Cloudflare Tunnel — Edit | **Removable** from the QA token: `git grep -nIiE 'wrangler tunnel\|cfd_tunnel\|/tunnels'` outside this page finds nothing on `6a1318a1` |
| token self-check | account-owned tokens verify at `GET /accounts/{id}/tokens/verify`, not `/user/tokens/verify` | Documented |

Run 37022977020 exercised the qa token on `secret list`, `d1 migrations apply`, `deployments
list`, `versions upload` / `view` / `deploy`, `triggers deploy` and `GET …/schedules`. That proves
this token suffices for them, not which group each one needs.

Citations: permission groups
https://developers.cloudflare.com/fundamentals/api/reference/permissions/ ; the template
Cloudflare tells CI users to pick, "Edit Cloudflare Workers", plus the secret names
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/ ; account-owned
tokens https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/ and
https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/ .

**How to settle the Inferred rows.** Mint a throwaway token with exactly one permission group, run
the one command it should cover, and record the failure `code` from the JSON error rather than the
message. Repeat per group. Nothing short of that run turns an Inferred row into Documented, and
this sheet does not pretend otherwise — no Cloudflare token exists in the runtime that wrote it.

## 3. Plan limits that bind this pipeline

Checked 2026-10-02, priced and limited per Cloudflare's plan pages, checked on that date — not
restated as an indefinitely current fact.

| Limit | Free | Paid | Source |
| --- | --- | --- | --- |
| CPU time per invocation | 10 ms | 5 min (default 30 s) | https://developers.cloudflare.com/workers/platform/limits/ |
| Cron Triggers **per account** | 5 | 250 | same |
| Workers per account | 100 | 500 | same |
| Subrequests per invocation | 50 | 10,000 | same |
| Variables per Worker (secrets + text) | 64 | 128 | same |
| Size of one variable | 5 KB | 5 KB | same |
| D1 databases per account | 10 | 50,000 | https://developers.cloudflare.com/d1/platform/limits/ |
| D1 queries per Worker invocation | 50 | 1000 | same |
| D1 max database size | 500 MB | 10 GB | same |
| D1 Time Travel retention | 7 days | 30 days | same |
| Queues message retention | fixed 24 h | configurable up to 14 days | https://developers.cloudflare.com/queues/platform/limits/ |

The variable limit is the one that now binds the pipeline. Secrets and text variables share one
budget, and the repository counts them together: `tools/wrangler-binding-budget.test.mjs:1-4` and
`:17-18` pin 64 / 128 / 5 KB, which matches Cloudflare's page. That is why IRO-268 grouped the
non-secret vars into `CFG_*` JSON bindings (see the binding table in §1).

The cron cap is **per account, not per Worker**. Production's two crons (`wrangler.jsonc:89`) are
written only by `triggers deploy` (`deploy-production.yml:520`, never run) or `wrangler deploy`.
qa's two (`wrangler.jsonc:567`) were written by `deploy.yml:427` and read back in run 37022977020.
That is 4 of 5
on Free once both are registered; the live count is Not verified.

## 4. GitHub side

- **Environments.** Read 2026-10-02: `qa` and `release` exist, each with one deployment-branch
  policy, `main` (`GET …/environments`, `…/environments/{name}/deployment-branch-policies`).
  `production` (named at `deploy-production.yml:69`) was created by the owner on 2026-10-21 with
  one deployment rule, tag `v*` (`…/environments/production/deployment-branch-policies` → `tag v*`,
  read 2026-10-22). Before that it did not exist, and GitHub: "Running a workflow that references
  an environment that does not exist will create an environment with the referenced name."
(https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
  "These secrets are only available to workflow jobs that use the environment" — a job reads
  an environment's secrets only by declaring `environment: <name>`. Which secrets and variables
  live in which store is unreadable with the agent token (403) and is Not verified.
- **"tags `v*` only".** Environment → Deployment branches and tags → **Selected branches and
  tags** → Add deployment branch or tag rule → Ref type **Tag** → pattern `v*`. Name patterns are
  configured for branches or tags individually; the other two settings are **No restriction** and
  **Protected branches only**. The same page carries `Required reviewers` (up to 6, one approval
  releases the job, optional "Prevent self-review") and `Wait timer` (minutes) if a human gate is
  wanted.
- **The trigger constraint that decided the design.** A `workflow_run`-triggered run has
  `GITHUB_REF` = "Default branch" and `GITHUB_SHA` = "Last commit on default branch"
(https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
  so its ref is a branch and can never match a tag rule. Production-by-tag therefore needs a run
  whose ref is the tag: a tag push, or a `workflow_dispatch` with `--ref <tag>`. Two further notes
  from the same page: a `workflow_run` workflow file must exist on the default branch, and
  `workflow_run` cannot chain more than three levels. The design now exists: `deploy.yml` is
  `workflow_run` and deploys qa only; `deploy-production.yml` is `workflow_dispatch` only, dispatched
  on the tag by `iron-wrap-infra`'s `promote-production.yml`, and re-checks `ref_type` and the tag
  shape (`:81-99`).
- **The chain.** CI → Deploy (`workflow_run`) → `release-please.yml` `github-release`
  (`workflow_run` of Deploy, `release-please.yml:25-27`, `:112-174`) → `v*` tag → promotion PR
  merged in `iron-wrap-infra` → `promote-production.yml` dispatches Deploy Production with
  `RELEASE_PROMOTION_DISPATCH_TOKEN`. The tag is written with `RELEASE_TAG_TOKEN`, not `GITHUB_TOKEN`. GitHub: "events
  triggered by the `GITHUB_TOKEN` will not create a new workflow run, with the following
  exceptions: `workflow_dispatch` and `repository_dispatch` events always create workflow runs"
  (https://docs.github.com/en/actions/concepts/security/github_token). A tag pushed with
  `GITHUB_TOKEN` started nothing; since the tag no longer triggers `deploy-production.yml` at all,
  that now matters for CI on the release pull request only. Because Deploy has not succeeded since
  #305, `github-release` cannot tag and the chain cannot start.
- **What each trigger exposes.** `workflow_run`: `github.event.workflow_run.head_sha`, `.id`,
  `.conclusion`, `.event`, `.head_branch`, `.head_repository.full_name`. `deploy.yml:43-47` gates on
  the first four of those that decide admission (`.conclusion`, `.head_repository.full_name`,
  `.event`, `.head_branch`); `.head_sha` and `.id` are read as `RELEASE_SOURCE_COMMIT` and
  `RELEASE_CI_RUN_ID` (`deploy.yml:22-23`). It does **not** populate `workflow_run.pull_requests`
  for a push event, which is why `deploy.yml:66-79` recovers the base commit from the squash
  commit's single parent. `workflow_dispatch` on a tag: `github.ref` = `refs/tags/vX.Y.Z`, `github.ref_name` =
  `vX.Y.Z`, `github.sha` = the tag's tip, read as `RELEASE_SOURCE_COMMIT: ${{ github.sha }}`
  (`deploy-production.yml:47`). It has no CI-success field, so the workflow rebuilds that gate by
  locating the commit's CI and Deploy runs (`:171-191`).
- **`concurrency`.** Two groups, both `cancel-in-progress: false`: `deploy-qa`
  (`deploy.yml:267-269`) and `deploy-production` (`deploy-production.yml:35-37`). Cancelling
  mid-run could leave `d1 migrations apply` half-applied, and migrations are forward-only.
- **release-please, as implemented.** The organisation permits GitHub-owned actions only, so it
  runs through `npx release-please@17.11.2` (`release-please.yml:33`, `:105`, `:169`), not an
  action. Two jobs: `release-pr` and `github-release`. Flags: `--config-file release-please-config.json` (the file has no leading dot) and
  `--manifest-file .release-please-manifest.json`. `"release-type": "simple"` and
  `"include-v-in-tag": true` (`release-please-config.json:2`, `:4`) give `vX.Y.Z` tags, matching
  `deploy-production.yml:92`. The manifest is `{".": "0.1.0"}`. Writes go through
  `RELEASE_TAG_TOKEN` in the `release` environment (`release-please.yml:87`, `:101`, `:124`,
  `:165`) under `permissions: {}` (`:30`). Release PR #323 changes
  `.release-please-manifest.json` and `CHANGELOG.md` only. No `v*` tag exists — 20 tags, none
  matching — and there is no GitHub release.
- **Conventional-commit warning.** release-please silently drops a commit whose subject it cannot
  parse, and with squash merges the PR title (or the single commit's subject) becomes that
  subject. The `release-pr` job therefore runs `tools/conventional-pr-title.mjs` on the subject of
  the commit that landed, on push to `main` only, and emits a warning annotation when it is not
  conventional. The commit message reaches the script through `env`, never through the shell, and
  the step never fails. Nothing runs on `pull_request` events: the earlier per-PR `pr-title` job
  was about a fifth of all Actions runs. It was never a required check (ruleset 20652163 requires
  exactly `gate`).
- **Untrusted interpolation.** An audit of every `${{ }}` inside a `run:` block on `6a1318a1`
  finds only step outputs (`deploy.yml:514`, `:566`, `deploy-production.yml:627`) and matrix or
  workflow `env` values (`ci.yml:164`, `:243`, `:277`). Nothing attacker-controlled is
  interpolated into a script.
- **Rulesets.** Ruleset **20652163** ("Required CI - validate-and-test", target
  `~DEFAULT_BRANCH`, enforcement `active`, last updated 2026-09-26) requires exactly
  `{"context": "gate"}` with `strict_required_status_checks_policy: true`, so a branch must also be
  up to date with `main` before it can merge. Read 2026-10-02 from
  `GET /repos/Iron-Wrap/ironwrap-os/rulesets/20652163`. The comment at `ci.yml:45-46`, that
  `validate-and-test` reports the name the ruleset "still requires", is stale and is contradicted
  by `:52-53` ("The single required status check is `gate`"). `gate` is `ci.yml:470-496` and
  `validate-and-test` is `:498-509`; it only mirrors `gate`.

## 5. Workers Builds — the honest comparison

Gain: "The Cloudflare Git integration lets you connect a new or existing Worker to a GitHub or
GitLab repository, enabling automated builds and deployments for your Worker on push"; no
Cloudflare API token in GitHub; "Preview builds run for branches that are not your production
branch. The Preview URL is posted as a pull request comment"; the production branch can run
`wrangler deploy` while preview branches run `wrangler versions upload`.

Loss, concretely: the build configuration lives in the Cloudflare dashboard, so it is not in a PR,
not reviewed, and not covered by `make validate`. Cloudflare rebuilds per branch, so the qa bytes
are not the artifact production promotes; the production workflow promotes the very bytes qa
proved (`deploy-production.yml:5-6`), and the identical-digest property in §1 is gone. And none of
the evidence chain survives: the signed permit (`deploy-production.yml:440-479`), the durable D1
ledger (`:266-278`, `:603-617`), the qa smoke (`deploy.yml:443-464`), the export-and-restore drill
(`:466-504`) and rollback drill (`:506-534`), and the automatic rollback after a failed promotion
(`deploy-production.yml:619-658`).

Docs: https://developers.cloudflare.com/workers/ci-cd/builds/

No recommendation beyond what is stated above: production stays on GitHub Actions so the permit,
ledger, and drills keep working; Workers Builds is a fit only for a per-PR preview URL, not for the
qa/production release train.

## Not verified

- `production` exists with the `v*` tag rule (read back 2026-10-22) but holds only
  `RELEASE_DECLARATION_READ_TOKEN` and `RELEASE_PRODUCTION_CLOUDFLARE_API_TOKEN`; the permit,
  ledger, admin and ingest secrets and `vars.RELEASE_PRODUCTION_ZONE_ID` are missing.
- The declaration check (`deploy-production.yml:101-138`) is exercised only for its refusals, run by
  hand against real `iron-wrap-infra` commits on 2026-10-22 (`sha_invalid`, `ref_not_tag`,
  `not_on_main:behind`, `policy_not_pin`, `token_missing`); the accepting path and `superseded`
  need a promotion on `iron-wrap-infra` `main`.
- No `v*` tag, no release, and Deploy Production has never run: every tag-path line is as written,
  not as run.
- Deploy has not succeeded since #305: the latest run fails at the qa smoke, so the export/restore
  and rollback drills have never executed.
- Which secrets and variables live in which store (unreadable: 403).
- The account's plan and its live cron count.
- The minimal permission per command (the Inferred rows).
- Every capture on this page came from an `aarch64` workspace, while `ci.yml`, `deploy.yml` and
  `deploy-production.yml` run `ubuntu-latest` (x64), where the published digest has never been
  produced. The qa = production equality is two builds on one machine and does not depend on the
  host.
- `/subdomain` and `/workers/domains`: docs-cited only.
