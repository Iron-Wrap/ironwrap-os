import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

test("the Worker has no supplier-send module", () => {
  assert.equal(existsSync(new URL("../src/supplier-order.ts", import.meta.url)), false);
});
