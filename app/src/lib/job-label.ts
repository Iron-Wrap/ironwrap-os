/**
 * The ruled name for a job (D5): "{customer} · {street} · {code}". The customer and street lead,
 * and the code may follow but never leads ("Elena Ruiz · 118 Larkspur Way NW · J-ELENA"). The
 * street is the address up to its first comma; a part the read does not have is left out.
 */
type JobLabelSource = {
  customer?: string | null;
  address?: string | null;
  code?: string | null;
};

/** The label's lead ("{customer} · {street}") and its code, for a screen that keeps the code whole. */
export function jobLabelParts(job: JobLabelSource): { lead: string | null; code: string | null } {
  const street = job.address?.split(",")[0]?.trim();
  const lead = [job.customer?.trim(), street].filter(Boolean).join(" · ");
  return { lead: lead || null, code: job.code?.trim() || null };
}

export function jobLabel(job: JobLabelSource): string | null {
  const { lead, code } = jobLabelParts(job);
  return [lead, code].filter(Boolean).join(" · ") || null;
}
