# Field Voice Report

## Purpose
Convert field check-ins and voice/photo evidence into structured checklist updates, an internal progress summary, and a customer-safe draft, without the crew retyping anything. Read-and-draft only.

## When to use
- A crew submits a field check-in with photos or a voice note through the bus.
- The owner wants a progress summary or a customer-safe update built from verified field evidence.

## Inputs
- Bus: `get_envelope` (raw voice/photo/check-in payload before it becomes a record).
- Frappe: `get_roof_job`, `get_field_check_in` / `list_field_check_ins_for_job` (Field Check-in: `status`, `photo_count`, `submitted_at`), `get_evidence_item` / `list_evidence_for_job` (Evidence Item: `evidence_type` Photo/Voice Note, `customer_safe`, `captured_at`).

## Procedure
1. Read the check-in with `get_field_check_in` and its linked evidence with `list_evidence_for_job`. Confirm evidence is attached to the Roof Job, not retyped.
2. Transcribe/interpret the voice note and photos into: checklist status changes, issue flags, and photo captions. Keep raw evidence as the source of truth.
3. Draft an internal progress summary for the owner: what was done, blockers, and open items (check-ins still at `status` Needs Review).
4. Draft a customer-safe update using only `customer_safe` evidence. Strip internal notes, pricing, and any unsafe photo.
5. This skill writes no Frappe record directly. Completion-stage capture flows into the Field Closeout skill (`dry_run_completion_packet` -> `request_create_completion_packet`).
6. If a customer-safe update is to be sent, route it through the comms path (`check_consent` -> `check_quiet_hours` -> `dry_run_communication_event` -> `request_record_communication_event`, record-only).
7. Flag missing required photos against tenant `photo_requirements` (before 4, progress 6, completion 8); do not fabricate counts.

## Guardrails
- Never delete or alter evidence. No delete tool exists; capture is append-only.
- Never send a customer message. Comms and updates are record-only; a human sends.
- Never include non-`customer_safe` evidence or internal pricing in a customer draft.
- Never bypass the completion gate: completion packets require photo evidence and stay review-gated.

## Output
Checklist updates, an internal progress summary, photo captions, and a customer-safe draft, all sourced from verified field evidence.
