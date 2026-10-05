import type { ReactNode } from "react";

import { ApiError } from "../../lib/api";
import { cn } from "../../lib/cn";

/**
 * The one place a screen may show system facts: IDs, versions, raw states, digests. The
 * zero-learning gate (`design/ZERO-LEARNING-GATE.md`, Z2) allows internal words only inside an
 * explicit details disclosure, so every such disclosure carries the same word and the same 48px
 * summary target, and `scripts/plain-language.family.test.ts` exempts exactly this subtree
 * (`data-system-details`). A bare `<details>` exempts nothing.
 */
export function SystemDetails({
  children,
  className,
  summaryClassName,
}: {
  children: ReactNode;
  className?: string;
  /** Inset only (padding), so the summary lines up with a bordered or padded container. */
  summaryClassName?: string;
}) {
  return (
    <details data-system-details="" className={className}>
      <summary className={cn("min-h-12 cursor-pointer py-3.5 text-sm font-bold", summaryClassName)}>
        System details
      </summary>
      {children}
    </details>
  );
}

/**
 * The code and request reference of a refused request, for whoever looks into it. The screen
 * itself says what happened in plain words (`messageFor`); this keeps the rest one tap away.
 */
export function ErrorSystemDetails({ error }: { error: unknown }) {
  if (!(error instanceof ApiError)) return null;
  return (
    <SystemDetails className="mt-2">
      <p className="break-words text-sm">
        Error code <span className="font-mono">{error.code}</span>
      </p>
      {error.requestId ? (
        <p className="break-words text-sm">
          Request ID <span className="font-mono">{error.requestId}</span>
        </p>
      ) : null}
    </SystemDetails>
  );
}
