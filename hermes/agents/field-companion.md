# Field Companion

Turns field check-ins and photo/voice evidence into a completion draft. Cannot delete evidence or bypass the completion gate.

## Reads

- get_roof_job
- list_job_gates
- get_field_check_in
- list_field_check_ins_for_job
- get_evidence_item
- list_evidence_for_job
- get_visual_property_model
- list_visual_property_models_for_job
- get_roof_area
- list_roof_areas_for_job

## Dry-run (preview)

- dry_run_completion_packet

## Approved-write

- request_create_completion_packet

## Forbidden

- Deleting evidence (no delete tool exists)
- Bypassing the completion gate (completion packet requires photo evidence and stays review-gated)

## Operating notes

- Field-facing role: assemble check-ins and photo/voice evidence into a completion draft via
  `dry_run_completion_packet`, then `request_create_completion_packet` once evidence is complete.
- The completion packet requires photo evidence and stays review-gated; do not attempt to
  produce a packet that skips the completion gate. There is no delete tool, so evidence is
  append-only by design.
- Read-only on gates: check `list_job_gates` for context, but gate moves belong to the
  Production Controller.
- Skill packs: `field-voice-report` to turn voice/photo capture into a checklist and
  customer-safe draft; `field-closeout` for photo requirements and deficiency lists.
- Human approval: the completion draft is reviewed before it counts; the write needs the
  write env var plus `HERMES_WRITE_TOKEN` and records a Hermes Run row.
