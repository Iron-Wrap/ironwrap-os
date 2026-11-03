# Trusted auth-control writer prerequisite

This tool-only prerequisite adds the Node writer and shared v2 codec to the release-policy closure. It does not install the P1 Worker, migration, runtime variables or reader credentials. It does not provision a bucket, invoke a protected workflow, open enrollment or qualify a deployed producer. The existing release/config commands retain their contracts and historical canonical encoding.

`AUTH_CONTROL_WRITER_POLICY_FILES` binds the executable Node writer, codec, conditional S3 adapter and existing release/provider policy consumers. The separate `AUTH_PROTOCOL_POLICY_FILES` describes the future candidate's transitive Worker/schema closure. Those absent future paths are not inputs to the P0 release-policy hash.

## Captured predecessor and exact evidence

The protected caller must execute `tools/release-promotion.mjs` from the clean, captured trusted predecessor tree. Its externally established commit is supplied as `--policy-commit`; an input proposal cannot select the policy checkout. `candidateRoots` must hold clean, exact source checkouts for the observed provider versions. Each binding includes the source/base commits, version ID, artifact hash, issuer, protocol, role and CI run; a predecessor also requires its completed QA run.

The writer checks the canonical repository `Iron-Wrap/ironwrap-os`, successful exact-source main CI, predecessor QA, provider version metadata, complete effective config/binding/secret manifests and candidate/predecessor roles. Protocol2 requires actual version metadata and reader secrets, and rejects writer-secret bindings in the application version. Source claims or a locally mocked provider response do not constitute deployed qualification.

## Commands and effects

All three commands require `--repo-root`, `--environment` (`qa` or `production`) and `--output`. The private control target comes from the candidate's validated environment config. Writer credentials use only `RELEASE_AUTH_CONTROL_R2_ACCESS_KEY_ID` and `RELEASE_AUTH_CONTROL_R2_SECRET_ACCESS_KEY`; the application reader uses the separate `AUTH_CONTROL_READ_*` names. Provider enforcement of read-only/bucket/environment credential scope is a separate provisioning and qualification prerequisite.

- `auth-control-update` additionally takes `--input` and `--policy-commit`. It authorizes the proposal, validates the next head and performs one conditional PUT of `auth-control/head-v2`. Genesis needs explicit bootstrap, the sole current legacy predecessor at100percent, a pristine revision-zero D1 mirror and no enrolled contexts. Those deployment/mirror conditions are checked again before the PUT. A lost head after D1 lineage cannot create a new genesis. Existing heads require the current ETag and the next monotonic revision. A CAS loser reads back and stops; it never retries an unconditional overwrite.
- `auth-protocol-mirror` additionally takes `--input`, `--policy-commit` and `--phase`. Stage and cutover predicates check enrollment, contexts and activation identity atomically with the SQL update. Cutover requires a safe protocol2 producer pair and no legacy deployment member, including a zero-percent member. The owning P1 database trigger must retire legacy credentials; the writer verifies that readback. Every phase keeps shipping enrollment closed.
- `auth-switch-preflight` additionally takes `--version-id`. It reads the head, mirror and complete current deployment before a candidate, predecessor or cleanup switch, then rereads the head. Missing/malformed data, a closed barrier, stale identity/revision or an unsafe zero-percent member refuses the switch. It performs no provider switch or head/SQL write.

The S3 adapter signs a fixed account/bucket/key URL, disables cache and redirects, bounds response bytes and requires exact canonical control bytes. It supports GET and conditional PUT only. The v2 encoding uses shared code-unit ordering; existing release-tool and Worker canonical forms remain separate and unchanged.

## Execution gates

The protected workflow invocation, least-privilege credentials, dedicated non-restored environment buckets and actual provider/schema/producer readbacks must be explicitly prepared and qualified before execution. No current workflow invokes these commands. Production floor2 requires the completed exact QA producer qualification artifact; CI, source presence, health checks and bootstrap receipts cannot substitute. Synthetic committed fixtures exercise writer adapters and SQL consumer predicates only; they do not qualify migration0173 or deployed recovery.
