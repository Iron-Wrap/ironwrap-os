import {
  Check,
  ChevronRight,
  CircleAlert,
  Lightbulb,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { ReceiptRow, type ReceiptRowProps } from "./receipt-row";
import { type } from "./type";

export type BriefKind = "needs_you" | "found" | "done" | "working";

/** Each kind's title, glyph, and what it says empty: one line and the one next step under it. */
const KIND: Record<BriefKind, { title: string; empty: string; next: string; Glyph: LucideIcon }> = {
  needs_you: {
    title: "Needs you",
    empty: "Nothing needs you now.",
    next: "When the AI team needs your decision, it shows here.",
    Glyph: CircleAlert,
  },
  found: {
    title: "Found",
    empty: "Nothing found since the last brief.",
    next: "When the AI team finds a risk or an opportunity, it shows here.",
    Glyph: Lightbulb,
  },
  done: {
    title: "Done for you",
    empty: "Nothing done for you yet today.",
    next: "When the AI team finishes a step, its receipt shows here.",
    Glyph: Check,
  },
  working: {
    title: "Working on it",
    empty: "Nothing in progress right now.",
    next: "When the AI team starts something, it shows here.",
    Glyph: LoaderCircle,
  },
};

/** The most rows a section shows; "See all" opens the rest. */
const ROWS = 4;

/**
 * One section of the team brief on Now (Board 6, AI/Brief section), in this order: Needs you
 * (asks first and people-only decisions), Found (risks and opportunities), Done for you (with
 * receipts and undo), Working on it. The header gives the count; up to four receipt rows follow.
 * Only Needs you is blue, because it is the owner who is waited on.
 */
export function BriefSection({
  kind,
  count,
  rows,
  seeAllHref,
  onSeeAll,
  empty,
  emptyNext,
  className,
}: {
  kind: BriefKind;
  /** Every item in the section, not only the rows shown. */
  count: number;
  rows: readonly ReceiptRowProps[];
  seeAllHref?: string;
  onSeeAll?: () => void;
  /** What an empty section says, and its one next step (words or a link); each kind has defaults. */
  empty?: string;
  emptyNext?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const { title, Glyph } = KIND[kind];
  const you = kind === "needs_you";
  const shown = rows.slice(0, ROWS);
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        "rounded-[var(--radius-card)] border border-line-hairline bg-surface-paper",
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b border-line-hairline px-4 py-3">
        <Glyph
          aria-hidden="true"
          className={cn("size-5 shrink-0", you ? "text-signal-you" : "text-text-primary")}
        />
        <h2
          id={`${id}-title`}
          aria-label={`${title}, ${count}`}
          className={cn(type.leadHeading, "flex items-baseline gap-2 font-semibold")}
        >
          <span className={you ? "text-signal-you" : "text-text-primary"}>{title}</span>
          <span className={cn(type.body, type.money, "font-semibold text-text-secondary")}>
            {count}
          </span>
        </h2>
        {shown.length && count > shown.length && (seeAllHref || onSeeAll) ? (
          seeAllHref ? (
            <Button asChild variant="quiet" size="small" className="ml-auto">
              <a href={seeAllHref}>
                See all
                <ChevronRight aria-hidden="true" />
              </a>
            </Button>
          ) : (
            <Button variant="quiet" size="small" className="ml-auto" onClick={onSeeAll}>
              See all
              <ChevronRight aria-hidden="true" />
            </Button>
          )
        ) : null}
      </header>
      {shown.length ? (
        <ul className="divide-y divide-line-hairline">
          {shown.map((row, index) => (
            <li key={index}>
              <ReceiptRow {...row} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid gap-0.5 px-4 py-3">
          <p className={cn(type.body, "text-text-primary")}>{empty ?? KIND[kind].empty}</p>
          <p className={cn(type.caption, "text-text-secondary")}>{emptyNext ?? KIND[kind].next}</p>
        </div>
      )}
    </section>
  );
}
