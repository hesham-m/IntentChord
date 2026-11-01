# IntentChord — MANUAL gated real-volume USN probe (SPEC V3 Phase 3).
# OWNER-INVOKED ONLY. This script is NEVER executed by automated tasks/CI.
#
# READ-ONLY CONTRACT:
#   - inspects USN journal state on a caller-provided NTFS volume;
#   - never modifies Workspace contents, EIT, database, or journal configuration;
#   - writes evidence ONLY into -OutputDir.
#
# Usage (Owner):
#   powershell -NoProfile -ExecutionPolicy Bypass ^
#     -File scripts\manual-usn-volume-probe.ps1 -VolumeRoot C:\ -OutputDir <dir>
param(
    [Parameter(Mandatory)][string]$VolumeRoot,
    [Parameter(Mandatory)][string]$OutputDir
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$cap = Invoke-IntentChordUsnQuery -VolumeRoot $VolumeRoot
Set-Content -Path (Join-Path $OutputDir 'capability.json') -Value $cap -Encoding utf8

$capObj = $cap | ConvertFrom-Json
if ($capObj.supported) {
    $endLong = [Convert]::ToInt64($capObj.nextUsn, 16)
    $startLong = [Math]::Max(0, $endLong - 200)
    $iv = Invoke-IntentChordUsnReadInterval -VolumeRoot $VolumeRoot `
        -ExpectedJournalId $capObj.journalId `
        -StartExclusive $startLong -EndInclusive $endLong -MaxEvents 100
    Set-Content -Path (Join-Path $OutputDir 'interval_tail.json') -Value $iv -Encoding utf8
}
Set-Content -Path (Join-Path $OutputDir 'README.txt') -Value @"
Manual USN probe evidence. READ-ONLY operations only (queryjournal/readdata).
VolumeRoot=$VolumeRoot
Generated=$(Get-Date -Format o)
"@ -Encoding utf8
Write-Host "PHASE3_MANUAL_PROBE_COMPLETE -> $OutputDir"
