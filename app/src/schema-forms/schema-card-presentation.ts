import { formatFieldDay, formatFieldTimestamp } from "../field/field-formatting";
import type { FieldDateOptions } from "../field/field-formatting";
import { ApiError } from "../lib/api";
import { messageFor } from "../lib/plain-error";
import { schemaCardFieldWritable } from "./schema-card-contracts";
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
      group = { key, label: key ? namespaceLabel(key) : DEFAULT_GROUP_LABEL, entries: [] };
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

/**
 * A group's title is the administrator's own namespace word, so "roofing" reads "Roofing". A
 * namespace that is not one plain word ("metal_roofing") is a key, not a title: it takes the
 * default label instead of being spelled out with its underscores swapped for spaces.
 */
function namespaceLabel(namespace: string): string {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(namespace)
    ? namespace.charAt(0).toUpperCase() + namespace.slice(1)
    : DEFAULT_GROUP_LABEL;
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
  return typeof option === "string"
    ? option
    : typeof option === "number"
      ? String(option)
      : "Not set";
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

/**
 * ---------------------------------------------------------------------------
 * Writing a value back (ELEC-193)
 * ---------------------------------------------------------------------------
 *
 * The same rule governs this half as the read half: the server decides, this file presents. What
 * follows turns three server-published facts — `writable`, `field_type`, `offline_mode` — into an
 * affordance, shapes a control's value into the type the field declares, and gives the server's
 * refusal codes words a crew member can act on. It never decides who may write, and it never
 * re-implements a validator.
 */

/** Types whose value is an immutable receipt, produced by a capture flow rather than typed. */
const EVIDENCE_FIELD_TYPES = new Set(["image", "attachment", "provider_fact"]);

export type SchemaCardReadOnlyReason = "not_writable" | "evidence_capture" | "needs_connection";

export type SchemaCardEditability =
  | { kind: "editable"; queueable: boolean }
  | { kind: "read_only"; reason: SchemaCardReadOnlyReason };

/**
 * Whether to draw an edit control for this field, and why not when the answer is no.
 *
 * `writable` is the only authority input, and it is the server's own derivation of the two
 * conditions the write route enforces. The card does not look at roles, does not draw a control
 * and let a write bounce off a 403, and treats an absent flag as "no" — the three postures #200
 * refused to choose between, now settled by the server answering the question.
 *
 * The other two refusals are not about authority at all. An evidence field's value is a receipt
 * the server issues, so there is a real edit path and it is not a text box. An `online_only` or
 * `offline_read` field is one an administrator marked as needing a live connection to write, so
 * offline the control says so instead of accepting an entry that could never be queued.
 */
export function schemaCardEditability(
  entry: SchemaCardEntry,
  options: { online: boolean },
): SchemaCardEditability {
  if (!schemaCardFieldWritable(entry)) return { kind: "read_only", reason: "not_writable" };
  if (EVIDENCE_FIELD_TYPES.has(entry.definition.field_type))
    return { kind: "read_only", reason: "evidence_capture" };
  const queueable = entry.definition.offline_mode === "queueable";
  if (!options.online && !queueable) return { kind: "read_only", reason: "needs_connection" };
  return { kind: "editable", queueable };
}

export const schemaCardReadOnlyCopy: Record<SchemaCardReadOnlyReason, string | null> = {
  // Silence on purpose. A crew member reading a card where some fields carry a control and others
  // do not has already been told; adding "you may not edit this" to every other row spends a phone
  // screen restating an absence.
  not_writable: null,
  evidence_capture: "Recorded from a photo, a file, or a linked system.",
  needs_connection: "This field needs a connection before it can be changed.",
};

/**
 * Whether changing this field must be recorded as an explicit correction rather than a plain
 * resubmission, once someone else has moved it underneath.
 *
 * Both halves are read off the definition the record view already publishes. An evidence-classed
 * field carries a claim someone may later have to defend, and a non-standard retention policy is
 * an administrator saying this record is kept for a reason beyond convenience. Overwriting either
 * silently would leave the audit trail describing only the last person to type.
 *
 * Append-only storage means both values survive either way. What the correction adds is WHY: the
 * server records `based_on_value_revision_id` and `correction_reason` on the new revision, and the
 * card renders them (`schemaCardCorrectionNote`) so the trail is visible where the work happens.
 */
export function schemaCardRequiresCorrection(definition: SchemaCardFieldDefinition): boolean {
  return definition.evidence_class !== "none" || definition.retention_policy !== "standard";
}

/** The correction lineage on a value, when it has one, as one readable line. */
export function schemaCardCorrectionNote(value: SchemaCardValue | null): string | null {
  if (!value?.based_on_value_revision_id) return null;
  const reason = value.correction_reason?.trim();
  return reason ? `Corrected: ${reason}` : "Corrected";
}

/**
 * The value a control should start from — always a string or a string array, because that is what
 * a DOM control holds. `formatSchemaCardValue` is for reading; this is for editing, and the two
 * differ deliberately: an editor must round-trip, so it shows `142`, never `142` formatted into a
 * locale's thousands separators.
 */
export function schemaCardControlValue(
  definition: SchemaCardFieldDefinition,
  value: SchemaCardValue | null,
): string | string[] | boolean {
  const held = schemaValueIsEmpty(value) ? null : (value as SchemaCardValue).value;
  switch (definition.field_type) {
    case "boolean":
      return held === true;
    case "multiselect":
      return Array.isArray(held)
        ? held.filter((item): item is string => typeof item === "string")
        : [];
    case "money":
      return typeof held === "number" && Number.isFinite(held) ? (held / 100).toFixed(2) : "";
    case "datetime":
      return typeof held === "string" ? localDateTimeInput(held) : "";
    default:
      return typeof held === "string" ? held : typeof held === "number" ? String(held) : "";
  }
}

export type SchemaCardWireValue = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * Turn what a control holds into the JSON the field's type declares.
 *
 * This is encoding, not validation. The only way it refuses is when the entry cannot be expressed
 * as the declared type at all — letters in a number box, a date the calendar could not produce.
 * Everything a person could reasonably mean but an administrator has ruled out (a required field
 * left empty, a value outside a configured range, an option not on the list) goes to the server
 * and comes back as that server's own refusal, because those rules are configuration and change
 * without this file changing.
 */
export function schemaCardWireValue(
  definition: SchemaCardFieldDefinition,
  raw: string | string[] | boolean,
): SchemaCardWireValue {
  if (definition.field_type === "boolean") return { ok: true, value: raw === true };
  if (definition.field_type === "multiselect")
    return { ok: true, value: Array.isArray(raw) ? raw : [] };
  const text = typeof raw === "string" ? raw.trim() : "";
  // An emptied control means "this field holds nothing". The server decides whether that is
  // allowed — a `required` validator refuses it, everything else accepts it.
  if (text === "") return { ok: true, value: null };
  switch (definition.field_type) {
    case "integer": {
      const parsed = Number(text);
      if (!Number.isSafeInteger(parsed)) return { ok: false, message: "Enter a whole number." };
      return { ok: true, value: parsed };
    }
    case "number": {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return { ok: false, message: "Enter a number." };
      return { ok: true, value: parsed };
    }
    case "money": {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return { ok: false, message: "Enter an amount." };
      // Money crosses the wire as minor units, matching the server's integer columns.
      const minorUnits = Math.round(parsed * 100);
      if (!Number.isSafeInteger(minorUnits))
        return { ok: false, message: "Enter a smaller amount." };
      return { ok: true, value: minorUnits };
    }
    case "datetime": {
      const isoValue = canonicalDateTime(text);
      if (!isoValue) return { ok: false, message: "Enter a date and a time." };
      return { ok: true, value: isoValue };
    }
    default:
      return { ok: true, value: text };
  }
}

/**
 * The server's refusal, in words that say what to do next.
 *
 * The record routes answer a refused command as `{ error: <code>, ...detail }` with no prose, so
 * the code is the identity of the refusal and this table is only its wording. A code with no entry
 * falls through to whatever the server did send rather than to a shrug, so a rule added on the
 * server after this shipped still reaches the person holding the phone.
 */
export function schemaCardWriteRefusal(
  error: unknown,
  definition: SchemaCardFieldDefinition,
): string {
  if (!(error instanceof ApiError)) return "This value could not be saved. Try again.";
  switch (error.code) {
    case "schema_field_required":
      return `${definition.label} cannot be left empty.`;
    case "schema_field_email_invalid":
      return "Enter an email address, like name@example.com.";
    case "schema_field_phone_invalid":
      return "Enter a phone number with 7 to 32 digits.";
    case "schema_field_nonnegative_invalid":
      return "Enter zero or more.";
    case "schema_field_option_invalid":
      return "Choose one of the listed options.";
    case "schema_field_range_invalid":
      return rangeRefusal(definition);
    case "schema_field_date_invalid":
    case "schema_field_datetime_invalid":
      return "Enter a real date.";
    case "schema_field_value_type_invalid":
      return `${definition.label} does not accept what was entered.`;
    case "schema_field_write_forbidden":
    case "schema_field_assignment_forbidden":
      return "Your role cannot change this field. Ask the office to record it.";
    case "schema_field_not_visible":
      return "This field no longer applies to this job. Reload the card.";
    case "schema_field_retired":
      return "An administrator removed this field. Reload the card.";
    case "schema_field_definition_stale":
      return "An administrator changed this field while you were entering it. Reload the card and enter it again.";
    case "schema_field_correction_reason_required":
    case "schema_field_correction_reference_required":
      return "Say what you are correcting and why before saving.";
    case "schema_field_value_version_conflict":
      return "Someone else changed this field while you were entering it.";
    case "csrf_failed":
      return "Your session expired. Sign in again, then re-enter this value.";
    default:
      // The record routes answer `{ error: <code> }` with no prose, so `ApiError.message` on one
      // of them is only the HTTP reason phrase — "Bad Request" tells a crew member nothing and the
      // code at least gives the office something to look up. A dropped connection or a timeout
      // carries a message written for this app; `messageFor` keeps exactly those.
      return error.code.startsWith("schema_field_")
        ? `${definition.label} was refused (${error.code}). Tell the office what you were entering.`
        : messageFor(error, {
            fallback: `We could not confirm ${definition.label} was saved. Reload the card to check it before you enter it again.`,
          });
  }
}

function rangeRefusal(definition: SchemaCardFieldDefinition): string {
  const { min, max } = definition.validator_config;
  const low = typeof min === "number" ? min : null;
  const high = typeof max === "number" ? max : null;
  if (low !== null && high !== null) return `Enter a number between ${low} and ${high}.`;
  if (low !== null) return `Enter ${low} or more.`;
  if (high !== null) return `Enter ${high} or less.`;
  return "Enter a number inside the allowed range.";
}

/**
 * `datetime-local` gives `YYYY-MM-DDTHH:mm`; the server takes canonical UTC to the millisecond.
 * The device's own zone is what does the conversion, which is right for the crew member standing
 * on the roof and the reason the card shows the stored value back through the same conversion.
 */
function canonicalDateTime(local: string): string | null {
  const parsed = new Date(local);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

function localDateTimeInput(isoValue: string): string {
  const parsed = new Date(isoValue);
  if (!Number.isFinite(parsed.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}` +
    `T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  );
}
