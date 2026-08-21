import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

/**
 * IRO-38 source inventory: every outbound `fetch(` call site in the Worker source
 * is pinned here with an explicit routing classification. The canonical external
 * side-effect lifecycle lives in `src/effect-runtime.ts`; a mutation adapter either
 * routes through it or is recorded below as governed-unrouted debt with the exact
 * discipline it uses instead. Adding an outbound call site without deciding its
 * classification fails this suite; so does silently dropping the effect-runtime
 * binding from a file this inventory says routes through it.
 *
 * The classifications:
 * - runtime-routed: the file performs provider mutations and binds them to the
 *   canonical effect runtime (`runExternalEffect`/`executeExternalEffect`).
 * - read-only: every fetch site in the file is a GET/HEAD-style read.
 * - read-only-post-rpc: POST transport, but only to the named Frappe read RPCs.
 * - transport-library: a provider client with a dynamic method; mutation
 *   authority is enforced by its callers, which are named and checked.
 * - governed-unrouted: a real mutation path with its own lease/receipt
 *   discipline that has not been re-seated onto the canonical runtime yet.
 *   This list may only shrink; growing it is a deliberate, reviewed decision.
 * - worker-entry: the Worker's own inbound `async fetch(` handler, not an
 *   outbound call.
 */
type InventoryEntry =
  | { kind: "runtime-routed" }
  | { kind: "read-only" }
  | { kind: "read-only-post-rpc"; rpcMethods: string[] }
  | { kind: "transport-library"; mutationAuthorityCallers: string[] }
  | { kind: "governed-unrouted"; discipline: string }
  | { kind: "worker-entry" };

const OUTBOUND_FETCH_INVENTORY: Record<string, InventoryEntry> = {
  "erpnext.ts": { kind: "runtime-routed" },
  "frappe-read.ts": { kind: "read-only" },
  "google.ts": { kind: "runtime-routed" },
  "index.ts": { kind: "worker-entry" },
  "jobnimbus.ts": { kind: "runtime-routed" },
  "measurements.ts": {
    kind: "governed-unrouted",
    discipline:
      "queue-leased, idempotent Anthropic OCR inference with optional OmniRoute credit-exhausted fallback, bounded by MEASUREMENT_OCR_* and optional OMNIROUTE_* config; mutates no provider business state, plus a redirect-bounded report download",
  },
  "newo-client.ts": {
    kind: "transport-library",
    mutationAuthorityCallers: ["newo-control.ts", "newo-admin.ts", "operations.ts"],
  },
  "operations.ts": { kind: "read-only" },
  "photos.ts": { kind: "read-only" },
  "production-gate-clearance.ts": {
    kind: "governed-unrouted",
    discipline:
      "required path writes clearance to D1 after an immutable R2 receipt; leftover frappeProductionGateWriter still holds one unused outbound POST and is not on the live command path",
  },
  "solar.ts": { kind: "read-only" },
};

const SRC_DIR = new URL("../src/", import.meta.url);

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(SRC_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
}

