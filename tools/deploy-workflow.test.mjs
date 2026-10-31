import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/deploy.yml", import.meta.url);
const productionWorkflowUrl = new URL(
  "../.github/workflows/deploy-production.yml",
  import.meta.url,
);
const releasePleaseWorkflowUrl = new URL(
  "../.github/workflows/release-please.yml",
  import.meta.url,
);

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
  // It does read them: push-context resolves the squash commit's PR association
  // through GET /repos/{repo}/commits/{sha}/pulls, which a private repository
  // refuses without `pull-requests: read` (IRO-264).
  assert.match(
    workflow,
    /^permissions:\n\s+contents: read\n\s+actions: read\n\s+pull-requests: read\n/m,
  );
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write/);
  assert.match(workflow, /group: deploy-qa/);
  assert.match(workflow, /cancel-in-progress: false/);
  for (const job of [admission, build, qa]) {
    assert.match(job, /permissions:\n\s+actions: read\n\s+contents: read/);
  }
  // Only admission calls that endpoint, so only admission reads pull requests.
  assert.match(
    admission,
    /permissions:\n\s+actions: read\n\s+contents: read\n(?:\s+#[^\n]*\n)*\s+pull-requests: read/,
  );
  for (const job of [build, qa]) assert.doesNotMatch(job, /pull-requests: read/);
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
  assert.doesNotMatch(workflow, /RELEASE_PRODUCTION_|a8fd0116-7af6-4788-98bd-083addbe58bc/);
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
  // IRO-264 R2(a): actions/upload-artifact roots the archive at the least common
  // ancestor of its search paths. context.json, pr-context.json and
  // artifact-components.json must be staged into ONE directory and that directory
  // uploaded whole, so the archive root is unambiguous and the qa job's flat
  // context-download/context.json reads stay correct.
  const builtContextUpload = build.slice(
    build.indexOf("name: iro41-built-context-"),
  );
  assert.match(builtContextUpload, /path: \$\{\{ runner\.temp \}\}\/built-context\n/);
  assert.equal((builtContextUpload.match(/^\s+path:/gm) ?? []).length, 1);
  assert.doesNotMatch(builtContextUpload, /admission\/context\.json|admission\/pr-context\.json/);
  assert.match(build, /mkdir -p "\$RUNNER_TEMP\/built-context"/);

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
  // IRO-264 R2(b): the qa job must hash the artifact tar it actually downloaded
  // (artifact-download/ironwrap-release-artifact.tar), never the build job's own
  // local path of the same basename, which does not exist in this job.
  assert.match(
    qa,
    /sha256sum "\$RUNNER_TEMP\/artifact-download\/ironwrap-release-artifact\.tar"/,
  );
  assert.doesNotMatch(qa, /sha256sum "\$RUNNER_TEMP\/ironwrap-release-artifact\.tar"/);
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
  const drillStart = qa.indexOf("      - name: Export and restore qa data into a separate local drill target");
  const drill = qa.slice(drillStart, qa.indexOf("\n      - name:", drillStart + 1));
  assert.match(drill, /ADMIN_TOKEN: \$\{\{ secrets\.RELEASE_QA_ADMIN_TOKEN \}\}/);
  assert.match(drill, /--header "Authorization: Bearer \$ADMIN_TOKEN" "\$RELEASE_QA_BASE_URL\/admin\/status"/);
  ordered(drill, [
    "set -euo pipefail", "drain_deadline=", "release_qa_queue_drained pending=0 open_dead_letters=0",
    "export_log=", "release_qa_export_starting", '"$WRANGLER_BIN" d1 export',
  ]);
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
  assert.doesNotMatch(qaProof, /qa\.sql|qa-export\.log|qa-drain-status\.json/);
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
  // Wrangler refuses `triggers deploy` while assets.directory is missing, and the qa job
  // never builds app/dist: it links the verified artifact's PWA first.
  assert.match(
    qa,
    /ln -sfn "\$RUNNER_TEMP\/app\/dist" app\/dist\n\s+"\$WRANGLER_BIN" triggers deploy --config workers-bus\/wrangler\.jsonc --env qa/,
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
      workflow.replace(
        'cp "$RUNNER_TEMP/admission/pr-context.json" "$RUNNER_TEMP/built-context/pr-context.json"\n',
        "",
      ),
    ),
  );
});

test("workflow validation rejects omitted component artifacts", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.throws(() =>
    validateWorkflow(workflow.replace("--frappe-wheel", "--unbound-wheel")),
  );
});

