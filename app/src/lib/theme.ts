/**
 * Appearance is a per-viewer convenience, not business state: it lives in this browser's
 * storage and never reaches the server. `system` follows the device; `light` and `dark` pin
 * `data-theme` on <html>, which `styles.css` honours over `prefers-color-scheme`.
 */
export const themePreferences = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof themePreferences)[number];

export const THEME_STORAGE_KEY = "ironwrap.theme.v1";

export function readThemePreference(storage: Pick<Storage, "getItem"> | undefined = safeStorage()) {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    return themePreferences.includes(stored as ThemePreference)
      ? (stored as ThemePreference)
      : "system";
  } catch {
    return "system";
  }
}

export function applyThemePreference(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
) {
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
}

/** Apply now and remember it; a storage failure (private mode, quota) only loses the memory. */
export function saveThemePreference(
  preference: ThemePreference,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = safeStorage(),
) {
  applyThemePreference(preference);
  try {
    if (preference === "system") storage?.removeItem(THEME_STORAGE_KEY);
    else storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Per-viewer convenience only.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
