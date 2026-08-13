const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ACTION_PINS,
  RELEASE_MATRIX,
  assertLockfiles,
  assertPinnedActions,
  assertPinnedToolchains,
  assertProductionCsp,
  assertEffectiveToolchain,
  assertInstalledSmokeScript,
  assertInstalledMediaFlowInspector,
  assertInstalledLocalMediaInspector,
  assertInstalledNativeToolsInspector,
  assertNativePickerEvidenceScripts,
  assertCiUpdaterFixtureDebugPortSource,
  assertCiUpdaterFixtureHandoffSource,
  assertDesktopCloseLifecycleSource,
  assertLoopbackAuditManifest,
  assertManagedEngineDelivery,
  assertNativeToolDelivery,
  assertNoMissingNativeCapabilities,
  assertNoUnmanagedLocalServices,
  assertRepositoryReleasePolicy,
  assertRequiredMediaToolDelivery,
  assertRenderRuntimeDelivery,
  assertUpdaterReleaseConfiguration,
  assertUpdaterFixtureSource,
  assertUpdaterSmokeWorkflow,
  assertSignedUpdaterScript,
  assertTauriNsisBootstrapScript,
  assertTauriProductionBuildContract,
  assertWorkerResources,
  assertWorkflowCommands,
  assertWorkflowMatrix,
  checkRuntimePackageReadiness,
  collectResourceMappings,
  collectPromptDjFontReleasePolicyFailures,
  normalizeDestination,
  parseArguments,
} = require('./check-release-readiness');

const INSTALLED_SMOKE_SCRIPT = fs.readFileSync(
  path.join(__dirname, 'test-installed-windows.ps1'),
  'utf8',
);
const NATIVE_PICKER_EVIDENCE_SCRIPT = fs.readFileSync(
  path.join(__dirname, 'native-picker-evidence.ps1'),
  'utf8',
);
const NATIVE_PICKER_EVIDENCE_REGRESSION = fs.readFileSync(
  path.join(__dirname, 'test-native-picker-evidence.ps1'),
  'utf8',
);
const INSTALLED_LOCAL_MEDIA_INSPECTOR = fs.readFileSync(
  path.join(__dirname, 'inspect-installed-local-media-flow.mjs'),
  'utf8',
);
const INSTALLED_MEDIA_FLOW_INSPECTOR = fs.readFileSync(
  path.join(__dirname, 'inspect-installed-media-flow.mjs'),
  'utf8',
);
const INPUT_METHODS_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'InputMethods.js'),
  'utf8',
);
const BUTTONS_CONTAINER_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'app', 'ButtonsContainer.jsx'),
  'utf8',
);
const INSTALLED_NATIVE_TOOLS_INSPECTOR = fs.readFileSync(
  path.join(__dirname, 'inspect-installed-native-tools.mjs'),
  'utf8',
);
const UPDATER_SMOKE_WORKFLOW = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'updater-smoke.yml'),
  'utf8',
);
const SIGNED_UPDATER_SCRIPT = fs.readFileSync(
  path.join(__dirname, 'test-signed-updater-windows.ps1'),
  'utf8',
);
const TAURI_NSIS_BOOTSTRAP_SCRIPT = fs.readFileSync(
  path.join(__dirname, 'prepare-tauri-nsis.ps1'),
  'utf8',
);
const DESKTOP_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'apps', 'desktop', 'src-tauri', 'src', 'lib.rs'),
  'utf8',
);
const CI_UPDATER_ARGUMENT_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'apps', 'desktop', 'src-tauri', 'src', 'ci_updater_fixture.rs'),
  'utf8',
);
const UPDATER_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'apps', 'desktop', 'src-tauri', 'src', 'updater.rs'),
  'utf8',
);
const CARGO_LOCK_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'Cargo.lock'),
  'utf8',
);

function createTauriProductionBuildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-tauri-production-build-'));
  writeFile(root, 'package.json', JSON.stringify({
    scripts: {
      build: 'npm run tauri:build',
      'tauri:build': 'npm --prefix apps/desktop run tauri:build --',
    },
  }));
  writeFile(root, 'apps/desktop/package.json', JSON.stringify({
    scripts: { 'tauri:build': 'tauri build --features production' },
  }));
  writeFile(
    root,
    'apps/desktop/src-tauri/Cargo.toml',
    '[features]\ndefault = []\nproduction = ["tauri/custom-protocol"]\n'
      + '[dependencies]\nrfd = { version = "=0.16.0", default-features = false }\n',
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/src/main.rs',
    '#[cfg(all(not(debug_assertions), not(feature = "production")))]\n'
      + 'compile_error!("release executables must be built with `npm run tauri:build`; '
      + 'plain `cargo build --release` retains the development URL");\n',
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/src/commands.rs',
    'use tauri::WebviewWindow;\n'
      + 'async fn select_media(window: WebviewWindow) {\n'
      + '  let dialog = rfd::FileDialog::new().set_parent(&window).set_title("Choose video or audio")\n'
      + '    .add_filter("Video and audio", &extensions);\n'
      + '  diagnostics::record("media-picker.requested", &[]);\n'
      + '  let Ok(selected) = tauri::async_runtime::spawn_blocking(move || {\n'
      + '    diagnostics::record("media-picker.worker-started", &[]);\n'
      + '    dialog.pick_file()\n'
      + '  }).await else {\n'
      + '    diagnostics::record("media-picker.worker-failed", &[]);\n'
      + '    return;\n'
      + '  };\n'
      + '  diagnostics::record("media-picker.returned", &[("outcome", media_picker_outcome(selected.as_ref()))]);\n'
      + '  let Some(path) = selected else { return; };\n'
      + '}\n',
  );
  return root;
}

function writeFile(root, relativePath, contents = 'fixture') {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
  return absolutePath;
}

function replaceInWorkflowJob(workflow, jobName, search, replacement) {
  const heading = `  ${jobName}:`;
  const start = workflow.indexOf(heading);
  assert.notEqual(start, -1, `Missing workflow job ${jobName}`);
  const nextJobOffset = workflow.slice(start + heading.length).search(/^  [a-zA-Z0-9_-]+:\s*$/m);
  const end = nextJobOffset === -1
    ? workflow.length
    : start + heading.length + nextJobOffset;
  const job = workflow.slice(start, end);
  assert.ok(job.includes(search), `${jobName} does not contain the requested mutation target`);
  return workflow.slice(0, start) + job.replace(search, replacement) + workflow.slice(end);
}

