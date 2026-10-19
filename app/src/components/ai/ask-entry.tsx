import { ChevronRight, LoaderCircle, MessageCircle, Mic, Sparkle } from "lucide-react";
import { useEffect, useId, useRef, type FormEvent } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { type } from "./type";

export type AskPlace = "desktop" | "compact" | "crew" | "customer";

const PLACE = {
  crew: { title: "Ask IronWrap", line: "Speak or type. Answers come from your job.", Glyph: Mic },
  customer: {
    title: "Ask a question",
    line: "AI customer care at Iron Wrap Exteriors. A person can answer too.",
    Glyph: MessageCircle,
  },
} as const;

/**
 * The one face (Board 6, AI/Ask entry), named for the tenant's brand.
 *
 * - `desktop`: the top bar field "Ask IronWrap or search work" with its ⌘K hint and a visible Ask
 *   button, so the shortcut is never the only way in.
 * - `compact`: a 48px Ask button for tablet and phone top bars.
 * - `crew`: a 64px (72 on glove) voice-first button above the crew phone's tabs.
 * - `customer`: "Ask a question", with the AI disclosure and the way to a person.
 *
 * `busy` while an answer is on its way; `unavailable` says in words why it cannot be used now
 * (offline, IronWrap is not answering, or "IronWrap's AI is off." on staff screens) and disables it.
 */
export function AskEntry({
  place,
  onAsk,
  onOpen,
  busy,
  unavailable,
  bindShortcut,
  className,
}: {
  place: AskPlace;
  /** Desktop: the question typed into the field. */
  onAsk?: (question: string) => void;
  /** Compact, crew and customer: opens the conversation. */
  onOpen?: () => void;
  busy?: boolean;
  unavailable?: string;
  /** Desktop: ⌘K or Ctrl+K anywhere on the page moves focus to the field. */
  bindShortcut?: boolean;
  className?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!bindShortcut || place !== "desktop") return;
    const focus = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, [bindShortcut, place]);

  const note = unavailable ? (
    <p id={`${id}-note`} className={cn(type.caption, "text-text-secondary")}>
      {unavailable}
    </p>
  ) : null;

  if (place === "desktop") {
    const submit = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const question = input.current?.value.trim() ?? "";
      if (question) onAsk?.(question);
      else input.current?.focus();
    };
    return (
      <div className={cn("grid w-full max-w-[26rem] gap-1", className)}>
        <form role="search" aria-label="Ask IronWrap" onSubmit={submit} className="flex gap-2">
          <span className="relative flex min-w-0 grow items-center">
            <Sparkle
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 size-[var(--control-icon)] text-text-secondary"
            />
            <Input
              ref={input}
              type="search"
              aria-label="Ask IronWrap"
              aria-keyshortcuts="Meta+K Control+K"
              aria-describedby={unavailable ? `${id}-note` : undefined}
              placeholder="Ask IronWrap or search work"
              busy={busy}
              disabled={Boolean(unavailable)}
              className="pr-11 pl-[calc(var(--control-icon)+1rem)]"
            />
            <kbd
              aria-hidden="true"
              className={cn(
                type.caption,
                "pointer-events-none absolute right-2 rounded-[4px] border border-line-strong px-1 font-sans text-text-secondary phone:hidden",
              )}
            >
              ⌘K
            </kbd>
          </span>
          <Button type="submit" variant="secondary" busy={busy} disabled={Boolean(unavailable)}>
            Ask
          </Button>
        </form>
        {note}
      </div>
    );
  }

  if (place === "compact")
    return (
      <span className={cn("inline-grid gap-1", className)}>
        <Button
          variant="secondary"
          aria-label="Ask IronWrap"
          aria-describedby={unavailable ? `${id}-note` : undefined}
          busy={busy}
          disabled={Boolean(unavailable)}
          onClick={onOpen}
          className="min-h-[max(3rem,var(--control-height))]"
        >
          <Sparkle aria-hidden="true" />
          Ask
        </Button>
        {note}
      </span>
    );

  const { title, line, Glyph } = PLACE[place];
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={busy || Boolean(unavailable)}
      aria-busy={busy || undefined}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-line`}
      className={cn(
        "flex w-full min-h-[max(4rem,var(--control-height-primary))] items-center gap-3 rounded-[var(--radius-card)] px-4 py-2 text-left",
        "border-[length:var(--control-border-width)] border-control-border bg-surface-rail text-text-primary",
        "transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease)] hover:bg-surface-selected active:bg-surface-pressed",
        "disabled:not-aria-busy:cursor-not-allowed disabled:not-aria-busy:border-line-hairline disabled:not-aria-busy:bg-transparent disabled:not-aria-busy:text-text-tertiary",
        className,
      )}
    >
      {busy ? (
        <LoaderCircle aria-hidden="true" className="size-6 shrink-0 animate-spin" />
      ) : (
        <Glyph aria-hidden="true" className="size-6 shrink-0" />
      )}
      <span className="grid min-w-0 grow">
        <span id={`${id}-title`} className={cn(type.lead, "font-semibold")}>
          {title}
        </span>
        <span id={`${id}-line`} className={cn(type.caption, "text-text-secondary")}>
          {busy ? "Working on it" : (unavailable ?? line)}
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-text-secondary" />
    </button>
  );
}
