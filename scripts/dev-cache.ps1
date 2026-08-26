#requires -Version 7.2

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
    [ValidateSet("Status", "Path", "Prune", "Lease")]
    [string]$Action = "Status",
    [ValidateSet("dev", "e2e", "package", "runtime", "evidence", "staging")]
    [string]$Lane = "dev",
    [string]$CacheRoot,
    [ValidateRange(1, 200)]
    [int]$MaxGiB = 28,
    [ValidateRange(1, [long]::MaxValue)]
    [long]$MaxBytes,
    [ValidateRange(1, 365)]
    [int]$InactiveDays = 14,
    [ValidateSet("none", "dev", "e2e", "package", "runtime", "evidence", "staging")]
    [string]$ProtectLane = "none",
    [ValidateSet(
        "none",
        "cargo-dev", "cargo-e2e", "cargo-package",
        "frontend-dev", "frontend-e2e", "frontend-package",
        "apps-dev", "apps-e2e", "apps-package",
        "assets-e2e", "runtime", "evidence", "staging"
    )]
    [string]$ProtectUnit = "none",
    [ValidateSet("Text", "Json")]
    [string]$OutputFormat = "Text",
    [ValidateSet("Acquire", "Release")]
    [string]$LeaseOperation = "Acquire",
    [ValidateRange(1, [int]::MaxValue)]
    [int]$LeaseProcessId,
    [string]$LeaseId,
    # How long to wait for the exclusive root-scoped manager lock before failing loudly. Manager
    # operations hold it for seconds, so concurrent disjoint lane groups only ever wait briefly.
    [ValidateRange(0, 600)]
    [int]$LockWaitSeconds = 60,
    [switch]$Apply
)

$ErrorActionPreference = "Stop"
$script:Owner = "oneclick-subtitles-generator"
$script:RootMarkerName = ".osg-development-cache.json"
$script:AreaMarkerName = ".osg-cache-area.json"
$script:EntryMarkerName = ".osg-cache-entry.json"
$script:LeaseName = ".osg-cache-lease"
$script:ManagerLockName = ".osg-cache-manager.lock"
$script:TrashOperationPattern = "^\.osg-delete-([0-9a-f]{32})\.json$"
$script:TrashOperationTemporaryPattern = "^\.osg-delete-([0-9a-f]{32})\.json\.write-([0-9a-f]{32})\.tmp$"
$script:SchemaVersion = 1
$script:RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$script:Utf8NoBom = [Text.UTF8Encoding]::new($false)
$script:CanRecoverInterruptedWrites = $Action -ne "Prune" -or (
    [bool]$Apply -and -not [bool]$WhatIfPreference
)
$script:LaneIds = @(
    "cargo-dev",
    "cargo-e2e",
    "cargo-package",
    "frontend-dev",
    "frontend-e2e",
    "frontend-package",
    "apps-dev",
    "apps-e2e",
    "apps-package",
    "assets-e2e",
    "runtime",
    "evidence",
    "staging"
)

if ($null -eq ("OsgDevelopmentCachePathNative" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Text;

public static class OsgDevelopmentCachePathNative
{
    private const uint FILE_READ_ATTRIBUTES = 0x80;
    private const uint FILE_SHARE_READ = 0x1;
    private const uint FILE_SHARE_WRITE = 0x2;
    private const uint FILE_SHARE_DELETE = 0x4;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle file,
        StringBuilder path,
        uint pathLength,
        uint flags);

    public static string GetFinalPath(string path)
    {
        using (SafeFileHandle handle = CreateFileW(
            path,
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            IntPtr.Zero))
        {
            if (handle.IsInvalid)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open path for canonical identity");

            var buffer = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not resolve canonical path identity");
            if (length >= buffer.Capacity)
                throw new InvalidOperationException("Canonical path identity exceeded the supported Windows path length");
            return buffer.ToString();
        }
    }
}
'@
}

function Test-HasTraversalSegment {
    param([Parameter(Mandatory)][string]$Path)

    foreach ($segment in ($Path -split "[\\/]")) {
        if ($segment -eq "." -or $segment -eq "..") {
            return $true
        }
    }
    return $false
}

