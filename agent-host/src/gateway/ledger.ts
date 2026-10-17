// Rolling-window usage ledger behind the call and cost ceilings, kept as an append-only JSONL file
// so a restart cannot reset a ceiling. A call is booked before it starts: the reservation record
// counts the call and the per-call cost ceiling, and the settlement record adjusts the cost to the
// actual figure. A crash between the two leaves the conservative reservation in force. If the file
// cannot be written, the ledger turns degraded and refuses every further reservation.
//
// A ledger key is a specialist id (live) or `<namespace>:<id>` (`shadow:`, `eval:`), and team totals
// are per namespace, so shadow and eval spend never count toward the live ceilings or each other.
// Records written before namespaces existed carry bare ids and so stay live.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ceiling, SpecialistCeiling } from "./config.ts";
import type { ProviderId, Usage } from "./types.ts";

export type Namespace = "live" | "shadow" | "eval";

/** A specialist id or the judge key; outside live, prefixed with its namespace. */
const LEDGER_KEY = /^(?:(?:shadow|eval):)?[a-z][a-z0-9_]{1,63}$/;

export interface UsageRecord {
  at: number;
  reservation: string;
  /** The ledger key: the specialist id, prefixed with its namespace outside live. */
  specialist: string;
  provider: ProviderId;
  model: string;
  outcome: string;
  /** 1 on the reservation record, 0 on its settlement. */
  calls: number;
  /** Per-call ceiling on the reservation, actual minus that ceiling on the settlement. */
  costUsd: number;
  usage: Usage;
}

export interface Reservation {
  id: string;
  at: number;
  specialist: string;
  provider: ProviderId;
  model: string;
  costUsd: number;
}

/** The ceilings one reservation is held to: its key's own and its namespace's team ceiling. */
export interface Limits {
  own: SpecialistCeiling;
  team: Ceiling;
}

export type Refusal = "call_ceiling" | "cost_ceiling" | "ledger_unavailable";

export function namespaceOf(key: string): string {
  const colon = key.indexOf(":");
  return colon === -1 ? "live" : key.slice(0, colon);
}

export class UsageLedger {
  private records: UsageRecord[] = [];
  private degraded = false;
  private sequence = 0;
  private readonly windowMs: number;
  private readonly file: string;
  private readonly now: () => number;

