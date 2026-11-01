import type { InternalAiSecretResolver } from "@/server/ai-secret-resolver";

/**
 * Write-capable secret authority for the governed credential lifecycle (ADR-001 §5).
 *
 * Read side remains InternalAiSecretResolver (isCredentialPresent / resolveSecret / resolveSecretOrThrow).
 * Write side is limited to store + remove for Add / Replace / Rotate / Revoke / Delete.
 *
 * SECURITY INVARIANTS:
 *   - DATABASE_STORES_SECRET_VALUE = NO
 *   - SECRET_IN_LOGS_OR_AUDIT = NO
 *   - SECRET_VALUE_EXPOSURE = FORBIDDEN
 *   - Resolver unavailable ≠ credential missing (invariant preserved on read path)
 */
export interface InternalAiSecretAuthority extends InternalAiSecretResolver {
  /**
   * Store or replace the secret for a credential reference in the approved OS-backed authority.
   * MUST NOT log, return, or persist the secret outside the authority.
   */
  storeSecret(credentialReference: string, secret: string): void | Promise<void>;

  /**
   * Remove the secret for a credential reference from the approved authority.
   * Idempotent: removing a missing credential is not an error.
   */
  removeSecret(credentialReference: string): void | Promise<void>;
}

/**
 * Authority that fails closed on write. Used when only a read-only resolver is available.
 * Read methods still delegate to the wrapped resolver (invariant: resolver unavailable ≠ credential missing).
 */
export class ReadOnlySecretAuthority implements InternalAiSecretAuthority {
  constructor(private readonly resolver: InternalAiSecretResolver) {}

  isCredentialPresent(credentialReference: string): boolean | Promise<boolean> {
    return this.resolver.isCredentialPresent(credentialReference);
  }

  resolveSecret(credentialReference: string): string | undefined | Promise<string | undefined> {
    return this.resolver.resolveSecret(credentialReference);
  }

  resolveSecretOrThrow(credentialReference: string): string | Promise<string> {
    return this.resolver.resolveSecretOrThrow(credentialReference);
  }

  storeSecret(): never {
    throw new Error("SECRET_AUTHORITY_WRITE_UNAVAILABLE: credential write operations require a write-capable secret authority.");
  }

  removeSecret(): never {
    throw new Error("SECRET_AUTHORITY_WRITE_UNAVAILABLE: credential write operations require a write-capable secret authority.");
  }
}
