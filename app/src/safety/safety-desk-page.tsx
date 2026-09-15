import { useQuery } from "@tanstack/react-query";
import { HardHat, RefreshCw } from "lucide-react";
import { useMemo } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { EmptyState, ErrorState, LoadingState, NoAccessState } from "../components/ui/state-panel";
import { WorkspaceHeader } from "../components/workspace-header";
import { ApiError } from "../lib/api";
import { loadSafetyDesk, safetyDeskQueryKeys } from "./safety-desk-api";
import {
  correctiveActionStateLabel,
  correctiveActionTiming,
  equipmentKindLabel,
  equipmentVerdictLabel,
  type SafetyDeskCorrectiveAction,
  type SafetyDeskEquipment,
  type SafetyDeskResponse,
} from "./safety-desk-contracts";

function EquipmentRow({ item }: { item: SafetyDeskEquipment }) {
  return (
    <li className="border-t border-border py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 break-words font-bold">
          {equipmentKindLabel(item.equipment_kind)} {item.serial_number}
        </p>
        <p className="text-sm font-bold tabular-nums">{equipmentVerdictLabel(item.verdict)}</p>
      </div>
      {/* The gate's own sentence, so the desk cannot describe a stop differently. */}
      {item.detail ? <p className="mt-1 text-sm break-words">{item.detail}</p> : null}
      <p className="mt-1 text-sm break-words text-muted">
        {item.assigned_user_id ? `Held by ${item.assigned_user_id}` : "Not issued to anyone"}.{" "}
        {item.last_inspection_result
          ? `Last inspection ${item.last_inspection_result}.`
          : "Never inspected."}
      </p>
    </li>
  );
}

function ActionRow({ action }: { action: SafetyDeskCorrectiveAction }) {
  return (
    <li className="border-t border-border py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 break-words font-bold">{action.description}</p>
        <p className="text-sm font-bold tabular-nums">
          {action.blocking ? "Stops work" : correctiveActionStateLabel(action.state)}
        </p>
      </div>
      <p className="mt-1 text-sm text-muted">{correctiveActionTiming(action)}</p>
      <Button asChild variant="outline" className="mt-2">
        <a href={`/safety/corrective-actions/${encodeURIComponent(action.corrective_action_id)}`}>
          Open action
        </a>
      </Button>
      <p className="mt-1 text-sm break-all text-muted">
        {action.risk_level} risk. Owned by {action.owner_user_id}. From {action.occurrence_id}.
      </p>
      {action.blocking ? (
        <p className="mt-1 text-sm">
          A release is refused while this stays open, because its risk is {action.risk_level} and
          its date has passed.
        </p>
      ) : null}
    </li>
  );
}

function Rail({
  heading,
  id,
  children,
}: {
  heading: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-lg font-bold">
        {heading}
      </h2>
      {children}
    </section>
  );
}

function summarize(data: SafetyDeskResponse | undefined) {
  const equipment = data?.equipment ?? [];
  const actions = data?.corrective_actions ?? [];
  return {
    blockedEquipment: equipment.filter((item) => item.verdict === "unserviceable"),
    expiringEquipment: equipment.filter((item) => item.verdict === "expiring"),
    usableEquipment: equipment.filter((item) => item.verdict === "serviceable"),
    blockingActions: actions.filter((action) => action.blocking),
    otherActions: actions.filter((action) => !action.blocking),
  };
}

