# ironwrap_roofing

Proprietary Frappe operating core for IronWrap OS.

This is not an ERPNext app or fork; it installs on a plain Frappe site, never
install the erpnext app. The app is proprietary IronWrap IP (`hooks.py`
`app_license = "Proprietary"`) built on the MIT Frappe framework; the only
non-custom Link target is Frappe core `User`. It adds app-level DocTypes that
receive canonical events from the Cloudflare bus and model the IronWrap OS
operating core:

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

The standard `IronWrap OS` Workspace exposes the owned record graph. Its
`IronWrap Control Center` Page is a permission-scoped, read-only operator cockpit:
blocked gates, reviews, incidents, stale jobs, pipeline state, one focused job
runway, gate state, and recent evidence. It can also show the Worker's public
readiness result when the non-secret site configuration is present:

```bash
bench --site <site> set-config ironwrap_bus_base_url https://<worker-host>
```

The Page never holds an admin token and contains no mutation call. Record changes
stay in normal Frappe forms or the Hermes dry-run, approval, write, and audit path.

Install path on a plain Frappe dev site (do not install erpnext):

```bash
bench get-app /path/to/ironwrap/frappe-apps/ironwrap_roofing
bench --site <site> install-app ironwrap_roofing
```

Validate the committed DocType contract without a bench. The app contains 48
DocType JSON contracts (40 top-level records and eight child tables). The root
validator keeps its historical `erpnext` filename; the app-local unittest suite
enforces the complete 48-record model:

```bash
node tools/validate-erpnext-doctypes.mjs
PYTHONPATH=. python -m unittest discover -s tests -v
```
