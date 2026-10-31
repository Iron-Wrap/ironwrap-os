// Synthetic independent storage for agent API tests. No implicit production fallback exists.
export class MemoryAgentPrivacyLedger {
  objects = new Map<string, string>();
  failGet = false;
  failPut = false;
  losePutResponse = false;
  failList = false;
  omitReadback = false;
  afterPut: (() => void) | null = null;
  listOverride: ((options: { prefix: string; limit: number; cursor?: string }) => unknown) | null = null;
  async get(key: string) {
    if (this.failGet) throw new Error("synthetic_get_failure");
    const text = this.objects.get(key);
    if (text === undefined || this.omitReadback) return null;
    const bytes = new TextEncoder().encode(text);
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
  }
  async head(key: string) { return this.objects.has(key) ? { key } : null; }
  async put(key: string, text: string, options: { onlyIf?: Headers }) {
    if (this.failPut) throw new Error("synthetic_put_failure");
    if (options.onlyIf?.get("if-none-match") !== "*") throw new Error("create_only_required");
    if (!this.objects.has(key)) this.objects.set(key, text);
    this.afterPut?.();
    if (this.losePutResponse) throw new Error("synthetic_lost_response");
    return { key };
  }
  async list(options: { prefix: string; limit: number; cursor?: string }) {
    if (this.failList) throw new Error("synthetic_list_failure");
    if (this.listOverride) return this.listOverride(options);
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    const offset = options.cursor ? Number(options.cursor.slice(7)) : 0;
    const page = keys.slice(offset, offset + options.limit);
    return { objects: page.map((key) => ({ key })), truncated: offset + page.length < keys.length, cursor: `offset:${offset + page.length}` };
  }
  binding(): R2Bucket { return this as unknown as R2Bucket; }
}
export const emptyAgentPrivacyLedger = () => new MemoryAgentPrivacyLedger().binding();
