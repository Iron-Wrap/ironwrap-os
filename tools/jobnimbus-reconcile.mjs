#!/usr/bin/env node
// jobnimbus-reconcile.mjs — post-import reconciliation of a JobNimbus snapshot against Frappe.
//
// Answers, with numbers: did every exported JobNimbus record land exactly once in Frappe,
// what stayed unmapped, and are there collisions? Read-only against both inputs (snapshot
// files on disk; GET-only against the local Frappe). Verdict is written to
// output/jobnimbus-reconcile/<ts>/verdict.md — aggregate counts and field names only, no
// row contents, so the numbers can be quoted in a PR or Linear without carrying PII.
//
// Usage:
//   ERPNEXT_API_KEY=... ERPNEXT_API_SECRET=... node tools/jobnimbus-reconcile.mjs \
//     [--snapshot output/jobnimbus-export/<ts>]

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

// Fields the phase-1 import maps out of each JobNimbus entity — keep in lockstep with
// tools/jobnimbus-import.mjs and docs/JOBNIMBUS-MIGRATION-MAP.md. Everything else in the
// snapshot schema is either archived verbatim in Lead Envelope.payload_json or explicitly
// out of phase-1 scope; the inventory below makes that set visible per run.
const MAPPED_FIELDS = {
  contacts: [
    "jnid", "display_name", "company", "first_name", "last_name", "email",
    "mobile_phone", "home_phone", "work_phone", "phone",
    "address_line1", "city", "state_text", "zip", "country_name",
    "description", "date_created",
  ],
  jobs: [
    "jnid", "number", "name", "description", "record_type_name", "status_name",
    "tags", "related", "date_created",
  ],
  activities: ["jnid", "record_type", "is_status_change", "note", "related", "date_created"],
};

