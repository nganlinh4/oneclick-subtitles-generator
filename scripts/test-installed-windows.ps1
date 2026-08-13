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

function Inspect-InstalledNativeTools {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$AssetId
  )

  if ($AssetId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'Installed native-tool asset identity is invalid'
  }
  $installingScreenshot = Join-Path $env:RUNNER_TEMP 'osg-installed-tools-parallel-install.png'
  $installedScreenshot = Join-Path $env:RUNNER_TEMP 'osg-installed-tools-reinstalled.png'
  $stdout = Join-Path $env:RUNNER_TEMP 'osg-installed-native-tools.stdout'
  $stderr = Join-Path $env:RUNNER_TEMP 'osg-installed-native-tools.stderr'
  foreach ($path in @($installingScreenshot, $installedScreenshot, $stdout, $stderr)) {
    if (Test-Path -LiteralPath $path) {
      throw 'Installed native-tool flow output path was not clean'
    }
  }
  $arguments = @(
    'scripts/inspect-installed-native-tools.mjs',
    '--port', [string]$Port,
    '--asset-id', $AssetId,
    '--installing-screenshot', $installingScreenshot,
    '--installed-screenshot', $installedScreenshot
  )
  $inspection = Start-Process `
    -FilePath 'node' `
    -ArgumentList $arguments `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru
  try {
    if (-not $inspection.WaitForExit(1860000)) {
      Stop-Process -Id $inspection.Id -ErrorAction SilentlyContinue
      throw 'Installed native-tool flow did not finish within 31 minutes'
    }
    $inspection.WaitForExit()
    $output = @(Get-Content -LiteralPath $stdout)
    $errors = @(Get-Content -LiteralPath $stderr)
    if ($inspection.ExitCode -ne 0) {
      throw "Installed native-tool flow failed: $($errors -join ' ')"
    }
    if ($output.Count -ne 1 -or $errors.Count -ne 0) {
      throw 'Installed native-tool flow returned an unexpected output shape'
    }
    $result = $output[0] | ConvertFrom-Json
    $resultNames = @($result.PSObject.Properties.Name | Sort-Object)
    $expectedResultNames = @(
      'assetId',
      'downloadVersion',
      'installJobs',
      'installedScreenshot',
      'installedTools',
      'installingScreenshot',
      'missingDownloadReason',
      'missingPipelineErrorCode',
      'pipeline',
      'removedToolIds'
    ) | Sort-Object
    $removedToolIds = @($result.removedToolIds)
    $installJobs = @($result.installJobs)
    $installedTools = @($result.installedTools)
    if (($resultNames -join ',') -cne ($expectedResultNames -join ',') `
        -or $result.assetId -cne $AssetId `
        -or ($removedToolIds -join ',') -cne 'deno,media-tools,yt-dlp' `
        -or $result.missingDownloadReason -cne 'downloaderUnavailable' `
        -or $result.missingPipelineErrorCode -cne 'mediaToolsUnavailable' `
        -or $installJobs.Count -ne 3 `
        -or @($installJobs | Where-Object { (@($_.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'id,jobId' }).Count -ne 0 `
        -or (@($installJobs | ForEach-Object id) -join ',') -cne 'deno,media-tools,yt-dlp' `
        -or @($installJobs | Where-Object { [string]$_.jobId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }).Count -ne 0 `
        -or $installedTools.Count -ne 3 `
        -or @($installedTools | Where-Object { (@($_.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'id,version' }).Count -ne 0 `
        -or (@($installedTools | ForEach-Object id) -join ',') -cne 'deno,media-tools,yt-dlp' `
        -or @($installedTools | Where-Object { [string]$_.version -notmatch '^.{1,128}$' }).Count -ne 0 `
        -or [string]$result.downloadVersion -notmatch '^.{1,128}$' `
        -or (@($result.pipeline.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'audioCodec,durationUs,frameRate,height,videoCodec,width' `
        -or $result.pipeline.audioCodec -cne 'aac' `
        -or $result.pipeline.durationUs -isnot [ValueType] `
        -or $result.pipeline.durationUs -is [bool] `
        -or [double]$result.pipeline.durationUs -ne [Math]::Truncate([double]$result.pipeline.durationUs) `
        -or [long]$result.pipeline.durationUs -lt 3900000 `
        -or [long]$result.pipeline.durationUs -gt 4100000 `
        -or $result.pipeline.frameRate -isnot [ValueType] `
        -or $result.pipeline.frameRate -is [bool] `
        -or [double]$result.pipeline.frameRate -lt 23.9 `
        -or [double]$result.pipeline.frameRate -gt 24.1 `
        -or $result.pipeline.height -isnot [ValueType] `
        -or $result.pipeline.height -is [bool] `
        -or [int]$result.pipeline.height -ne 360 `
        -or $result.pipeline.videoCodec -cne 'h264' `
        -or $result.pipeline.width -isnot [ValueType] `
        -or $result.pipeline.width -is [bool] `
        -or [int]$result.pipeline.width -ne 640) {
      throw 'Installed native-tool flow omitted exact remove and hot reinstall proof'
    }
    foreach ($screenshotProof in @(
        @($installingScreenshot, $result.installingScreenshot),
        @($installedScreenshot, $result.installedScreenshot)
      )) {
      $screenshotPath = [string]$screenshotProof[0]
      $proof = $screenshotProof[1]
      if (-not (Test-Path -LiteralPath $screenshotPath -PathType Leaf) `
          -or (@($proof.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'bytes,sha256' `
          -or [long]$proof.bytes -ne (Get-Item -LiteralPath $screenshotPath).Length `
          -or [string]$proof.sha256 -notmatch '^[0-9a-f]{64}$' `
          -or [string]$proof.sha256 -cne (Get-FileHash -LiteralPath $screenshotPath -Algorithm SHA256).Hash.ToLowerInvariant()) {
        throw 'Installed native-tool screenshot evidence did not match its retained PNG'
      }
    }
    if ([string]$result.installingScreenshot.sha256 -ceq [string]$result.installedScreenshot.sha256) {
      throw 'Installed native-tool screenshots did not visibly distinguish install from active state'
    }
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
  }
}

