// IRO-268: workers-bus/wrangler.jsonc groups non-secret vars into CFG_* JSON bindings to stay
// under the Cloudflare Workers variable-count limit (see workers-bus/src/env-bindings.ts, which
// applies the same rule at runtime through flattenEnv). Every Node-side tool that reads
// wrangler.jsonc's `vars` directly needs the same flat-name view; import from here rather than
// re-deriving it, so the two never drift.

export const CONFIG_GROUP_PREFIX = "CFG_";

function isGroupValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Flatten a wrangler `vars` object back to the flat `{ NAME: "value" }` shape every reader in
 * this repository expects, whether the source is fully grouped, fully flat, or (mid-migration) a
 * mix of both. A flat key always wins over the same name nested inside a `CFG_*` group
 * (ELEC-112 finding 4: `.dev.vars` and `wrangler secret put` bind by flat name), matching
 * workers-bus/src/env-bindings.ts::flattenEnv exactly.
 */
export function flattenWranglerVars(vars) {
  const flat = {};
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith(CONFIG_GROUP_PREFIX) && isGroupValue(value)) {
      // IRO-268 R1.5: this must be the exact rule workers-bus/src/env-bindings.ts::flattenEnv
      // applies, so a JSON-typed var digests and reads identically on both sides.
      for (const [name, entry] of Object.entries(value)) flat[name] = typeof entry === "string" ? entry : JSON.stringify(entry);
    }
  }
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith(CONFIG_GROUP_PREFIX) && isGroupValue(value)) continue;
    flat[key] = value;
  }
  return flat;
}

/**
 * Re-group a flat vars map using the same rule `wrangler.jsonc` was grouped with: the var name up
 * to its first `_` becomes `CFG_<TOKEN>` when 2 or more vars share that token, and every
 * remaining var goes to `CFG_CORE`. Used to keep a derived config (a tenant clone) in the same
 * grouped shape as its source, rather than deriving grouped values by hand at each call site.
 */
export function groupWranglerVars(flatVars) {
  const tokenCounts = new Map();
  for (const key of Object.keys(flatVars)) {
    const token = key.split("_")[0];
    tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
  }
  const groups = new Map();
  for (const [key, value] of Object.entries(flatVars)) {
    const token = key.split("_")[0];
    const groupName = (tokenCounts.get(token) || 0) >= 2 ? `${CONFIG_GROUP_PREFIX}${token}` : `${CONFIG_GROUP_PREFIX}CORE`;
    if (!groups.has(groupName)) groups.set(groupName, {});
    groups.get(groupName)[key] = value;
  }
  return Object.fromEntries(groups);
}
