import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionFor } from "../admin/admin-test-harness";
import {
  documentRequestKey,
  restoreDocumentRequest,
  retainDocumentRequest,
} from "./document-request";

beforeEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("saved document request identity", () => {
  const request = {
    entityType: "job",
    entityId: "JOB-1",
    templateId: "tpl_materials",
    templateRevisionId: "rev_1",
    idempotencyKey: "docgen:retained-0001",
  };
  it("restores the original revision while separating another user, tenant, job and template", () => {
    const session = sessionFor("owner");
    const key = documentRequestKey(session, "job", "JOB-1", "tpl_materials");
    retainDocumentRequest(key, request);
    expect(restoreDocumentRequest(key)).toEqual(request);
    for (const other of [
      documentRequestKey(
        { ...session, user: { ...session.user, id: "other-user" } },
        "job",
        "JOB-1",
        "tpl_materials",
      ),
      documentRequestKey(
        { ...session, tenant: { ...session.tenant, id: "other-tenant" } },
        "job",
        "JOB-1",
        "tpl_materials",
      ),
      documentRequestKey(session, "job", "JOB-2", "tpl_materials"),
      documentRequestKey(session, "job", "JOB-1", "tpl_contract"),
    ])
      expect(restoreDocumentRequest(other)).toBeNull();
  });
  it("refuses a corrupted or mis-scoped request instead of silently making another", () => {
    const key = documentRequestKey(sessionFor("owner"), "job", "JOB-1", "tpl_materials");
    sessionStorage.setItem(key, "broken json");
    expect(() => restoreDocumentRequest(key)).toThrow();
    retainDocumentRequest(key, { ...request, entityId: "JOB-2" });
    expect(() => restoreDocumentRequest(key)).toThrow();
  });
  it("does not fall back to a volatile identity when site storage refuses the write", () => {
    vi.stubGlobal("sessionStorage", {
      setItem() {
        throw new DOMException("storage denied", "SecurityError");
      },
    });
    expect(() => retainDocumentRequest("key", request)).toThrow("storage denied");
  });
});
