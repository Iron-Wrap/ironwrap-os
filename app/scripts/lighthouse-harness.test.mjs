import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  comparableAudits,
  formatProtocolAbTable,
  legPlan,
  missingComparableAudits,
  summarizeProtocolAb,
} from "./lighthouse-protocol-ab.mjs";
import { describeRunner, evaluateAssertions, normalizeRunnerValue } from "./lighthouse-field.mjs";
import { median } from "./lighthouse-statistics.mjs";

const require = createRequire(import.meta.url);
const config = require("../lighthouserc.cjs");

describe("paired-device gate profile", () => {
  // The bars, the run count and the throttle profile are the product rule; the harness
  // change that made this configurable at all was explicitly not allowed to move them.
  // This test is what makes a later drift a failing build rather than a quiet edit.
  it("asserts the mobile budget", () => {
    expect(config.numberOfRuns).toBe(5);
    expect(config.settings.throttlingMethod).toBe("devtools");
    expect(config.runnerNormalization).toEqual({
      referenceBenchmarkIndex: 2400,
      auditIds: ["total-blocking-time"],
    });
    expect(config.assertions["categories:performance"][1].minScore).toBe(0.9);
    expect(config.assertions["total-blocking-time"][1].maxNumericValue).toBe(250);
    expect(config.assertions["first-contentful-paint"][1].maxNumericValue).toBe(2000);
    expect(config.assertions["largest-contentful-paint"][1].maxNumericValue).toBe(4000);
    expect(config.assertions["cumulative-layout-shift"][1].maxNumericValue).toBe(0.1);
  });

  it("measures the protocol production serves", () => {
    expect(config.GATE_PROTOCOL).toBe("h2");
    expect(config.protocol).toBe("h2");
    expect(config.baseUrl.startsWith("https://")).toBe(true);
    expect(config.url.endsWith("/today")).toBe(true);
  });
});

describe("profileFor", () => {
  it("serves HTTP/2 over TLS, because browsers negotiate it no other way", () => {
    const profile = config.profileFor("h2");

    expect(profile.protocol).toBe("h2");
    expect(profile.baseUrl.startsWith("https://")).toBe(true);
  });

  it("reproduces the retired HTTP/1.1 acceptance server over plain HTTP", () => {
    const profile = config.profileFor("http1");

    expect(profile.protocol).toBe("http1");
    expect(profile.baseUrl.startsWith("http://")).toBe(true);
    expect(profile.url.endsWith("/today")).toBe(true);
  });

  // Without this the A/B could compare two different budgets and report the difference as a
  // protocol effect.
  it("gives every protocol the same bars, run count and throttle", () => {
    const h2 = config.profileFor("h2");
    const http1 = config.profileFor("http1");

    expect(http1.assertions).toBe(h2.assertions);
    expect(http1.settings).toBe(h2.settings);
    expect(http1.numberOfRuns).toBe(h2.numberOfRuns);
    expect(http1.runnerNormalization).toBe(h2.runnerNormalization);
  });

  it("refuses a protocol it cannot serve", () => {
    expect(() => config.profileFor("h3")).toThrow(/Unsupported acceptance protocol/);
  });
});

describe("legPlan", () => {
  it("mirrors leg order so runner drift lands in both arms", () => {
    expect(legPlan(2)).toEqual(["h2", "http1", "http1", "h2"]);
    expect(legPlan(1)).toEqual(["h2", "http1"]);
    expect(legPlan(3)).toEqual(["h2", "http1", "http1", "h2", "h2", "http1"]);
  });

  it("rejects a round count that cannot be measured", () => {
    expect(() => legPlan(0)).toThrow(/positive integer/);
    expect(() => legPlan(1.5)).toThrow(/positive integer/);
  });
});

describe("summarizeProtocolAb", () => {
  const legs = [
    {
      leg: 1,
      protocol: "h2",
      aggregate: { "total-blocking-time": { median: 170, values: [160, 170, 180] } },
    },
    {
      leg: 2,
      protocol: "http1",
      aggregate: { "total-blocking-time": { median: 240, values: [230, 240, 250] } },
    },
    {
      leg: 3,
      protocol: "http1",
      aggregate: { "total-blocking-time": { median: 260, values: [255, 260, 265] } },
    },
    {
      leg: 4,
      protocol: "h2",
      aggregate: { "total-blocking-time": { median: 190, values: [185, 190, 195] } },
    },
  ];

  it("pools every run of a protocol before taking its median", () => {
    const summary = summarizeProtocolAb(legs);
    const reading = summary.comparison["total-blocking-time"];

    expect(reading.h2.values).toEqual([160, 170, 180, 185, 190, 195]);
    expect(reading.h2.median).toBe(median([160, 170, 180, 185, 190, 195]));
    expect(reading.http1.median).toBe(median([230, 240, 250, 255, 260, 265]));
    expect(reading.delta).toBe(reading.h2.median - reading.http1.median);
  });

  it("renders both protocols side by side", () => {
    const table = formatProtocolAbTable(summarizeProtocolAb(legs));

    expect(table).toContain("h2 (new)");
    expect(table).toContain("http1 (old)");
    expect(table).toContain("total-blocking-time");
    expect(table).toContain("-70");
  });

  it("refuses to summarize nothing", () => {
    expect(() => summarizeProtocolAb([])).toThrow(/empty A\/B/);
  });
});

