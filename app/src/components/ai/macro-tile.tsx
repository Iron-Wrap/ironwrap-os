import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Status } from "../ui/status";
import { ProposedValue } from "./proposed";
import { type } from "./type";
import { formatMoney, isMoney, type Money } from "./words";

/**
 * One number the owner steers by (Board 6, AI/Macro tile): the label, the exact value, what
 * changed and where the number came from. A number IronWrap cannot read is "Not known yet" in its
 * dashed edge, never 0. Money is the text face with tabular figures and every minor digit; a
 * forecast is `proposed` and says so.
 */
export function MacroTile({
  label,
  value,
  unknown = "Not known yet",
  proposed,
  change,
  source,
  className,
}: {
  label: string;
  /** `null` when nobody has the number yet. */
  value: Money | ReactNode | null;
  unknown?: string;
  proposed?: boolean;
  change?: ReactNode;
  source?: ReactNode;
  className?: string;
}) {
  const known = value !== null && value !== undefined;
  const exact = isMoney(value) ? formatMoney(value) : value;
  return (
    <dl
      data-known={known ? "true" : "false"}
      className={cn(
        "grid content-start gap-1 rounded-[var(--radius-card)] border border-line-hairline bg-surface-paper px-4 py-3",
        className,
      )}
    >
      <dt className={cn(type.caption, "font-semibold text-text-secondary")}>{label}</dt>
      <dd className={cn(type.title, type.money, "font-semibold text-text-primary")}>
        {!known ? (
          <Status kind="unknown">{unknown}</Status>
        ) : proposed ? (
          <ProposedValue kind="inline" value={exact} />
        ) : (
          exact
        )}
      </dd>
      {change ? <dd className={cn(type.caption, "text-text-primary")}>{change}</dd> : null}
      {source ? <dd className={cn(type.caption, "text-text-tertiary")}>{source}</dd> : null}
    </dl>
  );
}
