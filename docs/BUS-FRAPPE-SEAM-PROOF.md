# Bus↔Frappe seam proof (local, synthetic)

Records one complete `tools/launch-proof.mjs --execute` pass across the Worker↔Frappe seam in the
lowest-side-effect topology that exists, and states exactly what that does and does not prove.
This is repository/local-runtime evidence for the seam code path only — it is **not** a staging or
production deployment proof, and per [`LAUNCH-PROOF-SIDE-EFFECTS.md`](./LAUNCH-PROOF-SIDE-EFFECTS.md)
a green synthetic proof is never bridge-retirement authority.

## Why the dry run is not the seam proof

`node tools/launch-proof.mjs` without `--execute` performs no I/O: it prints one `curl` template
per step with `$BUS_BASE_URL`/`$INGEST_TOKEN`/`$ADMIN_TOKEN`/`$FRAPPE_*` left unexpanded and
exits 0. It cannot detect any defect in the system under test, so a dry run "against" any
environment exercises nothing. The smallest thing that does exercise the seam is `--execute`
pointed at a non-production bus wired to a throwaway Frappe — which is what this document records.

## Why not the remote staging Worker

The isolated `staging` env in `workers-bus/wrangler.jsonc` cannot exercise this seam as committed:

1. Its vars carry `ERPNEXT_ENABLED=false` / `APP_BFF_ENABLED=false`; changing a deployed Worker's
   vars requires a `wrangler deploy --env staging`, which is a human-gated action outside this
   change.
2. No Frappe site is deployed anywhere; the only running Frappe is the throwaway
   `deploy/local/docker-compose.yml` stack on an operator workstation, which a remote Worker
   cannot reach.
3. Staging keeps `NEWO_PRODUCTION_REQUIRED=true` with every `NEWO_*` credential/identity blank, so
   a deployed staging `/ready` fails the `newo_*` checks before the Frappe rail is even relevant —
   and launch-proof aborts on any red `/ready` check.

A true remote-staging seam proof therefore needs, in order: a reachable HTTPS Frappe site with the
app installed and the reader identity pinned; staging vars flipped
(`ERPNEXT_ENABLED`, `ERPNEXT_BASE_URL`, `APP_BFF_ENABLED`, `APP_PUBLIC_ORIGIN`/`APP_ALLOWED_ORIGINS`,
and either Newo config completed or `NEWO_PRODUCTION_REQUIRED=false` for staging);
`wrangler secret put --env staging` for `INGEST_TOKEN`, `ADMIN_TOKEN`, `APP_AUTH_PEPPER`,
`ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`, `PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET` (required for a
green `/ready` because the staging/local var sets activate the production-schedule rail), and a
non-empty `GOOGLE_SERVICE_ACCOUNT_JSON`; then a staging deploy and an `--execute` run.

## Topology that ran

- Commit: the commit adding this document (branch `chore/launch-proof-readiness`).
- Bus: `npm run dev` in `workers-bus` — `wrangler dev --env local --port 7100 --test-scheduled`,
  i.e. the committed `local` env vars (JobNimbus/Drive rails **off**, BFF + estimator **on**,
  `ERPNEXT_ENABLED=true`, `ERPNEXT_BASE_URL=http://localhost:8000`) with Miniflare-local D1/R2/
  queues. All 33 D1 migrations applied locally by `deploy/local/predev.mjs`.
- Frappe: the `deploy/local` stack (Frappe `v15.114.0`, site `ironwrap.localhost`, only `frappe` +
  `ironwrap_roofing` installed), provisioned through the checked-in local-stack tooling and
  [`deploy/local/README.md`](../deploy/local/README.md).
- Reader identity: `launch-proof-reader@ironwrap.local`, holding only
  `IronWrap Launch Proof Reader`, API pair generated in-site, pinned via
  `bench --site ironwrap.localhost set-config ironwrap_launch_proof_reader_user …` (the manual
  step no repo script performs).
- Zero outbound side-effect surface: `JOBNIMBUS_ENABLED=false`, Drive share IDs blank, and
  `GOOGLE_SERVICE_ACCOUNT_JSON` set to a non-JSON placeholder so `sendGmail` throws at
  `JSON.parse` before any network request — both ack legs settle as recorded `attempt_failed`
  receipts and the digest failure is caught. No JobNimbus, Gmail, Google Drive, Newo, or
  production Cloudflare resource was contacted.

## Result

`node tools/launch-proof.mjs --execute` (with `BUS_BASE_URL=http://localhost:7100`,
`FRAPPE_BASE_URL=http://localhost:8000`, dev tokens, reader API pair) exited `0`. Redacted
evidence emitted by the run:

```json
{
  "proof": "ironwrap-launch-proof-v3",
  "fixture": {
    "envelope_id": "ow_b278fa9f-8ff7-4bd4-af86-622efdef2a03",
    "project_id": "LP-1786285548952-ff9441fac76e2a8aefa708736cde5d12"
  },
  "steps": {
    "frappe_reader": { "http_status": 200 },
    "health": { "http_status": 200 },
    "ready": { "http_status": 200 },
    "ingest_website": { "http_status": 200 },
    "ingest_estimate": { "http_status": 200 },
    "ingest_estimate_replay": { "http_status": 200 },
    "admin_envelopes": { "http_status": 200 },
    "admin_reconcile": { "http_status": 200 },
    "admin_status": { "http_status": 200 }
  },
  "readiness": { "checks": "all 23 true, including newo_* (not required in the local env)" },
  "reconciliation": { "day": "2026-08-09", "open_dead_letters": 0, "gaps": 0 },
  "operational_status": {
    "status": "ok",
    "heartbeat": { "fresh": true, "reconciled": true },
    "counts": {
      "open_dead_letters": 0, "pending": 1, "stuck": 0,
      "frappe_errors": 0, "replay_failed": 0, "replay_stuck": 0
    },
    "recent_audit_failure_count": 0
  },
  "frappe_projection": {
    "correlation_id": "launch-proof:LP-1786285548952-ff9441fac76e2a8aefa708736cde5d12",
    "state": "matched",
    "attempts": 1,
    "http_status": 200
  },
  "bridge_keep_enabled": true,
  "reconciliation_required": false
}
```

(`steps` request ids and the full 23-entry check map are elided above for brevity; the executed
run emitted them and they contained no payloads, tokens, or contact fields. `counts.pending: 1`
is the synthetic lead envelope, which correctly stops short of `pushed` while the JobNimbus rail
is off.)

Independent read-back through the local integration identity confirmed both seam directions in
Frappe, all records synthetic (`example.invalid`):

- `Lead Envelope` ×2 — one written by the **queue consumer** for the website lead (the rail the
  proof itself never asserts, observed working here), one by the synchronous estimate mirror;
- `Roof Job` ×2, `Roofing Customer` ×1;
- `Instant Estimate Session` ×1 — `estimate:LP-…`, the record the reader lookup matched.

## What this run surfaced (feeds the defect log)

1. `workers-bus/.dev.vars.example` omits `PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET` while the
   `local` env vars activate the production-schedule rail — an out-of-the-box `npm run dev` can
   never reach a green `/ready` (`production_schedule_configuration` stays false) and launch-proof
   aborts at its `/ready` assertion. Same class of gap: a truly empty
   `GOOGLE_SERVICE_ACCOUNT_JSON` turns `notification_configuration` red; the §9 rehearsal text in
   the side-effect inventory was corrected in this commit to require a non-empty parse-failing
   placeholder instead of "unset".
2. `wrangler dev` does not hot-reload `.dev.vars`; a restart is required after editing it.
