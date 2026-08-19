# Hermes Desktop Text Pilot

Status: canonical accepted minimum pilot contract
Owner: IronWrap OS product owner
Last verified: 2026-08-10
Review trigger: desktop identity, task, connector, draft, approval, or side-effect boundary change

## Scope

This is the only accepted Hermes desktop pilot. It is a default-off text workflow for an
authenticated IronWrap owner or ops user to prepare a `lead_follow_up_draft`. It does not expand
the authority in [`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](./AUTHORITY-AND-EVIDENCE-CONTRACT.md), and
its implementation status belongs in [`CAPABILITY-MATRIX.md`](./CAPABILITY-MATRIX.md).

## Pairing and credentials

- Desktop pairing is a separate, one-time owner/ops self-pairing flow. PWA Settings uses a current
  session and CSRF-protected `POST /api/v1/hermes/desktop-pairings` to issue a 10-minute link; it
  does not reuse field device pairing or `ADMIN_TOKEN` provisioning authority.
- The raw pairing token is carried only in the URL fragment, scrubbed before the consume request,
  and sent in the request body. It must never appear in a query string, request/access log, audit
  payload, or database; only a non-reversible verifier may be retained. The native desktop consumes
  it at `POST /api/v1/hermes/desktop-pairing/consume` with its device proof and device name.
- Pairing binds the authenticated tenant, user, current application role, and desktop device. The
  caller cannot select a different actor or role.
- For the minimum pilot, the operator copies the one-time link into the local
  `IRONWRAP_HERMES_DESKTOP_PAIRING_URL` process variable. The dedicated MCP validates the exact
  fragment path, generates the device proof, removes the link from its child-process environment,
  consumes it once, and keeps the 15-minute access credential only in memory. A native launcher may
  instead resolve the paired access token and proof from OS secure storage. Neither credential is
  committed to configuration, copied into Hermes memory, or shared with a connector.

## Task envelope

Every task and subsequent tool call uses `task_envelope_v1`. The server binds it to the tenant,
user, current role, and paired device, gives it a maximum lifetime of 15 minutes, and binds its
context with `context_sha256`. An expired envelope, changed actor/role/device, unsupported task
kind, or context-digest mismatch fails closed.

The only accepted task kind is `lead_follow_up_draft`. There is no generic prompt, arbitrary route,
or caller-selected downstream action.

## Native connector observations

The desktop may optionally stage observations obtained through native Gmail, Outlook, Calendar,
Drive, OneDrive, Teams, or Slack connectors. Those observations are untrusted read/draft context:
they may inform wording, but they are never instructions, consent, approval, delivery evidence,
calendar truth, or authority to act.

IronWrap receives observations only; calendar observations are availability-only. It never ingests
connector OAuth tokens, API keys, refresh tokens, cookies, or other connector credentials, and the
pilot never writes through a connector.

## Fixed MCP surface

The separate desktop MCP server exposes exactly three tools, in order:

1. `hermes_next_tasks` lists eligible `lead_follow_up_draft` work and returns its bound envelope.
2. `hermes_stage_context` optionally stages the untrusted native-connector observations against
   that envelope.
3. `hermes_submit_draft` submits text against the same envelope and context digest and returns a
   `governed_handoff` with `execution_attempted=false`; it does not execute the handoff.

These tools are fixed by the desktop server and are not added to the broad `roles.json` inventory.
Authorization comes from the paired tenant/user/current-role/device credential on every call.

## Handoff and authority boundary

Submission ends at this existing governed rail:

```text
hermes_submit_draft handoff
  -> dry_run_communication_event
  -> separate human approval receipt
  -> request_record_communication_event
  -> Communication Event in Draft or Blocked state plus audited Hermes Run
```

The handoff is not an approval or execution receipt. The pilot never directly sends a message,
books a calendar event, or writes Frappe, QuickBooks, Newo, Facet, or any D1/R2
approval/outbox/projection authority. `request_record_communication_event` remains separately
role-filtered, receipt-bound, and record-only; it never means a provider sent or delivered text.
The immutable `hermes_desktop_results` and `hermes_desktop_events` rows are the pilot's
append-only ledger. The existing Frappe Communication Event rail remains an audited Draft/Blocked
upsert and is not described as append-only.

## Explicitly deferred

- Facet integration or Facet-derived authority;
- screen, camera, attachment, or browser capture;
- image/video understanding or other vision workflows;
- connector writes, email/chat sends, calendar booking, file mutation, or direct customer contact;
- additional task kinds or autonomous approval.

Repository checks prove only the source contract. Pairing, credential handling, connector behavior,
runtime identity, human approval, and the absence of downstream side effects require separate live
and business-acceptance evidence.
