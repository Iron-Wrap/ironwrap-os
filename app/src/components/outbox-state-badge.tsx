import { outboxStateLabels, type OutboxState } from "../storage/outbox-types";
import { Status, type StatusKind } from "./ui/status";

const visualByState: Record<OutboxState, { kind: StatusKind; description: string }> = {
  saved_locally: { kind: "local", description: "Saved on this device. Not waiting to send yet." },
  queued: { kind: "local", description: "Waiting to send. Keep the app open." },
  uploading: { kind: "pending", description: "Sending now. Keep the app open." },
  verified: { kind: "confirmed", description: "The office has this exact saved item." },
  needs_attention: {
    kind: "attention",
    description: "Nothing was thrown away. Check this before you try again.",
  },
};

export function OutboxStateBadge({ state, className }: { state: OutboxState; className?: string }) {
  const visual = visualByState[state];
  return (
    <Status kind={visual.kind} className={className} title={visual.description}>
      {outboxStateLabels[state]}
    </Status>
  );
}
