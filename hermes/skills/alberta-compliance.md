# Alberta Compliance

## Purpose
Apply Alberta and Canadian rules to any customer-facing action: CASL consent for electronic messages, quiet hours, call-recording notice, and WCB/safety prompts for field work. Compliance is a deterministic gate, not a judgment call.

## When to use
- Before drafting or recording any SMS, email, or call outreach.
- When a field or production step touches worker safety or call recording.

## Inputs
- ERPNext deterministic checks: `check_consent` (channel, consent_basis), `check_quiet_hours` (now_utc_iso, timezone offset, start/end hour).
- Tenant config `config/tenants/<tenant>.json`: `geography.compliance` (casl_consent_required, quiet_hours 9-20 America/Edmonton) and `communications.consent_policy` (express_or_ebr).
- Existing Communication Event and consent basis on the Lead Envelope / Roof Job.

## Procedure
1. Determine the channel (SMS, Email, Call, Portal) and the recorded consent basis for the recipient.
2. Run `check_consent`. SMS requires express consent; email/call allow express or an existing business relationship; portal is always allowed. If it returns not allowed, stop and record the reason.
3. For outbound messages, run `check_quiet_hours` against the tenant timezone (America/Edmonton, 9 to 20). If outside the window, the action is blocked until the window opens.
4. For a compliant message, preview with `dry_run_communication_event`, then on human approval call `request_record_communication_event` (channel, recipient_ref, consent_basis, request_text, approved_by, approval_token). This records a policy-gated Communication Event at Draft or Blocked and a Hermes Run row. It does not send.
5. For calls, confirm the two-party recording notice is given; for field/production steps, surface the WCB/safety checklist prompt to the crew.
6. Report the consent basis, quiet-hours result, and policy outcome. A human performs the actual send.

## Guardrails
- Never record a Communication Event as Sent; sending is a human action outside these tools.
- Never send SMS without express consent, or any outbound message during quiet hours.
- Never bypass or override a failed `check_consent` or `check_quiet_hours` result.
- Consent basis and quiet-hours evaluation must be logged in the Communication Event `policy_reasons_json`.

## Output
A policy decision (allowed or blocked with reasons) and, when allowed and approved, a record-only Communication Event with its consent and quiet-hours evaluation plus a Hermes Run audit row.
