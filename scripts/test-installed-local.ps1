#requires -Version 7.2

<#
.SYNOPSIS
  Runs the installed-EXE smoke test (scripts/test-installed-windows.ps1) locally, in a bounded
  sandbox, without touching this machine's real OSG profile, registry, or Desktop.

.DESCRIPTION
  scripts/test-installed-windows.ps1 refuses to run unless it is on an isolated CI runner
  ($env:CI -eq 'true' and $env:RUNNER_TEMP set). Every side effect it performs was designed for a
  runner that is destroyed after the job. This wrapper asserts the same isolation contract on a
  developer machine instead of pretending to be CI:

    1. Resolves the five real-machine surfaces the installed app and its NSIS installer actually
       touch (app-data directory, uninstall registry key, default install directory, Start Menu
       shortcut, Desktop shortcut) and refuses to proceed unless every one of them is verified
       absent -- exactly the guard scripts/test-installed-windows.ps1 already applies to the first
       of those five, extended to all five because this machine is not ephemeral.
    2. Creates a run-scoped sandbox under this repository's existing managed local cache
       (scripts/dev-cache.ps1, "staging" lane): %LOCALAPPDATA%\OSG-Development\cache\staging\
       installed-smoke\<runId>.
    3. Spawns the UNMODIFIED scripts/test-installed-windows.ps1 as a real child process with
       CI=true and RUNNER_TEMP=<sandbox> set only on that child's environment block -- never on
       this process's own $env:, so the isolation contract cannot leak into an interactive session
       this script happens to be dot-sourced into. This is a local assertion of the same contract
       CI asserts, not an impersonation of CI.
    4. After the child exits (success or failure): uninstalls silently, deletes the app-data
       directory this run created (NSIS preserves it by design; CI never needed to clean it up
       because the whole runner is discarded), verifies no registry/shortcut/install-dir residue
       survived, releases the sandbox lease, and deletes the sandbox. Any residue is a failure even
       if the inner smoke reported success.

  See docs/rewrite/INSTALLED_SMOKE_LOCAL.md for the full side-effect catalog and the collision
  evidence this design is based on.

.PARAMETER InstallerPath
  Path to the locally built NSIS installer under test (same as scripts/test-installed-windows.ps1).

.PARAMETER ExpectedVersion
  Version the installed DisplayVersion must match (same as scripts/test-installed-windows.ps1).

.PARAMETER ResultPath
  Durable destination for the structured JSON result. Defaults next to the sandbox (a sibling of
  the deleted <runId> directory, so it survives cleanup). Unlike
  scripts/test-installed-windows.ps1's own -ResultPath, this does not need to already live inside
  the sandbox -- the wrapper copies the child's result out before cleanup removes it.

.PARAMETER IncludeMediaFlow
  Forwarded to scripts/test-installed-windows.ps1 unchanged.

.PARAMETER LocalMediaPath
  A reviewed local-media fixture anywhere on disk. The wrapper copies it into the sandbox (the
  inner script requires -LocalMediaPath to already live under RUNNER_TEMP, and a fresh per-run
  sandbox cannot be known to the caller in advance).

.PARAMETER CacheRoot
  Overrides the managed local cache root (default %LOCALAPPDATA%\OSG-Development\cache), matching
  scripts/dev-cache.ps1's own -CacheRoot/OSG_DEV_CACHE_ROOT convention.

.PARAMETER ProfileRootOverride
.PARAMETER UninstallKeyOverride
.PARAMETER InstallDirOverride
.PARAMETER DesktopShortcutOverride
.PARAMETER StartMenuShortcutOverride
  Advanced overrides for the five guarded real-machine surfaces. Exist so
  scripts/test-installed-local.test.ps1 can exercise the guard and cleanup logic against a
  synthetic sandbox instead of ever touching this machine's real profile, registry, or Desktop.
  Leave unset for a real run -- the defaults are the exact paths the installed app and its NSIS
  installer use.

