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

const {
  CR,
  CRLF,
  LF,
  countOccurrences,
  normalizeLineEndings,
  readMutableSource,
  toCrlf,
  weaken,
  weakenAll,
} = require('./mutation-testing');

const INSTALLED_SMOKE_SCRIPT = readMutableSource(__dirname, 'test-installed-windows.ps1');
const NATIVE_PICKER_EVIDENCE_SCRIPT = readMutableSource(__dirname, 'native-picker-evidence.ps1');
const NATIVE_PICKER_EVIDENCE_REGRESSION = readMutableSource(
  __dirname, 'test-native-picker-evidence.ps1',
);
const INSTALLED_LOCAL_MEDIA_INSPECTOR = readMutableSource(
  __dirname, 'inspect-installed-local-media-flow.mjs',
);
const INSTALLED_MEDIA_FLOW_INSPECTOR = readMutableSource(
  __dirname, 'inspect-installed-media-flow.mjs',
);
const INPUT_METHODS_SOURCE = readMutableSource(
  __dirname, '..', 'src', 'components', 'InputMethods.js',
);
const BUTTONS_CONTAINER_SOURCE = readMutableSource(
  __dirname, '..', 'src', 'components', 'app', 'ButtonsContainer.jsx',
);
const DOWNLOAD_HANDLERS_SOURCE = readMutableSource(
  __dirname, '..', 'src', 'components', 'app', 'handlers', 'downloadHandlers.js',
);
const NATIVE_URL_DOWNLOAD_ADAPTER_SOURCE = readMutableSource(
  __dirname, '..', 'src', 'platform', 'nativeUrlDownloadAdapter.js',
);
const INSTALLED_NATIVE_TOOLS_INSPECTOR = readMutableSource(
  __dirname, 'inspect-installed-native-tools.mjs',
);
const UPDATER_SMOKE_WORKFLOW = readMutableSource(
  __dirname, '..', '.github', 'workflows', 'updater-smoke.yml',
);
const SIGNED_UPDATER_SCRIPT = readMutableSource(__dirname, 'test-signed-updater-windows.ps1');
const TAURI_NSIS_BOOTSTRAP_SCRIPT = readMutableSource(__dirname, 'prepare-tauri-nsis.ps1');
const DESKTOP_SOURCE = readMutableSource(
  __dirname, '..', 'apps', 'desktop', 'src-tauri', 'src', 'lib.rs',
);
const APP_CLOSE_SOURCE = readMutableSource(
  __dirname, '..', 'apps', 'desktop', 'src-tauri', 'src', 'app_close.rs',
);
const CI_UPDATER_ARGUMENT_SOURCE = readMutableSource(
  __dirname, '..', 'apps', 'desktop', 'src-tauri', 'src', 'ci_updater_fixture.rs',
);
const UPDATER_SOURCE = readMutableSource(
  __dirname, '..', 'apps', 'desktop', 'src-tauri', 'src', 'updater.rs',
);
const CARGO_LOCK_SOURCE = readMutableSource(__dirname, '..', 'Cargo.lock');

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
    '#[cfg(all(not(debug_assertions), not(feature = "production"), not(feature = "unsigned-local-build")))]\n'
      + 'compile_error!("release executables must be built with `npm run tauri:build`; '
      + 'plain `cargo build --release` retains the development URL");\n',
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/src/commands.rs',
    'use tauri::WebviewWindow;\n'
      + 'async fn select_media(window: WebviewWindow) {\n'
      + '  let Some(path) = pick_media_path(window).await? else { return; };\n'
      + '}\n'
      + '\n'
      + 'async fn pick_media_path(window: WebviewWindow) -> Option<std::path::PathBuf> {\n'
      + '  diagnostics::record("media-picker.requested", &[]);\n'
      + '  let selected = dialog_paths::pick_file_with_window(\n'
      + '    window, "Choose video or audio", "Video and audio", &extensions,\n'
      + '  ).await?;\n'
      + '  diagnostics::record("media-picker.returned", &[("outcome", media_picker_outcome(selected.as_ref()))]);\n'
      + '  let Some(path) = selected else { return; };\n'
      + '}\n',
  );
  writeFile(
    root,
    'apps/desktop/src-tauri/src/dialog_paths.rs',
    '#[cfg(feature = "e2e-automation")]\n'
      + '#[allow(clippy::unused_async)]\n'
      + 'pub(crate) async fn pick_file_with_window(\n'
      + '  _window: WebviewWindow, _title: &str, _filter_label: &str, _extensions: &[&str],\n'
      + ') -> CommandResult<Option<PathBuf>> {\n'
      + '  staged_media_selection().map(Some)\n'
      + '}\n'
      + '#[cfg(not(feature = "e2e-automation"))]\n'
      + 'pub(crate) async fn pick_file_with_window(\n'
      + '  window: WebviewWindow, title: &str, filter_label: &str, extensions: &[&str],\n'
      + ') -> CommandResult<Option<PathBuf>> {\n'
      + '  let dialog = rfd::FileDialog::new()\n'
      + '    .set_parent(&window)\n'
      + '    .set_title(title)\n'
      + '    .add_filter(filter_label, extensions);\n'
      + '  tauri::async_runtime::spawn_blocking(move || dialog.pick_file()).await\n'
      + '}\n'
      + '#[cfg(feature = "e2e-automation")]\n'
      + 'pub(crate) fn pick_file() {}\n',
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
  return workflow.slice(0, start) + weaken(job, search, replacement) + workflow.slice(end);
}

// The guard that makes every other mutation in this file mean something. It has to be proven on
// both line endings, because the platform where it broke is not the platform anyone runs locally.
test('weakening refuses to hand back an unchanged fixture on either line ending', () => {
  const lfSource = ['param(', "  [string]$Phase = 'initial'", ')', 'exit 0', ''].join(LF);
  const crlfSource = toCrlf(lfSource);
  assert.notEqual(lfSource, crlfSource, 'the two fixtures must genuinely differ');
  assert.equal(countOccurrences(crlfSource, CR), 4);
  assert.equal(countOccurrences(lfSource, CR), 0);

  // The original defect, reproduced: an LF search string against CRLF bytes matches nothing.
  const lfSearch = `param(${LF}  [string]$Phase`;
  assert.equal(countOccurrences(lfSource, lfSearch), 1);
  assert.equal(countOccurrences(crlfSource, lfSearch), 0);
  assert.equal(crlfSource.replace(lfSearch, 'MUTATED'), crlfSource);

  // Defence 1: normalising at the read boundary makes the LF search string match either way.
  for (const [label, source] of [['LF', lfSource], ['CRLF', crlfSource]]) {
    const mutated = weaken(normalizeLineEndings(source), lfSearch, 'MUTATED');
    assert.ok(mutated.includes('MUTATED'), `${label} source must weaken after normalisation`);
  }

  // Defence 2: without normalising, the same mutation is a loud failure instead of a silent pass.
  assert.throws(
    () => weaken(crlfSource, lfSearch, 'MUTATED'),
    (error) => {
      assert.match(error.message, /Mutation target is absent/);
      assert.match(error.message, /still holds 4 CR bytes/);
      assert.match(error.message, /readMutableSource/);
      return true;
    },
  );

  // A search that is present but whose replacement changes nothing is equally vacuous.
  assert.throws(
    () => weaken(lfSource, 'exit 0', 'exit 0'),
    /Mutation left the source byte-identical/,
  );

  // Cardinality is checkable where it carries meaning.
  const repeated = [lfSource, lfSource].join(LF);
  assert.throws(
    () => weaken(repeated, 'exit 0', 'exit 1', { expected: 1 }),
    /occurs 2 times, expected exactly 1/,
  );
  assert.doesNotThrow(() => weakenAll(repeated, 'exit 0', 'exit 1', { expected: 2 }));

  // Regular-expression searches are counted and proven the same way.
  assert.throws(
    () => weaken(lfSource, /\$Phase\s*=\s*'reactivation'/, 'x'),
    /Mutation target is absent/,
  );
  assert.doesNotThrow(() => weaken(lfSource, /\$Phase\s*=\s*'initial'/, "$Phase = 'x'"));
});

