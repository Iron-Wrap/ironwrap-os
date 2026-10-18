/**
 * Test helpers for generated views, shared by the app tests and workers-bus/test/view-spec.test.ts.
 * No imports, so Node can load this file from the Worker tests as it is.
 */

interface Registry {
  readonly [name: string]: {
    readonly params: object;
    readonly fields: object;
    readonly planned_params: object;
    readonly planned_fields: object;
  };
}

/** The registry once every read model design/system-v2/TEMPLATES.md needs is served. */
export function everythingAvailable<R extends Registry>(registry: R): R {
  return Object.fromEntries(
    Object.entries(registry).map(([name, model]) => [
      name,
      {
        ...model,
        available: true,
        params: { ...model.params, ...model.planned_params },
        fields: { ...model.fields, ...model.planned_fields },
        planned_params: {},
        planned_fields: {},
      },
    ]),
  ) as unknown as R;
}

/**
 * A TEMPLATES.md example ready to validate: its elided hashes ("sha256:…") become synthetic ones
 * and `catalog_sha256` names the catalog in force.
 */
export function materializeExample<T>(example: T, catalogSha256: string): T {
  let next = 0;
  return JSON.parse(JSON.stringify(example), (key, value: unknown) => {
    if (value !== "sha256:…") return value;
    if (key === "catalog_sha256") return `sha256:${catalogSha256}`;
    next += 1;
    return `sha256:${next.toString(16).padStart(64, "0")}`;
  }) as T;
}

type Schema = { readonly [keyword: string]: unknown };

/**
 * The wire form a model produces under the strict JSON Schema: every property the schema declares
 * and the value leaves out becomes null.
 */
export function toWireForm(value: unknown, schema: Schema): unknown {
  if (Array.isArray(value)) {
    const items = schema.items as Schema | undefined;
    return items ? value.map((item) => toWireForm(item, items)) : value;
  }
  if (typeof value === "object" && value !== null) {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    const out: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(properties)) {
      const item = (value as Record<string, unknown>)[name];
      out[name] = Object.hasOwn(value, name) ? toWireForm(item, child) : null;
    }
    return out;
  }
  return value;
}