function outboundFetchSites(source: string): string[] {
  // `.fetch(` is a Worker service/DO binding (internal), not an outbound call.
  return Array.from(source.matchAll(/(?<![.\w])fetch\(/g), (match) => {
    const start = match.index ?? 0;
    return source.slice(Math.max(0, start - 40), start + 400);
  });
}

function referencesEffectRuntime(source: string): boolean {
  return (
    /from "\.\/effect-runtime\.ts"/.test(source) &&
    /\b(runExternalEffect|executeExternalEffect)\b/.test(source)
  );
}

const MUTATING_METHOD = /method:\s*"(POST|PUT|PATCH|DELETE)"/;

test("every Worker source file with an outbound fetch site is in the IRO-38 inventory, and the inventory is not stale", async () => {
  const filesWithFetch: string[] = [];
  for (const file of await sourceFiles()) {
    const source = await readFile(new URL(file, SRC_DIR), "utf8");
    if (outboundFetchSites(source).length > 0) filesWithFetch.push(file);
  }
  assert.deepEqual(
    filesWithFetch,
    Object.keys(OUTBOUND_FETCH_INVENTORY).sort(),
    "outbound fetch call sites moved: classify the new/removed file in OUTBOUND_FETCH_INVENTORY (route mutations through effect-runtime.ts unless a reviewed discipline says otherwise)",
  );
});

test("runtime-routed files actually bind the canonical effect runtime", async () => {
  for (const [file, entry] of Object.entries(OUTBOUND_FETCH_INVENTORY)) {
    if (entry.kind !== "runtime-routed") continue;
    const source = await readFile(new URL(file, SRC_DIR), "utf8");
    assert.ok(
      referencesEffectRuntime(source),
      `${file} is inventoried as runtime-routed but no longer references runExternalEffect/executeExternalEffect from effect-runtime.ts`,
    );
  }
});

test("read-only files carry no mutating method on any fetch site", async () => {
  for (const [file, entry] of Object.entries(OUTBOUND_FETCH_INVENTORY)) {
    if (entry.kind !== "read-only") continue;
    const source = await readFile(new URL(file, SRC_DIR), "utf8");
    for (const site of outboundFetchSites(source)) {
      assert.doesNotMatch(
        site,
        MUTATING_METHOD,
        `${file} is inventoried read-only but a fetch site sends a mutating method; reclassify it and route it through the effect runtime`,
      );
    }
  }
});

test("read-only POST RPC files call only their named read methods", async () => {
  for (const [file, entry] of Object.entries(OUTBOUND_FETCH_INVENTORY)) {
    if (entry.kind !== "read-only-post-rpc") continue;
    const source = await readFile(new URL(file, SRC_DIR), "utf8");
    const sites = outboundFetchSites(source);
    assert.equal(
      sites.length,
      entry.rpcMethods.length,
      `${file} gained a fetch site beyond its named read RPCs`,
    );
    for (const rpc of entry.rpcMethods) {
      assert.ok(
        source.includes(rpc),
        `${file} no longer names the read RPC ${rpc} this inventory pinned`,
      );
    }
  }
});

test("transport libraries have their mutation authority enforced by real, named callers", async () => {
  const files = await sourceFiles();
  for (const [file, entry] of Object.entries(OUTBOUND_FETCH_INVENTORY)) {
    if (entry.kind !== "transport-library") continue;
    const moduleRef = `./${file}`;
    for (const caller of entry.mutationAuthorityCallers) {
      assert.ok(files.includes(caller), `${file} names a caller ${caller} that does not exist`);
      const callerSource = await readFile(new URL(caller, SRC_DIR), "utf8");
      assert.ok(
        callerSource.includes(moduleRef),
        `${caller} is named as a mutation-authority caller of ${file} but does not import it`,
      );
    }
    // The one caller that mutates provider state must be runtime-routed.
    const controlSource = await readFile(new URL("newo-control.ts", SRC_DIR), "utf8");
    assert.ok(
      referencesEffectRuntime(controlSource),
      "newo-control.ts drives Newo mutations through newo-client and must stay bound to the effect runtime",
    );
  }
});

test("governed-unrouted mutation adapters are exactly the recorded debt, each with its own discipline, and none quietly adopts half the runtime", async () => {
  const unrouted = Object.entries(OUTBOUND_FETCH_INVENTORY).filter(
    (pair): pair is [string, Extract<InventoryEntry, { kind: "governed-unrouted" }>] =>
      pair[1].kind === "governed-unrouted",
  );
  // This list may only shrink. Re-seating one of these onto the canonical
  // runtime means moving it to runtime-routed, not editing its discipline.
  assert.deepEqual(
    unrouted.map(([file]) => file).sort(),
    // IRO-195 moved customer-portal-decision off outbound fetch (D1 commit after R2
    // receipt). production-gate-clearance's required path is also a D1 write; the
    // leftover Frappe writer still contains one unused fetch, so the file stays here
    // until that leftover function is deleted.
    [
      "measurements.ts",
      "production-gate-clearance.ts",
    ],
    "the governed-unrouted set changed: shrinking it means reclassifying to runtime-routed; growing it is a reviewed IRO-38 decision, not a default",
  );
  for (const [file, entry] of unrouted) {
    assert.ok(
      entry.discipline.length >= 40,
      `${file} needs a real recorded discipline, not a placeholder`,
    );
    const source = await readFile(new URL(file, SRC_DIR), "utf8");
    assert.ok(
      !referencesEffectRuntime(source),
      `${file} now references the canonical effect runtime: reclassify it as runtime-routed so the binding is enforced`,
    );
  }
});

test("the effect runtime itself performs no outbound fetch; adapters inject the provider call", async () => {
  const source = await readFile(new URL("effect-runtime.ts", SRC_DIR), "utf8");
  assert.equal(
    outboundFetchSites(source).length,
    0,
    "effect-runtime.ts must stay provider-neutral; provider calls belong to injected adapter bodies",
  );
});

test("the worker entry file's only fetch is the inbound handler", async () => {
  const source = await readFile(new URL("index.ts", SRC_DIR), "utf8");
  const sites = outboundFetchSites(source);
  assert.equal(sites.length, 1, "index.ts gained an outbound fetch site; classify it");
  assert.match(sites[0] ?? "", /async fetch\(/, "index.ts's fetch must be the Worker handler");
});
