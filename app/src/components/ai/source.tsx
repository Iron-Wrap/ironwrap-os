import { Camera, FileText, ListTree, MessageSquare, Ruler, type LucideIcon } from "lucide-react";

import { cn } from "../../lib/cn";
import { type } from "./type";

export type SourceKind = "record" | "document" | "message" | "photo" | "reading";

const GLYPH: Record<SourceKind, LucideIcon> = {
  record: ListTree,
  document: FileText,
  message: MessageSquare,
  photo: Camera,
  reading: Ruler,
};

const CHECK = {
  stale: "Out of date",
  unverifiable: "Could not be checked",
} as const;

export interface SourceProps {
  kind: SourceKind;
  /** The plain label first: "Job", "Measurement report", "Email from Linda Chu". */
  label: string;
  /** The code after it, in mono: "IW-1036", "p. 3". */
  code?: string;
  /** Opens the source; the chip is then a link named "Source: Job IW-1036". */
  href?: string;
  /** The fact could not be relied on: out of date, or its source could not be checked. */
  check?: keyof typeof CHECK;
}

/**
 * Where a fact came from (Board 6, AI/Source chip): a glyph, the plain label, the code in mono
 * after it. It sits under every fact an agent states.
 */
export function SourceChip({ kind, label, code, href, check }: SourceProps) {
  const Glyph = GLYPH[kind];
  const content = (
    <>
      <Glyph aria-hidden="true" className="size-[1.15em] shrink-0 text-text-secondary" />
      <span className="font-semibold text-text-primary">{label}</span>
      {code ? <code className={cn(type.captionMono, "text-text-secondary")}>{code}</code> : null}
      {check ? <span className="text-text-secondary">· {CHECK[check]}</span> : null}
    </>
  );
  const chip = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-[var(--radius-chip)] bg-surface-rail px-2 py-1",
    type.caption,
  );
  if (href)
    return (
      <a
        href={href}
        data-source={kind}
        aria-label={`Source: ${label}${code ? ` ${code}` : ""}${check ? `, ${CHECK[check]}` : ""}`}
        className={cn(
          chip,
          "min-h-[var(--target-min)] no-underline hover:bg-surface-selected active:bg-surface-pressed",
        )}
      >
        {content}
      </a>
    );
  return (
    <span data-source={kind} className={chip}>
      {content}
    </span>
  );
}

/** The sources of one fact, in a list. */
export function SourceList({
  sources,
  label = "Where this came from",
  className,
}: {
  sources: readonly SourceProps[];
  label?: string;
  className?: string;
}) {
  if (!sources.length) return null;
  return (
    <ul aria-label={label} className={cn("flex flex-wrap gap-1.5", className)}>
      {sources.map((source) => (
        <li key={`${source.kind}-${source.label}-${source.code ?? ""}`} className="max-w-full">
          <SourceChip {...source} />
        </li>
      ))}
    </ul>
  );
}
