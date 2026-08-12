param(
  [Parameter(Mandatory = $true)]
  [string]$InstalledResultPath,

  [Parameter(Mandatory = $true)]
  [string]$FixtureRoot,

  [Parameter(Mandatory = $true)]
  [string]$BaseVersion,

  [Parameter(Mandatory = $true)]
  [string]$UpdatedVersion
)

$ErrorActionPreference = 'Stop'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\One-Click Subtitles Generator'
$server = $null
$certificate = $null
$certificateKey = $null
$baseProcess = $null
$updatedProcess = $null
$verificationProcess = $null
$baseInstanceId = $null
$updatedInstanceId = $null
$verificationInstanceId = $null
$primaryFailure = $null
$finalizationFailure = $null
$smokeStartedAt = Get-Date
$diagnosticLog = Join-Path ([IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA 'io.github.nganlinh4.oneclicksubtitles')
)) 'logs\osg.log'
$diagnosticEvidence = Join-Path $env:RUNNER_TEMP 'osg-updater-diagnostics.log'
$diagnosticEvidenceByteLimit = 128 * 1024
$closeEvidencePath = Join-Path $env:RUNNER_TEMP 'osg-updater-close-evidence.json'
$closeEvidenceTemporaryPath = Join-Path $env:RUNNER_TEMP 'osg-updater-close-evidence.tmp'
$closeEvidence = [ordered]@{
  schemaVersion = 1
  updaterRelaunch = $null
  verification = $null
}

function Write-SmokePhase {
  param([Parameter(Mandatory = $true)][string]$Name)

  $elapsedMilliseconds = [Math]::Round(((Get-Date) - $script:smokeStartedAt).TotalMilliseconds)
  Write-Host "signed-updater.phase name=$Name elapsedMs=$elapsedMilliseconds"
}

if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true' `
    -or $env:OSG_ENABLE_SIGNED_UPDATER_FIXTURE -ne '1') {
  throw 'The signed updater smoke may run only in its isolated GitHub Actions job'
}
if ($BaseVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' `
    -or $UpdatedVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' `
    -or $BaseVersion -eq $UpdatedVersion) {
  throw 'Signed updater smoke versions are invalid'
}

$runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
$resultPath = [IO.Path]::GetFullPath($InstalledResultPath)
$fixture = [IO.Path]::GetFullPath($FixtureRoot)
foreach ($candidate in @($resultPath, ($fixture.TrimEnd('\') + '\'))) {
  if (-not $candidate.StartsWith($runnerTemp, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Signed updater smoke inputs must stay inside RUNNER_TEMP'
  }
}
if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf) `
    -or -not (Test-Path -LiteralPath $fixture -PathType Container)) {
  throw 'Signed updater smoke inputs are missing'
}

$installedResult = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
$projectId = [string]$installedResult.firstLaunchWebView.persistence.projectId
if ($projectId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
  throw 'Installed lifecycle result did not contain its UUIDv7 project ID'
}

function Get-FreeLoopbackPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Invoke-UpdaterInspection {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Mode,
    [string]$EvidenceName = $Mode
  )

  $validEvidenceName = ($Mode -eq 'trigger' -and $EvidenceName -eq 'trigger') `
    -or ($Mode -eq 'verify' -and $EvidenceName -in @('relaunch-verify', 'verify'))
  if (-not $validEvidenceName) {
    throw 'Updater inspection evidence name is invalid for its mode'
  }
  $screenshot = Join-Path $env:RUNNER_TEMP "osg-updater-$EvidenceName.png"
  if (Test-Path -LiteralPath $screenshot) {
    throw "Updater $Mode screenshot path was not clean"
  }
  $output = @(& node 'scripts/inspect-installed-updater.mjs' `
    '--port' $Port `
    '--mode' $Mode `
    '--base-version' $BaseVersion `
    '--updated-version' $UpdatedVersion `
    '--project-id' $projectId `
    '--screenshot' $screenshot 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Updater $Mode inspection failed: $($output -join ' ')"
  }
  if ($output.Count -ne 1) {
    throw "Updater $Mode inspection returned an unexpected output shape"
  }
  if (-not (Test-Path -LiteralPath $screenshot -PathType Leaf)) {
    throw "Updater $Mode screenshot was not written"
  }
  $output[0] | ConvertFrom-Json
}

function Get-BoundedProcessTreeSnapshot {
  param([Parameter(Mandatory = $true)]$Process)

  $snapshot = [ordered]@{
    available = $false
    processAlive = $false
    responding = $false
    mainWindowPresent = $false
    parentAlive = $false
    descendantCount = 0
    webViewDescendantCount = 0
  }
  try {
    $Process.Refresh()
    $snapshot.processAlive = -not $Process.HasExited
    if (-not $Process.HasExited) {
      $snapshot.responding = $Process.Responding
      $snapshot.mainWindowPresent = $Process.MainWindowHandle -ne [IntPtr]::Zero
    }
    $processes = @(Get-CimInstance Win32_Process -OperationTimeoutSec 3 -ErrorAction Stop |
      Select-Object ProcessId, ParentProcessId, Name)
    $root = $processes | Where-Object ProcessId -eq $Process.Id | Select-Object -First 1
    if ($null -eq $root) {
      return [pscustomobject]$snapshot
    }
    $snapshot.available = $true
    $snapshot.parentAlive = @(
      $processes | Where-Object ProcessId -eq $root.ParentProcessId
    ).Count -eq 1
    $descendantIds = [Collections.Generic.HashSet[int]]::new()
    $frontier = @([int]$Process.Id)
    while ($frontier.Count -gt 0) {
      $next = @()
      foreach ($parentId in $frontier) {
        foreach ($child in @($processes | Where-Object ParentProcessId -eq $parentId)) {
          $childId = [int]$child.ProcessId
          if ($descendantIds.Add($childId)) {
            $next += $childId
          }
        }
      }
      $frontier = $next
    }
    $descendants = @($processes | Where-Object { $descendantIds.Contains([int]$_.ProcessId) })
    $snapshot.descendantCount = $descendants.Count
    $snapshot.webViewDescendantCount = @(
      $descendants | Where-Object Name -ieq 'msedgewebview2.exe'
    ).Count
  } catch {
    # Process-tree evidence is supplemental. The native window and diagnostic gates remain fatal.
  }
  [pscustomobject]$snapshot
}

function Test-MainWindowStable {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][IntPtr]$ExpectedHandle
  )

  try {
    $Process.Refresh()
    -not $Process.HasExited `
      -and $Process.MainWindowHandle -eq $ExpectedHandle `
      -and $Process.MainWindowHandle -ne [IntPtr]::Zero
  } catch {
    $false
  }
}

