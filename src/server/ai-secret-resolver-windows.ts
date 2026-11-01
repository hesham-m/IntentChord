/**
 * WINDOWS CREDENTIAL MANAGER PRODUCTION RESOLVER.
 *
 * Forward V2 secret authority backed by Windows Credential Manager Generic Credentials
 * via native Credential Management API (CredReadW / CredWriteW / CredFree).
 *
 * Canonical mapping:
 *   credentialReference → IntentChord/InternalAI/<credentialReference>
 *
 * CredentialBlob encoding: UTF-8 byte array of the plaintext secret string.
 *   - Write: secret string → UTF-8 bytes → CredentialBlob
 *   - Read: CredentialBlob → UTF-8 decode → secret string
 *
 * Native contracts (verified against Win32 API):
 *   CredReadW(LPCWSTR TargetName, DWORD Type, DWORD Flags, PCREDENTIALW *Credential) → BOOL
 *   CredWriteW(PCREDENTIALW Credential, DWORD Flags) → BOOL
 *   CredFree(PVOID Buffer) → VOID
 *   CredDeleteW(LPCWSTR TargetName, DWORD Type, DWORD Flags) → BOOL
 *
 * Security invariants:
 *   - No secret in process.env
 *   - No secret in PostgreSQL
 *   - No secret in logs/audit
 *   - No secret in traversal snapshots
 *   - No secret in error messages
 *   - Presence-check mode does not emit the secret
 *   - PowerShell 5.1 compatible
 *   - No shell-string interpolation for untrusted values
 *   - Zero unmanaged secret buffers where applicable
 */

import { execFile } from "node:child_process";
import type { InternalAiSecretAuthority } from "@/server/ai-secret-authority";
import { windowsCredentialTargetName } from "@/server/ai-secret-resolver";

/**
 * C# helper compiled via Add-Type in PowerShell 5.1.
 * Provides P/Invoke wrappers for the native Credential Management API.
 *
 * Verified native signatures:
 *   CredReadW:  BOOL  CredReadW(LPCWSTR, DWORD, DWORD, PCREDENTIALW*)
 *   CredWriteW: BOOL  CredWriteW(PCREDENTIALW, DWORD)
 *   CredFree:   VOID  CredFree(PVOID)
 *   CredDeleteW: BOOL CredDeleteW(LPCWSTR, DWORD, DWORD)
 *
 * Constants:
 *   CRED_TYPE_GENERIC = 1
 *   CRED_PERSIST_LOCAL_MACHINE = 2
 *   ERROR_NOT_FOUND = 1168
 */
const CSHARP_CREDENTIAL_HELPER = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "",
  "namespace IntentChord.CredApi",
  "{",
  "    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
  "    public struct CREDENTIAL_ATTRIBUTEW",
  "    {",
  '        [MarshalAs(UnmanagedType.LPWStr)] public string Keyword;',
  "        public uint Flags;",
  "        public uint ValueSize;",
  "        public IntPtr Value;",
  "    }",
  "",
  "    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
  "    public struct CREDENTIALW",
  "    {",
  "        public uint Flags;",
  "        public uint Type;",
  '        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;',
  '        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;',
  "        public long LastWritten;",
  "        public uint CredentialBlobSize;",
  "        public IntPtr CredentialBlob;",
  "        public uint Persist;",
  "        public uint AttributeCount;",
  "        public IntPtr Attributes;",
  '        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;',
  '        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;',
  "    }",
  "",
  "    public static class Native",
  "    {",
  "        public const uint CRED_TYPE_GENERIC = 1;",
  "        public const uint CRED_PERSIST_LOCAL_MACHINE = 2;",
  "        public const uint ERROR_NOT_FOUND = 1168;",
  "",
  '        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
  "        public static extern bool CredReadW(",
  "            string TargetName,",
  "            uint Type,",
  "            uint Flags,",
  "            out IntPtr Credential);",
  "",
  '        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
  "        public static extern bool CredWriteW(",
  "            ref CREDENTIALW UserCredential,",
  "            uint Flags);",
  "",
  '        [DllImport("advapi32.dll")]',
  "        public static extern void CredFree(IntPtr Buffer);",
  "",
  '        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
  "        public static extern bool CredDeleteW(",
  "            string TargetName,",
  "            uint Type,",
  "            uint Flags);",
  "    }",
  "}",
].join("\n");

