// quickbooks-auth-port.ts - the only accounting dependency on the QuickBooks connection plane.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 3.1. An authenticated provider-detail read is
// the single mechanism the contract uses to define "reconciled" (section 5.1), so every money
// module needs a realm and an access token. It gets them from here and nowhere else: no accounting
// module reads `quickbooks_connections`, decrypts a token bundle, or holds a client secret.

/** One resolved active connection. Field-for-field what an authenticated provider call needs. */
export interface QuickBooksRealmBinding {
  /** Intuit realm (company) id. Part of the provider identity every observation records. */
  realmId: string;
  /**
   * A live bearer token. Never persisted by a money module, never logged, and never written to
   * evidence: contract section 6 admits hashes and identifiers into evidence, not credentials.
   */
  accessToken: string;
  /** Provider API origin, e.g. the sandbox or production Accounting API host. */
  apiBase: string;
  /** Intuit `minorversion` query parameter, carried as the string that reaches the URL. */
  minorVersion: string;
  connectionId: string;
}

export interface QuickBooksAuthPort {
  /**
   * Resolve the single active connection for a tenant, refreshing under lease if needed.
   *
   * Throws rather than returning null: a money mutation with no realm has nothing to be
   * authenticated against, and a soft failure here would invite an unauthenticated fallback.
   */
  activeRealm(tenantId: string): Promise<QuickBooksRealmBinding>;
}

/**
 * The error vocabulary a money module may observe from the auth port, matching what the connection
 * plane already throws in `quickbooks-final-invoice.ts`.
 */
export const QUICKBOOKS_AUTH_ERROR_CODES = [
  /** No connected realm for the tenant. The intent blocks; it never proceeds unauthenticated. */
  "quickbooks_connection_required",
  /** Another worker holds the refresh lease. Retryable, and never a verdict of record. */
  "quickbooks_refresh_in_progress",
  /** The stored bundle could not be decrypted. The connection needs reconciliation. */
  "quickbooks_connection_unreadable",
] as const;

export class QuickBooksAuthError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "QuickBooksAuthError";
  }
}