test('installed Windows smoke proves persistence, media, tools, logs, relaunch, uninstall, and reinstall', () => {
  assert.doesNotThrow(() => assertInstalledSmokeScript(INSTALLED_SMOKE_SCRIPT));
  assert.throws(
    () => assertInstalledSmokeScript(`${INSTALLED_SMOKE_SCRIPT}\n<# hidden proof #>\n`),
    /block comments/,
  );
  const lifecycleFunctionStart = INSTALLED_SMOKE_SCRIPT.indexOf(
    'function Assert-NativeToolLifecycleDiagnostics {',
  );
  const lifecycleFunctionEnd = INSTALLED_SMOKE_SCRIPT.indexOf(
    '\nfunction Get-NativePickerDiagnosticOutcome {',
    lifecycleFunctionStart,
  );
  assert.ok(lifecycleFunctionStart >= 0 && lifecycleFunctionEnd > lifecycleFunctionStart);
  const lifecycleFunction = INSTALLED_SMOKE_SCRIPT.slice(
    lifecycleFunctionStart,
    lifecycleFunctionEnd,
  );
  const lineCommentedLifecycle = [
    'function Assert-NativeToolLifecycleDiagnostics {',
    '  param(',
    '    [object[]]$Events,',
    '    [string]$AppInstanceId,',
    '    [int]$ExpectedInstalls,',
    '    [int]$ExpectedRemovals',
    '  )',
    '}',
    ...lifecycleFunction.split(/\r?\n/).map((line) => `# ${line}`),
  ].join('\n');
  const shadowedLifecycle = INSTALLED_SMOKE_SCRIPT.replace(
    '$third.Process.Refresh()',
    [
      'function Assert-NativeToolLifecycleDiagnostics {',
      '  param(',
      '    [object[]]$Events,',
      '    [string]$AppInstanceId,',
      '    [int]$ExpectedInstalls,',
      '    [int]$ExpectedRemovals',
      '  )',
      '}',
      '$third.Process.Refresh()',
    ].join('\n'),
  );
  const deadHotLifecycle = INSTALLED_SMOKE_SCRIPT
    .replace(
      '    $nativeToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath',
      '    if ($false) {\n    $nativeToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath',
    )
    .replace(
      '    $postHotToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath',
      '    }\n    $postHotToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath',
    );
  const commentedPreclickCategory = INSTALLED_SMOKE_SCRIPT.replace(
    '        Get-NativePickerPreclickFailureCode -Phase $phase',
    '        # Get-NativePickerPreclickFailureCode -Phase $phase',
  );
  for (const unreviewedExecutableSource of [
    INSTALLED_SMOKE_SCRIPT.slice(0, lifecycleFunctionStart)
      + lineCommentedLifecycle
      + INSTALLED_SMOKE_SCRIPT.slice(lifecycleFunctionEnd),
    shadowedLifecycle,
    deadHotLifecycle,
    commentedPreclickCategory,
  ]) {
    assert.notEqual(unreviewedExecutableSource, INSTALLED_SMOKE_SCRIPT);
    assert.throws(
      () => assertInstalledSmokeScript(unreviewedExecutableSource),
      /reviewed executable source/,
    );
  }
  for (const fragment of [
    "-Phase 'relaunch'",
    '$fontAfterRelaunch -cne $fontBeforeRelaunch',
    'Uninstall-Application -Installation $installed',
    '$reinstalled = Install-Application',
    "-Phase 'reinstall-launch'",
    'scripts/inspect-installed-webview.mjs',
    'scripts/inspect-installed-media-flow.mjs',
    'scripts/inspect-installed-local-media-flow.mjs',
    'scripts/inspect-installed-native-tools.mjs',
    'scripts/inspect-installed-media-pipeline.mjs',
    'scripts/inspect-installed-editor-flow.mjs',
    '$inspection = Inspect-InstalledWebView',
    '$initialMediaFlow = Inspect-InstalledMediaFlow',
    '$nativeToolFlow = Inspect-InstalledNativeTools',
    '$mediaFlow = Inspect-InstalledMediaFlow',
    "@('--prior-asset-id', $PriorAssetId)",
    '-PriorAssetId $localMediaFlow.assetId',
    '$localMediaFlow = Inspect-InstalledLocalMediaFlow',
    '-AssetId $initialMediaFlow.assetId',
    '-PriorAssetId $initialMediaFlow.assetId',
    '$mediaPipeline = Inspect-InstalledMediaPipeline',
    '$editorFlow = Inspect-InstalledEditorFlow',
    'function Inspect-InstalledNativeTools',
    'function Get-DiagnosticEventsAfterBaseline',
    'function Assert-NativeToolLifecycleDiagnostics',
    'function Inspect-InstalledMediaPipeline',
    'function Inspect-InstalledEditorFlow',
    "'--expected-source-name', $ExpectedSourceName",
    "'osg-installed-editor-flow.png'",
    'function Complete-NativeMediaPicker',
    ". (Join-Path $PSScriptRoot 'native-picker-evidence.ps1')",
    '-EvidencePath $nativePickerEvidencePath',
    '-AllowedRoot $runnerTempRoot',
    'Initialize-NativePickerEvidence',
    'function Get-NativeMediaPickerDialogs',
    'function Dismiss-NativeMediaPicker',
    "$nativePickerEvidencePath = Join-Path $runnerTempRoot 'osg-installed-native-picker-evidence.json'",
    '$nativePickerEvidenceBackupPath = "$nativePickerEvidencePath.bak"',
    'string.Equals(name.ToString(), "Choose video or audio", StringComparison.Ordinal)',
    'string.Equals(className.ToString(), "#32770", StringComparison.Ordinal)',
    'var owner = ReadOwnerWindow(window, out ownerError);',
    '-OwnerHandle $ownerHandle',
    '[StringComparison]::Ordinal',
    '$invokePattern.Invoke()',
    '$snapshot.NativeExactMatchCount -eq 0 -and $remainingCandidates.Count -eq 0',
    "-Stage 'dialog-dismissed'",
    "-Outcome 'succeeded'",
    'osg-installed-media-flow-initial.png',
    "Where-Object event -eq 'download.completed'",
    "'native-tool.requested'",
    "'native-tool.completed'",
    "'native-tool.started'",
    "'native-tool.failed'",
    "'native-tool.cancelled'",
    "'native-tool.invalid-terminal'",
    '$terminalFailures.Count -ne 0',
    '$requested.Count -ne $expectedCount',
    '$started.Count -ne $expectedCount',
    '$completed.Count -ne $expectedCount',
    "($startedJobs -join ',') -cne ($completedJobs -join ',')",
    "($startedPairs -join ',') -cne ($completedPairs -join ',')",
    "throw 'Native-tool lifecycle did not start all installs in parallel'",
    'function Get-DiagnosticEventCount',
    "Get-DiagnosticEventCount -LogPath $LogPath -Name 'app.close_requested'",
    '$Process.MainWindowHandle -eq [IntPtr]::Zero -or -not $Process.Responding',
    '$Process.ExitCode -ne 0',
    '$closeEventsAfter -ne ($closeEventsBefore + 1)',
    'Stop-Application -Process $first.Process -LogPath $logPath',
    'Stop-Application -Process $second.Process -LogPath $logPath',
    'Stop-Application -Process $third.Process -LogPath $logPath',
    '$startedDownloads.Count -ne 2',
    '$completedDownloads.Count -ne 2',
    '$startedDownloadJobs.Count -ne 2',
    '$completedDownloadJobs.Count -ne 2',
    "($startedDownloadJobs -join ',') -cne ($completedDownloadJobs -join ',')",
    '$invalidDownloadJobIds.Count -ne 0',
    "-notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'",
    "'download.cancelled'",
    "'download.failed'",
    "'download.admission_failed'",
    "'download.engine_failed'",
    "'download.command_failed'",
    "'download.inspection_failed'",
    '$failedDownloads.Count -ne 0',
    '$initialMediaFlow.assetId -eq $localMediaFlow.assetId',
    '$localMediaFlow.assetId -eq $mediaFlow.assetId',
    'installedInitialMediaFlow = $initialMediaFlow',
    'installedNativeTools = $nativeToolFlow',
    'installedMediaPipeline = $mediaPipeline',
    'installedEditorFlow = $editorFlow',
    'Installed smoke result evidence exposed a URL, capability, token, or filesystem path',
    '$rotationFixtureSha256 = Prepare-DiagnosticRotationFixture',
    '-ExpectedPreviousSha256 $rotationFixtureSha256',
    'diagnosticLogRotation = $true',
  ]) {
    assert.throws(
      () => assertInstalledSmokeScript(INSTALLED_SMOKE_SCRIPT.replaceAll(fragment, 'removed')),
      /Installed Windows smoke is missing lifecycle proof/,
    );
  }
  const reorderedInstalledMedia = INSTALLED_SMOKE_SCRIPT
    .replace(
      '$localMediaFlow = Inspect-InstalledLocalMediaFlow',
      '$temporaryInstalledMedia = Inspect-InstalledLocalMediaFlow',
    )
    .replace(
      '$mediaPipeline = Inspect-InstalledMediaPipeline',
      '$localMediaFlow = Inspect-InstalledLocalMediaFlow',
    )
    .replace(
      '$temporaryInstalledMedia = Inspect-InstalledLocalMediaFlow',
      '$mediaPipeline = Inspect-InstalledMediaPipeline',
    );
  assert.throws(
    () => assertInstalledSmokeScript(reorderedInstalledMedia),
    /ordered installed media flow/,
  );
  assert.throws(
    () => assertInstalledSmokeScript(INSTALLED_SMOKE_SCRIPT.replace(
      /\$initialMediaFlow\.assetId -eq \$localMediaFlow\.assetId `\r?\n\s*-or /,
      '',
    )),
    /Installed Windows smoke is missing lifecycle proof/,
  );
  for (const commentedPriorIdentityGate of [
    INSTALLED_SMOKE_SCRIPT.replace(
      "    $arguments += @('--prior-asset-id', $PriorAssetId)",
      "    # $arguments += @('--prior-asset-id', $PriorAssetId)",
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '      -PriorAssetId $localMediaFlow.assetId',
      '      # -PriorAssetId $localMediaFlow.assetId',
    ),
  ]) {
    assert.throws(
      () => assertInstalledSmokeScript(commentedPriorIdentityGate),
      /bind the second URL pass to the prior local-media identity/,
    );
  }
  for (const weakenedToolProof of [
    INSTALLED_SMOKE_SCRIPT.replace(
      '$requested.Count -ne $expectedCount',
      '$requested.Count -lt $expectedCount',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      "($startedJobs -join ',') -cne ($completedJobs -join ',')",
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      "($startedPairs -join ',') -cne ($completedPairs -join ',')",
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$entry.appInstanceId -cne $AppInstanceId',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$entry.timestampMs -isnot [string]',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$entry.event -isnot [string]',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$entry.action -isnot [string]',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$entry.tool -isnot [string]',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$entry.appInstanceId -isnot [string]',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$entry.job -isnot [string]',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$entry.code -isnot [string]',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '@($allStartedJobs | Sort-Object -Unique).Count -ne 6',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$result.pipeline.durationUs -isnot [ValueType]',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$result.pipeline.frameRate -isnot [ValueType]',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$result.pipeline.height -isnot [ValueType]',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$result.pipeline.width -isnot [ValueType]',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$result.installingScreenshot.sha256 -ceq [string]$result.installedScreenshot.sha256',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      "($uiInstallPairs -join ',') -cne ($diagnosticInstallPairs -join ',')",
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$uiInstallPairs.Count -ne 3',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$diagnosticInstallPairs.Count -ne 3',
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$postHotToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath',
      '$postHotToolBaseline = $nativeToolBaseline',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '      -ExpectedInstalls 0 `',
      '      -ExpectedInstalls 3 `',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '-ExpectedRemovals 3',
      '-ExpectedRemovals 0',
    ),
  ]) {
    assert.throws(
      () => assertInstalledSmokeScript(weakenedToolProof),
      /(?:Installed Windows smoke is missing lifecycle proof|Installed Windows smoke must retain exact bounded native-tool UI evidence|Installed native-tool diagnostic proof is missing exact invariant|Installed Windows smoke must execute exact native-tool correlation and hot-reuse guards)/,
    );
  }
  const commentedPairGuard = INSTALLED_SMOKE_SCRIPT.replace(
    /(^ {4}if \(\$uiInstallPairs[\s\S]*?^ {4}\}$)/m,
    (block) => block.split(/\r?\n/).map((line) => `# ${line}`).join('\n'),
  );
  const commentedPostHotCall = INSTALLED_SMOKE_SCRIPT.replace(
    /(^ {4}Assert-NativeToolLifecycleDiagnostics `\r?\n^ {6}-Events \$postHotToolEvents `[\s\S]*?^ {6}-ExpectedRemovals 0$)/m,
    (block) => block.split(/\r?\n/).map((line) => `# ${line}`).join('\n'),
  );
  const commentedInitialToolCall = INSTALLED_SMOKE_SCRIPT.replace(
    /(^ {4}Assert-NativeToolLifecycleDiagnostics `\r?\n^ {6}-Events \$initialToolEvents `[\s\S]*?^ {6}-ExpectedRemovals 0$)/m,
    (block) => block.split(/\r?\n/).map((line) => `# ${line}`).join('\n'),
  );
  const commentedHotToolCall = INSTALLED_SMOKE_SCRIPT.replace(
    /(^ {4}Assert-NativeToolLifecycleDiagnostics `\r?\n^ {6}-Events \$nativeToolEvents `[\s\S]*?^ {6}-ExpectedRemovals 3$)/m,
    (block) => block.split(/\r?\n/).map((line) => `# ${line}`).join('\n'),
  );
  for (const commentedToolGuard of [
    commentedPairGuard,
    commentedPostHotCall,
    commentedInitialToolCall,
    commentedHotToolCall,
  ]) {
    assert.notEqual(commentedToolGuard, INSTALLED_SMOKE_SCRIPT);
    assert.throws(
      () => assertInstalledSmokeScript(commentedToolGuard),
      /(?:exact native-tool correlation and hot-reuse guards|later consumers did not reinstall|missing lifecycle proof)/,
    );
  }
  for (const weakenedCloseProof of [
    INSTALLED_SMOKE_SCRIPT.replace(
      "throw 'Installed application exited before the graceful close request'",
      'return',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$closeEventsAfter -ne ($closeEventsBefore + 1)',
      '$false',
    ),
  ]) {
    assert.throws(
      () => assertInstalledSmokeScript(weakenedCloseProof),
      /(?:live responsive app|missing lifecycle proof)/,
    );
  }
  const omittedEditorMutationRescan = INSTALLED_SMOKE_SCRIPT.replace(
    '          $mutationCandidate = Get-NativePickerPinnedCandidateState `\n'
      + '              -Element $dialog `\n'
      + '              -CandidateHandle $dialogHandle `\n'
      + '              -ProcessId $ProcessId `\n'
      + '              -OwnerHandle $OwnerHandle',
    '          $mutationCandidate = $freshCandidate',
  );
  assert.notEqual(omittedEditorMutationRescan, INSTALLED_SMOKE_SCRIPT);
  assert.throws(
    () => assertInstalledSmokeScript(omittedEditorMutationRescan),
    /native-picker authority/,
  );
  for (const [weakenedIndex, weakenedPickerProof] of [
    INSTALLED_SMOKE_SCRIPT.replace('$dialog.FindAll(', '$dialog.FindFirst('),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$controls.Count -eq 1',
      '$controls.Count -ge 1',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      'Add-Type -AssemblyName UIAutomationClientSideProviders -ErrorAction Stop',
      '# omitted client-side provider load',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '[void][System.Windows.Automation.AutomationElement]::RootElement',
      '# omitted UI Automation bootstrap',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '[void][System.Windows.Automation.AutomationElement]::RootElement',
      '[void][System.Windows.Automation.AutomationElement]::RootElement.Current.Name',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      "@('button', 'combobox', 'edit')",
      "@('button', 'combobox')",
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$_.ClassName -ceq $providerClassName',
      '$_.ClassName -ieq $providerClassName',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$providerEntries.Count -ne 1 `\n        -or $null -eq $providerEntries[0].ClientSideProviderFactoryCallback',
      '$providerEntries.Count -lt 1',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '[System.Windows.Automation.ClientSideProviderDescription[]]@($providerEntries[0])',
      '[System.Windows.Automation.ClientSideProviderDescription[]]@($providerTable)',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '[System.Windows.Automation.AndCondition]::new(',
      '[System.Windows.Automation.OrCondition]::new(',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '[System.Windows.Automation.ControlType]::Edit',
      '[System.Windows.Automation.ControlType]::ComboBox',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '-IsEnabled $isEnabled',
      '-IsEnabled $true',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '-IsOffscreen $isOffscreen',
      '-IsOffscreen $false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '-HasValuePattern $hasValuePattern',
      '-HasValuePattern $true',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '-IsReadOnly $isReadOnly',
      '-IsReadOnly $false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '            $mutationEditor = $null\n\n            $readbackCandidate = Get-NativePickerPinnedCandidateState',
      '            $readbackCandidate = Get-NativePickerPinnedCandidateState',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$readbackEditor = Get-NativePickerWritableEditor -Dialog $dialog',
      '$readbackEditor = $mutationEditor',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$openButtons.Count -eq 1',
      '$openButtons.Count -ge 1',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$snapshot.NativeExactMatchCount -eq 0 -and $remainingCandidates.Count -eq 0',
      '$remainingCandidates.Count -le 1',
    ),
    INSTALLED_SMOKE_SCRIPT.replaceAll(
      '[OsgNativePickerWindow]::IsNormalizedWindow(',
      '$false -and [OsgNativePickerWindow]::IsNormalizedWindow(',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      'private const int MaximumRetainedCandidates = 2',
      'private const int MaximumRetainedCandidates = 3',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      'return sameProcess && visible && classMatches && nameMatches && ownerMatches;',
      'return sameProcess && visible && classMatches && nameMatches;',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      'return unchecked((long)(uint)window);',
      'return window;',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      'NormalizeNativeWindowHandle(ancestor) != normalizedWindow',
      'ancestor != window',
    ),
    INSTALLED_SMOKE_SCRIPT.replaceAll('SetLastError(0);', ''),
    INSTALLED_SMOKE_SCRIPT.replace(
      'titleLength == 0 && titleError != 0',
      'false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      'ownerMissing && ownerError != 0',
      'false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '  if (-not $scan.Incomplete `\n'
        + '      -and $scan.ExactMatchCount -eq 1 `\n'
        + '      -and @($scan.Candidates).Count -eq 1) {',
      '  if ($scan.ExactMatchCount -ge 1) {',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '  $rawCensus = $null\n',
      '  $rawCensus = $null\n'
        + '  $root = [System.Windows.Automation.AutomationElement]::RootElement\n'
        + '  [void]$root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)\n',
    ),
    INSTALLED_SMOKE_SCRIPT.replaceAll(
      'Get-NativePickerPinnedCandidateState',
      'Test-NativePickerElementCandidate',
    ),
    INSTALLED_SMOKE_SCRIPT.replaceAll(
      '$editorMutationCompleteScanObserved',
      '$editorCandidateCompleteScanObserved',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$rawCensus = [pscustomobject]$fallback',
      '$rawCensus = [pscustomobject]$fallback\n    $nativeCandidates = $fallback',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '    CandidateElements = $candidateElements',
      '    CandidateElements = $candidateElements\n    candidateHandle = 1',
    ),
    INSTALLED_SMOKE_SCRIPT.replace('EnumWindows(callback, IntPtr.Zero)', 'true'),
    INSTALLED_SMOKE_SCRIPT.replace(
      'private const int MaximumEnumeratedWindows = 512',
      'private const int MaximumEnumeratedWindows = 1024',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '[Math]::Max([int]$Maxima[$name], [int]$value)',
      '[int]$value',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      'if (classMatches && nameMatches) {',
      'if (ownerMatches && classMatches && nameMatches) {',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      'if (sameProcess || classMatches) {',
      'if (classMatches) {',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$snapshot.NativeExactMatchCount -eq 1 -and $nativeCandidates.Count -eq 1',
      '$snapshot.RawProcessExactMatches -eq 1',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      'Update-NativePickerRawCensusMaxima -Maxima $rawCensusMaxima -Snapshot $snapshot',
      '# omitted raw census update',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      'Add-NativePickerRawCensusMetrics -Metrics $failureMetrics -Maxima $rawCensusMaxima',
      '# omitted failed raw census evidence',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '      } else {\n'
        + '        $rawCensusMaxima.rawCensusIncomplete = $true\n'
        + '        $failureMetrics.nativeCandidateScanIncomplete = $true\n'
        + '      }\n'
        + '      Add-NativePickerRawCensusMetrics -Metrics $failureMetrics',
      '      } else {\n'
        + '        # missing cleanup census misreported as complete\n'
        + '      }\n'
        + '      Add-NativePickerRawCensusMetrics -Metrics $failureMetrics',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '      } catch {\n'
        + '        $rawCensusMaxima.rawCensusIncomplete = $true\n'
        + '        throw\n'
        + '      }\n'
        + '      Update-NativePickerRawCensusMaxima',
      '      } catch {\n'
        + '        throw\n'
        + '      }\n'
        + '      Update-NativePickerRawCensusMaxima',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '    Update-NativePickerRawCensusMaxima -Maxima $rawCensusMaxima -Snapshot $snapshot\n'
        + '    $nativeCandidates = @($snapshot.NativeCandidates)',
      '    # omitted cleanup raw census update\n'
        + '    $nativeCandidates = @($snapshot.NativeCandidates)',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '    if ($snapshot.NativeExactMatchCount -gt 1) {',
      '    if ($snapshot.RawProcessOwnerMatches -gt 1) {',
    ),
    INSTALLED_SMOKE_SCRIPT.replaceAll('RawDesktopExactMatches', 'RawProcessExactMatches'),
    INSTALLED_SMOKE_SCRIPT.replaceAll('RawCensusIncomplete', 'RawCensusComplete'),
    INSTALLED_SMOKE_SCRIPT.replace(
      'public int RawProcessWindowMatches { get; internal set; }',
      'public int RawProcessWindowMatches { get; internal set; }\n'
        + '    public int RawWindowTitle { get; internal set; }',
    ),
    INSTALLED_SMOKE_SCRIPT.replace('$snapshotAttempt -lt 5', '$snapshotAttempt -lt 1'),
    INSTALLED_SMOKE_SCRIPT.replace('$nonPrefix = $true', '$nonPrefix = $false'),
    INSTALLED_SMOKE_SCRIPT.replace('$phase.schemaVersion -isnot [int]', '$false'),
    INSTALLED_SMOKE_SCRIPT.replace('$phase.stage -isnot [string]', '$false'),
    INSTALLED_SMOKE_SCRIPT.replace('$phase.schemaVersion -ne 1', '$false'),
    INSTALLED_SMOKE_SCRIPT.replace('$phase.stage -cne $stage', '$false'),
    INSTALLED_SMOKE_SCRIPT.replace("'tab-activated',", ''),
    INSTALLED_SMOKE_SCRIPT.replace('$item.Length -gt 16384', '$false'),
    INSTALLED_SMOKE_SCRIPT.replace(
      'Get-InstalledLocalMediaInspectorStderrState -Path $StderrPath',
      'Get-Content -LiteralPath $StderrPath',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      "'connected' { 'inspector-tab-activation-exited' }",
      "'connected' { 'inspector-startup-exited' }",
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      "if ($phase -ceq 'click-issued')",
      "if ($phase -ceq 'prior-state-validated')",
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '$_.appInstanceId -ceq $AppInstanceId',
      '$true',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      'while ($offset -lt $snapshotBytes.Length)',
      'if ($offset -lt $snapshotBytes.Length)',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '[Text.Encoding]::UTF8.GetString($snapshotBytes)',
      '[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($LogPath))',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      "$pickerDiagnosticOutcome -cne 'selected'",
      '$false',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '-PriorAssetId $initialMediaFlow.assetId',
      '-PriorAssetId $third.AppInstanceId',
    ),
  ].entries()) {
    assert.notEqual(weakenedPickerProof, INSTALLED_SMOKE_SCRIPT, `picker hostile mutation ${weakenedIndex}`);
    assert.throws(
      () => assertInstalledSmokeScript(weakenedPickerProof),
      /(?:native-picker automation|native-picker editor selection|native-picker evidence|native-picker diagnostics|native-picker raw census|native-picker (?:authoritative )?candidate|native-picker authority|native-picker bridge|native-picker polling|native-tool events|local-media pre-click failures|reviewed executable source|missing lifecycle proof)/,
    );
  }
  for (const prematureOrUncorrectedSuccess of [
    INSTALLED_SMOKE_SCRIPT.replace(
      "    Set-NativePickerEvidence `\n      -Stage 'dialog-dismissed' `\n      -Outcome 'running' `",
      "    Set-NativePickerEvidence `\n      -Stage 'dialog-dismissed' `\n      -Outcome 'succeeded' `",
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      "      dismissAttempts = $pickerCompletion.DismissAttempts",
      '      dismissAttempts = 0',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      '        # Corrective evidence failure must never replace the original post-click ErrorRecord.',
      '        throw',
    ),
    INSTALLED_SMOKE_SCRIPT.replace(
      "          -FailureCode 'postclick-validation-failed'",
      "          -FailureCode 'unexpected'",
    ),
  ]) {
    assert.notEqual(prematureOrUncorrectedSuccess, INSTALLED_SMOKE_SCRIPT);
    assert.throws(
      () => assertInstalledSmokeScript(prematureOrUncorrectedSuccess),
      /(?:delay success through cleanup|native-picker automation|missing lifecycle proof|reviewed executable source)/,
    );
  }
  assert.throws(
    () => assertInstalledSmokeScript(INSTALLED_SMOKE_SCRIPT.replace(
      '$invokePattern.Invoke()',
      '$openButtons[0].SetFocus()',
    )),
    /(?:non-focus-stealing|native-picker automation|missing lifecycle proof)/,
  );
  assert.throws(
    () => assertInstalledSmokeScript(INSTALLED_SMOKE_SCRIPT.replace(
      /    throw\r?\n  \}\r?\n\}\r?\n\r?\nfunction Inspect-InstalledLocalMediaFlow/,
      '    return\n  }\n}\n\nfunction Inspect-InstalledLocalMediaFlow',
    )),
    /preserve its primary exception/,
  );
  assert.throws(
    () => assertInstalledSmokeScript(`${INSTALLED_SMOKE_SCRIPT}\nInvoke-WebRequest https://example.test/app.exe\n`),
    /without a second download/,
  );
});

