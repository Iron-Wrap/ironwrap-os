#!/usr/bin/env node
/**
 * Build an Approved Customer Quote on the local Frappe stack, through the real REST
 * validation chain (ELEC-112 finding 7).
 *
 * Every traverse that needs a priced, approved quote - the customer-portal acceptance leg, the
 * money-derive leg, anything downstream of "the customer can sign this" - had to rebuild one by
 * hand, because no product path prices a quote or approves it yet (that is an office estimator's
 * job today). ELEC-95, ELEC-112 and ELEC-120 each rebuilt the same fixture from scratch and each
 * rediscovered the same wrinkles. This is that construction, once, as a tool.
 *
 * It is a FIXTURE, not a product path, and it says so: every record it writes goes through
 * `domain_policy`'s full `_validate_price_rule` / `_validate_customer_quote` chain over REST -
 * no raw SQL, no `frappe.db.set_value`, no validation bypass - but the act of pricing and
 * approving is still standing in for a surface that does not exist yet.
 *
 * Usage (with the local stack up; credentials are read from workers-bus/.dev.vars):
 *
 *   node tools/local-approved-quote-fixture.mjs --roof-job job:ow_1234...
 *   node tools/local-approved-quote-fixture.mjs --roof-job job:... --subtotal 20000 --tax-rate 5
 *   node tools/local-approved-quote-fixture.mjs --roof-job job:... --json   # machine-readable
 *
 * Get a real Roof Job first through the owned intake spine, not by hand:
 *
 *   curl -s -X POST "$WORKER/ingest/estimate" -H "authorization: Bearer $INGEST_TOKEN" \
 *     -H 'content-type: application/json' -d '{"project_id":"...", ...}'
 *
 * The two wrinkles this tool exists to stop rediscovering:
 *
 *   1. `qb_terms_due_days` is written at Draft insert, not at approval. It is an `Int`, and
 *      Frappe stores an unset Int as 0 - which `enforce_write_once` used to read as "already
 *      set", so the first legitimate write tripped `write_once_field` (ELEC-120 finding 2).
 *      `domain_policy.WRITE_ONCE_ZERO_IS_UNSET` now names that field, but writing it at insert
 *      is still the right shape and keeps this tool working against an older bench.
 *   2. A price-rule snapshot can only be BOUND while the quote is Draft or Needs Review, and
 *      every frozen field in it must match its live source exactly as Frappe reads that source
 *      back - a Currency of 0 reads as blank, and an integral Currency stringifies Python-side
 *      as "1250.0". The snapshot is therefore built from a read-back of the created rule, never
 *      from the values we sent.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) fail(`unexpected argument ${JSON.stringify(arg)}`);
    if (arg === "--json") {
      options.set("--json", "true");
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) fail(`${arg} needs a value`);
    options.set(arg, next);
    index += 1;
  }
  return options;
}

function fail(message) {
  console.error(`local-approved-quote-fixture: ${message}`);
  process.exit(1);
}

/** Read a key out of workers-bus/.dev.vars, so nobody has to copy credentials by hand. */
function devVar(key) {
  const path = resolve(root, "workers-bus/.dev.vars");
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!line) return undefined;
  return line[1].trim().replace(/^["']|["']$/g, "");
}

/**
 * Frappe's MariaDB driver hands `frappe.get_all` a float for a Currency/Float column and a
 * date/datetime object for Date/Datetime, and `_validate_quote_price_rule_snapshot` compares
 * `str(source.get(field) or "")` against the frozen string. Two consequences that are very easy
 * to get wrong by hand: a zero (or null) reads as the empty string, and an integral float
 * stringifies with a trailing ".0" in Python but without one in JavaScript.
 */
function frozenSourceValue(value) {
  if (value === null || value === undefined || value === "" || value === 0) return "";
  if (typeof value === "number") return Number.isInteger(value) ? `${value}.0` : String(value);
  return String(value);
}

function money(amount) {
  return Number(amount.toFixed(2));
}

function frappeTimestamp(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

class Frappe {
  constructor({ baseUrl, apiKey, apiSecret }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authorization = `token ${apiKey}:${apiSecret}`;
  }

  async request(method, path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: this.authorization,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      // Frappe puts the PolicyViolation message in _server_messages or exception; surface the
      // deterministic code rather than a wall of HTML.
      const messages = [];
      try {
        for (const raw of JSON.parse(parsed?._server_messages ?? "[]")) {
          messages.push(JSON.parse(raw).message ?? String(raw));
        }
      } catch {
        /* not a server-message payload */
      }
      const detail = messages.join("; ") || parsed?.exception || text.slice(0, 400);
      throw new Error(`${method} ${path} -> ${response.status}: ${detail}`);
    }
    return parsed?.data;
  }

  get(doctype, name, fields) {
    const query = fields ? `?fields=${encodeURIComponent(JSON.stringify(fields))}` : "";
    return this.request("GET", `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}${query}`);
  }

  insert(doctype, document) {
    return this.request("POST", `/api/resource/${encodeURIComponent(doctype)}`, document);
  }

  update(doctype, name, patch) {
    return this.request("PUT", `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, patch);
  }
}

const options = parseArgs(process.argv.slice(2));
const asJson = options.has("--json");
const say = (message) => {
  if (!asJson) console.log(message);
};

const baseUrl = options.get("--base-url") ?? process.env.ERPNEXT_BASE_URL ?? devVar("ERPNEXT_BASE_URL") ?? "http://localhost:8000";
const apiKey = options.get("--api-key") ?? process.env.ERPNEXT_API_KEY ?? devVar("ERPNEXT_API_KEY");
const apiSecret = options.get("--api-secret") ?? process.env.ERPNEXT_API_SECRET ?? devVar("ERPNEXT_API_SECRET");
if (!apiKey || !apiSecret) {
  fail(
    "no Frappe credentials: run `npm run dev --prefix workers-bus` once so predev writes them into " +
      "workers-bus/.dev.vars, or pass --api-key/--api-secret",
  );
}

const roofJobId = options.get("--roof-job");
if (!roofJobId) {
  fail("--roof-job is required (create one through POST /ingest/estimate, not by hand)");
}
const prefix = options.get("--prefix") ?? "fixture";
if (!/^[a-z0-9][a-z0-9._:-]{0,40}$/.test(prefix)) {
  fail("--prefix must be a short lowercase slug");
}
const subtotal = Number(options.get("--subtotal") ?? "20000");
const taxRate = Number(options.get("--tax-rate") ?? "5");
if (!Number.isFinite(subtotal) || subtotal < 0) fail("--subtotal must be a nonnegative number");
if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) fail("--tax-rate must be 0-100");

const frappe = new Frappe({ baseUrl, apiKey, apiSecret });
const now = new Date();
const stamp = frappeTimestamp(now);
const today = stamp.slice(0, 10);
const currency = options.get("--currency") ?? "CAD";
const approver = options.get("--approved-by") ?? "Administrator";

const taxAmount = money(subtotal * (taxRate / 100));
const quoteTotal = money(subtotal + taxAmount);
const depositAmount = money(quoteTotal * 0.25);

const ruleId = `price:${prefix}-${Date.now().toString(36)}`;
const quoteId = `quote:${prefix}-${Date.now().toString(36)}`;

try {
  say(`Frappe ${baseUrl}`);

  // 0. The Roof Job must already exist, and it names the customer the quote must stay with.
  const job = await frappe.get("Roof Job", roofJobId, ["name", "customer", "job_status"]);
  const customer = options.get("--customer") ?? job?.customer;
  if (!customer) {
    fail(`Roof Job ${roofJobId} has no customer; pass --customer explicitly`);
  }
  say(`  roof job ${job.name} (${job.job_status}) -> customer ${customer}`);

  // 1. A Price Book Rule the snapshot can bind. Draft first, then Approved, so the update path
  //    (`_previous` present) is the one exercised - the same order an estimator would use.
  await frappe.insert("Price Book Rule", {
    price_rule_id: ruleId,
    rule_name: `${prefix} metal roofing supply and install`,
    rule_type: "Material",
    status: "Draft",
    service_type: "Roof",
    material_system: "Standing Seam Metal",
    unit: "SQ",
    unit_cost: 800,
    unit_price: 1250,
    minimum_quantity: 1,
    currency,
    source_ref: `local-fixture:${prefix}`,
    rule_json: JSON.stringify({
      schema_version: "ironwrap.price-rule.v1",
      operation: "quantity_times_unit_price",
      rounding: "half_up_cent",
    }),
    effective_from: today,
    effective_to: "2099-12-31",
    assumptions: "Synthetic local fixture; no real supplier pricing.",
    exclusions: "Synthetic local fixture; not a quotable rate.",
  });
  await frappe.update("Price Book Rule", ruleId, {
    status: "Approved",
    approved_by: approver,
    approved_at: stamp,
    approval_note: "Local fixture approval (tools/local-approved-quote-fixture.mjs).",
  });
  say(`  price book rule ${ruleId} Draft -> Approved`);

  // 2. Freeze the rule from what Frappe reads back, not from what we sent: the snapshot has to
  //    match `str(source.get(field) or "")` for the source row exactly.
  const source = await frappe.get("Price Book Rule", ruleId);
  const frozenRule = {
    price_rule_id: ruleId,
    status: "Approved",
    rule_json: JSON.parse(source.rule_json),
  };
  for (const field of [
    "rule_name",
    "rule_type",
    "service_type",
    "material_system",
    "unit",
    "unit_cost",
    "unit_price",
    "minimum_quantity",
    "currency",
    "source_ref",
    "effective_from",
    "effective_to",
    "assumptions",
    "exclusions",
    "approved_by",
    "approved_at",
  ]) {
    frozenRule[field] = frozenSourceValue(source[field]);
  }

  // 3. The quote, Draft, carrying everything. `price_rule_snapshot_json` can only be bound
  //    while Draft or Needs Review, and `qb_terms_due_days` goes in here for the reason in the
  //    header. The approval writes below then only move `status`.
  const snapshot = {
    quote: {
      customer_quote_id: quoteId,
      quote_version: 1,
      price_book_version: `${prefix}-v1`,
      pricing_effective_at: stamp,
    },
    captured_at: stamp,
    rules: [frozenRule],
  };
  await frappe.insert("Customer Quote", {
    customer_quote_id: quoteId,
    roof_job: roofJobId,
    customer,
    quote_version: 1,
    status: "Draft",
    price_book_version: `${prefix}-v1`,
    pricing_effective_at: stamp,
    price_rule_snapshot_json: JSON.stringify(snapshot),
    subtotal,
    tax_amount: taxAmount,
    tax_code: "GST",
    tax_rate: taxRate,
    tax_policy_snapshot_json: JSON.stringify({
      source: "local-development-stand-in",
      country: "CA",
      province: "AB",
      tax_code: "GST",
      tax_rate: taxRate,
      captured_at: stamp,
    }),
    quote_total: quoteTotal,
    currency,
    deposit_amount: depositAmount,
    amount_due: depositAmount,
    amount_paid: 0,
    balance_due: quoteTotal,
    payment_status: "Not Due",
    payment_truth_source: "local-fixture",
    payment_truth_at: stamp,
    qb_item_ref: "1",
    qb_tax_code_ref: "2",
    qb_terms_ref: "3",
    qb_terms_due_days: 30,
    scope_summary: "Synthetic local fixture: metal roof replacement, supply and install.",
    assumptions: "Synthetic local fixture; not a real commercial commitment.",
    exclusions: "Synthetic local fixture; excludes everything not listed.",
    quote_summary_json: JSON.stringify({
      schema_version: "ironwrap.local-fixture.v1",
      lines: [{ price_rule_id: ruleId, quantity: 16, unit: "SQ", line_total: subtotal }],
    }),
    prepared_at: stamp,
    valid_until: "2099-12-31",
  });
  say(`  customer quote ${quoteId} inserted Draft (snapshot bound, terms due days set)`);

  // 4. The real lifecycle: Draft -> Needs Review -> Approved.
  await frappe.update("Customer Quote", quoteId, { status: "Needs Review" });
  say("  customer quote Draft -> Needs Review");
  await frappe.update("Customer Quote", quoteId, {
    status: "Approved",
    approved_by: approver,
    approved_at: stamp,
  });
  say("  customer quote Needs Review -> Approved");

  const approved = await frappe.get("Customer Quote", quoteId, [
    "name",
    "status",
    "roof_job",
    "customer",
    "quote_total",
    "deposit_amount",
    "currency",
    "qb_terms_due_days",
    "approved_at",
  ]);
  if (approved.status !== "Approved") {
    fail(`quote ended in ${approved.status}, not Approved`);
  }
  const result = {
    customer_quote_id: quoteId,
    price_rule_id: ruleId,
    roof_job: roofJobId,
    customer,
    status: approved.status,
    quote_total: approved.quote_total,
    deposit_amount: approved.deposit_amount,
    currency: approved.currency,
    qb_terms_due_days: approved.qb_terms_due_days,
  };
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `ok Approved Customer Quote ${quoteId} on ${roofJobId}: ` +
        `${approved.quote_total} ${approved.currency} (deposit ${approved.deposit_amount})`,
    );
  }
} catch (error) {
  fail(error.message);
}
