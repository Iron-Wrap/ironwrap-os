import { Slot } from "@radix-ui/react-slot";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

export type RefKind = "job" | "lead" | "asset" | "case" | "supply" | "record";

const spokenKind: Record<RefKind, string> = {
  job: "Job",
  lead: "Lead",
  asset: "Vehicle or equipment",
  case: "Service case",
  supply: "Supply order",
  record: "Record",
};

/**
 * The stamped reference tag every record carries: galvanized metal for jobs and records,
 * manila paper for leads, dark plate for vehicles and equipment. The identifier is set in
 * Martian Mono and announced with its kind, so "IW-1001" is read as "Job IW-1001".
 *
 * Pass `asChild` with a single link child to make the tag navigable.
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
  const shared = {
    className: cn("ref-tag", className),
    "data-kind": kind,
    "data-size": size,
    "aria-label": `${spokenKind[kind]} ${id}`,
  };
  if (asChild) return <Slot {...shared}>{children}</Slot>;
  return (
    <span role="img" {...shared}>
      {id}
    </span>
  );
}