test("workflow rejects a drill without its scoped token or drain-before-export guard", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const start = workflow.indexOf("      - name: Export and restore qa data into a separate local drill target");
  const before = workflow.slice(0, start);
  const drillAndAfter = workflow.slice(start);
  assert.throws(() => validateWorkflow(before + drillAndAfter.replace(
    "          ADMIN_TOKEN: ${{ secrets.RELEASE_QA_ADMIN_TOKEN }}\n", "",
  )));
  assert.throws(() => validateWorkflow(before + drillAndAfter.replace(
    '          echo "release_qa_export_starting"\n',
    '          echo "release_qa_export_starting"\n          echo "release_qa_queue_drained pending=0 open_dead_letters=0"\n',
  ).replace('                echo "release_qa_queue_drained pending=0 open_dead_letters=0"\n', "")));
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

// ---------------------------------------------------------------------------
// The tag-triggered production release (IRO-264).
//
// `deploy.yml` deploys and proves qa from a push to main. Production is promoted
// from a release tag by `deploy-production.yml`, which BUILDS NOTHING: it consumes
// the bytes the Deploy run of that exact commit already proved, re-verifies their
// digest, and mutates production only behind the signed permit and the durable
// policy ledger. This function is the contract for that, and the negative tests
// below are what stop it being relaxed one line at a time.

function validateProductionWorkflow(workflow) {
  // Wrangler refuses `triggers deploy` while assets.directory is missing; production builds
  // nothing, so it links the verified artifact's PWA first.
  assert.match(
    workflow,
    /ln -sfn "\$RUNNER_TEMP\/release-artifact\/app\/dist" app\/dist\n\s+"\$WRANGLER_BIN" triggers deploy --config workers-bus\/wrangler\.jsonc\n/,
  );
  const production = section(workflow, "production");

  // --- the trigger -------------------------------------------------------
  // Only a dispatch, which iron-wrap-infra's promote-production.yml sends after a
  // promotion PR merges. Never a tag push (a tag alone would bypass the
  // declaration), never a branch push (that is qa's job and would promote every
  // commit) and never a workflow_run (which would promote whatever Deploy
  // happened to finish).
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n {4}inputs:\n/m);
  assert.doesNotMatch(workflow, /^ {2}push:/m);
  assert.doesNotMatch(workflow, /^ {2,4}tags:/m);
  assert.doesNotMatch(workflow, /^ {2,4}branches:/m);
  assert.doesNotMatch(workflow, /workflow_run/);
  // The dispatch has to name a tag and the declaration commit, and the job still
  // has to check the tag.
  assert.match(workflow, /inputs:\n\s+tag:\n(?:\s+[a-z-]+:.*\n)*\s+required: true/);
  assert.match(workflow, /\n {6}declaration_sha:\n(?: {8}[a-z-]+:.*\n)* {8}required: true/);
  assert.match(production, /github\.ref_type.*!= "tag"|REF_TYPE" != "tag"/);
  assert.match(production, /release_production_ref_not_a_tag/);
  assert.match(production, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(production, /release_production_tag_format_invalid/);
  assert.match(production, /if \[\[ "\$DISPATCH_TAG" != "\$REF_NAME" \]\]; then\n\s+echo "release_production_dispatch_tag_mismatch"/);

  // --- the declaration ---------------------------------------------------
  // The gate is the merged promotion PR in iron-wrap-infra. Before anything is
  // checked out, the declaration at declaration_sha and the one on main must
  // both name this tag, and declaration_sha must be an ancestor of main.
  assert.match(workflow, /RELEASE_DECLARATION_REPOSITORY: Iron-Wrap\/iron-wrap-infra\n/);
  assert.match(workflow, /RELEASE_DECLARATION_PATH: environments\/production\/stand\.yml\n/);
  const declaration = production.slice(
    production.indexOf("- name: Require the production declaration to name this tag"),
    production.indexOf("- uses: actions/checkout@"),
  );
  assert.ok(declaration.length > 0, "the declaration check runs before the checkout");
  assert.match(declaration, /GH_TOKEN: \$\{\{ secrets\.RELEASE_DECLARATION_READ_TOKEN \}\}\n/);
  assert.match(declaration, /DECLARATION_SHA: \$\{\{ inputs\.declaration_sha \}\}\n/);
  assert.match(declaration, /release_production_declaration_mismatch:/);
  assert.match(declaration, /test -n "\$GH_TOKEN" \|\| mismatch token_missing/);
  assert.match(declaration, /\[\[ "\$DECLARATION_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\] \|\| mismatch sha_invalid/);
  assert.match(declaration, /\.components\["ironwrap-os"\]\.policy[\s\S]*== "pin"/);
  assert.match(declaration, /declared="\$\(declared_ref "\$DECLARATION_SHA"\)"\n\s+\[\[ "\$declared" == "\$REF_NAME" \]\] \|\| mismatch/);
  assert.match(declaration, /compare\/\$DECLARATION_SHA\.\.\.main/);
  assert.match(declaration, /\[\[ "\$status" == "ahead" \|\| "\$status" == "identical" \]\] \|\| mismatch/);
  assert.match(declaration, /current="\$\(declared_ref main\)"\n\s+\[\[ "\$current" == "\$REF_NAME" \]\] \|\| mismatch "superseded/);
  ordered(production, [
    "- name: Require a release tag",
    "- name: Require the production declaration to name this tag",
    "- uses: actions/checkout@",
  ]);

  // --- the boundary ------------------------------------------------------
  assert.match(production, /environment: production\n/);
  assert.match(
    workflow,
    /^concurrency:\n\s+group: deploy-production\n\s+cancel-in-progress: false\n/m,
  );
  // Promotion reads; it never writes contents or pull requests.
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write/);
  assert.match(production, /permissions:\n\s+actions: read\n\s+contents: read\n\s+pull-requests: read/);
  assert.match(production, /timeout-minutes: 60/);

  // --- the enforcer is always the predecessor's ---------------------------
  // Every enforcement call runs from the base (generation N) tree. If the
  // candidate tree could supply the enforcer, a release could approve itself.
  assert.match(production, /node "\$RELEASE_ENFORCER"/);
  assert.doesNotMatch(production, /node tools\/release-promotion\.mjs/);
  assert.match(
    production,
    /git worktree add --detach "\$RUNNER_TEMP\/policy-enforcer" "\$base_commit"/,
  );
  assert.match(
    production,
    /lineage="\$\(git rev-list --parents --max-count=1 "\$RELEASE_SOURCE_COMMIT"\)"[\s\S]*-ne 2[\s\S]*release_admission_push_not_linear/,
  );
  // The Wrangler that touches production comes from the trusted base tree, and its
  // version is pinned; `npm ci --prefix workers-bus` would install the candidate's.
  assert.match(
    production,
    /npm ci --ignore-scripts --prefix "\$RUNNER_TEMP\/policy-enforcer\/workers-bus"/,
  );
  assert.doesNotMatch(production, /npm ci --ignore-scripts --prefix workers-bus/);
  assert.match(
    production,
    /trusted_wrangler="\$RUNNER_TEMP\/policy-enforcer\/workers-bus\/node_modules\/\.bin\/wrangler"/,
  );
  assert.match(production, /test "\$\("\$trusted_wrangler" --version\)" = "\$WORKER_VERSION"/);
  // launch-proof is likewise the base tree's, and it runs in release-smoke mode so
  // the production proof sends no customer mail and enqueues no bridge work.
  assert.match(
    production,
    /node "\$\(dirname "\$RELEASE_ENFORCER"\)\/launch-proof\.mjs" --execute --release-smoke/,
  );
  assert.doesNotMatch(production, /node tools\/launch-proof\.mjs/);

  // --- the source policy -------------------------------------------------
  // main may legitimately have moved past the tagged commit, so both source
  // readbacks use reachability rather than tip equality. Dropping the flag would
  // make every release after the newest commit fail closed.
  assert.match(production, /push-context \\\n\s+--source-policy reachable/);
  assert.match(production, /merged-source \\\n\s+--source-policy reachable/);
  assert.equal((production.match(/--source-policy reachable/g) ?? []).length, 2);

  // --- the proof it promotes ---------------------------------------------
  // Both artifacts come from the Deploy run of this exact commit, which needs the
  // cross-run id and a token; without either, download-artifact silently looks in
  // the wrong run.
  const downloads = [...production.matchAll(/- uses: actions\/download-artifact@[\s\S]*?(?=\n      - |\n$)/g)]
    .map((match) => match[0]);
  assert.equal(downloads.length, 2, "both qa artifacts are downloaded");
  for (const download of downloads) {
    assert.match(download, /run-id: \$\{\{ env\.RELEASE_QA_RUN_ID \}\}/);
    assert.match(download, /github-token: \$\{\{ github\.token \}\}/);
  }
  assert.match(production, /name: iro41-release-artifact-\$\{\{ github\.sha \}\}/);
  assert.match(production, /name: iro41-qa-proof-\$\{\{ github\.sha \}\}/);
  assert.match(production, /release_production_missing_ci_run/);
  assert.match(production, /release_production_missing_qa_run/);
  // The proof must be THIS tag's, and the bytes must be the digest it recorded.
  assert.match(production, /release_production_qa_proof_foreign/);
  assert.match(production, /test "\$actual" = "\$expected"/);

  // --- order: nothing secret-bearing before admission --------------------
  ordered(production, [
    "Require a release tag",
    "Load generation N policy enforcement and trusted Wrangler",
    "Locate the CI and Deploy runs of the tagged commit",
    "Require the qa proof to belong to this tag",
    "push-context",
    "source-evidence",
    "ci-checks",
    "policy-genesis",
    "admission-context",
    "artifact-manifest",
    "bind-artifact",
    "Require production provider and smoke inputs",
    "provider-targets",
    "secret-readback",
    "environment-preflight",
    "versions upload",
    "version-readback",
    "d1-recovery-point",
    "assemble",
    '"$RELEASE_ENFORCER" admit',
    "merged-source",
    "migrate_production",
    "promote_production",
    "deploy_production_triggers",
    "domain-readback",
    "cron-readback",
    "production-receipt",
    "advance",
  ]);
  // The specific inversions that would matter most, asserted as index order so a
  // reordering cannot pass by accident.
  assert.ok(
    production.indexOf("admission-context") < production.indexOf('"$WRANGLER_BIN" secret list'),
    "admission must precede the first secret-bearing Wrangler call",
  );
  assert.ok(
    production.indexOf('node "$RELEASE_ENFORCER" admit') < production.indexOf("id: migrate_production"),
    "the permit must be admitted before any migration",
  );
  assert.ok(
    production.indexOf('node "$RELEASE_ENFORCER" admit') < production.indexOf("id: promote_production"),
    "the permit must be admitted before promotion",
  );
  assert.ok(
    production.indexOf("id: merge_source") < production.indexOf("id: migrate_production"),
    "the merged-source readback must precede any migration",
  );

  // --- promotion is immutable -------------------------------------------
  // `wrangler deploy` would build and publish from the candidate tree; only an
  // already-uploaded, already-read-back version id may take traffic.
  // `deployments list` is a read and must keep matching; `deploy` as a verb must not.
  assert.doesNotMatch(production, /wrangler deploy\s|\$WRANGLER_BIN" deploy\s/);
  assert.match(production, /"\$WRANGLER_BIN" versions upload/);
  assert.match(production, /"\$WRANGLER_BIN" versions deploy --config workers-bus\/wrangler\.jsonc --version-id/);
  assert.doesNotMatch(production, /--keep-vars|node -e|<<['"]?[A-Z]{2,}/);

  // --- the failure paths -------------------------------------------------
  assert.match(
    production,
    /if: \$\{\{ failure\(\) && steps\.merge_source\.outcome == 'success' && steps\.promote_production\.outcome != 'skipped' \}\}/,
  );
  assert.match(production, /production-rollback-receipt[\s\S]*persist-rollback/);
  assert.match(production, /persist-recovery-required[\s\S]*--failure-stage automatic_rollback_incomplete/);
  assert.match(production, /persist-recovery-required[\s\S]*--failure-stage d1_migration_failed/);
  // The generation only advances on a fully successful promotion.
  assert.match(production, /if: \$\{\{ success\(\) \}\}[\s\S]*"\$RELEASE_ENFORCER" advance/);

  // --- evidence ----------------------------------------------------------
  assert.match(production, /name: iro264-release-artifact-\$\{\{ github\.ref_name \}\}/);
  assert.match(
    production,
    /name: iro264-release-proof-\$\{\{ github\.ref_name \}\}[\s\S]*if-no-files-found: ignore[\s\S]*retention-days: 30/,
  );
  assert.match(production, /if: \$\{\{ always\(\) \}\}/);

  // --- pinned constants --------------------------------------------------
  assert.match(workflow, /RELEASE_FRAPPE_SCOPE: out-of-scope/);
  assert.match(workflow, /RELEASE_RULESET_ID: 20652124/);
  const workerPackage = JSON.parse(
    readFileSync(new URL("../workers-bus/package.json", import.meta.url), "utf8"),
  );
  assert.match(
    workflow,
    new RegExp(`WORKER_VERSION: ${workerPackage.devDependencies.wrangler.replaceAll(".", "\\.")}\n`),
  );
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 1);
}

function validateReleasePleaseWorkflow(workflow) {
  const releasePr = section(workflow, "release-pr");
  const githubRelease = section(workflow, "github-release");

  // No job's GITHUB_TOKEN writes. The two release jobs write through RELEASE_TAG_TOKEN,
  // held only in the `release` environment, so their PR and tag start workflows.
  assert.match(releasePr, /environment: release\n\s+permissions:\n\s+contents: read\n\s+steps:/);
  assert.match(githubRelease, /environment: release\n\s+permissions:\n\s+contents: read\n\s+pull-requests: read\n\s+actions: read/);
  assert.equal((workflow.match(/: write/g) ?? []).length, 0);
  for (const job of [releasePr, githubRelease]) {
    assert.match(job, /GITHUB_TOKEN: \$\{\{ secrets\.RELEASE_TAG_TOKEN \}\}\n\s+run: \|\n\s+set -euo pipefail\n\s+test -n "\$GITHUB_TOKEN" \|\|/);
  }
  assert.equal((workflow.match(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/g) ?? []).length, 0);
  assert.equal((workflow.match(/\$\{\{ secrets\.RELEASE_TAG_TOKEN \}\}/g) ?? []).length, 2);

  // Nothing runs per pull request event: release-pr on pull_request would open a
  // release PR for every branch, and the subject check there was about a fifth of
  // all Actions runs. release-pr answers to a push to main or a manual dispatch.
  assert.doesNotMatch(workflow, /^\s*pull_request(_target)?:/m);
  assert.match(workflow, /\n  workflow_dispatch:\n/);
  assert.match(
    releasePr,
    /if: github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/,
  );
  assert.doesNotMatch(releasePr, /pull_request/);

  // The tag is minted only for the merge commit of the newest merged release PR,
  // on a successful Deploy of this repository's own main.
  assert.match(githubRelease, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(githubRelease, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(
    githubRelease,
    /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/,
  );
  assert.match(githubRelease, /id: release_commit/);
  assert.match(githubRelease, /--head release-please--branches--main/);
  assert.match(
    githubRelease,
    /if \[\[ "\$merge_commit" != "\$DEPLOY_HEAD_SHA" \]\]; then[\s\S]*tag=false[\s\S]*exit 0/,
  );
  assert.match(
    githubRelease,
    /if: \$\{\{ steps\.release_commit\.outputs\.tag == 'true' \}\}[\s\S]*github-release/,
  );

  // release-please itself is run through npx at a pinned version: the
  // organization allows only GitHub-owned actions.
  assert.match(workflow, /RELEASE_PLEASE_VERSION: 17\.11\.2/);
  assert.equal(
    (workflow.match(/npx --yes "release-please\$\{?RELEASE_PLEASE_VERSION\}?"/g) ?? []).length,
    0,
  );
  assert.equal(
    (workflow.match(/npx --yes "release-please@\$RELEASE_PLEASE_VERSION"/g) ?? []).length,
    2,
  );
  for (const uses of workflow.match(/uses: [^\s]+/g) ?? []) {
    assert.match(uses, /uses: actions\/(checkout|setup-node)@[0-9a-f]{40}/, uses);
  }

  // The subject check is advisory and push-only. The landed subject is text a
  // contributor chose: it may reach the job in exactly one way, an `env:`
  // assignment, never the `run:` script. The step warns and never fails.
  assert.match(releasePr, /if: github\.event_name == 'push'\n\s+env:\n\s+COMMIT_MESSAGE: \$\{\{ github\.event\.head_commit\.message \}\}/);
  assert.match(releasePr, /if ! PR_TITLE="\$subject" node tools\/conventional-pr-title\.mjs; then\n\s+echo "::warning /);
  const subjectUses = [
    ...workflow.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_-]*): \$\{\{ github\.event\.head_commit\.message \}\}$/gm),
  ];
  assert.equal(subjectUses.length, 1, "the landed commit message is read exactly once");
  assert.equal(subjectUses[0][1], "COMMIT_MESSAGE", "and only as an env assignment");
  assert.equal(
    (workflow.match(/github\.event\.head_commit\.message/g) ?? []).length,
    1,
    "the commit message expression appears nowhere else",
  );
}

test("the production release promotes qa-proven bytes from a tag, behind the predecessor enforcer", async () => {
  validateProductionWorkflow(await readFile(productionWorkflowUrl, "utf8"));
});

test("production workflow validation rejects a trigger that is not a declared dispatch", async () => {
  const workflow = await readFile(productionWorkflowUrl, "utf8");
  // A tag push would deploy without the declaration.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace("on:\n", 'on:\n  push:\n    tags: ["v*"]\n'),
    ),
  );
  // A branch push would promote every commit to production.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace("on:\n", "on:\n  push:\n    branches: [main]\n"),
    ),
  );
  // A workflow_run trigger would promote whatever Deploy last finished.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace(
        "on:\n",
        "on:\n  workflow_run:\n    workflows: [Deploy]\n    types: [completed]\n",
      ),
    ),
  );
  // Dropping the tag-shape gate would promote any tag, including a moved one.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace("release_production_tag_format_invalid", "release_production_tag_assumed_valid"),
    ),
  );
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace("release_production_ref_not_a_tag", "release_production_ref_assumed_tag"),
    ),
  );
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace("release_production_dispatch_tag_mismatch", "release_production_dispatch_trusted"),
    ),
  );
});

