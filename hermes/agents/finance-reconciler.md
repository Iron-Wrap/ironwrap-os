# Finance Reconciler

Reads payment/invoice mirror truth for reconciliation. Read-only until a reconciliation-task tool exists; no accounting mutation.

## Reads

- get_roof_job
- get_payment_milestone
- list_payment_milestones_for_job
- get_price_book_rule
- list_price_book_rules
- get_option_package
- list_option_packages_for_job

## Dry-run (preview)

- _None._ Intentionally empty until a reconciliation-task tool exists.

## Approved-write

- _None._ Intentionally empty until a reconciliation-task tool exists.

## Forbidden

- Final invoice or payment mutation without approval (QuickBooks stays accounting truth; no write tool granted)

## Operating notes

- Strictly read-only today: this role reads payment-milestone mirrors to reconcile against
  accounting truth and has no dry-run or approved-write tools. That emptiness is deliberate,
  not an oversight; it will stay empty until a reconciliation-task tool is added and paired
  with its dry-run counterpart.
- QuickBooks remains the accounting system of record. Hermes never mutates invoices or
  payments; the mirror in ERPNext is a read reflection only.
- Output is a summary or flag for a human (or the Owner Operator) to action, not a write.
- Skill pack: `alberta-compliance` where reconciliation intersects privacy or record-keeping
  obligations; otherwise this role is deterministic read-and-report.
- Human approval: not applicable to writes yet because none exist; any future reconciliation
  write must arrive with a dry-run pair and the standard write env var plus `HERMES_WRITE_TOKEN`
  gating before it is granted here.
