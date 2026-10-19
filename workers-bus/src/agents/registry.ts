// The Worker action registry: the Worker-owned half of every catalog action. The contract fixes
// each action's class, owners and delegability (catalog.ts); this file owns its argument schema
// (strict, so an unknown field is refused) and how a permitted step executes. Every contract
// action id appears here exactly once (test/agents-policy.test.ts); an action whose arguments
// are not registered yet abstains with `policy_missing` instead of running on a guess.
//
// Argument conventions (AI-TEAM-CONTRACT.md "Argument conventions"): money in integer minor units
// plus an ISO 4217 code, BCP 47 language tags, `<aggregate>_id` ids, a `reason_code` from a closed
// vocabulary, and recipients as `to`, a canonical contact id. A reference that carries its kind is
// `<kind>_ref`: `person:<id>`, `device:<id>`, or a signal's fact id, `signal/<id>`.

import { ROLE_PERMISSIONS } from "../app-types.ts";
import { COMPETENCY_KIND } from "../authority-record-native.ts";
import { EXTERNAL_ISSUER_AUTHORITY_KINDS, type AuthorityRequirement } from "../authority-records.ts";
import { isReservedEvidenceUploadReference } from "../evidence-upload-reference.ts";
import { CATALOG, catalogAction } from "./catalog.ts";
import { canonicalJson, validate, type JsonSchema } from "./schema.ts";

export type Binding =
  /** Recorded on the run only: A0 and A1 output, which has no effect. */
  | { kind: "record" }
  /** Creates a handoff signal for another specialist (`handoff.create`). */
  | { kind: "handoff" }
  /** Opens an exception for a named person and notifies them (`exception.escalate`). */
  | { kind: "exception" }
  /** Sets a specialist's hold flag (`specialist.hold`). */
  | { kind: "specialist_hold" }
  /** An A0 read of the authority records, answered with the step's decision and never written (authority-read.ts). */
  | { kind: "authority_read" }
  /**
   * No executor exists yet: the step asks first, and an approval records the decision and hands the
   * work back to its reviewer to do by hand (control.ts `decideStep`). Nothing runs for it.
   */
  | { kind: "by_hand" }
  /**
   * Records, verifies or revokes an internal worker competency natively in D1 once a person
   * approves the step, with an owned-store readback (`authority.record`).
   */
  | { kind: "authority_record" }
  /** Strict arguments are known; the provider effect and readback are not implemented. */
  | { kind: "unavailable" };

export interface RegistryEntry {
  args: JsonSchema;
  /**
   * A refusal from the arguments alone, so the step is never proposed: a rule the strict dialect
   * cannot state (a field set only with one value of another), or one the executor would give. It
   * runs on arguments the schema accepted; a code refuses them like the schema, null accepts.
   */
  argsError?: (args: unknown) => string | null;
  binding: Binding;
  /**
   * Whether this action's machine-permit path is implemented and proven (CAPABILITY-MATRIX.md).
   * Until it is, a within-limits setting has no effect and the step asks first (contract
   * "Delegation", rule 10).
   */
  machinePermitProven: boolean;
}

const NOT_YET_REGISTERED = null;

const SPECIALIST_IDS = CATALOG.specialists.map((specialist) => specialist.specialist_id);
const ABSTAIN_CODES = CATALOG.receipt.reason_codes.abstained;

const text = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const nullable = (schema: JsonSchema) => ({
  ...schema,
  type: [schema.type as string, "null"],
});
const recordId = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$" };
const ref = (prefix: string) => ({ type: "string", pattern: `^${prefix}[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$` });
const objectRef = {
  type: "object",
  additionalProperties: false,
  required: ["aggregate", "id", "version"],
  properties: {
    aggregate: { type: "string", pattern: "^[a-z][a-z0-9_]{1,40}$" },
    id: recordId,
    version: { type: "integer", minimum: 0 },
  },
};

const FACT_EXPLAIN: RegistryEntry = {
  args: {
    type: "object",
    additionalProperties: false,
    required: ["object", "explanation"],
    properties: { object: nullable(objectRef), explanation: text(2000) },
  },
  binding: { kind: "record" },
  machinePermitProven: false,
};