test("production workflow validation rejects a relaxed declaration check", async () => {
  const workflow = await readFile(productionWorkflowUrl, "utf8");
  // Without the input, nothing ties the run to a merged promotion PR.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace(/\n {6}declaration_sha:\n(?: {8}.*\n)+/, "\n"),
    ),
  );
  // The step removed entirely.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace(
        "- name: Require the production declaration to name this tag",
        "- name: Note the production declaration",
      ),
    ),
  );
  // A declaration that names another tag accepted.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace('[[ "$declared" == "$REF_NAME" ]] || mismatch', 'true || mismatch'),
    ),
  );
  // A declaration commit from an unmerged branch accepted.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace(
        '[[ "$status" == "ahead" || "$status" == "identical" ]] || mismatch',
        '[[ -n "$status" ]] || mismatch',
      ),
    ),
  );
  // An old declaration replayed after a newer promotion or a revert.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace('[[ "$current" == "$REF_NAME" ]] || mismatch "superseded', 'true || mismatch "superseded'),
    ),
  );
  // The read token swapped for the job token, which cannot read iron-wrap-infra.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace(
        "GH_TOKEN: ${{ secrets.RELEASE_DECLARATION_READ_TOKEN }}",
        "GH_TOKEN: ${{ github.token }}",
      ),
    ),
  );
  // The check moved after the checkout of the candidate tree.
  const step = workflow.slice(
    workflow.indexOf("      # The production gate is a merged promotion PR"),
    workflow.indexOf("      - uses: actions/checkout@"),
  );
  assert.throws(() =>
    validateProductionWorkflow(
      workflow
        .replace(step, "")
        .replace("      - name: Load generation N policy enforcement", `${step}      - name: Load generation N policy enforcement`),
    ),
  );
});

