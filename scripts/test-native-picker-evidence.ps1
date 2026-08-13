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
  foreach ($inspectorPhase in @(
      'tab-activated',
      'control-ready',
      'prior-state-validated',
      'click-issued'
    )) {
    Set-NativePickerEvidence `
      -Stage 'waiting-dialog' `
      -Outcome 'running' `
      -Metrics @{ inspectorPhase = $inspectorPhase }
  }
  Set-NativePickerEvidence `
    -Stage 'waiting-dialog' `
    -Outcome 'running' `
    -Metrics @{
      inspectorPhase = 'click-issued'
      dialogAttempts = 2
      nativeCandidateMatches = 1
      nativeCandidateScanIncomplete = $false
      rawProcessWindowMatches = 4
      rawProcessVisibleMatches = 3
      rawProcessClassMatches = 2
      rawProcessNameMatches = 1
      rawProcessExactMatches = 1
      rawProcessOwnerMatches = 1
      rawProcessOwnedVisibleMatches = 1
      rawDesktopExactMatches = 2
      rawDesktopOwnerMatches = 1
      rawDesktopOwnedVisibleMatches = 1
      rawCensusIncomplete = $true
    }
  $invalidInspectorPhaseRejected = $false
  try {
    Set-NativePickerEvidence `
      -Stage 'waiting-dialog' `
      -Outcome 'running' `
      -Metrics @{ inspectorPhase = $true }
  } catch {
    $invalidInspectorPhaseRejected = $true
  }
  $invalidRawCountRejected = $false
  try {
    Set-NativePickerEvidence `
      -Stage 'waiting-dialog' `
      -Outcome 'running' `
      -Metrics @{ rawProcessWindowMatches = 1001 }
  } catch {
    $invalidRawCountRejected = $true
  }
  $invalidRawIncompleteRejected = $false
  try {
    Set-NativePickerEvidence `
      -Stage 'waiting-dialog' `
      -Outcome 'running' `
      -Metrics @{ rawCensusIncomplete = 1 }
  } catch {
    $invalidRawIncompleteRejected = $true
  }
  $invalidNativeCandidateCountRejected = $false
  try {
    Set-NativePickerEvidence `
      -Stage 'waiting-dialog' `
      -Outcome 'running' `
      -Metrics @{ nativeCandidateMatches = 1001 }
  } catch {
    $invalidNativeCandidateCountRejected = $true
  }
  $invalidNativeCandidateIncompleteRejected = $false
  try {
    Set-NativePickerEvidence `
      -Stage 'waiting-dialog' `
      -Outcome 'running' `
      -Metrics @{ nativeCandidateScanIncomplete = 1 }
  } catch {
    $invalidNativeCandidateIncompleteRejected = $true
  }
  $forbiddenRawMetricRejected = $false
  try {
    Set-NativePickerEvidence `
      -Stage 'waiting-dialog' `
      -Outcome 'running' `
      -Metrics @{ rawWindowTitle = 1 }
  } catch {
    $forbiddenRawMetricRejected = $true
  }
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
    -Outcome 'running' `
    -Metrics @{
      dismissAttempts = 1
      dialogDismissed = $true
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
      -or $payload.inspectorPhase -cne 'click-issued' `
      -or $payload.nativeCandidateMatches -ne 1 `
      -or $payload.nativeCandidateScanIncomplete `
      -or -not $invalidInspectorPhaseRejected `
      -or $payload.rawProcessWindowMatches -ne 4 `
      -or $payload.rawProcessVisibleMatches -ne 3 `
      -or $payload.rawProcessClassMatches -ne 2 `
      -or $payload.rawProcessNameMatches -ne 1 `
      -or $payload.rawProcessExactMatches -ne 1 `
      -or $payload.rawProcessOwnerMatches -ne 1 `
      -or $payload.rawProcessOwnedVisibleMatches -ne 1 `
      -or $payload.rawDesktopExactMatches -ne 2 `
      -or $payload.rawDesktopOwnerMatches -ne 1 `
      -or $payload.rawDesktopOwnedVisibleMatches -ne 1 `
      -or -not $payload.rawCensusIncomplete `
      -or -not $invalidRawCountRejected `
      -or -not $invalidRawIncompleteRejected `
      -or -not $invalidNativeCandidateCountRejected `
      -or -not $invalidNativeCandidateIncompleteRejected `
      -or -not $forbiddenRawMetricRejected `
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

  $installedSmokePath = Join-Path $PSScriptRoot 'test-installed-windows.ps1'
  $installedTokens = $null
  $installedErrors = $null
  $installedAst = [System.Management.Automation.Language.Parser]::ParseFile(
    $installedSmokePath,
    [ref]$installedTokens,
    [ref]$installedErrors
  )
  if ($installedErrors.Count -ne 0) {
    throw 'Native picker diagnostic regression could not parse the installed smoke'
  }
  $installedFunctionSources = @{}
  foreach ($functionName in @(
      'Initialize-NativePickerInterop',
      'New-NativePickerRawCensusMaxima',
      'Update-NativePickerRawCensusMaxima',
      'Add-NativePickerRawCensusMetrics',
      'Test-NativePickerCandidate',
      'Test-NativePickerElementCandidate',
      'Get-NativePickerCandidateSnapshot',
      'Get-NativePickerPinnedCandidateState',
      'Get-NativeMediaPickerDialogs',
      'Get-DiagnosticBaselineSnapshot',
      'Get-NativePickerDiagnosticOutcome',
      'Get-NativePickerInspectorPhase',
      'Get-NativePickerPreclickFailureCode',
      'Get-InstalledLocalMediaInspectorStderrState',
      'Wait-NativePickerClickIssued',
      'Dismiss-NativeMediaPicker',
      'Complete-NativeMediaPicker',
      'Inspect-InstalledLocalMediaFlow'
    )) {
    $definitions = @($installedAst.FindAll({
          param($node)
          $node -is [System.Management.Automation.Language.FunctionDefinitionAst] `
            -and $node.Name -ceq $functionName
        }, $true))
    if ($definitions.Count -ne 1) {
      throw 'Native picker diagnostic regression found an invalid function boundary'
    }
    $installedFunctionSources[$functionName] = $definitions[0].Extent.Text
    Invoke-Expression $definitions[0].Extent.Text
  }
  Initialize-NativePickerInterop
  $candidateScan = [OsgNativePickerWindow]::GetNativeCandidates($PID, [long]1)
  if ((@($candidateScan.PSObject.Properties.Name | Sort-Object) -join ',') `
      -cne 'Candidates,ExactMatchCount,Incomplete' `
      -or $candidateScan.ExactMatchCount -isnot [int] `
      -or $candidateScan.ExactMatchCount -lt 0 `
      -or $candidateScan.ExactMatchCount -gt 512 `
      -or $candidateScan.Incomplete -isnot [bool] `
      -or @($candidateScan.Candidates).Count -gt 2 `
      -or (Test-NativePickerCandidate `
        -CandidateHandle 0 `
        -ProcessId $PID `
        -OwnerHandle 1) `
      -or [OsgNativePickerWindow]::IsNormalizedWindow(0)) {
    throw 'Native picker candidate regression exposed an invalid bounded ephemeral schema'
  }
  foreach ($signedHandle in @([int]-2147483647, [int]-1)) {
    $expectedNormalized = [long]$signedHandle -band 0xffffffffL
    $positiveHandle = [long]$expectedNormalized
    if ([OsgNativePickerWindow]::NormalizeAutomationWindowHandle($signedHandle) -ne $expectedNormalized `
        -or [OsgNativePickerWindow]::NormalizeNativeWindowHandle(
          [IntPtr]::new([long]$signedHandle)
        ) -ne $expectedNormalized) {
      throw 'Native picker candidate regression did not normalize signed and unsigned high-bit HWND representations identically'
    }
    if ([IntPtr]::Size -eq 8 `
        -and [OsgNativePickerWindow]::NormalizeNativeWindowHandle(
          [IntPtr]::new($positiveHandle)
        ) -ne $expectedNormalized) {
      throw 'Native picker candidate regression did not normalize the zero-extended high-bit HWND representation'
    }
  }
  $exactPredicate = [OsgNativePickerWindow].GetMethod(
    'IsExactOwnedVisibleFacts',
    ([Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static)
  )
  if ($null -eq $exactPredicate `
      -or -not [bool]$exactPredicate.Invoke(
        $null,
        @($true, $true, $true, $true, $true)
      )) {
    throw 'Native picker candidate regression rejected the exact authority tuple'
  }
  for ($falseIndex = 0; $falseIndex -lt 5; $falseIndex += 1) {
    $tuple = @($true, $true, $true, $true, $true)
    $tuple[$falseIndex] = $false
    if ([bool]$exactPredicate.Invoke($null, $tuple)) {
      throw 'Native picker candidate regression accepted a partial authority tuple'
    }
  }
  $probeIncomplete = [OsgNativePickerWindow].GetMethod(
    'IsCandidateProbeIncomplete',
    ([Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static)
  )
  if ($null -eq $probeIncomplete `
      -or [bool]$probeIncomplete.Invoke(
        $null,
        @($true, $true, $true, 21, 0, $false, 0, $true)
      ) `
      -or -not [bool]$probeIncomplete.Invoke(
        $null,
        @($true, $true, $true, 0, 5, $false, 0, $true)
      ) `
      -or -not [bool]$probeIncomplete.Invoke(
        $null,
        @($true, $true, $true, 21, 0, $true, 5, $true)
      ) `
      -or -not [bool]$probeIncomplete.Invoke(
        $null,
        @($true, $true, $true, 21, 0, $false, 0, $false)
      ) `
      -or [bool]$probeIncomplete.Invoke(
        $null,
        @($false, $true, $true, 0, 5, $true, 5, $false)
      )) {
    throw 'Native picker candidate regression did not fail closed on an uncertain relevant title, owner, or destroyed-window probe'
  }
  $rawCensusType = [OsgNativePickerWindow+RawCensus]
  $rawCensusPropertyNames = @(
    'RawCensusIncomplete',
    'RawDesktopExactMatches',
    'RawDesktopOwnedVisibleMatches',
    'RawDesktopOwnerMatches',
    'RawProcessClassMatches',
    'RawProcessExactMatches',
    'RawProcessNameMatches',
    'RawProcessOwnedVisibleMatches',
    'RawProcessOwnerMatches',
    'RawProcessVisibleMatches',
    'RawProcessWindowMatches'
  )
  $liveRawCensus = [OsgNativePickerWindow]::GetRawCensus($PID, [long]1)
  if ((@($liveRawCensus.PSObject.Properties.Name | Sort-Object) -join ',') `
      -cne (($rawCensusPropertyNames | Sort-Object) -join ',') `
      -or $liveRawCensus.RawCensusIncomplete -isnot [bool]) {
    throw 'Native picker raw census regression exposed an invalid aggregate-only schema'
  }
  foreach ($name in @($rawCensusPropertyNames | Where-Object { $_ -cne 'RawCensusIncomplete' })) {
    if ($liveRawCensus.$name -isnot [int] `
        -or $liveRawCensus.$name -lt 0 `
        -or $liveRawCensus.$name -gt 512) {
      throw 'Native picker raw census regression exceeded its per-poll count cap'
    }
  }

  $accumulatorFlags = [Reflection.BindingFlags]::NonPublic `
    -bor [Reflection.BindingFlags]::Static
  $accumulateRawCensus = [OsgNativePickerWindow].GetMethod(
    'AccumulateRawCensusWindow',
    $accumulatorFlags
  )
  if ($null -eq $accumulateRawCensus) {
    throw 'Native picker raw census regression could not exercise its production accumulator'
  }
  $tupleCensus = [Activator]::CreateInstance($rawCensusType)
  foreach ($tuple in @(
      @($true, $true, $false, $false, $true),
      @($true, $false, $false, $true, $false),
      @($false, $false, $true, $true, $false),
      @($false, $true, $false, $false, $true),
      @($true, $true, $true, $true, $true)
    )) {
    [void]$accumulateRawCensus.Invoke(
      $null,
      @($tupleCensus) + @($tuple | ForEach-Object { [bool]$_ })
    )
  }
  if ($tupleCensus.RawProcessWindowMatches -ne 3 `
      -or $tupleCensus.RawProcessVisibleMatches -ne 2 `
      -or $tupleCensus.RawProcessClassMatches -ne 1 `
      -or $tupleCensus.RawProcessNameMatches -ne 2 `
      -or $tupleCensus.RawProcessExactMatches -ne 1 `
      -or $tupleCensus.RawProcessOwnerMatches -ne 2 `
      -or $tupleCensus.RawProcessOwnedVisibleMatches -ne 2 `
      -or $tupleCensus.RawDesktopExactMatches -ne 2 `
      -or $tupleCensus.RawDesktopOwnerMatches -ne 3 `
      -or $tupleCensus.RawDesktopOwnedVisibleMatches -ne 3) {
    throw 'Native picker raw census regression merged independent process, identity, owner, or visibility buckets'
  }

  $rawCensusMaxima = New-NativePickerRawCensusMaxima
  $firstRawSnapshot = [pscustomobject](New-NativePickerRawCensusMaxima)
  $firstRawSnapshot.rawProcessWindowMatches = 7
  $firstRawSnapshot.rawProcessNameMatches = 4
  $firstRawSnapshot.rawDesktopExactMatches = 3
  Update-NativePickerRawCensusMaxima -Maxima $rawCensusMaxima -Snapshot $firstRawSnapshot
  $lowerRawSnapshot = [pscustomobject](New-NativePickerRawCensusMaxima)
  $lowerRawSnapshot.rawProcessWindowMatches = 2
  $lowerRawSnapshot.rawProcessNameMatches = 1
  $lowerRawSnapshot.rawDesktopExactMatches = 1
  Update-NativePickerRawCensusMaxima -Maxima $rawCensusMaxima -Snapshot $lowerRawSnapshot
  $oversizedRawSnapshot = [pscustomobject](New-NativePickerRawCensusMaxima)
  $oversizedRawSnapshot.rawProcessOwnerMatches = 1001
  Update-NativePickerRawCensusMaxima -Maxima $rawCensusMaxima -Snapshot $oversizedRawSnapshot
  $rawMetrics = @{}
  Add-NativePickerRawCensusMetrics -Metrics $rawMetrics -Maxima $rawCensusMaxima
  if ($rawMetrics.rawProcessWindowMatches -ne 7 `
      -or $rawMetrics.rawProcessNameMatches -ne 4 `
      -or $rawMetrics.rawDesktopExactMatches -ne 3 `
      -or $rawMetrics.rawProcessOwnerMatches -ne 1000 `
      -or -not $rawMetrics.rawCensusIncomplete `
      -or $rawMetrics.Count -ne 11) {
    throw 'Native picker raw census regression lost bounded maximum aggregation'
  }

  $savedCandidateSnapshotSource = $installedFunctionSources['Get-NativePickerCandidateSnapshot']
  $savedElementCandidateSource = $installedFunctionSources['Test-NativePickerElementCandidate']
  $script:syntheticPinnedElement = [pscustomobject]@{ identity = 'pinned' }
  function Test-NativePickerElementCandidate {
    param($Element, [long]$CandidateHandle, [int]$ProcessId, [long]$OwnerHandle)
    $Element.identity -ceq 'pinned' `
      -and $CandidateHandle -eq 2147483649L `
      -and $ProcessId -eq 7 `
      -and $OwnerHandle -eq 9
  }
  function Get-NativePickerCandidateSnapshot {
    param([int]$ProcessId, [long]$OwnerHandle)
    $script:syntheticCandidateSnapshot
  }
  foreach ($fixture in @(
      @{ exact = 1; scanIncomplete = $false; bridgeIncomplete = $false; count = 1; valid = $true },
      @{ exact = 2; scanIncomplete = $false; bridgeIncomplete = $false; count = 1; valid = $false },
      @{ exact = 1; scanIncomplete = $true; bridgeIncomplete = $false; count = 1; valid = $false },
      @{ exact = 1; scanIncomplete = $false; bridgeIncomplete = $true; count = 0; valid = $false },
      @{ exact = 0; scanIncomplete = $false; bridgeIncomplete = $false; count = 0; valid = $false }
    )) {
    $candidateElements = if ($fixture.count -eq 1) {
      @($script:syntheticPinnedElement)
    } else {
      @()
    }
    $script:syntheticCandidateSnapshot = [pscustomobject]@{
      CandidateElements = $candidateElements
      ExactMatchCount = [int]$fixture.exact
      ScanIncomplete = [bool]$fixture.scanIncomplete
      BridgeIncomplete = [bool]$fixture.bridgeIncomplete
      Incomplete = [bool]$fixture.scanIncomplete -or [bool]$fixture.bridgeIncomplete
    }
    $freshState = Get-NativePickerPinnedCandidateState `
      -Element $script:syntheticPinnedElement `
      -CandidateHandle 2147483649L `
      -ProcessId 7 `
      -OwnerHandle 9
    if ([bool]$freshState.Valid -ne [bool]$fixture.valid `
        -or [int]$freshState.ExactMatchCount -ne [int]$fixture.exact) {
      throw 'Native picker candidate regression accepted an ambiguous, incomplete, missing, or replacement fresh-scan tuple'
    }
  }
  Invoke-Expression $savedElementCandidateSource
  Invoke-Expression $savedCandidateSnapshotSource

  $completePickerSource = $installedFunctionSources['Complete-NativeMediaPicker']
  $dismissPickerSource = $installedFunctionSources['Dismiss-NativeMediaPicker']
  $candidateSnapshotSource = $installedFunctionSources['Get-NativePickerCandidateSnapshot']
  $dialogDiscoverySource = $installedFunctionSources['Get-NativeMediaPickerDialogs']
  if ($completePickerSource -match '(?i)(?:if|elseif|until|while)\s*\([^\r\n]*(?:rawCensus|rawProcess|rawDesktop)' `
      -or $dismissPickerSource -match '(?i)(?:if|elseif|until|while)\s*\([^\r\n]*(?:rawCensus|rawProcess|rawDesktop)' `
      -or $completePickerSource -match '\$snapshot\.(?:Exact|Owned)' `
      -or $dismissPickerSource -match '\$snapshot\.(?:Exact|Owned)' `
      -or $completePickerSource -notmatch '\$snapshot\.NativeExactMatchCount -eq 1 -and \$nativeCandidates\.Count -eq 1' `
      -or $dismissPickerSource -notmatch '\$snapshot\.NativeExactMatchCount -eq 0' `
      -or $dismissPickerSource -notmatch '\$snapshot\.NativeExactMatchCount -gt 1' `
      -or $dismissPickerSource -notmatch 'IsNormalizedWindow\(\$pinnedCandidateHandle\)' `
      -or $completePickerSource -notmatch 'IsNormalizedWindow\(\$dialogHandle\)[\s\S]*?''dismissal-changed''') {
    throw 'Native picker raw census regression allowed diagnostics to control UIA authority'
  }
  if ($completePickerSource -notmatch '\$snapshot\.NativeCandidateScanIncomplete' `
      -or $dismissPickerSource -notmatch '\$snapshot\.NativeCandidateScanIncomplete' `
      -or $completePickerSource -notmatch "'dialog-automation-timeout'" `
      -or $completePickerSource -notmatch '\$failureCode -ceq ''dialog-timeout''' `
      -or $completePickerSource -notmatch 'Get-NativePickerPinnedCandidateState[\s\S]*?\$valuePattern\.SetValue\(\$MediaPath\)' `
      -or $completePickerSource -notmatch 'Get-NativePickerPinnedCandidateState[\s\S]*?\$invokePattern\.Invoke\(\)' `
      -or $completePickerSource -notmatch '-ExpectedCandidateHandle \$dialogHandle' `
      -or $dismissPickerSource -notmatch 'Get-NativePickerPinnedCandidateState[\s\S]*?PostCloseMessage' `
      -or $dismissPickerSource -notmatch 'Get-NativePickerPinnedCandidateState[\s\S]*?Invoke\(\)') {
    throw 'Native picker candidate regression lost pinned complete-scan revalidation authority'
  }
  if ($candidateSnapshotSource -notmatch 'AutomationElement\]::FromHandle\(\$candidate\)[\s\S]*?Test-NativePickerElementCandidate' `
      -or $candidateSnapshotSource -notmatch '-not \$scan\.Incomplete[\s\S]*?\$scan\.ExactMatchCount -eq 1[\s\S]*?@\(\$scan\.Candidates\)\.Count -eq 1[\s\S]*?AutomationElement\]::FromHandle' `
      -or $candidateSnapshotSource -notmatch 'CandidateElements = \$candidateElements\s*ExactMatchCount = \[int\]\$scan\.ExactMatchCount\s*ScanIncomplete = ' `
      -or $dialogDiscoverySource -notmatch 'try\s*\{\s*\$nativeCandidates = Get-NativePickerCandidateSnapshot[\s\S]*?catch\s*\{\s*\$nativeCandidates = \[pscustomobject\]@\{[\s\S]*?Incomplete = \$true\s*\}\s*\}\s*try\s*\{\s*\$candidate = \[OsgNativePickerWindow\]::GetRawCensus' `
      -or $dialogDiscoverySource -match 'GetRawCensus[\s\S]*?catch\s*\{[\s\S]*?\$nativeCandidates\s*=') {
    throw 'Native picker candidate regression coupled authoritative discovery to diagnostic census failure or skipped its post-conversion identity check'
  }
  if ($installedFunctionSources['Initialize-NativePickerInterop'] -notmatch 'ReadRootAncestor\(window, out ancestorError\)' `
      -or $installedFunctionSources['Initialize-NativePickerInterop'] -notmatch 'NormalizeNativeWindowHandle\(ancestor\) != normalizedWindow') {
    throw 'Native picker candidate regression compared a root ancestor without canonical HWND normalization'
  }
  if (([regex]::Matches(
        $completePickerSource,
        'catch\s*\{\s*\$rawCensusMaxima\.rawCensusIncomplete = \$true\s*throw\s*\}'
      )).Count -ne 2 `
      -or $completePickerSource -notmatch '\}\s*else\s*\{\s*\$rawCensusMaxima\.rawCensusIncomplete = \$true\s*\$failureMetrics\.nativeCandidateScanIncomplete = \$true\s*\}\s*Add-NativePickerRawCensusMetrics -Metrics \$failureMetrics') {
    throw 'Native picker raw census regression misreported a dropped or missing snapshot as complete'
  }
  $phaseRoot = Join-Path $testRoot 'ordered-phases'
  [void][IO.Directory]::CreateDirectory($phaseRoot)
  $orderedPhases = @(
    'starting',
    'connected',
    'tab-activated',
    'control-ready',
    'prior-state-validated',
    'click-issued'
  )
  foreach ($phaseName in $orderedPhases) {
    $phasePath = Join-Path $phaseRoot "osg-installed-native-picker-$phaseName.json"
    [IO.File]::WriteAllText(
      $phasePath,
      (@{ schemaVersion = 1; stage = $phaseName } | ConvertTo-Json -Compress),
      [Text.UTF8Encoding]::new($false)
    )
    if ((Get-NativePickerInspectorPhase -Root $phaseRoot) -cne $phaseName) {
      throw 'Native picker phase regression did not preserve the ordered activation boundary'
    }
  }
  $expectedFailureCodes = [ordered]@{
    'not-started' = 'inspector-startup-exited'
    'starting' = 'inspector-startup-exited'
    'connected' = 'inspector-tab-activation-exited'
    'tab-activated' = 'inspector-control-readiness-exited'
    'control-ready' = 'inspector-prior-state-exited'
    'prior-state-validated' = 'inspector-picker-click-exited'
  }
  foreach ($failureBoundary in $expectedFailureCodes.GetEnumerator()) {
    if ((Get-NativePickerPreclickFailureCode -Phase $failureBoundary.Key) `
        -cne $failureBoundary.Value) {
      throw 'Native picker phase regression lost a fixed pre-click failure category'
    }
  }

  $nonPrefixRoot = Join-Path $testRoot 'non-prefix-phases'
  [void][IO.Directory]::CreateDirectory($nonPrefixRoot)
  [IO.File]::WriteAllText(
    (Join-Path $nonPrefixRoot 'osg-installed-native-picker-connected.json'),
    '{"schemaVersion":1,"stage":"connected"}',
    [Text.UTF8Encoding]::new($false)
  )
  $nonPrefixRejected = $false
  try {
    [void](Get-NativePickerInspectorPhase -Root $nonPrefixRoot)
  } catch {
    $nonPrefixRejected = $true
  }
  if (-not $nonPrefixRejected) {
    throw 'Native picker phase regression accepted a non-prefix activation boundary'
  }

  $hostilePhaseRoot = Join-Path $testRoot 'hostile-phase'
  [void][IO.Directory]::CreateDirectory($hostilePhaseRoot)
  [IO.File]::WriteAllText(
    (Join-Path $hostilePhaseRoot 'osg-installed-native-picker-starting.json'),
    ('x' * 129),
    [Text.UTF8Encoding]::new($false)
  )
  $oversizedPhaseRejected = $false
  try {
    [void](Get-NativePickerInspectorPhase -Root $hostilePhaseRoot)
  } catch {
    $oversizedPhaseRejected = $true
  }
  if (-not $oversizedPhaseRejected) {
    throw 'Native picker phase regression accepted oversized phase evidence'
  }

  $stderrPath = Join-Path $testRoot 'inspector.stderr'
  [IO.File]::WriteAllText(
    $stderrPath,
    "failure`nC:\Users\runner\secret.mp4`nhttps://localhost/file?token=secret",
    [Text.UTF8Encoding]::new($false)
  )
  $hostileStderrState = Get-InstalledLocalMediaInspectorStderrState -Path $stderrPath
  $fixedFailureCode = Get-NativePickerPreclickFailureCode -Phase 'connected'
  if ($hostileStderrState -cne 'nonempty' `
      -or $fixedFailureCode -cne 'inspector-tab-activation-exited' `
      -or $fixedFailureCode -match '(?i)(?:https?://|file://|localhost|127\.0\.0\.1|token|[A-Za-z]:[\\/])') {
    throw 'Native picker stderr regression surfaced hostile multiline path, URL, or token content'
  }
  [IO.File]::WriteAllText(
    $stderrPath,
    ('x' * 16385),
    [Text.UTF8Encoding]::new($false)
  )
  if ((Get-InstalledLocalMediaInspectorStderrState -Path $stderrPath) -cne 'invalid') {
    throw 'Native picker stderr regression accepted oversized inspector output'
  }
  [IO.File]::WriteAllText(
    $stderrPath,
    "failure`nC:\Users\runner\secret.mp4`nhttps://localhost/file?token=secret",
    [Text.UTF8Encoding]::new($false)
  )

  $primaryPhaseRoot = Join-Path $testRoot 'primary-precedence-phases'
  [void][IO.Directory]::CreateDirectory($primaryPhaseRoot)
  foreach ($phaseName in @('starting', 'connected')) {
    [IO.File]::WriteAllText(
      (Join-Path $primaryPhaseRoot "osg-installed-native-picker-$phaseName.json"),
      (@{ schemaVersion = 1; stage = $phaseName } | ConvertTo-Json -Compress),
      [Text.UTF8Encoding]::new($false)
    )
  }
  $primaryFailure = & {
    param($Sources, $Root, $ErrorPath, $ApplicationProcessId)

    Invoke-Expression $Sources['Get-NativePickerInspectorPhase']
    Invoke-Expression $Sources['Get-NativePickerPreclickFailureCode']
    Invoke-Expression $Sources['Get-InstalledLocalMediaInspectorStderrState']
    Invoke-Expression $Sources['Wait-NativePickerClickIssued']
    function Set-NativePickerEvidence {
      param($Stage, $Outcome, $FailureCode, $Metrics)
      if ($Outcome -ceq 'failed') {
        throw 'secondary evidence write failure'
      }
    }
    $inspector = [pscustomobject]@{ HasExited = $true; ExitCode = 1 }
    $inspector | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    $inspector | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($milliseconds) $true }
    try {
      Wait-NativePickerClickIssued `
        -Inspector $inspector `
        -ApplicationProcessId $ApplicationProcessId `
        -PhaseRoot $Root `
        -StderrPath $ErrorPath
    } catch {
      $_.Exception.Message
    }
  } $installedFunctionSources $primaryPhaseRoot $stderrPath $PID
  if ($primaryFailure -cne 'Installed local-media inspector exited at a bounded pre-click phase (inspector-tab-activation-exited)') {
    throw 'Native picker stderr regression replaced the primary fixed pre-click failure'
  }

  $localMediaFunction = $installedFunctionSources['Inspect-InstalledLocalMediaFlow']
  if ($localMediaFunction -match 'Get-Content\s+-LiteralPath\s+\$stderr' `
      -or $localMediaFunction -match '\$errors\s+-join' `
      -or $localMediaFunction -notmatch 'Get-InstalledLocalMediaInspectorStderrState' `
      -or $localMediaFunction -notmatch 'Installed local-media inspection failed after the native picker click') {
    throw 'Native picker stderr regression reintroduced arbitrary inspector output disclosure'
  }

  $postDialogRoot = Join-Path $testRoot 'post-dialog-primary-precedence'
  [void][IO.Directory]::CreateDirectory($postDialogRoot)
  $postDialogMediaPath = Join-Path $postDialogRoot 'fixture.mp4'
  [IO.File]::WriteAllBytes($postDialogMediaPath, [byte[]]@(0))
  $priorRunnerTemp = $env:RUNNER_TEMP
  $script:postDialogRegressionState = [ordered]@{
    failedAttempts = 0
    succeededAttempts = 0
    runningDialogDismissed = $false
  }
  try {
    $env:RUNNER_TEMP = $postDialogRoot
    $postDialogFailure = & {
      param($InspectSource, $MediaPath)

      Invoke-Expression $InspectSource
      function Get-Process {
        param($Id, $ErrorAction)
        $application = [pscustomobject]@{
          MainWindowHandle = [IntPtr]::new(1)
          Responding = $true
        }
        $application | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
        $application
      }
      function Get-DiagnosticBaselineSnapshot {
        param($LogPath)
        [pscustomobject]@{ Sha256 = ('a' * 64); Length = 1 }
      }
      function Start-Process {
        param(
          $FilePath,
          $ArgumentList,
          $RedirectStandardOutput,
          $RedirectStandardError,
          [switch]$PassThru
        )
        [IO.File]::WriteAllText($RedirectStandardOutput, '', [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($RedirectStandardError, 'fixed node failure', [Text.UTF8Encoding]::new($false))
        $inspector = [pscustomobject]@{ HasExited = $true; ExitCode = 1 }
        $inspector | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
        $inspector | Add-Member `
          -MemberType ScriptMethod `
          -Name WaitForExit `
          -Value {
            param($milliseconds)
            if ($null -ne $milliseconds) { $true }
          }
        $inspector
      }
      function Initialize-NativePickerEvidence {}
      function Wait-NativePickerClickIssued {
        param($Inspector, $ApplicationProcessId, $PhaseRoot, $StderrPath)
      }
      function Complete-NativeMediaPicker {
        param(
          $ProcessId,
          $OwnerHandle,
          $MediaPath,
          $LogPath,
          $DiagnosticBaselineSha256,
          $DiagnosticBaselineLength,
          $AppInstanceId
        )
        $script:postDialogRegressionState.runningDialogDismissed = $true
        [pscustomobject]@{ DismissAttempts = 2; DialogDismissed = $true }
      }
      function Get-InstalledLocalMediaInspectorStderrState {
        param($Path)
        'nonempty'
      }
      function Set-NativePickerEvidence {
        param($Stage, $Outcome, $FailureCode, $Metrics)
        if ($Outcome -ceq 'failed') {
          $script:postDialogRegressionState.failedAttempts += 1
          throw 'secondary corrective evidence failure'
        }
        if ($Outcome -ceq 'succeeded') {
          $script:postDialogRegressionState.succeededAttempts += 1
        }
      }
      try {
        Inspect-InstalledLocalMediaFlow `
          -Port 43123 `
          -ProcessId $PID `
          -MediaPath $MediaPath `
          -LogPath (Join-Path $env:RUNNER_TEMP 'osg.log') `
          -AppInstanceId '019ff572-2132-7ba1-9e9c-5a29894963bf' `
          -PriorAssetId '019ff572-2132-7ba1-9e9c-5a29894963be'
      } catch {
        $_
      }
    } $installedFunctionSources['Inspect-InstalledLocalMediaFlow'] $postDialogMediaPath
  } finally {
    $env:RUNNER_TEMP = $priorRunnerTemp
  }
  if ($postDialogFailure -isnot [System.Management.Automation.ErrorRecord] `
      -or $postDialogFailure.Exception.Message `
        -cne 'Installed local-media inspection failed after the native picker click' `
      -or $postDialogFailure.Exception.Message -ceq 'secondary corrective evidence failure' `
      -or -not $script:postDialogRegressionState.runningDialogDismissed `
      -or $script:postDialogRegressionState.failedAttempts -ne 1 `
      -or $script:postDialogRegressionState.succeededAttempts -ne 0) {
    throw 'Native picker post-dialog regression replaced the primary ErrorRecord or retained succeeded evidence'
  }
  $diagnosticLogLimitBytes = 4 * 1024 * 1024
  $diagnosticEntrySlackBytes = 64 * 1024
  $diagnosticPath = Join-Path $testRoot 'diagnostic-snapshot.log'
  $diagnosticAppInstanceId = '019ff572-2132-7ba1-9e9c-5a29894963bf'
  $baselineLine = '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"app.ready","timestampMs":"1"}'
  [IO.File]::WriteAllText(
    $diagnosticPath,
    $baselineLine + "`n",
    [Text.UTF8Encoding]::new($false)
  )
  $diagnosticBaseline = Get-DiagnosticBaselineSnapshot -LogPath $diagnosticPath
  $script:diagnosticRereadAttempts = 0
  function Read-DiagnosticEvents {
    param([Parameter(Mandatory = $true)][string]$LogPath)

    $script:diagnosticRereadAttempts += 1
    $swapped = @(
      '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963be","event":"swapped","timestampMs":"2"}',
      '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.requested","timestampMs":"3"}',
      '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.worker-started","timestampMs":"4"}',
      '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.returned","outcome":"selected","timestampMs":"5"}'
    ) -join "`n"
    [IO.File]::WriteAllText($LogPath, $swapped + "`n", [Text.UTF8Encoding]::new($false))
    @(Get-Content -LiteralPath $LogPath | ForEach-Object { $_ | ConvertFrom-Json })
  }
  $emptyOutcome = Get-NativePickerDiagnosticOutcome `
    -LogPath $diagnosticPath `
    -BaselineSha256 $diagnosticBaseline.Sha256 `
    -BaselineLength $diagnosticBaseline.Length `
    -AppInstanceId $diagnosticAppInstanceId
  if ($emptyOutcome -cne 'command-dispatch-timeout' `
      -or $script:diagnosticRereadAttempts -ne 0 `
      -or [IO.File]::ReadAllText($diagnosticPath) -cne ($baselineLine + "`n")) {
    throw 'Native picker diagnostic regression accepted a swapped post-verification path'
  }
  [IO.File]::AppendAllText(
    $diagnosticPath,
    '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.requested","timestampMs":"3"}' + "`n" `
      + '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.worker-started","timestampMs":"4"}' + "`n" `
      + '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.returned","outcome":"selected","timestampMs":"5"}' + "`n",
    [Text.UTF8Encoding]::new($false)
  )
  $selectedOutcome = Get-NativePickerDiagnosticOutcome `
    -LogPath $diagnosticPath `
    -BaselineSha256 $diagnosticBaseline.Sha256 `
    -BaselineLength $diagnosticBaseline.Length `
    -AppInstanceId $diagnosticAppInstanceId
  if ($selectedOutcome -cne 'selected' -or $script:diagnosticRereadAttempts -ne 0) {
    throw 'Native picker diagnostic regression rejected one immutable selected snapshot'
  }
  [IO.File]::WriteAllText(
    $diagnosticPath,
    $baselineLine + "`n" `
      + '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.requested","timestampMs":"3"}' + "`n",
    [Text.UTF8Encoding]::new($false)
  )
  $workerDispatchOutcome = Get-NativePickerDiagnosticOutcome `
    -LogPath $diagnosticPath `
    -BaselineSha256 $diagnosticBaseline.Sha256 `
    -BaselineLength $diagnosticBaseline.Length `
    -AppInstanceId $diagnosticAppInstanceId
  if ($workerDispatchOutcome -cne 'blocking-pool-dispatch-timeout') {
    throw 'Native picker diagnostic regression merged command and blocking-pool dispatch stalls'
  }
  [IO.File]::AppendAllText(
    $diagnosticPath,
    '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.worker-started","timestampMs":"4"}' + "`n",
    [Text.UTF8Encoding]::new($false)
  )
  $dialogTimeoutOutcome = Get-NativePickerDiagnosticOutcome `
    -LogPath $diagnosticPath `
    -BaselineSha256 $diagnosticBaseline.Sha256 `
    -BaselineLength $diagnosticBaseline.Length `
    -AppInstanceId $diagnosticAppInstanceId
  if ($dialogTimeoutOutcome -cne 'dialog-timeout') {
    throw 'Native picker diagnostic regression rejected a started blocking dialog stall'
  }
  [IO.File]::AppendAllText(
    $diagnosticPath,
    '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.worker-failed","timestampMs":"5"}' + "`n",
    [Text.UTF8Encoding]::new($false)
  )
  $workerFailedOutcome = Get-NativePickerDiagnosticOutcome `
    -LogPath $diagnosticPath `
    -BaselineSha256 $diagnosticBaseline.Sha256 `
    -BaselineLength $diagnosticBaseline.Length `
    -AppInstanceId $diagnosticAppInstanceId
  if ($workerFailedOutcome -cne 'worker-failed') {
    throw 'Native picker diagnostic regression rejected an exact path-free worker failure'
  }
  [IO.File]::WriteAllText(
    $diagnosticPath,
    $baselineLine + "`n" `
      + '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.requested","timestampMs":"3"}' + "`n" `
      + '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.worker-started","timestampMs":"4"}' + "`n" `
      + '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.returned","outcome":"none","timestampMs":"5"}' + "`n",
    [Text.UTF8Encoding]::new($false)
  )
  $noneOutcome = Get-NativePickerDiagnosticOutcome `
    -LogPath $diagnosticPath `
    -BaselineSha256 $diagnosticBaseline.Sha256 `
    -BaselineLength $diagnosticBaseline.Length `
    -AppInstanceId $diagnosticAppInstanceId
  if ($noneOutcome -cne 'backend-returned-none') {
    throw 'Native picker diagnostic regression rejected an exact none transaction'
  }
  [IO.File]::WriteAllText(
    $diagnosticPath,
    $baselineLine + "`n" `
      + '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.requested","timestampMs":"3"}' + "`n" `
      + '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.worker-started","path":"private","timestampMs":"4"}' + "`n",
    [Text.UTF8Encoding]::new($false)
  )
  $hostileWorkerOutcome = Get-NativePickerDiagnosticOutcome `
    -LogPath $diagnosticPath `
    -BaselineSha256 $diagnosticBaseline.Sha256 `
    -BaselineLength $diagnosticBaseline.Length `
    -AppInstanceId $diagnosticAppInstanceId
  if ($hostileWorkerOutcome -cne 'diagnostic-ambiguous') {
    throw 'Native picker diagnostic regression accepted a path-bearing worker event'
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
    diagnosticSnapshotIsolated = $true
    pickerWorkerBoundarySplit = $true
    rawCensusSchemaRedacted = $true
    rawCensusBucketsIndependent = $true
    rawCensusMaximaBounded = $true
    rawCensusDiagnosticOnly = $true
    nativeCandidatePredicateExact = $true
    nativeCandidateAuthorityPinned = $true
    nativeCandidateSchemaEphemeral = $true
    nativeCandidateBridgeRevalidated = $true
    nativeCandidateDiagnosticsDecoupled = $true
    nativeCandidateProbeFailuresClosed = $true
    nativeCandidateHandlesNormalized = $true
    orderedActivationPhases = $true
    fixedPreclickCategories = $true
    hostileStderrRedacted = $true
    primaryFailurePreserved = $true
    postDialogFailurePreserved = $true
    failedRunNeverSucceeded = $true
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
