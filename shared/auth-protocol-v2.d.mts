export interface AuthExchangeV2 {
  v: 2;
  exchangeId: string;
  issuer: string | null;
  kind: string;
  baseGeneration: number;
}
export interface AuthProducerBindingV2 {
  versionId: string;
  artifactHash: string;
  componentManifestHash: string;
  protocol: number;
  databaseIdentity: string;
  issuer: string;
}
export interface AuthControlHeadV2 {
  format: "ironwrap-auth-control-v2";
  controlRevision: number;
  minProducerProtocol: number;
  mode: "staged" | "closed" | "active";
  activationId: string;
  issuer: string;
  databaseIdentity: string;
  allowedProducerBindings: AuthProducerBindingV2[];
  qualificationReceiptHash: string | null;
}
export interface AuthReceiptV2 {
  v: 2;
  actualProducerVersion: string;
  controlRevision: number;
  activationId: string;
  producerQualificationReceiptHashOrNull: string | null;
  actualIssuer: string;
  databaseIdentity: string;
  kind: "authenticated" | "metadata" | "refused";
  status: string;
  reason: string;
  actualContextIdOrNull: string | null;
  actualGenerationOrNull: number | null;
  authenticatedSubjectDigestOrNull: string | null;
  exchangeId: string;
  requestFingerprint: string;
}
export const AUTH_CONTEXT_HEADER: string;
export const AUTH_EXCHANGE_HEADER: string;
export const AUTH_RECEIPT_HEADER: string;
export const AUTH_CONTROL_KEY: string;
export const MAX_COUNTER: number;
export function safeCounter(value: unknown): number;
export function exactKeys(
  value: unknown,
  keys: string[],
): Record<string, unknown>;
export function canonicalV2(value: unknown): string;
export function parseCanonicalV2(raw: string, maximum?: number): unknown;
export function encodeV2(value: unknown): string;
export function decodeV2(encoded: string, maximum?: number): unknown;
export function validateExchange(value: unknown): AuthExchangeV2;
export function validateControlHead(value: unknown): AuthControlHeadV2;
export function validateReceipt(value: unknown): AuthReceiptV2;
export function sha256V2(value: string | Uint8Array): Promise<string>;
export function requestFingerprintV2(
  request: { url: string; method: string },
  exchangeId: string,
): Promise<string>;
export function subjectDigestV2(
  session: unknown,
  verifiedPairedProofHash: string | null,
): Promise<string>;
