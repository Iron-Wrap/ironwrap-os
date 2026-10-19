import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, CornerDownLeft, LoaderCircle, Search, WifiOff, X } from "lucide-react";
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
import { isRefusal, messageForLoad } from "../lib/plain-error";
import { useOnlineStatus } from "../hooks/use-online-status";
import { navigationForRole } from "../lib/roles";
import { loadOperatorSearch } from "../search/operator-search-api";
import type {
  OperatorSearchReadModel,
  OperatorSearchResult,
} from "../search/operator-search-contracts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { matchDestinations } from "./shell-navigation";
import { RefTag } from "./ui/ref-tag";
import { ErrorSystemDetails } from "./ui/system-details";

interface OperatorSearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** One selectable row: a server record, or one of the viewer's own destinations. */
interface PaletteOption {
  key: string;
  group: string;
  label: string;
  detail: string | null;
  href: string;
  kind: "job" | "record" | "destination";
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
  // A deliberate choice follows its result when a pending search inserts records before it.
  const [activeKey, setActiveKey] = useState<string | null>(null);
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
  // The server also answers a `go_to` group, but it mirrors the rail from a copy of roles.ts.
  // The palette lists the viewer's destinations from roles.ts itself, so they match the rail
  // exactly, need no request, and still work offline.
  const recordGroups = useMemo(
    () =>
      model?.outcome === "results"
        ? model.groups.filter((group) => group.group !== "go_to" && group.results.length > 0)
        : [],
    [model],
  );
  const destinations = useMemo(
    () => matchDestinations(navigationForRole(session.user.role), normalizedQuery),
    [session.user.role, normalizedQuery],
  );
  const options = useMemo<PaletteOption[]>(
    () => [
      ...recordGroups.flatMap((group) =>
        group.results.map((result) => recordOption(group.group, result)),
      ),
      ...destinations.map((item) => ({
        key: `go_to-${item.to}`,
        group: "go_to",
        label: item.label,
        detail: null,
        href: item.to,
        kind: "destination" as const,
      })),
    ],
    [recordGroups, destinations],
  );
  const hasResults = options.length > 0;

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
    setActiveKey(null);
    onOpenChange(false);
  }

  function activate(option: PaletteOption) {
    closePalette();
    void navigate({ to: option.href as never });
  }

  function handleQueryChange(value: string) {
    setQueryText(value);
    setActiveKey(null);
  }

  const resultCount = options.length;
  const selectedIndex =
    resultCount === 0
      ? -1
      : Math.max(
          0,
          options.findIndex((option) => option.key === activeKey),
        );

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      if (resultCount === 0) return;
      event.preventDefault();
      setActiveKey(options[(selectedIndex + 1) % resultCount]!.key);
    } else if (event.key === "ArrowUp") {
      if (resultCount === 0) return;
      event.preventDefault();
      setActiveKey(options[selectedIndex <= 0 ? resultCount - 1 : selectedIndex - 1]!.key);
    } else if (event.key === "Enter") {
      const active = options[selectedIndex];
      if (!active) return;
      event.preventDefault();
      activate(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    }
  }

  const activeDescendant =
    selectedIndex >= 0 && options[selectedIndex]
      ? optionId(listId, options[selectedIndex]!.key, selectedIndex)
      : undefined;
  useEffect(() => {
    if (open && activeDescendant) {
      document.getElementById(activeDescendant)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, activeDescendant]);
  const status = statusMessage({
    offline,
    normalizedQuery,
    debouncedQuery,
    canSearch,
    isPending: search.isPending || search.isFetching,
    model,
    recordCount: options.length - destinations.length,
    destinationCount: destinations.length,
    error: search.error,
  });

  const groupsToShow = [
    ...recordGroups.map((group) => ({
      id: group.group,
      label: group.label,
      more: group.more_results,
    })),
    ...(destinations.length ? [{ id: "go_to", label: "Go to", more: false }] : []),
  ];

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={statusId}
      aria-modal="true"
      /* bottom-auto and mx-auto, not m-auto: this is a native <dialog>, and the
         UA sheet sets inset-block-end: 0 on an open one. With `m-auto` the
         block margins resolved to ~388px each and centred the box, defeating
         the top offset written right beside it - so the input sat at half screen
         height and drifted upward as results arrived, under the cursor of
         whoever was typing. On a phone the palette takes the whole screen. */
      className="palette fixed inset-0 bottom-auto m-0 h-dvh max-h-dvh w-screen max-w-none overflow-hidden bg-surface p-0 text-foreground shadow-[var(--shadow-floating)] backdrop:bg-scrim min-[721px]:top-[12vh] min-[721px]:mx-auto min-[721px]:h-auto min-[721px]:max-h-[calc(88dvh-2rem)] min-[721px]:w-[min(40rem,calc(100vw-2rem))] min-[721px]:rounded-[0.875rem]"
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
      <div className="flex min-h-15 items-center gap-2.5 border-b border-border py-1.5 pr-3 pl-4">
        <Search className="size-[1.125rem] shrink-0 text-faint" aria-hidden="true" />
        <h2 id={titleId} className="sr-only">
          Search Iron Wrap Exteriors
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
          placeholder="Job number, lead, customer or street"
          autoComplete="off"
          maxLength={120}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-controls={hasResults ? listId : undefined}
          aria-expanded={hasResults}
          aria-activedescendant={activeDescendant}
          // The palette's own 17px query type outranks the base field's unlayered type rule, and
          // the borderless field keeps no hover fill.
          className="min-h-12 flex-1 border-0 bg-transparent px-0 text-[1.0625rem]! shadow-none hover:bg-transparent focus-visible:outline-none"
        />
        {queryText ? (
          <button
            type="button"
            className="grid size-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-hover hover:text-foreground focus-visible:outline-focus"
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
          className="grid h-11 shrink-0 place-items-center rounded-md px-3 text-sm font-semibold text-muted hover:bg-surface-hover hover:text-foreground focus-visible:outline-focus"
          aria-label="Close search"
          onClick={closePalette}
        >
          <span aria-hidden="true">Esc</span>
        </button>
      </div>

      <div className="max-h-[calc(100dvh-4rem)] overflow-y-auto p-2 min-[721px]:max-h-[min(60vh,30rem)]">
        <p
          id={statusId}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex min-h-11 items-center gap-2 px-2.5 py-2.5 text-sm text-faint"
        >
          {status.icon}
          <span>{status.text}</span>
        </p>

        {search.isError && !isAbortedError(search.error) && !offline ? (
          <div
            className="mx-2 mb-3 rounded-lg border border-danger-line bg-danger-soft p-4"
            role="alert"
          >
            <div className="flex items-start gap-3">
              <CircleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-semibold text-foreground">
                  {isRefusal(search.error) ? "This search did not run" : "Search is unavailable"}
                </p>
                <p className="mt-1 text-sm leading-6 text-muted">{errorMessage(search.error)}</p>
                {isRefusal(search.error) ? null : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="compact"
                    className="mt-3"
                    onClick={() => void search.refetch()}
                  >
                    Try again
                  </Button>
                )}
                <ErrorSystemDetails error={search.error} />
              </div>
            </div>
          </div>
        ) : null}

        {hasResults ? (
          <div
            id={listId}
            role="listbox"
            aria-label="Search results"
            className="border-t border-border-soft pt-1"
          >
            {groupsToShow.map((group) => {
              const groupOptions = options.filter((option) => option.group === group.id);
              return (
                <div key={group.id} role="group" aria-labelledby={`${listId}-${group.id}`}>
                  <div
                    id={`${listId}-${group.id}`}
                    role="presentation"
                    className="px-2.5 pt-2 pb-1 text-xs font-semibold text-faint"
                  >
                    {group.label}
                  </div>
                  {groupOptions.map((option) => {
                    const index = options.indexOf(option);
                    const selected = index === selectedIndex;
                    return (
                      <div
                        key={option.key}
                        id={optionId(listId, option.key, index)}
                        role="option"
                        aria-selected={selected}
                        aria-setsize={options.length}
                        aria-posinset={index + 1}
                        tabIndex={-1}
                        className={cn(
                          "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-foreground outline-none hover:bg-surface-hover",
                          selected && "bg-selected hover:bg-selected",
                        )}
                        onClick={() => activate(option)}
                        onMouseMove={() => setActiveKey(option.key)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          activate(option);
                        }}
                        onPointerDown={(event) => event.preventDefault()}
                      >
                        {option.kind === "job" ? <RefTag id={option.label} /> : null}
                        <span className="min-w-0 flex-1">
                          {option.kind !== "job" ? (
                            <span className="block truncate text-[0.9375rem] font-medium">
                              {option.label}
                            </span>
                          ) : null}
                          {option.detail ? (
                            <span className="block truncate text-sm text-muted">
                              {option.detail}
                            </span>
                          ) : null}
                        </span>
                        {option.kind === "destination" ? (
                          <CornerDownLeft
                            className={cn("size-4 shrink-0 text-faint", !selected && "opacity-0")}
                            aria-hidden="true"
                          />
                        ) : null}
                      </div>
                    );
                  })}
                  {group.more ? (
                    <p className="px-2.5 py-2 text-xs font-semibold text-muted" role="note">
                      More results available. Keep typing to narrow the list.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}

function recordOption(group: string, result: OperatorSearchResult): PaletteOption {
  return {
    key: `${group}-${result.id}`,
    group,
    label: result.label,
    detail: result.detail,
    href: result.href,
    kind: group === "jobs" ? "job" : "record",
  };
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function optionId(listId: string, key: string, index: number): string {
  return `${listId}-option-${index}-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function isAbortedError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "aborted";
}

function errorMessage(error: unknown): string {
  return messageForLoad(error, {
    byCode: { search_query_too_long: "That search is too long. Use fewer words." },
    fallback: "Search is not answering right now. Try again in a moment.",
  });
}

function statusMessage({
  offline,
  normalizedQuery,
  debouncedQuery,
  canSearch,
  isPending,
  model,
  recordCount,
  destinationCount,
  error,
}: {
  offline: boolean;
  normalizedQuery: string;
  debouncedQuery: string;
  canSearch: boolean;
  isPending: boolean;
  model: OperatorSearchReadModel | undefined;
  recordCount: number;
  destinationCount: number;
  error: unknown;
}): { text: string; icon: React.JSX.Element | null } {
  if (offline)
    return {
      text: "Search needs a current connection. No offline index is available. Go to still works.",
      icon: <WifiOff className="size-4 shrink-0 text-warning" aria-hidden="true" />,
    };
  if (normalizedQuery.length === 0)
    return {
      text: "Search by job number, lead, customer name or street.",
      icon: null,
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
  if (recordCount === 0 && destinationCount === 0)
    return { text: `No results for “${model.query}”.`, icon: null };
  if (recordCount === 0) return { text: `No records match “${model.query}”.`, icon: null };
  return { text: `${recordCount} ${recordCount === 1 ? "result" : "results"}`, icon: null };
}