test('native-picker evidence uses bounded backups and real multi-stage replacement coverage', () => {
  assert.doesNotThrow(() => assertNativePickerEvidenceScripts(
    NATIVE_PICKER_EVIDENCE_SCRIPT,
    NATIVE_PICKER_EVIDENCE_REGRESSION,
  ));

  for (const [weakenedScript, description] of [
    [
      NATIVE_PICKER_EVIDENCE_SCRIPT.replace(
        /(\[IO\.File\]::Replace\(\s*\$script:nativePickerEvidenceTemporaryPath,\s*\$script:nativePickerEvidencePath,\s*)\$script:nativePickerEvidenceBackupPath/,
        (_match, prefix) => `${prefix}$null`,
      ),
      'null primary replacement backup',
    ],
    [
      NATIVE_PICKER_EVIDENCE_SCRIPT.replace(
        /(\[IO\.File\]::Replace\(\s*\$script:nativePickerEvidenceTemporaryPath,\s*\$script:nativePickerEvidencePath,\s*)\$script:nativePickerEvidenceBackupPath/,
        (_match, prefix) => `${prefix}''`,
      ),
      'empty primary replacement backup',
    ],
    [
      NATIVE_PICKER_EVIDENCE_SCRIPT.replace(
        /(\[IO\.File\]::Replace\(\s*\$script:nativePickerEvidenceBackupPath,\s*\$script:nativePickerEvidencePath,\s*)\$script:nativePickerEvidenceTemporaryPath/,
        (_match, prefix) => `${prefix}''`,
      ),
      'empty recovery replacement backup',
    ],
    [
      NATIVE_PICKER_EVIDENCE_SCRIPT.replace(
        '-not [string]::Equals($parent, $Root, [StringComparison]::OrdinalIgnoreCase)',
        '$false',
      ),
      'removed direct-child comparison',
    ],
    [
      NATIVE_PICKER_EVIDENCE_SCRIPT.replace(
        '($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0',
        '($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0',
      ),
      'inverted root reparse rejection',
    ],
    [
      NATIVE_PICKER_EVIDENCE_SCRIPT.replace(
        '  while (-not [string]::IsNullOrEmpty($candidate)) {',
        '  while ($false) {',
      ),
      'removed root ancestor walk',
    ],
    [
      NATIVE_PICKER_EVIDENCE_SCRIPT.replace(
        /\[IO\.File\]::Move\(\s*\$script:nativePickerEvidenceBackupPath,\s*\$script:nativePickerEvidencePath\s*\)/,
        '[IO.File]::Move($script:nativePickerEvidenceBackupPath, $script:nativePickerEvidenceTemporaryPath)',
      ),
      'redirected missing-destination restore',
    ],
    [
      NATIVE_PICKER_EVIDENCE_SCRIPT.replace(
        'Assert-NativePickerEvidenceRegularFile -Item $item',
        'Write-Output $item | Out-Null',
      ),
      'removed bounded scratch-file validation',
    ],
    [
      NATIVE_PICKER_EVIDENCE_SCRIPT.replaceAll(
        '$preserveTemporary = $true',
        '$preserveTemporary = $false',
      ),
      'weakened fail-closed recovery',
    ],
  ]) {
    assert.notEqual(
      weakenedScript,
      NATIVE_PICKER_EVIDENCE_SCRIPT,
      `Hostile mutation must alter the evidence writer: ${description}`,
    );
    assert.throws(
      () => assertNativePickerEvidenceScripts(
        weakenedScript,
        NATIVE_PICKER_EVIDENCE_REGRESSION,
      ),
      /Native-picker evidence/,
      description,
    );
  }

  const payloadLeak = NATIVE_PICKER_EVIDENCE_SCRIPT.replace(
    '    schemaVersion = 1',
    '    schemaVersion = 1\n    mediaPath = $MediaPath',
  );
  assert.notEqual(payloadLeak, NATIVE_PICKER_EVIDENCE_SCRIPT);
  assert.throws(
    () => assertNativePickerEvidenceScripts(
      payloadLeak,
      NATIVE_PICKER_EVIDENCE_REGRESSION,
    ),
    /payload must remain bounded/,
  );

  for (const weakenedRawSchema of [
    NATIVE_PICKER_EVIDENCE_SCRIPT.replace("    'rawProcessWindowMatches',\n", ''),
    NATIVE_PICKER_EVIDENCE_SCRIPT.replace('    rawProcessWindowMatches = 0\n', ''),
    NATIVE_PICKER_EVIDENCE_SCRIPT.replace('$metric.Value -le 1000', '$metric.Value -le 10000'),
    NATIVE_PICKER_EVIDENCE_SCRIPT.replace(
      "    'rawCensusIncomplete',",
      "    'rawWindowTitle',",
    ),
  ]) {
    assert.notEqual(weakenedRawSchema, NATIVE_PICKER_EVIDENCE_SCRIPT);
    assert.throws(
      () => assertNativePickerEvidenceScripts(
        weakenedRawSchema,
        NATIVE_PICKER_EVIDENCE_REGRESSION,
      ),
      /(?:raw census schema|payload must remain bounded)/,
    );
  }

  for (const weakenedRegression of [
    NATIVE_PICKER_EVIDENCE_REGRESSION.replaceAll(
      'Set-NativePickerEvidence',
      'Write-Output',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      '[IO.Directory]::CreateDirectory($hostileBackupPath)',
      '[IO.File]::WriteAllText($hostileBackupPath, "decoy")',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      "    throw 'Native picker evidence regression accepted a non-child destination'",
      '    Write-Output decoy',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      '      throw "Native picker evidence regression did not restore prior bytes for $fault"',
      '      Write-Output decoy',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      "    throw 'Native picker evidence regression accepted a reparse ancestor'",
      '    Write-Output decoy',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      "    throw 'Native picker diagnostic regression merged command and blocking-pool dispatch stalls'",
      '    Write-Output decoy',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      '    pickerWorkerBoundarySplit = $true',
      '    pickerWorkerBoundarySplit = $false',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      '    rawCensusBucketsIndependent = $true',
      '    rawCensusBucketsIndependent = $false',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      '    clientSideProvidersRegistered = $true',
      '    clientSideProvidersRegistered = $false',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      '    filenameEditorSelectorExact = $true',
      '    filenameEditorSelectorExact = $false',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      '    filenameEditorReadbackReacquired = $true',
      '    filenameEditorReadbackReacquired = $false',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      "      throw 'Native picker regression selected an ambiguous, disabled, offscreen, patternless, or read-only filename editor'",
      '      Write-Output decoy',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      "    throw 'Native picker raw census regression lost bounded maximum aggregation'",
      '    Write-Output decoy',
    ),
    NATIVE_PICKER_EVIDENCE_REGRESSION.replace(
      "    throw 'Native picker raw census regression allowed diagnostics to control UIA authority'",
      '    Write-Output decoy',
    ),
  ]) {
    assert.notEqual(weakenedRegression, NATIVE_PICKER_EVIDENCE_REGRESSION);
    assert.throws(
      () => assertNativePickerEvidenceScripts(
        NATIVE_PICKER_EVIDENCE_SCRIPT,
        weakenedRegression,
      ),
      /regression must execute multiple real replacements/,
    );
  }
});

test('installed local-media picker handshake publishes atomic create-once ordered phases', () => {
  assert.doesNotThrow(() => assertInstalledLocalMediaInspector(
    INSTALLED_LOCAL_MEDIA_INSPECTOR,
    INPUT_METHODS_SOURCE,
  ));
  const linkLine = '    fs.linkSync(temporaryPath, phasePath);\n';
  const fsyncLine = '    fs.fsyncSync(descriptor);\n';
  const linkBeforeFlush = INSTALLED_LOCAL_MEDIA_INSPECTOR
    .replace(linkLine, '')
    .replace(fsyncLine, `${linkLine}${fsyncLine}`);
  const regressiveDuplicate = INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
    "    writePickerPhase(options.phaseDirectory, 'control-ready');",
    "    writePickerPhase(options.phaseDirectory, 'control-ready');\n"
      + "    writePickerPhase(options.phaseDirectory, 'starting');",
  );
  const commentedActivationWait = INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
    '      () => evaluate(client, OPEN_PICKER_EXPRESSION),',
    '      // () => evaluate(client, OPEN_PICKER_EXPRESSION),',
  );
  const deadActivationWait = INSTALLED_LOCAL_MEDIA_INSPECTOR
    .replace(
      'export async function waitForPickerTabActivation(read, options = {}) {',
      'if (false) {\nexport async function waitForPickerTabActivation(read, options = {}) {',
    )
    .replace(
      '\n\nconst evaluate = async (client, expression) => {',
      '\n}\n\nconst evaluate = async (client, expression) => {',
    );
  for (const weakened of [
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace('fs.linkSync(temporaryPath, phasePath)', 'fs.renameSync(temporaryPath, phasePath)'),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace('fs.fsyncSync(descriptor)', '// omitted durable flush'),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace('throw error;', 'throw new Error("cleanup replaced primary")'),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      'JSON.stringify({ schemaVersion: 1, stage })',
      "JSON.stringify({ schemaVersion: 9, stage: 'click-issued' })",
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      'value.assetId !== priorAssetId',
      'value.assetId === priorAssetId',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      "if (uploadTab.classList.contains('active')) return 'already-active';",
      "if (uploadTab.classList.contains('active')) { uploadTab.click(); return 'already-active'; }",
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      "return 'activated';",
      "return 'already-active';",
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      'activeTabs[0] === uploadTab',
      'activeTabs[0] !== uploadTab',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      "':scope > .tab-content-wrapper div.file-upload-input:not(.loading)'",
      "'.file-upload-input'",
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replaceAll(
      "tabList.querySelectorAll(':scope > button.tab-btn')",
      "tabList.querySelectorAll(':scope button.tab-btn')",
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replaceAll(
      'directButtons.length !== tabs.length',
      'directButtons.length < tabs.length',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replaceAll(
      '!directButtons.every((button) => tabs.includes(button))',
      'directButtons.some((button) => tabs.includes(button))',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      '  picker.click();\n  return true;',
      '  return true;',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      '  picker.click();\n  return true;',
      '  picker.click();\n  picker.click();\n  return true;',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      '  picker.click();\n  return true;',
      '  uploadTab.click();\n  picker.click();\n  return true;',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      '  picker.click();\n  return true;',
      '  document.body.click();\n  picker.click();\n  return true;',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      '  const picker = pickers[0];\n  const input = picker?.querySelector(',
      '  const picker = pickers[0];\n  uploadTab.click();\n  const input = picker?.querySelector(',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      '  picker.click();\n  return true;',
      '  document.body.click();\n  return true;',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      'pickers.length !== 1 || !(pickers[0] instanceof HTMLDivElement)',
      'pickers.length < 1',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      "const expectedRendererAssetId = tabActivation === 'already-active' ? priorAssetId : null;",
      'const expectedRendererAssetId = priorAssetId;',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      'value.sessionMediaId === priorAssetId',
      'value.sessionMediaId === expectedRendererAssetId',
    ),
    INSTALLED_LOCAL_MEDIA_INSPECTOR.replace(
      '      tabActivation,',
      "      'already-active',",
    ),
    linkBeforeFlush,
    regressiveDuplicate,
  ]) {
    assert.notEqual(weakened, INSTALLED_LOCAL_MEDIA_INSPECTOR);
    assert.throws(
      () => assertInstalledLocalMediaInspector(weakened, INPUT_METHODS_SOURCE),
      /Installed local-media picker phases|Installed local-media inspector must (?:bind|reject|preserve)/,
    );
  }
  for (const unreviewedExecutableSource of [
    `${INSTALLED_LOCAL_MEDIA_INSPECTOR}\n// unreviewed executable-source drift\n`,
    commentedActivationWait,
    deadActivationWait,
  ]) {
    assert.notEqual(unreviewedExecutableSource, INSTALLED_LOCAL_MEDIA_INSPECTOR);
    assert.throws(
      () => assertInstalledLocalMediaInspector(unreviewedExecutableSource, INPUT_METHODS_SOURCE),
      /reviewed executable source/,
    );
  }
  const misplacedSemanticSelector = INPUT_METHODS_SOURCE
    .replace('\n            data-input-tab="file-upload"', '')
    .replace(
      "onClick={() => setActiveTab('unified-url')}",
      "data-input-tab=\"file-upload\"\n            onClick={() => setActiveTab('unified-url')}",
    );
  assert.notEqual(misplacedSemanticSelector, INPUT_METHODS_SOURCE);
  assert.equal(
    (misplacedSemanticSelector.match(/data-input-tab="file-upload"/g) || []).length,
    1,
  );
  assert.throws(
    () => assertInstalledLocalMediaInspector(
      INSTALLED_LOCAL_MEDIA_INSPECTOR,
      misplacedSemanticSelector,
    ),
    /unique picker selector/,
  );
});

test('installed URL media flow commits URL and replaces stale SRT before one download', () => {
  assert.doesNotThrow(() => assertInstalledMediaFlowInspector(
    INSTALLED_MEDIA_FLOW_INSPECTOR,
    INPUT_METHODS_SOURCE,
    BUTTONS_CONTAINER_SOURCE,
  ));
  const replaceWithin = (source, startMarker, endMarker, search, replacement) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `missing scoped block ${startMarker}`);
    const block = source.slice(start, end);
    assert.equal(block.split(search).length, 2, `non-unique scoped mutation ${search}`);
    const changedBlock = block.replace(search, replacement);
    assert.notEqual(changedBlock, block, `unchanged scoped mutation ${search}`);
    return source.slice(0, start) + changedBlock + source.slice(end);
  };
  const mutations = [
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      'evaluate(client, URL_COMMITTED_EXPRESSION)',
      'evaluate(client, URL_CONTROL_READY_EXPRESSION)',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "(previews[0].textContent ?? '').trim() === ${JSON.stringify(MEDIA_URL)}",
      'previews.length >= 0',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "localStorage.getItem('current_video_url') === ${JSON.stringify(MEDIA_URL)}",
      'true',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      '      () => evaluate(client, URL_COMMITTED_EXPRESSION),\n'
        + '      (value) => value === true,\n'
        + "      { timeoutMs: 60_000, failureCode: 'url-commit-timeout' },\n"
        + '    );\n'
        + '    await waitForValue(\n'
        + '      () => evaluate(client, RESET_SRT_EXPRESSION),',
      '      () => evaluate(client, RESET_SRT_EXPRESSION),\n'
        + "      (value) => value === 'already-clear' || value === 'cleared',\n"
        + "      { timeoutMs: 30_000, failureCode: 'srt-readiness-timeout' },\n"
        + '    );\n'
        + '    await waitForValue(\n'
        + '      () => evaluate(client, URL_COMMITTED_EXPRESSION),',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      '  clearButtons[0].click();\n  return \'cleared\';',
      "  return 'cleared';",
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "    && !uploadButtons[0].classList.contains('has-srt-uploaded')",
      "    && uploadButtons[0].classList.contains('has-srt-uploaded')",
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "    && info.hasUploaded === false && info.fileName === '' && info.source === ''",
      '    && info.hasUploaded === true',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "    && info.fileName === 'osg-installed-media-smoke.srt'",
      '    && typeof info.fileName === \'string\'',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "    && info.source === 'srt'",
      '    && typeof info.source === \'string\'',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "    && document.body.innerText.includes(${JSON.stringify(SUBTITLE_MARKER)})",
      '    && true',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      'Array.isArray(inputs.nodeIds) && inputs.nodeIds.length === 1',
      'Array.isArray(inputs.nodeIds) && inputs.nodeIds.length >= 1',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "    await client.send('DOM.setFileInputFiles', {\n"
        + '      files: [options.srt], nodeId: inputs.nodeIds[0],\n'
        + '    });\n',
      '',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "    await client.send('DOM.setFileInputFiles', {",
      "    void client.send('DOM.setFileInputFiles', {",
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "    await client.send('DOM.setFileInputFiles', {\n"
        + '      files: [options.srt], nodeId: inputs.nodeIds[0],\n'
        + '    });\n',
      "    await client.send('DOM.setFileInputFiles', {\n"
        + '      files: [options.srt], nodeId: inputs.nodeIds[0],\n'
        + '    });\n'
        + "    await evaluate(client, `inputs[0].dispatchEvent(new Event('change'))`);\n",
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      '      || buttons.length !== 1 || !(buttons[0] instanceof HTMLButtonElement)\n'
        + '      || buttons[0].disabled',
      '      || buttons.length < 1 || !(buttons[0] instanceof HTMLButtonElement)\n'
        + '      || buttons[0].disabled',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "    && startButtons[0].dataset.generationMode === 'url-with-srt';",
      '    && true;',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "      || buttons[0].dataset.generationMode !== 'url-with-srt') return false;",
      ') return false;',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replaceAll(
      "':scope .generate-btn.semi-auto'",
      "':scope .generate-btn.semi-auto[data-generation-mode=\"url-with-srt\"]'",
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      '  buttons[0].click();\n  return true;',
      '  buttons[0].click();\n  buttons[0].click();\n  return true;',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "{ timeoutMs: 30_000, failureCode: 'download-start-timeout' }",
      "{ timeoutMs: 30_000, failureCode: 'terminal-state-timeout' }",
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "      { failureCode: 'terminal-state-timeout' },",
      "      { failureCode: 'srt-readiness-timeout' },",
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "      { timeoutMs: 30_000, failureCode: 'url-tab-timeout' },\n"
        + '    );\n'
        + '    await waitForValue(\n'
        + '      () => evaluate(client, URL_CONTROL_READY_EXPRESSION),',
      "      { timeoutMs: 30_000, failureCode: 'url-commit-timeout' },\n"
        + '    );\n'
        + '    await waitForValue(\n'
        + '      () => evaluate(client, URL_CONTROL_READY_EXPRESSION),',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      "      { timeoutMs: 30_000, failureCode: 'srt-clear-timeout' },\n"
        + '    );\n'
        + '    await waitForValue(\n'
        + '      () => evaluate(client, SRT_CLEARED_EXPRESSION),',
      "      { timeoutMs: 30_000, failureCode: 'srt-readiness-timeout' },\n"
        + '    );\n'
        + '    await waitForValue(\n'
        + '      () => evaluate(client, SRT_CLEARED_EXPRESSION),',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replaceAll(
      '.buttons-container .srt-upload-buttons-group input[type="file"][accept=".srt,.json"]',
      '.srt-upload-buttons-group input[type="file"][accept=".srt,.json"]',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      'REVIEWED_TIMEOUT_FAILURE_CODES.includes(failureCode)',
      'typeof failureCode === \'string\'',
    ),
    INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
      'throw new Error(`Installed media flow timed out: ${failureCode}`)',
      "throw new Error('Installed media flow timed out')",
    ),
  ];
  for (const [index, mutation] of mutations.entries()) {
    assert.notEqual(mutation, INSTALLED_MEDIA_FLOW_INSPECTOR, `media-flow mutation ${index}`);
    assert.throws(
      () => assertInstalledMediaFlowInspector(
        mutation,
        INPUT_METHODS_SOURCE,
        BUTTONS_CONTAINER_SOURCE,
      ),
      /Installed media-flow inspector must/,
      `media-flow mutation ${index}`,
    );
  }
  const exactSetFileInputCall = [
    "    await client.send('DOM.setFileInputFiles', {",
    '      files: [options.srt], nodeId: inputs.nodeIds[0],',
    '    });',
    '',
  ].join('\n');
  const exactSrtReadyWaitStart = [
    '    await waitForValue(',
    '      () => evaluate(client, SRT_READY_EXPRESSION),',
  ].join('\n');
  const setFileInputThenReady = exactSetFileInputCall + exactSrtReadyWaitStart;
  assert.equal(INSTALLED_MEDIA_FLOW_INSPECTOR.split(setFileInputThenReady).length, 2,
    'setFileInputFiles to SRT_READY boundary cardinality');
  const uploadBoundaryMutations = [
    [
      'positive node validity removal',
      INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
        '      && Number.isInteger(inputs.nodeIds[0]) && inputs.nodeIds[0] > 0,',
        '      && true,',
      ),
    ],
    [
      'manual onchange insertion',
      INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
        setFileInputThenReady,
        exactSetFileInputCall
          + "    await evaluate(client, `document.querySelector('input')?.onchange?.(new Event('change'))`);\n"
          + exactSrtReadyWaitStart,
      ),
    ],
    [
      'out-of-line URL evaluation insertion',
      INSTALLED_MEDIA_FLOW_INSPECTOR.replace(
        setFileInputThenReady,
        exactSetFileInputCall
          + '    await evaluate(client, SET_URL_EXPRESSION);\n'
          + exactSrtReadyWaitStart,
      ),
    ],
  ];
  for (const [description, mutation] of uploadBoundaryMutations) {
    assert.notEqual(mutation, INSTALLED_MEDIA_FLOW_INSPECTOR, description);
    assert.throws(
      () => assertInstalledMediaFlowInspector(
        mutation,
        INPUT_METHODS_SOURCE,
        BUTTONS_CONTAINER_SOURCE,
      ),
      /retain one uninterrupted exact SRT upload transaction/,
      description,
    );
  }
  const startUrlRevalidationRemoved = replaceWithin(
    INSTALLED_MEDIA_FLOW_INSPECTOR,
    'const START_EXPRESSION = `',
    'export const MEDIA_RESULT_EXPRESSION = `',
    "      || localStorage.getItem('current_video_url') !== ${JSON.stringify(MEDIA_URL)}\n",
    '',
  );
  const startSrtRevalidationRemoved = replaceWithin(
    INSTALLED_MEDIA_FLOW_INSPECTOR,
    'const START_EXPRESSION = `',
    'export const MEDIA_RESULT_EXPRESSION = `',
    "      || info.fileName !== 'osg-installed-media-smoke.srt'\n",
    '',
  );
  for (const [description, mutation] of [
    ['START URL revalidation', startUrlRevalidationRemoved],
    ['START SRT revalidation', startSrtRevalidationRemoved],
  ]) {
    assert.notEqual(mutation, INSTALLED_MEDIA_FLOW_INSPECTOR, description);
    assert.throws(
      () => assertInstalledMediaFlowInspector(
        mutation,
        INPUT_METHODS_SOURCE,
        BUTTONS_CONTAINER_SOURCE,
      ),
      /synchronously revalidate URL and fresh SRT state/,
      description,
    );
  }
  const srtClearedWait = [
    '    await waitForValue(',
    '      () => evaluate(client, SRT_CLEARED_EXPRESSION),',
    '      (value) => value === true,',
    "      { timeoutMs: 30_000, failureCode: 'srt-clear-timeout' },",
    '    );',
    '',
  ].join('\n');
  const withoutSrtClearedWait = INSTALLED_MEDIA_FLOW_INSPECTOR.replace(srtClearedWait, '');
  assert.notEqual(withoutSrtClearedWait, INSTALLED_MEDIA_FLOW_INSPECTOR,
    'SRT_CLEARED wait removal');
  assert.throws(
    () => assertInstalledMediaFlowInspector(
      withoutSrtClearedWait,
      INPUT_METHODS_SOURCE,
      BUTTONS_CONTAINER_SOURCE,
    ),
    /commit URL state, replace stale SRT state, and baseline before one real download action/,
    'SRT_CLEARED wait removal',
  );
  const baselineAndPriorBlock = [
    '    const baselineState = await evaluate(client, MEDIA_RESULT_EXPRESSION);',
    '    const baselineDownloadJobIds = collectDownloadJobIds(baselineState);',
    '    if (options.priorAssetId !== null) {',
    '      // Activating the URL tab intentionally clears renderer compatibility storage, but the',
    '      // authoritative native session must still be the local asset we are replacing.',
    '      invariant(baselineState?.session?.media?.id === options.priorAssetId,',
    "        'Installed media flow did not begin from the reviewed prior asset');",
    '    }',
    '    const flowGuard = {',
    '      priorAssetId: options.priorAssetId,',
    '      baselineDownloadJobIds,',
    '    };',
    '',
  ].join('\n');
  const startCall = [
    '    invariant(await evaluate(client, START_EXPRESSION) === true,',
    "      'Installed media flow could not click the real semi-automatic action');",
    '',
  ].join('\n');
  assert.equal(INSTALLED_MEDIA_FLOW_INSPECTOR.split(baselineAndPriorBlock).length, 2,
    'baseline/prior block cardinality');
  assert.equal(INSTALLED_MEDIA_FLOW_INSPECTOR.split(startCall).length, 2,
    'start call cardinality');
  const baselineAfterStart = INSTALLED_MEDIA_FLOW_INSPECTOR
    .replace(baselineAndPriorBlock, '')
    .replace(startCall, `${startCall}${baselineAndPriorBlock}`);
  assert.notEqual(baselineAfterStart, INSTALLED_MEDIA_FLOW_INSPECTOR,
    'baseline/prior ordering mutation');
  assert.throws(
    () => assertInstalledMediaFlowInspector(
      baselineAfterStart,
      INPUT_METHODS_SOURCE,
      BUTTONS_CONTAINER_SOURCE,
    ),
    /commit URL state, replace stale SRT state, and baseline before one real download action/,
    'baseline/prior ordering mutation',
  );
  const priorGuard = [
    '    if (options.priorAssetId !== null) {',
    '      // Activating the URL tab intentionally clears renderer compatibility storage, but the',
    '      // authoritative native session must still be the local asset we are replacing.',
    '      invariant(baselineState?.session?.media?.id === options.priorAssetId,',
    "        'Installed media flow did not begin from the reviewed prior asset');",
    '    }',
    '',
  ].join('\n');
  const withoutPriorGuard = INSTALLED_MEDIA_FLOW_INSPECTOR.replace(priorGuard, '');
  assert.notEqual(withoutPriorGuard, INSTALLED_MEDIA_FLOW_INSPECTOR, 'prior guard removal');
  assert.throws(
    () => assertInstalledMediaFlowInspector(
      withoutPriorGuard,
      INPUT_METHODS_SOURCE,
      BUTTONS_CONTAINER_SOURCE,
    ),
    /commit URL state, replace stale SRT state, and baseline before one real download action/,
    'prior guard removal',
  );
  const missingUrlSelector = INPUT_METHODS_SOURCE.replace(
    '\n            data-input-tab="unified-url"',
    '',
  );
  const misplacedUrlSelector = missingUrlSelector.replace(
    'data-input-tab="file-upload"',
    'data-input-tab="file-upload"\n            data-input-tab="unified-url"',
  );
  for (const inputMethodsMutation of [missingUrlSelector, misplacedUrlSelector]) {
    assert.notEqual(inputMethodsMutation, INPUT_METHODS_SOURCE);
    assert.throws(
      () => assertInstalledMediaFlowInspector(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        inputMethodsMutation,
        BUTTONS_CONTAINER_SOURCE,
      ),
      /unique URL selector/,
    );
  }
  for (const buttonsMutation of [
    BUTTONS_CONTAINER_SOURCE.replace(
      "    : hasUrlAndSrtOnly ? 'url-with-srt' : 'other';",
      "    : hasUrlAndSrtOnly ? 'other' : 'url-with-srt';",
    ),
    BUTTONS_CONTAINER_SOURCE.replace(
      '              data-generation-mode={generationMode}\n',
      '',
    ),
  ]) {
    assert.notEqual(buttonsMutation, BUTTONS_CONTAINER_SOURCE);
    assert.throws(
      () => assertInstalledMediaFlowInspector(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        INPUT_METHODS_SOURCE,
        buttonsMutation,
      ),
      /committed URL-with-SRT generation mode/,
    );
  }
});