test('every mutable source is read with normalised line endings', () => {
  const sources = {
    INSTALLED_SMOKE_SCRIPT,
    NATIVE_PICKER_EVIDENCE_SCRIPT,
    NATIVE_PICKER_EVIDENCE_REGRESSION,
    INSTALLED_LOCAL_MEDIA_INSPECTOR,
    INSTALLED_MEDIA_FLOW_INSPECTOR,
    INPUT_METHODS_SOURCE,
    BUTTONS_CONTAINER_SOURCE,
    DOWNLOAD_HANDLERS_SOURCE,
    NATIVE_URL_DOWNLOAD_ADAPTER_SOURCE,
    INSTALLED_NATIVE_TOOLS_INSPECTOR,
    UPDATER_SMOKE_WORKFLOW,
    SIGNED_UPDATER_SCRIPT,
    TAURI_NSIS_BOOTSTRAP_SCRIPT,
    DESKTOP_SOURCE,
    CI_UPDATER_ARGUMENT_SOURCE,
    UPDATER_SOURCE,
    CARGO_LOCK_SOURCE,
  };
  for (const [name, source] of Object.entries(sources)) {
    assert.notEqual(source, '', `${name} must not be empty`);
    assert.equal(
      countOccurrences(source, CR),
      0,
      `${name} still carries CR bytes, so its LF search strings would match nothing`,
    );
  }
});

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
  const shadowedLifecycle = weaken(INSTALLED_SMOKE_SCRIPT,
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
  const deadHotLifecycle = weaken(
    weaken(
      INSTALLED_SMOKE_SCRIPT,
      '    $nativeToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath',
      '    if ($false) {\n    $nativeToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath',
    ),
    '    $postHotToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath',
    '    }\n    $postHotToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath',
  );
  const commentedPreclickCategory = weaken(INSTALLED_SMOKE_SCRIPT,
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
      () => assertInstalledSmokeScript(weakenAll(INSTALLED_SMOKE_SCRIPT, fragment, 'removed')),
      /Installed Windows smoke is missing lifecycle proof/,
    );
  }
  const reorderedInstalledMedia = weaken(
    weaken(
      weaken(
        INSTALLED_SMOKE_SCRIPT,
        '$localMediaFlow = Inspect-InstalledLocalMediaFlow',
        '$temporaryInstalledMedia = Inspect-InstalledLocalMediaFlow',
      ),
      '$mediaPipeline = Inspect-InstalledMediaPipeline',
      '$localMediaFlow = Inspect-InstalledLocalMediaFlow',
    ),
    '$temporaryInstalledMedia = Inspect-InstalledLocalMediaFlow',
    '$mediaPipeline = Inspect-InstalledMediaPipeline',
  );
  assert.throws(
    () => assertInstalledSmokeScript(reorderedInstalledMedia),
    /ordered installed media flow/,
  );
  assert.throws(
    () => assertInstalledSmokeScript(weaken(INSTALLED_SMOKE_SCRIPT,
      /\$initialMediaFlow\.assetId -eq \$localMediaFlow\.assetId `\r?\n\s*-or /,
      '',
    )),
    /Installed Windows smoke is missing lifecycle proof/,
  );
  for (const commentedPriorIdentityGate of [
    weaken(INSTALLED_SMOKE_SCRIPT,
      "    $arguments += @('--prior-asset-id', $PriorAssetId)",
      "    # $arguments += @('--prior-asset-id', $PriorAssetId)",
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '      -PriorAssetId $localMediaFlow.assetId',
      '      # -PriorAssetId $localMediaFlow.assetId',
    ),
  ]) {
    assert.throws(
      () => assertInstalledSmokeScript(commentedPriorIdentityGate),
      /bind exact URL phases to screenshots and prior identity/,
    );
  }
  const installedPhaseMutations = [
    [
      'same initial phase',
      weaken(INSTALLED_SMOKE_SCRIPT,
        "      -MediaPhase 'reactivation' `\n      -ScreenshotName 'osg-installed-media-flow.png' `",
        "      -MediaPhase 'initial' `\n      -ScreenshotName 'osg-installed-media-flow.png' `",
      ),
    ],
    [
      'inverted initial phase',
      weaken(INSTALLED_SMOKE_SCRIPT,
        "      -MediaPhase 'initial' `\n      -ScreenshotName 'osg-installed-media-flow-initial.png'",
        "      -MediaPhase 'reactivation' `\n      -ScreenshotName 'osg-installed-media-flow-initial.png'",
      ),
    ],
    [
      'arbitrary reactivation phase',
      weaken(INSTALLED_SMOKE_SCRIPT,
        "      -MediaPhase 'reactivation' `\n      -ScreenshotName 'osg-installed-media-flow.png' `",
        "      -MediaPhase 'arbitrary' `\n      -ScreenshotName 'osg-installed-media-flow.png' `",
      ),
    ],
    [
      'missing phase forwarding',
      weaken(INSTALLED_SMOKE_SCRIPT, "    '--media-phase', $MediaPhase\n", ''),
    ],
  ];
  for (const [description, mutation] of installedPhaseMutations) {
    assert.notEqual(mutation, INSTALLED_SMOKE_SCRIPT, description);
    assert.throws(
      () => assertInstalledSmokeScript(mutation),
      /bind exact URL phases|route one initial and one prior-bound reactivation phase/,
      description,
    );
  }
  for (const weakenedToolProof of [
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$requested.Count -ne $expectedCount',
      '$requested.Count -lt $expectedCount',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      "($startedJobs -join ',') -cne ($completedJobs -join ',')",
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      "($startedPairs -join ',') -cne ($completedPairs -join ',')",
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$entry.appInstanceId -cne $AppInstanceId',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$entry.timestampMs -isnot [string]',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$entry.event -isnot [string]',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$entry.action -isnot [string]',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$entry.tool -isnot [string]',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$entry.appInstanceId -isnot [string]',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$entry.job -isnot [string]',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$entry.code -isnot [string]',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '@($allStartedJobs | Sort-Object -Unique).Count -ne 6',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$result.pipeline.durationUs -isnot [ValueType]',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$result.pipeline.frameRate -isnot [ValueType]',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$result.pipeline.height -isnot [ValueType]',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$result.pipeline.width -isnot [ValueType]',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$result.installingScreenshot.sha256 -ceq [string]$result.installedScreenshot.sha256',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      "($uiInstallPairs -join ',') -cne ($diagnosticInstallPairs -join ',')",
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$uiInstallPairs.Count -ne 3',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$diagnosticInstallPairs.Count -ne 3',
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$postHotToolBaseline = Get-DiagnosticBaselineSnapshot -LogPath $logPath',
      '$postHotToolBaseline = $nativeToolBaseline',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '      -ExpectedInstalls 0 `',
      '      -ExpectedInstalls 3 `',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '-ExpectedRemovals 3',
      '-ExpectedRemovals 0',
    ),
  ]) {
    assert.throws(
      () => assertInstalledSmokeScript(weakenedToolProof),
      /(?:Installed Windows smoke is missing lifecycle proof|Installed Windows smoke must retain exact bounded native-tool UI evidence|Installed native-tool diagnostic proof is missing exact invariant|Installed Windows smoke must execute exact native-tool correlation and hot-reuse guards)/,
    );
  }
  const commentedPairGuard = weaken(INSTALLED_SMOKE_SCRIPT,
    /(^ {4}if \(\$uiInstallPairs[\s\S]*?^ {4}\}$)/m,
    (block) => block.split(/\r?\n/).map((line) => `# ${line}`).join('\n'),
  );
  const commentedPostHotCall = weaken(INSTALLED_SMOKE_SCRIPT,
    /(^ {4}Assert-NativeToolLifecycleDiagnostics `\r?\n^ {6}-Events \$postHotToolEvents `[\s\S]*?^ {6}-ExpectedRemovals 0$)/m,
    (block) => block.split(/\r?\n/).map((line) => `# ${line}`).join('\n'),
  );
  const commentedInitialToolCall = weaken(INSTALLED_SMOKE_SCRIPT,
    /(^ {4}Assert-NativeToolLifecycleDiagnostics `\r?\n^ {6}-Events \$initialToolEvents `[\s\S]*?^ {6}-ExpectedRemovals 0$)/m,
    (block) => block.split(/\r?\n/).map((line) => `# ${line}`).join('\n'),
  );
  const commentedHotToolCall = weaken(INSTALLED_SMOKE_SCRIPT,
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
    weaken(INSTALLED_SMOKE_SCRIPT,
      "throw 'Installed application exited before the graceful close request'",
      'return',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$closeEventsAfter -ne ($closeEventsBefore + 1)',
      '$false',
    ),
  ]) {
    assert.throws(
      () => assertInstalledSmokeScript(weakenedCloseProof),
      /(?:live responsive app|missing lifecycle proof)/,
    );
  }
  const omittedEditorMutationRescan = weaken(INSTALLED_SMOKE_SCRIPT,
    '          $mutationCandidate = Get-NativePickerPinnedCandidateState `\n'
      + '              -Element $dialog `\n'
      + '              -CandidateHandle $dialogHandle `\n'
      + '              -ProcessId $ProcessId `\n'
      + '              -OwnerHandle $OwnerHandle',
    '          $mutationCandidate = $freshCandidate',
  );
  assert.throws(
    () => assertInstalledSmokeScript(omittedEditorMutationRescan),
    /native-picker authority/,
  );
  for (const [weakenedIndex, weakenedPickerProof] of [
    weaken(INSTALLED_SMOKE_SCRIPT, '$dialog.FindAll(', '$dialog.FindFirst('),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$controls.Count -eq 1',
      '$controls.Count -ge 1',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'Add-Type -AssemblyName UIAutomationClientSideProviders -ErrorAction Stop',
      '# omitted client-side provider load',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '[void][System.Windows.Automation.AutomationElement]::RootElement',
      '# omitted UI Automation bootstrap',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '[void][System.Windows.Automation.AutomationElement]::RootElement',
      '[void][System.Windows.Automation.AutomationElement]::RootElement.Current.Name',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      "@('button', 'combobox', 'edit')",
      "@('button', 'combobox')",
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$_.ClassName -ceq $providerClassName',
      '$_.ClassName -ieq $providerClassName',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$providerEntries.Count -ne 1 `\n        -or $null -eq $providerEntries[0].ClientSideProviderFactoryCallback',
      '$providerEntries.Count -lt 1',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '[System.Windows.Automation.ClientSideProviderDescription[]]@($providerEntries[0])',
      '[System.Windows.Automation.ClientSideProviderDescription[]]@($providerTable)',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '[System.Windows.Automation.AndCondition]::new(',
      '[System.Windows.Automation.OrCondition]::new(',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '[System.Windows.Automation.ControlType]::Edit',
      '[System.Windows.Automation.ControlType]::ComboBox',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '-IsEnabled $isEnabled',
      '-IsEnabled $true',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '-IsOffscreen $isOffscreen',
      '-IsOffscreen $false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '-HasValuePattern $hasValuePattern',
      '-HasValuePattern $true',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '-IsReadOnly $isReadOnly',
      '-IsReadOnly $false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '            $mutationEditor = $null\n\n            $readbackCandidate = Get-NativePickerPinnedCandidateState',
      '            $readbackCandidate = Get-NativePickerPinnedCandidateState',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$readbackEditor = Get-NativePickerWritableEditor -Dialog $dialog',
      '$readbackEditor = $mutationEditor',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$openButtons.Count -eq 1',
      '$openButtons.Count -ge 1',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$snapshot.NativeExactMatchCount -eq 0 -and $remainingCandidates.Count -eq 0',
      '$remainingCandidates.Count -le 1',
    ),
    weakenAll(INSTALLED_SMOKE_SCRIPT,
      '[OsgNativePickerWindow]::IsNormalizedWindow(',
      '$false -and [OsgNativePickerWindow]::IsNormalizedWindow(',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'private const int MaximumRetainedCandidates = 2',
      'private const int MaximumRetainedCandidates = 3',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'return sameProcess && visible && classMatches && nameMatches && ownerMatches;',
      'return sameProcess && visible && classMatches && nameMatches;',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'return unchecked((long)(uint)window);',
      'return window;',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'NormalizeNativeWindowHandle(ancestor) != normalizedWindow',
      'ancestor != window',
    ),
    weakenAll(INSTALLED_SMOKE_SCRIPT, 'SetLastError(0);', ''),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'titleLength == 0 && titleError != 0',
      'false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'ownerMissing && ownerError != 0',
      'false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '  if (-not $scan.Incomplete `\n'
        + '      -and $scan.ExactMatchCount -eq 1 `\n'
        + '      -and @($scan.Candidates).Count -eq 1) {',
      '  if ($scan.ExactMatchCount -ge 1) {',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '  $rawCensus = $null\n',
      '  $rawCensus = $null\n'
        + '  $root = [System.Windows.Automation.AutomationElement]::RootElement\n'
        + '  [void]$root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)\n',
    ),
    weakenAll(INSTALLED_SMOKE_SCRIPT,
      'Get-NativePickerPinnedCandidateState',
      'Test-NativePickerElementCandidate',
    ),
    weakenAll(INSTALLED_SMOKE_SCRIPT,
      '$editorMutationCompleteScanObserved',
      '$editorCandidateCompleteScanObserved',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$rawCensus = [pscustomobject]$fallback',
      '$rawCensus = [pscustomobject]$fallback\n    $nativeCandidates = $fallback',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '    CandidateElements = $candidateElements',
      '    CandidateElements = $candidateElements\n    candidateHandle = 1',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT, 'EnumWindows(callback, IntPtr.Zero)', 'true'),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'private const int MaximumEnumeratedWindows = 512',
      'private const int MaximumEnumeratedWindows = 1024',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '[Math]::Max([int]$Maxima[$name], [int]$value)',
      '[int]$value',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'if (classMatches && nameMatches) {',
      'if (ownerMatches && classMatches && nameMatches) {',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'if (sameProcess || classMatches) {',
      'if (classMatches) {',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$snapshot.NativeExactMatchCount -eq 1 -and $nativeCandidates.Count -eq 1',
      '$snapshot.RawProcessExactMatches -eq 1',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'Update-NativePickerRawCensusMaxima -Maxima $rawCensusMaxima -Snapshot $snapshot',
      '# omitted raw census update',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'Add-NativePickerRawCensusMetrics -Metrics $failureMetrics -Maxima $rawCensusMaxima',
      '# omitted failed raw census evidence',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
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
    weaken(INSTALLED_SMOKE_SCRIPT,
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
    weaken(INSTALLED_SMOKE_SCRIPT,
      '    Update-NativePickerRawCensusMaxima -Maxima $rawCensusMaxima -Snapshot $snapshot\n'
        + '    $nativeCandidates = @($snapshot.NativeCandidates)',
      '    # omitted cleanup raw census update\n'
        + '    $nativeCandidates = @($snapshot.NativeCandidates)',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '    if ($snapshot.NativeExactMatchCount -gt 1) {',
      '    if ($snapshot.RawProcessOwnerMatches -gt 1) {',
    ),
    weakenAll(INSTALLED_SMOKE_SCRIPT, 'RawDesktopExactMatches', 'RawProcessExactMatches'),
    weakenAll(INSTALLED_SMOKE_SCRIPT, 'RawCensusIncomplete', 'RawCensusComplete'),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'public int RawProcessWindowMatches { get; internal set; }',
      'public int RawProcessWindowMatches { get; internal set; }\n'
        + '    public int RawWindowTitle { get; internal set; }',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT, '$snapshotAttempt -lt 5', '$snapshotAttempt -lt 1'),
    weaken(INSTALLED_SMOKE_SCRIPT, '$nonPrefix = $true', '$nonPrefix = $false'),
    weaken(INSTALLED_SMOKE_SCRIPT, '$phase.schemaVersion -isnot [int]', '$false'),
    weaken(INSTALLED_SMOKE_SCRIPT, '$phase.stage -isnot [string]', '$false'),
    weaken(INSTALLED_SMOKE_SCRIPT, '$phase.schemaVersion -ne 1', '$false'),
    weaken(INSTALLED_SMOKE_SCRIPT, '$phase.stage -cne $stage', '$false'),
    weaken(INSTALLED_SMOKE_SCRIPT, "'tab-activated',", ''),
    weaken(INSTALLED_SMOKE_SCRIPT, '$item.Length -gt 16384', '$false'),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'Get-InstalledLocalMediaInspectorStderrState -Path $StderrPath',
      'Get-Content -LiteralPath $StderrPath',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      "'connected' { 'inspector-tab-activation-exited' }",
      "'connected' { 'inspector-startup-exited' }",
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      "if ($phase -ceq 'click-issued')",
      "if ($phase -ceq 'prior-state-validated')",
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '$_.appInstanceId -ceq $AppInstanceId',
      '$true',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      'while ($offset -lt $snapshotBytes.Length)',
      'if ($offset -lt $snapshotBytes.Length)',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '[Text.Encoding]::UTF8.GetString($snapshotBytes)',
      '[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($LogPath))',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      "$pickerDiagnosticOutcome -cne 'selected'",
      '$false',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
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
    weaken(INSTALLED_SMOKE_SCRIPT,
      "    Set-NativePickerEvidence `\n      -Stage 'dialog-dismissed' `\n      -Outcome 'running' `",
      "    Set-NativePickerEvidence `\n      -Stage 'dialog-dismissed' `\n      -Outcome 'succeeded' `",
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      "      dismissAttempts = $pickerCompletion.DismissAttempts",
      '      dismissAttempts = 0',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
      '        # Corrective evidence failure must never replace the original post-click ErrorRecord.',
      '        throw',
    ),
    weaken(INSTALLED_SMOKE_SCRIPT,
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
    () => assertInstalledSmokeScript(weaken(INSTALLED_SMOKE_SCRIPT,
      '$invokePattern.Invoke()',
      '$openButtons[0].SetFocus()',
    )),
    /(?:non-focus-stealing|native-picker automation|missing lifecycle proof)/,
  );
  assert.throws(
    () => assertInstalledSmokeScript(weaken(INSTALLED_SMOKE_SCRIPT,
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
      weaken(NATIVE_PICKER_EVIDENCE_SCRIPT,
        /(\[IO\.File\]::Replace\(\s*\$script:nativePickerEvidenceTemporaryPath,\s*\$script:nativePickerEvidencePath,\s*)\$script:nativePickerEvidenceBackupPath/,
        (_match, prefix) => `${prefix}$null`,
      ),
      'null primary replacement backup',
    ],
    [
      weaken(NATIVE_PICKER_EVIDENCE_SCRIPT,
        /(\[IO\.File\]::Replace\(\s*\$script:nativePickerEvidenceTemporaryPath,\s*\$script:nativePickerEvidencePath,\s*)\$script:nativePickerEvidenceBackupPath/,
        (_match, prefix) => `${prefix}''`,
      ),
      'empty primary replacement backup',
    ],
    [
      weaken(NATIVE_PICKER_EVIDENCE_SCRIPT,
        /(\[IO\.File\]::Replace\(\s*\$script:nativePickerEvidenceBackupPath,\s*\$script:nativePickerEvidencePath,\s*)\$script:nativePickerEvidenceTemporaryPath/,
        (_match, prefix) => `${prefix}''`,
      ),
      'empty recovery replacement backup',
    ],
    [
      weaken(NATIVE_PICKER_EVIDENCE_SCRIPT,
        '-not [string]::Equals($parent, $Root, [StringComparison]::OrdinalIgnoreCase)',
        '$false',
      ),
      'removed direct-child comparison',
    ],
    [
      weaken(NATIVE_PICKER_EVIDENCE_SCRIPT,
        '($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0',
        '($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0',
      ),
      'inverted root reparse rejection',
    ],
    [
      weaken(NATIVE_PICKER_EVIDENCE_SCRIPT,
        '  while (-not [string]::IsNullOrEmpty($candidate)) {',
        '  while ($false) {',
      ),
      'removed root ancestor walk',
    ],
    [
      weaken(NATIVE_PICKER_EVIDENCE_SCRIPT,
        /\[IO\.File\]::Move\(\s*\$script:nativePickerEvidenceBackupPath,\s*\$script:nativePickerEvidencePath\s*\)/,
        '[IO.File]::Move($script:nativePickerEvidenceBackupPath, $script:nativePickerEvidenceTemporaryPath)',
      ),
      'redirected missing-destination restore',
    ],
    [
      weaken(NATIVE_PICKER_EVIDENCE_SCRIPT,
        'Assert-NativePickerEvidenceRegularFile -Item $item',
        'Write-Output $item | Out-Null',
      ),
      'removed bounded scratch-file validation',
    ],
    [
      weakenAll(NATIVE_PICKER_EVIDENCE_SCRIPT,
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

  const payloadLeak = weaken(NATIVE_PICKER_EVIDENCE_SCRIPT,
    '    schemaVersion = 1',
    '    schemaVersion = 1\n    mediaPath = $MediaPath',
  );
  assert.throws(
    () => assertNativePickerEvidenceScripts(
      payloadLeak,
      NATIVE_PICKER_EVIDENCE_REGRESSION,
    ),
    /payload must remain bounded/,
  );

  for (const weakenedRawSchema of [
    weaken(NATIVE_PICKER_EVIDENCE_SCRIPT, "    'rawProcessWindowMatches',\n", ''),
    weaken(NATIVE_PICKER_EVIDENCE_SCRIPT, '    rawProcessWindowMatches = 0\n', ''),
    weaken(NATIVE_PICKER_EVIDENCE_SCRIPT, '$metric.Value -le 1000', '$metric.Value -le 10000'),
    weaken(NATIVE_PICKER_EVIDENCE_SCRIPT,
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
    weakenAll(NATIVE_PICKER_EVIDENCE_REGRESSION,
      'Set-NativePickerEvidence',
      'Write-Output',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
      '[IO.Directory]::CreateDirectory($hostileBackupPath)',
      '[IO.File]::WriteAllText($hostileBackupPath, "decoy")',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
      "    throw 'Native picker evidence regression accepted a non-child destination'",
      '    Write-Output decoy',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
      '      throw "Native picker evidence regression did not restore prior bytes for $fault"',
      '      Write-Output decoy',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
      "    throw 'Native picker evidence regression accepted a reparse ancestor'",
      '    Write-Output decoy',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
      "    throw 'Native picker diagnostic regression merged command and blocking-pool dispatch stalls'",
      '    Write-Output decoy',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
      '    pickerWorkerBoundarySplit = $true',
      '    pickerWorkerBoundarySplit = $false',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
      '    rawCensusBucketsIndependent = $true',
      '    rawCensusBucketsIndependent = $false',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
      '    clientSideProvidersRegistered = $true',
      '    clientSideProvidersRegistered = $false',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
      '    filenameEditorSelectorExact = $true',
      '    filenameEditorSelectorExact = $false',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
      '    filenameEditorReadbackReacquired = $true',
      '    filenameEditorReadbackReacquired = $false',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
      "      throw 'Native picker regression selected an ambiguous, disabled, offscreen, patternless, or read-only filename editor'",
      '      Write-Output decoy',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
      "    throw 'Native picker raw census regression lost bounded maximum aggregation'",
      '    Write-Output decoy',
    ),
    weaken(NATIVE_PICKER_EVIDENCE_REGRESSION,
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
  const linkBeforeFlush = weaken(
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR, linkLine, ''),
    fsyncLine,
    `${linkLine}${fsyncLine}`,
  );
  const regressiveDuplicate = weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
    "    writePickerPhase(options.phaseDirectory, 'control-ready');",
    "    writePickerPhase(options.phaseDirectory, 'control-ready');\n"
      + "    writePickerPhase(options.phaseDirectory, 'starting');",
  );
  const commentedActivationWait = weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
    '      () => evaluate(client, OPEN_PICKER_EXPRESSION),',
    '      // () => evaluate(client, OPEN_PICKER_EXPRESSION),',
  );
  const deadActivationWait = weaken(
    weaken(
      INSTALLED_LOCAL_MEDIA_INSPECTOR,
      'export async function waitForPickerTabActivation(read, options = {}) {',
      'if (false) {\nexport async function waitForPickerTabActivation(read, options = {}) {',
    ),
    '\n\nconst evaluate = async (client, expression) => {',
    '\n}\n\nconst evaluate = async (client, expression) => {',
  );
  for (const weakened of [
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR, 'fs.linkSync(temporaryPath, phasePath)', 'fs.renameSync(temporaryPath, phasePath)'),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR, 'fs.fsyncSync(descriptor)', '// omitted durable flush'),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR, 'throw error;', 'throw new Error("cleanup replaced primary")'),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      'JSON.stringify({ schemaVersion: 1, stage })',
      "JSON.stringify({ schemaVersion: 9, stage: 'click-issued' })",
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      'value.assetId !== priorAssetId',
      'value.assetId === priorAssetId',
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      "if (uploadTab.classList.contains('active')) return 'already-active';",
      "if (uploadTab.classList.contains('active')) { uploadTab.click(); return 'already-active'; }",
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      "return 'activated';",
      "return 'already-active';",
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      'activeTabs[0] === uploadTab',
      'activeTabs[0] !== uploadTab',
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      "':scope > .tab-content-wrapper div.file-upload-input:not(.loading)'",
      "'.file-upload-input'",
    ),
    weakenAll(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      "tabList.querySelectorAll(':scope > button.tab-btn')",
      "tabList.querySelectorAll(':scope button.tab-btn')",
    ),
    weakenAll(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      'directButtons.length !== tabs.length',
      'directButtons.length < tabs.length',
    ),
    weakenAll(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      '!directButtons.every((button) => tabs.includes(button))',
      'directButtons.some((button) => tabs.includes(button))',
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      '  picker.click();\n  return true;',
      '  return true;',
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      '  picker.click();\n  return true;',
      '  picker.click();\n  picker.click();\n  return true;',
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      '  picker.click();\n  return true;',
      '  uploadTab.click();\n  picker.click();\n  return true;',
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      '  picker.click();\n  return true;',
      '  document.body.click();\n  picker.click();\n  return true;',
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      '  const picker = pickers[0];\n  const input = picker?.querySelector(',
      '  const picker = pickers[0];\n  uploadTab.click();\n  const input = picker?.querySelector(',
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      '  picker.click();\n  return true;',
      '  document.body.click();\n  return true;',
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      'pickers.length !== 1 || !(pickers[0] instanceof HTMLDivElement)',
      'pickers.length < 1',
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      "const expectedRendererAssetId = tabActivation === 'already-active' ? priorAssetId : null;",
      'const expectedRendererAssetId = priorAssetId;',
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
      'value.sessionMediaId === priorAssetId',
      'value.sessionMediaId === expectedRendererAssetId',
    ),
    weaken(INSTALLED_LOCAL_MEDIA_INSPECTOR,
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
  // The selector must move, not multiply: weakening asserts it was there exactly once to begin
  // with, and the count below asserts the move did not leave a second copy behind.
  const misplacedSemanticSelector = weaken(
    weaken(
      INPUT_METHODS_SOURCE,
      '\n            data-input-tab="file-upload"',
      '',
      { expected: 1 },
    ),
    "onClick={() => setActiveTab('unified-url')}",
    "data-input-tab=\"file-upload\"\n            onClick={() => setActiveTab('unified-url')}",
  );
  assert.equal(
    countOccurrences(misplacedSemanticSelector, 'data-input-tab="file-upload"'),
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

test('installed URL media flow preserves A while staging B and commits only native success', () => {
  const assertReviewed = (
    inspector = INSTALLED_MEDIA_FLOW_INSPECTOR,
    inputMethods = INPUT_METHODS_SOURCE,
    buttons = BUTTONS_CONTAINER_SOURCE,
    handlers = DOWNLOAD_HANDLERS_SOURCE,
    adapter = NATIVE_URL_DOWNLOAD_ADAPTER_SOURCE,
  ) => assertInstalledMediaFlowInspector(
    inspector, inputMethods, buttons, handlers, adapter,
  );
  assert.doesNotThrow(() => assertReviewed());

  const replaceWithin = (source, startMarker, endMarker, search, replacement) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `missing scoped block ${startMarker}`);
    const block = source.slice(start, end);
    const changedBlock = weaken(block, search, replacement, { expected: 1 });
    return source.slice(0, start) + changedBlock + source.slice(end);
  };

  const scriptMutations = [
    [
      'staged URL wait replaced by a readiness wait',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        'evaluate(client, URL_STAGED_EXPRESSION)',
        'evaluate(client, URL_CONTROL_READY_EXPRESSION)',
      ),
    ],
    [
      'staged URL no longer proves its visible preview',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        "(previews[0].textContent ?? '').trim() === ${JSON.stringify(MEDIA_URL)}",
        'previews.length >= 0',
      ),
    ],
    [
      'staging writes the pending URL into active compatibility state',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        "    && (previews[0].textContent ?? '').trim() === ${JSON.stringify(MEDIA_URL)};",
        "    && (previews[0].textContent ?? '').trim() === ${JSON.stringify(MEDIA_URL)}\n"
          + "    && localStorage.getItem('current_video_url') === ${JSON.stringify(MEDIA_URL)};",
      ),
    ],
    [
      'active A snapshot removed before staging B',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        '    const activeState = options.priorAssetId === null\n'
          + '      ? null\n'
          + '      : await evaluate(client, MEDIA_RESULT_EXPRESSION);\n',
        '    const activeState = null;\n',
      ),
    ],
    [
      'A/B identity guard call removed',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        '      assertStagedReplacementPreservesActiveMedia(\n'
          + '        activeState, stagedState, options.priorAssetId,\n'
          + '      );\n',
        '',
      ),
    ],
    [
      'initial-only SRT upload widened to replacement',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        '    if (options.priorAssetId === null) {',
        '    if (true) {',
      ),
    ],
    [
      'staged active asset equality weakened',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        '  invariant(after?.assetId === before.assetId',
        '  invariant(typeof after?.assetId === \'string\'',
      ),
    ],
    [
      'staged playback capability equality weakened',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        '    && after?.currentFileUrl === before.currentFileUrl',
        '    && typeof after?.currentFileUrl === \'string\'',
      ),
    ],
    [
      'staged native session equality weakened',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        '    && after?.session?.media?.id === before.session.media.id',
        '    && typeof after?.session?.media?.id === \'string\'',
      ),
    ],
    [
      'staged subtitle ownership equality weakened',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        '    && after?.uploadedSrtInfo?.cacheId === before.uploadedSrtInfo.cacheId',
        '    && after?.uploadedSrtInfo !== null',
      ),
    ],
    [
      'SRT readiness accepts an unowned cache id',
      replaceWithin(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        'const SRT_READY_EXPRESSION = (preferences, expectedCacheId) => `',
        'const START_EXPRESSION = (preferences, expectedCacheId) => `',
        '    && info.cacheId === ${JSON.stringify(expectedCacheId)}',
        '    && info.cacheId === null',
      ),
    ],
    [
      'start accepts an unowned SRT cache id',
      replaceWithin(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        'const START_EXPRESSION = (preferences, expectedCacheId) => `',
        'export const MEDIA_RESULT_EXPRESSION = `',
        '      || info.cacheId !== ${JSON.stringify(expectedCacheId)}',
        '      || false',
      ),
    ],
    [
      'native SRT file selection removed',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        "      await client.send('DOM.setFileInputFiles', {\n"
          + '        files: [options.srt], nodeId: inputs.nodeIds[0],\n'
          + '      });\n',
        '',
      ),
    ],
    [
      'real customer action double-clicked',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        '  buttons[0].click();\n  return true;',
        '  buttons[0].click();\n  buttons[0].click();\n  return true;',
      ),
    ],
    [
      'URL-stage timeout mislabeled',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        "{ timeoutMs: 60_000, failureCode: 'url-stage-timeout' }",
        "{ timeoutMs: 60_000, failureCode: 'terminal-state-timeout' }",
      ),
    ],
    [
      'timeout category allow-list bypassed',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        'REVIEWED_TIMEOUT_FAILURE_CODES.includes(failureCode)',
        "typeof failureCode === 'string'",
      ),
    ],
  ];
  for (const [description, mutation] of scriptMutations) {
    assert.notEqual(mutation, INSTALLED_MEDIA_FLOW_INSPECTOR, description);
    assert.throws(() => assertReviewed(mutation), /Installed media-flow inspector must/, description);
  }

  for (const [description, mutation] of [
    [
      'both phases collapse to one adapter preference',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        "return Object.freeze({ autoImport: 'false', preferredLanguages: '[\"en\"]' });",
        "return Object.freeze({ autoImport: 'true', preferredLanguages: '[\"en\"]' });",
      ),
    ],
    [
      'phase and prior identity are decoupled',
      weaken(
        INSTALLED_MEDIA_FLOW_INSPECTOR,
        "  invariant((mediaPhase === 'initial' && priorAssetId === null)\n"
          + "    || (mediaPhase === 'reactivation' && priorAssetId !== null),\n"
          + "  'Installed media-flow phase and prior asset are inconsistent');\n",
        '',
      ),
    ],
  ]) {
    assert.notEqual(mutation, INSTALLED_MEDIA_FLOW_INSPECTOR, description);
    assert.throws(() => assertReviewed(mutation), /distinct reviewed adapter preferences/, description);
  }

  const missingUrlSelector = weaken(
    INPUT_METHODS_SOURCE,
    '\n            data-input-tab="unified-url"',
    '',
  );
  assert.throws(
    () => assertReviewed(INSTALLED_MEDIA_FLOW_INSPECTOR, missingUrlSelector),
    /unique URL selector/,
  );

  const weakenedHandler = weaken(
    DOWNLOAD_HANDLERS_SOURCE,
    "if (localStorage.getItem('auto_import_site_subtitles') !== 'false')",
    "if (localStorage.getItem('auto_import_site_subtitles') === 'false')",
  );
  assert.throws(
    () => assertReviewed(
      INSTALLED_MEDIA_FLOW_INSPECTOR,
      INPUT_METHODS_SOURCE,
      BUTTONS_CONTAINER_SOURCE,
      weakenedHandler,
    ),
    /distinct reviewed native adapter keys/,
  );

  const weakenedAdapter = weaken(
    NATIVE_URL_DOWNLOAD_ADAPTER_SOURCE,
    'const key = operationKey(normalizedUrl, cookieSource, preferredLanguages);',
    'const key = operationKey(url, cookieSource, preferredLanguages);',
  );
  assert.throws(
    () => assertReviewed(
      INSTALLED_MEDIA_FLOW_INSPECTOR,
      INPUT_METHODS_SOURCE,
      BUTTONS_CONTAINER_SOURCE,
      DOWNLOAD_HANDLERS_SOURCE,
      weakenedAdapter,
    ),
    /distinct reviewed native adapter keys/,
  );
});
test('installed native-tool inspector uses exact UI removal and hot reinstall proof', () => {
  assert.doesNotThrow(() => assertInstalledNativeToolsInspector(INSTALLED_NATIVE_TOOLS_INSPECTOR));
  const mutations = [
    weaken(INSTALLED_NATIVE_TOOLS_INSPECTOR,
      "document.querySelector('[data-app-action=\"open-settings\"]')",
      "document.querySelector('.settings-button')",
    ),
    weaken(INSTALLED_NATIVE_TOOLS_INSPECTOR,
      "buttons.forEach((button) => button.click());",
      '// removed real UI clicks',
    ),
    weaken(INSTALLED_NATIVE_TOOLS_INSPECTOR,
      "window.__TAURI_INTERNALS__?.invoke('native_tools_status')",
      "window.__TAURI_INTERNALS__?.invoke('native_tool_remove')",
    ),
    weaken(INSTALLED_NATIVE_TOOLS_INSPECTOR,
      "value.download.reason === 'downloaderUnavailable'",
      'value.download.reason !== null',
    ),
    weaken(INSTALLED_NATIVE_TOOLS_INSPECTOR,
      'tool.activeRuntime === true',
      'tool.activeRuntime !== null',
    ),
    weaken(INSTALLED_NATIVE_TOOLS_INSPECTOR,
      'new Set(jobIds).size === TOOL_IDS.length',
      'jobIds.length === TOOL_IDS.length',
    ),
    weaken(INSTALLED_NATIVE_TOOLS_INSPECTOR,
      "fs.writeFileSync(destination, bytes, { flag: 'wx' })",
      'fs.writeFileSync(destination, bytes)',
    ),
    weaken(INSTALLED_NATIVE_TOOLS_INSPECTOR,
      'evaluate(client, CLOSE_SETTINGS_EXPRESSION)',
      'Promise.resolve(true)',
    ),
    weaken(INSTALLED_NATIVE_TOOLS_INSPECTOR,
      "document.querySelector('[data-settings-tab=\\\"tools\\\"]') === null",
      'true',
    ),
    weaken(INSTALLED_NATIVE_TOOLS_INSPECTOR,
      'Number.isSafeInteger(value.pipeline.durationUs)',
      'Number.isFinite(Number(value.pipeline.durationUs))',
    ),
    weaken(INSTALLED_NATIVE_TOOLS_INSPECTOR,
      'Number.isFinite(value.pipeline.frameRate)',
      'value.pipeline.frameRate != null',
    ),
    weaken(INSTALLED_NATIVE_TOOLS_INSPECTOR,
      "    await waitForDom(client, 'missing');",
      "    await waitForDom(client, 'missing');\n"
        + "    assertClickedActions(await evaluate(client, clickToolActionsExpression('install')), 'install');",
    ),
    weakenAll(INSTALLED_NATIVE_TOOLS_INSPECTOR,
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
  assert.doesNotThrow(() => assertTauriNsisBootstrapScript(toCrlf(TAURI_NSIS_BOOTSTRAP_SCRIPT)));
  for (const [label, bootstrap, newline] of [
    ['LF', TAURI_NSIS_BOOTSTRAP_SCRIPT, LF],
    ['CRLF', toCrlf(TAURI_NSIS_BOOTSTRAP_SCRIPT), CRLF],
  ]) {
    const preferenceBoundary = `$ErrorActionPreference = 'Stop'${newline}`;
    for (const earlyTermination of ['return', 'exit 0']) {
      const weakened = weaken(bootstrap,
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
    const deadMiddleWrapper = weaken(
      weaken(bootstrap, bodyBoundary, `function Invoke-DeadBootstrap {${newline}${bodyBoundary}`),
      successBoundary,
      `}${newline}${successBoundary}`,
    );
    assert.throws(
      () => assertTauriNsisBootstrapScript(deadMiddleWrapper),
      /exact reviewed executable source/,
      `${label} bootstrap must reject reviewed operations hidden in a dead function`,
    );
  }
  const curlResolutionVariants = [
    [
      'PATH-selected first of multiple curl commands',
      weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
        "$curlPath = [IO.Path]::GetFullPath((Join-Path $windowsSystemDirectory 'curl.exe'))",
        "$curlPath = @(Get-Command 'curl.exe' -CommandType Application -All)[0].Source",
      ),
    ],
    [
      'fallback command discovery after a missing system curl',
      weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
        "  throw 'The reviewed Windows system curl executable is missing or not a leaf file'",
        "  $curlPath = (Get-Command 'curl.exe' -CommandType Application).Source",
      ),
    ],
    [
      'non-leaf system curl',
      weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT, '-PathType Leaf', '-PathType Any'),
    ],
    [
      'unreviewed curl filesystem type',
      weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT, '$curlItem -isnot [IO.FileInfo]', '$false'),
    ],
    [
      'reparse-point system curl',
      weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
        '($curlItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0',
        '$false',
      ),
    ],
    [
      'PATH-order invocation',
      weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT, '& $curlPath `', '& curl.exe `'),
    ],
    [
      'non-system special folder',
      weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
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
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      "if ($desktopPackage.devDependencies.'@tauri-apps/cli' -cne '2.11.4') {",
      'if ($false) {',
    ),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip',
      'https://evil.example/nsis-3.11.zip',
    ),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      "    Url = 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip'",
      "    Url = 'https://evil.example/nsis-3.11.zip'",
    ) + "\n#    Url = 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip'\n",
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1',
      '0'.repeat(64),
    ),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT, 'Size = 2361546L', 'Size = 1L'),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT, "--proto-redir '=https'", "--proto-redir '=all'"),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      "    --proto-redir '=https' `",
      "    --proto-redir '=all' `",
    ) + "\n#    --proto-redir '=https' `\n",
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT, '--retry 4', '--retry 0'),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT, '--retry-all-errors', '--retry-connrefused'),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT, '--retry-max-time 120', '--retry-max-time 1200'),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT, '--max-time 180', '--max-time 1800'),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      'Assert-PinnedFile -Path $Destination -Artifact $Artifact',
      '# response verification removed',
    ),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      '  Assert-PinnedFile -Path $Destination -Artifact $Artifact',
      '  return',
    ) + '\n#  Assert-PinnedFile -Path $Destination -Artifact $Artifact\n',
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      '  Assert-PinnedFile -Path $Destination -Artifact $Artifact',
      '  return\n<#\n  Assert-PinnedFile -Path $Destination -Artifact $Artifact\n#>',
    ),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      "$nsisRoot = Join-Path $CacheRoot 'NSIS'",
      "$nsisRoot = Join-Path $CacheRoot 'unreviewed'",
    ),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      "$nsisRoot = Join-Path $CacheRoot 'NSIS'",
      "$nsisRoot = Join-Path $CacheRoot 'unreviewed'",
    ) + "\n# $nsisRoot = Join-Path $CacheRoot 'NSIS'\n",
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      "throw 'Refusing to use a non-directory or reparse-point NSIS bootstrap root'",
      'return',
    ),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      "Copy-Item -LiteralPath $tauriPlugin -Destination (Join-Path $pluginDirectory 'nsis_tauri_utils.dll')",
      '# plugin injection removed',
    ),
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT,
      "  Copy-Item -LiteralPath $tauriPlugin -Destination (Join-Path $pluginDirectory 'nsis_tauri_utils.dll')",
      '  return',
    ) + "\n#  Copy-Item -LiteralPath $tauriPlugin -Destination (Join-Path $pluginDirectory 'nsis_tauri_utils.dll')\n",
    weaken(TAURI_NSIS_BOOTSTRAP_SCRIPT, "'Include\\Win\\RestartManager.nsh'", "'Include\\unreviewed.nsh'"),
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
    'id: updater_versions',
    'node scripts/derive-updater-smoke-version.js --github-output $env:GITHUB_OUTPUT',
    '${{ steps.updater_versions.outputs.base }}',
    '${{ steps.updater_versions.outputs.updated }}',
    './scripts/prepare-tauri-nsis.ps1',
    './scripts/test-signed-updater-windows.ps1',
    "url = 'https://localhost:38443/update.exe'",
    '${{ runner.temp }}/osg-updater-diagnostics.log',
  ]) {
    assert.throws(
      () => assertUpdaterSmokeWorkflow(weaken(UPDATER_SMOKE_WORKFLOW, fragment, 'removed')),
      /Signed updater smoke/,
    );
  }
  assert.throws(() => assertUpdaterSmokeWorkflow(
    weaken(UPDATER_SMOKE_WORKFLOW, 'workflow_dispatch:', 'pull_request_target:'),
  ), /workflow_dispatch/);
  assert.throws(() => assertUpdaterSmokeWorkflow(
    `${UPDATER_SMOKE_WORKFLOW}\n# \${{ secrets.UNREVIEWED_SECRET }}\n`,
  ), /two reviewed updater signing secrets/);
  assert.throws(() => assertUpdaterSmokeWorkflow(
    weaken(UPDATER_SMOKE_WORKFLOW,
      '  workflow_dispatch:\n  workflow_call:',
      '  workflow_dispatch:\n    inputs:\n      version:\n        required: true\n  workflow_call:',
    ),
  ), /input-free/);
  assert.throws(() => assertUpdaterSmokeWorkflow(
    weaken(UPDATER_SMOKE_WORKFLOW,
      'version = $env:OSG_UPDATER_UPDATED_VERSION',
      "version = '1.0.1'",
    ),
  ), /immutable derived versions/);
  assert.throws(() => assertUpdaterSmokeWorkflow(
    weaken(UPDATER_SMOKE_WORKFLOW,
      'OSG_UPDATER_UPDATED_VERSION: ${{ steps.updater_versions.outputs.updated }}',
      'OSG_UPDATER_UPDATED_VERSION: ${{ steps.updater_versions.outputs.base }}',
    ),
  ), /immutable derived versions/);
  assert.throws(() => assertUpdaterSmokeWorkflow(
    weaken(UPDATER_SMOKE_WORKFLOW,
      'run: node scripts/derive-updater-smoke-version.js --github-output $env:GITHUB_OUTPUT',
      'run: node scripts/derive-updater-smoke-version.js --github-output $env:GITHUB_ENV',
    ),
  ), /(?:missing required boundary|immutable repository version contract)/);
  for (const argument of [
    '-CacheRoot C:\\unreviewed',
    '-ScratchRoot C:\\unreviewed',
  ]) {
    assert.throws(
      () => assertUpdaterSmokeWorkflow(weaken(UPDATER_SMOKE_WORKFLOW,
        'run: ./scripts/prepare-tauri-nsis.ps1',
        `run: ./scripts/prepare-tauri-nsis.ps1 ${argument}`,
      )),
      /Signed updater smoke/,
      `signed updater must reject NSIS bootstrap argument ${argument}`,
    );
  }
  assert.throws(
    () => assertUpdaterSmokeWorkflow(weaken(UPDATER_SMOKE_WORKFLOW,
      'run: ./scripts/prepare-tauri-nsis.ps1',
      'run: |\n          Write-Host decoy\n          run: ./scripts/prepare-tauri-nsis.ps1',
    )),
    /Signed updater smoke/,
    'signed updater must reject an NSIS bootstrap command hidden in a YAML scalar',
  );
});

