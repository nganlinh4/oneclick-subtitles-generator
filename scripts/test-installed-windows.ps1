param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,

  [string]$ResultPath,

  [switch]$IncludeMediaFlow,

  [string]$LocalMediaPath
)

$ErrorActionPreference = 'Stop'
$diagnosticLogLimitBytes = 4 * 1024 * 1024
$diagnosticEntrySlackBytes = 64 * 1024

if ($env:CI -ne 'true') {
  throw 'The installed Windows smoke test may run only on an isolated CI runner.'
}
if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  throw 'The installed Windows smoke test requires RUNNER_TEMP.'
}

$runnerTempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
$nativePickerEvidencePath = Join-Path $runnerTempRoot 'osg-installed-native-picker-evidence.json'
$nativePickerEvidenceTemporaryPath = "$nativePickerEvidencePath.tmp"
$nativePickerEvidenceBackupPath = "$nativePickerEvidencePath.bak"
foreach ($evidencePath in @(
    $nativePickerEvidencePath,
    $nativePickerEvidenceTemporaryPath,
    $nativePickerEvidenceBackupPath
  )) {
  if (Test-Path -LiteralPath $evidencePath) {
    throw 'Native picker evidence path must be clean'
  }
}
. (Join-Path $PSScriptRoot 'native-picker-evidence.ps1') `
  -EvidencePath $nativePickerEvidencePath `
  -AllowedRoot $runnerTempRoot

