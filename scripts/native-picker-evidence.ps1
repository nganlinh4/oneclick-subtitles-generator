param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$EvidencePath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$AllowedRoot,

  [ValidateSet('none', 'restore-existing-destination', 'restore-missing-destination')]
  [string]$TestFault = 'none'
)

$script:nativePickerEvidenceMaximumBytes = 16384

function Assert-NativePickerEvidenceRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Root
  )

  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
  $pathRoot = [IO.Path]::GetPathRoot($fullRoot)
  $candidate = $fullRoot
  while (-not [string]::IsNullOrEmpty($candidate)) {
    $candidateItem = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
    if (-not $candidateItem.PSIsContainer `
        -or ($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Native picker evidence root ancestry must contain only regular directories'
    }
    if ([string]::Equals($candidate, $pathRoot, [StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $parent = [IO.Path]::GetDirectoryName($candidate)
    if ([string]::IsNullOrEmpty($parent) `
        -or [string]::Equals($parent, $candidate, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Native picker evidence root ancestry did not reach its volume boundary'
    }
    $candidate = if ([string]::Equals(
        $parent,
        $pathRoot,
        [StringComparison]::OrdinalIgnoreCase
      )) {
      $pathRoot
    } else {
      $parent.TrimEnd([char[]]@('\', '/'))
    }
  }
  $fullRoot
}

function Assert-NativePickerEvidenceDirectChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )

  if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Length -gt 1024) {
    throw 'Native picker evidence path must be bounded'
  }
  $fullPath = [IO.Path]::GetFullPath($Path)
  $parent = [IO.Path]::GetDirectoryName($fullPath)
  $leaf = [IO.Path]::GetFileName($fullPath)
  if (-not [string]::Equals($parent, $Root, [StringComparison]::OrdinalIgnoreCase) `
      -or [string]::IsNullOrWhiteSpace($leaf) `
      -or $leaf.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
    throw 'Native picker evidence path must be a direct child of its allowed root'
  }
  $fullPath
}

function Get-NativePickerEvidenceItem {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  try {
    Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch [System.Management.Automation.ItemNotFoundException] {
    $null
  }
}

function Assert-NativePickerEvidenceRegularFile {
  param(
    [Parameter(Mandatory = $true)]$Item
  )

  if ($Item.PSIsContainer `
      -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 `
      -or $Item.Length -le 0 `
      -or $Item.Length -gt $script:nativePickerEvidenceMaximumBytes) {
    throw 'Native picker evidence file must remain regular and bounded'
  }
}

function Assert-NativePickerEvidenceScratchAbsent {
  foreach ($scratchPath in @(
      $script:nativePickerEvidenceTemporaryPath,
      $script:nativePickerEvidenceBackupPath
    )) {
    if ($null -ne (Get-NativePickerEvidenceItem -Path $scratchPath)) {
      throw 'Native picker evidence scratch path must be clean'
    }
  }
}

function Remove-NativePickerEvidenceScratchFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  $boundedPath = Assert-NativePickerEvidenceDirectChildPath `
    -Path $Path `
    -Root $script:nativePickerEvidenceRoot
  $item = Get-NativePickerEvidenceItem -Path $boundedPath
  if ($null -eq $item) {
    return
  }
  Assert-NativePickerEvidenceRegularFile -Item $item
  [IO.File]::Delete($boundedPath)
}

function Restore-NativePickerEvidenceBackup {
  $backupItem = Get-NativePickerEvidenceItem -Path $script:nativePickerEvidenceBackupPath
  if ($null -eq $backupItem) {
    throw 'Native picker evidence replacement lost its bounded backup'
  }
  Assert-NativePickerEvidenceRegularFile -Item $backupItem

  $destinationItem = Get-NativePickerEvidenceItem -Path $script:nativePickerEvidencePath
  if ($null -eq $destinationItem) {
    [IO.File]::Move(
      $script:nativePickerEvidenceBackupPath,
      $script:nativePickerEvidencePath
    )
    return
  }

  Assert-NativePickerEvidenceRegularFile -Item $destinationItem
  if ($null -ne (Get-NativePickerEvidenceItem -Path $script:nativePickerEvidenceTemporaryPath)) {
    throw 'Native picker evidence restore scratch path was not clean'
  }
  [IO.File]::Replace(
    $script:nativePickerEvidenceBackupPath,
    $script:nativePickerEvidencePath,
    $script:nativePickerEvidenceTemporaryPath
  )
  Remove-NativePickerEvidenceScratchFile -Path $script:nativePickerEvidenceTemporaryPath
}

function Write-NativePickerEvidenceAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Json
  )

  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Json)
  if ($bytes.Length -le 0 -or $bytes.Length -gt $script:nativePickerEvidenceMaximumBytes) {
    throw 'Native picker evidence exceeded its bounded write contract'
  }

  [void](Assert-NativePickerEvidenceRoot -Root $script:nativePickerEvidenceRoot)
  $writeFailed = $false
  $cleanupFailed = $false
  $replaceAttempted = $false
  $replaceSucceeded = $false
  $preserveTemporary = $false
  try {
    Assert-NativePickerEvidenceScratchAbsent
    $stream = $null
    try {
      $stream = [IO.FileStream]::new(
        $script:nativePickerEvidenceTemporaryPath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None,
        4096,
        [IO.FileOptions]::WriteThrough
      )
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      if ($null -ne $stream) {
        $stream.Dispose()
      }
    }

    $destinationItem = Get-NativePickerEvidenceItem -Path $script:nativePickerEvidencePath
    if ($null -eq $destinationItem) {
      [IO.File]::Move(
        $script:nativePickerEvidenceTemporaryPath,
        $script:nativePickerEvidencePath
      )
    } else {
      Assert-NativePickerEvidenceRegularFile -Item $destinationItem
      $replaceAttempted = $true
      [IO.File]::Replace(
        $script:nativePickerEvidenceTemporaryPath,
        $script:nativePickerEvidencePath,
        $script:nativePickerEvidenceBackupPath
      )
      if ($script:nativePickerEvidenceTestFault -eq 'restore-missing-destination') {
        [IO.File]::Delete($script:nativePickerEvidencePath)
        throw 'Injected native picker evidence missing-destination recovery fault'
      }
      if ($script:nativePickerEvidenceTestFault -eq 'restore-existing-destination') {
        throw 'Injected native picker evidence existing-destination recovery fault'
      }
      $replaceSucceeded = $true
    }
  } catch {
    $writeFailed = $true
  } finally {
    if ($replaceAttempted) {
      try {
        if ($replaceSucceeded) {
          $backupItem = Get-NativePickerEvidenceItem `
            -Path $script:nativePickerEvidenceBackupPath
          if ($null -eq $backupItem) {
            throw 'Native picker evidence replacement omitted its bounded backup'
          }
          Remove-NativePickerEvidenceScratchFile `
            -Path $script:nativePickerEvidenceBackupPath
        } else {
          Restore-NativePickerEvidenceBackup
        }
      } catch {
        $cleanupFailed = $true
        $preserveTemporary = $true
      }
    }

    if (-not $preserveTemporary) {
      try {
        Remove-NativePickerEvidenceScratchFile `
          -Path $script:nativePickerEvidenceTemporaryPath
      } catch {
        $cleanupFailed = $true
      }
    }
  }

  if ($cleanupFailed) {
    throw 'Native picker evidence recovery or bounded cleanup failed'
  }
  if ($writeFailed) {
    throw 'Native picker evidence could not be written atomically'
  }
}

