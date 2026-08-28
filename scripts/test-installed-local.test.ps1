#requires -Version 7.2

<#
.SYNOPSIS
  Argument-handling and dry-run coverage for scripts/test-installed-local.ps1, following the same
  hand-rolled harness scripts/dev-cache.test.ps1 uses (this repository has no Pester convention for
  testing a .ps1 script).

.DESCRIPTION
  This suite never installs, launches, or uninstalls anything, and never touches this machine's
  real OSG profile, registry, or Desktop -- every guarded surface is pointed at a synthetic path
  under an isolated temp root via the subject's own -ProfileRootOverride/-UninstallKeyOverride/
  -InstallDirOverride/-DesktopShortcutOverride/-StartMenuShortcutOverride parameters. It exercises
  only -WhatIf and the pre-flight guard (which throws before any mutation), matching what the
  mission scoped for this test: argument handling and dry-run output.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$subject = Join-Path $PSScriptRoot "test-installed-local.ps1"
$suiteRoot = Join-Path ([IO.Path]::GetTempPath()) ("osg-installed-local-tests-{0}" -f [Guid]::NewGuid().ToString("N"))
# One namespace for every synthetic registry-key fixture this suite creates. New-Item -Path on a
# multi-segment registry path creates every missing ancestor key too, so cleanup removes this
# whole namespace recursively in the suite-level `finally` below rather than per-test -- a per-test
# Remove-Item of only the leaf key it created would leave this ancestor behind as residue.
$registryFixtureRoot = 'HKCU:\Software\OSG-Installed-Local-Test-Fixture'
$script:passed = 0
$script:failed = 0

