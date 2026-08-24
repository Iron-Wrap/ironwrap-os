#!/usr/bin/env node
/**
 * Seeds a pipeline board from a template document (IRO-209).
 *
 * The Worker contains no knowledge of any particular board. A pipeline, its stages and its card
 * template are configuration: a JSON document under `config/pipelines/`, turned into additive
 * `INSERT OR IGNORE` rows here. That is why M3's admin UI has nothing to unpick - it edits the
 * same rows this script inserts.
 *
 * Ids are derived from (tenant, key), so re-running the script is a no-op rather than a duplicate
 * board, and a test can compute the same ids without reading them back.
 *
 * Usage:
 *   node tools/seed-pipeline.mjs --tenant ironwrap --template config/pipelines/sales-pipeline.v1.json
 *   node tools/seed-pipeline.mjs --tenant ironwrap --template <path> --format json
 *
 * The default `--format sql` prints statements for `wrangler d1 execute`. It performs no network
 * call and touches no database itself.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SLOT_KINDS = new Set(["title", "amount", "identifier", "tag", "counter", "won_flag"]);
const SOURCE_PATH = /^[a-z][a-z0-9_]{0,39}\.[a-z][a-z0-9_]{0,63}$/;
const KEY = /^[a-z0-9_]{1,60}$/;
const ENTITY_TYPE = /^[a-z_]{2,40}$/;

function fail(message) {
  throw new Error(`pipeline_template_invalid: ${message}`);
}

/**
 * Structural validation of a template document. Slot semantics are re-checked by the Worker's
 * `parsePipelineCardTemplate`, and a test drives the shipped document through both.
 */
export function parsePipelineTemplate(document) {
  if (!document || typeof document !== "object" || Array.isArray(document))
    fail("document must be an object");
  if (document.schema_version !== "ironwrap.pipeline-template.v1")
    fail("unsupported schema_version");
  if (!KEY.test(document.key ?? "")) fail("key");
  if (typeof document.name !== "string" || !document.name.trim()) fail("name");
  if (!ENTITY_TYPE.test(document.entity_type ?? "")) fail("entity_type");
  if (document.owning_role !== null && document.owning_role !== undefined &&
      typeof document.owning_role !== "string")
    fail("owning_role");
  if (!Number.isInteger(document.position) || document.position < 0) fail("position");
  if (!Array.isArray(document.stages) || document.stages.length === 0) fail("stages");

  const seen = new Set();
  const stages = document.stages.map((stage, index) => {
    if (!KEY.test(stage?.key ?? "")) fail(`stages[${index}].key`);
    if (seen.has(stage.key)) fail(`stages[${index}].key duplicated`);
    seen.add(stage.key);
    if (typeof stage.name !== "string" || !stage.name.trim()) fail(`stages[${index}].name`);
    if (stage.is_won === true && stage.is_lost === true) fail(`stages[${index}] won and lost`);
    return {
      key: stage.key,
      name: stage.name.trim(),
      color: typeof stage.color === "string" ? stage.color : null,
      position: index,
      is_won: stage.is_won === true ? 1 : 0,
      is_lost: stage.is_lost === true ? 1 : 0,
      min_role_to_enter:
        typeof stage.min_role_to_enter === "string" ? stage.min_role_to_enter : null,
    };
  });

  const cardTemplate = document.card_template;
  if (!cardTemplate || cardTemplate.version !== 1 || !Array.isArray(cardTemplate.slots))
    fail("card_template");
  if (!cardTemplate.slots.some((slot) => slot?.slot === "title")) fail("card_template title slot");
  for (const [index, slot] of cardTemplate.slots.entries()) {
    if (!SLOT_KINDS.has(slot?.slot)) fail(`card_template.slots[${index}].slot`);
    const sources = Array.isArray(slot.sources)
      ? slot.sources
      : typeof slot.source === "string"
        ? [slot.source]
        : null;
    if (!sources?.length) fail(`card_template.slots[${index}].sources`);
    for (const source of sources)
      if (!SOURCE_PATH.test(source)) fail(`card_template.slots[${index}] source ${source}`);
    if (slot.slot === "identifier" && !slot.label?.trim())
      fail(`card_template.slots[${index}].label`);
    if (slot.slot === "counter" && !slot.kind?.trim()) fail(`card_template.slots[${index}].kind`);
  }

  return {
    key: document.key,
    name: document.name.trim(),
    entity_type: document.entity_type,
    owning_role: document.owning_role ?? null,
    position: document.position,
    stages,
    card_template: { version: 1, slots: cardTemplate.slots },
  };
}

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function pipelineIdFor(tenantId, pipelineKey) {
  return `pl_${digest(`${tenantId}:${pipelineKey}`).slice(0, 40)}`;
}

export function stageIdFor(tenantId, pipelineKey, stageKey) {
  return `pls_${digest(`${tenantId}:${pipelineKey}:${stageKey}`).slice(0, 40)}`;
}

/**
 * Additive, re-runnable statements for one template. `INSERT OR IGNORE` so a second run against a
 * board an administrator has since edited leaves their edits alone.
 */
export function pipelineSeedStatements(template, options) {
  const tenantId = options.tenantId;
  const now = options.now ?? new Date().toISOString();
  const pipelineId = pipelineIdFor(tenantId, template.key);
  const statements = [
    {
      sql: `INSERT OR IGNORE INTO pipelines (
        pipeline_id, tenant_id, key, name, entity_type, owning_role, card_template_json,
        is_template, template_source_id, is_active, position, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, ?, 1, ?, ?)`,
      params: [
        pipelineId,
        tenantId,
        template.key,
        template.name,
        template.entity_type,
        template.owning_role,
        JSON.stringify(template.card_template),
        template.position,
        now,
        now,
      ],
    },
  ];
  for (const stage of template.stages) {
    statements.push({
      sql: `INSERT OR IGNORE INTO pipeline_stages (
        stage_id, tenant_id, pipeline_id, key, name, color, position, is_won, is_lost,
        min_role_to_enter, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      params: [
        stageIdFor(tenantId, template.key, stage.key),
        tenantId,
        pipelineId,
        stage.key,
        stage.name,
        stage.color,
        stage.position,
        stage.is_won,
        stage.is_lost,
        stage.min_role_to_enter,
        now,
        now,
      ],
    });
  }
  return statements;
}

const quote = (value) =>
  value === null || value === undefined
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${String(value).replaceAll("'", "''")}'`;

export function statementsToSql(statements) {
  return statements
    .map(({ sql, params }) => {
      let index = 0;
      return `${sql.replaceAll("?", () => quote(params[index++]))};`;
    })
    .join("\n\n");
}

function argument(name, fallback = null) {
  const flag = process.argv.indexOf(`--${name}`);
  return flag >= 0 && process.argv[flag + 1] ? process.argv[flag + 1] : fallback;
}

if (process.argv[1]?.endsWith("seed-pipeline.mjs")) {
  const templatePath = argument("template");
  const tenantId = argument("tenant");
  if (!templatePath || !tenantId) {
    console.error("usage: seed-pipeline.mjs --tenant <id> --template <path> [--format sql|json]");
    process.exit(2);
  }
  const template = parsePipelineTemplate(JSON.parse(readFileSync(templatePath, "utf8")));
  const statements = pipelineSeedStatements(template, { tenantId, now: argument("now") });
  process.stdout.write(
    argument("format", "sql") === "json"
      ? `${JSON.stringify(statements, null, 2)}\n`
      : `${statementsToSql(statements)}\n`,
  );
}
