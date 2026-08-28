import { describe, expect, it } from "vitest";

import type { FieldDateOptions } from "../field/field-formatting";
import type { SchemaCardEntry } from "../schema-forms/schema-card-contracts";
import type { EntityDocument } from "./document-contracts";
import {
  bindingCount,
  documentSegments,
  readableDocuments,
  resolveDocument,
  resolveDocuments,
  sortDocumentsForShelf,
} from "./document-resolution";

const dateOptions: FieldDateOptions = { locale: "en-CA", timeZone: "America/Edmonton" };

function entry(
  fieldKey: string,
  label: string,
  value: unknown,
  overrides: Partial<SchemaCardEntry["definition"]> = {},
): SchemaCardEntry {
  return {
    definition: {
      field_id: `fld_${fieldKey}`,
      field_key: fieldKey,
      revision_id: "rev_1",
      version: 1,
      label,
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
    },
    value:
      value === undefined
        ? null
        : {
            value_revision_id: `val_${fieldKey}`,
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
  };
}

function document(overrides: Partial<EntityDocument> = {}): EntityDocument {
  return {
    template_id: "tpl_materials",
    template_key: "materials_list",
    label: "Materials list",
    revision_id: "rev_tpl_1",
    version: 1,
    blocks: [
      { kind: "heading", level: 1, text: "Materials" },
      { kind: "field", field_id: "fld_bundles" },
      { kind: "field", field_id: "fld_underlayment" },
      { kind: "text", text: "Confirm counts with the shop before ordering." },
    ],
    ...overrides,
  };
}

/** Index into a result the assertion is about to describe, failing loudly if it is not there. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an entry at index ${index}`);
  return item;
}

describe("resolveDocument", () => {
  it("fills every binding from the record's authorized values, in the authored order", () => {
    const resolved = resolveDocument(
      document(),
      [entry("bundles", "Bundles", 42), entry("underlayment", "Underlayment", "Synthetic")],
      dateOptions,
    );

    expect(resolved.lines).toEqual([
      { kind: "heading", level: 1, text: "Materials" },
      {
        kind: "field",
        fieldId: "fld_bundles",
        fieldKey: "bundles",
        label: "Bundles",
        text: "42",
        state: "value",
      },
      {
        kind: "field",
        fieldId: "fld_underlayment",
        fieldKey: "underlayment",
        label: "Underlayment",
        text: "Synthetic",
        state: "value",
      },
      { kind: "text", text: "Confirm counts with the shop before ordering." },
    ]);
    expect(resolved.withheldCount).toBe(0);
    expect(resolved.emptyCount).toBe(0);
  });

  it("formats a binding by the field's own type rather than printing the raw value", () => {
    const resolved = resolveDocument(
      document({ blocks: [{ kind: "field", field_id: "fld_bundle_price" }] }),
      [
        entry("bundle_price", "Bundle price", 12_950, {
          field_type: "money",
          validator_config: { currency: "CAD" },
        }),
      ],
      dateOptions,
    );

    expect(at(resolved.lines, 0)).toMatchObject({ state: "value", text: "$129.50" });
  });

  /**
   * The acceptance line this whole surface exists for: a role the server did not authorize for a
   * field receives no entry for it, so the document has nothing to render and says so instead of
   * quietly dropping the line.
   */
  it("marks a binding withheld when the reader's record read never carried that field", () => {
    const resolved = resolveDocument(document(), [entry("bundles", "Bundles", 42)], dateOptions);

    expect(at(resolved.lines, 2)).toEqual({
      kind: "field",
      fieldId: "fld_underlayment",
      fieldKey: null,
      label: null,
      text: "Not shared with your role",
      state: "withheld",
    });
    expect(resolved.withheldCount).toBe(1);
  });

  it("shows a configured but unfilled binding as unrecorded rather than dropping it", () => {
    const resolved = resolveDocument(
      document(),
      [entry("bundles", "Bundles", 42), entry("underlayment", "Underlayment", undefined)],
      dateOptions,
    );

    expect(at(resolved.lines, 2)).toMatchObject({ state: "empty", text: "Not recorded" });
    expect(resolved.emptyCount).toBe(1);
    expect(resolved.withheldCount).toBe(0);
  });

  it("honours a field's configured visibility rule against the values in this payload", () => {
    const resolved = resolveDocument(
      document({ blocks: [{ kind: "field", field_id: "fld_permit_number" }] }),
      [
        entry("permit_required", "Permit required", false),
        entry("permit_number", "Permit number", "AB-1", {
          visibility_key: "when_field_equals",
          visibility_config: { field_key: "permit_required", value: true },
        }),
      ],
      dateOptions,
    );

    expect(at(resolved.lines, 0)).toMatchObject({ state: "withheld" });
  });
});

describe("readableDocuments", () => {
  it("keeps a document the reader can partly read", () => {
    const resolved = resolveDocuments([document()], [entry("bundles", "Bundles", 42)], dateOptions);
    expect(readableDocuments(resolved)).toHaveLength(1);
  });

  it("drops a document whose every binding is withheld", () => {
    const resolved = resolveDocuments([document()], [], dateOptions);
    expect(bindingCount(at(resolved, 0))).toBe(2);
    expect(readableDocuments(resolved)).toEqual([]);
  });

  it("keeps a document that binds nothing, because its prose is the whole document", () => {
    const resolved = resolveDocuments(
      [document({ blocks: [{ kind: "text", text: "Read the safety sheet before you start." }] })],
      [],
      dateOptions,
    );
    expect(readableDocuments(resolved)).toHaveLength(1);
  });
});

describe("sortDocumentsForShelf", () => {
  it("orders the shelf by label so the same document sits in the same place on every job", () => {
    const resolved = resolveDocuments(
      [
        document({ template_id: "tpl_2", template_key: "materials_list", label: "Materials list" }),
        document({ template_id: "tpl_1", template_key: "contract", label: "Contract" }),
      ],
      [entry("bundles", "Bundles", 42), entry("underlayment", "Underlayment", "Synthetic")],
      dateOptions,
    );

    expect(sortDocumentsForShelf(resolved).map((entry) => entry.label)).toEqual([
      "Contract",
      "Materials list",
    ]);
  });
});

describe("documentSegments", () => {
  it("groups consecutive bindings into one list and keeps prose between them", () => {
    const resolved = resolveDocument(
      document(),
      [entry("bundles", "Bundles", 42), entry("underlayment", "Underlayment", "Synthetic")],
      dateOptions,
    );

    expect(documentSegments(resolved).map((segment) => segment.kind)).toEqual([
      "heading",
      "fields",
      "text",
    ]);
    const fields = documentSegments(resolved)[1];
    expect(fields?.kind === "fields" && fields.lines).toHaveLength(2);
  });
});