$resultFile = $null
if (-not [string]::IsNullOrEmpty($ResultPath)) {
  $resultFile = [IO.Path]::GetFullPath($ResultPath)
  if (-not $resultFile.StartsWith($runnerTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installed smoke result path must stay inside RUNNER_TEMP'
  }
  if (Test-Path -LiteralPath $resultFile) {
    throw 'Installed smoke result path must be clean'
  }
}

$installer = [IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Installer does not exist: $installer"
}

$localMediaFixture = $null
$localMediaFixtureSha256 = $null
if ($IncludeMediaFlow) {
  if ([string]::IsNullOrEmpty($LocalMediaPath)) {
    throw 'Installed media flow requires a reviewed local-media fixture'
  }
  $localMediaFixture = [IO.Path]::GetFullPath($LocalMediaPath)
  if (-not $localMediaFixture.StartsWith($runnerTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installed local-media fixture must stay inside RUNNER_TEMP'
  }
  if (-not (Test-Path -LiteralPath $localMediaFixture -PathType Leaf)) {
    throw 'Installed local-media fixture is missing'
  }
  $fixtureInfo = Get-Item -LiteralPath $localMediaFixture
  $localMediaFixtureSha256 = (Get-FileHash -LiteralPath $localMediaFixture -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($fixtureInfo.Name -cne 'osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4' `
      -or $fixtureInfo.Length -ne 366888 `
      -or ($fixtureInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) `
      -or $localMediaFixtureSha256 -cne 'aecf6c8ef3977cd4525261ccadb4086581bd911cb17cc97128cfd8640c6055db') {
    throw 'Installed local-media fixture does not match the reviewed identity'
  }
}

$profileRoot = [IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA 'io.github.nganlinh4.oneclicksubtitles')
)
if (Test-Path -LiteralPath $profileRoot) {
  throw "CI profile is not clean: $profileRoot"
}

function Install-Application {
  $installation = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($installation.ExitCode -ne 0) {
    throw "NSIS installer exited with code $($installation.ExitCode)"
  }

  $installed = Get-ItemProperty -LiteralPath $uninstallKey
  if ($installed.DisplayVersion -ne $ExpectedVersion) {
    throw "Installed version $($installed.DisplayVersion) does not match $ExpectedVersion"
  }

  $installRoot = [IO.Path]::GetFullPath($installed.InstallLocation.Trim('"'))
  $localAppDataRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
  if (-not $installRoot.StartsWith($localAppDataRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Install root escaped LOCALAPPDATA: $installRoot"
  }
  $executable = [IO.Path]::GetFullPath((Join-Path $installRoot 'osg-desktop.exe'))
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Installed executable is missing: $executable"
  }

  [pscustomobject]@{
    Registry = $installed
    Root = $installRoot
    Executable = $executable
  }
}

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\One-Click Subtitles Generator'

function Read-DiagnosticEvents {
  param([Parameter(Mandatory = $true)][string]$LogPath)

  if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
    return @()
  }
  @(
    Get-Content -LiteralPath $LogPath |
      Where-Object { $_.Length -gt 0 } |
      ForEach-Object { $_ | ConvertFrom-Json }
  )
}

function Get-DiagnosticEventCount {
  param(
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][string]$Name
  )

  @(
    Read-DiagnosticEvents -LogPath $LogPath |
      Where-Object event -eq $Name
  ).Count
}

function Assert-DiagnosticEvents {
  param(
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][array]$Events
  )

  $length = (Get-Item -LiteralPath $LogPath).Length
  if ($length -gt ($diagnosticLogLimitBytes + $diagnosticEntrySlackBytes)) {
    throw "Diagnostic log exceeded its bounded rotation threshold: $length bytes"
  }
  foreach ($entry in $Events) {
    $properties = @($entry.PSObject.Properties)
    if ($properties.Count -lt 2) {
      throw 'Diagnostic log entry omitted required fields'
    }
    if ([string]$entry.timestampMs -notmatch '^\d{1,20}$') {
      throw 'Diagnostic log entry has an invalid timestamp'
    }
    if ([string]$entry.event -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') {
      throw 'Diagnostic log entry has an invalid event name'
    }
    foreach ($property in $properties) {
      if ($property.Name -in @('timestampMs', 'event')) {
        continue
      }
      if ($property.Name -notmatch '^[A-Za-z][A-Za-z0-9_]{0,63}$' `
          -or $property.Value -isnot [string] `
          -or $property.Value -notmatch '^[A-Za-z0-9._:-]{1,128}$') {
        throw 'Diagnostic log field escaped the bounded redacted contract'
      }
    }
  }
}

function Prepare-DiagnosticRotationFixture {
  param([Parameter(Mandatory = $true)][string]$LogPath)

  $previous = Join-Path (Split-Path -Parent $LogPath) 'osg.previous.log'
  if (Test-Path -LiteralPath $previous) {
    throw 'Diagnostic rotation fixture did not start without a previous log'
  }
  $padding = [string]::new('a', 4096)
  $line = "{`"timestampMs`":`"0`",`"event`":`"ci.rotation-padding`",`"padding`":`"$padding`"}"
  $encoding = [Text.UTF8Encoding]::new($false)
  $stream = [IO.FileStream]::new(
    $LogPath,
    [IO.FileMode]::Append,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
  )
  try {
    $writer = [IO.StreamWriter]::new($stream, $encoding, 4096, $true)
    try {
      while ($stream.Length -lt $diagnosticLogLimitBytes) {
        $writer.WriteLine($line)
        $writer.Flush()
      }
    } finally {
      $writer.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
  (Get-FileHash -LiteralPath $LogPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-DiagnosticRotation {
  param(
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][string]$ExpectedPreviousSha256
  )

  $previous = Join-Path (Split-Path -Parent $LogPath) 'osg.previous.log'
  if (-not (Test-Path -LiteralPath $previous -PathType Leaf)) {
    throw 'Diagnostic log did not rotate on relaunch'
  }
  $previousLength = (Get-Item -LiteralPath $previous).Length
  if ($previousLength -lt $diagnosticLogLimitBytes) {
    throw 'Rotated diagnostic log is smaller than the rollover threshold'
  }
  $previousSha256 = (Get-FileHash -LiteralPath $previous -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($previousSha256 -cne $ExpectedPreviousSha256) {
    throw 'Diagnostic log rotation changed the previous log bytes'
  }
  if ((Get-Item -LiteralPath $LogPath).Length -gt $diagnosticEntrySlackBytes) {
    throw 'Fresh diagnostic log remained oversized after rotation'
  }
}

function Stop-Application {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$LogPath
  )

  $Process.Refresh()
  if ($Process.HasExited) {
    throw 'Installed application exited before the graceful close request'
  }
  if ($Process.MainWindowHandle -eq [IntPtr]::Zero -or -not $Process.Responding) {
    throw 'Installed application was not ready for a graceful close'
  }
  $closeEventsBefore = Get-DiagnosticEventCount -LogPath $LogPath -Name 'app.close_requested'
  if (-not $Process.CloseMainWindow()) {
    Stop-Process -Id $Process.Id -ErrorAction SilentlyContinue
    throw 'Installed application rejected a graceful close request'
  }
  if (-not $Process.WaitForExit(30000)) {
    Stop-Process -Id $Process.Id -ErrorAction SilentlyContinue
    throw 'Installed application did not exit after a graceful close request'
  }
  if ($Process.ExitCode -ne 0) {
    throw "Installed application exited with code $($Process.ExitCode) after the graceful close request"
  }
  $closeEventsAfter = Get-DiagnosticEventCount -LogPath $LogPath -Name 'app.close_requested'
  if ($closeEventsAfter -ne ($closeEventsBefore + 1)) {
    throw 'Installed application did not flush exactly one graceful-close diagnostic'
  }
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

function Inspect-InstalledWebView {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Phase,
    [string]$ExpectedProjectId
  )

  $screenshot = Join-Path $env:RUNNER_TEMP "osg-$Phase.png"
  if (Test-Path -LiteralPath $screenshot) {
    throw "$Phase screenshot path was not clean"
  }
  $arguments = @(
    'scripts/inspect-installed-webview.mjs',
    '--port', $Port,
    '--expected-version', $ExpectedVersion,
    '--screenshot', $screenshot,
    '--phase', $Phase
  )
  if (-not [string]::IsNullOrEmpty($ExpectedProjectId)) {
    $arguments += @('--expected-project-id', $ExpectedProjectId)
  }
  $output = @(& node @arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "$Phase installed WebView inspection failed: $($output -join ' ')"
  }
  if ($output.Count -ne 1) {
    throw "$Phase installed WebView inspection returned an unexpected output shape"
  }
  $inspection = $output[0] | ConvertFrom-Json
  if (-not (Test-Path -LiteralPath $screenshot -PathType Leaf)) {
    throw "$Phase installed WebView screenshot was not written"
  }
  $inspection
}

function Inspect-InstalledMediaFlow {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$SrtPath,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)]
    [ValidateSet('osg-installed-media-flow-initial.png', 'osg-installed-media-flow.png')]
    [string]$ScreenshotName,
    [string]$PriorAssetId
  )

  $screenshot = Join-Path $env:RUNNER_TEMP $ScreenshotName
  if (Test-Path -LiteralPath $screenshot) {
    throw 'Installed media-flow screenshot path was not clean'
  }
  $arguments = @(
    'scripts/inspect-installed-media-flow.mjs',
    '--port', [string]$Port,
    '--srt', $SrtPath,
    '--screenshot', $screenshot
  )
  if (-not [string]::IsNullOrEmpty($PriorAssetId)) {
    if ($PriorAssetId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
      throw 'Installed media-flow prior asset identity is invalid'
    }
    $arguments += @('--prior-asset-id', $PriorAssetId)
  }
  $output = @(& node @arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $relevantEvents = @(
      Read-DiagnosticEvents -LogPath $LogPath |
        Where-Object event -in @(
          'native-tool.started',
          'native-tool.completed',
          'native-tool.failed',
          'download.inspection_requested',
          'download.inspection_completed',
          'download.inspection_failed',
          'download.started',
          'download.completed',
          'download.cancelled',
          'download.failed',
          'download.admission_failed',
          'download.engine_failed',
          'download.command_failed'
        ) |
        Select-Object -Last 64
    )
    $diagnostic = $relevantEvents | ConvertTo-Json -Depth 4 -Compress
    throw "Installed media-flow inspection failed: $($output -join ' ') diagnostics=$diagnostic"
  }
  if ($output.Count -ne 1) {
    throw 'Installed media-flow inspection returned an unexpected output shape'
  }
  if (-not (Test-Path -LiteralPath $screenshot -PathType Leaf)) {
    throw 'Installed media-flow screenshot was not written'
  }
  $output[0] | ConvertFrom-Json
}

function Initialize-NativePickerInterop {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  if ($null -eq ('OsgNativePickerWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OsgNativePickerWindow {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr GetWindow(IntPtr window, uint command);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
  }
}

function Get-NativeMediaPickerDialogs {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$OwnerHandle
  )

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $processCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
    $ProcessId
  )
  $windows = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    $processCondition
  )
  $processWindows = @()
  $processDialogClasses = @()
  $processNamedWindows = @()
  foreach ($window in $windows) {
    try {
      if ($window.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) {
        $processWindows += $window
        if ($window.Current.ClassName -ceq '#32770') {
          $processDialogClasses += $window
        }
        if ($window.Current.Name -ceq 'Choose video or audio') {
          $processNamedWindows += $window
        }
      }
    } catch {
      # A top-level window can disappear while its categorical state is sampled.
    }
  }
  $exact = @(
    foreach ($window in $processDialogClasses) {
      try {
        if ($window.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window `
            -and $window.Current.ClassName -ceq '#32770' `
            -and $window.Current.Name -ceq 'Choose video or audio') {
          $window
        }
      } catch {
        # A window can disappear while UI Automation enumerates the desktop tree.
      }
    }
  )
  $owned = @(
    foreach ($dialog in $exact) {
      try {
        $nativeHandle = [IntPtr]::new([long]$dialog.Current.NativeWindowHandle)
        if ([OsgNativePickerWindow]::GetWindow($nativeHandle, 4).ToInt64() -eq $OwnerHandle) {
          $dialog
        }
      } catch {
        # A matching dialog can disappear before its native owner is inspected.
      }
    }
  )
  [pscustomobject]@{
    Exact = $exact
    Owned = $owned
    ProcessWindows = $processWindows.Count
    ProcessDialogClasses = $processDialogClasses.Count
    ProcessNamedWindows = $processNamedWindows.Count
  }
}

function Get-NativePickerInspectorPhase {
  param([Parameter(Mandatory = $true)][string]$Root)

  $stages = @('starting', 'connected', 'control-ready', 'click-issued')
  $present = $null
  for ($snapshotAttempt = 0; $snapshotAttempt -lt 5; $snapshotAttempt += 1) {
    $present = @(
      foreach ($stage in $stages) {
        Test-Path -LiteralPath (Join-Path $Root "osg-installed-native-picker-$stage.json")
      }
    )
    $seenMissing = $false
    $nonPrefix = $false
    foreach ($exists in $present) {
      if (-not $exists) {
        $seenMissing = $true
      } elseif ($seenMissing) {
        $nonPrefix = $true
      }
    }
    if (-not $nonPrefix) {
      break
    }
    if ($snapshotAttempt -eq 4) {
      throw 'Installed local-media picker phases were not contiguous'
    }
    Start-Sleep -Milliseconds 10
  }

  $highest = 'not-started'
  for ($index = 0; $index -lt $stages.Count; $index += 1) {
    if (-not $present[$index]) {
      break
    }
    $stage = $stages[$index]
    $phasePath = Join-Path $Root "osg-installed-native-picker-$stage.json"
    $item = Get-Item -LiteralPath $phasePath -Force
    if ($item.PSIsContainer `
        -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) `
        -or $item.Length -le 0 `
        -or $item.Length -gt 128) {
      throw 'Installed local-media picker phase evidence was not regular and bounded'
    }
    $phase = Get-Content -LiteralPath $phasePath -Raw | ConvertFrom-Json
    $properties = @($phase.PSObject.Properties)
    if ($properties.Count -ne 2 `
        -or $null -eq $phase.PSObject.Properties['schemaVersion'] `
        -or $null -eq $phase.PSObject.Properties['stage'] `
        -or ($phase.schemaVersion -isnot [int] -and $phase.schemaVersion -isnot [long]) `
        -or $phase.stage -isnot [string] `
        -or $phase.schemaVersion -ne 1 `
        -or $phase.stage -cne $stage) {
      throw 'Installed local-media picker phase evidence had an invalid schema'
    }
    $highest = $stage
  }
  $highest
}

function Get-DiagnosticBaselineSnapshot {
  param([Parameter(Mandatory = $true)][string]$LogPath)

  $stream = [IO.FileStream]::new(
    $LogPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::ReadWrite
  )
  try {
    $length = $stream.Length
    if ($length -le 0 -or $length -gt ($diagnosticLogLimitBytes + $diagnosticEntrySlackBytes)) {
      throw 'Native picker diagnostic baseline length was invalid'
    }
    $bytes = [byte[]]::new([int]$length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($read -le 0) {
        throw 'Native picker diagnostic baseline ended unexpectedly'
      }
      $offset += $read
    }
    $lastLineBreak = $bytes.Length - 1
    while ($lastLineBreak -ge 0 -and $bytes[$lastLineBreak] -ne 10) {
      $lastLineBreak -= 1
    }
    if ($lastLineBreak -lt 0) {
      throw 'Native picker diagnostic baseline omitted a complete event'
    }
    $prefixLength = $lastLineBreak + 1
    if ($prefixLength -ne $bytes.Length) {
      $completeBytes = [byte[]]::new($prefixLength)
      [Array]::Copy($bytes, $completeBytes, $prefixLength)
      $bytes = $completeBytes
    }
  } finally {
    $stream.Dispose()
  }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $sha256 = ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
  $lines = @(
    [Text.Encoding]::UTF8.GetString($bytes) -split "`r?`n" |
      Where-Object Length -gt 0
  )
  foreach ($line in $lines) {
    [void]($line | ConvertFrom-Json)
  }
  [pscustomobject]@{
    EventCount = $lines.Count
    Length = $prefixLength
    Sha256 = $sha256
  }
}

function Get-NativePickerDiagnosticOutcome {
  param(
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][string]$BaselineSha256,
    [Parameter(Mandatory = $true)][long]$BaselineLength,
    [Parameter(Mandatory = $true)][string]$AppInstanceId
  )

  if ($BaselineLength -le 0 `
      -or $BaselineLength -gt ($diagnosticLogLimitBytes + $diagnosticEntrySlackBytes)) {
    return 'diagnostic-baseline-changed'
  }
  $stream = [IO.FileStream]::new(
    $LogPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::ReadWrite
  )
  try {
    $snapshotLength = $stream.Length
    if ($snapshotLength -lt $BaselineLength) {
      return 'diagnostic-baseline-changed'
    }
    if ($snapshotLength -gt ($diagnosticLogLimitBytes + $diagnosticEntrySlackBytes)) {
      return 'diagnostic-ambiguous'
    }
    $snapshotBytes = [byte[]]::new([int]$snapshotLength)
    $offset = 0
    while ($offset -lt $snapshotBytes.Length) {
      $read = $stream.Read($snapshotBytes, $offset, $snapshotBytes.Length - $offset)
      if ($read -le 0) {
        return 'diagnostic-baseline-changed'
      }
      $offset += $read
    }
  } finally {
    $stream.Dispose()
  }
  $lastLineBreak = $snapshotBytes.Length - 1
  while ($lastLineBreak -ge 0 -and $snapshotBytes[$lastLineBreak] -ne 10) {
    $lastLineBreak -= 1
  }
  $completeLength = $lastLineBreak + 1
  if ($completeLength -lt $BaselineLength) {
    return 'diagnostic-baseline-changed'
  }
  if ($completeLength -ne $snapshotBytes.Length) {
    $completeBytes = [byte[]]::new($completeLength)
    [Array]::Copy($snapshotBytes, $completeBytes, $completeLength)
    $snapshotBytes = $completeBytes
  }
  $baselineBytes = [byte[]]::new([int]$BaselineLength)
  [Array]::Copy($snapshotBytes, $baselineBytes, [int]$BaselineLength)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $actualBaselineSha256 = ([BitConverter]::ToString(
        $hasher.ComputeHash($baselineBytes)
      )).Replace('-', '').ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
  if ($actualBaselineSha256 -cne $BaselineSha256) {
    return 'diagnostic-baseline-changed'
  }
  $events = @(
    [Text.Encoding]::UTF8.GetString($snapshotBytes) -split "`r?`n" |
      Where-Object Length -gt 0 |
      ForEach-Object { $_ | ConvertFrom-Json }
  )
  $baselineEvents = @(
    [Text.Encoding]::UTF8.GetString($baselineBytes) -split "`r?`n" |
      Where-Object Length -gt 0
  )
  $pickerEvents = @(
    $events |
      Select-Object -Skip $baselineEvents.Count |
      Where-Object {
        $_.appInstanceId -ceq $AppInstanceId `
          -and $_.event -in @('media-picker.requested', 'media-picker.returned')
      }
  )
  $requested = @($pickerEvents | Where-Object event -eq 'media-picker.requested')
  $returned = @($pickerEvents | Where-Object event -eq 'media-picker.returned')
  foreach ($entry in $pickerEvents) {
    $expectedNames = if ($entry.event -ceq 'media-picker.requested') {
      @('appInstanceId', 'event', 'timestampMs')
    } else {
      @('appInstanceId', 'event', 'outcome', 'timestampMs')
    }
    if ((@($entry.PSObject.Properties.Name | Sort-Object) -join ',') `
        -cne (($expectedNames | Sort-Object) -join ',') `
        -or [string]$entry.timestampMs -notmatch '^\d{1,20}$') {
      return 'diagnostic-ambiguous'
    }
  }
  $returnedNone = @($returned | Where-Object outcome -ceq 'none')
  $returnedSelected = @($returned | Where-Object outcome -ceq 'selected')
  if ($returnedSelected.Count -eq 1 -and $requested.Count -eq 1 -and $returned.Count -eq 1 `
      -and $pickerEvents.Count -eq 2 `
      -and $pickerEvents[0].event -ceq 'media-picker.requested' `
      -and $pickerEvents[1].event -ceq 'media-picker.returned') {
    return 'selected'
  }
  if ($returnedNone.Count -eq 1 -and $requested.Count -eq 1 -and $returned.Count -eq 1 `
      -and $pickerEvents.Count -eq 2 `
      -and $pickerEvents[0].event -ceq 'media-picker.requested' `
      -and $pickerEvents[1].event -ceq 'media-picker.returned') {
    return 'backend-returned-none'
  }
  if ($requested.Count -eq 0 -and $returned.Count -eq 0) {
    return 'command-dispatch-timeout'
  }
  if ($requested.Count -eq 1 -and $returned.Count -eq 0) {
    return 'dialog-timeout'
  }
  'diagnostic-ambiguous'
}