.EXAMPLE
  scripts/test-installed-local.ps1 -InstallerPath .\target\...\osg-desktop_1.2.3_x64-setup.exe `
    -ExpectedVersion 1.2.3 -WhatIf

  Prints the full planned side-effect list -- including the current state of every guarded
  surface -- without installing, launching, or writing anything.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,

  [string]$ResultPath,

  [switch]$IncludeMediaFlow,

  [string]$LocalMediaPath,

  [string]$CacheRoot,

  [string]$ProfileRootOverride,
  [string]$UninstallKeyOverride,
  [string]$InstallDirOverride,
  [string]$DesktopShortcutOverride,
  [string]$StartMenuShortcutOverride
)

$ErrorActionPreference = 'Stop'
$script:ProductName = 'One-Click Subtitles Generator'
$script:AppIdentifier = 'io.github.nganlinh4.oneclicksubtitles'
$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:DevCachePath = Join-Path $PSScriptRoot 'dev-cache.ps1'
$script:CiScriptPath = Join-Path $PSScriptRoot 'test-installed-windows.ps1'

function Resolve-GuardedSurfaces {
  # The five real-machine surfaces the installed app and its NSIS installer touch that are NOT
  # relocatable into the sandbox without admin rights or testing a different binary than CI does.
  # See docs/rewrite/INSTALLED_SMOKE_LOCAL.md for why each one is fixed.
  [pscustomobject]@{
    ProfileRoot = if ($ProfileRootOverride) {
      $ProfileRootOverride
    } else {
      Join-Path $env:LOCALAPPDATA $script:AppIdentifier
    }
    UninstallKey = if ($UninstallKeyOverride) {
      $UninstallKeyOverride
    } else {
      "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$script:ProductName"
    }
    InstallDir = if ($InstallDirOverride) {
      $InstallDirOverride
    } else {
      Join-Path $env:LOCALAPPDATA $script:ProductName
    }
    DesktopShortcut = if ($DesktopShortcutOverride) {
      $DesktopShortcutOverride
    } else {
      Join-Path ([Environment]::GetFolderPath('Desktop')) "$script:ProductName.lnk"
    }
    StartMenuShortcut = if ($StartMenuShortcutOverride) {
      $StartMenuShortcutOverride
    } else {
      Join-Path ([Environment]::GetFolderPath('Programs')) "$script:ProductName.lnk"
    }
  }
}

function Get-SurfaceState {
  param([Parameter(Mandatory = $true)]$Surfaces)

  [ordered]@{
    profileRoot = Test-Path -LiteralPath $Surfaces.ProfileRoot
    uninstallKey = Test-Path -LiteralPath $Surfaces.UninstallKey
    installDir = Test-Path -LiteralPath $Surfaces.InstallDir
    desktopShortcut = Test-Path -LiteralPath $Surfaces.DesktopShortcut
    startMenuShortcut = Test-Path -LiteralPath $Surfaces.StartMenuShortcut
  }
}

function Get-PresentSurfaceNames {
  param([Parameter(Mandatory = $true)]$State)

  # Explicit script blocks, not the "ForEach-Object Key" member-name shorthand: that shorthand
  # narrates every property access as a "What if: Performing the operation..." line once
  # $WhatIfPreference is set script-wide, which would bury the actual plan output in noise.
  @($State.GetEnumerator() | Where-Object { $_.Value } | ForEach-Object { $_.Key })
}

function Get-SurfacePath {
  param(
    [Parameter(Mandatory = $true)]$Surfaces,
    [Parameter(Mandatory = $true)][string]$SurfaceName
  )

  switch ($SurfaceName) {
    'profileRoot' { $Surfaces.ProfileRoot }
    'uninstallKey' { $Surfaces.UninstallKey }
    'installDir' { $Surfaces.InstallDir }
    'desktopShortcut' { $Surfaces.DesktopShortcut }
    'startMenuShortcut' { $Surfaces.StartMenuShortcut }
    default { throw "Unknown guarded surface name: $SurfaceName" }
  }
}

function Assert-MachineIsClean {
  param(
    [Parameter(Mandatory = $true)]$Surfaces,
    [Parameter(Mandatory = $true)]$State
  )

  $present = Get-PresentSurfaceNames -State $State
  if ($present.Count -gt 0) {
    $detail = @(
      $present | ForEach-Object { "$_ = $(Get-SurfacePath -Surfaces $Surfaces -SurfaceName $_)" }
    ) -join '; '
    throw (
      "Refusing to run the local installed-EXE smoke: real machine state already occupies " +
      "$($present.Count) of 5 guarded surfaces this run cannot safely share ($detail). " +
      "Installing over it would corrupt a real installation's registry entry and app data. " +
      "See docs/rewrite/INSTALLED_SMOKE_LOCAL.md for why these cannot be relocated and what to " +
      "do instead (temporarily move the real install aside, or run in an environment where none " +
      "of these five paths already exist)."
    )
  }
}

function New-RunId {
  $timestamp = [DateTime]::UtcNow.ToString('yyyyMMdd\THHmmss\Z')
  $random = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  "$timestamp-$random"
}

function Invoke-DevCache {
  # In-process invocation with hashtable splatting -- the same pattern
  # scripts/dev-cache.test.ps1's own Invoke-CacheManager uses -- so switch/boolean parameters
  # (Apply, Confirm) bind as real typed values instead of relying on external-process command-line
  # re-parsing of ":"-syntax tokens.
  param([Parameter(Mandatory = $true)][hashtable]$Parameters)

  $boundParameters = [hashtable]$Parameters.Clone()
  if ($CacheRoot) {
    $boundParameters['CacheRoot'] = $CacheRoot
  }
  & $script:DevCachePath @boundParameters
}

function Enter-InstalledSmokeSandbox {
  # Reclaim stale runs before leasing, mirroring e2e/support/stagingLease.js's own acquire flow,
  # so a prior interrupted local run does not accumulate sandbox bytes forever. Like that JS
  # helper, a failure here is not swallowed -- it means the shared cache itself is unhealthy.
  Invoke-DevCache -Parameters @{
    Action = 'Prune'; Apply = $true; Confirm = $false; ProtectUnit = 'apps-e2e'
  } | Out-Null

  $leaseJson = Invoke-DevCache -Parameters @{
    Action = 'Lease'; LeaseOperation = 'Acquire'; Lane = 'staging'; LeaseProcessId = $PID
  }
  $lease = $leaseJson | ConvertFrom-Json
  if ($lease.lane -cne 'staging' -or [string]::IsNullOrWhiteSpace($lease.leaseId) `
      -or [string]::IsNullOrWhiteSpace($lease.stagingRoot)) {
    throw 'Managed staging lease returned an unexpected shape.'
  }

  $runId = New-RunId
  $sandboxRoot = Join-Path $lease.stagingRoot (Join-Path 'installed-smoke' $runId)
  if (Test-Path -LiteralPath $sandboxRoot) {
    throw "Sandbox run directory was not clean: $sandboxRoot"
  }
  New-Item -ItemType Directory -Path $sandboxRoot -Force | Out-Null

  [pscustomobject]@{
    LeaseId = $lease.leaseId
    StagingRoot = $lease.stagingRoot
    RunId = $runId
    SandboxRoot = $sandboxRoot
  }
}

