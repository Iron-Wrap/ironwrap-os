# IronWrap OS Launch Runbook (free-tier path)

Copy-paste guide from zero to a live end-to-end system at $0 incremental hosting cost.
Companion files live in `deploy/`. Steady-state operations: `docs/OPERATIONS-RUNBOOK.md`.
Second-tenant cloning: `docs/WHITE-LABEL-CLONE-PLAYBOOK.md`.

Version-sensitive commands are marked "verify against the frappe_docker README"; the
repo pins nothing about frappe_docker, so trust upstream docs over this file if they differ.

## 0. What the owner must provide (nothing else blocks)

| Item | Why |
|---|---|
| Oracle Cloud account (Always Free; card required, $0 spend) or any always-on Ubuntu 22+ box | Hosts the Frappe site + Hermes. Free tier is 2 OCPU / 12 GB as of 2026-06, enough for both |
| An empty private GitHub repo `ironwrap/ironwrap_roofing` | frappe_docker image builds clone apps from git URLs; the monorepo subdir is split into it |
| Cloudflare DNS access for the chosen hostname (e.g. `os.ironwrapexteriors.com`) | Free Tunnel ingress |
| Website/CMS access | Source cutover (step 8) |
| One QuickBooks OAuth consent click | Payment detail reads (step 8) |

## 1. VM

Oracle: create a VM.Standard.A1.Flex instance (2 OCPU, 12 GB, Ubuntu 22.04, 100+ GB boot).
Then:

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git rclone
sudo usermod -aG docker $USER  # re-login after
```

## 2. Publish the app repo (one time, from the dev machine)

```bash
APP_REPO_URL=https://github.com/ironwrap/ironwrap_roofing.git deploy/split-app-repo.sh
```

Re-run after any DocType change to sync the split repo before rebuilding the image.

## 3. Frappe site (Frappe-only; NEVER install the erpnext app)

On the VM (verify build-arg names against the frappe_docker README):

```bash
git clone https://github.com/frappe/frappe_docker && cd frappe_docker
# apps.json from deploy/apps.example.json with a real read token
export APPS_JSON_BASE64=$(base64 -w0 apps.json)
docker build --build-arg=APPS_JSON_BASE64=$APPS_JSON_BASE64 \
  -t ironwrap-os:latest -f images/layered/Containerfile .
# Bring up mariadb/redis/backend/frontend per the frappe_docker compose docs,
# using image ironwrap-os:latest, then:
docker exec <backend> bench new-site os.ironwrapexteriors.com --admin-password '<choose>'
docker exec <backend> bench --site os.ironwrapexteriors.com install-app ironwrap_roofing
```

Create the API credentials the Worker and MCP servers use: Frappe Desk > User >
API Access (an api_key/api_secret pair for a dedicated `bus@` service user with
System Manager role). Record them only in secret stores.

## 4. Free HTTPS ingress (Cloudflare Tunnel)

```bash
curl -fsSL https://pkg.cloudflare.com/install.sh | sudo bash && sudo apt-get install -y cloudflared
cloudflared tunnel login
cloudflared tunnel create ironwrap-os
cloudflared tunnel route dns ironwrap-os os.ironwrapexteriors.com
sudo cp deploy/cloudflared-config.example.yml /etc/cloudflared/config.yml  # fill UUID
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

## 5. Wire the Worker to the site

```bash
cd workers-bus
npx wrangler secret put ERPNEXT_BASE_URL     # https://os.ironwrapexteriors.com
npx wrangler secret put ERPNEXT_API_KEY
npx wrangler secret put ERPNEXT_API_SECRET
# then set ERPNEXT_ENABLED="true" in wrangler.jsonc vars and deploy
npx wrangler deploy
```

## 6. Launch proof (gates 1-2)

```bash
node tools/launch-proof.mjs                    # dry run: prints the plan
BUS_BASE_URL=... INGEST_TOKEN=... ADMIN_TOKEN=... node tools/launch-proof.mjs --execute
```

Pass criteria: script prints LIVE/PROVEN, and in Frappe Desk the fixture shows
Lead Envelope, Roofing Customer/Property, Roof Job, and all 7 Production Gate
State rows. Archive the fixture records afterward. Run `POST /admin/reconcile`
and confirm the heartbeat.

## 7. Hermes (gates 3-4)

On the same VM, install the Hermes runtime per its docs
(https://hermes-agent.nousresearch.com/docs/), export the env block from
`deploy/env.example`, and register the two MCP servers from
`hermes/mcp-servers.json` (tool filtering per role comes from
`hermes/agents/roles.json`; validate with `node tools/validate-hermes-config.mjs`).

- Gate 3 proof: with `ERPNEXT_WRITE_ENABLED=false`, ask an owner-operator profile
  question ("what jobs are blocked and why") and confirm it answers from live reads only.
- Gate 4 proof: set `ERPNEXT_WRITE_ENABLED=true` plus `HERMES_WRITE_TOKEN`, run
  `dry_run_update_gate` on the fixture job, approve, run `request_update_gate`,
  and confirm the Hermes Run audit row (before + Executed).

## 8. Real-source cutover (gates 5, 9, and payment visibility)

| Source | Action |
|---|---|
| Website form | POST to `/ingest/website` with the ingest bearer (see `docs/WEBSITE-INTEGRATION.md`) |
| 3D estimator | POST submit/save to `/ingest/estimate` (idempotent by project id) |
| Jotform photo/voice | Point the webhook at `/ingest/photo`; device test with photos and one voice note |
| RoofRuler email | Forward parsed reports to `/ingest/measurement` via the existing Make Core seat or a free Gmail Apps Script |
| QuickBooks | Owner completes OAuth consent; webhook receiver is already live |

## 9. Backups and monitoring ($0)

```bash
# cron on the VM (env block from deploy/env.example):
15 9 * * * /home/ubuntu/ironwrap-ops/deploy/backup-to-r2.sh >> /var/log/ironwrap-backup.log 2>&1
```

- UptimeRobot (free) on `GET /health` (bus) and the site hostname.
- The daily reconcile digest email IS the heartbeat; if it stops arriving, escalate
  per `docs/OPERATIONS-RUNBOOK.md`.

## 10. Gate scorecard for launch week

| Gate | Proof artifact |
|---|---|
| 1 Intake spine | `launch-proof.mjs --execute` passes on production traffic |
| 2 ERP operating core | Fixture Roof Job + 7 gates visible in Frappe Desk |
| 3 Read-only Hermes | Owner question answered from live truth, zero writes |
| 4 Approved-write | One `request_update_gate` with a full Hermes Run audit trail |
| 5 Instant estimate | Real estimator submit lands a review-gated session |
| 6-8 Proposal/supplier/gates | First real job: takeoff -> supplier quote/order -> proposal pack (Frappe print format PDF) |
| 9 Field proof | Real crew photos + one voice note land as evidence + check-in |
| 10 Closeout | Completion packet -> warranty draft -> review request (Eligible, human-sent) |

E-sign interim: email the proposal PDF, capture the signed scan as an Evidence Item
with `customer_signoff_ref`. SMS stays record-only until the A2P task completes.
