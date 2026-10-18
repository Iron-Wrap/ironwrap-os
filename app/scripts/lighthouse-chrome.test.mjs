import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@puppeteer/browsers", () => ({
  install: vi.fn(async ({ browser, buildId, cacheDir }) => ({
    executablePath: `${cacheDir}/${browser}-${buildId}/chrome`,
  })),
}));

const { install } = await import("@puppeteer/browsers");
const { cacheDir, pin, resolveChromePath } = await import("./lighthouse-chrome.mjs");

describe("the measuring browser", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The point of the pin: unless someone names another executable on purpose, the budget is
  // read on the one Chrome for Testing build in chrome-for-testing.json, whatever Playwright
  // the e2e suites have installed.
  it("is the pinned Chrome for Testing build by default", async () => {
    vi.stubEnv("LHCI_CHROME_PATH", "");

    await expect(resolveChromePath()).resolves.toBe(`${cacheDir}/chrome-${pin.buildId}/chrome`);
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ browser: "chrome", buildId: pin.buildId, cacheDir }),
    );
  });

  it("is the executable LHCI_CHROME_PATH names, without installing the pin", async () => {
    vi.stubEnv("LHCI_CHROME_PATH", "/opt/candidate/chrome");

    await expect(resolveChromePath()).resolves.toBe("/opt/candidate/chrome");
    expect(install).not.toHaveBeenCalled();
  });

  // A channel or milestone ("stable", "149") would resolve to whatever Chrome for Testing
  // published last, which is the drift the pin exists to stop.
  it("is pinned to an exact build", () => {
    expect(pin.buildId).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  // Given no path, chrome-launcher measures with whatever Chrome it finds, which on a runner is
  // the preinstalled stable channel: the floating browser the pin exists to stop, behind green
  // tests. measure() needs a server and a browser, so its wiring is pinned in the source.
  it("is the executable every Lighthouse run launches", () => {
    const harness = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "lighthouse-field.mjs"),
      "utf8",
    );

    expect(harness).toContain('import { resolveChromePath } from "./lighthouse-chrome.mjs";');
    expect(harness).toContain("const chromePath = await resolveChromePath();");
    expect(harness).toContain("await runLighthouse(profile, chromePath, ");
    expect(harness.match(/chromeLauncher\.launch\(/g)).toHaveLength(1);
    expect(harness).toContain("chromeLauncher.launch({ chromePath, chromeFlags })");
  });
});