test('installed native-tool inspector uses exact UI removal and hot reinstall proof', () => {
  assert.doesNotThrow(() => assertInstalledNativeToolsInspector(INSTALLED_NATIVE_TOOLS_INSPECTOR));
  const mutations = [
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replace(
      "document.querySelector('[data-app-action=\"open-settings\"]')",
      "document.querySelector('.settings-button')",
    ),
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replace(
      "buttons.forEach((button) => button.click());",
      '// removed real UI clicks',
    ),
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replace(
      "window.__TAURI_INTERNALS__?.invoke('native_tools_status')",
      "window.__TAURI_INTERNALS__?.invoke('native_tool_remove')",
    ),
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replace(
      "value.download.reason === 'downloaderUnavailable'",
      'value.download.reason !== null',
    ),
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replace(
      'tool.activeRuntime === true',
      'tool.activeRuntime !== null',
    ),
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replace(
      'new Set(jobIds).size === TOOL_IDS.length',
      'jobIds.length === TOOL_IDS.length',
    ),
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replace(
      "fs.writeFileSync(destination, bytes, { flag: 'wx' })",
      'fs.writeFileSync(destination, bytes)',
    ),
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replace(
      'evaluate(client, CLOSE_SETTINGS_EXPRESSION)',
      'Promise.resolve(true)',
    ),
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replace(
      "document.querySelector('[data-settings-tab=\\\"tools\\\"]') === null",
      'true',
    ),
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replace(
      'Number.isSafeInteger(value.pipeline.durationUs)',
      'Number.isFinite(Number(value.pipeline.durationUs))',
    ),
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replace(
      'Number.isFinite(value.pipeline.frameRate)',
      'value.pipeline.frameRate != null',
    ),
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replace(
      "    await waitForDom(client, 'missing');",
      "    await waitForDom(client, 'missing');\n"
        + "    assertClickedActions(await evaluate(client, clickToolActionsExpression('install')), 'install');",
    ),
    INSTALLED_NATIVE_TOOLS_INSPECTOR.replaceAll(
      '  buttons.forEach((button) => button.click());',
      '  // buttons.forEach((button) => button.click());',
    ),
  ];
  for (const weakened of mutations) {
    assert.notEqual(weakened, INSTALLED_NATIVE_TOOLS_INSPECTOR);
    assert.throws(
      () => assertInstalledNativeToolsInspector(weakened),
      /Installed native-tool inspector/,
    );
  }
});

test('Tauri NSIS bootstrap is pinned, bounded, verified, and atomically staged', () => {
  assert.doesNotThrow(() => assertTauriNsisBootstrapScript(TAURI_NSIS_BOOTSTRAP_SCRIPT));
  assert.doesNotThrow(() => assertTauriNsisBootstrapScript(
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(/\r?\n/g, '\r\n'),
  ));
  for (const [label, bootstrap, newline] of [
    ['LF', TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(/\r\n/g, '\n'), '\n'],
    ['CRLF', TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(/\r?\n/g, '\r\n'), '\r\n'],
  ]) {
    const preferenceBoundary = `$ErrorActionPreference = 'Stop'${newline}`;
    for (const earlyTermination of ['return', 'exit 0']) {
      const weakened = bootstrap.replace(
        preferenceBoundary,
        `${preferenceBoundary}${earlyTermination}${newline}`,
      );
      assert.notEqual(weakened, bootstrap, `${label} mutation must alter the bootstrap`);
      assert.throws(
        () => assertTauriNsisBootstrapScript(weakened),
        /exact executable prologue and top-level success boundary/,
        `${label} bootstrap must reject standalone ${earlyTermination}`,
      );
    }
    assert.throws(
      () => assertTauriNsisBootstrapScript(
        `if ($false) {${newline}${bootstrap}${newline}}${newline}`,
      ),
      /exact executable prologue and top-level success boundary/,
      `${label} bootstrap must reject a dead top-level wrapper`,
    );
    const bodyBoundary = `$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))`;
    const successBoundary =
      "Write-Host 'Prepared the verified Tauri NSIS 3.11 toolchain in the exact Windows user cache.'";
    const deadMiddleWrapper = bootstrap
      .replace(bodyBoundary, `function Invoke-DeadBootstrap {${newline}${bodyBoundary}`)
      .replace(successBoundary, `}${newline}${successBoundary}`);
    assert.notEqual(deadMiddleWrapper, bootstrap, `${label} dead-wrapper mutation must alter the bootstrap`);
    assert.throws(
      () => assertTauriNsisBootstrapScript(deadMiddleWrapper),
      /exact reviewed executable source/,
      `${label} bootstrap must reject reviewed operations hidden in a dead function`,
    );
  }
  const curlResolutionVariants = [
    [
      'PATH-selected first of multiple curl commands',
      TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
        "$curlPath = [IO.Path]::GetFullPath((Join-Path $windowsSystemDirectory 'curl.exe'))",
        "$curlPath = @(Get-Command 'curl.exe' -CommandType Application -All)[0].Source",
      ),
    ],
    [
      'fallback command discovery after a missing system curl',
      TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
        "  throw 'The reviewed Windows system curl executable is missing or not a leaf file'",
        "  $curlPath = (Get-Command 'curl.exe' -CommandType Application).Source",
      ),
    ],
    [
      'non-leaf system curl',
      TAURI_NSIS_BOOTSTRAP_SCRIPT.replace('-PathType Leaf', '-PathType Any'),
    ],
    [
      'unreviewed curl filesystem type',
      TAURI_NSIS_BOOTSTRAP_SCRIPT.replace('$curlItem -isnot [IO.FileInfo]', '$false'),
    ],
    [
      'reparse-point system curl',
      TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
        '($curlItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0',
        '$false',
      ),
    ],
    [
      'PATH-order invocation',
      TAURI_NSIS_BOOTSTRAP_SCRIPT.replace('& $curlPath `', '& curl.exe `'),
    ],
    [
      'non-system special folder',
      TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
        '[Environment+SpecialFolder]::System',
        '[Environment+SpecialFolder]::LocalApplicationData',
      ),
    ],
  ];
  for (const [label, weakened] of curlResolutionVariants) {
    assert.notEqual(weakened, TAURI_NSIS_BOOTSTRAP_SCRIPT, `${label} mutation must alter the bootstrap`);
    assert.throws(
      () => assertTauriNsisBootstrapScript(weakened),
      /Tauri NSIS bootstrap/,
      `Tauri NSIS bootstrap must reject ${label}`,
    );
  }
  const weakenedVariants = [
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      "if ($desktopPackage.devDependencies.'@tauri-apps/cli' -cne '2.11.4') {",
      'if ($false) {',
    ),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip',
      'https://evil.example/nsis-3.11.zip',
    ),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      "    Url = 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip'",
      "    Url = 'https://evil.example/nsis-3.11.zip'",
    ) + "\n#    Url = 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip'\n",
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1',
      '0'.repeat(64),
    ),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace('Size = 2361546L', 'Size = 1L'),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace("--proto-redir '=https'", "--proto-redir '=all'"),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      "    --proto-redir '=https' `",
      "    --proto-redir '=all' `",
    ) + "\n#    --proto-redir '=https' `\n",
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace('--retry 4', '--retry 0'),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace('--retry-all-errors', '--retry-connrefused'),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace('--retry-max-time 120', '--retry-max-time 1200'),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace('--max-time 180', '--max-time 1800'),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      'Assert-PinnedFile -Path $Destination -Artifact $Artifact',
      '# response verification removed',
    ),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      '  Assert-PinnedFile -Path $Destination -Artifact $Artifact',
      '  return',
    ) + '\n#  Assert-PinnedFile -Path $Destination -Artifact $Artifact\n',
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      '  Assert-PinnedFile -Path $Destination -Artifact $Artifact',
      '  return\n<#\n  Assert-PinnedFile -Path $Destination -Artifact $Artifact\n#>',
    ),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      "$nsisRoot = Join-Path $CacheRoot 'NSIS'",
      "$nsisRoot = Join-Path $CacheRoot 'unreviewed'",
    ),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      "$nsisRoot = Join-Path $CacheRoot 'NSIS'",
      "$nsisRoot = Join-Path $CacheRoot 'unreviewed'",
    ) + "\n# $nsisRoot = Join-Path $CacheRoot 'NSIS'\n",
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      "throw 'Refusing to use a non-directory or reparse-point NSIS bootstrap root'",
      'return',
    ),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      "Copy-Item -LiteralPath $tauriPlugin -Destination (Join-Path $pluginDirectory 'nsis_tauri_utils.dll')",
      '# plugin injection removed',
    ),
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace(
      "  Copy-Item -LiteralPath $tauriPlugin -Destination (Join-Path $pluginDirectory 'nsis_tauri_utils.dll')",
      '  return',
    ) + "\n#  Copy-Item -LiteralPath $tauriPlugin -Destination (Join-Path $pluginDirectory 'nsis_tauri_utils.dll')\n",
    TAURI_NSIS_BOOTSTRAP_SCRIPT.replace("'Include\\Win\\RestartManager.nsh'", "'Include\\unreviewed.nsh'"),
    `${TAURI_NSIS_BOOTSTRAP_SCRIPT}\nInvoke-WebRequest https://example.test/fallback.zip\n`,
    `${TAURI_NSIS_BOOTSTRAP_SCRIPT}\n# http://example.test/fallback.zip\n`,
  ];
  for (const [index, weakened] of weakenedVariants.entries()) {
    assert.throws(
      () => assertTauriNsisBootstrapScript(weakened),
      /Tauri NSIS bootstrap/,
      `Tauri NSIS hostile mutation ${index} must fail closed`,
    );
  }
});

