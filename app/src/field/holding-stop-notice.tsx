import type { ActiveStop } from "./field-contracts";

/** Informational holding projection; permission and exact crew-release identity come elsewhere. */
export function HoldingStopNotice({
  stops,
  unavailable,
  offline,
}: {
  stops: ActiveStop[] | null;
  unavailable: boolean;
  offline: boolean;
}) {
  if (stops?.length === 0) return null;
  return (
    <section
      aria-label="Safety stops holding this work"
      className="space-y-2 border-2 border-warning/45 bg-warning-soft p-4 sm:p-5"
    >
      <h2 className="text-lg font-bold">
        {stops === null
          ? "Safety-stop status is unknown"
          : offline
            ? "Saved safety stops"
            : "Safety stops hold this work"}
      </h2>
      {stops === null ? (
        <p>
          {unavailable
            ? "Safety-stop details could not be read."
            : "This copy does not include safety-stop details."}{" "}
          This screen cannot confirm whether another stop holds this work. Check the current stops
          before work.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {stops.map((stop, index) => (
              <li key={`${stop.occurrence_id}:${index}`} className="[overflow-wrap:anywhere]">
                <span className="font-semibold">
                  {stop.scope === "tenant" ? "All assignments" : "This assignment"}
                </span>{" "}
                · {stop.summary || "Stop details are unavailable. Check the stop before work."}
              </li>
            ))}
          </ul>
          <p className="text-sm">
            A release of this plan’s crew stop does not clear separate safety stops. Work checks
            still apply.{offline ? " Reconnect to check the current stops." : ""}
          </p>
        </>
      )}
    </section>
  );
}
