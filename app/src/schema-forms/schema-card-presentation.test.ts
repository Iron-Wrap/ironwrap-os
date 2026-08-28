import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/api";
import type { SchemaCardEntry, SchemaCardFieldDefinition } from "./schema-card-contracts";
import {
  applyControllingVisibility,
  formatSchemaCardValue,
  groupSchemaCardEntries,
  schemaCardControlValue,
  schemaCardCorrectionNote,
  schemaCardEditability,
  schemaCardRequiresCorrection,
  schemaCardWireValue,
  schemaCardWriteRefusal,
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

/** A field the server said this caller may write. Absent means "no" everywhere else. */
function writable(
  definitionOverrides: Partial<SchemaCardFieldDefinition> = {},
  value: unknown = undefined,
): SchemaCardEntry {
  return { ...entry(definitionOverrides, value), writable: true } as SchemaCardEntry;
}

function wire(
  definitionOverrides: Partial<SchemaCardFieldDefinition>,
  raw: string | string[] | boolean,
) {
  return schemaCardWireValue(definition(definitionOverrides), raw);
}

describe("deciding whether to draw an edit control", () => {
  it("offers an edit only where the server said this caller may write", () => {
    expect(schemaCardEditability(writable(), { online: true })).toEqual({
      kind: "editable",
      queueable: false,
    });
  });

  it("draws nothing on a field the server did not mark writable", () => {
    expect(schemaCardEditability(entry({}), { online: true })).toEqual({
      kind: "read_only",
      reason: "not_writable",
    });
  });

  it("treats a missing flag as a refusal rather than a permission", () => {
    // A server that has not shipped the flag, a cached card written by an older client, and a
    // field this role genuinely may not write are indistinguishable here. Failing closed is the
    // only reading of all three that never invents an edit the server would reject.
    const stale = { ...entry({}) } as SchemaCardEntry & { writable?: boolean };
    delete stale.writable;
    expect(schemaCardEditability(stale, { online: true }).kind).toBe("read_only");
  });

  it("reads the flag only where #202 publishes it, and does not honour it anywhere else", () => {
    // A `writable` on the definition is a different server's idea of the contract. Honouring it
    // would be guessing at authority, which is the whole thing this flag exists to stop.
    const misplaced = {
      ...entry({}),
      definition: { ...definition({}), writable: true },
    } as SchemaCardEntry;
    expect(schemaCardEditability(misplaced, { online: true })).toEqual({
      kind: "read_only",
      reason: "not_writable",
    });
  });

  it("keeps evidence fields read-only, because their value is a receipt and not something typed", () => {
    for (const fieldType of ["image", "attachment", "provider_fact"]) {
      expect(schemaCardEditability(writable({ field_type: fieldType }), { online: true })).toEqual({
        kind: "read_only",
        reason: "evidence_capture",
      });
    }
  });

  it("still offers a queueable field with no signal, because that is the whole point", () => {
    expect(
      schemaCardEditability(writable({ offline_mode: "queueable" }), { online: false }),
    ).toEqual({ kind: "editable", queueable: true });
  });

  it("says a field an administrator marked online-only cannot be entered without signal", () => {
    expect(
      schemaCardEditability(writable({ offline_mode: "online_only" }), { online: false }),
    ).toEqual({ kind: "read_only", reason: "needs_connection" });
  });
});

describe("deciding how a change must be recorded once someone else moved the field", () => {
  it("lets an ordinary field be replaced", () => {
    expect(schemaCardRequiresCorrection(definition({}))).toBe(false);
  });

  it("requires an explicit correction on an evidence-classed field", () => {
    expect(schemaCardRequiresCorrection(definition({ evidence_class: "physical" }))).toBe(true);
  });

  it("requires an explicit correction on a field an administrator kept beyond standard retention", () => {
    expect(schemaCardRequiresCorrection(definition({ retention_policy: "legal_hold" }))).toBe(true);
    expect(schemaCardRequiresCorrection(definition({ retention_policy: "extended" }))).toBe(true);
  });

  it("renders the correction the server recorded, so the trail is visible on the card", () => {
    const corrected = entry({}, "18");
    expect(schemaCardCorrectionNote(corrected.value)).toBeNull();
    expect(
      schemaCardCorrectionNote({
        ...corrected.value!,
        based_on_value_revision_id: "val_1",
        correction_reason: "Measured again after the tear-off",
      }),
    ).toBe("Corrected: Measured again after the tear-off");
  });
});

describe("shaping what a control holds into what the field's type declares", () => {
  it("round-trips a value into an editor without a reader's formatting", () => {
    // 1_450_00 minor units reads as "$1,450.00" but must edit as "1450.00".
    expect(
      schemaCardControlValue(definition({ field_type: "money" }), entry({}, 145_000).value),
    ).toBe("1450.00");
    expect(
      schemaCardControlValue(definition({ field_type: "integer" }), entry({}, 142).value),
    ).toBe("142");
    expect(
      schemaCardControlValue(definition({ field_type: "boolean" }), entry({}, true).value),
    ).toBe(true);
    expect(
      schemaCardControlValue(
        definition({ field_type: "multiselect" }),
        entry({}, ["a", "b"]).value,
      ),
    ).toEqual(["a", "b"]);
  });

  it("sends money as the minor units the server stores", () => {
    expect(wire({ field_type: "money" }, "1450.55")).toEqual({ ok: true, value: 145_055 });
  });

  it("sends an emptied control as nothing and lets the server rule on it", () => {
    // A `required` validator refuses null; anything else accepts it. That is configuration an
    // administrator can change without this file changing, so it is never decided here.
    expect(wire({ field_type: "text", validator_key: "required" }, "  ")).toEqual({
      ok: true,
      value: null,
    });
  });

  it("refuses only what cannot be expressed as the declared type at all", () => {
    expect(wire({ field_type: "integer" }, "14.5")).toMatchObject({ ok: false });
    expect(wire({ field_type: "number" }, "not a number")).toMatchObject({ ok: false });
  });

  it("does not second-guess a configured rule it could have checked locally", () => {
    // 500 is outside the configured range. The server owns that refusal, so the value goes.
    expect(
      wire(
        { field_type: "integer", validator_key: "range", validator_config: { min: 1, max: 100 } },
        "500",
      ),
    ).toEqual({ ok: true, value: 500 });
  });

  it("sends a datetime as the canonical UTC the server accepts", () => {
    const shaped = wire({ field_type: "datetime" }, "2026-08-28T14:30");
    expect(shaped).toMatchObject({ ok: true });
    expect(String((shaped as { value: unknown }).value)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});

describe("saying what the server refused, in words a crew member can act on", () => {
  function refusalFor(code: string, definitionOverrides: Partial<SchemaCardFieldDefinition> = {}) {
    return schemaCardWriteRefusal(
      new ApiError({ status: 400, code, message: "Bad Request" }),
      definition(definitionOverrides),
    );
  }

  it("names the field an administrator marked required", () => {
    expect(refusalFor("schema_field_required", { label: "Permit number" })).toContain(
      "Permit number",
    );
  });

  it("quotes the administrator's own range rather than a generic complaint", () => {
    expect(
      refusalFor("schema_field_range_invalid", {
        validator_key: "range",
        validator_config: { min: 1, max: 100 },
      }),
    ).toBe("Enter a number between 1 and 100.");
  });

  it("tells a crew member to ask the office when their role cannot write the field", () => {
    expect(refusalFor("schema_field_write_forbidden")).toMatch(/ask the office/i);
  });

  it("tells them to reload when an administrator changed the field underneath", () => {
    expect(refusalFor("schema_field_definition_stale")).toMatch(/reload the card/i);
  });

  it("passes a code it has never seen through instead of shrugging", () => {
    // A rule added on the server after this shipped still has to reach the person holding the
    // phone, even if only as the code the office can look up.
    expect(refusalFor("schema_field_some_future_rule")).toContain("schema_field_some_future_rule");
  });
});

describe("saying what stopped a write that never reached a rule", () => {
  it("keeps the connection message written for this app rather than restating a code", () => {
    expect(
      schemaCardWriteRefusal(
        new ApiError({
          status: 0,
          code: "network_error",
          message: "No connection to IronWrap OS. Your saved work stays on this device.",
        }),
        definition({}),
      ),
    ).toMatch(/No connection to IronWrap OS/);
  });
});
