# IronWrap OS checks. CI (.github/workflows/ci.yml) splits this into parallel jobs
# (`check-contracts`, `check-pwa`, sharded `worker-shard`) plus a matrixed `make e2e`;
# `gate` covers all of them. `make check` stays the local, sequential entry point and
# must still run everything the split jobs run between them. The paired-device
# Lighthouse budget is a timing measurement and keeps a runner of its own in ci.yml.

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := check

# Test logs feed the capability evidence receipt at the end of `check`.
OUT ?= tmp/check
NODE_PACKAGES := app mcp/erpnext-roofing-mcp mcp/ironwrap-bus-mcp mcp/newo-mcp agent-host
FRAPPE_APP := frappe-apps/ironwrap_roofing
FRAPPE_VENV := tmp/frappe-venv

.PHONY: check check-contracts check-pwa check-worker deps validate test-tools mcp agent-host app \
  worker worker-contract worker-tests worker-shard frappe audit static evidence \
  evidence-receipt e2e e2e-suite secret-scan seed ci-sqlite

check: validate test-tools mcp agent-host app worker frappe audit static evidence

# Per-area sub-targets for CI's parallel jobs. Together they cover exactly what
# `check` covers, minus `evidence` (which needs both the pwa and worker legs merged
# onto one filesystem, so it runs in its own CI job instead): `make -n check-contracts
# check-pwa check-worker` and `make -n check` list the same set of commands.
check-contracts: validate test-tools mcp agent-host frappe audit static
check-pwa: app
check-worker: worker

# Ubuntu's older CLI cannot parse the unchanged 0117 guard. Keep every schema
# object in recovery proofs and install a checksum-pinned verification engine.
ci-sqlite:
	bash tools/install-sqlite-cli.sh "$(abspath $(OUT))/sqlite"
	printf '%s\n' "$(abspath $(OUT))/sqlite" >> "$${GITHUB_PATH:?CI requires GITHUB_PATH}"

# npm ci only when a lockfile changes; npm writes node_modules/.package-lock.json.
%/node_modules/.package-lock.json: %/package-lock.json
	npm ci --no-audit --no-fund --prefix $*

workers-bus/node_modules/.package-lock.json: workers-bus/package-lock.json
	npm ci --ignore-scripts --no-audit --no-fund --prefix workers-bus

# The Claude and Codex SDKs pull their CLIs in as optional platform binaries (about 700 MB);
# the tests inject fakes, so checks install the SDK code only.
agent-host/node_modules/.package-lock.json: agent-host/package-lock.json
	npm ci --omit=optional --ignore-scripts --no-audit --no-fund --prefix agent-host

deps: $(addsuffix /node_modules/.package-lock.json,$(NODE_PACKAGES) workers-bus)

validate:
	node tools/validate-erpnext-doctypes.mjs
	node tools/validate-hermes-config.mjs
	node tools/validate-tenant-config.mjs
	node tools/validate-newo-config.mjs
	node tools/validate-lead-triage-shadow-authority.mjs
	node tools/validate-documentation.mjs
	node agent-host/evals/validate.mjs --require-complete
	node tools/validate-site-config-pins.mjs
	node tools/validate-rail-credential-isolation.mjs
	node tools/validate-facet-blank-quote-contract.mjs
	node tools/validate-ingest-doctype-coverage.mjs
	IRONWRAP_TENANT_CONFIG=ironwrap APP_TENANT_ID=ironwrap APP_TENANT_NAME="IronWrap OS" \
	  APP_TENANT_BRAND=IronWrap APP_LOCALE=en-CA APP_TIME_ZONE=America/Edmonton \
	  APP_CURRENCY=CAD FROM_EMAIL=sales@ironwrapexteriors.com \
	  APP_BFF_ENABLED=false APP_CUSTOMER_PORTAL_ENABLED=false \
	  node tools/validate-tenant-runtime.mjs
	node tools/applicad-xml-proof.mjs --check
	node tools/production-readiness.mjs contract

