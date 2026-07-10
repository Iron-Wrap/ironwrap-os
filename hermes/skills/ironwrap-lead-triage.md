# IronWrap Lead Triage

## Purpose
Qualify a new lead, score urgency, attribute its source, and flag missing information so a human can act fast. Read-only classification plus an optional record-only first-response draft.

## When to use
- A new envelope lands on the bus (website, call, form, email, ad) and needs qualification.
- An Instant Estimate Session was created and needs to be turned into a qualified lead.
- The owner or Sales Desk asks "what is this lead and what is missing?"

## Inputs
- Bus: `list_recent_envelopes`, `get_envelope` (canonical envelope, raw payload, source).
- Frappe: `list_untriaged_lead_envelopes`, `get_lead_envelope` (Lead Envelope), `get_roof_job` (Roof Job), `get_instant_estimate_session` / `list_instant_estimate_sessions_for_job` (Instant Estimate Session).
- Comms history: `list_communication_events_for_lead` for the exact envelope; use `list_communication_events_for_job` only when a verified linked job exists. Run `check_consent` / `check_quiet_hours` before any draft.

## Procedure
1. Start from `list_untriaged_lead_envelopes`, then read the exact raw envelope with `get_envelope`; note channel, brand (ironwrap vs iroof by sender_domain), timestamp, and consent field.
2. Read the mapped `get_lead_envelope` and any linked `get_roof_job` to confirm the bus event became an IronWrap OS Frappe record. If counts do not match, flag a reconcile gap; do not invent records.
3. Classify service type against tenant services (roofing, metal_roofing, siding, gutters, soffit_fascia) and set urgency (emergency leak / active damage = high).
4. Attribute source from the envelope (organic, GBP, ad, referral, form) and record the brand.
5. Run a missing-info check: name, address/service area (Edmonton / Greater Edmonton / Alberta), contact method, consent basis, service, and any Instant Estimate Session link. List every gap explicitly.
6. Read `list_communication_events_for_lead` to distinguish recorded history from a proposed first touch. It never sends a message.
7. Preview the local classification with `dry_run_mark_lead_triaged` using a bounded, factual `triage_summary`. Inspect the exact four-field patch: `triage_status`, `triaged_by`, `triaged_at`, and `triage_summary`.
8. On human approval, call `request_mark_lead_triaged` with the same lead and summary, `request_text`, `approved_by`, `run_id`, the server-issued `dry_run_receipt`, and a signed `approval_receipt`. It writes a Hermes Run audit row. It must not alter the Lead Envelope transport `status` or any Communication Event.
9. If a first-response draft is warranted: call `check_consent` (channel + consent_basis) and `check_quiet_hours` first. Then `dry_run_communication_event` to preview the policy-gated record.
10. On separate human approval, call `request_record_communication_event` with `request_text`, `approved_by`, and `dry_run_receipt` plus a signed `approval_receipt`. The record is Draft or Blocked, never Sent, and writes its own Hermes Run audit row.
11. Hand the owner: qualification summary, urgency, source, missing-info list, the Lead Envelope triage result, and (if drafted) the Communication Event id for a human to send.

## Guardrails
- Never promise a price, discount, or binding quote. No estimate or takeoff write tools belong to this skill.
- Never send a message. Comms are record-only; a human sends.
- Never fabricate a lead, address, or consent basis. Missing data is reported, not filled.
- Never mutate Lead Envelope transport `status`; the bus owns that field. Never use lead triage to create, update, or imply a Communication Event.
- Never mutate accounting or gates.

## Output
A lead qualification brief (service, urgency, source, brand, missing-info list); when approved, a four-field Lead Envelope triage annotation with its Hermes Run audit row; and, separately when warranted and approved, one review-gated Communication Event Draft with its own Hermes Run audit row.
