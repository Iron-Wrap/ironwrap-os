import { z } from "zod";

const nullableText = z.string().min(1).nullable();

export const fieldUserSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  email: z.email(),
  frappe_user_id: nullableText,
});

export const fieldUsersResponseSchema = z.object({
  users: z.array(fieldUserSchema),
});

export const devicePairingSchema = z.object({
  id: z.string().min(1),
  field_user_id: z.string().min(1),
  field_user_name: z.string().min(1),
  paired_at: z.string().min(1),
  last_seen_at: nullableText,
  revoked_at: nullableText,
  revoked_by: nullableText,
});

export const devicePairingsResponseSchema = z.object({
  devices: z.array(devicePairingSchema),
});

export const issueDevicePairingResponseSchema = z.object({
  pairing_url: z.string().url(),
  expires_at: z.string().min(1),
  field_user: z.object({
    id: z.string().min(1),
    display_name: z.string().min(1),
  }),
});

export const issueHermesDesktopPairingResponseSchema = z.object({
  pairing_url: z.string().url(),
  expires_at: z.string().min(1),
  api_audience: z.string().url(),
  bound_issuer: z.string().url(),
  bootstrap_prompt: z.string().min(1).max(8_000),
});

export const revokeDevicePairingResponseSchema = z.object({
  ok: z.literal(true),
  device_id: z.string().min(1),
  revoked_at: z.string().min(1),
});

export type FieldUser = z.infer<typeof fieldUserSchema>;
export type DevicePairing = z.infer<typeof devicePairingSchema>;
export type IssuedDevicePairing = z.infer<typeof issueDevicePairingResponseSchema>;
export type IssuedHermesDesktopPairing = z.infer<typeof issueHermesDesktopPairingResponseSchema>;
