import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Status } from "../ui/status";
import { AiBadge } from "./badge";
import { SourceList, type SourceProps } from "./source";
import { type } from "./type";
import { specialistName, type SpecialistId } from "./words";

/** One sentence of an answer and the sources of the fact it states. */
export interface MessagePart {
  text: ReactNode;
  sources?: SourceProps[];
}

/**
 * One message in a conversation (Board 6, AI/Message). A person's question sits on the right in
 * a bubble. IronWrap's and a specialist's answers sit on the left under the badge and the name;
 * every fact carries its source chips right under it, and narrative is only around cited facts.
 * An answer can hold one receipt row for an action.
 *
 * `working`: the answer is being written. `unavailable`: it could not answer, so the person does
 * it themselves. `not-sent`: the person's message is waiting on this device for signal. `note`:
 * `VIEW_REFUSED` under an answer whose generated view was refused. A closed draft's note belongs on
 * its receipt ("Since then"), never here.
 */
export function Message({
  from,
  who = "orchestrator",
  parts,
  children,
  status,
  note,
}: {
  from: "person" | "ironwrap" | "specialist";
  /** The specialist that answers; the face for IronWrap. */
  who?: SpecialistId;
  parts?: readonly MessagePart[];
  /** A person's words, or one receipt row under an answer. */
  children?: ReactNode;
  status?: "working" | "unavailable" | "not-sent";
  note?: string;
}) {
  if (from === "person")
    return (
      <div className="grid justify-items-end gap-1">
        <div
          className={cn(
            type.body,
            "max-w-[85%] rounded-[var(--radius-card)] bg-surface-selected px-3 py-2 text-text-primary",
          )}
        >
          {children}
        </div>
        {status === "not-sent" ? (
          <Status kind="local" className="whitespace-normal">
            Not sent yet. It sends when this phone has signal.
          </Status>
        ) : null}
      </div>
    );

  const speaker = from === "ironwrap" ? "orchestrator" : who;
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
      <AiBadge who={speaker} size="small" decorative className="mt-0.5" />
      <div className="grid min-w-0 gap-1.5">
        <span className={cn(type.caption, "font-semibold text-text-secondary")}>
          {specialistName(speaker)}
        </span>
        {status === "working" ? (
          <Status kind="working" className="justify-self-start">
            Working on it
          </Status>
        ) : null}
        {status === "unavailable" ? (
          <p className={cn(type.body, "text-text-primary")}>
            {specialistName(speaker)} could not answer right now. Do it yourself from the screen you
            are on.
          </p>
        ) : null}
        {parts?.map((part, index) => (
          <div key={index} className="grid gap-1">
            <p className={cn(type.body, "text-text-primary")}>{part.text}</p>
            {part.sources?.length ? <SourceList sources={part.sources} /> : null}
          </div>
        ))}
        {note ? <p className={cn(type.body, "text-text-secondary")}>{note}</p> : null}
        {children}
      </div>
    </div>
  );
}
