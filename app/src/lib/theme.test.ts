import { afterEach, describe, expect, it } from "vitest";

import tokens from "../design-system/tokens.json";
import {
  applyThemePreference,
  customerScope,
  readThemePreference,
  saveThemePreference,
  scopes,
  THEME_STORAGE_KEY,
} from "./theme";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-mode");
});

describe("appearance preference", () => {
  it("follows the device until the viewer chooses otherwise", () => {
    expect(readThemePreference()).toBe("system");
    applyThemePreference(readThemePreference());
    expect(document.documentElement).not.toHaveAttribute("data-mode");
  });

  it("pins the office mode on <html> and remembers it for the next visit", () => {
    saveThemePreference("dark");
    expect(document.documentElement).toHaveAttribute("data-mode", "office-dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    // A fresh load reads the choice back before anything renders.
    document.documentElement.removeAttribute("data-mode");
    applyThemePreference(readThemePreference());
    expect(document.documentElement).toHaveAttribute("data-mode", "office-dark");

    saveThemePreference("light");
    expect(document.documentElement).toHaveAttribute("data-mode", "office-light");
    expect(readThemePreference()).toBe("light");
  });

  it("returns to the device setting and forgets the pin", () => {
    saveThemePreference("dark");
    saveThemePreference("system");
    expect(document.documentElement).not.toHaveAttribute("data-mode");
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
    expect(document.documentElement).toHaveAttribute("data-mode", "office-dark");
  });
});

describe("place scopes", () => {
  const { combinations, axes } = tokens.$extensions["com.ironwrap.os"];

  it("only ever pair a colour mode and a density that tokens.json lists for a place", () => {
    for (const [name, scope] of Object.entries(scopes)) {
      const place = combinations.find(
        (entry) =>
          entry["color-mode"].includes(scope["data-mode"]) &&
          entry.density === scope["data-density"],
      );
      expect(place, `${name} (${scope["data-mode"]} at ${scope["data-density"]})`).toBeDefined();
      expect(axes["color-mode"]).toContain(scope["data-mode"]);
    }
  });

  it("keep the crew, shop and customer places on their own modes", () => {
    expect(scopes.crewSun["data-mode"]).toBe("field-sun");
    expect(scopes.crewNight["data-mode"]).toBe("field-night");
    expect(scopes.shopReading).toEqual({ "data-mode": "shop-dark", "data-density": "glove" });
    for (const scope of [scopes.customerLight, scopes.customerDark, scopes.customerSun]) {
      expect(scope["data-mode"]).toMatch(/^customer-/);
      expect(scope["data-density"]).toBe("touch");
    }
  });
});

describe("customer scope", () => {
  const phone =
    (...on: string[]) =>
    (query: string) =>
      on.includes(query);
  const dark = "(prefers-color-scheme: dark)";
  const more = "(prefers-contrast: more)";

  it("is light unless the phone asks otherwise", () => {
    expect(customerScope(phone())).toBe(scopes.customerLight);
  });

  it("follows the phone into dark", () => {
    expect(customerScope(phone(dark))).toBe(scopes.customerDark);
  });

  it("takes the sun palette under increased contrast, even on a dark phone", () => {
    expect(customerScope(phone(more))).toBe(scopes.customerSun);
    expect(customerScope(phone(dark, more))).toBe(scopes.customerSun);
  });
});
