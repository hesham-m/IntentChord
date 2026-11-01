/**
 * REAL WINDOWS CREDENTIAL MANAGER NATIVE SMOKE TEST.
 *
 * This test performs a bounded real round-trip against Windows Credential Manager
 * using the same native P/Invoke contracts as the production resolver.
 *
 * It uses a SYNTHETIC credential only — never any real Owner secret.
 *
 * Required flow:
 *   1. CredWriteW → write synthetic credential
 *   2. CredReadW → read it back
 *   3. Verify round-trip byte-for-byte
 *   4. CredDeleteW → remove it
 *   5. Verify post-deletion: CredReadW fails, ERROR_NOT_FOUND
 *
 * Security:
 *   - Uses only synthetic random values
 *   - Cleans up in finally block
 *   - Never leaves synthetic credential in Credential Manager
 */

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SMOKE_DIR = join(process.env.TEMP || process.env.TMP || ".", "intentchord_smoke");
const CSHARP_FILE = join(SMOKE_DIR, "CredApi.cs");
const PS_FILE = join(SMOKE_DIR, "SmokeTest.ps1");

const CSHARP_SMOKE_SOURCE = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "",
  "namespace IntentChord.SmokeTest",
  "{",
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
  "        public static extern bool CredWriteW(ref CREDENTIALW UserCredential, uint Flags);",
  "",
  '        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
  "        public static extern bool CredReadW(string TargetName, uint Type, uint Flags, out IntPtr Credential);",
  "",
  '        [DllImport("advapi32.dll")]',
  "        public static extern void CredFree(IntPtr Buffer);",
  "",
  '        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
  "        public static extern bool CredDeleteW(string TargetName, uint Type, uint Flags);",
  "    }",
  "}",
].join("\n");

