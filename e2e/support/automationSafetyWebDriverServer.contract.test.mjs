// The compiled WebDriver server: identified, session-bound, with no interactive window route.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { REPOSITORY_ROOT, read, readSplitModule } from './repositorySources.js';

test('the compiled WebDriver server is identified, session-bound, and has no interactive window route', () => {
  const cargo = read('apps', 'desktop', 'src-tauri', 'Cargo.toml');
  const cargoLock = read('Cargo.lock');
  const application = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'lib.rs');
  const automationWindow = readSplitModule('apps', 'desktop', 'src-tauri', 'src', 'automation_window.rs');
  const plugin = read('vendor', 'tauri-plugin-wdio-webdriver', 'src', 'lib.rs');
  const server = read('vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'mod.rs');
  const router = read('vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'router.rs');
  const sessions = read(
    'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'handlers', 'session.rs',
  );
  const status = read(
    'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'handlers', 'mod.rs',
  );
  const windows = read(
    'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'handlers', 'window.rs',
  );
  const executor = read(
    'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'platform', 'executor.rs',
  );
  const navigation = read(
    'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'handlers', 'navigation.rs',
  );
  const config = read('e2e', 'wdio.conf.js');
  const installedService = read(
    'e2e', 'node_modules', '@wdio', 'tauri-service', 'dist', 'esm', 'index.js',
  );
  const installedNativeUtils = read(
    'e2e', 'node_modules', '@wdio', 'native-utils', 'dist', 'esm', 'index.js',
  );
  const vendoredLicense = read('vendor', 'tauri-plugin-wdio-webdriver', 'LICENSE');

  assert.match(
    cargo,
    /tauri-plugin-wdio-webdriver\s*=\s*\{\s*path\s*=\s*"\.\.\/\.\.\/\.\.\/vendor\/tauri-plugin-wdio-webdriver",\s*optional\s*=\s*true\s*\}/u,
  );
  assert.match(cargo, /^production\s*=\s*\["tauri\/custom-protocol"\]\s*$/mu);
  assert.match(
    cargo,
    /^e2e-automation\s*=\s*\[[\s\S]*?"dep:tauri-plugin-wdio-webdriver"[\s\S]*?"dep:tauri-plugin-wdio"[\s\S]*?\]\s*$/mu,
  );
  const automationFeature = /^e2e-automation\s*=\s*\[([\s\S]*?)^\]\s*$/mu.exec(cargo)?.[1];
  assert.notEqual(automationFeature, undefined, 'the automation feature declaration is missing');
  assert.match(automationFeature, /"tauri\/custom-protocol"/u);
  assert.doesNotMatch(
    automationFeature,
    /unsigned-local-build|tauri\/devtools/u,
    'the hidden automation graph may not compile a DevTools window surface',
  );
  assert.match(
    application,
    /#\[cfg\(all\(feature = "production", feature = "e2e-automation"\)\)\]\s*compile_error!\("the production and e2e-automation channels are mutually exclusive"\);/u,
    'a production feature graph must be structurally unable to include automation hooks',
  );
  assert.match(
    application,
    /#\[cfg\(all\(feature = "unsigned-local-build", feature = "e2e-automation"\)\)\]\s*compile_error!\("the unsigned-local-build and e2e-automation channels are mutually exclusive"\);/u,
    'an automation feature graph must be structurally unable to include DevTools',
  );
  assert.match(
    application,
    /#\[cfg\(all\(feature = "ci-updater-fixture", feature = "e2e-automation"\)\)\]\s*compile_error!\("the ci-updater-fixture and e2e-automation channels are mutually exclusive"\);/u,
    'an automation feature graph must be structurally unable to inherit fixture browser arguments',
  );
  assert.match(cargo, /\[features\]\s*default = \[\]\s*production = \["tauri\/custom-protocol"\]/u);
  assert.match(
    cargo,
    /e2e-automation = \[[\s\S]*?"dep:tauri-plugin-wdio-webdriver"[\s\S]*?"dep:tauri-plugin-wdio"[\s\S]*?\]/u,
  );
  assert.equal(
    createHash('sha256').update(vendoredLicense).digest('hex'),
    '20c84663dbfa685b230f362509fdbaea7819f5da166afea9857c4d96dcc7e0bc',
    'the exact upstream MIT license must remain in the vendored source snapshot',
  );
  const lockedPlugin = /\[\[package\]\]\s*name = "tauri-plugin-wdio-webdriver"[\s\S]*?(?=\n\[\[package\]\]|$)/u
    .exec(cargoLock)?.[0];
  assert.notEqual(lockedPlugin, undefined, 'the vendored automation plugin is absent from Cargo.lock');
  assert.doesNotMatch(
    lockedPlugin,
    /\n(?:source|checksum) = /u,
    'Cargo.lock must resolve the patched plugin as a local path package',
  );
  assert.match(application, /#\[cfg\(feature = "e2e-automation"\)\][\s\S]*?init_with_window_guard/u);
  assert.match(plugin, /IDENTITY_ENV_VAR:\s*&str\s*=\s*"OSG_E2E_WEBDRIVER_IDENTITY"/u);
  assert.match(plugin, /value\.len\(\)\s*==\s*64/u);
  assert.doesNotMatch(plugin, /unwrap_or\(DEFAULT_PORT\)|DEFAULT_PORT:\s*u16/u);
  assert.match(server, /pub fn enforce_window_guard/u);
  assert.match(router, /from_fn_with_state\([\s\S]*?enforce_native_window_guard::<R>/u);
  assert.doesNotMatch(router, /\.route\(\s*"\/wdio\/eval"/u, 'sessionless eval is forbidden');
  assert.doesNotMatch(router, /\.route\(\s*"\/session\/\{session_id\}\/print"/u);
  assert.equal(
    existsSync(join(REPOSITORY_ROOT, 'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'handlers', 'direct_eval.rs')),
    false,
    'the unauthenticated direct-eval handler must not remain as dormant vendored code',
  );
  assert.equal(
    existsSync(join(REPOSITORY_ROOT, 'vendor', 'tauri-plugin-wdio-webdriver', 'src', 'server', 'handlers', 'print.rs')),
    false,
    'the native print handler must not remain as dormant vendored code',
  );
  assert.match(
    executor,
    /el\.tagName === 'INPUT' && el\.type === 'file'[\s\S]*refuses file-input activation/u,
    'standard element click must not activate a native file input',
  );
  assert.ok(
    (executor.match(/refuses file-input mutation/gu)?.length ?? 0) >= 2,
    'clear and send-keys must both refuse file-input mutation',
  );
  assert.doesNotMatch(
    navigation,
    /executor\.(?:navigate|go_back|go_forward|refresh)\s*\(/u,
    'WebDriver navigation must not bypass the product external-surface guard',
  );
  assert.match(navigation, /refuses top-level navigation/u);
  assert.match(navigation, /refuses history navigation/u);
  assert.match(navigation, /refuses document reload/u);

  // Every W3C window route is named here. Context switching and reads do not touch HWND state;
  // creation is already an unsupported stub, close only destroys the existing isolated window,
  // and every surface mutation is an explicit refusal handler.
  for (const route of [
    '/session/{session_id}/window',
    '/session/{session_id}/window/new',
    '/session/{session_id}/window/handles',
    '/session/{session_id}/window/rect',
    '/session/{session_id}/window/maximize',
    '/session/{session_id}/window/minimize',
    '/session/{session_id}/window/fullscreen',
  ]) {
    assert.match(router, new RegExp(route.replaceAll(/[{}]/gu, '\\$&'), 'u'), `missing route audit: ${route}`);
  }
  assert.match(windows, /Creating new windows is not supported in this context/u);
  assert.match(windows, /window\s*\.destroy\(\)/u);
  assert.doesNotMatch(windows, /window\s*\.(?:show|set_focusable|set_position|maximize|minimize|set_fullscreen)\s*\(/u);
  assert.doesNotMatch(
    windows,
    /executor\.(?:set_window_rect|maximize_window|minimize_window|fullscreen_window)\s*\(/u,
  );
  for (const refusal of ['position and size', 'maximization', 'minimization', 'fullscreen']) {
    assert.match(windows, new RegExp(`refuses native-window ${refusal}`, 'u'));
  }
  assert.match(sessions, /state\.authorizes\(received_authorization\)/u);
  const sessionCreate = sessions.indexOf('pub async fn create');
  const authorizationExtraction = sessions.indexOf('extract_authorization(', sessionCreate);
  const authorizationCheck = sessions.indexOf('state.authorizes(', authorizationExtraction);
  const windowWait = sessions.indexOf('wait_for_window(', authorizationCheck);
  const webviewEvaluation = sessions.indexOf('.evaluate_js(', windowWait);
  const sessionAllocation = sessions.indexOf('sessions.create(', webviewEvaluation);
  assert.ok(
    sessionCreate >= 0
      && authorizationExtraction > sessionCreate
      && authorizationCheck > authorizationExtraction
      && windowWait > authorizationCheck
      && webviewEvaluation > windowWait
      && sessionAllocation > webviewEvaluation,
    'authorization must succeed before the server waits on, evaluates, or allocates a WebView session',
  );
  assert.match(sessions, /"osg:e2eAuthorization"/u);
  assert.match(sessions, /"setWindowRect":\s*false/u);
  assert.match(sessions, /"osg:e2eIdentity":\s*state\.identity\.as_str\(\)/u);
  assert.match(sessions, /"osg:e2eProcessId":\s*std::process::id\(\)/u);
  assert.doesNotMatch(status, /authorization/iu, 'the public status endpoint must not reveal session authorization');
  assert.match(config, /'osg:e2eAuthorization':\s*webdriverBinding\.authorization/u);
  assert.match(config, /beforeSession:[\s\S]*?verifyGuardedWebDriverStatus/u);
  assert.match(config, /assertGuardedWebDriverSession\(\s*browser\.capabilities/u);
  assert.match(config, /beforeCommand:[\s\S]*?assertWebDriverCommandIsNonInteractive/u);
  assert.match(config, /captureBackendLogs:\s*true/u);
  assert.match(config, /backendLogLevel:\s*'trace'/u);
  assert.match(config, /^\s*logLevel:\s*'warn'/mu);
  assert.match(config, /logLevels:\s*\{\s*'tauri-service:service':\s*'trace'\s*\}/u);
  assert.match(
    config,
    /const handle = await browser\.getWindowHandle\(\);\s*await browser\.switchToWindow\(handle\);/u,
    'the one existing browsing context must be explicit before any journey command',
  );
  assert.match(
    installedService,
    /if \(isEmbedded\) \{[\s\S]*?return originalExecute\(script, \.\.\.args\);/u,
    'embedded browser.execute must use the authenticated W3C session, not direct eval',
  );
  assert.match(
    installedService,
    /userSwitchedWindowCache\.has\(browser\.sessionId \|\| 'default'\)[\s\S]*?return;/u,
    'the pinned service must suppress its direct-eval focus discovery after the explicit switch',
  );
  assert.equal(
    installedService.match(/Skipping auto-focus: user has explicitly switched windows/gu)?.length,
    1,
    'focus suppression must be logged once at its transition, never once per WebDriver command',
  );
  const focusTransition = installedService.slice(
    installedService.indexOf('function suppressActiveWindowFocus('),
    installedService.indexOf('function isInternalWindowSwitch('),
  );
  const focusRecovery = installedService.slice(
    installedService.indexOf('async function ensureActiveWindowFocus('),
    installedService.indexOf('async function getCurrentWebviewWindowLabel('),
  );
  assert.match(focusTransition, /Skipping auto-focus/u);
  assert.doesNotMatch(focusRecovery, /Skipping auto-focus/u);
  assert.match(
    installedNativeUtils,
    /const waitUntilWindowAvailable = async \(browser\)[\s\S]*?browser\.getWindowHandles\(\)/u,
    'service initialization must use a standard authenticated W3C route',
  );

  assert.match(automationWindow, /window\.set_skip_taskbar\(true\)/u);
  assert.match(automationWindow, /window\.is_focused\(\)\?/u);
  assert.match(automationWindow, /window\.is_fullscreen\(\)/u);
  assert.match(automationWindow, /window\.is_maximized\(\)/u);
  assert.match(application, /WindowEvent::Moved\(_\)[\s\S]*?WindowEvent::Focused\(true\)[\s\S]*?automation_window::isolate/u);
  assert.match(
    application,
    /#\[cfg\(not\(feature = "e2e-automation"\)\)\]\s*if has_saved_main_window_state\(app\)/u,
    'automation may not even read the live window-state profile',
  );
  const isolateStart = automationWindow.indexOf('pub(crate) fn isolate(');
  const nonFocusable = automationWindow.indexOf('.set_focusable(false)', isolateStart);
  const visibilityRead = automationWindow.indexOf('let was_visible =', isolateStart);
  const repairHide = automationWindow.indexOf('window.hide()?', visibilityRead);
  const unfullscreen = automationWindow.indexOf('window.set_fullscreen(false)?', repairHide);
  const unmaximize = automationWindow.indexOf('window.unmaximize()?', unfullscreen);
  const moveOffscreen = automationWindow.indexOf('window.set_position(', unmaximize);
  const repairShow = automationWindow.indexOf('window.show()?', moveOffscreen);
  assert.ok(
    isolateStart >= 0
      && nonFocusable > isolateStart
      && visibilityRead > nonFocusable
      && repairHide > visibilityRead
      && unfullscreen > repairHide
      && unmaximize > unfullscreen
      && moveOffscreen > unmaximize
      && repairShow > moveOffscreen,
    'a hostile window state must become non-focusable, hide, normalize, move fully off-screen, and only then reappear',
  );
});