export function SafetyDeskPage() {
  const session = useSession();
  const offline = isOfflineSession(session);
  const desk = useQuery({
    queryKey: safetyDeskQueryKeys.desk,
    queryFn: () => loadSafetyDesk(),
    retry: false,
  });

  const groups = useMemo(() => summarize(desk.data), [desk.data]);
  const forbidden = desk.error instanceof ApiError && desk.error.status === 403;
  const stopping = groups.blockedEquipment.length + groups.blockingActions.length;
  const nothingOnFile =
    (desk.data?.equipment?.length ?? 0) === 0 && (desk.data?.corrective_actions?.length ?? 0) === 0;

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        icon={<HardHat aria-hidden="true" />}
        title="What is safe to use, and what is not"
        description="Safety equipment and open corrective actions available to your role, judged by the release rules. This desk shows up to 500 equipment records and 200 actions."
        actions={
          <>
            <Button asChild variant="outline">
              <a href="/safety/equipment">Equipment</a>
            </Button>
            <Button
              variant="outline"
              onClick={() => void desk.refetch()}
              disabled={desk.isFetching}
            >
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
          </>
        }
      />

      {offline ? (
        <Notice tone="warning" title="Offline, so this is read only">
          You are seeing the last copy this device holds. Nothing on this screen changes anything,
          so nothing is queued.
        </Notice>
      ) : null}

      {forbidden ? (
        <NoAccessState
          title="Not your role"
          message="The safety desk is read by the people who can act on it: equipment authority for the gear, response authority for the corrective actions."
          nextAction="Your own gear and your own actions are on the safety panel."
          personPath="the owner or operations"
        />
      ) : desk.isPending ? (
        <LoadingState label="Reading what is on file…" />
      ) : desk.isError ? (
        <ErrorState
          message={
            desk.error instanceof ApiError && desk.error.status === 502
              ? "The safety store did not answer. Nothing is lost; try again."
              : "This did not load. Nothing is lost; try again."
          }
          onRetry={() => void desk.refetch()}
        />
      ) : nothingOnFile ? (
        <EmptyState
          title="No safety records on this desk"
          message="There are no records in the lists available to your role. An empty desk is not the same as a safe one."
        />
      ) : (
        <>
          <Card>
            <CardContent className="grid grid-cols-2 gap-4 pt-5 sm:grid-cols-4">
              <div>
                <p className="text-sm font-bold text-muted">Stops work now</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{stopping}</p>
              </div>
              <div>
                <p className="text-sm font-bold text-muted">
                  Inspections due in {desk.data.expiring_within_days} days
                </p>
                <p className="mt-1 text-2xl font-bold tabular-nums">
                  {groups.expiringEquipment.length}
                </p>
              </div>
              <div>
                <p className="text-sm font-bold text-muted">Equipment records</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">
                  {desk.data.equipment?.length ?? "Unavailable"}
                </p>
              </div>
              <div>
                <p className="text-sm font-bold text-muted">Open actions</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">
                  {desk.data.corrective_actions?.length ?? "Unavailable"}
                </p>
              </div>
            </CardContent>
          </Card>

          {stopping > 0 ? (
            <Rail id="stopping" heading={`Stops work now, ${stopping}`}>
              {groups.blockingActions.length > 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Corrective actions past their date</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul>
                      {groups.blockingActions.map((action) => (
                        <ActionRow key={action.corrective_action_id} action={action} />
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ) : null}
              {groups.blockedEquipment.length > 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Equipment that may not be used</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul>
                      {groups.blockedEquipment.map((item) => (
                        <EquipmentRow key={item.equipment_id} item={item} />
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ) : null}
            </Rail>
          ) : null}

          {groups.expiringEquipment.length > 0 ? (
            <Rail id="expiring" heading={`Due soon, ${groups.expiringEquipment.length}`}>
              <Card>
                <CardContent className="pt-5">
                  <ul>
                    {groups.expiringEquipment.map((item) => (
                      <EquipmentRow key={item.equipment_id} item={item} />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </Rail>
          ) : null}

          {groups.otherActions.length > 0 ? (
            <Rail id="tracking" heading={`Open, not stopping work, ${groups.otherActions.length}`}>
              <Card>
                <CardContent className="pt-5">
                  <ul>
                    {groups.otherActions.map((action) => (
                      <ActionRow key={action.corrective_action_id} action={action} />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </Rail>
          ) : null}

          {groups.usableEquipment.length > 0 ? (
            <Rail id="usable" heading={`Usable, ${groups.usableEquipment.length}`}>
              <Card>
                <CardContent className="pt-5">
                  <ul>
                    {groups.usableEquipment.map((item) => (
                      <EquipmentRow key={item.equipment_id} item={item} />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </Rail>
          ) : null}

          <p className="text-sm text-muted">
            Read model generated {desk.data.read_model_generated_at.slice(0, 16).replace("T", " ")}{" "}
            UTC. Issuing, inspecting, quarantining and closing all happen on the safety rail, not
            here.
          </p>
        </>
      )}
      {desk.isSuccess ? (
        <>
          {/* A rail this role may not read is said plainly, never shown as an empty list. */}
          {desk.data.equipment === null ? (
            <Notice tone="info" title="Equipment is not on your desk">
              Reading the company's equipment needs equipment authority. Your own issued gear is on
              the safety panel.
            </Notice>
          ) : null}
          {desk.data.corrective_actions === null ? (
            <Notice tone="info" title="Corrective actions are not on your desk">
              Reading the company's corrective actions needs response authority. Your own assigned
              actions are on the safety panel.
            </Notice>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export default SafetyDeskPage;
