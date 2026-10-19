import {
  CircleAlert,
  CircleCheck,
  Info,
  OctagonAlert,
  Smartphone,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

/**
 * `local` is for work that exists only on this device: saved, not yet sent, not yet confirmed
 * by the office. `neutral` is for a fact nobody has to act on.
 */
export type NoticeTone = "warning" | "danger" | "success" | "info" | "local" | "neutral";

const noticePresentation: Record<
  NoticeTone,
  { Icon: LucideIcon; className: string; iconClassName: string }
> = {
  warning: {
    Icon: TriangleAlert,
    className:
      "bg-warning-soft shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--warning-line)_60%,transparent)]",
    iconClassName: "text-warning",
  },
  danger: {
    Icon: OctagonAlert,
    className:
      "bg-danger-soft shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--danger-line)_60%,transparent)]",
    iconClassName: "text-danger",
  },
  success: { Icon: CircleCheck, className: "bg-ok-soft", iconClassName: "text-ok" },
  info: { Icon: Info, className: "bg-info-soft", iconClassName: "text-info" },
  local: { Icon: Smartphone, className: "bg-local-soft", iconClassName: "text-local" },
  neutral: {
    Icon: CircleAlert,
    className: "bg-surface-sunk shadow-[inset_0_0_0_1px_var(--border)]",
    iconClassName: "text-muted",
  },
};

export function Notice({
  tone,
  title,
  children,
  actions,
}: {
  tone: NoticeTone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const presentation = noticePresentation[tone];
  const Icon = presentation.Icon;
  return (
    <section
      className={cn(
        "grid grid-cols-[1.125rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-[var(--radius-card)] px-4 py-3.5 text-foreground",
        presentation.className,
      )}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon
        className={cn("mt-0.5 size-[1.125rem] shrink-0", presentation.iconClassName)}
        aria-hidden="true"
      />
      <p className="font-semibold text-foreground">{title}</p>
      {children ? <div className="col-start-2 text-sm leading-6 text-muted">{children}</div> : null}
      {actions ? <div className="col-start-2 mt-2.5 flex flex-wrap gap-2">{actions}</div> : null}
    </section>
  );
}