const HANDOFF_CREATE: RegistryEntry = {
  args: {
    type: "object",
    additionalProperties: false,
    required: ["to_specialist_id", "object", "reason", "expected_action_id"],
    properties: {
      to_specialist_id: { type: "string", enum: SPECIALIST_IDS },
      object: objectRef,
      reason: text(600),
      expected_action_id: {
        type: "string",
        enum: CATALOG.actions.map((action) => action.action_id),
      },
    },
  },
  binding: { kind: "handoff" },
  machinePermitProven: false,
};

const EXCEPTION_ESCALATE: RegistryEntry = {
  args: {
    type: "object",
    additionalProperties: false,
    required: ["reason_code", "object", "summary", "urgency", "route_to"],
    properties: {
      reason_code: { type: "string", enum: ABSTAIN_CODES },
      route_to: {
        type: "string",
        enum: [...new Set(CATALOG.specialists.map((specialist) => specialist.reviewer_role))],
      },
      object: nullable(objectRef),
      summary: text(600),
      urgency: { type: "string", enum: ["immediate", "today", "brief"] },
    },
  },
  // Owned-store write with readback: the exception row, read back by id (test/agents-control.test.ts).
  binding: { kind: "exception" },
  machinePermitProven: true,
};

const SPECIALIST_HOLD: RegistryEntry = {
  args: {
    type: "object",
    additionalProperties: false,
    required: ["specialist_id", "reason"],
    properties: {
      // Never the AI auditor (contract "Delegation", rule 7); the database refuses it too.
      specialist_id: {
        type: "string",
        enum: SPECIALIST_IDS.filter((id) => !catalogAction("specialist.hold")?.never_targets?.includes(id)),
      },
      reason: text(600),
    },
  },
  binding: { kind: "specialist_hold" },
  machinePermitProven: true,
};

const EMERGENCY_PAGE: RegistryEntry = {
  args: {
    type: "object",
    additionalProperties: false,
    required: ["route_to", "urgency", "summary", "location", "job_id", "contact_id"],
    properties: {
      route_to: {
        type: "string",
        enum: [...new Set(CATALOG.specialists.map((specialist) => specialist.reviewer_role))],
      },
      urgency: { type: "string", const: "immediate" },
      summary: text(600),
      location: text(600),
      job_id: nullable(text(200)),
      contact_id: nullable(text(200)),
    },
  },
  binding: { kind: "unavailable" },
  machinePermitProven: false,
};

const NOTE_ADD: RegistryEntry = {
  args: {
    type: "object",
    additionalProperties: false,
    required: ["object", "text"],
    properties: { object: objectRef, text: text(2000) },
  },
  binding: { kind: "record" },
  machinePermitProven: false,
};

/** The roles a role change may give: every app role but the owner's. */
const TARGET_ROLES = Object.keys(ROLE_PERMISSIONS).filter((role) => role !== "owner");
const DEVICE_CHANGES = new Set(["replace_device", "revoke_device"]);

// Prepared for a person to apply with access.change (H). Policy also checks `request_ref` against
// the ask or request the run answers (policy.ts PERSON_REQUEST_ONLY).
const ACCESS_PREPARE_CHANGE: RegistryEntry = {
  args: {
    type: "object",
    additionalProperties: false,
    required: ["person_ref", "change", "target_role", "device_ref", "expected_access_version", "request_ref", "reason"],
    properties: {
      person_ref: ref("person:"),
      change: { type: "string", enum: ["pair_device", "replace_device", "revoke_device", "change_role"] },
      target_role: { type: ["string", "null"], enum: [...TARGET_ROLES, null] },
      device_ref: nullable(ref("device:")),
      // Checked against the person's access when a person applies the change.
      expected_access_version: { type: "integer", minimum: 1 },
      request_ref: ref("signal/"),
      reason: text(600),
    },
  },
  // A role change names its role and nothing else does; a device change names its device.
  argsError: (args) => {
    const { change, target_role, device_ref } = args as Record<string, unknown>;
    return (target_role !== null) === (change === "change_role") && (device_ref !== null) === DEVICE_CHANGES.has(change as string)
      ? null
      : "access_change_fields";
  },
  binding: { kind: "record" },
  machinePermitProven: false,
};

const AUTHORITY_EVALUATE: RegistryEntry = {
  args: {
    type: "object",
    additionalProperties: false,
    required: ["authority_id", "job_id", "applicability_id", "assignment_id"],
    properties: { authority_id: recordId, job_id: recordId, applicability_id: recordId, assignment_id: recordId },
  },
  binding: { kind: "authority_read" },
  machinePermitProven: false,
};

