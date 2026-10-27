/**
 * The ruled name for a job (D5): "{customer} · {street} · Ref {code}". The customer and street
 * lead, and the code follows with its label ("Elena Ruiz · 118 Larkspur Way NW · Ref J-ELENA"):
 * a bare code was read only by its place (gate e-d5-checkin). The
 * street is the address up to its first comma, keeping a unit that comes before it ("Unit 4, 118
 * Larkspur Way NW"); a part the read does not have is left out.
 */
/** An address line that is only a unit ("Unit 4", "Suite 200", "#12", "4B"), so the street follows. */
const UNIT_FIRST = /^(?:(?:unit|suite|ste|apt)\b.*|#\s*\w+|\d+[a-z]?)$/i;

type JobLabelSource = {
  customer?: string | null;
  address?: string | null;
  code?: string | null;
};

/** The label's lead ("{customer} · {street}") and its code, for a screen that keeps the code whole. */
export function jobLabelParts(job: JobLabelSource): { lead: string | null; code: string | null } {
  const [first, second] = (job.address ?? "").split(",").map((part) => part.trim());
  const street = first && second && UNIT_FIRST.test(first) ? `${first}, ${second}` : first;
  const lead = [job.customer?.trim(), street].filter(Boolean).join(" · ");
  return { lead: lead || null, code: job.code?.trim() || null };
}

export function jobLabel(job: JobLabelSource): string | null {
  const { lead, code } = jobLabelParts(job);
  return [lead, code ? `Ref ${code}` : null].filter(Boolean).join(" · ") || null;
}