function Get-NativePickerDiagnosticOutcomeSafely {
  param(
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][string]$BaselineSha256,
    [Parameter(Mandatory = $true)][long]$BaselineLength,
    [Parameter(Mandatory = $true)][string]$AppInstanceId
  )

  try {
    Get-NativePickerDiagnosticOutcome @PSBoundParameters
  } catch {
    'diagnostic-unavailable'
  }
}

function Wait-NativePickerClickIssued {
  param(
    [Parameter(Mandatory = $true)]$Inspector,
    [Parameter(Mandatory = $true)][int]$ApplicationProcessId,
    [Parameter(Mandatory = $true)][string]$PhaseRoot
  )

  $deadline = (Get-Date).AddMinutes(2)
  $lastPhase = 'not-started'
  do {
    try {
      $phase = Get-NativePickerInspectorPhase -Root $PhaseRoot
    } catch {
      try {
        Set-NativePickerEvidence `
          -Stage 'failed' `
          -Outcome 'failed' `
          -FailureCode 'inspector-phase-invalid'
      } catch {}
      throw
    }
    if ($phase -cne $lastPhase) {
      Set-NativePickerEvidence `
        -Stage "inspector-$phase" `
        -Outcome 'running' `
        -Metrics @{ inspectorPhase = $phase }
      $lastPhase = $phase
    }
    if ($phase -ceq 'click-issued') {
      return
    }
    if ($null -eq (Get-Process -Id $ApplicationProcessId -ErrorAction SilentlyContinue)) {
      try {
        Set-NativePickerEvidence -Stage 'failed' -Outcome 'failed' -FailureCode 'application-exited'
      } catch {}
      throw 'Installed application exited before the native picker click was issued'
    }
    $Inspector.Refresh()
    if ($Inspector.HasExited) {
      try {
        Set-NativePickerEvidence `
          -Stage 'failed' `
          -Outcome 'failed' `
          -FailureCode 'inspector-preclick-exited'
      } catch {}
      throw 'Installed local-media inspector exited before issuing the native picker click'
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)

  try {
    Set-NativePickerEvidence `
      -Stage 'failed' `
      -Outcome 'failed' `
      -FailureCode 'inspector-preclick-timeout'
  } catch {}
  throw 'Installed local-media inspector did not issue the native picker click within two minutes'
}

function Dismiss-NativeMediaPicker {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$OwnerHandle
  )

  Initialize-NativePickerInterop
  $attempts = 0
  $dismissed = $false
  $deadline = (Get-Date).AddSeconds(5)
  do {
    $attempts += 1
    $snapshot = Get-NativeMediaPickerDialogs `
      -ProcessId $ProcessId `
      -OwnerHandle $OwnerHandle
    $exact = @($snapshot.Exact)
    $owned = @($snapshot.Owned)
    if ($exact.Count -eq 0) {
      $dismissed = $true
      break
    }
    if ($exact.Count -ne 1 -or $owned.Count -ne 1) {
      break
    }
    $cancelCondition = [System.Windows.Automation.AndCondition]::new(
      [System.Windows.Automation.Condition[]]@(
        [System.Windows.Automation.PropertyCondition]::new(
          [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
          '2'
        ),
        [System.Windows.Automation.PropertyCondition]::new(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Button
        )
      )
    )
    $cancelButtons = @($owned[0].FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $cancelCondition
    ))
    $invoked = $false
    if ($cancelButtons.Count -eq 1 -and $cancelButtons[0].Current.IsEnabled) {
      $patternObject = $null
      if ($cancelButtons[0].TryGetCurrentPattern(
          [System.Windows.Automation.InvokePattern]::Pattern,
          [ref]$patternObject
        )) {
        ([System.Windows.Automation.InvokePattern]$patternObject).Invoke()
        $invoked = $true
      }
    }
    if (-not $invoked) {
      $nativeHandle = [IntPtr]::new([long]$owned[0].Current.NativeWindowHandle)
      [void][OsgNativePickerWindow]::PostMessage(
        $nativeHandle,
        0x0010,
        [IntPtr]::Zero,
        [IntPtr]::Zero
      )
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  [pscustomobject]@{
    Attempts = $attempts
    Dismissed = $dismissed
  }
}

function Complete-NativeMediaPicker {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$OwnerHandle,
    [Parameter(Mandatory = $true)][string]$MediaPath,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][string]$DiagnosticBaselineSha256,
    [Parameter(Mandatory = $true)][long]$DiagnosticBaselineLength,
    [Parameter(Mandatory = $true)][string]$AppInstanceId
  )

  $failureCode = 'unexpected'
  $dialogAttempts = 0
  $dialogMatches = 0
  $ownerMatched = $false
  $processWindowMatches = 0
  $processDialogMatches = 0
  $processNamedMatches = 0
  $ownedDialogMatches = 0
  $editorAttempts = 0
  $editorMatches = 0
  $editorWritable = $false
  $valueRetained = $false
  $buttonAttempts = 0
  $buttonMatches = 0
  $buttonEnabled = $false
  $buttonInvokable = $false
  $dismissAttempts = 0
  $dialogDismissed = $false
  try {
    Initialize-NativePickerInterop
    Set-NativePickerEvidence -Stage 'waiting-dialog' -Outcome 'running'
    $dialogDeadline = (Get-Date).AddSeconds(30)
    $dialog = $null
    do {
      $dialogAttempts += 1
      Start-Sleep -Milliseconds 100
      if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
        $failureCode = 'application-exited'
        throw 'Installed application exited while opening the native media picker'
      }
      $snapshot = Get-NativeMediaPickerDialogs `
        -ProcessId $ProcessId `
        -OwnerHandle $OwnerHandle
      $dialogs = @($snapshot.Exact)
      $ownedDialogs = @($snapshot.Owned)
      $dialogMatches = [Math]::Max($dialogMatches, $dialogs.Count)
      $processWindowMatches = [Math]::Max($processWindowMatches, [int]$snapshot.ProcessWindows)
      $processDialogMatches = [Math]::Max($processDialogMatches, [int]$snapshot.ProcessDialogClasses)
      $processNamedMatches = [Math]::Max($processNamedMatches, [int]$snapshot.ProcessNamedWindows)
      $ownedDialogMatches = [Math]::Max($ownedDialogMatches, $ownedDialogs.Count)
      $ownerMatched = $ownerMatched -or $ownedDialogs.Count -eq 1
      if ($dialogs.Count -gt 1 -or $ownedDialogs.Count -gt 1) {
        $failureCode = 'dialog-ambiguous'
        throw 'Installed application opened multiple native media pickers'
      }
      if ($dialogs.Count -eq 1 -and $ownedDialogs.Count -eq 1) {
        $dialog = $ownedDialogs[0]
      }
    } until ($null -ne $dialog -or (Get-Date) -ge $dialogDeadline)
    if ($null -eq $dialog) {
      $failureCode = if ($dialogMatches -eq 1) { 'owner-mismatch' } else { 'dialog-timeout' }
      throw 'Native media picker did not open as an owned dialog within 30 seconds'
    }
    Set-NativePickerEvidence `
      -Stage 'dialog-discovered' `
      -Outcome 'running' `
      -Metrics @{
        dialogAttempts = [Math]::Min($dialogAttempts, 1000)
        dialogMatches = $dialogMatches
        ownerMatched = $ownerMatched
        processWindowMatches = $processWindowMatches
        processDialogMatches = $processDialogMatches
        processNamedMatches = $processNamedMatches
        ownedDialogMatches = $ownedDialogMatches
      }

    $editorDeadline = (Get-Date).AddSeconds(30)
    do {
      $editorAttempts += 1
      try {
        $fileNameControls = @($dialog.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
            '1148'
          )
        ))
        $editorMatches = [Math]::Max($editorMatches, $fileNameControls.Count)
        $valuePattern = $null
        if ($fileNameControls.Count -eq 1) {
          $patternObject = $null
          if ($fileNameControls[0].TryGetCurrentPattern(
              [System.Windows.Automation.ValuePattern]::Pattern,
              [ref]$patternObject
            )) {
            $valuePattern = [System.Windows.Automation.ValuePattern]$patternObject
          } else {
            $editableControls = @($fileNameControls[0].FindAll(
              [System.Windows.Automation.TreeScope]::Descendants,
              [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::Edit
              )
            ))
            if ($editableControls.Count -eq 1) {
              $patternObject = $null
              if ($editableControls[0].TryGetCurrentPattern(
                  [System.Windows.Automation.ValuePattern]::Pattern,
                  [ref]$patternObject
                )) {
                $valuePattern = [System.Windows.Automation.ValuePattern]$patternObject
              }
            }
          }
        }
        if ($null -ne $valuePattern) {
          $currentEditorWritable = -not $valuePattern.Current.IsReadOnly
          $editorWritable = $editorWritable -or $currentEditorWritable
          if ($currentEditorWritable) {
            $valuePattern.SetValue($MediaPath)
            $valueRetained = [string]::Equals(
              $valuePattern.Current.Value,
              $MediaPath,
              [StringComparison]::Ordinal
            )
          }
        }
      } catch {
        # Common-dialog descendants can be replaced while their shell view initializes.
      }
      if (-not $valueRetained) {
        Start-Sleep -Milliseconds 100
      }
    } until ($valueRetained -or (Get-Date) -ge $editorDeadline)
    if (-not $valueRetained) {
      $failureCode = if ($editorMatches -gt 1) {
        'editor-ambiguous'
      } elseif (-not $editorWritable) {
        'editor-not-writable'
      } else {
        'value-not-retained'
      }
      throw 'Native media picker did not expose one writable filename control with the retained fixture value'
    }
    Set-NativePickerEvidence `
      -Stage 'value-confirmed' `
      -Outcome 'running' `
      -Metrics @{
        editorAttempts = [Math]::Min($editorAttempts, 1000)
        editorMatches = $editorMatches
        editorWritable = $editorWritable
        valueRetained = $valueRetained
      }

    $openButtonCondition = [System.Windows.Automation.AndCondition]::new(
      [System.Windows.Automation.Condition[]]@(
        [System.Windows.Automation.PropertyCondition]::new(
          [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
          '1'
        ),
        [System.Windows.Automation.PropertyCondition]::new(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Button
        )
      )
    )
    $buttonDeadline = (Get-Date).AddSeconds(30)
    $invokePattern = $null
    do {
      $buttonAttempts += 1
      try {
        $openButtons = @($dialog.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          $openButtonCondition
        ))
        $buttonMatches = [Math]::Max($buttonMatches, $openButtons.Count)
        if ($openButtons.Count -eq 1) {
          $currentButtonEnabled = $openButtons[0].Current.IsEnabled
          $buttonEnabled = $buttonEnabled -or $currentButtonEnabled
          $patternObject = $null
          if ($currentButtonEnabled -and $openButtons[0].TryGetCurrentPattern(
              [System.Windows.Automation.InvokePattern]::Pattern,
              [ref]$patternObject
            )) {
            $invokePattern = [System.Windows.Automation.InvokePattern]$patternObject
            $buttonInvokable = $true
          }
        }
      } catch {
        # Retry when the shell refreshes the common-dialog button tree.
      }
      if (-not $buttonInvokable) {
        Start-Sleep -Milliseconds 100
      }
    } until ($buttonInvokable -or (Get-Date) -ge $buttonDeadline)
    if (-not $buttonInvokable) {
      $failureCode = if ($buttonMatches -gt 1) {
        'button-ambiguous'
      } elseif (-not $buttonEnabled) {
        'button-disabled'
      } else {
        'button-not-invokable'
      }
      throw 'Native media picker did not expose one enabled invokable confirmation button'
    }
    Set-NativePickerEvidence `
      -Stage 'button-discovered' `
      -Outcome 'running' `
      -Metrics @{
        buttonAttempts = [Math]::Min($buttonAttempts, 1000)
        buttonMatches = $buttonMatches
        buttonEnabled = $buttonEnabled
        buttonInvokable = $buttonInvokable
      }

    $invokePattern.Invoke()
    Set-NativePickerEvidence -Stage 'button-invoked' -Outcome 'running'
    $dismissDeadline = (Get-Date).AddSeconds(30)
    do {
      $dismissAttempts += 1
      Start-Sleep -Milliseconds 100
      $snapshot = Get-NativeMediaPickerDialogs `
        -ProcessId $ProcessId `
        -OwnerHandle $OwnerHandle
      $remainingDialogs = @($snapshot.Exact)
      $remainingOwnedDialogs = @($snapshot.Owned)
      if ($remainingDialogs.Count -gt 1 -or $remainingOwnedDialogs.Count -gt 1) {
        $failureCode = 'dismissal-ambiguous'
        throw 'Native media picker multiplied after confirmation'
      }
      if ($remainingDialogs.Count -eq 0) {
        $dialogDismissed = $true
      } elseif ($remainingOwnedDialogs.Count -ne 1) {
        $failureCode = 'owner-changed'
        throw 'Native media picker owner changed after confirmation'
      }
    } until ($dialogDismissed -or (Get-Date) -ge $dismissDeadline)
    if (-not $dialogDismissed) {
      $failureCode = 'dismissal-timeout'
      throw 'Native media picker did not disappear after confirmation'
    }
    Set-NativePickerEvidence `
      -Stage 'dialog-dismissed' `
      -Outcome 'succeeded' `
      -Metrics @{
        dismissAttempts = [Math]::Min($dismissAttempts, 1000)
        dialogDismissed = $dialogDismissed
      }
  } catch {
    if ($failureCode -in @('dialog-timeout', 'owner-mismatch')) {
      $diagnosticFailure = Get-NativePickerDiagnosticOutcomeSafely `
        -LogPath $LogPath `
        -BaselineSha256 $DiagnosticBaselineSha256 `
        -BaselineLength $DiagnosticBaselineLength `
        -AppInstanceId $AppInstanceId
      if ($diagnosticFailure -in @(
          'command-dispatch-timeout',
          'backend-returned-none',
          'diagnostic-baseline-changed',
          'diagnostic-ambiguous',
          'diagnostic-unavailable'
        )) {
        $failureCode = $diagnosticFailure
      }
    }
    $dismissal = $null
    try {
      $dismissal = Dismiss-NativeMediaPicker `
        -ProcessId $ProcessId `
        -OwnerHandle $OwnerHandle
    } catch {
      # The primary picker failure remains authoritative when best-effort cleanup also fails.
    }
    try {
      $failureMetrics = @{
        dialogAttempts = [Math]::Min($dialogAttempts, 1000)
        dialogMatches = [Math]::Min($dialogMatches, 1000)
        ownerMatched = $ownerMatched
        processWindowMatches = [Math]::Min($processWindowMatches, 1000)
        processDialogMatches = [Math]::Min($processDialogMatches, 1000)
        processNamedMatches = [Math]::Min($processNamedMatches, 1000)
        ownedDialogMatches = [Math]::Min($ownedDialogMatches, 1000)
        editorAttempts = [Math]::Min($editorAttempts, 1000)
        editorMatches = [Math]::Min($editorMatches, 1000)
        editorWritable = $editorWritable
        valueRetained = $valueRetained
        buttonAttempts = [Math]::Min($buttonAttempts, 1000)
        buttonMatches = [Math]::Min($buttonMatches, 1000)
        buttonEnabled = $buttonEnabled
        buttonInvokable = $buttonInvokable
        dismissAttempts = [Math]::Min($dismissAttempts, 1000)
        dialogDismissed = $dialogDismissed
      }
      if ($null -ne $dismissal) {
        $failureMetrics.dismissAttempts = [Math]::Min([int]$dismissal.Attempts, 1000)
        $failureMetrics.dialogDismissed = [bool]$dismissal.Dismissed
      }
      Set-NativePickerEvidence `
        -Stage 'failed' `
        -Outcome 'failed' `
        -FailureCode $failureCode `
        -Metrics $failureMetrics
    } catch {
      # Evidence persistence must never replace the original picker exception.
    }
    throw
  }
}

function Inspect-InstalledLocalMediaFlow {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$MediaPath,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][string]$AppInstanceId,
    [Parameter(Mandatory = $true)][string]$PriorAssetId
  )

  $screenshot = Join-Path $env:RUNNER_TEMP 'osg-installed-local-media-flow.png'
  $stdout = Join-Path $env:RUNNER_TEMP 'osg-installed-local-media-flow.stdout'
  $stderr = Join-Path $env:RUNNER_TEMP 'osg-installed-local-media-flow.stderr'
  $phasePaths = @(
    @('starting', 'connected', 'control-ready', 'click-issued') |
      ForEach-Object { Join-Path $env:RUNNER_TEMP "osg-installed-native-picker-$_.json" }
  )
  $phaseScratchPaths = @($phasePaths | ForEach-Object { "$_.tmp" })
  foreach ($path in @($screenshot, $stdout, $stderr) + $phasePaths + $phaseScratchPaths) {
    if (Test-Path -LiteralPath $path) {
      throw 'Installed local-media flow output path was not clean'
    }
  }
  $applicationProcess = Get-Process -Id $ProcessId -ErrorAction Stop
  $applicationProcess.Refresh()
  $ownerHandle = $applicationProcess.MainWindowHandle.ToInt64()
  if ($ownerHandle -eq 0 -or -not $applicationProcess.Responding) {
    throw 'Installed application lacked a responsive owner before native selection'
  }
  if ($PriorAssetId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'Installed local-media prior asset identity is invalid'
  }
  $arguments = @(
    'scripts/inspect-installed-local-media-flow.mjs',
    '--port', [string]$Port,
    '--expected-file-name', [IO.Path]::GetFileName($MediaPath),
    '--screenshot', $screenshot,
    '--phase-directory', $env:RUNNER_TEMP,
    '--prior-asset-id', $PriorAssetId
  )
  Initialize-NativePickerEvidence
  $diagnosticBaseline = Get-DiagnosticBaselineSnapshot -LogPath $LogPath
  $inspection = Start-Process `
    -FilePath 'node' `
    -ArgumentList $arguments `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru
  $inspectionSucceeded = $false
  try {
    Wait-NativePickerClickIssued `
      -Inspector $inspection `
      -ApplicationProcessId $ProcessId `
      -PhaseRoot $env:RUNNER_TEMP
    Complete-NativeMediaPicker `
      -ProcessId $ProcessId `
      -OwnerHandle $ownerHandle `
      -MediaPath $MediaPath `
      -LogPath $LogPath `
      -DiagnosticBaselineSha256 $diagnosticBaseline.Sha256 `
      -DiagnosticBaselineLength $diagnosticBaseline.Length `
      -AppInstanceId $AppInstanceId
    if (-not $inspection.WaitForExit(120000)) {
      Stop-Process -Id $inspection.Id -ErrorAction SilentlyContinue
      throw 'Installed local-media flow did not finish within two minutes'
    }
    # Flush redirected stdout/stderr after the bounded wait observes process termination.
    $inspection.WaitForExit()
    $output = @(Get-Content -LiteralPath $stdout)
    $errors = @(Get-Content -LiteralPath $stderr)
    if ($inspection.ExitCode -ne 0) {
      throw "Installed local-media inspection failed: $($errors -join ' ')"
    }
    if ($output.Count -ne 1 -or $errors.Count -ne 0) {
      throw 'Installed local-media inspection returned an unexpected output shape'
    }
    if (-not (Test-Path -LiteralPath $screenshot -PathType Leaf)) {
      throw 'Installed local-media screenshot was not written'
    }
    $result = $output[0] | ConvertFrom-Json
    $pickerDiagnosticOutcome = Get-NativePickerDiagnosticOutcome `
      -LogPath $LogPath `
      -BaselineSha256 $diagnosticBaseline.Sha256 `
      -BaselineLength $diagnosticBaseline.Length `
      -AppInstanceId $AppInstanceId
    if ($pickerDiagnosticOutcome -cne 'selected') {
      throw 'Installed local-media flow omitted one selected native picker transaction'
    }
    if ($result.fixtureSha256 -cne $localMediaFixtureSha256) {
      throw 'Installed local-media inspection returned the wrong fixture digest'
    }
    $inspectionSucceeded = $true
    $result
  } finally {
    try {
      $inspection.Refresh()
      if (-not $inspection.HasExited) {
        Stop-Process -Id $inspection.Id -ErrorAction SilentlyContinue
        [void]$inspection.WaitForExit(5000)
      }
    } catch {
      # Inspector cleanup is best effort and must not replace the primary flow failure.
    }
    $phaseCleanupFailed = $false
    try {
      foreach ($phasePath in $phasePaths + $phaseScratchPaths) {
        if (Test-Path -LiteralPath $phasePath) {
          $phaseItem = Get-Item -LiteralPath $phasePath -Force
          if ($phaseItem.PSIsContainer `
              -or ($phaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) `
              -or $phaseItem.Length -gt 128) {
            throw 'Installed local-media picker phase cleanup rejected hostile state'
          }
          [IO.File]::Delete($phasePath)
        }
      }
    } catch {
      $phaseCleanupFailed = $true
    }
    if ($inspectionSucceeded -and $phaseCleanupFailed) {
      throw 'Installed local-media picker phase cleanup failed'
    }
  }
}

function Inspect-InstalledMediaPipeline {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$ExpectedSourceName
  )

  $stdout = Join-Path $env:RUNNER_TEMP 'osg-installed-media-pipeline.stdout'
  $stderr = Join-Path $env:RUNNER_TEMP 'osg-installed-media-pipeline.stderr'
  foreach ($path in @($stdout, $stderr)) {
    if (Test-Path -LiteralPath $path) {
      throw 'Installed media-pipeline output path was not clean'
    }
  }
  $arguments = @(
    'scripts/inspect-installed-media-pipeline.mjs',
    '--port', [string]$Port,
    '--expected-source-name', $ExpectedSourceName
  )
  $inspection = Start-Process `
    -FilePath 'node' `
    -ArgumentList $arguments `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru
  try {
    if (-not $inspection.WaitForExit(360000)) {
      Stop-Process -Id $inspection.Id
      throw 'Installed media-pipeline inspection did not finish within six minutes'
    }
    $inspection.WaitForExit()
    $output = @(Get-Content -LiteralPath $stdout)
    $errors = @(Get-Content -LiteralPath $stderr)
    if ($inspection.ExitCode -ne 0) {
      throw "Installed media-pipeline inspection failed: $($errors -join ' ')"
    }
    if ($output.Count -ne 1 -or $errors.Count -ne 0) {
      throw 'Installed media-pipeline inspection returned an unexpected output shape'
    }
    $output[0] | ConvertFrom-Json
  } finally {
    if (-not $inspection.HasExited) {
      Stop-Process -Id $inspection.Id
    }
  }
}

