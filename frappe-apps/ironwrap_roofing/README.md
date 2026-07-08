# ironwrap_roofing

Minimal Frappe/ERPNext app contract for IronWrap OS.

This is not an ERPNext fork. It adds app-level DocTypes that receive canonical
events from the Cloudflare bus. The first committed proof is `Lead Envelope`,
matching `workers-bus/src/erpnext.ts`.

Install path once an ERPNext dev site exists:

```bash
bench get-app /path/to/ironwrap/frappe-apps/ironwrap_roofing
bench --site <site> install-app ironwrap_roofing
```

Validate the committed DocType contract without a bench:

```bash
node tools/validate-erpnext-doctypes.mjs
```
