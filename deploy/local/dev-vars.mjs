/**
 * The composable half of `predev.mjs`: how `workers-bus/.dev.vars` is built.
 *
 * `predev.mjs` itself needs Docker, a booted Frappe, and a live bench to run at all, so the
 * rules that decide what lands in `.dev.vars` could never be tested. They are here instead,
 * as pure functions over text, and `dev-vars.test.mjs` pins them. Two ELEC-112 findings were
 * reproduced twice each (ELEC-112, then ELEC-120) precisely because nothing checked them:
 *
 *   - finding 4: `wrangler.jsonc` is static JSON and cannot read the environment, so every
 *     `local` var carrying a host port has to be re-declared here - `wrangler dev` loads
 *     `.dev.vars` OVER the config's `vars`. `ERPNEXT_BASE_URL` was the one that got missed,
 *     which silently pointed a second stack's Worker at the FIRST stack's Frappe.
 *     `portBearingVars()` is now the single list, and the test asserts it covers every
 *     loopback-port-bearing var wrangler.jsonc declares for `local`.
 *   - finding 6: nothing scaffolded `.dev.vars` from `.dev.vars.example`, so a fresh checkout
 *     had no `ADMIN_TOKEN`/`INGEST_TOKEN`/`APP_AUTH_PEPPER` and every tester hand-added them.
 *     `scaffoldDevVars()` seeds the file from the example, comments and all.
 */

/**
 * Every `.dev.vars` key whose value carries a host port. Keep this list equal to the set of
 * `env.local.vars` entries in `workers-bus/wrangler.jsonc` that point at loopback - the test
 * fails when a new one is added there and forgotten here.
 */
export const PORT_BEARING_KEYS = Object.freeze([
  "ERPNEXT_BASE_URL",
  "APP_PUBLIC_ORIGIN",
  "APP_ALLOWED_ORIGINS",
  "PUBLIC_ESTIMATE_ALLOWED_ORIGINS",
]);

// Old generated .dev.vars files take precedence over the checked-in local config.
// Clear the retired broker origins, key IDs, and secrets during local preflight.
export const retiredBrokerVars = [
  ...["APPROVAL", "QUOTE_REVISION", "PRODUCTION_SCHEDULE", "PROPOSAL_PUBLICATION"].flatMap((name) => [
    [`APP_${name}_BROKER_URL`, '""'],
    [`APP_${name}_BROKER_KEY_ID`, '""'],
    [`${name}_BROKER_SHARED_SECRET`, '""'],
  ]),
  ["APP_FACET_QUOTE_REVISION_PREPARE_ENABLED", "false"],
  ["APP_PROPOSAL_PUBLICATION_ENABLED", "false"],
];

export function portBearingVars({ frappePort, workerPort }) {
  return [
    ["ERPNEXT_BASE_URL", `http://localhost:${frappePort}`],
    ["APP_PUBLIC_ORIGIN", `http://localhost:${workerPort}`],
    ["APP_ALLOWED_ORIGINS", `http://localhost:${workerPort}`],
    ["PUBLIC_ESTIMATE_ALLOWED_ORIGINS", `http://localhost:${workerPort}`],
  ];
}

/** Update existing `KEY=value` lines or append one, preserving unrelated lines. */
export function setVar(source, key, value) {
  const line = `${key}=${value}`;
  return source.match(new RegExp(`^${key}=`, "m"))
    ? source.replace(new RegExp(`^${key}=.*$`, "gm"), () => line)
    : `${source.trimEnd()}\n${line}\n`;
}

/** Apply `[key, value]` pairs in order. */
export function applyVars(source, entries) {
  let next = source;
  for (const [key, value] of entries) next = setVar(next, key, value);
  return next;
}

/**
 * Seed `.dev.vars` from `.dev.vars.example` when there is nothing to seed from yet.
 *
 * The example's placeholder values (`dev-admin-token-change-me`, and the "replace-with..."
 * peppers) are exactly what a tester types by hand today, so copying them verbatim is the
 * documented local contract, not a new one. An existing file is never rewritten: a stack that
 * has already been stood up keeps whatever the operator put there.
 */
export function scaffoldDevVars({ existing, example }) {
  const current = typeof existing === "string" ? existing : "";
  if (current.trim()) return { text: current, scaffolded: false };
  if (typeof example !== "string" || !example.trim()) {
    throw new Error(".dev.vars.example is missing or empty; cannot scaffold .dev.vars");
  }
  return { text: example, scaffolded: true };
}