function Initialize-NativePickerInterop {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  [void][System.Windows.Automation.AutomationElement]::RootElement
  Add-Type -AssemblyName UIAutomationClientSideProviders -ErrorAction Stop
  $providerTable = @(
    [UIAutomationClientsideProviders.UIAutomationClientSideProviders]::ClientSideProviderDescriptionTable
  )
  foreach ($providerClassName in @('button', 'combobox', 'edit')) {
    $providerEntries = @(
      $providerTable | Where-Object {
        $_.ClassName -ceq $providerClassName
      }
    )
    if ($providerEntries.Count -ne 1 `
        -or $null -eq $providerEntries[0].ClientSideProviderFactoryCallback) {
      throw 'Native-picker required one exact client-side provider entry'
    }
    [System.Windows.Automation.ClientSettings]::RegisterClientSideProviders(
      [System.Windows.Automation.ClientSideProviderDescription[]]@($providerEntries[0])
    )
  }
  if ($null -eq ('OsgNativePickerWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class OsgNativePickerWindow {
  private const int MaximumEnumeratedWindows = 512;
  private const int MaximumRetainedCandidates = 2;
  private const uint OwnerWindowCommand = 4;
  private const uint RootAncestorFlag = 2;

  private delegate bool EnumWindowsCallback(IntPtr window, IntPtr state);

  public sealed class RawCensus {
    public int RawProcessWindowMatches { get; internal set; }
    public int RawProcessVisibleMatches { get; internal set; }
    public int RawProcessClassMatches { get; internal set; }
    public int RawProcessNameMatches { get; internal set; }
    public int RawProcessExactMatches { get; internal set; }
    public int RawProcessOwnerMatches { get; internal set; }
    public int RawProcessOwnedVisibleMatches { get; internal set; }
    public int RawDesktopExactMatches { get; internal set; }
    public int RawDesktopOwnerMatches { get; internal set; }
    public int RawDesktopOwnedVisibleMatches { get; internal set; }
    public bool RawCensusIncomplete { get; internal set; }
  }

  public sealed class NativeCandidateScan {
    public IntPtr[] Candidates { get; internal set; }
    public int ExactMatchCount { get; internal set; }
    public bool Incomplete { get; internal set; }

    internal NativeCandidateScan() {
      Candidates = new IntPtr[0];
    }
  }

  [DllImport("user32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

  [DllImport("user32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindowVisible(IntPtr window);

  [DllImport("user32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindow(IntPtr window);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern IntPtr GetAncestor(IntPtr window, uint flags);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern int GetClassNameW(IntPtr window, StringBuilder className, int capacity);

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern int GetWindowTextW(IntPtr window, StringBuilder text, int capacity);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr GetWindow(IntPtr window, uint command);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("kernel32.dll")]
  private static extern void SetLastError(uint error);

  private static long NormalizeWindowHandleValue(long window) {
    return unchecked((long)(uint)window);
  }

  private static IntPtr ExpandNormalizedWindowHandle(long window) {
    if (window <= 0 || window > uint.MaxValue) {
      return IntPtr.Zero;
    }
    return new IntPtr(unchecked((int)(uint)window));
  }

  public static long NormalizeNativeWindowHandle(IntPtr window) {
    return NormalizeWindowHandleValue(window.ToInt64());
  }

  public static long NormalizeAutomationWindowHandle(int window) {
    return unchecked((long)(uint)window);
  }

  public static bool IsNormalizedWindow(long normalizedWindow) {
    var window = ExpandNormalizedWindowHandle(normalizedWindow);
    return window != IntPtr.Zero && IsWindow(window);
  }

  private static void AccumulateRawCensusWindow(
    RawCensus census,
    bool sameProcess,
    bool visible,
    bool classMatches,
    bool nameMatches,
    bool ownerMatches
  ) {
    if (sameProcess) {
      census.RawProcessWindowMatches += 1;
      if (visible) {
        census.RawProcessVisibleMatches += 1;
      }
      if (classMatches) {
        census.RawProcessClassMatches += 1;
      }
      if (nameMatches) {
        census.RawProcessNameMatches += 1;
      }
      if (classMatches && nameMatches) {
        census.RawProcessExactMatches += 1;
      }
      if (ownerMatches) {
        census.RawProcessOwnerMatches += 1;
        if (visible) {
          census.RawProcessOwnedVisibleMatches += 1;
        }
      }
    }
    if (classMatches && nameMatches) {
      census.RawDesktopExactMatches += 1;
    }
    if (ownerMatches) {
      census.RawDesktopOwnerMatches += 1;
      if (visible) {
        census.RawDesktopOwnedVisibleMatches += 1;
      }
    }
  }

  private static bool IsExactOwnedVisibleFacts(
    bool sameProcess,
    bool visible,
    bool classMatches,
    bool nameMatches,
    bool ownerMatches
  ) {
    return sameProcess && visible && classMatches && nameMatches && ownerMatches;
  }

  private static bool IsCandidateProbeIncomplete(
    bool sameProcess,
    bool visible,
    bool classMatches,
    int titleLength,
    int titleError,
    bool ownerMissing,
    int ownerError,
    bool stillWindow
  ) {
    return sameProcess && visible && classMatches && (
      !stillWindow
      || (titleLength == 0 && titleError != 0)
      || (ownerMissing && ownerError != 0)
    );
  }

  private static IntPtr ReadOwnerWindow(IntPtr window, out int error) {
    SetLastError(0);
    var owner = GetWindow(window, OwnerWindowCommand);
    error = owner == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
    return owner;
  }

  private static int ReadWindowTitle(IntPtr window, StringBuilder name, out int error) {
    SetLastError(0);
    var length = GetWindowTextW(window, name, name.Capacity);
    error = length == 0 ? Marshal.GetLastWin32Error() : 0;
    return length;
  }

  private static IntPtr ReadRootAncestor(IntPtr window, out int error) {
    SetLastError(0);
    var ancestor = GetAncestor(window, RootAncestorFlag);
    error = ancestor == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
    return ancestor;
  }

  public static bool IsExactOwnedVisibleCandidate(
    long normalizedWindow,
    int processId,
    long expectedOwner
  ) {
    var window = ExpandNormalizedWindowHandle(normalizedWindow);
    var normalizedExpectedOwner = NormalizeWindowHandleValue(expectedOwner);
    var ancestorError = 0;
    var ancestor = window == IntPtr.Zero
      ? IntPtr.Zero
      : ReadRootAncestor(window, out ancestorError);
    if (window == IntPtr.Zero
        || processId <= 0
        || normalizedExpectedOwner == 0
        || !IsWindow(window)
        || ancestor == IntPtr.Zero
        || ancestorError != 0
        || NormalizeNativeWindowHandle(ancestor) != normalizedWindow) {
      return false;
    }
    uint windowProcessId;
    if (GetWindowThreadProcessId(window, out windowProcessId) == 0) {
      return false;
    }
    var className = new StringBuilder(64);
    if (GetClassNameW(window, className, className.Capacity) == 0) {
      return false;
    }
    var name = new StringBuilder(64);
    int titleError;
    var titleLength = ReadWindowTitle(window, name, out titleError);
    int ownerError;
    var owner = ReadOwnerWindow(window, out ownerError);
    var sameProcess = windowProcessId == (uint)processId;
    var visible = IsWindowVisible(window);
    var classMatches = string.Equals(className.ToString(), "#32770", StringComparison.Ordinal);
    if (IsCandidateProbeIncomplete(
        sameProcess,
        visible,
        classMatches,
        titleLength,
        titleError,
        owner == IntPtr.Zero,
        ownerError,
        IsWindow(window)
      )) {
      return false;
    }
    var nameMatches = titleLength > 0
      && string.Equals(name.ToString(), "Choose video or audio", StringComparison.Ordinal);
    return IsExactOwnedVisibleFacts(
      sameProcess,
      visible,
      classMatches,
      nameMatches,
      NormalizeNativeWindowHandle(owner) == normalizedExpectedOwner
    );
  }

  public static bool PostCloseMessage(long normalizedWindow) {
    var window = ExpandNormalizedWindowHandle(normalizedWindow);
    return window != IntPtr.Zero
      && PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
  }

  public static NativeCandidateScan GetNativeCandidates(
    int processId,
    long expectedOwner
  ) {
    var scan = new NativeCandidateScan();
    var normalizedExpectedOwner = NormalizeWindowHandleValue(expectedOwner);
    if (processId <= 0 || normalizedExpectedOwner == 0) {
      scan.Incomplete = true;
      return scan;
    }

    var candidates = new List<IntPtr>(MaximumRetainedCandidates);
    var enumerated = 0;
    EnumWindowsCallback callback = (window, state) => {
      try {
        enumerated += 1;
        uint windowProcessId;
        if (GetWindowThreadProcessId(window, out windowProcessId) == 0) {
          scan.Incomplete = true;
        } else {
          var className = new StringBuilder(64);
          var classLength = GetClassNameW(window, className, className.Capacity);
          if (classLength == 0) {
            scan.Incomplete = true;
          }
          var classMatches = classLength > 0
            && string.Equals(className.ToString(), "#32770", StringComparison.Ordinal);
          var sameProcess = windowProcessId == (uint)processId;
          var visible = IsWindowVisible(window);
          var nameMatches = false;
          var titleLength = 0;
          var titleError = 0;
          if (sameProcess || classMatches) {
            var name = new StringBuilder(64);
            titleLength = ReadWindowTitle(window, name, out titleError);
            nameMatches = titleLength > 0
              && string.Equals(name.ToString(), "Choose video or audio", StringComparison.Ordinal);
          }
          int ownerError;
          var owner = ReadOwnerWindow(window, out ownerError);
          if (IsCandidateProbeIncomplete(
              sameProcess,
              visible,
              classMatches,
              titleLength,
              titleError,
              owner == IntPtr.Zero,
              ownerError,
              IsWindow(window)
            )) {
            scan.Incomplete = true;
          }
          if (IsExactOwnedVisibleFacts(
              sameProcess,
              visible,
              classMatches,
              nameMatches,
              NormalizeNativeWindowHandle(owner) == normalizedExpectedOwner
            )) {
            scan.ExactMatchCount += 1;
            if (candidates.Count < MaximumRetainedCandidates) {
              candidates.Add(window);
            }
          }
        }
      } catch {
        scan.Incomplete = true;
      }

      if (enumerated >= MaximumEnumeratedWindows) {
        scan.Incomplete = true;
        return false;
      }
      return true;
    };
    if (!EnumWindows(callback, IntPtr.Zero) && !scan.Incomplete) {
      scan.Incomplete = true;
    }
    scan.Candidates = candidates.ToArray();
    return scan;
  }

  public static RawCensus GetRawCensus(int processId, long expectedOwner) {
    var census = new RawCensus();
    var normalizedExpectedOwner = NormalizeWindowHandleValue(expectedOwner);
    if (processId <= 0 || normalizedExpectedOwner == 0) {
      census.RawCensusIncomplete = true;
      return census;
    }

    var enumerated = 0;
    EnumWindowsCallback callback = (window, state) => {
      try {
        enumerated += 1;
        uint windowProcessId;
        if (GetWindowThreadProcessId(window, out windowProcessId) == 0) {
          census.RawCensusIncomplete = true;
        } else {
          var sameProcess = windowProcessId == (uint)processId;
          var visible = IsWindowVisible(window);
          int ownerError;
          var owner = ReadOwnerWindow(window, out ownerError);
          if (owner == IntPtr.Zero && ownerError != 0) {
            census.RawCensusIncomplete = true;
          }
          var ownerMatches = NormalizeNativeWindowHandle(owner) == normalizedExpectedOwner;

          var className = new StringBuilder(64);
          var classLength = GetClassNameW(window, className, className.Capacity);
          if (classLength == 0) {
            census.RawCensusIncomplete = true;
          }
          var classMatches = classLength > 0
            && string.Equals(className.ToString(), "#32770", StringComparison.Ordinal);
          var nameMatches = false;
          if (sameProcess || classMatches) {
            var name = new StringBuilder(64);
            int titleError;
            var titleLength = ReadWindowTitle(window, name, out titleError);
            if (titleLength == 0 && titleError != 0) {
              census.RawCensusIncomplete = true;
            }
            nameMatches = titleLength > 0
              && string.Equals(name.ToString(), "Choose video or audio", StringComparison.Ordinal);
          }
          AccumulateRawCensusWindow(
            census,
            sameProcess,
            visible,
            classMatches,
            nameMatches,
            ownerMatches
          );
        }
      } catch {
        census.RawCensusIncomplete = true;
      }

      if (enumerated >= MaximumEnumeratedWindows) {
        census.RawCensusIncomplete = true;
        return false;
      }
      return true;
    };
    if (!EnumWindows(callback, IntPtr.Zero) && !census.RawCensusIncomplete) {
      census.RawCensusIncomplete = true;
    }
    return census;
  }
}
'@
  }
}

function New-NativePickerRawCensusMaxima {
  @{
    rawProcessWindowMatches = 0
    rawProcessVisibleMatches = 0
    rawProcessClassMatches = 0
    rawProcessNameMatches = 0
    rawProcessExactMatches = 0
    rawProcessOwnerMatches = 0
    rawProcessOwnedVisibleMatches = 0
    rawDesktopExactMatches = 0
    rawDesktopOwnerMatches = 0
    rawDesktopOwnedVisibleMatches = 0
    rawCensusIncomplete = $false
  }
}

function Update-NativePickerRawCensusMaxima {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Maxima,
    [Parameter(Mandatory = $true)]$Snapshot
  )

  foreach ($name in @(
      'rawProcessWindowMatches',
      'rawProcessVisibleMatches',
      'rawProcessClassMatches',
      'rawProcessNameMatches',
      'rawProcessExactMatches',
      'rawProcessOwnerMatches',
      'rawProcessOwnedVisibleMatches',
      'rawDesktopExactMatches',
      'rawDesktopOwnerMatches',
      'rawDesktopOwnedVisibleMatches'
    )) {
    $value = $Snapshot.$name
    if ($value -isnot [int] -or $value -lt 0) {
      $Maxima.rawCensusIncomplete = $true
      continue
    }
    if ($value -gt 1000) {
      $Maxima.rawCensusIncomplete = $true
    }
    $Maxima[$name] = [Math]::Min(
      1000,
      [Math]::Max([int]$Maxima[$name], [int]$value)
    )
  }
  if ($Snapshot.rawCensusIncomplete -isnot [bool]) {
    $Maxima.rawCensusIncomplete = $true
  } else {
    $Maxima.rawCensusIncomplete = [bool]$Maxima.rawCensusIncomplete `
      -or [bool]$Snapshot.rawCensusIncomplete
  }
}

function Add-NativePickerRawCensusMetrics {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Metrics,
    [Parameter(Mandatory = $true)][hashtable]$Maxima
  )

  foreach ($metric in $Maxima.GetEnumerator()) {
    $Metrics[$metric.Key] = $metric.Value
  }
}