function Assert-SafeCallerPathSpelling {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $normalized = $Path.Replace('/', '\')
    $namespacePrefixes = @('\\?\', '\\.\', '\??\', '\\??\', '\Device\', '\GLOBAL??\')
    foreach ($prefix in $namespacePrefixes) {
        if ($normalized.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "$Label must not use a Windows device, verbatim, or NT namespace spelling: $Path"
        }
    }
    foreach ($segment in ($normalized -split '\\')) {
        if (-not [string]::IsNullOrEmpty($segment) -and
            $segment -ne '.' -and $segment -ne '..' -and
            ($segment.EndsWith('.') -or $segment.EndsWith(' '))) {
            throw "$Label must not contain a Win32 trailing-dot or trailing-space segment: $Path"
        }
    }
}

function Get-NormalizedPath {
    param([Parameter(Mandatory)][string]$Path)

    $full = [IO.Path]::GetFullPath($Path)
    $pathRoot = [IO.Path]::GetPathRoot($full)
    if ($full.Equals($pathRoot, [StringComparison]::OrdinalIgnoreCase)) {
        return $full
    }
    return $full.TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
}

function Convert-NativeFinalPathSpelling {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $normalized = $Path.Replace('/', '\')
    if ($normalized.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase) -or
        $normalized.StartsWith('\??\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
        $prefixLength = if ($normalized.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
            '\\?\UNC\'.Length
        }
        else { '\??\UNC\'.Length }
        $normalized = '\\' + $normalized.Substring($prefixLength)
    }
    elseif ($normalized.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase) -or
        $normalized.StartsWith('\??\', [StringComparison]::OrdinalIgnoreCase)) {
        $prefixLength = if ($normalized.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
            '\\?\'.Length
        }
        else { '\??\'.Length }
        $normalized = $normalized.Substring($prefixLength)
    }
    elseif ($normalized.StartsWith('\\.\', [StringComparison]::OrdinalIgnoreCase) -or
        $normalized.StartsWith('\Device\', [StringComparison]::OrdinalIgnoreCase) -or
        $normalized.StartsWith('\GLOBAL??\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label resolved through an ambiguous Windows device namespace: $Path"
    }
    if (-not [IO.Path]::IsPathFullyQualified($normalized)) {
        throw "$Label did not resolve to an absolute DOS or UNC identity: $Path"
    }
    return Get-NormalizedPath $normalized
}

function Get-CanonicalPathIdentity {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $normalized = Get-NormalizedPath $Path
    $tail = [Collections.Generic.Stack[string]]::new()
    $cursor = $normalized
    while (-not (Test-Path -LiteralPath $cursor)) {
        $leaf = Split-Path -Leaf $cursor
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($leaf) -or
            [string]::IsNullOrWhiteSpace($parent) -or
            $parent.Equals($cursor, [StringComparison]::OrdinalIgnoreCase)) {
            throw "$Label has no existing ancestor whose filesystem identity can be verified: $Path"
        }
        $tail.Push($leaf)
        $cursor = $parent
    }
    try {
        $final = [OsgDevelopmentCachePathNative]::GetFinalPath($cursor)
        $identity = Convert-NativeFinalPathSpelling -Path $final -Label $Label
    }
    catch {
        throw "$Label could not be resolved to one authoritative filesystem identity: $Path. $($_.Exception.Message)"
    }
    while ($tail.Count -gt 0) {
        $identity = Join-Path $identity $tail.Pop()
    }
    return Get-NormalizedPath $identity
}

function Test-SameOrChildPath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Parent
    )

    $normalizedPath = Get-NormalizedPath $Path
    $normalizedParent = Get-NormalizedPath $Parent
    if ($normalizedPath.Equals($normalizedParent, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $normalizedPath.StartsWith(
        "$normalizedParent$([IO.Path]::DirectorySeparatorChar)",
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-NotReparsePoint {
    param(
        [Parameter(Mandatory)]$Item,
        [Parameter(Mandatory)][string]$Label
    )

    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label must not be a symbolic link, junction, mount point, or other reparse point: $($Item.FullName)"
    }
}

function Assert-NoReparseAncestors {
    param([Parameter(Mandatory)][string]$Path)

    $cursor = $Path
    while (-not (Test-Path -LiteralPath $cursor)) {
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) {
            break
        }
        $cursor = $parent
    }
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        $item = Get-Item -LiteralPath $cursor -Force
        Assert-NotReparsePoint -Item $item -Label "Development-cache path ancestor"
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) {
            break
        }
        $cursor = $parent
    }
}

function Resolve-CacheRoot {
    $requested = if (-not [string]::IsNullOrWhiteSpace($CacheRoot)) {
        $CacheRoot
    }
    elseif (-not [string]::IsNullOrWhiteSpace($env:OSG_DEV_CACHE_ROOT)) {
        $env:OSG_DEV_CACHE_ROOT
    }
    else {
        $localData = [Environment]::GetFolderPath(
            [Environment+SpecialFolder]::LocalApplicationData
        )
        Join-Path $localData "OSG-Development\cache"
    }

    Assert-SafeCallerPathSpelling -Path $requested -Label "Development cache path"
    if (Test-HasTraversalSegment $requested) {
        throw "Development cache path must not contain '.' or '..' traversal segments: $requested"
    }
    if (-not [IO.Path]::IsPathFullyQualified($requested)) {
        throw "Development cache must use an absolute path: $requested"
    }

    $lexicalRoot = Get-NormalizedPath $requested
    Assert-NoReparseAncestors $lexicalRoot
    $root = Get-CanonicalPathIdentity -Path $lexicalRoot -Label "Development cache path"
    $repoIdentity = Get-CanonicalPathIdentity -Path $script:RepoRoot -Label "Repository path"
    $volumeRoot = Get-NormalizedPath ([IO.Path]::GetPathRoot($root))
    if ($root.Equals($volumeRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Development cache cannot be a filesystem or share root: $root"
    }
    if ((Test-SameOrChildPath -Path $root -Parent $repoIdentity) -or
        (Test-SameOrChildPath -Path $repoIdentity -Parent $root)) {
        throw "Development cache must be outside, and must not contain, the repository: $root"
    }
    Assert-NoReparseAncestors $root
    return $root
}

function Enter-RootScopedLock {
    param([Parameter(Mandatory)][string]$Root)

    if (Test-Path -LiteralPath $Root -PathType Leaf) {
        throw "Development cache root is occupied by a file: $Root"
    }
    if (-not (Test-Path -LiteralPath $Root)) {
        [IO.Directory]::CreateDirectory($Root) | Out-Null
    }
    $rootItem = Get-Item -LiteralPath $Root -Force
    if (-not $rootItem.PSIsContainer) {
        throw "Development cache root is not a directory: $Root"
    }
    Assert-NotReparsePoint -Item $rootItem -Label "Development cache root"
    $lockPath = Join-Path $Root $script:ManagerLockName
    # Manager operations hold this for seconds. Concurrent entry points over DISJOINT lane groups
    # (a dev cargo command beside a running e2e journey) are legitimate, so wait briefly for the
    # kernel-owned lock instead of failing on first contention. Deadline keeps a wedged or leaked
    # holder loud rather than hanging forever.
    $stream = $null
    $deadline = [DateTime]::UtcNow.AddSeconds($LockWaitSeconds)
    while ($true) {
        try {
            $options = [IO.FileOptions]::DeleteOnClose -bor [IO.FileOptions]::WriteThrough
            $stream = [IO.FileStream]::new(
                $lockPath,
                [IO.FileMode]::CreateNew,
                [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None,
                1,
                $options
            )
            break
        }
        catch [IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "Another OSG development-cache manager holds the root-scoped lock, or an unowned stale lock requires inspection: $lockPath"
            }
            Start-Sleep -Milliseconds 250
        }
    }
    $script:BootstrapLockOwned = $true
    return $stream
}

function Write-JsonFileAtomically {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][hashtable]$Value
    )

    $parent = Split-Path -Parent $Path
    $leafHex = [Convert]::ToHexString(
        [Text.Encoding]::UTF8.GetBytes((Split-Path -Leaf $Path))
    ).ToLowerInvariant()
    $temporary = Join-Path $parent (
        ".osg-write-{0}-{1}.tmp" -f $leafHex, [Guid]::NewGuid().ToString("N")
    )
    $stream = $null
    try {
        $json = ($Value | ConvertTo-Json -Compress) + [Environment]::NewLine
        $bytes = $script:Utf8NoBom.GetBytes($json)
        $stream = [IO.FileStream]::new(
            $temporary,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough
        )
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        [IO.File]::Move($temporary, $Path)
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Recover-AtomicWriteTemporaryFiles {
    param(
        [Parameter(Mandatory)][string]$Directory,
        [Parameter(Mandatory)][string[]]$TargetLeaves,
        [switch]$VerifiedOwnership
    )

    $allowedHex = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($leaf in $TargetLeaves) {
        [void]$allowedHex.Add([Convert]::ToHexString(
            [Text.Encoding]::UTF8.GetBytes($leaf)
        ).ToLowerInvariant())
    }
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if (-not $item.Name.StartsWith(".osg-write-", [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        if ($item.Name -cnotmatch "^\.osg-write-([0-9a-f]+)-([0-9a-f]{32})\.tmp$" -or
            -not $allowedHex.Contains($Matches[1])) {
            throw "Unrecognized atomic-write residue at a managed cache boundary: $($item.FullName)"
        }
        Assert-NotReparsePoint -Item $item -Label "Atomic-write residue"
        if ($item.PSIsContainer) {
            throw "Atomic-write residue must be a regular file: $($item.FullName)"
        }
        if (-not $VerifiedOwnership) {
            throw "Refusing to recover atomic-write residue before ownership is verified: $($item.FullName)"
        }
        if ($script:CanRecoverInterruptedWrites) {
            Remove-Item -LiteralPath $item.FullName -Force
        }
        else {
            Write-Host "WOULD RECOVER ATOMIC WRITE: $($item.FullName)" -ForegroundColor Yellow
        }
    }
}

function Read-ExactMarker {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string[]]$ExpectedProperties
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required cache ownership marker is missing: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    Assert-NotReparsePoint -Item $item -Label "Cache ownership marker"
    try {
        $marker = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        throw "Cache ownership marker is not valid JSON: $Path"
    }
    $actual = @($marker.PSObject.Properties.Name | Sort-Object)
    $expected = @($ExpectedProperties | Sort-Object)
    if (($actual -join "|") -ne ($expected -join "|")) {
        throw "Cache ownership marker has an unexpected schema: $Path"
    }
    return $marker
}

function Write-TrashOperationJournal {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][hashtable]$Value
    )

    $leaf = Split-Path -Leaf $Path
    if ($leaf -cnotmatch $script:TrashOperationPattern) {
        throw "Trash operation journal path has an invalid identity: $Path"
    }
    $operationId = $Matches[1]
    $temporary = Join-Path (Split-Path -Parent $Path) (
        ".osg-delete-{0}.json.write-{1}.tmp" -f $operationId, [Guid]::NewGuid().ToString("N")
    )
    $json = ($Value | ConvertTo-Json -Compress) + [Environment]::NewLine
    $bytes = $script:Utf8NoBom.GetBytes($json)
    $options = [IO.FileOptions]::WriteThrough
    $stream = [IO.FileStream]::new(
        $temporary,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None,
        4096,
        $options
    )
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    }
    finally {
        $stream.Dispose()
    }
    try {
        [IO.File]::Move($temporary, $Path)
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Assert-CommonMarker {
    param(
        [Parameter(Mandatory)]$Marker,
        [Parameter(Mandatory)][string]$RootId,
        [Parameter(Mandatory)][string]$Path
    )

    if ($Marker.schemaVersion -ne $script:SchemaVersion -or
        $Marker.owner -ne $script:Owner -or
        $Marker.rootId -ne $RootId) {
        throw "Cache ownership marker does not belong to this managed root: $Path"
    }
}

function Ensure-OwnedDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$MarkerName,
        [Parameter(Mandatory)][hashtable]$MarkerValue,
        [Parameter(Mandatory)][string[]]$MarkerProperties,
        [string[]]$AdditionalAtomicTargets = @()
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path | Out-Null
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) {
        throw "Managed cache directory path is occupied by a file: $Path"
    }
    Assert-NotReparsePoint -Item $item -Label "Managed cache directory"
    $markerPath = Join-Path $Path $MarkerName
    if (-not (Test-Path -LiteralPath $markerPath)) {
        Recover-AtomicWriteTemporaryFiles -Directory $Path -TargetLeaves @(
            $MarkerName
            $AdditionalAtomicTargets
        )
        $children = @(Get-ChildItem -LiteralPath $Path -Force)
        if ($children.Count -ne 0) {
            throw "Refusing to adopt a non-empty directory without its ownership marker: $Path"
        }
        Write-JsonFileAtomically -Path $markerPath -Value $MarkerValue
    }
    $marker = Read-ExactMarker -Path $markerPath -ExpectedProperties $MarkerProperties
    foreach ($property in $MarkerValue.Keys) {
        if ([string]$marker.$property -cne [string]$MarkerValue[$property]) {
            throw "Managed cache marker has the wrong identity: $markerPath"
        }
    }
    Recover-AtomicWriteTemporaryFiles -Directory $Path -TargetLeaves @(
        $MarkerName
        $AdditionalAtomicTargets
    ) -VerifiedOwnership
    return $marker
}

function Assert-OnlyNamedChildren {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string[]]$AllowedNames
    )

    foreach ($item in Get-ChildItem -LiteralPath $Path -Force) {
        if ($AllowedNames -notcontains $item.Name) {
            throw "Unmanaged cache bytes found at a managed boundary: $($item.FullName)"
        }
    }
}

function Get-LaneSpecifications {
    param([Parameter(Mandatory)][string]$Root)

    return @(
        [pscustomobject]@{ Name = "dev"; Id = "cargo-dev"; Path = Join-Path $Root "cargo\dev"; Kind = "cargo" },
        [pscustomobject]@{ Name = "e2e"; Id = "cargo-e2e"; Path = Join-Path $Root "cargo\e2e"; Kind = "cargo" },
        [pscustomobject]@{ Name = "package"; Id = "cargo-package"; Path = Join-Path $Root "cargo\package"; Kind = "cargo" },
        [pscustomobject]@{ Name = "dev"; Id = "frontend-dev"; Path = Join-Path $Root "frontend\dev"; Kind = "frontend" },
        [pscustomobject]@{ Name = "e2e"; Id = "frontend-e2e"; Path = Join-Path $Root "frontend\e2e"; Kind = "frontend" },
        [pscustomobject]@{ Name = "package"; Id = "frontend-package"; Path = Join-Path $Root "frontend\package"; Kind = "frontend" },
        [pscustomobject]@{ Name = "dev"; Id = "apps-dev"; Path = Join-Path $Root "apps\dev"; Kind = "apps" },
        [pscustomobject]@{ Name = "e2e"; Id = "apps-e2e"; Path = Join-Path $Root "apps\e2e"; Kind = "apps" },
        [pscustomobject]@{ Name = "package"; Id = "apps-package"; Path = Join-Path $Root "apps\package"; Kind = "apps" },
        [pscustomobject]@{ Name = "e2e"; Id = "assets-e2e"; Path = Join-Path $Root "assets\e2e"; Kind = "assets" },
        [pscustomobject]@{ Name = "runtime"; Id = "runtime"; Path = Join-Path $Root "runtime"; Kind = "runtime" },
        [pscustomobject]@{ Name = "evidence"; Id = "evidence"; Path = Join-Path $Root "evidence"; Kind = "bounded" },
        [pscustomobject]@{ Name = "staging"; Id = "staging"; Path = Join-Path $Root "staging"; Kind = "bounded" }
    )
}

function Ensure-ManagedLayout {
    param([Parameter(Mandatory)][string]$Root)

    if (-not (Test-Path -LiteralPath $Root)) {
        New-Item -ItemType Directory -Path $Root | Out-Null
    }
    $rootItem = Get-Item -LiteralPath $Root -Force
    if (-not $rootItem.PSIsContainer) {
        throw "Development cache root is not a directory: $Root"
    }
    Assert-NotReparsePoint -Item $rootItem -Label "Development cache root"
    $rootMarkerPath = Join-Path $Root $script:RootMarkerName
    if (-not (Test-Path -LiteralPath $rootMarkerPath)) {
        Recover-AtomicWriteTemporaryFiles -Directory $Root -TargetLeaves @($script:RootMarkerName)
        $children = @(Get-ChildItem -LiteralPath $Root -Force)
        $unexpectedChildren = @($children | Where-Object Name -ne $script:ManagerLockName)
        if ($unexpectedChildren.Count -ne 0 -or
            -not $script:BootstrapLockOwned -or
            -not (Test-Path -LiteralPath (Join-Path $Root $script:ManagerLockName) -PathType Leaf)) {
            throw "Refusing to adopt a non-empty cache without its ownership marker: $Root"
        }
        Write-JsonFileAtomically -Path $rootMarkerPath -Value @{
            schemaVersion = $script:SchemaVersion
            owner = $script:Owner
            cacheKind = "development-cache"
            rootId = [Guid]::NewGuid().ToString("N")
        }
    }
    $rootMarker = Read-ExactMarker -Path $rootMarkerPath -ExpectedProperties @(
        "schemaVersion", "owner", "cacheKind", "rootId"
    )
    if ($rootMarker.schemaVersion -ne $script:SchemaVersion -or
        $rootMarker.owner -ne $script:Owner -or
        $rootMarker.cacheKind -ne "development-cache" -or
        [string]$rootMarker.rootId -notmatch "^[0-9a-f]{32}$") {
        throw "Development cache ownership marker is not recognized: $rootMarkerPath"
    }
    Recover-AtomicWriteTemporaryFiles -Directory $Root `
        -TargetLeaves @($script:RootMarkerName) -VerifiedOwnership
    $rootId = [string]$rootMarker.rootId

    $areaRoots = @{}
    foreach ($areaName in @("cargo", "frontend", "apps", "assets")) {
        $areaRoot = Join-Path $Root $areaName
        $areaMarker = Ensure-OwnedDirectory -Path $areaRoot -MarkerName $script:AreaMarkerName -MarkerValue @{
            schemaVersion = $script:SchemaVersion; owner = $script:Owner; rootId = $rootId; area = $areaName
        } -MarkerProperties @("schemaVersion", "owner", "rootId", "area")
        Assert-CommonMarker -Marker $areaMarker -RootId $rootId -Path $areaRoot
        if ($areaMarker.area -ne $areaName) {
            throw "Cache area marker has the wrong identity: $areaRoot"
        }
        $areaRoots[$areaName] = $areaRoot
    }

    $trashRoot = Join-Path $Root ".trash"
    $trashMarker = Ensure-OwnedDirectory -Path $trashRoot -MarkerName $script:AreaMarkerName -MarkerValue @{
        schemaVersion = $script:SchemaVersion; owner = $script:Owner; rootId = $rootId; area = "trash"
    } -MarkerProperties @("schemaVersion", "owner", "rootId", "area")
    Assert-CommonMarker -Marker $trashMarker -RootId $rootId -Path $trashRoot
    if ($trashMarker.area -ne "trash") {
        throw "Trash area marker has the wrong identity: $trashRoot"
    }

    $lanes = Get-LaneSpecifications $Root
    foreach ($laneSpec in $lanes) {
        $entry = Ensure-OwnedDirectory -Path $laneSpec.Path -MarkerName $script:EntryMarkerName -MarkerValue @{
            schemaVersion = $script:SchemaVersion; owner = $script:Owner; rootId = $rootId; lane = $laneSpec.Id
        } -MarkerProperties @("schemaVersion", "owner", "rootId", "lane") `
            -AdditionalAtomicTargets @($script:LeaseName)
        Assert-CommonMarker -Marker $entry -RootId $rootId -Path $laneSpec.Path
        if ($entry.lane -ne $laneSpec.Id) {
            throw "Cache lane marker does not match its directory: $($laneSpec.Path)"
        }
    }

    $runtimeHashes = Join-Path $Root "runtime\sha256"
    if (-not (Test-Path -LiteralPath $runtimeHashes)) {
        New-Item -ItemType Directory -Path $runtimeHashes | Out-Null
    }
    $runtimeHashItem = Get-Item -LiteralPath $runtimeHashes -Force
    if (-not $runtimeHashItem.PSIsContainer) {
        throw "Runtime content-addressed area is not a directory: $runtimeHashes"
    }
    Assert-NotReparsePoint -Item $runtimeHashItem -Label "Runtime content-addressed area"

    Assert-OnlyNamedChildren -Path $Root -AllowedNames @(
        $script:RootMarkerName, $script:ManagerLockName,
        "cargo", "frontend", "apps", "assets", "runtime", "evidence", "staging", ".trash"
    )
    foreach ($areaName in @("cargo", "frontend", "apps")) {
        Assert-OnlyNamedChildren -Path $areaRoots[$areaName] -AllowedNames @(
            $script:AreaMarkerName, "dev", "e2e", "package"
        )
    }
    Assert-OnlyNamedChildren -Path $areaRoots.assets -AllowedNames @($script:AreaMarkerName, "e2e")
    Assert-OnlyNamedChildren -Path (Join-Path $Root "runtime") -AllowedNames @(
        $script:EntryMarkerName, $script:LeaseName, "sha256"
    )
    foreach ($runtimeEntry in Get-ChildItem -LiteralPath $runtimeHashes -Force) {
        Assert-NotReparsePoint -Item $runtimeEntry -Label "Runtime content-addressed entry"
        if (-not $runtimeEntry.PSIsContainer -or $runtimeEntry.Name -cnotmatch "^[0-9a-f]{64}$") {
            throw "Runtime cache accepts only lowercase SHA-256 directory names: $($runtimeEntry.FullName)"
        }
    }
    foreach ($boundedName in @("evidence", "staging")) {
        $boundedPath = Join-Path $Root $boundedName
        foreach ($item in Get-ChildItem -LiteralPath $boundedPath -Force) {
            Assert-NotReparsePoint -Item $item -Label "Bounded cache entry"
            if ($item.Name -eq $script:EntryMarkerName -or $item.Name -eq $script:LeaseName) {
                if ($item.PSIsContainer) {
                    throw "Cache marker or lease must be a regular file: $($item.FullName)"
                }
                continue
            }
            # The evidence publisher maintains one cross-workflow index at its lane root.
            if ($boundedName -eq "evidence" -and $item.Name -ceq "README.md" -and -not $item.PSIsContainer) {
                continue
            }
            if (-not $item.PSIsContainer -or $item.Name -cnotmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$") {
                throw "Unmanaged cache bytes found in ${boundedName}: $($item.FullName)"
            }
        }
    }
    return [pscustomobject]@{
        Root = $Root
        RootId = $rootId
        CargoRoot = $areaRoots.cargo
        FrontendRoot = $areaRoots.frontend
        AppsRoot = $areaRoots.apps
        AssetsRoot = $areaRoots.assets
        RuntimeHashes = $runtimeHashes
        TrashRoot = $trashRoot
        Lanes = $lanes
    }
}

function Assert-EntryMarker {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$RootId,
        [Parameter(Mandatory)][string]$ExpectedLane
    )

    $markerPath = Join-Path $Path $script:EntryMarkerName
    $marker = Read-ExactMarker -Path $markerPath -ExpectedProperties @(
        "schemaVersion", "owner", "rootId", "lane"
    )
    Assert-CommonMarker -Marker $marker -RootId $RootId -Path $markerPath
    if ($marker.lane -ne $ExpectedLane) {
        throw "Managed entry has the wrong lane identity: $Path"
    }
}

