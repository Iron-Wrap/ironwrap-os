import type { ReactNode } from "react";

export interface TimelineEntry {
  id: string;
  actor: ReactNode;
  text: ReactNode;
  /** Already formatted for the reader, e.g. "Jul 10, 10:04 a.m." */
  when: ReactNode;
  /** Machine-readable instant for `<time dateTime>`. */
  at?: string;
}

/** An activity trail in the order given; the caller decides newest-first or oldest-first. */
export function Timeline({ entries, label }: { entries: readonly TimelineEntry[]; label: string }) {
  return (
    <ol role="list" aria-label={label} className="grid text-sm">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className="relative grid grid-cols-[0.75rem_minmax(0,1fr)] gap-3 pb-3.5 before:mt-1.5 before:ml-0.5 before:size-[7px] before:rounded-full before:bg-border-strong before:content-[''] after:absolute after:top-4 after:bottom-0.5 after:left-[5px] after:w-px after:bg-border after:content-[''] last:after:hidden"
        >
          <div className="min-w-0">
            <div>
              <strong className="font-semibold">{entry.actor}</strong> · {entry.text}
            </div>
            <time dateTime={entry.at} className="text-[0.8125rem] text-faint">
              {entry.when}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}
