# Runtime capability signal contract

Status: source-level route contract
Owner: IronWrap OS product owner
Last verified: 2026-08-31
Review trigger: any change to `workers-bus/src/capability-signal.ts`,
`workers-bus/src/capability-signal-api.ts`, the `CAPABILITY_REFERENCE_STATE` table in
`tools/production-readiness.mjs`, or any capability flag or configuration binding in
`workers-bus/wrangler.jsonc`

## Truth boundary

This page is the request/response contract for `GET /api/v1/capabilities`: what a signed-in surface
may honestly say about a capability it cannot use. It exists because a capability that is switched
off, absent from the build, or on-over-missing-configuration were all indistinguishable to the PWA
— a non-office role learned a capability was unavailable from a `404` or a `503` at first use,
which reads identically to a fault.

Both halves are in source: the registry and evaluator are `workers-bus/src/capability-signal.ts`,
the role-scoped read model is `workers-bus/src/capability-signal-api.ts`, and the route is in
`workers-bus/src/app-api.ts`. Contract tests are `workers-bus/test/capability-signal.test.ts`.

**This read model reports reachability. It never reports proof.** `proof_claimed` is a constant
`false`. Whether a capability has been proven against a provider is a different question answered
from different facts by `GET /api/v1/integrations/readiness`
(`workers-bus/src/capability-readiness.ts`), which is office-only and evaluates append-only
manifest and proof rows. A capability can be `available` here and unproven there, and both
statements are true. See [`CAPABILITY-MATRIX.md`](CAPABILITY-MATRIX.md) for current implementation
gaps and [`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](AUTHORITY-AND-EVIDENCE-CONTRACT.md) for the proof
boundary; the architecture map is [`AI-NATIVE-ARCHITECTURE.md`](AI-NATIVE-ARCHITECTURE.md).

## Three facts that never collapse

| Fact | Field | Why it is separate |
|---|---|---|
| Presence | `presence` | Two flags in `wrangler.jsonc` have no consumer in `workers-bus/src`. They name nothing a user gets, so they can never be presented as a switched-off capability. |
| Flag state | `flag_state` | A flag that is on over missing credentials is not "off". An undeclared flag is not the same operator fact as a declared `false`, and a value that is neither `"true"` nor `"false"` is an error, not an off. |
| Configuration | `configuration_state` | Whether the bindings a capability needs are present, missing, or unreadable — independent of whether anyone switched it on. |

`state` is the single value a surface renders, derived from all three. It is never a boolean.

## Route

```
GET /api/v1/capabilities
```

Every authenticated role. No query parameter, header, or body is read: passing `?tenant_id=…`,
`?projection=office`, or a capability name changes nothing. An unauthenticated caller gets `401`
and learns nothing about the deployment's configuration.

Responses carry `cache-control: private, no-store` and every field is derived from the live
bindings on each call, so a configuration change is visible on the next request without a deploy or
a client refresh. Nothing is cached and no value survives a configuration change.

The same read model is embedded as `capabilities` in `GET /api/v1/field/bootstrap`, so a field
device gets it in the one call it makes before going offline.

### Envelope

```json
{
  "version": 1,
  "tenant_id": "ironwrap",
  "role": "sales",
  "projection": "scoped",
  "read_model_generated_at": "2026-08-31T00:00:00.000Z",
  "capabilities": [],
  "proof_claimed": false,
  "configuration_mutations_available": false,
  "allowed_actions": ["capabilities.read"],
  "readback_obligations": false
}
```

`tenant_id` is the authenticated session's tenant and is never taken from the request. Capability
state is a tenant fact: `facet_launch` resolves from the static route set that names *this* tenant
as its destination, so one binding set legitimately yields `available` for one tenant and
`unconfigured` for another.

`readback_obligations` is `true` when at least one capability's state rests on something that must
be read back before it can be settled. A surface must not render those as either working or broken.

### Scoped item — every non-office role

```json
{
  "id": "proposal_template",
  "title": "Proposal document template",
  "presence": "present",
  "state": "unconfigured",
  "reason": "configuration_incomplete",
  "flag_state": "not_flagged",
  "configuration_state": "incomplete",
  "readback_required": false
}
```

No binding names, no declared literals, no dependency graph. Capability state leaks commercial and
infrastructure facts, so a non-office role receives the minimum that lets its UI be honest.

### Office item — `owner` and `ops` only

The scoped item plus the operator detail those two roles already reach through
`/api/v1/integrations/readiness` and `/api/v1/owner/runtime`:

```json
{
  "id": "facet_design_ingest",
  "title": "Facet design delivery",
  "presence": "present",
  "state": "unconfigured",
  "reason": "configuration_incomplete",
  "flag_state": "on",
  "configuration_state": "incomplete",
  "readback_required": false,
  "flag_binding": "FACET_V2_INGEST_ENABLED",
  "flag_declared": "true",
  "missing_configuration": ["FACET_V2_ROUTES_JSON", "FACET_V2_KEYS_JSON"],
  "indeterminate_configuration": [],
  "dependencies": []
}
```

## State vocabulary

| `state` | Meaning | What a surface must show |
|---|---|---|
| `absent` | No consumer in `workers-bus/src`. The id names nothing a user gets. | Nothing. Do not render it as a capability, disabled or otherwise. |
| `off` | In the build, switched off. | Not available. Turning it on is an administrator action. |
| `unconfigured` | On — or mounted with no flag at all — but the configuration it needs is missing. It will fail at first use. | Not configured, and what kind of setup it needs. Never "unavailable": the action may still be offered and will still fail. |
| `dependency_blocked` | On and configured, but something it depends on is not available. | Waiting on the named dependency, not broken. |
| `unknown` | A required input could not be determined. | Neither working nor broken. Carries a readback obligation. |
| `available` | On and configured. Reachable — **not proven**. | Available. Never "verified", "connected", or "proven". |

`reason` is a closed vocabulary that says which of the three facts produced the state:
`no_source_consumer`, `flag_off`, `flag_undeclared`, `flag_value_invalid`,
`configuration_incomplete`, `configuration_rejected`, `configuration_indeterminate`,
`dependency_unavailable`, `dependency_indeterminate`, `flag_on_and_configured`,
`mounted_and_configured`.

`configuration_incomplete` and `configuration_rejected` are different jobs for whoever has to fix
it. The first means a binding is blank and `missing_configuration` names it. The second means every
binding is present and the capability's own parser refused them anyway — a value out of range, a key
set that does not parse, or a static route set with no entry for this tenant — so
`missing_configuration` is empty and pointing at it would send an operator hunting for a blank
binding that does not exist.

`flag_state` is `on`, `off`, `undeclared`, `invalid`, or `not_flagged`. `configuration_state` is
`configured`, `incomplete`, `indeterminate`, or `not_evaluated` — `not_evaluated` is what an `off`
capability reports, because an off capability answers completely from its flag and leaks nothing
about its credentials.

## Registry, audience, and reference state

A role sees a capability when it holds a permission that actually reaches that capability's
surface. The audience is derived from the permission rather than a hand-kept role list, so a
capability cannot leak to a role that could never use it, and a new capability routes itself.

| Capability id | Flag binding | Audience permissions | Roles today | Reference state |
|---|---|---|---|---|
| `quickbooks_oauth` | `QB_OAUTH_ENABLED` | `quickbooks:read`, `accounting:read` | owner, ops, accounting | `off` |
| `quickbooks_final_invoice` | `QB_FINAL_INVOICE_ENABLED` | `quickbooks:read`, `accounting:read` | owner, ops, accounting | `off` |
| `hermes_desktop` | `APP_HERMES_DESKTOP_ENABLED` | `owner:read` | owner, ops | `off` |
| `hermes_hosted_reference` | `APP_HERMES_HOSTED_REFERENCE_ENABLED` | `owner:read` | owner, ops | `off` (flag undeclared) |
| `public_estimator` | `PUBLIC_ESTIMATE_ENABLED` | `sales:read` | owner, ops, sales | `off` |
| `newo` | `NEWO_ENABLED` | `owner:read` | owner, ops | `off` |
| `postiz` | `POSTIZ_ENABLED` | `owner:read` | owner, ops | `off` |
| `facet_design_ingest` | `FACET_V2_INGEST_ENABLED` | `facet:read`, `estimator:read` | owner, ops, sales | `unconfigured` |
| `facet_launch` | `APP_FACET_LAUNCH_ENABLED` | `facet:launch`, `facet:read` | owner, ops | `unconfigured` |
| `facet_native_projection` | `FACET_V2_NATIVE_PROJECTION_ENABLED` | `owner:read` | owner, ops | `dependency_blocked` |
| `facet_frappe_projection` | `FACET_DESIGN_FRAPPE_PROJECTION_ENABLED` | `owner:read` | owner, ops | `off` |
| `facet_design_ingest_v1` | `FACET_DESIGN_INGEST_ENABLED` | `owner:read` | owner, ops | `absent` |
| `facet_quote_revision_prepare` | `APP_FACET_QUOTE_REVISION_PREPARE_ENABLED` | `owner:read` | owner, ops | `absent` |
| `proposal_template` | none | `estimator:read` | owner, ops, sales | `unconfigured` |
| `proposal_publication` | `APP_PROPOSAL_PUBLICATION_ENABLED` | `estimator:read`, `approvals:read` | owner, ops, sales | `off` |
| `document_generation` | `APP_DOCUMENT_GENERATION_ENABLED` | `owner:read`, `production:read` | owner, ops, production | `off` |
| `effect_runtime` | `EFFECT_RUNTIME_ENABLED` | `owner:read` | owner, ops | `available` |

The `field` role holds no permission that reaches any of these, so its capability list is empty by
derivation, not by omission. The envelope still arrives, so a field-facing capability added to the
registry later needs no new mechanism — but no such capability has been named yet, and one is not
invented here.

"Reference state" is the state the committed configuration in `workers-bus/wrangler.jsonc` produces
at the time above. It is recorded in `CAPABILITY_REFERENCE_STATE` in
`tools/production-readiness.mjs` and gated by `node tools/production-readiness.mjs contract`, which
imports this same registry and evaluator rather than restating them. Changing a flag is allowed;
changing one without recording the new state fails the readiness contract.

`wrangler.jsonc` groups its non-secret vars into `CFG_*` JSON bindings to stay under the Cloudflare
Workers variable-count limit (IRO-268); this signal reads the flattened view of those bindings
(`tools/wrangler-vars.mjs`, mirroring `workers-bus/src/env-bindings.ts`), so a flag's name and
behavior are unchanged by which binding carries it.

## What the signal does not know

Configuration presence is not credential validity. This signal reads bindings; it never calls a
provider. A capability reported `available` may still fail against Intuit, Newo, Postiz, or Google
with a rejected credential. That question belongs to the effect runtime and the readback it
records, and to `/api/v1/integrations/readiness` for the proof itself.

Four facts remain unknown from the repository alone and need a named-environment readback rather
than another document:

1. Whether any Worker secret is actually set in a deployed environment.
2. Whether migrations `0042`, `0062` and `0118` are applied in the deployed D1.
3. Whether any `capability_integration_manifests` / `capability_proof_facts` row exists for the
   tenant.
4. Whether the deployed Worker's live vars still match `workers-bus/wrangler.jsonc`.

Within the Worker, (1) and (4) are answered for the request that is running, because a live binding
is what the evaluator reads. They stay unknown to `tools/production-readiness.mjs`, which analyses
the committed file, and that verifier reports secret-backed configuration as `indeterminate` rather
than guessing in either direction.

### Governed readiness declarations

The separate Integrations readiness evaluator reads immutable declarations; it is not the
per-request capability signal above. `POST /api/v1/integrations/manifests` and
`POST /api/v1/integrations/profiles` admit those declarations only when
`APP_READINESS_ADMISSION_ENABLED=true`. The checked-in production and local values are false;
QA's is true so the owner can try the declarations on synthetic data.
An active owner or operations app session must match the current D1 role and supply CSRF. Tenant,
approver and approval time come from the server. A client supplies a stable record ID, the next
version and its expected predecessor; the D1 insert tests the head in the same statement.
Repeating the exact record ID and content returns the stored receipt, while a changed body, stale
head, unknown action or extra field is refused. Responses are private and uncached.
The closed registry's external-effect capabilities cannot be relabelled internal or inbound to
skip auth-scope and effect-runtime checks; historical declarations with such a label remain blocked.

Manifest source pointers, configuration digests and credential-binding digests are approved
declarations, not provider authentication. These commands cannot write
`capability_proof_facts`, execute a provider action, upload secrets, or make the read model ready
without a fresh separately authenticated provider readback. The current Integrations page remains
read-only (`configuration_mutations_available: false` describes that page). Enable the admission
flag only with the Figma-derived owner workflow, an independent proof issuer, exact-head CI and
authenticated QA proof; source checks alone do not authorize it.

## Offline

The field bootstrap carries the signal so a device needs one call, not two, on a bad connection. A
cached capability state is a **hint for rendering only**. The server re-derives and re-enforces on
every write, and a cached `available` never admits an action the server would refuse. This is the
same rule as the rest of the offline contract: cached authority never creates a release.

## For the honest-presentation work

A surface consuming this must:

- Never render an `absent` capability, in any styling.
- Distinguish `off` from `unconfigured` in words. "Not available" is wrong for `unconfigured`: the
  action may still be offered and will still fail, and the fix is configuration, not enablement.
- Never render `available` as proven, verified, or connected.
- Render `unknown` as neither working nor broken, and say a readback is outstanding.
- Treat a missing capability id as "not visible to this role", never as "off".
