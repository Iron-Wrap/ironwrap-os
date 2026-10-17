// Shared memory (AI-TEAM-CONTRACT.md "Shared memory"): the canonical D1 objects as exact,
// versioned facts. A run's context snapshot holds the signal's subject and the objects it links
// to, read through the same rows the role screens read and only as far as the specialist's
// reviewer role may read them. Every cited fact is read again before the step is decided.
//
// A fact is `<object>/<id>`, or `<object>/<id>#<pointer>` when the reviewer role may read only
// part of the object. Its hash is `sha256:` plus the hex digest of its value in canonical JSON.
// Its version comes from the append-only fact-version ledger: the first time a value is observed
// it gets the next version for that fact id, so any change to anything the fact holds (a gate, a
// quote revision, a consent) moves the version even where the source rows keep no aggregate
// counter, and one version always names one exact value.
//
// Values are never copied into coordination records. The run row keeps each fact's id, version
// and hash (`FactRef`); the values are read from the canonical rows when the run opens, when it
// resumes and when a step cites them, so a correction or erasure of the source reaches every run.

import { sha256Hex } from "../app-auth.ts";
import { permissionsForRole, type AppRole } from "../app-types.ts";
import { catalogSpecialist } from "./catalog.ts";
import type { Citation, SnapshotFact } from "./policy.ts";
import { canonicalJson } from "./schema.ts";
import type { AgentDb } from "./store.ts";

/** What a run row keeps of a fact: no value. */
export interface FactRef extends SnapshotFact {
  kind: string;
  observed_at: string;
}

export interface ContextFact extends FactRef {
  data: unknown;
}

/** A fact that belongs in the snapshot but is not in it, and why. */
export interface OmittedFact {
  fact_id: string;
  reason: "unreadable" | "too_large" | "limit_reached";
}

export interface ObjectRead {
  data: unknown;
  /** Other canonical objects this one names, offered to the snapshot when the reader may read them. */
  links: Array<{ kind: string; id: string }>;
}

export interface ObjectView {
  /** The role-screen permission (app-types.ts ROLE_PERMISSIONS) that grants this view. */
  permission: string;
  /** The parts of the object this view shows, as JSON pointers; null shows the whole object. */
  pointers: readonly string[] | null;
}

export interface ObjectModel {
  /** Widest first: a reader gets the first view its reviewer role holds the permission for. */
  views: readonly ObjectView[];
  read(db: AgentDb, tenantId: string, id: string): Promise<ObjectRead | null>;
}

/** Bounds on one snapshot (UTF-8 bytes of the facts), so a widely linked object cannot flood a run. */
export const SNAPSHOT_LIMITS = { facts: 24, bytes: 96 * 1024 };

const FACT_ID = /^([a-z][a-z_]{1,40})\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})(#(\/.*)?)?$/;
const encoder = new TextEncoder();

export function parseFactId(factId: string): { kind: string; id: string; pointer: string | null } | null {
  const match = FACT_ID.exec(factId);
  if (!match) return null;
  return { kind: match[1], id: match[2], pointer: match[3] === undefined ? null : (match[4] ?? "") };
}

/** RFC 6901: the value at a JSON pointer, or undefined when any step is missing. */
export function resolvePointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length) return undefined;
      current = current[Number(key)];
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else return undefined;
  }
  return current;
}

