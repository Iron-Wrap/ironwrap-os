const { chromium } = require("@playwright/test");

const chromePath = process.env.LHCI_CHROME_PATH ?? chromium.executablePath();

module.exports = {
  ci: {
    collect: {
      startServerCommand: "node scripts/acceptance-server.mjs",
      startServerReadyPattern: "acceptance server listening",
      chromePath,
      puppeteerScript: "./scripts/lhci-field-device.cjs",
      puppeteerLaunchOptions: { executablePath: chromePath },
      url: ["http://127.0.0.1:4173/today"],
      numberOfRuns: 1,
      settings: {
        preset: "perf",
        onlyCategories: ["performance", "accessibility", "best-practices"],
      },
    },
    assert: {
      assertions: {
        "categories:performance": ["error", { minScore: 0.9 }],
        "categories:accessibility": ["error", { minScore: 0.95 }],
        "categories:best-practices": ["error", { minScore: 0.95 }],
        "first-contentful-paint": ["error", { maxNumericValue: 2000 }],
        "largest-contentful-paint": ["error", { maxNumericValue: 4000 }],
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.1 }],
        "total-blocking-time": ["error", { maxNumericValue: 200 }],
      },
    },
    upload: {
      target: "filesystem",
      outputDir: ".lighthouseci",
    },
  },
};
