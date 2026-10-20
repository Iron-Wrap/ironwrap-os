import type { NavigationItem, NavigationWorkspace } from "../lib/roles";

/** Up to four daily destinations fit the phone bar; a longer menu keeps its primaries and More. */
export function phoneTabs(items: readonly NavigationItem[]) {
  const primary = items.length <= 4 ? [...items] : items.filter((item) => item.mobilePrimary);
  return { primary, hasMore: primary.length < items.length };
}

export function groupNavigation(items: readonly NavigationItem[]) {
  const groups: Array<{ workspace: NavigationWorkspace; items: NavigationItem[] }> = [];
  for (const item of items) {
    const group = groups.find((candidate) => candidate.workspace === item.workspace);
    if (group) group.items.push(item);
    else groups.push({ workspace: item.workspace, items: [item] });
  }
  return groups;
}

/**
 * Records opened from a destination keep that destination named in the breadcrumb, so a job
 * packet reads "Plan / Production / Job" rather than losing its place.
 */
const RECORD_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/jobs\/[^/]+\/history$/, "Job history"],
  [/^\/jobs\/[^/]+/, "Job"],
  [/^\/work-objects\//, "Work"],
  [/^\/check-in\/[^/]+/, "Check-in"],
  [/^\/estimator\/jobs\/[^/]+\/revision$/, "Draft revision"],
  [/^\/estimator\/jobs\/[^/]+/, "Measurements"],
  [/^\/sales\/leads\/[^/]+\/triage$/, "Lead review"],
  [/^\/sales\/new-lead$/, "New lead"],
  [/^\/service\/[^/]+/, "Service case"],
  [/^\/marketing\/postiz\//, "Post draft"],
  [/^\/accounting\/intents\//, "Money item"],
  [/^\/accounting\/quickbooks\/final-invoices\//, "Final invoice"],
  [/^\/quote-revision-approvals\/[^/]+/, "Draft revision"],
  [/^\/quote-revision-approvals$/, "Draft revisions"],
  [/^\/safety\/corrective-actions\//, "Corrective action"],
  [/^\/safety\/equipment\/[^/]+/, "Equipment item"],
  [/^\/safety\/equipment$/, "Equipment"],
  [/^\/settings\/company$/, "Company"],
  [/^\/settings\/team$/, "Team"],
  [/^\/settings\/devices$/, "Crew devices"],
  [/^\/settings\/integrations$/, "Integrations"],
  [/^\/settings\/configuration/, "Configuration"],
];

export function shellPlace(
  items: readonly NavigationItem[],
  pathname: string,
): { item: NavigationItem; record?: string } {
  const item = navigationItemForPath(items, pathname);
  if (pathname === item.to) return { item };
  const record = RECORD_LABELS.find(([pattern]) => pattern.test(pathname))?.[1];
  return record ? { item, record } : { item };
}

/**
 * The breadcrumb for a place: the workspace, the destination when a record is open, and the page
 * itself. A destination named like its workspace ("Settings" in Settings, "Now" in Now) is said
 * once, so a settings page reads "Settings / Company", never "Settings / Settings / Company"; with a
 * record open the workspace crumb then links back to the destination.
 */
export function breadcrumbTrail({ item, record }: { item: NavigationItem; record?: string }): {
  workspace?: { label: string; to?: string };
  destination?: { label: string; to: string };
  current: string;
} {
  const repeats = item.label === item.workspace;
  if (!record)
    return repeats
      ? { current: item.label }
      : { workspace: { label: item.workspace }, current: item.label };
  return repeats
    ? { workspace: { label: item.workspace, to: item.to }, current: record }
    : {
        workspace: { label: item.workspace },
        destination: { label: item.label, to: item.to },
        current: record,
      };
}

export function navigationItemForPath(
  items: readonly NavigationItem[],
  pathname: string,
): NavigationItem {
  const direct = [...items]
    .sort((left, right) => right.to.length - left.to.length)
    .find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  if (direct) return direct;

  const alias =
    pathname === "/today" || pathname.startsWith("/jobs/") || pathname.startsWith("/work-objects/")
      ? "/production"
      : pathname === "/owner"
        ? "/now"
        : pathname.startsWith("/estimator/") || pathname.startsWith("/marketing/")
          ? "/sales"
          : pathname.startsWith("/quote-revision-approvals")
            ? "/approvals"
            : undefined;

  return (
    items.find((item) => item.to === alias) ??
    (alias === "/production" ? items.find((item) => item.to === "/today") : undefined) ??
    items.find((item) => item.to === "/now") ??
    items[0]!
  );
}

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase())
      .slice(0, 2)
      .join("") || "?"
  );
}

/**
 * The viewer's own destinations, all of them before anything is typed and then those with a word
 * that starts with the query (the rule the server's `go_to` group uses), so "iss" finds "Money
 * issues" but "sue" does not.
 */
export function matchDestinations(
  items: readonly NavigationItem[],
  query: string,
): readonly NavigationItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) =>
    item.label
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .some((word) => word.startsWith(needle)),
  );
}
