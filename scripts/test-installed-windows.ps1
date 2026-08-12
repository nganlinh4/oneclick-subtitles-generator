param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,

  [string]$ResultPath,

  [switch]$IncludeMediaFlow
)

$ErrorActionPreference = 'Stop'
$diagnosticLogLimitBytes = 4 * 1024 * 1024
$diagnosticEntrySlackBytes = 64 * 1024

if ($env:CI -ne 'true') {
  throw 'The installed Windows smoke test may run only on an isolated CI runner.'
}

$resultFile = $null
if (-not [string]::IsNullOrEmpty($ResultPath)) {
  $resultFile = [IO.Path]::GetFullPath($ResultPath)
  $runnerTempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
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
  param([Parameter(Mandatory = $true)]$Process)

  if ($Process.HasExited) {
    return
  }
  if (-not $Process.CloseMainWindow()) {
    Stop-Process -Id $Process.Id
    throw 'Installed application rejected a graceful close request'
  }
  if (-not $Process.WaitForExit(15000)) {
    Stop-Process -Id $Process.Id
    throw 'Installed application did not exit after a graceful close request'
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
    [Parameter(Mandatory = $true)][string]$LogPath
  )

  $screenshot = Join-Path $env:RUNNER_TEMP 'osg-installed-media-flow.png'
  if (Test-Path -LiteralPath $screenshot) {
    throw 'Installed media-flow screenshot path was not clean'
  }
  $output = @(
    & node 'scripts/inspect-installed-media-flow.mjs' `
      '--port' $Port `
      '--srt' $SrtPath `
      '--screenshot' $screenshot 2>&1
  )
  if ($LASTEXITCODE -ne 0) {
    $relevantEvents = @(
      Read-DiagnosticEvents -LogPath $LogPath |
        Where-Object event -in @(
          'native-tool.started',
          'native-tool.completed',
          'native-tool.failed',
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
Stop-Application -Process $first.Process
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
Stop-Application -Process $second.Process
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
try {
  $mediaFlow = $null
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
    $mediaFlow = Inspect-InstalledMediaFlow `
      -Port $third.DebugPort `
      -SrtPath $srtPath `
      -LogPath $logPath
    $eventsAfterMediaFlow = @(Read-DiagnosticEvents -LogPath $logPath)
    Assert-DiagnosticEvents -LogPath $logPath -Events $eventsAfterMediaFlow
    $mediaEvents = @($eventsAfterMediaFlow | Select-Object -Skip $third.Events.Count)
    if (-not ($mediaEvents | Where-Object event -eq 'download.started') `
        -or -not ($mediaEvents | Where-Object event -eq 'download.completed') `
        -or ($mediaEvents | Where-Object event -eq 'download.failed')) {
      throw 'Installed media-flow diagnostics did not prove one successful native download'
    }
    $completedTools = @(
      $mediaEvents |
        Where-Object event -eq 'native-tool.completed' |
        ForEach-Object tool |
        Sort-Object -Unique
    )
    if (($completedTools -join ',') -cne 'deno,media-tools,yt-dlp') {
      throw "Installed media-flow did not complete all parallel native tools: $($completedTools -join ',')"
    }
    $startedTools = @(
      $mediaEvents |
        Where-Object event -eq 'native-tool.started' |
        ForEach-Object tool |
        Sort-Object -Unique
    )
    $lastStartedIndex = -1
    $firstCompletedIndex = [int]::MaxValue
    for ($index = 0; $index -lt $mediaEvents.Count; $index += 1) {
      if ($mediaEvents[$index].event -eq 'native-tool.started') {
        $lastStartedIndex = $index
      } elseif ($mediaEvents[$index].event -eq 'native-tool.completed') {
        $firstCompletedIndex = [Math]::Min($firstCompletedIndex, $index)
      }
    }
    if (($startedTools -join ',') -cne 'deno,media-tools,yt-dlp' `
        -or $lastStartedIndex -ge $firstCompletedIndex) {
      throw 'Installed media-flow did not start all three native tool downloads in parallel'
    }
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
    installedMediaFlow = $mediaFlow
    managedFontCacheStable = $true
    diagnosticLogRotation = $true
    uninstallPreservedProfile = $true
  }
  $resultJson = $result | ConvertTo-Json -Depth 4
  if ($null -ne $resultFile) {
    [IO.File]::WriteAllText($resultFile, $resultJson, [Text.UTF8Encoding]::new($false))
  }
  $resultJson
} finally {
  Stop-Application -Process $third.Process
}
