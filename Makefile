# IronWrap OS checks. CI (.github/workflows/ci.yml) runs `make check`, then
# `make e2e secret-scan` in the same job; `gate` covers all three. The paired-device Lighthouse budget is a timing measurement and
# keeps a runner of its own in ci.yml.

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := check

# Test logs feed the capability evidence receipt at the end of `check`.
OUT ?= tmp/check
NODE_PACKAGES := app mcp/erpnext-roofing-mcp mcp/ironwrap-bus-mcp mcp/newo-mcp
FRAPPE_APP := frappe-apps/ironwrap_roofing
FRAPPE_VENV := tmp/frappe-venv

.PHONY: check deps validate test-tools mcp app worker frappe audit static evidence e2e secret-scan

check: validate test-tools mcp app worker frappe audit static evidence

# npm ci only when a lockfile changes; npm writes node_modules/.package-lock.json.
%/node_modules/.package-lock.json: %/package-lock.json
	npm ci --no-audit --no-fund --prefix $*

workers-bus/node_modules/.package-lock.json: workers-bus/package-lock.json
	npm ci --ignore-scripts --no-audit --no-fund --prefix workers-bus

deps: $(addsuffix /node_modules/.package-lock.json,$(NODE_PACKAGES) workers-bus)

validate:
	node tools/validate-erpnext-doctypes.mjs
	node tools/validate-hermes-config.mjs
	node tools/validate-tenant-config.mjs
	node tools/validate-newo-config.mjs
	node tools/validate-lead-triage-shadow-authority.mjs
	node tools/validate-documentation.mjs
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
	  tools/validate-site-config-pins.test.mjs \
	  tools/validate-rail-credential-isolation.test.mjs \
	  tools/validate-facet-blank-quote-contract.test.mjs \
	  tools/validate-documentation.test.mjs \
	  tools/validate-newo-config.test.mjs \
	  tools/validate-lead-triage-shadow-authority.test.mjs \
	  tools/validate-tenant-runtime.test.mjs \
	  tools/seed-pipeline.test.mjs \
	  tools/generate-tenant-config.test.mjs \
	  tools/generate-tenant-worker-config.test.mjs \
	  tools/start-local-runtime.test.mjs \
	  tools/validate-ingest-doctype-coverage.test.mjs \
	  deploy/local/dev-vars.test.mjs \
	  deploy/local/frappe-marker-sweep.test.mjs \
	  deploy/local/frappe-init.test.mjs
	node --test \
	  tools/production-readiness.test.mjs \
	  tools/launch-proof.test.mjs \
	  tools/deploy-workflow.test.mjs \
	  tools/release-permit.test.mjs \
	  tools/release-promotion.test.mjs
	npm test --prefix release-issuer

mcp: $(addsuffix /node_modules/.package-lock.json,$(filter mcp/%,$(NODE_PACKAGES)))
	npm test --prefix mcp/erpnext-roofing-mcp
	npm test --prefix mcp/ironwrap-bus-mcp
	npm test --prefix mcp/newo-mcp

app: app/node_modules/.package-lock.json
	mkdir -p $(OUT)
	npm run typecheck --prefix app
	npm run lint --prefix app
	npm test --prefix app 2>&1 | tee $(OUT)/app-tests.log
	npm run format:check --prefix app
	npm run build --prefix app

worker: workers-bus/node_modules/.package-lock.json
	mkdir -p $(OUT)
	npm run typegen --prefix workers-bus
	rm -rf $(OUT)/d1
	npm run db:migrate:local --prefix workers-bus -- --persist-to "$(abspath $(OUT))/d1"
	npm test --prefix workers-bus 2>&1 | tee $(OUT)/worker-tests.tap
	npm run typecheck --prefix workers-bus
	npm run deploy --prefix workers-bus -- --dry-run

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

audit: deps
	npm audit --prefix app
	npm audit --prefix workers-bus
	for package in $(NODE_PACKAGES) workers-bus; do npm audit --omit=dev --prefix $$package; done

static:
	find deploy workers-bus -path '*/node_modules' -prune -o -type f -name '*.sh' -print0 \
	  | xargs -0 -r -n1 bash -n
	if grep -rl $$'—' hermes/ config/ deploy/; then \
	  echo "em dash found in agent-facing content" >&2; exit 1; \
	fi

# Exact-source capability evidence, bound to the test logs above.
evidence: app worker
	node tools/validate-documentation.mjs \
	  --app-test-output $(OUT)/app-tests.log \
	  --worker-test-output $(OUT)/worker-tests.tap \
	  --evidence $(OUT)/capability-evidence.json

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
	  curl -fsSL --retry 3 -o $$archive \
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
  test:pwa:onboarding

e2e: app/node_modules/.package-lock.json
	cd app && npx playwright install $(if $(CI),--with-deps,) chromium
	for suite in $(E2E_SUITES); do npm run $$suite --prefix app; done
