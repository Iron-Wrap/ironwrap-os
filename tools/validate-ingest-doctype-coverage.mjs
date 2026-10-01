#!/usr/bin/env node
// Guard the tenant-leakage sweep against the drift that produced ELEC-143 finding 1.
//
// The leakage suite's check 5 ("B's lead exists on B's site and nowhere on A's") used to query
// ONE doctype, `Lead Envelope`. The ingest fan-out in workers-bus/src/erpnext.ts writes the same
// contact email into several more - `Roofing Customer.email` (erpnext.ts:665) most obviously -
// so a leak confined to the customer-dedup path passed check 5 and was counted toward the
// "0 FAIL" isolation claim. A hand-picked longer list would have re-opened the same gap the next
// time someone added a write, so deploy/local/frappe-marker-sweep.mjs sweeps the app's whole
// schema instead.
//
// This is the CI half of that: it re-derives, from erpnext.ts itself, every doctype the Worker
// names, and fails if any of them is outside what the sweep actually queries. It also refuses a
// check 5 that has stopped calling the sweep, and a schema carrying a fieldtype the sweep cannot
// classify. All three are the same defect shape: a question that was never asked, reported as an
// answer of "no leakage".
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sweepPlan } from "../deploy/local/frappe-marker-sweep.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ERPNEXT_SOURCE = "workers-bus/src/erpnext.ts";
const LEAKAGE_CHECKS = "deploy/tenant-leakage-checks.sh";
const SWEEP_TOOL = "deploy/local/frappe-marker-sweep.mjs";

/**
 * Every doctype the Worker names, taken as "a string literal in erpnext.ts that is also the name
 * of a doctype this app ships". Deliberately not a call-graph parse: doctype names reach
 * `erpFetch` through parameters, template literals and an env override
 * (`ERPNEXT_LEAD_ENVELOPE_DOCTYPE || "Lead Envelope"`), and a parser that understood today's
 * five call shapes would quietly miss the sixth. Matching literals against the shipped schema
 * over-approximates instead - a doctype named only in a comment is included - and an
 * over-approximation is the safe direction for a coverage guard.
 */
export function doctypesNamedIn(source, shippedDoctypes) {
  const literals = new Set(
    [...source.matchAll(/"([^"\\\n]+)"/g)].map((match) => match[1]),
  );
  return [...shippedDoctypes].filter((name) => literals.has(name)).sort();
}

export function coverageFindings({ erpnextSource, leakageChecks, plan }) {
  const findings = [];

  // `shipped` is what the app defines; `swept` is what check 5 will actually ask. Reading the
  // first from the second would make this guard agree with any sweep, however narrow.
  const shipped = new Set(plan.shipped);
  const swept = new Map(plan.doctypes.map((entry) => [entry.doctype, entry]));
  const named = doctypesNamedIn(erpnextSource, shipped);

  if (named.length === 0) {
    findings.push(
      `${ERPNEXT_SOURCE} names no doctype this app ships: the extraction is broken, so this guard would pass vacuously.`,
    );
  }

  for (const doctype of named) {
    const entry = swept.get(doctype);
    if (!entry) {
      findings.push(
        `${ERPNEXT_SOURCE} writes ${doctype} but ${SWEEP_TOOL} does not query it: a leak into ${doctype} would be reported as "no leakage".`,
      );
      continue;
    }
    if (entry.fields.length <= 1) {
      findings.push(
        `${SWEEP_TOOL} searches only \`name\` on ${doctype}, which ${ERPNEXT_SOURCE} writes: a contact detail in any of its own fields would not be found.`,
      );
    }
  }

  for (const entry of plan.unclassifiedFieldtypes) {
    findings.push(
      `${SWEEP_TOOL} cannot classify ${entry}: add the fieldtype to SEARCHABLE_FIELDTYPES or NON_SEARCHABLE_FIELDTYPES, never leave it unsearched by accident.`,
    );
  }
  for (const doctype of plan.unparented) {
    findings.push(
      `${doctype} is a child table no doctype embeds, so ${SWEEP_TOOL} cannot list it: give it a parent or remove it.`,
    );
  }

  // Check 5 is the caller. A sweep nothing runs proves nothing, and reverting check 5 to a
  // single hand-picked doctype is exactly the regression this file exists to catch.
  if (!leakageChecks.includes("frappe-marker-sweep.mjs")) {
    findings.push(
      `${LEAKAGE_CHECKS} no longer runs ${SWEEP_TOOL}: check 5 is back to asking a hand-picked doctype list (ELEC-143 finding 1).`,
    );
  }

  // IRO-268 R1.4: `c.vars.NAME` reads a wrangler config's vars directly, which is exactly the
  // pattern that turned checks 6 and 8 into verdicts about nothing once vars moved into CFG_*
  // JSON bindings (blocker 11) - the same defect shape this file exists to catch, one level
  // removed from ERPNext. `tools/read-wrangler-var.mjs` is the one reader that stays correct
  // whether the config is flat or grouped.
  const directVarReads = [...leakageChecks.matchAll(/\.vars\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]);
  if (directVarReads.length > 0) {
    findings.push(
      `${LEAKAGE_CHECKS} reads ${[...new Set(directVarReads)].join(", ")} through \`.vars.NAME\` directly: that silently reads undefined once the var moves into a CFG_* group. Use tools/read-wrangler-var.mjs instead.`,
    );
  }

  return { findings, named, sweptDoctypes: shipped.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const plan = sweepPlan();
  const { findings, named, sweptDoctypes } = coverageFindings({
    erpnextSource: readFileSync(join(root, ERPNEXT_SOURCE), "utf8"),
    leakageChecks: readFileSync(join(root, LEAKAGE_CHECKS), "utf8"),
    plan,
  });

  if (findings.length > 0) {
    console.error("ingest doctype coverage FAILED:");
    for (const finding of findings) console.error(`  - ${finding}`);
    process.exitCode = 1;
  } else {
    console.log(
      `ok tenant-leakage check 5 sweeps ${sweptDoctypes} doctypes, covering all ${named.length} named in ${ERPNEXT_SOURCE}`,
    );
  }
}
