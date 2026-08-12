[CmdletBinding()]
param(
  [string]$CacheRoot,
  [string]$ScratchRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'The verified Tauri NSIS bootstrap is Windows-only'
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$desktopPackagePath = Join-Path $repositoryRoot 'apps\desktop\package.json'
$desktopPackage = Get-Content -LiteralPath $desktopPackagePath -Raw | ConvertFrom-Json
if ($desktopPackage.devDependencies.'@tauri-apps/cli' -cne '2.11.4') {
  throw 'The verified NSIS cache contract supports only Tauri CLI 2.11.4'
}

if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
  $localAppData = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData
  )
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw 'Could not resolve the Windows local application-data directory'
  }
  $CacheRoot = Join-Path $localAppData 'tauri'
}

if ([string]::IsNullOrWhiteSpace($ScratchRoot)) {
  $ScratchRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    [IO.Path]::GetTempPath()
  } else {
    $env:RUNNER_TEMP
  }
}

$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
$ScratchRoot = [IO.Path]::GetFullPath($ScratchRoot)
$operationId = [guid]::NewGuid().ToString('N')
$workRoot = Join-Path $ScratchRoot "osg-tauri-nsis-$operationId"
$candidateRoot = Join-Path $CacheRoot ".NSIS-candidate-$operationId"
$backupRoot = Join-Path $CacheRoot ".NSIS-backup-$operationId"
$nsisRoot = Join-Path $CacheRoot 'NSIS'

foreach ($trustedRoot in @($CacheRoot, $ScratchRoot)) {
  if (Test-Path -LiteralPath $trustedRoot) {
    $rootItem = Get-Item -LiteralPath $trustedRoot -Force
    if (-not $rootItem.PSIsContainer -or
        ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Refusing to use a non-directory or reparse-point NSIS bootstrap root'
    }
  }
}

function Assert-DirectChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $childPath = [IO.Path]::GetFullPath($Child)
  $childParent = [IO.Path]::GetDirectoryName($childPath).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  if (-not $childParent.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be a direct child of its reviewed parent"
  }
}

Assert-DirectChildPath -Parent $ScratchRoot -Child $workRoot -Label 'NSIS download workspace'
Assert-DirectChildPath -Parent $CacheRoot -Child $candidateRoot -Label 'NSIS candidate cache'
Assert-DirectChildPath -Parent $CacheRoot -Child $backupRoot -Label 'NSIS backup cache'
Assert-DirectChildPath -Parent $CacheRoot -Child $nsisRoot -Label 'Tauri NSIS cache'

$artifacts = @(
  [ordered]@{
    Name = 'nsis-3.11.zip'
    Url = 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip'
    Size = 2361546L
    Sha256 = 'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1'
    TauriSha1 = 'ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d'
  },
  [ordered]@{
    Name = 'nsis_tauri_utils.dll'
    Url = 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll'
    Size = 34304L
    Sha256 = '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709'
    TauriSha1 = '75197fee3c6a814fe035788d1c34ead39349b860'
  }
)

$requiredFiles = @(
  'makensis.exe',
  'Bin\makensis.exe',
  'Stubs\lzma-x86-unicode',
  'Stubs\lzma_solid-x86-unicode',
  'Plugins\x86-unicode\additional\nsis_tauri_utils.dll',
  'Include\MUI2.nsh',
  'Include\FileFunc.nsh',
  'Include\x64.nsh',
  'Include\nsDialogs.nsh',
  'Include\WinMessages.nsh',
  'Include\Win\COM.nsh',
  'Include\Win\Propkey.nsh',
  'Include\Win\RestartManager.nsh'
)

function Assert-PinnedFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Artifact
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Pinned Tauri bootstrap artifact is missing: $($Artifact.Name)"
  }
  if ((Get-Item -LiteralPath $Path).Length -ne $Artifact.Size) {
    throw "Pinned Tauri bootstrap artifact has the wrong byte length: $($Artifact.Name)"
  }
  $sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sha256 -cne $Artifact.Sha256) {
    throw "Pinned Tauri bootstrap artifact failed SHA-256 verification: $($Artifact.Name)"
  }
  $sha1 = (Get-FileHash -LiteralPath $Path -Algorithm SHA1).Hash.ToLowerInvariant()
  if ($sha1 -cne $Artifact.TauriSha1) {
    throw "Pinned Tauri bootstrap artifact does not match Tauri's locked SHA-1: $($Artifact.Name)"
  }
}