/** A settings edit's values by key, flat: 1 to 20 keys, each a scalar. */
const settingValues = {
  type: "object",
  additionalProperties: { type: ["string", "number", "boolean", "null"], maxLength: 600 },
  propertyNames: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
  minProperties: 1,
  maxProperties: 20,
};

// A preview for the person who applies it (settings.apply, H). `before` must still equal the
// current values when they do.
const SETTINGS_PROPOSE_CHANGE: RegistryEntry = {
  args: {
    type: "object",
    additionalProperties: false,
    required: ["settings_id", "before", "after"],
    properties: { settings_id: recordId, before: settingValues, after: settingValues },
  },
  argsError: (args) => {
    const { before, after } = args as Record<string, Record<string, unknown>>;
    return sameKeys(before, after) ? null : "settings_keys_differ";
  },
  binding: { kind: "record" },
  machinePermitProven: false,
};

const IMPORT_RETRY_FAILED: RegistryEntry = {
  args: {
    type: "object",
    additionalProperties: false,
    required: ["import_run_id", "source_keys"],
    properties: {
      import_run_id: recordId,
      // The failed items only, each by its source key as the import recorded it.
      source_keys: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: text(240) },
    },
  },
  // The predecessor re-runs a whole file (POST /admin/crm-import/execute), so no executor retries
  // failed items yet: the owner approves, then takes the retry over.
  binding: { kind: "by_hand" },
  machinePermitProven: false,
};

const LEAD_FACT_CONFIRM: RegistryEntry = {
  args: {
    type: "object",
    additionalProperties: false,
    required: ["lead_id", "proposal_id", "fields"],
    properties: {
      lead_id: recordId,
      proposal_id: recordId,
      // Values copied from the proposal; null leaves that fact unconfirmed. At least one is set.
      fields: {
        type: "object",
        additionalProperties: false,
        required: ["service", "scope", "address", "timing"],
        properties: { service: nullable(text(200)), scope: nullable(text(2000)), address: nullable(text(600)), timing: nullable(text(600)) },
      },
    },
  },
  argsError: (args) => (Object.values((args as { fields: Record<string, unknown> }).fields).some((value) => value !== null) ? null : "lead_fields_empty"),
  // No executor writes lead facts yet: sales approves, then confirms them by hand.
  binding: { kind: "by_hand" },
  machinePermitProven: false,
};

function sameKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key));
}

// No control characters and no leading or trailing space, so an authority value is stored as sent.
const exactText = (maxLength: number, minLength = 1) => ({
  type: "string",
  minLength,
  maxLength,
  pattern: "^\\S(?:[^\\u0000-\\u001f]*\\S)?$",
});
const SCOPE_TYPES: AuthorityRequirement["scope_type"][] = [
  "Tenant",
  "Roof Job",
  "Assignment",
  "Work Package",
  "Shop",
  "Field",
  "Trade",
  "Manufacturer System",
];
// Frappe requires the roof job for these scopes (authority_policy.validate_authority_record).
const JOB_SCOPES = new Set(["Roof Job", "Assignment", "Work Package"]);

// One internal worker competency command, the same for the step's arguments and the /people
// route's body; the Worker runs it natively once a person approves it (authority-record-native.ts).
// Never within limits: the action is not delegable, so a person approves every command.
const AUTHORITY_RECORD: RegistryEntry = {
  args: {
    type: "object",
    additionalProperties: false,
    required: ["operation", "authority_kind", "subject_ref", "scope_type", "scope_ref", "expected_head", "record", "reference", "reason"],
    properties: {
      operation: { type: "string", enum: ["record", "verify", "revoke"] },
      authority_kind: { type: "string", const: COMPETENCY_KIND },
      // The worker as the requirements name them (`subject_ref`), stored as the record's person.
      subject_ref: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:@+-]{2,139}$" },
      scope_type: { type: "string", enum: SCOPE_TYPES },
      scope_ref: exactText(140),
      // The identity's current head the command supersedes; null only for its first version.
      expected_head: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["authority_record_id", "authority_version"],
        properties: {
          authority_record_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{2,139}$" },
          authority_version: { type: "integer", minimum: 1, maximum: 999_999 },
        },
      },
      // The assessment a record captures; verify and revoke carry the head's assessment forward.
      record: {
        type: ["object", "null"],
        additionalProperties: false,
        required: [
          "authority_scope",
          "roof_job",
          "issuer_jurisdiction",
          "issuer_reference",
          "source_version",
          "evidence_refs",
          "effective_from",
          "expires_at",
        ],
        properties: {
          authority_scope: exactText(240, 2),
          roof_job: nullable(exactText(200)),
          issuer_jurisdiction: exactText(160, 2),
          issuer_reference: exactText(240, 3),
          source_version: exactText(120),
          evidence_refs: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["ref", "sha256"],
              properties: { ref: exactText(512, 3), sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } },
            },
          },
          effective_from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          expires_at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        },
      },
      // The verification reference of a verify, or the revocation reference of a revoke.
      reference: nullable(exactText(240, 3)),
      reason: nullable(exactText(600, 3)),
    },
  },
  argsError: competencyCommandError,
  binding: { kind: "authority_record" },
  machinePermitProven: false,
};

