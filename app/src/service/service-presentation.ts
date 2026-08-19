import type { ServiceCase } from "./service-contracts";

// Shared wording and small presentational pieces for the service surfaces. Lifecycle codes are the
// bus's vocabulary; the office reads plain English.

const STATE_LABELS: Record<ServiceCase["state"], string> = {
  intake: "Intake",
  triaged: "Triaged",
  diagnosed: "Diagnosed",
  remedy_issued: "Remedy issued",
  remedy_verified: "Remedy verified",
  customer_accepted: "Customer accepted",
  disputed: "Disputed",
  closed: "Closed",
  reopened: "Reopened",
};

const SEVERITY_LABELS: Record<ServiceCase["severity"], string> = {
  emergency: "Emergency",
  urgent: "Urgent",
  standard: "Standard",
  monitor: "Monitor",
};

export function stateLabel(state: ServiceCase["state"]): string {
  return STATE_LABELS[state];
}

export function severityLabel(severity: ServiceCase["severity"]): string {
  return SEVERITY_LABELS[severity];
}

export function codeLabel(code: string): string {
  return code.replaceAll("_", " ");
}

/** Money is stored in cents and shown in the tenant's currency, never rounded away. */
export function cadFromCents(cents: number): string {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
}
