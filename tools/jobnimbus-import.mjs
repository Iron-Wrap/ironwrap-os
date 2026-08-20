#!/usr/bin/env node
// jobnimbus-import.mjs — idempotent import of a JobNimbus snapshot into Frappe (ironwrap_roofing).
//
// Phase-1 (migration readiness) tool: it targets a LOCAL Frappe only and refuses anything else.
// Pointing it at production is a phase-3 flip decision that stays human-gated
// (docs/JOBNIMBUS-MIGRATION-MAP.md). JobNimbus itself is never touched — input is the
// tools/jobnimbus-export.mjs snapshot on disk.
//
// Usage:
//   ERPNEXT_API_KEY=... ERPNEXT_API_SECRET=... [ERPNEXT_BASE_URL=http://localhost:8000] \
//     node tools/jobnimbus-import.mjs [--snapshot output/jobnimbus-export/<ts>] [--execute]
//
// Default is DRY-RUN: it plans every row, writes the ledger, and performs zero writes.
// Re-running with --execute is safe: every write is an upsert keyed on the preserved
// JobNimbus id (jnid), and records already created by the live dual-write bridge are
// ADOPTED (matched via their jobnimbus_* reference fields), never duplicated.
//
// Mapping contract: docs/JOBNIMBUS-MIGRATION-MAP.md. Ledger: output/jobnimbus-import/<ts>/.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

// ── args / env ────────────────────────────────────────────────────────────────

function usage() {
  console.log(`Usage: ERPNEXT_API_KEY=... ERPNEXT_API_SECRET=... node tools/jobnimbus-import.mjs
  --snapshot DIR   snapshot directory (default: newest under output/jobnimbus-export)
  --execute        perform writes (default: dry-run, plan + ledger only)
  --entities a,b   subset of contacts,jobs,notes (default: all three)
  --limit N        stop after N rows per entity (smoke runs)`);
}

function parseArgs(argv) {
  const args = { snapshot: null, execute: false, entities: ["contacts", "jobs", "notes"], limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--snapshot") args.snapshot = String(argv[++i] ?? "");
    else if (a === "--execute") args.execute = true;
    else if (a === "--entities") args.entities = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--limit") args.limit = Math.max(1, Number(argv[++i]) || Infinity);
    else { console.error(`Unknown argument: ${a}`); usage(); process.exit(2); }
  }
  const known = new Set(["contacts", "jobs", "notes"]);
  for (const e of args.entities) if (!known.has(e)) { console.error(`Unknown entity: ${e}`); process.exit(2); }
  return args;
}

function frappeConfig() {
  const base = (process.env.ERPNEXT_BASE_URL ?? "http://localhost:8000").replace(/\/+$/, "");
  const key = process.env.ERPNEXT_API_KEY ?? "";
  const secret = process.env.ERPNEXT_API_SECRET ?? "";
  if (!key || !secret) {
    console.error("ERPNEXT_API_KEY and ERPNEXT_API_SECRET are required (local integration pair from workers-bus/.dev.vars).");
    process.exit(2);
  }
  let host;
  try { host = new URL(base).hostname; } catch { console.error(`Invalid ERPNEXT_BASE_URL: ${base}`); process.exit(2); }
  if (!["localhost", "127.0.0.1", "::1", "ironwrap.localhost"].includes(host)) {
    console.error(`Refusing non-local Frappe target (${host}). Phase 1 is migration readiness; importing into a shared or production site is a phase-3 flip decision and stays human-gated (docs/JOBNIMBUS-MIGRATION-MAP.md).`);
    process.exit(2);
  }
  return { base, key, secret };
}

// ── snapshot loading ──────────────────────────────────────────────────────────

