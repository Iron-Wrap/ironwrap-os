import type { AuthenticatedSession } from "../auth/session";
import { ApiError } from "../lib/api";
import type { PreparedEvidenceFile } from "./evidence-file";
import { evidenceProblemFromError, type EvidenceProblem } from "./evidence-messages";
import {
  uploadEvidenceWithRetry,
  type EvidenceRetryOptions,
  type EvidenceUploadRequest,
  type EvidenceUploadResult,
  type EvidenceWait,
} from "./evidence-upload";
import {
  EVIDENCE_MAX_FILES,
  evidenceScopeKey,
  isUploadableScope,
  newEvidenceUploadKey,
  type EvidenceMimeType,
  type EvidenceScope,
} from "./evidence-types";

/**
 * The files one form has selected, and where each one stands.
 *
 * - `held`: chosen, not sent. Either the scope is not complete yet, there is no signal, or it is
 *   next in line.
 * - `uploading`: being sent now.
 * - `waiting`: told to wait (too many uploads, or a weak link); it starts again by itself.
 * - `uploaded`: the Worker confirmed it and gave a receipt.
 * - `failed`: stopped, with a plain reason and one next step.
 */
export type EvidenceItemStatus = "held" | "uploading" | "waiting" | "uploaded" | "failed";

export interface EvidenceItem {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mime: EvidenceMimeType;
  readonly blob: Blob;
  /** One key per file and scope, kept for every retry. A new one only comes with a fresh choice. */
  readonly key: string;
  readonly status: EvidenceItemStatus;
  readonly receiptId?: string;
  readonly wait?: EvidenceWait;
  readonly problem?: EvidenceProblem & { code: string };
}

export interface EvidenceSnapshot {
  readonly items: readonly EvidenceItem[];
  /**
   * The scope these items are keyed to ("" while it is incomplete). A form compares it with its
   * own scope, so receipts are never paired with an action they were not uploaded for.
   */
  readonly scopeKey: string;
}

export interface EvidenceContext {
  session: AuthenticatedSession | null;
  scope: EvidenceScope | null;
  online: boolean;
  /** What the files belong to, in a word a person uses ("job", "stock lot"). */
  target?: string;
}

export interface EvidenceUploadsOptions {
  upload?: (
    request: EvidenceUploadRequest,
    options: EvidenceRetryOptions,
  ) => Promise<EvidenceUploadResult>;
  now?: () => number;
  /** How long a changed scope must hold still before files go up again (a job ID being typed). */
  settleMs?: number;
}

export const EVIDENCE_SCOPE_SETTLE_MS = 600;

function isAbort(error: unknown): boolean {
  return error instanceof ApiError && error.code === "aborted";
}

/**
 * A small external store, so the timing-heavy part (one upload at a time, waiting out a limit,
 * starting over when the scope changes) is plain code that can be tested without a renderer.
 * The React hook is a thin shell around it.
 */
export class EvidenceUploads {
  private items: EvidenceItem[] = [];
  private snapshot: EvidenceSnapshot = { items: [], scopeKey: "" };
  private context: EvidenceContext = { session: null, scope: null, online: false };
  private scopeKey = "";
  private settledAt = 0;
  private running = false;
  /** Set when the form goes away: nothing may start uploading for a screen nobody is looking at. */
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly aborts = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  private readonly upload: NonNullable<EvidenceUploadsOptions["upload"]>;
  private readonly now: () => number;
  private readonly settleMs: number;

  constructor(options: EvidenceUploadsOptions = {}) {
    this.upload = options.upload ?? uploadEvidenceWithRetry;
    this.now = options.now ?? Date.now;
    this.settleMs = options.settleMs ?? EVIDENCE_SCOPE_SETTLE_MS;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): EvidenceSnapshot => this.snapshot;

  setContext(next: EvidenceContext): void {
    // A form that mounts again (React's development double mount) gets the store back.
    this.disposed = false;
    const previous = this.context;
    this.context = { ...next };
    const nextKey = isUploadableScope(next.scope) ? evidenceScopeKey(next.scope) : "";
    let changed = false;
    if (nextKey !== this.scopeKey) {
      this.scopeKey = nextKey;
      changed = true;
      if (this.items.length > 0) {
        // Receipts belong to one scope. A file moved to another one needs a new key and a new
        // upload; the old key would only be refused as a conflict.
        this.abortAll();
        this.items = this.items.map((item) => ({
          id: item.id,
          name: item.name,
          size: item.size,
          mime: item.mime,
          blob: item.blob,
          key: newEvidenceUploadKey(),
          status: "held",
        }));
        this.settledAt = this.now() + this.settleMs;
      }
    }
    if (previous.online && !next.online) {
      this.abortAll();
      this.items = this.items.map((item) =>
        item.status === "uploading" || item.status === "waiting"
          ? withoutProgress(item, "held")
          : item,
      );
      changed = true;
    }
    if (changed) this.emit();
    this.pump();
  }

  /** Adds checked files up to the limit. Returns how many were left out for lack of room. */
  add(files: readonly PreparedEvidenceFile[]): { added: number; skipped: number } {
    // Files finished reading after the form was left: they would only upload for nobody.
    if (this.disposed) return { added: 0, skipped: 0 };
    const room = Math.max(0, EVIDENCE_MAX_FILES - this.items.length);
    const accepted = files.slice(0, room);
    for (const file of accepted) {
      this.items.push({
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        mime: file.mime,
        blob: file.blob,
        key: newEvidenceUploadKey(),
        status: "held",
      });
    }
    if (accepted.length > 0) this.emit();
    this.pump();
    return { added: accepted.length, skipped: files.length - accepted.length };
  }

