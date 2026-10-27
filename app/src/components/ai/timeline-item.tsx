import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Status, type StatusKind } from "../ui/status";
import { AiBadge, PersonAvatar } from "./badge";
import { type } from "./type";
import {
  RECEIPT_STATE,
  initialsOf,
  personDoneWords,
  type Person,
  type ReceiptState,
  type SpecialistId,
  type When,
} from "./words";

/**
 * The receipt state, when the event is an agent step. A step a person did instead names them
 * (`by`), and says where their answer still has to go (`waitingFor`).
 */
type TimelineStep =
  | { state?: Exclude<ReceiptState, "done_by_person">; by?: never; waitingFor?: never }
  | { state: "done_by_person"; by: Person; waitingFor?: string };

/** "Needs you" belongs to the person who decides; anyone else reads who it waits on, in ink. */
type Decider = { viewerMayDecide?: boolean; waitingOn?: string };

/**
 * One event in a history that mixes people, agents and customers (Board 6, AI/Timeline item).
 * The actor's shape says who acted, a circle for a person or customer and a rounded square for an
 * agent, and the words say it too. Every time carries its day word. The link ("See receipt for
 * the invoice") opens the receipt in a panel titled "What the AI did" and shows only with what
 * opens it; `status` marks an event that is held, waits on the viewer or is proposed. An event
 * that is an agent step takes its receipt `state`; a step a person did (`done_by_person`) names
 * that person and shows their initials circle and "Done by {name}", never the AI badge. Render
 * items inside a list (`<ol>`).
 */
export function TimelineItem({
  actor,
  who,
  initials,
  state,
  by,
  waitingFor,
  when,
  what,
  line,
  status,
  link,
  onLink,
  href,
  viewerMayDecide = false,
  waitingOn,
}: TimelineStep &
  Decider & {
    actor: "person" | "specialist" | "ironwrap" | "customer";
    /** The specialist, for `specialist`. */
    who?: SpecialistId;
    /** The person's or customer's initials; without them the circle draws a neutral person. */
    initials?: string;
    when: When;
    what: ReactNode;
    line?: ReactNode;
    status?: { kind: StatusKind; words: string };
    /** The link's words, a verb and its object: "See receipt for the invoice". */
    link?: string;
    onLink?: () => void;
    href?: string;
  }) {
  const personDone = state === "done_by_person" ? by : undefined;
  const chip =
    status ??
    (personDone
      ? personDoneWords(personDone.isViewer ? "you" : personDone.name, waitingFor)
      : state === "needs_you" && !viewerMayDecide
        ? {
            words: waitingOn ? `Waiting on ${waitingOn}` : "Waiting on a person",
            kind: "pending" as const,
          }
        : state
          ? RECEIPT_STATE[state]
          : undefined);
  const node =
    personDone || actor === "person" || actor === "customer" ? (
      <PersonAvatar
        initials={personDone ? initialsOf(personDone) : initials}
        size="small"
        decorative
      />
    ) : (
      <AiBadge
        who={actor === "ironwrap" ? "orchestrator" : (who ?? "orchestrator")}
        size="small"
        decorative
      />
    );
  const whenClassName = cn(type.caption, "pt-0.5 text-text-secondary phone:col-span-2 phone:pt-0");
  return (
    <li className="@container">
      <div className="grid grid-cols-[8.5rem_auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 py-2 phone:grid-cols-[auto_minmax(0,1fr)]">
        {when.at ? (
          <time dateTime={when.at} className={whenClassName}>
            {when.text}
          </time>
        ) : (
          <span className={whenClassName}>{when.text}</span>
        )}
        {node}
        <span className="grid min-w-0 gap-0.5">
          <span className={cn(type.body, "text-text-primary")}>{what}</span>
          {line || actor === "customer" ? (
            <span className={cn(type.caption, "text-text-secondary")}>
              {actor === "customer" ? "Customer" : null}
              {actor === "customer" && line ? " · " : null}
              {line}
            </span>
          ) : null}
          {chip ? (
            <span>
              <Status kind={chip.kind}>{chip.words}</Status>
            </span>
          ) : null}
        </span>
        {link && (href || onLink) ? (
          href ? (
            <Button
              asChild
              variant="quiet"
              size="small"
              className="phone:col-start-2 phone:justify-self-start"
            >
              <a href={href}>{link}</a>
            </Button>
          ) : (
            <Button
              variant="quiet"
              size="small"
              className="phone:col-start-2 phone:justify-self-start"
              onClick={onLink}
            >
              {link}
            </Button>
          )
        ) : null}
      </div>
    </li>
  );
}
