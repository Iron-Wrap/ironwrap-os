import { Slot, Slottable } from "@radix-ui/react-slot";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

export type RefKind =
  | "job"
  | "lead"
  | "asset"
  | "case"
  | "supply"
  | "record"
  | "coil"
  | "lot"
  | "survey"
  | "cutlist"
  | "change_order"
  | "quality_problem"
  | "person";

const spokenKind: Record<RefKind, string> = {
  job: "Job",
  lead: "Lead",
  asset: "Vehicle or equipment",
  case: "Service call",
  supply: "Supply order",
  record: "Record",
  coil: "Coil",
  lot: "Lot",
  survey: "Survey reading",
  cutlist: "Cut list",
  change_order: "Change order",
  quality_problem: "Quality problem",
  person: "Person",
};

/**
 * The stamped reference tag every record carries: galvanized metal for jobs and records,
 * manila paper for leads, dark plate for vehicles and equipment. A code never stands alone
 * (design/ZERO-LEARNING-GATE.md, Z2): the plain kind word is printed first, so the tag reads
 * "Job IW-1001" on screen and is announced the same way.
 *
 * Pass `asChild` with a single link child to make the tag navigable; the kind word is placed
 * before the link's own text.
 */
export function RefTag({
  id,
  kind = "job",
  size,
  asChild,
  children,
  className,
}: {
  id: string;
  kind?: RefKind;
  size?: "large";
  asChild?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const label = `${spokenKind[kind]} ${id}`;
  const shared = {
    className: cn("ref-tag", className),
    "data-kind": kind,
    "data-size": size,
    "data-interactive": asChild || undefined,
    "aria-label": label,
  };
  if (asChild)
    return (
      <Slot {...shared}>
        {spokenKind[kind]} <Slottable>{children}</Slottable>
      </Slot>
    );
  return (
    <span role="img" {...shared}>
      {label}
    </span>
  );
}
