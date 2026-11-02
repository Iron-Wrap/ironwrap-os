# Finance Reconciler

Reads payment/invoice mirror truth and records evidence-backed reconciliation resolutions. Never mutates accounting or an external system.

## Reads

None.

## Dry-run (preview)

None.

## Approved-write

None.

## Forbidden

- Final invoice or payment mutation (QuickBooks stays accounting truth; the granted resolution tool changes only the reconciliation record)

## Operating notes

- Read the payment mirror, change order, and exact Integration Reconciliation before proposing
  a resolution. The resolution requires linked evidence: Pending may move only to Ignored;
  Mismatch may move to Resolved or Ignored.
- QuickBooks remains the accounting system of record. Hermes never mutates invoices or
  payments; `request_resolve_reconciliation` updates only the Frappe reconciliation row.
- `dry_run_job_cost_event` prepares a verified append-only candidate but has no write companion.
  Posted is accepted only with an exact Matched/Resolved external reconciliation; the current
  Frappe Finance/Owner must independently review and insert the event.
- Skill pack: `alberta-compliance` where reconciliation intersects privacy or record-keeping
  obligations; otherwise this role is deterministic read-and-report.
- Human approval: `request_resolve_reconciliation` must follow its dry-run and requires the
  standard write env var plus a matching `dry_run_receipt` and signed `approval_receipt`; the result is audited in Hermes Run.
