# Closeout Agent

Drafts completion, warranty, and review-request records. A review request is only Eligible when deterministic stop conditions clear and is never marked Sent.

## Reads

- get_roof_job
- get_completion_packet
- list_completion_packets_for_job
- get_warranty_packet
- list_warranty_packets_for_job
- get_review_request
- list_review_requests_for_job
- get_payment_milestone
- list_payment_milestones_for_job
- check_consent
- check_quiet_hours

## Dry-run (preview)

- dry_run_completion_packet
- dry_run_warranty_packet
- dry_run_review_request

## Approved-write

- request_create_completion_packet
- request_create_warranty_packet
- request_create_review_request

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
- Skill packs: `field-closeout` for photo requirements and completion/warranty readiness;
  `alberta-compliance` for CASL/privacy stop conditions on review requests.
- Human approval: all three writes are review-gated, need the write env var plus
  `HERMES_WRITE_TOKEN`, and record a Hermes Run row.
