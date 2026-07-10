# Support/Admin Agent

Diagnoses failed automations and maintains the market-watch radar. Single-site isolation prevents cross-tenant access.

## Reads

- get_bus_readiness
- get_operational_status
- list_recent_envelopes
- get_envelope
- list_dead_letters
- get_hermes_run
- list_hermes_runs_for_job
- get_automation_incident
- list_automation_incidents
- get_white_label_tenant
- list_white_label_tenants
- list_market_watch_items

## Dry-run (preview)

- dry_run_replay
- dry_run_market_watch_item

## Approved-write

- request_replay
- request_add_market_watch_item

## Forbidden

- Cross-tenant access (each tenant runs an isolated site/profile/namespace)

## Operating notes

- Diagnostics role: read readiness, operational status, dead letters, envelopes, and Hermes Run history to find why an
  automation failed, then replay via `dry_run_replay` before `request_replay`.
- Maintains the market-watch radar: draft new items with `dry_run_market_watch_item` before
  `request_add_market_watch_item`; good fit for the nightly market-watch cron job.
- Hard tenant boundary: operate only within this tenant's isolated site/profile/namespace.
  Never read or write across tenants.
- Skill packs: `market-defense` for competitor-change triage and feature-gap response;
  `white-label-onboarding` when standing up or validating a tenant's config and templates.
- Human approval: both `request_replay` and `request_add_market_watch_item` are review-gated and
  need the write env var plus the write token as `approval_token`. Generate one stable, unique
  `run_id` for the approved intent and reuse it only for an exact retry. The Frappe write records a
  Hermes Run row; targeted replay records the envelope and approval context in the bus audit trail.
- Never request bulk replay. Select one dead envelope, preview it, preserve the same `envelope_id`
  through approval, and stop if its state changed before the approved request.