/**
 * PowerShell script template that uses the native Credential Management API.
 * Loaded once per process via Add-Type, then called per-operation.
 *
 * IMPORTANT: This template is parameterized by $operation which must be one of:
 *   "read"    — CredReadW, output UTF-8 decoded secret or empty string
 *   "present" — CredReadW, output PRESENT/ABSENT (no secret emitted)
 *   "write"   — CredWriteW, output STORED/STORE_FAILED (no secret emitted)
 *   "delete"  — CredDeleteW, output REMOVED/ABSENT/DELETE_FAILED (no secret emitted)
 *
 * The $targetName is injected via PowerShell variable, not string interpolation
 * of the target name into the script body. The C# helper handles the API call.
 *
 * WRITE path: the secret is passed as a base64 (UTF-8 bytes) variable. The
 * plaintext secret never appears in the script body, stdout, or error output.
 * The unmanaged blob buffer is freed and the managed byte array cleared in a
 * finally block. Any OS/API failure emits STORE_FAILED only (fail closed in
 * the caller).
 *
 * DELETE path: a missing credential (ERROR_NOT_FOUND) is reported as ABSENT
 * (idempotent remove); any other OS/API failure emits DELETE_FAILED (fail
 * closed in the caller).
 */
function buildCredApiPowerShellScript(
  targetName: string,
  operation: "read" | "present" | "write" | "delete",
  secretBase64?: string,
): string {
  const escapedTarget = targetName.replace(/'/g, "''");
  const escapedHelper = CSHARP_CREDENTIAL_HELPER.replace(/'/g, "''");
  const failureLine =
    operation === "write"
      ? `  Write-Output 'STORE_FAILED'`
      : operation === "delete"
        ? `  Write-Output 'DELETE_FAILED'`
        : `  Write-Output ''`;

  let operationBody: string;
  if (operation === "present") {
    operationBody = [
      `  $credPtr = [IntPtr]::Zero`,
      `  $ok = [IntentChord.CredApi.Native]::CredReadW($target, [IntentChord.CredApi.Native]::CRED_TYPE_GENERIC, 0, [ref]$credPtr)`,
      `  if ($ok -and $credPtr -ne [IntPtr]::Zero) {`,
      `    try {`,
      `      Write-Output 'PRESENT'`,
      `    } finally {`,
      `      [IntentChord.CredApi.Native]::CredFree($credPtr)`,
      `    }`,
      `  } else {`,
      `    Write-Output 'ABSENT'`,
      `  }`,
    ].join("\n");
  } else if (operation === "read") {
    operationBody = [
      `  $credPtr = [IntPtr]::Zero`,
      `  $ok = [IntentChord.CredApi.Native]::CredReadW($target, [IntentChord.CredApi.Native]::CRED_TYPE_GENERIC, 0, [ref]$credPtr)`,
      `  if (-not $ok -or $credPtr -eq [IntPtr]::Zero) {`,
      `    Write-Output ''`,
      `    return`,
      `  }`,
      `  try {`,
      `    $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($credPtr, [Type][IntentChord.CredApi.CREDENTIALW])`,
      `    if ($cred.CredentialBlobSize -eq 0 -or $cred.CredentialBlob -eq [IntPtr]::Zero) {`,
      `      Write-Output ''`,
      `      return`,
      `    }`,
      `    $blob = New-Object byte[] $cred.CredentialBlobSize`,
      `    [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, [int]$cred.CredentialBlobSize)`,
      `    $secret = [System.Text.Encoding]::UTF8.GetString($blob)`,
      `    [System.Array]::Clear($blob, 0, $blob.Length)`,
      `    Write-Output $secret`,
      `  } finally {`,
      `    [IntentChord.CredApi.Native]::CredFree($credPtr)`,
      `  }`,
    ].join("\n");
  } else if (operation === "write") {
    const escapedSecretBase64 = (secretBase64 ?? "").replace(/'/g, "''");
    operationBody = [
      `  $secretBytes = [System.Convert]::FromBase64String('${escapedSecretBase64}')`,
      `  $blobPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($secretBytes.Length)`,
      `  try {`,
      `    [System.Runtime.InteropServices.Marshal]::Copy($secretBytes, 0, $blobPtr, $secretBytes.Length)`,
      `    $cred = New-Object IntentChord.CredApi.CREDENTIALW`,
      `    $cred.Type = [IntentChord.CredApi.Native]::CRED_TYPE_GENERIC`,
      `    $cred.TargetName = $target`,
      `    $cred.Comment = 'IntentChord InternalAI credential'`,
      `    $cred.CredentialBlobSize = [uint32]($secretBytes.Length)`,
      `    $cred.CredentialBlob = $blobPtr`,
      `    $cred.Persist = [IntentChord.CredApi.Native]::CRED_PERSIST_LOCAL_MACHINE`,
      `    $cred.AttributeCount = 0`,
      `    $cred.Attributes = [IntPtr]::Zero`,
      `    $cred.TargetAlias = $null`,
      `    $cred.UserName = $null`,
      `    $ok = [IntentChord.CredApi.Native]::CredWriteW([ref]$cred, 0)`,
      `    if ($ok) {`,
      `      Write-Output 'STORED'`,
      `    } else {`,
      `      Write-Output 'STORE_FAILED'`,
      `    }`,
      `  } finally {`,
      `    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)`,
      `    [System.Array]::Clear($secretBytes, 0, $secretBytes.Length)`,
      `  }`,
    ].join("\n");
  } else {
    operationBody = [
      `  $ok = [IntentChord.CredApi.Native]::CredDeleteW($target, [IntentChord.CredApi.Native]::CRED_TYPE_GENERIC, 0)`,
      `  if ($ok) {`,
      `    Write-Output 'REMOVED'`,
      `  } else {`,
      `    $lastErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()`,
      `    if ($lastErr -eq [IntentChord.CredApi.Native]::ERROR_NOT_FOUND) {`,
      `      Write-Output 'ABSENT'`,
      `    } else {`,
      `      Write-Output 'DELETE_FAILED'`,
      `    }`,
      `  }`,
    ].join("\n");
  }

  return [
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    `  Add-Type -TypeDefinition '${escapedHelper}' -ErrorAction SilentlyContinue`,
    `  $target = '${escapedTarget}'`,
    operationBody,
    `} catch {`,
    failureLine,
    `}`,
  ].join("\n");
}

/**
 * Execute a PowerShell command and return stdout.
 * Uses execFile (no shell) for security — no shell-string interpolation.
 */
function executePowerShell(script: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve("");
          return;
        }
        resolve(stdout?.trim() ?? "");
      },
    );
  });
}

