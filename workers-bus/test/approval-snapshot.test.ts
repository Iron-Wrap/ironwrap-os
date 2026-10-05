import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  approvedSnapshotFromPreview,
  brokerApprovalPreviewJson,
  freezeApprovalSnapshot,
  PROPOSAL_PUBLICATION_SNAPSHOT_LABEL,
  quoteRevisionSnapshotLabel,
} from "../src/approval-snapshot.ts";
import { canonicalJson } from "../src/newo-hash.ts";
import { canonicalJson as brokerCanonicalJson, digest, semanticPreview } from "../../mcp/erpnext-roofing-mcp/src/approval-contract.mjs";

function input() {
  return {
    tenantId: "ironwrap",
    requestId: "proposal-publication-approval:001",
    requestKind: "proposal_publication" as const,
    previewJson: canonicalJson({ would_write: false, before: { status: "Draft", quotation: "CQ-001" } }),
    argsDigest: "a".repeat(64),
    previewDigest: "b".repeat(64),
    receiptPreviewDigest: "c".repeat(64),
    versionLabel: PROPOSAL_PUBLICATION_SNAPSHOT_LABEL,
  };
}

test("snapshot identity binds tenant, request, reviewed content and receipt without hashing itself", async () => {
  const preparation = input();
  const saved = await freezeApprovalSnapshot(preparation);
  const snapshot = approvedSnapshotFromPreview(saved, preparation.versionLabel);
  const expectedDigest = createHash("sha256").update(canonicalJson({
    tenant_id: preparation.tenantId,
    approval_request_id: preparation.requestId,
    request_kind: preparation.requestKind,
    args_digest: preparation.argsDigest,
    preview_digest: preparation.previewDigest,
    receipt_preview_digest: preparation.receiptPreviewDigest,
    preview: JSON.parse(preparation.previewJson),
    version_label: preparation.versionLabel,
  })).digest("hex");
  assert.deepEqual(snapshot, {
    snapshot_id: `approval-snapshot:${expectedDigest}`,
    version_label: "Saved proposal publication review",
  });
  assert.equal(await freezeApprovalSnapshot(preparation), saved);
  for (const changed of [
    { tenantId: "tenant-other" },
    { requestId: "proposal-publication-approval:002" },
    { receiptPreviewDigest: "d".repeat(64) },
    { previewJson: canonicalJson({ would_write: false, before: { status: "Draft", quotation: "CQ-002" } }) },
  ]) {
    const newSaved = await freezeApprovalSnapshot({ ...preparation, ...changed });
    assert.notEqual(approvedSnapshotFromPreview(newSaved, preparation.versionLabel)?.snapshot_id, snapshot?.snapshot_id);
  }
  assert.equal(brokerApprovalPreviewJson(saved), preparation.previewJson);
});

test("snapshot metadata preserves the broker semantic digest and original canonical preview", async () => {
  const preparation = input();
  preparation.previewDigest = digest(semanticPreview(JSON.parse(preparation.previewJson)));
  const saved = await freezeApprovalSnapshot(preparation);
  const brokerJson = brokerApprovalPreviewJson(saved);
  assert.equal(brokerJson, preparation.previewJson);
  assert.equal(digest(semanticPreview(JSON.parse(brokerJson))), preparation.previewDigest);
  assert.notEqual(digest(semanticPreview(JSON.parse(saved))), preparation.previewDigest);
});

test("execution recovers the broker's exact bytes when its key order differs from the Worker", async () => {
  const preview = {
    Draft: { line_2: 2, line1: 1 },
    before: { qty_2: 2, qty10: 10 },
  };
  const original = brokerCanonicalJson(preview);
  assert.notEqual(original, canonicalJson(preview));
  const preparation = { ...input(), previewJson: original };
  const saved = await freezeApprovalSnapshot(preparation);
  assert.ok(approvedSnapshotFromPreview(saved, preparation.versionLabel));
  assert.equal(brokerApprovalPreviewJson(saved), original);
  assert.equal(brokerCanonicalJson(JSON.parse(brokerApprovalPreviewJson(saved))), original);
});

test("legacy and malformed descriptors remain unknown and cannot claim an inferred proposal version", async () => {
  const preparation = input();
  const saved = JSON.parse(await freezeApprovalSnapshot(preparation));
  assert.equal(approvedSnapshotFromPreview(preparation.previewJson, preparation.versionLabel), null);
  assert.equal(brokerApprovalPreviewJson(preparation.previewJson), preparation.previewJson);
  assert.equal(approvedSnapshotFromPreview("not-json", preparation.versionLabel), null);
  for (const descriptor of [
    null,
    { snapshot_id: "proposal:latest", version_label: preparation.versionLabel },
    { ...saved.approved_snapshot, version_label: "Proposal v4" },
    { ...saved.approved_snapshot, private_receipt: "not-for-browser" },
  ]) {
    assert.equal(approvedSnapshotFromPreview(
      JSON.stringify({ ...saved, approved_snapshot: descriptor }), preparation.versionLabel,
    ), null);
  }
  await assert.rejects(freezeApprovalSnapshot({ ...preparation, previewJson: JSON.stringify(saved) }), /preview_invalid/);
  assert.equal(quoteRevisionSnapshotLabel(3), "Source quote v3 (correction draft review)");
});