test("production workflow validation rejects candidate-supplied enforcement", async () => {
  const workflow = await readFile(productionWorkflowUrl, "utf8");
  // The candidate tree approving its own release.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replaceAll('node "$RELEASE_ENFORCER"', "node tools/release-promotion.mjs"),
    ),
  );
  // The candidate tree's Wrangler touching production.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace(
        'npm ci --ignore-scripts --prefix "$RUNNER_TEMP/policy-enforcer/workers-bus"',
        "npm ci --ignore-scripts --prefix workers-bus",
      ),
    ),
  );
  assert.throws(() =>
    validateProductionWorkflow(workflow.replace("release_admission_push_not_linear", "assumed_linear")),
  );
});

test("production workflow validation rejects a relaxed source policy or an unbound proof", async () => {
  const workflow = await readFile(productionWorkflowUrl, "utf8");
  // Without `reachable`, every release that is not main's tip fails closed; with
  // it dropped from only ONE of the two readbacks, the two disagree.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replaceAll("            --source-policy reachable \\\n", ""),
    ),
  );
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace("            --source-policy reachable \\\n", ""),
    ),
  );
  // A download without the run id reads the wrong run's artifact.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replaceAll("          run-id: ${{ env.RELEASE_QA_RUN_ID }}\n", ""),
    ),
  );
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replaceAll("          github-token: ${{ github.token }}\n", ""),
    ),
  );
  assert.throws(() =>
    validateProductionWorkflow(
      // Both the tag/tree check and the tree-digest check report this code.
      workflow.replaceAll("release_production_qa_proof_foreign", "release_production_qa_proof_trusted"),
    ),
  );
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace("release_production_missing_qa_run", "release_production_qa_run_optional"),
    ),
  );
});

