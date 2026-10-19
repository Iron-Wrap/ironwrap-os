import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { AiBadge } from "./badge";
import { type } from "./type";
import { specialistName, type SpecialistId } from "./words";

/**
 * The badge and the name people see (Board 6, AI/Name). Row: a small badge and the name, for
 * lists. Header: the default badge, the name and one line about the job or the time. The name
 * always says "AI …", or the brand for the face.
 */
export function AiName({
  who,
  size = "row",
  line,
  className,
}: {
  who: SpecialistId;
  size?: "row" | "header";
  line?: ReactNode;
  className?: string;
}) {
  if (size === "row")
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
        <AiBadge who={who} size="small" decorative />
        <span className={cn(type.body, "font-semibold text-text-primary")}>
          {specialistName(who)}
        </span>
      </span>
    );
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
      <AiBadge who={who} size="default" decorative />
      <span className="grid min-w-0">
        <span className={cn(type.body, "font-semibold text-text-primary")}>
          {specialistName(who)}
        </span>
        {line ? <span className={cn(type.caption, "text-text-secondary")}>{line}</span> : null}
      </span>
    </span>
  );
}
