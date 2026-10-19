import { Check, Pencil, Trash2 } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { type } from "./type";
import { formatMoney, isMoney, type Money } from "./words";

const dotted = "outline-1 -outline-offset-1 outline-text-secondary outline-dotted";

function ProposedGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      data-glyph="proposed"
      className="size-[1.15em] shrink-0 text-text-secondary"
    >
      <path
        d="M6 1.2 10.8 6 6 10.8 1.2 6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const shown = (value: ReactNode | Money) => (isMoney(value) ? formatMoney(value) : value);

/**
 * An agent's value nobody has accepted (Board 6, AI/Proposed value). Three cues together: the
 * word "Proposed", the open diamond and a dotted edge, never colour. Facts have none of them, and a
 * proposed value is never added into a total of facts. The word is the component's own, and the
 * field's and the block's names carry it, whatever their caption says.
 *
 * - `inline`: in a sentence or a table cell.
 * - `field`: one value to accept or edit, with who proposed it and from what.
 * - `block`: a whole draft, to accept, edit or discard; it is "not sent, not saved to the record".
 *
 * IRW-R8d R8d-1: it sits inline on the work screen with Accept and Edit (and Discard for a draft),
 * and the screen works the same with the AI off.
 */
export function ProposedValue(
  props:
    | { kind: "inline"; value: ReactNode | Money; className?: string }
    | {
        kind: "field";
        label: string;
        value: ReactNode | Money;
        /** Who proposed it and from what: "AI measurer, from the measurement report, page 3." */
        caption: ReactNode;
        /** Accepted or edited by a person: the value is a fact now; the caption says who. */
        state?: "proposed" | "accepted" | "edited";
        acceptLabel?: string;
        editLabel?: string;
        /** What Edit lets you do and what your value becomes: "Type your own figure; it replaces 988 sq ft." */
        editNote?: string;
        onAccept?: () => void;
        onEdit?: () => void;
        className?: string;
      }
    | {
        kind: "block";
        title: ReactNode;
        children?: ReactNode;
        acceptLabel?: string;
        editLabel?: string;
        discardLabel?: string;
        /** What Discard removes and leaves: "Discarding removes this draft only; the last quote stays." */
        discardNote?: string;
        onAccept?: () => void;
        onEdit?: () => void;
        onDiscard?: () => void;
        className?: string;
      },
) {
  const id = useId();
  if (props.kind === "inline")
    return (
      <span
        data-proposed=""
        className={cn(
          "inline-flex max-w-full flex-wrap items-center gap-x-1 rounded-sm px-1.5 align-baseline",
          dotted,
          props.className,
        )}
      >
        <ProposedGlyph />
        <span className={cn(type.caption, "text-text-secondary")}>Proposed</span>
        <span className={cn(type.money, "font-semibold text-text-primary")}>
          {shown(props.value)}
        </span>
      </span>
    );

  if (props.kind === "block")
    return (
      <section
        data-proposed=""
        aria-labelledby={`${id}-proposed ${id}-title`}
        className={cn(
          "grid gap-2 rounded-[var(--radius-card)] bg-surface-paper px-5 py-4",
          dotted,
          props.className,
        )}
      >
        <p
          className={cn(
            type.caption,
            "flex items-center gap-1.5 font-semibold text-text-secondary",
          )}
        >
          <ProposedGlyph />
          <span>
            <span id={`${id}-proposed`}>Proposed</span>, not accepted yet
          </span>
        </p>
        <h3 id={`${id}-title`} className={cn(type.leadHeading, "font-semibold text-text-primary")}>
          {props.title}
        </h3>
        {props.children ? (
          <div className={cn(type.body, "text-text-secondary")}>{props.children}</div>
        ) : null}
        <p id={`${id}-note`} className={cn(type.caption, "text-text-secondary")}>
          Not sent, not saved to the record.
          {props.onDiscard && props.discardNote ? ` ${props.discardNote}` : null}
        </p>
        <Actions
          {...props}
          discardNoteId={props.onDiscard && props.discardNote ? `${id}-note` : undefined}
        />
      </section>
    );

  const state = props.state ?? "proposed";
  const proposed = state === "proposed";
  return (
    <div
      role="group"
      aria-labelledby={proposed ? `${id}-label ${id}-proposed` : `${id}-label`}
      data-proposed={proposed ? "" : undefined}
      className={cn("grid max-w-[22.5rem] gap-1.5", props.className)}
    >
      <span id={`${id}-label`} className={cn(type.caption, "font-semibold text-text-secondary")}>
        {props.label}
      </span>
      <span
        className={cn(
          "flex min-h-[var(--control-height)] items-center gap-2 rounded-[var(--control-radius)] px-3",
          type.body,
          proposed ? dotted : "bg-surface-rail",
        )}
      >
        {proposed ? (
          <>
            <ProposedGlyph />
            <span id={`${id}-proposed`} className={cn(type.caption, "text-text-secondary")}>
              Proposed
            </span>
          </>
        ) : null}
        <span className={cn(type.money, "text-text-primary")}>{shown(props.value)}</span>
      </span>
      <span className={cn(type.caption, "text-text-secondary")}>{props.caption}</span>
      {proposed ? (
        <Actions {...props} editNoteId={props.editNote ? `${id}-edit` : undefined} />
      ) : null}
      {proposed && props.onEdit && props.editNote ? (
        // Named, so the line reads as the Edit button's.
        <span id={`${id}-edit`} className={cn(type.caption, "text-text-secondary")}>
          <span className="font-semibold" aria-hidden="true">
            {props.editLabel ?? "Edit"}:
          </span>{" "}
          {props.editNote}
        </span>
      ) : null}
    </div>
  );
}

/** Accept, Edit and, for a draft, Discard: each only with its handler. */
function Actions({
  acceptLabel,
  editLabel,
  discardLabel,
  onAccept,
  onEdit,
  onDiscard,
  editNoteId,
  discardNoteId,
}: {
  acceptLabel?: string;
  editLabel?: string;
  discardLabel?: string;
  editNoteId?: string;
  discardNoteId?: string;
  onAccept?: () => void;
  onEdit?: () => void;
  onDiscard?: () => void;
}) {
  if (!onAccept && !onEdit && !onDiscard) return null;
  const small = "h-auto whitespace-normal";
  return (
    <span className="flex flex-wrap gap-2">
      {onAccept ? (
        <Button variant="secondary" size="small" className={small} onClick={onAccept}>
          <Check aria-hidden="true" />
          {acceptLabel ?? "Accept"}
        </Button>
      ) : null}
      {onEdit ? (
        <Button
          variant="quiet"
          size="small"
          className={small}
          aria-describedby={editNoteId}
          onClick={onEdit}
        >
          <Pencil aria-hidden="true" />
          {editLabel ?? "Edit"}
        </Button>
      ) : null}
      {onDiscard ? (
        <Button
          variant="quiet"
          size="small"
          className={small}
          aria-describedby={discardNoteId}
          onClick={onDiscard}
        >
          <Trash2 aria-hidden="true" />
          {discardLabel ?? "Discard"}
        </Button>
      ) : null}
    </span>
  );
}
