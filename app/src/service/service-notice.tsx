import type { ReactNode } from "react";

// One notice shape for every service surface: an alert when a step was refused, a status
// otherwise, so a screen reader hears the difference between a warning and a failure.

export function Notice({
  tone,
  title,
  children,
}: {
  tone: "warning" | "danger" | "success" | "info";
  title: string;
  children: ReactNode;
}) {
  const toneClasses = {
    warning: "border-warning/35 bg-warning-soft",
    danger: "border-danger/35 bg-danger-soft",
    success: "border-ok/35 bg-ok-soft",
    info: "border-info/35 bg-info-soft",
  }[tone];
  return (
    <section
      className={`border px-4 py-4 ${toneClasses}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <p className="font-bold">{title}</p>
      <div className="mt-1 text-sm leading-6 text-muted">{children}</div>
    </section>
  );
}