test('signed updater smoke is isolated, signed, installed, and persistent', () => {
  assert.doesNotThrow(() => assertUpdaterSmokeWorkflow(UPDATER_SMOKE_WORKFLOW));
  for (const fragment of [
    'workflow_dispatch:',
    'OSG_ENABLE_SIGNED_UPDATER_FIXTURE: "1"',
    'production,ci-updater-fixture',
    './scripts/prepare-tauri-nsis.ps1',
    './scripts/test-signed-updater-windows.ps1',
    "url = 'https://localhost:38443/update.exe'",
    '${{ runner.temp }}/osg-updater-diagnostics.log',
  ]) {
    assert.throws(
      () => assertUpdaterSmokeWorkflow(UPDATER_SMOKE_WORKFLOW.replace(fragment, 'removed')),
      /Signed updater smoke/,
    );
  }
  assert.throws(() => assertUpdaterSmokeWorkflow(
    UPDATER_SMOKE_WORKFLOW.replace('workflow_dispatch:', 'pull_request_target:'),
  ), /workflow_dispatch/);
  assert.throws(() => assertUpdaterSmokeWorkflow(
    `${UPDATER_SMOKE_WORKFLOW}\n# \${{ secrets.UNREVIEWED_SECRET }}\n`,
  ), /two reviewed updater signing secrets/);
  for (const argument of [
    '-CacheRoot C:\\unreviewed',
    '-ScratchRoot C:\\unreviewed',
  ]) {
    assert.throws(
      () => assertUpdaterSmokeWorkflow(UPDATER_SMOKE_WORKFLOW.replace(
        'run: ./scripts/prepare-tauri-nsis.ps1',
        `run: ./scripts/prepare-tauri-nsis.ps1 ${argument}`,
      )),
      /Signed updater smoke/,
      `signed updater must reject NSIS bootstrap argument ${argument}`,
    );
  }
  assert.throws(
    () => assertUpdaterSmokeWorkflow(UPDATER_SMOKE_WORKFLOW.replace(
      'run: ./scripts/prepare-tauri-nsis.ps1',
      'run: |\n          Write-Host decoy\n          run: ./scripts/prepare-tauri-nsis.ps1',
    )),
    /Signed updater smoke/,
    'signed updater must reject an NSIS bootstrap command hidden in a YAML scalar',
  );
});

test('updater fixture source remains compile-time isolated from production releases', () => {
  assert.doesNotThrow(() => assertUpdaterFixtureSource(path.join(__dirname, '..')));
  assert.doesNotThrow(() => assertDesktopCloseLifecycleSource(
    DESKTOP_SOURCE,
    CARGO_LOCK_SOURCE,
  ));
  assert.doesNotThrow(() => assertCiUpdaterFixtureDebugPortSource(
    DESKTOP_SOURCE,
    CI_UPDATER_ARGUMENT_SOURCE,
    CARGO_LOCK_SOURCE,
  ));
  assert.doesNotThrow(() => assertCiUpdaterFixtureHandoffSource(UPDATER_SOURCE));
  for (const weakened of [
    UPDATER_SOURCE.replace(
      '#[cfg(feature = "ci-updater-fixture")]\n    let webview_debug =',
      '    let webview_debug =',
    ),
    UPDATER_SOURCE.replace(
      'webview_debug || crate::ci_updater_fixture::configuration().enables_webview_debugging()',
      'webview_debug && crate::ci_updater_fixture::configuration().enables_webview_debugging()',
    ),
    UPDATER_SOURCE.replace(
      'crate::ci_updater_fixture::configuration().enables_webview_debugging()',
      'false',
    ),
  ]) {
    assert.throws(
      () => assertCiUpdaterFixtureHandoffSource(weakened),
      /Updater fixture handoff/,
    );
  }
  for (const [desktop, fixture] of [
    [DESKTOP_SOURCE.replace(
      '#[cfg(feature = "ci-updater-fixture")]\nmod ci_updater_fixture;',
      'mod ci_updater_fixture;',
    ), CI_UPDATER_ARGUMENT_SOURCE],
    [DESKTOP_SOURCE, CI_UPDATER_ARGUMENT_SOURCE.replace(
      '--osg-ci-updater-debug-port=',
      '--remote-debugging-port=',
    )],
    [DESKTOP_SOURCE, CI_UPDATER_ARGUMENT_SOURCE.replace(
      'if arguments.len() != 1',
      'if arguments.len() > 2',
    )],
    [DESKTOP_SOURCE, CI_UPDATER_ARGUMENT_SOURCE.replace(
      'if debug_port < 1024',
      'if debug_port < 1',
    )],
    [DESKTOP_SOURCE, CI_UPDATER_ARGUMENT_SOURCE.replace(
      '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required',
      '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --enable-features=RemoveRedirectionBitmap --autoplay-policy=no-user-gesture-required',
    )],
    [DESKTOP_SOURCE, CI_UPDATER_ARGUMENT_SOURCE.replace(
      'format!("{WEBVIEW2_DEFAULT_BROWSER_ARGUMENTS} --remote-debugging-port={port}")',
      'format!("{WEBVIEW2_DEFAULT_BROWSER_ARGUMENTS} --unreviewed --remote-debugging-port={port}")',
    )],
    [DESKTOP_SOURCE.replace(
      'window_builder.additional_browser_args(&arguments)',
      'window_builder',
    ), CI_UPDATER_ARGUMENT_SOURCE],
  ]) {
    assert.throws(
      () => assertCiUpdaterFixtureDebugPortSource(desktop, fixture, CARGO_LOCK_SOURCE),
      /Updater fixture debug-port/,
    );
  }
  const driftedWryLock = CARGO_LOCK_SOURCE.replace(
    /(\[\[package]]\r?\nname = "wry"\r?\nversion = )"0\.55\.1"/,
    '$1"0.56.0"',
  );
  assert.notEqual(driftedWryLock, CARGO_LOCK_SOURCE, 'Wry lock mutation must alter Cargo.lock');
  assert.throws(
    () => assertCiUpdaterFixtureDebugPortSource(
      DESKTOP_SOURCE,
      CI_UPDATER_ARGUMENT_SOURCE,
      driftedWryLock,
    ),
    /reviewed Wry 0\.55\.1 registry package/,
  );

  for (const weakenedDesktop of [
    DESKTOP_SOURCE.replace(
      '        diagnostics::record("app.close_requested", &[]);',
      '        diagnostics::record("app.close_requested", &[]);\n        window.app_handle().exit(0);',
    ),
    DESKTOP_SOURCE.replace(
      'window_label == "main" && close_requested',
      'close_requested',
    ),
    DESKTOP_SOURCE.replace(
      'diagnostics::record("app.close_requested", &[]);',
      'diagnostics::record("app.close_requested", &[]);\n        diagnostics::record("app.close_requested", &[]);',
    ),
    DESKTOP_SOURCE.replace(
      '        diagnostics::record("app.close_requested", &[]);',
      '        diagnostics::record("app.close_requested", &[]);\n        std::process::exit(0);',
    ),
    DESKTOP_SOURCE.replace(
      '        diagnostics::record("app.close_requested", &[]);',
      '        diagnostics::record("app.close_requested", &[]);\n        std::process::abort();',
    ),
    DESKTOP_SOURCE.replace(
      '        diagnostics::record("app.close_requested", &[]);',
      '        diagnostics::record("app.close_requested", &[]);\n        window.close().unwrap();',
    ),
    DESKTOP_SOURCE.replace(
      '        diagnostics::record("app.close_requested", &[]);',
      '        diagnostics::record("app.close_requested", &[]);\n        window.destroy().unwrap();',
    ),
    DESKTOP_SOURCE.replace(
      '        diagnostics::record("app.close_requested", &[]);',
      '        diagnostics::record("app.close_requested", &[]);\n        if let WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); }',
    ),
  ]) {
    assert.throws(
      () => assertDesktopCloseLifecycleSource(weakenedDesktop, CARGO_LOCK_SOURCE),
      /Desktop close handler/,
    );
  }
  const driftedRuntimeLock = CARGO_LOCK_SOURCE.replace(
    /(\[\[package]]\r?\nname = "tauri-runtime-wry"\r?\nversion = )"2\.11\.4"/,
    '$1"2.11.5"',
  );
  assert.notEqual(
    driftedRuntimeLock,
    CARGO_LOCK_SOURCE,
    'Tauri runtime lock mutation must alter Cargo.lock',
  );
  assert.throws(
    () => assertDesktopCloseLifecycleSource(DESKTOP_SOURCE, driftedRuntimeLock),
    /reviewed tauri-runtime-wry 2\.11\.4 registry package/,
  );
});

test('signed updater runner uses isolated HTTPS, the real toast, NSIS relaunch, and durable state', () => {
  assert.doesNotThrow(() => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT));
  assert.doesNotThrow(() => assertSignedUpdaterScript(
    SIGNED_UPDATER_SCRIPT.replace(/\r?\n/g, '\r\n'),
  ));
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      "            -and [string]$_.webviewDebug -ceq 'present' `",
      "            -and [string]$_.webviewDebug -in @('present', 'absent') `",
    )),
    /confirms the preserved CI debug-port hook/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      "            -and [string]$_.webviewDebug -ceq 'present' `\n",
      '',
    )),
    /confirms the preserved CI debug-port hook/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      "            -and [string]$_.webviewDebug -ceq 'present' `",
      "            -and [string]$_.webviewDebug -ceq 'absent' `",
    )),
    /confirms the preserved CI debug-port hook/,
  );
  for (const weakened of [
    SIGNED_UPDATER_SCRIPT.replace(
      '$Port -lt 1024 -or $Port -gt 65535',
      '$Port -lt 1 -or $Port -gt 65535',
    ),
    SIGNED_UPDATER_SCRIPT.replace(
      '"--osg-ci-updater-debug-port=$Port"',
      '"--remote-debugging-port=$Port"',
    ),
    SIGNED_UPDATER_SCRIPT.replace(
      '-ArgumentList @($debugArgument)',
      '-ArgumentList @("--unreviewed=$debugPort")',
    ),
    `${SIGNED_UPDATER_SCRIPT}\n$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--unreviewed'\n`,
  ]) {
    assert.throws(
      () => assertSignedUpdaterScript(weakened),
      /(?:bounded CI debug-port argument|only the preserved CI debug-port argument|missing lifecycle proof)/,
    );
  }
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      '            -and $_.version -ceq $ExpectedVersion `',
      '            -and $true `',
    )),
    /one new versioned UUIDv7 identity/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      '        $boundedRecord = ConvertTo-BoundedDiagnosticEvidenceRecord -Entry $_',
      '        $boundedRecord = $_',
    )),
    /bounded sanitized lifecycle evidence/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      "        [string]$_.event -like 'app-update.*' `",
      "        ($_.version -eq $UpdatedVersion) -and [string]$_.event -like 'app-update.*' `",
    )),
    /including unknown relaunch candidates/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      'if ([Text.Encoding]::UTF8.GetByteCount($encoded) -gt $script:diagnosticEvidenceByteLimit) {',
      'if ($false) {',
    )),
    /bounded sanitized lifecycle evidence/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      '$updatedProcessPath.Equals($executable, [StringComparison]::OrdinalIgnoreCase)',
      '$true',
    )),
    /exact installed executable path/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      "Invoke-UpdaterFinalizationStep -Name 'diagnostic-evidence' -Action {",
      '& {',
    )),
    /guarded cleanup step/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      "Invoke-UpdaterFinalizationStep -Name 'fixture-server' -Action {",
      '& {',
    )),
    /every guarded cleanup step/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      '    $script:finalizationFailure = $_',
      '    throw $_',
    )),
    /without throwing from cleanup/,
  );
  const primaryRethrow = SIGNED_UPDATER_SCRIPT.match(
    /if\s*\(\$null\s+-ne\s+\$primaryFailure\)\s*\{\s*throw\s+\$primaryFailure\s*}/,
  )[0];
  const finalizationRethrow = SIGNED_UPDATER_SCRIPT.match(
    /if\s*\(\$null\s+-ne\s+\$finalizationFailure\)\s*\{\s*throw\s+\$finalizationFailure\s*}/,
  )[0];
  const reversedFailures = SIGNED_UPDATER_SCRIPT
    .replace(primaryRethrow, '__OSG_PRIMARY_RETHROW__')
    .replace(finalizationRethrow, primaryRethrow)
    .replace('__OSG_PRIMARY_RETHROW__', finalizationRethrow);
  assert.throws(
    () => assertSignedUpdaterScript(reversedFailures),
    /rethrow the primary failure before any finalization failure/,
  );
  for (const fragment of [
    "$env:GITHUB_ACTIONS -ne 'true'",
    '-WindowStyle Hidden',
    "signed-updater.phase name=$Name elapsedMs=$elapsedMilliseconds",
    "@($resultPath, ($fixture.TrimEnd('\\') + '\\'))",
    "-Mode 'trigger'",
    "-Mode 'verify'",
    '$certificateRequest.CreateSelfSigned(',
    "'updated-application-relaunched'",
    'Wait-ForApplicationInstance',
    'Wait-ForReadyApplicationWindow',
    '$Process.MainWindowHandle -ne [IntPtr]::Zero',
    '$Process.WaitForInputIdle(1000)',
    "$pageLoadEvents = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.page_load_finished'",
    "$closeEventsBefore = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.close_requested'",
    "$exitRequestedEventsBefore = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.exit_requested'",
    "$exitEventsBefore = Get-DiagnosticEventCount -AppInstanceId $AppInstanceId -Name 'app.exit'",
    '$closeAccepted = $Process.CloseMainWindow()',
    "-Outcome 'request-rejected'",
    "-Outcome 'exit-timeout'",
    'Get-BoundedProcessTreeSnapshot',
    'Get-CimInstance Win32_Process -OperationTimeoutSec 3',
    'Get-BoundedEvidenceDelta',
    'appInstanceId = $AppInstanceId',
    'mainWindowStable = $MainWindowStable',
    'diagnosticDeltasUnclamped = $diagnosticDeltasUnclamped',
    'diagnosticLifecycleExact = $diagnosticLifecycleExact',
    '$closeEvidencePath',
    '$closeEvidenceTemporaryPath',
    'Write-CloseEvidenceDocument',
    'schemaVersion = 1',
    'cleanExit = $CleanExit',
    '$processQueryHandle = $Process.Handle',
    '$processQueryHandle -eq [IntPtr]::Zero',
    '$exitCode = $Process.ExitCode',
    '$cleanExit = $null -ne $exitCode -and $exitCode -eq 0',
    'if ($null -eq $exitCode)',
    '$closeEventsAfter -ne ($closeEventsBefore + 1)',
    '$exitRequestedEventsAfter -ne ($exitRequestedEventsBefore + 1)',
    '$exitEventsAfter -ne ($exitEventsBefore + 1)',
    '$closeRecord = Write-CloseEvidence',
    '-AppInstanceId $updatedInstanceId',
    "'updated-application-ready'",
    "-EvidenceName 'relaunch-verify'",
    'Wait-ForSettledUpdaterChecks',
    '-MinimumChecks 2',
    "'updated-frontend-ready'",
    '$updatedClose = Stop-Gracefully',
    "-Phase 'updater-relaunched'",
    '$verificationPort = Get-FreeLoopbackPort',
    'closeProof = [ordered]@{',
    'relaunchFrontend = $relaunchFrontend',
    'preservedSettingsProjectAndHistory = $true',
  ]) {
    assert.throws(
      () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replaceAll(fragment, 'removed')),
      /Signed updater runner/,
    );
  }
  const delayedQueryHandle = SIGNED_UPDATER_SCRIPT
    .replace('    $processQueryHandle = $Process.Handle\n', '')
    .replace(
      '  $closeAccepted = $Process.CloseMainWindow()\n',
      '  $closeAccepted = $Process.CloseMainWindow()\n    $processQueryHandle = $Process.Handle\n',
    );
  assert.throws(
    () => assertSignedUpdaterScript(delayedQueryHandle),
    /Signed updater runner/,
    'signed updater must open the rediscovered process query handle before requesting close',
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      "        -and $pageLoadEvents -ge 1 `\n",
      '',
    )),
    /diagnostic readiness, and a responsive idle window/,
  );
  const readyPhase = "Write-SmokePhase -Name 'updated-application-ready'";
  const frontendReady = "Write-SmokePhase -Name 'updated-frontend-ready'";
  const gracefulClose = '$updatedClose = Stop-Gracefully';
  const reorderedClose = SIGNED_UPDATER_SCRIPT
    .replace(frontendReady, '__OSG_FRONTEND_READY__')
    .replace(gracefulClose, frontendReady)
    .replace('__OSG_FRONTEND_READY__', gracefulClose);
  assert.throws(
    () => assertSignedUpdaterScript(reorderedClose),
    /exact frontend/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      'if (-not $closeAccepted) {',
      'if ($false) {',
    )),
    /separate native close acceptance/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      'if (-not $Process.WaitForExit(30000)) {',
      'if ($false) {',
    )),
    /separate native close acceptance/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(`${SIGNED_UPDATER_SCRIPT}\nif (-not $Process.CloseMainWindow() -or -not $Process.WaitForExit(30000)) {}\n`),
    /separate native close acceptance/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT.replace(
      '$closeAccepted = $Process.CloseMainWindow()',
      '$processTree = Get-BoundedProcessTreeSnapshot -Process $Process\n  $closeAccepted = $Process.CloseMainWindow()',
    )),
    /before waiting for exit or scanning descendants/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(`${SIGNED_UPDATER_SCRIPT}\n# Cert:\\LocalMachine\\Root\n`),
    /certificate store|trust stores/,
  );
});

