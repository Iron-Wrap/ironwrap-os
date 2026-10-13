// Rolling-window usage ledger behind the call and cost ceilings, kept as an append-only JSONL file
// so a restart cannot reset a ceiling. A call is booked before it starts: the reservation record
// counts the call and the per-call cost ceiling, and the settlement record adjusts the cost to the
// actual figure. A crash between the two leaves the conservative reservation in force. If the file
// cannot be written, the ledger turns degraded and refuses every further reservation.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ceiling, GatewayConfig, SpecialistCeiling } from "./config.ts";
import type { ProviderId, Usage } from "./types.ts";

export interface UsageRecord {
  at: number;
  reservation: string;
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

export type Refusal = "call_ceiling" | "cost_ceiling" | "ledger_unavailable";

export class UsageLedger {
  private records: UsageRecord[] = [];
  private degraded = false;
  private sequence = 0;
  private readonly windowMs: number;
  private readonly ceilings: GatewayConfig["ceilings"];
  private readonly file: string;
  private readonly now: () => number;

  constructor(ceilings: GatewayConfig["ceilings"], file: string, now: () => number) {
    this.ceilings = ceilings;
    this.file = file;
    this.now = now;
    this.windowMs = ceilings.windowHours * 3_600_000;
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

  ceilingFor(specialist: string): SpecialistCeiling {
    return this.ceilings.specialists[specialist] ?? this.ceilings.specialistDefault;
  }

  /** Books one call at the specialist's per-call cost ceiling, or names the ceiling it would break. */
  reserve(specialist: string, provider: ProviderId, model: string): { reservation: Reservation } | { refusal: Refusal } {
    if (this.degraded) return { refusal: "ledger_unavailable" };
    this.prune();
    const own = this.ceilingFor(specialist);
    const team = this.totals(() => true);
    const mine = this.totals((s) => s === specialist);
    if (mine.calls + 1 > own.calls || team.calls + 1 > this.ceilings.team.calls) return { refusal: "call_ceiling" };
    const room = Math.min(own.costUsd - mine.costUsd, this.ceilings.team.costUsd - team.costUsd);
    if (room < own.costUsdPerCall) return { refusal: "cost_ceiling" };
    const at = this.now();
    const reservation: Reservation = {
      id: `${at}-${process.pid}-${(this.sequence += 1)}`,
      at,
      specialist,
      provider,
      model,
      costUsd: own.costUsdPerCall,
    };
    const booked = this.append({
      at,
      reservation: reservation.id,
      specialist,
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

  snapshot(): { team: Ceiling; specialists: Record<string, Ceiling> } {
    this.prune();
    const specialists: Record<string, Ceiling> = {};
    for (const record of this.records) {
      const entry = (specialists[record.specialist] ??= { calls: 0, costUsd: 0 });
      entry.calls += record.calls;
      entry.costUsd += record.costUsd;
    }
    return { team: this.totals(() => true), specialists };
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

  private totals(match: (specialist: string) => boolean): Ceiling {
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
    (record.calls === 0 || record.calls === 1) &&
    Number.isFinite(record.costUsd)
  );
}
