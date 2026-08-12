[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd(
  [char[]]@('\', '/')
)
$testRoot = Join-Path `
  $temporaryParent `
  "osg-native-picker-evidence-$([Guid]::NewGuid().ToString('N'))"
$testRoot = [IO.Path]::GetFullPath($testRoot)
if (-not [string]::Equals(
    [IO.Path]::GetDirectoryName($testRoot),
    $temporaryParent,
    [StringComparison]::OrdinalIgnoreCase
  ) `
    -or -not [IO.Path]::GetFileName($testRoot).StartsWith(
      'osg-native-picker-evidence-',
      [StringComparison]::Ordinal
    ) `
    -or (Test-Path -LiteralPath $testRoot)) {
  throw 'Native picker evidence regression root was not a fresh direct child'
}
[void][IO.Directory]::CreateDirectory($testRoot)
$junctionPath = $null

try {
  $rootItem = Get-Item -LiteralPath $testRoot -Force
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Native picker evidence regression root must not be a reparse point'
  }

  $evidencePath = Join-Path $testRoot 'multi-stage.json'
  . (Join-Path $PSScriptRoot 'native-picker-evidence.ps1') `
    -EvidencePath $evidencePath `
    -AllowedRoot $testRoot
  Initialize-NativePickerEvidence
  Set-NativePickerEvidence `
    -Stage 'waiting-dialog' `
    -Outcome 'running' `
    -Metrics @{ dialogAttempts = 2 }
  Set-NativePickerEvidence `
    -Stage 'value-confirmed' `
    -Outcome 'running' `
    -Metrics @{
      editorAttempts = 3
      editorMatches = 1
      editorWritable = $true
      valueRetained = $true
    }
  Set-NativePickerEvidence `
    -Stage 'dialog-dismissed' `
    -Outcome 'succeeded' `
    -Metrics @{
      dismissAttempts = 1
      dialogDismissed = $true
    }

  $payloadBytes = [IO.File]::ReadAllBytes($evidencePath)
  $payload = [Text.Encoding]::UTF8.GetString($payloadBytes) | ConvertFrom-Json
  if ($payloadBytes.Length -le 0 `
      -or $payloadBytes.Length -gt 16384 `
      -or $payload.schemaVersion -ne 1 `
      -or $payload.outcome -cne 'succeeded' `
      -or $payload.stage -cne 'dialog-dismissed' `
      -or ($payload.stages -join ',') -cne 'initialized,waiting-dialog,value-confirmed,dialog-dismissed' `
      -or $payload.dialogAttempts -ne 2 `
      -or $payload.editorAttempts -ne 3 `
      -or $payload.dismissAttempts -ne 1 `
      -or -not $payload.dialogDismissed) {
    throw 'Native picker evidence regression did not preserve all replacement stages'
  }
  foreach ($scratchPath in @("$evidencePath.tmp", "$evidencePath.bak")) {
    if (Test-Path -LiteralPath $scratchPath) {
      throw 'Native picker evidence regression left scratch state after replacement'
    }
  }

  $hostileEvidencePath = Join-Path $testRoot 'hostile-backup.json'
  . (Join-Path $PSScriptRoot 'native-picker-evidence.ps1') `
    -EvidencePath $hostileEvidencePath `
    -AllowedRoot $testRoot
  Initialize-NativePickerEvidence
  $hostileOriginal = [IO.File]::ReadAllBytes($hostileEvidencePath)
  $hostileBackupPath = "$hostileEvidencePath.bak"
  [void][IO.Directory]::CreateDirectory($hostileBackupPath)
  $hostileRejected = $false
  try {
    Set-NativePickerEvidence -Stage 'waiting-dialog' -Outcome 'running'
  } catch {
    $hostileRejected = $true
  }
  $hostileCurrent = [IO.File]::ReadAllBytes($hostileEvidencePath)
  if (-not $hostileRejected `
      -or [Convert]::ToBase64String($hostileOriginal) -cne [Convert]::ToBase64String($hostileCurrent) `
      -or -not (Test-Path -LiteralPath $hostileBackupPath -PathType Container) `
      -or (Test-Path -LiteralPath "$hostileEvidencePath.tmp")) {
    throw 'Native picker evidence regression did not fail closed on hostile backup state'
  }
  [IO.Directory]::Delete($hostileBackupPath, $false)

  $recoveryResults = [ordered]@{}
  foreach ($fault in @('restore-existing-destination', 'restore-missing-destination')) {
    $recoveryEvidencePath = Join-Path $testRoot "$fault.json"
    . (Join-Path $PSScriptRoot 'native-picker-evidence.ps1') `
      -EvidencePath $recoveryEvidencePath `
      -AllowedRoot $testRoot `
      -TestFault $fault
    Initialize-NativePickerEvidence
    $priorBytes = [IO.File]::ReadAllBytes($recoveryEvidencePath)
    $faultRejected = $false
    try {
      Set-NativePickerEvidence -Stage 'waiting-dialog' -Outcome 'running'
    } catch {
      $faultRejected = $true
    }
    $restoredBytes = [IO.File]::ReadAllBytes($recoveryEvidencePath)
    $scratchClean = -not (Test-Path -LiteralPath "$recoveryEvidencePath.tmp") `
      -and -not (Test-Path -LiteralPath "$recoveryEvidencePath.bak")
    if (-not $faultRejected `
        -or [Convert]::ToBase64String($priorBytes) -cne [Convert]::ToBase64String($restoredBytes) `
        -or -not $scratchClean) {
      throw "Native picker evidence regression did not restore prior bytes for $fault"
    }
    $recoveryResults[$fault] = $true
  }

  $outsideRejected = $false
  try {
    . (Join-Path $PSScriptRoot 'native-picker-evidence.ps1') `
      -EvidencePath (Join-Path $temporaryParent 'outside.json') `
      -AllowedRoot $testRoot
  } catch {
    $outsideRejected = $true
  }
  if (-not $outsideRejected) {
    throw 'Native picker evidence regression accepted a non-child destination'
  }

  $junctionTarget = Join-Path $testRoot 'junction-target'
  $junctionChild = Join-Path $junctionTarget 'child'
  [void][IO.Directory]::CreateDirectory($junctionChild)
  $junctionPath = Join-Path $testRoot 'junction-boundary'
  $junction = New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget
  if (($junction.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
    throw 'Native picker evidence regression did not create its junction boundary'
  }
  $ancestorReparseRejected = $false
  try {
    $rootThroughJunction = Join-Path $junctionPath 'child'
    . (Join-Path $PSScriptRoot 'native-picker-evidence.ps1') `
      -EvidencePath (Join-Path $rootThroughJunction 'junction.json') `
      -AllowedRoot $rootThroughJunction
  } catch {
    $ancestorReparseRejected = $true
  }
  if (-not $ancestorReparseRejected `
      -or (Test-Path -LiteralPath (Join-Path $junctionChild 'junction.json'))) {
    throw 'Native picker evidence regression accepted a reparse ancestor'
  }
  [IO.Directory]::Delete($junctionPath, $false)
  $junctionPath = $null

  [pscustomobject]@{
    schemaVersion = 1
    replacements = 5
    hostileBackupRejected = $hostileRejected
    existingDestinationRestored = $recoveryResults['restore-existing-destination']
    missingDestinationRestored = $recoveryResults['restore-missing-destination']
    ancestorReparseRejected = $ancestorReparseRejected
    outsidePathRejected = $outsideRejected
    scratchClean = $true
  } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $junctionPath -and (Test-Path -LiteralPath $junctionPath)) {
    $junctionItem = Get-Item -LiteralPath $junctionPath -Force
    if (($junctionItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
      throw 'Native picker evidence regression refused non-junction cleanup'
    }
    [IO.Directory]::Delete($junctionPath, $false)
  }
  if (Test-Path -LiteralPath $testRoot) {
    $cleanupRoot = Get-Item -LiteralPath $testRoot -Force
    if (-not $cleanupRoot.PSIsContainer `
        -or ($cleanupRoot.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 `
        -or -not [string]::Equals(
          [IO.Path]::GetDirectoryName($cleanupRoot.FullName),
          $temporaryParent,
          [StringComparison]::OrdinalIgnoreCase
        ) `
        -or -not $cleanupRoot.Name.StartsWith(
          'osg-native-picker-evidence-',
          [StringComparison]::Ordinal
        )) {
      throw 'Native picker evidence regression refused unsafe cleanup'
    }
    [IO.Directory]::Delete($cleanupRoot.FullName, $true)
  }
}
