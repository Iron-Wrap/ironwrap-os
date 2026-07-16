import { AlertTriangle, Check, CircleDashed, ShieldCheck } from "lucide-react";

import { cn } from "../lib/cn";

const stateStyle: Record<string, string> = {
  Blocked: "border-danger/35 bg-danger-soft text-danger",
  Ready: "border-info/35 bg-info-soft text-info",
  Waived: "border-warning/35 bg-warning-soft text-warning",
  Done: "border-ok/35 bg-ok-soft text-ok",
};

export function GateChip({ name, state }: { name: string; state: string }) {
  const Icon =
    state === "Blocked"
      ? AlertTriangle
      : state === "Done"
        ? Check
        : state === "Ready"
          ? ShieldCheck
          : CircleDashed;
  return (
    <span
      className={cn(
        "inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-sm font-extrabold",
        stateStyle[state] ?? "bg-surface-muted text-muted",
      )}
      aria-label={`${name}: ${state}`}
    >
      <Icon className="size-4" aria-hidden="true" />
      {name} · {state}
    </span>
  );
}
