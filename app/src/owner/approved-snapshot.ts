import { z } from "zod";

/**
 * The reviewed preview an approval froze when it was prepared. The Worker
 * projects `null` for legacy records and records without a preview; servers
 * older than the snapshot change omit the field entirely.
 */
export const approvedSnapshotSchema = z
  .object({
    snapshot_id: z.string().regex(/^approval-snapshot:[0-9a-f]{64}$/),
    version_label: z.string().min(1).max(200),
  })
  .strict();

export const optionalApprovedSnapshotSchema = approvedSnapshotSchema.nullable().optional();

export type ApprovedSnapshot = z.infer<typeof approvedSnapshotSchema>;
