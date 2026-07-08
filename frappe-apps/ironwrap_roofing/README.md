# ironwrap_roofing

Minimal Frappe/ERPNext app contract for IronWrap OS.

This is not an ERPNext fork. It adds app-level DocTypes that receive canonical
events from the Cloudflare bus and model the first ERP operating core:

- `Lead Envelope`
- `Roofing Property`
- `Roof Job`
- `Measurement Report` with child `Measurement Value`
- `Evidence Item`
- `Proposal Evidence Pack`
- `Production Gate State`

Install path once an ERPNext dev site exists:

```bash
bench get-app /path/to/ironwrap/frappe-apps/ironwrap_roofing
bench --site <site> install-app ironwrap_roofing
```

Validate the committed DocType contract without a bench:

```bash
node tools/validate-erpnext-doctypes.mjs
```
