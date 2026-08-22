# ironwrap_roofing

Proprietary Frappe compatibility projection for IronWrap OS. It is not the native operating
authority: D1/Worker owns normalized operating state and controls. This app remains for bounded
legacy workflows, projections, reconciliation, and rollback while retirement is in progress.
See the canonical boundary in
[`docs/AI-NATIVE-ARCHITECTURE.md`](../../docs/AI-NATIVE-ARCHITECTURE.md).

This is not an ERPNext app or fork; it installs on a plain Frappe site, never
install the erpnext app. The app is proprietary IronWrap IP (`hooks.py`
`app_license = "Proprietary"`) built on the MIT Frappe framework; the only
non-custom Link target is Frappe core `User`. It adds app-level DocTypes that
receive bounded events/projections from the Cloudflare bus and model the compatibility surface:

- `Lead Envelope`
- `Roofing Customer`
- `Roofing Property`
- `Roof Job`
- `Customer Quote`
- `Instant Estimate Session`
- `Price Book Rule`
- `Insurance Supplement` with child `Insurance Supplement Evidence`
- `Measurement Report` with child `Measurement Value`
- `Visual Property Model`
- `Roof Area`
- `Material Takeoff` with child `Material Takeoff Item`
- `Option Package`
- `Scope Clause`
- `Supplier Profile`
- `Supplier Order` with child `Supplier Order Item`
- `Controlled Item`
- `Material Lot`
- `Shop Order` with supply-only line, allocation, operation, yield, inspection, and bundle tables
- `Nonconformance`
- `Evidence Item`
- `Proposal Evidence Pack`
- `Supplier Quote` with child `Supplier Quote Item`
- `Payment Milestone`
- `Production Gate State`
- `Field Check-in`
- `Completion Packet`
- `Warranty Packet`
- `Review Request`
- `Communication Event`
- `Automation Incident`
- `Market Watch Item`
- `White-Label Tenant`
- `Hermes Run`

The standard `IronWrap OS` Workspace exposes the compatibility record graph. Its
`IronWrap Control Center` Page is a permission-scoped, read-only operator cockpit:
blocked gates, reviews, incidents, stale jobs, pipeline state, one focused job
runway, gate state, and recent evidence. It can also show the Worker's public
readiness result when the non-secret site configuration is present:

```bash
bench --site <site> set-config ironwrap_bus_base_url https://<worker-host>
```

The Page never holds an admin token and contains no mutation call. Legacy record changes stay in
normal Frappe forms or the Hermes dry-run, approval, write, and audit path; neither path can bypass
native D1 authority for a migrated fact.

Install path on a plain Frappe dev site (do not install erpnext):

```bash
bench get-app /path/to/ironwrap/frappe-apps/ironwrap_roofing
bench --site <site> install-app ironwrap_roofing
```

Before upgrading an existing site to the commercial-truth schema, run the
read-only preflight:

```bash
bench --site <site> execute ironwrap_roofing.commercial_migration.commercial_schema_preflight_report
```

`ready: true` is required before migration. The report enumerates opaque
DocType/name/field blockers and the count of deterministic updates. Migration
derives only missing Supplier Quote line totals (`quantity × unit_price`,
half-up cents) and their parent quote totals. Missing currency, dates, source
references, closed Price Book Rule contracts, or contradictory totals are never
defaulted: `before_migrate` aborts before any repair or metadata synchronization.
The complete deterministic plan is applied only when the whole site is clean,
and the same preflight is a no-op after successful application.

Validate the committed DocType contract without a bench. The root validator derives the current
top-level/child totals from the JSON contracts and compares them with the canonical capability
matrix, so this component page does not copy a volatile count. The validator keeps its historical
`erpnext` filename; the app-local unittest suite enforces the current contract:

```bash
node tools/validate-erpnext-doctypes.mjs
PYTHONPATH=. python -m unittest discover -s tests -v
```
