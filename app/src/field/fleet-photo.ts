import { ApiError, apiErrorBodySchema } from "../lib/api";
import {
  fleetPhotoUploadEndpoint,
  fleetPhotoUploadResponseSchema,
  type FleetPhotoEvidenceRef,
} from "./fleet-contracts";

export async function uploadFleetPhotoEvidence(input: {
  fleetAssetId: string;
  file: File;
  csrfToken: string;
  deviceProof?: () => Promise<string | null | undefined>;
  fetcher?: typeof fetch;
}): Promise<FleetPhotoEvidenceRef> {
  const headers = new Headers();
  headers.set("x-csrf-token", input.csrfToken);
  const proof = await input.deviceProof?.();
  if (proof) headers.set("X-IronWrap-Device-Proof", proof);
  const body = new FormData();
  body.append("photo", input.file, input.file.name || "fleet-photo.jpg");
  const response = await (input.fetcher ?? fetch)(fleetPhotoUploadEndpoint(input.fleetAssetId), {
    method: "POST",
    headers,
    body,
    credentials: "same-origin",
  });
  if (!response.ok) {
    const parsed = apiErrorBodySchema.safeParse(await response.json().catch(() => ({})));
    throw new ApiError({
      message: parsed.success
        ? (parsed.data.message ?? parsed.data.error ?? "Fleet photo upload failed.")
        : "Fleet photo upload failed.",
      status: response.status,
      code: parsed.success ? (parsed.data.error ?? parsed.data.code) : "fleet_photo_upload_failed",
    });
  }
  return fleetPhotoUploadResponseSchema.parse(await response.json()).photo_evidence;
}