  constructor(file: string, windowHours: number, now: () => number) {
    this.file = file;
    this.now = now;
    this.windowMs = windowHours * 3_600_000;
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      return;
    }
    const cutoff = now() - this.windowMs;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let record: UsageRecord;
      try {
        record = JSON.parse(line) as UsageRecord;
      } catch {
        continue; // A torn final line from a crash; earlier records stay authoritative.
      }
      if (!isRecord(record)) {
        // A record that cannot be counted would disable every ceiling; refuse to spend instead.
        this.degraded = true;
        continue;
      }
      if (record.at >= cutoff) this.records.push(record);
    }
    if (!this.degraded && this.records.length !== lines.length) {
      // Write aside and rename, so a crash mid-rewrite cannot lose the window.
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, this.records.map((record) => `${JSON.stringify(record)}\n`).join(""));
      renameSync(temp, file);
    }
  }

  /**
   * Books one call at the key's per-call cost ceiling, or names the ceiling it would break and
   * when the oldest reservation counted against it leaves the window.
   */
  reserve(
    key: string,
    limits: Limits,
    provider: ProviderId,
    model: string,
  ): { reservation: Reservation } | { refusal: Refusal; retryAt?: number } {
    if (this.degraded) return { refusal: "ledger_unavailable" };
    this.prune();
    const namespace = namespaceOf(key);
    const ownKey = (candidate: string) => candidate === key;
    const teamKey = (candidate: string) => namespaceOf(candidate) === namespace;
    const mine = this.totals(ownKey);
    const team = this.totals(teamKey);
    const { own } = limits;
    const full: Array<(key: string) => boolean> = [];
    if (mine.calls + 1 > own.calls) full.push(ownKey);
    if (team.calls + 1 > limits.team.calls) full.push(teamKey);
    if (full.length > 0) return { refusal: "call_ceiling", ...this.freedAt(full) };
    if (own.costUsd - mine.costUsd < own.costUsdPerCall) full.push(ownKey);
    if (limits.team.costUsd - team.costUsd < own.costUsdPerCall) full.push(teamKey);
    if (full.length > 0) return { refusal: "cost_ceiling", ...this.freedAt(full) };
    const at = this.now();
    const reservation: Reservation = {
      id: `${at}-${process.pid}-${(this.sequence += 1)}`,
      at,
      specialist: key,
      provider,
      model,
      costUsd: own.costUsdPerCall,
    };
    const booked = this.append({
      at,
      reservation: reservation.id,
      specialist: key,
      provider,
      model,
      outcome: "reserved",
      calls: 1,
      costUsd: reservation.costUsd,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    });
    return booked ? { reservation } : { refusal: "ledger_unavailable" };
  }

  /** Records the actual cost. Never throws: a write failure degrades the ledger instead. */
  settle(reservation: Reservation, outcome: string, reportedCostUsd: number, usage: Usage): void {
    // An unusable cost figure is booked at the full reservation rather than trusted.
    const costUsd = Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0 ? reportedCostUsd : reservation.costUsd;
    // Dated at the reservation so the pair leaves the window together.
    this.append({
      at: reservation.at,
      reservation: reservation.id,
      specialist: reservation.specialist,
      provider: reservation.provider,
      model: reservation.model,
      outcome,
      calls: 0,
      costUsd: costUsd - reservation.costUsd,
      usage,
    });
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  snapshot(): { teams: Record<Namespace, Ceiling>; specialists: Record<string, Ceiling> } {
    this.prune();
    // A Map, so a key such as `constructor` adds up on its own entry, never on a prototype member.
    const specialists = new Map<string, Ceiling>();
    for (const record of this.records) {
      const entry = specialists.get(record.specialist) ?? { calls: 0, costUsd: 0 };
      entry.calls += record.calls;
      entry.costUsd += record.costUsd;
      specialists.set(record.specialist, entry);
    }
    const team = (namespace: Namespace) => this.totals((key) => namespaceOf(key) === namespace);
    return { teams: { live: team("live"), shadow: team("shadow"), eval: team("eval") }, specialists: Object.fromEntries(specialists) };
  }

  /**
   * The first moment every refusing ceiling has a reservation fewer: each one's oldest counted
   * reservation has left the window. A settling call can free cost room sooner; nothing counted
   * means waiting cannot help, so there is no time.
   */
  private freedAt(ceilings: Array<(key: string) => boolean>): { retryAt?: number } {
    let retryAt = 0;
    for (const match of ceilings) {
      let oldest = Number.POSITIVE_INFINITY;
      for (const record of this.records) {
        if (record.calls === 1 && match(record.specialist)) oldest = Math.min(oldest, record.at);
      }
      if (oldest === Number.POSITIVE_INFINITY) return {};
      // prune() keeps a record while `at >= now - window`, so it is gone one millisecond later.
      retryAt = Math.max(retryAt, oldest + this.windowMs + 1);
    }
    return { retryAt };
  }

  private append(record: UsageRecord): boolean {
    // In memory first, so the books stay right for this process even when the file write fails.
    this.records.push(record);
    try {
      appendFileSync(this.file, `${JSON.stringify(record)}\n`);
      return true;
    } catch {
      this.degraded = true;
      return false;
    }
  }

  private totals(match: (key: string) => boolean): Ceiling {
    let calls = 0;
    let costUsd = 0;
    for (const record of this.records) {
      if (!match(record.specialist)) continue;
      calls += record.calls;
      costUsd += record.costUsd;
    }
    return { calls, costUsd };
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.records = this.records.filter((record) => record.at >= cutoff);
  }
}

function isRecord(value: unknown): value is UsageRecord {
  const record = value as UsageRecord;
  return (
    typeof record === "object" &&
    record !== null &&
    Number.isFinite(record.at) &&
    typeof record.specialist === "string" &&
    // A key in a namespace this version does not know would count toward no ceiling at all, and
    // the gateway never writes anything but a specialist id or judge key in a known namespace.
    LEDGER_KEY.test(record.specialist) &&
    (record.calls === 0 || record.calls === 1) &&
    Number.isFinite(record.costUsd)
  );
}
