import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, LoaderCircle, Search, WifiOff, X } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { useOnlineStatus } from "../hooks/use-online-status";
import { loadOperatorSearch } from "../search/operator-search-api";
import type {
  OperatorSearchReadModel,
  OperatorSearchResult,
} from "../search/operator-search-contracts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface OperatorSearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface FlattenedResult {
  result: OperatorSearchResult;
}

export function OperatorSearchPaletteTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label="Open search (Command or Control K)"
      aria-keyshortcuts="Control+K Meta+K"
      title="Search (⌘K / Ctrl+K)"
      onClick={onOpen}
    >
      <Search aria-hidden="true" />
    </Button>
  );
}

export function OperatorSearchPalette({ open, onOpenChange }: OperatorSearchPaletteProps) {
  const session = useSession();
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const offline = !online || isOfflineSession(session);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [queryText, setQueryText] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const titleId = useId();
  const inputId = useId();
  const listId = useId();
  const statusId = useId();
  const normalizedQuery = queryText.trim();
  const permissionScope = JSON.stringify([...session.permissions].sort());

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      if (isTextEntry(event.target)) return;
      event.preventDefault();
      onOpenChange(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setDebouncedQuery(normalizedQuery), 180);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery, open]);

  const canSearch =
    open && !offline && normalizedQuery.length >= 2 && debouncedQuery === normalizedQuery;
  const search = useQuery({
    queryKey: [
      "operator-search",
      session.tenant.id,
      session.user.id,
      session.user.role,
      permissionScope,
      debouncedQuery,
    ],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      loadOperatorSearch(session, debouncedQuery, signal),
    enabled: canSearch,
    retry: false,
    gcTime: 0,
  });

  const model = canSearch && !search.isError ? search.data : undefined;
  const flattenedResults = useMemo<FlattenedResult[]>(
    () => model?.groups.flatMap((group) => group.results.map((result) => ({ result }))) ?? [],
    [model],
  );
  const hasResults = model?.outcome === "results" && flattenedResults.length > 0 && !search.isError;
  const visibleGroups =
    hasResults && model ? model.groups.filter((group) => group.results.length > 0) : [];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!open) {
      if (dialog.open) dialog.close();
      const previousFocus = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previousFocus?.isConnected) previousFocus.focus();
      return;
    }

    if (!previousFocusRef.current && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute("open", "");
        }
      } else {
        dialog.setAttribute("open", "");
      }
    }
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  function closePalette() {
    setQueryText("");
    setDebouncedQuery("");
    setActiveIndex(-1);
    onOpenChange(false);
  }

  function activate(result: OperatorSearchResult) {
    closePalette();
    void navigate({ to: result.href as never });
  }

  function handleQueryChange(value: string) {
    setQueryText(value);
    setActiveIndex(-1);
  }

  const resultCount = hasResults ? flattenedResults.length : 0;
  const selectedIndex =
    resultCount === 0 ? -1 : activeIndex < 0 ? 0 : Math.min(activeIndex, resultCount - 1);

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      if (resultCount === 0) return;
      event.preventDefault();
      setActiveIndex((selectedIndex + 1) % resultCount);
    } else if (event.key === "ArrowUp") {
      if (resultCount === 0) return;
      event.preventDefault();
      setActiveIndex(selectedIndex <= 0 ? resultCount - 1 : selectedIndex - 1);
    } else if (event.key === "Enter") {
      const active = flattenedResults[selectedIndex];
      if (!active) return;
      event.preventDefault();
      activate(active.result);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    }
  }

  const activeDescendant =
    hasResults && selectedIndex >= 0 && flattenedResults[selectedIndex]
      ? resultId(listId, flattenedResults[selectedIndex]!.result.id, selectedIndex)
      : undefined;
  const status = statusMessage({
    offline,
    normalizedQuery,
    debouncedQuery,
    canSearch,
    isPending: search.isPending || search.isFetching,
    model,
    hasResults,
    error: search.error,
  });

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={statusId}
      aria-modal="true"
      /* bottom-auto and mx-auto, not m-auto: this is a native <dialog>, and the
         UA sheet sets inset-block-end: 0 on an open one. With `m-auto` the
         block margins resolved to ~388px each and centred the box, defeating
         the top-4 written right beside it - so the input sat at half screen
         height and drifted upward as results arrived, under the cursor of
         whoever was typing. */
      className="fixed inset-x-2 bottom-auto top-4 mx-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-1rem)] max-w-2xl overflow-hidden rounded-2xl border border-border bg-surface p-0 text-foreground shadow-[0_24px_80px_oklch(0_0_0/0.28)] backdrop:bg-foreground/40 sm:top-[12vh] sm:w-[calc(100%-2rem)]"
      onCancel={(event) => {
        event.preventDefault();
        closePalette();
      }}
      onClose={() => {
        if (open) onOpenChange(false);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closePalette();
      }}
    >
      <div className="flex min-h-14 items-center gap-2 border-b border-border px-3 sm:px-4">
        <Search className="size-5 shrink-0 text-muted" aria-hidden="true" />
        <h2 id={titleId} className="sr-only">
          Search IronWrap OS
        </h2>
        <label htmlFor={inputId} className="sr-only">
          Search jobs, leads, customers, or workspaces
        </label>
        <Input
          ref={inputRef}
          id={inputId}
          role="combobox"
          value={queryText}
          onChange={(event) => handleQueryChange(event.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="Search jobs, leads, customers, or workspaces"
          autoComplete="off"
          maxLength={120}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-controls={hasResults ? listId : undefined}
          aria-expanded={hasResults}
          aria-activedescendant={activeDescendant}
          className="min-h-12 border-0 bg-transparent px-1 shadow-none"
        />
        {queryText ? (
          <button
            type="button"
            className="grid size-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-muted hover:text-foreground focus-visible:outline-focus"
            aria-label="Clear search"
            onClick={() => {
              handleQueryChange("");
              inputRef.current?.focus();
            }}
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        ) : null}
        {/* Not a second X. Clear and close sat side by side as identical
            glyphs with different consequences - one empties the field, the
            other loses your place - and only a screen reader could tell them
            apart. This one mirrors the key that already closes the palette. */}
        <button
          type="button"
          className="grid h-11 shrink-0 place-items-center rounded-lg px-3 text-xs font-bold text-muted hover:bg-surface-muted hover:text-foreground focus-visible:outline-focus"
          aria-label="Close search"
          onClick={closePalette}
        >
          <span aria-hidden="true">Esc</span>
        </button>
      </div>

      <p
        id={statusId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex min-h-11 items-center gap-2 px-4 py-3 text-sm text-muted"
      >
        {status.icon}
        <span>{status.text}</span>
      </p>

      {search.isError && !isAbortedError(search.error) && !offline ? (
        <div
          className="mx-4 mb-4 rounded-xl border border-danger/35 bg-danger-soft p-4"
          role="alert"
        >
          <div className="flex items-start gap-3">
            <CircleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
            <div className="min-w-0">
              <p className="font-bold text-foreground">Search is unavailable</p>
              <p className="mt-1 text-sm leading-6 text-muted">{errorMessage(search.error)}</p>
              <Button
                type="button"
                variant="outline"
                size="compact"
                className="mt-3"
                onClick={() => void search.refetch()}
              >
                Try again
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {hasResults ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="max-h-[55dvh] overflow-y-auto px-2 pb-3 sm:px-3"
        >
          {visibleGroups.map((group) => (
            <div key={group.group} role="group" aria-labelledby={`${listId}-${group.group}`}>
              <div
                id={`${listId}-${group.group}`}
                role="presentation"
                className="px-2 pb-1 pt-3 text-xs font-bold text-muted"
              >
                {group.label}
              </div>
              <div className="space-y-1">
                {group.results.map((result) => {
                  const index = flattenedResults.findIndex((entry) => entry.result === result);
                  const selected = index === selectedIndex;
                  return (
                    <div
                      key={`${group.group}-${result.id}`}
                      id={resultId(listId, result.id, index)}
                      role="option"
                      aria-selected={selected}
                      aria-setsize={flattenedResults.length}
                      aria-posinset={index + 1}
                      tabIndex={-1}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-foreground outline-none",
                        selected && "bg-surface-muted",
                      )}
                      onClick={() => activate(result)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        activate(result);
                      }}
                      onPointerDown={(event) => event.preventDefault()}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-bold text-foreground">
                          {result.label}
                        </span>
                        {result.detail ? (
                          <span className="block truncate text-sm text-foreground/80">
                            {result.detail}
                          </span>
                        ) : null}
                      </span>
                      <span
                        className="shrink-0 text-xs font-semibold text-foreground/80"
                        aria-hidden="true"
                      >
                        {group.label}
                      </span>
                    </div>
                  );
                })}
              </div>
              {group.more_results ? (
                <p className="px-3 py-2 text-xs font-semibold text-muted" role="note">
                  More results available. Keep typing to narrow the list.
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </dialog>
  );
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function resultId(listId: string, id: string, index: number): string {
  return `${listId}-result-${index}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function isAbortedError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "aborted";
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "The search request failed. Try again when the connection is available.";
}

function statusMessage({
  offline,
  normalizedQuery,
  debouncedQuery,
  canSearch,
  isPending,
  model,
  hasResults,
  error,
}: {
  offline: boolean;
  normalizedQuery: string;
  debouncedQuery: string;
  canSearch: boolean;
  isPending: boolean;
  model: OperatorSearchReadModel | undefined;
  hasResults: boolean;
  error: unknown;
}): { text: string; icon: React.JSX.Element | null } {
  if (offline)
    return {
      text: "Search needs a current connection. No offline index is available.",
      icon: <WifiOff className="size-4 shrink-0 text-warning" aria-hidden="true" />,
    };
  if (normalizedQuery.length < 2)
    return { text: "Type at least 2 characters to search.", icon: null };
  if (normalizedQuery !== debouncedQuery)
    return {
      text: "Waiting to search…",
      icon: <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />,
    };
  if (isPending)
    return {
      text: "Searching…",
      icon: <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />,
    };
  if (error && !isAbortedError(error))
    return { text: "Search could not be completed.", icon: null };
  if (!canSearch || !model) return { text: "Type at least 2 characters to search.", icon: null };
  if (model.outcome === "query_too_short")
    return { text: "Type at least 2 usable characters to search.", icon: null };
  if (model.outcome === "no_matches" || !hasResults)
    return { text: `No results for “${model.query}”.`, icon: null };
  return {
    text: `${model.groups.reduce((count, group) => count + group.results.length, 0)} results`,
    icon: null,
  };
}
