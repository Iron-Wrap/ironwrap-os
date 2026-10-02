import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { loadPublicEstimateConfig } from "../public-estimate/public-estimate-config";

/**
 * The ⌘K palette, loaded on first use. The shortcut is ignored while typing in a field so it
 * never steals a keystroke from a form.
 */
export function useSearchPalette() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const openSearch = useCallback(() => {
    setLoaded(true);
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      if (
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName))
      )
        return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSearch]);

  return { open, setOpen, loaded, openSearch };
}

/**
 * The company's own logo once an owner has uploaded one. The public brand configuration already
 * states whether a logo exists, so a tenant without one never probes a known-missing resource.
 */
export function useCompanyLogoUrl(): string | null {
  const session = useSession();
  const brandConfig = useQuery({
    queryKey: ["public-brand", session.tenant.id],
    queryFn: () => loadPublicEstimateConfig(),
    enabled: !isOfflineSession(session),
    staleTime: 5 * 60_000,
  });
  return brandConfig.data?.logo_url ?? null;
}