function Set-NativePickerEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][ValidateSet('running', 'succeeded', 'failed')][string]$Outcome,
    [string]$FailureCode = 'none',
    [hashtable]$Metrics = @{}
  )

  if ($Stage -notmatch '^[a-z][a-z0-9-]{0,47}$' `
      -or $FailureCode -notmatch '^[a-z][a-z0-9-]{0,47}$') {
    throw 'Native picker evidence used an invalid bounded label'
  }
  $allowedMetrics = @(
    'inspectorPhase',
    'nativeCandidateMatches',
    'nativeCandidateScanIncomplete',
    'rawProcessWindowMatches',
    'rawProcessVisibleMatches',
    'rawProcessClassMatches',
    'rawProcessNameMatches',
    'rawProcessExactMatches',
    'rawProcessOwnerMatches',
    'rawProcessOwnedVisibleMatches',
    'rawDesktopExactMatches',
    'rawDesktopOwnerMatches',
    'rawDesktopOwnedVisibleMatches',
    'rawCensusIncomplete',
    'dialogAttempts',
    'dialogMatches',
    'ownerMatched',
    'editorAttempts',
    'editorMatches',
    'editorWritable',
    'valueRetained',
    'buttonAttempts',
    'buttonMatches',
    'buttonEnabled',
    'buttonInvokable',
    'dismissAttempts',
    'dialogDismissed'
  )
  $rawCountMetrics = @(
    'rawProcessWindowMatches',
    'rawProcessVisibleMatches',
    'rawProcessClassMatches',
    'rawProcessNameMatches',
    'rawProcessExactMatches',
    'rawProcessOwnerMatches',
    'rawProcessOwnedVisibleMatches',
    'rawDesktopExactMatches',
    'rawDesktopOwnerMatches',
    'rawDesktopOwnedVisibleMatches'
  )
  foreach ($metric in $Metrics.GetEnumerator()) {
    $validInspectorPhase = $metric.Key -ceq 'inspectorPhase' `
      -and $metric.Value -is [string] `
      -and $metric.Value -in @(
        'not-started',
        'starting',
        'connected',
        'tab-activated',
        'control-ready',
        'prior-state-validated',
        'click-issued'
      )
    $validRawCount = $metric.Key -notin $rawCountMetrics `
      -or ($metric.Value -is [int] `
        -and $metric.Value -ge 0 `
        -and $metric.Value -le 1000)
    $validRawIncomplete = $metric.Key -cne 'rawCensusIncomplete' `
      -or $metric.Value -is [bool]
    $validNativeCandidateCount = $metric.Key -cne 'nativeCandidateMatches' `
      -or ($metric.Value -is [int] `
        -and $metric.Value -ge 0 `
        -and $metric.Value -le 1000)
    $validNativeCandidateIncomplete = $metric.Key -cne 'nativeCandidateScanIncomplete' `
      -or $metric.Value -is [bool]
    if ($metric.Key -notin $allowedMetrics `
        -or ($metric.Key -ceq 'inspectorPhase' -and -not $validInspectorPhase) `
        -or -not $validRawCount `
        -or -not $validRawIncomplete `
        -or -not $validNativeCandidateCount `
        -or -not $validNativeCandidateIncomplete `
        -or ($metric.Key -cne 'inspectorPhase' `
          -and $metric.Value -isnot [bool] `
          -and $metric.Value -isnot [int])) {
      throw 'Native picker evidence used an invalid bounded metric'
    }
    $script:nativePickerEvidenceState[$metric.Key] = $metric.Value
  }
  if ($script:nativePickerEvidenceStages.Count -eq 0 `
      -or $script:nativePickerEvidenceStages[$script:nativePickerEvidenceStages.Count - 1] -cne $Stage) {
    if ($script:nativePickerEvidenceStages.Count -ge 16) {
      throw 'Native picker evidence exceeded its bounded stage count'
    }
    [void]$script:nativePickerEvidenceStages.Add($Stage)
  }
  $script:nativePickerEvidenceState.outcome = $Outcome
  $script:nativePickerEvidenceState.stage = $Stage
  $script:nativePickerEvidenceState.failureCode = $FailureCode
  $script:nativePickerEvidenceState.elapsedMs = [Math]::Min(
    [int]$script:nativePickerEvidenceWatch.ElapsedMilliseconds,
    300000
  )
  $script:nativePickerEvidenceState.stages = @($script:nativePickerEvidenceStages)
  $json = $script:nativePickerEvidenceState | ConvertTo-Json -Depth 3 -Compress
  if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 16384 `
      -or $json -match '(?i)(?:https?://|file://|localhost|127\.0\.0\.1|[A-Za-z]:[\\/]|\\\\|"[^"\r\n]*(?:path|pid|hwnd|handle|title|url|token)[^"\r\n]*"\s*:)') {
    throw 'Native picker evidence escaped its bounded redacted contract'
  }
  Write-NativePickerEvidenceAtomically -Json $json
}

function Initialize-NativePickerEvidence {
  $script:nativePickerEvidenceWatch = [Diagnostics.Stopwatch]::StartNew()
  $script:nativePickerEvidenceStages = [Collections.Generic.List[string]]::new()
  $script:nativePickerEvidenceState = [ordered]@{
    schemaVersion = 1
    outcome = 'running'
    stage = 'initialized'
    failureCode = 'none'
    elapsedMs = 0
    stages = @()
    inspectorPhase = 'not-started'
    nativeCandidateMatches = 0
    nativeCandidateScanIncomplete = $false
    rawProcessWindowMatches = 0
    rawProcessVisibleMatches = 0
    rawProcessClassMatches = 0
    rawProcessNameMatches = 0
    rawProcessExactMatches = 0
    rawProcessOwnerMatches = 0
    rawProcessOwnedVisibleMatches = 0
    rawDesktopExactMatches = 0
    rawDesktopOwnerMatches = 0
    rawDesktopOwnedVisibleMatches = 0
    rawCensusIncomplete = $false
    dialogAttempts = 0
    dialogMatches = 0
    ownerMatched = $false
    editorAttempts = 0
    editorMatches = 0
    editorWritable = $false
    valueRetained = $false
    buttonAttempts = 0
    buttonMatches = 0
    buttonEnabled = $false
    buttonInvokable = $false
    dismissAttempts = 0
    dialogDismissed = $false
  }
  Set-NativePickerEvidence -Stage 'initialized' -Outcome 'running'
}

$script:nativePickerEvidenceRoot = Assert-NativePickerEvidenceRoot -Root $AllowedRoot
$script:nativePickerEvidenceTestFault = $TestFault
$script:nativePickerEvidencePath = Assert-NativePickerEvidenceDirectChildPath `
  -Path $EvidencePath `
  -Root $script:nativePickerEvidenceRoot
$script:nativePickerEvidenceTemporaryPath = Assert-NativePickerEvidenceDirectChildPath `
  -Path "$script:nativePickerEvidencePath.tmp" `
  -Root $script:nativePickerEvidenceRoot
$script:nativePickerEvidenceBackupPath = Assert-NativePickerEvidenceDirectChildPath `
  -Path "$script:nativePickerEvidencePath.bak" `
  -Root $script:nativePickerEvidenceRoot

if ([string]::Equals(
    $script:nativePickerEvidenceTemporaryPath,
    $script:nativePickerEvidenceBackupPath,
    [StringComparison]::OrdinalIgnoreCase
  )) {
  throw 'Native picker evidence scratch paths must be distinct'
}
if ($null -ne (Get-NativePickerEvidenceItem -Path $script:nativePickerEvidencePath)) {
  throw 'Native picker evidence path must be clean'
}
Assert-NativePickerEvidenceScratchAbsent