test('package scripts name inspector contracts honestly and exercise updater derivation', () => {
  const packageManifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8',
  ));
  assert.equal(packageManifest.scripts['test:installed-webview'], undefined);
  assert.match(
    packageManifest.scripts['test:installed-inspector-contracts'],
    /^node --test scripts\/inspect-installed-webview\.test\.mjs /,
  );
  assert.equal(
    packageManifest.scripts['test:updater-fixture'],
    'node --test scripts/derive-updater-smoke-version.test.js scripts/serve-updater-fixture.test.mjs scripts/inspect-installed-updater.test.mjs',
  );
});

test('updater fixture source remains compile-time isolated from production releases', () => {
  assert.doesNotThrow(() => assertUpdaterFixtureSource(path.join(__dirname, '..')));
  assert.doesNotThrow(() => assertDesktopCloseLifecycleSource(
    DESKTOP_SOURCE,
    APP_CLOSE_SOURCE,
    CARGO_LOCK_SOURCE,
  ));
  assert.doesNotThrow(() => assertCiUpdaterFixtureDebugPortSource(
    DESKTOP_SOURCE,
    CI_UPDATER_ARGUMENT_SOURCE,
    CARGO_LOCK_SOURCE,
  ));
  assert.doesNotThrow(() => assertCiUpdaterFixtureHandoffSource(UPDATER_SOURCE));
  for (const weakened of [
    weaken(UPDATER_SOURCE,
      '#[cfg(feature = "ci-updater-fixture")]\n    let webview_debug =',
      '    let webview_debug =',
    ),
    weaken(UPDATER_SOURCE,
      'webview_debug || crate::ci_updater_fixture::configuration().enables_webview_debugging()',
      'webview_debug && crate::ci_updater_fixture::configuration().enables_webview_debugging()',
    ),
    weaken(UPDATER_SOURCE,
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
    [weaken(DESKTOP_SOURCE,
      '#[cfg(feature = "ci-updater-fixture")]\nmod ci_updater_fixture;',
      'mod ci_updater_fixture;',
    ), CI_UPDATER_ARGUMENT_SOURCE],
    [DESKTOP_SOURCE, weaken(CI_UPDATER_ARGUMENT_SOURCE,
      '--osg-ci-updater-debug-port=',
      '--remote-debugging-port=',
    )],
    [DESKTOP_SOURCE, weaken(CI_UPDATER_ARGUMENT_SOURCE,
      'if arguments.len() != 1',
      'if arguments.len() > 2',
    )],
    [DESKTOP_SOURCE, weaken(CI_UPDATER_ARGUMENT_SOURCE,
      'if debug_port < 1024',
      'if debug_port < 1',
    )],
    [DESKTOP_SOURCE, weaken(CI_UPDATER_ARGUMENT_SOURCE,
      '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required',
      '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --enable-features=RemoveRedirectionBitmap --autoplay-policy=no-user-gesture-required',
    )],
    [DESKTOP_SOURCE, weaken(CI_UPDATER_ARGUMENT_SOURCE,
      'format!("{WEBVIEW2_DEFAULT_BROWSER_ARGUMENTS} --remote-debugging-port={port}")',
      'format!("{WEBVIEW2_DEFAULT_BROWSER_ARGUMENTS} --unreviewed --remote-debugging-port={port}")',
    )],
    [weaken(DESKTOP_SOURCE,
      'window_builder.additional_browser_args(&arguments)',
      'window_builder',
    ), CI_UPDATER_ARGUMENT_SOURCE],
  ]) {
    assert.throws(
      () => assertCiUpdaterFixtureDebugPortSource(desktop, fixture, CARGO_LOCK_SOURCE),
      /Updater fixture debug-port/,
    );
  }
  const driftedWryLock = weaken(CARGO_LOCK_SOURCE,
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
    weaken(DESKTOP_SOURCE,
      '        diagnostics::record("app.close_requested", &[]);',
      '        diagnostics::record("app.close_requested", &[]);\n        window.app_handle().exit(0);',
    ),
    weaken(DESKTOP_SOURCE,
      'window_label == "main" && close_requested',
      'close_requested',
    ),
    weaken(DESKTOP_SOURCE,
      'diagnostics::record("app.close_requested", &[]);',
      'diagnostics::record("app.close_requested", &[]);\n        diagnostics::record("app.close_requested", &[]);',
    ),
    weaken(DESKTOP_SOURCE,
      '        diagnostics::record("app.close_requested", &[]);',
      '        diagnostics::record("app.close_requested", &[]);\n        std::process::exit(0);',
    ),
    weaken(DESKTOP_SOURCE,
      '        diagnostics::record("app.close_requested", &[]);',
      '        diagnostics::record("app.close_requested", &[]);\n        std::process::abort();',
    ),
    weaken(DESKTOP_SOURCE,
      '        diagnostics::record("app.close_requested", &[]);',
      '        diagnostics::record("app.close_requested", &[]);\n        window.close().unwrap();',
    ),
    weaken(DESKTOP_SOURCE,
      '        diagnostics::record("app.close_requested", &[]);',
      '        diagnostics::record("app.close_requested", &[]);\n        window.destroy().unwrap();',
    ),
    weaken(DESKTOP_SOURCE,
      '        diagnostics::record("app.close_requested", &[]);',
      '        diagnostics::record("app.close_requested", &[]);\n        if let WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); }',
    ),
  ]) {
    assert.throws(
      () => assertDesktopCloseLifecycleSource(
        weakenedDesktop,
        APP_CLOSE_SOURCE,
        CARGO_LOCK_SOURCE,
      ),
      /Desktop close handler/,
    );
  }
  assert.throws(
    () => assertDesktopCloseLifecycleSource(
      DESKTOP_SOURCE,
      weaken(APP_CLOSE_SOURCE, 'state.cancel_commit(nonce);', 'let _ = nonce;'),
      CARGO_LOCK_SOURCE,
    ),
    /exact reviewed one-shot state machine/,
  );
  const driftedRuntimeLock = weaken(CARGO_LOCK_SOURCE,
    /(\[\[package]]\r?\nname = "tauri-runtime-wry"\r?\nversion = )"2\.11\.4"/,
    '$1"2.11.5"',
  );
  assert.notEqual(
    driftedRuntimeLock,
    CARGO_LOCK_SOURCE,
    'Tauri runtime lock mutation must alter Cargo.lock',
  );
  assert.throws(
    () => assertDesktopCloseLifecycleSource(
      DESKTOP_SOURCE,
      APP_CLOSE_SOURCE,
      driftedRuntimeLock,
    ),
    /reviewed tauri-runtime-wry 2\.11\.4 registry package/,
  );
});

