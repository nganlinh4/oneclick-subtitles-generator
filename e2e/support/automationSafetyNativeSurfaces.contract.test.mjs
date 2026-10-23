// Native surfaces: no fullscreen/window/app actions, the compiled automation boundary, managed
// staging, and hidden owned processes.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  E2E_ROOT, journeySources, read, readSplitModule, sourceFilesBelow,
} from './repositorySources.js';

const MANAGED_STAGING_ENVIRONMENT = Object.freeze([
  'OSG_E2E_CACHE_ROOT',
  'OSG_E2E_CACHE_ROOT_ID',
  'OSG_E2E_STAGING_ROOT',
  'OSG_E2E_STAGING_LEASE_ID',
  'OSG_E2E_STAGING_LEASE_OWNER_PID',
  'OSG_E2E_STAGING_LEASE_OWNER_CREATED_UTC',
  'OSG_E2E_RUN_ROOT_AUTHORIZATION',
]);

const assertManagedStagingNativeContract = (source) => {
  for (const variable of MANAGED_STAGING_ENVIRONMENT) {
    assert.ok(source.includes(`"${variable}"`), `native guard does not require ${variable}`);
  }
  for (const marker of [
    '.osg-development-cache.json',
    '.osg-cache-entry.json',
    '.osg-cache-lease',
    '.osg-e2e-staging-parent',
    '.osg-e2e-staging-authority.json',
    '.osg-e2e-authority',
  ]) {
    assert.ok(source.includes(marker), `native guard does not validate ${marker}`);
  }
  assert.ok(source.includes('data root is not one ordinary direct child of the managed staging lane'));
  assert.ok(source.includes('the isolated run does not match its exact active managed staging lease'));
  assert.ok(source.includes('verify_live_process_creation_identity('));
  assert.ok(source.includes('managed staging lease owner PID was reused'));
  assert.ok(source.includes('Duration::from_secs(5)'));
  assert.doesNotMatch(source, /validate_harness_environment\([\s\S]*?std::env::temp_dir\(\)/u);
};
test('no unattended journey can activate fullscreen, move a native window, or open another app', () => {
  const forbidden = [
    /requestFullscreen\s*\(/u,
    /webkitRequestFullScreen\s*\(/u,
    /webkitRequestFullscreen\s*\(/u,
    /mozRequestFullScreen\s*\(/u,
    /msRequestFullscreen\s*\(/u,
    /fullscreenWindow\s*\(/u,
    /maximizeWindow\s*\(/u,
    /minimizeWindow\s*\(/u,
    /setWindowRect\s*\(/u,
    /setWindowPosition\s*\(/u,
    /setWindowSize\s*\(/u,
    /showOpenFilePicker\s*\(/u,
    /showSaveFilePicker\s*\(/u,
    /showDirectoryPicker\s*\(/u,
    /showPicker\s*\(/u,
    /window\.open\s*\(/u,
    /openExternal\s*\(/u,
    /input\s*\[\s*type\s*=\s*['"]?file/iu,
    /\.hidden-file-input\b/u,
  ];
  for (const { name, source } of journeySources()) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${name} contains unattended native-surface action ${pattern}`);
    }
  }

  const fullscreenJourney = read('e2e', 'journeys', 'mainPreviewControlsAndFullscreen.journey.js');
  assert.match(fullscreenJourney, /executed:\s*false/u);
  assert.match(fullscreenJourney, /assert\.equal\(state\.fullscreen\.active,\s*false/u);
});

test('the compiled automation boundary owns dialogs, off-screen placement, and isolated data', () => {
  const dialogPaths = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'dialog_paths.rs');
  const automationWindow = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'automation_window.rs');
  const application = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'lib.rs');
  const legacyImport = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'legacy_import.rs');
  const desktopState = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'state.rs');
  const externalLinks = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'external_links.rs');
  const providers = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'providers.rs');
  const download = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'download.rs');
  const downloadPlan = read('crates', 'osg-download', 'src', 'plan.rs');
  const updater = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'updater.rs');
  const isolatedRunner = read('e2e', 'run-isolated.mjs');
  const environment = readSplitModule('e2e', 'support', 'environment.js');
  const automationEnvironment = read('e2e', 'support', 'automationEnvironment.js');
  const capability = JSON.parse(read('apps', 'desktop', 'src-tauri', 'capabilities', 'main.json'));
  const productionConfig = read('apps', 'desktop', 'src-tauri', 'tauri.conf.json');

  assert.match(dialogPaths, /#\[cfg\(feature = "e2e-automation"\)\][\s\S]*?fn staged_media_selection/u);
  assert.match(dialogPaths, /automation_dialog_refused\(\)/u);
  assert.match(automationWindow, /window\s*\.set_focusable\(false\)/u);
  assert.match(automationWindow, /window\s*\.set_position\(/u);
  assert.match(automationWindow, /virtual_desktop_bounds/u);
  assert.match(automationWindow, /AUTOMATION_BROWSER_ARGUMENTS:\s*&str\s*=\s*"--mute-audio"/u);
  assert.match(automationWindow, /AUTOMATION_INTERACTION_GUARD_SCRIPT/u);
  assert.match(automationWindow, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/u);
  assertManagedStagingNativeContract(automationWindow);
  for (const variable of MANAGED_STAGING_ENVIRONMENT.slice(0, -1)) {
    assert.match(environment, new RegExp(`${variable}:`, 'u'));
  }
  const wdio = read('e2e', 'wdio.conf.js');
  const stagingAuthority = wdio.indexOf('managedStagingEnvironment(runRoot)');
  const driverBinding = wdio.indexOf('createGuardedWebDriverBinding({');
  assert.ok(stagingAuthority >= 0 && driverBinding > stagingAuthority);
  assert.match(
    automationWindow,
    /for child in \[\s*"data", "cache", "logs", "webview", "evidence", "input", "output",?\s*\]/u,
  );
  assert.match(automationWindow, /input\[type="file"\]/u);
  assert.match(automationWindow, /requestFullscreen/u);
  assert.doesNotMatch(productionConfig, /--mute-audio|OSG_E2E/u);
  assert.match(application, /#\[cfg\(not\(feature = "e2e-automation"\)\)\][\s\S]*?tauri_plugin_window_state/u);
  const runStart = application.indexOf('pub fn run() {');
  const preflight = application.indexOf('automation_window::require_harness_environment()', runStart);
  const ciFixture = application.indexOf('ci_updater_fixture::initialize_from_process_arguments()', runStart);
  const builder = application.indexOf('let builder = tauri::Builder::default()', runStart);
  assert.ok(runStart >= 0 && preflight > runStart && preflight < ciFixture && preflight < builder);
  assert.match(application, /let browser_arguments = Some\(automation_window::automation_browser_arguments\(\)\)/u);
  assert.doesNotMatch(
    automationWindow,
    /remote-debugging|append_automation_browser_arguments/u,
    'the automation browser argument set must be closed rather than extending ambient arguments',
  );
  assert.match(application, /initialization_script\(\s*automation_window::AUTOMATION_INTERACTION_GUARD_SCRIPT/u);
  assert.match(
    externalLinks,
    /#\[cfg\(feature = "e2e-automation"\)\][\s\S]*?The automation build refused to open another desktop application\./u,
  );
  assert.match(
    providers,
    /youtube_oauth_authorize[\s\S]*?#\[cfg\(feature = "e2e-automation"\)\][\s\S]*?The automation build refused to open another desktop application\./u,
  );
  assert.match(
    updater,
    /if cfg!\(any\(\s*feature = "unsigned-local-build",\s*feature = "e2e-automation"\s*\)\)[\s\S]*?UpdateChannelState::Disabled/u,
  );
  assert.match(isolatedRunner, /scrubAutomationEnvironment\(environment\)/u);
  assert.match(automationEnvironment, /!key\.startsWith\('WEBVIEW2_'\)/u);
  assert.match(automationEnvironment, /!key\.startsWith\('OSG_E2E_'\)/u);
  assert.match(environment, /export \{ scrubAutomationEnvironment \} from '.\/automationEnvironment\.js'/u);
  assert.deepEqual(
    capability.permissions.filter((permission) => permission.startsWith('core:window:')),
    ['core:window:allow-show'],
    'the WebView may reveal its already-isolated surface, but may not focus, move, maximize, or fullscreen it',
  );
  assert.deepEqual(
    capability.permissions.filter((permission) => /^(?:dialog|opener):/u.test(permission)),
    [],
    'the WebView must not call the native dialog or external-opener plugins directly',
  );
  for (const source of [
    read('crates', 'osg-asr', 'src', 'process.rs'),
    read('crates', 'osg-download', 'src', 'process.rs'),
    read('crates', 'osg-media', 'src', 'process.rs'),
    read('crates', 'osg-speech', 'src', 'session.rs'),
  ]) {
    assert.match(source, /const CREATE_NO_WINDOW:\s*u32\s*=\s*0x0800_0000/u);
    assert.match(source, /\.creation_flags\(CREATE_NO_WINDOW\)/u);
  }

  const automationAuthorityVariables = [
    '__WDIO_TAURI_APP_BINARY__',
    '__WDIO_TAURI_EMBEDDED__',
    'OSG_E2E_REUSE_ROOT',
    'OSG_E2E_CACHE_ROOT',
    'OSG_E2E_CACHE_ROOT_ID',
    'OSG_E2E_RUN_ROOT_AUTHORIZATION',
    'OSG_E2E_STAGING_LEASE_ID',
    'OSG_E2E_STAGING_LEASE_OWNER_CREATED_UTC',
    'OSG_E2E_STAGING_LEASE_OWNER_PID',
    'OSG_E2E_STAGING_ROOT',
    'OSG_E2E_WEBDRIVER_AUTHORIZATION',
    'OSG_E2E_WEBDRIVER_IDENTITY',
    'OSG_E2E_WEBDRIVER_RUN_ROOT',
    'REMOTE_WEBDRIVER_URL',
    'TAURI_WEBDRIVER_PORT',
    'WDIO_EMBEDDED_SERVER',
    'WDIO_WORKER_ID',
  ];
  const nativeChildLaunchers = [
    {
      label: 'downloader',
      source: read('crates', 'osg-download', 'src', 'process.rs'),
      construction: 'let mut command = Command::new(request.binary);',
      removal: 'remove_automation_authority_environment(&mut command);',
      spawn: 'let child = spawn_group(&mut command)?;',
      behaviorTest: 'fn downloader_process_drops_automation_authority()',
    },
    {
      label: 'media tool',
      source: read('crates', 'osg-media', 'src', 'process.rs'),
      construction: 'let mut command = Command::new(binary.path());',
      removal: 'remove_automation_authority_environment(&mut command);',
      spawn: 'let child = spawn_group(&mut command, tool)?;',
      behaviorTest: 'fn media_tool_process_drops_automation_authority()',
    },
    {
      label: 'speech worker',
      source: read('crates', 'osg-speech', 'src', 'worker.rs'),
      construction: 'let mut command = Command::new(native_process_path(self.program.executable())?);',
      removal: 'remove_automation_authority_environment(&mut command);',
      spawn: 'let child = spawn_group(&mut command)?;',
      behaviorTest: 'fn speech_worker_drops_automation_authority()',
    },
  ];
  for (const launcher of nativeChildLaunchers) {
    for (const variable of automationAuthorityVariables) {
      assert.match(
        launcher.source,
        new RegExp(`"${variable}"`, 'u'),
        `${launcher.label} does not remove ${variable}`,
      );
    }
    const construction = launcher.source.indexOf(launcher.construction);
    const removal = launcher.source.indexOf(launcher.removal, construction);
    const spawn = launcher.source.indexOf(launcher.spawn, removal);
    assert.ok(
      construction >= 0 && removal > construction && spawn > removal,
      `${launcher.label} must drop automation authority before its native process can spawn`,
    );
    assert.ok(
      launcher.source.includes(launcher.behaviorTest)
        && /command\s*\.get_envs\(\)\s*\.any\(\|\(key, value\)\|/u.test(launcher.source)
        && /value\.is_none\(\)/u.test(launcher.source),
      `${launcher.label} lacks a behavior test for inherited automation authority`,
    );
  }

  const asrProgram = read('crates', 'osg-asr', 'src', 'program.rs');
  const asrProcess = read('crates', 'osg-asr', 'src', 'process.rs');
  assert.match(
    asrProgram,
    /pub\(crate\) fn command\(&self\) -> Command[\s\S]*?apply_sanitized_environment\(&mut command\);[\s\S]*?command/u,
    'the ASR command must sanitize its inherited environment before it is returned to the spawner',
  );
  const asrSanitizer = asrProgram.match(
    /fn apply_sanitized_environment\(command: &mut Command\) \{[\s\S]*?\n\}/u,
  )?.[0] ?? '';
  assert.match(asrSanitizer, /command\.env_clear\(\);/u, 'ASR must clear its ambient environment');
  for (const variable of automationAuthorityVariables) {
    assert.doesNotMatch(
      asrSanitizer,
      new RegExp(`"${variable}"`, 'u'),
      `ASR must not re-add ${variable} after clearing inherited state`,
    );
  }
  assert.match(
    asrProcess,
    /let mut command = program\.command\(\);[\s\S]*?\.creation_flags\(CREATE_NO_WINDOW\)[\s\S]*?\.spawn\(\)/u,
    'the ASR spawner must only launch the sanitized WorkerProgram command',
  );
  assert.match(environment, /WEBVIEW2_USER_DATA_FOLDER:\s*join\(root, 'webview'\)/u);
  assert.match(environment, /OSG_E2E_FIXTURE_ROOT:\s*root/u);
  assert.match(environment, /OSG_E2E_OFFSCREEN_WINDOW:\s*'1'/u);
  assert.match(
    legacyImport,
    /let local_data = match crate::harness_data_root\(\)[\s\S]*?Some\(root\) => root\.join\("data"\)[\s\S]*?None => app[\s\S]*?app_local_data_dir/u,
    'legacy-import locking must not bypass the isolated native data root',
  );
  assert.match(
    desktopState,
    /#\[cfg\(feature = "e2e-automation"\)\]\s*pub\(crate\) type DesktopCredentialBackend = Arc<SessionCredentialBackend>;/u,
    'automation credentials must remain process-memory-only and never reach the OS keyring',
  );
  assert.match(
    desktopState,
    /#\[cfg\(feature = "e2e-automation"\)\]\s*let credentials\s*=\s*CredentialService::new\([\s\S]*SessionCredentialBackend::new\(\)/u,
    'automation state must instantiate the in-memory credential backend',
  );

  const inspectStart = download.indexOf('pub(crate) async fn download_inspect(');
  const cookieGuard = download.indexOf(
    'let cookies = resolve_browser_cookie_source(request.cookie_source)?;',
    inspectStart,
  );
  const engineResolution = download.indexOf('let engine = runtime.engine()', inspectStart);
  const engineInspection = download.indexOf(
    'engine.inspect(&url, inspection_cookies, &control)', inspectStart,
  );
  assert.ok(inspectStart >= 0, 'download_inspect is missing');
  assert.ok(
    cookieGuard > inspectStart && cookieGuard < engineResolution && cookieGuard < engineInspection,
    'automation must resolve cookie authority before resolving or invoking the downloader',
  );
  assert.match(
    download,
    /#\[cfg\(feature = "e2e-automation"\)\]\s*fn resolve_browser_cookie_source\([\s\S]*?if request == CookieSourceRequest::None[\s\S]*?AUTOMATION_COOKIE_FILE_ENV[\s\S]*?AutomationCookieFile::new[\s\S]*?AUTOMATION_BROWSER_PROFILE_ENV[\s\S]*?refused access to a live browser profile[\s\S]*?AutomationBrowserProfile::new/u,
    'the E2E binary must substitute only a typed file or disposable browser-profile authority',
  );
  assert.match(
    downloadPlan,
    /#\[cfg\(feature = "e2e-automation"\)\][\s\S]*?pub struct AutomationCookieFile\(PathBuf\)[\s\S]*?join\("input"\)[\s\S]*?!file\.starts_with\(&input\)[\s\S]*?AutomationCookieFile\(<redacted>\)/u,
    'the automation cookie authority must stay under fixture input and redact its path',
  );
  assert.match(
    downloadPlan,
    /pub struct AutomationBrowserProfile[\s\S]*?browser: BrowserCookieSource[\s\S]*?join\("input"\)[\s\S]*?!profile\.starts_with\(&input\)[\s\S]*?AutomationBrowserProfile[\s\S]*?"<redacted>"/u,
    'the automation browser authority must stay under fixture input and redact its path',
  );
});

test('the managed-staging native contract fails closed when one cross-language field drifts', () => {
  const source = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'automation_window.rs');
  assertManagedStagingNativeContract(source);
  for (const variable of MANAGED_STAGING_ENVIRONMENT) {
    assert.throws(
      () => assertManagedStagingNativeContract(source.replaceAll(variable, `${variable}_DRIFTED`)),
      new RegExp(variable, 'u'),
    );
  }
});

test('all owned automation processes are hidden and all runtime sources refuse desktop surfaces', () => {
  const runtimeFiles = [
    ...sourceFilesBelow(join(E2E_ROOT, 'journeys')),
    ...sourceFilesBelow(join(E2E_ROOT, 'scenarios')),
    ...sourceFilesBelow(join(E2E_ROOT, 'support')),
    join(E2E_ROOT, 'run-isolated.mjs'),
    join(E2E_ROOT, 'wdio.conf.js'),
  ];
  const forbiddenCalls = [
    /requestFullscreen\s*\(/u,
    /fullscreenWindow\s*\(/u,
    /maximizeWindow\s*\(/u,
    /minimizeWindow\s*\(/u,
    /newWindow\s*\(/u,
    /setWindowRect\s*\(/u,
    /setWindowPosition\s*\(/u,
    /setWindowSize\s*\(/u,
    /showOpenFilePicker\s*\(/u,
    /showSaveFilePicker\s*\(/u,
    /showDirectoryPicker\s*\(/u,
    /window\.open\s*\(/u,
    /openExternal\s*\(/u,
    /browser\.tauri\.execute\s*\(/u,
  ];

  for (const path of new Set(runtimeFiles)) {
    const source = readFileSync(path, 'utf8');
    for (const pattern of forbiddenCalls) {
      assert.doesNotMatch(source, pattern, `${path} contains interactive call ${pattern}`);
    }
    const childCalls = source.match(/\b(?:execFileSync|execSync|spawnSync|spawn)\s*\(/gu)?.length ?? 0;
    const hiddenOptions = source.match(/windowsHide:\s*true/gu)?.length ?? 0;
    assert.ok(
      hiddenOptions >= childCalls,
      `${path} starts ${childCalls} child process(es) but supplies only ${hiddenOptions} hidden options`,
    );
  }

  const main = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'main.rs');
  assert.match(main, /cfg_attr\(not\(debug_assertions\), windows_subsystem = "windows"\)/u);
  const config = read('e2e', 'wdio.conf.js');
  assert.match(config, /saveScreenshot\(/u, 'failure evidence must come from the WebView compositor');
  assert.doesNotMatch(config, /desktopCapturer|PrintWindow|BitBlt|computer-use/iu);
});
