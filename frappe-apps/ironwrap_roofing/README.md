# ironwrap_roofing

Minimal Frappe/ERPNext app contract for IronWrap OS.

This is not an ERPNext fork. It adds app-level DocTypes that receive canonical
events from the Cloudflare bus and model the first ERP operating core:

- `Lead Envelope`
- `Roofing Property`
- `Roof Job`
- `Instant Estimate Session`
- `Measurement Report` with child `Measurement Value`
- `Material Takeoff` with child `Material Takeoff Item`
- `Supplier Order` with child `Supplier Order Item`
- `Evidence Item`
- `Proposal Evidence Pack`
- `Supplier Quote` with child `Supplier Quote Item`
- `Payment Milestone`
- `Production Gate State`
- `Completion Packet`
- `Warranty Packet`
- `Review Request`
- `Communication Event`
- `Market Watch Item`
- `Hermes Run`

Install path once an ERPNext dev site exists:

```bash
bench get-app /path/to/ironwrap/frappe-apps/ironwrap_roofing
bench --site <site> install-app ironwrap_roofing
```

Validate the committed DocType contract without a bench:

```bash
node tools/validate-erpnext-doctypes.mjs
```
