import { Check, Palette } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { recordCustomerPortalDecision } from "./portal-api";
import type { CustomerPortalOptionPackage, CustomerPortalResponse } from "./portal-contracts";

type SelectionState =
  | { kind: "idle" }
  | { kind: "pending"; id: string }
  | { kind: "chosen"; id: string; label: string }
  | { kind: "error"; id: string };

/**
 * Step 3 of the core workflow on an IronWrap-owned surface: compare the curated Option Packages
 * the office approved for this job, and say which one you want.
 *
 * Stacked single-column cards at every width rather than a desktop comparison table. Contractors
 * and their customers read this on a phone, and one layout that works at 393px and scales up
 * beats two layouts where the mobile one is the afterthought. The whole section is silent when no
 * Approved package exists, so a job that never got options never grows an empty shell.
 */
export function MaterialComparisonSection({
  model,
  portalToken,
}: {
  model: CustomerPortalResponse;
  portalToken?: string;
}) {
  const [state, setState] = useState<SelectionState>({ kind: "idle" });
  const selectable = Boolean(portalToken) && model.material_decision_available;

  async function choose(option: CustomerPortalOptionPackage) {
    if (!portalToken || state.kind === "pending") return;
    setState({ kind: "pending", id: option.id });
    try {
      // One key per option per attempt: retrying the same card is a retry, switching cards is a
      // new decision. Both are what the customer meant.
      await recordCustomerPortalDecision({
        token: portalToken,
        optionPackageId: option.id,
        idempotencyKey: `portal-decision:${option.id}:${crypto.randomUUID()}`,
      });
      setState({
        kind: "chosen",
        id: option.id,
        label: optionTitle(option),
      });
    } catch {
      setState({ kind: "error", id: option.id });
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <Palette className="mt-0.5 size-5 text-info" aria-hidden="true" />
          <div>
            <CardTitle>Materials and colours</CardTitle>
            <CardDescription>
              {selectable
                ? "See your choices. Pick the one you like."
                : "These are the choices for your job."}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="space-y-4">
          {model.option_packages.map((option) => (
            <li key={option.id}>
              <OptionCard
                option={option}
                selectable={selectable}
                state={state}
                onChoose={() => void choose(option)}
              />
            </li>
          ))}
        </ul>
        {state.kind === "chosen" ? (
          <p className="mt-5 text-sm font-semibold leading-6 text-ok" role="status">
            You picked {state.label}. Your project team will call you. This does not order or bill
            anything.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function OptionCard({
  option,
  selectable,
  state,
  onChoose,
}: {
  option: CustomerPortalOptionPackage;
  selectable: boolean;
  state: SelectionState;
  onChoose: () => void;
}) {
  const chosen = state.kind === "chosen" && state.id === option.id;
  const pending = state.kind === "pending" && state.id === option.id;
  const failed = state.kind === "error" && state.id === option.id;
  const details = optionDetails(option.options);
  const title = optionTitle(option);
  return (
    <section
      aria-label={title}
      className={`rounded-xl border p-4 ${chosen ? "border-ok/40 bg-ok-soft shadow-[inset_0_2px_0_var(--ok)]" : "border-border"}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-lg font-black tracking-[-0.02em]">{title}</h3>
        {option.tier ? (
          <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-extrabold text-muted">
            {option.tier}
          </span>
        ) : null}
      </div>
      {option.material_system ? (
        <p className="mt-2 text-sm leading-6 text-muted">{option.material_system}</p>
      ) : null}
      {option.price_delta !== null ? (
        <p className="mt-3 text-base font-bold">
          {formatDelta(option.price_delta, option.currency)}
        </p>
      ) : null}
      {details.length > 0 ? (
        <dl className="mt-3 space-y-1">
          {details.map((detail) => (
            <div key={detail.label} className="flex flex-wrap gap-x-2 text-sm leading-6">
              <dt className="font-bold">{detail.label}:</dt>
              <dd className="text-muted">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {option.warranty_summary ? (
        <p className="mt-3 text-sm leading-6 text-muted">{option.warranty_summary}</p>
      ) : null}
      {selectable ? (
        <>
          <Button
            className="mt-4"
            fullWidth
            type="button"
            variant={chosen ? "outline" : "default"}
            disabled={pending || chosen}
            busy={pending}
            onClick={onChoose}
          >
            {chosen ? (
              <>
                <Check aria-hidden="true" />
                Chosen
              </>
            ) : pending ? (
              "Saving choice…"
            ) : (
              "Pick this option"
            )}
          </Button>
          {failed ? (
            <p className="mt-3 text-sm font-semibold text-danger" role="alert">
              We could not save your choice. Try again.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function optionTitle(option: CustomerPortalOptionPackage): string {
  return option.package_name ?? option.tier ?? "Option";
}

/**
 * `options_json` is office-authored and its shape is not yet standardised (an open question on the
 * ELEC-89 design). Project only scalar members as label/value text — never markup, never a nested
 * object walked into the DOM — so an unfamiliar payload degrades to fewer rows instead of a crash.
 */
function optionDetails(
  options: Record<string, unknown> | null,
): Array<{ label: string; value: string }> {
  if (!options) return [];
  return Object.entries(options)
    .filter(
      ([, value]) =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean",
    )
    .slice(0, 8)
    .map(([key, value]) => ({ label: humanizeKey(key), value: String(value) }))
    .filter((detail) => detail.value.length > 0 && detail.value.length <= 160);
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

function formatDelta(value: number, currency: string | null): string {
  if (value === 0) return "In your current price";
  const formatted = formatMoney(Math.abs(value), currency);
  return value > 0 ? `Costs ${formatted} more` : `Costs ${formatted} less`;
}

function formatMoney(value: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: currency ?? "CAD",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency ?? "CAD"} ${value.toLocaleString("en-CA")}`;
  }
}
