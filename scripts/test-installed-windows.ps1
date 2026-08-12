param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'

if ($env:CI -ne 'true') {
  throw 'The installed Windows smoke test may run only on an isolated CI runner.'
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

function Start-And-WaitForReadiness {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][int]$InitialEventCount,
    [Parameter(Mandatory = $true)][string]$Phase
  )

  $app = Start-Process -FilePath $Executable -PassThru
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

    $process = Get-Process -Id $app.Id
    if (-not $process.Responding) {
      throw "$Phase application window is not responding"
    }
    [pscustomobject]@{
      Process = $app
      Events = $events
      NewEventNames = @($newEvents | ForEach-Object event)
      Responding = $process.Responding
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

$second = Start-And-WaitForReadiness `
  -Executable $installed.Executable `
  -LogPath $logPath `
  -InitialEventCount $first.Events.Count `
  -Phase 'relaunch'
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
  -Phase 'reinstall-launch'
try {
  [pscustomobject]@{
    version = $reinstalled.Registry.DisplayVersion
    executableSha256 = $executableSha256
    firstLaunchEvents = $first.NewEventNames
    relaunchEvents = $second.NewEventNames
    reinstallLaunchEvents = $third.NewEventNames
    firstLaunchResponding = $first.Responding
    relaunchResponding = $second.Responding
    reinstallResponding = $third.Responding
    managedFontCacheStable = $true
    uninstallPreservedProfile = $true
  } | ConvertTo-Json -Depth 4
} finally {
  Stop-Application -Process $third.Process
}
