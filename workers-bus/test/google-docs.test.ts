// Proposal-doc builder tests: the pure merge layer must be exact and bounded.
// Network calls (copy/batchUpdate) stay thin and are proven live, not mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { docsReplaceRequests, proposalDocName, sanitizeDocValue } from "../src/google.ts";

test("docs: replace requests target exact {{placeholders}} with sanitized values", () => {
  const requests = docsReplaceRequests({
    customer_name: "Dana Example",
    total: 3257.1,
    notes: null,
  });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], {
    replaceAllText: {
      containsText: { text: "{{customer_name}}", matchCase: true },
      replaceText: "Dana Example",
    },
  });
  assert.equal(requests[1].replaceAllText.replaceText, "3257.1");
  assert.equal(requests[2].replaceAllText.replaceText, "");
});

test("docs: values are control-stripped and bounded, tab and newline survive", () => {
  assert.equal(sanitizeDocValue("line1\nline2\u0007 end\u007F"), "line1\nline2 end");
  assert.equal(sanitizeDocValue("a\tb"), "a\tb");
  assert.equal(sanitizeDocValue("x".repeat(6000)).length, 5000);
  assert.equal(sanitizeDocValue(undefined), "");
});

test("docs: proposal names keep the JN-first folder convention and stay path-safe", () => {
  assert.equal(proposalDocName("26-0007"), "26-0007 Proposal");
  assert.equal(proposalDocName("26-0007", "Metal re-roof"), "26-0007 Proposal - Metal re-roof");
  assert.equal(proposalDocName("26/0007"), "26_0007 Proposal");
});
