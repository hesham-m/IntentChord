/**
 * Next.js Instrumentation Hook
 * Runs once when the Next.js server instance starts up.
 * Governed startup recovery for multi-window context mapping traversals.
 * Canonical production bootstrap for Forward-V2 secret resolver AND the
 * write-capable Windows Credential Manager secret authority used by the
 * governed credential lifecycle (Add/Replace/Rotate/Revoke/Delete).
 */
import type { InternalAiSecretAuthority } from "@/server/ai-secret-authority";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTraversalRecoveryLoop } = await import(
      "@/server/context/context-mapping-traversal-recovery-loop"
    );
    startTraversalRecoveryLoop();

    const { setInternalAiSecretResolver, getInternalAiSecretResolver } = await import(
      "@/server/ai-context-mapper-config"
    );
    const { WindowsCredentialResolver } = await import(
      "@/server/ai-secret-resolver-windows"
    );
    const { internalAiCredentialService } = await import(
      "@/server/internal-ai-credential-service"
    );
    setInternalAiSecretResolver(new WindowsCredentialResolver());
    // One shared authority instance: the same WindowsCredentialResolver stored
    // on globalThis is injected as the credential service write authority, so
    // the Admin credential API reaches Windows Credential Manager directly.
    internalAiCredentialService.setSecretAuthority(
      getInternalAiSecretResolver() as InternalAiSecretAuthority,
    );
  }
}
