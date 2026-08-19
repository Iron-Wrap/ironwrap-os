const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.ACCEPTANCE_PORT ?? process.env.PORT ?? "4173");

// Production serves this PWA from Cloudflare over HTTP/2, where subresources multiplex
// on one connection. Measuring it over HTTP/1.1 charged `/today` the six-connection
// cap's extra round trips, which no paired device pays. Browsers negotiate HTTP/2 only
// over TLS, so the profile runs against the loopback server's throwaway certificate.
// The emulated device, CPU and network throttling are unchanged — only the protocol.
//
// The gate's protocol is this literal and nothing else. It is deliberately not read from
// the environment: the whole point of the change was to stop the harness from deciding
// the verdict, and an env-selected protocol would put that decision back in a CI variable.
// `profileFor` below exists so the A/B harness can measure the retired HTTP/1.1 serving
// path against this one; it cannot relax what the gate asserts, because both profiles
// carry the same bars.
const GATE_PROTOCOL = "h2";

const schemes = { h2: "https", http1: "http" };

// Five runs, not three. The GitHub runner's own noise is wide enough that a median of three
// straddles the blocking-time bar on an unchanged artifact: CI run 32250637973 measured
// total-blocking-time medians of 242.234 ms and 200.504 ms across two attempts on the very same
// build (Multica ELEC-22 §4), and `main` alternated green and red on the same commit range.
// A wider sample narrows the median's own variance so the gate reports the page rather than the
// runner. The bars below are deliberately unchanged -- mobile-first is a gating product rule and
// 0.9 / 200 ms stay exactly where they were; making `/today` genuinely fast is a separate lane.
const numberOfRuns = 5;

const settings = {
  // Match Lighthouse's built-in `perf` preset explicitly. The programmatic API
  // does not resolve a `preset` value supplied inside `settings`.
  throttlingMethod: "devtools",
  onlyCategories: ["performance", "accessibility", "best-practices"],
};

const assertions = {
  "categories:performance": ["error", { minScore: 0.9, aggregationMethod: "median-run" }],
  "categories:accessibility": ["error", { minScore: 0.95 }],
  "categories:best-practices": ["error", { minScore: 0.95 }],
  "first-contentful-paint": ["error", { maxNumericValue: 2000, aggregationMethod: "median-run" }],
  "largest-contentful-paint": ["error", { maxNumericValue: 4000, aggregationMethod: "median-run" }],
  "cumulative-layout-shift": ["error", { maxNumericValue: 0.1, aggregationMethod: "median-run" }],
  "total-blocking-time": ["error", { maxNumericValue: 200, aggregationMethod: "median-run" }],
};

// Resolved on access, not at load. `@playwright/test` is the Playwright *runner*, and
// importing it opens a connection to a test server that is not there when anything other
// than Playwright loads this file — harmless, but it dumps an ECONNREFUSED stack into the
// unit-test output that reads like a real failure. Only the code that actually launches a
// browser needs the path.
function resolveChromePath() {
  if (process.env.LHCI_CHROME_PATH) return process.env.LHCI_CHROME_PATH;
  return require("@playwright/test").chromium.executablePath();
}

/**
 * One measurement profile per serving protocol. Everything a verdict depends on — the run
 * count, the emulated device/CPU/network throttle and every threshold — is shared by
 * construction, so the only difference an A/B between two profiles can measure is the
 * protocol itself.
 */
function profileFor(protocol) {
  const scheme = schemes[protocol];
  if (!scheme) throw new Error(`Unsupported acceptance protocol: ${protocol}`);
  const baseUrl = `${scheme}://${host}:${port}`;

  return {
    baseUrl,
    protocol,
    url: `${baseUrl}/today`,
    numberOfRuns,
    get chromePath() {
      return resolveChromePath();
    },
    settings,
    assertions,
    outputDir: ".lighthouseci",
  };
}

module.exports = Object.assign(profileFor(GATE_PROTOCOL), { GATE_PROTOCOL, profileFor });