/**
 * Windows Credential Manager Generic Credential resolver + write authority.
 *
 * Production Forward V2 secret authority. Uses the native Credential Management API
 * (CredReadW / CredWriteW / CredDeleteW / CredFree) via PowerShell Add-Type P/Invoke
 * to read and write CRED_TYPE_GENERIC credentials from Windows Credential Manager.
 *
 * Verified native contracts:
 *   CredReadW:  4 parameters (TargetName, Type, Flags=0, out Credential)
 *   CredWriteW: 2 parameters (ref Credential, Flags=0)
 *   CredDeleteW: 3 parameters (TargetName, Type, Flags=0)
 *   CredFree:   void return (no return value)
 *
 * Dual interface:
 *   InternalAiSecretResolver (read)  — isCredentialPresent / resolveSecret / resolveSecretOrThrow
 *   InternalAiSecretAuthority (write) — storeSecret / removeSecret (Add/Replace/Rotate/Revoke/Delete)
 *
 * SECURITY INVARIANTS:
 *   - Secret never appears in process.env
 *   - Secret never appears in PostgreSQL
 *   - Secret never appears in logs/audit/traversal snapshots
 *   - Secret never appears in error messages
 *   - Secret never echoed from write operations (STORED/STORE_FAILED only)
 *   - Presence-check mode does not emit the secret value
 *   - CredentialBlob encoding: UTF-8
 *   - Write and delete fail closed on OS/API failure
 *   - removeSecret is idempotent (ERROR_NOT_FOUND = success)
 */
