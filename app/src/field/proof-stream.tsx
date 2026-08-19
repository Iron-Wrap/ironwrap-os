import { useMemo, useState, type UIEvent } from "react";

import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/state-panel";
import { dateTimeFormatter } from "../lib/intl-cache";
import type { ProofStreamItem } from "./field-contracts";

const ROW_HEIGHT = 116;
const VIEWPORT_HEIGHT = 520;
const OVERSCAN = 5;

export function ProofStream({
  items,
  hasMore,
  loadingMore,
  onLoadMore,
  locale,
  timeZone,
}: {
  items: ProofStreamItem[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  locale?: string;
  timeZone?: string;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const window = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const count = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
    return { start, end: Math.min(items.length, start + count) };
  }, [items.length, scrollTop]);

  if (items.length === 0) {
    return (
      <EmptyState
        title="No verified proof yet"
        message="Captured field work will appear here only after the exact device action is verified in raw storage and Frappe."
      />
    );
  }

  function trackScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    setScrollTop(target.scrollTop);
    if (
      hasMore &&
      !loadingMore &&
      target.scrollTop + target.clientHeight >= target.scrollHeight - ROW_HEIGHT * 2
    ) {
      onLoadMore();
    }
  }

  return (
    <div className="space-y-4">
      <div
        className="relative overflow-y-auto rounded-xl border bg-surface"
        style={{ height: Math.min(VIEWPORT_HEIGHT, items.length * ROW_HEIGHT) }}
        onScroll={trackScroll}
        role="feed"
        aria-label="Job proof stream"
        aria-busy={loadingMore}
      >
        <div className="relative" style={{ height: items.length * ROW_HEIGHT }}>
          {items.slice(window.start, window.end).map((item, index) => {
            const absoluteIndex = window.start + index;
            return (
              <article
                key={item.id}
                className="absolute inset-x-0 border-b px-4 py-4 sm:px-5"
                style={{
                  height: ROW_HEIGHT,
                  transform: `translateY(${absoluteIndex * ROW_HEIGHT}px)`,
                }}
                aria-posinset={absoluteIndex + 1}
                aria-setsize={items.length}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">
                      {item.proof_slot ?? item.type ?? "Field proof"}
                    </p>
                    <p className="mt-1 line-clamp-2 font-bold">
                      {item.summary ?? item.type ?? "Verified field record"}
                    </p>
                  </div>
                  <span
                    className={
                      item.blocker ? "text-xs font-bold text-danger" : "text-xs font-bold text-ok"
                    }
                  >
                    {item.blocker ? "Blocker" : (item.sync_state ?? "Recorded")}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted">
                  {formatTime(item.occurred_at, locale, timeZone)} ·{" "}
                  {item.source ?? "Source unavailable"} ·{" "}
                  {item.customer_safe ? "Customer-safe" : "Internal"}
                </p>
              </article>
            );
          })}
        </div>
      </div>
      {hasMore ? (
        <Button
          type="button"
          variant="outline"
          size="field"
          fullWidth
          busy={loadingMore}
          onClick={onLoadMore}
        >
          Load older proof
        </Button>
      ) : (
        <p className="text-center text-sm text-muted" role="status">
          All loaded proof is shown.
        </p>
      )}
    </div>
  );
}

function formatTime(value: string | null, locale?: string, timeZone?: string): string {
  if (!value || Number.isNaN(Date.parse(value))) return "Time unavailable";
  try {
    return dateTimeFormatter(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  } catch {
    return dateTimeFormatter(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );
  }
}
