// A specialist's release: what a qualification binds to besides the route. Its hash is the
// SHA-256 of the canonical JSON (keys sorted, no whitespace) of {specialist_id, playbook_sha256,
// allowlist_sha256, common_sha256, catalog_sha256}, each file hashed over its exact bytes. The
// Worker stores it in agent_qualifications.release_sha256 (migration 0203); Track D's report
// imports this module, so there is one definition.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../gateway/schema.ts";

export interface SpecialistRelease {
  specialist_id: string;
  playbook_sha256: string;
  allowlist_sha256: string;
  common_sha256: string;
  catalog_sha256: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

const SPECIALIST_ID = /^[a-z][a-z0-9_]{1,63}$/;

export function releaseSha256(release: SpecialistRelease): string {
  const { specialist_id, playbook_sha256, allowlist_sha256, common_sha256, catalog_sha256 } = release;
  if (typeof specialist_id !== "string" || !SPECIALIST_ID.test(specialist_id)) throw new Error("release needs a specialist id");
  for (const [key, value] of Object.entries({ playbook_sha256, allowlist_sha256, common_sha256, catalog_sha256 }))
    if (typeof value !== "string" || !HEX64.test(value)) throw new Error(`release ${key} must be a lower-case SHA-256`);
  return sha256(canonicalJson({ specialist_id, playbook_sha256, allowlist_sha256, common_sha256, catalog_sha256 }));
}

/** The release of a specialist as it is on disk under `specialistsRoot`, against one contract catalog. */
export function specialistRelease(specialistsRoot: string, specialistId: string, catalogSha256: string): SpecialistRelease & { release_sha256: string } {
  if (!SPECIALIST_ID.test(specialistId)) throw new Error("release needs a specialist id");
  const fileSha = (path: string) => createHash("sha256").update(readFileSync(join(specialistsRoot, path))).digest("hex");
  const release = {
    specialist_id: specialistId,
    playbook_sha256: fileSha(join(specialistId, "playbook.md")),
    allowlist_sha256: fileSha(join(specialistId, "allowlist.json")),
    common_sha256: fileSha("COMMON.md"),
    catalog_sha256: catalogSha256,
  };
  return { ...release, release_sha256: releaseSha256(release) };
}
