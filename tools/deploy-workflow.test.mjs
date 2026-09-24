import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/deploy.yml", import.meta.url);

function section(workflow, heading) {
  const start = workflow.indexOf(`  ${heading}:`);
  assert.ok(start >= 0, `missing job ${heading}`);
  const next = workflow.slice(start + 3).search(/\n  [A-Za-z0-9_-]+:/);
  return workflow.slice(start, next < 0 ? workflow.length : start + 3 + next);
}

function ordered(source, markers) {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker);
    assert.ok(
      current > previous,
      `expected ${marker} after the preceding release gate`,
    );
    previous = current;
  }
}

function validateWorkflow(workflow) {
  const admission = section(workflow, "admission");
  const build = section(workflow, "build");
  const staging = section(workflow, "staging");
  const production = section(workflow, "production");

  assert.match(
    workflow,
    /workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]/,
  );
  // Exactly two source events are admissible: a pre-merge pull_request run, and
  // a post-merge push run pinned to main. The push arm must stay paired with the
  // branch pin, and both arms stay behind the head_repository pin so a fork's CI
  // (including a fork whose own default branch is named main) is never admitted.
  assert.match(admission, /workflow_run\.event == 'pull_request'/);
  assert.match(
    admission,
    /workflow_run\.event == 'push' &&\n\s+github\.event\.workflow_run\.head_branch == 'main'/,
  );
  assert.match(
    admission,
    /workflow_run\.head_repository\.full_name == github\.repository/,
  );
  assert.match(
    workflow,
    /permissions:\n\s+contents: write\n\s+actions: read\n\s+pull-requests: write/,
  );
  assert.match(workflow, /group: release-ironwrap-production/);
  assert.match(workflow, /cancel-in-progress: false/);
  for (const job of [admission, build, staging]) {
    assert.match(job, /permissions:\n\s+actions: read\n\s+contents: read/);
    assert.doesNotMatch(job, /contents: write|pull-requests: write/);
  }
  assert.match(
    production,
    /permissions:\n\s+actions: read\n\s+contents: write\n\s+pull-requests: write/,
  );
  assert.equal(
    (workflow.match(/persist-credentials: false/g) ?? []).length,
    4,
  );
  assert.doesNotMatch(
    workflow,
    /environment:\s*production|required_reviewers|RELEASE_REVIEW_RECEIPT/,
  );
  // Deploy still never triggers on a raw push: every admissible source is a
  // completed CI run, so unvalidated code cannot reach the pipeline.
  assert.doesNotMatch(workflow, /branches:\s*\[main\]/);

  assert.match(
    admission,
    /Check out generation N policy enforcement from the PR base/,
  );
  assert.match(
    admission,
    /git worktree add --detach "\$RUNNER_TEMP\/policy-enforcer" "\$base_commit"/,
  );
  assert.match(
    admission,
    /pr-context[\s\S]*source-evidence[\s\S]*ci-checks[\s\S]*policy-genesis[\s\S]*admission-context/,
  );
  // Admission reads every job of the CI run it releases, including the
  // `gate` aggregator and the `validate-and-test` name the ruleset requires.
  assert.match(
    admission,
    /ci-checks[\s\S]*--job-names "[^"]*\bgate\b[^"]*validate-and-test"/,
  );
  // Automated checks are the only release gate: no reviewer GO receipt, no
  // independent evidence issuer, and no external Frappe adapter signer.
  assert.doesNotMatch(
    workflow,
    /issuer-request|review-wait|release-evidence-wait|review\.receipt|RELEASE_INDEPENDENT_|RELEASE_REVIEW_|service-adapter|RELEASE_SERVICE_ADAPTER_/,
  );
  assert.match(workflow, /RELEASE_FRAPPE_SCOPE: out-of-scope/);
  assert.match(admission, /--repo-root "\$RUNNER_TEMP\/policy-enforcer"/);
  assert.match(workflow, /RELEASE_RULESET_ID: 20652124/);
  assert.match(
    workflow,
    /RELEASE_PRODUCTION_DOMAIN_HOSTNAME: ironwrap-bus\.ironwrapexteriors\.com/,
  );
  assert.match(workflow, /RELEASE_PRODUCTION_DOMAIN_SERVICE: ironwrap-bus/);
  assert.match(
    workflow,
    /RELEASE_PRODUCTION_ZONE_ID: \$\{\{ vars\.RELEASE_PRODUCTION_ZONE_ID \}\}/,
  );
  assert.match(admission, /pr-context[\s\S]*--ruleset-id "\$RELEASE_RULESET_ID"/);
  // The push-sourced arm derives generation N from the squash commit's single
  // parent and hands both commits to the enforcer, which re-reads the same
  // lineage from the provider before admitting anything.
  assert.match(
    admission,
    /lineage="\$\(git rev-list --parents --max-count=1 "\$RELEASE_SOURCE_COMMIT"\)"[\s\S]*-ne 2[\s\S]*release_admission_push_not_linear/,
  );
  assert.match(
    admission,
    /push-context[\s\S]*--head-commit "\$RELEASE_SOURCE_COMMIT" --base-commit "\$RELEASE_BASE_COMMIT"/,
  );
  assert.match(admission, /push-context[\s\S]*--ruleset-id "\$RELEASE_RULESET_ID"/);
  assert.match(admission, /\$\{\{ runner\.temp \}\}\/pr-context\.json/);
  assert.match(workflow, /node "\$RELEASE_ENFORCER"/);
  assert.doesNotMatch(workflow, /node tools\/release-promotion\.mjs/);
  assert.equal(
    (workflow.match(/node "\$\(dirname "\$RELEASE_ENFORCER"\)\/launch-proof\.mjs" --execute/g) ?? [])
      .length,
    3,
  );
  assert.doesNotMatch(workflow, /node tools\/launch-proof\.mjs/);

  assert.match(build, /npm ci --prefix app/);
  assert.match(build, /npm ci --ignore-scripts --prefix workers-bus/);
  assert.match(build, /python -m build --wheel/);
  assert.match(build, /wrangler deploy[\s\S]*--dry-run --strict/);
  assert.match(
    build,
    /artifact-manifest[\s\S]*--worker[\s\S]*--pwa[\s\S]*--frappe-wheel/,
  );
  assert.match(build, /tar --sort=name --mtime='UTC 1970-01-01'/);
  assert.equal((build.match(/actions\/upload-artifact@/g) ?? []).length, 2);
  assert.match(
    build,
    /name: iro41-release-artifact-\$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
  );
  assert.match(build, /admission\/pr-context\.json/);

  ordered(staging, [
    "provider-targets",
    "Require isolated smoke inputs before any staging mutation",
    "Verify isolated staging secret-name inventory before mutation",
    "Fail closed on static staging readiness drift before mutation",
    "Apply expand/contract migrations to isolated staging",
    "Capture the current isolated staging revision",
    "Upload the same immutable bundle to isolated staging",
    "Verify isolated staging provider version readback",
    "Deploy candidate to isolated staging traffic",
    "Verify staging active revision, health, and owned-core readiness",
    "Run authenticated affected-workflow smoke receipt",
    "Re-read and bind the post-smoke staged revision",
    "Export and restore staging data into a separate local drill target",
    "Roll back staging candidate and prove the previous revision against migrated data",
  ]);
  assert.match(
    staging,
    /"\$WRANGLER_BIN" versions upload[\s\S]*--env staging[\s\S]*--no-bundle[\s\S]*--strict/,
  );
  assert.match(staging, /"\$WRANGLER_BIN" secret list[\s\S]*secret-readback/);
  assert.match(staging, /npm ci --ignore-scripts --prefix "\$RUNNER_TEMP\/policy-enforcer\/workers-bus"/);
  assert.match(staging, /provider-targets[\s\S]*--policy-root "\$RUNNER_TEMP\/policy-enforcer"[\s\S]*--environment staging/);
  assert.doesNotMatch(staging, /npm ci --ignore-scripts --prefix workers-bus/);
  assert.match(staging, /secrets\.RELEASE_STAGING_CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(staging, /secrets\.RELEASE_PRODUCTION_CLOUDFLARE_API_TOKEN|secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(staging, /version-readback/);
  assert.match(staging, /environment-preflight[\s\S]*staging-environment-preflight\.json/);
  assert.match(
    staging,
    /d1 export[\s\S]*> "\$export_log" 2>&1[\s\S]*restore-local[\s\S]*--database "\$source_database"[\s\S]*restore-local[\s\S]*--database "\$restored_database"[\s\S]*restore-readback[\s\S]*--source-target "\$source_database"[\s\S]*--restored-target "\$restored_database"[\s\S]*backup-receipt/,
  );
  assert.match(staging, /source_database="\$RUNNER_TEMP\/staging-restore-source-\$\{GITHUB_RUN_ID\}\.sqlite"/);
  assert.match(staging, /restored_database="\$RUNNER_TEMP\/staging-restore-restored-\$\{GITHUB_RUN_ID\}\.sqlite"/);
  assert.match(
    staging,
    /test ! -e "\$source_database"[\s\S]*test ! -e "\$restored_database"/,
  );
  assert.match(
    staging,
    /if ! "\$WRANGLER_BIN" d1 export[\s\S]*echo "release_staging_export_failed" >&2/,
  );
  assert.doesNotMatch(staging, /restore-query|--persist-to|d1 execute/);
  const stagingProof = staging.slice(staging.indexOf("- name: Publish redacted staging proof"));
  assert.doesNotMatch(stagingProof, /staging\.sql|staging-export\.log/);
  assert.match(staging, /rollback-receipt/);
  assert.match(
    staging,
    /id: deploy_staging[\s\S]*if: \$\{\{ failure\(\) && steps\.deploy_staging\.outcome != 'skipped' \}\}[\s\S]*versions deploy[\s\S]*--version-id "\$previous"[\s\S]*deployments list[\s\S]*staging-cleanup-receipt/,
  );
  assert.match(
    staging,
    /staging-cleanup-receipt[\s\S]*--previous "\$previous" --candidate "\$candidate"[\s\S]*--command-result "\$command_result"/,
  );

  ordered(production, [
    "provider-targets",
    "Require production provider and smoke inputs",
    "Verify the same immutable artifact bytes",
    "Verify production secret-name inventory before immutable promotion",
    "Fail closed on static production readiness drift before mutation",
    "Upload the same immutable bundle to the production Worker service",
    "Verify production provider version and config readback before traffic",
    "Capture current production revision before permit admission",
    "Capture the exact production D1 recovery bookmark before admission",
    "Assemble the signed short-lived permit from automated release evidence",
    "--domain-hostname \"\$RELEASE_PRODUCTION_DOMAIN_HOSTNAME\"",
    "--domain-service \"\$RELEASE_PRODUCTION_DOMAIN_SERVICE\"",
    "--domain-zone-id \"\$RELEASE_PRODUCTION_ZONE_ID\"",
    "Consume the permit once through the durable D1 replay and policy boundary",
    "Auto-merge the exact admitted PR and verify the resulting main tree",
    "Apply admitted migrations only after exact source admission",
    "Promote the pre-verified immutable production version",
    "Deploy the production custom-domain route after immutable promotion",
    "Read back the production Workers domain binding",
    "Verify production identity, health, readiness, and authenticated smoke",
    "Bind production active revision, readiness, and exact smoke to immutable receipt",
    "Advance the durable generation only after production proof",
  ]);
  assert.match(
    production,
    /assemble[\s\S]*--artifact-manifest[\s\S]*--production-previous-readback[\s\S]*--permit-private-key/,
  );
  assert.match(production, /assemble[\s\S]*--production-recovery/);
  assert.match(
    production,
    /assemble[\s\S]*--frappe-scope "\$RELEASE_FRAPPE_SCOPE"/,
  );
  assert.match(
    production,
    /admit[\s\S]*merge-pr[\s\S]*d1 migrations apply ironwrap-bus[\s\S]*"\$WRANGLER_BIN" versions deploy/,
  );
  // A push-sourced release is already on main, so the merge step reads the same
  // source-merge receipt back instead of merging again. It branches on the
  // admitted, permit-bound context status rather than the live event.
  assert.match(
    production,
    /source_status="\$\(jq -er '\.status \| select\(\. == "open" or \. == "merged"\)' "\$RUNNER_TEMP\/context-download\/pr-context\.json"\)"/,
  );
  assert.match(
    production,
    /admit[\s\S]*merged-source[\s\S]*merge-pr[\s\S]*d1 migrations apply ironwrap-bus/,
  );
  assert.match(production, /npm ci --ignore-scripts --prefix "\$RUNNER_TEMP\/policy-enforcer\/workers-bus"/);
  assert.match(production, /provider-targets[\s\S]*--policy-root "\$RUNNER_TEMP\/policy-enforcer"[\s\S]*--environment production/);
  assert.doesNotMatch(production, /npm ci --ignore-scripts --prefix workers-bus/);
  assert.match(production, /environment-preflight[\s\S]*production-environment-preflight\.json/);
  assert.match(
    production,
    /if \[\[ ! "\$RELEASE_PRODUCTION_ZONE_ID" =~ \^\[0-9a-f\]\{32\}\$ \]\]; then[\s\S]*release_production_invalid_zone_id/,
  );
  assert.match(
    production,
    /assemble[\s\S]*--domain-hostname "\$RELEASE_PRODUCTION_DOMAIN_HOSTNAME"[\s\S]*--domain-service "\$RELEASE_PRODUCTION_DOMAIN_SERVICE"[\s\S]*--domain-zone-id "\$RELEASE_PRODUCTION_ZONE_ID"/,
  );
  assert.match(production, /secrets\.RELEASE_PRODUCTION_CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(production, /secrets\.RELEASE_STAGING_CLOUDFLARE_API_TOKEN|secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(
    production,
    /id: deploy_production_triggers[\s\S]*\"\$WRANGLER_BIN\" triggers deploy --config workers-bus\/wrangler\.jsonc/,
  );
  const productionAdmitMarker = 'node "$RELEASE_ENFORCER" admit \\';
  const productionAdmitIndex = production.indexOf(productionAdmitMarker);
  assert.ok(productionAdmitIndex >= 0, "missing production permit admission command");
  assert.doesNotMatch(
    production.slice(0, productionAdmitIndex),
    /triggers deploy/,
  );
  assert.equal(
    (production.match(/triggers deploy --config workers-bus\/wrangler\.jsonc/g) ?? [])
      .length,
    1,
  );
  assert.match(
    production,
    /triggers deploy --config workers-bus\/wrangler\.jsonc[\s\S]*Read back the production Workers domain binding[\s\S]*https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/\$CLOUDFLARE_ACCOUNT_ID\/workers\/domains/,
  );
  assert.match(
    production,
    /--header "Authorization: Bearer \$CLOUDFLARE_API_TOKEN"[\s\S]*--output "\$response" 2> "\$response_error"[\s\S]*release_production_domain_readback_request_failed/,
  );
  assert.match(
    production,
    /domain-readback[\s\S]*--input "\$response"[\s\S]*--hostname "\$RELEASE_PRODUCTION_DOMAIN_HOSTNAME"[\s\S]*--service "\$RELEASE_PRODUCTION_DOMAIN_SERVICE"[\s\S]*--zone-id "\$RELEASE_PRODUCTION_ZONE_ID"[\s\S]*production-domain-readback\.json/,
  );
  assert.doesNotMatch(staging, /triggers deploy/);
  const productionProof = production.slice(production.indexOf("- name: Publish signed permit and production proof receipt"));
  assert.match(productionProof, /production-domain-readback\.json/);
  assert.doesNotMatch(productionProof, /production-domains\.json|production-domains\.error/);
  assert.match(production, /production-receipt[\s\S]*--frappe-scope "\$RELEASE_FRAPPE_SCOPE"[\s\S]*--merge-receipt/);
  assert.match(production, /production-receipt[\s\S]*--domain-readback "\$RUNNER_TEMP\/production-domain-readback\.json"/);
  assert.match(
    production,
    /production-post-smoke\.json[\s\S]*deployment-revision[\s\S]*production-receipt/,
  );
  assert.match(production, /node "\$RELEASE_ENFORCER" production-receipt/);
  assert.match(
    production,
    /advance[\s\S]*--production-receipt[\s\S]*--merge-receipt/,
  );
  assert.match(
    production,
    /id: rollback_production\n\s+if: \$\{\{ failure\(\) && steps\.merge_source\.outcome == 'success' && steps\.promote_production\.outcome != 'skipped' \}\}[\s\S]*"\$WRANGLER_BIN" rollback/,
  );
  assert.match(
    production,
    /steps\.rollback_production\.outcome == 'failure'[\s\S]*persist-recovery-required[\s\S]*--failure-stage automatic_rollback_incomplete/,
  );
  assert.match(production, /production-rollback-recovery-required-outcome\.json/);
  assert.match(
    production,
    /id: migrate_production[\s\S]*if: \$\{\{ failure\(\) && steps\.merge_source\.outcome == 'success' && steps\.migrate_production\.outcome == 'failure' && steps\.promote_production\.outcome == 'skipped' \}\}[\s\S]*persist-recovery-required[\s\S]*--failure-stage d1_migration_failed/,
  );
  assert.match(
    production,
    /"\$WRANGLER_BIN" rollback[\s\S]*version-snapshot[\s\S]*production-rollback-health[\s\S]*production-rollback-receipt[\s\S]*persist-rollback/,
  );
  assert.equal(
    (production.match(/--frappe-scope "\$RELEASE_FRAPPE_SCOPE"/g) ?? [])
      .length,
    3,
  );
  assert.match(
    production,
    /"\$WRANGLER_BIN" rollback[\s\S]*deployments list[\s\S]*production-rollback-receipt/,
  );
  assert.match(production, /production-previous-version\.json[\s\S]*version-snapshot/);
  assert.equal(
    (production.match(/node "\$RELEASE_ENFORCER" version-snapshot/g) ?? [])
      .length,
    2,
  );
  assert.match(
    production,
    /d1 time-travel info ironwrap-bus[\s\S]*--json[\s\S]*d1-recovery-point/,
  );

  for (const required of [
    "RELEASE_PERMIT_PRIVATE_KEY",
    "RELEASE_PERMIT_PUBLIC_KEY",
    "RELEASE_POLICY_LEDGER_API_TOKEN",
    "RELEASE_STAGING_CLOUDFLARE_API_TOKEN",
    "RELEASE_STAGING_INGEST_TOKEN",
    "RELEASE_STAGING_ADMIN_TOKEN",
    "RELEASE_PRODUCTION_CLOUDFLARE_API_TOKEN",
    "RELEASE_PRODUCTION_INGEST_TOKEN",
    "RELEASE_PRODUCTION_ADMIN_TOKEN",
  ])
    assert.match(workflow, new RegExp(required));
  assert.match(workflow, /release_admission_missing_external_secret/);
  assert.match(workflow, /release_staging_missing_external_secret/);
  assert.match(workflow, /release_production_missing_external_secret/);
  assert.match(workflow, /release-policy:\$\{RELEASE_REPOSITORY\}/);
  assert.doesNotMatch(
    workflow,
    /npm run (?:deploy|db:migrate)|--keep-vars|PRAGMA integrity_check|<<['"]?NODE|node -e/,
  );
  assert.doesNotMatch(staging, /wrangler deploy\s/);
  assert.doesNotMatch(production, /wrangler deploy\s/);
  // The trusted Wrangler loaded from the policy base must be the locked one.
  const workerPackage = JSON.parse(
    readFileSync(new URL("../workers-bus/package.json", import.meta.url), "utf8"),
  );
  assert.match(
    workflow,
    new RegExp(`WORKER_VERSION: ${workerPackage.devDependencies.wrangler.replaceAll(".", "\\.")}\n`),
  );
}

test("release workflow enforces PR admission, build-once staging, and immutable promotion", async () => {
  validateWorkflow(await readFile(workflowUrl, "utf8"));
});

test("workflow validation rejects candidate-policy self-approval and missing PR evidence", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.throws(() =>
    validateWorkflow(
      workflow.replaceAll(
        'node "$RELEASE_ENFORCER"',
        "node tools/release-promotion.mjs",
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace("workflow_run.event == 'pull_request'", "true"),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace("${{ runner.temp }}/admission/pr-context.json\n", ""),
    ),
  );
});

test("workflow validation rejects missing or malformed production zone configuration", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        "RELEASE_PRODUCTION_ZONE_ID: ${{ vars.RELEASE_PRODUCTION_ZONE_ID }}",
        "RELEASE_PRODUCTION_ZONE_ID: ${{ vars.RELEASE_PRODUCTION_ZONE_ID_MISSING }}",
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        'if [[ ! "$RELEASE_PRODUCTION_ZONE_ID" =~ ^[0-9a-f]{32}$ ]]; then',
        'if [[ ! "$RELEASE_PRODUCTION_ZONE_ID" =~ ^[0-9a-f]{31}$ ]]; then',
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        'echo "release_production_invalid_zone_id"',
        'echo "release_production_zone_defaulted"',
      ),
    ),
  );
});

