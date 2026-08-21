import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  generateTenantConfig,
  render,
  resolveAnswers,
} from "./generate-tenant-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const template = JSON.parse(readFileSync(join(root, "deploy/templates/tenant-config.template.json"), "utf8"));
const exampleAnswers = JSON.parse(readFileSync(join(root, "deploy/templates/tenant-answers.example.json"), "utf8"));

const ironwrap = JSON.parse(readFileSync(join(root, "config/tenants/ironwrap.json"), "utf8"));

test("the shipped template and example answers render a config the tenant validator's invariants accept", () => {
  const config = generateTenantConfig({ template, answers: exampleAnswers, existingTenants: [ironwrap] });
  assert.equal(config._template, undefined, "the template's own documentation must not ship in a tenant config");
  assert.equal(config.tenant.id, "northline-metal");
  assert.deepEqual(config.geography.service_areas, ["Red Deer", "Lacombe", "Sylvan Lake"]);
  assert.equal(config.geography.compliance.casl_consent_required, true);
  assert.equal(config.estimates.instant_estimate.online_price, false);
  assert.equal(config.locale.timezone, config.geography.compliance.quiet_hours.timezone);
  assert.equal(config.locale.tax.province_code, config.geography.province);
  assert.deepEqual(config.production.gates, [
    "Deposit", "Materials", "Safety", "Access", "Weather", "Crew", "Completion",
  ]);
});

test("a sender domain another tenant already owns is refused", () => {
  // The copy-and-edit failure this generator exists to stop: the source tenant's domain
  // survives the edit, and two tenants send as the same domain.
  assert.throws(
    () =>
      generateTenantConfig({
        template,
        answers: {
          ...exampleAnswers,
          SENDER_DOMAIN: ironwrap.brand.brands[0].sender_domain,
          SENDER_MAILBOX: ironwrap.brand.brands[0].sender_mailbox,
          SENDER_ALIASES: [],
        },
        existingTenants: [ironwrap],
      }),
    /already belongs to tenant ironwrap/,
  );
});

test("a tenant id another config already owns is refused", () => {
  assert.throws(
    () =>
      generateTenantConfig({
        template,
        answers: { ...exampleAnswers, TENANT_ID: ironwrap.tenant.id },
        existingTenants: [ironwrap],
      }),
    /already taken by another config/,
  );
});

test("a missing answer is an error rather than an inherited value", () => {
  const { BRAND_NAME, ...incomplete } = exampleAnswers;
  void BRAND_NAME;
  assert.throws(() => resolveAnswers(incomplete), /missing required answers: BRAND_NAME/);
});

test("a sender mailbox off the sender domain is refused", () => {
  assert.throws(
    () => resolveAnswers({ ...exampleAnswers, SENDER_MAILBOX: "hello@somewhere-else.example" }),
    /must be a mailbox on SENDER_DOMAIN/,
  );
});

test("a sender alias off the sender domain is refused", () => {
  assert.throws(
    () => resolveAnswers({ ...exampleAnswers, SENDER_ALIASES: ["quotes@somewhere-else.example"] }),
    /is not on SENDER_DOMAIN/,
  );
});

test("a province with no blessed rates must state its own rather than inherit Alberta's", () => {
  assert.throws(
    () => resolveAnswers({ ...exampleAnswers, PROVINCE: "BC" }),
    /province BC has no blessed defaults/,
  );
  const stated = resolveAnswers({
    ...exampleAnswers,
    PROVINCE: "BC",
    TIMEZONE: "America/Vancouver",
    GST_RATE_BPS: 500,
    PST_RATE_BPS: 700,
    PRIVACY_LAW: "British Columbia PIPA",
    PREPAID_LICENCE_ID_ENV: "BC_PREPAID_CONTRACTOR_LICENCE_ID",
  });
  assert.equal(stated.PST_RATE_BPS, 700);
});

test("a tenant id that cannot be a site prefix is refused", () => {
  assert.throws(() => resolveAnswers({ ...exampleAnswers, TENANT_ID: "Northline Metal" }), /TENANT_ID must be/);
});

test("a token standing alone adopts its answer's type, and one inside prose is interpolated", () => {
  assert.deepEqual(render({ list: "{{SERVICES}}" }, { SERVICES: ["a", "b"] }), { list: ["a", "b"] });
  assert.deepEqual(render({ text: "pack for {{TENANT_ID}}" }, { TENANT_ID: "x" }), { text: "pack for x" });
  assert.throws(() => render({ text: "for {{SERVICES}}" }, { SERVICES: ["a"] }), /is not scalar/);
  assert.throws(() => render({ text: "{{NOPE}}" }, {}), /has no answer/);
});
