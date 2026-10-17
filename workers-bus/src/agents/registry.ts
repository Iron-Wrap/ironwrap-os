// The Worker action registry: the Worker-owned half of every catalog action. The contract fixes
// each action's class, owners and delegability (catalog.ts); this file owns its argument schema
// (strict, so an unknown field is refused) and how a permitted step executes. Every contract
// action id appears here exactly once (test/agents-policy.test.ts); an action whose arguments
// are not registered yet abstains with `policy_missing` instead of running on a guess.
//
// Argument conventions (AI-TEAM-CONTRACT.md "Argument conventions"): money in integer minor units
// plus an ISO 4217 code, BCP 47 language tags, `<aggregate>_id` ids, a `reason_code` from a closed
// vocabulary, and recipients as `to`, a canonical contact id.

import { CATALOG, catalogAction } from "./catalog.ts";
import type { JsonSchema } from "./schema.ts";

export type Binding =
  /** Recorded on the run only: A0 and A1 output, which has no effect. */
  | { kind: "record" }
  /** Creates a handoff signal for another specialist (`handoff.create`). */
  | { kind: "handoff" }
  /** Opens an exception for a named person and notifies them (`exception.escalate`). */
  | { kind: "exception" }
  /** Sets a specialist's hold flag (`specialist.hold`). */
  | { kind: "specialist_hold" }
  /** Strict arguments are known; the provider effect and readback are not implemented. */
  | { kind: "unavailable" };

export interface RegistryEntry {
  args: JsonSchema;
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
const objectRef = {
  type: "object",
  additionalProperties: false,
  required: ["aggregate", "id", "version"],
  properties: {
    aggregate: { type: "string", pattern: "^[a-z][a-z0-9_]{1,40}$" },
    id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$" },
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
  "dead_letter.replay": NOT_YET_REGISTERED,
  "market_alert.raise": NOT_YET_REGISTERED,
  "storm_watch.open": NOT_YET_REGISTERED,
  "storm_mode.propose": NOT_YET_REGISTERED,
  "market_watch_item.add": NOT_YET_REGISTERED,
  "market_review.draft": NOT_YET_REGISTERED,
  "inquiry.classify": NOT_YET_REGISTERED,
  "inquiry.link_duplicate": NOT_YET_REGISTERED,
  "inquiry.record_triage": NOT_YET_REGISTERED,
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
  "authority.evaluate": NOT_YET_REGISTERED,
  "gate.block": NOT_YET_REGISTERED,
  "gate.clear": NOT_YET_REGISTERED,
  "gate.waive": NOT_YET_REGISTERED,
  "document.request": NOT_YET_REGISTERED,
  "authority.record": NOT_YET_REGISTERED,
  "privacy_request.answer": NOT_YET_REGISTERED,
  "privacy_incident.contain": NOT_YET_REGISTERED,
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