function Inspect-InstalledEditorFlow {
  param([Parameter(Mandatory = $true)][int]$Port)

  $screenshot = Join-Path $env:RUNNER_TEMP 'osg-installed-editor-flow.png'
  $stdout = Join-Path $env:RUNNER_TEMP 'osg-installed-editor-flow.stdout'
  $stderr = Join-Path $env:RUNNER_TEMP 'osg-installed-editor-flow.stderr'
  foreach ($path in @($screenshot, $stdout, $stderr)) {
    if (Test-Path -LiteralPath $path) {
      throw 'Installed editor-flow output path was not clean'
    }
  }
  $arguments = @(
    'scripts/inspect-installed-editor-flow.mjs',
    '--port', [string]$Port,
    '--screenshot', $screenshot
  )
  $inspection = Start-Process `
    -FilePath 'node' `
    -ArgumentList $arguments `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru
  try {
    if (-not $inspection.WaitForExit(180000)) {
      Stop-Process -Id $inspection.Id
      throw 'Installed editor-flow inspection did not finish within three minutes'
    }
    $inspection.WaitForExit()
    $output = @(Get-Content -LiteralPath $stdout)
    $errors = @(Get-Content -LiteralPath $stderr)
    if ($inspection.ExitCode -ne 0) {
      throw "Installed editor-flow inspection failed: $($errors -join ' ')"
    }
    if ($output.Count -ne 1 -or $errors.Count -ne 0) {
      throw 'Installed editor-flow inspection returned an unexpected output shape'
    }
    if (-not (Test-Path -LiteralPath $screenshot -PathType Leaf)) {
      throw 'Installed editor-flow screenshot was not written'
    }
    $output[0] | ConvertFrom-Json
  } finally {
    if (-not $inspection.HasExited) {
      Stop-Process -Id $inspection.Id
    }
  }
}

function Start-And-WaitForReadiness {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][int]$InitialEventCount,
    [Parameter(Mandatory = $true)][string]$Phase,
    [string]$ExpectedProjectId
  )

  if (-not [string]::IsNullOrEmpty($env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS)) {
    throw 'The isolated runner already has unreviewed WebView2 browser arguments'
  }
  $debugPort = Get-FreeLoopbackPort
  try {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$debugPort"
    $app = Start-Process -FilePath $Executable -PassThru
  } finally {
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  }
  $deadline = (Get-Date).AddMinutes(2)
  $events = @()
  try {
    do {
      Start-Sleep -Milliseconds 500
      if ($app.HasExited) {
        throw "$Phase application exited before readiness with code $($app.ExitCode)"
      }
      $events = @(Read-DiagnosticEvents -LogPath $LogPath)
      $newEvents = @($events | Select-Object -Skip $InitialEventCount)
      $ready = $newEvents | Where-Object event -eq 'app.ready' | Select-Object -Last 1
    } until ($ready -or (Get-Date) -ge $deadline)

    if (-not $ready) {
      throw "$Phase application did not reach app.ready within two minutes"
    }
    $startIndex = -1
    $fontIndex = -1
    $readyIndex = -1
    for ($index = 0; $index -lt $newEvents.Count; $index += 1) {
      if ($startIndex -lt 0 -and $newEvents[$index].event -eq 'app.start') {
        $startIndex = $index
      }
      if ($fontIndex -lt 0 -and $newEvents[$index].event -eq 'ui-font.ready') {
        $fontIndex = $index
      }
      if ($readyIndex -lt 0 -and $newEvents[$index].event -eq 'app.ready') {
        $readyIndex = $index
      }
    }
    if (-not (0 -le $startIndex -and $startIndex -lt $fontIndex -and $fontIndex -lt $readyIndex)) {
      throw "$Phase application readiness events were absent or out of order"
    }
    $launchInstanceIds = @(
      [string]$newEvents[$startIndex].appInstanceId,
      [string]$newEvents[$fontIndex].appInstanceId,
      [string]$newEvents[$readyIndex].appInstanceId
    )
    if (@($launchInstanceIds | Sort-Object -Unique).Count -ne 1 `
        -or $launchInstanceIds[0] -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
      throw "$Phase application readiness events had an invalid instance identity"
    }
    if ($newEvents | Where-Object event -eq 'ui-font.unavailable') {
      throw "Managed UI font was unavailable during $Phase launch"
    }
    Assert-DiagnosticEvents -LogPath $LogPath -Events $events

    $process = Get-Process -Id $app.Id
    if (-not $process.Responding) {
      throw "$Phase application window is not responding"
    }
    $inspection = Inspect-InstalledWebView `
      -Port $debugPort `
      -Phase $Phase `
      -ExpectedProjectId $ExpectedProjectId
    [pscustomobject]@{
      Process = $app
      DebugPort = $debugPort
      Events = $events
      AppInstanceId = $launchInstanceIds[0]
      NewEventNames = @($newEvents | ForEach-Object event)
      Responding = $process.Responding
      Inspection = $inspection
    }
  } catch {
    if (-not $app.HasExited) {
      Stop-Process -Id $app.Id
    }
    throw
  }
}

function Get-FontSnapshot {
  param([Parameter(Mandatory = $true)][string]$FontRoot)

  if (-not (Test-Path -LiteralPath $FontRoot -PathType Container)) {
    throw 'Managed UI font store is missing after a ready launch'
  }
  $records = @(
    Get-ChildItem -LiteralPath $FontRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
      if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Managed UI font store contains a reparse point'
      }
      [pscustomobject]@{
        relativePath = [IO.Path]::GetRelativePath($FontRoot, $_.FullName).Replace('\', '/')
        sizeBytes = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
  )
  if ($records.Count -eq 0) {
    throw 'Managed UI font store is empty after a ready launch'
  }
  $records | ConvertTo-Json -Depth 4 -Compress
}

function Uninstall-Application {
  param([Parameter(Mandatory = $true)]$Installation)

  $uninstaller = [IO.Path]::GetFullPath((Join-Path $Installation.Root 'uninstall.exe'))
  if (-not $uninstaller.StartsWith(
    $Installation.Root.TrimEnd('\') + '\',
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw 'Uninstaller escaped the validated installation root'
  }
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw 'NSIS uninstaller is missing from the validated installation root'
  }
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) {
    throw "NSIS uninstaller exited with code $($uninstall.ExitCode)"
  }
  if (Test-Path -LiteralPath $uninstallKey) {
    throw 'NSIS uninstall registration remains after uninstall'
  }
  if (Test-Path -LiteralPath $Installation.Executable) {
    throw 'Installed executable remains after uninstall'
  }
  if (-not (Test-Path -LiteralPath $profileRoot -PathType Container)) {
    throw 'Uninstall unexpectedly deleted the user profile'
  }
}

$installed = Install-Application
$logPath = Join-Path $profileRoot 'logs\osg.log'
$fontRoot = Join-Path $profileRoot 'ui-fonts\v1'
$first = Start-And-WaitForReadiness `
  -Executable $installed.Executable `
  -LogPath $logPath `
  -InitialEventCount 0 `
  -Phase 'first-launch'
Stop-Application -Process $first.Process -LogPath $logPath
$fontBeforeRelaunch = Get-FontSnapshot -FontRoot $fontRoot
$rotationFixtureSha256 = Prepare-DiagnosticRotationFixture -LogPath $logPath

$second = Start-And-WaitForReadiness `
  -Executable $installed.Executable `
  -LogPath $logPath `
  -InitialEventCount 0 `
  -Phase 'relaunch' `
  -ExpectedProjectId $first.Inspection.persistence.projectId