function Exit-InstalledSmokeSandbox {
  param([Parameter(Mandatory = $true)]$Sandbox)

  if (Test-Path -LiteralPath $Sandbox.SandboxRoot) {
    Remove-Item -LiteralPath $Sandbox.SandboxRoot -Recurse -Force
  }
  try {
    Invoke-DevCache -Parameters @{
      Action = 'Lease'; LeaseOperation = 'Release'; Lane = 'staging'; LeaseId = $Sandbox.LeaseId
    } | Out-Null
  } finally {
    Invoke-DevCache -Parameters @{
      Action = 'Prune'; Apply = $true; Confirm = $false; ProtectUnit = 'apps-e2e'
    } | Out-Null
  }
}

function Copy-LocalMediaFixtureIntoSandbox {
  param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$SandboxRoot
  )

  $resolvedSource = [IO.Path]::GetFullPath($SourcePath)
  if (-not (Test-Path -LiteralPath $resolvedSource -PathType Leaf)) {
    throw "Local-media fixture does not exist: $resolvedSource"
  }
  $destination = Join-Path $SandboxRoot ([IO.Path]::GetFileName($resolvedSource))
  Copy-Item -LiteralPath $resolvedSource -Destination $destination
  $destination
}

function Start-CiScriptChild {
  param(
    [Parameter(Mandatory = $true)][string]$SandboxRoot,
    [Parameter(Mandatory = $true)][string]$ChildResultPath,
    [string]$ChildLocalMediaPath
  )

  $childArguments = [Collections.Generic.List[string]]::new()
  foreach ($token in @(
      '-NoProfile', '-NonInteractive', '-File', $script:CiScriptPath,
      '-InstallerPath', $InstallerPath,
      '-ExpectedVersion', $ExpectedVersion,
      '-ResultPath', $ChildResultPath
    )) {
    $childArguments.Add($token)
  }
  if ($IncludeMediaFlow) {
    $childArguments.Add('-IncludeMediaFlow')
  }
  if ($ChildLocalMediaPath) {
    $childArguments.Add('-LocalMediaPath')
    $childArguments.Add($ChildLocalMediaPath)
  }

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Command pwsh).Source
  $startInfo.WorkingDirectory = $script:RepoRoot
  $startInfo.UseShellExecute = $false
  foreach ($argument in $childArguments) {
    $startInfo.ArgumentList.Add($argument)
  }
  # Scoped to this one child process only (ProcessStartInfo.Environment is a private copy; it does
  # not touch this process's own $env:). This is a LOCAL assertion of the same isolation contract
  # CI's runner provides, not an impersonation of CI -- the wrapper's own process never claims
  # $env:CI, so a caller who dot-sources this script cannot end up with a polluted interactive
  # session, and nothing outside this one child ever observes CI=true.
  $startInfo.Environment['CI'] = 'true'
  $startInfo.Environment['RUNNER_TEMP'] = $SandboxRoot

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $process.WaitForExit()
  $process.ExitCode
}