function Receive-PinnedArtifact {
  param(
    [Parameter(Mandatory = $true)]$Artifact,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  $curl = Get-Command 'curl.exe' -CommandType Application -ErrorAction Stop
  & $curl.Source `
    --fail `
    --location `
    --proto '=https' `
    --proto-redir '=https' `
    --max-redirs 5 `
    --retry 4 `
    --retry-all-errors `
    --retry-delay 2 `
    --retry-max-time 120 `
    --connect-timeout 20 `
    --max-time 180 `
    --remove-on-error `
    --silent `
    --show-error `
    --output $Destination `
    $Artifact.Url
  if ($LASTEXITCODE -ne 0) {
    throw "Pinned Tauri bootstrap download failed with curl code $LASTEXITCODE`: $($Artifact.Name)"
  }
  Assert-PinnedFile -Path $Destination -Artifact $Artifact
}

function Assert-NsisLayout {
  param([Parameter(Mandatory = $true)][string]$Root)

  foreach ($relativePath in $requiredFiles) {
    $requiredPath = Join-Path $Root $relativePath
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Verified Tauri NSIS cache is missing required file: $relativePath"
    }
  }
  $plugin = $artifacts[1]
  Assert-PinnedFile `
    -Path (Join-Path $Root 'Plugins\x86-unicode\additional\nsis_tauri_utils.dll') `
    -Artifact $plugin
}

New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
New-Item -ItemType Directory -Path $workRoot | Out-Null

$published = $false
$backupCreated = $false
try {
  $nsisArchive = Join-Path $workRoot $artifacts[0].Name
  $tauriPlugin = Join-Path $workRoot $artifacts[1].Name
  Receive-PinnedArtifact -Artifact $artifacts[0] -Destination $nsisArchive
  Receive-PinnedArtifact -Artifact $artifacts[1] -Destination $tauriPlugin

  New-Item -ItemType Directory -Path $candidateRoot | Out-Null
  Expand-Archive -LiteralPath $nsisArchive -DestinationPath $candidateRoot
  $expandedRoot = Join-Path $candidateRoot 'nsis-3.11'
  if (-not (Test-Path -LiteralPath $expandedRoot -PathType Container)) {
    throw 'Pinned NSIS archive did not contain its exact nsis-3.11 root'
  }
  $unexpectedRoots = @(
    Get-ChildItem -LiteralPath $candidateRoot -Force |
      Where-Object { $_.Name -cne 'nsis-3.11' }
  )
  if ($unexpectedRoots.Count -ne 0) {
    throw 'Pinned NSIS archive contained an unexpected top-level entry'
  }

  $pluginDirectory = Join-Path $expandedRoot 'Plugins\x86-unicode\additional'
  New-Item -ItemType Directory -Path $pluginDirectory -Force | Out-Null
  Copy-Item -LiteralPath $tauriPlugin -Destination (Join-Path $pluginDirectory 'nsis_tauri_utils.dll')
  Assert-NsisLayout -Root $expandedRoot

  if (Test-Path -LiteralPath $nsisRoot) {
    $existing = Get-Item -LiteralPath $nsisRoot -Force
    if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Refusing to replace a reparse-point Tauri NSIS cache'
    }
    Move-Item -LiteralPath $nsisRoot -Destination $backupRoot
    $backupCreated = $true
  }

  try {
    Move-Item -LiteralPath $expandedRoot -Destination $nsisRoot
    Assert-NsisLayout -Root $nsisRoot
    $published = $true
  } catch {
    if (Test-Path -LiteralPath $nsisRoot) {
      Remove-Item -LiteralPath $nsisRoot -Recurse -Force
    }
    if ($backupCreated -and (Test-Path -LiteralPath $backupRoot)) {
      Move-Item -LiteralPath $backupRoot -Destination $nsisRoot
      $backupCreated = $false
    }
    throw
  }

  if ($backupCreated -and (Test-Path -LiteralPath $backupRoot)) {
    Remove-Item -LiteralPath $backupRoot -Recurse -Force
    $backupCreated = $false
  }
} finally {
  if (-not $published -and $backupCreated -and
      -not (Test-Path -LiteralPath $nsisRoot) -and
      (Test-Path -LiteralPath $backupRoot)) {
    Move-Item -LiteralPath $backupRoot -Destination $nsisRoot
    $backupCreated = $false
  }
  if (Test-Path -LiteralPath $candidateRoot) {
    Remove-Item -LiteralPath $candidateRoot -Recurse -Force
  }
  if (Test-Path -LiteralPath $workRoot) {
    Remove-Item -LiteralPath $workRoot -Recurse -Force
  }
}

Write-Host 'Prepared the verified Tauri NSIS 3.11 toolchain in the exact Windows user cache.'
