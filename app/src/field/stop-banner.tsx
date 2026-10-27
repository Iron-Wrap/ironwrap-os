import { Phone } from "lucide-react";

import { Button } from "../components/ui/button";
import { Notice } from "../components/ui/notice";
import { jobLabel } from "../lib/job-label";
import { dialableNumber } from "./dialable-number";
import type { ActiveStop } from "./field-contracts";
import { STOP_WORDS, stopDetail } from "./stop-words";

type StopDateOptions = { locale?: string; timeZone?: string };

/** One line per stop under the banner's title, then that only the office releases it. */
function StopLines({
  stops,
  dateOptions,
  now,
}: {
  stops: ActiveStop[];
  dateOptions: StopDateOptions;
  now?: Date;
}) {
  return (
    <>
      {stops.map((stop) => (
        <p key={stop.occurrence_id} className="leading-6 break-words">
          {stopDetail(stop, dateOptions, now)}
        </p>
      ))}
      <p className="leading-6">{STOP_WORDS.waits}</p>
    </>
  );
}

/** The banner's action: call the office that releases the stop; none when the profile has no dialable number. */
function officeCall(officePhone: string | null | undefined) {
  const dialable = dialableNumber(officePhone);
  if (!dialable) return undefined;
  return (
    <Button asChild size="field">
      <a href={`tel:${dialable}`}>
        <Phone aria-hidden="true" />
        {STOP_WORDS.callOffice}
      </a>
    </Button>
  );
}

/** A stop whose job wasn't found holds every job: shown once, above the crew's jobs. */
export function TenantStopBanner({
  stops,
  dateOptions,
  officePhone,
  now,
}: {
  stops: ActiveStop[];
  dateOptions: StopDateOptions;
  officePhone?: string | null;
  now?: Date;
}) {
  const tenant = stops.filter((stop) => stop.scope === "tenant");
  if (tenant.length === 0) return null;
  return (
    <Notice tone="danger" title={STOP_WORDS.tenant} actions={officeCall(officePhone)}>
      <StopLines stops={tenant} dateOptions={dateOptions} now={now} />
    </Notice>
  );
}

/** A stop on this job: names the job the ruled way (D5) and who stopped it. */
export function JobStopBanner({
  stops,
  job,
  dateOptions,
  officePhone,
  now,
}: {
  stops: ActiveStop[];
  job: { customer?: string | null; address?: string | null; code?: string | null };
  dateOptions: StopDateOptions;
  officePhone?: string | null;
  now?: Date;
}) {
  const onJob = stops.filter((stop) => stop.scope === "job");
  if (onJob.length === 0) return null;
  const named = jobLabel(job);
  return (
    <Notice
      tone="danger"
      title={named ? `${STOP_WORDS.jobLeadIn} ${named}` : STOP_WORDS.jobUnnamed}
      actions={officeCall(officePhone)}
    >
      <StopLines stops={onJob} dateOptions={dateOptions} now={now} />
    </Notice>
  );
}