function Recover-TrashOperationTemporaryFiles {
    param([Parameter(Mandatory)]$Layout)

    $records = @()
    foreach ($item in Get-ChildItem -LiteralPath $Layout.TrashRoot -Force) {
        if ($item.Name -cnotmatch $script:TrashOperationTemporaryPattern) { continue }
        Assert-NotReparsePoint -Item $item -Label "Trash journal atomic-write residue"
        if ($item.PSIsContainer) {
            throw "Trash journal atomic-write residue must be a regular file: $($item.FullName)"
        }
        $records += $item
    }
    foreach ($item in $records) {
        if ($script:CanRecoverInterruptedWrites) {
            # The live lane is moved only after the complete journal has been atomically renamed
            # into its final name. A remaining temp therefore authorizes no deletion and is safe
            # to discard without interpreting its possibly partial bytes.
            Remove-Item -LiteralPath $item.FullName -Force
        }
        else {
            Write-Host "WOULD RECOVER TRASH JOURNAL WRITE: $($item.FullName)" -ForegroundColor Yellow
        }
    }
    return $records
}

function Get-TrashOperationRecords {
    param([Parameter(Mandatory)]$Layout)

    [void](Recover-TrashOperationTemporaryFiles $Layout)
    $records = @()
    foreach ($item in Get-ChildItem -LiteralPath $Layout.TrashRoot -Force) {
        if ($item.Name -cnotmatch $script:TrashOperationPattern) { continue }
        Assert-NotReparsePoint -Item $item -Label "Trash operation journal"
        if ($item.PSIsContainer) {
            throw "Trash operation journal must be a regular file: $($item.FullName)"
        }
        $operationId = $Matches[1]
        $journal = Read-ExactMarker -Path $item.FullName -ExpectedProperties @(
            "schemaVersion", "owner", "rootId", "kind", "operationId", "laneId", "trashLeaf"
        )
        Assert-CommonMarker -Marker $journal -RootId $Layout.RootId -Path $item.FullName
        if ($journal.kind -ne "lane-delete" -or
            $journal.operationId -cne $operationId -or
            $script:LaneIds -cnotcontains [string]$journal.laneId -or
            [string]$journal.trashLeaf -cnotmatch (
                "^{0}--\d{{8}}T\d{{9}}Z--{1}$" -f [regex]::Escape([string]$journal.laneId), $operationId
            )) {
            throw "Trash operation journal has an invalid identity: $($item.FullName)"
        }
        $trashPath = Join-Path $Layout.TrashRoot ([string]$journal.trashLeaf)
        if (-not (Get-NormalizedPath (Split-Path -Parent $trashPath)).Equals(
                (Get-NormalizedPath $Layout.TrashRoot),
                [StringComparison]::OrdinalIgnoreCase)) {
            throw "Trash operation journal escaped its owned directory: $($item.FullName)"
        }
        $records += [pscustomobject]@{
            JournalPath = $item.FullName
            OperationId = $operationId
            LaneId = [string]$journal.laneId
            TrashLeaf = [string]$journal.trashLeaf
            TrashPath = $trashPath
        }
    }
    return $records
}

