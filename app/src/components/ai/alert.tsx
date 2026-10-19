import { Lightbulb, TriangleAlert } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Status } from "../ui/status";
import { AiName } from "./name";
import { SourceList, type SourceProps } from "./source";
import { type } from "./type";
import type { SpecialistId } from "./words";

const KIND = {
  risk: { word: "Risk", Glyph: TriangleAlert },
  opportunity: { word: "Opportunity", Glyph: Lightbulb },
} as const;

/**
 * What a specialist found while watching (Board 6, AI/Alert): Risk or Opportunity, told apart by
 * glyph and word, never colour; who found it; the exact evidence with its sources; the impact in
 * exact numbers; and the proposal. `forYou` when a decision waits on the viewer: the "Needs you"
 * chip, the blue tint and a You primary; otherwise "For your information" and an outlined one. The
 * words carry it, never the tint alone. The kind word is part of the article's name, and each
 * button shows only with its handler.
 */
export function Alert({
  kind,
  forYou,
  who,
  title,
  evidence,
  sources = [],
  impact,
  primary = "Review the proposal",
  onPrimary,
  onNotNow,
  headingLevel = 3,
  className,
}: {
  kind: "risk" | "opportunity";
  forYou?: boolean;
  who: SpecialistId;
  title: ReactNode;
  evidence: ReactNode;
  sources?: readonly SourceProps[];
  /** The impact in exact numbers: "1 payment held: CAD 1,803.60". */
  impact?: ReactNode;
  primary?: string;
  onPrimary?: () => void;
  onNotNow?: () => void;
  headingLevel?: 2 | 3 | 4;
  className?: string;
}) {
  const id = useId();
  const { word, Glyph } = KIND[kind];
  const Heading = `h${headingLevel}` as const;
  return (
    <article
      aria-labelledby={`${id}-kind ${id}-title`}
      data-kind={kind}
      className={cn(
        "@container grid gap-2.5 rounded-[var(--radius-card)] border px-5 py-4 text-text-primary",
        forYou
          ? "border-signal-you-tint-edge bg-signal-you-tint"
          : "border-line-hairline bg-surface-paper",
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn(type.caption, "inline-flex items-center gap-1.5 font-semibold")}>
          <Glyph aria-hidden="true" className="size-[1.15em]" />
          <span id={`${id}-kind`}>{word}</span>
        </span>
        <Status kind={forYou ? "you" : "neutral"}>
          {forYou ? "Needs you" : "For your information"}
        </Status>
        <span className="ml-auto inline-flex items-center gap-2 phone:ml-0 phone:basis-full">
          <span className={cn(type.caption, "text-text-secondary")}>Found by</span>
          <AiName who={who} />
        </span>
      </header>
      <Heading id={`${id}-title`} className={cn(type.leadHeading, "font-semibold")}>
        {title}
      </Heading>
      <p className={cn(type.body, "text-text-primary")}>{evidence}</p>
      <SourceList sources={sources} />
      {impact ? <p className={cn(type.body, type.money, "font-semibold")}>{impact}</p> : null}
      {onPrimary || onNotNow ? (
        <div className="flex flex-wrap gap-2 phone:flex-col phone:items-stretch">
          {onPrimary ? (
            <Button
              variant={forYou ? "you" : "secondary"}
              className="phone:w-full phone:min-h-[max(3rem,var(--control-height))]"
              onClick={onPrimary}
            >
              {primary}
            </Button>
          ) : null}
          {onNotNow ? (
            <Button
              variant="quiet"
              className="phone:w-full phone:min-h-[max(3rem,var(--control-height))]"
              onClick={onNotNow}
            >
              Not now
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