export interface CompetencyCommand {
  operation: "record" | "verify" | "revoke";
  authority_kind: typeof COMPETENCY_KIND;
  subject_ref: string;
  scope_type: AuthorityRequirement["scope_type"];
  scope_ref: string;
  expected_head: { authority_record_id: string; authority_version: number } | null;
  record: {
    authority_scope: string;
    roof_job: string | null;
    issuer_jurisdiction: string;
    issuer_reference: string;
    source_version: string;
    evidence_refs: Array<{ ref: string; sha256: string }>;
    effective_from: string;
    expires_at: string;
  } | null;
  reference: string | null;
  reason: string | null;
}

/** The refusal a competency command earns from its own content, before any record is read. */
export function competencyCommandError(value: unknown): string | null {
  const kind = typeof value === "object" && value !== null ? (value as { authority_kind?: unknown }).authority_kind : undefined;
  if (typeof kind === "string" && EXTERNAL_ISSUER_AUTHORITY_KINDS.has(kind)) return "authority_external_issuer_required";
  if (validate(AUTHORITY_RECORD.args, value).length > 0) return "authority_command_invalid";
  const command = value as CompetencyCommand;
  if (command.operation === "record") {
    const record = command.record;
    // An unverified version carries no verification fact.
    if (!record || command.reference !== null) return "authority_command_invalid";
    // The stored reference list holds at most 20,000 characters (0045).
    if (record.evidence_refs.some((entry) => isReservedEvidenceUploadReference(entry.ref)) ||
        canonicalJson(record.evidence_refs).length > 20_000) {
      return "authority_command_invalid";
    }
    if (!isoDate(record.effective_from) || !isoDate(record.expires_at) || record.effective_from > record.expires_at) {
      return "authority_window_invalid";
    }
    if (JOB_SCOPES.has(command.scope_type) && record.roof_job === null) return "authority_roof_job_required";
    return null;
  }
  if (command.record !== null || command.expected_head === null || command.reference === null) {
    return "authority_command_invalid";
  }
  return command.operation === "revoke" && command.reason === null ? "authority_command_invalid" : null;
}

function isoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const REGISTRY: Record<string, RegistryEntry | null> = {
  "purchase_order.record_acknowledgement": NOT_YET_REGISTERED,
  "supplier_return.request": NOT_YET_REGISTERED,
  "shop_order.hold": NOT_YET_REGISTERED,
  "shop_order.release_hold": NOT_YET_REGISTERED,
  "shop_outcome.record": NOT_YET_REGISTERED,
  "safety_stop.release_prepare": NOT_YET_REGISTERED,
  "ncr.verify_close": NOT_YET_REGISTERED,
  "payee.unfreeze_prepare": NOT_YET_REGISTERED,
  "cancellation.hold": NOT_YET_REGISTERED,
  "cancellation.release_hold": NOT_YET_REGISTERED,
  "fact.explain": FACT_EXPLAIN,
  "handoff.create": HANDOFF_CREATE,
  "exception.escalate": EXCEPTION_ESCALATE,
  "note.add": NOTE_ADD,
  "signal.route": NOT_YET_REGISTERED,
  "report.compose": NOT_YET_REGISTERED,
  "staff.notify": NOT_YET_REGISTERED,
  "owner.interrupt": NOT_YET_REGISTERED,
  "delegation.propose_change": NOT_YET_REGISTERED,
  "delegation.set": NOT_YET_REGISTERED,
  "policy.propose_change": NOT_YET_REGISTERED,
  "policy.activate": NOT_YET_REGISTERED,
  "settings.propose_change": SETTINGS_PROPOSE_CHANGE,
  "settings.apply": NOT_YET_REGISTERED,
  "onboarding.go_live": NOT_YET_REGISTERED,
  "dead_letter.replay": NOT_YET_REGISTERED,
  "import.retry_failed": IMPORT_RETRY_FAILED,
  "market_alert.raise": NOT_YET_REGISTERED,
  "storm_watch.open": NOT_YET_REGISTERED,
  "storm_mode.propose": NOT_YET_REGISTERED,
  "market_watch_item.add": NOT_YET_REGISTERED,
  "market_review.draft": NOT_YET_REGISTERED,
  "inquiry.classify": NOT_YET_REGISTERED,
  "inquiry.link_duplicate": NOT_YET_REGISTERED,
  "inquiry.record_triage": NOT_YET_REGISTERED,
  "lead_fact.propose": NOT_YET_REGISTERED,
  "lead_fact.confirm": LEAD_FACT_CONFIRM,
  "inquiry.close": NOT_YET_REGISTERED,
  "inbound.quarantine": NOT_YET_REGISTERED,
  "inbound.release": NOT_YET_REGISTERED,
  "customer_message.draft": NOT_YET_REGISTERED,
  "customer_message.send": NOT_YET_REGISTERED,
  "followup.pause": NOT_YET_REGISTERED,
  "followup.resume": NOT_YET_REGISTERED,
  "visit.hold_slot": NOT_YET_REGISTERED,
  "visit.confirm": NOT_YET_REGISTERED,
  "consent.record": NOT_YET_REGISTERED,
  "suppression.apply": NOT_YET_REGISTERED,
  "conversation.assign_person": NOT_YET_REGISTERED,
  "conversation.answer_live": NOT_YET_REGISTERED,
  "reception_script.publish": NOT_YET_REGISTERED,
  "takeoff.draft": NOT_YET_REGISTERED,
  "quote.draft_revision": NOT_YET_REGISTERED,
  "quote.commit_revision": NOT_YET_REGISTERED,
  "quote.apply_discount": NOT_YET_REGISTERED,
  "quote.flag_reprice": NOT_YET_REGISTERED,
  "price_book.propose_change": NOT_YET_REGISTERED,
  "change_order.draft": NOT_YET_REGISTERED,
  "change_order.commit": NOT_YET_REGISTERED,
  "insurance_supplement.draft": NOT_YET_REGISTERED,
  "insurance_supplement.send": NOT_YET_REGISTERED,
  "measurement.extract": NOT_YET_REGISTERED,
  "measurement.match_report": NOT_YET_REGISTERED,
  "measurement.accept_version": NOT_YET_REGISTERED,
  "property_fact.propose": NOT_YET_REGISTERED,
  "property_fact.confirm": NOT_YET_REGISTERED,
  "design_basis.commit": NOT_YET_REGISTERED,
  "design_basis.substitute": NOT_YET_REGISTERED,
  "proposal.draft_revision": NOT_YET_REGISTERED,
  "proposal.publish": NOT_YET_REGISTERED,
  "proposal.withdraw": NOT_YET_REGISTERED,
  "portal_link.send": NOT_YET_REGISTERED,
  "portal_link.revoke": NOT_YET_REGISTERED,
  "acceptance.customer_decision": NOT_YET_REGISTERED,
  "change_order.send_for_decision": NOT_YET_REGISTERED,
  "terms.legal_signoff": NOT_YET_REGISTERED,
  "cancellation.record": NOT_YET_REGISTERED,
  "rfq.send": NOT_YET_REGISTERED,
  "supplier_quote.extract": NOT_YET_REGISTERED,
  "supplier_quote.confirm": NOT_YET_REGISTERED,
  "catalog.record_snapshot": NOT_YET_REGISTERED,
  "purchase_order.place": NOT_YET_REGISTERED,
  "purchase_order.expedite": NOT_YET_REGISTERED,
  "purchase_order.change": NOT_YET_REGISTERED,
  "receipt.match": NOT_YET_REGISTERED,
  "stock.reserve": NOT_YET_REGISTERED,
  "stock.quarantine": NOT_YET_REGISTERED,
  "stock.release_quarantine": NOT_YET_REGISTERED,
  "stock.adjust_count": NOT_YET_REGISTERED,
  "supplier.onboard": NOT_YET_REGISTERED,
  "cut_list.draft": NOT_YET_REGISTERED,
  "nest.plan": NOT_YET_REGISTERED,
  "shop_schedule.plan": NOT_YET_REGISTERED,
  "shop_order.release": NOT_YET_REGISTERED,
  "label.generate": NOT_YET_REGISTERED,
  "load_plan.draft": NOT_YET_REGISTERED,
  "billing_basis.propose": NOT_YET_REGISTERED,
  "schedule.draft": NOT_YET_REGISTERED,
  "crew_slot.hold": NOT_YET_REGISTERED,
  "crew_date.commit": NOT_YET_REGISTERED,
  "asset.assign": NOT_YET_REGISTERED,
  "mobilization.check": NOT_YET_REGISTERED,
  "work_package.draft": NOT_YET_REGISTERED,
  "work_package.issue": NOT_YET_REGISTERED,
  "work_package.hold_before_start": NOT_YET_REGISTERED,
  "work_package.release_hold": NOT_YET_REGISTERED,
  "stop_condition.alert": NOT_YET_REGISTERED,
  "evidence.request": NOT_YET_REGISTERED,
  "field_record.draft": NOT_YET_REGISTERED,
  "crew_item.propose_resolution": NOT_YET_REGISTERED,
  "safety_stop.release": NOT_YET_REGISTERED,
  "evidence.review": NOT_YET_REGISTERED,
  "hold_point.release": NOT_YET_REGISTERED,
  "ncr.open": NOT_YET_REGISTERED,
  "ncr.disposition": NOT_YET_REGISTERED,
  "completion.draft_packet": NOT_YET_REGISTERED,
  "completion.accept": NOT_YET_REGISTERED,
  "invoice.commit_intent": NOT_YET_REGISTERED,
  "reconciliation.resolve": NOT_YET_REGISTERED,
  "supplier_bill.match": NOT_YET_REGISTERED,
  "supplier_bill.approve": NOT_YET_REGISTERED,
  "supplier_message.draft": NOT_YET_REGISTERED,
  "supplier_message.send": NOT_YET_REGISTERED,
  "payment_run.draft": NOT_YET_REGISTERED,
  "payee.freeze": NOT_YET_REGISTERED,
  "payee.change_details": NOT_YET_REGISTERED,
  "payee.unfreeze": NOT_YET_REGISTERED,
  "money.flag": NOT_YET_REGISTERED,
  "job_cost.attribute": NOT_YET_REGISTERED,
  "tax_slip.capture": NOT_YET_REGISTERED,
  "tax_snapshot.record": NOT_YET_REGISTERED,
  "holdback.release": NOT_YET_REGISTERED,
  "refund.issue": NOT_YET_REGISTERED,
  "write_off.record": NOT_YET_REGISTERED,
  "filing.draft_packet": NOT_YET_REGISTERED,
  "filing.submit": NOT_YET_REGISTERED,
  "authority.evaluate": AUTHORITY_EVALUATE,
  "gate.block": NOT_YET_REGISTERED,
  "gate.clear": NOT_YET_REGISTERED,
  "gate.waive": NOT_YET_REGISTERED,
  "document.request": NOT_YET_REGISTERED,
  "authority.record": AUTHORITY_RECORD,
  "privacy_request.answer": NOT_YET_REGISTERED,
  "privacy_incident.contain": NOT_YET_REGISTERED,
  "access.prepare_change": ACCESS_PREPARE_CHANGE,
  "access.change": NOT_YET_REGISTERED,
  "service_case.open": NOT_YET_REGISTERED,
  "emergency.page": EMERGENCY_PAGE,
  "service_case.triage": NOT_YET_REGISTERED,
  "remedy.offer": NOT_YET_REGISTERED,
  "cost_recovery.claim": NOT_YET_REGISTERED,
  "service_case.close": NOT_YET_REGISTERED,
  "content.draft": NOT_YET_REGISTERED,
  "claim.approve": NOT_YET_REGISTERED,
  "content.publish": NOT_YET_REGISTERED,
  "content.stop": NOT_YET_REGISTERED,
  "campaign.send": NOT_YET_REGISTERED,
  "review_response.publish": NOT_YET_REGISTERED,
  "ad_spend.commit": NOT_YET_REGISTERED,
  "run.verify": NOT_YET_REGISTERED,
  "finding.raise": NOT_YET_REGISTERED,
  "specialist.hold": SPECIALIST_HOLD,
  "finding.close": NOT_YET_REGISTERED,
};

export function registryEntry(actionId: string): RegistryEntry | null {
  return Object.hasOwn(REGISTRY, actionId) ? REGISTRY[actionId] : null;
}