test("production workflow validation rejects a mutable or out-of-order promotion", async () => {
  const workflow = await readFile(productionWorkflowUrl, "utf8");
  // Building and publishing from the candidate tree instead of promoting the
  // already-proven version.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace(
        '\'"$WRANGLER_BIN" versions deploy --config workers-bus/wrangler.jsonc --version-id "$(cat "$RUNNER_TEMP/production-version.id")" --yes\'',
        '\'"$WRANGLER_BIN" deploy --config workers-bus/wrangler.jsonc\'',
      ),
    ),
  );
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace("--strict --message", "--strict --keep-vars --message"),
    ),
  );
  // Migrating production before the permit is admitted.
  const admitStep = workflow.slice(
    workflow.indexOf("      - name: Consume the permit once"),
    workflow.indexOf("      - name: Read back the exact merged source"),
  );
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace(admitStep, "").replace(
        "      - name: Read back the production Workers domain binding",
        `${admitStep}      - name: Read back the production Workers domain binding`,
      ),
    ),
  );
  // Losing the automatic rollback guard.
  assert.throws(() =>
    validateProductionWorkflow(
      workflow.replace(
        "steps.promote_production.outcome != 'skipped'",
        "steps.promote_production.outcome == 'success'",
      ),
    ),
  );
  // Advancing the durable generation whatever happened.
  assert.throws(() =>
    validateProductionWorkflow(workflow.replace("if: ${{ success() }}", "if: ${{ always() }}")),
  );
});

