# Product Events

Status: Target
Owner: IronWrap OS product owner
Last verified: 2026-11-06
Review trigger: event boundaries, privacy rules, integration provenance, or Workers Analytics Engine limits change
Source SHA: `68bf878f443ff97cfa14218630a4d63df1b6de2c`

## Scope and authority

This contract defines the tenant-neutral product events proposed for Workers Analytics Engine
(WAE) and per-tenant Grafana metrics. It follows the
[documentation contract](./DOCUMENTATION-CONTRACT.md) and
[authority and evidence contract](./AUTHORITY-AND-EVIDENCE-CONTRACT.md).
D1 remains business and audit truth; R2 remains evidence storage. WAE is a best-effort
analytical projection, never legal/audit proof or authority to perform an action.

Every hook below is a proposed insertion boundary in existing source. This document adds no
producer, binding, migration, instrumentation, dashboard, or deployed behavior. It covers the
specification slice of [product analytics](https://github.com/Iron-Wrap/ironwrap-tracker/issues/87)
within the [observability epic](https://github.com/Iron-Wrap/ironwrap-tracker/issues/85).
Integration removals and branding decisions remain in the
[white-label scope](https://github.com/Iron-Wrap/ironwrap-tracker/issues/84).

Events follow durable business success. Replayed requests, rejected attempts and duplicate
queue deliveries do not create another successful-action point. A separately authorized new
action, such as a newly minted sign-in link or a later quote republication, can create a point.
Producer errors must not fail business actions. There is no exactly-once guarantee across a
business commit and a WAE write: crashes can lose points and sampling can omit them. Sample
weights cannot restore actions that were never written.

The future implementation must expose first-insert and first-transition ownership where the
current functions do not retain it, and verify the matching durable readback. A pre-read alone
does not prove that an invocation won a concurrent insert. This contract does not prescribe an
outbox or migration. Structural document validation does not prove event emission or metric accuracy.

## Positional schema v1

Use a fixed allowlist and ordered arrays, with no raw object spreading or arbitrary properties.
The layout occupies 11 blobs and 5 doubles. SQL columns are one-based positional names.

- `blob1=event_name`: exactly one catalogue name below.
- `blob2=schema_version`: literal `v1`.
- `blob3=environment`: `local`, `qa`, or `production`, from trusted deployment configuration.
  No product environment-name variable exists today: [Worker configuration](../workers-bus/wrangler.jsonc)
  has top-level configuration plus `env.local` and `env.qa`. The later per-environment analytics
  binding change must add an explicit trusted environment setting, including `production` for
  the top-level deployment. Never infer it from a hostname, Worker name, request, or provider setting.
- `blob4=actor_id`: pseudonym of an app user established by a validated session, invitation claim,
  or consumed sign-in/pairing token. Anonymous customer/voice actions leave this empty.
- `blob5=actor_role`: the server's effective app role for that user; `customer` for anonymous
  customer actions, `system` for automatic actions. Never invent an actor from an email,
  signer name, user agent, or IP address.
- `blob6=entity_id`: pseudonym of the action's durable entity, as specified per row.
- `blob7=job_id`: pseudonym of the validated owned `roof_job_id`, when established.
- `blob8=channel`: `office`, `public`, or `voice` only for lead creation; empty elsewhere.
- `blob9=outcome`: the row's fixed successful outcome enum.
- `blob10=origin`: the row's fixed origin enum, independent of provider names.
- `blob11=entity_group_id`: pseudonym of the related durable group, as specified per row.

All identifier blobs follow the privacy encoding below. Absent strings are `""`. User actor,
entity and group references share the `app_user_id` namespace. Invitation groups share
`invite_id`. Both quote events and contract acceptance share `customer_quote_id` for their group;
all job identifiers share `roof_job_id`. Other entity/group kinds are `lead_id`,
`publication_event_id`, `quote_revision_id`, `decision_id`, `acceptance_id`, `device_id`, and
`receipt_id`, as appropriate to the row. Preserve these namespaces across related events.

- `double1=1`: one successful action, before sampling.
- `double2=duration_ms`: non-negative elapsed milliseconds only for definitions below;
  `-1` when unavailable, missing, invalid, or negative. Zero is a real duration, never an unknown sentinel.
- `double3=byte_size`: stored upload bytes only; `-1` for every other event.
- `double4=occurred_at_ms`: the durable business timestamp as Unix milliseconds.
- `double5=first_for_entity_group`: `1` for the first durable success of this event name for its
  group, `0` for a later success, `-1` when not established. Establish it from authoritative D1
  state, never sampled WAE queries. A missing historical first point does not make a later action first.

Every row has `indexes=[tenant_id]` (that is, `indexes = [tenant_id]`): exactly one trusted,
opaque configured tenant key, at most 96 bytes in UTF-8. Resolve it from the authenticated
session plus configured tenant, or from the durable entity's tenant with a match check.
Never use a raw request-provided index, tenant display name, truncation, reassignment, or a
fallback/shared tenant. Emit no point for unknown tenant identity or a tenant mismatch.
The index is a sampling and query dimension, not an authorization boundary.

WAE supplies ingestion `timestamp`. Business time in `double4` can precede it when queues or
retries delay delivery; the two clocks are not interchangeable.

## Event catalogue

The common blob order above and `double1=1`, `double4=occurred_at_ms` apply to every row.
Actor roles follow the effective-role rule unless a row explicitly specifies `customer`,
`system`, or `field`. All IDs named in this table mean encoded owned IDs, never raw credentials.

| Event name | Existing source and proposed emission boundary | Row-specific blobs, doubles, group and index |
| --- | --- | --- |
| `sign_in_link_requested` | [Auth source](../workers-bus/src/app-auth.ts), `workers-bus/src/app-auth.ts:deliverMagicLink`: after `replaceMagicLink` and the accepted request audit; never the indistinguishable HTTP 202 in `requestMagicLink`. | Actor/entity/group=authorized user; role from user; job/channel empty; outcome=`issued`; origin=`sign_in` or `invite_accept` from the existing caller detail code. Each newly minted link is one action even if email delivery later fails. Unknown/throttled/field-user requests mint no link and emit no success point. `double2=-1`, `double3=-1`, `double5=-1`; `indexes=[tenant_id]`. |
| `sign_in_link_consumed` | [Auth source](../workers-bus/src/app-auth.ts), `workers-bus/src/app-auth.ts:consumeMagicLink`: after tenant/role checks and successful `insertSession`. | Actor/entity/group=user; job/channel empty; outcome=`session_created`; origin=`sign_in`. Token reuse and rejection emit nothing; never include a session or magic-link token/hash. `double2=-1`, `double3=-1`, `double5=-1`; `indexes=[tenant_id]`. |
| `user_invited` | [Invite source](../workers-bus/src/app-user-invites.ts), `workers-bus/src/app-user-invites.ts:createUserInvite`: after `issueUserInvite` returns a durable invite, before email delivery. | Actor=inviter; entity/group=invite ID; job/channel empty; outcome=`issued`; origin=`office`. Re-send through `resendUserInviteForOffice` is excluded; no recipient email or display name. `double2=-1`, `double3=-1`, `double5=1` for the newly created invite; `indexes=[tenant_id]`. |
| `invite_accepted` | [Invite source](../workers-bus/src/app-user-invites.ts), `workers-bus/src/app-user-invites.ts:acceptUserInvite`: after a successful `claimUserInvite` or successful `settleUserInviteWithoutGrant`, before `acceptanceBody`. | Actor/entity=accepted user; group=invite ID, matching the invitation namespace; job/channel empty; outcome=`accepted` or `already_active`; origin=`invite`. `double2`=durable acceptance time minus invite creation time in milliseconds, or `-1` if unavailable/invalid/negative; `double3=-1`, `double5=1` for the winning acceptance. Expired/revoked/replayed/losing claims emit nothing; `indexes=[tenant_id]`. |
| `lead_created` | [Operating source](../workers-bus/src/operating-core.ts), `workers-bus/src/operating-core.ts:materializeOperatingCore`: after the `operating_leads` insert and `assertCommittedOperatingCore`, only when this invocation created that lead. | Actor=validated office receipt user when available, otherwise empty/system; entity/group=lead ID; job=roof job ID; outcome=`created`; channel=`office`, `public`, or `voice`; origin=channel. Capture the first-insert result in the later implementation: the current function discards batch results. Follow provenance below. `double2=-1`, `double3=-1`, `double5=1` for the new lead; `indexes=[tenant_id]`. |
| `quote_sent` | [Commercial source](../workers-bus/src/commercial-store.ts), `workers-bus/src/commercial-store.ts:recordCommercialProposalPublication`: on `kind: created` with `state=published`, after verified publication readback. Reached through [app API](../workers-bus/src/app-api.ts), `workers-bus/src/app-api.ts:settleCommercialProposalPublication`. No point on preparation, draft document creation, withdrawal, or replay. | Entity=publication event ID; group=customer quote ID; job=roof job ID; actor=validated permit actor when an app user, otherwise empty/system; outcome=`published`; origin=`office`; channel empty. `double2`=publication `occurred_at` minus originating lead capture `operating_core_events.occurred_at`, resolved as below, or `-1` if missing/invalid/negative; `double3=-1`; `double5=1` for first publication of this quote group, `0` on later republications, `-1` if not established. Provider success does not prove customer reading; `indexes=[tenant_id]`. |
| `quote_approved` | [Commercial source](../workers-bus/src/commercial-store.ts), `workers-bus/src/commercial-store.ts:recordCommercialQuoteRevision`: on `kind: created` with persisted `status=approved`. Reached through [app API](../workers-bus/src/app-api.ts), `workers-bus/src/app-api.ts:createCommercialQuoteRevision`. | Entity=quote revision ID; group=customer quote ID; job=roof job ID; actor from validated authority as for publication; outcome=`approved`; origin=`office`; channel empty. Internal approval before send, not customer acceptance. `double2=-1`, `double3=-1`; `double5=1` for first approved revision in this quote group, `0` for later approvals, `-1` if not established; `indexes=[tenant_id]`. |
| `portal_decision` | [Decision source](../workers-bus/src/customer-portal-decision.ts), `workers-bus/src/customer-portal-decision.ts:settleDecisionIntent`: only when `finalizeDecisionIntent` succeeds with `state=recorded`. | Entity/group=decision ID; job=roof job ID; actor empty/customer; outcome=`option_selected`; origin=`portal`; channel empty. The action selects an approved option; no invented rejection, decline, or view events. Exclude uncertain, receipt-only and replay paths. `double2=-1`, `double3=-1`, `double5=1` for first recorded decision; `indexes=[tenant_id]`. |
| `contract_accepted` | [Acceptance source](../workers-bus/src/customer-contract-acceptance.ts), `workers-bus/src/customer-contract-acceptance.ts:commitNativeAcceptance`: after this invocation's first committed transition to `accepted` and matching `commercial_acceptance_bindings` readback checked by `workers-bus/src/customer-contract-acceptance.ts:nativeTerminalResponse`. | Entity=acceptance ID; group=customer quote ID; job=roof job ID; actor empty/customer; outcome=`accepted`; origin=`portal`; channel empty. Do not emit on every `nativeTerminalResponse` call: it also serves replay/recovery. Later instrumentation must retain transition ownership and the matching-binding check. No signer, consent text, or receipt object content. `double2=-1`, `double3=-1`; `double5=1` for first acceptance for the quote group, `0` for later successes, `-1` if not established; `indexes=[tenant_id]`. |
| `crew_device_paired` | [Auth source](../workers-bus/src/app-auth.ts), `workers-bus/src/app-auth.ts:consumeDevicePairing`: after a successful store claim commits device and session with the matching tenant. | Actor=paired field user; entity=device ID; group=user; role=`field`; job/channel empty; outcome=`paired`; origin=`crew`. QR issuance/rejection is excluded. Device proof, device-proof hash, pairing token and session are forbidden. `double2=-1`, `double3=-1`; `double5=1` for first successful pairing for this user, `0` on later pairings, `-1` if not established; `indexes=[tenant_id]`. |
| `upload_stored` | [Upload source](../workers-bus/src/evidence-uploads.ts), `workers-bus/src/evidence-uploads.ts:handleEvidenceUpload`: after R2 readback, successful new receipt insert and `assertEvidenceAvailable`, immediately before the `result: stored` 201 response. | Actor=authenticated user; entity/group=receipt ID; job only if validated from the bound target, otherwise empty; outcome=`stored`; origin=`crew` for a field session, otherwise `office`; channel empty. `double2=-1`, `double3=row.byte_size`, `double5=1` for the new receipt. Replayed and concurrent-winner responses emit nothing. No filename, R2 key, content digest, target free text, or uploaded contents; `indexes=[tenant_id]`. |

## Provenance and clocks

The central lead materializer is reached by:

- [App API](../workers-bus/src/app-api.ts), `workers-bus/src/app-api.ts:handleOfficeLeadCreate`,
  and [office intake](../workers-bus/src/office-lead-intake-store.ts),
  `workers-bus/src/office-lead-intake-store.ts:recordOfficeIntake`, through
  [lead ingestion](../workers-bus/src/lead-intake.ts), `workers-bus/src/lead-intake.ts:ingestLead`,
  and the queue. This authenticated path is `office`, including an office-recorded phone/referral lead.
- [Public estimates](../workers-bus/src/estimates.ts),
  `workers-bus/src/estimates.ts:tryMaterializeEstimate`: the public estimate/web path is `public`.
- [Existing voice adapter](../workers-bus/src/newo.ts),
  `workers-bus/src/newo.ts:projectNewoSessionToNativeCore`: the validated voice integration path is `voice`.

Do not infer voice solely from `rec.source === "phone"`: office intake also uses that value.
Client-provided `entered_in`, `provider`, and `source_detail` are not trusted provenance without
route/receipt validation. Legacy sources without established route provenance emit no v1
`lead_created` point until classified; do not guess or invent a fourth channel. Existing provider
names belong only in explanatory source references, never event names, blob enums, or dataset examples.
Exclude release-smoke fixtures from product metrics through trusted provenance before writing points.

For quote latency, resolve the originating lead through the publication's quote/job relationship
and the same tenant's `operating_roof_jobs.lead_id`. Use the matching
`operating_core_events.occurred_at` with `event_type=operating_core_materialized`,
`entity_type=lead`, the lead ID and its `source_envelope_id`. This durable timestamp records
`rec.ts || rec.created_at` in `workers-bus/src/operating-core.ts:materializeOperatingCore`.
It represents source capture occurrence. Do not substitute `operating_leads.created_at`:
that column is initialized from `rec.updated_at || rec.ts` and can reflect later processing.
Publication time is `commercial_proposal_publication_events.occurred_at`. Parse both as instants
and subtract in milliseconds; unavailable, ambiguous, invalid or negative endpoints yield `-1`.
For `lead_created`, `double4` likewise uses the matching durable lead occurrence timestamp.

## Privacy

No personal data may enter blobs: names, emails, phone numbers, addresses, IPs, user agents,
filenames, free text, raw payloads, tokens, credential hashes and provider message identifiers
are forbidden. Never include authentication tokens, session identifiers, their hashes, device
proofs or their hashes. A hash of an email, phone number or name is not a permitted workaround.

The only identity inputs are validated, owned opaque IDs. For every nonempty identifier blob,
encode consistently as lowercase SHA-256 of the UTF-8 canonical JSON tuple
`["product-events.v1", tenant_id, entity_kind, opaque_id]` (compact JSON array, no added whitespace,
using the exact validated ID strings). Use the namespaces defined above so related IDs match
across events. This is tenant-scoped pseudonymization, not anonymity. Do not derive IDs from
provider message identifiers or credentials. Hashing does not establish tenant ownership.

The tenant index is the opaque configured tenant key, not a customer/company display name.
Examples use only `tenant_demo` and generated IDs such as `appu_demo_0001` before encoding;
never copy real account values. The schema accepts only the fixed enums and numeric fields,
so a payload cannot smuggle free text into an unused blob position.

## Platform limits and producer validation

Per the [Cloudflare limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/),
WAE allows at most 20 blobs, 20 doubles, one index of 96 bytes maximum, 16 KB aggregate blob
data per point, and 250 points per Worker invocation. It has 3-month retention. This contract's
11 blobs and 5 doubles fit within those limits. Once data ages out, WAE cannot reconstruct
the historical cohort.

The future producer must reject invalid shapes and oversized tenant keys, validate finite
numeric values and the defined sentinels, and cap analytical writes within the invocation
budget, shared across all event calls. It must never truncate or reassign a tenant key to fit.
Failure or budget exhaustion drops analytical writes without changing the business outcome.

## Grafana consumer

Use the Altinity ClickHouse datasource with URL
`https://api.cloudflare.com/client/v4/accounts/<id>/analytics_engine/sql`, other authentication
settings off, and a custom `Authorization: Bearer <token>` header, as described in
[Cloudflare's Grafana guidance](https://developers.cloudflare.com/analytics/analytics-engine/grafana/).
The token needs Account Analytics Read (`Account | Account Analytics | Read`) scoped to the account;
see the [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).
Store the future token in the approved secret store, never Git or browser code. Every query must
filter environment and tenant. Those filters and the tenant index are not authorization boundaries
for an account-wide token; restrict datasource access accordingly. This document provisions nothing
and requires no credentials or live endpoint calls.

## Sampling and query examples

`product_events` below is a logical example dataset, not a binding declaration. Following
[Cloudflare sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/),
event totals use `SUM(_sample_interval)`. Weighted sums and means estimate population values;
they do not recover missing identities or make distinct counts, cross-event joins, or exact
cohorts correct under sampling. Sampled totals are not exact users, exact cohort conversion,
or legal/audit proof.

Example: estimated published actions for one tenant/environment/schema in a bounded UTC window:

```sql
SELECT SUM(_sample_interval) AS estimated_publications
FROM product_events
WHERE index1 = 'tenant_demo'
  AND blob3 = 'qa'
  AND blob2 = 'v1'
  AND blob1 = 'quote_sent'
  AND timestamp >= toDateTime('2026-11-01 00:00:00')
  AND timestamp < toDateTime('2026-11-02 00:00:00')
```

Example: weighted time to first quote, omitting unavailable durations and guarding a zero denominator:

```sql
SELECT IF(SUM(_sample_interval) > 0,
          SUM(_sample_interval * double2) / SUM(_sample_interval),
          NULL) AS estimated_mean_time_to_first_quote_ms
FROM product_events
WHERE index1 = 'tenant_demo'
  AND blob3 = 'qa'
  AND blob2 = 'v1'
  AND blob1 = 'quote_sent'
  AND double5 = 1
  AND double2 >= 0
  AND timestamp >= toDateTime('2026-11-01 00:00:00')
  AND timestamp < toDateTime('2026-11-02 00:00:00')
```

These examples use ingestion time. Derive occurrence-time windows explicitly from `double4`
when measuring business cohorts, and allow for delayed points. Do not compare ingestion-time
and occurrence-time totals as though their clocks matched. The examples are proposed SQL,
not results from a live dataset.

## Derived metrics

All metrics select one tenant and environment, schema `v1`, and a bounded UTC observation
window within retention. Exclude release-smoke fixtures. Report missing data as unavailable;
a zero denominator never means 0%. Exact cohort calculations need authoritative D1 relationships
and complete endpoints even where WAE supplies useful trends.

### Speed to lead

Population: owned leads captured in the selected lead-capture cohort. Intended duration:
lead capture occurrence to first response, in milliseconds, observed through a stated cutoff.
None of the 11 events records a first response, so v1 WAE alone cannot measure this interval.
[Notification source](../workers-bus/src/notify.ts), `workers-bus/src/notify.ts:sendInstantAck`,
and D1 `lead_ack_receipts` provide a separately labelled automated provider-acceptance proxy.
It proves neither delivery/read nor human response. A later response event or authoritative
D1-derived response measurement is required; quote-send time is not speed to lead.

### Funnel conversion

Population: distinct leads/jobs captured in the selected occurrence-time cohort within retention,
followed through the stated observation cutoff. Progression is lead created → internal quote
approved → quote sent → portal decision / contract accepted. Portal decision is optional, not
necessarily a prerequisite for acceptance. For an exact stage ratio, the numerator is distinct
cohort leads/jobs reaching the stage and the denominator is distinct eligible cohort leads/jobs
at the preceding stage. Match job and quote identities in D1. Weighted stage totals are trend
estimates, not same-cohort conversion; a zero denominator is unavailable. Job-creation and invoice
events are absent from v1 and remain future stages.

### Quote win rate

Population: quote groups first sent in the same selected occurrence-time cohort, observed until
a stated cutoff. Numerator: accepted quote groups; denominator: sent quote groups, each counted
at most once. Customer acceptance is `contract_accepted`, never internal `quote_approved`.
Period weighted first-event ratios may be shown only as approximate activity ratios, not an
exact cohort win rate. Refunds, withdrawals, loss reasons and revisions need authoritative D1
interpretation. Without complete cohort matching the exact metric is unavailable.

### Time to quote

Population: first confirmed publications per quote group during the selected window. Duration
is publication `commercial_proposal_publication_events.occurred_at` minus originating lead
`operating_core_events.occurred_at`, resolved by the tenant/job/lead provenance above, in milliseconds.
Filter `quote_sent` by `double5=1` and `double2>=0`; use the weighted mean above. Its numerator
is `SUM(_sample_interval * double2)` over valid first-publication durations and its denominator
is `SUM(_sample_interval)` over those same points. Omit missing/negative durations and report
unavailable on a zero denominator. Preparation, internal approval and a regenerated document
are not sending. Do not average unknowns as zero or substitute lead processing time.

### Portal engagement

Population: successful portal option decisions and contract acceptances in the selected window.
Report weighted `portal_decision` and `contract_accepted` counts separately as action volume;
no visitor denominator exists in v1. Visitor/session rate, view-to-decision conversion and unique
customers are unavailable without view/session instrumentation and a denominator. A decision
plus acceptance is not two unique visitors.

### Tenant activation

Population: each selected tenant/environment during the bounded retention window. Report observed
milestones separately: first sign-in consumption, an invitation accepted with `outcome=accepted`,
first lead, first sent quote and first paired crew user. Each milestone's endpoint is its durable
successful event time; no onboarding start endpoint or provisioned-tenant denominator exists in v1.
Do not invent an onboarding SLA or activation percentage without provisioned-tenant/start-time
data. First observed within WAE retention is not necessarily lifetime first; sampling or lost
points can hide a milestone.

### Crew adoption

Population: eligible active field users for the tenant at the stated measurement cutoff.
Numerator: distinct users successfully paired by that cutoff; denominator: eligible active field
users at the same cutoff. Separately report distinct field actors performing `upload_stored`
during the rolling 30-day UTC window ending at that cutoff as a limited activity signal.
Eligibility, revocations and complete distinct-user membership come from D1; device count is
not user count. Weighted pairing/upload totals are trends only. Pairing alone does not establish
ongoing field-work adoption; exact adoption is unavailable from sampled WAE alone.

### WAU/MAU per tenant

Population: nonempty authenticated actor IDs performing successful product actions in rolling
7-day and 30-day UTC windows ending at a stated cutoff, filtered by tenant/environment.
The counts are distinct weekly/monthly actors; if showing their ratio, weekly actors are the
numerator and monthly actors the denominator. Exclude automatic/anonymous actions and sign-in-link
issuance alone. This covers only the listed actions, not all application activity. Exact distinct
users require unsampled authoritative activity data; never multiply distinct counts by
`_sample_interval`. With sampled WAE alone, label observed distinct users as incomplete and
WAU/MAU exactness unavailable. Broader activity instrumentation is later work.

## Source evidence and follow-up boundary

Existing behavior is also described by these source tests; listing them does not claim a test run
or an analytics implementation:

- [Authentication](../workers-bus/test/app-auth.test.ts) and
  [invitations](../workers-bus/test/app-user-invites.test.ts).
- [Office intake](../workers-bus/test/office-lead-intake.test.ts) and
  [native lead queue](../workers-bus/test/native-lead-queue.test.ts).
- [Commercial publication](../workers-bus/test/commercial-proposal-api.test.ts).
- [Portal decisions](../workers-bus/test/customer-portal-decision.test.ts) and
  [contract acceptance](../workers-bus/test/customer-contract-acceptance.test.ts).
- [Evidence uploads](../workers-bus/test/evidence-uploads.test.ts).

Later work must implement the producer's trust/shape checks, transition ownership, durable first
flags, validated route provenance and trusted environment setting, with tests. Bindings, token
creation, datasource/panels, deployment, live data and the five-minute QA proof remain separate
work. Review this contract when integrations or event boundaries change before adopting it.
