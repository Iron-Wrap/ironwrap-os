import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { stripJsonComments } from "../../tools/generate-tenant-worker-config.mjs";
import { flattenWranglerVars } from "../../tools/wrangler-vars.mjs";
import type { AppEnv } from "../src/app-types.ts";
import { COMMERCIAL_ACTIONS, commercialActionConfigured } from "../src/commercial-authority.ts";

/**
 * The commercial write path opens only in qa, on a synthetic policy; production and local keep it
 * closed. Every check runs at a fixed instant inside the qa window, so the test never depends on
 * today's date (the window itself is renewed by editing wrangler.jsonc).
 */
const config = JSON.parse(
  stripJsonComments(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")).replace(
    /,(\s*[}\]])/g,
    "$1",
  ),
);

function policyEnv(environment: "production" | "local" | "qa") {
  const vars = environment === "production" ? config.vars : config.env[environment].vars;
  const flat = flattenWranglerVars(vars) as Record<string, string>;
  return { COMMERCIAL_AUTHORITY_POLICY_JSON: flat.COMMERCIAL_AUTHORITY_POLICY_JSON } as AppEnv & {
    COMMERCIAL_AUTHORITY_POLICY_JSON: string;
  };
}

const qa = policyEnv("qa");
const qaPolicy = JSON.parse(qa.COMMERCIAL_AUTHORITY_POLICY_JSON);
const insideWindow = new Date(Date.parse(qaPolicy.valid_from) + 24 * 60 * 60 * 1000);

test("production and local carry no commercial policy, so every action stays closed", () => {
  for (const environment of ["production", "local"] as const) {
    const env = policyEnv(environment);
    assert.equal(env.COMMERCIAL_AUTHORITY_POLICY_JSON, "", environment);
    for (const action of COMMERCIAL_ACTIONS) {
      for (const actor of ["owner", "worker"] as const) {
        assert.equal(commercialActionConfigured(env, "ironwrap", action, actor, insideWindow), false);
      }
    }
  }
});

test("qa opens the five commercial actions to owner and staff, never to an agent", () => {
  for (const action of COMMERCIAL_ACTIONS) {
    assert.equal(commercialActionConfigured(qa, "ironwrap", action, "owner", insideWindow), true, action);
    assert.equal(commercialActionConfigured(qa, "ironwrap", action, "worker", insideWindow), true, action);
    assert.equal(commercialActionConfigured(qa, "ironwrap", action, "agent", insideWindow), false, action);
    assert.equal(commercialActionConfigured(qa, "ironwrap", action, "customer", insideWindow), false, action);
    assert.equal(commercialActionConfigured(qa, "another-tenant", action, "owner", insideWindow), false);
  }
});

test("the qa policy is synthetic, bounded to 365 days and refuses outside its window", () => {
  assert.equal(qaPolicy.policy_id, "qa-synthetic-commercial-policy");
  assert.equal(qaPolicy.max_quote_total_cents, 10_000_000);
  assert.equal(Date.parse(qaPolicy.valid_until) - Date.parse(qaPolicy.valid_from), 365 * 24 * 60 * 60 * 1000);
  const before = new Date(Date.parse(qaPolicy.valid_from) - 1);
  const after = new Date(Date.parse(qaPolicy.valid_until));
  assert.equal(commercialActionConfigured(qa, "ironwrap", "quote.revision.record", "owner", before), false);
  assert.equal(commercialActionConfigured(qa, "ironwrap", "quote.revision.record", "owner", after), false);
});