function Test-NativePickerCandidate {
  param(
    [Parameter(Mandatory = $true)][long]$CandidateHandle,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$OwnerHandle
  )

  $CandidateHandle -ne 0 `
    -and [OsgNativePickerWindow]::IsExactOwnedVisibleCandidate(
      $CandidateHandle,
      $ProcessId,
      $OwnerHandle
    )
}

function Test-NativePickerElementCandidate {
  param(
    [Parameter(Mandatory = $true)]$Element,
    [Parameter(Mandatory = $true)][long]$CandidateHandle,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$OwnerHandle
  )

  try {
    [OsgNativePickerWindow]::NormalizeAutomationWindowHandle(
      [int]$Element.Current.NativeWindowHandle
    ) -eq $CandidateHandle `
      -and (Test-NativePickerCandidate `
        -CandidateHandle $CandidateHandle `
        -ProcessId $ProcessId `
        -OwnerHandle $OwnerHandle)
  } catch {
    $false
  }
}

function Test-NativePickerWritableEditorSelection {
  param(
    [Parameter(Mandatory = $true)][int]$MatchCount,
    [Parameter(Mandatory = $true)][bool]$IsEnabled,
    [Parameter(Mandatory = $true)][bool]$IsOffscreen,
    [Parameter(Mandatory = $true)][bool]$HasValuePattern,
    [Parameter(Mandatory = $true)][bool]$IsReadOnly
  )

  $MatchCount -eq 1 `
    -and $IsEnabled `
    -and -not $IsOffscreen `
    -and $HasValuePattern `
    -and -not $IsReadOnly
}

function Get-NativePickerWritableEditor {
  param(
    [Parameter(Mandatory = $true)]$Dialog
  )

  $controls = @($Dialog.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.AndCondition]::new(
      [System.Windows.Automation.Condition[]]@(
        [System.Windows.Automation.PropertyCondition]::new(
          [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
          '1148'
        ),
        [System.Windows.Automation.PropertyCondition]::new(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Edit
        )
      )
    )
  ))
  $pattern = $null
  if ($controls.Count -eq 1) {
    $control = $controls[0]
    $patternObject = $null
    $isEnabled = [bool]$control.Current.IsEnabled
    $isOffscreen = [bool]$control.Current.IsOffscreen
    $hasValuePattern = $control.TryGetCurrentPattern(
      [System.Windows.Automation.ValuePattern]::Pattern,
      [ref]$patternObject
    )
    $candidatePattern = $null
    $isReadOnly = $true
    if ($hasValuePattern) {
      $candidatePattern = [System.Windows.Automation.ValuePattern]$patternObject
      $isReadOnly = [bool]$candidatePattern.Current.IsReadOnly
    }
    if (Test-NativePickerWritableEditorSelection `
        -MatchCount $controls.Count `
        -IsEnabled $isEnabled `
        -IsOffscreen $isOffscreen `
        -HasValuePattern $hasValuePattern `
        -IsReadOnly $isReadOnly) {
      $pattern = $candidatePattern
    }
  }
  [pscustomobject]@{
    MatchCount = $controls.Count
    ValuePattern = $pattern
  }
}

function Get-NativePickerCandidateSnapshot {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$OwnerHandle
  )

  $scan = [OsgNativePickerWindow]::GetNativeCandidates(
    $ProcessId,
    $OwnerHandle
  )
  if ((@($scan.PSObject.Properties.Name | Sort-Object) -join ',') `
      -cne 'Candidates,ExactMatchCount,Incomplete' `
      -or $scan.ExactMatchCount -isnot [int] `
      -or $scan.ExactMatchCount -lt 0 `
      -or $scan.ExactMatchCount -gt 512 `
      -or $scan.Incomplete -isnot [bool] `
      -or $scan.Candidates -isnot [Array] `
      -or @($scan.Candidates).Count -gt 2 `
      -or @($scan.Candidates).Count -gt $scan.ExactMatchCount) {
    throw 'Native-picker candidate scan returned an invalid bounded schema'
  }
  $candidateConversionIncomplete = $false
  $candidateElements = @()
  if (-not $scan.Incomplete `
      -and $scan.ExactMatchCount -eq 1 `
      -and @($scan.Candidates).Count -eq 1) {
    $candidateElements = @(
      foreach ($candidate in @($scan.Candidates)) {
      if ($candidate -isnot [IntPtr] -or $candidate -eq [IntPtr]::Zero) {
        throw 'Native-picker candidate scan returned an invalid ephemeral candidate'
      }
      $candidateHandle = [OsgNativePickerWindow]::NormalizeNativeWindowHandle($candidate)
      if (-not (Test-NativePickerCandidate `
          -CandidateHandle $candidateHandle `
          -ProcessId $ProcessId `
          -OwnerHandle $OwnerHandle)) {
        $candidateConversionIncomplete = $true
        continue
      }
      try {
        $element = [System.Windows.Automation.AutomationElement]::FromHandle($candidate)
        if ($null -eq $element `
            -or -not (Test-NativePickerElementCandidate `
              -Element $element `
              -CandidateHandle $candidateHandle `
              -ProcessId $ProcessId `
              -OwnerHandle $OwnerHandle)) {
          $candidateConversionIncomplete = $true
          continue
        }
        $element
      } catch {
        $candidateConversionIncomplete = $true
      }
      }
    )
  }
  [pscustomobject]@{
    CandidateElements = $candidateElements
    ExactMatchCount = [int]$scan.ExactMatchCount
    ScanIncomplete = [bool]$scan.Incomplete
    BridgeIncomplete = $candidateConversionIncomplete
    Incomplete = [bool]$scan.Incomplete -or $candidateConversionIncomplete
  }
}