function buildSmokeTestPs1(targetName: string, syntheticSecret: string, csFilePath: string): string {
  const escapedCsPath = csFilePath.replace(/\\/g, "\\\\");
  const escapedTarget = targetName.replace(/'/g, "''");
  const escapedSecret = syntheticSecret.replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$csPath = '${escapedCsPath}'`,
    `$target = '${escapedTarget}'`,
    `$secretValue = '${escapedSecret}'`,
    "",
    "try {",
    "  Add-Type -Path $csPath",
    "  $secretBytes = [System.Text.Encoding]::UTF8.GetBytes($secretValue)",
    "",
    "  # WRITE",
    "  $blobPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($secretBytes.Length)",
    "  try {",
    "    [System.Runtime.InteropServices.Marshal]::Copy($secretBytes, 0, $blobPtr, $secretBytes.Length)",
    "    $cred = New-Object IntentChord.SmokeTest.CREDENTIALW",
    "    $cred.Type = [IntentChord.SmokeTest.Native]::CRED_TYPE_GENERIC",
    "    $cred.TargetName = $target",
    "    $cred.Comment = 'IntentChord smoke test'",
    "    $cred.CredentialBlobSize = [uint32]($secretBytes.Length)",
    "    $cred.CredentialBlob = $blobPtr",
    "    $cred.Persist = [IntentChord.SmokeTest.Native]::CRED_PERSIST_LOCAL_MACHINE",
    "    $cred.AttributeCount = 0",
    "    $cred.Attributes = [IntPtr]::Zero",
    "    $cred.TargetAlias = $null",
    "    $cred.UserName = $null",
    "    $writeOk = [IntentChord.SmokeTest.Native]::CredWriteW([ref]$cred, 0)",
    "    if ($writeOk) { Write-Host 'WRITE=PASS' } else { Write-Host 'WRITE=FAIL' }",
    "  } finally {",
    "    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)",
    "    [System.Array]::Clear($secretBytes, 0, $secretBytes.Length)",
    "  }",
    "",
    "  # READ",
    "  $readPtr = [IntPtr]::Zero",
    "  $readOk = [IntentChord.SmokeTest.Native]::CredReadW($target, [IntentChord.SmokeTest.Native]::CRED_TYPE_GENERIC, 0, [ref]$readPtr)",
    "  if ($readOk -and $readPtr -ne [IntPtr]::Zero) {",
    "    Write-Host 'READ=PASS'",
    "    try {",
    "      $readCred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($readPtr, [Type][IntentChord.SmokeTest.CREDENTIALW])",
    "      if ($readCred.CredentialBlobSize -gt 0 -and $readCred.CredentialBlob -ne [IntPtr]::Zero) {",
    "        $readBlob = New-Object byte[] $readCred.CredentialBlobSize",
    "        [System.Runtime.InteropServices.Marshal]::Copy($readCred.CredentialBlob, $readBlob, 0, [int]$readCred.CredentialBlobSize)",
    "        $decoded = [System.Text.Encoding]::UTF8.GetString($readBlob)",
    "        [System.Array]::Clear($readBlob, 0, $readBlob.Length)",
    "        if ($decoded -eq $secretValue) { Write-Host 'ROUND_TRIP=PASS' } else { Write-Host 'ROUND_TRIP=FAIL' }",
    "      } else {",
    "        Write-Host 'ROUND_TRIP=FAIL'",
    "      }",
    "    } finally {",
    "      [IntentChord.SmokeTest.Native]::CredFree($readPtr)",
    "    }",
    "  } else {",
    "    Write-Host 'READ=FAIL'",
    "    Write-Host 'ROUND_TRIP=FAIL'",
    "  }",
    "",
    "  # DELETE",
    "  $deleteOk = [IntentChord.SmokeTest.Native]::CredDeleteW($target, [IntentChord.SmokeTest.Native]::CRED_TYPE_GENERIC, 0)",
    "  if ($deleteOk) { Write-Host 'DELETE=PASS' } else { Write-Host 'DELETE=FAIL' }",
    "",
    "  # VERIFY POST-DELETE",
    "  $verifyPtr = [IntPtr]::Zero",
    "  $verifyOk = [IntentChord.SmokeTest.Native]::CredReadW($target, [IntentChord.SmokeTest.Native]::CRED_TYPE_GENERIC, 0, [ref]$verifyPtr)",
    "  if (-not $verifyOk) {",
    "    $lastErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    "    if ($lastErr -eq [IntentChord.SmokeTest.Native]::ERROR_NOT_FOUND) {",
    "      Write-Host 'POST_DELETE_NOT_FOUND=PASS'",
    "    } else {",
    "      Write-Host 'POST_DELETE_NOT_FOUND=FAIL'",
    "    }",
    "  } else {",
    "    [IntentChord.SmokeTest.Native]::CredFree($verifyPtr)",
    "    [IntentChord.SmokeTest.Native]::CredDeleteW($target, [IntentChord.SmokeTest.Native]::CRED_TYPE_GENERIC, 0) | Out-Null",
    "    Write-Host 'POST_DELETE_NOT_FOUND=FAIL'",
    "  }",
    "} catch {",
    "  Write-Host ('EXCEPTION=' + $_.Exception.Message)",
    "  try {",
    `    [IntentChord.SmokeTest.Native]::CredDeleteW('${escapedTarget}', [IntentChord.SmokeTest.Native]::CRED_TYPE_GENERIC, 0) | Out-Null`,
    "  } catch { }",
    "}",
  ].join("\n");
}

function executePowershellFile(scriptPath: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-File", scriptPath],
      { encoding: "utf8", timeout: 30000 },
      (_error, stdout, stderr) => {
        resolve({ stdout: stdout?.trim() ?? "", stderr: stderr?.trim() ?? "" });
      },
    );
  });
}

describe("REAL_WINDOWS_NATIVE_CREDENTIAL_SMOKE", () => {
  it("real CredWriteW -> CredReadW -> CredDeleteW round-trip with synthetic credential", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const guid = randomBytes(16).toString("hex");
    const syntheticTarget = `IntentChord/InternalAI/SMOKE_TEST_${guid}`;
    const syntheticSecret = `synthetic_test_value_${guid}`;

    try {
      mkdirSync(SMOKE_DIR, { recursive: true });
    } catch { /* exists */ }

    writeFileSync(CSHARP_FILE, CSHARP_SMOKE_SOURCE, "utf8");
    writeFileSync(PS_FILE, buildSmokeTestPs1(syntheticTarget, syntheticSecret, CSHARP_FILE), "utf8");

    let output = "";
    try {
      const result = await executePowershellFile(PS_FILE);
      output = result.stdout;
    } finally {
      try { unlinkSync(CSHARP_FILE); } catch { /* ok */ }
      try { unlinkSync(PS_FILE); } catch { /* ok */ }
      try { require("node:fs").rmdirSync(SMOKE_DIR); } catch { /* ok */ }
    }

    // Parse Write-Host output lines
    const lines = output.split(/\r?\n/).filter((l) => l.includes("="));
    const results = Object.fromEntries(
      lines.map((line) => {
        const eqIdx = line.indexOf("=");
        return [line.substring(0, eqIdx), line.substring(eqIdx + 1)];
      }),
    );

    // Safe metadata assertions
    expect(results.WRITE).toBe("PASS");
    expect(results.READ).toBe("PASS");
    expect(results.ROUND_TRIP).toBe("PASS");
    expect(results.DELETE).toBe("PASS");
    expect(results.POST_DELETE_NOT_FOUND).toBe("PASS");

    // Verify the synthetic secret is NOT in output
    expect(output).not.toContain(syntheticSecret);
  });
});