test-tools:
	node --test \
	  tools/make-audit.test.mjs \
	  tools/d1-migrations-splitter.test.mjs \
	  tools/validate-site-config-pins.test.mjs \
	  tools/validate-rail-credential-isolation.test.mjs \
	  tools/validate-facet-blank-quote-contract.test.mjs \
	  tools/validate-documentation.test.mjs \
	  agent-host/evals/validate.test.mjs \
	  agent-host/evals/score.test.mjs \
	  agent-host/evals/report.test.mjs \
	  tools/validate-newo-config.test.mjs \
	  tools/validate-lead-triage-shadow-authority.test.mjs \
	  tools/validate-tenant-runtime.test.mjs \
	  tools/seed-pipeline.test.mjs \
	  tools/seed-env.test.mjs \
	  tools/generate-tenant-config.test.mjs \
	  tools/generate-tenant-worker-config.test.mjs \
	  tools/start-local-runtime.test.mjs \
	  tools/validate-ingest-doctype-coverage.test.mjs \
	  tools/wrangler-binding-budget.test.mjs \
	  deploy/local/dev-vars.test.mjs \
	  deploy/local/frappe-marker-sweep.test.mjs \
	  deploy/local/frappe-init.test.mjs
	node --test \
	  tools/production-readiness-contract.test.mjs \
	  tools/production-readiness-live-env.test.mjs \
	  tools/production-readiness-backup-restore.test.mjs \
	  tools/production-readiness-d1-backup.test.mjs \
	  tools/production-readiness-d1-recovery.test.mjs \
	  tools/production-readiness-d1-drill.test.mjs \
	  tools/production-readiness-misc.test.mjs \
	  tools/merge-worker-tap.test.mjs \
	  tools/ci-workflow.test.mjs \
	  tools/ci-scope.test.mjs \
	  tools/launch-proof.test.mjs \
	  tools/conventional-pr-title.test.mjs \
	  tools/deploy-workflow.test.mjs \
	  tools/qa-artifact-flow.test.mjs \
	  tools/qa-dead-letter-workflow.test.mjs \
	  tools/release-permit.test.mjs \
	  tools/release-promotion.test.mjs
	npm test --prefix release-issuer

mcp: $(addsuffix /node_modules/.package-lock.json,$(filter mcp/%,$(NODE_PACKAGES)))
	npm test --prefix mcp/erpnext-roofing-mcp
	npm test --prefix mcp/ironwrap-bus-mcp
	npm test --prefix mcp/newo-mcp

agent-host: agent-host/node_modules/.package-lock.json
	npm run typecheck --prefix agent-host
	npm test --prefix agent-host

app: app/node_modules/.package-lock.json
	mkdir -p $(OUT)
	npm run typecheck --prefix app
	npm run lint --prefix app
	npm test --prefix app 2>&1 | tee $(OUT)/app-tests.log
	npm run format:check --prefix app
	npm run build --prefix app

worker: worker-contract worker-tests

# The typegen/typecheck/dry-run contract, plus the migration smoke. Nothing under
# workers-bus/src imports from app/ (IRO-267 blocker 9), but the dry-run below
# validates the real app/dist bundle, so this target needs app's node_modules too.
# typecheck needs worker-configuration.d.ts, which typegen generates (blocker 10),
# so typegen must run before typecheck here.
#
# workers-bus/wrangler.jsonc's assets.directory points at ../app/dist, and
# `wrangler deploy --dry-run` fails closed if that directory is missing. It
# does not fail closed on an empty one, though: run 36706471011 showed
# `Read 0 files from the assets directory` against `Read 97 files` inside
# `make check` on run 36589095529, same pinned wrangler 4.131.0 - an empty
# `app/dist` dry-runs clean but validates none of wrangler's asset limits or
# manifest. So this target builds the real bundle first and then greps the
# dry-run log for a nonzero read count; a wrangler upgrade that renames this
# line must have the guard re-pinned to the new wording, not deleted.
worker-contract: workers-bus/node_modules/.package-lock.json app/node_modules/.package-lock.json
	mkdir -p $(OUT)
	npm run typegen --prefix workers-bus
	rm -rf $(OUT)/d1
	npm run db:migrate:local --prefix workers-bus -- --persist-to "$(abspath $(OUT))/d1"
	npm run typecheck --prefix workers-bus
	npm run build --prefix app
	npm run deploy --prefix workers-bus -- --dry-run 2>&1 | tee $(OUT)/worker-dry-run.log
	grep -Eq 'Read [1-9][0-9]* files from the assets directory' $(OUT)/worker-dry-run.log