test('signed updater runner uses isolated HTTPS, the real toast, NSIS relaunch, and durable state', () => {
  assert.doesNotThrow(() => assertSignedUpdaterScript(SIGNED_UPDATER_SCRIPT));
  assert.doesNotThrow(() => assertSignedUpdaterScript(toCrlf(SIGNED_UPDATER_SCRIPT)));
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      "  '--assert-contract' `",
      "  '--unchecked-contract' `",
    )),
    /(?:missing lifecycle proof|repository-derived increasing version contract)/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      "            -and [string]$_.webviewDebug -ceq 'present' `",
      "            -and [string]$_.webviewDebug -in @('present', 'absent') `",
    )),
    /confirms the preserved CI debug-port hook/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      "            -and [string]$_.webviewDebug -ceq 'present' `\n",
      '',
    )),
    /confirms the preserved CI debug-port hook/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      "            -and [string]$_.webviewDebug -ceq 'present' `",
      "            -and [string]$_.webviewDebug -ceq 'absent' `",
    )),
    /confirms the preserved CI debug-port hook/,
  );
  for (const weakened of [
    weaken(SIGNED_UPDATER_SCRIPT,
      '$Port -lt 1024 -or $Port -gt 65535',
      '$Port -lt 1 -or $Port -gt 65535',
    ),
    weaken(SIGNED_UPDATER_SCRIPT,
      '"--osg-ci-updater-debug-port=$Port"',
      '"--remote-debugging-port=$Port"',
    ),
    weaken(SIGNED_UPDATER_SCRIPT,
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
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      '            -and $_.version -ceq $ExpectedVersion `',
      '            -and $true `',
    )),
    /one new versioned UUIDv7 identity/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      '        $boundedRecord = ConvertTo-BoundedDiagnosticEvidenceRecord -Entry $_',
      '        $boundedRecord = $_',
    )),
    /bounded sanitized lifecycle evidence/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      "        [string]$_.event -like 'app-update.*' `",
      "        ($_.version -eq $UpdatedVersion) -and [string]$_.event -like 'app-update.*' `",
    )),
    /including unknown relaunch candidates/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      'if ([Text.Encoding]::UTF8.GetByteCount($encoded) -gt $script:diagnosticEvidenceByteLimit) {',
      'if ($false) {',
    )),
    /bounded sanitized lifecycle evidence/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      '$updatedProcessPath.Equals($executable, [StringComparison]::OrdinalIgnoreCase)',
      '$true',
    )),
    /exact installed executable path/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      "Invoke-UpdaterFinalizationStep -Name 'diagnostic-evidence' -Action {",
      '& {',
    )),
    /guarded cleanup step/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      "Invoke-UpdaterFinalizationStep -Name 'fixture-server' -Action {",
      '& {',
    )),
    /every guarded cleanup step/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
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
  const reversedFailures = weaken(
    weaken(
      weaken(SIGNED_UPDATER_SCRIPT, primaryRethrow, '__OSG_PRIMARY_RETHROW__', { expected: 1 }),
      finalizationRethrow,
      primaryRethrow,
      { expected: 1 },
    ),
    '__OSG_PRIMARY_RETHROW__',
    finalizationRethrow,
    { expected: 1 },
  );
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
      () => assertSignedUpdaterScript(weakenAll(SIGNED_UPDATER_SCRIPT, fragment, 'removed')),
      /Signed updater runner/,
    );
  }
  const delayedQueryHandle = weaken(
    weaken(SIGNED_UPDATER_SCRIPT, '    $processQueryHandle = $Process.Handle\n', ''),
    '  $closeAccepted = $Process.CloseMainWindow()\n',
    '  $closeAccepted = $Process.CloseMainWindow()\n    $processQueryHandle = $Process.Handle\n',
  );
  assert.throws(
    () => assertSignedUpdaterScript(delayedQueryHandle),
    /Signed updater runner/,
    'signed updater must open the rediscovered process query handle before requesting close',
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      "        -and $pageLoadEvents -ge 1 `\n",
      '',
    )),
    /diagnostic readiness, and a responsive idle window/,
  );
  const readyPhase = "Write-SmokePhase -Name 'updated-application-ready'";
  const frontendReady = "Write-SmokePhase -Name 'updated-frontend-ready'";
  const gracefulClose = '$updatedClose = Stop-Gracefully';
  const reorderedClose = weaken(
    weaken(
      weaken(SIGNED_UPDATER_SCRIPT, frontendReady, '__OSG_FRONTEND_READY__', { expected: 1 }),
      gracefulClose,
      frontendReady,
      { expected: 1 },
    ),
    '__OSG_FRONTEND_READY__',
    gracefulClose,
    { expected: 1 },
  );
  assert.throws(
    () => assertSignedUpdaterScript(reorderedClose),
    /exact frontend/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
      'if (-not $closeAccepted) {',
      'if ($false) {',
    )),
    /separate native close acceptance/,
  );
  assert.throws(
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
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
    () => assertSignedUpdaterScript(weaken(SIGNED_UPDATER_SCRIPT,
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
      () => assertPinnedActions(weaken(workflow, pin, 'v0')),
      /full commit SHA/,
    );
    assert.throws(
      () => assertPinnedActions(weaken(workflow, pin, '0'.repeat(40))),
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
  // The real-binary test harness has its own manifest, so the pinned set is three.
  writeFile(root, 'e2e/package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
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
    () => assertWorkflowMatrix(weaken(workflow, 'macos-15-intel', 'macos-latest')),
    /mutable \*-latest aliases/,
  );
});

test('workflow is unsigned, read-only, credentialless, and locked', () => {
  const workflow = readMutableSource(__dirname, '..', '.github/workflows/rewrite-ci.yml');
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
      weaken(uploadStep, 'if: always()', 'if: success()'),
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
    () => assertWorkflowCommands(weaken(workflow, 'contents: read', 'contents: write')),
    /permissions must remain contents: read only/,
  );
  assert.throws(
    () => assertWorkflowCommands(weaken(workflow, 'persist-credentials: false', 'persist-credentials: true')),
    /Every checkout step must disable persisted Git credentials/,
  );
  assert.throws(
    () => assertWorkflowCommands(transformWorkflowJob(
      workflow,
      'native-matrix',
      (job) => weaken(job, "if: github.event_name == 'workflow_dispatch'", 'if: always()'),
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
    return weaken(job, buildLine, '') + `\n${buildLine}`;
  });
  assert.throws(
    () => assertWorkflowCommands(frontendBuiltTooLate),
    /native-matrix must build frontendDist before compiling the Tauri Rust workspace/,
  );
  assert.throws(
    () => assertWorkflowCommands(weaken(workflow,
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
      () => assertWorkflowCommands(weaken(workflow, gate, 'gate intentionally removed')),
      /workflow is missing required locked gate/,
    );
  }
  const nativeWithoutFrontendBuild = transformWorkflowJob(
    workflow,
    'native-matrix',
    (job) => weaken(job, 'npm run build:frontend', 'frontend build intentionally removed'),
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
  endpoint = 'https://example.invalid/releases/latest/download/osg-desktop-updater-v2.json',
  permission = 'check-for-updates',
  publicKey = null,
  updaterOverrides = {},
  windowsOverrides = {},
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
      plugins: {
        updater: {
          endpoints: [endpoint],
          pubkey: '',
          windows: { installMode: 'passive', ...windowsOverrides },
          ...updaterOverrides,
        },
      },
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
  const transportAndInstallCases = [
    [
      createUpdaterFixture({ updaterOverrides: { dangerousInsecureTransportProtocol: true } }),
      /never allow insecure transport/,
    ],
    [
      createUpdaterFixture({ updaterOverrides: { dangerousAcceptInvalidCerts: true } }),
      /never accept invalid TLS certificates/,
    ],
    [
      createUpdaterFixture({ updaterOverrides: { dangerousAcceptInvalidHostnames: true } }),
      /never accept invalid TLS hostnames/,
    ],
    [
      createUpdaterFixture({ updaterOverrides: { proxy: 'http://proxy.invalid' } }),
      /updater declares unreviewed keys: proxy/,
    ],
    [
      createUpdaterFixture({ windowsOverrides: { installMode: 'quiet' } }),
      /windows\.installMode must stay passive/,
    ],
    [
      createUpdaterFixture({ windowsOverrides: { installerArgs: ['/SILENT'] } }),
      /windows\.installerArgs must stay empty/,
    ],
    [
      createUpdaterFixture({ windowsOverrides: { installerHooks: 'hook.ps1' } }),
      /windows declares unreviewed keys: installerHooks/,
    ],
  ];
  context.after(() => {
    for (const root of [
      validRoot,
      placeholderRoot,
      insecureRoot,
      guestRoot,
      ...transportAndInstallCases.map(([root]) => root),
    ]) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  assert.doesNotThrow(() => assertUpdaterReleaseConfiguration(validRoot));
  assert.throws(() => assertUpdaterReleaseConfiguration(placeholderRoot), /still a placeholder/);
  assert.throws(() => assertUpdaterReleaseConfiguration(insecureRoot), /must use HTTPS/);
  assert.throws(() => assertUpdaterReleaseConfiguration(guestRoot), /must not grant updater guest permissions/);
  for (const [root, expected] of transportAndInstallCases) {
    assert.throws(() => assertUpdaterReleaseConfiguration(root), expected);
  }
});

test('signed updater release gate pins the shipped transport and Windows install invariants', () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'desktop', 'src-tauri', 'tauri.conf.json'),
    'utf8',
  ));
  const updater = config.plugins.updater;
  assert.deepEqual(Object.keys(updater).sort(), ['endpoints', 'pubkey', 'windows']);
  assert.deepEqual(updater.windows, { installMode: 'passive' });
  assert.doesNotThrow(() => assertUpdaterReleaseConfiguration(path.resolve(__dirname, '..')));
});

test('Tauri production build contract embeds the frontend instead of retaining the dev URL', (context) => {
  const root = createTauriProductionBuildFixture();
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));

  assert.doesNotThrow(() => assertTauriProductionBuildContract(root));
});