test("workflow validation rejects a production trigger inserted before permit admission", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const admissionStep = "      - name: Consume the permit once through the durable D1 replay and policy boundary\n";
  const preAdmissionTrigger =
    '      - name: Invalid pre-admission production trigger\n' +
    '        run: \'"$WRANGLER_BIN" triggers deploy --config workers-bus/wrangler.jsonc\'\n\n';
  const mutatedWorkflow = workflow.replace(
    admissionStep,
    `${preAdmissionTrigger}${admissionStep}`,
  );
  assert.notEqual(mutatedWorkflow, workflow);
  assert.throws(() => validateWorkflow(mutatedWorkflow));
});

test("workflow validation rejects omitted component artifacts and source admission gates", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.throws(() =>
    validateWorkflow(workflow.replace("--frappe-wheel", "--unbound-wheel")),
  );
  assert.throws(() =>
    validateWorkflow(workflow.replace("merge-pr", "merge-without-permit")),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        '      - name: Assemble the signed short-lived permit from automated release evidence\n',
        '      - name: Wait for an independent reviewer GO receipt\n' +
          '        run: node "$RELEASE_ENFORCER" review-wait --attempts 40\n\n' +
          '      - name: Assemble the signed short-lived permit from automated release evidence\n',
      ),
    ),
  );
});