function Get-BoundedEvidenceDelta {
  param([Parameter(Mandatory = $true)][int]$Delta)

  [Math]::Max(-512, [Math]::Min(512, $Delta))
}

function Write-CloseEvidenceDocument {
  $encoded = $script:closeEvidence | ConvertTo-Json -Depth 6 -Compress
  if ([Text.Encoding]::UTF8.GetByteCount($encoded) -gt 4096) {
    throw 'Signed updater close evidence exceeded its 4096-byte bound'
  }
  [IO.File]::WriteAllText(
    $script:closeEvidenceTemporaryPath,
    $encoded,
    [Text.UTF8Encoding]::new($false)
  )
  [IO.File]::Move(
    $script:closeEvidenceTemporaryPath,
    $script:closeEvidencePath,
    $true
  )
}

function Write-CloseEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Phase,
    [Parameter(Mandatory = $true)][string]$AppInstanceId,
    [Parameter(Mandatory = $true)][string]$Outcome,
    [Parameter(Mandatory = $true)][bool]$CloseAccepted,
    [Parameter(Mandatory = $true)][int]$CloseEventDelta,
    [Parameter(Mandatory = $true)][int]$ExitRequestedEventDelta,
    [Parameter(Mandatory = $true)][int]$ExitEventDelta,
    [Parameter(Mandatory = $true)][bool]$CleanExit,
    [AllowNull()]$MainWindowStable,
    [AllowNull()]$ProcessTree
  )

  if ($Phase -notin @('updater-relaunched', 'verification') `
      -or $AppInstanceId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' `
      -or $Outcome -notin @('request-rejected', 'exit-timeout', 'exited')) {
    throw 'Signed updater close evidence escaped its bounded schema'
  }
  $diagnosticDeltasUnclamped = $CloseEventDelta -in -512..512 `
    -and $ExitRequestedEventDelta -in -512..512 `
    -and $ExitEventDelta -in -512..512
  $diagnosticLifecycleExact = $CloseEventDelta -eq 1 `
    -and $ExitRequestedEventDelta -eq 1 `
    -and $ExitEventDelta -eq 1
  $record = [ordered]@{
    phase = $Phase
    appInstanceId = $AppInstanceId
    outcome = $Outcome
    closeAccepted = $CloseAccepted
    closeEventDelta = Get-BoundedEvidenceDelta -Delta $CloseEventDelta
    exitRequestedEventDelta = Get-BoundedEvidenceDelta -Delta $ExitRequestedEventDelta
    exitEventDelta = Get-BoundedEvidenceDelta -Delta $ExitEventDelta
    diagnosticDeltasUnclamped = $diagnosticDeltasUnclamped
    diagnosticLifecycleExact = $diagnosticLifecycleExact
    cleanExit = $CleanExit
    mainWindowStable = $MainWindowStable
    processTree = $ProcessTree
  }
  $slot = if ($Phase -eq 'updater-relaunched') { 'updaterRelaunch' } else { 'verification' }
  if ($null -ne $script:closeEvidence[$slot]) {
    throw 'Signed updater close evidence already contains this phase'
  }
  $script:closeEvidence[$slot] = $record
  Write-CloseEvidenceDocument
  Write-Host "signed-updater.close $($record | ConvertTo-Json -Depth 4 -Compress)"
  [pscustomobject]$record
}

