// The final output every specialist run closes with, as the Worker checks it. It must equal the
// agent host's RUN_OUTPUT_SCHEMA (agent-host/src/host/prompt.ts); test/agents-api.test.ts compares
// the two, so a change on either side fails until both agree.

import type { JsonSchema } from "./schema.ts";

const NULLABLE_TEXT = (maxLength: number) => ({ type: ["string", "null"], maxLength });

const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action_id", "did", "doing", "needs_from_you", "sources", "undo", "do_it_myself"],
  properties: {
    action_id: NULLABLE_TEXT(128),
    did: NULLABLE_TEXT(600),
    doing: NULLABLE_TEXT(600),
    needs_from_you: {
      type: "object",
      additionalProperties: false,
      required: ["reviewer_role", "person_id", "ask"],
      properties: { reviewer_role: NULLABLE_TEXT(64), person_id: NULLABLE_TEXT(128), ask: NULLABLE_TEXT(600) },
    },
    sources: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fact_id", "version", "hash"],
        properties: {
          fact_id: { type: "string", minLength: 1, maxLength: 160 },
          version: { type: "integer", minimum: 0 },
          hash: { type: "string", maxLength: 128 },
        },
      },
    },
    undo: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "how"],
      properties: { mode: { type: "string", enum: ["none", "automatic", "manual"] }, how: NULLABLE_TEXT(600) },
    },
    do_it_myself: {
      type: "object",
      additionalProperties: false,
      required: ["surface", "context"],
      properties: { surface: NULLABLE_TEXT(200), context: NULLABLE_TEXT(600) },
    },
  },
};

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "audience", "language", "text"],
  properties: {
    id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$" },
    audience: { type: "string", enum: ["customer", "supplier", "crew", "owner", "staff"] },
    language: { type: "string", pattern: "^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$" },
    text: { type: "string", minLength: 1, maxLength: 4000 },
  },
};

/** AI-TEAM-CONTRACT.md receipt reason codes for an abstention. */
export const ABSTAIN_REASON_CODES = [
  "fact_missing",
  "fact_stale",
  "fact_conflict",
  "citation_unverifiable",
  "action_unregistered",
  "policy_missing",
  "ceiling_reached",
  "no_progress",
  "provider_unavailable",
  "no_qualified_route",
  "injection_suspected",
  "out_of_scope",
  "person_requested",
  "safety_event",
  "emergency",
] as const;

/** The one final answer every specialist run ends with. Actions are proposed only as tool calls. */
export const RUN_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "escalate_to", "reason_code", "reason", "receipts", "drafts", "final_text"],
  properties: {
    decision: { type: "string", enum: ["propose", "abstain", "escalate", "ignore"] },
    escalate_to: NULLABLE_TEXT(64),
    reason_code: { type: ["string", "null"], enum: [...ABSTAIN_REASON_CODES, null] },
    reason: { type: "string", maxLength: 1000 },
    receipts: { type: "array", maxItems: 20, items: RECEIPT_SCHEMA },
    drafts: { type: "array", maxItems: 10, items: DRAFT_SCHEMA },
    final_text: { type: "string", maxLength: 4000 },
  },
};