test("the release train warns on the landed subject, opens one release PR, and tags only the release merge", async () => {
  validateReleasePleaseWorkflow(await readFile(releasePleaseWorkflowUrl, "utf8"));
});

test("release-please workflow validation rejects a per-pull-request run, a write token or an ungated tag", async () => {
  const workflow = await readFile(releasePleaseWorkflowUrl, "utf8");
  // No job's GITHUB_TOKEN may write.
  assert.throws(() =>
    validateReleasePleaseWorkflow(
      workflow.replace(
        "    permissions:\n      contents: read\n",
        "    permissions:\n      contents: write\n",
      ),
    ),
  );
  // A pull_request trigger would bring the per-event runs back.
  assert.throws(() =>
    validateReleasePleaseWorkflow(
      workflow.replace("on:\n", "on:\n  pull_request:\n    types: [opened, synchronize]\n"),
    ),
  );
  // The landed subject may not be interpolated into the script.
  assert.throws(() =>
    validateReleasePleaseWorkflow(
      workflow.replace('subject="$(printf', 'echo "${{ github.event.head_commit.message }}"\n          subject="$(printf'),
    ),
  );
  // A GITHUB_TOKEN-made release PR or tag starts no workflow; the PAT outside its
  // environment would reach every branch.
  assert.throws(() =>
    validateReleasePleaseWorkflow(
      workflow.replace("GITHUB_TOKEN: ${{ secrets.RELEASE_TAG_TOKEN }}", "GITHUB_TOKEN: ${{ github.token }}"),
    ),
  );
  assert.throws(() =>
    validateReleasePleaseWorkflow(workflow.replace("    environment: release\n", "")),
  );
  // Opening a release PR from a pull_request event would mint one per branch.
  assert.throws(() =>
    validateReleasePleaseWorkflow(
      workflow.replace("if: github.event_name == 'push'", "if: github.event_name == 'pull_request'"),
    ),
  );
  // Without the merge-commit gate, every successful Deploy of main would tag.
  const gate = workflow.slice(
    workflow.indexOf("      - name: Require this Deploy run to be the merged release pull request"),
    workflow.indexOf("      - name: Tag the release commit and publish the GitHub release"),
  );
  assert.throws(() => validateReleasePleaseWorkflow(workflow.replace(gate, "")));
  assert.throws(() =>
    validateReleasePleaseWorkflow(
      workflow.replace('if [[ "$merge_commit" != "$DEPLOY_HEAD_SHA" ]]; then', 'if false; then'),
    ),
  );
  // A fork's Deploy must never tag this repository.
  assert.throws(() =>
    validateReleasePleaseWorkflow(
      workflow.replace(
        "github.event.workflow_run.head_repository.full_name == github.repository",
        "github.event.workflow_run.head_repository.full_name != ''",
      ),
    ),
  );
  // Only GitHub-owned actions, and release-please only through pinned npx.
  const thirdPartyAction = workflow.replace(
    /      - uses: actions\/setup-node@[^\n]+/,
    "      - uses: googleapis/release-please-action@v4",
  );
  assert.notEqual(thirdPartyAction, workflow, "the refusal fixture must replace the current pinned action");
  assert.throws(() =>
    validateReleasePleaseWorkflow(thirdPartyAction),
  );
  assert.throws(() =>
    validateReleasePleaseWorkflow(workflow.replace("RELEASE_PLEASE_VERSION: 17.11.2", "RELEASE_PLEASE_VERSION: latest")),
  );
});