export async function factHash(value: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(value))}`;
}

export function refOf(fact: ContextFact): FactRef {
  const { data: _value, ...ref } = fact;
  return ref;
}

const factBytes = (fact: ContextFact) => encoder.encode(canonicalJson(fact)).length;

/** The view a specialist's reviewer role is granted on an object kind, or null. */
export function viewFor(models: Record<string, ObjectModel>, specialistId: string, kind: string): ObjectView | null {
  const model = Object.hasOwn(models, kind) ? models[kind] : undefined;
  const role = catalogSpecialist(specialistId)?.reviewer_role as AppRole | undefined;
  if (!model || !role) return null;
  const permissions = permissionsForRole(role);
  return model.views.find((view) => permissions.includes(view.permission)) ?? null;
}

const LEDGER_RACE = "agent_fact_versions_append_only";

/**
 * The ledger version of this exact value of a fact: the latest version when it already holds this
 * hash, otherwise the next one. Two readers racing on different values cannot share a version; the
 * loser reads again and takes the following one.
 */
export async function factVersion(db: AgentDb, tenantId: string, factId: string, hash: string, now: string): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await db
      .prepare("SELECT version, hash FROM agent_fact_versions WHERE tenant_id = ? AND fact_id = ? ORDER BY version DESC LIMIT 1")
      .bind(tenantId, factId)
      .first<{ version: number; hash: string }>();
    if (latest?.hash === hash) return latest.version;
    try {
      await db
        .prepare("INSERT INTO agent_fact_versions (tenant_id, fact_id, version, hash, observed_at) VALUES (?, ?, ?, ?, ?)")
        .bind(tenantId, factId, (latest?.version ?? 0) + 1, hash, now)
        .run();
      return (latest?.version ?? 0) + 1;
    } catch (error) {
      const message = String(error);
      if (!message.includes(LEDGER_RACE) && !message.includes("UNIQUE constraint failed: agent_fact_versions")) throw error;
    }
  }
  throw new Error("fact_version_contended");
}

/**
 * One canonical object as facts for this specialist: the whole object, or one fact per part its
 * view shows. Null when the object does not exist or the specialist's role may not read it; a
 * failing read throws.
 */
export async function readObjectFacts(
  db: AgentDb,
  models: Record<string, ObjectModel>,
  tenantId: string,
  specialistId: string,
  kind: string,
  id: string,
  now: string,
): Promise<{ facts: ContextFact[]; links: ObjectRead["links"] } | null> {
  const view = viewFor(models, specialistId, kind);
  if (!view) return null;
  const read = await models[kind].read(db, tenantId, id);
  if (!read) return null;
  const parts: Array<[string, unknown]> =
    view.pointers === null
      ? [[`${kind}/${id}`, read.data]]
      : view.pointers.map((pointer) => [`${kind}/${id}#${pointer}`, resolvePointer(read.data, pointer)]);
  const facts: ContextFact[] = [];
  for (const [factId, value] of parts) {
    if (value === undefined) continue;
    const hash = await factHash(value);
    facts.push({
      fact_id: factId,
      kind,
      version: await factVersion(db, tenantId, factId, hash, now),
      hash,
      trust: "owned",
      observed_at: now,
      fresh_until: null,
      data: value,
    });
  }
  return facts.length > 0 ? { facts, links: read.links } : null;
}

/** The same read, with a failure reported instead of thrown. */
async function tryReadObjectFacts(...args: Parameters<typeof readObjectFacts>) {
  try {
    return { read: await readObjectFacts(...args) };
  } catch {
    return { failed: true as const };
  }
}

/**
 * The facts a run starts from: the subject first, then the objects it links to, in link order,
 * within the snapshot limits. Objects the specialist may not read are left out silently; an object
 * that cannot be read, or does not fit, is named in `omitted` so the run knows it is missing.
 */
export async function subjectFacts(
  db: AgentDb,
  models: Record<string, ObjectModel>,
  tenantId: string,
  specialistId: string,
  subject: { aggregate: string; id: string } | null,
  now: string,
  budgetBytes = SNAPSHOT_LIMITS.bytes,
): Promise<{ facts: ContextFact[]; omitted: OmittedFact[] }> {
  const facts: ContextFact[] = [];
  const omitted: OmittedFact[] = [];
  if (!subject || !parseFactId(`${subject.aggregate}/${subject.id}`)) return { facts, omitted };
  let bytes = 0;
  const take = (key: string, group: ContextFact[]) => {
    const size = group.reduce((sum, fact) => sum + factBytes(fact), 0);
    if (facts.length + group.length > SNAPSHOT_LIMITS.facts) omitted.push({ fact_id: key, reason: "limit_reached" });
    else if (bytes + size > budgetBytes) omitted.push({ fact_id: key, reason: "too_large" });
    else {
      facts.push(...group);
      bytes += size;
    }
  };
  const rootKey = `${subject.aggregate}/${subject.id}`;
  const root = await tryReadObjectFacts(db, models, tenantId, specialistId, subject.aggregate, subject.id, now);
  if ("failed" in root) return { facts, omitted: [{ fact_id: rootKey, reason: "unreadable" }] };
  if (!root.read) return { facts, omitted };
  take(rootKey, root.read.facts);
  const seen = new Set([rootKey]);
  for (const link of root.read.links) {
    const key = `${link.kind}/${link.id}`;
    if (seen.has(key) || !parseFactId(key)) continue;
    seen.add(key);
    const linked = await tryReadObjectFacts(db, models, tenantId, specialistId, link.kind, link.id, now);
    if ("failed" in linked) omitted.push({ fact_id: key, reason: "unreadable" });
    // A linked object that does not fit is left out whole; a smaller later one may still fit.
    else if (linked.read) take(key, linked.read.facts);
  }
  return { facts, omitted };
}

