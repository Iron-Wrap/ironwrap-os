// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CATALOG_SHA256 as WORKER_CATALOG_SHA256 } from "../../workers-bus/src/agents/contract-catalog";
import { CATALOG_JSON, CATALOG_SHA256 } from "../src/generated-views/contract-catalog";
import { catalogFromContractJson, validateViewSpec } from "../src/generated-views/view-spec";
import { APP_CATALOG, renderAppCatalog } from "./sync-agent-catalog.mjs";
import { VIEW_SPEC_SOURCE, WORKER_VIEW_SPEC, renderWorkerCopy } from "./sync-view-spec.mjs";

/**
 * The copies the generated-view validator depends on, checked on every `npm test` (the CI app job
 * runs no separate sync step): the app's catalog against docs/AI-TEAM-CONTRACT.md and the Worker's
 * hash, the Worker's validator against this app's source, and the literal-word rule against the
 * plain-language guard it mirrors.
 */

const FIXTURES = new URL("../src/generated-views/__fixtures__/", import.meta.url);

describe("generated-view copies", () => {
  it("carries the contract catalog byte for byte, under the Worker's hash", () => {
    expect(readFileSync(APP_CATALOG, "utf8")).toBe(renderAppCatalog());
    expect(CATALOG_SHA256).toBe(WORKER_CATALOG_SHA256);
  });

  it("keeps the examples equal to the ones in design/system-v2/TEMPLATES.md", () => {
    const templates = readFileSync(
      new URL("../../design/system-v2/TEMPLATES.md", import.meta.url),
      "utf8",
    );
    const examples = [...templates.matchAll(/```json\s*([\s\S]*?)\s*```/g)]
      .map(([, block]) => {
        try {
          return JSON.parse(block as string) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((spec) => spec?.schema === "ironwrap_view_spec_v1" && spec.template);
    const fixtures = readdirSync(FIXTURES)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as unknown);
    // A TEMPLATES.md edit fails here until the fixture is copied again (and the validator agrees).
    for (const fixture of fixtures) expect(examples).toContainEqual(fixture);
  });

  it("gives the Worker the validator byte for byte (npm run view-spec)", () => {
    expect(readFileSync(WORKER_VIEW_SPEC, "utf8")).toBe(
      renderWorkerCopy(readFileSync(VIEW_SPEC_SOURCE, "utf8")),
    );
  });
});

describe("literal words in a view spec", () => {
  const source = readFileSync(new URL("./plain-language.family.test.ts", import.meta.url), "utf8");
  const between = (from: string, to: string) =>
    source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const TERM =
    /term\(\s*"([^"]+)",\s*\/(?:\\.|[^/\\\n])+\/[a-z]*,\s*(?:"[^"]*"|systemOnly),\s*(\[[^\]]*\]),\s*(\[[^\]]*\])/g;
  const terms = (block: string) =>
    [...block.matchAll(TERM)].map(([, name, hits, misses]) => ({
      name: name as string,
      hits: JSON.parse((hits as string).replace(/,\s*\]$/, "]")) as string[],
      misses: JSON.parse((misses as string).replace(/,\s*\]$/, "]")) as string[],
    }));
  const banned = terms(between("const BANNED", "const AGENTS"));
  const agents = terms(between("const AGENTS", "const SOFT")).filter((term) => term.name !== "AI");

  const catalog = catalogFromContractJson(CATALOG_JSON, CATALOG_SHA256);
  const codesFor = (title: string) => {
    const spec = { schema: "ironwrap_view_spec_v1", title };
    const result = validateViewSpec(spec, catalog, { place: "office" });
    return result.ok
      ? []
      : result.issues.filter((issue) => issue.path === "/title").map((issue) => issue.code);
  };

  it("reads every term of the guard's lists", () => {
    const calls = (from: string, to: string) => between(from, to).match(/\bterm\(/g)?.length ?? 0;
    expect(banned.length).toBe(calls("const BANNED", "const AGENTS"));
    expect(banned.length).toBeGreaterThan(30);
    expect(agents.map((term) => term.name)).toEqual(["HELM", "Hermes", "Newo", "Postiz", "agent"]);
  });

  it("refuses every banned term and agent name of the plain-language guard", () => {
    for (const term of [...banned, ...agents]) {
      for (const hit of term.hits)
        expect(codesFor(hit), `${term.name}: ${hit}`).toContain("literal_banned_term");
      for (const miss of term.misses) {
        expect(codesFor(miss), `${term.name}: ${miss}`).not.toContain("literal_banned_term");
      }
    }
  });
});