function Uninstall-IfPresent {
  # Deliberately not shared with scripts/test-installed-windows.ps1's own Uninstall-Application:
  # that function takes the in-memory object its own Install-Application returned in the SAME
  # process. This wrapper's install happened in a spawned child process, so cleanup here discovers
  # the current install fresh from the registry instead. The NSIS silent-uninstall invocation
  # itself is a stable three-line idiom, not workflow logic, so duplicating just that idiom (rather
  # than threading an install-result object across a process boundary) is the smaller risk.
  param([Parameter(Mandatory = $true)]$Surfaces)

  if (-not (Test-Path -LiteralPath $Surfaces.UninstallKey)) {
    return
  }
  $installed = Get-ItemProperty -LiteralPath $Surfaces.UninstallKey
  $installRoot = [IO.Path]::GetFullPath([string]$installed.InstallLocation.Trim('"'))
  $uninstaller = Join-Path $installRoot 'uninstall.exe'
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    Write-Warning "Cleanup: uninstall registry key is present but uninstall.exe is missing at $uninstaller; cannot silently uninstall."
    return
  }
  $result = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  if ($result.ExitCode -ne 0) {
    throw "Cleanup uninstaller exited with code $($result.ExitCode)."
  }
}

function Complete-InstalledSmokeCleanup {
  param([Parameter(Mandatory = $true)]$Surfaces)

  Uninstall-IfPresent -Surfaces $Surfaces

  # Everything the NSIS uninstaller is responsible for should be gone now. Anything still present
  # is unexpected residue -- the exact contract the mission asked this lane to enforce.
  $afterUninstall = Get-SurfaceState -Surfaces $Surfaces
  $residue = @(Get-PresentSurfaceNames -State $afterUninstall | Where-Object { $_ -ne 'profileRoot' })

  # The app-data directory is preserved by NSIS uninstall by design (matches
  # scripts/test-installed-windows.ps1:3026-3028's own assertion that uninstall must NOT delete
  # it). This run's own pre-flight guard already proved it was absent before we started, so it is
  # safe -- and, on a persistent developer machine rather than a discarded CI runner, necessary --
  # to remove it explicitly now.
  if (Test-Path -LiteralPath $Surfaces.ProfileRoot) {
    Remove-Item -LiteralPath $Surfaces.ProfileRoot -Recurse -Force
  }

  # Force-remove any uninstaller residue too, so a bug in the NSIS uninstaller never leaves this
  # developer machine dirtier than it was before the run, then still fail loudly below.
  # Remove-Item works across the registry provider the same way it does the filesystem, so every
  # remaining surface -- including the uninstall registry key -- is removed the same way.
  foreach ($surfaceName in $residue) {
    $path = Get-SurfacePath -Surfaces $Surfaces -SurfaceName $surfaceName
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }

  $final = Get-SurfaceState -Surfaces $Surfaces
  $finalResidue = Get-PresentSurfaceNames -State $final
  if ($finalResidue.Count -gt 0) {
    throw (
      "Local installed-EXE smoke left residue behind after cleanup and forced removal: " +
      "$($finalResidue -join ', '). Inspect the machine manually before running again."
    )
  }
  if ($residue.Count -gt 0) {
    throw (
      "Local installed-EXE smoke's own uninstaller did not remove: $($residue -join ', '). " +
      "The residue has been force-removed so the machine is clean, but this is reported as a " +
      "failure because the NSIS uninstaller should have removed it itself."
    )
  }
}

