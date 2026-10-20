import { config } from "zod";
import { describe, expect, it } from "vitest";

describe("zod parsing path", () => {
  // The app parses through zod's interpreted path (zod-jitless.ts) and the suite's setup imports
  // the same setting, so every contract test parses the way the shipped app does.
  it("runs the suite on zod's interpreted path", () => {
    expect(config().jitless).toBe(true);
  });
});
