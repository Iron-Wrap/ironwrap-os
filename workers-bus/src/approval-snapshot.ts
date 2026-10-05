import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export interface ApprovedSnapshot {
  snapshot_id: string;
  version_label: string;
}

export const PROPOSAL_PUBLICATION_SNAPSHOT_LABEL = "Saved proposal publication review";

export function quoteRevisionSnapshotLabel(sourceVersion: number): string {
  return `Source quote v${sourceVersion} (correction draft review)`;
}

/** Freeze the reviewed action, never an inferred current quote/proposal revision. */
export async function freezeApprovalSnapshot(input: {
  tenantId: string;
  requestId: string;
  requestKind: "quote_revision" | "proposal_publication";
  previewJson: string;
  argsDigest: string;
  previewDigest: string;
  receiptPreviewDigest: string;
  versionLabel: string;
}): Promise<string> {
  const preview = parsePreview(input.previewJson);
  if (!preview || Object.hasOwn(preview, "approved_snapshot")) {
    throw new Error("approval_snapshot_preview_invalid");
  }
  // Hash the original preview and saved bindings before adding the descriptor.
  // Broker digests retain their existing meaning and do not hash this metadata.
  const snapshotDigest = await sha256Hex(canonicalJson({
    tenant_id: input.tenantId,
    approval_request_id: input.requestId,
    request_kind: input.requestKind,
    args_digest: input.argsDigest,
    preview_digest: input.previewDigest,
    receipt_preview_digest: input.receiptPreviewDigest,
    preview,
    version_label: input.versionLabel,
  }));
  const approvedSnapshot: ApprovedSnapshot = {
    snapshot_id: `approval-snapshot:${snapshotDigest}`,
    version_label: input.versionLabel,
  };
  // The broker validates its own exact canonical bytes at execution. Its key order differs
  // from the Worker's, so append only our metadata and keep every broker byte untouched.
  if (!input.previewJson.startsWith("{") || !input.previewJson.endsWith("}")) {
    throw new Error("approval_snapshot_preview_invalid");
  }
  const separator = Object.keys(preview).length === 0 ? "" : ",";
  return `${input.previewJson.slice(0, -1)}${separator}"approved_snapshot":${canonicalJson(approvedSnapshot)}}`;
}

/** Legacy or contradictory saved descriptors remain unknown; never backfill at read time. */
export function approvedSnapshotFromPreview(
  previewJson: string,
  expectedVersionLabel: string,
): ApprovedSnapshot | null {
  const snapshot = object(parsePreview(previewJson)?.approved_snapshot);
  if (
    !snapshot || Object.keys(snapshot).length !== 2 ||
    typeof snapshot.snapshot_id !== "string" ||
    !/^approval-snapshot:[0-9a-f]{64}$/.test(snapshot.snapshot_id) ||
    snapshot.version_label !== expectedVersionLabel
  ) return null;
  return { snapshot_id: snapshot.snapshot_id, version_label: expectedVersionLabel };
}

/** Send the saved broker preview, without Worker metadata, under the original broker digest. */
export function brokerApprovalPreviewJson(previewJson: string): string {
  const preview = parsePreview(previewJson);
  if (!preview || !Object.hasOwn(preview, "approved_snapshot")) return previewJson;
  const suffix = `"approved_snapshot":${canonicalJson(preview.approved_snapshot)}}`;
  if (!previewJson.endsWith(suffix)) throw new Error("approval_snapshot_preview_invalid");
  const prefix = previewJson.slice(0, -suffix.length);
  const brokerJson = prefix.endsWith(",") ? `${prefix.slice(0, -1)}}` : prefix === "{" ? "{}" : null;
  if (!brokerJson || !parsePreview(brokerJson)) throw new Error("approval_snapshot_preview_invalid");
  return brokerJson;
}

function parsePreview(value: string): Record<string, unknown> | null {
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
