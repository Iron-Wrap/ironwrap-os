import assert from "node:assert/strict";
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
  assert.match(admission, /workflow_run\.event == 'pull_request'/);
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
  assert.doesNotMatch(workflow, /branches:\s*\[main\]|head_branch == 'main'/);

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
    /pr-context[\s\S]*source-evidence[\s\S]*ci-checks[\s\S]*issuer-request[\s\S]*review-wait[\s\S]*policy-genesis[\s\S]*admission-context/,
  );
  assert.match(admission, /id: publish_review_candidate[\s\S]*--artifact-digest "\$\{\{ steps\.publish_review_candidate\.outputs\.artifact-digest \}\}"/);
  assert.match(admission, /review-wait[\s\S]*--issuer-ack "\$RUNNER_TEMP\/review-issuer-ack\.json"/);
  assert.match(admission, /--repo-root "\$RUNNER_TEMP\/policy-enforcer"/);
  assert.match(workflow, /RELEASE_RULESET_ID: 20652124/);
  assert.match(admission, /pr-context[\s\S]*--ruleset-id "\$RELEASE_RULESET_ID"/);
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
    /d1 export[\s\S]*restore-query[\s\S]*d1 execute[\s\S]*--json[\s\S]*restore-readback/,
  );
  assert.match(staging, /restore_persist="\$RUNNER_TEMP\/ironwrap-d1-restore-/);
  assert.match(staging, /--persist-to "\$restore_persist"/);
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
    "Require production provider, smoke, and permit inputs",
    "Verify production secret-name inventory before immutable promotion",
    "Fail closed on static production readiness drift before mutation",
    "Upload the same immutable bundle to the production Worker service",
    "Verify production provider version and config readback before traffic",
    "Capture current production revision before permit admission",
    "Capture the exact production D1 recovery bookmark before admission",
    "Publish exact staged candidate evidence for the independent evidence issuer",
    "Trigger the independently permissioned full-surface evidence issuer",
    "Bounded wait for signed full-surface release evidence",
    "Assemble the signed short-lived permit from independent evidence",
    "Consume the permit once through the durable D1 replay and policy boundary",
    "Auto-merge the exact admitted PR and verify the resulting main tree",
    "Apply admitted migrations only after exact source admission",
    "Promote the prepared Frappe artifact through the authenticated adapter",
    "Promote the pre-verified immutable production version",
    "Verify production identity, health, readiness, and authenticated smoke",
    "Re-read the Frappe provider identity after production smoke",
    "Bind production active revision, readiness, and exact smoke to immutable receipt",
    "Advance the durable generation only after production proof",
  ]);
  assert.match(
    production,
    /release-evidence-wait[\s\S]*--attempts 80 --interval-ms 15000/,
  );
  assert.match(production, /id: publish_release_candidate[\s\S]*issuer-request[\s\S]*--artifact-digest "\$\{\{ steps\.publish_release_candidate\.outputs\.artifact-digest \}\}"/);
  assert.match(production, /release-evidence-wait[\s\S]*--issuer-ack "\$RUNNER_TEMP\/release-evidence-issuer-ack\.json"/);
  assert.match(
    production,
    /assemble[\s\S]*--artifact-manifest[\s\S]*--release-evidence/,
  );
  assert.match(production, /assemble[\s\S]*--production-recovery/);
  assert.match(
    production,
    /admit[\s\S]*merge-pr[\s\S]*d1 migrations apply ironwrap-bus[\s\S]*"\$WRANGLER_BIN" versions deploy/,
  );
  assert.match(production, /npm ci --ignore-scripts --prefix "\$RUNNER_TEMP\/policy-enforcer\/workers-bus"/);
  assert.match(production, /provider-targets[\s\S]*--policy-root "\$RUNNER_TEMP\/policy-enforcer"[\s\S]*--environment production/);
  assert.doesNotMatch(production, /npm ci --ignore-scripts --prefix workers-bus/);
  assert.match(production, /environment-preflight[\s\S]*production-environment-preflight\.json/);
  assert.match(production, /secrets\.RELEASE_PRODUCTION_CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(production, /secrets\.RELEASE_STAGING_CLOUDFLARE_API_TOKEN|secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(
    production,
    /service-adapter[\s\S]*--operation promote[\s\S]*--operation readback[\s\S]*production-receipt[\s\S]*--service-promotion-receipt[\s\S]*--service-readback-receipt/,
  );
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
    /if: \$\{\{ failure\(\) && steps\.merge_source\.outcome == 'success' && steps\.promote_frappe\.outcome != 'skipped' \}\}/,
  );
  assert.match(
    production,
    /id: migrate_production[\s\S]*if: \$\{\{ failure\(\) && steps\.merge_source\.outcome == 'success' && steps\.migrate_production\.outcome == 'failure' && steps\.promote_frappe\.outcome == 'skipped' && steps\.promote_production\.outcome == 'skipped' \}\}[\s\S]*persist-recovery-required[\s\S]*--failure-stage d1_migration_failed/,
  );
  assert.match(
    production,
    /"\$WRANGLER_BIN" rollback[\s\S]*--operation rollback[\s\S]*version-snapshot[\s\S]*production-rollback-health[\s\S]*production-rollback-receipt[\s\S]*persist-rollback/,
  );
  assert.match(
    production,
    /steps\.promote_production\.outcome \}\}" != "skipped"[\s\S]*"\$WRANGLER_BIN" rollback[\s\S]*deployments list[\s\S]*production-rollback-receipt/,
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
    "RELEASE_REVIEW_PUBLIC_KEY",
    "RELEASE_PERMIT_PRIVATE_KEY",
    "RELEASE_PERMIT_PUBLIC_KEY",
    "RELEASE_POLICY_LEDGER_API_TOKEN",
    "RELEASE_STAGING_CLOUDFLARE_API_TOKEN",
    "RELEASE_PRODUCTION_CLOUDFLARE_API_TOKEN",
    "RELEASE_INDEPENDENT_ISSUER_URL",
    "RELEASE_INDEPENDENT_ISSUER_TOKEN",
    "RELEASE_STAGING_FRAPPE_API_SECRET",
    "RELEASE_PRODUCTION_FRAPPE_API_SECRET",
    "RELEASE_SERVICE_ADAPTER_URL",
    "RELEASE_SERVICE_ADAPTER_TOKEN",
    "RELEASE_SERVICE_ADAPTER_PUBLIC_KEY",
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
  assert.match(workflow, /WORKER_VERSION: 4\.123\.0/);
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
      workflow.replace("release-evidence-wait", "release-evidence-omitted"),
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
    validateWorkflow(workflow.replace("issuer-request", "issuer-trigger-omitted")),
  );
  assert.throws(() =>
    validateWorkflow(workflow.replace("--issuer-ack", "--unbound-issuer-ack")),
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
      workflow.replace("--operation readback", "--operation unchecked"),
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
        'steps.promote_production.outcome }}" != "skipped"',
        'steps.promote_production.outcome }}" == "success"',
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
