import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("supplier send stays an internal packet with external_supplier_contact false", () => {
  assert.equal(existsSync(new URL("../src/supplier-order.ts", import.meta.url)), false);
  const mcp = readFileSync(new URL("../../mcp/erpnext-roofing-mcp/src/server.mjs", import.meta.url), "utf8");
  assert.match(mcp, /external_supplier_contact:\s*false/);
  assert.equal((mcp.match(/external_supplier_contact:\s*true/g) ?? []).length, 0);
});