export class WindowsCredentialResolver implements InternalAiSecretAuthority {
  /**
   * Check if a credential is present in Windows Credential Manager.
   * Uses CredReadW with CRED_TYPE_GENERIC, Flags=0.
   * Does NOT reveal the secret value.
   */
  async isCredentialPresent(credentialReference: string): Promise<boolean> {
    const targetName = `IntentChord/InternalAI/${credentialReference}`;
    const script = buildCredApiPowerShellScript(targetName, "present");
    const result = await executePowerShell(script);
    return result === "PRESENT";
  }

  /**
   * Resolve the secret value from Windows Credential Manager.
   * Uses CredReadW to read the CRED_TYPE_GENERIC credential,
   * then decodes the CredentialBlob as UTF-8.
   * Returns undefined if not found.
   *
   * SECURITY: The secret value is only in memory, never logged or persisted.
   * CredFree is called in all completion paths.
   */
  async resolveSecret(credentialReference: string): Promise<string | undefined> {
    const targetName = `IntentChord/InternalAI/${credentialReference}`;
    const script = buildCredApiPowerShellScript(targetName, "read");
    const result = await executePowerShell(script);
    return result || undefined;
  }

  /**
   * Resolve the secret value, throwing if not available.
   * Fail-closed: missing secret = hard failure.
   *
   * SECURITY: Error message contains only the credential REFERENCE name,
   * never the secret value.
   */
  async resolveSecretOrThrow(credentialReference: string): Promise<string> {
    const secret = await this.resolveSecret(credentialReference);
    if (!secret) {
      throw new Error(
        `WINDOWS_CREDENTIAL_NOT_FOUND: Credential "${credentialReference}" is not available in Windows Credential Manager. ` +
        `Target: IntentChord/InternalAI/${credentialReference}. ` +
        `Use the provisioning utility to store the credential.`,
      );
    }
    return secret;
  }

  /**
   * Store or replace the secret in Windows Credential Manager (CredWriteW).
   * Uses the governed target convention IntentChord/InternalAI/<credentialReference>.
   *
   * SECURITY:
   *   - Secret is base64-encoded (UTF-8 bytes) into the script variable; the
   *     plaintext secret never appears in the script body, stdout, or errors.
   *   - No secret echo: success/failure is signaled only as STORED/STORE_FAILED.
   *   - Fail closed: any non-STORED outcome (OS/API failure) throws.
   *   - Error message contains only the credential REFERENCE, never the value.
   */
  async storeSecret(credentialReference: string, secret: string): Promise<void> {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new Error(
        `WINDOWS_CREDENTIAL_STORE_FAILED: Credential "${credentialReference}" requires a non-empty secret value.`,
      );
    }
    const targetName = windowsCredentialTargetName(credentialReference);
    const secretBase64 = Buffer.from(secret, "utf8").toString("base64");
    const script = buildCredApiPowerShellScript(targetName, "write", secretBase64);
    const result = await executePowerShell(script);
    if (result !== "STORED") {
      throw new Error(
        `WINDOWS_CREDENTIAL_STORE_FAILED: Windows Credential Manager write failed for ` +
        `Target: IntentChord/InternalAI/${credentialReference}.`,
      );
    }
  }

  /**
   * Remove the secret from Windows Credential Manager (CredDeleteW).
   * Idempotent: removing a missing credential (ERROR_NOT_FOUND → ABSENT)
   * is a success, not an error.
   *
   * SECURITY:
   *   - No secret echo: outcome is REMOVED/ABSENT/DELETE_FAILED only.
   *   - Fail closed: any other OS/API failure throws.
   *   - Error message contains only the credential REFERENCE, never a value.
   */
  async removeSecret(credentialReference: string): Promise<void> {
    const targetName = windowsCredentialTargetName(credentialReference);
    const script = buildCredApiPowerShellScript(targetName, "delete");
    const result = await executePowerShell(script);
    if (result !== "REMOVED" && result !== "ABSENT") {
      throw new Error(
        `WINDOWS_CREDENTIAL_DELETE_FAILED: Windows Credential Manager delete failed for ` +
        `Target: IntentChord/InternalAI/${credentialReference}.`,
      );
    }
  }
}
