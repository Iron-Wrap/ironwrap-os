import { jobLabelParts } from "../lib/job-label";

/**
 * A job named the ruled way (D5): "{customer} · {street} · Ref {code}", with "Ref" and the code
 * kept whole on one line ("IW-" and "ACCEPTANCE" on two lines read as two things). Renders nothing when the read
 * has none of the three, so the screen can say what it does instead.
 */
export function JobLabelText(job: {
  customer?: string | null;
  address?: string | null;
  code?: string | null;
}) {
  const { lead, code } = jobLabelParts(job);
  // A no-break space keeps each dot with the part before it, so no line starts with "·".
  if (!lead && !code) return null;
  return (
    <>
      {lead?.replaceAll(" · ", "\u00a0· ")}
      {lead && code ? "\u00a0· " : null}
      {code ? (
        <span className="whitespace-nowrap">
          {/* plain-language-allow: unlabelled-code - D5 labels the code "Ref" in the line itself */}
          Ref {code}
        </span>
      ) : null}
    </>
  );
}