function Add-CloseEvidenceProcessTree {
  param(
    [Parameter(Mandatory = $true)][string]$Phase,
    [Parameter(Mandatory = $true)]$ProcessTree
  )

  $slot = if ($Phase -eq 'updater-relaunched') { 'updaterRelaunch' } else { 'verification' }
  $record = $script:closeEvidence[$slot]
  if ($Phase -notin @('updater-relaunched', 'verification') `
      -or $null -eq $record `
      -or $null -ne $record.processTree) {
    throw 'Signed updater close evidence cannot accept process-tree enrichment'
  }
  $record.processTree = $ProcessTree
  Write-CloseEvidenceDocument
}

function Stop-Gracefully {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$AppInstanceId,
    [Parameter(Mandatory = $true)][string]$Phase
  )

  $Process.Refresh()
  if ($Process.HasExited) {
    throw 'Application exited before the graceful close request'
  }
  if ($Process.MainWindowHandle -eq [IntPtr]::Zero -or -not $Process.Responding) {
    throw 'Application was not ready for a graceful close'
  }
  $closeEventsBefore = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.close_requested'
  $exitRequestedEventsBefore = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.exit_requested'
  $exitEventsBefore = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.exit'
  $mainWindowBefore = $Process.MainWindowHandle
  $closeAccepted = $Process.CloseMainWindow()
  if (-not $closeAccepted) {
    $closeEventsAfter = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.close_requested'
    $exitRequestedEventsAfter = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.exit_requested'
    $exitEventsAfter = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.exit'
    $mainWindowStable = Test-MainWindowStable `
      -Process $Process `
      -ExpectedHandle $mainWindowBefore
    Write-CloseEvidence `
      -Phase $Phase `
      -AppInstanceId $AppInstanceId `
      -Outcome 'request-rejected' `
      -CloseAccepted $false `
      -CloseEventDelta ($closeEventsAfter - $closeEventsBefore) `
      -ExitRequestedEventDelta ($exitRequestedEventsAfter - $exitRequestedEventsBefore) `
      -ExitEventDelta ($exitEventsAfter - $exitEventsBefore) `
      -CleanExit $false `
      -MainWindowStable $mainWindowStable `
      -ProcessTree $null | Out-Null
    try {
      $processTree = Get-BoundedProcessTreeSnapshot -Process $Process
      Add-CloseEvidenceProcessTree -Phase $Phase -ProcessTree $processTree
    } catch {
      # The core native close evidence is already durable; enrichment is strictly best-effort.
    }
    Stop-Process -Id $Process.Id -ErrorAction SilentlyContinue
    throw "$Phase application rejected a graceful close request"
  }
  if (-not $Process.WaitForExit(30000)) {
    $closeEventsAfter = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.close_requested'
    $exitRequestedEventsAfter = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.exit_requested'
    $exitEventsAfter = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.exit'
    $mainWindowStable = Test-MainWindowStable `
      -Process $Process `
      -ExpectedHandle $mainWindowBefore
    Write-CloseEvidence `
      -Phase $Phase `
      -AppInstanceId $AppInstanceId `
      -Outcome 'exit-timeout' `
      -CloseAccepted $true `
      -CloseEventDelta ($closeEventsAfter - $closeEventsBefore) `
      -ExitRequestedEventDelta ($exitRequestedEventsAfter - $exitRequestedEventsBefore) `
      -ExitEventDelta ($exitEventsAfter - $exitEventsBefore) `
      -CleanExit $false `
      -MainWindowStable $mainWindowStable `
      -ProcessTree $null | Out-Null
    try {
      $processTree = Get-BoundedProcessTreeSnapshot -Process $Process
      Add-CloseEvidenceProcessTree -Phase $Phase -ProcessTree $processTree
    } catch {
      # The core native close evidence is already durable; enrichment is strictly best-effort.
    }
    Stop-Process -Id $Process.Id -ErrorAction SilentlyContinue
    throw "$Phase application did not exit within 30 seconds of an accepted graceful close request"
  }
  $closeEventsAfter = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.close_requested'
  $exitRequestedEventsAfter = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.exit_requested'
  $exitEventsAfter = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.exit'
  $cleanExit = $Process.ExitCode -eq 0
  $closeRecord = Write-CloseEvidence `
    -Phase $Phase `
    -AppInstanceId $AppInstanceId `
    -Outcome 'exited' `
    -CloseAccepted $true `
    -CloseEventDelta ($closeEventsAfter - $closeEventsBefore) `
    -ExitRequestedEventDelta ($exitRequestedEventsAfter - $exitRequestedEventsBefore) `
    -ExitEventDelta ($exitEventsAfter - $exitEventsBefore) `
    -CleanExit $cleanExit `
    -MainWindowStable $null `
    -ProcessTree $null
  if (-not $cleanExit) {
    throw "Application exited with code $($Process.ExitCode) after the graceful close request"
  }
  if ($closeEventsAfter -ne ($closeEventsBefore + 1)) {
    throw 'Application did not flush exactly one graceful-close diagnostic'
  }
  if ($exitRequestedEventsAfter -ne ($exitRequestedEventsBefore + 1) `
      -or $exitEventsAfter -ne ($exitEventsBefore + 1)) {
    throw 'Application did not traverse exactly one requested-exit and exit diagnostic'
  }
  $closeRecord
}

function Read-DiagnosticEvents {
  param([switch]$IncludePrevious)

  $directory = Split-Path -Parent $diagnosticLog
  $paths = @($diagnosticLog)
  if ($IncludePrevious) {
    $paths = @((Join-Path $directory 'osg.previous.log')) + $paths
  }
  $events = @()
  foreach ($path in $paths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      continue
    }
    $length = (Get-Item -LiteralPath $path).Length
    if ($length -gt (8 * 1024 * 1024)) {
      throw 'Signed updater diagnostic input exceeded its 8 MiB per-file bound'
    }
    foreach ($line in @(Get-Content -LiteralPath $path | Where-Object { $_.Length -gt 0 })) {
      try {
        $entry = $line | ConvertFrom-Json
        if ([string]$entry.timestampMs -match '^\d{1,20}$' `
            -and [string]$entry.event -match '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') {
          $events += $entry
        }
      } catch {
        # The active process may be flushing one final bounded JSON line.
      }
    }
  }
  @($events)
}

