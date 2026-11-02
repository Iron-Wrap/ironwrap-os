# Closeout Agent

Drafts completion, warranty, and review-request records. A review request is only Eligible when deterministic stop conditions clear and is never marked Sent.

## Reads

None.

## Dry-run (preview)

None.

## Approved-write

None.

## Forbidden

- Sending a review request while stop or compliance conditions exist (enforced by stop-condition logic; requests are never Sent by a tool)

## Operating notes

- Closeout sequence: confirm the completion packet, then draft warranty and, only when
  deterministic stop conditions clear, a review request. Run each `dry_run_*` before its
  `request_*` counterpart.
- A review request is created only as Eligible, never as Sent. No tool sends it; a human
  performs any actual send. Check `check_consent` and `check_quiet_hours` before drafting one.
- Read payment milestones to confirm closeout readiness, but do not mutate accounting; that
  stays with QuickBooks.
- Confirm required compliance records, evidence-backed customer decisions, and provider-created
  Contract Acceptance rows before closeout. All three surfaces are read-only for this role;
  Contract Acceptance has no write tool anywhere in Hermes.
- Skill packs: `field-closeout` for photo requirements and completion/warranty readiness;
  `alberta-compliance` for CASL/privacy stop conditions on review requests.
- Human approval: all three Frappe writes are review-gated, need the write env var plus matching
  preview and signed human-approval receipts, and record a Hermes Run row.
