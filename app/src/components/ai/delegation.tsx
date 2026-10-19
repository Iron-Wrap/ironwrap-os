import { cn } from "../../lib/cn";
import { type } from "./type";
import { DELEGATION, type DelegationSetting } from "./words";

/**
 * What a specialist may do with one action, in words only (Board 6, AI/Delegation): an outlined
 * pill with a glyph, ink only. The class code (A0 to A3, H) lives in System details; the control
 * that changes a setting lives in Settings and only the owner uses it.
 */
export function DelegationPill({
  setting,
  className,
}: {
  setting: DelegationSetting;
  className?: string;
}) {
  const { words, glyph: Glyph } = DELEGATION[setting];
  return (
    <span
      data-delegation={setting}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-[var(--radius-chip)] border border-line-strong py-0.5 pr-2 pl-1.5 font-semibold text-text-primary",
        type.caption,
        className,
      )}
    >
      <Glyph aria-hidden="true" className="size-[1.15em] shrink-0" strokeWidth={1.75} />
      {words}
    </span>
  );
}
