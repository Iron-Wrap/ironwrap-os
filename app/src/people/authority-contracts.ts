import { z } from "zod";

/** The desk mirrors the Worker's response exactly. The verdict is the server's, computed by the
 *  same two rules the fence uses when it stops work, so this screen can never disagree with it. */
export const authorityVerdicts = [
  "revoked",
  "expired",
  "contradictory",
  "unknown",
  "expiring",
  "clear",
] as const;
export type AuthorityVerdict = (typeof authorityVerdicts)[number];

export const authorityHeadSchema = z.object({
  authority_record_id: z.string(),
  authority_version: z.number().int(),
  authority_kind: z.string().nullable(),
  authority_scope: z.string().nullable(),
  scope_type: z.string().nullable(),
  scope_ref: z.string().nullable(),
  issuer_name: z.string(),
  issuer_jurisdiction: z.string(),
  verification_state: z.enum(["verified", "revoked", "contradictory", "unavailable"]),
  authority_effective_from: z.string().nullable(),
  authority_expires_at: z.string().nullable(),
  authority_revoked_at: z.string().nullable(),
  observed_at: z.string(),
  verdict: z.enum(authorityVerdicts),
  denial_code: z.string().nullable(),
  days_left: z.number().int().nullable(),
});

export const authoritySubjectSchema = z.object({
  subject_key: z.string(),
  subject_type: z.string().nullable(),
  subject_role: z.string().nullable(),
  person_user: z.string().nullable(),
  organization: z.string().nullable(),
  records: z.array(authorityHeadSchema),
});

export const authorityDeskResponseSchema = z.object({
  version: z.literal(1),
  read_model_generated_at: z.string(),
  expiring_within_days: z.number().int(),
  subjects: z.array(authoritySubjectSchema),
});

export const authorityReadbackSchema = z.object({
  readback_id: z.string(),
  authority_record_id: z.string(),
  authority_version: z.number().int(),
  issuer_name: z.string(),
  issuer_jurisdiction: z.string(),
  issuer_reference: z.string(),
  verification_state: z.string(),
  authority_effective_from: z.string().nullable(),
  authority_expires_at: z.string().nullable(),
  authority_revoked_at: z.string().nullable(),
  evidence_sha256: z.string(),
  observed_by_user_id: z.string(),
  observed_at: z.string(),
});

export const authorityReadbacksResponseSchema = z.object({
  version: z.literal(1),
  authority_record_id: z.string(),
  readbacks: z.array(authorityReadbackSchema),
});

export type AuthorityHead = z.infer<typeof authorityHeadSchema>;
export type AuthoritySubject = z.infer<typeof authoritySubjectSchema>;
export type AuthorityDeskResponse = z.infer<typeof authorityDeskResponseSchema>;
export type AuthorityReadback = z.infer<typeof authorityReadbackSchema>;

/** Plain words for a verdict. The word carries the meaning; the colour only repeats it. */
export function verdictLabel(verdict: AuthorityVerdict): string {
  switch (verdict) {
    case "revoked":
      return "Revoked";
    case "expired":
      return "Expired";
    case "contradictory":
      return "Contradictory";
    case "unknown":
      return "Unknown";
    case "expiring":
      return "Expiring";
    case "clear":
      return "Clear";
  }
}

/** What the fence would say, in the words an operator can act on. An unrecognised code is
 *  printed as it came from the server rather than swallowed. */
export function denialText(code: string | null): string | null {
  switch (code) {
    case null:
      return null;
    case "authority_revoked":
      return "The issuer recorded this as revoked. Work that needs it stops.";
    case "authority_expired":
      return "The expiry date has passed. Work that needs it stops until it is renewed.";
    case "authority_contradictory":
      return "Two readbacks disagree at the same version. Nobody can act on it until that is resolved.";
    case "authority_unavailable":
      return "The issuer did not answer, so this cannot be treated as current.";
    case "authority_stale":
      return "The dates on file are incomplete or not yet in effect.";
    case "authority_unverifiable":
      return "The evidence on file does not verify against the issuer record.";
    case "authority_superseded":
      return "A later record replaced this one.";
    case "authority_missing":
      return "No readback on file.";
    case "authority_ambiguous":
      return "More than one head matched, so none can be treated as current.";
    default:
      return code;
  }
}

export function subjectName(subject: AuthoritySubject): string {
  return subject.person_user ?? subject.organization ?? "Unnamed subject";
}
