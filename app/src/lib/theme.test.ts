import { afterEach, describe, expect, it } from "vitest";

import {
  applyThemePreference,
  readThemePreference,
  saveThemePreference,
  THEME_STORAGE_KEY,
} from "./theme";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("appearance preference", () => {
  it("follows the device until the viewer chooses otherwise", () => {
    expect(readThemePreference()).toBe("system");
    applyThemePreference(readThemePreference());
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("pins data-theme on <html> and remembers it for the next visit", () => {
    saveThemePreference("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    // A fresh load reads the choice back before anything renders.
    document.documentElement.removeAttribute("data-theme");
    applyThemePreference(readThemePreference());
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    saveThemePreference("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(readThemePreference()).toBe("light");
  });

  it("returns to the device setting and forgets the pin", () => {
    saveThemePreference("dark");
    saveThemePreference("system");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("ignores a value it did not write and survives storage that throws", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readThemePreference()).toBe("system");

    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readThemePreference(throwing)).toBe("system");
    expect(() => saveThemePreference("dark", throwing)).not.toThrow();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
});