function Recover-JournaledTrash {
    param([Parameter(Mandatory)]$Layout)

    $records = @(Get-TrashOperationRecords $Layout)
    foreach ($record in $records) {
        $laneSpec = $Layout.Lanes | Where-Object Id -eq $record.LaneId | Select-Object -First 1
        if ($null -eq $laneSpec) {
            throw "Trash operation journal names an unknown live lane: $($record.JournalPath)"
        }
        $target = if (Test-Path -LiteralPath $record.TrashPath) {
            $record.TrashPath
        }
        else {
            $record.JournalPath
        }
        if (-not $PSCmdlet.ShouldProcess(
                $target,
                "Recover interrupted OSG development-cache lane deletion"
            )) {
            continue
        }
        if (Test-Path -LiteralPath $record.TrashPath) {
            $trashItem = Get-Item -LiteralPath $record.TrashPath -Force
            Assert-NotReparsePoint -Item $trashItem -Label "Journal-authorized trash"
            if (-not $trashItem.PSIsContainer) {
                throw "Journal-authorized trash must be a real directory: $($record.TrashPath)"
            }
            # An interrupted recursive deletion may already have removed the lane marker.
            # The root-owned journal authorizes that exact residue, but it never authorizes
            # traversal through a reparse point that appeared inside the residue.
            [void](Get-UnitFacts ([pscustomobject]@{
                Path = $record.TrashPath
                Kind = "trash"
            }))
            Assert-PathNotLive -Path $record.TrashPath -AlternateLivePath $laneSpec.Path
            Remove-Item -LiteralPath $record.TrashPath -Recurse -Force
            if (Test-Path -LiteralPath $record.TrashPath) {
                throw "Journal-authorized trash still exists after recursive deletion: $($record.TrashPath)"
            }
            Write-Host "RECOVERED JOURNALED TRASH: $($record.TrashPath)" -ForegroundColor Green
        }
        Remove-Item -LiteralPath $record.JournalPath -Force
    }
    return $records
}

function Get-TrashEntries {
    param([Parameter(Mandatory)]$Layout)

    $entries = @()
    $journalRecords = @(Get-TrashOperationRecords $Layout)
    $journalLeaves = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($record in $journalRecords) { [void]$journalLeaves.Add($record.TrashLeaf) }
    foreach ($item in Get-ChildItem -LiteralPath $Layout.TrashRoot -Force) {
        if ($item.Name -eq $script:AreaMarkerName -or
            $item.Name -cmatch $script:TrashOperationPattern -or
            $item.Name -cmatch $script:TrashOperationTemporaryPattern) {
            continue
        }
        Assert-NotReparsePoint -Item $item -Label "Trash entry"
        if (-not $item.PSIsContainer -or
            $item.Name -cnotmatch "^(cargo-dev|cargo-e2e|cargo-package|frontend-dev|frontend-e2e|frontend-package|apps-dev|apps-e2e|apps-package|assets-e2e|runtime|evidence|staging)--\d{8}T\d{9}Z--[0-9a-f]{32}$") {
            throw "Unrecognized bytes found in the owned trash directory: $($item.FullName)"
        }
        $laneId = $Matches[1]
        if (-not $journalLeaves.Contains($item.Name)) {
            Assert-EntryMarker -Path $item.FullName -RootId $Layout.RootId -ExpectedLane $laneId
        }
        $entries += [pscustomobject]@{
            Name = $laneId
            Id = $laneId
            Path = $item.FullName
            Kind = "trash"
        }
    }
    return $entries
}

function Get-UnitFacts {
    param([Parameter(Mandatory)]$LaneSpec)

    $bytes = [long]0
    $hasPayload = $false
    $newest = [DateTime]::MinValue
    $pending = [Collections.Generic.Stack[object]]::new()
    foreach ($item in Get-ChildItem -LiteralPath $LaneSpec.Path -Force) {
        $payload = $item.Name -ne $script:EntryMarkerName -and $item.Name -ne $script:LeaseName
        if ($LaneSpec.Kind -eq "runtime" -and $item.Name -eq "sha256") {
            $payload = $false
        }
        $pending.Push([pscustomobject]@{ Item = $item; Payload = $payload })
    }
    while ($pending.Count -gt 0) {
        $visit = $pending.Pop()
        $item = $visit.Item
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -and
            $LaneSpec.Id -eq "staging" -and $item.PSIsContainer) {
            # A live scenario junctions persistent asset caches into its leased run root by design.
            # Never follow it and never fail on it here: the junction target is measured and
            # protected inside its own lane, and deletion paths remove such links without descent.
            continue
        }
        Assert-NotReparsePoint -Item $item -Label "Managed cache payload"
        if (-not $item.PSIsContainer) {
            $bytes += [long]$item.Length
        }
        if ($visit.Payload) {
            $hasPayload = $true
            if ($item.LastWriteTimeUtc -gt $newest) {
                $newest = $item.LastWriteTimeUtc
            }
        }
        if ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) {
                $childIsPayload = $visit.Payload -or (
                    $LaneSpec.Kind -eq "runtime" -and $item.Name -eq "sha256"
                )
                $pending.Push([pscustomobject]@{ Item = $child; Payload = $childIsPayload })
            }
        }
    }
    return [pscustomobject]@{
        Bytes = $bytes
        HasPayload = $hasPayload
        LastWriteUtc = $newest
    }
}

