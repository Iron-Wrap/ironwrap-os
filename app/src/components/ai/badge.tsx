import { User } from "lucide-react";

import { cn } from "../../lib/cn";
import { BrandMark } from "../ui/brand";
import { type } from "./type";
import { SPECIALISTS, specialistName, type SpecialistId } from "./words";

export type MarkSize = "small" | "default" | "large";

const box: Record<MarkSize, string> = { small: "size-6", default: "size-8", large: "size-12" };
const glyph: Record<MarkSize, string> = { small: "size-4", default: "size-5", large: "size-7" };
const brand: Record<MarkSize, number> = { small: 16, default: 22, large: 32 };

/**
 * Who did it, for an agent (Board 6, AI/Badge): a rounded square on the rail fill with a strong
 * edge and the specialist's glyph in ink; the face carries the brand mark. Small 24, Default 32,
 * Large 48. An agent is never a circle and never coloured. Beside its name it is `decorative`;
 * alone it is an image named "AI estimator".
 */
export function AiBadge({
  who,
  size = "default",
  decorative,
  className,
}: {
  who: SpecialistId;
  size?: MarkSize;
  decorative?: boolean;
  className?: string;
}) {
  // A specialist this app does not know yet draws the team's mark (the brand glyph).
  const Glyph =
    (SPECIALISTS as Record<string, { glyph: unknown } | undefined>)[who] === undefined
      ? SPECIALISTS.orchestrator.glyph
      : SPECIALISTS[who].glyph;
  return (
    <span
      data-shape="rounded-square"
      data-who={who}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : specialistName(who)}
      aria-hidden={decorative || undefined}
      className={cn(
        "inline-grid shrink-0 place-items-center border border-line-strong bg-surface-rail text-text-primary",
        box[size],
        size === "small" ? "rounded-sm" : size === "default" ? "rounded-md" : "rounded-lg",
        className,
      )}
    >
      {Glyph ? (
        <Glyph aria-hidden="true" className={glyph[size]} strokeWidth={1.75} />
      ) : (
        <BrandMark size={brand[size]} />
      )}
    </span>
  );
}

/**
 * A person or a customer (Board 6, Avatar/Person): a circle with initials on the rail fill, or a
 * neutral person glyph when nobody named them. People are circles, agents rounded squares, so who
 * acted reads without colour.
 */
export function PersonAvatar({
  initials,
  name,
  size = "default",
  decorative,
  className,
}: {
  initials?: string;
  /** The person's name, announced when the avatar stands alone. */
  name?: string;
  size?: MarkSize;
  decorative?: boolean;
  className?: string;
}) {
  const labelled = !decorative && Boolean(name);
  return (
    <span
      data-shape="circle"
      role={labelled ? "img" : undefined}
      aria-label={labelled ? name : undefined}
      aria-hidden={labelled ? undefined : true}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full border border-line-hairline bg-surface-rail font-semibold text-text-primary",
        box[size],
        // Initials keep the circle's own size; the field and shop scopes raise `text-xs`.
        size === "large" ? type.body : "text-[12px] leading-none",
        className,
      )}
    >
      {initials ? (
        <span aria-hidden="true">{initials}</span>
      ) : (
        <User aria-hidden="true" className={glyph[size]} strokeWidth={1.75} />
      )}
    </span>
  );
}
