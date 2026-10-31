import { Phone } from "lucide-react";

import { Button } from "../components/ui/button";
import { Notice } from "../components/ui/notice";
import { jobLabel } from "../lib/job-label";
import { dialableNumber } from "./dialable-number";
import type { ActiveStop } from "./field-contracts";
import { STOP_WORDS, stopDetail, stopReadStatus } from "./stop-words";

type StopDateOptions = { locale?: string; timeZone?: string };

/** One line per stop under the banner's title, then that only the office releases it. */
function StopLines({
  stops,
  dateOptions,
  checkedAt,
  offline,
  now,
  unmatched = false,
}: {
  stops: ActiveStop[];
  dateOptions: StopDateOptions;
  checkedAt: string;
  offline: boolean;
  now?: Date;
  /** A stop nobody could match to a job first says so, naming who reported it. */
  unmatched?: boolean;
}) {
  return (
    <>
      {stops.map((stop) => (
        <div key={stop.occurrence_id}>
          {unmatched ? (
            <p className="leading-6">
              {STOP_WORDS.unmatched(stop.raiser_display_name?.trim() || null)}
            </p>
          ) : null}
          <p className="leading-6 break-words">
            {stopDetail(stop, dateOptions, now, { withRaiser: !unmatched })}
          </p>
        </div>
      ))}
      <p className="leading-6">{stopReadStatus(stops, checkedAt, offline, dateOptions, now)}</p>
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

/** A stop nobody could match to a job holds every job: shown once, above the crew's jobs. */
export function TenantStopBanner({
  stops,
  dateOptions,
  checkedAt,
  offline,
  officePhone,
  now,
}: {
  stops: ActiveStop[];
  dateOptions: StopDateOptions;
  checkedAt: string;
  offline: boolean;
  officePhone?: string | null;
  now?: Date;
}) {
  const tenant = stops.filter((stop) => stop.scope === "tenant");
  if (tenant.length === 0) return null;
  return (
    <Notice tone="danger" title={STOP_WORDS.tenant} actions={officeCall(officePhone)}>
      <StopLines
        stops={tenant}
        dateOptions={dateOptions}
        checkedAt={checkedAt}
        offline={offline}
        now={now}
        unmatched
      />
    </Notice>
  );
}

/** A stop on this job: names the job the ruled way (D5) and who stopped it. */
export function JobStopBanner({
  stops,
  job,
  dateOptions,
  checkedAt,
  offline,
  officePhone,
  now,
}: {
  stops: ActiveStop[];
  job: { customer?: string | null; address?: string | null; code?: string | null };
  dateOptions: StopDateOptions;
  checkedAt: string;
  offline: boolean;
  officePhone?: string | null;
  now?: Date;
}) {
  const onJob = stops.filter((stop) => stop.scope === "job");
  if (onJob.length === 0) return null;
  // No-break spaces keep each dot with the part before it and "Ref" with its code.
  const named = jobLabel(job)
    ?.replaceAll(" · ", "\u00a0· ")
    .replace(/Ref (\S+)$/, "Ref\u00a0$1");
  return (
    <Notice
      tone="danger"
      title={named ? `${STOP_WORDS.jobLeadIn} ${named}` : STOP_WORDS.jobUnnamed}
      actions={officeCall(officePhone)}
    >
      <StopLines
        stops={onJob}
        dateOptions={dateOptions}
        checkedAt={checkedAt}
        offline={offline}
        now={now}
      />
    </Notice>
  );
}
