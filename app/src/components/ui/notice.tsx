import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

type NoticeTone = "warning" | "danger" | "success" | "info";

const noticePresentation: Record<
  NoticeTone,
  { Icon: LucideIcon; className: string; iconClassName: string }
> = {
  warning: {
    Icon: CircleAlert,
    className: "border-warning/35 bg-warning-soft",
    iconClassName: "text-warning",
  },
  danger: {
    Icon: TriangleAlert,
    className: "border-danger/35 bg-danger-soft",
    iconClassName: "text-danger",
  },
  success: {
    Icon: CircleCheck,
    className: "border-ok/35 bg-ok-soft",
    iconClassName: "text-ok",
  },
  info: {
    Icon: Info,
    className: "border-info/35 bg-info-soft",
    iconClassName: "text-info",
  },
};

export function Notice({
  tone,
  title,
  children,
}: {
  tone: NoticeTone;
  title: string;
  children: ReactNode;
}) {
  const presentation = noticePresentation[tone];
  const Icon = presentation.Icon;
  return (
    <section
      className={cn("rounded-xl border px-4 py-4 sm:px-5", presentation.className)}
      role={tone === "danger" ? "alert" : "status"}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={cn("mt-0.5 size-5 shrink-0", presentation.iconClassName)}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="font-bold text-foreground">{title}</p>
          <div className="mt-1 text-sm leading-6 text-muted">{children}</div>
        </div>
      </div>
    </section>
  );
}