# workers-bus/test/record-documents-api.test.ts imports a shared zod contract
# from app/src/, so the Worker suite also needs app's node_modules; in the
# unsplit `check` target this always worked by accident (the `app` target ran
# first in the same job filesystem), a coupling CI's separate worker job made
# real (IRO-267).
worker-tests: workers-bus/node_modules/.package-lock.json app/node_modules/.package-lock.json
	mkdir -p $(OUT)
	npm run typegen --prefix workers-bus
	npm test --prefix workers-bus 2>&1 | tee $(OUT)/worker-tests.tap

# One shard of the Worker bus suite, for CI's worker matrix (SHARD=k/N, N=4). The cwd
# must be workers-bus so node's test discovery finds the same 151 files `npm test`
# does. No shard touches D1: nothing under workers-bus/ reads the database `worker`
# persists (grep for persist-to|persistTo|tmp/check|.wrangler finds nothing), so the
# 40s db:migrate:local smoke stays its own CI job (`worker-contract`) instead of
# being duplicated, or skipped, per shard.
worker-shard: workers-bus/node_modules/.package-lock.json app/node_modules/.package-lock.json
	mkdir -p $(OUT)
	npm run typegen --prefix workers-bus
	cd workers-bus && node --test --test-shard=$(SHARD) 2>&1 \
	  | tee "$(abspath $(OUT))/worker-tests-$(subst /,-,$(SHARD)).tap"

# The leftover Frappe compatibility app: unit contracts without a site, lint,
# and the wheel the release artifact carries.
frappe:
	python3 -m venv $(FRAPPE_VENV)
	$(FRAPPE_VENV)/bin/python -m pip install --quiet --disable-pip-version-check \
	  setuptools ruff==0.13.0 build==1.4.0 ./$(FRAPPE_APP)
	cd $(FRAPPE_APP) && ../../$(FRAPPE_VENV)/bin/python -m unittest discover -s tests -t .
	cd $(FRAPPE_APP) && ../../$(FRAPPE_VENV)/bin/ruff check ironwrap_roofing tests
	cd $(FRAPPE_APP) && ../../$(FRAPPE_VENV)/bin/python -m compileall -q ironwrap_roofing tests
	$(FRAPPE_VENV)/bin/python -m build --wheel --outdir $(OUT)/frappe-dist $(FRAPPE_APP)

# Seed a non-production environment (tools/seed-env.mjs, IRO-263). Refuses production on its own;
# ADMIN_TOKEN/INGEST_TOKEN come from workers-bus/.dev.vars for a loopback target so neither token
# ever appears on this command line - pass them yourself in the environment for a remote ENV=.
#   make seed BASE_URL=http://localhost:7100
#   ADMIN_TOKEN=... INGEST_TOKEN=... make seed ENV=qa [LEADS=5]
seed:
	@target="$(if $(BASE_URL),--base-url $(BASE_URL),$(if $(ENV),--env $(ENV),))"; \
	if [ -z "$$target" ]; then \
	  echo "usage: make seed ENV=<name>   or   make seed BASE_URL=<loopback-url>  [LEADS=n]" >&2; \
	  exit 2; \
	fi; \
	if [ -n "$(BASE_URL)" ] && [ -n "$(ENV)" ]; then \
	  echo "pass exactly one of ENV= or BASE_URL=" >&2; \
	  exit 2; \
	fi; \
	if [ -n "$(BASE_URL)" ] && [ -f workers-bus/.dev.vars ]; then set -a; . workers-bus/.dev.vars; set +a; fi; \
	node tools/seed-env.mjs $$target $(if $(LEADS),--leads $(LEADS),)

audit: deps
	npm audit --prefix app
	npm audit --prefix workers-bus
	for package in $(NODE_PACKAGES) workers-bus; do npm audit --omit=dev --prefix $$package || exit $$?; done