function transformWorkflowJob(workflow, jobName, transform) {
  const heading = `  ${jobName}:`;
  const start = workflow.indexOf(heading);
  assert.notEqual(start, -1, `Missing workflow job ${jobName}`);
  const nextJobOffset = workflow.slice(start + heading.length).search(/^  [a-zA-Z0-9_-]+:\s*$/m);
  const end = nextJobOffset === -1
    ? workflow.length
    : start + heading.length + nextJobOffset;
  return workflow.slice(0, start) + transform(workflow.slice(start, end)) + workflow.slice(end);
}

function createWorkerFixture({ packageSpeech = true, packageRender = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-release-readiness-'));
  writeFile(root, '.gitattributes', '*.mjs text eol=lf\n*.py text eol=lf\n');
  writeFile(root, 'crates/osg-asr/worker/osg_asr_worker.py', 'asr worker');
  writeFile(root, 'crates/osg-speech/worker/osg_speech_worker.py', 'speech worker');
  writeFile(root, 'video-renderer/worker/osg_render_worker.mjs', 'render worker');
  writeFile(
    root,
    'apps/desktop/src-tauri/src/asr.rs',
    'const WORKER: &[u8] = include_bytes!("../../../../crates/osg-asr/worker/osg_asr_worker.py");',
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/src/speech.rs',
    'const WORKER: &[u8] = include_bytes!("../../../../crates/osg-speech/worker/osg_speech_worker.py");',
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/src/render.rs',
    'const WORKER: &[u8] = include_bytes!("../../../../video-renderer/worker/osg_render_worker.mjs");',
  );
  const resources = {
    '../../../crates/osg-asr/worker/osg_asr_worker.py': 'workers/osg_asr_worker.py',
  };
  if (packageRender) {
    resources['../../../video-renderer/worker/osg_render_worker.mjs'] =
      'workers/osg_render_worker.mjs';
  }
  if (packageSpeech) {
    resources['../../../crates/osg-speech/worker/osg_speech_worker.py'] =
      'workers/osg_speech_worker.py';
  }
  writeFile(
    root,
    'apps/desktop/src-tauri/tauri.conf.json',
    JSON.stringify({ bundle: { resources } }),
  );
  return root;
}

function createNativeToolFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-native-tool-readiness-'));
  const repositoryRoot = path.resolve(__dirname, '..');
  for (const relativePath of [
    'crates/osg-native-tools/delivery/native-tools.delivery.json',
    'crates/osg-native-tools/delivery/native-tools.upstreams.lock.json',
  ]) {
    writeFile(root, relativePath, fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
  }
  const commands = [
    'native_tools_catalog',
    'native_tools_status',
    'native_tool_install',
    'native_tool_cancel',
  ].join('\n');
  for (const relativePath of [
    'apps/desktop/src-tauri/build.rs',
    'apps/desktop/src-tauri/src/lib.rs',
    'apps/desktop/src-tauri/permissions/app.toml',
  ]) {
    writeFile(root, relativePath, commands);
  }
  return root;
}

function createDependencyPinFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-dependency-pins-'));
  const rootPackage = {
    packageManager: 'npm@11.17.0',
    dependencies: {
      '@tauri-apps/api': '2.11.1',
      react: '18.3.1',
      'react-dom': '18.3.1',
    },
    devDependencies: {
      '@tauri-apps/cli': '2.11.4',
      '7zip-bin-full': '26.2.1',
    },
  };
  const workspacePackage = {
    dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
  };
  writeFile(root, '.node-version', '24.19.0\n');
  writeFile(root, 'package.json', JSON.stringify(rootPackage));
  writeFile(
    root,
    'apps/desktop/package.json',
    JSON.stringify({
      packageManager: 'npm@11.17.0',
      devDependencies: { '@tauri-apps/cli': '2.11.4' },
    }),
  );
  writeFile(root, 'promptdj-midi/package.json', JSON.stringify(workspacePackage));
  writeFile(root, 'video-renderer/package.json', JSON.stringify(workspacePackage));
  writeFile(
    root,
    'rust-toolchain.toml',
    '[toolchain]\nchannel = "1.97.1"\nprofile = "minimal"\ncomponents = ["clippy", "rustfmt"]\n',
  );
  writeFile(
    root,
    'Cargo.toml',
    '[workspace]\nmembers = ["crates/example"]\n\n[workspace.package]\nrust-version = "1.97"\n',
  );
  return { root, rootPackage, workspacePackage };
}

test('accepts only reviewed full-SHA GitHub Action pins', () => {
  const workflow = Object.entries(ACTION_PINS)
    .map(([action, pin]) => `      - uses: ${action}@${pin}`)
    .join('\n');
  assert.doesNotThrow(() => assertPinnedActions(workflow));
  for (const pin of Object.values(ACTION_PINS)) {
    assert.throws(
      () => assertPinnedActions(workflow.replace(pin, 'v0')),
      /full commit SHA/,
    );
    assert.throws(
      () => assertPinnedActions(workflow.replace(pin, '0'.repeat(40))),
      /reviewed pin/,
    );
  }
});

test('pins the reviewed React pair and release inspection dependency in every manifest', (context) => {
  const { root, rootPackage } = createDependencyPinFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  assert.doesNotThrow(() => assertPinnedToolchains(root));

  rootPackage.dependencies.react = '^18.2.0';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(rootPackage));
  assert.throws(
    () => assertPinnedToolchains(root),
    /package\.json must pin React and React DOM to the reviewed 18\.3\.1 pair/,
  );

  rootPackage.dependencies.react = '18.3.1';
  rootPackage.devDependencies['7zip-bin-full'] = '^26.2.1';
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(rootPackage));
  assert.throws(
    () => assertPinnedToolchains(root),
    /must pin 7zip-bin-full to exact version 26\.2\.1/,
  );
});

test('lockfiles bind reviewed registry artifacts and exact React workspace parity', (context) => {
  const { root } = createDependencyPinFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const genericIntegrity = `sha512-${Buffer.alloc(64, 0x5a).toString('base64')}`;
  const tauriCli = {
    version: '2.11.4',
    resolved: 'https://registry.npmjs.org/@tauri-apps/cli/-/cli-2.11.4.tgz',
    integrity: genericIntegrity,
  };
  const rootLock = {
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
        devDependencies: { '7zip-bin-full': '26.2.1' },
      },
      'node_modules/@tauri-apps/cli': tauriCli,
      'node_modules/7zip-bin-full': {
        version: '26.2.1',
        resolved: 'https://registry.npmjs.org/7zip-bin-full/-/7zip-bin-full-26.2.1.tgz',
        integrity: 'sha512-h1DE4G8WEJ3/LI4HTcuOpouP7cy9JGqYfZm5fzLhdzw8jI3wFyA9RFu5MP+ICzelKEYmWweRWApEvVWKmJIdVQ==',
        dev: true,
        license: 'MIT',
      },
      'node_modules/react': {
        version: '18.3.1',
        resolved: 'https://registry.npmjs.org/react/-/react-18.3.1.tgz',
        integrity: genericIntegrity,
      },
      'node_modules/react-dom': {
        version: '18.3.1',
        resolved: 'https://registry.npmjs.org/react-dom/-/react-dom-18.3.1.tgz',
        integrity: genericIntegrity,
      },
      'promptdj-midi': {
        dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
        link: true,
      },
      'video-renderer': {
        dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
        link: true,
      },
    },
  };
  const desktopLock = {
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/@tauri-apps/cli': tauriCli,
    },
  };
  writeFile(root, 'package-lock.json', JSON.stringify(rootLock));
  writeFile(root, 'apps/desktop/package-lock.json', JSON.stringify(desktopLock));
  writeFile(root, 'Cargo.lock', 'version = 4\n');
  assert.doesNotThrow(() => assertLockfiles(root));

  rootLock.packages['node_modules/7zip-bin-full'].integrity = genericIntegrity;
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(rootLock));
  assert.throws(
    () => assertLockfiles(root),
    /must bind 7zip-bin-full to its reviewed registry artifact/,
  );

  rootLock.packages['node_modules/7zip-bin-full'].integrity =
    'sha512-h1DE4G8WEJ3/LI4HTcuOpouP7cy9JGqYfZm5fzLhdzw8jI3wFyA9RFu5MP+ICzelKEYmWweRWApEvVWKmJIdVQ==';
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(rootLock));
  writeFile(
    root,
    'Cargo.lock',
    `version = 4\n\n[[package]]\nname = "git-fixture"\nversion = "1.0.0"\nsource = "git+https://example.test/repository.git#${'a'.repeat(40)}"\n`,
  );
  assert.doesNotThrow(() => assertLockfiles(root));
  writeFile(
    root,
    'Cargo.lock',
    'version = 4\n\n[[package]]\nname = "git-fixture"\nversion = "1.0.0"\nsource = "git+https://example.test/repository.git#main"\n',
  );
  assert.throws(
    () => assertLockfiles(root),
    /git dependency git-fixture must use HTTPS and a full commit revision/,
  );
});

test('requires all four immutable host/target/package matrix entries', () => {
  const entries = RELEASE_MATRIX.map(
    ({ platform, os: runner, target, bundles }) =>
      `          - platform: ${platform}\n            os: ${runner}\n            rust-target: ${target}\n            bundles: ${bundles}`,
  ).join('\n');
  const workflow = `      matrix:\n        include:\n${entries}\n\n    steps:\n`;
  assert.doesNotThrow(() => assertWorkflowMatrix(workflow));
  assert.throws(
    () => assertWorkflowMatrix(workflow.replace('macos-15-intel', 'macos-latest')),
    /mutable \*-latest aliases/,
  );
});

test('workflow is unsigned, read-only, credentialless, and locked', () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, '..', '.github/workflows/rewrite-ci.yml'),
    'utf8',
  );
  assert.doesNotThrow(() => assertWorkflowCommands(workflow));
  const nativePickerRegressionOnEveryHost = replaceInWorkflowJob(
    workflow,
    'native-matrix',
    "if: matrix.rust-target == 'x86_64-pc-windows-msvc'",
    "if: matrix.rust-target != 'x86_64-pc-windows-msvc'",
  );
  assert.throws(
    () => assertWorkflowCommands(nativePickerRegressionOnEveryHost),
    /evidence regression in both PowerShell engines on Windows only/,
  );
  const nativeWithoutWindowsPowerShellRegression = replaceInWorkflowJob(
    workflow,
    'native-matrix',
    '& "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
    '& pwsh',
  );
  assert.throws(
    () => assertWorkflowCommands(nativeWithoutWindowsPowerShellRegression),
    /evidence regression in both PowerShell engines on Windows only/,
  );
  for (const jobName of ['windows-installed-smoke', 'windows-published-installed-smoke']) {
    const withoutWindowsPowerShellRegression = replaceInWorkflowJob(
      workflow,
      jobName,
      '& "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
      '& pwsh',
    );
    assert.throws(
      () => assertWorkflowCommands(withoutWindowsPowerShellRegression),
      /execute the production evidence writer in Windows PowerShell and pwsh/,
    );
    const withoutPickerRegression = replaceInWorkflowJob(
      workflow,
      jobName,
      './scripts/test-native-picker-evidence.ps1',
      '# native-picker regression removed',
    );
    assert.throws(
      () => assertWorkflowCommands(withoutPickerRegression),
      /execute the production evidence writer in Windows PowerShell and pwsh/,
    );
    const uploadStep = jobName === 'windows-installed-smoke'
      ? '- name: Upload installed WebView screenshots\n        if: always()'
      : '- name: Upload published installed WebView screenshots\n        if: always()';
    const withoutAlwaysUpload = replaceInWorkflowJob(
      workflow,
      jobName,
      uploadStep,
      uploadStep.replace('if: always()', 'if: success()'),
    );
    assert.throws(
      () => assertWorkflowCommands(withoutAlwaysUpload),
      /(?:installed-smoke must build|published-installed-smoke must validate)/,
    );
  }
  const nativeWithoutNsisBootstrap = replaceInWorkflowJob(
    workflow,
    'native-matrix',
    './scripts/prepare-tauri-nsis.ps1',
    '# verified NSIS bootstrap removed',
  );
  assert.throws(
    () => assertWorkflowCommands(nativeWithoutNsisBootstrap),
    /native-matrix must prepare verified NSIS/,
  );
  const branchWithoutNsisBootstrap = replaceInWorkflowJob(
    workflow,
    'windows-installed-smoke',
    './scripts/prepare-tauri-nsis.ps1',
    '# verified NSIS bootstrap removed',
  );
  assert.throws(
    () => assertWorkflowCommands(branchWithoutNsisBootstrap),
    /installed-smoke must prepare the verified Tauri NSIS cache/,
  );
  for (const [jobName, failurePattern] of [
    ['native-matrix', /native-matrix must prepare verified NSIS/],
    ['windows-installed-smoke', /installed-smoke must prepare the verified Tauri NSIS cache/],
  ]) {
    for (const argument of [
      '-CacheRoot C:\\unreviewed',
      '-ScratchRoot C:\\unreviewed',
    ]) {
      const workflowWithBootstrapOverride = replaceInWorkflowJob(
        workflow,
        jobName,
        'run: ./scripts/prepare-tauri-nsis.ps1',
        `run: ./scripts/prepare-tauri-nsis.ps1 ${argument}`,
      );
      assert.throws(
        () => assertWorkflowCommands(workflowWithBootstrapOverride),
        failurePattern,
        `${jobName} must reject NSIS bootstrap argument ${argument}`,
      );
    }
    const workflowWithScalarDecoy = replaceInWorkflowJob(
      workflow,
      jobName,
      'run: ./scripts/prepare-tauri-nsis.ps1',
      'run: |\n          Write-Host decoy\n          run: ./scripts/prepare-tauri-nsis.ps1',
    );
    assert.throws(
      () => assertWorkflowCommands(workflowWithScalarDecoy),
      failurePattern,
      `${jobName} must reject an NSIS bootstrap command hidden in a YAML scalar`,
    );
  }
  const nativeNsisBootstrapOnEveryHost = replaceInWorkflowJob(
    workflow,
    'native-matrix',
    "if: github.event_name == 'workflow_dispatch' && matrix.rust-target == 'x86_64-pc-windows-msvc'",
    "if: github.event_name == 'workflow_dispatch'",
  );
  assert.throws(
    () => assertWorkflowCommands(nativeNsisBootstrapOnEveryHost),
    /native-matrix must prepare verified NSIS only for manual Windows packaging/,
  );
  assert.throws(
    () => assertWorkflowCommands(workflow.replace('contents: read', 'contents: write')),
    /permissions must remain contents: read only/,
  );
  assert.throws(
    () => assertWorkflowCommands(workflow.replace('persist-credentials: false', 'persist-credentials: true')),
    /Every checkout step must disable persisted Git credentials/,
  );
  assert.throws(
    () => assertWorkflowCommands(transformWorkflowJob(
      workflow,
      'native-matrix',
      (job) => job.replace("if: github.event_name == 'workflow_dispatch'", 'if: always()'),
    )),
    /Unsigned package validation must be manual-only/,
  );
  const nativeSetupPython = `uses: actions/setup-python@${ACTION_PINS['actions/setup-python']}`;
  const nativeWithoutPython = replaceInWorkflowJob(
    workflow,
    'native-matrix',
    nativeSetupPython,
    '# native setup-python intentionally removed',
  );
  assert.throws(
    () => assertWorkflowCommands(nativeWithoutPython),
    /native-matrix must install Python through the reviewed setup-python action/,
  );
  const nativeSetupNode = `uses: actions/setup-node@${ACTION_PINS['actions/setup-node']}`;
  const nativeWithoutNode = replaceInWorkflowJob(
    workflow,
    'native-matrix',
    nativeSetupNode,
    '# native setup-node intentionally removed',
  );
  assert.throws(
    () => assertWorkflowCommands(nativeWithoutNode),
    /native-matrix must install Node through the reviewed setup-node action/,
  );
  const branchSmokeWithoutPython = replaceInWorkflowJob(
    workflow,
    'windows-installed-smoke',
    nativeSetupPython,
    '# branch smoke setup-python intentionally removed',
  );
  assert.throws(
    () => assertWorkflowCommands(branchSmokeWithoutPython),
    /windows-installed-smoke must install Python through the reviewed setup-python action/,
  );
  const branchSmokeDownloadingPublished = transformWorkflowJob(
    workflow,
    'windows-installed-smoke',
    (job) => `${job}\n      # https://example.invalid/releases/download/v1.0.0/app.exe\n`,
  );
  assert.throws(
    () => assertWorkflowCommands(branchSmokeDownloadingPublished),
    /installed-smoke must build, validate, install, and launch the current branch/,
  );
  for (const [jobName, failurePattern] of [
    ['windows-installed-smoke', /installed-smoke must build, validate, install, and launch the current branch/],
    ['windows-published-installed-smoke', /published-installed-smoke must validate and launch the signed immutable release artifact/],
  ]) {
    const smokeWithShortTimeout = replaceInWorkflowJob(
      workflow,
      jobName,
      'timeout-minutes: 180',
      'timeout-minutes: 20',
    );
    assert.throws(() => assertWorkflowCommands(smokeWithShortTimeout), failurePattern);
    const timeoutCommentDecoy = replaceInWorkflowJob(
      workflow,
      jobName,
      'timeout-minutes: 180',
      'timeout-minutes: 20\n    # timeout-minutes: 180',
    );
    assert.throws(() => assertWorkflowCommands(timeoutCommentDecoy), failurePattern);
  }
  for (const jobName of ['windows-installed-smoke', 'windows-published-installed-smoke']) {
    const fixtureWithUnsafeRedirects = replaceInWorkflowJob(
      workflow,
      jobName,
      "--proto '=https' --proto-redir '=https'",
      '--proto-default http',
    );
    assert.throws(
      () => assertWorkflowCommands(fixtureWithUnsafeRedirects),
      /(?:installed-smoke must build|published-installed-smoke must validate)/,
    );
    const fixtureFromUnreviewedHost = replaceInWorkflowJob(
      workflow,
      jobName,
      'https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4',
      'https://evil.example/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4',
    );
    assert.throws(
      () => assertWorkflowCommands(fixtureFromUnreviewedHost),
      /(?:installed-smoke must build|published-installed-smoke must validate)/,
    );
    const fixtureAssignmentWithCommentDecoy = replaceInWorkflowJob(
      workflow,
      jobName,
      `$url = 'https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4'`,
      `$url = 'https://evil.example/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4'\n          # $url = 'https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4'`,
    );
    assert.throws(
      () => assertWorkflowCommands(fixtureAssignmentWithCommentDecoy),
      /(?:installed-smoke must build|published-installed-smoke must validate)/,
    );
    const pickerEvidenceAssignmentCommented = replaceInWorkflowJob(
      workflow,
      jobName,
      "$pickerEvidencePath = Join-Path $env:RUNNER_TEMP 'osg-installed-native-picker-evidence.json'",
      "# $pickerEvidencePath = Join-Path $env:RUNNER_TEMP 'osg-installed-native-picker-evidence.json'",
    );
    assert.throws(
      () => assertWorkflowCommands(pickerEvidenceAssignmentCommented),
      /(?:installed-smoke must build|published-installed-smoke must validate)/,
    );
    const pickerEvidenceSuccessRemoved = replaceInWorkflowJob(
      workflow,
      jobName,
      "if ($pickerEvidence.outcome -cne 'succeeded' -or $pickerEvidence.stage -cne 'dialog-dismissed') {",
      'if ($false) {',
    );
    assert.throws(
      () => assertWorkflowCommands(pickerEvidenceSuccessRemoved),
      /(?:installed-smoke must build|published-installed-smoke must validate)/,
    );
    const pickerEvidenceUploadCommented = replaceInWorkflowJob(
      workflow,
      jobName,
      '${{ runner.temp }}/osg-installed-native-picker-evidence.json',
      '# ${{ runner.temp }}/osg-installed-native-picker-evidence.json',
    );
    assert.throws(
      () => assertWorkflowCommands(pickerEvidenceUploadCommented),
      /(?:installed-smoke must build|published-installed-smoke must validate)/,
    );
  }
  const branchWithoutStructuredEvidenceCheck = replaceInWorkflowJob(
    workflow,
    'windows-installed-smoke',
    'Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json | Out-Null',
    '# structured result validation removed',
  );
  assert.throws(
    () => assertWorkflowCommands(branchWithoutStructuredEvidenceCheck),
    /installed-smoke must build, validate, install, and launch the current branch/,
  );
  const publishedWithoutStructuredEvidenceCheck = replaceInWorkflowJob(
    workflow,
    'windows-published-installed-smoke',
    'Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json | Out-Null',
    '# structured result validation removed',
  );
  assert.throws(
    () => assertWorkflowCommands(publishedWithoutStructuredEvidenceCheck),
    /published-installed-smoke must validate and launch the signed immutable release artifact/,
  );
  const buildLine = '        run: npm run build:frontend\n';
  const frontendBuiltTooLate = transformWorkflowJob(workflow, 'native-matrix', (job) => {
    assert.ok(job.includes(buildLine));
    return job.replace(buildLine, '') + `\n${buildLine}`;
  });
  assert.throws(
    () => assertWorkflowCommands(frontendBuiltTooLate),
    /native-matrix must build frontendDist before compiling the Tauri Rust workspace/,
  );
  assert.throws(
    () => assertWorkflowCommands(workflow.replace(
      'run: node apps/desktop/node_modules/@tauri-apps/cli/tauri.js build --features production --no-bundle',
      'run: npm --prefix apps/desktop run tauri -- build --no-bundle',
    )),
    /(?:required locked gate.*(?:tauri:build|tauri\.js)|production-feature Tauri wrapper)/,
  );
  for (const gate of [
    'node --test scripts/frozen-css-compatibility.test.mjs scripts/check-frozen-css-output.test.mjs',
    'node scripts/check-frozen-css-output.mjs',
  ]) {
    assert.throws(
      () => assertWorkflowCommands(workflow.replace(gate, 'gate intentionally removed')),
      /workflow is missing required locked gate/,
    );
  }
  const nativeWithoutFrontendBuild = transformWorkflowJob(
    workflow,
    'native-matrix',
    (job) => job.replace('npm run build:frontend', 'frontend build intentionally removed'),
  );
  assert.throws(
    () => assertWorkflowCommands(nativeWithoutFrontendBuild),
    /native-matrix must build frontendDist before compiling the Tauri Rust workspace/,
  );
});

