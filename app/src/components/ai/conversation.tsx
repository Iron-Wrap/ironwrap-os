import { Mic, SendHorizontal, X } from "lucide-react";
import { useId, useRef, type FormEvent, type ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AiBadge } from "./badge";
import { type } from "./type";

/**
 * The conversation with the face (Board 6, AI/Conversation), opened from "Ask IronWrap".
 * `docked`: a 400px complementary panel beside the page on the office. `sheet`: full width on a
 * tablet or phone, its top corners on the sheet radius; the screen that opens it makes it modal.
 * Answers cite records; actions arrive as receipt rows and go through the same approvals as the
 * screens.
 *
 * `working` while an answer is on its way; `unavailable` (IronWrap is not answering), `offline`
 * and `notSent` say so in words with the one next step. The composer shows only with `onSend`, and
 * Speak only with `onSpeak`.
 */
export function Conversation({
  place,
  children,
  state = "ready",
  onClose,
  onSend,
  onSpeak,
  className,
}: {
  place: "docked" | "sheet";
  /** The messages, oldest first. */
  children?: ReactNode;
  state?: "ready" | "working" | "unavailable" | "offline" | "not-sent";
  onClose?: () => void;
  onSend?: (question: string) => void;
  onSpeak?: () => void;
  className?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const blocked = state === "unavailable" || state === "offline";
  const note =
    state === "unavailable"
      ? "IronWrap is not answering right now. Do it yourself from the screen you are on."
      : state === "offline"
        ? "No signal. Ask IronWrap again when this device is back online."
        : state === "not-sent"
          ? "Your question was not sent. Send it again."
          : undefined;
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = input.current?.value.trim() ?? "";
    if (!question) return input.current?.focus();
    onSend?.(question);
    if (input.current) input.current.value = "";
  };
  const Root = place === "docked" ? "aside" : "section";
  return (
    <Root
      aria-labelledby={`${id}-title`}
      role={place === "sheet" ? "dialog" : undefined}
      className={cn(
        "flex min-h-0 w-full flex-col border border-line-hairline bg-surface-paper text-text-primary",
        place === "docked"
          ? "h-full max-w-[25rem]"
          : "rounded-t-[var(--radius-sheet)] shadow-[var(--shadow-sheet)]",
        className,
      )}
    >
      <header className="flex items-center gap-2.5 border-b border-line-hairline px-4 py-3">
        <AiBadge who="orchestrator" size="default" decorative />
        <span className="grid min-w-0 grow">
          <h2 id={`${id}-title`} className={cn(type.leadHeading, "font-semibold")}>
            Ask IronWrap
          </h2>
          <span className={cn(type.caption, "text-text-secondary")}>
            Answers come from your records. Each fact shows where it came from.
          </span>
        </span>
        {onClose ? (
          <Button variant="quiet" size="small" onClick={onClose}>
            <X aria-hidden="true" />
            Close
          </Button>
        ) : null}
      </header>
      <div
        role="log"
        aria-live="polite"
        aria-labelledby={`${id}-title`}
        aria-busy={state === "working" || undefined}
        className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 py-4"
      >
        {children ?? (
          <p className={cn(type.body, "text-text-secondary")}>
            Ask about a job, a customer or money. Each answer shows where its facts came from.
          </p>
        )}
      </div>
      {onSend ? (
        <form
          onSubmit={send}
          className="grid gap-2 border-t border-line-hairline px-4 py-3"
          aria-describedby={note ? `${id}-note` : undefined}
        >
          {note ? (
            <p id={`${id}-note`} className={cn(type.caption, "text-text-secondary")}>
              {note}
            </p>
          ) : null}
          <Input
            ref={input}
            aria-label="Question for IronWrap"
            placeholder="Ask about a job, a customer or money"
            disabled={blocked}
            className="min-h-[max(3rem,var(--control-height))]"
          />
          <span className="flex flex-wrap justify-end gap-2">
            {onSpeak ? (
              <Button type="button" variant="secondary" disabled={blocked} onClick={onSpeak}>
                <Mic aria-hidden="true" />
                Speak
              </Button>
            ) : null}
            <Button type="submit" busy={state === "working"} disabled={blocked}>
              <SendHorizontal aria-hidden="true" />
              Send
            </Button>
          </span>
        </form>
      ) : note ? (
        <p
          className={cn(
            type.caption,
            "border-t border-line-hairline px-4 py-3 text-text-secondary",
          )}
        >
          {note}
        </p>
      ) : null}
    </Root>
  );
}
