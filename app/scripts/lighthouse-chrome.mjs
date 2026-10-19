import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The browser the paired-device budget is measured with. A regression gate compares a reading
 * against a fixed bar, so the instrument has to hold still while the bundle moves. The build is
 * pinned in `chrome-for-testing.json` beside this file and nowhere else; CI and a local
 * `npm run test:lighthouse` both install it from there.
 *
 * The leg used to measure with Playwright's Chromium, which moves with every @playwright/test
 * minor. #412 took it from Chrome 149 to 156, and on the same bundle Chrome 153 and later read
 * LCP +85-130 ms, Speed Index +470-560 ms and about twice the TBT, which put main at 0.89
 * against the 0.90 budget without one byte of the PWA changing. Chrome for Testing publishes
 * every build at an exact version, so the measuring browser no longer depends on the Playwright
 * the e2e suites run.
 *
 * The first pin, 149.0.7827.55, was the build Playwright 1.61.1 installs as `chromium-1228`
 * (Playwright mirrors Chrome for Testing), so the readings carried over unchanged; the pin now
 * follows current stable Chrome only when the bundle holds the budget on it. It is `chrome`
 * rather than `chrome-headless-shell` because the harness has always launched the full browser
 * in its new headless mode, and the shell is a separate headless implementation that would
 * move the reading on its own.
 *
 * Moving the pin is a measurement change, not a dependency update: read the current bundle on
 * both builds first. The budget does not move with the browser; a newer build that reads the
 * same bundle below it is a performance task for the bundle, never a reason to lower the bar.
 */
export const PIN_PATH = "app/scripts/chrome-for-testing.json";
export const pin = createRequire(import.meta.url)("./chrome-for-testing.json");

// Outside the checkout, so every worktree shares one download; ci.yml caches this directory.
export const cacheDir = join(homedir(), ".cache", "chrome-for-testing");

/** Installs the pinned build unless it is already there, and returns its executable. */
export async function installPinnedChrome() {
  // Imported on use: lighthouse-scope.mjs reads PIN_PATH before CI installs dependencies.
  const { install } = await import("@puppeteer/browsers");
  const installed = await install({
    browser: pin.browser,
    buildId: pin.buildId,
    cacheDir,
    downloadProgressCallback: "default",
  });
  return installed.executablePath;
}

/**
 * The executable to measure with. `LHCI_CHROME_PATH` names one on purpose: CI sets it to the
 * pinned build it has just installed, and a local comparison sets it to a candidate build.
 */
export async function resolveChromePath() {
  return process.env.LHCI_CHROME_PATH || installPinnedChrome();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chromePath = await installPinnedChrome();
  process.stdout.write(`${pin.browser}@${pin.buildId} ${chromePath}\n`);
  // Every later step of the job measures with exactly this executable.
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `LHCI_CHROME_PATH=${chromePath}\n`);
  }
}
