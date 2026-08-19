import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { median } from "./lighthouse-statistics.mjs";

const require = createRequire(import.meta.url);
const config = require("../lighthouserc.cjs");

/**
 * Measures the same build over both serving protocols so the claim behind the harness change
 * is checkable rather than argued: production serves this PWA through Cloudflare over HTTP/2,
 * the retired acceptance server was `node:http` HTTP/1.1, and HTTP/1.1's six-connection cap
 * queued this app's subresources into round trips no paired device pays.
 *
 * This is evidence, not a gate. It never fails on a threshold — a leg that misses a bar is the
 * datapoint it went looking for — and it is deliberately not part of the required check, so it
 * can never block a merge or be mistaken for the budget.
 */

/**
 * Legs alternate ABBA (h2, http1, http1, h2) rather than running each protocol's whole sample
 * in one block. A runner that drifts — thermal, noisy-neighbour, or simply warming up — biases
 * a blocked design entirely into whichever protocol ran second; mirroring the order puts that
 * drift into both arms equally. It matters here more than usual: byte-identical builds on this
 * gate have scored 0.92/73 ms and 0.86/232 ms on different runner allocations (Multica ELEC-46),
 * which is larger than the effect being measured.
 */
export function legPlan(rounds) {
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`A/B rounds must be a positive integer, received ${rounds}`);
  }
  const plan = [];
  for (let round = 0; round < rounds; round += 1) {
    plan.push(...(round % 2 === 0 ? ["h2", "http1"] : ["http1", "h2"]));
  }
  return plan;
}

/**
 * Pools every individual run of a protocol across its legs before taking the median, rather
 * than averaging per-leg medians: the legs are the same measurement repeated, so the wider
 * sample is the better estimate of the protocol's own reading.
 */
export function summarizeProtocolAb(legs) {
  if (!legs.length) throw new Error("Cannot summarize an empty A/B");
  const protocols = [...new Set(legs.map((leg) => leg.protocol))];
  const audits = [...new Set(legs.flatMap((leg) => Object.keys(leg.aggregate)))];
  const comparison = {};

  for (const audit of audits) {
    const readings = {};
    for (const protocol of protocols) {
      const values = legs
        .filter((leg) => leg.protocol === protocol)
        .flatMap((leg) => leg.aggregate[audit]?.values ?? []);
      if (values.length) readings[protocol] = { median: median(values), values };
    }
    comparison[audit] = readings;
    if (readings.h2 && readings.http1) {
      comparison[audit].delta = round(readings.h2.median - readings.http1.median);
    }
  }

  return { protocols, legs, comparison };
}

export function formatProtocolAbTable(summary) {
  const columns = ["audit", "h2 (new)", "http1 (old)", "delta"];
  const rows = Object.entries(summary.comparison).map(([audit, readings]) => [
    audit,
    readings.h2 ? String(round(readings.h2.median)) : "-",
    readings.http1 ? String(round(readings.http1.median)) : "-",
    readings.delta === undefined ? "-" : signed(readings.delta),
  ]);
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => row[index].length)),
  );
  const line = (cells) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join("  ")
      .trimEnd();

  return [line(columns), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}

/**
 * Audits that both arms actually measured. An A/B that produces nothing comparable still has a
 * well-formed summary and a table with every cell empty, and the run exits successfully — so
 * without this the job goes green having proved nothing, which is worse than going red. It is
 * not hypothetical: on a machine whose headless Chrome reports no paint timing, every audit
 * comes back non-numeric and both arms are blank.
 */
export function comparableAudits(summary) {
  return Object.entries(summary.comparison)
    .filter(([, readings]) => readings.h2 && readings.http1)
    .map(([audit]) => audit);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

export async function main({ rounds = Number(process.env.LIGHTHOUSE_AB_ROUNDS ?? "2") } = {}) {
  // Imported here rather than at module scope so the pure helpers above stay unit-testable:
  // a static import would pull Lighthouse, Puppeteer and a Chrome launcher into the suite.
  const { measure } = await import("./lighthouse-field.mjs");
  const plan = legPlan(rounds);
  const legs = [];

  for (const [index, protocol] of plan.entries()) {
    process.stdout.write(`\nA/B leg ${index + 1}/${plan.length}: ${protocol}\n`);
    const { aggregate, failures } = await measure({
      profile: config.profileFor(protocol),
      runFilePrefix: `ab-leg${index + 1}-${protocol}`,
      clean: index === 0,
    });
    legs.push({ leg: index + 1, protocol, aggregate, thresholdMisses: failures });
  }

  const summary = summarizeProtocolAb(legs);
  const evidence = {
    version: 1,
    tool: "lighthouse@13.4.1",
    url: config.url,
    gateProtocol: config.GATE_PROTOCOL,
    runsPerLeg: config.numberOfRuns,
    plan,
    ...summary,
  };

  const outputDir = resolve(config.outputDir);
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "protocol-ab.json"), `${JSON.stringify(evidence, null, 2)}\n`);

  process.stdout.write(`\nSame build, ${config.url}, ${config.numberOfRuns} runs per leg\n`);
  process.stdout.write(`Leg order: ${plan.join(" -> ")}\n\n`);
  for (const leg of legs) {
    const performance = leg.aggregate["categories:performance"]?.median;
    const blocking = leg.aggregate["total-blocking-time"]?.median;
    process.stdout.write(
      `leg ${leg.leg} ${leg.protocol.padEnd(5)} performance ${performance ?? "-"}` +
        `  total-blocking-time ${blocking === undefined ? "-" : round(blocking)}\n`,
    );
  }
  process.stdout.write(`\n${formatProtocolAbTable(summary)}\n`);
  process.stdout.write(`\nJSON evidence: ${resolve(outputDir, "protocol-ab.json")}\n`);

  // Checked last so the readings and the artifact survive the failure and can be read back.
  const comparable = comparableAudits(summary);
  if (!comparable.length) {
    const reasons = legs.flatMap((leg) =>
      leg.thresholdMisses.map((miss) => `leg ${leg.leg} ${leg.protocol}: ${miss}`),
    );
    throw new Error(
      `The A/B measured no audit on both protocols, so it compared nothing:\n- ${reasons.join("\n- ")}`,
    );
  }

  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
