// crm-import-api.ts - the admin surface for importing an existing CRM export into a tenant.
//
//   POST /admin/crm-import/dry-run   plan only. Writes nothing, anywhere. Returns the full report.
//   POST /admin/crm-import/execute   the same plan, applied. Returns the same report plus `applied`.
//   GET  /admin/crm-import/runs      recent executed runs.
//   GET  /admin/crm-import/runs/<id> the stored report for one run.
//
// Bearer auth is the caller's problem: index.ts gates every /admin/ path on ADMIN_TOKEN before this
// handler is reached. No provider is contacted here or anywhere else in the importer; the only
// input is a file the operator already has.

import { parseCsv } from "./crm-import/csv.ts";
import { planImport } from "./crm-import/plan.ts";
import { resolveAdapter, ADAPTERS } from "./crm-import/adapters.ts";
import { resolvePlacementMap, PLACEMENT_MAPS } from "./crm-import/stage-map.ts";
import { executeImport, getImportRunReport, listImportRuns } from "./crm-import/store.ts";
import type { SourceRecord } from "./crm-import/contracts.ts";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;

type ImportEnv = Env & { APP_TENANT_ID?: string; OPERATING_AUTOMATION_USER?: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function handleCrmImport(
  req: Request,
  env: ImportEnv,
  url: URL,
  now: string = new Date().toISOString(),
): Promise<Response> {
  if (req.method === "GET" && url.pathname === "/admin/crm-import/adapters") {
    return json({
      adapters: ADAPTERS.map((entry) => ({ id: entry.id, label: entry.label, columns: entry.aliases })),
      pipelines: Object.values(PLACEMENT_MAPS).map((map) => ({
        pipeline_key: map.pipelineKey,
        label: map.pipelineLabel,
        stages: map.stages,
      })),
    });
  }

  if (req.method === "GET" && url.pathname === "/admin/crm-import/runs") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "20") || 20, 1), 100);
    return json({ runs: await listImportRuns(env, limit) });
  }

  if (req.method === "GET" && url.pathname.startsWith("/admin/crm-import/runs/")) {
    const runId = decodeURIComponent(url.pathname.slice("/admin/crm-import/runs/".length));
    const report = await getImportRunReport(env, runId);
    return report ? json({ report }) : json({ error: "not_found" }, 404);
  }

  const mode = url.pathname === "/admin/crm-import/dry-run"
    ? "dry_run"
    : url.pathname === "/admin/crm-import/execute"
      ? "execute"
      : null;
  if (req.method !== "POST" || mode === null) return json({ error: "not_found" }, 404);

  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "invalid_request" }, 400);

  const adapter = resolveAdapter(typeof body.adapter === "string" ? body.adapter : "");
  if (!adapter) {
    return json({ error: "unknown_adapter", known: ADAPTERS.map((entry) => entry.id) }, 400);
  }
  const pipelineKey = typeof body.pipeline_key === "string" && body.pipeline_key
    ? body.pipeline_key
    : "sales";
  const map = resolvePlacementMap(pipelineKey);
  if (!map) {
    return json({ error: "unknown_pipeline", known: Object.keys(PLACEMENT_MAPS) }, 400);
  }
  const sourceLabel = typeof body.source_label === "string" && body.source_label.trim()
    ? body.source_label.trim().slice(0, 200)
    : null;

  let records: SourceRecord[];
  try {
    records = readRecords(body);
  } catch (error) {
    return json({ error: String((error as Error).message ?? error).slice(0, 200) }, 400);
  }
  if (records.length === 0) return json({ error: "no_rows" }, 400);
  if (records.length > MAX_ROWS) return json({ error: "too_many_rows", max_rows: MAX_ROWS }, 413);

  const plan = planImport({ adapter, map, records, sourceLabel, generatedAt: now });

  if (mode === "dry_run") return json({ report: { ...plan.report, sourceLabel } });
  return json({ report: await executeImport(env, { plan, sourceLabel, now }) });
}

function readRecords(body: Record<string, unknown>): SourceRecord[] {
  if (typeof body.csv === "string") {
    return parseCsv(body.csv, MAX_ROWS).records as SourceRecord[];
  }
  if (Array.isArray(body.rows)) {
    return body.rows.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`crm_import_row_not_an_object:${index}`);
      }
      const record: Record<string, string> = {};
      for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
        if (value === null || value === undefined) continue;
        if (typeof value === "object") throw new Error(`crm_import_row_nested_value:${index}:${key}`);
        record[key] = String(value);
      }
      return record;
    });
  }
  throw new Error("crm_import_source_missing: supply either csv or rows");
}
