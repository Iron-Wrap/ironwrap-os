import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { lazy, Suspense, useId, useState, type ReactNode } from "react";

import { getDeviceSecret } from "../auth/device-credential";
import { clearSessionSnapshot, isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { sessionQueryKey } from "../auth/session-query";
import { apiCommand } from "../lib/api";
import { useOnlineStatus } from "../hooks/use-online-status";
import { API_PATHS } from "../lib/api-paths";
import { cn } from "../lib/cn";
import { roleLabel } from "../lib/roles";
import {
  readThemePreference,
  saveThemePreference,
  themePreferences,
  type ThemePreference,
} from "../lib/theme";
import { Button } from "./ui/button";
import { Segmented } from "./ui/segmented";

const themeLabel: Record<ThemePreference, string> = {
  system: "Match device",
  light: "Light",
  dark: "Dark",
};

function useSignOut() {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const online = useOnlineStatus();
  const offline = !online || isOfflineSession(session);

  async function signOut() {
    if (offline || signingOut) return;
    setSignOutError(null);
    setSigningOut(true);
    try {
      await apiCommand({
        path: API_PATHS.logout,
        csrfToken: session.csrf_token,
        deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
      });
      await clearSessionSnapshot();
      queryClient.removeQueries({ queryKey: sessionQueryKey });
      await navigate({ to: "/", replace: true });
    } catch {
      setSignOutError("Could not confirm sign-out. Check your connection and try again.");
    } finally {
      setSigningOut(false);
    }
  }

  return { signOut, signingOut, offline, signOutError };
}

/**
 * The person menu: who is signed in, this viewer's appearance, and sign out. `trigger` is the
 * visible button content; the menu is a native popover, so Escape and light dismiss are free.
 */
export function PersonMenu({
  trigger,
  triggerClassName,
  menuClassName,
}: {
  trigger: ReactNode;
  triggerClassName?: string;
  menuClassName?: string;
}) {
  const session = useSession();
  const menuId = useId();
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const { signOut, signingOut, offline, signOutError } = useSignOut();
  const name = session.user.display_name || session.user.email;

  return (
    <>
      <button
        type="button"
        popoverTarget={menuId}
        aria-label={`${name}, account menu`}
        className={triggerClassName}
      >
        {trigger}
      </button>
      <div
        id={menuId}
        popover="auto"
        className={cn(
          "fixed inset-auto top-[calc(var(--header-h,3.5rem)+env(safe-area-inset-top)-2px)] right-4 m-0 w-[min(18rem,calc(100vw-2rem))] rounded-xl bg-surface-raised p-1.5 text-foreground shadow-[var(--shadow-floating)]",
          menuClassName,
        )}
      >
        <div className="mb-1.5 border-b border-border px-3 pt-2.5 pb-3 text-sm">
          <p className="truncate font-semibold">{name}</p>
          <p className="truncate text-faint">
            {roleLabel(session.user.role)} · {session.user.email}
          </p>
        </div>
        <div className="px-3 pt-1 pb-3">
          <p className="mb-2 text-sm font-semibold" id={`${menuId}-appearance`}>
            Appearance
          </p>
          <Segmented variant="control" label="Appearance">
            {themePreferences.map((preference) => (
              <button
                key={preference}
                type="button"
                aria-pressed={theme === preference}
                onClick={() => {
                  saveThemePreference(preference);
                  setTheme(preference);
                }}
              >
                {themeLabel[preference]}
              </button>
            ))}
          </Segmented>
        </div>
        {signOutError ? (
          <p role="alert" className="px-3 pb-2 text-sm text-danger">
            {signOutError}
          </p>
        ) : null}
        <Button
          variant="quiet"
          className="w-full justify-start px-3 text-foreground"
          disabled={offline}
          busy={signingOut}
          onClick={() => void signOut()}
        >
          {signingOut ? null : <LogOut aria-hidden="true" />}
          {offline ? "Reconnect to sign out" : "Sign out"}
        </Button>
      </div>
    </>
  );
}

const OperatorSearchPalette = lazy(async () => ({
  default: (await import("./operator-search-palette")).OperatorSearchPalette,
}));

/** The ⌘K palette's chunk loads on first use, not with the shell. */
export function SearchPalette({
  loaded,
  open,
  onOpenChange,
}: {
  loaded: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!loaded) return null;
  return (
    <Suspense fallback={null}>
      <OperatorSearchPalette open={open} onOpenChange={onOpenChange} />
    </Suspense>
  );
}
