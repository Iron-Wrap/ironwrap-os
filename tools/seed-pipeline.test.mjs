// seed-pipeline.test.mjs - the pipeline seeder and every shipped template document.
//
// A board is configuration, so a broken document has to fail here rather than at a stakeholder's
// first drag. Every file under config/pipelines/ is parsed, and the statements it produces are
// checked for the two properties the whole design leans on: stable ids and additive writes.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import {
  parsePipelineTemplate,
  pipelineIdFor,
  pipelineSeedStatements,
  stageIdFor,
  statementsToSql,
} from "./seed-pipeline.mjs";

const directory = new URL("../config/pipelines/", import.meta.url);
const documents = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => [name, JSON.parse(readFileSync(new URL(name, directory), "utf8"))]);

test("every shipped pipeline template parses", () => {
  assert.ok(documents.length > 0, "no pipeline templates found");
  for (const [name, document] of documents)
    assert.doesNotThrow(() => parsePipelineTemplate(document), `${name} does not parse`);
});

test("stage positions are dense and ordered, so board adjacency is unambiguous", () => {
  for (const [name, document] of documents) {
    const template = parsePipelineTemplate(document);
    assert.deepEqual(
      template.stages.map((stage) => stage.position),
      template.stages.map((_stage, index) => index),
      `${name} stage positions`,
    );
    assert.equal(
      template.stages.filter((stage) => stage.is_won).length <= 1,
      true,
      `${name} declares more than one won stage`,
    );
  }
});

test("seeding is additive and re-runnable, and ids depend only on tenant and key", () => {
  const [, document] = documents[0];
  const template = parsePipelineTemplate(document);
  const statements = pipelineSeedStatements(template, {
    tenantId: "acme",
    now: "2026-08-22T12:00:00.000Z",
  });
  assert.equal(statements.length, template.stages.length + 1);
  for (const { sql } of statements) assert.match(sql, /^INSERT OR IGNORE INTO /);

  assert.equal(statements[0].params[0], pipelineIdFor("acme", template.key));
  assert.equal(statements[1].params[0], stageIdFor("acme", template.key, template.stages[0].key));
  // A different tenant gets a different board, never a shared row.
  assert.notEqual(pipelineIdFor("acme", template.key), pipelineIdFor("other", template.key));
});

test("rendered SQL binds every placeholder and quotes text safely", () => {
  const template = parsePipelineTemplate(documents[0][1]);
  const sql = statementsToSql(
    pipelineSeedStatements(template, { tenantId: "acme", now: "2026-08-22T12:00:00.000Z" }),
  );
  assert.doesNotMatch(sql, /\?/);
  assert.match(sql, /'acme'/);
});

test("a template missing its title slot or naming an unusable source is refused", () => {
  const base = parsePipelineTemplate(documents[0][1]);
  const document = (overrides) => ({
    schema_version: "ironwrap.pipeline-template.v1",
    key: base.key,
    name: base.name,
    entity_type: base.entity_type,
    owning_role: base.owning_role,
    position: 0,
    stages: [{ key: "one", name: "One" }],
    card_template: { version: 1, slots: [{ slot: "title", source: "entity.name" }] },
    ...overrides,
  });
  assert.doesNotThrow(() => parsePipelineTemplate(document({})));
  assert.throws(
    () =>
      parsePipelineTemplate(
        document({ card_template: { version: 1, slots: [{ slot: "tag", source: "a.b" }] } }),
      ),
    /card_template title slot/,
  );
  assert.throws(
    () =>
      parsePipelineTemplate(
        document({ card_template: { version: 1, slots: [{ slot: "title", source: "nodot" }] } }),
      ),
    /source nodot/,
  );
  assert.throws(
    () => parsePipelineTemplate(document({ stages: [{ key: "a", name: "A" }, { key: "a", name: "B" }] })),
    /duplicated/,
  );
  assert.throws(() => parsePipelineTemplate(document({ schema_version: "nope" })), /schema_version/);
});
