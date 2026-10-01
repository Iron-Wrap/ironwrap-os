import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sweepPlan } from "../deploy/local/frappe-marker-sweep.mjs";
import { coverageFindings, doctypesNamedIn } from "./validate-ingest-doctype-coverage.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const erpnextSource = readFileSync(join(root, "workers-bus/src/erpnext.ts"), "utf8");
const leakageChecks = readFileSync(join(root, "deploy/tenant-leakage-checks.sh"), "utf8");
const plan = sweepPlan();

test("the shipped tree passes: every doctype erpnext.ts names is swept by check 5", () => {
  const { findings, named } = coverageFindings({ erpnextSource, leakageChecks, plan });
  assert.deepEqual(findings, []);
  // The ELEC-143 finding named these three specifically; a regression that drops them from the
  // extraction would otherwise make this test pass on an empty set.
  assert.ok(named.includes("Lead Envelope"));
  assert.ok(named.includes("Roofing Customer"));
  assert.ok(named.includes("Instant Estimate Session"));
});

test("a doctype the Worker writes but the sweep does not query is a finding", () => {
  const withoutCustomer = {
    ...plan,
    doctypes: plan.doctypes.filter((entry) => entry.doctype !== "Roofing Customer"),
  };
  const { findings } = coverageFindings({ erpnextSource, leakageChecks, plan: withoutCustomer });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /Roofing Customer/);
  assert.match(findings[0], /reported as "no leakage"/);
});

test("a doctype swept by name alone is a finding: its own fields would still hide a leak", () => {
  const nameOnly = {
    ...plan,
    doctypes: plan.doctypes.map((entry) =>
      entry.doctype === "Roofing Customer" ? { ...entry, fields: ["name"] } : entry,
    ),
  };
  const { findings } = coverageFindings({ erpnextSource, leakageChecks, plan: nameOnly });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /searches only `name` on Roofing Customer/);
});

test("a fieldtype the sweep cannot classify is a finding, not a silently skipped field", () => {
  const { findings } = coverageFindings({
    erpnextSource,
    leakageChecks,
    plan: { ...plan, unclassifiedFieldtypes: ["Roof Job.ledger:Ledger Text"] },
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /cannot classify Roof Job\.ledger:Ledger Text/);
});

test("a child table no doctype embeds is a finding: the sweep cannot list it", () => {
  const { findings } = coverageFindings({
    erpnextSource,
    leakageChecks,
    plan: { ...plan, unparented: ["Orphan Line"] },
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /Orphan Line is a child table/);
});

test("reverting check 5 to a hand-picked doctype is a finding", () => {
  const oldCheckFive = leakageChecks.replaceAll("frappe-marker-sweep.mjs", "Lead%20Envelope");
  const { findings } = coverageFindings({ erpnextSource, leakageChecks: oldCheckFive, plan });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /no longer runs deploy\/local\/frappe-marker-sweep\.mjs/);
});

test("a leakage check reading .vars.NAME directly is a finding (IRO-268 R1.4)", () => {
  const directRead = `${leakageChecks}\nconst c=JSON.parse(require("node:fs").readFileSync("x","utf8"));c.vars.FROM_EMAIL;\n`;
  const { findings } = coverageFindings({ erpnextSource, leakageChecks: directRead, plan });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /reads FROM_EMAIL through `\.vars\.NAME` directly/);
});

test("an erpnext.ts that names no doctype fails loudly rather than passing on an empty set", () => {
  const { findings } = coverageFindings({ erpnextSource: "export const nothing = 1;\n", leakageChecks, plan });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /names no doctype this app ships/);
});

test("extraction reads doctype names out of the call shapes erpnext.ts actually uses", () => {
  const shipped = new Set(["Lead Envelope", "Roofing Customer", "Roof Job", "Payment Milestone", "Crew Member"]);
  const source = `
    const doctype = cfg.ERPNEXT_LEAD_ENVELOPE_DOCTYPE || "Lead Envelope";
    await createIfMissingByField(
      env,
      base,
      "Roofing Customer",
      "customer_id",
    );
    await erpFetch(env, base, "PUT", \`/api/resource/\${enc("Roof Job")}/\${enc(name)}\`, {});
    local_doctype: paymentMilestoneName ? "Payment Milestone" : "Unresolved QuickBooks Event",
  `;
  assert.deepEqual(doctypesNamedIn(source, shipped), [
    "Lead Envelope",
    "Payment Milestone",
    "Roof Job",
    "Roofing Customer",
  ]);
});

test("the CLI reports the coverage it proved rather than just exiting zero", () => {
  const output = execFileSync("node", [join(root, "tools/validate-ingest-doctype-coverage.mjs")], {
    encoding: "utf8",
  });
  assert.match(output, /^ok tenant-leakage check 5 sweeps \d+ doctypes/m);
});
