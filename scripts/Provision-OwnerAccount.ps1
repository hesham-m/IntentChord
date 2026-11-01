<#
.SYNOPSIS
    One-time Owner account provisioning for IntentChord.
.DESCRIPTION
    Creates the initial Owner account in PostgreSQL using scrypt password hashing.
    Must be run from the project root. Requires DATABASE_URL in environment or .env.local.
    Password is entered securely via Read-Host -AsSecureString and never echoed.
#>
param(
    [string]$LoginName,
    [string]$DisplayName
)

$ErrorActionPreference = "Stop"

# Load .env.local if present
if (Test-Path ".env.local") {
    $envContent = Get-Content ".env.local" -Raw
    foreach ($line in $envContent -split "`n") {
        if ($line -match '^\s*([\w.-]+)\s*=\s*(.*)$') {
            $key = $Matches[1]
            $val = $Matches[2].Trim().Trim('"').Trim("'")
            if (-not [System.Environment]::GetEnvironmentVariable($key)) {
                [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
            }
        }
    }
}

if (-not $LoginName) {
    $LoginName = Read-Host "Owner login name"
}
if (-not $DisplayName) {
    $DisplayName = Read-Host "Display name"
}

$securePassword = Read-Host "Password" -AsSecureString
$confirmPassword = Read-Host "Confirm password" -AsSecureString

# Convert SecureString to plain text transiently for the Node process
$plainPassword = [System.Net.NetworkCredential]::new("", $securePassword).Password
$confirmPlain = [System.Net.NetworkCredential]::new("", $confirmPassword).Password

if ($plainPassword -ne $confirmPlain) {
    Write-Error "Passwords do not match."
    exit 1
}
if ($plainPassword.Length -lt 8) {
    Write-Error "Password must be at least 8 characters."
    exit 1
}

# Pass password via environment variable to avoid command-line exposure
$env:INTENTCHORD_PROVISION_PASSWORD = $plainPassword

try {
    node scripts/provision-owner-account.mjs --login "$LoginName" --display "$DisplayName"
} finally {
    # Clear the password from environment
    $env:INTENTCHORD_PROVISION_PASSWORD = $null
    [System.GC]::Collect()
}