  remove(id: string): void {
    this.aborts.get(id)?.abort();
    this.aborts.delete(id);
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length !== before) this.emit();
    this.pump();
  }

  /** Sends a failed file again with the same key. Only where sending the same file can work. */
  retry(id: string): void {
    const index = this.items.findIndex((item) => item.id === id);
    const item = this.items[index];
    if (!item || item.status !== "failed" || item.problem?.next !== "retry") return;
    this.items[index] = withoutProgress(item, "held");
    this.emit();
    this.pump();
  }

  reset(): void {
    this.abortAll();
    this.items = [];
    this.emit();
  }

  /** Stops anything in flight and clears timers. The store stays usable if the form comes back. */
  dispose(): void {
    this.disposed = true;
    this.abortAll();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.items = this.items.map((item) =>
      item.status === "uploading" || item.status === "waiting"
        ? withoutProgress(item, "held")
        : item,
    );
    this.emit();
  }

  private abortAll(): void {
    for (const controller of this.aborts.values()) controller.abort();
    this.aborts.clear();
  }

  private emit(): void {
    this.snapshot = { items: [...this.items], scopeKey: this.scopeKey };
    for (const listener of [...this.listeners]) listener();
  }

  private patch(id: string, update: Partial<EvidenceItem>): void {
    const index = this.items.findIndex((item) => item.id === id);
    const item = this.items[index];
    if (!item) return;
    this.items[index] = { ...item, ...update };
    this.emit();
  }

  private canUpload(): boolean {
    const { session, scope, online } = this.context;
    return online && session !== null && isUploadableScope(scope);
  }

  private pump(): void {
    if (this.disposed || this.running || !this.canUpload()) return;
    const next = this.items.find((item) => item.status === "held");
    if (!next) return;
    const remaining = this.settledAt - this.now();
    if (remaining > 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, remaining);
      return;
    }
    this.running = true;
    void this.run(next.id).finally(() => {
      this.running = false;
      this.pump();
    });
  }

  private async run(id: string): Promise<void> {
    const item = this.items.find((candidate) => candidate.id === id);
    const { session, scope, target } = this.context;
    if (!item || !session || !scope) return;
    const controller = new AbortController();
    this.aborts.set(id, controller);
    this.patch(id, { status: "uploading" });
    const current = () => !controller.signal.aborted && this.items.some((entry) => entry.id === id);
    try {
      const result = await this.upload(
        {
          session,
          scope,
          key: item.key,
          file: { name: item.name, blob: item.blob },
          signal: controller.signal,
        },
        {
          onWait: (wait) => {
            if (!current()) return;
            if (wait) this.patch(id, { status: "waiting", wait });
            else this.patch(id, { status: "uploading", wait: undefined });
          },
        },
      );
      if (!current()) return;
      this.patch(id, { status: "uploaded", receiptId: result.receiptId, wait: undefined });
    } catch (error) {
      if (!current() || isAbort(error)) return;
      this.patch(id, {
        status: "failed",
        wait: undefined,
        problem: {
          ...evidenceProblemFromError(error, target),
          code: error instanceof ApiError ? error.code : "upload_failed",
        },
      });
    } finally {
      if (this.aborts.get(id) === controller) this.aborts.delete(id);
    }
  }
}

function withoutProgress(item: EvidenceItem, status: EvidenceItemStatus): EvidenceItem {
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    mime: item.mime,
    blob: item.blob,
    key: item.key,
    status,
  };
}

/** Receipts in the order the files were chosen. */
export function evidenceReceiptIds(items: readonly EvidenceItem[]): string[] {
  return items.flatMap((item) =>
    item.status === "uploaded" && item.receiptId ? [item.receiptId] : [],
  );
}

/**
 * Whether the form that owns these files may be submitted. Online, every file must have
 * uploaded. Where the form can save its work for later (`queue`), a file that is only waiting
 * for signal counts too: it is kept on the device with its key and goes up first on reconnect.
 */
export function evidenceReady(
  items: readonly EvidenceItem[],
  rule: { min: number; queue: boolean },
): boolean {
  if (items.length < rule.min || items.length > EVIDENCE_MAX_FILES) return false;
  return items.every(
    (item) => item.status === "uploaded" || (rule.queue && item.status === "held"),
  );
}

/** What the offline queue must keep: the scope, and per file its key, bytes or confirmed receipt. */
export interface EvidenceSubmission {
  scope: EvidenceScope;
  files: Array<{
    uploadKey: string;
    fileName: string;
    mimeType: string;
    size: number;
    receiptId?: string;
    /** Always present: the saved action keeps the file until the Worker confirms the action. */
    blob: Blob;
  }>;
}

export function freezeEvidence(
  scope: EvidenceScope,
  items: readonly EvidenceItem[],
): EvidenceSubmission {
  return {
    scope: { ...scope },
    files: items.map((item) => ({
      uploadKey: item.key,
      fileName: item.name,
      mimeType: item.mime,
      size: item.size,
      blob: item.blob,
      ...(item.status === "uploaded" && item.receiptId ? { receiptId: item.receiptId } : {}),
    })),
  };
}
