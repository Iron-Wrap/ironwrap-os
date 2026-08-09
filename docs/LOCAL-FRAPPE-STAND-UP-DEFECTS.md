# Local Frappe stand-up: defect log

Defects and required manual steps discovered by actually provisioning
`deploy/local/docker-compose.yml` (colima/Docker on Apple-silicon macOS, `linux/arm64`) and
running the `ironwrap_roofing` Python suite. Every claim below is reproducible with the quoted
command; none of it is deployment, runtime-production, or business evidence. The local stack is
development/proof only — production remains the digest-pinned `x86_64` contract in
`deploy/` ([`LAUNCH-RUNBOOK.md`](./LAUNCH-RUNBOOK.md)).

## What provisioning proved

After the defects below were worked around, one `docker compose -f deploy/local/docker-compose.yml
up -d` completes end to end:

- `frappe-init` finishes: bench at Frappe `v15.114.0`, site `ironwrap.localhost`, app installed,
  assets built, three service identities created (`ironwrap-bus@ironwrap.local` integration user,
  customer-acceptance service, QuickBooks reconciliation issuer), site-config pins written.
- `bench --site ironwrap.localhost list-apps` returns exactly `frappe 15.114.0` and
  `ironwrap_roofing` — no `erpnext`, as the launch contract requires.
- `curl http://localhost:8000/api/method/ping` answers `{"message":"pong"}`; a REST read of
  `Lead Envelope` with the generated integration API pair returns `{"data":[]}` (DocTypes present,
  zero business rows); `web`, `schedule`, and `worker` processes run under `bench start`.
- The app model carries **64 DocTypes (48 top-level + 16 child)**, matching
  [`CAPABILITY-MATRIX.md`](./CAPABILITY-MATRIX.md).

## Defect 1 — provisioner dies on transient DNS and stays dead

`frappe-init.sh` performs many network installs (GitHub clone, yarn, PyPI) with no retry or DNS
preflight. On a freshly started colima VM, in-container DNS can fail for a window after boot; the
observed first run resolved GitHub during `bench init`, then failed both the optional
`assets.tar.gz` download and, fatally, the PyPI fetch of `setuptools>=68` during the app's
editable install:

```
NameResolutionError: Failed to resolve 'pypi.org' ... ERROR: No matching distribution found for setuptools>=68
service "frappe-init" didn't complete successfully: exit 1
```

Because `frappe` depends on `frappe-init` with `condition: service_completed_successfully`, the
whole stack then sits half-up (MariaDB/Redis running, no Frappe) until an operator notices.
The script is correctly idempotent: verify DNS
(`docker run --rm frappe/bench:latest python3 -c "import socket; print(socket.gethostbyname('pypi.org'))"`)
and re-run `docker compose -f deploy/local/docker-compose.yml up -d`; the second pass skips
completed steps and finishes. Repair candidates (not implemented here): bounded retry around the
pip/bench network steps, or a hard DNS preflight at the top of `frappe-init.sh` so the failure is
one obvious line instead of a mid-provision stack trace.

## Defect 2 — the Python suite cannot go green from the bench-installed copy

`tests/test_approval_receipt.py` contains two cross-language parity tests that spawn `node` on
`mcp/erpnext-roofing-mcp/src/approval-contract.mjs` and `src/server.mjs`, resolved as
`Path(__file__).resolve().parents[3]` — i.e. they hard-require the monorepo layout around the app.
Inside the container the app lives at `apps/ironwrap_roofing` under the bench, `parents[3]` is the
bench root, there is no `mcp/`, and the suite reports `Ran 159 tests ... FAILED (failures=2)`.

From a repository checkout (with `node` on `PATH` and Python ≥3.12 with `cryptography`):

```
cd frappe-apps/ironwrap_roofing && PYTHONPATH=. python3 -m unittest discover -s tests
# Ran 159 tests ... OK
```

Consequence: "run the app suite where the app is installed" is structurally impossible to satisfy
at 159/159; the green run must happen from the checkout. Repair candidates (not implemented
here): skip the two parity tests with an explicit reason when the `mcp/` tree is absent, or mount
`mcp/erpnext-roofing-mcp` read-only into the init/runtime containers.

## Defect 3 — stale test-count and DocType claims in canonical docs

- [`CAPABILITY-MATRIX.md`](./CAPABILITY-MATRIX.md) repository baseline says "Frappe | 102 unit
  tests passed"; the suite is now 159 tests in 16 files (both container and checkout runs execute
  159). The matrix figure is a dated snapshot, not wrong-by-design, but anyone sizing the suite
  from the matrix is off by a third.
- [`LAUNCH-RUNBOOK.md`](./LAUNCH-RUNBOOK.md) §13 claimed "50 DocTypes (42 top-level + 8 child)"
  in the operating-core gate row while the app and the matrix both carry 64 (48 + 16). Corrected
  to 64 in the same commit that adds this log.

## Defect 4 — launch-proof reader identity is not provisioned by any script

`frappe-init.sh` creates the integration, customer-acceptance, and QuickBooks-issuer identities,
but not the `IronWrap Launch Proof Reader` user, its API pair, or the
`ironwrap_launch_proof_reader_user` site-config pin that
[`LAUNCH-PROOF-SIDE-EFFECTS.md`](./LAUNCH-PROOF-SIDE-EFFECTS.md) §2 requires before
`tools/launch-proof.mjs --execute` will send anything. The role itself exists (created by the app
install hook); the user provisioning is a deliberate manual step in production and an undocumented
manual step locally. Local provisioning recipe (bench console, same shape as the broker users in
`deploy/local/README.md`): create the user with only the `IronWrap Launch Proof Reader` role,
`generate_keys`, then `bench --site ironwrap.localhost set-config ironwrap_launch_proof_reader_user
<email>`.

## Accepted-by-design residuals (recorded, not defects to fix)

- `deploy/local/docker-compose.yml` uses unpinned `frappe/bench:latest` (currently ships Python
  3.14 in the bench virtualenv, emitting `rq` `utcnow()` deprecation warnings in the worker).
  Acceptable for a dev/proof stack; never a template for production, which stays digest-pinned.
- First `bench build` inside `bench init` warns `Cannot connect to redis_cache to update
  assets_json` — Redis config generation is intentionally skipped at that stage; the later build
  in step 6 of `frappe-init.sh` completes against the running containers.
