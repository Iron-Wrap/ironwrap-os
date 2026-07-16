# Alberta Compliance

## Purpose
Apply Alberta and Canadian rules to any customer-facing action: CASL consent for electronic messages, quiet hours, call-recording notice, and WCB/safety prompts for field work. Compliance is a deterministic gate, not a judgment call.

## When to use
- Before drafting or recording any SMS, email, or call outreach.
- When a field or production step touches worker safety or call recording.

## Inputs
- Frappe deterministic checks: `check_consent` (channel, consent_basis), `check_quiet_hours` (now_utc_iso, timezone offset, start/end hour), plus `get_communication_consent` / `list_communication_consents_for_job` and consent dry-run/write tools.
- Tenant config `config/tenants/<tenant>.json`: `geography.compliance` (casl_consent_required, quiet_hours 9-20 America/Edmonton) and `communications.consent_policy` (express_or_ebr).
- Existing Communication Event and consent basis on the Lead Envelope / Roof Job.

## Procedure
1. Determine the channel (SMS, Email, Call, Portal) and the recorded consent basis for the recipient.
2. Run `check_consent`. SMS requires express consent; email/call allow express or an existing business relationship; portal is always allowed. If it returns not allowed, stop and record the reason.
3. For outbound messages, run `check_quiet_hours` against the tenant timezone (America/Edmonton, 9 to 20). If outside the window, the action is blocked until the window opens.
4. To record consent, preview `dry_run_communication_consent` then call `request_record_communication_consent` only after human approval. Granted requires proof evidence. Revoked requires `revoked_at`, `supersedes`, and a correction reason; Superseded also requires lineage. Consent rows are append-only and never send.
5. For a compliant message, preview with `dry_run_communication_event`, then on human approval call `request_record_communication_event`. This records Draft or Blocked and a Hermes Run row; it does not send.
6. For calls, confirm the recording notice is given; for field/production steps, surface WCB/safety prompts and use evidence-backed safety-plan acknowledgements.
7. Report the consent basis, quiet-hours result, and policy outcome. A human performs the actual send.

## Guardrails
- Never record a Communication Event as Sent; sending is a human action outside these tools.
- Never send SMS without express consent, or any outbound message during quiet hours.
- Never bypass or override a failed `check_consent` or `check_quiet_hours` result.
- Consent basis and quiet-hours evaluation must be logged in the Communication Event `policy_reasons_json`.
- Never overwrite consent history or create Contract Acceptance. Contract Acceptance is strictly read-only, and no agent may accept or sign on a customer's behalf.

## Output
A policy decision (allowed or blocked with reasons) and, when allowed and approved, a record-only Communication Event with its consent and quiet-hours evaluation plus a Hermes Run audit row.
