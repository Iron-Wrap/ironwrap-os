// adapters.ts - the only place in the importer that knows what a particular CRM calls things.
//
// An adapter is an alias table plus the shared `normalizeWith` reducer. Adding a provider is a new
// constant, never a new code path; swapping providers changes which constant the caller names.
// Two adapters ship: the documented canonical format, and the GoHighLevel-style opportunity export
// the stakeholder runs today.

import { normalizeEmail, normalizePhone } from "../core.ts";
import type { CanonicalRow, ColumnAliases, CrmImportAdapter, SourceRecord } from "./contracts.ts";

const MAX_TEXT = 240;
const MAX_EXTRAS = 40;

/** Canonical fields every adapter maps onto. The planner reads nothing else. */
const CANONICAL_FIELDS = [
  "externalId",
  "contactName",
  "email",
  "phone",
  "addressLine1",
  "city",
  "province",
  "postalCode",
  "services",
  "value",
  "sourceStage",
  "leadNumber",
  "jobNumber",
] as const;

type CanonicalField = (typeof CANONICAL_FIELDS)[number];

function pick(record: SourceRecord, aliases: readonly string[] | undefined): string | null {
  for (const alias of aliases ?? []) {
    const hit = Object.keys(record).find((column) => column.toLowerCase() === alias.toLowerCase());
    if (hit === undefined) continue;
    const value = (record[hit] ?? "").trim();
    if (value !== "") return value.slice(0, MAX_TEXT);
  }
  return null;
}

/** Split a multi-value cell. Order is preserved: the first entry is the primary service. */
function splitServices(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,|]|\s+\/\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .slice(0, 10);
}

/**
 * Parse a currency cell to integer cents. Accepts `C$6,400.00`, `6400`, `6,400.5`. Refuses anything
 * else rather than guessing, because a mis-parsed value would land on a card as real money.
 */
export function parseValueCents(raw: string | null): number | null {
  if (raw === null) return null;
  const cleaned = raw.replace(/[\s,]/g, "").replace(/^(?:[A-Z]{0,3}\$|\$)/i, "");
  if (cleaned === "") return null;
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(cleaned)) throw new Error(`crm_import_value_invalid:${raw.slice(0, 40)}`);
  if (cleaned.startsWith("-")) throw new Error(`crm_import_value_negative:${raw.slice(0, 40)}`);
  const [whole, fraction = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error("crm_import_value_out_of_range");
  return cents;
}

function normalizeWith(
  aliases: ColumnAliases,
  activityColumns: readonly string[],
  record: SourceRecord,
): CanonicalRow {
  const claimed = new Set<string>();
  const claim = (field: CanonicalField): string | null => {
    for (const alias of aliases[field] ?? []) {
      const hit = Object.keys(record).find((column) => column.toLowerCase() === alias.toLowerCase());
      if (hit !== undefined) claimed.add(hit.toLowerCase());
    }
    return pick(record, aliases[field]);
  };

  const externalId = claim("externalId");
  const contactName = claim("contactName");
  const rawEmail = claim("email");
  const rawPhone = claim("phone");
  // A contact method our own normalizers refuse is not silently discarded and does not sink an
  // otherwise-good row: it is archived verbatim and reported as an unmapped column.
  const email = normalizeEmail(rawEmail);
  const phone = normalizePhone(rawPhone);
  const unparseable: Record<string, string> = {};
  if (rawEmail && !email) unparseable["email (unparseable)"] = rawEmail;
  if (rawPhone && !phone) unparseable["phone (unparseable)"] = rawPhone;
  const addressLine1 = claim("addressLine1");
  const city = claim("city");
  const province = claim("province");
  const postalCode = claim("postalCode");
  const services = splitServices(claim("services"));
  const valueCents = parseValueCents(claim("value"));
  const sourceStage = claim("sourceStage");
  const leadNumber = claim("leadNumber");
  const jobNumber = claim("jobNumber");

  const activity: Record<string, string> = {};
  for (const column of activityColumns) {
    const hit = Object.keys(record).find((name) => name.toLowerCase() === column.toLowerCase());
    if (hit === undefined) continue;
    claimed.add(hit.toLowerCase());
    const value = (record[hit] ?? "").trim();
    if (value !== "") activity[hit] = value.slice(0, MAX_TEXT);
  }

  const extras: Record<string, string> = { ...unparseable };
  for (const [column, value] of Object.entries(record)) {
    if (claimed.has(column.toLowerCase())) continue;
    const text = (value ?? "").trim();
    if (text === "") continue;
    if (Object.keys(extras).length >= MAX_EXTRAS) break;
    extras[column] = text.slice(0, MAX_TEXT);
  }

  return {
    externalId,
    contactName,
    email,
    phone,
    addressLine1,
    city,
    province,
    postalCode,
    services,
    valueCents,
    sourceStage,
    leadNumber,
    jobNumber,
    activity,
    extras,
  };
}

function adapter(
  id: string,
  label: string,
  aliases: ColumnAliases,
  activityColumns: readonly string[],
): CrmImportAdapter {
  return {
    id,
    label,
    aliases,
    activityColumns,
    normalize: (record) => normalizeWith(aliases, activityColumns, record),
  };
}

/**
 * The documented import format (docs/CRM-IMPORT-MAP.md). This is the shape a customer is asked for
 * when their CRM has no adapter of its own.
 */
export const GENERIC_ADAPTER = adapter(
  "generic",
  "IronWrap canonical CRM export",
  {
    externalId: ["external_id", "id"],
    contactName: ["contact_name", "name"],
    email: ["email"],
    phone: ["phone"],
    addressLine1: ["address", "address_line1"],
    city: ["city"],
    province: ["province", "state"],
    postalCode: ["postal_code", "postal", "zip"],
    services: ["service", "services"],
    value: ["value", "amount"],
    sourceStage: ["stage"],
    leadNumber: ["lead_number"],
    jobNumber: ["job_number"],
  },
  ["activity_count", "note_count"],
);

/**
 * GoHighLevel-style opportunity export - the stakeholder's own CRM shape. Column names follow the
 * two board screenshots recorded on ELEC-158; when the real export arrives, this alias table is the
 * single place that changes.
 */
export const GHL_ADAPTER = adapter(
  "ghl",
  "GoHighLevel opportunity export",
  {
    externalId: ["opportunity id", "opportunity_id", "id"],
    contactName: ["contact name", "opportunity name", "full name", "name"],
    email: ["email", "contact email"],
    phone: ["phone", "contact phone"],
    addressLine1: ["address", "address line 1", "street address"],
    city: ["city"],
    province: ["state", "province"],
    postalCode: ["postal code", "zip", "postal"],
    services: ["services needed", "service", "services"],
    value: ["opportunity value", "value", "lead value"],
    sourceStage: ["stage", "pipeline stage", "opportunity stage"],
    leadNumber: ["lead number", "lead #", "lead no"],
    jobNumber: ["job number", "job #", "job no"],
  },
  ["notes", "tasks", "emails", "calls", "sms", "conversations"],
);

export const ADAPTERS: readonly CrmImportAdapter[] = [GENERIC_ADAPTER, GHL_ADAPTER];

export function resolveAdapter(id: string): CrmImportAdapter | null {
  return ADAPTERS.find((candidate) => candidate.id === id) ?? null;
}
