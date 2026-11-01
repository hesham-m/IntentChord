/**
 * IN-MEMORY SECRET RESOLVER — Test/Development Implementation.
 *
 * Deterministic, in-memory secret resolver for automated tests.
 * Tests must not require a real Windows Credential Manager entry.
 *
 * SECURITY INVARIANTS:
 *   - Production V2 must never silently instantiate this resolver
 *   - Secret values are only in memory, never persisted
 *   - Deterministic: same inputs → same outputs
 */

import type { InternalAiSecretResolver } from "@/server/ai-secret-resolver";

/**
 * In-memory secret resolver for tests.
 *
 * Stores secrets in a simple Map. Deterministic and predictable.
 * Production V2 must never silently instantiate this resolver.
 */
export class InMemorySecretResolver implements InternalAiSecretResolver {
  private readonly secrets: Map<string, string>;

  constructor(secrets?: Record<string, string>) {
    this.secrets = new Map(Object.entries(secrets ?? {}));
  }

  /**
   * Set a secret for testing.
   */
  setSecret(credentialReference: string, secret: string): void {
    this.secrets.set(credentialReference, secret);
  }

  /**
   * Write-capable authority method (InternalAiSecretAuthority contract).
   * Delegates to setSecret.
   */
  storeSecret(credentialReference: string, secret: string): void {
    this.secrets.set(credentialReference, secret);
  }

  /**
   * Remove a secret for testing.
   * Idempotent: removing a missing credential is not an error.
   */
  removeSecret(credentialReference: string): void {
    this.secrets.delete(credentialReference);
  }

  /**
   * Check if a credential is present.
   */
  isCredentialPresent(credentialReference: string): boolean {
    return this.secrets.has(credentialReference);
  }

  /**
   * Resolve the secret value.
   * Returns undefined if not found.
   */
  resolveSecret(credentialReference: string): string | undefined {
    return this.secrets.get(credentialReference);
  }

  /**
   * Resolve the secret value, throwing if not available.
   * Fail-closed: missing secret = hard failure.
   *
   * SECURITY: Error message contains only the credential reference, NOT the secret.
   */
  resolveSecretOrThrow(credentialReference: string): string {
    const secret = this.secrets.get(credentialReference);
    if (secret === undefined) {
      throw new Error(
        `SECRET_NOT_FOUND: Credential "${credentialReference}" is not available in the secret resolver.`,
      );
    }
    return secret;
  }
}

/**
 * Create a test resolver with pre-configured secrets.
 * Convenience factory for test setup.
 */
export function createTestSecretResolver(secrets?: Record<string, string>): InMemorySecretResolver {
  return new InMemorySecretResolver(secrets);
}
