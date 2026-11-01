<#
.SYNOPSIS
    Store/replace a Generic Credential in Windows Credential Manager for IntentChord V2 AI Engine Registry.

.DESCRIPTION
    Prompts for a secret using Read-Host -AsSecureString and stores it as a
    CRED_TYPE_GENERIC credential in Windows Credential Manager via CredWriteW.

    Canonical target: IntentChord/InternalAI/<credentialReference>
    CredentialBlob encoding: UTF-8
    Persistence: CRED_PERSIST_LOCAL_MACHINE (current user, current machine only)

    Security requirements:
    - Never accepts secret as command-line argument
    - Never echoes secret
    - Never writes plaintext secret to disk
    - Never prints secret
    - Returns only safe status

.PARAMETER CredentialReference
    The credential reference name (e.g., OLLAMA_API_KEY, ZAI_API_KEY).

.EXAMPLE
    .\Provision-IntentChordSecret.ps1 -CredentialReference "OLLAMA_API_KEY"
    # Prompts for secret, stores in Windows Credential Manager via CredWriteW
#>

param(
    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]*$')]
    [string]$CredentialReference
)

$ErrorActionPreference = 'Stop'

# Canonical target name mapping
$TargetName = "IntentChord/InternalAI/$CredentialReference"

# C# helper for native Credential Management API P/Invoke
$CredApiSource = @"
using System;
using System.Runtime.InteropServices;

namespace IntentChord.Provision
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIALW
    {
        public uint Flags;
        public uint Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }

    public static class Native
    {
        public const uint CRED_TYPE_GENERIC = 1;
        public const uint CRED_PERSIST_LOCAL_MACHINE = 2;

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CredWriteW(
            ref CREDENTIALW UserCredential,
            uint Flags);
    }
}
"@

try {
    # Load native Credential API helper
    Add-Type -TypeDefinition $CredApiSource -ErrorAction SilentlyContinue

    # Prompt for secret using SecureString (never echoed, never in args)
    $SecureSecret = Read-Host -Prompt "Enter secret for $CredentialReference" -AsSecureString

    # Convert SecureString to UTF-8 byte array via BSTR (only in memory)
    $Bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureSecret)
    try {
        $PlainText = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
    } finally {
        # Zero the unmanaged BSTR buffer immediately
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
    }

    # Encode secret as UTF-8 byte array (canonical CredentialBlob encoding)
    $BlobBytes = [System.Text.Encoding]::UTF8.GetBytes($PlainText)

    # Zero the plaintext string after conversion
    $PlainText = $null
    [System.GC]::Collect()

    # Allocate unmanaged memory for the credential blob
    $BlobPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($BlobBytes.Length)
    try {
        # Copy UTF-8 bytes to unmanaged memory
        [System.Runtime.InteropServices.Marshal]::Copy($BlobBytes, 0, $BlobPtr, $BlobBytes.Length)

        # Zero the managed byte array after copy
        [System.Array]::Clear($BlobBytes, 0, $BlobBytes.Length)

        # Build the CREDENTIALW structure
        $Cred = New-Object IntentChord.Provision.CREDENTIALW
        $Cred.Type = [IntentChord.Provision.Native]::CRED_TYPE_GENERIC
        $Cred.TargetName = $TargetName
        $Cred.Comment = "IntentChord V2 AI Engine credential"
        $Cred.CredentialBlobSize = [uint32]($BlobBytes.Length)
        $Cred.CredentialBlob = $BlobPtr
        $Cred.Persist = [IntentChord.Provision.Native]::CRED_PERSIST_LOCAL_MACHINE
        $Cred.AttributeCount = 0
        $Cred.Attributes = [IntPtr]::Zero
        $Cred.TargetAlias = $null
        $Cred.UserName = $null

        # Write to Windows Credential Manager via CredWriteW (Flags=0)
        $ok = [IntentChord.Provision.Native]::CredWriteW([ref]$Cred, 0)
        if (-not $ok) {
            $errCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "CredWriteW failed with Win32 error $errCode"
        }

        # Safe status output only — no secret value
        Write-Output "SECRET_WRITE=PASS"
        Write-Output "CREDENTIAL_REFERENCE=$CredentialReference"
        Write-Output "TARGET=$TargetName"
        Write-Output "CREDENTIAL_TYPE=GENERIC"
        Write-Output "PERSISTENCE=LOCAL_MACHINE"

    } finally {
        # Zero and free unmanaged blob memory
        if ($BlobPtr -ne [IntPtr]::Zero) {
            try {
                $zero = New-Object byte[] $BlobBytes.Length
                [System.Runtime.InteropServices.Marshal]::Copy($zero, 0, $BlobPtr, $BlobBytes.Length)
            } catch { }
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($BlobPtr)
        }
    }

} catch {
    Write-Output "SECRET_WRITE=FAIL"
    Write-Output "CREDENTIAL_REFERENCE=$CredentialReference"
    Write-Output "TARGET=$TargetName"
    Write-Output "ERROR=$($_.Exception.Message)"
    exit 1
} finally {
    # Ensure SecureString is disposed
    if ($SecureSecret) {
        try { $SecureSecret.Dispose() } catch { }
    }
}
