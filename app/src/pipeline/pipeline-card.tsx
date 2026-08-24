import {
  Activity,
  CalendarClock,
  ClipboardCheck,
  MessageSquare,
  Move,
  Paperclip,
  Phone,
  type LucideIcon,
} from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { cn } from "../lib/cn";
import { cardSlots, initials, type CardSlot } from "./pipeline-board-model";
import type { BoardCard, CardTemplateBinding } from "./pipeline-contracts";

const counterIcons: Record<string, LucideIcon> = {
  calls: Phone,
  call: Phone,
  messages: MessageSquare,
  message: MessageSquare,
  tasks: ClipboardCheck,
  task: ClipboardCheck,
  files: Paperclip,
  file: Paperclip,
  appointments: CalendarClock,
};

export function PipelineCard({
  card,
  template,
  locale,
  currency,
  movable,
  lifted,
  dimmed,
  onMove,
  onPointerDown,
}: {
  card: BoardCard;
  template: readonly CardTemplateBinding[] | null | undefined;
  locale: string;
  currency: string;
  movable: boolean;
  lifted: boolean;
  dimmed: boolean;
  onMove: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const slots = cardSlots(template, card.summary, { locale, currency });
  const title = slots.find((slot) => slot.slot === "title")?.text ?? card.summary.title;
  const badge = slots.find((slot) => slot.slot === "badge");
  const body = slots.filter((slot) => slot.slot !== "title" && slot.slot !== "badge");

  return (
    <article
      data-card-id={card.card_id}
      data-lifted={lifted || undefined}
      aria-label={title}
      onPointerDown={movable ? onPointerDown : undefined}
      className={cn(
        "rounded-lg border border-border bg-surface-raised p-3 shadow-[0_1px_2px_oklch(0_0_0/0.035)] transition-[transform,box-shadow,opacity] duration-[var(--motion-fast)] sm:p-4",
        movable && "touch-none",
        lifted && "scale-[1.02] shadow-[0_16px_36px_oklch(0_0_0/0.22)]",
        dimmed && "opacity-55 outline-2 outline-dashed outline-accent",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <h4 className="min-w-0 flex-1 truncate text-sm font-bold">{title}</h4>
        {badge ? (
          <span className="shrink-0 rounded-full bg-ok-soft px-2 py-0.5 text-xs font-bold text-ok">
            {badge.text}
          </span>
        ) : null}
      </div>

      {body.map((slot) => (
        <CardSlotRow
          key={slot.slot}
          slot={slot}
          ownerInitials={slot.slot === "counters" ? initials(title) : undefined}
        />
      ))}

      {movable ? (
        <button
          type="button"
          onClick={onMove}
          aria-label={`Move ${title}`}
          className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface text-sm font-bold text-muted transition-colors hover:border-border-strong hover:bg-surface-muted hover:text-foreground"
        >
          <Move className="size-4" aria-hidden="true" />
          Move
        </button>
      ) : null}
    </article>
  );
}

function CardSlotRow({ slot, ownerInitials }: { slot: CardSlot; ownerInitials?: string }) {
  if (slot.slot === "value") {
    return <p className="mt-2 text-base font-extrabold tabular-nums">{slot.text}</p>;
  }
  if (slot.slot === "identifiers") {
    return (
      <dl className="mt-2 space-y-0.5 text-xs text-muted">
        {slot.items.map((item) => (
          <div key={`${item.label}:${item.value}`} className="flex min-w-0 gap-1">
            <dt className="shrink-0">{item.label}:</dt>
            <dd className="min-w-0 truncate font-semibold">{item.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  if (slot.slot === "tags") {
    return (
      <ul className="mt-2 flex flex-wrap gap-1">
        {slot.items.map((tag) => (
          <li key={tag} className="rounded-md bg-surface-muted px-1.5 py-0.5 text-xs font-semibold">
            {tag}
          </li>
        ))}
        {slot.overflow > 0 ? (
          <li className="rounded-md bg-surface-muted px-1.5 py-0.5 text-xs font-semibold">
            +{slot.overflow}
          </li>
        ) : null}
      </ul>
    );
  }
  if (slot.slot === "counters") {
    return (
      <div className="mt-2 flex items-center justify-between gap-2">
        <ul className="flex min-w-0 flex-wrap items-center gap-3 text-xs text-muted">
          {slot.items.map((counter) => {
            const Icon = counterIcons[counter.kind.toLowerCase()] ?? Activity;
            return (
              // The kind rides on the row's own label instead of a visually hidden
              // span: an `sr-only` element is absolutely positioned, and inside a
              // horizontally scrolled column that lands it outside the viewport and
              // widens the whole page.
              <li
                key={counter.kind}
                aria-label={`${counter.count} ${counter.kind}`}
                className="flex items-center gap-1"
              >
                <Icon className="size-3.5" aria-hidden="true" />
                <span className="tabular-nums" aria-hidden="true">
                  {counter.count}
                </span>
              </li>
            );
          })}
        </ul>
        {ownerInitials ? (
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-muted text-xs font-bold text-muted"
          >
            {ownerInitials}
          </span>
        ) : null}
      </div>
    );
  }
  return null;
}
