#!/usr/bin/env node
// Lists what still reads the one-release compatibility aliases (design/system-v2/PIPELINE.md):
// per legacy custom property, its `var(--name)` call sites in src/ and the Tailwind utilities
// built on the shipped colour name of the same role. Delete an alias from tokens.json
// ($extensions.com.ironwrap.os.compat) when its row reaches zero. A report: it never fails.
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tokens = JSON.parse(readFileSync(join(root, "src/design-system/tokens.json"), "utf8"));
const legacy = Object.keys(tokens.$extensions["com.ironwrap.os"].compat?.aliases ?? {});
const sources = [];
(function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (/\.(tsx?|css)$/.test(extname(path)) && !/(\.test\.|[\\/]tokens\.css$)/.test(path)) {
      sources.push(readFileSync(path, "utf8"));
    }
  }
})(join(root, "src"));
const code = sources.join("\n");

const utility = /(?:bg|text|border|ring|outline|fill|stroke|from|to|via|divide|decoration|shadow)/;
const rows = legacy
  .map((property) => {
    const name = property.slice(2);
    const vars = code.match(new RegExp(`var\\(${property}(?![\\w-])`, "g"))?.length ?? 0;
    const utilities =
      code.match(new RegExp(`(?<![\\w-])${utility.source}-${name}(?![\\w-])`, "g"))?.length ?? 0;
    return { property, vars, utilities };
  })
  .filter((row) => row.vars + row.utilities > 0)
  .sort((a, b) => b.vars + b.utilities - (a.vars + a.utilities));

for (const { property, vars, utilities } of rows) {
  console.log(`${property.padEnd(30)} var() ${String(vars).padStart(3)}   utilities ${utilities}`);
}
const total = rows.reduce((sum, row) => sum + row.vars + row.utilities, 0);
console.log(`${rows.length} of ${legacy.length} aliases still read, ${total} call sites`);
