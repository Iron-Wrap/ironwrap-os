import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardHat } from "lucide-react";
import { useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { ErrorSystemDetails } from "../components/ui/system-details";
import { Textarea } from "../components/ui/textarea";
import { WorkspaceHeader } from "../components/workspace-header";
import { safetyEquipmentStatusLabels } from "../field/safety-contracts";
import { useOnlineStatus } from "../hooks/use-online-status";
import { ApiError } from "../lib/api";
import { isRefusal, messageFor, UNANSWERED_CONNECTION } from "../lib/plain-error";
import { loadSafetyDesk } from "./safety-desk-api";
import { equipmentKindLabel, equipmentVerdictLabel } from "./safety-desk-contracts";
import { inspectSafetyEquipment, loadSafetyEquipment } from "./safety-equipment-api";

export function SafetyEquipmentPage({ equipmentId }: { equipmentId?: string }) {
  const session = useSession();
  const online = useOnlineStatus() && !isOfflineSession(session);
  const client = useQueryClient();
  const [result, setResult] = useState<"pass" | "fail">("fail");
  const [detail, setDetail] = useState("");
  const [mustRefresh, setMustRefresh] = useState(false);
  // The revision the inspector was looking at when the findings were started. The verdict is
  // bound to this, not to whatever the query cache holds at submit time: a window-focus or
  // background refetch that brings in someone else's quarantine must not silently re-bind a
  // stale draft to the new revision.
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const desk = useQuery({
    queryKey: ["safety", "desk", session.tenant.id, session.user.id],
    queryFn: () => loadSafetyDesk(),
    retry: false,
  });
  const record = useQuery({
    queryKey: ["safety", "equipment", session.tenant.id, session.user.id, equipmentId],
    queryFn: () => loadSafetyEquipment(equipmentId!),
    enabled: !!equipmentId,
    retry: false,
  });
  const inspection = useMutation({
    // The verdict is bound to the revision on screen. The Worker refuses a verdict against
    // any other revision, so a "pass" typed over a record someone else has since quarantined
    // can never return the item to service.
    mutationFn: () =>
      inspectSafetyEquipment(session, equipmentId!, {
        result,
        detail: detail.trim(),
        expected_version: draftVersion!,
      }),
    onSuccess: async () => {
      setDetail("");
      setDraftVersion(null);
      await client.invalidateQueries({ queryKey: ["safety"] });
    },
    onError: async () => {
      setMustRefresh(true);
      // Show the current record next to the refusal; the person decides, never an auto-retry.
      await client.invalidateQueries({ queryKey: ["safety", "equipment"] });
    },
  });
  const equipment = record.data?.equipment;
  const conflict =
    inspection.error instanceof ApiError &&
    inspection.error.code === "safety_equipment_version_conflict";
  const sessionLost = inspection.error instanceof ApiError && inspection.error.status === 401;
  // The record on screen moved on while findings were being written.
  const draftStale =
    draftVersion !== null && equipment !== undefined && equipment.version !== draftVersion;
  const canSubmit =
    !mustRefresh && !draftStale && draftVersion !== null && detail.trim().length >= 3;
  const mayInspect =
    desk.isSuccess && ["owner", "ops", "production", "shop"].includes(desk.data.actor_role);
  const retired = equipment?.status === "retired" || equipment?.status === "replaced";

  async function refresh() {
    const refreshed = await record.refetch();
    await desk.refetch();
    if (refreshed.isSuccess) setMustRefresh(false);
  }

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        icon={<HardHat aria-hidden="true" />}
        title={equipmentId ? "Inspect safety equipment" : "Safety equipment"}
        description="Read the recorded condition before using an item. A failed inspection takes it out of service."
        actions={
          <Button asChild variant="outline">
            <a href="/safety">Safety desk</a>
          </Button>
        }
      />
      {desk.isPending || (equipmentId && record.isPending) ? (
        <LoadingState label="Reading safety equipment…" />
      ) : null}
      {desk.isError || (equipmentId && record.isError) ? (
        <ErrorState
          message={
            record.error instanceof ApiError && record.error.status === 404
              ? "This equipment record was not found. Return to the safety desk and choose a current item."
              : "Equipment could not be read. Refresh before recording an inspection."
          }
          onRetry={() => {
            void desk.refetch();
            if (equipmentId) void record.refetch();
          }}
        />
      ) : null}
      {!equipmentId && desk.isSuccess ? (
        <>
          <p className="text-sm text-muted">
            Up to 500 current equipment records. Replaced and retired items are excluded.
          </p>
          {desk.data.equipment?.length ? (
            <ul className="space-y-3">
              {desk.data.equipment.map((item) => (
                <li key={item.equipment_id}>
                  <Card>
                    <CardContent className="space-y-2 pt-5">
                      <p className="break-all font-bold">
                        {equipmentKindLabel(item.equipment_kind)} {item.serial_number}
                      </p>
                      <p>{equipmentVerdictLabel(item.verdict)}</p>
                      {item.detail ? <p className="break-all text-sm">{item.detail}</p> : null}
                      <Button asChild variant="outline">
                        <a href={`/safety/equipment/${encodeURIComponent(item.equipment_id)}`}>
                          Open equipment
                        </a>
                      </Button>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          ) : desk.data.equipment === null ? (
            <Notice tone="info" title="Equipment authority required">
              Ask the owner or operations to review the equipment record.
            </Notice>
          ) : (
            <EmptyState
              title="No current equipment"
              message="No equipment is recorded in this list. This is not proof that work is safe to release."
            />
          )}
        </>
      ) : null}
      {equipment ? (
        <Card>
          <CardContent className="space-y-4 pt-5">
            <h2 className="break-all text-lg font-bold">
              {equipmentKindLabel(equipment.equipment_kind)} {equipment.serial_number}
            </h2>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-bold">Recorded state</dt>
                <dd>{safetyEquipmentStatusLabels[equipment.status]}</dd>
              </div>
              <div>
                <dt className="font-bold">Held by</dt>
                <dd className="break-all">{equipment.assigned_user_id ?? "Not assigned"}</dd>
              </div>
              <div>
                <dt className="font-bold">Last inspection</dt>
                <dd>
                  {equipment.last_inspection_result ?? "Never inspected"}
                  {equipment.last_inspection_at ? `, ${equipment.last_inspection_at}` : ""}
                </dd>
              </div>
              <div>
                <dt className="font-bold">Next inspection due</dt>
                <dd>{equipment.inspection_due_at ?? "No inspection recorded"}</dd>
              </div>
            </dl>
            <p className="break-all text-sm text-muted">
              Record {equipment.equipment_id}. Updated {equipment.updated_at}.
            </p>
            <Button
              variant="outline"
              onClick={() => void refresh()}
              disabled={record.isFetching || inspection.isPending}
            >
              Refresh equipment
            </Button>
            {inspection.isSuccess ? (
              <Notice tone="success" title="Inspection recorded">
                The server accepted the inspection. Review the current record above before using
                this item.
              </Notice>
            ) : null}
            {sessionLost ? (
              <Notice tone="warning" title="Your sign-in ended before this was recorded">
                Nothing was recorded. Your findings stay on this screen; sign in again in another
                tab or reload, then press Refresh equipment and decide again.
              </Notice>
            ) : conflict ? (
              <Notice tone="warning" title="This record changed before your inspection arrived">
                The current condition is shown above; your findings are kept. Decide again against
                the current revision.
              </Notice>
            ) : inspection.isError && isRefusal(inspection.error) ? (
              // A refusal is a confirmed "no", and its sentence already names the next step.
              <Notice tone="danger" title="Inspection not recorded">
                {messageFor(inspection.error, { refused: "Check the details and try again." })} Your
                findings stay on this screen.
                <ErrorSystemDetails error={inspection.error} />
              </Notice>
            ) : inspection.isError ? (
              <Notice tone="danger" title="Inspection not confirmed">
                {messageFor(inspection.error, {
                  byCode: UNANSWERED_CONNECTION,
                  fallback: "The server did not confirm this inspection.",
                })}{" "}
                Refresh the record and check the last inspection before submitting again.
                <ErrorSystemDetails error={inspection.error} />
              </Notice>
            ) : null}
            {!online ? (
              <Notice tone="warning" title="Connect before inspecting">
                Inspections require a live authority check. You can still report unsafe equipment
                from the Safety panel; that report is saved on this device.
              </Notice>
            ) : null}
            {retired ? (
              <Notice tone="info" title="No longer in service">
                Replaced or retired equipment cannot receive another inspection.
              </Notice>
            ) : !mayInspect && desk.isSuccess ? (
              <Notice tone="info" title="Equipment authority required">
                Only the owner, operations, production or shop may record an inspection.
              </Notice>
            ) : null}
            {mayInspect && record.isSuccess && online && !retired ? (
              <form
                className="space-y-4 border-t pt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!inspection.isPending && canSubmit) inspection.mutate();
                }}
              >
                <label className="block text-sm font-bold">
                  Inspection result
                  <Select
                    className="mt-1"
                    value={result}
                    onChange={(event) => setResult(event.target.value as "pass" | "fail")}
                  >
                    <option value="fail">Fail: quarantine this item</option>
                    <option value="pass">Pass: return to service</option>
                  </Select>
                </label>
                <label className="block text-sm font-bold">
                  Inspection findings
                  <Textarea
                    className="mt-1"
                    value={detail}
                    required
                    minLength={3}
                    maxLength={4000}
                    onChange={(event) => {
                      setDetail(event.target.value);
                      if (draftVersion === null) setDraftVersion(equipment.version);
                    }}
                  />
                </label>
                <p className="text-sm text-muted">
                  A pass resets the inspection due date by {equipment.inspection_interval_days}{" "}
                  days. A fail quarantines the item immediately.
                </p>
                {draftStale ? (
                  <Notice tone="warning" title="This record changed while you were writing">
                    The record changed since you started these findings. Read the current condition
                    above, then decide again. Your findings are kept.
                    <div className="mt-3">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setDraftVersion(equipment.version)}
                      >
                        I have read the current record, decide again
                      </Button>
                    </div>
                  </Notice>
                ) : null}
                <Button type="submit" busy={inspection.isPending} disabled={!canSubmit}>
                  Record inspection
                </Button>
              </form>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
