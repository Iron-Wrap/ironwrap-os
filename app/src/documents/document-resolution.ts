import type { FieldDateOptions } from "../field/field-formatting";
import {
  applyControllingVisibility,
  formatSchemaCardValue,
  schemaValueIsEmpty,
} from "../schema-forms/schema-card-presentation";
import type { SchemaCardEntry } from "../schema-forms/schema-card-contracts";
import type { EntityDocument } from "./document-contracts";

/**
 * Turning an administrator's document layout plus the reader's authorized field values into lines a
 * person can read on a phone.
 *
 * The join is deliberately one-directional: the layout may only ever ASK for a field, and the
 * answer comes from the authority-filtered record read. A binding whose field is not in that
 * payload has no value here and never will — this module has nothing else to fall back on, which
 * is what keeps per-field read authority a server decision rather than a client one.
 */

export type ResolvedDocumentLine =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "text"; text: string }
  | {
      kind: "field";
      fieldId: string;
      /** The administrator's label, or null when the reader never received the definition. */
      fieldKey: string | null;
      label: string | null;
      text: string;
      state: "value" | "empty" | "withheld";
    };

export interface ResolvedDocument {
  templateId: string;
  templateKey: string;
  label: string;
  revisionId: string;
  version: number;
  lines: ResolvedDocumentLine[];
  /** Bindings this reader's authority did not reach. Zero means the document is complete for them. */
  withheldCount: number;
  /** Bindings whose field exists for this reader but holds nothing yet. */
  emptyCount: number;
}

const WITHHELD_TEXT = "Not shared with your role";
const EMPTY_TEXT = "Not recorded";

export function resolveDocument(
  document: EntityDocument,
  entries: readonly SchemaCardEntry[],
  dateOptions: FieldDateOptions,
): ResolvedDocument {
  const visible = applyControllingVisibility([...entries]);
  const byFieldId = new Map(visible.map((entry) => [entry.definition.field_id, entry]));
  let withheldCount = 0;
  let emptyCount = 0;
  const lines = document.blocks.map((block): ResolvedDocumentLine => {
    if (block.kind === "heading")
      return { kind: "heading", level: headingLevel(block.level), text: block.text };
    if (block.kind === "text") return { kind: "text", text: block.text };
    const entry = byFieldId.get(block.field_id);
    if (!entry) {
      withheldCount += 1;
      return {
        kind: "field",
        fieldId: block.field_id,
        fieldKey: null,
        label: null,
        text: WITHHELD_TEXT,
        state: "withheld",
      };
    }
    const empty = schemaValueIsEmpty(entry.value);
    if (empty) emptyCount += 1;
    return {
      kind: "field",
      fieldId: block.field_id,
      fieldKey: entry.definition.field_key,
      label: entry.definition.label,
      text: empty ? EMPTY_TEXT : formatSchemaCardValue(entry.definition, entry.value, dateOptions),
      state: empty ? "empty" : "value",
    };
  });
  return {
    templateId: document.template_id,
    templateKey: document.template_key,
    label: document.label,
    revisionId: document.revision_id,
    version: document.version,
    lines,
    withheldCount,
    emptyCount,
  };
}

export function resolveDocuments(
  documents: readonly EntityDocument[],
  entries: readonly SchemaCardEntry[],
  dateOptions: FieldDateOptions,
): ResolvedDocument[] {
  return documents.map((document) => resolveDocument(document, entries, dateOptions));
}

/**
 * A document whose every binding is withheld tells the reader nothing except that a document they
 * may not read exists. The shelf hides those rather than offering an all-blank page, while a
 * partially authorized document is still offered — the shop that may read quantities but not price
 * still needs the quantities.
 */
export function readableDocuments(documents: readonly ResolvedDocument[]): ResolvedDocument[] {
  return documents.filter(
    (document) => bindingCount(document) === 0 || document.withheldCount < bindingCount(document),
  );
}

export function bindingCount(document: ResolvedDocument): number {
  return document.lines.filter((line) => line.kind === "field").length;
}

/**
 * Documents keep the administrator's authored order. `blocks` arrives in template order and stays
 * that way; only the shelf itself is sorted, by label, so a tenant with several documents finds
 * the same one in the same place on every job.
 */
export function sortDocumentsForShelf(documents: readonly ResolvedDocument[]): ResolvedDocument[] {
  return [...documents].sort(
    (left, right) =>
      left.label.localeCompare(right.label) || left.templateKey.localeCompare(right.templateKey),
  );
}

function headingLevel(level: number): 1 | 2 | 3 {
  return level === 1 ? 1 : level === 2 ? 2 : 3;
}

export type DocumentSegment =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "text"; text: string }
  | { kind: "fields"; lines: Extract<ResolvedDocumentLine, { kind: "field" }>[] };

/**
 * Consecutive bindings become one description list, and the authored headings and paragraphs stay
 * between them. A `<dl>` may only hold terms and definitions, so interleaving prose inside one
 * would produce markup a screen reader cannot walk — this is what keeps the document both a real
 * document and valid.
 */
export function documentSegments(document: ResolvedDocument): DocumentSegment[] {
  const segments: DocumentSegment[] = [];
  for (const line of document.lines) {
    if (line.kind === "field") {
      const last = segments.at(-1);
      if (last?.kind === "fields") last.lines.push(line);
      else segments.push({ kind: "fields", lines: [line] });
      continue;
    }
    segments.push(line);
  }
  return segments;
}
