import { useQuery } from "@tanstack/react-query";
import { Barcode, ClipboardList, PackageSearch, RefreshCw, Warehouse } from "lucide-react";
import { useState, type FormEvent } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import { Notice } from "../components/ui/notice";
import {
  loadInventoryOverview,
  lookupInventoryBarcode,
  newInventoryActionKey,
  queueInventoryCommand,
  queueInventoryScan,
  recordInventoryScan,
  submitInventoryCommand,
} from "./inventory-api";
import {
  inventoryStatusLabel,
  inventoryTransitionLabel,
  type InventoryCommandInput,
  type InventoryLookupResponse,
  type InventoryOverviewResponse,
  type InventoryScanInput,
  type InventoryTransition,
} from "./inventory-contracts";

type Position = InventoryOverviewResponse["positions"][number];
type Layer = InventoryOverviewResponse["valuation_layers"][number];

type ActionState =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "success" | "rejected" | "uncertain"; message: string };

type CommandForm = {
  sourcePositionId: string;
  targetPositionId: string;
  itemId: string;
  lotId: string;
  binId: string;
  uomId: string;
  jobCustody: string;
  quantity: string;
  countedQuantity: string;
  unitCost: string;
  approvalId: string;
  jobId: string;
  workPackageId: string;
  reservationId: string;
  receiptId: string;
  poLineId: string;
  countSessionId: string;
  reversalReference: string;
  conditionStatus: "accepted" | "damaged" | "quarantined";
  evidenceRef: string;
  evidenceSha256: string;
};

type CommandAttempt = {
  commandId: string;
  key: string;
  input: InventoryCommandInput;
};

const EMPTY_COMMAND_FORM: CommandForm = {
  sourcePositionId: "",
  targetPositionId: "",
  itemId: "",
  lotId: "",
  binId: "",
  uomId: "",
  jobCustody: "-",
  quantity: "1",
  countedQuantity: "",
  unitCost: "0.00",
  approvalId: "",
  jobId: "",
  workPackageId: "",
  reservationId: "",
  receiptId: "",
  poLineId: "",
  countSessionId: "",
  reversalReference: "",
  conditionStatus: "accepted",
  evidenceRef: "",
  evidenceSha256: "",
};

const TRANSITION_GUIDANCE: Record<
  InventoryTransition,
  { summary: string; sourceLabel?: string; targetLabel?: string; quantityLabel?: string }
> = {
  receive: {
    summary: "Add a received quantity to the selected stock position and record its cost.",
    sourceLabel: "Received stock position",
    quantityLabel: "Received quantity",
  },
  reserve: {
    summary: "Hold stock for a job without moving it out of the warehouse.",
    sourceLabel: "Stock to reserve",
    quantityLabel: "Quantity to reserve",
  },
  release_reservation: {
    summary: "Release a previous job hold so the stock is available again.",
    sourceLabel: "Reserved stock",
    quantityLabel: "Quantity to release",
  },
  issue_use: {
    summary: "Issue stock for a roofing job. The server values it from available layers.",
    sourceLabel: "Stock to issue",
    quantityLabel: "Quantity used",
  },
  return: {
    summary: "Put returned material back into a stock position and record its return cost.",
    sourceLabel: "Returned stock position",
    quantityLabel: "Quantity returned",
  },
  transfer: {
    summary: "Move stock between two positions. Both positions must use the same item and unit.",
    sourceLabel: "Move from",
    targetLabel: "Move to",
    quantityLabel: "Quantity to move",
  },
  quarantine: {
    summary: "Mark stock as quarantined without changing total quantity.",
    sourceLabel: "Stock to quarantine",
    quantityLabel: "Quantity to quarantine",
  },
  release_quarantine: {
    summary: "Release quarantined stock back to available stock.",
    sourceLabel: "Quarantined stock",
    quantityLabel: "Quantity to release",
  },
  count_freeze: {
    summary: "Freeze this stock position while a physical count is performed.",
    sourceLabel: "Position to freeze",
  },
  count_adjustment: {
    summary: "Post an approved count variance against the selected stock position.",
    sourceLabel: "Counted stock position",
    quantityLabel: "Counted quantity",
  },
  yield: {
    summary: "Move material from a source position into the selected usable output position.",
    sourceLabel: "Source material",
    targetLabel: "Usable output position",
    quantityLabel: "Quantity yielded",
  },
  reversal: {
    summary: "Reverse a material movement into the selected destination position.",
    sourceLabel: "Position to reverse from",
    targetLabel: "Position to reverse to",
    quantityLabel: "Quantity to reverse",
  },
};

export function InventoryPage() {
  return <InventoryContent />;
}

function InventoryContent() {
  const session = useSession();
  const offline = isOfflineSession(session);
  const query = useQuery({
    queryKey: ["inventory-overview", session.tenant.id, session.user.id],
    queryFn: () => loadInventoryOverview(session),
    retry: false,
  });

  if (query.isPending) return <LoadingState label="Loading inventory…" />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title="Inventory unavailable"
        message="Nothing was changed. Reconnect and try the inventory desk again."
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <InventoryDesk
      overview={query.data}
      session={session}
      offline={offline}
      onRefresh={() => void query.refetch()}
      refreshing={query.isFetching}
    />
  );
}

