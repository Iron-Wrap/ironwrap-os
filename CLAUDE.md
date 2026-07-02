# CLAUDE.md

**Read [`AGENTS.md`](./AGENTS.md) — it is the canonical guide for this repo.** This file exists
so Claude Code loads it automatically; the substance lives in AGENTS.md.

Critical must-knows (full detail in AGENTS.md):

1. **`final-spec-pack/` is the spec (the target). GHL is experimental and being retired — never
   re-introduce it as a keeper.** Migrate toward the JobNimbus spine, don't bend the spec back.
2. **JobNimbus is live-verified:** record types are contact `Customer` / job `Retail` —
   **`"Lead"` is rejected (HTTP 400)**. API = `api1`, `Bearer` key, `{count,results}`, id `jnid`.
3. **Storage = OneDrive (Microsoft 365); email = Microsoft 365 brand mailboxes** (ESP deferred).
   Two brands: IronWrap Exteriors + iRoof Alberta. Make is on the Core plan.
4. **Secrets are never committed.** The JobNimbus API key was shared in chat — it should be
   rotated. Use `.dev.vars` (gitignored) / `wrangler secret put`.
5. **`workers-bus/`**: `npm test` (zero-dep), `npm run typecheck`, `npx wrangler deploy --dry-run`.
   JobNimbus write path is **live-verified** (`JOBNIMBUS_ENABLED="true"`); **omit `source_name`**
   (account 400s unknown sources) and note JN api1 has **no DELETE** (archive via `PUT is_archived`).
6. **Maintainer = Ilia via Claude Code.** Roadmap: [`DELIVERY-PLAN.md`](./DELIVERY-PLAN.md).
