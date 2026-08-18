import assert from "node:assert/strict";

import { evaluateAssertions, median } from "./lighthouse-field.mjs";

assert.equal(median([0.98, 0.9, 0.95]), 0.95);

const results = [
  {
    categories: { performance: { score: 0.92 } },
    audits: { "first-contentful-paint": { numericValue: 1_800 } },
  },
  {
    categories: { performance: { score: 0.88 } },
    audits: { "first-contentful-paint": { numericValue: 2_100 } },
  },
  {
    categories: { performance: { score: 0.94 } },
    audits: { "first-contentful-paint": { numericValue: 1_900 } },
  },
];
const checked = evaluateAssertions(results, {
  "categories:performance": ["error", { minScore: 0.9 }],
  "first-contentful-paint": ["error", { maxNumericValue: 2_000 }],
});
assert.equal(checked.aggregate["categories:performance"].median, 0.92);
assert.equal(checked.aggregate["first-contentful-paint"].median, 1_900);
assert.deepEqual(checked.failures, []);
assert.equal(
  evaluateAssertions(results, { "categories:performance": ["error", { minScore: 0.95 }] }).failures
    .length,
  1,
);
console.log("Lighthouse assertion helper check passed");