function Assert-True {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

function Assert-False {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if ($Condition) { throw $Message }
}

function Assert-Contains {
    param(
        [AllowEmptyString()][string]$Actual,
        [Parameter(Mandatory)][string]$Expected,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Actual.Contains($Expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Message`nExpected to find: $Expected`nActual: $Actual"
    }
}

function Invoke-Subject {
    param([Parameter(Mandatory)][hashtable]$Parameters)

    try {
        $lines = @(& $subject @Parameters *>&1)
        return [pscustomobject]@{
            Succeeded = $true
            Output = ($lines | Out-String)
            Error = $null
        }
    }
    catch {
        return [pscustomobject]@{
            Succeeded = $false
            Output = ((@($_) + @($_.ScriptStackTrace)) | Out-String)
            Error = $_
        }
    }
}

function Assert-Succeeds {
    param(
        [Parameter(Mandatory)]$Result,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Result.Succeeded) {
        throw "$Message`n$($Result.Output)"
    }
}

function Assert-FailsWith {
    param(
        [Parameter(Mandatory)]$Result,
        [Parameter(Mandatory)][string]$Text,
        [Parameter(Mandatory)][string]$Message
    )
    if ($Result.Succeeded) {
        throw "$Message`nThe command unexpectedly succeeded:`n$($Result.Output)"
    }
    Assert-Contains -Actual $Result.Output -Expected $Text -Message $Message
}

function Invoke-Test {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Body
    )
    try {
        & $Body
        $script:passed++
        Write-Host "PASS $Name" -ForegroundColor Green
    }
    catch {
        $script:failed++
        Write-Host "FAIL $Name" -ForegroundColor Red
        Write-Host $_
    }
}

function New-CleanOverrides {
    # A fully synthetic, currently-absent set of guarded-surface paths under the isolated suite
    # root -- never the real %LOCALAPPDATA%\io.github.nganlinh4.oneclicksubtitles, real registry
    # Uninstall key, or real Desktop/Start Menu.
    param([Parameter(Mandatory)][string]$Name)

    $root = Join-Path $suiteRoot $Name
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    [pscustomobject]@{
        Root = $root
        ProfileRootOverride = Join-Path $root "profile"
        UninstallKeyOverride = Join-Path $registryFixtureRoot $Name
        InstallDirOverride = Join-Path $root "install"
        DesktopShortcutOverride = Join-Path $root "desktop.lnk"
        StartMenuShortcutOverride = Join-Path $root "startmenu.lnk"
    }
}

function New-FakeInstaller {
    param([Parameter(Mandatory)][string]$Root)

    $path = Join-Path $Root "fake-installer.exe"
    [IO.File]::WriteAllBytes($path, [byte[]]::new(16))
    $path
}

New-Item -ItemType Directory -Path $suiteRoot | Out-Null
try {
    Invoke-Test "missing mandatory parameters fail closed" {
        $result = Invoke-Subject @{ ExpectedVersion = "1.0.0"; WhatIf = $true }
        Assert-FailsWith $result "InstallerPath" "Omitting -InstallerPath did not fail closed."

        $result2 = Invoke-Subject @{ InstallerPath = "does-not-matter.exe"; WhatIf = $true }
        Assert-FailsWith $result2 "ExpectedVersion" "Omitting -ExpectedVersion did not fail closed."
    }

    Invoke-Test "-WhatIf reports a missing installer without creating anything" {
        $overrides = New-CleanOverrides "missing-installer"
        $result = Invoke-Subject @{
            InstallerPath = (Join-Path $overrides.Root "nonexistent.exe")
            ExpectedVersion = "1.2.3"
            WhatIf = $true
            ProfileRootOverride = $overrides.ProfileRootOverride
            UninstallKeyOverride = $overrides.UninstallKeyOverride
            InstallDirOverride = $overrides.InstallDirOverride
            DesktopShortcutOverride = $overrides.DesktopShortcutOverride
            StartMenuShortcutOverride = $overrides.StartMenuShortcutOverride
        }
        Assert-Succeeds $result "-WhatIf with a missing installer should still print a plan, not throw."
        $plan = $result.Output | ConvertFrom-Json
        Assert-False $plan.installerExists "Plan claimed a nonexistent installer exists."
        Assert-False $plan.wouldProceed "A missing installer must never report wouldProceed=true."
        Assert-False (Test-Path -LiteralPath $overrides.ProfileRootOverride) "-WhatIf created the profile root."
    }

    Invoke-Test "-WhatIf on a fully clean synthetic sandbox reports wouldProceed and never mutates" {
        $overrides = New-CleanOverrides "clean-sandbox"
        $installer = New-FakeInstaller -Root $overrides.Root
        $result = Invoke-Subject @{
            InstallerPath = $installer
            ExpectedVersion = "1.2.3"
            WhatIf = $true
            ProfileRootOverride = $overrides.ProfileRootOverride
            UninstallKeyOverride = $overrides.UninstallKeyOverride
            InstallDirOverride = $overrides.InstallDirOverride
            DesktopShortcutOverride = $overrides.DesktopShortcutOverride
            StartMenuShortcutOverride = $overrides.StartMenuShortcutOverride
        }
        Assert-Succeeds $result "-WhatIf on a clean sandbox failed."
        $plan = $result.Output | ConvertFrom-Json
        Assert-True $plan.installerExists "Plan did not see the fake installer."
        Assert-True $plan.wouldProceed "A fully clean set of guarded surfaces must report wouldProceed=true."
        foreach ($surface in @(
            "profileRoot", "uninstallKey", "installDir", "desktopShortcut", "startMenuShortcut"
        )) {
            Assert-False $plan.guardedSurfaces.$surface.present "Plan reported a synthetic-clean surface as present: $surface"
        }
        Assert-False (Test-Path -LiteralPath $overrides.ProfileRootOverride) "-WhatIf created the profile root on a clean sandbox."
        Assert-False (Test-Path -LiteralPath $overrides.InstallDirOverride) "-WhatIf created the install directory."
        Assert-False (Test-Path -LiteralPath $overrides.UninstallKeyOverride) "-WhatIf created the registry fixture key."
    }

    Invoke-Test "-WhatIf reports every occupied guarded surface by name and path" {
        $overrides = New-CleanOverrides "occupied-sandbox"
        $installer = New-FakeInstaller -Root $overrides.Root
        New-Item -ItemType Directory -Path $overrides.ProfileRootOverride -Force | Out-Null
        New-Item -ItemType Directory -Path $overrides.InstallDirOverride -Force | Out-Null
        [IO.File]::WriteAllText($overrides.DesktopShortcutOverride, "not a real shortcut")
        New-Item -Path $overrides.UninstallKeyOverride -Force | Out-Null
        $result = Invoke-Subject @{
            InstallerPath = $installer
            ExpectedVersion = "1.2.3"
            WhatIf = $true
            ProfileRootOverride = $overrides.ProfileRootOverride
            UninstallKeyOverride = $overrides.UninstallKeyOverride
            InstallDirOverride = $overrides.InstallDirOverride
            DesktopShortcutOverride = $overrides.DesktopShortcutOverride
            StartMenuShortcutOverride = $overrides.StartMenuShortcutOverride
        }
        Assert-Succeeds $result "-WhatIf on an occupied sandbox failed."
        $plan = $result.Output | ConvertFrom-Json
        Assert-False $plan.wouldProceed "An occupied guarded surface must report wouldProceed=false."
        Assert-True $plan.guardedSurfaces.profileRoot.present "Plan missed the occupied profile root."
        Assert-True $plan.guardedSurfaces.installDir.present "Plan missed the occupied install directory."
        Assert-True $plan.guardedSurfaces.desktopShortcut.present "Plan missed the occupied desktop shortcut."
        Assert-True $plan.guardedSurfaces.uninstallKey.present "Plan missed the occupied registry fixture key."
        Assert-False $plan.guardedSurfaces.startMenuShortcut.present "Plan reported an absent surface as present."
    }

    Invoke-Test "a real invocation refuses before touching the cache root when a surface collides" {
        $overrides = New-CleanOverrides "guard-refuses"
        $installer = New-FakeInstaller -Root $overrides.Root
        New-Item -ItemType Directory -Path $overrides.InstallDirOverride -Force | Out-Null
        $cacheRoot = Join-Path $overrides.Root "dev-cache"

        $result = Invoke-Subject @{
            InstallerPath = $installer
            ExpectedVersion = "1.2.3"
            CacheRoot = $cacheRoot
            ProfileRootOverride = $overrides.ProfileRootOverride
            UninstallKeyOverride = $overrides.UninstallKeyOverride
            InstallDirOverride = $overrides.InstallDirOverride
            DesktopShortcutOverride = $overrides.DesktopShortcutOverride
            StartMenuShortcutOverride = $overrides.StartMenuShortcutOverride
        }
        Assert-FailsWith $result "installDir" "A real run with an occupied surface did not refuse to proceed."
        Assert-False (Test-Path -LiteralPath $cacheRoot) "The guard mutated the managed cache root before refusing."
    }

    Invoke-Test "the guard's advanced overrides never resolve to this machine's real surfaces" {
        # A structural regression check: if a future edit accidentally dropped an override branch,
        # this would silently start reading the real %LOCALAPPDATA%\...\oneclicksubtitles profile,
        # the real Uninstall registry key, or the real Desktop/Start Menu -- exactly what this
        # entire lane exists to avoid touching. Compare only when this developer machine's own
        # real surfaces are known (they may not exist on a different machine, which is fine).
        $overrides = New-CleanOverrides "override-isolation"
        $installer = New-FakeInstaller -Root $overrides.Root
        $result = Invoke-Subject @{
            InstallerPath = $installer
            ExpectedVersion = "1.2.3"
            WhatIf = $true
            ProfileRootOverride = $overrides.ProfileRootOverride
            UninstallKeyOverride = $overrides.UninstallKeyOverride
            InstallDirOverride = $overrides.InstallDirOverride
            DesktopShortcutOverride = $overrides.DesktopShortcutOverride
            StartMenuShortcutOverride = $overrides.StartMenuShortcutOverride
        }
        Assert-Succeeds $result "-WhatIf with full overrides failed."
        $plan = $result.Output | ConvertFrom-Json
        Assert-True (
            $plan.guardedSurfaces.profileRoot.path.StartsWith($suiteRoot, [StringComparison]::OrdinalIgnoreCase)
        ) "profileRoot override did not take effect -- plan resolved outside the isolated suite root."
        Assert-True (
            $plan.guardedSurfaces.installDir.path.StartsWith($suiteRoot, [StringComparison]::OrdinalIgnoreCase)
        ) "installDir override did not take effect -- plan resolved outside the isolated suite root."
        Assert-Contains $plan.guardedSurfaces.uninstallKey.path "OSG-Installed-Local-Test-Fixture" "uninstallKey override did not take effect."
    }
}
finally {
    if (Test-Path -LiteralPath $suiteRoot) {
        Remove-Item -LiteralPath $suiteRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $registryFixtureRoot) {
        Remove-Item -LiteralPath $registryFixtureRoot -Recurse -Force
    }
}

Write-Host "$($script:passed) passed, $($script:failed) failed"
if ($script:failed -ne 0) {
    exit 1
}
