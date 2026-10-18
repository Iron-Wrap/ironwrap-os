// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { overpaidLinkedInvoice } from "../src/accounting/money-fixtures";

// The page tests run in jsdom, where the Worker's fixtures are out of reach; this keeps the copy
// they use equal to the Worker's own.
describe("accounting fixtures shared with the Worker", () => {
  it("keeps the over-paid linked invoice equal to the Worker's fixture", () => {
    const worker: unknown = JSON.parse(
      readFileSync(
        new URL(
          "../../workers-bus/test/fixtures/quickbooks/invoice-overpaid-linked.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(overpaidLinkedInvoice).toEqual(worker);
  });
});