test('production CSP rejects provider and development network endpoints', () => {
  assert.doesNotThrow(() =>
    assertProductionCsp({
      app: {
        security: {
          csp: {
            'connect-src': "'self' ipc: http://ipc.localhost",
            'img-src': "'self' data: blob: http://127.0.0.1:*",
          },
        },
      },
    }),
  );
  for (const endpoint of [
    'https://generativelanguage.googleapis.com',
    'http://localhost:3030',
    'http://127.0.0.1:*',
    'https:',
  ]) {
    assert.throws(
      () =>
        assertProductionCsp({
          app: {
            security: {
              csp: {
                'connect-src': `\'self\' ipc: ${endpoint}`,
                'img-src': "'self' data: blob: http://127.0.0.1:*",
              },
            },
          },
        }),
      /only self\/Tauri IPC endpoints/,
    );
  }
  for (const imageSource of [
    "'self' data: blob: https:",
    "'self' data: blob: https://i.ytimg.com",
    "'self' data: blob:",
  ]) {
    assert.throws(
      () => assertProductionCsp({
        app: {
          security: {
            csp: {
              'connect-src': "'self' ipc: http://ipc.localhost",
              'img-src': imageSource,
            },
          },
        },
      }),
      /only local assets and tokenized loopback images/,
    );
  }
});

function createUpdaterFixture({
  endpoint = 'https://example.invalid/releases/latest/download/latest.json',
  permission = 'check-for-updates',
  publicKey = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-updater-readiness-'));
  const keyBytes = Buffer.concat([Buffer.from('Ed'), Buffer.from(Array.from({ length: 40 }, (_, index) => index + 1))]);
  const minisignKey = keyBytes.toString('base64');
  const encodedPublicKey = publicKey ?? Buffer.from(
    `untrusted comment: minisign public key test fixture\n${minisignKey}\n`,
    'utf8',
  ).toString('base64');
  writeFile(root, 'apps/desktop/src-tauri/updater-public-key.txt', `${encodedPublicKey}\n`);
  writeFile(
    root,
    'apps/desktop/src-tauri/tauri.conf.json',
    JSON.stringify({
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { endpoints: [endpoint], pubkey: '' } },
    }),
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/capabilities/main.json',
    JSON.stringify({ permissions: [permission] }),
  );
  return root;
}

test('signed updater release gate requires a real key, HTTPS latest.json, and no guest API', (context) => {
  const validRoot = createUpdaterFixture();
  const placeholderRoot = createUpdaterFixture({ publicKey: 'UNCONFIGURED' });
  const insecureRoot = createUpdaterFixture({ endpoint: 'http://example.invalid/latest.json' });
  const guestRoot = createUpdaterFixture({ permission: 'updater:default' });
  context.after(() => {
    for (const root of [validRoot, placeholderRoot, insecureRoot, guestRoot]) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  assert.doesNotThrow(() => assertUpdaterReleaseConfiguration(validRoot));
  assert.throws(() => assertUpdaterReleaseConfiguration(placeholderRoot), /still a placeholder/);
  assert.throws(() => assertUpdaterReleaseConfiguration(insecureRoot), /must use HTTPS/);
  assert.throws(() => assertUpdaterReleaseConfiguration(guestRoot), /must not grant updater guest permissions/);
});

test('Tauri production build contract embeds the frontend instead of retaining the dev URL', (context) => {
  const root = createTauriProductionBuildFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));

  assert.doesNotThrow(() => assertTauriProductionBuildContract(root));
});

test('Tauri production build contract rejects dev-server releases and weakened native picker boundaries', (context) => {
  const fixtures = Array.from({ length: 11 }, createTauriProductionBuildFixture);
  context.after(() => {
    for (const root of fixtures) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  const [
    rootScript,
    desktopScript,
    cargoFeature,
    rfdPin,
    mainGuard,
    unownedPicker,
    unloggedPicker,
    unpooledPicker,
    unstartedWorker,
    pluginBridge,
    unloggedWorkerFailure,
  ] = fixtures;
  const rootPackage = JSON.parse(fs.readFileSync(path.join(rootScript, 'package.json'), 'utf8'));
  rootPackage.scripts['tauri:build'] = 'npm --prefix apps/desktop run tauri -- build';
  writeFile(rootScript, 'package.json', JSON.stringify(rootPackage));
  assert.throws(
    () => assertTauriProductionBuildContract(rootScript),
    /Root tauri:build must delegate/,
  );

  const desktopPackage = JSON.parse(
    fs.readFileSync(path.join(desktopScript, 'apps/desktop/package.json'), 'utf8'),
  );
  desktopPackage.scripts['tauri:build'] = 'tauri build';
  writeFile(desktopScript, 'apps/desktop/package.json', JSON.stringify(desktopPackage));
  assert.throws(
    () => assertTauriProductionBuildContract(desktopScript),
    /must enable the production custom-protocol feature/,
  );

  writeFile(
    cargoFeature,
    'apps/desktop/src-tauri/Cargo.toml',
    '[features]\ndefault = []\nproduction = []\n',
  );
  assert.throws(
    () => assertTauriProductionBuildContract(cargoFeature),
    /must enable only tauri\/custom-protocol/,
  );

  const unpinnedCargo = fs.readFileSync(
    path.join(rfdPin, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8',
  ).replace('version = "=0.16.0"', 'version = "0.16.0"');
  writeFile(rfdPin, 'apps/desktop/src-tauri/Cargo.toml', unpinnedCargo);
  assert.throws(
    () => assertTauriProductionBuildContract(rfdPin),
    /must pin its direct rfd dependency/,
  );

  writeFile(mainGuard, 'apps/desktop/src-tauri/src/main.rs', 'fn main() {}\n');
  assert.throws(
    () => assertTauriProductionBuildContract(mainGuard),
    /must reject release builds/,
  );

  writeFile(
    unownedPicker,
    'apps/desktop/src-tauri/src/commands.rs',
    'use tauri::WebviewWindow;\n'
      + 'async fn select_media(window: WebviewWindow) {\n'
      + '  app.dialog().file().set_title("Choose video or audio");\n'
      + '}\n',
  );
  assert.throws(
    () => assertTauriProductionBuildContract(unownedPicker),
    /must run its parented picker on the blocking pool/,
  );

  const unloggedSource = fs.readFileSync(
    path.join(unloggedPicker, 'apps/desktop/src-tauri/src/commands.rs'), 'utf8',
  ).replace('  diagnostics::record("media-picker.requested", &[]);\n', '');
  writeFile(unloggedPicker, 'apps/desktop/src-tauri/src/commands.rs', unloggedSource);
  assert.throws(
    () => assertTauriProductionBuildContract(unloggedPicker),
    /must run its parented picker on the blocking pool/,
  );

  const unpooledSource = fs.readFileSync(
    path.join(unpooledPicker, 'apps/desktop/src-tauri/src/commands.rs'), 'utf8',
  ).replace('tauri::async_runtime::spawn_blocking', 'tauri::async_runtime::spawn');
  writeFile(unpooledPicker, 'apps/desktop/src-tauri/src/commands.rs', unpooledSource);
  assert.throws(
    () => assertTauriProductionBuildContract(unpooledPicker),
    /must run its parented picker on the blocking pool/,
  );

  const unstartedSource = fs.readFileSync(
    path.join(unstartedWorker, 'apps/desktop/src-tauri/src/commands.rs'), 'utf8',
  ).replace('    diagnostics::record("media-picker.worker-started", &[]);\n', '');
  writeFile(unstartedWorker, 'apps/desktop/src-tauri/src/commands.rs', unstartedSource);
  assert.throws(
    () => assertTauriProductionBuildContract(unstartedWorker),
    /must run its parented picker on the blocking pool/,
  );

  const pluginBridgeSource = fs.readFileSync(
    path.join(pluginBridge, 'apps/desktop/src-tauri/src/commands.rs'), 'utf8',
  ).replace('dialog.pick_file()', 'dialog.blocking_pick_file()');
  writeFile(pluginBridge, 'apps/desktop/src-tauri/src/commands.rs', pluginBridgeSource);
  assert.throws(
    () => assertTauriProductionBuildContract(pluginBridge),
    /must run its parented picker on the blocking pool/,
  );

  const unloggedFailureSource = fs.readFileSync(
    path.join(unloggedWorkerFailure, 'apps/desktop/src-tauri/src/commands.rs'), 'utf8',
  ).replace('    diagnostics::record("media-picker.worker-failed", &[]);\n', '');
  writeFile(
    unloggedWorkerFailure,
    'apps/desktop/src-tauri/src/commands.rs',
    unloggedFailureSource,
  );
  assert.throws(
    () => assertTauriProductionBuildContract(unloggedWorkerFailure),
    /must run its parented picker on the blocking pool/,
  );
});

test('embedded ASR, speech, and render workers map to exact runtime destinations', (context) => {
  const root = createWorkerFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const mappings = collectResourceMappings(root);
  assert.doesNotThrow(() => assertWorkerResources(root, mappings));
});

test('worker resource validation fail-closes when speech is omitted', (context) => {
  const root = createWorkerFixture({ packageSpeech: false });
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const mappings = collectResourceMappings(root);
  assert.throws(() => assertWorkerResources(root, mappings), /speech\.rs embeds osg_speech_worker\.py/);
});

test('worker resource validation fail-closes when the render worker is omitted', (context) => {
  const root = createWorkerFixture({ packageRender: false });
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const mappings = collectResourceMappings(root);
  assert.throws(
    () => assertWorkerResources(root, mappings),
    /render\.rs embeds osg_render_worker\.mjs/,
  );
});

test('worker resource validation fail-closes on platform-dependent checkout bytes', (context) => {
  const root = createWorkerFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  writeFile(root, '.gitattributes', '*.mjs text\n*.py text\n');
  const mappings = collectResourceMappings(root);
  assert.throws(
    () => assertWorkerResources(root, mappings),
    /must include \*\.mjs text eol=lf/,
  );
});

test('managed native-tool delivery validates every target without bundled executables', (context) => {
  const root = createNativeToolFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  assert.doesNotThrow(() => assertNativeToolDelivery(root, []));
  assert.throws(
    () => assertNativeToolDelivery(root, [{ destination: 'bin/yt-dlp.exe' }]),
    /must be installed from the reviewed catalog, not bundled/,
  );
});

test('managed native-tool delivery rejects upstream-audit and immutable-source drift', (context) => {
  const root = createNativeToolFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const deliveryPath = path.join(
    root,
    'crates/osg-native-tools/delivery/native-tools.delivery.json',
  );
  const delivery = JSON.parse(fs.readFileSync(deliveryPath, 'utf8'));
  const ytDlp = delivery.tools.find(({ id }) => id === 'yt-dlp');
  ytDlp.notices[0].sha256 = '0'.repeat(64);
  fs.writeFileSync(deliveryPath, JSON.stringify(delivery));
  assert.throws(
    () => assertNativeToolDelivery(root, []),
    /yt-dlp notice hashes differ from the upstream audit lock/,
  );

  ytDlp.notices[0].sha256 =
    '7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c';
  ytDlp.platforms['windows-x86_64'].releases[0].artifact.sourceUrl =
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  fs.writeFileSync(deliveryPath, JSON.stringify(delivery));
  assert.throws(
    () => assertNativeToolDelivery(root, []),
    /may not use a latest alias/,
  );

  ytDlp.platforms['windows-x86_64'].releases[0].artifact.sourceUrl =
    'https://github.com/yt-dlp/yt-dlp/releases/download/2025.01.01/yt-dlp.exe';
  fs.writeFileSync(deliveryPath, JSON.stringify(delivery));
  assert.throws(
    () => assertNativeToolDelivery(root, []),
    /exact reviewed release tag 2026\.07\.04/,
  );
});

test('media tools are downloadable on Windows and blocked honestly elsewhere', (context) => {
  const root = createNativeToolFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  assert.doesNotThrow(
    () => assertRequiredMediaToolDelivery(root, 'x86_64-pc-windows-msvc'),
  );
  assert.throws(
    () => assertRequiredMediaToolDelivery(root, 'aarch64-apple-darwin'),
    /FFmpeg\/ffprobe delivery is unavailable/,
  );
});

test('repository release policy requires owner-selected license and application notices', (context) => {
  const root = createNativeToolFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  assert.throws(
    () => assertRepositoryReleasePolicy(root),
    /root LICENSE[\s\S]*THIRD_PARTY_NOTICES\.md/i,
  );
});

test('PromptDJ font policy requires per-asset notices for any bundled font', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-font-release-policy-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const openFont = 'promptdj-midi/assets/fonts/Reviewed Open Font.woff2';
  writeFile(root, openFont, 'open font fixture');

  let failures = collectPromptDjFontReleasePolicyFailures(root);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /font assets are absent from THIRD_PARTY_NOTICES\.md/);
  assert.match(failures[0], /Reviewed Open Font\.woff2/);

  writeFile(root, 'THIRD_PARTY_NOTICES.md', `${openFont}\n`);
  failures = collectPromptDjFontReleasePolicyFailures(root);
  assert.deepEqual(failures, []);
});

test('runtime targets report only their honest release blocker groups', () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  for (const { target } of RELEASE_MATRIX) {
    if (target === 'x86_64-pc-windows-msvc') {
      assert.doesNotThrow(() => checkRuntimePackageReadiness(repositoryRoot, target));
      continue;
    }
    assert.throws(
      () => checkRuntimePackageReadiness(repositoryRoot, target),
      (error) => {
        assert.match(error.message, /Runtime package has 3 blocking violation\(s\)/);
        assert.match(error.message, /FFmpeg\/ffprobe delivery is unavailable/);
        assert.match(error.message, /Remotion delivery catalog/);
        assert.match(error.message, /Managed engine delivery/);
        assert.doesNotMatch(error.message, /updater public key is still a placeholder/i);
        assert.doesNotMatch(error.message, /Repository licensing\/notice policy is unresolved/);
        assert.doesNotMatch(error.message, /bundle pinned|yt-dlp\.exe|deno\.exe/);
        return true;
      },
    );
  }
});