/** The ref a citation falls under: the fact itself, or the part of it the pointer names. */
function refUnder(byId: Map<string, FactRef>, citation: string): { ref: FactRef; rest: string } | null {
  const parsed = parseFactId(citation);
  if (!parsed) return null;
  const base = `${parsed.kind}/${parsed.id}`;
  const exact = byId.get(citation);
  if (exact) return { ref: exact, rest: "" };
  if (parsed.pointer === null) return null;
  const whole = byId.get(base);
  if (whole) return { ref: whole, rest: parsed.pointer };
  // A part fact (`job/x#/facts/commercial`) covers the pointers below it, never a sibling prefix.
  for (const [factId, ref] of byId) {
    const part = parseFactId(factId);
    if (!part || part.pointer === null || `${part.kind}/${part.id}` !== base) continue;
    if (parsed.pointer.startsWith(`${part.pointer}/`)) return { ref, rest: parsed.pointer.slice(part.pointer.length) };
  }
  return null;
}

/** Reads a fact's value again; the signal's value comes from its immutable signal row. */
export type FactReader = (ref: FactRef) => Promise<ContextFact | null>;

export function factReader(
  db: AgentDb,
  models: Record<string, ObjectModel>,
  tenantId: string,
  specialistId: string,
  now: string,
  signal: (ref: FactRef) => Promise<ContextFact | null>,
): FactReader {
  const reads = new Map<string, Promise<Map<string, ContextFact> | null>>();
  return async (ref) => {
    if (ref.kind === "signal") return await signal(ref);
    const parsed = parseFactId(ref.fact_id);
    if (!parsed) return null;
    const key = `${parsed.kind}/${parsed.id}`;
    if (!reads.has(key))
      reads.set(
        key,
        tryReadObjectFacts(db, models, tenantId, specialistId, parsed.kind, parsed.id, now).then((result) =>
          "read" in result && result.read ? new Map(result.read.facts.map((fact) => [fact.fact_id, fact])) : null,
        ),
      );
    return (await reads.get(key)!)?.get(ref.fact_id) ?? null;
  };
}

/**
 * A resumed run's facts: each ref read again. A fact still at its version comes back with its
 * value; one that changed or can no longer be read comes back without a value and marked, so the
 * run sees it is stale instead of acting on the new value under the old version.
 */
export async function hydrate(refs: FactRef[], read: FactReader): Promise<Array<ContextFact & { current?: false }>> {
  const facts: Array<ContextFact & { current?: false }> = [];
  for (const ref of refs) {
    const fresh = await read(ref);
    facts.push(fresh && fresh.version === ref.version && fresh.hash === ref.hash ? { ...ref, data: fresh.data } : { ...ref, data: null, current: false });
  }
  return facts;
}

/**
 * Snapshot entries and current versions for a step's citations, read again now. A pointer
 * citation exists only where the pointer resolves in the value at the cited version; it gets its
 * own entry carrying the enclosing fact's version and the hash of the cited value. A fact reports
 * its current ledger version, so a changed value is a newer version (stale) and an unreadable one
 * is null (unverifiable), never the old version.
 */
export async function citedFacts(
  citations: Citation[],
  refs: FactRef[],
  read: FactReader,
): Promise<{ snapshot: Map<string, SnapshotFact>; currentVersions: Map<string, number | null> }> {
  const byId = new Map(refs.map((ref) => [ref.fact_id, ref]));
  const snapshot = new Map<string, SnapshotFact>(byId);
  const currentVersions = new Map<string, number | null>();
  for (const citation of citations) {
    const under = refUnder(byId, citation.fact_id);
    const fresh = under ? await read(under.ref) : null;
    if (!under || !fresh) {
      currentVersions.set(citation.fact_id, null);
      continue;
    }
    if (fresh.version !== under.ref.version) {
      currentVersions.set(citation.fact_id, fresh.version);
      continue;
    }
    // One version names one value, so the value read now is the value the run was given.
    const value = resolvePointer(fresh.data, under.rest);
    if (value === undefined) {
      currentVersions.set(citation.fact_id, null);
      continue;
    }
    if (under.rest !== "") snapshot.set(citation.fact_id, { ...under.ref, fact_id: citation.fact_id, hash: await factHash(value) });
    currentVersions.set(citation.fact_id, fresh.version);
  }
  return { snapshot, currentVersions };
}