test("workflow rejects candidate toolchain and cross-environment provider credentials", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        'npm ci --ignore-scripts --prefix "$RUNNER_TEMP/policy-enforcer/workers-bus"',
        "npm ci --ignore-scripts --prefix workers-bus",
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replaceAll(
        "secrets.RELEASE_STAGING_CLOUDFLARE_API_TOKEN",
        "secrets.RELEASE_PRODUCTION_CLOUDFLARE_API_TOKEN",
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(workflow.replace("provider-targets", "unchecked-targets")),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replaceAll("environment-preflight", "unchecked-environment"),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        "RELEASE_FRAPPE_SCOPE: out-of-scope",
        "RELEASE_FRAPPE_SCOPE: in-scope",
      ),
    ),
  );
});

test("workflow validation rejects an unpinned or unverified push-sourced admission", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  // Dropping the branch pin would admit any push-triggered CI success, not only
  // the run that validated main.
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        "github.event.workflow_run.head_branch == 'main'",
        "github.event.workflow_run.head_branch != ''",
      ),
    ),
  );
  // Dropping the fork pin would let a fork-owned head repository through.
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        "github.event.workflow_run.head_repository.full_name == github.repository",
        "github.event.workflow_run.head_repository.full_name != ''",
      ),
    ),
  );
  // Deploy must stay behind CI: a direct push trigger would promote unvalidated code.
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        "  workflow_run:\n    workflows: [CI]",
        "  push:\n    branches: [main]\n  workflow_run:\n    workflows: [CI]",
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        '"$RELEASE_ENFORCER" push-context',
        '"$RELEASE_ENFORCER" unbound-context',
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        '--head-commit "$RELEASE_SOURCE_COMMIT" --base-commit "$RELEASE_BASE_COMMIT"',
        '--head-commit "$RELEASE_SOURCE_COMMIT"',
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace("release_admission_push_not_linear", "release_admission_push_assumed_linear"),
    ),
  );
  assert.throws(() =>
    validateWorkflow(workflow.replace("merged-source", "merge-skipped")),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        `'.status | select(. == "open" or . == "merged")'`,
        "'.status'",
      ),
    ),
  );
});

test("workflow validation rejects missing durable success or rollback outcomes", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        'node "$RELEASE_ENFORCER" production-receipt',
        'node "$RELEASE_ENFORCER" production-proof-omitted',
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace("persist-rollback", "rollback-artifact-only"),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        "persist-recovery-required",
        "recovery-required-artifact-only",
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        '"$WRANGLER_BIN" rollback',
        '"$WRANGLER_BIN" omit-rollback',
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace("version-snapshot", "version-id-only"),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace("policy-genesis", "policy-read-without-genesis"),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        "steps.promote_production.outcome != 'skipped' }}",
        "steps.promote_production.outcome == 'success' }}",
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        "steps.deploy_staging.outcome != 'skipped'",
        "steps.deploy_staging.outcome == 'success'",
      ),
    ),
  );
});