test('Remotion delivery requires exact cross-component payload and license inventory', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-remotion-delivery-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const worker = 'reviewed render worker';
  writeFile(root, 'video-renderer/worker/osg_render_worker.mjs', worker);
  const digest = (contents) => crypto.createHash('sha256').update(contents).digest('hex');
  const file = (role, filePath, executable = false) => ({
    executable,
    path: filePath,
    role,
    sha256: digest(`${role}:${filePath}`),
    sizeBytes: Buffer.byteLength(`${role}:${filePath}`),
  });
  const noticePath = 'licenses/THIRD_PARTY_NOTICES.txt';
  const source = (id) => `https://downloads.example.test/${id}/1.2.3/${id}-1.2.3.zip`;
  const catalog = {
    schemaVersion: 1,
    protocolVersion: 1,
    remotionVersion: '4.0.507',
    worker: {
      sourcePath: 'video-renderer/worker/osg_render_worker.mjs',
      sizeBytes: Buffer.byteLength(worker),
      sha256: digest(worker),
    },
    platforms: {
      'x86_64-pc-windows-msvc': {
        releases: [{
          archiveFormat: 'zip',
          archiveSha256: 'a'.repeat(64),
          archiveSizeBytes: 100,
          components: [
            ['node', '24.19.0'],
            ['chromium', '140.0.7339'],
            ['remotion', '4.0.507'],
            ['remotion-binaries', '4.0.507'],
            ['font-pack', '1.0.0'],
          ].map(([id, version]) => ({
            id,
            version,
            sourceUrl: source(id),
            license: { spdx: 'MIT', noticePath },
          })),
          files: [
            file('node', 'node/node.exe', true),
            file('browser', 'chromium/chrome.exe', true),
            file('rendererPackage', 'renderer/package.json'),
            file('bundleIndex', 'bundle/index.html'),
            file('binariesMarker', 'binaries/.ready'),
            file('fontManifest', 'bundle/fonts/fonts.css'),
            file('notices', noticePath),
            file('payload', 'renderer/index.js'),
          ],
          manifest: {
            path: 'remotion-runtime.json',
            sha256: 'b'.repeat(64),
            sizeBytes: 200,
          },
          remotionVersion: '4.0.507',
          sourceUrl: source('runtime'),
          target: 'x86_64-pc-windows-msvc',
          unpackedSizeBytes: 1_000,
          version: '1.0.0',
        }],
      },
    },
  };
  const catalogPath = 'video-renderer/delivery/remotion-runtime.delivery.json';
  writeFile(root, catalogPath, JSON.stringify(catalog));
  assert.throws(() =>
    assertRenderRuntimeDelivery(root, 'x86_64-pc-windows-msvc'),
    /no packaged render-runtime resource tree\/receipt or managed installer wiring/,
  );

  const release = catalog.platforms['x86_64-pc-windows-msvc'].releases[0];
  const resources = {};
  for (const runtimeFile of release.files) {
    const sourcePath = `runtime-fixture/${runtimeFile.path}`;
    writeFile(root, sourcePath, `${runtimeFile.role}:${runtimeFile.path}`);
    resources[`../../../${sourcePath}`] =
      `render-runtime/x86_64-pc-windows-msvc/${runtimeFile.path}`;
  }
  const manifestContents = `${JSON.stringify({
    schemaVersion: 1,
    target: 'x86_64-pc-windows-msvc',
    remotionVersion: '4.0.507',
    files: release.files.map(({ role, path: filePath, sizeBytes, sha256 }) => ({
      role,
      path: filePath,
      sizeBytes,
      sha256,
    })),
  })}\n`;
  const manifestSource = 'runtime-fixture/remotion-runtime.json';
  writeFile(root, manifestSource, manifestContents);
  release.manifest.sizeBytes = Buffer.byteLength(manifestContents);
  release.manifest.sha256 = digest(manifestContents);
  resources[`../../../${manifestSource}`] =
    'render-runtime/x86_64-pc-windows-msvc/remotion-runtime.json';
  writeFile(
    root,
    'apps/desktop/src-tauri/tauri.conf.json',
    JSON.stringify({ bundle: { resources } }),
  );
  fs.writeFileSync(path.join(root, catalogPath), JSON.stringify(catalog));
  assert.doesNotThrow(() =>
    assertRenderRuntimeDelivery(root, 'x86_64-pc-windows-msvc'),
  );

  writeFile(root, 'runtime-fixture/renderer/index.js', 'tampered renderer payload');
  assert.throws(
    () => assertRenderRuntimeDelivery(root, 'x86_64-pc-windows-msvc'),
    /no packaged render-runtime resource tree\/receipt or managed installer wiring/,
  );
  writeFile(root, 'runtime-fixture/renderer/index.js', 'payload:renderer/index.js');
  catalog.platforms['x86_64-pc-windows-msvc'].releases[0].components =
    catalog.platforms['x86_64-pc-windows-msvc'].releases[0].components
      .filter((component) => component.id !== 'font-pack');
  fs.writeFileSync(path.join(root, catalogPath), JSON.stringify(catalog));
  assert.throws(
    () => assertRenderRuntimeDelivery(root, 'x86_64-pc-windows-msvc'),
    /components must be exactly/,
  );
});

test('managed ASR and speech delivery requires releases plus real install command wiring', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-engine-delivery-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const sha256 = 'b'.repeat(64);
  const delivery = (id, { model = true, remote = false } = {}) => {
    const files = [
      {
        executable: true,
        path: 'runtime/python.exe',
        role: 'runtime',
        sha256,
        sizeBytes: 10,
      },
      {
        executable: false,
        path: 'licenses/LICENSE.txt',
        role: 'license',
        sha256,
        sizeBytes: 10,
      },
    ];
    if (model) {
      files.push({
        executable: false,
        path: 'model/model.bin',
        role: 'model',
        sha256,
        sizeBytes: 10,
      });
    }
    return {
      asset: `${id}-windows-x86_64-1.2.3-${sha256.slice(0, 16)}.zip`,
      files,
      modelRelativePath: model ? 'model' : undefined,
      pythonRelativePath: 'runtime/python.exe',
      sha256,
      sizeBytes: 100,
      sourceUrl: remote
        ? `https://downloads.example.test/${id}/1.2.3/${id}-${sha256.slice(0, 16)}.zip`
        : undefined,
      unpackedSizeBytes: 200,
      version: '1.2.3',
    };
  };
  const asrIds = [
    'parakeet',
    'faster-whisper-turbo',
    'faster-whisper-large-v3',
    'qwen3-asr-1.7b',
    'qwen3-asr-0.6b',
  ];
  const speechIds = ['f5-tts', 'chatterbox', 'edge-tts', 'gtts', 'gemini-tts'];
  writeFile(
    root,
    'crates/osg-engine-packages/delivery/engine-packages.delivery.json',
    JSON.stringify({
      platforms: {
        'windows-x86_64': {
          engines: asrIds.map((id) => ({ id, releases: [delivery(id)] })),
        },
      },
      schemaVersion: 1,
    }),
  );
  writeFile(
    root,
    'crates/osg-speech/delivery/speech-packages.delivery.json',
    JSON.stringify({
      commands: {
        install: 'speech_package_install',
        remove: 'speech_package_remove',
        status: 'speech_packages_status',
      },
      platforms: {
        'windows-x86_64': {
          backends: speechIds.map((id) => ({
            id,
            releases: [
              delivery(id, {
                model: id === 'f5-tts' || id === 'chatterbox',
                remote: true,
              }),
            ],
          })),
        },
      },
      schemaVersion: 1,
    }),
  );
  const commands = [
    'engine_packages_status',
    'engine_package_install',
    'engine_package_remove',
    'speech_packages_status',
    'speech_package_install',
    'speech_package_remove',
  ].join('\n');
  for (const relativePath of [
    'apps/desktop/src-tauri/build.rs',
    'apps/desktop/src-tauri/src/lib.rs',
    'apps/desktop/src-tauri/permissions/app.toml',
  ]) {
    writeFile(root, relativePath, commands);
  }
  assert.doesNotThrow(() =>
    assertManagedEngineDelivery(root, 'x86_64-pc-windows-msvc'),
  );

  const catalogPath = path.join(
    root,
    'crates/osg-engine-packages/delivery/engine-packages.delivery.json',
  );
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  catalog.platforms['windows-x86_64'].engines[0].releases = [];
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  assert.throws(
    () => assertManagedEngineDelivery(root, 'x86_64-pc-windows-msvc'),
    /ASR delivery catalog windows-x86_64 has no reviewed release for: parakeet/,
  );
});

test('production rejects unmanaged loopback endpoints but accepts the explicit browser-only guard', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-render-delivery-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  writeFile(
    root,
    'src/utils/videoRendererClient.js',
    "export const RENDERER_BASE_URL = 'http://localhost:3033';",
  );
  assert.throws(
    () => assertNoUnmanagedLocalServices(root),
    /Production frontend still contains unmanaged loopback service endpoints/,
  );
  fs.rmSync(path.join(root, 'src/utils/videoRendererClient.js'));
  writeFile(
    root,
    'src/utils/ipv6Renderer.js',
    "export const RENDERER_BASE_URL = 'http://[::1]:3033';",
  );
  assert.throws(
    () => assertNoUnmanagedLocalServices(root),
    /Production frontend still contains unmanaged loopback service endpoints/,
  );
  fs.rmSync(path.join(root, 'src/utils/ipv6Renderer.js'));
  writeFile(
    root,
    'src/utils/publicRenderer.js',
    "export const RENDERER_BASE_URL = 'https://localhost.example.test';",
  );
  assert.doesNotThrow(() => assertNoUnmanagedLocalServices(root));
  fs.rmSync(path.join(root, 'src/utils/publicRenderer.js'));
  writeFile(
    root,
    'src/utils/browserCompatibility.js',
    [
      "import { guardBrowserOnlyServiceOrigin } from '../platform/browserOnlyService';",
      "const SERVER = guardBrowserOnlyServiceOrigin('http://localhost:3031');",
      'export const ping = () => fetch(`${SERVER}/health`);',
    ].join('\n'),
  );
  assert.doesNotThrow(() => assertNoUnmanagedLocalServices(root));
  fs.rmSync(path.join(root, 'src/utils/browserCompatibility.js'));
  writeFile(
    root,
    'src/utils/fakeGuard.js',
    [
      'const guardBrowserOnlyServiceOrigin = (value) => value;',
      "export const SERVER = guardBrowserOnlyServiceOrigin('http://localhost:3031');",
    ].join('\n'),
  );
  assert.throws(
    () => assertNoUnmanagedLocalServices(root),
    /Production frontend still contains unmanaged loopback service endpoints/,
  );
  fs.rmSync(path.join(root, 'src/utils/fakeGuard.js'));
  writeFile(
    root,
    'src/utils/spoofedGuard.js',
    [
      "import { guardBrowserOnlyServiceOrigin } from './fake/browserOnlyService';",
      "export const SERVER = guardBrowserOnlyServiceOrigin('http://localhost:3031');",
    ].join('\n'),
  );
  assert.throws(
    () => assertNoUnmanagedLocalServices(root),
    /Production frontend still contains unmanaged loopback service endpoints/,
  );
  fs.rmSync(path.join(root, 'src/utils/spoofedGuard.js'));
  writeFile(
    root,
    'src/utils/forcedBrowserGuard.js',
    [
      "import { guardBrowserOnlyServiceOrigin } from '../platform/browserOnlyService';",
      "export const SERVER = guardBrowserOnlyServiceOrigin('http://localhost:3031', { nativeRuntime: false });",
    ].join('\n'),
  );
  assert.throws(
    () => assertNoUnmanagedLocalServices(root),
    /Production frontend still contains unmanaged loopback service endpoints/,
  );
  fs.rmSync(path.join(root, 'src/utils/forcedBrowserGuard.js'));
  writeFile(
    root,
    'src/platform/mediaCapability.js',
    'const PLAYBACK = /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/asset\\//;',
  );
  assert.doesNotThrow(() => assertNoUnmanagedLocalServices(root));
});

test('the production transport audit is native-only and has no capability blockers', () => {
  const root = path.resolve(__dirname, '..');
  const audit = assertLoopbackAuditManifest(root);
  assert.equal(audit.schemaVersion, 2);
  assert.equal(audit.productionPolicy, 'native-only');
  assert.equal(audit.artifactGate, 'scripts/check-production-transport.js');
  assert.ok(audit.reviewedCompatibilitySources.length <= 3);
  assert.deepEqual(audit.missingCapabilities, []);
  assert.doesNotThrow(() => assertNoMissingNativeCapabilities(root));
});

test('resource destinations cannot escape or alias package paths', () => {
  assert.equal(normalizeDestination('workers/osg_asr_worker.py'), 'workers/osg_asr_worker.py');
  for (const destination of ['../worker.py', '/absolute/worker.py', 'workers//worker.py']) {
    assert.throws(() => normalizeDestination(destination), /Resource destination/);
  }
});

test('runtime profile requires an explicit supported target', () => {
  assert.deepEqual(parseArguments(['--profile', 'compile']), {
    profile: 'compile',
    target: undefined,
  });
  assert.deepEqual(
    parseArguments([
      '--profile',
      'runtime-package',
      '--target',
      'aarch64-apple-darwin',
    ]),
    { profile: 'runtime-package', target: 'aarch64-apple-darwin' },
  );
  assert.throws(() => parseArguments(['--mystery']), /Unknown argument/);
});

test('effective toolchain versions must equal every repository pin', () => {
  const pins = {
    nodeVersion: '24.19.0',
    packageManager: 'npm@11.17.0',
    pythonVersion: '3.12.10',
    rustVersion: '1.97.1',
  };
  assert.doesNotThrow(() =>
    assertEffectiveToolchain(pins, {
      nodeVersion: '24.19.0',
      npmVersion: '11.17.0',
      pythonVersion: '3.12.10',
      rustVersion: '1.97.1',
    }),
  );
  assert.throws(
    () =>
      assertEffectiveToolchain(pins, {
        nodeVersion: '24.19.0',
        npmVersion: '11.16.0',
        pythonVersion: '3.12.10',
        rustVersion: '1.97.1',
      }),
    /Effective npm is 11\.16\.0/,
  );
  assert.throws(
    () =>
      assertEffectiveToolchain(pins, {
        nodeVersion: '24.19.0',
        npmVersion: '11.17.0',
        pythonVersion: '3.12.9',
        rustVersion: '1.97.1',
      }),
    /Effective Python is 3\.12\.9/,
  );
});
