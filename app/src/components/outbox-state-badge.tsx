import {
  AlertTriangle,
  Check,
  CloudUpload,
  HardDrive,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../lib/cn";
import { outboxStateLabels, type OutboxState } from "../storage/outbox-types";

const visualByState: Record<
  OutboxState,
  { icon: LucideIcon; className: string; description: string }
> = {
  saved_locally: {
    icon: HardDrive,
    className: "border-info/30 bg-info-soft text-info",
    description: "Saved on this device and not queued yet.",
  },
  queued: {
    icon: CloudUpload,
    className: "border-info/30 bg-info-soft text-info",
    description: "Waiting for a connection while the app is open.",
  },
  uploading: {
    icon: LoaderCircle,
    className: "border-warning/30 bg-warning-soft text-warning",
    description: "Sending now. Keep the app open.",
  },
  verified: {
    icon: Check,
    className: "border-ok/30 bg-ok-soft text-ok",
    description: "The server verified this exact saved item.",
  },
  needs_attention: {
    icon: AlertTriangle,
    className: "border-danger/30 bg-danger-soft text-danger",
    description: "Nothing was discarded. Review is needed before retrying.",
  },
};

export function OutboxStateBadge({ state, className }: { state: OutboxState; className?: string }) {
  const visual = visualByState[state];
  const Icon = visual.icon;
  return (
    <span
      className={cn(
        "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-bold",
        visual.className,
        className,
      )}
      title={visual.description}
    >
      <Icon
        className={cn("size-3.5", state === "uploading" && "animate-spin")}
        aria-hidden="true"
      />
      {outboxStateLabels[state]}
    </span>
  );
}