function Get-UnitRemovableBytes {
    param([Parameter(Mandatory)]$Unit)

    if ($Unit.IsTrash) {
        return [long]$Unit.Bytes
    }
    $markerPath = Join-Path $Unit.Path $script:EntryMarkerName
    $marker = Get-Item -LiteralPath $markerPath -Force
    Assert-NotReparsePoint -Item $marker -Label "Cache lane marker"
    if ($marker.PSIsContainer) {
        throw "Cache lane marker is not a regular file: $markerPath"
    }
    return [math]::Max([long]0, [long]$Unit.Bytes - [long]$marker.Length)
}

function Get-InfrastructureBytes {
    param([Parameter(Mandatory)]$Layout)

    $paths = @(
        (Join-Path $Layout.Root $script:RootMarkerName),
        (Join-Path $Layout.CargoRoot $script:AreaMarkerName),
        (Join-Path $Layout.FrontendRoot $script:AreaMarkerName),
        (Join-Path $Layout.AppsRoot $script:AreaMarkerName),
        (Join-Path $Layout.AssetsRoot $script:AreaMarkerName),
        (Join-Path $Layout.TrashRoot $script:AreaMarkerName)
    )
    $total = [long]0
    foreach ($path in $paths) {
        $item = Get-Item -LiteralPath $path -Force
        Assert-NotReparsePoint -Item $item -Label "Cache infrastructure marker"
        if ($item.PSIsContainer) { throw "Cache infrastructure marker is not a regular file: $path" }
        $total += [long]$item.Length
    }
    foreach ($operation in Get-TrashOperationRecords $Layout) {
        $total += [long](Get-Item -LiteralPath $operation.JournalPath -Force).Length
    }
    foreach ($temporary in Get-ChildItem -LiteralPath $Layout.TrashRoot -Force | Where-Object {
            $_.Name -cmatch $script:TrashOperationTemporaryPattern
        }) {
        $total += [long]$temporary.Length
    }
    return $total
}