Assert-DiagnosticRotation `
  -LogPath $logPath `
  -ExpectedPreviousSha256 $rotationFixtureSha256
Stop-Application -Process $second.Process -LogPath $logPath
$fontAfterRelaunch = Get-FontSnapshot -FontRoot $fontRoot
if ($fontAfterRelaunch -cne $fontBeforeRelaunch) {
  throw 'Managed UI font files changed during cached relaunch'
}

$executableSha256 = (Get-FileHash -LiteralPath $installed.Executable -Algorithm SHA256).Hash.ToLowerInvariant()
Uninstall-Application -Installation $installed

$reinstalled = Install-Application
if ((Get-FileHash -LiteralPath $reinstalled.Executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $executableSha256) {
  throw 'Reinstalled executable differs from the validated first installation'
}
$third = Start-And-WaitForReadiness `
  -Executable $reinstalled.Executable `
  -LogPath $logPath `
  -InitialEventCount $second.Events.Count `
  -Phase 'reinstall-launch' `
  -ExpectedProjectId $first.Inspection.persistence.projectId
$third.Process.Refresh()
$thirdOwnerHandle = $third.Process.MainWindowHandle.ToInt64()
if ($thirdOwnerHandle -eq 0) {
  throw 'Reinstalled application omitted its main window owner'
}
try {
  $initialMediaFlow = $null
  $mediaFlow = $null
  $localMediaFlow = $null
  $mediaPipeline = $null
  $editorFlow = $null
  if ($IncludeMediaFlow) {
    $srtPath = Join-Path $env:RUNNER_TEMP 'osg-installed-media-smoke.srt'
    if (Test-Path -LiteralPath $srtPath) {
      throw 'Installed media-flow SRT fixture path was not clean'
    }
    $srtFixture = @"
1
00:00:00,000 --> 00:00:03,000
OSG installed media smoke
"@
    [IO.File]::WriteAllText($srtPath, $srtFixture, [Text.UTF8Encoding]::new($false))
    # The first URL pass installs all three managed tools in parallel. Local selection then
    # proves native FFprobe inspection, and the final URL pass proves that leaving the upload
    # tab did not strand the real URL workflow.
    $initialMediaFlow = Inspect-InstalledMediaFlow `
      -Port $third.DebugPort `
      -SrtPath $srtPath `
      -LogPath $logPath `
      -ScreenshotName 'osg-installed-media-flow-initial.png'
    $localMediaFlow = Inspect-InstalledLocalMediaFlow `
      -Port $third.DebugPort `
      -ProcessId $third.Process.Id `
      -MediaPath $localMediaFixture `
      -LogPath $logPath `
      -AppInstanceId $third.AppInstanceId `
      -PriorAssetId $initialMediaFlow.assetId
    if ((Get-FileHash -LiteralPath $localMediaFixture -Algorithm SHA256).Hash.ToLowerInvariant() `
        -cne $localMediaFixtureSha256) {
      throw 'Native local-media selection changed the reviewed fixture bytes'
    }
    $mediaPipeline = Inspect-InstalledMediaPipeline `
      -Port $third.DebugPort `
      -ExpectedSourceName ([IO.Path]::GetFileName($localMediaFixture))
    $mediaFlow = Inspect-InstalledMediaFlow `
      -Port $third.DebugPort `
      -SrtPath $srtPath `
      -LogPath $logPath `
      -ScreenshotName 'osg-installed-media-flow.png' `
      -PriorAssetId $localMediaFlow.assetId
    if ($initialMediaFlow.assetId -eq $localMediaFlow.assetId `
        -or $localMediaFlow.assetId -eq $mediaFlow.assetId) {
      throw 'Installed media flows did not replace the active native asset at each boundary'
    }
    $eventsAfterMediaFlow = @(Read-DiagnosticEvents -LogPath $logPath)
    Assert-DiagnosticEvents -LogPath $logPath -Events $eventsAfterMediaFlow
    $mediaEvents = @($eventsAfterMediaFlow | Select-Object -Skip $third.Events.Count)
    $startedDownloads = @($mediaEvents | Where-Object event -eq 'download.started')
    $completedDownloads = @($mediaEvents | Where-Object event -eq 'download.completed')
    $startedDownloadJobs = @($startedDownloads | ForEach-Object job | Sort-Object -Unique)
    $completedDownloadJobs = @($completedDownloads | ForEach-Object job | Sort-Object -Unique)
    $invalidDownloadJobIds = @(
      @($startedDownloadJobs) + @($completedDownloadJobs) |
        Where-Object { [string]$_ -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }
    )
    $downloadFailureEvents = @(
      'download.cancelled',
      'download.failed',
      'download.admission_failed',
      'download.engine_failed',
      'download.command_failed',
      'download.inspection_failed'
    )
    $failedDownloads = @(
      $mediaEvents | Where-Object { $_.event -in $downloadFailureEvents }
    )
    if ($startedDownloads.Count -ne 2 `
        -or $completedDownloads.Count -ne 2 `
        -or $startedDownloadJobs.Count -ne 2 `
        -or $completedDownloadJobs.Count -ne 2 `
        -or ($startedDownloadJobs -join ',') -cne ($completedDownloadJobs -join ',') `
        -or $invalidDownloadJobIds.Count -ne 0 `
        -or $failedDownloads.Count -ne 0) {
      throw 'Installed media-flow diagnostics did not prove URL reactivation after native selection'
    }
    $startedToolEvents = @($mediaEvents | Where-Object event -eq 'native-tool.started')
    $completedToolEvents = @($mediaEvents | Where-Object event -eq 'native-tool.completed')
    $startedTools = @(
      $startedToolEvents |
        ForEach-Object tool |
        Sort-Object -Unique
    )
    $completedTools = @(
      $completedToolEvents |
        ForEach-Object tool |
        Sort-Object -Unique
    )
    $startedToolJobs = @($startedToolEvents | ForEach-Object job | Sort-Object -Unique)
    $completedToolJobs = @($completedToolEvents | ForEach-Object job | Sort-Object -Unique)
    $startedToolPairs = @(
      $startedToolEvents |
        ForEach-Object { "$($_.tool):$($_.job)" } |
        Sort-Object
    )
    $completedToolPairs = @(
      $completedToolEvents |
        ForEach-Object { "$($_.tool):$($_.job)" } |
        Sort-Object
    )
    $invalidToolJobIds = @(
      @($startedToolJobs) + @($completedToolJobs) |
        Where-Object { [string]$_ -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }
    )
    $failedTools = @(
      $mediaEvents | Where-Object {
        $_.event -in @(
          'native-tool.failed',
          'native-tool.cancelled',
          'native-tool.invalid-terminal'
        )
      }
    )
    if ($startedToolEvents.Count -ne 3 `
        -or $completedToolEvents.Count -ne 3 `
        -or ($startedTools -join ',') -cne 'deno,media-tools,yt-dlp' `
        -or ($completedTools -join ',') -cne 'deno,media-tools,yt-dlp' `
        -or $startedToolJobs.Count -ne 3 `
        -or $completedToolJobs.Count -ne 3 `
        -or ($startedToolJobs -join ',') -cne ($completedToolJobs -join ',') `
        -or ($startedToolPairs -join ',') -cne ($completedToolPairs -join ',') `
        -or $invalidToolJobIds.Count -ne 0 `
        -or $failedTools.Count -ne 0) {
      throw "Installed media-flow did not complete all parallel native tools: $($completedTools -join ',')"
    }
    $lastStartedIndex = -1
    $firstCompletedIndex = [int]::MaxValue
    for ($index = 0; $index -lt $mediaEvents.Count; $index += 1) {
      if ($mediaEvents[$index].event -eq 'native-tool.started') {
        $lastStartedIndex = $index
      } elseif ($mediaEvents[$index].event -eq 'native-tool.completed') {
        $firstCompletedIndex = [Math]::Min($firstCompletedIndex, $index)
      }
    }
    if ($lastStartedIndex -ge $firstCompletedIndex) {
      throw 'Installed media-flow did not start all three native tool downloads in parallel'
    }
    $editorFlow = Inspect-InstalledEditorFlow -Port $third.DebugPort
  }
  $result = [pscustomobject]@{
    version = $reinstalled.Registry.DisplayVersion
    executableSha256 = $executableSha256
    firstLaunchEvents = $first.NewEventNames
    relaunchEvents = $second.NewEventNames
    reinstallLaunchEvents = $third.NewEventNames
    firstLaunchResponding = $first.Responding
    relaunchResponding = $second.Responding
    reinstallResponding = $third.Responding
    firstLaunchWebView = $first.Inspection
    relaunchWebView = $second.Inspection
    reinstallWebView = $third.Inspection
    installedInitialMediaFlow = $initialMediaFlow
    installedMediaFlow = $mediaFlow
    installedLocalMediaFlow = $localMediaFlow
    installedMediaPipeline = $mediaPipeline
    installedEditorFlow = $editorFlow
    managedFontCacheStable = $true
    diagnosticLogRotation = $true
    uninstallPreservedProfile = $true
  }
  $resultJson = $result | ConvertTo-Json -Depth 4
  if ($resultJson -match '(?i)(?:https?://|file://|localhost|127\.0\.0\.1|[A-Za-z]:[\\/]|\\\\|"(?:currentFileUrl|playbackUrl|token)"\s*:)') {
    throw 'Installed smoke result evidence exposed a URL, capability, token, or filesystem path'
  }
  if ($null -ne $resultFile) {
    [IO.File]::WriteAllText($resultFile, $resultJson, [Text.UTF8Encoding]::new($false))
  }
  $resultJson
} catch {
  try {
    [void](Dismiss-NativeMediaPicker `
      -ProcessId $third.Process.Id `
      -OwnerHandle $thirdOwnerHandle)
  } catch {
    # Picker dismissal is best effort; the original test failure remains authoritative.
  }
  try {
    Stop-Application -Process $third.Process -LogPath $logPath
  } catch {
    Stop-Process -Id $third.Process.Id -ErrorAction SilentlyContinue
  }
  throw
}
Stop-Application -Process $third.Process -LogPath $logPath