function Get-NativePickerPinnedCandidateState {
  param(
    [Parameter(Mandatory = $true)]$Element,
    [Parameter(Mandatory = $true)][long]$CandidateHandle,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$OwnerHandle
  )

  try {
    $snapshot = Get-NativePickerCandidateSnapshot `
      -ProcessId $ProcessId `
      -OwnerHandle $OwnerHandle
    $candidates = @($snapshot.CandidateElements)
    $valid = -not [bool]$snapshot.ScanIncomplete `
      -and -not [bool]$snapshot.BridgeIncomplete `
      -and [int]$snapshot.ExactMatchCount -eq 1 `
      -and $candidates.Count -eq 1 `
      -and (Test-NativePickerElementCandidate `
        -Element $candidates[0] `
        -CandidateHandle $CandidateHandle `
        -ProcessId $ProcessId `
        -OwnerHandle $OwnerHandle) `
      -and (Test-NativePickerElementCandidate `
        -Element $Element `
        -CandidateHandle $CandidateHandle `
        -ProcessId $ProcessId `
        -OwnerHandle $OwnerHandle)
    [pscustomobject]@{
      Valid = $valid
      EnumerationIncomplete = [bool]$snapshot.ScanIncomplete
      BridgeIncomplete = [bool]$snapshot.BridgeIncomplete
      ExactMatchCount = [int]$snapshot.ExactMatchCount
    }
  } catch {
    [pscustomobject]@{
      Valid = $false
      EnumerationIncomplete = $true
      BridgeIncomplete = $false
      ExactMatchCount = 0
    }
  }
}

function Get-NativeMediaPickerDialogs {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$OwnerHandle
  )

  $rawCensus = $null
  try {
    $nativeCandidates = Get-NativePickerCandidateSnapshot `
      -ProcessId $ProcessId `
      -OwnerHandle $OwnerHandle
  } catch {
    $nativeCandidates = [pscustomobject]@{
      CandidateElements = @()
      ExactMatchCount = 0
      ScanIncomplete = $true
      BridgeIncomplete = $false
      Incomplete = $true
    }
  }
  try {
    $candidate = [OsgNativePickerWindow]::GetRawCensus($ProcessId, $OwnerHandle)
    $expectedRawNames = @(
      'RawCensusIncomplete',
      'RawDesktopExactMatches',
      'RawDesktopOwnedVisibleMatches',
      'RawDesktopOwnerMatches',
      'RawProcessClassMatches',
      'RawProcessExactMatches',
      'RawProcessNameMatches',
      'RawProcessOwnedVisibleMatches',
      'RawProcessOwnerMatches',
      'RawProcessVisibleMatches',
      'RawProcessWindowMatches'
    )
    if ((@($candidate.PSObject.Properties.Name | Sort-Object) -join ',') `
        -cne (($expectedRawNames | Sort-Object) -join ',') `
        -or $candidate.RawCensusIncomplete -isnot [bool]) {
      throw 'Raw native-picker census returned an invalid aggregate schema'
    }
    foreach ($name in @($expectedRawNames | Where-Object { $_ -cne 'RawCensusIncomplete' })) {
      if ($candidate.$name -isnot [int] `
          -or $candidate.$name -lt 0 `
          -or $candidate.$name -gt 512) {
        throw 'Raw native-picker census returned an invalid bounded count'
      }
    }
    $rawCensus = $candidate
  } catch {
    $fallback = New-NativePickerRawCensusMaxima
    $fallback.rawCensusIncomplete = $true
    $rawCensus = [pscustomobject]$fallback
  }

  [pscustomobject]@{
    NativeCandidates = @($nativeCandidates.CandidateElements)
    NativeExactMatchCount = [int]$nativeCandidates.ExactMatchCount
    NativeCandidateScanIncomplete = [bool]$nativeCandidates.Incomplete
    NativeCandidateEnumerationIncomplete = [bool]$nativeCandidates.ScanIncomplete
    NativeCandidateBridgeIncomplete = [bool]$nativeCandidates.BridgeIncomplete
    RawProcessWindowMatches = [int]$rawCensus.rawProcessWindowMatches
    RawProcessVisibleMatches = [int]$rawCensus.rawProcessVisibleMatches
    RawProcessClassMatches = [int]$rawCensus.rawProcessClassMatches
    RawProcessNameMatches = [int]$rawCensus.rawProcessNameMatches
    RawProcessExactMatches = [int]$rawCensus.rawProcessExactMatches
    RawProcessOwnerMatches = [int]$rawCensus.rawProcessOwnerMatches
    RawProcessOwnedVisibleMatches = [int]$rawCensus.rawProcessOwnedVisibleMatches
    RawDesktopExactMatches = [int]$rawCensus.rawDesktopExactMatches
    RawDesktopOwnerMatches = [int]$rawCensus.rawDesktopOwnerMatches
    RawDesktopOwnedVisibleMatches = [int]$rawCensus.rawDesktopOwnedVisibleMatches
    RawCensusIncomplete = [bool]$rawCensus.rawCensusIncomplete
  }
}

function Get-NativePickerInspectorPhase {
  param([Parameter(Mandatory = $true)][string]$Root)

  $stages = @(
    'starting',
    'connected',
    'tab-activated',
    'control-ready',
    'prior-state-validated',
    'click-issued'
  )
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

function Get-NativePickerPreclickFailureCode {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
      'not-started',
      'starting',
      'connected',
      'tab-activated',
      'control-ready',
      'prior-state-validated'
    )]
    [string]$Phase
  )

  switch -CaseSensitive ($Phase) {
    'not-started' { 'inspector-startup-exited' }
    'starting' { 'inspector-startup-exited' }
    'connected' { 'inspector-tab-activation-exited' }
    'tab-activated' { 'inspector-control-readiness-exited' }
    'control-ready' { 'inspector-prior-state-exited' }
    'prior-state-validated' { 'inspector-picker-click-exited' }
  }
}

function Get-InstalledLocalMediaInspectorStderrState {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer `
        -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) `
        -or $item.Length -gt 16384) {
      return 'invalid'
    }
    if ($item.Length -eq 0) {
      return 'empty'
    }
    'nonempty'
  } catch {
    'invalid'
  }
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

function Get-DiagnosticEventsAfterBaseline {
  param(
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][string]$BaselineSha256,
    [Parameter(Mandatory = $true)][long]$BaselineLength
  )

  if ($BaselineLength -le 0 `
      -or $BaselineLength -gt ($diagnosticLogLimitBytes + $diagnosticEntrySlackBytes)) {
    throw 'Diagnostic suffix baseline length is invalid'
  }
  $stream = [IO.FileStream]::new(
    $LogPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::ReadWrite
  )
  try {
    $snapshotLength = $stream.Length
    if ($snapshotLength -lt $BaselineLength `
        -or $snapshotLength -gt ($diagnosticLogLimitBytes + $diagnosticEntrySlackBytes)) {
      throw 'Diagnostic suffix snapshot length is invalid'
    }
    $snapshotBytes = [byte[]]::new([int]$snapshotLength)
    $offset = 0
    while ($offset -lt $snapshotBytes.Length) {
      $read = $stream.Read($snapshotBytes, $offset, $snapshotBytes.Length - $offset)
      if ($read -le 0) {
        throw 'Diagnostic suffix snapshot was truncated during its single read'
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
    throw 'Diagnostic suffix snapshot lost its reviewed baseline'
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
    throw 'Diagnostic suffix snapshot did not retain its immutable prefix'
  }
  if ($completeLength -eq $BaselineLength) {
    return
  }
  $suffixLength = $completeLength - [int]$BaselineLength
  $suffixBytes = [byte[]]::new($suffixLength)
  [Array]::Copy($snapshotBytes, [int]$BaselineLength, $suffixBytes, 0, $suffixLength)
  @(
    [Text.Encoding]::UTF8.GetString($suffixBytes) -split "`r?`n" |
      Where-Object Length -gt 0 |
      ForEach-Object { $_ | ConvertFrom-Json }
  )
}

function Assert-NativeToolLifecycleDiagnostics {
  param(
    [Parameter(Mandatory = $true)][object[]]$Events,
    [Parameter(Mandatory = $true)][string]$AppInstanceId,
    [Parameter(Mandatory = $true)][ValidateRange(0, 3)][int]$ExpectedInstalls,
    [Parameter(Mandatory = $true)][ValidateRange(0, 3)][int]$ExpectedRemovals
  )

  if ($AppInstanceId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'Native-tool lifecycle diagnostics received an invalid app instance identity'
  }
  $lifecycle = @($Events | Where-Object { [string]$_.event -like 'native-tool.*' })
  $allowedEvents = @(
    'native-tool.requested',
    'native-tool.started',
    'native-tool.completed',
    'native-tool.cancelled',
    'native-tool.failed',
    'native-tool.invalid-terminal'
  )
  foreach ($entry in $lifecycle) {
    $expectedNames = switch ([string]$entry.event) {
      'native-tool.requested' {
        @('action', 'appInstanceId', 'event', 'timestampMs', 'tool')
        break
      }
      'native-tool.failed' {
        @('action', 'appInstanceId', 'code', 'event', 'job', 'timestampMs', 'tool')
        break
      }
      default {
        @('action', 'appInstanceId', 'event', 'job', 'timestampMs', 'tool')
      }
    }
    if ($entry.event -isnot [string] `
        -or $entry.action -isnot [string] `
        -or $entry.tool -isnot [string] `
        -or $entry.appInstanceId -isnot [string] `
        -or [string]$entry.event -notin $allowedEvents `
        -or (@($entry.PSObject.Properties.Name | Sort-Object) -join ',') `
          -cne (($expectedNames | Sort-Object) -join ',') `
        -or $entry.appInstanceId -cne $AppInstanceId `
        -or $entry.timestampMs -isnot [string] `
        -or $entry.timestampMs -notmatch '^\d{1,20}$' `
        -or [string]$entry.action -notin @('install', 'remove') `
        -or [string]$entry.tool -notin @('deno', 'media-tools', 'yt-dlp') `
        -or ($entry.event -cne 'native-tool.requested' `
          -and ($entry.job -isnot [string] `
            -or [string]$entry.job -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) `
        -or ($entry.event -ceq 'native-tool.failed' `
          -and ($entry.code -isnot [string] `
            -or [string]::IsNullOrEmpty([string]$entry.code) `
            -or [string]$entry.code -notmatch '^[A-Za-z][A-Za-z0-9]{0,63}$'))) {
      throw 'Native-tool lifecycle diagnostics returned an invalid or cross-instance schema'
    }
  }
  $terminalFailures = @(
    $lifecycle | Where-Object event -in @(
      'native-tool.cancelled',
      'native-tool.failed',
      'native-tool.invalid-terminal'
    )
  )
  if ($terminalFailures.Count -ne 0) {
    throw 'Native-tool lifecycle diagnostics contained a failed or ambiguous terminal'
  }
  foreach ($actionExpectation in @(
      @('install', $ExpectedInstalls),
      @('remove', $ExpectedRemovals)
    )) {
    $action = [string]$actionExpectation[0]
    $expectedCount = [int]$actionExpectation[1]
    $requested = @($lifecycle | Where-Object { $_.event -ceq 'native-tool.requested' -and $_.action -ceq $action })
    $started = @($lifecycle | Where-Object { $_.event -ceq 'native-tool.started' -and $_.action -ceq $action })
    $completed = @($lifecycle | Where-Object { $_.event -ceq 'native-tool.completed' -and $_.action -ceq $action })
    $requestedTools = @($requested | ForEach-Object tool | Sort-Object)
    $startedTools = @($started | ForEach-Object tool | Sort-Object)
    $completedTools = @($completed | ForEach-Object tool | Sort-Object)
    $startedJobs = @($started | ForEach-Object job | Sort-Object -Unique)
    $completedJobs = @($completed | ForEach-Object job | Sort-Object -Unique)
    $startedPairs = @($started | ForEach-Object { "$($_.tool):$($_.job)" } | Sort-Object)
    $completedPairs = @($completed | ForEach-Object { "$($_.tool):$($_.job)" } | Sort-Object)
    $expectedTools = if ($expectedCount -eq 3) { 'deno,media-tools,yt-dlp' } else { '' }
    if ($requested.Count -ne $expectedCount `
        -or $started.Count -ne $expectedCount `
        -or $completed.Count -ne $expectedCount `
        -or ($requestedTools -join ',') -cne $expectedTools `
        -or ($startedTools -join ',') -cne $expectedTools `
        -or ($completedTools -join ',') -cne $expectedTools `
        -or $startedJobs.Count -ne $expectedCount `
        -or $completedJobs.Count -ne $expectedCount `
        -or ($startedJobs -join ',') -cne ($completedJobs -join ',') `
        -or ($startedPairs -join ',') -cne ($completedPairs -join ',')) {
      throw "Native-tool lifecycle diagnostics omitted exact $action request, job, or completion proof"
    }
    if ($expectedCount -eq 0) {
      continue
    }
    $requestIndices = @()
    $startIndices = @()
    $completeIndices = @()
    for ($index = 0; $index -lt $lifecycle.Count; $index += 1) {
      if ($lifecycle[$index].action -cne $action) {
        continue
      }
      if ($lifecycle[$index].event -ceq 'native-tool.requested') {
        $requestIndices += $index
      } elseif ($lifecycle[$index].event -ceq 'native-tool.started') {
        $startIndices += $index
      } elseif ($lifecycle[$index].event -ceq 'native-tool.completed') {
        $completeIndices += $index
      }
    }
    if (($requestIndices | Measure-Object -Maximum).Maximum `
          -ge ($completeIndices | Measure-Object -Minimum).Minimum) {
      throw "Native-tool lifecycle did not request all $action operations before the first terminal"
    }
    if ($action -ceq 'install' `
        -and ($startIndices | Measure-Object -Maximum).Maximum `
          -ge ($completeIndices | Measure-Object -Minimum).Minimum) {
      throw 'Native-tool lifecycle did not start all installs in parallel'
    }
    foreach ($tool in @('deno', 'media-tools', 'yt-dlp')) {
      $requestIndex = [Array]::IndexOf($lifecycle, @($requested | Where-Object tool -ceq $tool)[0])
      $startIndex = [Array]::IndexOf($lifecycle, @($started | Where-Object tool -ceq $tool)[0])
      $completeIndex = [Array]::IndexOf($lifecycle, @($completed | Where-Object tool -ceq $tool)[0])
      if ($requestIndex -lt 0 -or $startIndex -le $requestIndex -or $completeIndex -le $startIndex) {
        throw "Native-tool lifecycle diagnostics were out of order for $action $tool"
      }
    }
  }
  if ($ExpectedRemovals -eq 3 -and $ExpectedInstalls -eq 3) {
    $allStartedJobs = @(
      $lifecycle |
        Where-Object event -ceq 'native-tool.started' |
        ForEach-Object job
    )
    $allCompletedJobs = @(
      $lifecycle |
        Where-Object event -ceq 'native-tool.completed' |
        ForEach-Object job
    )
    if ($allStartedJobs.Count -ne 6 `
        -or @($allStartedJobs | Sort-Object -Unique).Count -ne 6 `
        -or $allCompletedJobs.Count -ne 6 `
        -or @($allCompletedJobs | Sort-Object -Unique).Count -ne 6 `
        -or (@($allStartedJobs | Sort-Object) -join ',') `
          -cne (@($allCompletedJobs | Sort-Object) -join ',')) {
      throw 'Native-tool hot lifecycle reused or mismatched remove and reinstall jobs'
    }
    $lastRemoval = -1
    $firstInstallRequest = [int]::MaxValue
    for ($index = 0; $index -lt $lifecycle.Count; $index += 1) {
      if ($lifecycle[$index].action -ceq 'remove') {
        $lastRemoval = $index
      } elseif ($lifecycle[$index].action -ceq 'install' `
          -and $lifecycle[$index].event -ceq 'native-tool.requested') {
        $firstInstallRequest = [Math]::Min($firstInstallRequest, $index)
      }
    }
    if ($lastRemoval -ge $firstInstallRequest) {
      throw 'Native-tool reinstalls began before every removal completed'
    }
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
          -and $_.event -in @(
            'media-picker.requested',
            'media-picker.worker-started',
            'media-picker.worker-failed',
            'media-picker.returned'
          )
      }
  )
  $requested = @($pickerEvents | Where-Object event -eq 'media-picker.requested')
  $workerStarted = @($pickerEvents | Where-Object event -eq 'media-picker.worker-started')
  $workerFailed = @($pickerEvents | Where-Object event -eq 'media-picker.worker-failed')
  $returned = @($pickerEvents | Where-Object event -eq 'media-picker.returned')
  foreach ($entry in $pickerEvents) {
    $expectedNames = if ($entry.event -ceq 'media-picker.returned') {
      @('appInstanceId', 'event', 'outcome', 'timestampMs')
    } else {
      @('appInstanceId', 'event', 'timestampMs')
    }
    if ((@($entry.PSObject.Properties.Name | Sort-Object) -join ',') `
        -cne (($expectedNames | Sort-Object) -join ',') `
        -or [string]$entry.timestampMs -notmatch '^\d{1,20}$') {
      return 'diagnostic-ambiguous'
    }
  }
  $returnedNone = @($returned | Where-Object outcome -ceq 'none')
  $returnedSelected = @($returned | Where-Object outcome -ceq 'selected')
  if ($returnedSelected.Count -eq 1 -and $requested.Count -eq 1 `
      -and $workerStarted.Count -eq 1 -and $workerFailed.Count -eq 0 `
      -and $returned.Count -eq 1 -and $pickerEvents.Count -eq 3 `
      -and $pickerEvents[0].event -ceq 'media-picker.requested' `
      -and $pickerEvents[1].event -ceq 'media-picker.worker-started' `
      -and $pickerEvents[2].event -ceq 'media-picker.returned') {
    return 'selected'
  }
  if ($returnedNone.Count -eq 1 -and $requested.Count -eq 1 `
      -and $workerStarted.Count -eq 1 -and $workerFailed.Count -eq 0 `
      -and $returned.Count -eq 1 -and $pickerEvents.Count -eq 3 `
      -and $pickerEvents[0].event -ceq 'media-picker.requested' `
      -and $pickerEvents[1].event -ceq 'media-picker.worker-started' `
      -and $pickerEvents[2].event -ceq 'media-picker.returned') {
    return 'backend-returned-none'
  }
  if ($requested.Count -eq 1 -and $workerStarted.Count -eq 1 `
      -and $workerFailed.Count -eq 1 -and $returned.Count -eq 0 `
      -and $pickerEvents.Count -eq 3 `
      -and $pickerEvents[0].event -ceq 'media-picker.requested' `
      -and $pickerEvents[1].event -ceq 'media-picker.worker-started' `
      -and $pickerEvents[2].event -ceq 'media-picker.worker-failed') {
    return 'worker-failed'
  }
  if ($requested.Count -eq 0 -and $workerStarted.Count -eq 0 `
      -and $workerFailed.Count -eq 0 -and $returned.Count -eq 0) {
    return 'command-dispatch-timeout'
  }
  if ($requested.Count -eq 1 -and $workerStarted.Count -eq 0 `
      -and $workerFailed.Count -eq 0 -and $returned.Count -eq 0 `
      -and $pickerEvents.Count -eq 1 `
      -and $pickerEvents[0].event -ceq 'media-picker.requested') {
    return 'blocking-pool-dispatch-timeout'
  }
  if ($requested.Count -eq 1 -and $workerStarted.Count -eq 1 `
      -and $workerFailed.Count -eq 0 -and $returned.Count -eq 0 `
      -and $pickerEvents.Count -eq 2 `
      -and $pickerEvents[0].event -ceq 'media-picker.requested' `
      -and $pickerEvents[1].event -ceq 'media-picker.worker-started') {
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
    [Parameter(Mandatory = $true)][string]$PhaseRoot,
    [Parameter(Mandatory = $true)][string]$StderrPath
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
      [void]$Inspector.WaitForExit(5000)
      $stderrState = Get-InstalledLocalMediaInspectorStderrState -Path $StderrPath
      $failureCode = if ($stderrState -ceq 'invalid') {
        'inspector-stderr-invalid'
      } else {
        Get-NativePickerPreclickFailureCode -Phase $phase
      }
      try {
        Set-NativePickerEvidence `
          -Stage 'failed' `
          -Outcome 'failed' `
          -FailureCode $failureCode
      } catch {}
      throw "Installed local-media inspector exited at a bounded pre-click phase ($failureCode)"
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
    [Parameter(Mandatory = $true)][long]$OwnerHandle,
    [long]$ExpectedCandidateHandle = 0
  )

  Initialize-NativePickerInterop
  $attempts = 0
  $dismissed = $false
  $pinnedCandidateHandle = $ExpectedCandidateHandle
  $rawCensusMaxima = New-NativePickerRawCensusMaxima
  $nativeCandidateMatches = 0
  $nativeCandidateScanIncomplete = $false
  $deadline = (Get-Date).AddSeconds(5)
  do {
    $attempts += 1
    $snapshot = Get-NativeMediaPickerDialogs `
      -ProcessId $ProcessId `
      -OwnerHandle $OwnerHandle
    Update-NativePickerRawCensusMaxima -Maxima $rawCensusMaxima -Snapshot $snapshot
    $nativeCandidates = @($snapshot.NativeCandidates)
    $nativeCandidateMatches = [Math]::Max(
      $nativeCandidateMatches,
      [int]$snapshot.NativeExactMatchCount
    )
    $nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete `
      -or [bool]$snapshot.NativeCandidateScanIncomplete
    if ($snapshot.NativeExactMatchCount -gt 1) {
      break
    }
    if ($snapshot.NativeCandidateEnumerationIncomplete) {
      Start-Sleep -Milliseconds 100
      continue
    }
    if ($snapshot.NativeExactMatchCount -eq 0) {
      if ($nativeCandidates.Count -eq 0 `
          -and ($pinnedCandidateHandle -eq 0 `
            -or -not [OsgNativePickerWindow]::IsNormalizedWindow($pinnedCandidateHandle))) {
        $dismissed = $true
      }
      break
    }
    if ($snapshot.NativeCandidateBridgeIncomplete -or $nativeCandidates.Count -ne 1) {
      Start-Sleep -Milliseconds 100
      continue
    }
    $candidate = $nativeCandidates[0]
    try {
      $candidateHandle = [OsgNativePickerWindow]::NormalizeAutomationWindowHandle(
        [int]$candidate.Current.NativeWindowHandle
      )
    } catch {
      Start-Sleep -Milliseconds 100
      continue
    }
    if ($candidateHandle -eq 0 `
        -or ($pinnedCandidateHandle -ne 0 -and $candidateHandle -ne $pinnedCandidateHandle) `
        -or -not (Test-NativePickerCandidate `
          -CandidateHandle $candidateHandle `
          -ProcessId $ProcessId `
          -OwnerHandle $OwnerHandle)) {
      break
    }
    $pinnedCandidateHandle = $candidateHandle
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
    try {
      $cancelButtons = @($candidate.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $cancelCondition
      ))
    } catch {
      Start-Sleep -Milliseconds 100
      continue
    }
    try {
      $invoked = $false
      if ($cancelButtons.Count -eq 1 -and $cancelButtons[0].Current.IsEnabled) {
        $patternObject = $null
        if ($cancelButtons[0].TryGetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern,
            [ref]$patternObject
          )) {
          $freshCandidate = Get-NativePickerPinnedCandidateState `
            -Element $candidate `
            -CandidateHandle $pinnedCandidateHandle `
            -ProcessId $ProcessId `
            -OwnerHandle $OwnerHandle
          $nativeCandidateMatches = [Math]::Max(
            $nativeCandidateMatches,
            [int]$freshCandidate.ExactMatchCount
          )
          $nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete `
            -or [bool]$freshCandidate.EnumerationIncomplete `
            -or [bool]$freshCandidate.BridgeIncomplete
          if ($freshCandidate.ExactMatchCount -gt 1) {
            break
          }
          if ($freshCandidate.EnumerationIncomplete `
              -or $freshCandidate.BridgeIncomplete) {
            Start-Sleep -Milliseconds 100
            continue
          }
          if (-not $freshCandidate.Valid) {
            break
          }
          ([System.Windows.Automation.InvokePattern]$patternObject).Invoke()
          $invoked = $true
        }
      }
      if (-not $invoked) {
        $freshCandidate = Get-NativePickerPinnedCandidateState `
          -Element $candidate `
          -CandidateHandle $pinnedCandidateHandle `
          -ProcessId $ProcessId `
          -OwnerHandle $OwnerHandle
        $nativeCandidateMatches = [Math]::Max(
          $nativeCandidateMatches,
          [int]$freshCandidate.ExactMatchCount
        )
        $nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete `
          -or [bool]$freshCandidate.EnumerationIncomplete `
          -or [bool]$freshCandidate.BridgeIncomplete
        if ($freshCandidate.ExactMatchCount -gt 1) {
          break
        }
        if ($freshCandidate.EnumerationIncomplete `
            -or $freshCandidate.BridgeIncomplete) {
          Start-Sleep -Milliseconds 100
          continue
        }
        if (-not $freshCandidate.Valid) {
          break
        }
        [void][OsgNativePickerWindow]::PostCloseMessage($pinnedCandidateHandle)
      }
    } catch {
      Start-Sleep -Milliseconds 100
      continue
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  [pscustomobject]@{
    Attempts = $attempts
    Dismissed = $dismissed
    RawCensusMaxima = $rawCensusMaxima
    NativeCandidateMatches = [Math]::Min($nativeCandidateMatches, 1000)
    NativeCandidateScanIncomplete = $nativeCandidateScanIncomplete
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
  $dialogHandle = 0
  $rawCensusMaxima = New-NativePickerRawCensusMaxima
  $nativeCandidateMatches = 0
  $nativeCandidateScanIncomplete = $false
  $nativeCandidateCompleteScanObserved = $false
  $nativeCandidateBridgeFailureObserved = $false
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
      try {
        $snapshot = Get-NativeMediaPickerDialogs `
          -ProcessId $ProcessId `
          -OwnerHandle $OwnerHandle
      } catch {
        $rawCensusMaxima.rawCensusIncomplete = $true
        throw
      }
      Update-NativePickerRawCensusMaxima -Maxima $rawCensusMaxima -Snapshot $snapshot
      $nativeCandidates = @($snapshot.NativeCandidates)
      $nativeCandidateMatches = [Math]::Max(
        $nativeCandidateMatches,
        [int]$snapshot.NativeExactMatchCount
      )
      $nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete `
        -or [bool]$snapshot.NativeCandidateScanIncomplete
      $nativeCandidateCompleteScanObserved = $nativeCandidateCompleteScanObserved `
        -or -not [bool]$snapshot.NativeCandidateEnumerationIncomplete
      $nativeCandidateBridgeFailureObserved = $nativeCandidateBridgeFailureObserved `
        -or (-not [bool]$snapshot.NativeCandidateEnumerationIncomplete `
          -and [int]$snapshot.NativeExactMatchCount -eq 1 `
          -and [bool]$snapshot.NativeCandidateBridgeIncomplete)
      $dialogMatches = [Math]::Max($dialogMatches, [int]$snapshot.NativeExactMatchCount)
      if ($snapshot.NativeExactMatchCount -gt 1) {
        $failureCode = 'dialog-ambiguous'
        throw 'Installed application opened multiple native media pickers'
      }
      if ($snapshot.NativeCandidateEnumerationIncomplete) {
        continue
      }
      if ($snapshot.NativeCandidateBridgeIncomplete) {
        continue
      }
      if ($snapshot.NativeExactMatchCount -eq 1 -and $nativeCandidates.Count -eq 1) {
        $candidate = $nativeCandidates[0]
        try {
          $candidateHandle = [OsgNativePickerWindow]::NormalizeAutomationWindowHandle(
            [int]$candidate.Current.NativeWindowHandle
          )
        } catch {
          continue
        }
        if ($candidateHandle -ne 0 `
            -and (Test-NativePickerCandidate `
              -CandidateHandle $candidateHandle `
              -ProcessId $ProcessId `
              -OwnerHandle $OwnerHandle)) {
          $dialog = $candidate
          $dialogHandle = $candidateHandle
          $ownerMatched = $true
        }
      }
    } until ($null -ne $dialog -or (Get-Date) -ge $dialogDeadline)
    if ($null -eq $dialog) {
      $failureCode = if (-not $nativeCandidateCompleteScanObserved) {
        'dialog-discovery-incomplete'
      } elseif ($nativeCandidateBridgeFailureObserved) {
        'dialog-automation-timeout'
      } else {
        'dialog-timeout'
      }
      throw 'Native media picker did not open as an owned dialog within 30 seconds'
    }
    $dialogMetrics = @{
      dialogAttempts = [Math]::Min($dialogAttempts, 1000)
      dialogMatches = $dialogMatches
      ownerMatched = $ownerMatched
      nativeCandidateMatches = [Math]::Min($nativeCandidateMatches, 1000)
      nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete
    }
    Add-NativePickerRawCensusMetrics -Metrics $dialogMetrics -Maxima $rawCensusMaxima
    Set-NativePickerEvidence `
      -Stage 'dialog-discovered' `
      -Outcome 'running' `
      -Metrics $dialogMetrics

    $editorCandidateCompleteScanObserved = $false
    $editorMutationCompleteScanObserved = $false
    $editorReadbackCompleteScanObserved = $false
    $editorDeadline = (Get-Date).AddSeconds(30)
    do {
      $editorAttempts += 1
      $freshCandidate = Get-NativePickerPinnedCandidateState `
          -Element $dialog `
          -CandidateHandle $dialogHandle `
          -ProcessId $ProcessId `
          -OwnerHandle $OwnerHandle
      $nativeCandidateMatches = [Math]::Max(
        $nativeCandidateMatches,
        [int]$freshCandidate.ExactMatchCount
      )
      $nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete `
        -or [bool]$freshCandidate.EnumerationIncomplete `
        -or [bool]$freshCandidate.BridgeIncomplete
      if ($freshCandidate.ExactMatchCount -gt 1) {
        $failureCode = 'dialog-ambiguous'
        throw 'Installed application opened multiple native media pickers during filename interaction'
      }
      if ($freshCandidate.EnumerationIncomplete `
          -or $freshCandidate.BridgeIncomplete) {
        Start-Sleep -Milliseconds 100
        continue
      }
      $editorCandidateCompleteScanObserved = $true
      if (-not $freshCandidate.Valid) {
        $failureCode = 'dialog-changed'
        throw 'Native media picker identity changed before filename interaction'
      }
      $candidateChanged = $false
      $candidateRetry = $false
      $candidateAmbiguous = $false
      try {
        $mutationEditor = Get-NativePickerWritableEditor -Dialog $dialog
        $editorMatches = [Math]::Max($editorMatches, [int]$mutationEditor.MatchCount)
        if ($null -ne $mutationEditor.ValuePattern) {
          $editorWritable = $true
          $mutationCandidate = Get-NativePickerPinnedCandidateState `
              -Element $dialog `
              -CandidateHandle $dialogHandle `
              -ProcessId $ProcessId `
              -OwnerHandle $OwnerHandle
          $nativeCandidateMatches = [Math]::Max(
            $nativeCandidateMatches,
            [int]$mutationCandidate.ExactMatchCount
          )
          $nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete `
            -or [bool]$mutationCandidate.EnumerationIncomplete `
            -or [bool]$mutationCandidate.BridgeIncomplete
          if ($mutationCandidate.ExactMatchCount -gt 1) {
            $candidateAmbiguous = $true
          } elseif ($mutationCandidate.EnumerationIncomplete `
              -or $mutationCandidate.BridgeIncomplete) {
            $candidateRetry = $true
          } elseif (-not $mutationCandidate.Valid) {
            $candidateChanged = $true
          } else {
            $editorMutationCompleteScanObserved = $true
            $mutationEditor.ValuePattern.SetValue($MediaPath)
            $mutationEditor = $null

            $readbackCandidate = Get-NativePickerPinnedCandidateState `
                -Element $dialog `
                -CandidateHandle $dialogHandle `
                -ProcessId $ProcessId `
                -OwnerHandle $OwnerHandle
            $nativeCandidateMatches = [Math]::Max(
              $nativeCandidateMatches,
              [int]$readbackCandidate.ExactMatchCount
            )
            $nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete `
              -or [bool]$readbackCandidate.EnumerationIncomplete `
              -or [bool]$readbackCandidate.BridgeIncomplete
            if ($readbackCandidate.ExactMatchCount -gt 1) {
              $candidateAmbiguous = $true
            } elseif ($readbackCandidate.EnumerationIncomplete `
                -or $readbackCandidate.BridgeIncomplete) {
              $candidateRetry = $true
            } elseif (-not $readbackCandidate.Valid) {
              $candidateChanged = $true
            } else {
              $editorReadbackCompleteScanObserved = $true
              $readbackEditor = Get-NativePickerWritableEditor -Dialog $dialog
              $editorMatches = [Math]::Max($editorMatches, [int]$readbackEditor.MatchCount)
              if ($null -ne $readbackEditor.ValuePattern) {
                $valueRetained = [string]::Equals(
                  $readbackEditor.ValuePattern.Current.Value,
                  $MediaPath,
                  [StringComparison]::Ordinal
                )
              }
              $readbackEditor = $null
            }
          }
          $mutationEditor = $null
        }
      } catch {
        # Common-dialog descendants can be replaced while their shell view initializes.
        if (-not (Test-NativePickerElementCandidate `
            -Element $dialog `
            -CandidateHandle $dialogHandle `
            -ProcessId $ProcessId `
            -OwnerHandle $OwnerHandle)) {
          $candidateChanged = $true
        }
      }
      if ($candidateAmbiguous) {
        $failureCode = 'dialog-ambiguous'
        throw 'Installed application opened multiple native media pickers before filename mutation'
      }
      if ($candidateChanged) {
        $failureCode = 'dialog-changed'
        throw 'Native media picker identity changed during filename interaction'
      }
      if ($candidateRetry) {
        Start-Sleep -Milliseconds 100
        continue
      }
      if (-not $valueRetained) {
        Start-Sleep -Milliseconds 100
      }
    } until ($valueRetained -or (Get-Date) -ge $editorDeadline)
    if (-not $valueRetained) {
      $failureCode = if (-not $editorCandidateCompleteScanObserved `
          -or ($editorWritable `
            -and (-not $editorMutationCompleteScanObserved `
              -or -not $editorReadbackCompleteScanObserved))) {
        'dialog-action-incomplete'
      } elseif ($editorMatches -gt 1) {
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
    $buttonCandidateCompleteScanObserved = $false
    $buttonDeadline = (Get-Date).AddSeconds(30)
    $invokePattern = $null
    do {
      $buttonAttempts += 1
      $freshCandidate = Get-NativePickerPinnedCandidateState `
          -Element $dialog `
          -CandidateHandle $dialogHandle `
          -ProcessId $ProcessId `
          -OwnerHandle $OwnerHandle
      $nativeCandidateMatches = [Math]::Max(
        $nativeCandidateMatches,
        [int]$freshCandidate.ExactMatchCount
      )
      $nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete `
        -or [bool]$freshCandidate.EnumerationIncomplete `
        -or [bool]$freshCandidate.BridgeIncomplete
      if ($freshCandidate.ExactMatchCount -gt 1) {
        $failureCode = 'dialog-ambiguous'
        throw 'Installed application opened multiple native media pickers during confirmation discovery'
      }
      if ($freshCandidate.EnumerationIncomplete `
          -or $freshCandidate.BridgeIncomplete) {
        Start-Sleep -Milliseconds 100
        continue
      }
      $buttonCandidateCompleteScanObserved = $true
      if (-not $freshCandidate.Valid) {
        $failureCode = 'dialog-changed'
        throw 'Native media picker identity changed before confirmation discovery'
      }
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
      $failureCode = if (-not $buttonCandidateCompleteScanObserved) {
        'dialog-action-incomplete'
      } elseif ($buttonMatches -gt 1) {
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

    $freshCandidate = Get-NativePickerPinnedCandidateState `
        -Element $dialog `
        -CandidateHandle $dialogHandle `
        -ProcessId $ProcessId `
        -OwnerHandle $OwnerHandle
    $nativeCandidateMatches = [Math]::Max(
      $nativeCandidateMatches,
      [int]$freshCandidate.ExactMatchCount
    )
    $nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete `
      -or [bool]$freshCandidate.EnumerationIncomplete `
      -or [bool]$freshCandidate.BridgeIncomplete
    if ($freshCandidate.ExactMatchCount -gt 1) {
      $failureCode = 'dialog-ambiguous'
      throw 'Installed application opened multiple native media pickers before confirmation'
    }
    if ($freshCandidate.EnumerationIncomplete `
        -or $freshCandidate.BridgeIncomplete) {
      $failureCode = 'dialog-action-incomplete'
      throw 'Native media picker could not be revalidated immediately before confirmation'
    }
    if (-not $freshCandidate.Valid) {
      $failureCode = 'dialog-changed'
      throw 'Native media picker identity changed before confirmation'
    }
    $invokePattern.Invoke()
    Set-NativePickerEvidence -Stage 'button-invoked' -Outcome 'running'
    $dismissalCandidateCompleteScanObserved = $false
    $dismissDeadline = (Get-Date).AddSeconds(30)
    do {
      $dismissAttempts += 1
      Start-Sleep -Milliseconds 100
      try {
        $snapshot = Get-NativeMediaPickerDialogs `
          -ProcessId $ProcessId `
          -OwnerHandle $OwnerHandle
      } catch {
        $rawCensusMaxima.rawCensusIncomplete = $true
        throw
      }
      Update-NativePickerRawCensusMaxima -Maxima $rawCensusMaxima -Snapshot $snapshot
      $remainingCandidates = @($snapshot.NativeCandidates)
      $nativeCandidateMatches = [Math]::Max(
        $nativeCandidateMatches,
        [int]$snapshot.NativeExactMatchCount
      )
      $nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete `
        -or [bool]$snapshot.NativeCandidateScanIncomplete
      if ($snapshot.NativeExactMatchCount -gt 1) {
        $failureCode = 'dismissal-ambiguous'
        throw 'Native media picker multiplied after confirmation'
      }
      if ($snapshot.NativeCandidateEnumerationIncomplete) {
        continue
      }
      if (-not $snapshot.NativeCandidateBridgeIncomplete) {
        $dismissalCandidateCompleteScanObserved = $true
      }
      if ($snapshot.NativeExactMatchCount -eq 0 -and $remainingCandidates.Count -eq 0) {
        if ([OsgNativePickerWindow]::IsNormalizedWindow($dialogHandle)) {
          $failureCode = 'dismissal-changed'
          throw 'Native media picker changed identity instead of disappearing after confirmation'
        }
        $dialogDismissed = $true
      } elseif (-not $snapshot.NativeCandidateBridgeIncomplete `
          -and $snapshot.NativeExactMatchCount -eq 1 `
          -and $remainingCandidates.Count -eq 1) {
        if (-not (Test-NativePickerElementCandidate `
            -Element $remainingCandidates[0] `
            -CandidateHandle $dialogHandle `
            -ProcessId $ProcessId `
            -OwnerHandle $OwnerHandle)) {
          $failureCode = 'dialog-changed'
          throw 'Native media picker identity changed after confirmation'
        }
      }
    } until ($dialogDismissed -or (Get-Date) -ge $dismissDeadline)
    if (-not $dialogDismissed) {
      $failureCode = if (-not $dismissalCandidateCompleteScanObserved) {
        'dismissal-incomplete'
      } else {
        'dismissal-timeout'
      }
      throw 'Native media picker did not disappear after confirmation'
    }
    $dismissedMetrics = @{
      dismissAttempts = [Math]::Min($dismissAttempts, 1000)
      dialogDismissed = $dialogDismissed
      nativeCandidateMatches = [Math]::Min($nativeCandidateMatches, 1000)
      nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete
    }
    Add-NativePickerRawCensusMetrics -Metrics $dismissedMetrics -Maxima $rawCensusMaxima
    Set-NativePickerEvidence `
      -Stage 'dialog-dismissed' `
      -Outcome 'running' `
      -Metrics $dismissedMetrics
    [pscustomobject]@{
      DismissAttempts = [Math]::Min($dismissAttempts, 1000)
      DialogDismissed = $dialogDismissed
    }
  } catch {
    if ($failureCode -ceq 'dialog-timeout') {
      $diagnosticFailure = Get-NativePickerDiagnosticOutcomeSafely `
        -LogPath $LogPath `
        -BaselineSha256 $DiagnosticBaselineSha256 `
        -BaselineLength $DiagnosticBaselineLength `
        -AppInstanceId $AppInstanceId
      if ($diagnosticFailure -in @(
          'command-dispatch-timeout',
          'blocking-pool-dispatch-timeout',
          'worker-failed',
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
        -OwnerHandle $OwnerHandle `
        -ExpectedCandidateHandle $dialogHandle
    } catch {
      # The primary picker failure remains authoritative when best-effort cleanup also fails.
    }
    try {
      $failureMetrics = @{
        dialogAttempts = [Math]::Min($dialogAttempts, 1000)
        dialogMatches = [Math]::Min($dialogMatches, 1000)
        ownerMatched = $ownerMatched
        nativeCandidateMatches = [Math]::Min($nativeCandidateMatches, 1000)
        nativeCandidateScanIncomplete = $nativeCandidateScanIncomplete
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
        Update-NativePickerRawCensusMaxima `
          -Maxima $rawCensusMaxima `
          -Snapshot $dismissal.RawCensusMaxima
        $failureMetrics.nativeCandidateMatches = [Math]::Max(
          [int]$failureMetrics.nativeCandidateMatches,
          [int]$dismissal.NativeCandidateMatches
        )
        $failureMetrics.nativeCandidateScanIncomplete = `
          [bool]$failureMetrics.nativeCandidateScanIncomplete `
          -or [bool]$dismissal.NativeCandidateScanIncomplete
      } else {
        $rawCensusMaxima.rawCensusIncomplete = $true
        $failureMetrics.nativeCandidateScanIncomplete = $true
      }
      Add-NativePickerRawCensusMetrics -Metrics $failureMetrics -Maxima $rawCensusMaxima
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
    @(
      'starting',
      'connected',
      'tab-activated',
      'control-ready',
      'prior-state-validated',
      'click-issued'
    ) |
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
  $dialogCompleted = $false
  $pickerCompletion = $null
  $result = $null
  try {
    Wait-NativePickerClickIssued `
      -Inspector $inspection `
      -ApplicationProcessId $ProcessId `
      -PhaseRoot $env:RUNNER_TEMP `
      -StderrPath $stderr
    $pickerCompletion = Complete-NativeMediaPicker `
      -ProcessId $ProcessId `
      -OwnerHandle $ownerHandle `
      -MediaPath $MediaPath `
      -LogPath $LogPath `
      -DiagnosticBaselineSha256 $diagnosticBaseline.Sha256 `
      -DiagnosticBaselineLength $diagnosticBaseline.Length `
      -AppInstanceId $AppInstanceId
    $dialogCompleted = $true
    if ((@($pickerCompletion.PSObject.Properties.Name | Sort-Object) -join ',') `
        -cne 'DialogDismissed,DismissAttempts' `
        -or $pickerCompletion.DismissAttempts -isnot [int] `
        -or $pickerCompletion.DismissAttempts -lt 1 `
        -or $pickerCompletion.DismissAttempts -gt 1000 `
        -or $pickerCompletion.DialogDismissed -isnot [bool] `
        -or -not $pickerCompletion.DialogDismissed) {
      throw 'Installed native picker completion returned invalid bounded evidence'
    }
    if (-not $inspection.WaitForExit(120000)) {
      Stop-Process -Id $inspection.Id -ErrorAction SilentlyContinue
      throw 'Installed local-media flow did not finish within two minutes'
    }
    # Flush redirected stdout/stderr after the bounded wait observes process termination.
    $inspection.WaitForExit()
    $output = @(Get-Content -LiteralPath $stdout)
    $stderrState = Get-InstalledLocalMediaInspectorStderrState -Path $stderr
    if ($stderrState -ceq 'invalid') {
      throw 'Installed local-media inspector stderr was not regular and bounded'
    }
    if ($inspection.ExitCode -ne 0) {
      throw 'Installed local-media inspection failed after the native picker click'
    }
    if ($output.Count -ne 1 -or $stderrState -cne 'empty') {
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
  } catch {
    if ($dialogCompleted) {
      try {
        Set-NativePickerEvidence `
          -Stage 'failed' `
          -Outcome 'failed' `
          -FailureCode 'postclick-validation-failed'
      } catch {
        # Corrective evidence failure must never replace the original post-click ErrorRecord.
      }
    }
    throw
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
      try {
        Set-NativePickerEvidence `
          -Stage 'failed' `
          -Outcome 'failed' `
          -FailureCode 'postclick-validation-failed'
      } catch {
        # Corrective evidence failure must never replace the phase-cleanup ErrorRecord.
      }
      throw 'Installed local-media picker phase cleanup failed'
    }
  }
  Set-NativePickerEvidence `
    -Stage 'dialog-dismissed' `
    -Outcome 'succeeded' `
    -Metrics @{
      dismissAttempts = $pickerCompletion.DismissAttempts
      dialogDismissed = $pickerCompletion.DialogDismissed
    }
  $result
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
  $nativeToolFlow = $null
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
    # The first URL pass installs all three managed tools in parallel. The same-process hot
    # lifecycle then removes and reinstalls them through the real Tools UI before local FFprobe,
    # pipeline, and final URL flows prove every consumer picked up the fresh runtimes.
    $initialToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath
    $initialMediaFlow = Inspect-InstalledMediaFlow `
      -Port $third.DebugPort `
      -SrtPath $srtPath `
      -LogPath $logPath `
      -ScreenshotName 'osg-installed-media-flow-initial.png'
    $initialToolEvents = @(
      Get-DiagnosticEventsAfterBaseline `
        -LogPath $logPath `
        -BaselineSha256 $initialToolBaseline.Sha256 `
        -BaselineLength $initialToolBaseline.Length
    )
    Assert-NativeToolLifecycleDiagnostics `
      -Events $initialToolEvents `
      -AppInstanceId $third.AppInstanceId `
      -ExpectedInstalls 3 `
      -ExpectedRemovals 0
    $nativeToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath
    $nativeToolFlow = Inspect-InstalledNativeTools `
      -Port $third.DebugPort `
      -AssetId $initialMediaFlow.assetId
    $nativeToolEvents = @(
      Get-DiagnosticEventsAfterBaseline `
        -LogPath $logPath `
        -BaselineSha256 $nativeToolBaseline.Sha256 `
        -BaselineLength $nativeToolBaseline.Length
    )
    Assert-NativeToolLifecycleDiagnostics `
      -Events $nativeToolEvents `
      -AppInstanceId $third.AppInstanceId `
      -ExpectedInstalls 3 `
      -ExpectedRemovals 3
    $uiInstallPairs = @(
      $nativeToolFlow.installJobs |
        ForEach-Object { "$($_.id):$($_.jobId)" } |
        Sort-Object
    )
    $diagnosticInstallPairs = @(
      $nativeToolEvents |
        Where-Object { $_.event -ceq 'native-tool.started' -and $_.action -ceq 'install' } |
        ForEach-Object { "$($_.tool):$($_.job)" } |
        Sort-Object
    )
    if ($uiInstallPairs.Count -ne 3 `
        -or $diagnosticInstallPairs.Count -ne 3 `
        -or ($uiInstallPairs -join ',') -cne ($diagnosticInstallPairs -join ',')) {
      throw 'Native-tool UI status jobs did not match exact install diagnostics'
    }
    $postHotToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath
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
    $editorFlow = Inspect-InstalledEditorFlow -Port $third.DebugPort
    $postHotToolEvents = @(
      Get-DiagnosticEventsAfterBaseline `
        -LogPath $logPath `
        -BaselineSha256 $postHotToolBaseline.Sha256 `
        -BaselineLength $postHotToolBaseline.Length
    )
    Assert-NativeToolLifecycleDiagnostics `
      -Events $postHotToolEvents `
      -AppInstanceId $third.AppInstanceId `
      -ExpectedInstalls 0 `
      -ExpectedRemovals 0
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
    installedNativeTools = $nativeToolFlow
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
