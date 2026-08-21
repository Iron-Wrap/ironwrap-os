import type { ServiceCase } from "./service-contracts";

// Shared wording and small presentational pieces for the service surfaces. Lifecycle codes are the
// bus's vocabulary; the office reads plain English.

const STATE_LABELS: Record<ServiceCase["state"], string> = {
  intake: "New",
  triaged: "Checked",
  diagnosed: "Cause found",
  remedy_issued: "Fix planned",
  remedy_verified: "Fix checked",
  customer_accepted: "Customer said yes",
  disputed: "Customer does not agree",
  closed: "Done",
  reopened: "Open again",
};

const SEVERITY_LABELS: Record<ServiceCase["severity"], string> = {
  emergency: "Emergency",
  urgent: "Urgent",
  standard: "Standard",
  monitor: "Watch",
};

const CODE_LABELS: Record<string, string> = {
  accepted: "Yes",
  disputed: "No",
  emergency: "Emergency",
  executed: "Sent",
  excluded: "Not covered",
  failed: "No",
  inconclusive: "Not known",
  insurer: "Insurance company",
  ironwrap_workmanship: "IronWrap work",
  manufacturer: "Maker",
  material_manufacturer: "Maker material",
  not_executed: "Not sent",
  remedied_accepted: "Fix accepted",
  supplier: "Supplier",
  succeeded: "Paid",
  third_party: "Other company",
  undetermined: "Not known",
  unknown: "Not known",
  verified: "Yes",
  weather: "Weather",
  workmanship: "Work quality",
};

export function stateLabel(state: ServiceCase["state"]): string {
  return STATE_LABELS[state];
}

export function severityLabel(severity: ServiceCase["severity"]): string {
  return SEVERITY_LABELS[severity];
}

export function codeLabel(code: string): string {
  return CODE_LABELS[code] ?? code.replaceAll("_", " ");
}

/** Money is stored in cents and shown in the tenant's currency, never rounded away. */
export function cadFromCents(cents: number): string {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
}
