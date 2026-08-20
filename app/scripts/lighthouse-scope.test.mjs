import { describe, expect, it } from "vitest";

import { measurementScope, readTreeState } from "./lighthouse-scope.mjs";

const BASE = { appTree: "a2205ea7a965d350bd9b38d4117c1268fff5fd62", workflowBlob: "ci000000" };

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

  // The reading is only reproducible for a fixed Node and Chromium, and this workflow file
  // is what pins them. A change there is a change to the measurement even when the bundle
  // is identical, so it has to be re-measured.
  it("measures when the workflow that pins the measurement changed", () => {
    const decision = measurementScope({ head: { ...BASE, workflowBlob: "ci111111" }, base: BASE });

    expect(decision.measure).toBe(true);
    expect(decision.changed).toEqual([".github/workflows/ci.yml"]);
  });

  it("names both inputs when both changed", () => {
    const decision = measurementScope({
      head: { appTree: "deadbeef", workflowBlob: "ci111111" },
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
  it("reads the app tree and the workflow blob at the given ref", () => {
    const calls = [];
    const state = readTreeState("HEAD^", {
      git: (args) => {
        calls.push(args);
        return args[1];
      },
    });

    expect(calls).toEqual([
      ["rev-parse", "HEAD^:app"],
      ["rev-parse", "HEAD^:.github/workflows/ci.yml"],
    ]);
    expect(state).toEqual({
      appTree: "HEAD^:app",
      workflowBlob: "HEAD^:.github/workflows/ci.yml",
    });
  });
});
