import { jobLabelParts } from "../lib/job-label";

/**
 * A job named the ruled way (D5): "{customer} · {street} · {code}", with the code kept whole on
 * one line ("IW-" and "ACCEPTANCE" on two lines read as two things). Renders nothing when the read
 * has none of the three, so the screen can say what it does instead.
 */
export function JobLabelText(job: {
  customer?: string | null;
  address?: string | null;
  code?: string | null;
}) {
  const { lead, code } = jobLabelParts(job);
  if (!lead && !code) return null;
  return (
    <>
      {lead}
      {lead && code ? " · " : null}
      {/* plain-language-allow: unlabelled-code - D5 puts the code last, after the customer and street */}
      {code ? <span className="whitespace-nowrap">{code}</span> : null}
    </>
  );
}