const dependencyWorkflowUrl = new URL(
  "../.github/workflows/dependabot-automerge.yml",
  import.meta.url,
);

function dependencyWorkflowRun(workflow) {
  const marker = "        run: |\n";
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, "dependency workflow has its real shell step");
  const lines = workflow.slice(start + marker.length).split("\n");
  const run = [];
  for (const line of lines) {
    if (line && !line.startsWith("          ")) break;
    run.push(line.slice(10));
  }
  assert.equal(workflow.indexOf(marker, start + marker.length), -1, "one advisory shell step");
  return run.join("\n");
}

function dependencyMessages(types) {
  return [
    "Bump synthetic dependencies",
    "---",
    "updated-dependencies:",
    ...types.flatMap((type, index) => [
      `- dependency-name: synthetic-${index}`,
      "  dependency-type: direct:production",
      ...(type === null ? [] : [`  update-type: ${type}`]),
    ]),
    "...",
    "",
  ].join("\n");
}

function runDependencyClassification(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ironwrap-dependency-review-"));
  try {
    const trace = join(directory, "gh-calls.jsonl");
    const messages = join(directory, "messages.txt");
    writeFileSync(messages, options.messages ?? dependencyMessages(["version-update:semver-patch"]));
    const stub = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.OFFLINE_GH_TRACE, JSON.stringify(args) + "\n");
if (process.env.GH_TOKEN !== "offline-test-token" || process.env.GITHUB_TOKEN !== "offline-test-token") {
  process.stderr.write("The fixture refuses real credentials.\n");
  process.exit(95);
}
let method = args.includes("-f") || args.includes("-F") || args.includes("--field") || args.includes("--raw-field") ? "POST" : "GET";
const methodIndex = args.findIndex((value) => value === "--method" || value === "-X");
if (methodIndex >= 0) method = args[methodIndex + 1];
const endpoint = args.find((value) => value.startsWith("repos/"));
if (args[0] !== "api" || method !== "GET") {
  process.stderr.write("Mutation or unexpected command refused by offline gh: " + JSON.stringify(args) + "\n");
  process.exit(97);
}
if (endpoint === "repos/example/synthetic/pulls/123/commits") {
  if (process.env.OFFLINE_FAIL_COMMITS === "1") process.exit(42);
  process.stdout.write(fs.readFileSync(process.env.OFFLINE_MESSAGES_PATH, "utf8"));
} else if (endpoint === "repos/example/synthetic/rules/branches/main") {
  if (process.env.OFFLINE_FAIL_RULES === "1") process.exit(43);
  process.stdout.write(process.env.OFFLINE_RULES_RESULT + "\n");
} else {
  process.stderr.write("Unexpected API read refused: " + String(endpoint) + "\n");
  process.exit(98);
}
`;
    writeFileSync(join(directory, "gh"), `#!${process.execPath}\n${stub}`, { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${directory}:${dirname(process.execPath)}:/usr/bin:/bin`,
      GH_TOKEN: "offline-test-token",
      GITHUB_TOKEN: "offline-test-token",
      GH_ENTERPRISE_TOKEN: "",
      GITHUB_ENTERPRISE_TOKEN: "",
      GH_HOST: "offline.invalid",
      GITHUB_REPOSITORY: "example/synthetic",
      PR_NUMBER: "123",
      PR_URL: "https://example.invalid/pull/123",
      BASE: "main",
      OFFLINE_GH_TRACE: trace,
      OFFLINE_MESSAGES_PATH: messages,
      OFFLINE_FAIL_COMMITS: options.failCommits ? "1" : "0",
      OFFLINE_FAIL_RULES: options.failRules ? "1" : "0",
      OFFLINE_RULES_RESULT: options.rules ?? "1",
    };
    const selected = spawnSync("/bin/bash", ["-c", "command -v gh"], { env, encoding: "utf8" });
    assert.equal(selected.status, 0);
    assert.equal(selected.stdout.trim(), join(directory, "gh"), "only the offline gh stub is executable here");
    const result = spawnSync("/bin/bash", ["-c", dependencyWorkflowRun(readFileSync(dependencyWorkflowUrl, "utf8"))], {
      cwd: directory,
      env,
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    const calls = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertReadOnlyDependencyCalls(result) {
  for (const args of result.calls) {
    assert.equal(args[0], "api", `No mutation may be attempted: ${JSON.stringify(result.calls)}`);
    const index = args.findIndex((value) => value === "--method" || value === "-X");
    const method = index >= 0 ? args[index + 1] : "GET";
    assert.equal(method, "GET", JSON.stringify(args));
    assert.ok(!args.some((value) => ["-f", "-F", "--field", "--raw-field"].includes(value)), JSON.stringify(args));
  }
}

test("dependency bot workflow uses read-only permissions", () => {
  const workflow = readFileSync(dependencyWorkflowUrl, "utf8");
  assert.match(workflow, /^permissions: \{\}$/m);
  const permissions = workflow.match(/^    permissions:\n((?:      [^\n]+\n)+)/m)?.[1];
  assert.ok(permissions);
  assert.deepEqual(permissions.trim().split("\n").map((line) => line.trim()).sort(), ["contents: read", "pull-requests: read"]);
  assert.doesNotMatch(workflow, /:\s*write\b|secrets\./);
  assert.doesNotMatch(dependencyWorkflowRun(workflow), /\bgh\s+pr\b/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /if: github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'/);
});

for (const [name, types, classification] of [
  ["patch", ["version-update:semver-patch"], "eligible_for_serial_review"],
  ["minor", ["version-update:semver-minor"], "eligible_for_serial_review"],
  ["patch and minor", ["version-update:semver-patch", "version-update:semver-minor"], "eligible_for_serial_review"],
  ["major", ["version-update:semver-major"], "review_required"],
  ["mixed major", ["version-update:semver-patch", "version-update:semver-major"], "review_required"],
  ["digest", ["version-update:digest"], "review_required"],
  ["missing type", [null], "metadata_missing"],
  ["partially missing type", ["version-update:semver-patch", null], "metadata_missing"],
]) {
  test(`dependency bot classifies ${name} metadata without mutation`, () => {
    const result = runDependencyClassification({ messages: dependencyMessages(types) });
    assertReadOnlyDependencyCalls(result);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`dependency_classification=${classification}(?:;|\s|$)`));
    assert.equal(result.calls.length, classification === "eligible_for_serial_review" ? 2 : 1);
  });
}

test("dependency bot reports missing required checks without mutation", () => {
  const result = runDependencyClassification({ rules: "0" });
  assertReadOnlyDependencyCalls(result);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dependency_classification=checks_missing/);
  assert.equal(result.calls.length, 2);
});

for (const [name, options, classification, count] of [
  ["commit metadata failure", { failCommits: true }, "metadata_unavailable", 1],
  ["branch metadata failure", { failRules: true }, "checks_unavailable", 2],
  ["invalid check metadata", { rules: "unknown" }, "checks_unavailable", 2],
]) {
  test(`dependency bot fails closed on ${name} without mutation`, () => {
    const result = runDependencyClassification(options);
    assertReadOnlyDependencyCalls(result);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, new RegExp(`dependency_classification=${classification}`));
    assert.equal(result.calls.length, count);
  });
}
