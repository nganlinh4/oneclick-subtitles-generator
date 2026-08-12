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
$smokeStartedAt = Get-Date
$diagnosticLog = Join-Path ([IO.Path]::GetFullPath(
  (Join-Path $env:LOCALAPPDATA 'io.github.nganlinh4.oneclicksubtitles')
)) 'logs\osg.log'
$diagnosticEvidence = Join-Path $env:RUNNER_TEMP 'osg-updater-diagnostics.log'

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

  $Process.Refresh()
  if ($Process.HasExited) {
    throw 'Application exited before the graceful close request'
  }
  if ($Process.MainWindowHandle -eq [IntPtr]::Zero -or -not $Process.Responding) {
    throw 'Application was not ready for a graceful close'
  }
  $closeEventsBefore = Get-DiagnosticEventCount -Name 'app.close_requested'
  if (-not $Process.CloseMainWindow() -or -not $Process.WaitForExit(30000)) {
    Stop-Process -Id $Process.Id -ErrorAction SilentlyContinue
    throw 'Application did not accept a graceful close'
  }
  if ($Process.ExitCode -ne 0) {
    throw "Application exited with code $($Process.ExitCode) after the graceful close request"
  }
  $closeEventsAfter = Get-DiagnosticEventCount -Name 'app.close_requested'
  if ($closeEventsAfter -ne ($closeEventsBefore + 1)) {
    throw 'Application did not flush exactly one graceful-close diagnostic'
  }
}

function Get-DiagnosticEventCount {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Test-Path -LiteralPath $diagnosticLog -PathType Leaf)) {
    return 0
  }
  @(
    Get-Content -LiteralPath $diagnosticLog -Tail 512 |
      ForEach-Object {
        try {
          $_ | ConvertFrom-Json
        } catch {
          # The process may be flushing one final bounded JSON line.
        }
      } |
      Where-Object event -eq $Name
  ).Count
}

function Wait-ForReadyApplicationWindow {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][int]$MinimumReadyEventCount,
    [Parameter(Mandatory = $true)][string]$Phase
  )

  $deadline = (Get-Date).AddMinutes(2)
  do {
    Start-Sleep -Milliseconds 200
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "$Phase application exited before its window became ready"
    }
    $readyEvents = Get-DiagnosticEventCount -Name 'app.ready'
    $inputIdle = $false
    if ($Process.MainWindowHandle -ne [IntPtr]::Zero -and $Process.Responding) {
      try {
        $inputIdle = $Process.WaitForInputIdle(1000)
      } catch {
        $inputIdle = $false
      }
    }
    if ($readyEvents -ge $MinimumReadyEventCount -and $inputIdle) {
      return
    }
  } while ((Get-Date) -lt $deadline)
  throw "$Phase application did not expose a ready, responsive window within two minutes"
}

function Get-UpdaterFailurePhase {
  if (-not (Test-Path -LiteralPath $diagnosticLog -PathType Leaf)) {
    return $null
  }
  $allowed = @{
    'app-update.download_failed' = @('transport-or-signature')
    'app-update.install_failed' = @('extract-or-launch')
    'app-update.cancel_requested' = @('user', 'protocol')
  }
  foreach ($line in @(Get-Content -LiteralPath $diagnosticLog -Tail 256)) {
    try {
      $entry = $line | ConvertFrom-Json
      if ($allowed.ContainsKey([string]$entry.event) `
          -and [string]$entry.reason -in $allowed[[string]$entry.event]) {
        return "$($entry.event):$($entry.reason)"
      }
    } catch {
      # A partial last line may be observed while the process is flushing its bounded JSON log.
    }
  }
  $null
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
  $readyEventsBeforeBase = Get-DiagnosticEventCount -Name 'app.ready'
  $debugPort = Get-FreeLoopbackPort
  try {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$debugPort"
    $baseProcess = Start-Process -FilePath $executable -PassThru
  } finally {
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  }
  Write-SmokePhase -Name 'base-application-launched'
  $trigger = Invoke-UpdaterInspection -Port $debugPort -Mode 'trigger'
  Write-SmokePhase -Name 'update-accepted'
  $exitDeadline = (Get-Date).AddMinutes(5)
  while (-not $baseProcess.HasExited -and (Get-Date) -lt $exitDeadline) {
    $failurePhase = Get-UpdaterFailurePhase
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
  Wait-ForReadyApplicationWindow `
    -Process $updatedProcess `
    -MinimumReadyEventCount ($readyEventsBeforeBase + 2) `
    -Phase 'updater-relaunched'
  Write-SmokePhase -Name 'updated-application-ready'
  Stop-Gracefully -Process $updatedProcess
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
  $verify = Invoke-UpdaterInspection -Port $verificationPort -Mode 'verify'
  Write-SmokePhase -Name 'updated-state-verified'
  Stop-Gracefully -Process $verificationProcess
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

  $events = @(Get-Content -LiteralPath $diagnosticLog | Where-Object { $_.Length -gt 0 } |
    ForEach-Object { $_ | ConvertFrom-Json })
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
    verify = $verify
    preservedSettingsProjectAndHistory = $true
    signedNsisRelaunch = $true
  } | ConvertTo-Json -Depth 5
} finally {
  if (Test-Path -LiteralPath $diagnosticLog -PathType Leaf) {
    $boundedUpdateEvents = @(Get-Content -LiteralPath $diagnosticLog -Tail 256 |
      ForEach-Object {
        try {
          $entry = $_ | ConvertFrom-Json
          if ([string]$entry.event -like 'app-update.*') {
            $entry | ConvertTo-Json -Compress
          }
        } catch {
          # Ignore a partial last line; only complete path-free diagnostic records are evidence.
        }
      })
    [IO.File]::WriteAllLines(
      $diagnosticEvidence,
      $boundedUpdateEvents,
      [Text.UTF8Encoding]::new($false)
    )
  }
  Remove-Item Env:OSG_UPDATER_FIXTURE_PFX_PASSWORD -ErrorAction SilentlyContinue
  if ($null -ne $updatedProcess -and -not $updatedProcess.HasExited) {
    Stop-Process -Id $updatedProcess.Id -ErrorAction SilentlyContinue
  }
  if ($null -ne $verificationProcess -and -not $verificationProcess.HasExited) {
    Stop-Process -Id $verificationProcess.Id -ErrorAction SilentlyContinue
  }
  if ($null -ne $baseProcess -and -not $baseProcess.HasExited) {
    Stop-Process -Id $baseProcess.Id -ErrorAction SilentlyContinue
  }
  if ($null -ne $server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
  }
  if ($null -ne $certificate) {
    $certificate.Dispose()
  }
  if ($null -ne $certificateKey) {
    $certificateKey.Dispose()
  }
}