describe("comparableAudits", () => {
  it("counts only audits both arms measured", () => {
    const summary = summarizeProtocolAb([
      { leg: 1, protocol: "h2", aggregate: { "total-blocking-time": { values: [170] } } },
      { leg: 2, protocol: "http1", aggregate: { "total-blocking-time": { values: [240] } } },
      { leg: 3, protocol: "h2", aggregate: { "largest-contentful-paint": { values: [2900] } } },
    ]);

    expect(comparableAudits(summary)).toEqual(["total-blocking-time"]);
  });

  // A Lighthouse run that returns no numeric value still produces a well-formed summary and a
  // table of empty cells. Reporting that as a successful A/B would be a green job proving nothing.
  it("finds nothing comparable when Lighthouse returned no readings", () => {
    const summary = summarizeProtocolAb([
      { leg: 1, protocol: "h2", aggregate: {} },
      { leg: 2, protocol: "http1", aggregate: {} },
    ]);

    expect(comparableAudits(summary)).toEqual([]);
  });

  it("requires the normalized gate audit even when other readings are comparable", () => {
    const summary = summarizeProtocolAb([
      { leg: 1, protocol: "h2", aggregate: { "largest-contentful-paint": { values: [2900] } } },
      {
        leg: 2,
        protocol: "http1",
        aggregate: { "largest-contentful-paint": { values: [3100] } },
      },
    ]);

    expect(missingComparableAudits(summary, ["total-blocking-time"])).toEqual([
      "total-blocking-time",
    ]);
  });
});

describe("median", () => {
  it("orders before it picks", () => {
    expect(median([0.98, 0.9, 0.95])).toBe(0.95);
  });

  it("refuses an empty set", () => {
    expect(() => median([])).toThrow(/empty set/);
  });
});

describe("describeRunner", () => {
  // Two jobs reading 214 ms and 34 ms on byte-identical bytes is the ELEC-106 symptom, and
  // it was only diagnosable by re-deriving the runner from the metrics. The evidence now
  // carries the machine's own speed, so the next comparison does not have to.
  it("records the runner speed the readings were taken on", () => {
    const runner = describeRunner([
      { environment: { benchmarkIndex: 1100, hostUserAgent: "Chrome/tests" } },
      { environment: { benchmarkIndex: 900 } },
      { environment: { benchmarkIndex: 1000 } },
    ]);

    expect(runner.benchmarkIndex).toEqual({ median: 1000, values: [1100, 900, 1000] });
    expect(runner.hostUserAgent).toBe("Chrome/tests");
  });

  it("stays quiet when Lighthouse reported no environment", () => {
    expect(describeRunner([{}, {}])).toBeUndefined();
  });
});

describe("runner-normalized admission", () => {
  const assertions = {
    "total-blocking-time": ["error", { maxNumericValue: 250 }],
  };
  const normalization = {
    referenceBenchmarkIndex: 2400,
    auditIds: ["total-blocking-time"],
  };

  it("compares observed DevTools TBT on a fixed runner reference without hiding raw values", () => {
    const results = [
      [320.365, 2452.5],
      [314.641, 1077],
      [266.652, 2263],
      [262.976, 2193],
      [249.152, 2242.5],
    ].map(([totalBlockingTime, benchmarkIndex]) => ({
      audits: { "total-blocking-time": { numericValue: totalBlockingTime } },
      environment: { benchmarkIndex },
    }));

    const checked = evaluateAssertions(results, assertions, normalization);

    expect(checked.failures).toEqual([]);
    expect(checked.aggregate["total-blocking-time"].rawMedian).toBe(266.652);
    expect(checked.aggregate["total-blocking-time"].median).toBeCloseTo(240.2968);
  });

  it("still rejects a slow page on the reference runner", () => {
    const results = [260, 270, 280].map((totalBlockingTime) => ({
      audits: { "total-blocking-time": { numericValue: totalBlockingTime } },
      environment: { benchmarkIndex: 2400 },
    }));

    expect(evaluateAssertions(results, assertions, normalization).failures).toEqual([
      "total-blocking-time: runner-normalized median 270 exceeds 250",
    ]);
  });

  it("fails closed when Lighthouse omits the runner benchmark", () => {
    const results = [{ audits: { "total-blocking-time": { numericValue: 100 } } }];

    expect(evaluateAssertions(results, assertions, normalization).failures).toEqual([
      "total-blocking-time: runner normalization requires a positive benchmarkIndex",
    ]);
  });

  it("scales a measurement to the configured runner", () => {
    expect(normalizeRunnerValue(250, 1200, 2400)).toBe(125);
    expect(normalizeRunnerValue(250, 4800, 2400)).toBe(500);
  });
});
