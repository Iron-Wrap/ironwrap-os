import { once } from "node:events";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { median } from "./lighthouse-statistics.mjs";

const require = createRequire(import.meta.url);
const chromeLauncher = require("chrome-launcher");
const lighthouse = require("lighthouse").default;
const puppeteer = require("puppeteer-core");
const config = require("../lighthouserc.cjs");
const { seedPairedFieldDevice } = require("./lhci-field-device.cjs");
const { certificateSpkiFingerprint } = await import("./acceptance-certificate.mjs");

export { median };

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

/**
 * The reading depends on the machine that took it, and until now nothing recorded which
 * machine that was. Lighthouse measures `benchmarkIndex` — a synthetic CPU/GC score, taken
 * unthrottled, independent of the page — at the start of every run, so the evidence can
 * carry the runner's speed next to the numbers it produced. Without it, a job that reads
 * 214 ms and a job that reads 34 ms on the same bytes are indistinguishable after the fact,
 * which is exactly the position ELEC-106 had to reconstruct from CI logs.
 */
export function describeRunner(results) {
  const values = results
    .map((result) => result.environment?.benchmarkIndex)
    .filter(Number.isFinite);
  if (!values.length) return undefined;
  return {
    benchmarkIndex: { median: median(values), values },
    hostUserAgent: results[0].environment?.hostUserAgent,
  };
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
// The A/B profile serves the retired HTTP/1.1 path over plain HTTP, which needs the
// other client: `https.get` against it never connects, and the readiness poll would
// spend its whole budget failing before the leg started.
function isServerReady(url) {
  const secure = url.startsWith("https:");
  const get = secure ? httpsGet : httpGet;
  return new Promise((resolve) => {
    const request = get(url, secure ? { rejectUnauthorized: false } : {}, (response) => {
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

async function runLighthouse(profile, runFileName, outputDir, chromeFlags) {
  const chrome = await chromeLauncher.launch({
    chromePath: profile.chromePath,
    chromeFlags,
  });
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
    const setupPage = await browser.newPage();
    await seedPairedFieldDevice(setupPage, new URL(profile.url).origin);
    await setupPage.close();
    const page = await browser.newPage();
    const result = await lighthouse(
      profile.url,
      {
        port: chrome.port,
        output: "json",
        logLevel: "error",
        disableStorageReset: true,
      },
      { extends: "lighthouse:default", settings: profile.settings },
      page,
    );
    if (!result?.lhr) throw new Error("Lighthouse returned no result");
    await writeFile(resolve(outputDir, runFileName), `${JSON.stringify(result.lhr, null, 2)}\n`);
    await page.close();
    return result.lhr;
  } finally {
    browser?.disconnect();
    await chrome.kill();
  }
}

/**
 * Runs one profile's full sample and reduces it, without deciding anything. The gate turns
 * the result into a verdict below; the protocol A/B deliberately does not, because a leg
 * that misses a bar is the datapoint it went looking for rather than a failure.
 */
export async function measure({
  profile = config,
  runFilePrefix = "lighthouse-run",
  clean = true,
} = {}) {
  const outputDir = resolve(profile.outputDir);
  const baseUrl = new URL(profile.baseUrl);

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
      ACCEPTANCE_PROTOCOL: profile.protocol,
      HOST: baseUrl.hostname,
      PORT: String(baseUrl.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(profile.baseUrl, server);
    if (clean) await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    const results = [];
    const runFiles = [];
    for (let runNumber = 1; runNumber <= profile.numberOfRuns; runNumber += 1) {
      process.stdout.write(
        `Lighthouse ${profile.protocol} run ${runNumber}/${profile.numberOfRuns}\n`,
      );
      const runFile = `${runFilePrefix}-${runNumber}.json`;
      results.push(await runLighthouse(profile, runFile, outputDir, chromeFlags));
      runFiles.push(runFile);
    }

    const { aggregate, failures } = evaluateAssertions(results, profile.assertions);
    return {
      aggregate,
      failures,
      outputDir,
      evidence: {
        version: 2,
        tool: "lighthouse@13.4.1",
        url: profile.url,
        protocol: profile.protocol,
        runs: profile.numberOfRuns,
        thresholds: profile.assertions,
        aggregate,
        runner: describeRunner(results),
        runFiles,
      },
    };
  } finally {
    await stopProcess(server);
  }
}

export async function run() {
  const { evidence, failures, outputDir } = await measure();

  // Written before the throw on purpose: the gate reports only what it failed, so a red run
  // would otherwise hide how much headroom every other metric had.
  await writeFile(
    resolve(outputDir, "lighthouse-summary.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  if (failures.length) throw new Error(`Lighthouse assertions failed:\n- ${failures.join("\n- ")}`);
  process.stdout.write(`Lighthouse assertions passed; JSON evidence is in ${outputDir}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
