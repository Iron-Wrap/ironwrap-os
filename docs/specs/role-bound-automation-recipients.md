# Role-bound automation recipients — decision contract

Status: future requirements; not implemented
Owner: IronWrap OS product owner
Last verified: 2026-08-29
Review trigger: changes to the automation-recipient aggregate, team/role identity source, or
automation dispatch and reconciliation.

## Truth boundary

Document templates and fixed automation recipients are already configurable by an owner. Current
source provides **Documents** and **Recipients** configuration tiles, document-template
create/revise/retire/history flows, a tenant-owned recipient catalog, and inline fixed-recipient
creation from the automation rule builder. The inline action is a separate button beside the
recipient selector; a sentinel option is deliberately not placed inside the selector.

This document does not reopen those shipped capabilities. It records the remaining request to let a
recipient follow a company role instead of one fixed address, and the decisions required before
that can be implemented safely. It is not a schema, deployment, or customer-proof claim.

## Current fixed-recipient invariant

Today an automation rule stores an immutable `recipient_ref`, never an address. That reference
resolves through the tenant's active, revisioned recipient catalog:

- the owner supplies a label, immutable reference, closed transport channel, and fixed destination;
- raw destinations exist only in recipient revisions and are returned to admin clients as a mask
  and digest;
- create/revise/retire commands are tenant-scoped, actor-attributed, idempotent, and guarded by
  aggregate version;
- a referenced recipient cannot be retired while an active rule still names it;
- the dispatcher resolves the reference, binds its digest to the invocation, and refuses silent
  destination drift;
- deployment-provided recipients are only a compatibility fallback until the tenant owns any
  recipient rows.

Role-bound delivery must preserve every one of these properties.

## Required role-bound model

A recipient revision must select exactly one resolution mode:

1. **Fixed destination** — the shipped behavior.
2. **Role binding** — a closed IronWrap role plus an explicit delivery policy.

The delivery policy must be stored, reviewed, and versioned with the recipient:

- `single_holder`: exactly one eligible active holder must resolve; zero or multiple holders fail
  closed.
- `all_active_holders`: every eligible active holder is addressed through independently
  idempotent delivery effects; zero holders fails closed.

There is no implicit policy. Inferring one from current team size would let the same recipient
change meaning when a person joins or leaves.

The role value must come from the same closed role vocabulary used by tenant authorization. Free
text, arbitrary email lists, and role names supplied by a model are rejected.

## Authoritative identity prerequisite

Implementation is blocked until one tenant-scoped identity source can answer all of the following
without querying Frappe desk state from the browser:

- active company members for a closed role;
- stable member identity;
- one verified notification email per eligible member;
- active/suspended status and the version or digest of the resolved membership set.

Missing, unverified, duplicated, cross-tenant, or suspended identities are not skipped silently.
Resolution fails with an operator-visible reason before provider work begins.

## Resolution and evidence semantics

The rule continues to store only `recipient_ref`. On the first dispatch lease:

1. Resolve the active recipient revision.
2. Resolve the eligible role holders using the stored delivery policy.
3. Canonically sort the stable member identities and destinations.
4. Compute and persist a resolution digest without persisting raw destinations in the invocation.
5. Re-read before every provider attempt and require the same digest.

If role membership or a verified destination changes after the digest is bound, the invocation
stops as reconciliation-required rather than following the new membership silently.

For `all_active_holders`, each destination needs its own effect identity, provider idempotency key,
attempt state, and receipt. One successful send must not hide another failed send, and a retry must
not resend destinations already proven delivered. Aggregate success exists only when every bounded
effect has a terminal success receipt.

The durable outcome must name the recipient reference, recipient revision, role, policy, resolved
member identities, membership digest, destination digests, and per-effect receipts. It must never
publish a raw address through admin, rule, invocation, incident, or receipt APIs.

## Admin user flow

The existing **Recipients** tile remains the entry point. The existing fixed-recipient form remains
the default and the rule builder keeps its separate **Add a recipient** button.

When the identity prerequisite exists, the recipient form may add a labelled **Delivery follows**
choice:

- **One email address** shows the shipped address field.
- **A company role** shows role and delivery-policy selectors and no address field.

The choice is part of the revision. Changing modes or changing role/policy appends a revision and
warns that active rules keep the same reference but future invocations resolve through the new
revision. Existing invocations retain their bound digest and never retarget.

List/detail/history views show a role badge and policy, not member email addresses. The form must
explain `single_holder` zero/multiple-holder refusal and `all_active_holders` fan-out before save.
Owner-configuration guards, cached read-only offline behavior, 44px targets, visible focus, and
stale-version/refusal states follow the existing Recipients surface.

## Failure contract

At minimum, callers and operators must distinguish:

- role binding unsupported because the identity source is not configured;
- unknown or disallowed role;
- no eligible active holder;
- multiple eligible holders under `single_holder`;
- member missing a verified notification destination;
- membership/destination digest changed after invocation binding;
- partial fan-out requiring reconciliation;
- provider refusal or uncertain delivery for one bounded effect.

None of these may fall back to a deployment recipient or a previously stored fixed address. A
role-bound recipient either resolves under its current reviewed revision or fails closed.

## Backward compatibility

- Existing fixed recipients and rules remain byte-for-byte meaningful.
- No migration may infer a role from a recipient label such as `shop` or `owner`.
- Deployment fallback behavior remains unchanged for tenants with no recipient rows.
- Adding the first role-bound tenant recipient takes ownership of the tenant catalog under the same
  explicit takeover warning as adding the first fixed recipient.

## Acceptance evidence required before implementation is called delivered

- migration tests for fixed and role-bound revisions, rollback/restore, and mixed catalogs;
- tenant-isolation and closed-role validation tests;
- zero/one/many-holder tests for both policies;
- verified-destination and suspended-member refusal tests;
- exact digest-drift tests between invocation, lease, retry, and reconciliation;
- per-destination idempotency and partial-fan-out recovery tests;
- owner UI tests for create/revise/retire/history, offline refusal, stale version, keyboard, touch,
  390px layout, and accessible labels;
- one provider-stub end-to-end flow proving receipts without exposing raw destinations;
- hosted exact-head CI, then separate deployment/runtime proof.

No real customer, business-acceptance, or production claim follows from source/tests alone.

## Related source truth

- `workers-bus/src/automation-recipients.ts`
- `workers-bus/src/pipeline-automation.ts`
- `app/src/admin/automation-recipient-form.tsx`
- `app/src/admin/automation-recipients-configuration-page.tsx`
- `app/src/admin/automation-configuration-page.tsx`
- `docs/TEMPLATE-MARKETPLACE-REQUIREMENTS.md`
