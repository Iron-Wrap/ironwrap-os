import { useSession } from "../auth/session-context";
import { OffState, UnconfiguredState } from "../components/ui/state-panel";
import { capabilityCopy } from "./capability-copy";
import type { CapabilityRead } from "./capability-signal";

/**
 * The honest panel for a capability this screen cannot use, or `null` when there is nothing to
 * say: it is reachable, it is absent, it is not this role's, or its state was never read. The
 * last case is the important one — silence is honest where a guess would not be, and the screen's
 * own offline and load-failure notices already explain a missing read.
 */
export function CapabilityUnavailable({ read }: { read: CapabilityRead }) {
  const session = useSession();
  if (read.status !== "known") return null;
  const copy = capabilityCopy(read.capability, session.user.role);
  if (!copy) return null;
  const Panel = read.capability.state === "off" ? OffState : UnconfiguredState;
  return (
    <Panel
      stateLabel={copy.stateLabel}
      title={copy.title}
      message={copy.message}
      nextAction={copy.nextAction}
      personPath={copy.personPath}
    />
  );
}
