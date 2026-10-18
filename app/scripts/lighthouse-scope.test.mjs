import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { pin, PIN_PATH } from "./lighthouse-chrome.mjs";
import { measurementScope, readTreeState } from "./lighthouse-scope.mjs";

const BASE = {
  appTree: "a2205ea7a965d350bd9b38d4117c1268fff5fd62",
  workflowBlob: "ci000000",
  browser: "chrome@149.0.7827.55",
};

describe("measurementScope", () => {
  // The whole point of the change. Every budget failure in the 58-job survey behind
  // ELEC-106 was on a commit in exactly this state.
  it("does not re-measure a bundle byte-identical to the one the parent already measured", () => {
    const decision = measurementScope({ head: { ...BASE }, base: BASE });

    expect(decision.measure).toBe(false);
    expect(decision.changed).toEqual([]);
    expect(decision.reason).toContain("unchanged");
  });

  it("measures every commit that touches the PWA", () => {
    const decision = measurementScope({ head: { ...BASE, appTree: "deadbeef" }, base: BASE });

    expect(decision.measure).toBe(true);
    expect(decision.changed).toEqual(["app/"]);
  });

  // The reading is only reproducible for a fixed Node and browser, and this workflow file
  // pins the one and installs the other. A change there is a change to the measurement even
  // when the bundle is identical, so it has to be re-measured.
  it("measures when the workflow that pins the measurement changed", () => {
    const decision = measurementScope({ head: { ...BASE, workflowBlob: "ci111111" }, base: BASE });

    expect(decision.measure).toBe(true);
    expect(decision.changed).toEqual([".github/workflows/ci.yml"]);
  });

  // A new browser moves the reading on a byte-identical bundle (#412: Chrome 149 -> 156 took
  // main from passing to 0.89). The pin lives under app/, so the tree differs too, but the
  // reason names the browser so a reader of the job sees why the reading may have moved.
  it("measures when the browser pin moved, and names both builds", () => {
    const decision = measurementScope({
      head: { ...BASE, appTree: "deadbeef", browser: "chrome@155.0.8059.84" },
      base: BASE,
    });

    expect(decision.measure).toBe(true);
    expect(decision.changed).toEqual([
      "app/",
      "the browser pin (chrome@149.0.7827.55 -> chrome@155.0.8059.84)",
    ]);
    expect(decision.reason).toContain("chrome@155.0.8059.84");
  });

  it("measures when the base commit predates the pin", () => {
    const decision = measurementScope({
      head: { ...BASE, appTree: "deadbeef" },
      base: { ...BASE, browser: null },
    });

    expect(decision.measure).toBe(true);
    expect(decision.changed).toContain("the browser pin (unset -> chrome@149.0.7827.55)");
  });

  it("names both inputs when both changed", () => {
    const decision = measurementScope({
      head: { ...BASE, appTree: "deadbeef", workflowBlob: "ci111111" },
      base: BASE,
    });

    expect(decision.measure).toBe(true);
    expect(decision.changed).toEqual(["app/", ".github/workflows/ci.yml"]);
  });
});

describe("readTreeState", () => {
  // `actions/checkout` hands a pull request its merge commit and a push the pushed commit,
  // so HEAD^ is the base branch tip in one case and the previous commit in the other. One
  // ref, both events — this asserts the paths it reads, because reading the wrong ones
  // would silently skip a commit that did change the bundle.
  it("reads the app tree, the workflow blob and the browser pin at the given ref", () => {
    const calls = [];
    const state = readTreeState("HEAD^", {
      git: (args) => {
        calls.push(args);
        if (args[0] === "ls-tree") return args[5];
        if (args[0] === "show") return '{ "browser": "chrome", "buildId": "149.0.7827.55" }';
        return args[1];
      },
    });

    expect(calls).toEqual([
      ["rev-parse", "HEAD^:app"],
      ["rev-parse", "HEAD^:.github/workflows/ci.yml"],
      [
        "ls-tree",
        "--full-tree",
        "--name-only",
        "HEAD^",
        "--",
        "app/scripts/chrome-for-testing.json",
      ],
      ["show", "HEAD^:app/scripts/chrome-for-testing.json"],
    ]);
    expect(state).toEqual({
      appTree: "HEAD^:app",
      workflowBlob: "HEAD^:.github/workflows/ci.yml",
      browser: "chrome@149.0.7827.55",
    });
  });

  it("reads no pin at a ref that has none, without asking git for the missing file", () => {
    const calls = [];
    const state = readTreeState("HEAD^", {
      git: (args) => {
        calls.push(args[0]);
        return args[0] === "ls-tree" ? "" : args[1];
      },
    });

    expect(state.browser).toBeNull();
    expect(calls).not.toContain("show");
  });

  it("reads no pin from a pin file that does not parse", () => {
    const state = readTreeState("HEAD", {
      git: (args) => (args[0] === "show" ? "{ not json" : args[1]),
    });

    expect(state.browser).toBeNull();
  });

  // The comparison reads the pin by path through git, the harness reads it from disk; a
  // rename that updated only one of them would silently compare nothing.
  it("compares the same pin file the harness installs from", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

    expect(JSON.parse(readFileSync(resolve(repoRoot, PIN_PATH), "utf8"))).toEqual(pin);
    expect(PIN_PATH.startsWith("app/")).toBe(true);
  });
});