static:
	find deploy workers-bus -path '*/node_modules' -prune -o -type f -name '*.sh' -print0 \
	  | xargs -0 -r -n1 bash -n
	if grep -rl $$'—' hermes/ config/ deploy/; then \
	  echo "em dash found in agent-facing content" >&2; exit 1; \
	fi

# The receipt command, defined once so `evidence` (local) and `evidence-receipt`
# (CI's evidence job, fed by downloaded artifacts) cannot drift apart.
EVIDENCE_RECEIPT = node tools/validate-documentation.mjs \
  --app-test-output $(OUT)/app-tests.log \
  --worker-test-output $(OUT)/worker-tests.tap \
  --evidence $(OUT)/capability-evidence.json

# Exact-source capability evidence, bound to the test logs above.
evidence: app worker
	$(EVIDENCE_RECEIPT)

evidence-receipt:
	$(EVIDENCE_RECEIPT)

# Secret scan of the tracked tree (`git archive`, not the checkout) with a
# pinned, checksum-verified gitleaks; `tools/secret-scan.test.mjs` proves it
# fails closed.
GITLEAKS_VERSION := 8.30.1
GITLEAKS_SHA256 := 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
GITLEAKS_DIR := tmp/gitleaks-$(GITLEAKS_VERSION)
# The pinned download is the linux x64 build; elsewhere set GITLEAKS_BIN.
GITLEAKS_BIN ?= $(abspath $(GITLEAKS_DIR))/gitleaks

secret-scan:
	test -x "$(GITLEAKS_BIN)" || { \
	  mkdir -p $(GITLEAKS_DIR); archive=$(GITLEAKS_DIR)/gitleaks.tar.gz; \
	  curl -fsSL --retry 5 --retry-max-time 120 --connect-timeout 10 --max-time 60 -o $$archive \
	    https://github.com/gitleaks/gitleaks/releases/download/v$(GITLEAKS_VERSION)/gitleaks_$(GITLEAKS_VERSION)_linux_x64.tar.gz; \
	  echo "$(GITLEAKS_SHA256)  $$archive" | sha256sum -c -; \
	  tar -xzf $$archive -C $(GITLEAKS_DIR) gitleaks; }
	GITLEAKS_BIN="$(GITLEAKS_BIN)" node --test tools/secret-scan.test.mjs
	GITLEAKS_BIN="$(GITLEAKS_BIN)" node tools/secret-scan.mjs

# Playwright PWA suites. The office, accounting, and onboarding specs self-skip
# under the default field session, so each gets its own run.
E2E_SUITES := test:pwa test:pwa:board test:pwa:owner-configuration test:pwa:people \
  test:pwa:safety test:pwa:documents test:pwa:job-history test:pwa:placement \
  test:pwa:capabilities test:pwa:capabilities:accounting test:pwa:accounting \
  test:pwa:onboarding test:pwa:quote-revision test:pwa:decisions test:pwa:sales-intake \
  test:pwa:manual-measurements test:pwa:service-calls

# Every suite runs even after one fails, and the recipe fails if any did: a bare
# `for` loop exits with its last command's status, which used to pass `make e2e`
# whenever only an earlier suite failed.
e2e: app/node_modules/.package-lock.json
	cd app && npx playwright install chromium
	npm run build --prefix app
	status=0; for suite in $(E2E_SUITES); do PW_SKIP_BUILD=1 npm run $$suite --prefix app || status=1; done; exit $$status

# One e2e leg, for CI's e2e matrix (SUITE="<npm script> ..."). Builds once, then
# runs the leg's suites one after another; each pins its own ACCEPTANCE_PORT in
# app/package.json and runs single-worker, so they never overlap. The runner
# image already carries Chromium's system libraries (IRO-269), so only the
# browser is installed.
e2e-suite: app/node_modules/.package-lock.json
	cd app && npx playwright install chromium
	npm run build --prefix app
	status=0; for suite in $(SUITE); do PW_SKIP_BUILD=1 npm run $$suite --prefix app || status=1; done; exit $$status