function InventoryDesk({
  overview,
  session,
  offline,
  onRefresh,
  refreshing,
}: {
  overview: InventoryOverviewResponse;
  session: ReturnType<typeof useSession>;
  offline: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [barcode, setBarcode] = useState("");
  const [lookupState, setLookupState] = useState<{
    phase: "idle" | "pending" | "success" | "not_found" | "rejected" | "uncertain";
    response?: InventoryLookupResponse;
    message?: string;
  }>({ phase: "idle" });
  const [scanState, setScanState] = useState<ActionState>({ phase: "idle" });
  const [commandState, setCommandState] = useState<ActionState>({ phase: "idle" });
  const [commandAttempt, setCommandAttempt] = useState<CommandAttempt | null>(null);
  const [scanAttempt, setScanAttempt] = useState<InventoryScanInput | null>(null);
  const [selectedTransition, setSelectedTransition] = useState<InventoryTransition | undefined>();
  const [form, setForm] = useState<CommandForm>({ ...EMPTY_COMMAND_FORM });

  const transition =
    selectedTransition && overview.allowed_transitions.includes(selectedTransition)
      ? selectedTransition
      : overview.allowed_transitions[0];

  const sourcePosition = overview.positions.find(
    (position) => position.position_id === form.sourcePositionId,
  );
  const targetPosition = overview.positions.find(
    (position) => position.position_id === form.targetPositionId,
  );
  const sourceLayers = sourcePosition
    ? overview.valuation_layers.filter(
        (layer) =>
          layer.item_id === sourcePosition.item_id &&
          (overview.items.find((item) => item.item_id === sourcePosition.item_id)
            ?.valuation_method === "fifo" ||
            layer.lot_id === sourcePosition.lot_id) &&
          layer.remaining_scaled > 0,
      )
    : [];
  const compatibleTargets = sourcePosition
    ? overview.positions.filter(
        (position) =>
          position.position_id !== sourcePosition.position_id &&
          position.item_id === sourcePosition.item_id &&
          position.uom_id === sourcePosition.uom_id &&
          (transition === "yield"
            ? position.parent_lot_id === sourcePosition.lot_id &&
              ["remnant", "scrap"].includes(position.lot_kind)
            : position.lot_id === sourcePosition.lot_id),
      )
    : [];

  function setField<K extends keyof CommandForm>(field: K, value: CommandForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function choosePosition(position: Position, target = false) {
    setField(target ? "targetPositionId" : "sourcePositionId", position.position_id);
    if (!target) {
      setForm((current) => ({
        ...current,
        sourcePositionId: position.position_id,
        targetPositionId: "",
        itemId: position.item_id,
        lotId: position.lot_id,
        binId: position.bin_id,
        uomId: position.uom_id,
        jobCustody: position.job_custody,
      }));
    }
  }

  function chooseLookupPosition(result: InventoryLookupResponse["result"]) {
    if (!result) return;
    const position = overview.positions.find((candidate) =>
      result.entity_type === "lot"
        ? candidate.lot_id === result.entity_id
        : result.entity_type === "bin"
          ? candidate.bin_id === result.entity_id
          : candidate.item_id === result.entity_id,
    );
    if (position) choosePosition(position);
  }

  async function submitLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = barcode.trim();
    if (!value) {
      setLookupState({ phase: "rejected", message: "Enter a barcode before looking it up." });
      return;
    }
    setLookupState({ phase: "pending" });
    try {
      const response = await lookupInventoryBarcode(session, value);
      setLookupState({ phase: response.result ? "success" : "not_found", response });
      chooseLookupPosition(response.result);
    } catch (error) {
      setLookupState(actionStateFromError(error, "Barcode lookup could not be completed."));
    }
  }

  async function submitScan() {
    const value = barcode.trim();
    if (!value) {
      setScanState({ phase: "rejected", message: "Enter a barcode before recording a scan." });
      return;
    }
    const attempt = scanAttempt ?? {
      scan_id: newInventoryActionKey("scan"),
      device_id: `pwa:${session.user.id}`,
      device_action_id: newInventoryActionKey("scan-action"),
      barcode: value,
      scan_intent: "lookup" as const,
      observed_at: new Date().toISOString(),
      captured_offline: false,
      payload: { source: "inventory-desk" },
    };
    setScanAttempt(attempt);
    setScanState({ phase: "pending" });
    try {
      if (offline) {
        await queueInventoryScan(session, attempt);
        setScanState({
          phase: "success",
          message:
            "Scan saved on this device and will sync once the live inventory authority returns.",
        });
        setScanAttempt(null);
        return;
      }
      const response = await recordInventoryScan(session, attempt);
      setScanState({
        phase: response.kind === "conflict" ? "rejected" : "success",
        message:
          response.kind === "conflict"
            ? "This scan action already has different facts; start a new scan."
            : response.kind === "duplicate"
              ? "The earlier scan was found again; no second observation was created."
              : response.scan.resolution === "observed_pending_validation"
                ? "Scan recorded for validation; it did not create stock."
                : "Scan recorded and resolved against the tenant inventory.",
      });
      if (response.kind !== "conflict") setScanAttempt(null);
    } catch (error) {
      const state = actionStateFromError(
        error,
        "The scan outcome is uncertain. Retry the same scan action to reconcile it safely.",
      );
      setScanState(state);
      if (state.phase !== "uncertain") setScanAttempt(null);
    }
  }

  async function submitCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!transition) {
      setCommandState({
        phase: "rejected",
        message: "No transition is currently allowed for this session.",
      });
      return;
    }
    const attempt = commandAttempt ?? createCommandAttempt(transition, form, overview);
    if (!attempt) {
      setCommandState({
        phase: "rejected",
        message: "Complete the guided fields and evidence before submitting.",
      });
      return;
    }
    setCommandAttempt(attempt);
    setCommandState({ phase: "pending" });
    try {
      if (offline) {
        await queueInventoryCommand(session, attempt.input, attempt.key);
        setCommandState({
          phase: "success",
          message:
            "Action saved on this device. It will replay with the same idempotency key when reconnected.",
        });
        setCommandAttempt(null);
        return;
      }
      const response = await submitInventoryCommand(session, attempt.input, attempt.key);
      if (response.kind === "applied" || response.kind === "replayed") {
        setCommandState({
          phase: "success",
          message:
            response.kind === "replayed"
              ? "The earlier command was found again; no second ledger write was made."
              : "Inventory command applied and the ledger was read back.",
        });
        setCommandAttempt(null);
        onRefresh();
      } else {
        setCommandState({
          phase: "rejected",
          message: response.code
            ? `Command refused: ${humanizeCode(response.code)}.`
            : "Command refused before inventory changed.",
        });
        setCommandAttempt(null);
      }
    } catch (error) {
      const state = actionStateFromError(
        error,
        "The command outcome is uncertain. Retry this same action to reconcile it safely.",
      );
      setCommandState(state);
      if (state.phase !== "uncertain") setCommandAttempt(null);
    }
  }

  function resetCommandAttempt() {
    setCommandAttempt(null);
    setCommandState({ phase: "idle" });
  }

  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
              <Warehouse className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                Inventory
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                Scan a stock identity, choose what happened, and submit one governed warehouse
                action.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="compact"
            busy={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect before changing inventory">
          The saved screen can be read, but commands and scans require the live D1 authority, CSRF,
          and idempotency checks.
        </Notice>
      ) : null}

      <section aria-label="Inventory authority and policy" className="grid gap-3 sm:grid-cols-2">
        <IdentityTile
          label="Current authority"
          value={overview.authority_ref ?? "None read back"}
          detail={inventoryStatusLabel(overview.authority.verification_state)}
        />
        <IdentityTile
          label="Command policy"
          value={overview.policy_ref}
          detail={`Version ${overview.policy_version}`}
        />
      </section>
      {overview.authority.verification_state !== "verified" ? (
        <Notice tone="danger" title="Inventory commands are fail-closed">
          The current inventory authority is{" "}
          {inventoryStatusLabel(overview.authority.verification_state).toLowerCase()}. The server
          will refuse commands until a current verified readback exists.
        </Notice>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        <Tile label="Items" value={overview.summary.item_count} />
        <Tile label="Positions" value={overview.summary.position_count} />
        <Tile label="On hand" value={summaryQuantity(overview, "quantity_scaled")} />
        <Tile label="Reserved" value={summaryQuantity(overview, "reserved_scaled")} />
        <Tile
          label="Quarantined"
          value={summaryQuantity(overview, "quarantined_scaled")}
          tone={overview.summary.quarantined_scaled > 0 ? "danger" : undefined}
        />
        <Tile label="Value" value={summaryValue(overview, session.tenant.currency)} />
      </dl>
      <SummaryGroups overview={overview} />

      <InventoryCatalog overview={overview} />

      <section
        aria-labelledby="inventory-scan-heading"
        className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]"
      >
        <Card>
          <CardHeader>
            <CardTitle id="inventory-scan-heading" className="flex items-center gap-2">
              <Barcode aria-hidden="true" />
              Scan or look up
            </CardTitle>
            <CardDescription>
              Lookup is read-only. Recording a scan creates one duplicate-safe physical observation.
              A matching lot, item, or bin is selected for the next action.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              aria-label="Scan or look up"
              onSubmit={(event) => void submitLookup(event)}
            >
              <label htmlFor="inventory-barcode" className="block text-sm font-bold">
                Barcode
              </label>
              <Input
                id="inventory-barcode"
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                autoComplete="off"
                inputMode="text"
                placeholder="Scan or enter a barcode"
              />
              <div className="flex flex-wrap gap-3">
                <Button type="submit" variant="outline" busy={lookupState.phase === "pending"}>
                  <PackageSearch aria-hidden="true" />
                  Look up
                </Button>
                <Button
                  type="button"
                  variant="accent"
                  busy={scanState.phase === "pending"}
                  onClick={() => void submitScan()}
                >
                  <Barcode aria-hidden="true" />
                  Record scan
                </Button>
              </div>
            </form>
            {lookupState.phase === "success" && lookupState.response?.result ? (
              <Notice tone="success" title="Barcode resolved">
                <LookupResult result={lookupState.response.result} />
                {sourcePosition ? (
                  <span className="mt-1 block">Selected: {positionLabel(sourcePosition)}.</span>
                ) : (
                  <span className="mt-1 block">
                    The identity is known, but this desk has no matching stock position to act on.
                  </span>
                )}
              </Notice>
            ) : null}
            {lookupState.phase === "not_found" ? (
              <Notice tone="info" title="No active identity found">
                No active barcode in this tenant matched that value. The lookup did not guess an
                item or create stock.
              </Notice>
            ) : null}
            {lookupState.phase === "rejected" || lookupState.phase === "uncertain" ? (
              <Notice
                tone={lookupState.phase === "uncertain" ? "warning" : "danger"}
                title={lookupState.phase === "uncertain" ? "Lookup uncertain" : "Lookup refused"}
              >
                {lookupState.message}
              </Notice>
            ) : null}
            {scanState.phase !== "idle" && scanState.phase !== "pending" ? (
              <Notice
                tone={
                  scanState.phase === "success"
                    ? "success"
                    : scanState.phase === "uncertain"
                      ? "warning"
                      : "danger"
                }
                title={
                  scanState.phase === "success"
                    ? "Scan complete"
                    : scanState.phase === "uncertain"
                      ? "Scan outcome uncertain"
                      : "Scan refused"
                }
              >
                {scanState.message}
              </Notice>
            ) : null}
          </CardContent>
        </Card>
        <RecentScans scans={overview.recent_scans} />
      </section>

      <section aria-labelledby="inventory-positions-heading">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-muted">Tenant stock position</p>
            <h2
              id="inventory-positions-heading"
              className="mt-1 text-2xl font-black tracking-[-0.03em]"
            >
              Available stock
            </h2>
          </div>
          <span className="text-sm text-muted">{overview.positions.length} shown</span>
        </div>
        {overview.positions.length === 0 ? (
          <EmptyState
            title="No stock positions yet"
            message="A verified receipt or return will appear here after the ledger accepts it."
          />
        ) : (
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <caption className="sr-only">Tenant inventory positions</caption>
              <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-[0.12em] text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    Material
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Location
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Available
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Reserved / quarantine
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Choose
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.positions.map((position) => (
                  <tr key={position.position_id} className="border-b border-border last:border-0">
                    <th scope="row" className="px-4 py-4">
                      <span className="block font-bold">{position.item_code}</span>
                      <span className="block text-xs font-normal text-muted">
                        {position.item_kind} · lot {position.lot_code}
                      </span>
                    </th>
                    <td className="px-4 py-4">
                      <span className="block font-bold">{position.location_name}</span>
                      <span className="block text-xs text-muted">
                        {position.location_code} · bin {position.bin_code}
                      </span>
                    </td>
                    <td className="px-4 py-4 tabular-nums">
                      {formatQuantity(
                        position.quantity_scaled -
                          position.reserved_scaled -
                          position.quarantined_scaled,
                        position.uom_scale,
                      )}{" "}
                      {position.uom_code}
                    </td>
                    <td className="px-4 py-4 text-xs text-muted">
                      {formatQuantity(position.reserved_scaled, position.uom_scale)} reserved ·{" "}
                      {formatQuantity(position.quarantined_scaled, position.uom_scale)} quarantined
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="compact"
                          onClick={() => choosePosition(position)}
                        >
                          Use as source
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="compact"
                          onClick={() => choosePosition(position, true)}
                        >
                          Use as destination
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="inventory-command-heading">
        <Card>
          <CardHeader>
            <CardTitle id="inventory-command-heading" className="flex items-center gap-2">
              <ClipboardList aria-hidden="true" />
              Record a stock action
            </CardTitle>
            <CardDescription>
              Only transitions the server grants this session appear below. Labels describe the
              roofing action; ledger identities are populated from the selected stock positions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {transition ? (
              <form
                className="space-y-6"
                aria-label="Record warehouse action"
                onSubmit={(event) => void submitCommand(event)}
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm font-bold">
                    What happened?
                    <select
                      className="mt-2 min-h-14 w-full rounded-lg border bg-surface-raised px-4 text-base"
                      value={transition}
                      onChange={(event) => {
                        setSelectedTransition(event.target.value as InventoryTransition);
                        setCommandAttempt(null);
                        setCommandState({ phase: "idle" });
                      }}
                    >
                      {overview.allowed_transitions.map((allowed) => (
                        <option key={allowed} value={allowed}>
                          {inventoryTransitionLabel(allowed)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="border border-border bg-surface-muted px-4 py-3 text-sm leading-6 text-muted">
                    {TRANSITION_GUIDANCE[transition].summary}
                  </div>
                </div>

                <TransitionFields
                  transition={transition}
                  form={form}
                  sourcePosition={sourcePosition}
                  targetPosition={targetPosition}
                  positions={overview.positions}
                  compatibleTargets={compatibleTargets}
                  sourceLayers={sourceLayers}
                  onChange={setField}
                />

                <EvidenceFields form={form} onChange={setField} />

                {commandState.phase !== "idle" && commandState.phase !== "pending" ? (
                  <Notice
                    tone={
                      commandState.phase === "success"
                        ? "success"
                        : commandState.phase === "uncertain"
                          ? "warning"
                          : "danger"
                    }
                    title={
                      commandState.phase === "success"
                        ? "Action complete"
                        : commandState.phase === "uncertain"
                          ? "Action outcome uncertain"
                          : "Action refused"
                    }
                  >
                    {commandState.message}
                    {commandState.phase === "uncertain" ? (
                      <Button
                        className="mt-3"
                        type="button"
                        variant="outline"
                        size="compact"
                        onClick={resetCommandAttempt}
                      >
                        Start a new action
                      </Button>
                    ) : null}
                  </Notice>
                ) : null}
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" variant="accent" busy={commandState.phase === "pending"}>
                    {commandState.phase === "uncertain" ? "Retry same action" : "Record action"}
                  </Button>
                  <span className="text-sm text-muted">
                    Policy {overview.policy_ref} · version {overview.policy_version}
                  </span>
                </div>
              </form>
            ) : (
              <EmptyState
                title="No action is available"
                message="The server did not grant an inventory transition for this session."
              />
            )}
          </CardContent>
        </Card>
      </section>
    </section>
  );
}

function TransitionFields({
  transition,
  form,
  sourcePosition,
  targetPosition,
  positions,
  compatibleTargets,
  sourceLayers,
  onChange,
}: {
  transition: InventoryTransition;
  form: CommandForm;
  sourcePosition: Position | undefined;
  targetPosition: Position | undefined;
  positions: Position[];
  compatibleTargets: Position[];
  sourceLayers: Layer[];
  onChange: <K extends keyof CommandForm>(field: K, value: CommandForm[K]) => void;
}) {
  const guide = TRANSITION_GUIDANCE[transition];
  const needsTarget = ["transfer", "yield"].includes(transition);
  const needsSource = !["receive", "return", "reversal"].includes(transition);
  const needsQuantity = !["count_freeze", "reversal"].includes(transition);
  const needsUnitCost = ["receive", "return", "count_adjustment"].includes(transition);
  const needsCount = transition === "count_adjustment";
  const needsApproval = ["count_adjustment", "release_quarantine"].includes(transition);
  const needsJob = transition === "reserve";
  const needsReservation = transition === "release_reservation";
  const needsReceipt = transition === "receive";
  const needsCountSession = transition === "count_adjustment";
  const available = sourcePosition
    ? sourcePosition.quantity_scaled -
      sourcePosition.reserved_scaled -
      sourcePosition.quarantined_scaled
    : 0;

  return (
    <fieldset className="space-y-4 border-t border-border pt-5">
      <legend className="text-base font-bold">{guide.summary}</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        {transition !== "reversal" ? (
          <PositionSelect
            id="inventory-source-position"
            label={guide.sourceLabel ?? "Stock position"}
            value={form.sourcePositionId}
            positions={positions}
            onChange={(value) => onChange("sourcePositionId", value)}
            emptyLabel={
              needsSource ? "Choose a stock position" : "Create or choose an exact receipt position"
            }
          />
        ) : null}
        {needsTarget ? (
          <PositionSelect
            id="inventory-target-position"
            label={guide.targetLabel ?? "Destination"}
            value={form.targetPositionId}
            positions={compatibleTargets}
            onChange={(value) => onChange("targetPositionId", value)}
            emptyLabel={
              sourcePosition
                ? "No compatible destination positions"
                : "Choose a source position first"
            }
          />
        ) : null}
      </div>
      {transition === "receive" || transition === "return" ? (
        <div className="space-y-3 border border-border bg-surface-muted px-4 py-4">
          <p className="text-sm font-bold">Exact stock identity</p>
          <p className="text-xs leading-5 text-muted">
            Choose a position above when it exists. To create a new position, leave it blank and
            choose the tenant's item, lot, bin, and unit; the Worker resolves the durable identity.
          </p>
          {!sourcePosition ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <IdentitySelect
                id="inventory-item"
                label="Material"
                value={form.itemId}
                options={uniqueValues(positions, "item_id", (position) => position.item_code)}
                onChange={(value) => onChange("itemId", value)}
              />
              <IdentitySelect
                id="inventory-lot"
                label="Lot"
                value={form.lotId}
                options={uniqueValues(positions, "lot_id", (position) => position.lot_code)}
                onChange={(value) => onChange("lotId", value)}
              />
              <IdentitySelect
                id="inventory-bin"
                label="Bin"
                value={form.binId}
                options={uniqueValues(
                  positions,
                  "bin_id",
                  (position) => `${position.location_code} / ${position.bin_code}`,
                )}
                onChange={(value) => onChange("binId", value)}
              />
              <IdentitySelect
                id="inventory-uom"
                label="Unit"
                value={form.uomId}
                options={uniqueValues(
                  positions,
                  "uom_id",
                  (position) => `${position.uom_code} (${position.uom_dimension})`,
                )}
                onChange={(value) => onChange("uomId", value)}
              />
            </div>
          ) : (
            <p className="text-sm text-muted">
              {positionLabel(sourcePosition)} · {sourcePosition.uom_code}
            </p>
          )}
        </div>
      ) : null}
      {sourcePosition ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Selected material" value={positionLabel(sourcePosition)} />
          <Metric
            label="Available now"
            value={`${formatQuantity(Math.max(0, available), sourcePosition.uom_scale)} ${sourcePosition.uom_code}`}
          />
          <Metric
            label="Value"
            value={formatMoney(sourcePosition.value_minor, sourcePosition.currency)}
          />
        </div>
      ) : (
        <Notice
          tone="info"
          title={transition === "reversal" ? "Original action required" : "Choose the stock first"}
        >
          {transition === "reversal"
            ? "The server will read back the original action and derive its inverse movements."
            : "Use a barcode lookup or the source button above. Receipt and return can also create an exact new position from the identity fields."}
        </Notice>
      )}
      {needsQuantity ? (
        <label className="block max-w-sm text-sm font-bold">
          {guide.quantityLabel ?? "Quantity"}
          <Input
            className="mt-2"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={needsCount ? form.countedQuantity : form.quantity}
            onChange={(event) =>
              onChange(needsCount ? "countedQuantity" : "quantity", event.target.value)
            }
          />
          <span className="mt-1 block text-xs font-normal text-muted">
            Enter the physical quantity in {sourcePosition?.uom_code ?? "the selected unit"}.
          </span>
        </label>
      ) : null}
      {needsUnitCost ? (
        <label className="block max-w-sm text-sm font-bold">
          Unit cost ({sourcePosition?.currency ?? "CAD"})
          <Input
            className="mt-2"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={form.unitCost}
            onChange={(event) => onChange("unitCost", event.target.value)}
          />
          <span className="mt-1 block text-xs font-normal text-muted">
            The form records this as{" "}
            {formatMoney(parseMoneyMinor(form.unitCost) ?? 0, sourcePosition?.currency ?? "CAD")}{" "}
            per {sourcePosition?.uom_code ?? "unit"}.
          </span>
        </label>
      ) : null}
      {needsApproval ? (
        <label className="block max-w-sm text-sm font-bold">
          {transition === "release_quarantine"
            ? "Approval reference"
            : "Approved count variance reference"}
          <Input
            className="mt-2"
            value={form.approvalId}
            onChange={(event) => onChange("approvalId", event.target.value)}
            placeholder="Approval reference"
          />
          <span className="mt-1 block text-xs font-normal text-muted">
            A count adjustment cannot be recorded without the server-approved variance reference.
          </span>
        </label>
      ) : null}
      {needsJob ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="inventory-job"
            label="Roofing job"
            value={form.jobId}
            onChange={(value) => onChange("jobId", value)}
            placeholder="Job reference"
          />
          <TextField
            id="inventory-work-package"
            label="Work package (optional)"
            value={form.workPackageId}
            onChange={(value) => onChange("workPackageId", value)}
            placeholder="Work package reference"
          />
        </div>
      ) : null}
      {needsReservation ? (
        <TextField
          id="inventory-reservation"
          label="Reservation reference"
          value={form.reservationId}
          onChange={(value) => onChange("reservationId", value)}
          placeholder="Reservation reference"
        />
      ) : null}
      {needsReceipt ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="inventory-receipt"
            label="Receipt reference"
            value={form.receiptId}
            onChange={(value) => onChange("receiptId", value)}
            placeholder="Receipt reference"
          />
          <TextField
            id="inventory-po-line"
            label="Purchase-order line"
            value={form.poLineId}
            onChange={(value) => onChange("poLineId", value)}
            placeholder="PO line reference"
          />
        </div>
      ) : null}
      {needsCountSession ? (
        <TextField
          id="inventory-count-session"
          label="Approved count session"
          value={form.countSessionId}
          onChange={(value) => onChange("countSessionId", value)}
          placeholder="Count session reference"
        />
      ) : null}
      {transition === "reversal" ? (
        <label className="block max-w-sm text-sm font-bold">
          Action being reversed
          <Input
            className="mt-2"
            value={form.reversalReference}
            onChange={(event) => onChange("reversalReference", event.target.value)}
            placeholder="Original action reference"
          />
        </label>
      ) : null}
      {sourceLayers.length > 0 &&
      ["issue_use", "transfer", "yield", "count_adjustment"].includes(transition) ? (
        <div className="border border-border bg-surface-muted px-4 py-3 text-sm">
          <p className="font-bold">Available valuation</p>
          <p className="mt-1 text-muted">
            {sourceLayers
              .slice(0, 3)
              .map(
                (layer) =>
                  `${layer.item_code} / lot ${layer.lot_code}: ${formatQuantity(layer.remaining_scaled, layer.uom_scale)} ${layer.uom_code} at ${formatMoney(layer.unit_cost_minor, sourcePosition?.currency ?? "CAD")}`,
              )
              .join(" · ")}
          </p>
        </div>
      ) : null}
      {targetPosition ? (
        <Notice tone="info" title="Destination selected">
          {positionLabel(targetPosition)} will receive the matching quantity and value.
        </Notice>
      ) : null}
    </fieldset>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label htmlFor={id} className="block max-w-sm text-sm font-bold">
      {label}
      <Input
        id={id}
        className="mt-2"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function IdentitySelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label htmlFor={id} className="block text-sm font-bold">
      {label}
      <select
        id={id}
        className="mt-2 min-h-12 w-full rounded-lg border bg-surface-raised px-3 text-base"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose {label.toLowerCase()}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function uniqueValues(
  positions: Position[],
  key: "item_id" | "lot_id" | "bin_id" | "uom_id",
  label: (position: Position) => string,
): Array<{ value: string; label: string }> {
  const values = new Map<string, string>();
  for (const position of positions) values.set(position[key], label(position));
  return [...values].map(([value, optionLabel]) => ({ value, label: optionLabel }));
}

function PositionSelect({
  id,
  label,
  value,
  positions,
  onChange,
  emptyLabel = "Choose a stock position",
}: {
  id: string;
  label: string;
  value: string;
  positions: Position[];
  onChange: (value: string) => void;
  emptyLabel?: string;
}) {
  return (
    <label className="block text-sm font-bold">
      {label}
      <select
        id={id}
        className="mt-2 min-h-14 w-full rounded-lg border bg-surface-raised px-4 text-base"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{emptyLabel}</option>
        {positions.map((position) => (
          <option key={position.position_id} value={position.position_id}>
            {positionLabel(position)}
          </option>
        ))}
      </select>
    </label>
  );
}

function EvidenceFields({
  form,
  onChange,
}: {
  form: CommandForm;
  onChange: <K extends keyof CommandForm>(field: K, value: CommandForm[K]) => void;
}) {
  return (
    <fieldset className="space-y-4 border-t border-border pt-5">
      <legend className="text-base font-bold">Action evidence</legend>
      <p className="text-sm leading-6 text-muted">
        Use the tenant-bound evidence reference and its SHA-256 digest. The server verifies the
        exact object before any inventory effect:
        r2://inventory-evidence/&lt;tenant&gt;/&lt;object&gt; or field-media://&lt;receipt-id&gt;.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-bold">
          Evidence reference
          <Input
            className="mt-2"
            value={form.evidenceRef}
            onChange={(event) => onChange("evidenceRef", event.target.value)}
            placeholder="r2://inventory-evidence/tenant/object"
          />
        </label>
        <label className="block text-sm font-bold">
          Evidence SHA-256
          <Input
            className="mt-2 font-mono"
            value={form.evidenceSha256}
            onChange={(event) => onChange("evidenceSha256", event.target.value.toLowerCase())}
            inputMode="text"
            autoComplete="off"
            placeholder="64 lowercase hexadecimal characters"
          />
        </label>
      </div>
    </fieldset>
  );
}

function InventoryCatalog({ overview }: { overview: InventoryOverviewResponse }) {
  return (
    <section aria-label="Inventory units and valuation" className="grid gap-3 sm:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Materials and units</CardTitle>
          <CardDescription>
            Server read-back of the units used by this tenant inventory.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {overview.items.length === 0 ? (
            <p className="text-sm text-muted">
              Material catalog details will appear after the first item read-back.
            </p>
          ) : (
            <ul className="space-y-3">
              {overview.items.slice(0, 8).map((item) => (
                <li
                  key={item.item_id}
                  className="border-b border-border pb-3 last:border-0 last:pb-0"
                >
                  <span className="block font-bold">{item.item_code}</span>
                  <span className="block text-sm text-muted">
                    {item.item_kind.replaceAll("_", " ")} · {item.base_uom_code} ·{" "}
                    {item.base_uom_dimension}
                  </span>
                  <span className="block text-xs text-muted">
                    Exact scale {item.base_uom_scale}; valuation {item.valuation_method}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {overview.uom_conversions.length > 0 ? (
            <div className="mt-4 border-t border-border pt-3 text-sm">
              <p className="font-bold">Exact conversions</p>
              <ul className="mt-2 space-y-1 text-muted">
                {overview.uom_conversions.slice(0, 8).map((conversion) => (
                  <li key={conversion.conversion_id}>
                    1 {conversion.from_uom_code} = {conversion.numerator}/{conversion.denominator}{" "}
                    {conversion.to_uom_code} · version {conversion.version}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Available valuation</CardTitle>
          <CardDescription>Read back from the tenant's current cost layers.</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.valuation_layers.length === 0 ? (
            <p className="text-sm text-muted">
              No available valuation layers are currently read back.
            </p>
          ) : (
            <ul className="space-y-3">
              {overview.valuation_layers.slice(0, 8).map((layer) => (
                <li
                  key={layer.layer_id}
                  className="border-b border-border pb-3 last:border-0 last:pb-0"
                >
                  <span className="block font-bold">
                    {layer.item_code} · lot {layer.lot_code}
                  </span>
                  <span className="block text-sm text-muted">
                    {formatQuantity(layer.remaining_scaled, layer.uom_scale)} {layer.uom_code}{" "}
                    available · {formatMoney(layer.unit_cost_minor, layer.currency)} per unit
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function RecentScans({ scans }: { scans: InventoryOverviewResponse["recent_scans"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent scans</CardTitle>
        <CardDescription>Read back from the tenant observation ledger.</CardDescription>
      </CardHeader>
      <CardContent>
        {scans.length === 0 ? (
          <p className="text-sm text-muted">No scans have been recorded on this tenant yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {scans.slice(0, 5).map((scan) => (
              <li key={scan.scan_id} className="py-3 first:pt-0 last:pb-0">
                <span className="block font-bold">{scan.barcode}</span>
                <span className="block text-sm text-muted">
                  {scan.scan_intent} · {scan.resolution}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function createCommandAttempt(
  transition: InventoryTransition,
  form: CommandForm,
  overview: InventoryOverviewResponse,
): CommandAttempt | null {
  const commandId = newInventoryActionKey("command");
  const key = newInventoryActionKey(transition);
  const input = buildCommandInput(commandId, key, transition, form, overview);
  return input ? { commandId, key, input } : null;
}

function buildCommandInput(
  commandId: string,
  key: string,
  transition: InventoryTransition,
  form: CommandForm,
  overview: InventoryOverviewResponse,
): InventoryCommandInput | null {
  const source = overview.positions.find(
    (position) => position.position_id === form.sourcePositionId,
  );
  const target = overview.positions.find(
    (position) => position.position_id === form.targetPositionId,
  );
  const identity = source ?? {
    item_id: form.itemId,
    lot_id: form.lotId,
    bin_id: form.binId,
    uom_id: form.uomId,
    job_custody: form.jobCustody || "-",
    uom_scale:
      overview.positions.find((position) => position.uom_id === form.uomId)?.uom_scale ??
      overview.items.find((item) => item.item_id === form.itemId)?.quantity_scale ??
      0,
    currency: "CAD",
  };
  const quantity =
    transition === "reversal" ? null : parseQuantity(form.quantity, identity.uom_scale);
  const counted =
    transition === "count_adjustment"
      ? parseQuantity(form.countedQuantity, identity.uom_scale)
      : null;
  const unitCost = parseMoneyMinor(form.unitCost);
  const evidenceRef = form.evidenceRef.trim();
  const evidenceSha256 = form.evidenceSha256.trim().toLowerCase();
  if (
    (!["receive", "return", "reversal"].includes(transition) && !source) ||
    (transition !== "reversal" && !identity.item_id) ||
    (transition !== "reversal" && !identity.lot_id) ||
    (transition !== "reversal" && !identity.bin_id) ||
    (transition !== "reversal" && !identity.uom_id) ||
    !evidenceRef ||
    !/^[0-9a-f]{64}$/.test(evidenceSha256)
  )
    return null;
  if (
    !["count_freeze", "reversal"].includes(transition) &&
    quantity === null &&
    transition !== "count_adjustment"
  )
    return null;
  if (
    ["transfer", "yield"].includes(transition) &&
    (!source || !target || target.position_id === source.position_id)
  )
    return null;
  if (["receive", "return"].includes(transition) && (unitCost === null || unitCost < 0))
    return null;
  if (
    transition === "count_adjustment" &&
    (counted === null || counted < 0 || !form.approvalId.trim() || !form.countSessionId.trim())
  )
    return null;
  if (transition === "release_quarantine" && !form.approvalId.trim()) return null;
  if (transition === "reserve" && (!form.jobId.trim() || !quantity || quantity <= 0)) return null;
  if (
    transition === "release_reservation" &&
    (!form.reservationId.trim() || !quantity || quantity <= 0)
  )
    return null;
  if (transition === "receive" && (!form.receiptId.trim() || !form.poLineId.trim())) return null;
  if (transition === "reversal" && !form.reversalReference.trim()) return null;

  const payload: Record<string, unknown> = { source: "inventory-desk" };
  if (transition === "count_freeze") payload.action = "count_freeze";
  if (transition === "reversal") payload.reversal_of = form.reversalReference.trim();
  return {
    command_id: commandId,
    idempotency_key: key,
    transition,
    authority_ref: overview.authority_ref ?? "",
    policy_ref: overview.policy_ref,
    policy_version: overview.policy_version,
    evidence_refs: [{ ref: evidenceRef, sha256: evidenceSha256 }],
    approval_id: form.approvalId.trim() || null,
    source_position_id: form.sourcePositionId || null,
    target_position_id: form.targetPositionId || null,
    item_id: identity.item_id || null,
    lot_id: identity.lot_id || null,
    bin_id: identity.bin_id || null,
    uom_id: identity.uom_id || null,
    job_custody: identity.job_custody || null,
    quantity_scaled: quantity,
    counted_quantity_scaled: counted,
    unit_cost_minor: unitCost,
    currency: source?.currency ?? identity.currency,
    job_id: form.jobId.trim() || null,
    work_package_id: form.workPackageId.trim() || null,
    reservation_id: form.reservationId.trim() || null,
    receipt_id: form.receiptId.trim() || null,
    po_line_id: form.poLineId.trim() || null,
    count_session_id: form.countSessionId.trim() || null,
    reversal_reference: form.reversalReference.trim() || null,
    condition_status: form.conditionStatus,
    payload,
  };
}

function parseQuantity(value: string, scale: number): number | null {
  const normalized = value.trim();
  const match = normalized.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > scale) return null;
  const scaledText = `${whole}${fraction.padEnd(scale, "0")}`;
  const number = Number(scaledText);
  return Number.isSafeInteger(number) ? number : null;
}

function parseMoneyMinor(value: string): number | null {
  const normalized = value.trim();
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const number = Number(`${match[1]}${(match[2] ?? "").padEnd(2, "0")}`);
  return Number.isSafeInteger(number) ? number : null;
}

function actionStateFromError(
  error: unknown,
  uncertainMessage: string,
): Exclude<ActionState, { phase: "idle" | "pending" }> {
  if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
    return { phase: "uncertain", message: uncertainMessage };
  }
  return {
    phase: "rejected",
    message:
      error instanceof ApiError
        ? `Request refused: ${humanizeCode(error.code)}.`
        : "Request refused before inventory changed.",
  };
}

function humanizeCode(code: string): string {
  return code.replace(/^inventory_/, "").replaceAll("_", " ");
}

function positionLabel(position: Position): string {
  return `${position.item_code} · lot ${position.lot_code} · ${position.location_name} / bin ${position.bin_code}`;
}

function formatQuantity(value: number, scale: number): string {
  const divisor = 10 ** scale;
  return (value / divisor).toLocaleString(undefined, { maximumFractionDigits: scale });
}

function formatMoney(valueMinor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(valueMinor / 100);
}

function summaryQuantity(
  overview: InventoryOverviewResponse,
  field: "quantity_scaled" | "reserved_scaled" | "quarantined_scaled",
): string {
  if (overview.summary.quantity_by_uom.length !== 1) return "See units below";
  const group = overview.summary.quantity_by_uom[0];
  return formatQuantity(group?.[field] ?? 0, group?.uom_scale ?? 0);
}

function summaryValue(overview: InventoryOverviewResponse, fallbackCurrency: string): string {
  if (overview.summary.value_by_currency.length !== 1) return "See currencies below";
  const group = overview.summary.value_by_currency[0];
  return formatMoney(group?.value_minor ?? 0, group?.currency ?? fallbackCurrency);
}

function SummaryGroups({ overview }: { overview: InventoryOverviewResponse }) {
  return (
    <section aria-label="Grouped inventory totals" className="grid gap-3 sm:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Stock by unit</CardTitle>
          <CardDescription>
            Different units are kept separate; no mixed-scale total is shown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {overview.summary.quantity_by_uom.length === 0 ? (
            <p className="text-sm text-muted">No stock quantities yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {overview.summary.quantity_by_uom.map((group) => (
                <li key={group.uom_id} className="flex items-center justify-between gap-3">
                  <span className="font-bold">{group.uom_code}</span>
                  <span className="tabular-nums">
                    {formatQuantity(group.quantity_scaled, group.uom_scale)} on hand ·{" "}
                    {formatQuantity(group.reserved_scaled, group.uom_scale)} reserved ·{" "}
                    {formatQuantity(group.quarantined_scaled, group.uom_scale)} quarantined
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Value by currency</CardTitle>
          <CardDescription>
            Valuation stays grouped by the currency recorded by the ledger.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {overview.summary.value_by_currency.length === 0 ? (
            <p className="text-sm text-muted">No valuation yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {overview.summary.value_by_currency.map((group) => (
                <li key={group.currency} className="flex items-center justify-between gap-3">
                  <span className="font-bold">{group.currency}</span>
                  <span className="tabular-nums">
                    {formatMoney(group.value_minor, group.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function LookupResult({ result }: { result: NonNullable<InventoryLookupResponse["result"]> }) {
  return (
    <span>
      {result.entity_type} ·{" "}
      {result.item_code ?? result.lot_code ?? result.bin_code ?? result.barcode}
      {result.lot_code ? ` · lot ${result.lot_code}` : ""}
      {result.bin_code ? ` · bin ${result.bin_code}` : ""}
      {result.location_code ? ` · ${result.location_code}` : ""}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border bg-surface px-3 py-3">
      <dt className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd className="mt-1 text-sm font-bold">{value}</dd>
    </div>
  );
}

function IdentityTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="border border-border bg-surface px-4 py-4">
      <dt className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd className="mt-1 break-all font-bold">{value}</dd>
      <dd className="mt-1 text-sm text-muted">{detail}</dd>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number | string; tone?: "danger" }) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <dt className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd
        className={`mt-1 text-2xl font-black tabular-nums ${tone === "danger" ? "text-danger" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}