function Get-ProcessSnapshot {
    param([switch]$IncludePathIdentities)

    try {
        $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        $identities = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $ambiguous = $false
        $ambiguity = $null
        foreach ($process in $(if ($IncludePathIdentities) { $processes } else { @() })) {
            $reportedPaths = [Collections.Generic.List[object]]::new()
            $commandLine = [string]$process.CommandLine
            if (-not [string]::IsNullOrWhiteSpace($commandLine)) {
                foreach ($token in Get-CommandLinePathTokens $commandLine) {
                    $reportedPaths.Add([pscustomobject]@{ Path = $token; Label = "Process command-line path" })
                }
            }
            if (-not [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
                $reportedPaths.Add([pscustomobject]@{
                    Path = [string]$process.ExecutablePath
                    Label = "Process executable path"
                })
            }
            foreach ($reported in $reportedPaths) {
                try {
                    [void]$identities.Add((Convert-SystemReportedPathIdentity -Path $reported.Path -Label $reported.Label))
                }
                catch {
                    $ambiguous = $true
                    if ($null -eq $ambiguity) { $ambiguity = $_.Exception.Message }
                }
            }
        }
        return [pscustomobject]@{
            Available = $true
            Error = $null
            Processes = $processes
            PathIdentities = @($identities)
            PathIdentityAmbiguous = $ambiguous
            PathIdentityError = $ambiguity
        }
    }
    catch {
        Write-Warning "Could not inspect process command lines; every managed lane is protected for this run: $($_.Exception.Message)"
        return [pscustomobject]@{
            Available = $false
            Error = $_.Exception.Message
            Processes = @()
            PathIdentities = @()
            PathIdentityAmbiguous = $true
            PathIdentityError = $_.Exception.Message
        }
    }
}

function Convert-SystemReportedPathIdentity {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $normalized = Convert-NativeFinalPathSpelling -Path $Path -Label $Label
    foreach ($segment in ($normalized -split '\\')) {
        if (-not [string]::IsNullOrEmpty($segment) -and ($segment.EndsWith('.') -or $segment.EndsWith(' '))) {
            throw "$Label has an ambiguous trailing-dot or trailing-space segment: $Path"
        }
    }
    return Get-CanonicalPathIdentity -Path $normalized -Label $Label
}

function Get-SystemPathSpellings {
    param([Parameter(Mandatory)][string]$Path)

    $spellings = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [void]$spellings.Add($Path)
    if ($Path.StartsWith('\\')) {
        $uncTail = $Path.Substring(2)
        [void]$spellings.Add("\\?\UNC\$uncTail")
        [void]$spellings.Add("\??\UNC\$uncTail")
    }
    else {
        [void]$spellings.Add("\\?\$Path")
        [void]$spellings.Add("\??\$Path")
    }
    foreach ($spelling in @($spellings)) {
        [void]$spellings.Add($spelling.Replace('\', '/'))
    }
    return @($spellings)
}

function Get-CommandLinePathTokens {
    param([Parameter(Mandatory)][string]$CommandLine)

    $tokens = [Collections.Generic.List[string]]::new()
    foreach ($match in [regex]::Matches($CommandLine, '"([^"]+)"|([^\s]+)')) {
        $token = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
        if ($token.Contains('=')) { $token = $token.Substring($token.LastIndexOf('=') + 1) }
        $token = $token.Trim('"', "'", ',', ';')
        if ($token.IndexOfAny([char[]]"';|<>``") -ge 0) {
            # This is a shell/program fragment captured as one -Command argument, not one path.
            # Exact lane spellings in the raw command line are still checked separately below.
            continue
        }
        $windows = $token.Replace('/', '\')
        if ($windows.StartsWith('\\.\pipe\', [StringComparison]::OrdinalIgnoreCase) -or
            $windows.StartsWith('\\?\pipe\', [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $isDrivePath = $windows -match '^[A-Za-z]:\\'
        $isUncPath = $windows -match '^\\\\[^\\]+\\[^\\]+'
        $isVerbatimPath = $windows -match '^\\\\\?\\(?:[A-Za-z]:\\|UNC\\[^\\]+\\[^\\]+)'
        $isNtPath = $windows -match '^\\\?\?\\(?:[A-Za-z]:\\|UNC\\[^\\]+\\[^\\]+)'
        $isDevicePath = $windows -match '^\\\\\.\\' -or $windows -match '^\\(?:Device|GLOBAL\?\?)\\'
        if ($isDrivePath -or $isUncPath -or $isVerbatimPath -or $isNtPath -or $isDevicePath) {
            $tokens.Add($token)
        }
    }
    return @($tokens)
}

function Test-PathInUse {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$ProcessSnapshot
    )

    if (-not $ProcessSnapshot.Available) {
        return $true
    }
    if ($ProcessSnapshot.PathIdentityAmbiguous) {
        Write-Warning "Could not disambiguate a process-reported path; cache deletion is disabled: $($ProcessSnapshot.PathIdentityError)"
        return $true
    }
    $needle = Get-CanonicalPathIdentity -Path $Path -Label "Managed cache lane"
    $spellings = @(Get-SystemPathSpellings $needle)
    foreach ($process in $ProcessSnapshot.Processes) {
        $commandLine = [string]$process.CommandLine
        $executable = [string]$process.ExecutablePath
        if (-not [string]::IsNullOrWhiteSpace($commandLine)) {
            foreach ($spelling in $spellings) {
                if ($commandLine.IndexOf($spelling, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    return $true
                }
            }
        }
    }
    foreach ($identity in $ProcessSnapshot.PathIdentities) {
        if (Test-SameOrChildPath -Path $identity -Parent $needle) { return $true }
    }
    return $false
}

function Assert-PathNotLive {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$AlternateLivePath
    )

    if (Test-Path -LiteralPath (Join-Path $Path $script:LeaseName) -PathType Leaf) {
        throw "Managed cache entry became leased before deletion and was kept: $Path"
    }
    $freshSnapshot = Get-ProcessSnapshot -IncludePathIdentities
    if (-not $freshSnapshot.Available) {
        throw "Process inspection became unavailable before deletion; managed cache entry was kept: $Path"
    }
    if (Test-PathInUse -Path $Path -ProcessSnapshot $freshSnapshot) {
        throw "Managed cache entry became active before deletion and was kept: $Path"
    }
    if (-not [string]::IsNullOrWhiteSpace($AlternateLivePath) -and
        (Test-PathInUse -Path $AlternateLivePath -ProcessSnapshot $freshSnapshot)) {
        throw "The live lane corresponding to partial trash is active; its old trash was kept: $Path"
    }
}

function Get-ManagedUnits {
    param(
        [Parameter(Mandatory)]$Layout,
        $ProcessSnapshot
    )

    $units = @()
    foreach ($laneSpec in $Layout.Lanes) {
        $facts = Get-UnitFacts $laneSpec
        $leasePath = Join-Path $laneSpec.Path $script:LeaseName
        $leaseState = Get-LeaseState -Path $leasePath -RootId $Layout.RootId `
            -ExpectedGroup $laneSpec.Name -ProcessSnapshot $ProcessSnapshot
        $inUse = if ($null -ne $ProcessSnapshot) {
            Test-PathInUse -Path $laneSpec.Path -ProcessSnapshot $ProcessSnapshot
        }
        else { $false }
        $reasons = @()
        if ($ProtectLane -eq $laneSpec.Name) { $reasons += "explicitly protected" }
        if ($ProtectUnit -eq $laneSpec.Id) { $reasons += "unit explicitly protected" }
        if ($leaseState.Active) { $reasons += $leaseState.Reason }
        if ($inUse) {
            $reasons += $(if ($ProcessSnapshot.Available) { "in use" } else { "process inspection unavailable" })
        }
        $units += [pscustomobject]@{
            Name = $laneSpec.Id
            Group = $laneSpec.Name
            Id = $laneSpec.Id
            Path = $laneSpec.Path
            Kind = $laneSpec.Kind
            Bytes = $facts.Bytes
            HasPayload = $facts.HasPayload
            LastWriteUtc = $facts.LastWriteUtc
            Protected = $reasons.Count -gt 0
            Protection = $reasons -join ", "
            LeasePresent = $leaseState.Present
            LeaseStale = $leaseState.Stale
            LeasePath = $leasePath
            LanePath = $laneSpec.Path
            IsTrash = $false
        }
    }
    foreach ($trashSpec in Get-TrashEntries $Layout) {
        $facts = Get-UnitFacts $trashSpec
        $leasePath = Join-Path $trashSpec.Path $script:LeaseName
        $liveSpec = $Layout.Lanes | Where-Object Id -eq $trashSpec.Id | Select-Object -First 1
        $leaseState = Get-LeaseState -Path $leasePath -RootId $Layout.RootId `
            -ExpectedGroup $liveSpec.Name -ProcessSnapshot $ProcessSnapshot
        $inUse = if ($null -ne $ProcessSnapshot) {
            Test-PathInUse -Path $trashSpec.Path -ProcessSnapshot $ProcessSnapshot
        }
        else { $false }
        $reasons = @()
        if ($leaseState.Active) { $reasons += $leaseState.Reason }
        if ($inUse) {
            $reasons += $(if ($ProcessSnapshot.Available) { "in use" } else { "process inspection unavailable" })
        }
        $trashItem = Get-Item -LiteralPath $trashSpec.Path -Force
        $units += [pscustomobject]@{
            Name = "trash/$($trashItem.Name)"
            Group = $liveSpec.Name
            Id = $trashSpec.Id
            Path = $trashSpec.Path
            Kind = "trash"
            Bytes = $facts.Bytes
            HasPayload = $true
            LastWriteUtc = if ($facts.HasPayload) { $facts.LastWriteUtc } else { $trashItem.LastWriteTimeUtc }
            Protected = $reasons.Count -gt 0
            Protection = $reasons -join ", "
            LeasePresent = $leaseState.Present
            LeaseStale = $leaseState.Stale
            LeasePath = $leasePath
            LanePath = $trashSpec.Path
            IsTrash = $true
        }
    }
    return $units
}

function Get-GroupLaneSpecifications {
    param(
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)][string]$Group
    )

    return @($Layout.Lanes | Where-Object Name -eq $Group)
}

function Get-PathContract {
    param(
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)][string]$Group
    )

    $groupLanes = @(Get-GroupLaneSpecifications -Layout $Layout -Group $Group)
    if ($groupLanes.Count -eq 0) {
        throw "Unknown managed cache lane group: $Group"
    }
    $cargo = $groupLanes | Where-Object Kind -eq "cargo" | Select-Object -First 1
    $frontend = $groupLanes | Where-Object Kind -eq "frontend" | Select-Object -First 1
    $apps = $groupLanes | Where-Object Kind -eq "apps" | Select-Object -First 1
    $assets = $groupLanes | Where-Object Kind -eq "assets" | Select-Object -First 1
    $primaryPath = if ($Group -eq "runtime") {
        $Layout.RuntimeHashes
    }
    elseif ($null -ne $cargo) {
        $cargo.Path
    }
    else {
        $groupLanes[0].Path
    }
    return [ordered]@{
        schemaVersion = $script:SchemaVersion
        cacheRoot = $Layout.Root
        rootId = $Layout.RootId
        lane = $Group
        primaryPath = $primaryPath
        cargoTargetDir = if ($null -ne $cargo) { $cargo.Path } else { $null }
        frontendCacheRoot = if ($null -ne $frontend) { $frontend.Path } else { $null }
        appPublicationRoot = if ($null -ne $apps) { $apps.Path } else { $null }
        assetCacheRoot = if ($null -ne $assets) { $assets.Path } else { $null }
        runtimeContentRoot = $Layout.RuntimeHashes
        evidenceRoot = ($Layout.Lanes | Where-Object Id -eq "evidence" | Select-Object -First 1).Path
        stagingRoot = ($Layout.Lanes | Where-Object Id -eq "staging" | Select-Object -First 1).Path
        leasePaths = @($groupLanes | ForEach-Object { Join-Path $_.Path $script:LeaseName })
    }
}

function Get-LeaseOwnerProcess {
    param([Parameter(Mandatory)][int]$ProcessId)

    try {
        $processes = @(Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop)
    }
    catch {
        throw "Could not validate the requested lease owner process; no lease was created: $($_.Exception.Message)"
    }
    if ($processes.Count -ne 1) {
        throw "Lease owner process does not exist or is ambiguous: $ProcessId"
    }
    $created = ([DateTime]$processes[0].CreationDate).ToUniversalTime().ToString("O")
    return [pscustomobject]@{
        ProcessId = $ProcessId
        ProcessCreatedUtc = $created
    }
}

function Read-LeaseMarker {
    param([Parameter(Mandatory)][string]$Path)

    return Read-ExactMarker -Path $Path -ExpectedProperties @(
        "schemaVersion",
        "owner",
        "rootId",
        "laneGroup",
        "leaseId",
        "processId",
        "processCreatedUtc"
    )
}

function Get-LeaseState {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$RootId,
        [Parameter(Mandatory)][string]$ExpectedGroup,
        $ProcessSnapshot
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{
            Present = $false; Active = $false; Stale = $false; Corrupt = $false
            Reason = ""; Marker = $null
        }
    }
    try {
        $marker = Read-LeaseMarker $Path
        # ConvertFrom-Json auto-converts the ISO-8601 marker field into a tick-exact [DateTime];
        # casting that to [string] first would drop sub-second precision and the UTC suffix, making
        # every live lease compare as "process id was reused" and letting Prune break mutual
        # exclusion. Use the DateTime directly and only parse when the field stayed a string.
        $rawCreated = $marker.processCreatedUtc
        $created = if ($rawCreated -is [DateTime]) {
            if ($rawCreated.Kind -eq [DateTimeKind]::Unspecified) {
                [DateTime]::SpecifyKind($rawCreated, [DateTimeKind]::Utc)
            }
            else {
                $rawCreated.ToUniversalTime()
            }
        }
        else {
            [DateTime]::Parse(
                [string]$rawCreated,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            ).ToUniversalTime()
        }
        $processId = [int]$marker.processId
        if ($marker.schemaVersion -ne $script:SchemaVersion -or
            $marker.owner -ne $script:Owner -or
            $marker.rootId -ne $RootId -or
            $marker.laneGroup -ne $ExpectedGroup -or
            [string]$marker.leaseId -cnotmatch "^[0-9a-f]{32}$" -or
            $processId -lt 1) {
            throw "lease ownership fields do not match"
        }
    }
    catch {
        return [pscustomobject]@{
            Present = $true; Active = $true; Stale = $false; Corrupt = $true
            Reason = "corrupt or foreign lease"; Marker = $null
        }
    }
    if ($null -eq $ProcessSnapshot -or -not $ProcessSnapshot.Available) {
        return [pscustomobject]@{
            Present = $true; Active = $true; Stale = $false; Corrupt = $false
            Reason = $(if ($null -eq $ProcessSnapshot) { "lease present" } else { "lease owner inspection unavailable" })
            Marker = $marker
        }
    }
    $owner = @($ProcessSnapshot.Processes | Where-Object ProcessId -eq $processId)
    if ($owner.Count -ne 1) {
        return [pscustomobject]@{
            Present = $true; Active = $false; Stale = $true; Corrupt = $false
            Reason = "lease owner process exited"; Marker = $marker
        }
    }
    try {
        $actualCreated = ([DateTime]$owner[0].CreationDate).ToUniversalTime()
    }
    catch {
        return [pscustomobject]@{
            Present = $true; Active = $true; Stale = $false; Corrupt = $true
            Reason = "lease owner creation time is unreadable"; Marker = $marker
        }
    }
    if ($actualCreated.Ticks -ne $created.Ticks) {
        return [pscustomobject]@{
            Present = $true; Active = $false; Stale = $true; Corrupt = $false
            Reason = "lease process id was reused"; Marker = $marker
        }
    }
    return [pscustomobject]@{
        Present = $true; Active = $true; Stale = $false; Corrupt = $false
        Reason = "active process-held lease"; Marker = $marker
    }
}

function Remove-StaleLease {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExpectedLanePath,
        [Parameter(Mandatory)][string]$RootId,
        [Parameter(Mandatory)][string]$ExpectedGroup,
        [switch]$Quiet
    )

    $snapshot = Get-ProcessSnapshot
    if (-not $snapshot.Available) {
        throw "CIM became unavailable while reclaiming a stale lease; the lease was kept: $Path"
    }
    $state = Get-LeaseState -Path $Path -RootId $RootId -ExpectedGroup $ExpectedGroup -ProcessSnapshot $snapshot
    if (-not $state.Present) { return $false }
    if ($state.Corrupt) {
        throw "Refusing to reclaim a corrupt or foreign cache lease: $Path"
    }
    if (-not $state.Stale) {
        throw "Cache lease became active before reclamation and was kept: $Path"
    }
    $expectedPath = Join-Path $ExpectedLanePath $script:LeaseName
    if (-not (Get-NormalizedPath $Path).Equals(
            (Get-NormalizedPath $expectedPath),
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Lease path is not the exact lease file of its owned lane: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    Assert-NotReparsePoint -Item $item -Label "Stale cache lease"
    if ($item.PSIsContainer) {
        throw "Stale cache lease must be a regular file: $Path"
    }
    Remove-Item -LiteralPath $Path -Force
    if (-not $Quiet) {
        Write-Host "RECLAIMED STALE LEASE ($($state.Reason)): $Path" -ForegroundColor Yellow
    }
    return $true
}

function Acquire-ManagedLease {
    param(
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)][string]$Group,
        [Parameter(Mandatory)][int]$ProcessId
    )

    $groupLanes = @(Get-GroupLaneSpecifications -Layout $Layout -Group $Group)
    if ($groupLanes.Count -eq 0) {
        throw "Unknown managed cache lane group: $Group"
    }
    $snapshot = Get-ProcessSnapshot
    if (-not $snapshot.Available) {
        throw "Could not inspect existing lease owners; no lease was created."
    }
    $staleLeases = [Collections.Generic.List[object]]::new()
    foreach ($laneSpec in $groupLanes) {
        $leasePath = Join-Path $laneSpec.Path $script:LeaseName
        $state = Get-LeaseState -Path $leasePath -RootId $Layout.RootId -ExpectedGroup $Group -ProcessSnapshot $snapshot
        if ($state.Corrupt) {
            throw "Managed cache lane has a corrupt or foreign lease that must be inspected manually: $($laneSpec.Path)"
        }
        if ($state.Active) {
            throw "Managed cache lane is already leased by a live process: $($laneSpec.Path)"
        }
        if ($state.Stale) {
            $staleLeases.Add([pscustomobject]@{ Path = $leasePath; LanePath = $laneSpec.Path })
        }
    }
    foreach ($staleLease in $staleLeases) {
        [void](Remove-StaleLease -Path $staleLease.Path -ExpectedLanePath $staleLease.LanePath `
            -RootId $Layout.RootId -ExpectedGroup $Group -Quiet)
    }
    $ownerProcess = Get-LeaseOwnerProcess -ProcessId $ProcessId
    $leaseId = [Guid]::NewGuid().ToString("N")
    $leaseValue = @{
        schemaVersion = $script:SchemaVersion
        owner = $script:Owner
        rootId = $Layout.RootId
        laneGroup = $Group
        leaseId = $leaseId
        processId = $ownerProcess.ProcessId
        processCreatedUtc = $ownerProcess.ProcessCreatedUtc
    }
    $created = [Collections.Generic.List[string]]::new()
    try {
        foreach ($laneSpec in $groupLanes) {
            $leasePath = Join-Path $laneSpec.Path $script:LeaseName
            if (Test-Path -LiteralPath $leasePath) { throw "Managed cache lane became leased concurrently: $($laneSpec.Path)" }
            Write-JsonFileAtomically -Path $leasePath -Value $leaseValue
            $created.Add($leasePath)
        }
    }
    catch {
        foreach ($leasePath in $created) {
            if (Test-Path -LiteralPath $leasePath -PathType Leaf) {
                $written = Read-LeaseMarker $leasePath
                if ($written.leaseId -eq $leaseId) {
                    Remove-Item -LiteralPath $leasePath -Force
                }
            }
        }
        throw
    }
    $contract = Get-PathContract -Layout $Layout -Group $Group
    $contract["leaseId"] = $leaseId
    $contract["leaseProcessId"] = $ownerProcess.ProcessId
    $contract["leaseProcessCreatedUtc"] = $ownerProcess.ProcessCreatedUtc
    return $contract
}

function Release-ManagedLease {
    param(
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)][string]$Group,
        [Parameter(Mandatory)][string]$ExpectedLeaseId
    )

    if ($ExpectedLeaseId -cnotmatch "^[0-9a-f]{32}$") {
        throw "Lease release requires the exact lowercase lease id returned by acquisition."
    }
    $groupLanes = @(Get-GroupLaneSpecifications -Layout $Layout -Group $Group)
    if ($groupLanes.Count -eq 0) {
        throw "Unknown managed cache lane group: $Group"
    }
    $validated = [Collections.Generic.List[string]]::new()
    foreach ($laneSpec in $groupLanes) {
        $leasePath = Join-Path $laneSpec.Path $script:LeaseName
        if (-not (Test-Path -LiteralPath $leasePath)) {
            continue
        }
        $marker = Read-LeaseMarker $leasePath
        if ($marker.schemaVersion -ne $script:SchemaVersion -or
            $marker.owner -ne $script:Owner -or
            $marker.rootId -ne $Layout.RootId -or
            $marker.laneGroup -ne $Group -or
            $marker.leaseId -ne $ExpectedLeaseId) {
            throw "Lease release token does not own the current lease: $leasePath"
        }
        $validated.Add($leasePath)
    }
    foreach ($leasePath in $validated) {
        Remove-Item -LiteralPath $leasePath -Force
    }
    return [ordered]@{
        schemaVersion = $script:SchemaVersion
        cacheRoot = $Layout.Root
        lane = $Group
        leaseId = $ExpectedLeaseId
        released = $true
        releasedPaths = @($validated)
    }
}

function Remove-OwnedTrashEntry {
    param(
        [Parameter(Mandatory)]$Unit,
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)][string]$Reason
    )

    $resolvedParent = Get-NormalizedPath (Split-Path -Parent $Unit.Path)
    if (-not $resolvedParent.Equals((Get-NormalizedPath $Layout.TrashRoot), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to delete a path outside the exact owned trash directory: $($Unit.Path)"
    }
    $validatedEntry = @(Get-TrashEntries $Layout) | Where-Object {
        (Get-NormalizedPath $_.Path).Equals((Get-NormalizedPath $Unit.Path), [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    if ($null -eq $validatedEntry) {
        throw "Refusing to delete a path that is not a validated owned trash entry: $($Unit.Path)"
    }
    [void](Get-UnitFacts $validatedEntry)
    $correspondingLane = $Layout.Lanes | Where-Object Id -eq $validatedEntry.Id | Select-Object -First 1
    Assert-PathNotLive -Path $Unit.Path -AlternateLivePath $correspondingLane.Path
    if ($PSCmdlet.ShouldProcess($Unit.Path, "Delete recovered OSG development-cache trash ($Reason)")) {
        Remove-Item -LiteralPath $Unit.Path -Recurse -Force
        Write-Host "REMOVED TRASH ($Reason): $($Unit.Path)" -ForegroundColor Green
        return $true
    }
    return $false
}

function Move-LaneThroughTrash {
    param(
        [Parameter(Mandatory)]$Unit,
        [Parameter(Mandatory)]$Layout,
        [Parameter(Mandatory)][string]$Reason
    )

    $laneSpec = $Layout.Lanes | Where-Object Id -eq $Unit.Id | Select-Object -First 1
    if ($null -eq $laneSpec -or
        -not (Get-NormalizedPath $laneSpec.Path).Equals((Get-NormalizedPath $Unit.Path), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to prune an unrecognized live lane: $($Unit.Path)"
    }
    Assert-EntryMarker -Path $Unit.Path -RootId $Layout.RootId -ExpectedLane $Unit.Id
    [void](Get-UnitFacts $laneSpec)
    Assert-PathNotLive -Path $Unit.Path
    $operationId = [Guid]::NewGuid().ToString("N")
    $trashName = "{0}--{1}--{2}" -f @(
        $Unit.Id,
        [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmssfff'Z'"),
        $operationId
    )
    $destination = Join-Path $Layout.TrashRoot $trashName
    $journalPath = Join-Path $Layout.TrashRoot ".osg-delete-$operationId.json"
    if (-not (Get-NormalizedPath (Split-Path -Parent $destination)).Equals(
            (Get-NormalizedPath $Layout.TrashRoot),
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Computed trash destination escaped its owned directory: $destination"
    }
    if ($PSCmdlet.ShouldProcess($Unit.Path, "Atomically stage and delete OSG development-cache lane ($Reason)")) {
        Write-TrashOperationJournal -Path $journalPath -Value @{
            schemaVersion = $script:SchemaVersion
            owner = $script:Owner
            rootId = $Layout.RootId
            kind = "lane-delete"
            operationId = $operationId
            laneId = $Unit.Id
            trashLeaf = $trashName
        }
        [IO.Directory]::Move($Unit.Path, $destination)
        Write-Host "STAGED IN TRASH ($Reason): $destination" -ForegroundColor Yellow
        try {
            Assert-PathNotLive -Path $destination
            Remove-Item -LiteralPath $destination -Recurse -Force
            Remove-Item -LiteralPath $journalPath -Force
            Write-Host "REMOVED TRASH ($Reason): $destination" -ForegroundColor Green
        }
        catch {
            Write-Warning "Lane was safely renamed into owned trash but deletion did not finish; the next prune will recover it: $destination"
            throw
        }
        return $true
    }
    return $false
}

$resolvedRoot = Resolve-CacheRoot
$rootLock = $null
try {
    $rootLock = Enter-RootScopedLock $resolvedRoot
    $layout = Ensure-ManagedLayout $resolvedRoot

    if ($Action -eq "Path") {
        $contract = Get-PathContract -Layout $layout -Group $Lane
        if ($OutputFormat -eq "Json") {
            Write-Output ($contract | ConvertTo-Json -Compress -Depth 5)
        }
        else {
            Write-Output $contract.primaryPath
        }
        return
    }

    if ($Action -eq "Lease") {
        if ($LeaseOperation -eq "Acquire") {
            if (-not $PSBoundParameters.ContainsKey("LeaseProcessId")) {
                throw "Lease acquisition requires -LeaseProcessId for the process that will hold the build lease."
            }
            $leaseResult = Acquire-ManagedLease -Layout $layout -Group $Lane -ProcessId $LeaseProcessId
        }
        else {
            if ([string]::IsNullOrWhiteSpace($LeaseId)) {
                throw "Lease release requires -LeaseId from the matching acquisition."
            }
            $leaseResult = Release-ManagedLease -Layout $layout -Group $Lane -ExpectedLeaseId $LeaseId
        }
        Write-Output ($leaseResult | ConvertTo-Json -Compress -Depth 5)
        return
    }

    if ($Action -eq "Status") {
        $units = Get-ManagedUnits -Layout $layout -ProcessSnapshot $null
        $rows = foreach ($unit in $units | Sort-Object Name) {
            [pscustomobject]@{
                Lane = $unit.Name
                GiB = [math]::Round($unit.Bytes / 1GB, 3)
                LastWriteUtc = $unit.LastWriteUtc
                Lease = Test-Path -LiteralPath (Join-Path $unit.Path $script:LeaseName) -PathType Leaf
                Path = $unit.Path
            }
        }
        $rows | Format-Table -AutoSize
        $total = [long](($units | Measure-Object Bytes -Sum).Sum) + (Get-InfrastructureBytes $layout)
        Write-Host ("Total: {0:N3} GiB / {1:N3} GiB at {2}" -f ($total / 1GB), $MaxGiB, $resolvedRoot)
        return
    }

    $journaledTrash = @(Get-TrashOperationRecords $layout)
    # -WhatIf is a dry run even when callers also supplied the script's explicit
    # -Apply opt-in. Keep one effective mutation flag so recovery and ordinary
    # pruning cannot disagree about that PowerShell contract.
    $shouldApply = [bool]$Apply -and -not [bool]$WhatIfPreference
    if ($journaledTrash.Count -gt 0) {
        # Validate the complete trash boundary before recovering any one journal.
        # Otherwise a valid journal could make dry-run return early while foreign
        # siblings remain unnoticed, or let Apply mutate known bytes before it
        # discovers unknown bytes later in the ordinary inventory pass.
        [void](Get-TrashEntries $layout)
        if (-not $shouldApply) {
            foreach ($operation in $journaledTrash) {
                Write-Host "WOULD RECOVER JOURNALED TRASH: $($operation.TrashPath)" -ForegroundColor Yellow
            }
            return
        }
        [void](Recover-JournaledTrash $layout)
    }

    $limit = if ($PSBoundParameters.ContainsKey("MaxBytes")) {
        [long]$MaxBytes
    }
    else {
        [long]$MaxGiB * 1GB
    }
    $snapshot = Get-ProcessSnapshot -IncludePathIdentities
    $units = @(Get-ManagedUnits -Layout $layout -ProcessSnapshot $snapshot)
    $staleLeaseUnits = @($units | Where-Object LeaseStale)
    foreach ($staleLeaseUnit in $staleLeaseUnits) {
        if (-not $shouldApply) {
            Write-Host "WOULD RECLAIM STALE LEASE: $($staleLeaseUnit.LeasePath)" -ForegroundColor Yellow
            continue
        }
        $staleLeaseBytes = [long](Get-Item -LiteralPath $staleLeaseUnit.LeasePath -Force).Length
        [void](Remove-StaleLease -Path $staleLeaseUnit.LeasePath `
            -ExpectedLanePath $staleLeaseUnit.LanePath -RootId $layout.RootId `
            -ExpectedGroup $staleLeaseUnit.Group)
        $staleLeaseUnit.Bytes = [math]::Max([long]0, [long]$staleLeaseUnit.Bytes - $staleLeaseBytes)
        $staleLeaseUnit.LeasePresent = $false
        $staleLeaseUnit.LeaseStale = $false
    }
    $protectedBytes = [long](($units | Where-Object Protected | Measure-Object Bytes -Sum).Sum)
    if ($protectedBytes -gt $limit) {
        throw "Protected, leased, or in-use cache bytes alone exceed the limit ($protectedBytes > $limit); nothing was removed."
    }

    $selectedPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $plan = [Collections.Generic.List[object]]::new()
    foreach ($trashUnit in $units | Where-Object { $_.IsTrash -and -not $_.Protected } | Sort-Object LastWriteUtc, Path) {
        if ($selectedPaths.Add($trashUnit.Path)) {
            $plan.Add([pscustomobject]@{ Unit = $trashUnit; Reason = "recover partial trash" })
        }
    }

    $cutoff = [DateTime]::UtcNow.AddDays(-$InactiveDays)
    foreach ($unit in $units | Where-Object {
        -not $_.IsTrash -and $_.HasPayload -and -not $_.Protected -and $_.LastWriteUtc -lt $cutoff
    } | Sort-Object LastWriteUtc, Name) {
        if ($selectedPaths.Add($unit.Path)) {
            $plan.Add([pscustomobject]@{ Unit = $unit; Reason = "inactive for at least $InactiveDays days" })
        }
    }

    $total = [long](($units | Measure-Object Bytes -Sum).Sum) + (Get-InfrastructureBytes $layout)
    $projected = $total
    foreach ($item in $plan) {
        $projected = [math]::Max([long]0, $projected - (Get-UnitRemovableBytes $item.Unit))
    }
    if ($projected -gt $limit) {
        foreach ($unit in $units | Where-Object {
            -not $_.IsTrash -and $_.HasPayload -and -not $_.Protected -and -not $selectedPaths.Contains($_.Path)
        } | Sort-Object LastWriteUtc, Name) {
            if ($projected -le $limit) { break }
            [void]$selectedPaths.Add($unit.Path)
            $plan.Add([pscustomobject]@{ Unit = $unit; Reason = "cache exceeds its byte cap" })
            $projected = [math]::Max([long]0, $projected - (Get-UnitRemovableBytes $unit))
        }
    }
    if ($projected -gt $limit) {
        throw "Managed cache cannot be reduced below its byte cap without deleting protected or structural bytes ($projected > $limit)."
    }

    $actual = $total
    foreach ($item in $plan) {
        if (-not $shouldApply) {
            Write-Host "WOULD REMOVE ($($item.Reason)): $($item.Unit.Path)" -ForegroundColor Yellow
            continue
        }
        $removableBytes = Get-UnitRemovableBytes $item.Unit
        if ($item.Unit.IsTrash) {
            $removed = Remove-OwnedTrashEntry -Unit $item.Unit -Layout $layout -Reason $item.Reason
        }
        else {
            $removed = Move-LaneThroughTrash -Unit $item.Unit -Layout $layout -Reason $item.Reason
            $layout = Ensure-ManagedLayout $resolvedRoot
        }
        if ($removed) {
            $actual = [math]::Max([long]0, $actual - $removableBytes)
        }
    }

    if ($shouldApply -and $actual -gt $limit) {
        throw "Cache pruning completed only partially and the cache remains over its byte cap ($actual > $limit)."
    }
    $mode = if ($shouldApply) { "after pruning" } else { "projected after dry run" }
    $reported = if ($shouldApply) { $actual } else { $projected }
    Write-Host ("Cache {0}: {1:N3} GiB / {2:N3} GiB at {3}" -f $mode, ($reported / 1GB), ($limit / 1GB), $resolvedRoot)
}
finally {
    if ($null -ne $rootLock) {
        $rootLock.Dispose()
    }
}
