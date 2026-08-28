import { describe, expect, it } from "vitest";

import type { SchemaCardEntry, SchemaCardFieldDefinition } from "./schema-card-contracts";
import {
  applyControllingVisibility,
  formatSchemaCardValue,
  groupSchemaCardEntries,
  schemaValueIsEmpty,
} from "./schema-card-presentation";

const dateOptions = { locale: "en-CA", timeZone: "America/Edmonton" };

/** Index into a result the assertion is about to describe, failing loudly if it is not there. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an entry at index ${index}`);
  return item;
}

function definition(overrides: Partial<SchemaCardFieldDefinition> = {}): SchemaCardFieldDefinition {
  return {
    field_id: overrides.field_key ? `fld_${overrides.field_key}` : "fld_default",
    field_key: "permit_number",
    revision_id: "rev_1",
    version: 1,
    label: "Permit number",
    position: 0,
    field_type: "text",
    validator_key: "none",
    validator_config: {},
    visibility_key: "always",
    visibility_config: {},
    evidence_class: "none",
    retention_policy: "standard",
    offline_mode: "offline_read",
    ...overrides,
  } as SchemaCardFieldDefinition;
}

function entry(
  definitionOverrides: Partial<SchemaCardFieldDefinition>,
  value: unknown = undefined,
): SchemaCardEntry {
  return {
    definition: definition(definitionOverrides),
    value:
      value === undefined
        ? null
        : {
            value_revision_id: "val_1",
            field_definition_revision_id: "rev_1",
            version: 1,
            prior_value_revision_id: null,
            based_on_value_revision_id: null,
            correction_reason: null,
            value,
            value_digest: "digest",
            provenance_actor_type: "owner",
            created_at: "2026-08-27T18:00:00.000Z",
          },
  } as SchemaCardEntry;
}

describe("grouping more than one service type onto one card", () => {
  it("gives each field-key namespace its own block while keeping the administrator's order", () => {
    const groups = groupSchemaCardEntries([
      entry({ field_key: "gutters.downspouts", label: "Downspouts", position: 3 }),
      entry({ field_key: "roofing.underlayment", label: "Underlayment", position: 1 }),
      entry({ field_key: "roofing.deck_condition", label: "Deck condition", position: 0 }),
      entry({ field_key: "gutters.linear_feet", label: "Linear feet", position: 2 }),
    ]);

    expect(groups.map((group) => group.key)).toEqual(["roofing", "gutters"]);
    expect(at(groups, 0).label).toBe("Roofing");
    expect(at(groups, 1).label).toBe("Gutters");
    expect(at(groups, 0).entries.map((item) => item.definition.field_key)).toEqual([
      "roofing.deck_condition",
      "roofing.underlayment",
    ]);
    expect(at(groups, 1).entries.map((item) => item.definition.field_key)).toEqual([
      "gutters.linear_feet",
      "gutters.downspouts",
    ]);
  });

  it("keeps un-namespaced fields in one default block, so a flat field set is unaffected", () => {
    const groups = groupSchemaCardEntries([
      entry({ field_key: "permit_number", position: 1 }),
      entry({ field_key: "site_contact", position: 0 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(at(groups, 0).key).toBe("");
    expect(at(groups, 0).label).toBe("Details");
    expect(at(groups, 0).entries.map((item) => item.definition.field_key)).toEqual([
      "site_contact",
      "permit_number",
    ]);
  });

  it("orders a tie by field key so a render never reshuffles between loads", () => {
    const groups = groupSchemaCardEntries([
      entry({ field_key: "b_field", position: 0 }),
      entry({ field_key: "a_field", position: 0 }),
    ]);

    expect(at(groups, 0).entries.map((item) => item.definition.field_key)).toEqual([
      "a_field",
      "b_field",
    ]);
  });
});

describe("conditional show and hide", () => {
  it("hides a when_field_equals field whose controller holds a different value", () => {
    const visible = applyControllingVisibility([
      entry({ field_key: "service_kind", position: 0 }, "repair"),
      entry(
        {
          field_key: "replacement_squares",
          position: 1,
          visibility_key: "when_field_equals",
          visibility_config: { field_key: "service_kind", value: "replacement" },
        },
        12,
      ),
    ]);

    expect(visible.map((item) => item.definition.field_key)).toEqual(["service_kind"]);
  });

  it("shows a when_field_equals field once its controller matches", () => {
    const visible = applyControllingVisibility([
      entry({ field_key: "service_kind", position: 0 }, "replacement"),
      entry(
        {
          field_key: "replacement_squares",
          position: 1,
          visibility_key: "when_field_equals",
          visibility_config: { field_key: "service_kind", value: "replacement" },
        },
        12,
      ),
    ]);

    expect(visible.map((item) => item.definition.field_key)).toEqual([
      "service_kind",
      "replacement_squares",
    ]);
  });

  it("treats an empty controller as absent for when_field_present", () => {
    const dependent = {
      field_key: "damage_notes",
      position: 1,
      visibility_key: "when_field_present",
      visibility_config: { field_key: "damage_photo" },
    };

    expect(
      applyControllingVisibility([
        entry({ field_key: "damage_photo", position: 0 }, ""),
        entry(dependent, "hail"),
      ]).map((item) => item.definition.field_key),
    ).toEqual(["damage_photo"]);

    expect(
      applyControllingVisibility([
        entry({ field_key: "damage_photo", position: 0 }, "evidence_9"),
        entry(dependent, "hail"),
      ]).map((item) => item.definition.field_key),
    ).toEqual(["damage_photo", "damage_notes"]);
  });

  it("keeps a dependent field when the controller is not in this role's payload", () => {
    // The server authorized this field and withheld its controller from this role. Re-deciding
    // here would hide something the server deliberately sent.
    const visible = applyControllingVisibility([
      entry(
        {
          field_key: "crew_note",
          position: 0,
          visibility_key: "when_field_equals",
          visibility_config: { field_key: "margin_band", value: "thin" },
        },
        "Watch the north valley",
      ),
    ]);

    expect(visible.map((item) => item.definition.field_key)).toEqual(["crew_note"]);
  });
});

describe("presenting a governed value", () => {
  it("renders each closed field type for a person rather than a machine", () => {
    expect(
      formatSchemaCardValue(
        definition({ field_type: "boolean" }),
        entry({}, true).value,
        dateOptions,
      ),
    ).toBe("Yes");
    expect(
      formatSchemaCardValue(
        definition({ field_type: "boolean" }),
        entry({}, false).value,
        dateOptions,
      ),
    ).toBe("No");
    expect(
      formatSchemaCardValue(
        definition({ field_type: "multiselect" }),
        entry({}, ["Ridge vent", "Drip edge"]).value,
        dateOptions,
      ),
    ).toBe("Ridge vent, Drip edge");
    expect(
      formatSchemaCardValue(
        definition({ field_type: "money", validator_config: { currency: "CAD" } }),
        entry({}, 125_000).value,
        dateOptions,
      ),
    ).toContain("1,250.00");
    expect(
      formatSchemaCardValue(
        definition({ field_type: "date" }),
        entry({}, "2026-08-31").value,
        dateOptions,
      ),
    ).toContain("2026");
  });

  it("names an evidence reference instead of trying to inline it", () => {
    expect(
      formatSchemaCardValue(
        definition({ field_type: "image" }),
        entry({}, { object_key: "evidence/before-north.jpg" }).value,
        dateOptions,
      ),
    ).toBe("evidence/before-north.jpg");
  });

  it("says where a provider fact came from", () => {
    expect(
      formatSchemaCardValue(
        definition({ field_type: "provider_fact" }),
        entry({}, { value: "In stock", provider: "supplier-api" }).value,
        dateOptions,
      ),
    ).toBe("In stock · from supplier-api");
  });

  it("degrades a value that does not match its declared type instead of throwing", () => {
    expect(
      formatSchemaCardValue(
        definition({ field_type: "number" }),
        entry({}, "not-a-number").value,
        dateOptions,
      ),
    ).toBe("Not readable");
  });

  it("reports an unset field as unrecorded rather than blank", () => {
    expect(schemaValueIsEmpty(null)).toBe(true);
    expect(schemaValueIsEmpty(entry({}, []).value)).toBe(true);
    expect(schemaValueIsEmpty(entry({}, "Charcoal").value)).toBe(false);
    expect(formatSchemaCardValue(definition(), null, dateOptions)).toBe("Not recorded");
  });
});
