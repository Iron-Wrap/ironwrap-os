// IRO-268: `wrangler.jsonc` groups non-secret vars into `CFG_*` JSON bindings (see var-bindings.d.ts)
// to stay under the Cloudflare Workers variable-count limit. `flattenEnv` restores the flat
// `env.NAME` shape every reader in this repository already expects, so nothing below the three
// entry points (fetch/queue/scheduled in index.ts) has to change.
//
// Precedence: a flat binding on `env` always wins over a grouped one. `.dev.vars` and
// `wrangler secret put` bind by flat name (ELEC-112 finding 4), and a local override such as
// `ERPNEXT_BASE_URL` must keep taking effect. This also makes `flattenEnv` a no-op on an
// already-flat env (no `CFG_*` binding present), so old flat configuration keeps working
// unchanged against this code.
export const CONFIG_GROUP_PREFIX = "CFG_";

export function flattenEnv(env: Env): Env {
  const flattened: Record<string, unknown> = {};
  for (const [binding, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (!binding.startsWith(CONFIG_GROUP_PREFIX)) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      flattened[name] = typeof entry === "string" ? entry : JSON.stringify(entry);
    }
  }
  return Object.keys(flattened).length === 0
    ? env
    : (Object.assign(flattened, env) as unknown as Env);
}