function Write-Plan {
  param(
    [Parameter(Mandatory = $true)]$Surfaces,
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][bool]$InstallerExists
  )

  $wouldProceed = (Get-PresentSurfaceNames -State $State).Count -eq 0 -and $InstallerExists
  $plan = [ordered]@{
    installerPath = [IO.Path]::GetFullPath($InstallerPath)
    installerExists = $InstallerExists
    expectedVersion = $ExpectedVersion
    installerFlags = '/S (silent, per-user default install directory; no /D override -- see docs/rewrite/INSTALLED_SMOKE_LOCAL.md)'
    includeMediaFlow = [bool]$IncludeMediaFlow
    localMediaPath = $LocalMediaPath
    sandboxParent = 'managed staging lane under %LOCALAPPDATA%\OSG-Development\cache\staging\installed-smoke\<runId>'
    childEnvironmentScoping = 'CI=true and RUNNER_TEMP=<sandbox> set only on the spawned pwsh child process environment; this process''s own $env: is never modified'
    guardedSurfaces = [ordered]@{
      profileRoot = [ordered]@{ path = $Surfaces.ProfileRoot; present = $State.profileRoot }
      uninstallKey = [ordered]@{ path = $Surfaces.UninstallKey; present = $State.uninstallKey }
      installDir = [ordered]@{ path = $Surfaces.InstallDir; present = $State.installDir }
      desktopShortcut = [ordered]@{ path = $Surfaces.DesktopShortcut; present = $State.desktopShortcut }
      startMenuShortcut = [ordered]@{ path = $Surfaces.StartMenuShortcut; present = $State.startMenuShortcut }
    }
    wouldProceed = $wouldProceed
    cleanupPlan = @(
      'silently uninstall (/S) if a registry key/executable from this run remains',
      'delete the app-data directory this run created (NSIS preserves it by design)',
      'force-remove and report as failure any uninstaller residue (registry key, install dir, shortcuts)',
      'release the staging lease and delete the sandbox directory'
    )
  }
  $plan | ConvertTo-Json -Depth 6
}

$surfaces = Resolve-GuardedSurfaces
$state = Get-SurfaceState -Surfaces $surfaces
$installerExists = Test-Path -LiteralPath $InstallerPath -PathType Leaf

if ($WhatIfPreference) {
  Write-Plan -Surfaces $surfaces -State $state -InstallerExists $installerExists
  return
}

if (-not $installerExists) {
  throw "Installer does not exist: $([IO.Path]::GetFullPath($InstallerPath))"
}
Assert-MachineIsClean -Surfaces $surfaces -State $state

if (-not $PSCmdlet.ShouldProcess(
    'this developer machine (app data, registry, install directory, shortcuts)',
    'install, exercise, and uninstall the local NSIS build'
  )) {
  return
}

$sandbox = Enter-InstalledSmokeSandbox

# Cleanup must never silently replace a primary failure (PowerShell's `finally` does exactly that
# if the cleanup block itself throws). Capture each independently and combine them if both fail,
# mirroring e2e/support/stagingLease.js's own withStagingLease AggregateError pattern.
$primaryError = $null
try {
  $childLocalMediaPath = $null
  if ($LocalMediaPath) {
    $childLocalMediaPath = Copy-LocalMediaFixtureIntoSandbox `
      -SourcePath $LocalMediaPath `
      -SandboxRoot $sandbox.SandboxRoot
  }
  $childResultPath = Join-Path $sandbox.SandboxRoot 'osg-installed-branch-result.json'
  $exitCode = Start-CiScriptChild `
    -SandboxRoot $sandbox.SandboxRoot `
    -ChildResultPath $childResultPath `
    -ChildLocalMediaPath $childLocalMediaPath

  $durableResultPath = if ($ResultPath) {
    [IO.Path]::GetFullPath($ResultPath)
  } else {
    Join-Path $sandbox.StagingRoot (Join-Path 'installed-smoke' "$($sandbox.RunId)-result.json")
  }
  if (Test-Path -LiteralPath $childResultPath -PathType Leaf) {
    Copy-Item -LiteralPath $childResultPath -Destination $durableResultPath -Force
    Write-Host "Result evidence: $durableResultPath"
  }
  if ($exitCode -ne 0) {
    throw "scripts/test-installed-windows.ps1 exited with code $exitCode."
  }
} catch {
  $primaryError = $_
}

$cleanupError = $null
try {
  Complete-InstalledSmokeCleanup -Surfaces $surfaces
  Exit-InstalledSmokeSandbox -Sandbox $sandbox
} catch {
  $cleanupError = $_
}

if ($primaryError -and $cleanupError) {
  throw (
    "Local installed-EXE smoke failed AND cleanup failed.`n" +
    "Primary failure: $($primaryError.Exception.Message)`n" +
    "Cleanup failure: $($cleanupError.Exception.Message)"
  )
}
if ($primaryError) {
  throw $primaryError
}
if ($cleanupError) {
  throw $cleanupError
}
