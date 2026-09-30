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
  const qa = section(workflow, "qa");

  // Only the post-merge push run pinned to main is admissible. A pull_request
  // CI success (including a Dependabot PR) must never release or merge. The
  // push event stays paired with the branch pin and behind the head_repository
  // pin, so a fork's CI (including a fork whose own default branch is named
  // main) is never admitted.
  assert.doesNotMatch(workflow, /event == 'pull_request'|workflow_run\.pull_requests\[/);
  assert.match(admission, /workflow_run\.conclusion == 'success'/);
  assert.match(
    admission,
    /workflow_run\.event == 'push' &&\n\s+github\.event\.workflow_run\.head_branch == 'main'/,
  );
  assert.match(
    admission,
    /workflow_run\.head_repository\.full_name == github\.repository/,
  );
  // The release never merges, so no token it holds can write contents or PRs.
  assert.match(workflow, /^permissions:\n\s+contents: read\n\s+actions: read\n/m);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write/);
  assert.match(workflow, /group: deploy-qa/);
  assert.match(workflow, /cancel-in-progress: false/);
  for (const job of [admission, build, qa]) {
    assert.match(job, /permissions:\n\s+actions: read\n\s+contents: read/);
  }
  assert.equal(
    (workflow.match(/persist-credentials: false/g) ?? []).length,
    3,
  );
  assert.doesNotMatch(
    workflow,
    /environment:\s*production|required_reviewers|RELEASE_REVIEW_RECEIPT/,
  );
  // A push to main deploys qa only; production is a separate tag-triggered
  // release (IRO-264). No push-path job may reference a production secret,
  // variable, or D1 id.
  assert.doesNotMatch(workflow, /RELEASE_PRODUCTION_|f0674848-13df-4422-9896-8ba2719663b8/);
  // Only the completed-CI workflow_run on main reaches admission; the branches
  // filter only narrows workflow_run noise and never becomes a push trigger of
  // its own, so unvalidated code still cannot reach the pipeline directly.
  assert.match(
    workflow,
    /workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]\n\s+branches: \[main\]/,
  );
  assert.doesNotMatch(workflow, /^ {2}push:/m);
  // Exactly three jobs run per push: admission, build, and qa. Production is
  // a separate tag-triggered workflow (IRO-264).
  assert.deepEqual(
    [...workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(/^  ([A-Za-z0-9_-]+):/gm)].map((match) => match[1]),
    ["admission", "build", "qa"],
  );

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
    /push-context[\s\S]*source-evidence[\s\S]*ci-checks[\s\S]*admission-context/,
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
  assert.match(workflow, /RELEASE_RULESET_ID: 20652124/);
  // The generation-N policy ledger left the push path entirely: there is no
  // permit to make single-use in a qa-only release.
  assert.doesNotMatch(workflow, /policy-genesis|RELEASE_POLICY_LEDGER_API_TOKEN|release-policy:/);
  // The pre-merge pr-context admission must not come back.
  assert.doesNotMatch(workflow, /node "\$RELEASE_ENFORCER" pr-context/);
  // Admission derives generation N from the squash commit's single
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
    2,
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

  ordered(qa, [
    "provider-targets",
    "Require isolated smoke inputs before any qa mutation",
    "Verify isolated qa secret-name inventory before mutation",
    "Fail closed on static qa readiness drift before mutation",
    "Apply expand/contract migrations to isolated qa",
    "Capture the current isolated qa revision",
    "Upload the same immutable bundle to isolated qa",
    "Verify isolated qa provider version readback",
    "Deploy candidate to isolated qa traffic",
    "Verify qa active revision, health, and owned-core readiness",
    "Deploy the qa Worker triggers after traffic cutover",
    "Read back the qa Worker cron schedules",
    "Run authenticated affected-workflow smoke receipt",
    "Re-read and bind the post-smoke staged revision",
    "Export and restore qa data into a separate local drill target",
    "Roll back qa candidate and prove the previous revision against migrated data",
  ]);
  assert.match(qa, /environment: qa\n/);
  assert.match(qa, /cron-readback/);
  assert.match(
    qa,
    /"\$WRANGLER_BIN" versions upload[\s\S]*--env qa[\s\S]*--no-bundle[\s\S]*--strict/,
  );
  assert.match(qa, /"\$WRANGLER_BIN" secret list[\s\S]*secret-readback/);
  assert.match(qa, /npm ci --ignore-scripts --prefix "\$RUNNER_TEMP\/policy-enforcer\/workers-bus"/);
  assert.match(qa, /provider-targets[\s\S]*--policy-root "\$RUNNER_TEMP\/policy-enforcer"[\s\S]*--environment qa/);
  assert.doesNotMatch(qa, /npm ci --ignore-scripts --prefix workers-bus/);
  assert.match(qa, /secrets\.RELEASE_QA_CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(qa, /secrets\.RELEASE_PRODUCTION_CLOUDFLARE_API_TOKEN|secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(qa, /version-readback/);
  assert.match(qa, /environment-preflight[\s\S]*qa-environment-preflight\.json/);
  assert.match(
    qa,
    /d1 export[\s\S]*> "\$export_log" 2>&1[\s\S]*restore-local[\s\S]*--database "\$source_database"[\s\S]*restore-local[\s\S]*--database "\$restored_database"[\s\S]*restore-readback[\s\S]*--source-target "\$source_database"[\s\S]*--restored-target "\$restored_database"[\s\S]*backup-receipt/,
  );
  assert.match(qa, /source_database="\$RUNNER_TEMP\/qa-restore-source-\$\{GITHUB_RUN_ID\}\.sqlite"/);
  assert.match(qa, /restored_database="\$RUNNER_TEMP\/qa-restore-restored-\$\{GITHUB_RUN_ID\}\.sqlite"/);
  assert.match(
    qa,
    /test ! -e "\$source_database"[\s\S]*test ! -e "\$restored_database"/,
  );
  assert.match(
    qa,
    /if ! "\$WRANGLER_BIN" d1 export[\s\S]*echo "release_qa_export_failed" >&2/,
  );
  assert.doesNotMatch(qa, /restore-query|--persist-to|d1 execute/);
  const qaProof = qa.slice(qa.indexOf("- name: Publish redacted qa proof"));
  assert.doesNotMatch(qaProof, /qa\.sql|qa-export\.log/);
  assert.match(qa, /rollback-receipt/);
  assert.match(
    qa,
    /id: deploy_qa[\s\S]*if: \$\{\{ failure\(\) && steps\.deploy_qa\.outcome != 'skipped' \}\}[\s\S]*versions deploy[\s\S]*--version-id "\$previous"[\s\S]*deployments list[\s\S]*qa-cleanup-receipt/,
  );
  assert.match(
    qa,
    /qa-cleanup-receipt[\s\S]*--previous "\$previous" --candidate "\$candidate"[\s\S]*--command-result "\$command_result"/,
  );
  assert.equal(
    (qa.match(/triggers deploy --config workers-bus\/wrangler\.jsonc --env qa/g) ?? [])
      .length,
    1,
  );
  assert.equal(
    (workflow.match(/triggers deploy --config workers-bus\/wrangler\.jsonc --env qa/g) ?? [])
      .length,
    1,
  );

  for (const required of [
    "RELEASE_QA_CLOUDFLARE_API_TOKEN",
    "RELEASE_QA_INGEST_TOKEN",
    "RELEASE_QA_ADMIN_TOKEN",
  ])
    assert.match(workflow, new RegExp(required));
  assert.match(workflow, /release_qa_missing_external_secret/);
  assert.doesNotMatch(
    workflow,
    /npm run (?:deploy|db:migrate)|--keep-vars|PRAGMA integrity_check|<<['"]?NODE|node -e/,
  );
  assert.doesNotMatch(qa, /wrangler deploy\s/);
  // The trusted Wrangler loaded from the policy base must be the locked one.
  const workerPackage = JSON.parse(
    readFileSync(new URL("../workers-bus/package.json", import.meta.url), "utf8"),
  );
  assert.match(
    workflow,
    new RegExp(`WORKER_VERSION: ${workerPackage.devDependencies.wrangler.replaceAll(".", "\\.")}\n`),
  );
}

test("release workflow enforces push-only admission and deploys build-once qa only", async () => {
  validateWorkflow(await readFile(workflowUrl, "utf8"));
});

test("workflow validation rejects candidate-policy self-approval and pre-merge admission", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.throws(() =>
    validateWorkflow(
      workflow.replaceAll(
        'node "$RELEASE_ENFORCER"',
        "node tools/release-promotion.mjs",
      ),
    ),
  );
  // Re-admitting pull_request CI runs would release and merge any open PR
  // whose CI passed, including Dependabot PRs.
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        "github.event.workflow_run.event == 'push' &&",
        "(github.event.workflow_run.event == 'push' || github.event.workflow_run.event == 'pull_request') &&",
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        "github.event.workflow_run.conclusion == 'success'",
        "github.event.workflow_run.conclusion != ''",
      ),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace("  contents: read\n  actions: read\n", "  contents: write\n  actions: read\n  pull-requests: write\n"),
    ),
  );
  assert.throws(() =>
    validateWorkflow(
      workflow.replace("${{ runner.temp }}/admission/pr-context.json\n", ""),
    ),
  );
});

test("workflow validation rejects omitted component artifacts", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.throws(() =>
    validateWorkflow(workflow.replace("--frappe-wheel", "--unbound-wheel")),
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
  // Substituting the qa job's Cloudflare credential with the production one
  // would also reintroduce a production secret into the push path.
  assert.throws(() =>
    validateWorkflow(
      workflow.replaceAll(
        "secrets.RELEASE_QA_CLOUDFLARE_API_TOKEN",
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
});

test("workflow validation rejects a cleanup drill that skips its own failure guard", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.throws(() =>
    validateWorkflow(
      workflow.replace(
        "steps.deploy_qa.outcome != 'skipped'",
        "steps.deploy_qa.outcome == 'success'",
      ),
    ),
  );
});
