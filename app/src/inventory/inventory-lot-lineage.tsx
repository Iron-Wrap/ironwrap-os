import { useState } from "react";

import { Button } from "../components/ui/button";
import { RefTag } from "../components/ui/ref-tag";
import { Status } from "../components/ui/status";
import { roleCanAccess, type AppRole } from "../lib/roles";
import type { InventoryOverviewPosition, InventoryOverviewResponse } from "./inventory-contracts";

export function InventoryLotLineage({
  overview,
  role,
  locale,
  onChoose,
}: {
  overview: InventoryOverviewResponse;
  role: AppRole;
  locale: string;
  onChoose: (position: InventoryOverviewPosition) => void;
}) {
  const lots = [
    ...new Map(overview.positions.map((position) => [position.lot_id, position])).values(),
  ];
  const [selectedId, setSelectedId] = useState<string>();
  const selected = lots.find((lot) => lot.lot_id === selectedId) ?? lots[0];
  const positions = overview.positions.filter((position) => position.lot_id === selected?.lot_id);
  const parent = lots.find((lot) => lot.lot_id === selected?.parent_lot_id);
  const children = lots.filter((lot) => lot.parent_lot_id === selected?.lot_id);
  const siblings = selected?.parent_lot_id
    ? lots.filter(
        (lot) => lot.parent_lot_id === selected.parent_lot_id && lot.lot_id !== selected.lot_id,
      )
    : [];
  const layers = overview.valuation_layers.filter((layer) => layer.lot_id === selected?.lot_id);

  return (
    <section
      aria-labelledby="inventory-lineage-heading"
      className="grid min-w-0 grid-cols-1 gap-4 border-y border-border py-6 [overflow-wrap:anywhere]"
    >
      <h2 id="inventory-lineage-heading" className="text-xl font-semibold">
        Lot lineage and custody
      </h2>
      <p className="text-sm leading-6 text-muted">
        Follow the parent, output lots, job custody, quarantine, and recorded value in the loaded
        stock positions.
      </p>
      {selected ? (
        <>
          <label className="grid min-w-0 gap-2 text-sm font-semibold">
            Lot to trace
            <select
              className="environment-control min-h-16 w-full min-w-0 rounded-md border border-border-control bg-surface px-4 text-base"
              value={selected.lot_id}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {lots.map((lot) => (
                <option key={lot.lot_id} value={lot.lot_id}>
                  {lot.lot_code} · {lot.lot_kind.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <RefTag kind="lot" id={selected.lot_code} />
            <Status kind={selected.lot_status === "quarantined" ? "stopped" : "neutral"}>
              {selected.lot_status.replaceAll("_", " ")}
            </Status>
            {positions.some((position) => position.quarantined_scaled > 0) ? (
              <Status kind="stopped">Quarantined stock in this lot</Status>
            ) : null}
            <span className="text-sm">{selected.lot_kind.replaceAll("_", " ")}</span>
          </div>
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="font-semibold text-muted">Parent lot</dt>
              <dd className="mt-1">
                {parent ? (
                  <Button
                    variant="quiet"
                    size="field"
                    className="max-w-full"
                    onClick={() => setSelectedId(parent.lot_id)}
                  >
                    Trace {parent.lot_code}
                  </Button>
                ) : selected.parent_lot_id ? (
                  <span className="break-all">
                    {selected.parent_lot_id} · parent position not loaded
                  </span>
                ) : (
                  "No parent recorded"
                )}
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-muted">Output lots loaded</dt>
              <dd>
                {children.length ? (
                  <ul>
                    {children.map((lot) => (
                      <li key={lot.lot_id}>
                        <Button
                          variant="quiet"
                          size="field"
                          className="max-w-full"
                          onClick={() => setSelectedId(lot.lot_id)}
                        >
                          Trace {lot.lot_code} · {lot.lot_kind}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  "None in loaded positions"
                )}
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-muted">Sibling lots loaded</dt>
              <dd>
                {siblings.length ? (
                  <ul>
                    {siblings.map((lot) => (
                      <li key={lot.lot_id}>
                        <Button
                          variant="quiet"
                          size="field"
                          className="max-w-full"
                          onClick={() => setSelectedId(lot.lot_id)}
                        >
                          Trace {lot.lot_code}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  "None in loaded positions"
                )}
              </dd>
            </div>
          </dl>
          <ul className="grid divide-y divide-border" aria-label="Selected lot custody and value">
            {positions.map((position) => (
              <li
                key={position.position_id}
                className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="grid min-w-0 gap-3">
                  <p className="font-semibold">
                    {position.location_name} · bin {position.bin_code}
                  </p>
                  <dl className="grid gap-x-5 gap-y-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted">Custody</dt>
                      <dd>
                        {position.job_custody === "-" ? (
                          "Warehouse stock"
                        ) : roleCanAccess(role, "jobHistory") ? (
                          <a
                            className="inline-flex min-h-16 items-center break-all font-mono underline underline-offset-4"
                            href={`/jobs/${encodeURIComponent(position.job_custody)}/history`}
                          >
                            {position.job_custody}
                          </a>
                        ) : (
                          <span className="break-all font-mono">{position.job_custody}</span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Recorded value</dt>
                      <dd className="font-mono">
                        {money(position.value_minor, position.currency, locale)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">On hand / reserved</dt>
                      <dd className="font-mono">
                        {quantity(position.quantity_scaled, position.uom_scale)} /{" "}
                        {quantity(position.reserved_scaled, position.uom_scale)} {position.uom_code}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Quarantined</dt>
                      <dd className="font-mono">
                        {quantity(position.quarantined_scaled, position.uom_scale)}{" "}
                        {position.uom_code}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Saved position version</dt>
                      <dd>v{position.version}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-muted">Last movement receipt</dt>
                      <dd className="break-all font-mono">{position.last_event_id}</dd>
                    </div>
                  </dl>
                </div>
                <Button variant="secondary" size="field" onClick={() => onChoose(position)}>
                  Choose this stock
                </Button>
              </li>
            ))}
          </ul>
          <details className="border-t border-border pt-2">
            <summary className="flex min-h-16 cursor-pointer items-center font-semibold">
              Valuation sources for this lot
            </summary>
            {layers.length ? (
              <ul className="grid gap-3 py-3" aria-label="Selected lot valuation layers">
                {layers.map((layer) => (
                  <li className="text-sm [overflow-wrap:anywhere]" key={layer.layer_id}>
                    <span className="font-semibold">
                      {layer.item_code} · {layer.layer_kind}
                    </span>
                    <p>
                      {quantity(layer.remaining_scaled, layer.uom_scale)} {layer.uom_code} remaining
                      · original layer value {money(layer.value_minor, layer.currency, locale)} ·{" "}
                      {layer.method}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-3 text-sm text-muted">
                No valuation layers for this lot were returned.
              </p>
            )}
          </details>
        </>
      ) : (
        <p className="text-sm text-muted">No lot positions were returned to trace.</p>
      )}
      <p className="text-sm leading-6 text-muted">
        This read does not contain NCR findings or disposition, original yield totals, or rework and
        scrap cost. Current remnant or scrap quantities are stock, not a yield-loss calculation.
      </p>
    </section>
  );
}

function quantity(value: number, scale: number) {
  return (value / 10 ** scale).toFixed(scale);
}
function money(value: number, currency: string, locale: string) {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "code",
    }).format(value / 100);
  } catch {
    return `${currency} ${(value / 100).toFixed(2)}`;
  }
}