function ConvertTo-BoundedDiagnosticEvidenceRecord {
  param([Parameter(Mandatory = $true)]$Entry)

  $version = [string]$Entry.version
  $webviewDebug = [string]$Entry.webviewDebug
  $outcome = [string]$Entry.outcome
  $reason = [string]$Entry.reason
  $phase = [string]$Entry.phase
  [pscustomobject][ordered]@{
    timestampMs = if ([string]$Entry.timestampMs -match '^\d{1,20}$') {
      [string]$Entry.timestampMs
    } else {
      'invalid'
    }
    event = [string]$Entry.event
    appInstanceId = if ([string]$Entry.appInstanceId -match '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
      [string]$Entry.appInstanceId
    } else {
      'invalid'
    }
    version = if ([string]::IsNullOrEmpty($version)) {
      $null
    } elseif ($version.Length -le 64 `
        -and $version -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
      $version
    } else {
      'invalid'
    }
    webviewDebug = if ([string]$Entry.event -notin @('app.environment', 'app-update.handoff')) {
      $null
    } elseif ($webviewDebug -in @('present', 'absent')) {
      $webviewDebug
    } else {
      'unknown'
    }
    outcome = if ([string]::IsNullOrEmpty($outcome)) {
      $null
    } elseif ($outcome -in @('available', 'current', 'error', 'unconfigured')) {
      $outcome
    } else {
      'unknown'
    }
    reason = if ([string]::IsNullOrEmpty($reason)) {
      $null
    } elseif ($reason -in @('transport-or-signature', 'extract-or-launch', 'user', 'protocol')) {
      $reason
    } else {
      'unknown'
    }
    phase = if ([string]::IsNullOrEmpty($phase)) {
      $null
    } elseif ($phase -eq 'download') {
      $phase
    } else {
      'unknown'
    }
  }
}

function Write-BoundedDiagnosticEvidence {
  $evidenceLines = @(
    Read-DiagnosticEvents -IncludePrevious |
      Where-Object {
        [string]$_.event -like 'app-update.*' `
          -or [string]$_.event -in @(
            'app.environment',
            'app.ready',
            'app.page_load_finished',
            'app.close_requested',
            'app.exit_requested',
            'app.exit'
          )
      } |
      Select-Object -Last 256 |
      ForEach-Object {
        $boundedRecord = ConvertTo-BoundedDiagnosticEvidenceRecord -Entry $_
        $boundedRecord | ConvertTo-Json -Compress
      }
  )
  $encoded = if ($evidenceLines.Count -eq 0) {
    ''
  } else {
    [string]::Join([Environment]::NewLine, $evidenceLines) + [Environment]::NewLine
  }
  if ([Text.Encoding]::UTF8.GetByteCount($encoded) -gt $script:diagnosticEvidenceByteLimit) {
    throw 'Signed updater diagnostic evidence exceeded its 128 KiB output bound'
  }
  [IO.File]::WriteAllText(
    $script:diagnosticEvidence,
    $encoded,
    [Text.UTF8Encoding]::new($false)
  )
}

function Invoke-UpdaterFinalizationStep {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )

  try {
    & $Action
  } catch {
    if ($null -eq $script:finalizationFailure) {
      $script:finalizationFailure = $_
    }
    Write-Host "signed-updater.finalization-warning step=$Name" -ErrorAction SilentlyContinue
  }
}

