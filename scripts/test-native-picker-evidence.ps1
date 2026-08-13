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
      processWindowMatches = 3
      processDialogMatches = 2
      processNamedMatches = 1
      ownedDialogMatches = 1
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
      -or $payload.processWindowMatches -ne 3 `
      -or $payload.processDialogMatches -ne 2 `
      -or $payload.processNamedMatches -ne 1 `
      -or $payload.ownedDialogMatches -ne 1 `
      -or -not $invalidInspectorPhaseRejected `
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
      'Get-DiagnosticBaselineSnapshot',
      'Get-NativePickerDiagnosticOutcome',
      'Get-NativePickerInspectorPhase',
      'Get-NativePickerPreclickFailureCode',
      'Get-InstalledLocalMediaInspectorStderrState',
      'Wait-NativePickerClickIssued',
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
      '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.returned","outcome":"selected","timestampMs":"4"}'
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
      + '{"appInstanceId":"019ff572-2132-7ba1-9e9c-5a29894963bf","event":"media-picker.returned","outcome":"selected","timestampMs":"4"}' + "`n",
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
