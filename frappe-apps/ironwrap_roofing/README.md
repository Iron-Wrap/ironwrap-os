# ironwrap_roofing

Minimal Frappe app contract for IronWrap OS.

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
- `Measurement Report` with child `Measurement Value`
- `Material Takeoff` with child `Material Takeoff Item`
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
- `Market Watch Item`
- `Hermes Run`

Install path on a plain Frappe dev site (do not install erpnext):

```bash
bench get-app /path/to/ironwrap/frappe-apps/ironwrap_roofing
bench --site <site> install-app ironwrap_roofing
```

Validate the committed DocType contract without a bench (prints `ok 26`; the
validator keeps its historical `erpnext` filename for compatibility):

```bash
node tools/validate-erpnext-doctypes.mjs
```