function Get-DiagnosticEvents {
  param(
    [Parameter(Mandatory = $true)][string]$AppInstanceId,
    [string]$Name
  )

  if ($AppInstanceId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'Signed updater application instance ID is invalid'
  }
  $events = @(Read-DiagnosticEvents | Where-Object appInstanceId -eq $AppInstanceId)
  if (-not [string]::IsNullOrEmpty($Name)) {
    $events = @($events | Where-Object event -eq $Name)
  }
  @($events)
}

function Get-DiagnosticEventCount {
  param(
    [Parameter(Mandatory = $true)][string]$AppInstanceId,
    [Parameter(Mandatory = $true)][string]$Name
  )

  @(Get-DiagnosticEvents -AppInstanceId $AppInstanceId -Name $Name).Count
}

function Get-KnownApplicationInstanceIds {
  @(
    Read-DiagnosticEvents -IncludePrevious |
      Where-Object appInstanceId -match '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' |
      ForEach-Object { [string]$_.appInstanceId } |
      Sort-Object -Unique
  )
}

function Wait-ForApplicationInstance {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][array]$ExcludedInstanceIds,
    [Parameter(Mandatory = $true)][string]$Phase
  )

  $deadline = (Get-Date).AddMinutes(2)
  do {
    Start-Sleep -Milliseconds 200
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "$Phase application exited before publishing its diagnostic identity"
    }
    $candidateEvents = @(
      Read-DiagnosticEvents |
        Where-Object {
          $_.event -eq 'app.environment' `
            -and $_.version -ceq $ExpectedVersion `
            -and [string]$_.webviewDebug -in @('present', 'absent') `
            -and [string]$_.appInstanceId -match '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' `
            -and [string]$_.appInstanceId -notin $ExcludedInstanceIds
        }
    )
    $candidateInstanceIds = @(
      $candidateEvents |
        ForEach-Object { [string]$_.appInstanceId } |
        Sort-Object -Unique
    )
    if ($candidateInstanceIds.Count -gt 1) {
      throw "$Phase application published more than one new diagnostic identity"
    }
    if ($candidateInstanceIds.Count -eq 1) {
      $candidate = $candidateEvents | Select-Object -First 1
      $webviewDebugEvidence = switch ([string]$candidate.webviewDebug) {
        'present' { 'present' }
        'absent' { 'absent' }
        default { 'unknown' }
      }
      Write-Host "signed-updater.identity phase=$Phase webviewDebug=$webviewDebugEvidence"
      return $candidateInstanceIds[0]
    }
  } while ((Get-Date) -lt $deadline)
  throw "$Phase application did not publish one new diagnostic identity within two minutes"
}

function Wait-ForSettledUpdaterChecks {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$AppInstanceId,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][int]$MinimumChecks,
    [Parameter(Mandatory = $true)][string]$Phase
  )

  $deadline = (Get-Date).AddMinutes(2)
  do {
    Start-Sleep -Milliseconds 200
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "$Phase application exited before its updater checks settled"
    }
    $started = @(Get-DiagnosticEvents -AppInstanceId $AppInstanceId -Name 'app-update.check_started')
    $completed = @(Get-DiagnosticEvents -AppInstanceId $AppInstanceId -Name 'app-update.check_completed')
    $invalid = @($started | Where-Object version -ne $ExpectedVersion)
    $invalid += @($completed | Where-Object {
      $_.version -ne $ExpectedVersion -or $_.outcome -ne 'current'
    })
    if ($invalid.Count -ne 0) {
      throw "$Phase application reported an invalid updater-check lifecycle"
    }
    if ($started.Count -ge $MinimumChecks -and $completed.Count -eq $started.Count) {
      return
    }
  } while ((Get-Date) -lt $deadline)
  throw "$Phase application updater checks did not settle within two minutes"
}

function Wait-ForReadyApplicationWindow {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$AppInstanceId,
    [Parameter(Mandatory = $true)][string]$Phase
  )

  $deadline = (Get-Date).AddMinutes(2)
  do {
    Start-Sleep -Milliseconds 200
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "$Phase application exited before its window became ready"
    }
    $readyEvents = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.ready'
    $pageLoadEvents = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.page_load_finished'
    $inputIdle = $false
    if ($Process.MainWindowHandle -ne [IntPtr]::Zero -and $Process.Responding) {
      try {
        $inputIdle = $Process.WaitForInputIdle(1000)
      } catch {
        $inputIdle = $false
      }
    }
    if ($readyEvents -eq 1 `
        -and $pageLoadEvents -ge 1 `
        -and $inputIdle) {
      return
    }
  } while ((Get-Date) -lt $deadline)
  throw "$Phase application did not expose a ready, responsive window within two minutes"
}

