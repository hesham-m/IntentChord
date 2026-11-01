/**
 * INTERNAL AI SECRET RESOLVER — Canonical Boundary.
 *
 * Forward V2 secret authority is OS-backed, NOT process.env.
 * This module defines the canonical interface that ALL V2 credential
 * resolution MUST go through.
 *
 * INVARIANTS:
 *   - V2_PROCESS_ENV_SECRET_AUTHORITY = NO
 *   - V2_ENV_FALLBACK = FORBIDDEN
 *   - DATABASE_STORES_SECRET_VALUE = NO
 *   - SECRET_IN_TRAVERSAL_SNAPSHOT = NO
 *   - SECRET_IN_LOGS_OR_AUDIT = NO
 */

/**
 * Canonical secret resolver interface.
 *
 * Every V2 credential resolution MUST go through this boundary.
 * Production uses Windows Credential Manager. Tests use InMemory.
 */
export interface InternalAiSecretResolver {
  /**
   * Check if a credential is present (without revealing the value).
   * Used for eligibility/readiness checks.
   */
  isCredentialPresent(credentialReference: string): boolean | Promise<boolean>;

  /**
   * Resolve the actual secret value for a credential reference.
   * Returns undefined if the credential is not available.
   *
   * MUST NOT:
   *   - Log the secret value
   *   - Return the secret in error messages
   *   - Store the secret in any external system
   */
  resolveSecret(credentialReference: string): string | undefined | Promise<string | undefined>;

  /**
   * Resolve the actual secret value, throwing if not available.
   * Fail-closed: missing secret = hard failure.
   */
  resolveSecretOrThrow(credentialReference: string): string | Promise<string>;
}

/**
 * Canonical Windows Credential Manager target name mapping.
 *
 * General rule: IntentChord/InternalAI/<credentialReference>
 *
 * Example:
 *   credentialReference: "OLLAMA_API_KEY"
 *   → target: "IntentChord/InternalAI/OLLAMA_API_KEY"
 */
export function windowsCredentialTargetName(credentialReference: string): string {
  return `IntentChord/InternalAI/${credentialReference}`;
}
