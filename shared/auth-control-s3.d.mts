import type { AuthControlHeadV2 } from "./auth-protocol-v2.mjs";
export interface AuthControlS3Config {
  accountId: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
}
export interface AuthControlObject {
  head: AuthControlHeadV2;
  etag: string;
  bodyHash: string;
}
export function controlObjectUrl(config: AuthControlS3Config): string;
export function signedControlRequest(
  config: AuthControlS3Config,
  method: string,
  body?: string,
  condition?: { ifMatch?: string; ifNoneMatch?: string },
  now?: Date,
): Promise<Request>;
export function readControlObject(
  config: AuthControlS3Config,
  fetcher?: typeof fetch,
): Promise<AuthControlObject | null>;
export function putControlObject(
  config: AuthControlS3Config,
  head: AuthControlHeadV2,
  condition: { ifMatch?: string; ifNoneMatch?: string },
  fetcher?: typeof fetch,
): Promise<AuthControlObject>;
