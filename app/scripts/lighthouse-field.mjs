import { once } from "node:events";
import { get as httpsGet } from "node:https";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const chromeLauncher = require("chrome-launcher");
const lighthouse = require("lighthouse").default;
const puppeteer = require("puppeteer-core");
const config = require("../lighthouserc.cjs");
const { seedPairedFieldDevice } = require("./lhci-field-device.cjs");
const { certificateSpkiFingerprint } = await import("./acceptance-certificate.mjs");

export function median(values) {
  if (!values.length) throw new Error("Cannot calculate a median for an empty set");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function evaluateAssertions(results, assertions) {
  const failures = [];
  const aggregate = {};

  for (const [auditId, [, options]] of Object.entries(assertions)) {
    const values = results.map((result) => {
      if (auditId.startsWith("categories:")) {
        return result.categories[auditId.slice("categories:".length)]?.score;
      }
      return result.audits[auditId]?.numericValue;
    });
    if (!values.every((value) => Number.isFinite(value))) {
      failures.push(`${auditId}: Lighthouse returned a non-numeric value`);
      continue;
    }

    const value = median(values);
    aggregate[auditId] = { median: value, values };
    if (options.minScore !== undefined && value < options.minScore) {
      failures.push(`${auditId}: median ${value} is below ${options.minScore}`);
    }
    if (options.maxNumericValue !== undefined && value > options.maxNumericValue) {
      failures.push(`${auditId}: median ${value} exceeds ${options.maxNumericValue}`);
    }
  }

  return { aggregate, failures };
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Acceptance server exited with code ${child.exitCode}`);
    try {
      if (await isServerReady(`${url}/healthz`)) return;
    } catch {
      // The server may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Acceptance server did not become ready at ${url}`);
}

// The loopback certificate is self-signed, so Node's fetch rejects it. Only Chrome's
// view of the certificate affects the measurement, and that is pinned by SPKI digest.
function isServerReady(url) {
  return new Promise((resolve) => {
    const request = httpsGet(url, { rejectUnauthorized: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function runLighthouse(url, runNumber, outputDir, chromeFlags) {
  const chrome = await chromeLauncher.launch({
    chromePath: config.chromePath,
    chromeFlags,
  });
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
    const setupPage = await browser.newPage();
    await seedPairedFieldDevice(setupPage, new URL(url).origin);
    await setupPage.close();
    const page = await browser.newPage();
    const result = await lighthouse(
      url,
      {
        port: chrome.port,
        output: "json",
        logLevel: "error",
        disableStorageReset: true,
      },
      { extends: "lighthouse:default", settings: config.settings },
      page,
    );
    if (!result?.lhr) throw new Error("Lighthouse returned no result");
    await writeFile(
      resolve(outputDir, `lighthouse-run-${runNumber}.json`),
      `${JSON.stringify(result.lhr, null, 2)}\n`,
    );
    await page.close();
    return result.lhr;
  } finally {
    browser?.disconnect();
    await chrome.kill();
  }
}

export async function run() {
  const outputDir = resolve(config.outputDir);
  const baseUrl = new URL(config.baseUrl);

  // Mint the certificate before the server starts. Both this process and the server
  // ensure it exists, so leaving it to chance let them race: each minted its own, and
  // Chrome then pinned a digest the server never served.
  const chromeFlags = [
    "--headless",
    "--disable-gpu",
    // Trust this one certificate rather than disabling certificate checking wholesale:
    // an origin Chrome still considers insecure is not a secure context, and the PWA
    // under measurement would register no service worker.
    `--ignore-certificate-errors-spki-list=${await certificateSpkiFingerprint()}`,
    ...(process.env.CI ? ["--no-sandbox"] : []),
  ];

  const server = spawn(process.execPath, ["scripts/acceptance-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ACCEPTANCE_MODE: "field",
      ACCEPTANCE_PROTOCOL: config.protocol,
      HOST: baseUrl.hostname,
      PORT: String(baseUrl.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(config.baseUrl, server);
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    const results = [];
    for (let runNumber = 1; runNumber <= config.numberOfRuns; runNumber += 1) {
      process.stdout.write(`Lighthouse run ${runNumber}/${config.numberOfRuns}\n`);
      results.push(await runLighthouse(config.url, runNumber, outputDir, chromeFlags));
    }

    const { aggregate, failures } = evaluateAssertions(results, config.assertions);
    const evidence = {
      version: 1,
      tool: "lighthouse@13.4.1",
      url: config.url,
      runs: config.numberOfRuns,
      thresholds: config.assertions,
      aggregate,
      runFiles: results.map((_, index) => `lighthouse-run-${index + 1}.json`),
    };
    await writeFile(
      resolve(outputDir, "lighthouse-summary.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    if (failures.length)
      throw new Error(`Lighthouse assertions failed:\n- ${failures.join("\n- ")}`);
    process.stdout.write(`Lighthouse assertions passed; JSON evidence is in ${outputDir}\n`);
  } finally {
    await stopProcess(server);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
