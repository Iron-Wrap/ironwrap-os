// The one tenant this host works for. A shared multi-tenant Worker resolves the tenant per request,
// so the host token alone decides whose signals and runs the host sees; this binding makes sure a
// token, URL or state directory pointed at another tenant stops the host instead of running that
// tenant's work under this host's sign-ins, ceilings and ledger.
//
// `AGENT_HOST_TENANT_ID` pins the tenant up front. Without it the host adopts the tenant the Worker
// names first (normally on the first heartbeat) and keeps it in the state directory, so a restart
// cannot silently adopt another one. Every Worker answer that names a tenant is then checked; a
// mismatch refuses the batch or the run before any provider call (`tenant_mismatch`).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const STATE_FILE = "tenant-id";

export class TenantMismatch extends Error {
  readonly expected: string;
  readonly reported: string | null;

  constructor(expected: string, reported: string | null, where: string) {
    super(`tenant_mismatch: the Worker answered ${where} for tenant ${JSON.stringify(reported)}, this host works for ${expected}`);
    this.name = "TenantMismatch";
    this.expected = expected;
    this.reported = reported;
  }
}

export class TenantBinding {
  private tenant: string | null;
  private readonly stateDir: string;
  private readonly dataClass: string | null;
  private readonly log: (event: Record<string, unknown>) => void;

  /** Throws when the configured tenant and the one the state directory was bound to differ. */
  constructor(configured: string | null, stateDir: string, log: (event: Record<string, unknown>) => void, dataClass: string | null = null) {
    this.stateDir = stateDir;
    this.dataClass = dataClass;
    this.log = log;
    const file = join(stateDir, STATE_FILE);
    const stored = existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
    if (configured && stored && configured !== stored) {
      throw new Error(`AGENT_HOST_TENANT_ID is ${configured}, but the state directory belongs to tenant ${stored}`);
    }
    this.tenant = configured ?? stored;
    if (configured && !stored) this.save(configured);
  }

  current(): string | null {
    return this.tenant;
  }

  /**
   * Checks the tenant one Worker answer names and returns it. An answer without one (a Worker
   * before the field) passes only while nothing is bound yet; once bound it is a mismatch. The
   * data class the answer names must be the host's own (`AGENT_HOST_DATA_CLASS`) when both are
   * known: a synthetic host never works a business tenant, nor the reverse.
   */
  check(reported: unknown, where: string, dataClass?: unknown): string | null {
    if (this.dataClass !== null && typeof dataClass === "string" && dataClass !== this.dataClass) {
      this.log({ event: "data_class_mismatch", expected: this.dataClass, reported: dataClass, where });
      throw new Error(`data_class_mismatch: the Worker answered ${where} for ${dataClass} data, this host is ${this.dataClass}`);
    }
    const named = typeof reported === "string" && TENANT_ID.test(reported) ? reported : null;
    if (this.tenant === null) {
      if (named !== null) {
        this.tenant = named;
        this.save(named);
        this.log({ event: "tenant_adopted", tenant_id: named, where });
      }
      return named;
    }
    if (named !== this.tenant) {
      this.log({ event: "tenant_mismatch", expected: this.tenant, reported: named, where });
      throw new TenantMismatch(this.tenant, named, where);
    }
    return named;
  }

  private save(tenant: string): void {
    const file = join(this.stateDir, STATE_FILE);
    writeFileSync(`${file}.tmp`, tenant);
    renameSync(`${file}.tmp`, file);
  }
}
