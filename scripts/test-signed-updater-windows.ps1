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
$rootStore = $null
$baseProcess = $null
$updatedProcess = $null

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
foreach ($candidate in @($resultPath, $fixture.TrimEnd('\') + '\')) {
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
    [Parameter(Mandatory = $true)][string]$Mode
  )

  $screenshot = Join-Path $env:RUNNER_TEMP "osg-updater-$Mode.png"
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

function Stop-Gracefully {
  param([Parameter(Mandatory = $true)]$Process)

  if ($Process.HasExited) {
    return
  }
  if (-not $Process.CloseMainWindow() -or -not $Process.WaitForExit(15000)) {
    Stop-Process -Id $Process.Id -ErrorAction SilentlyContinue
    throw 'Updated application did not accept a graceful close'
  }
}

$pfxPath = Join-Path $env:RUNNER_TEMP 'osg-updater-fixture.pfx'
$readyPath = Join-Path $env:RUNNER_TEMP 'osg-updater-fixture.ready.json'
$serverOutput = Join-Path $env:RUNNER_TEMP 'osg-updater-fixture.stdout.log'
$serverError = Join-Path $env:RUNNER_TEMP 'osg-updater-fixture.stderr.log'
foreach ($path in @($pfxPath, $readyPath, $serverOutput, $serverError)) {
  if (Test-Path -LiteralPath $path) {
    throw "Signed updater temporary path was not clean: $path"
  }
}

try {
  $passwordBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  $pfxPassword = [Convert]::ToBase64String($passwordBytes)
  [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
  $securePassword = ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force
  $certificate = New-SelfSignedCertificate `
    -Subject 'CN=localhost' `
    -DnsName 'localhost' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddHours(2) `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')
  Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $securePassword | Out-Null
  $rootStore = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
  $rootStore.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  $rootStore.Add($certificate)

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
  $debugPort = Get-FreeLoopbackPort
  try {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$debugPort"
    $baseProcess = Start-Process -FilePath $executable -PassThru
  } finally {
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  }
  $trigger = Invoke-UpdaterInspection -Port $debugPort -Mode 'trigger'
  if (-not $baseProcess.WaitForExit(300000)) {
    Stop-Process -Id $baseProcess.Id -ErrorAction SilentlyContinue
    throw 'Base application did not exit after the signed update was accepted'
  }
  if ($baseProcess.ExitCode -ne 0) {
    throw "Base application exited with code $($baseProcess.ExitCode) during update"
  }

  $updateDeadline = (Get-Date).AddMinutes(3)
  $updatedRegistry = $null
  do {
    Start-Sleep -Milliseconds 500
    $updatedRegistry = Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction SilentlyContinue
  } until ($updatedRegistry.DisplayVersion -eq $UpdatedVersion -or (Get-Date) -ge $updateDeadline)
  if ($updatedRegistry.DisplayVersion -ne $UpdatedVersion) {
    throw 'Signed NSIS updater did not replace the installed application version'
  }

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

  $verify = Invoke-UpdaterInspection -Port $debugPort -Mode 'verify'
  Stop-Gracefully -Process $updatedProcess
  $updatedProcess = $null

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

  $logPath = Join-Path ([IO.Path]::GetFullPath(
    (Join-Path $env:LOCALAPPDATA 'io.github.nganlinh4.oneclicksubtitles')
  )) 'logs\osg.log'
  $events = @(Get-Content -LiteralPath $logPath | Where-Object { $_.Length -gt 0 } |
    ForEach-Object { $_ | ConvertFrom-Json })
  if (-not ($events | Where-Object {
      $_.event -eq 'app-update.checking' -and $_.version -eq $UpdatedVersion
    }) -or -not ($events | Where-Object {
      $_.event -eq 'app-update.installing' -and $_.version -eq $UpdatedVersion
    })) {
    throw 'Signed updater diagnostics omitted the checked and installed version'
  }

  [pscustomobject]@{
    baseVersion = $BaseVersion
    updatedVersion = $UpdatedVersion
    projectId = $projectId
    manifestRequests = $manifestRequests.Count
    updateRequests = $updateRequests.Count
    trigger = $trigger
    verify = $verify
    preservedSettingsProjectAndHistory = $true
    signedNsisRelaunch = $true
  } | ConvertTo-Json -Depth 5
} finally {
  Remove-Item Env:OSG_UPDATER_FIXTURE_PFX_PASSWORD -ErrorAction SilentlyContinue
  if ($null -ne $updatedProcess -and -not $updatedProcess.HasExited) {
    Stop-Process -Id $updatedProcess.Id -ErrorAction SilentlyContinue
  }
  if ($null -ne $baseProcess -and -not $baseProcess.HasExited) {
    Stop-Process -Id $baseProcess.Id -ErrorAction SilentlyContinue
  }
  if ($null -ne $server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
  }
  if ($null -ne $rootStore) {
    if ($null -ne $certificate) {
      $rootStore.Remove($certificate)
    }
    $rootStore.Close()
  }
  if ($null -ne $certificate) {
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -ErrorAction SilentlyContinue
  }
}