function Get-UpdaterFailurePhase {
  param([Parameter(Mandatory = $true)][string]$AppInstanceId)

  $allowed = @{
    'app-update.download_failed' = @('transport-or-signature')
    'app-update.install_failed' = @('extract-or-launch')
    'app-update.cancel_requested' = @('user', 'protocol')
  }
  foreach ($entry in @(Get-DiagnosticEvents -AppInstanceId $AppInstanceId)) {
    if ($allowed.ContainsKey([string]$entry.event) `
        -and [string]$entry.reason -in $allowed[[string]$entry.event]) {
      return "$($entry.event):$($entry.reason)"
    }
  }
  $null
}

$pfxPath = Join-Path $env:RUNNER_TEMP 'osg-updater-fixture.pfx'
$readyPath = Join-Path $env:RUNNER_TEMP 'osg-updater-fixture.ready.json'
$serverOutput = Join-Path $env:RUNNER_TEMP 'osg-updater-fixture.stdout.log'
$serverError = Join-Path $env:RUNNER_TEMP 'osg-updater-fixture.stderr.log'
foreach ($path in @(
  $pfxPath,
  $readyPath,
  $serverOutput,
  $serverError,
  $closeEvidencePath,
  $closeEvidenceTemporaryPath
)) {
  if (Test-Path -LiteralPath $path) {
    throw "Signed updater temporary path was not clean: $path"
  }
}
Write-CloseEvidenceDocument

try {
  Write-SmokePhase -Name 'fixture-certificate-started'
  $passwordBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  $pfxPassword = [Convert]::ToBase64String($passwordBytes)
  [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
  $certificateKey = [Security.Cryptography.RSA]::Create(2048)
  $certificateRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=localhost',
    $certificateKey,
    [Security.Cryptography.HashAlgorithmName]::SHA256,
    [Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $subjectAlternativeNames = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $subjectAlternativeNames.AddDnsName('localhost')
  $certificateRequest.CertificateExtensions.Add($subjectAlternativeNames.Build())
  $enhancedKeyUsages = [Security.Cryptography.OidCollection]::new()
  $enhancedKeyUsages.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
  $certificateRequest.CertificateExtensions.Add(
    [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new(
      $enhancedKeyUsages,
      $false
    )
  )
  $certificate = $certificateRequest.CreateSelfSigned(
    [DateTimeOffset]::UtcNow.AddMinutes(-1),
    [DateTimeOffset]::UtcNow.AddHours(2)
  )
  Write-SmokePhase -Name 'fixture-certificate-created'
  [IO.File]::WriteAllBytes(
    $pfxPath,
    $certificate.Export(
      [Security.Cryptography.X509Certificates.X509ContentType]::Pfx,
      $pfxPassword
    )
  )
  Write-SmokePhase -Name 'fixture-certificate-exported'

  $env:OSG_UPDATER_FIXTURE_PFX_PASSWORD = $pfxPassword
  $node = (Get-Command node -ErrorAction Stop).Source
  $server = Start-Process `
    -FilePath $node `
    -ArgumentList @(
      'scripts/serve-updater-fixture.mjs',
      '--root', $fixture,
      '--pfx', $pfxPath,
      '--ready-file', $readyPath
    ) `
    -RedirectStandardOutput $serverOutput `
    -RedirectStandardError $serverError `
    -WindowStyle Hidden `
    -PassThru
  Remove-Item Env:OSG_UPDATER_FIXTURE_PFX_PASSWORD -ErrorAction SilentlyContinue

  $serverDeadline = (Get-Date).AddSeconds(20)
  while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf) `
      -and -not $server.HasExited `
      -and (Get-Date) -lt $serverDeadline) {
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf) -or $server.HasExited) {
    $detail = if (Test-Path -LiteralPath $serverError) {
      (Get-Content -LiteralPath $serverError -Raw).Trim()
    } else {
      'no bounded server diagnostic'
    }
    throw "Signed updater fixture server did not become ready: $detail"
  }
  Write-SmokePhase -Name 'fixture-server-ready'

  $installed = Get-ItemProperty -LiteralPath $uninstallKey
  if ($installed.DisplayVersion -ne $BaseVersion) {
    throw "Updater base installation is $($installed.DisplayVersion), expected $BaseVersion"
  }
  $installRoot = [IO.Path]::GetFullPath($installed.InstallLocation.Trim('"'))
  $localAppData = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
  if (-not $installRoot.StartsWith($localAppData, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Updater installation escaped LOCALAPPDATA'
  }
  $executable = [IO.Path]::GetFullPath((Join-Path $installRoot 'osg-desktop.exe'))
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw 'Updater base executable is missing'
  }

  if (-not [string]::IsNullOrEmpty($env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS)) {
    throw 'Signed updater runner already has unreviewed WebView2 arguments'
  }
  $knownAppInstanceIds = @(Get-KnownApplicationInstanceIds)
  $debugPort = Get-FreeLoopbackPort
  try {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$debugPort"
    $baseProcess = Start-Process -FilePath $executable -PassThru
  } finally {
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  }
  Write-SmokePhase -Name 'base-application-launched'
  $baseInstanceId = Wait-ForApplicationInstance `
    -Process $baseProcess `
    -ExpectedVersion $BaseVersion `
    -ExcludedInstanceIds $knownAppInstanceIds `
    -Phase 'base'
  $knownAppInstanceIds += $baseInstanceId
  $trigger = Invoke-UpdaterInspection -Port $debugPort -Mode 'trigger'
  Write-SmokePhase -Name 'update-accepted'
  $exitDeadline = (Get-Date).AddMinutes(5)
  while (-not $baseProcess.HasExited -and (Get-Date) -lt $exitDeadline) {
    $failurePhase = Get-UpdaterFailurePhase -AppInstanceId $baseInstanceId
    if ($null -ne $failurePhase) {
      Stop-Process -Id $baseProcess.Id -ErrorAction SilentlyContinue
      throw "Base application reported a bounded updater failure: $failurePhase"
    }
    Start-Sleep -Milliseconds 500
    $baseProcess.Refresh()
  }
  if (-not $baseProcess.HasExited) {
    Stop-Process -Id $baseProcess.Id -ErrorAction SilentlyContinue
    throw 'Base application did not exit after the signed update was accepted'
  }
  if ($baseProcess.ExitCode -ne 0) {
    throw "Base application exited with code $($baseProcess.ExitCode) during update"
  }
  Write-SmokePhase -Name 'base-application-exited'

  $updateDeadline = (Get-Date).AddMinutes(3)
  $updatedRegistry = $null
  do {
    Start-Sleep -Milliseconds 500
    $updatedRegistry = Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction SilentlyContinue
  } until ($updatedRegistry.DisplayVersion -eq $UpdatedVersion -or (Get-Date) -ge $updateDeadline)
  if ($updatedRegistry.DisplayVersion -ne $UpdatedVersion) {
    throw 'Signed NSIS updater did not replace the installed application version'
  }
  Write-SmokePhase -Name 'updated-version-registered'

  do {
    $updatedCandidates = @(Get-Process -Name 'osg-desktop' -ErrorAction SilentlyContinue |
      Where-Object Id -ne $baseProcess.Id)
    if ($updatedCandidates.Count -eq 1) {
      $updatedProcess = $updatedCandidates[0]
      break
    }
    if ($updatedCandidates.Count -gt 1) {
      throw 'Signed updater launched more than one application process'
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $updateDeadline)
  if ($null -eq $updatedProcess) {
    throw 'Signed NSIS updater did not relaunch the application'
  }
  $updatedProcess.Refresh()
  if ($updatedProcess.HasExited) {
    throw 'Signed NSIS updater relaunched an application that exited immediately'
  }
  $updatedProcessPath = [IO.Path]::GetFullPath($updatedProcess.Path)
  if (-not $updatedProcessPath.Equals($executable, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Signed NSIS updater relaunched an unexpected executable'
  }
  Write-SmokePhase -Name 'updated-application-relaunched'
  $updatedInstanceId = Wait-ForApplicationInstance `
    -Process $updatedProcess `
    -ExpectedVersion $UpdatedVersion `
    -ExcludedInstanceIds $knownAppInstanceIds `
    -Phase 'updater-relaunched'
  $knownAppInstanceIds += $updatedInstanceId
  Wait-ForReadyApplicationWindow `
    -Process $updatedProcess `
    -AppInstanceId $updatedInstanceId `
    -Phase 'updater-relaunched'
  Write-SmokePhase -Name 'updated-application-ready'
  $relaunchFrontend = Invoke-UpdaterInspection `
    -Port $debugPort `
    -Mode 'verify' `
    -EvidenceName 'relaunch-verify'
  Wait-ForSettledUpdaterChecks `
    -Process $updatedProcess `
    -AppInstanceId $updatedInstanceId `
    -ExpectedVersion $UpdatedVersion `
    -MinimumChecks 2 `
    -Phase 'updater-relaunched'
  Write-SmokePhase -Name 'updated-frontend-ready'
  $updatedClose = Stop-Gracefully `
    -Process $updatedProcess `
    -AppInstanceId $updatedInstanceId `
    -Phase 'updater-relaunched'
  $updatedProcess = $null
  Write-SmokePhase -Name 'updated-application-closed'

  # The original WebView2 browser process may retain the first debugging port briefly after the
  # updater-driven relaunch. Inspect the already-updated installation on a fresh port instead of
  # treating that diagnostic-port lifetime as an application update failure.
  $verificationPort = Get-FreeLoopbackPort
  try {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$verificationPort"
    $verificationProcess = Start-Process -FilePath $executable -PassThru
  } finally {
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  }
  Write-SmokePhase -Name 'verification-application-launched'
  $verificationInstanceId = Wait-ForApplicationInstance `
    -Process $verificationProcess `
    -ExpectedVersion $UpdatedVersion `
    -ExcludedInstanceIds $knownAppInstanceIds `
    -Phase 'verification'
  $knownAppInstanceIds += $verificationInstanceId
  $verify = Invoke-UpdaterInspection -Port $verificationPort -Mode 'verify'
  Wait-ForSettledUpdaterChecks `
    -Process $verificationProcess `
    -AppInstanceId $verificationInstanceId `
    -ExpectedVersion $UpdatedVersion `
    -MinimumChecks 2 `
    -Phase 'verification'
  Write-SmokePhase -Name 'updated-state-verified'
  $verificationClose = Stop-Gracefully `
    -Process $verificationProcess `
    -AppInstanceId $verificationInstanceId `
    -Phase 'verification'
  $verificationProcess = $null
  Write-SmokePhase -Name 'verification-application-closed'

  if (-not $server.HasExited) {
    Stop-Process -Id $server.Id
    $server.WaitForExit()
  }
  $server = $null
  $requests = @(
    Get-Content -LiteralPath $serverOutput |
      Where-Object { $_.Length -gt 0 } |
      ForEach-Object { $_ | ConvertFrom-Json }
  )
  $manifestRequests = @($requests | Where-Object route -eq 'manifest')
  $updateRequests = @($requests | Where-Object route -eq 'update')
  $invalidRequests = @($requests | Where-Object {
    $_.event -ne 'updater-fixture.request' -or $_.method -notin @('GET', 'HEAD')
  })
  if ($manifestRequests.Count -lt 2 -or $updateRequests.Count -ne 1 `
      -or $invalidRequests.Count -ne 0) {
    throw 'Signed updater fixture observed an invalid bounded request sequence'
  }
  Write-SmokePhase -Name 'fixture-requests-verified'

  $events = @(Get-DiagnosticEvents -AppInstanceId $baseInstanceId)
  if (-not ($events | Where-Object {
      $_.event -eq 'app-update.checking' -and $_.version -eq $UpdatedVersion
    }) -or -not ($events | Where-Object {
      $_.event -eq 'app-update.installing' -and $_.version -eq $UpdatedVersion
    })) {
    throw 'Signed updater diagnostics omitted the checked and installed version'
  }
  Write-SmokePhase -Name 'diagnostics-verified'

  [pscustomobject]@{
    baseVersion = $BaseVersion
    updatedVersion = $UpdatedVersion
    projectId = $projectId
    manifestRequests = $manifestRequests.Count
    updateRequests = $updateRequests.Count
    trigger = $trigger
    relaunchFrontend = $relaunchFrontend
    verify = $verify
    closeProof = [ordered]@{
      updaterRelaunch = $updatedClose
      verification = $verificationClose
    }
    preservedSettingsProjectAndHistory = $true
    signedNsisRelaunch = $true
  } | ConvertTo-Json -Depth 5
} catch {
  $primaryFailure = $_
} finally {
  Invoke-UpdaterFinalizationStep -Name 'diagnostic-evidence' -Action {
    if (Test-Path -LiteralPath $diagnosticLog -PathType Leaf) {
      Write-BoundedDiagnosticEvidence
    }
  }
  Invoke-UpdaterFinalizationStep -Name 'fixture-password' -Action {
    Remove-Item Env:OSG_UPDATER_FIXTURE_PFX_PASSWORD -ErrorAction SilentlyContinue
  }
  Invoke-UpdaterFinalizationStep -Name 'updated-process' -Action {
    if ($null -ne $updatedProcess -and -not $updatedProcess.HasExited) {
      Stop-Process -Id $updatedProcess.Id -ErrorAction SilentlyContinue
    }
  }
  Invoke-UpdaterFinalizationStep -Name 'verification-process' -Action {
    if ($null -ne $verificationProcess -and -not $verificationProcess.HasExited) {
      Stop-Process -Id $verificationProcess.Id -ErrorAction SilentlyContinue
    }
  }
  Invoke-UpdaterFinalizationStep -Name 'base-process' -Action {
    if ($null -ne $baseProcess -and -not $baseProcess.HasExited) {
      Stop-Process -Id $baseProcess.Id -ErrorAction SilentlyContinue
    }
  }
  Invoke-UpdaterFinalizationStep -Name 'fixture-server' -Action {
    if ($null -ne $server -and -not $server.HasExited) {
      Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
    }
  }
  Invoke-UpdaterFinalizationStep -Name 'certificate' -Action {
    if ($null -ne $certificate) {
      $certificate.Dispose()
    }
  }
  Invoke-UpdaterFinalizationStep -Name 'certificate-key' -Action {
    if ($null -ne $certificateKey) {
      $certificateKey.Dispose()
    }
  }
}
if ($null -ne $primaryFailure) {
  throw $primaryFailure
}
if ($null -ne $finalizationFailure) {
  throw $finalizationFailure
}
