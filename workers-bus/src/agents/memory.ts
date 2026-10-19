// Shared memory (AI-TEAM-CONTRACT.md "Shared memory"): the canonical D1 objects as exact,
// versioned facts. A run's context snapshot holds the signal's subject and the objects it links
// to, read through the same rows the role screens read and only as far as the reader may read
// them: the specialist's reviewer role, or the asker's role when the face answers a person's ask.
// Every cited fact is read again before the step is decided.
//
// A fact is `<object>/<id>`, or `<object>/<id>#<pointer>` when the reader's role may read only
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
import { permissionsForRole, ROLE_PERMISSIONS, type AppRole } from "../app-types.ts";
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
  /** Widest first: a reader gets the first view its role holds the permission for. */
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

/**
 * Whose read rights the facts follow: a specialist id reads as its catalog reviewer role; `{role}`
 * reads as one person's role (the face answering that person's ask, or a screen checking its
 * facts). A role the app does not define reads nothing.
 */
export type Reader = string | { role: string };

/** The view a reader's role is granted on an object kind, or null. */
export function viewFor(models: Record<string, ObjectModel>, reader: Reader, kind: string): ObjectView | null {
  const model = Object.hasOwn(models, kind) ? models[kind] : undefined;
  const role = typeof reader === "string" ? catalogSpecialist(reader)?.reviewer_role : reader.role;
  if (!model || !role || !Object.hasOwn(ROLE_PERMISSIONS, role)) return null;
  const permissions = permissionsForRole(role as AppRole);
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

/** One canonical object's parts for a reader: each fact's id, value and hash, before any version. */
interface ObjectParts {
  kind: string;
  parts: Array<{ fact_id: string; value: unknown; hash: string }>;
  links: ObjectRead["links"];
}

/**
 * One canonical object for this reader: the whole object, or one part per pointer its view shows.
 * Null when the object does not exist or the reader's role may not read it; a failing read throws.
 */
async function readObjectParts(db: AgentDb, models: Record<string, ObjectModel>, tenantId: string, reader: Reader, kind: string, id: string): Promise<ObjectParts | null> {
  const view = viewFor(models, reader, kind);
  if (!view) return null;
  const read = await models[kind].read(db, tenantId, id);
  if (!read) return null;
  const values: Array<[string, unknown]> =
    view.pointers === null
      ? [[`${kind}/${id}`, read.data]]
      : view.pointers.map((pointer) => [`${kind}/${id}#${pointer}`, resolvePointer(read.data, pointer)]);
  const parts: ObjectParts["parts"] = [];
  for (const [factId, value] of values) if (value !== undefined) parts.push({ fact_id: factId, value, hash: await factHash(value) });
  return parts.length > 0 ? { kind, parts, links: read.links } : null;
}

/** The same read, with a failure reported instead of thrown. */
async function tryReadObjectParts(...args: Parameters<typeof readObjectParts>): Promise<ObjectParts | null | "failed"> {
  try {
    return await readObjectParts(...args);
  } catch {
    return "failed";
  }
}

const toFact = (kind: string, part: ObjectParts["parts"][number], version: number, now: string): ContextFact => ({
  fact_id: part.fact_id,
  kind,
  version,
  hash: part.hash,
  trust: "owned",
  observed_at: now,
  fresh_until: null,
  data: part.value,
});

/**
 * One canonical object as facts for this reader: the whole object, or one fact per part its view
 * shows. Null when the object does not exist or the reader's role may not read it; a failing read
 * throws.
 */
export async function readObjectFacts(
  db: AgentDb,
  models: Record<string, ObjectModel>,
  tenantId: string,
  reader: Reader,
  kind: string,
  id: string,
  now: string,
): Promise<{ facts: ContextFact[]; links: ObjectRead["links"] } | null> {
  const read = await readObjectParts(db, models, tenantId, reader, kind, id);
  if (!read) return null;
  const facts: ContextFact[] = [];
  for (const part of read.parts) facts.push(toFact(kind, part, await factVersion(db, tenantId, part.fact_id, part.hash, now), now));
  return { facts, links: read.links };
}

/** The same read, with a failure reported instead of thrown. */
async function tryReadObjectFacts(...args: Parameters<typeof readObjectFacts>) {
  try {
    return { read: await readObjectFacts(...args) };
  } catch {
    return { failed: true as const };
  }
}

/** Fact ids per ledger read: D1 binds at most 100 parameters to one statement. */
const LEDGER_READ_IDS = 90;

/** The latest ledger line of each fact id, in one statement per 90 ids. */
async function latestVersions(db: AgentDb, tenantId: string, factIds: string[]): Promise<Map<string, { version: number; hash: string }>> {
  const latest = new Map<string, { version: number; hash: string }>();
  const ids = [...new Set(factIds)];
  for (let start = 0; start < ids.length; start += LEDGER_READ_IDS) {
    const chunk = ids.slice(start, start + LEDGER_READ_IDS);
    const rows = await db
      .prepare(
        `SELECT fact_id, version, hash FROM agent_fact_versions line
          WHERE tenant_id = ? AND fact_id IN (${chunk.map(() => "?").join(", ")})
            AND version = (SELECT MAX(version) FROM agent_fact_versions WHERE tenant_id = line.tenant_id AND fact_id = line.fact_id)`,
      )
      .bind(tenantId, ...chunk)
      .all<{ fact_id: string; version: number; hash: string }>();
    for (const row of rows.results ?? []) latest.set(row.fact_id, { version: row.version, hash: row.hash });
  }
  return latest;
}

/**
 * Versions for facts read together, as factVersion gives them: a value the ledger holds keeps its
 * version, any other takes the next one. The ledger is read once per batch of fact ids, and a new
 * value's line is written only when `commit` keeps that fact, so a fact no run is given is never
 * recorded.
 */
function pendingLedger(db: AgentDb, tenantId: string, now: string) {
  const latest = new Map<string, { version: number; hash: string } | null>();
  return {
    async load(factIds: string[]) {
      const missing = [...new Set(factIds)].filter((id) => !latest.has(id));
      const found = await latestVersions(db, tenantId, missing);
      for (const id of missing) latest.set(id, found.get(id) ?? null);
    },
    /** The facts of loaded parts, each at the version it holds or the next one. */
    versioned(read: ObjectParts): ContextFact[] {
      return read.parts.map((part) => {
        const line = latest.get(part.fact_id) ?? null;
        return toFact(read.kind, part, line?.hash === part.hash ? line.version : (line?.version ?? 0) + 1, now);
      });
    },
    /** Records the new values among the kept facts, in one batch; a writer racing it is settled as factVersion settles it. */
    async commit(facts: ContextFact[]): Promise<ContextFact[]> {
      const fresh = new Map<string, ContextFact>();
      for (const fact of facts) if (latest.get(fact.fact_id)?.hash !== fact.hash) fresh.set(fact.fact_id, fact);
      if (fresh.size === 0) return facts;
      const insert = (fact: ContextFact) =>
        db.prepare("INSERT INTO agent_fact_versions (tenant_id, fact_id, version, hash, observed_at) VALUES (?, ?, ?, ?, ?)").bind(tenantId, fact.fact_id, fact.version, fact.hash, now);
      try {
        await db.batch([...fresh.values()].map(insert));
      } catch (error) {
        const message = String(error);
        if (!message.includes(LEDGER_RACE) && !message.includes("UNIQUE constraint failed: agent_fact_versions")) throw error;
        // Another reader recorded one of these facts first: each takes the version factVersion gives it.
        const settled = new Map<string, number>();
        for (const fact of fresh.values()) settled.set(fact.fact_id, await factVersion(db, tenantId, fact.fact_id, fact.hash, now));
        facts = facts.map((fact) => (settled.has(fact.fact_id) ? { ...fact, version: settled.get(fact.fact_id)! } : fact));
      }
      for (const fact of fresh.values()) latest.set(fact.fact_id, { version: facts.find((kept) => kept.fact_id === fact.fact_id)!.version, hash: fact.hash });
      return facts;
    },
  };
}

/** Object reads in flight at once for one run: each job read already runs its own queries in parallel. */
const READ_CONCURRENCY = 6;

/** `task` over `items` with at most `limit` running at once; the results keep the items' order. */
async function inPool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) results[index] = await task(items[index]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A subject's objects as read: its root, then each object it links to, once, in link order. */
interface SubjectRead {
  key: string;
  root: ObjectParts | null | "failed";
  links: Array<{ key: string; read: ObjectParts | null | "failed" }>;
}

/** Reads a subject and, when its root is readable, every object it links to, the links in parallel. */
async function readSubject(db: AgentDb, models: Record<string, ObjectModel>, tenantId: string, reader: Reader, subject: { aggregate: string; id: string }): Promise<SubjectRead> {
  const key = `${subject.aggregate}/${subject.id}`;
  const root = await tryReadObjectParts(db, models, tenantId, reader, subject.aggregate, subject.id);
  if (root === null || root === "failed") return { key, root, links: [] };
  const seen = new Set([key]);
  const linked: Array<{ kind: string; id: string; key: string }> = [];
  for (const link of root.links) {
    const linkKey = `${link.kind}/${link.id}`;
    if (seen.has(linkKey) || !parseFactId(linkKey)) continue;
    seen.add(linkKey);
    linked.push({ ...link, key: linkKey });
  }
  const links = await inPool(linked, READ_CONCURRENCY, async (link) => ({ key: link.key, read: await tryReadObjectParts(db, models, tenantId, reader, link.kind, link.id) }));
  return { key, root, links };
}

const partsOf = (read: SubjectRead) =>
  [read.root, ...read.links.map((link) => link.read)].flatMap((parts) => (parts && parts !== "failed" ? parts.parts.map((part) => part.fact_id) : []));

/**
 * A subject's facts within the snapshot limits: the subject first, then the objects it links to, in
 * link order. Objects the reader may not read are left out silently; an object that cannot be read,
 * or does not fit, is named in `omitted` so the run knows it is missing.
 */
function takeSubject(read: SubjectRead, versioned: (parts: ObjectParts) => ContextFact[], budgetBytes: number): { facts: ContextFact[]; omitted: OmittedFact[] } {
  const facts: ContextFact[] = [];
  const omitted: OmittedFact[] = [];
  if (read.root === "failed") return { facts, omitted: [{ fact_id: read.key, reason: "unreadable" }] };
  if (read.root === null) return { facts, omitted };
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
  take(read.key, versioned(read.root));
  for (const link of read.links) {
    if (link.read === "failed") omitted.push({ fact_id: link.key, reason: "unreadable" });
    // A linked object that does not fit is left out whole; a smaller later one may still fit.
    else if (link.read) take(link.key, versioned(link.read));
  }
  return { facts, omitted };
}

/**
 * The facts a run starts from: the subject first, then the objects it links to, in link order,
 * within the snapshot limits. Objects the reader may not read are left out silently; an object
 * that cannot be read, or does not fit, is named in `omitted` so the run knows it is missing.
 */
export async function subjectFacts(
  db: AgentDb,
  models: Record<string, ObjectModel>,
  tenantId: string,
  reader: Reader,
  subject: { aggregate: string; id: string } | null,
  now: string,
  budgetBytes = SNAPSHOT_LIMITS.bytes,
): Promise<{ facts: ContextFact[]; omitted: OmittedFact[] }> {
  if (!subject || !parseFactId(`${subject.aggregate}/${subject.id}`)) return { facts: [], omitted: [] };
  const read = await readSubject(db, models, tenantId, reader, subject);
  const ledger = pendingLedger(db, tenantId, now);
  await ledger.load(partsOf(read));
  const taken = takeSubject(read, ledger.versioned, budgetBytes);
  return { facts: await ledger.commit(taken.facts), omitted: taken.omitted };
}

/** Subjects read at once for a watch run; the snapshot decides in subject order after each group. */
const SUBJECT_GROUP = READ_CONCURRENCY;

/**
 * The facts for several subjects (a watch's objects), in order, sharing one snapshot's limits.
 * A fact already taken for an earlier subject is not repeated.
 */
export async function subjectsFacts(
  db: AgentDb,
  models: Record<string, ObjectModel>,
  tenantId: string,
  specialistId: string,
  subjects: Array<{ aggregate: string; id: string }>,
  now: string,
): Promise<{ facts: ContextFact[]; omitted: OmittedFact[] }> {
  const facts: ContextFact[] = [];
  const omitted: OmittedFact[] = [];
  const taken = new Set<string>();
  const ledger = pendingLedger(db, tenantId, now);
  let bytes = 0;
  for (let start = 0; start < subjects.length; start += SUBJECT_GROUP) {
    const group = subjects.slice(start, start + SUBJECT_GROUP);
    // Once the snapshot is full, the rest are named without being read, as before.
    const reads =
      facts.length >= SNAPSHOT_LIMITS.facts
        ? group.map(() => null)
        : await Promise.all(group.map((subject) => (parseFactId(`${subject.aggregate}/${subject.id}`) ? readSubject(db, models, tenantId, specialistId, subject) : null)));
    await ledger.load(reads.flatMap((read) => (read ? partsOf(read) : [])));
    for (const [index, subject] of group.entries()) {
      if (facts.length >= SNAPSHOT_LIMITS.facts) {
        omitted.push({ fact_id: `${subject.aggregate}/${subject.id}`, reason: "limit_reached" });
        continue;
      }
      const read = reads[index];
      const part = read ? takeSubject(read, ledger.versioned, SNAPSHOT_LIMITS.bytes - bytes) : { facts: [], omitted: [] };
      const fresh = part.facts.filter((fact) => !taken.has(fact.fact_id));
      // A subject's facts go in whole or not at all, so a run never mistakes a part for the object.
      if (facts.length + fresh.length > SNAPSHOT_LIMITS.facts) {
        omitted.push({ fact_id: `${subject.aggregate}/${subject.id}`, reason: "limit_reached" });
        continue;
      }
      for (const fact of fresh) {
        taken.add(fact.fact_id);
        facts.push(fact);
        bytes += factBytes(fact);
      }
      omitted.push(...part.omitted.filter((entry) => !taken.has(entry.fact_id)));
    }
  }
  return { facts: await ledger.commit(facts), omitted };
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

/**
 * Reads a fact's value again; the signal's value comes from its immutable signal row. `all` reads
 * many at once, as a resume does.
 */
export type FactReader = ((ref: FactRef) => Promise<ContextFact | null>) & { all?: (refs: FactRef[]) => Promise<Array<ContextFact | null>> };

export function factReader(
  db: AgentDb,
  models: Record<string, ObjectModel>,
  tenantId: string,
  reader: Reader,
  now: string,
  signal: (ref: FactRef) => Promise<ContextFact | null>,
): FactReader {
  const reads = new Map<string, Promise<Map<string, ContextFact> | null>>();
  const read: FactReader = async (ref) => {
    if (ref.kind === "signal") return await signal(ref);
    const parsed = parseFactId(ref.fact_id);
    if (!parsed) return null;
    const key = `${parsed.kind}/${parsed.id}`;
    if (!reads.has(key))
      reads.set(
        key,
        tryReadObjectFacts(db, models, tenantId, reader, parsed.kind, parsed.id, now).then((result) =>
          "read" in result && result.read ? new Map(result.read.facts.map((fact) => [fact.fact_id, fact])) : null,
        ),
      );
    return (await reads.get(key)!)?.get(ref.fact_id) ?? null;
  };
  // Every object once, several at a time, and the ledger in one read: each fact at the version its
  // value holds, or the next one, which is not recorded (a resume only needs to know it moved).
  read.all = async (refs) => {
    const objects = [...new Set(refs.filter((ref) => ref.kind !== "signal").flatMap((ref) => {
      const parsed = parseFactId(ref.fact_id);
      return parsed ? [`${parsed.kind}/${parsed.id}`] : [];
    }))];
    const parts = new Map<string, ObjectParts | null>();
    await inPool(objects, READ_CONCURRENCY, async (key) => {
      const parsed = parseFactId(key)!;
      const result = await tryReadObjectParts(db, models, tenantId, reader, parsed.kind, parsed.id);
      parts.set(key, result === "failed" ? null : result);
    });
    const ledger = pendingLedger(db, tenantId, now);
    await ledger.load([...parts.values()].flatMap((object) => object?.parts.map((part) => part.fact_id) ?? []));
    const facts = new Map([...parts.values()].flatMap((object) => (object ? ledger.versioned(object) : [])).map((fact) => [fact.fact_id, fact]));
    return await Promise.all(refs.map(async (ref) => (ref.kind === "signal" ? await signal(ref) : (facts.get(ref.fact_id) ?? null))));
  };
  return read;
}

/**
 * A resumed run's facts: each ref read again. A fact still at its version comes back with its
 * value; one that changed or can no longer be read comes back without a value and marked, so the
 * run sees it is stale instead of acting on the new value under the old version.
 */
export async function hydrate(refs: FactRef[], read: FactReader): Promise<Array<ContextFact & { current?: false }>> {
  const fresh = read.all ? await read.all(refs) : await Promise.all(refs.map((ref) => read(ref)));
  return refs.map((ref, index) => {
    const now = fresh[index];
    return now && now.version === ref.version && now.hash === ref.hash ? { ...ref, data: now.data } : { ...ref, data: null, current: false as const };
  });
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

/**
 * Each fact's current version and hash as this reader may read it now, never its value: what a
 * screen checks before it shows a cited fact again. An id with a pointer carries the hash of the
 * value it names and the version it is cited at (`citedVersion`), whatever part of the object the
 * reader may read. A fact the reader may not read, that does not exist or that cannot be read now
 * is unreadable.
 */
export async function currentFacts(
  db: AgentDb,
  models: Record<string, ObjectModel>,
  tenantId: string,
  reader: Reader,
  factIds: string[],
  now: string,
): Promise<{ facts: Array<{ fact_id: string; version: number; hash: string }>; unreadable: string[] }> {
  const objects = new Map<string, Promise<Map<string, ContextFact> | null>>();
  const facts: Array<{ fact_id: string; version: number; hash: string }> = [];
  const unreadable: string[] = [];
  for (const factId of factIds) {
    const parsed = parseFactId(factId);
    if (!parsed) {
      unreadable.push(factId);
      continue;
    }
    const key = `${parsed.kind}/${parsed.id}`;
    if (!objects.has(key))
      objects.set(
        key,
        tryReadObjectFacts(db, models, tenantId, reader, parsed.kind, parsed.id, now).then((result) =>
          "read" in result && result.read ? new Map(result.read.facts.map((fact) => [fact.fact_id, fact])) : null,
        ),
      );
    const byId = await objects.get(key)!;
    const under = byId ? refUnder(byId, factId) : null;
    const value = under ? resolvePointer((under.ref as ContextFact).data, under.rest) : undefined;
    if (!under || value === undefined) unreadable.push(factId);
    else
      facts.push({
        fact_id: factId,
        version: await citedVersion(db, tenantId, under.ref as ContextFact, under.rest, now),
        hash: under.rest === "" ? under.ref.hash : await factHash(value),
      });
  }
  return { facts, unreadable };
}

/**
 * The version an id below a read fact is cited at, the same for every reader who may read it: that
 * of the narrowest ledger line between the id and the fact. A part a narrower role reads as its own
 * fact has its own line, so a wider reader (the owner, reading the whole object) gets the part's
 * version, not the object's; a step's pointer below a fact (`citedFacts`) keeps that fact's version.
 */
async function citedVersion(db: AgentDb, tenantId: string, read: ContextFact, rest: string, now: string): Promise<number> {
  const segments = rest === "" ? [] : rest.slice(1).split("/");
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const pointer = `/${segments.slice(0, depth).join("/")}`;
    const factId = read.fact_id.includes("#") ? `${read.fact_id}${pointer}` : `${read.fact_id}#${pointer}`;
    const line = await db
      .prepare("SELECT 1 AS found FROM agent_fact_versions WHERE tenant_id = ? AND fact_id = ? LIMIT 1")
      .bind(tenantId, factId)
      .first();
    if (line) return await factVersion(db, tenantId, factId, await factHash(resolvePointer(read.data, pointer)), now);
  }
  return read.version;
}
