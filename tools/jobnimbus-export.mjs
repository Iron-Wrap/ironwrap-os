#!/usr/bin/env node
// jobnimbus-export.mjs — read-only snapshot of JobNimbus records for the migration exit ramp.
//
// Doctrine (docs/JOBNIMBUS-MIGRATION-MAP.md): JobNimbus is strictly read-only. api1 has no
// DELETE, and this tool never issues anything but GET. One-way copy + freeze.
//
// Usage:
//   JOBNIMBUS_API_KEY=... node tools/jobnimbus-export.mjs [--entities contacts,jobs,...]
//     [--out output/jobnimbus-export] [--page-size 100] [--max-pages 200]
//
// Output: output/jobnimbus-export/<UTC timestamp>/<entity>.ndjson (one raw record per line)
// plus manifest.json (counts, date ranges, schema fingerprint — no row contents, no PII).
// The output directory is gitignored; snapshots must never be committed.
//
// API facts (live-verified in workers-bus/src/jobnimbus.ts and mined from Ilya's
// JobNimbus-MCP client):
//   base   https://app.jobnimbus.com/api1
//   auth   Authorization: Bearer <key>
//   lists  {count, results} — EXCEPT /activities which answers {count, activity}
//   page   ?size=N&from=OFFSET (size max 1000); sort_field/sort_direction supported
//   dates  unix seconds in date_created / date_updated

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const BASE = "https://app.jobnimbus.com/api1";
const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

// Paginated list endpoints. `key` = response property that carries rows when not `results`.
const ENTITIES = {
  contacts: { path: "contacts" },
  jobs: { path: "jobs" },
  activities: { path: "activities", key: "activity" },
  tasks: { path: "tasks" },
  files: { path: "files" },
  estimates: { path: "estimates" },
  invoices: { path: "invoices" },
  workorders: { path: "workorders" },
  materialorders: { path: "materialorders" },
};

function usage() {
  console.log(`Usage: JOBNIMBUS_API_KEY=... node tools/jobnimbus-export.mjs
  --entities a,b,c   subset of: ${Object.keys(ENTITIES).join(",")} (default: all)
  --out DIR          snapshot root (default output/jobnimbus-export; must stay gitignored)
  --page-size N      records per request (default 100, max 1000)
  --max-pages N      per-entity safety cap (default 200)
  --skip-account     do not snapshot /account (workflow + custom-field definitions)`);
}

function parseArgs(argv) {
  const args = { entities: Object.keys(ENTITIES), out: "output/jobnimbus-export", pageSize: 100, maxPages: 200, account: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--entities") args.entities = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") args.out = String(argv[++i] ?? "");
    else if (a === "--page-size") args.pageSize = Math.min(1000, Math.max(1, Number(argv[++i]) || 100));
    else if (a === "--max-pages") args.maxPages = Math.max(1, Number(argv[++i]) || 200);
    else if (a === "--skip-account") args.account = false;
    else { console.error(`Unknown argument: ${a}`); usage(); process.exit(2); }
  }
  for (const e of args.entities) {
    if (!ENTITIES[e]) { console.error(`Unknown entity: ${e}`); usage(); process.exit(2); }
  }
  return args;
}

