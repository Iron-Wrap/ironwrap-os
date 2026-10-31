import { ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Status } from "../ui/status";
import { AiBadge, PersonAvatar } from "./badge";
import { type } from "./type";
import {
  RECEIPT_STATE,
  initialsOf,
  personDoneWords,
  type Person,
  type ReceiptState,
  type SpecialistId,
} from "./words";

/**
 * Who the row shows: the specialist's badge, or, for a step a person did instead, that person's
 * initials circle and "Done by {name}" (never the AI badge).
 */
type RowActor =
  | { state: Exclude<ReceiptState, "done_by_person">; who: SpecialistId; by?: never }
  | {
      state: "done_by_person";
      by: Person;
      /** The person's answer still has to reach "the phone". */
      waitingFor?: string;
      who?: SpecialistId;
    };

export type ReceiptRowProps = RowActor & {
  /** The state chip's words when they name someone: "Undone by Dana Whitford". */
  stateWords?: string;
  /** Needs you: the viewer may decide it, so the chip is the blue "Needs you". */
  viewerMayDecide?: boolean;
  /** Needs you, for a viewer who may not decide: who decides ("Dana Whitford", "a person"). */
  waitingOn?: string;
  /** What happened, in one line: "Final invoice for Ruth Okafor, CAD 9,860.00". */
  summary: ReactNode;
  /** The record and the key fact: "Job IW-1019 · prepared from the accepted contract". */
  line?: ReactNode;
  /** The one action, a verb and its object: "Review the invoice", "See receipt for the invoice". */
  action?: string;
  /**
   * Opens the receipt, in a panel titled "What the AI did": the whole row, and the action. Without
   * either the row is words only.
   */
  href?: string;
  onOpen?: () => void;
};

/**
 * One agent step in a list (Board 6, AI/Receipt row): a small badge, what happened in one line,
 * the record and the key fact, the state and one outlined action; it never adds a second primary.
 * On the office the row is 56px and two targets, the row and its action. In touch and glove
 * density, on a coarse pointer, in a window 720px wide or narrower, or in a container narrower
 * than 30rem the whole row, 64px or taller, is the one target; the state sits under the summary
 * and the action verb is its last line. Needs you is the viewer's: only `viewerMayDecide` makes it
 * the blue "Needs you"; anyone else reads "Waiting on {who decides}" in ink.
 */
export function ReceiptRow(props: ReceiptRowProps) {
  const { state, stateWords, viewerMayDecide, waitingOn, summary, line, href, onOpen } = props;
  const id = useId();
  const { kind, words } =
    props.state === "done_by_person"
      ? personDoneWords(props.by.isViewer ? "you" : props.by.name, props.waitingFor)
      : state === "needs_you" && !viewerMayDecide
        ? { kind: "pending" as const, words: `Waiting on ${waitingOn ?? "a person"}` }
        : RECEIPT_STATE[state];
  const opens = Boolean(href || onOpen);
  const action = opens ? props.action : undefined;
  // The row's words sit above its one target and let a press fall through to it, so the target
  // covers the whole row without covering the words.
  const above = "pointer-events-none relative z-[1]";
  const mark = cn(above, "phone:row-span-3 phone:mt-0.5");
  const target = {
    "data-row-target": "",
    "aria-labelledby": `${id}-summary ${id}-state`,
    "aria-describedby":
      [line ? `${id}-line` : "", action ? `${id}-action` : ""].filter(Boolean).join(" ") ||
      undefined,
    className: "ai-row-target absolute inset-0 z-0 rounded-[inherit]",
  };
  return (
    <div className="@container">
      <div
        data-state={state}
        className={cn(
          "relative grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5",
          "hover:bg-surface-selected has-[[data-row-target]:active]:bg-surface-pressed",
          "phone:min-h-[max(4rem,var(--row-min-height))] phone:grid-cols-[auto_minmax(0,1fr)_auto] phone:items-start phone:py-3",
        )}
      >
        {href ? (
          <a href={href} {...target} />
        ) : onOpen ? (
          <button type="button" onClick={onOpen} {...target} />
        ) : null}
        {props.state === "done_by_person" ? (
          <PersonAvatar initials={initialsOf(props.by)} size="small" decorative className={mark} />
        ) : (
          <AiBadge who={props.who} size="small" decorative className={mark} />
        )}
        <span className={cn(above, "grid min-w-0")}>
          <span id={`${id}-summary`} className={cn(type.body, "font-semibold text-text-primary")}>
            {summary}
          </span>
          {line ? (
            <span id={`${id}-line`} className={cn(type.caption, "text-text-secondary")}>
              {line}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            above,
            "justify-self-end phone:col-start-2 phone:row-start-2 phone:justify-self-start",
          )}
        >
          <Status id={`${id}-state`} kind={kind}>
            {stateWords ?? words}
          </Status>
        </span>
        {action ? (
          <>
            {href ? (
              <Button
                asChild
                variant="secondary"
                size="small"
                className="relative z-10 phone:hidden"
              >
                <a href={href}>{action}</a>
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="small"
                className="relative z-10 phone:hidden"
                onClick={onOpen}
              >
                {action}
              </Button>
            )}
            <span
              id={`${id}-action`}
              className={cn(
                above,
                type.caption,
                "hidden items-center gap-1 font-semibold text-text-primary phone:col-start-2 phone:row-start-3 phone:flex",
              )}
            >
              {action}
              <ChevronRight aria-hidden="true" className="size-[1.15em]" />
            </span>
          </>
        ) : null}
        {opens ? (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              above,
              "hidden size-5 self-center text-text-secondary phone:col-start-3 phone:row-span-3 phone:row-start-1 phone:block",
            )}
          />
        ) : null}
      </div>
    </div>
  );
}
