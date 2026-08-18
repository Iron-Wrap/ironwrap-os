const { chromium } = require("@playwright/test");

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.ACCEPTANCE_PORT ?? process.env.PORT ?? "4173");
const baseUrl = `http://${host}:${port}`;

module.exports = {
  baseUrl,
  url: `${baseUrl}/today`,
  numberOfRuns: 3,
  chromePath: process.env.LHCI_CHROME_PATH ?? chromium.executablePath(),
  settings: {
    // Match Lighthouse's built-in `perf` preset explicitly. The programmatic API
    // does not resolve a `preset` value supplied inside `settings`.
    throttlingMethod: "devtools",
    onlyCategories: ["performance", "accessibility", "best-practices"],
  },
  assertions: {
    "categories:performance": ["error", { minScore: 0.9, aggregationMethod: "median-run" }],
    "categories:accessibility": ["error", { minScore: 0.95 }],
    "categories:best-practices": ["error", { minScore: 0.95 }],
    "first-contentful-paint": ["error", { maxNumericValue: 2000, aggregationMethod: "median-run" }],
    "largest-contentful-paint": [
      "error",
      { maxNumericValue: 4000, aggregationMethod: "median-run" },
    ],
    "cumulative-layout-shift": ["error", { maxNumericValue: 0.1, aggregationMethod: "median-run" }],
    "total-blocking-time": ["error", { maxNumericValue: 200, aggregationMethod: "median-run" }],
  },
  outputDir: ".lighthouseci",
};
