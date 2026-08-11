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

$installation = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
if ($installation.ExitCode -ne 0) {
  throw "NSIS installer exited with code $($installation.ExitCode)"
}

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\One-Click Subtitles Generator'
$installed = Get-ItemProperty -LiteralPath $uninstallKey
if ($installed.DisplayVersion -ne $ExpectedVersion) {
  throw "Installed version $($installed.DisplayVersion) does not match $ExpectedVersion"
}

$installRoot = $installed.InstallLocation.Trim('"')
$executable = [IO.Path]::GetFullPath((Join-Path $installRoot 'osg-desktop.exe'))
if (-not $executable.StartsWith(
  [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\',
  [StringComparison]::OrdinalIgnoreCase
)) {
  throw "Installed executable escaped LOCALAPPDATA: $executable"
}
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "Installed executable is missing: $executable"
}

$app = Start-Process -FilePath $executable -PassThru
$logPath = Join-Path $profileRoot 'logs\osg.log'
$deadline = (Get-Date).AddMinutes(2)
$events = @()
try {
  do {
    Start-Sleep -Milliseconds 500
    if ($app.HasExited) {
      throw "Installed application exited before readiness with code $($app.ExitCode)"
    }
    if (Test-Path -LiteralPath $logPath -PathType Leaf) {
      $events = @(
        Get-Content -LiteralPath $logPath |
          ForEach-Object { $_ | ConvertFrom-Json }
      )
    }
    $ready = $events | Where-Object event -eq 'app.ready' | Select-Object -Last 1
  } until ($ready -or (Get-Date) -ge $deadline)

  if (-not $ready) {
    throw 'Installed application did not reach app.ready within two minutes'
  }
  $startIndex = -1
  $fontIndex = -1
  $readyIndex = -1
  for ($index = 0; $index -lt $events.Count; $index += 1) {
    if ($startIndex -lt 0 -and $events[$index].event -eq 'app.start') {
      $startIndex = $index
    }
    if ($fontIndex -lt 0 -and $events[$index].event -eq 'ui-font.ready') {
      $fontIndex = $index
    }
    if ($readyIndex -lt 0 -and $events[$index].event -eq 'app.ready') {
      $readyIndex = $index
    }
  }
  if (-not (0 -le $startIndex -and $startIndex -lt $fontIndex -and $fontIndex -lt $readyIndex)) {
    throw 'Installed application readiness events were absent or out of order'
  }
  if ($events | Where-Object event -eq 'ui-font.unavailable') {
    throw 'Managed UI font was unavailable during clean first launch'
  }

  $process = Get-Process -Id $app.Id
  if (-not $process.Responding) {
    throw 'Installed application window is not responding'
  }
  [pscustomobject]@{
    version = $installed.DisplayVersion
    executableSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    firstLaunchEvents = @($events | ForEach-Object event)
    responding = $process.Responding
  } | ConvertTo-Json -Depth 4
} finally {
  if (-not $app.HasExited) {
    [void]$app.CloseMainWindow()
    if (-not $app.WaitForExit(10000)) {
      Stop-Process -Id $app.Id
    }
  }
}
