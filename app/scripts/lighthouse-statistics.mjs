/**
 * The gate and the protocol A/B both reduce a set of runs to a median, and the A/B has to do
 * it without importing Lighthouse itself. Keeping the reduction here is what lets its unit
 * test run inside the normal suite instead of behind a browser launch.
 */
export function median(values) {
  if (!values.length) throw new Error("Cannot calculate a median for an empty set");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