test('Tauri production build contract rejects dev-server releases and weakened native picker boundaries', (context) => {
  const fixtures = Array.from({ length: 13 }, createTauriProductionBuildFixture);
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
    detachedSelectMedia,
    duplicatePicker,
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

  const unpinnedCargo = weaken(
    readMutableSource(rfdPin, 'apps/desktop/src-tauri/Cargo.toml'),
    'version = "=0.16.0"',
    'version = "0.16.0"',
    { expected: 1 },
  );
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

  const unloggedSource = weaken(
    readMutableSource(unloggedPicker, 'apps/desktop/src-tauri/src/commands.rs'),
    '  diagnostics::record("media-picker.requested", &[]);\n',
    '',
    { expected: 1 },
  );
  writeFile(unloggedPicker, 'apps/desktop/src-tauri/src/commands.rs', unloggedSource);
  assert.throws(
    () => assertTauriProductionBuildContract(unloggedPicker),
    /must run its parented picker on the blocking pool/,
  );

  const unpooledSource = weaken(
    readMutableSource(unpooledPicker, 'apps/desktop/src-tauri/src/dialog_paths.rs'),
    'tauri::async_runtime::spawn_blocking',
    'tauri::async_runtime::spawn',
    { expected: 1 },
  );
  writeFile(unpooledPicker, 'apps/desktop/src-tauri/src/dialog_paths.rs', unpooledSource);
  assert.throws(
    () => assertTauriProductionBuildContract(unpooledPicker),
    /must run its parented picker on the blocking pool/,
  );

  const unstartedSource = weaken(
    readMutableSource(unstartedWorker, 'apps/desktop/src-tauri/src/dialog_paths.rs'),
    '  staged_media_selection().map(Some)\n',
    '  Ok(None)\n',
    { expected: 1 },
  );
  writeFile(unstartedWorker, 'apps/desktop/src-tauri/src/dialog_paths.rs', unstartedSource);
  assert.throws(
    () => assertTauriProductionBuildContract(unstartedWorker),
    /must run its parented picker on the blocking pool/,
  );

  const pluginBridgeSource = weaken(
    readMutableSource(pluginBridge, 'apps/desktop/src-tauri/src/dialog_paths.rs'),
    'dialog.pick_file()',
    'dialog.blocking_pick_file()',
    { expected: 1 },
  );
  writeFile(pluginBridge, 'apps/desktop/src-tauri/src/dialog_paths.rs', pluginBridgeSource);
  assert.throws(
    () => assertTauriProductionBuildContract(pluginBridge),
    /must run its parented picker on the blocking pool/,
  );

  const unloggedFailureSource = weaken(
    readMutableSource(unloggedWorkerFailure, 'apps/desktop/src-tauri/src/commands.rs'),
    '  diagnostics::record("media-picker.returned", &[("outcome", media_picker_outcome(selected.as_ref()))]);\n',
    '',
    { expected: 1 },
  );
  writeFile(
    unloggedWorkerFailure,
    'apps/desktop/src-tauri/src/commands.rs',
    unloggedFailureSource,
  );
  assert.throws(
    () => assertTauriProductionBuildContract(unloggedWorkerFailure),
    /must run its parented picker on the blocking pool/,
  );

  // select_media must keep delegating to the one reviewed picker helper.
  const detachedSource = weaken(
    readMutableSource(detachedSelectMedia, 'apps/desktop/src-tauri/src/commands.rs'),
    'pick_media_path(window).await?',
    'pick_media_path_unparented().await?',
    { expected: 1 },
  );
  writeFile(detachedSelectMedia, 'apps/desktop/src-tauri/src/commands.rs', detachedSource);
  assert.throws(
    () => assertTauriProductionBuildContract(detachedSelectMedia),
    /must run its parented picker on the blocking pool/,
  );

  // A second dialog anywhere in commands.rs could bypass the reviewed picker entirely.
  const duplicateSource = `${fs.readFileSync(
    path.join(duplicatePicker, 'apps/desktop/src-tauri/src/commands.rs'), 'utf8',
  )}\nasync fn extra_picker() -> Option<std::path::PathBuf> {\n`
    + '    rfd::FileDialog::new().pick_file()\n}\n';
  writeFile(duplicatePicker, 'apps/desktop/src-tauri/src/commands.rs', duplicateSource);
  assert.throws(
    () => assertTauriProductionBuildContract(duplicatePicker),
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
        // Two, not three: the legacy renderer's delivery catalog is gone, so a target that cannot
        // run the native renderer's tools is blocked by the tool delivery and the engine delivery
        // only. The token itself is not spelled here — the residue rule scans this directory.
        assert.match(error.message, /Runtime package has 2 blocking violation\(s\)/);
        assert.match(error.message, /FFmpeg\/ffprobe delivery is unavailable/);
        assert.match(error.message, /Managed engine delivery/);
        assert.doesNotMatch(error.message, /updater public key is still a placeholder/i);
        assert.doesNotMatch(error.message, /Repository licensing\/notice policy is unresolved/);
        assert.doesNotMatch(error.message, /bundle pinned|yt-dlp\.exe|deno\.exe/);
        return true;
      },
    );
  }
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