function apiKey() {
  const key = (process.env.JOBNIMBUS_API_KEY ?? "").trim();
  if (!key) {
    console.error("JOBNIMBUS_API_KEY is required in the environment (source it from your local ACCESS.env; never commit or print it).");
    process.exit(2);
  }
  return key;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET only — this tool must never mutate JobNimbus. */
async function jnGet(path, qs) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(qs ?? {})) url.searchParams.set(k, v);
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt);
    let res;
    try {
      res = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${apiKey()}`, accept: "application/json" } });
    } catch (e) {
      lastErr = new Error(`network_error ${path}: ${e?.message ?? e}`);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`jobnimbus_http_${res.status} ${path} (retryable): ${(await res.text()).slice(0, 300)}`);
      continue;
    }
    if (!res.ok) throw new Error(`jobnimbus_http_${res.status} ${path}: ${(await res.text()).slice(0, 500)}`);
    return await res.json();
  }
  throw lastErr;
}

function rowsOf(json, entity) {
  const spec = ENTITIES[entity];
  const direct = json?.[spec.key ?? "results"] ?? json?.results;
  if (Array.isArray(direct)) return direct;
  const firstArray = Object.values(json ?? {}).find((v) => Array.isArray(v));
  return Array.isArray(firstArray) ? firstArray : [];
}

/** Accumulates field-shape statistics without ever retaining row values. */
function makeSchemaStats() {
  const fields = new Map(); // fieldName -> { types:Set, present:count }
  return {
    observe(row) {
      if (!row || typeof row !== "object") return;
      for (const [k, v] of Object.entries(row)) {
        let f = fields.get(k);
        if (!f) { f = { types: new Set(), present: 0 }; fields.set(k, f); }
        f.present += 1;
        f.types.add(v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
      }
    },
    summary(total) {
      const out = {};
      for (const k of [...fields.keys()].sort()) {
        const f = fields.get(k);
        out[k] = { types: [...f.types].sort(), present: f.present, coverage: total ? +(f.present / total).toFixed(4) : 0 };
      }
      return out;
    },
  };
}

function fingerprint(schemaByEntity) {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(schemaByEntity).sort().map(([e, s]) => [e, Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.types]))])),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function tsRange(rows, field) {
  let min, max;
  for (const r of rows) {
    const v = r?.[field];
    if (typeof v !== "number" || v <= 0) continue;
    if (min === undefined || v < min) min = v;
    if (max === undefined || v > max) max = v;
  }
  const iso = (t) => (t === undefined ? null : new Date(t * 1000).toISOString());
  return { min: iso(min), max: iso(max) };
}

async function exportEntity(entity, dir, { pageSize, maxPages }) {
  const spec = ENTITIES[entity];
  const file = join(dir, `${entity}.ndjson`);
  writeFileSync(file, "");
  const stats = makeSchemaStats();
  const idField = "jnid";
  const ids = new Set();
  const dateRows = [];
  let from = 0;
  let reportedCount = null;
  let pages = 0;
  let truncated = false;

  for (; pages < maxPages; pages++) {
    const json = await jnGet(spec.path, {
      size: String(pageSize),
      from: String(from),
      sort_field: "date_created",
      sort_direction: "asc",
    });
    if (typeof json?.count === "number") reportedCount = json.count;
    const rows = rowsOf(json, entity);
    if (rows.length === 0) break;
    const lines = [];
    for (const row of rows) {
      stats.observe(row);
      const id = row?.[idField];
      if (typeof id === "string" && id) ids.add(id);
      dateRows.push({ date_created: row?.date_created, date_updated: row?.date_updated });
      lines.push(JSON.stringify(row));
    }
    appendFileSync(file, lines.join("\n") + "\n");
    from += rows.length;
    if (reportedCount !== null && from >= reportedCount) break;
    if (rows.length < pageSize) break;
    await sleep(300); // be polite; JN publishes no hard budget, the bridge saw no 429s at this pace
  }
  if (pages >= maxPages) truncated = true;

  return {
    entity,
    endpoint: `${BASE}/${spec.path}`,
    rows_exported: dateRows.length,
    unique_jnids: ids.size,
    server_reported_count: reportedCount,
    truncated_by_max_pages: truncated,
    date_created_range: tsRange(dateRows, "date_created"),
    date_updated_range: tsRange(dateRows, "date_updated"),
    schema: stats.summary(dateRows.length),
  };
}

/** Snapshot /account (workflow stages, record types, custom-field definitions) — config, not PII. */
async function exportAccount(dir) {
  const json = await jnGet("account");
  writeFileSync(join(dir, "account.json"), JSON.stringify(json, null, 2) + "\n");
  return { entity: "account", endpoint: `${BASE}/account`, ok: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  apiKey(); // fail fast, without printing anything secret

  const outRoot = resolve(REPO_ROOT, args.out);
  const rel = relative(REPO_ROOT, outRoot);
  if (!rel.startsWith("output")) {
    console.error(`Refusing to write snapshot outside the gitignored output/ tree (got: ${rel}). Snapshots carry customer PII and must never be committable.`);
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(outRoot, stamp);
  mkdirSync(dir, { recursive: true });

  const started = Date.now();
  const perEntity = [];
  for (const entity of args.entities) {
    process.stdout.write(`export ${entity} ... `);
    try {
      const res = await exportEntity(entity, dir, args);
      perEntity.push(res);
      console.log(`${res.rows_exported} rows (server count ${res.server_reported_count ?? "n/a"})`);
    } catch (e) {
      perEntity.push({ entity, error: String(e?.message ?? e) });
      console.log(`ERROR: ${String(e?.message ?? e)}`);
    }
    await sleep(300);
  }
  let account = null;
  if (args.account) {
    try { account = await exportAccount(dir); console.log("export account ... ok"); }
    catch (e) { account = { entity: "account", error: String(e?.message ?? e) }; console.log(`export account ... ERROR: ${String(e?.message ?? e)}`); }
  }

  const schemaByEntity = Object.fromEntries(perEntity.filter((r) => r.schema).map((r) => [r.entity, r.schema]));
  const manifest = {
    tool: "tools/jobnimbus-export.mjs",
    snapshot_dir: relative(REPO_ROOT, dir),
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    api_base: BASE,
    read_only: true,
    page_size: args.pageSize,
    entities: perEntity,
    account,
    schema_fingerprint_sha256: fingerprint(schemaByEntity),
    note: "NDJSON rows contain customer PII and stay in gitignored output/. This manifest carries counts, date ranges, and field shapes only.",
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\nsnapshot: ${relative(REPO_ROOT, dir)}`);
  console.log(`schema fingerprint: ${manifest.schema_fingerprint_sha256}`);
  const failed = perEntity.filter((r) => r.error);
  if (failed.length) {
    console.error(`FAILED entities: ${failed.map((r) => r.entity).join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
