import { useSyncExternalStore } from "react";

/**
 * Appearance is a per-viewer convenience, not business state: it lives in this browser's
 * storage and never reaches the server. `system` follows the device; `light` and `dark` pin
 * `data-mode` on <html> to `office-light` or `office-dark`, which the generated tokens
 * (`styles/tokens.css`) honour over `prefers-color-scheme`.
 *
 * A place that chooses its own colour mode does not touch <html>: the crew phone, the shop
 * reading view and the customer page put one of `scopes` on their own root.
 */
export const themePreferences = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof themePreferences)[number];

export const THEME_STORAGE_KEY = "ironwrap.theme.v1";

const OFFICE_MODES = { light: "office-light", dark: "office-dark" } as const;

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
  if (preference === "system") root.removeAttribute("data-mode");
  else root.setAttribute("data-mode", OFFICE_MODES[preference]);
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

/**
 * The colour mode and density of each place that chooses its own. Only the combinations in
 * `combinations` of `design/system-v2` tokens.json exist (theme.test.ts proves every entry is
 * one), so a scope is spread on a root and never assembled from loose strings.
 */
export const scopes = {
  crewSun: { "data-mode": "field-sun", "data-density": "touch" },
  crewNight: { "data-mode": "field-night", "data-density": "touch" },
  shopReading: { "data-mode": "shop-dark", "data-density": "glove" },
  customerLight: { "data-mode": "customer-light", "data-density": "touch" },
  customerDark: { "data-mode": "customer-dark", "data-density": "touch" },
  customerSun: { "data-mode": "customer-sun", "data-density": "touch" },
} as const;
export type Scope = (typeof scopes)[keyof typeof scopes];

const customerQueries = ["(prefers-contrast: more)", "(prefers-color-scheme: dark)"] as const;

function deviceMatches(query: string) {
  try {
    return window.matchMedia?.(query).matches ?? false;
  } catch {
    return false;
  }
}

/**
 * The customer page follows the phone: dark under `prefers-color-scheme: dark`, and the sun
 * palette (every text pair 7:1) under `prefers-contrast: more`, which wins over dark because an
 * accessibility request is the more specific one.
 */
export function customerScope(matches: (query: string) => boolean = deviceMatches): Scope {
  if (matches(customerQueries[0])) return scopes.customerSun;
  return matches(customerQueries[1]) ? scopes.customerDark : scopes.customerLight;
}

export function useCustomerScope(): Scope {
  return useSyncExternalStore(
    (notify) => {
      const lists = customerQueries.map((query) => window.matchMedia?.(query));
      for (const list of lists) list?.addEventListener("change", notify);
      return () => {
        for (const list of lists) list?.removeEventListener("change", notify);
      };
    },
    () => customerScope(),
    () => scopes.customerLight,
  );
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
