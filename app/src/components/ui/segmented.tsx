import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

/**
 * Three shapes of one choice row:
 *  - `tabs`: section tabs, a `nav` of links marked `aria-current="page"`, underlined in ink.
 *  - `filters`: filter chips, a group of buttons marked `aria-pressed`, selected in brass.
 *  - `control`: a segmented control, the same group of `aria-pressed` buttons on a sunk track.
 * The children own their own state attribute; this only lays them out.
 */
export function Segmented({
  variant,
  label,
  className,
  children,
}: {
  variant: "tabs" | "filters" | "control";
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const shared = {
    "aria-label": label,
    "data-variant": variant,
    className: cn("segmented", className),
  };
  if (variant === "tabs") return <nav {...shared}>{children}</nav>;
  return (
    <div role="group" {...shared}>
      {children}
    </div>
  );
}

/** A count inside a tab or chip. */
export function SegmentedCount({ children }: { children: ReactNode }) {
  return <span className="segmented-count">{children}</span>;
}