function newestSnapshotDir() {
  const root = join(REPO_ROOT, "output", "jobnimbus-export");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root)
    .map((d) => join(root, d))
    .filter((d) => statSync(d).isDirectory() && existsSync(join(d, "manifest.json")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

function readNdjson(dir, name) {
  const file = join(dir, `${name}.ndjson`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ── Frappe REST (upsert primitives mirror workers-bus/src/erpnext.ts) ─────────

async function frappe(cfg, method, path, body) {
  const res = await fetch(cfg.base + path, {
    method,
    headers: {
      accept: "application/json",
      authorization: `token ${cfg.key}:${cfg.secret}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`frappe_http_${res.status} ${method} ${path}: ${(await res.text()).slice(0, 400)}`);
  return await res.json();
}

const enc = encodeURIComponent;

async function findByField(cfg, doctype, field, value) {
  if (!value) return null;
  const filters = enc(JSON.stringify([[doctype, field, "=", value]]));
  const json = await frappe(cfg, "GET", `/api/resource/${enc(doctype)}?filters=${filters}&fields=${enc('["name"]')}&limit_page_length=2`);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows[0]?.name ?? null;
}

async function listAll(cfg, doctype, fields, filters) {
  const out = [];
  const pageSize = 200;
  for (let start = 0; ; start += pageSize) {
    const qs = [
      `fields=${enc(JSON.stringify(fields))}`,
      filters ? `filters=${enc(JSON.stringify(filters))}` : null,
      `limit_page_length=${pageSize}`,
      `limit_start=${start}`,
    ].filter(Boolean).join("&");
    const json = await frappe(cfg, "GET", `/api/resource/${enc(doctype)}?${qs}`);
    const rows = Array.isArray(json?.data) ? json.data : [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

// ── field transforms (contract: docs/JOBNIMBUS-MIGRATION-MAP.md) ──────────────

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const iso = (unix) => (typeof unix === "number" && unix > 0 ? new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19) : undefined);

/**
 * JobNimbus workflow status → Roof Job.job_status select. Unmapped falls back to Qualified
 * and is ledgered. Two Roof Job statuses are POLICY-GATED (domain_policy._validate_roof_job):
 * "In Production" and "Closed" require real Production Gate State rows, which a migration must
 * never fabricate. Those imports are CAPPED at the nearest pre-gate status (Won / Completed),
 * the true JobNimbus status is ledgered as status_capped, and advancing through the gates stays
 * phase-2+ owned-workflow work. "Won"/"Completed" require the locale policy snapshot, which the
 * importer supplies from config/tenants/ironwrap.json (the operative tenant locale truth).
 */
const JOB_STATUS_MAP = {
  "lead": "Qualified",
  "new": "Qualified",
  "qualified": "Qualified",
  "measurement": "Measurement",
  "inspection": "Measurement",
  "estimating": "Proposal",
  "estimate": "Proposal",
  "proposal": "Proposal",
  "proposal sent": "Proposal",
  "quote": "Proposal",
  "signed": "Won",
  "sold": "Won",
  "won": "Won",
  "approved": "Won",
  "scheduled": "In Production",
  "in progress": "In Production",
  "in production": "In Production",
  "work in progress": "In Production",
  "completed": "Completed",
  "complete": "Completed",
  "job completed": "Completed",
  "invoiced": "Completed",
  "paid": "Closed",
  "closed": "Closed",
  "lost": "Lost",
  "dead": "Lost",
  "cancelled": "Lost",
  "canceled": "Lost",
};

const STATUS_ORDER = ["Qualified", "Measurement", "Proposal", "Won", "In Production", "Completed", "Closed"];
const GATED_STATUS_CAP = { "In Production": "Won", "Closed": "Completed" };
const LOCALE_GATED = new Set(["Won", "Completed"]);

function mapJobStatus(statusName) {
  const key = (str(statusName) ?? "").toLowerCase();
  const mapped = JOB_STATUS_MAP[key] ?? "Qualified";
  const importable = GATED_STATUS_CAP[mapped] ?? mapped;
  return { importable, mapped, capped: importable !== mapped, unmapped: !(key in JOB_STATUS_MAP), raw: statusName ?? null };
}

let localePolicyCache;
/** Operative locale policy from the tenant contract — the same truth owned flows snapshot. */
function localePolicy() {
  if (!localePolicyCache) {
    const tenant = JSON.parse(readFileSync(join(REPO_ROOT, "config", "tenants", "ironwrap.json"), "utf8"));
    const locale = tenant.locale ?? {};
    const tax = locale.tax ?? {};
    const country = str(tax.country_code) ?? "CA";
    const province = str(tax.province_code) ?? "AB";
    localePolicyCache = {
      version: `${country.toLowerCase()}-${province.toLowerCase()}-2026-01`,
      snapshot: JSON.stringify({
        country,
        province,
        language_tag: locale.language_tag ?? null,
        currency: locale.currency ?? null,
        timezone: locale.timezone ?? null,
        gst_rate_bps: tax.gst_rate_bps ?? null,
        provincial_sales_tax_rate_bps: tax.provincial_sales_tax_rate_bps ?? null,
      }),
    };
  }
  return localePolicyCache;
}

function serviceTypeOf(row) {
  const text = `${str(row.name) ?? ""} ${str(row.description) ?? ""} ${str(row.record_type_name) ?? ""}`.toLowerCase();
  if (text.includes("metal")) return "Metal Roofing";
  if (text.includes("siding")) return "Siding";
  if (text.includes("gutter")) return "Gutters";
  if (text.includes("soffit") || text.includes("fascia")) return "Soffit/Fascia";
  if (text.includes("commercial")) return "Commercial";
  if (text.includes("roof")) return "Roofing";
  return "Other";
}

function brandOf(row) {
  const tags = Array.isArray(row.tags) ? row.tags : [];
  for (const t of tags) {
    const m = /^brand:(ironwrap|iroof)$/.exec(String(t));
    if (m) return m[1];
  }
  return "ironwrap"; // JobNimbus predates the iroof split; default per mapping doc
}

function phoneOf(row) {
  return str(row.mobile_phone) ?? str(row.home_phone) ?? str(row.work_phone) ?? str(row.phone);
}

function relatedContactId(row) {
  const rel = Array.isArray(row.related) ? row.related : [];
  const c = rel.find((r) => r && (r.type === "contact" || r.type === "Contact"));
  return str(c?.id);
}

// ── import passes ─────────────────────────────────────────────────────────────

function makeLedger(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "ledger.ndjson");
  writeFileSync(file, "");
  const counts = {};
  return {
    file,
    log(entry) {
      appendFileSync(file, JSON.stringify(entry) + "\n");
      const k = `${entry.entity}:${entry.action}`;
      counts[k] = (counts[k] ?? 0) + 1;
    },
    counts,
  };
}

async function importContacts(cfg, rows, ledger, { execute, limit }) {
  let n = 0;
  for (const row of rows) {
    if (++n > limit) break;
    const jnid = str(row.jnid);
    if (!jnid) { ledger.log({ entity: "contacts", action: "error", reason: "missing_jnid" }); continue; }
    try {
      // 1) Lead Envelope — archive + external-reference anchor. Adopt a bridge-created one when present.
      let envelopeName = await findByField(cfg, "Lead Envelope", "jobnimbus_contact_id", jnid);
      const envelopeAdopted = !!envelopeName;
      if (!envelopeName) {
        const envelopeId = `jn:${jnid}`;
        envelopeName = await findByField(cfg, "Lead Envelope", "envelope_id", envelopeId);
        if (!envelopeName) {
          if (execute) {
            await frappe(cfg, "POST", "/api/resource/Lead%20Envelope", {
              envelope_id: envelopeId,
              source: "manual",
              event_ts: iso(row.date_created) ?? iso(Math.floor(Date.now() / 1000)),
              status: "reconciled",
              contact_name: str(row.display_name),
              contact_phone: phoneOf(row),
              contact_email: str(row.email),
              jobnimbus_contact_id: jnid,
              raw_key: `jobnimbus-export:contacts:${jnid}`,
              payload_json: JSON.stringify(row), // archive-only home for unmapped JobNimbus fields
            });
          }
          envelopeName = envelopeId;
          ledger.log({ entity: "contacts", action: execute ? "created" : "plan_created", target: "Lead Envelope", name: envelopeId, jnid });
        }
      }

      // 2) Roofing Customer — adopt the bridge-created customer hanging off an adopted envelope.
      let customerName = envelopeAdopted ? await findByField(cfg, "Roofing Customer", "lead_envelope", envelopeName) : null;
      let action = customerName ? "adopted" : null;
      if (!customerName) {
        const customerId = `jn-${jnid}`;
        customerName = await findByField(cfg, "Roofing Customer", "customer_id", customerId);
        action = customerName ? "updated" : "created";
        const body = {
          display_name: str(row.display_name) ?? str(row.company) ?? `JobNimbus contact ${jnid}`,
          customer_type: str(row.company) ? "Company" : "Homeowner",
          first_name: str(row.first_name),
          last_name: str(row.last_name),
          phone: phoneOf(row),
          email: str(row.email),
          lead_envelope: envelopeName,
          notes: str(row.description),
        };
        if (execute) {
          if (customerName) await frappe(cfg, "PUT", `/api/resource/Roofing%20Customer/${enc(customerName)}`, body);
          else await frappe(cfg, "POST", "/api/resource/Roofing%20Customer", { customer_id: customerId, ...body });
        }
        customerName = customerName ?? customerId;
      }
      ledger.log({ entity: "contacts", action: execute ? action : `plan_${action}`, target: "Roofing Customer", name: customerName, jnid });

      // 3) Roofing Property — only when the contact carries a service address.
      const hasAddress = str(row.address_line1) || str(row.city) || str(row.zip);
      if (hasAddress) {
        const propertyKey = `jn-contact-${jnid}`;
        const existing = await findByField(cfg, "Roofing Property", "property_key", propertyKey);
        const body = {
          lead_envelope: envelopeName,
          customer: customerName,
          address_line1: str(row.address_line1),
          city: str(row.city),
          province: str(row.state_text),
          postal_code: str(row.zip),
          country: str(row.country_name) ?? "Canada",
        };
        if (execute) {
          if (existing) await frappe(cfg, "PUT", `/api/resource/Roofing%20Property/${enc(existing)}`, body);
          else await frappe(cfg, "POST", "/api/resource/Roofing%20Property", { property_key: propertyKey, ...body });
        }
        ledger.log({ entity: "contacts", action: execute ? (existing ? "updated" : "created") : `plan_${existing ? "updated" : "created"}`, target: "Roofing Property", name: propertyKey, jnid });
      }
    } catch (e) {
      ledger.log({ entity: "contacts", action: "error", jnid, reason: String(e?.message ?? e).slice(0, 300) });
    }
  }
}

async function importJobs(cfg, rows, ledger, { execute, limit }) {
  let n = 0;
  for (const row of rows) {
    if (++n > limit) break;
    const jnid = str(row.jnid);
    if (!jnid) { ledger.log({ entity: "jobs", action: "error", reason: "missing_jnid" }); continue; }
    try {
      const contactJnid = relatedContactId(row);
      // Adopt a bridge-created Roof Job carrying this JobNimbus job id; otherwise upsert jn-<jnid>.
      let name = await findByField(cfg, "Roof Job", "jobnimbus_job_id", jnid);
      let action = name ? "adopted" : null;
      if (!name) {
        const roofJobId = `jn-${jnid}`;
        name = await findByField(cfg, "Roof Job", "roof_job_id", roofJobId);
        action = name ? "updated" : "created";
        name = name ?? roofJobId;
      }
      const { importable, mapped, capped, unmapped, raw } = mapJobStatus(row.status_name);
      if (unmapped) ledger.log({ entity: "jobs", action: "status_unmapped", jnid, raw_status: raw, fallback: importable });
      if (capped) ledger.log({ entity: "jobs", action: "status_capped", jnid, raw_status: raw, mapped_status: mapped, imported_as: importable, reason: "production_gates_never_fabricated" });

      const envelopeName = contactJnid
        ? (await findByField(cfg, "Lead Envelope", "jobnimbus_contact_id", contactJnid)) ?? (await findByField(cfg, "Lead Envelope", "envelope_id", `jn:${contactJnid}`))
        : null;
      const customerName = envelopeName ? await findByField(cfg, "Roofing Customer", "lead_envelope", envelopeName) : null;
      const propertyName = contactJnid ? await findByField(cfg, "Roofing Property", "property_key", `jn-contact-${contactJnid}`) : null;

      const body = {
        job_number: row.number != null ? String(row.number) : undefined,
        brand: brandOf(row),
        service_type: serviceTypeOf(row),
        job_status: importable,
        lead_envelope: envelopeName ?? undefined,
        roofing_property: propertyName ?? undefined,
        customer: customerName ?? undefined,
        jobnimbus_contact_id: contactJnid,
        jobnimbus_job_id: jnid,
      };
      if (LOCALE_GATED.has(importable)) {
        // Won/Completed require the locale policy snapshot (domain policy). Supplied at create;
        // on update only when absent — the fields are write-once.
        body.workflow_profile = "Residential Retail";
        body.locale_policy_version = localePolicy().version;
        body.locale_policy_snapshot_json = localePolicy().snapshot;
      }
      if (execute) {
        if (action === "created") await frappe(cfg, "POST", "/api/resource/Roof%20Job", { roof_job_id: name, ...body });
        else {
          // Never regress an existing record, never resurrect a Lost one, never touch
          // write-once fields that are already set.
          const current = (await frappe(cfg, "GET", `/api/resource/Roof%20Job/${enc(name)}`)).data ?? {};
          let statusDecision = "apply";
          if (current.job_status === importable) statusDecision = "same";
          else if (current.job_status === "Lost") statusDecision = "conflict_existing_lost";
          else if (importable !== "Lost" && STATUS_ORDER.indexOf(importable) <= STATUS_ORDER.indexOf(current.job_status)) statusDecision = "behind";
          if (statusDecision !== "apply") delete body.job_status;
          if (statusDecision === "conflict_existing_lost") {
            ledger.log({ entity: "jobs", action: "status_conflict", jnid, frappe_status: "Lost", jobnimbus_status: raw, resolution: "kept_frappe_lost" });
          }
          const effectiveStatus = body.job_status ?? current.job_status;
          if (current.workflow_profile) delete body.workflow_profile;
          if (current.locale_policy_version || !LOCALE_GATED.has(effectiveStatus)) {
            delete body.workflow_profile;
            delete body.locale_policy_version;
            delete body.locale_policy_snapshot_json;
          }
          await frappe(cfg, "PUT", `/api/resource/Roof%20Job/${enc(name)}`, body);
        }
        // Mirror the job id onto the envelope so the pair is navigable from both ends.
        if (envelopeName) await frappe(cfg, "PUT", `/api/resource/Lead%20Envelope/${enc(envelopeName)}`, { jobnimbus_job_id: jnid, job_ref: name });
      }
      ledger.log({ entity: "jobs", action: execute ? action : `plan_${action}`, target: "Roof Job", name, jnid });
    } catch (e) {
      ledger.log({ entity: "jobs", action: "error", jnid, reason: String(e?.message ?? e).slice(0, 300) });
    }
  }
}

/** User-written notes (activities with record_type=1, not status changes) → Frappe Comment on the mapped record. */
async function importNotes(cfg, rows, ledger, { execute, limit }) {
  let n = 0;
  for (const row of rows) {
    const isNote = row.record_type === 1 && row.is_status_change !== true && str(row.note);
    if (!isNote) continue;
    if (++n > limit) break;
    const jnid = str(row.jnid) ?? `noid-${n}`;
    try {
      const rel = Array.isArray(row.related) ? row.related : [];
      let refDoctype = null;
      let refName = null;
      for (const r of rel) {
        const rid = str(r?.id);
        if (!rid) continue;
        const job = (await findByField(cfg, "Roof Job", "jobnimbus_job_id", rid)) ?? (await findByField(cfg, "Roof Job", "roof_job_id", `jn-${rid}`));
        if (job) { refDoctype = "Roof Job"; refName = job; break; }
        const envelope = (await findByField(cfg, "Lead Envelope", "jobnimbus_contact_id", rid)) ?? (await findByField(cfg, "Lead Envelope", "envelope_id", `jn:${rid}`));
        if (envelope) {
          const customer = await findByField(cfg, "Roofing Customer", "lead_envelope", envelope);
          if (customer) { refDoctype = "Roofing Customer"; refName = customer; break; }
        }
      }
      if (!refName) { ledger.log({ entity: "notes", action: "skipped", jnid, reason: "no_mapped_parent" }); continue; }

      const marker = `[jn:${jnid}]`;
      const existing = await findByField(cfg, "Comment", "subject", marker);
      if (existing) { ledger.log({ entity: "notes", action: "skipped", jnid, reason: "already_imported" }); continue; }
      if (execute) {
        await frappe(cfg, "POST", "/api/resource/Comment", {
          comment_type: "Comment",
          subject: marker,
          reference_doctype: refDoctype,
          reference_name: refName,
          content: `${marker} ${str(row.note)}`,
        });
      }
      ledger.log({ entity: "notes", action: execute ? "created" : "plan_created", target: `Comment on ${refDoctype}`, name: refName, jnid });
    } catch (e) {
      ledger.log({ entity: "notes", action: "error", jnid, reason: String(e?.message ?? e).slice(0, 300) });
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = frappeConfig();

  const snapDir = args.snapshot ? resolve(REPO_ROOT, args.snapshot) : newestSnapshotDir();
  if (!snapDir || !existsSync(join(snapDir, "manifest.json"))) {
    console.error("No snapshot found. Run tools/jobnimbus-export.mjs first (or pass --snapshot DIR).");
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(join(snapDir, "manifest.json"), "utf8"));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(REPO_ROOT, "output", "jobnimbus-import", stamp);
  const ledger = makeLedger(runDir);

  console.log(`snapshot: ${relative(REPO_ROOT, snapDir)}${manifest.synthetic ? " (SYNTHETIC fixture)" : ""}`);
  console.log(`target:   ${cfg.base} (${args.execute ? "EXECUTE" : "dry-run"})`);

  const contacts = readNdjson(snapDir, "contacts");
  const jobs = readNdjson(snapDir, "jobs");
  const activities = readNdjson(snapDir, "activities");

  if (args.entities.includes("contacts")) await importContacts(cfg, contacts, ledger, args);
  if (args.entities.includes("jobs")) await importJobs(cfg, jobs, ledger, args);
  if (args.entities.includes("notes")) await importNotes(cfg, activities, ledger, args);

  const summary = {
    tool: "tools/jobnimbus-import.mjs",
    snapshot_dir: relative(REPO_ROOT, snapDir),
    snapshot_synthetic: !!manifest.synthetic,
    target: cfg.base,
    mode: args.execute ? "execute" : "dry-run",
    generated_at: new Date().toISOString(),
    input_rows: { contacts: contacts.length, jobs: jobs.length, activities: activities.length },
    actions: ledger.counts,
  };
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary.actions, null, 2));
  console.log(`ledger: ${relative(REPO_ROOT, runDir)}/ledger.ndjson`);
  const errors = Object.entries(ledger.counts).filter(([k]) => k.endsWith(":error")).reduce((a, [, v]) => a + v, 0);
  if (errors > 0) { console.error(`${errors} row error(s) — see ledger`); process.exit(1); }
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