function parseArgs(argv) {
  const args = { snapshot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--snapshot") args.snapshot = String(argv[++i] ?? "");
    else if (a === "--help" || a === "-h") { console.log("node tools/jobnimbus-reconcile.mjs [--snapshot DIR]"); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

function frappeConfig() {
  const base = (process.env.ERPNEXT_BASE_URL ?? "http://localhost:8000").replace(/\/+$/, "");
  const key = process.env.ERPNEXT_API_KEY ?? "";
  const secret = process.env.ERPNEXT_API_SECRET ?? "";
  if (!key || !secret) { console.error("ERPNEXT_API_KEY and ERPNEXT_API_SECRET are required."); process.exit(2); }
  const host = new URL(base).hostname;
  if (!["localhost", "127.0.0.1", "::1", "ironwrap.localhost"].includes(host)) {
    console.error(`Refusing non-local Frappe target (${host}) — see docs/JOBNIMBUS-MIGRATION-MAP.md phase gating.`);
    process.exit(2);
  }
  return { base, key, secret };
}

async function frappe(cfg, path) {
  const res = await fetch(cfg.base + path, {
    headers: { accept: "application/json", authorization: `token ${cfg.key}:${cfg.secret}` },
  });
  if (!res.ok) throw new Error(`frappe_http_${res.status} GET ${path}: ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

const enc = encodeURIComponent;

async function listAll(cfg, doctype, fields) {
  const out = [];
  const pageSize = 200;
  for (let start = 0; ; start += pageSize) {
    const json = await frappe(cfg, `/api/resource/${enc(doctype)}?fields=${enc(JSON.stringify(fields))}&limit_page_length=${pageSize}&limit_start=${start}`);
    const rows = Array.isArray(json?.data) ? json.data : [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

function newestSnapshotDir() {
  const root = join(REPO_ROOT, "output", "jobnimbus-export");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root)
    .map((d) => join(root, d))
    .filter((d) => statSync(d).isDirectory() && existsSync(join(d, "manifest.json")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

function ndjsonIds(dir, name, pick) {
  const file = join(dir, `${name}.ndjson`);
  if (!existsSync(file)) return [];
  const ids = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const id = pick ? pick(row) : row.jnid;
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
}

function dupes(values) {
  const seen = new Set();
  const out = new Set();
  for (const v of values) {
    if (v == null || v === "") continue;
    if (seen.has(v)) out.add(v);
    seen.add(v);
  }
  return [...out];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = frappeConfig();
  const snapDir = args.snapshot ? resolve(REPO_ROOT, args.snapshot) : newestSnapshotDir();
  if (!snapDir || !existsSync(join(snapDir, "manifest.json"))) {
    console.error("No snapshot found. Run tools/jobnimbus-export.mjs first (or pass --snapshot DIR).");
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(join(snapDir, "manifest.json"), "utf8"));

  // Snapshot side
  const contactIds = ndjsonIds(snapDir, "contacts");
  const jobIds = ndjsonIds(snapDir, "jobs");
  const noteIds = ndjsonIds(snapDir, "activities", (r) => (r.record_type === 1 && r.is_status_change !== true && r.note ? r.jnid : null));

  // Frappe side (single paginated pulls, then set math locally)
  const envelopes = await listAll(cfg, "Lead Envelope", ["name", "jobnimbus_contact_id", "jobnimbus_job_id"]);
  const customers = await listAll(cfg, "Roofing Customer", ["name", "lead_envelope"]);
  const roofJobs = await listAll(cfg, "Roof Job", ["name", "roof_job_id", "jobnimbus_job_id", "job_number"]);
  const comments = await listAll(cfg, "Comment", ["name", "subject"]);

  const envByContact = new Map(envelopes.filter((e) => e.jobnimbus_contact_id).map((e) => [e.jobnimbus_contact_id, e.name]));
  const customersByEnvelope = new Map(customers.filter((c) => c.lead_envelope).map((c) => [c.lead_envelope, c.name]));
  const jobsByJnid = new Map(roofJobs.filter((j) => j.jobnimbus_job_id).map((j) => [j.jobnimbus_job_id, j.name]));
  const commentMarkers = new Set(comments.map((c) => c.subject).filter((s) => typeof s === "string" && s.startsWith("[jn:")));

  const missingContacts = contactIds.filter((id) => {
    const env = envByContact.get(id);
    return !(env && customersByEnvelope.has(env));
  });
  const missingJobs = jobIds.filter((id) => !jobsByJnid.has(id));
  const missingNotes = noteIds.filter((id) => !commentMarkers.has(`[jn:${id}]`));

  const collisions = {
    duplicate_snapshot_contact_jnids: dupes(contactIds),
    duplicate_snapshot_job_jnids: dupes(jobIds),
    frappe_envelopes_sharing_contact_id: dupes(envelopes.map((e) => e.jobnimbus_contact_id)),
    frappe_jobs_sharing_job_id: dupes(roofJobs.map((j) => j.jobnimbus_job_id)),
    frappe_jobs_sharing_job_number: dupes(roofJobs.map((j) => j.job_number)),
  };
  const collisionCount = Object.values(collisions).reduce((a, v) => a + v.length, 0);

  // Unmapped-field inventory from the snapshot manifest's observed schema
  const unmapped = {};
  for (const [entity, mapped] of Object.entries(MAPPED_FIELDS)) {
    const schema = manifest.entities?.find?.((e) => e.entity === entity)?.schema ?? {};
    unmapped[entity] = Object.keys(schema).filter((f) => !mapped.includes(f)).sort();
  }

  const green = missingContacts.length === 0 && missingJobs.length === 0 && missingNotes.length === 0 && collisionCount === 0;
  const verdict = {
    snapshot_dir: relative(REPO_ROOT, snapDir),
    snapshot_synthetic: !!manifest.synthetic,
    target: cfg.base,
    generated_at: new Date().toISOString(),
    counts: {
      snapshot: { contacts: contactIds.length, jobs: jobIds.length, user_notes: noteIds.length },
      frappe: {
        lead_envelopes_with_jn_contact_id: envByContact.size,
        roofing_customers_linked: [...envByContact.values()].filter((env) => customersByEnvelope.has(env)).length,
        roof_jobs_with_jn_job_id: jobsByJnid.size,
        imported_note_comments: commentMarkers.size,
      },
      missing: { contacts: missingContacts.length, jobs: missingJobs.length, notes: missingNotes.length },
    },
    missing_ids_sample: {
      contacts: missingContacts.slice(0, 10),
      jobs: missingJobs.slice(0, 10),
      notes: missingNotes.slice(0, 10),
    },
    collisions,
    unmapped_fields: unmapped,
    verdict: green ? "GREEN" : "RED",
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(REPO_ROOT, "output", "jobnimbus-reconcile", stamp);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n");

  const md = [
    `# JobNimbus -> Frappe reconciliation verdict: ${verdict.verdict}`,
    "",
    `- Snapshot: \`${verdict.snapshot_dir}\`${verdict.snapshot_synthetic ? " (synthetic fixture)" : ""}`,
    `- Target: \`${verdict.target}\` - Generated: ${verdict.generated_at}`,
    "",
    "| Entity | Snapshot | In Frappe | Missing |",
    "|---|---:|---:|---:|",
    `| Contacts -> Lead Envelope + Roofing Customer | ${contactIds.length} | ${verdict.counts.frappe.roofing_customers_linked} | ${missingContacts.length} |`,
    `| Jobs -> Roof Job | ${jobIds.length} | ${jobsByJnid.size} | ${missingJobs.length} |`,
    `| User notes -> Comment | ${noteIds.length} | ${commentMarkers.size} | ${missingNotes.length} |`,
    "",
    `Collisions: ${collisionCount === 0 ? "none" : JSON.stringify(collisions)}`,
    "",
    "Unmapped snapshot fields (archived in Lead Envelope.payload_json, not projected):",
    ...Object.entries(unmapped).map(([e, fs]) => `- ${e}: ${fs.length ? fs.join(", ") : "(none)"}`),
  ].join("\n");
  writeFileSync(join(runDir, "verdict.md"), md + "\n");

  console.log(md);
  console.log(`\nwritten: ${relative(REPO_ROOT, runDir)}/verdict.{md,json}`);
  process.exit(green ? 0 : 1);
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
