/**
 * The ruled name for a job (D5): "{customer} · {street} · {code}". The customer and street lead,
 * and the code may follow but never leads ("Elena Ruiz · 118 Larkspur Way NW · J-ELENA"). The
 * street is the address up to its first comma; a part the read does not have is left out.
 */
export function jobLabel(job: {
  customer?: string | null;
  address?: string | null;
  code?: string | null;
}): string | null {
  const street = job.address?.split(",")[0]?.trim();
  const parts = [job.customer?.trim(), street, job.code?.trim()].filter((part): part is string =>
    Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}
