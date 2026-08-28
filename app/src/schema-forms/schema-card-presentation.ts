import { formatFieldDay, formatFieldTimestamp, humanizeFieldName } from "../field/field-formatting";
import type { FieldDateOptions } from "../field/field-formatting";
import type {
  SchemaCardEntry,
  SchemaCardFieldDefinition,
  SchemaCardValue,
} from "./schema-card-contracts";

/**
 * Turning the governed field vocabulary into something a person on a phone can read.
 *
 * Nothing here decides whether a field is shown to a role — the server already did that. What is
 * here is presentation of what arrived, plus one narrow defensive mirror of the visibility rule
 * (see `applyControllingVisibility`).
 */

export interface SchemaCardGroup {
  /** Stable identity: the field-key namespace, or "" for fields that carry none. */
  key: string;
  label: string;
  entries: SchemaCardEntry[];
}

const DEFAULT_GROUP_LABEL = "Details";

/**
 * Fields are grouped by the namespace their key carries before the first ".".
 *
 * This is how more than one service type coexists on a single card: an administrator who defines
 * `<service>.<field>` gets that service's fields rendered as their own titled block instead of
 * interleaved with another service's. The convention is optional and vertical-agnostic — a flat
 * key like `permit_number` simply lands in the default block, so a tenant that never namespaces
 * anything sees one ungrouped list and nothing changes for them.
 *
 * Server order (`position`) is preserved inside a group, and groups appear in the order their
 * first field does, so the administrator's ordering stays the ordering the crew sees.
 */
export function groupSchemaCardEntries(entries: SchemaCardEntry[]): SchemaCardGroup[] {
  const groups: SchemaCardGroup[] = [];
  const byKey = new Map<string, SchemaCardGroup>();
  for (const entry of [...entries].sort(byPosition)) {
    const key = namespaceOf(entry.definition.field_key);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: key ? humanizeFieldName(key) : DEFAULT_GROUP_LABEL, entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

function byPosition(left: SchemaCardEntry, right: SchemaCardEntry): number {
  return (
    left.definition.position - right.definition.position ||
    left.definition.field_key.localeCompare(right.definition.field_key)
  );
}

function namespaceOf(fieldKey: string): string {
  const separator = fieldKey.indexOf(".");
  return separator > 0 ? fieldKey.slice(0, separator) : "";
}

/**
 * Re-apply a field's configured visibility rule against the values in THIS payload.
 *
 * The server is decisive and has already evaluated `fieldVisible`, so this can only ever remove a
 * field the server sent — never restore one it withheld. It exists so a card that is re-rendered
 * from values already in hand (a cached offline packet, or a value refreshed in place) does not
 * show a dependent field whose controller no longer satisfies the rule.
 *
 * When the controlling field is not in the payload the rule is NOT evaluated and the field is
 * kept: the controller may simply be one this role cannot read, and second-guessing the server
 * there would hide a field the server deliberately authorized.
 */
export function applyControllingVisibility(entries: SchemaCardEntry[]): SchemaCardEntry[] {
  const byFieldKey = new Map(entries.map((entry) => [entry.definition.field_key, entry]));
  return entries.filter((entry) => {
    const { visibility_key: rule, visibility_config: config } = entry.definition;
    if (rule === "always") return true;
    const controllingKey = typeof config.field_key === "string" ? config.field_key : null;
    if (!controllingKey) return true;
    const controlling = byFieldKey.get(controllingKey);
    if (!controlling) return true;
    const current = controlling.value?.value;
    if (rule === "when_field_present")
      return current !== null && current !== undefined && current !== "";
    if (rule === "when_field_equals") return current === config.value;
    return true;
  });
}

/** True when the field holds nothing yet — rendered as an explicit blank, never omitted. */
export function schemaValueIsEmpty(value: SchemaCardValue | null): boolean {
  if (!value) return true;
  const held = value.value;
  return (
    held === null || held === undefined || held === "" || (Array.isArray(held) && held.length === 0)
  );
}

/**
 * Present one value according to its closed field type. Every branch returns a string; a value
 * that does not match its declared type degrades to a readable marker rather than throwing, so one
 * malformed row can never blank the whole card.
 */
export function formatSchemaCardValue(
  definition: SchemaCardFieldDefinition,
  value: SchemaCardValue | null,
  options: FieldDateOptions,
): string {
  if (schemaValueIsEmpty(value)) return "Not recorded";
  const held = (value as SchemaCardValue).value;
  switch (definition.field_type) {
    case "boolean":
      return held === true ? "Yes" : held === false ? "No" : "Not readable";
    case "money":
      return formatMoney(held, definition, options);
    case "date":
      return typeof held === "string" ? formatFieldDay(held, options) : "Not readable";
    case "datetime":
      return typeof held === "string" ? formatFieldTimestamp(held, options) : "Not readable";
    case "multiselect":
      return Array.isArray(held) ? held.map(labelOfOption).join(", ") : "Not readable";
    case "image":
    case "attachment":
      return evidenceLabel(held);
    case "provider_fact":
      return providerFactLabel(held);
    case "integer":
    case "number":
      return typeof held === "number" && Number.isFinite(held)
        ? held.toLocaleString(options.locale)
        : "Not readable";
    default:
      return typeof held === "string"
        ? held
        : typeof held === "number"
          ? String(held)
          : "Not readable";
  }
}

/**
 * Money crosses the wire as minor units, matching the server's `*_cents` columns. The currency
 * comes from the field's own validator config so a tenant is never shown a hard-coded symbol.
 */
function formatMoney(
  held: unknown,
  definition: SchemaCardFieldDefinition,
  options: FieldDateOptions,
): string {
  if (typeof held !== "number" || !Number.isFinite(held)) return "Not readable";
  const currency =
    typeof definition.validator_config.currency === "string"
      ? definition.validator_config.currency
      : null;
  const amount = held / 100;
  if (!currency) return amount.toLocaleString(options.locale, { minimumFractionDigits: 2 });
  try {
    return amount.toLocaleString(options.locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    });
  } catch {
    return `${amount.toLocaleString(options.locale, { minimumFractionDigits: 2 })} ${currency}`;
  }
}

function labelOfOption(option: unknown): string {
  return typeof option === "string" ? option : typeof option === "number" ? String(option) : "—";
}

/**
 * Images and attachments are immutable evidence references, not inline blobs. The card names the
 * reference; opening it stays the evidence surface's job.
 */
function evidenceLabel(held: unknown): string {
  if (typeof held === "string") return held;
  if (held && typeof held === "object") {
    const record = held as Record<string, unknown>;
    for (const key of ["filename", "object_key", "evidence_id", "reference"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return "Attached";
}

/** A provider fact carries a readback receipt; the card shows the fact and says where it came from. */
function providerFactLabel(held: unknown): string {
  if (held && typeof held === "object") {
    const record = held as Record<string, unknown>;
    const fact = record.value ?? record.fact;
    const provider = typeof record.provider === "string" ? record.provider : null;
    const rendered =
      typeof fact === "string" || typeof fact === "number" ? String(fact) : "Recorded";
    return provider ? `${rendered} · from ${provider}` : rendered;
  }
  return typeof held === "string" ? held : "Recorded";
}
