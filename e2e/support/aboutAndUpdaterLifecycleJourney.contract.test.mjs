import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (...segments) => readFileSync(join(import.meta.dirname, ...segments), 'utf8');

const journeyPath = join(import.meta.dirname, '..', 'journeys', 'aboutAndUpdaterLifecycle.journey.js');
const journey = readFileSync(journeyPath, 'utf8');
const updaterRs = read('..', '..', 'apps', 'desktop', 'src-tauri', 'src', 'updater.rs');
const libRs = read('..', '..', 'apps', 'desktop', 'src-tauri', 'src', 'lib.rs');
const cargoToml = read('..', '..', 'apps', 'desktop', 'src-tauri', 'Cargo.toml');
const updaterSmokeWorkflow = read('..', '..', '.github', 'workflows', 'updater-smoke.yml');
const aboutTab = read('..', '..', 'src', 'components', 'settings', 'tabs', 'AboutTab.js');
const gitVersion = read('..', '..', 'src', 'utils', 'gitVersion.js');
const updateService = read('..', '..', 'src', 'platform', 'updateService.js');
const startupUpdateCoordinator = read('..', '..', 'src', 'platform', 'startupUpdateCoordinator.js');
const diagnosticsRs = read('..', '..', 'apps', 'desktop', 'src-tauri', 'src', 'diagnostics.rs');
const settingsSurfaceJourney = read('..', 'journeys', 'settingsSurface.journey.js');
const database = read('..', 'support', 'database.js');

test('the e2e-automation channel is really compiled disabled, before the signing key is ever checked', () => {
  assert.match(updaterRs, /pub\(crate\) enum UpdateChannelState \{/u);
  assert.match(updaterRs, /if cfg!\(any\(\s*feature = "unsigned-local-build",\s*feature = "e2e-automation"\s*\)\) \{\s*return UpdateChannelState::Disabled;/u);
  assert.match(updaterRs, /const fn quiescent_outcome\(self\) -> Option<&'static str> \{/u);
  assert.match(updaterRs, /Self::Disabled => Some\("disabled"\)/u);
  assert.match(updaterRs, /if let Some\(outcome\) = channel\.quiescent_outcome\(\) \{/u);
  // The quiescent branch returns before build_updater is ever called -- no endpoint is configured
  // and no socket opens on this channel.
  const quiescentIndex = updaterRs.indexOf('if let Some(outcome) = channel.quiescent_outcome()');
  const returnIndex = updaterRs.indexOf('return Ok(AppUpdateStatus {', quiescentIndex);
  const buildUpdaterCallIndex = updaterRs.indexOf('build_updater(&app, UPDATE_CHECK_TIMEOUT)?');
  assert.ok(quiescentIndex >= 0 && returnIndex > quiescentIndex && buildUpdaterCallIndex > returnIndex,
    'the disabled-channel early return must precede the only build_updater call');
  assert.match(journey, /update_channel_state/u);
});

test('the diagnostic log this journey reads really always records check_started then a disabled check_completed', () => {
  assert.match(updaterRs, /diagnostics::record\(\s*"app-update\.check_started"/u);
  assert.match(updaterRs, /diagnostics::record\(\s*"app-update\.check_completed",\s*&\[\s*\("version", current_version\.clone\(\)\),\s*\(\s*"outcome", outcome\.to_owned\(\)/u);
  assert.match(diagnosticsRs, /entry\.insert\("event"\.to_owned\(\), Value::String\(event\.to_owned\(\)\)\);/u);
  assert.match(journey, /"event":"app-update\\\.check_started"/u);
  assert.match(journey, /"event":"app-update\\\.check_completed"/u);
  assert.match(journey, /"outcome":"disabled"/u);
});

test('ci-updater-fixture (the real signed-update seam) is structurally unreachable from this e2e-automation journey', () => {
  assert.match(libRs, /#\[cfg\(all\(feature = "ci-updater-fixture", feature = "e2e-automation"\)\)\]/u);
  assert.match(libRs, /compile_error!\("the ci-updater-fixture and e2e-automation channels are mutually exclusive"\);/u);
  assert.match(cargoToml, /ci-updater-fixture = \[\]/u);
  assert.match(cargoToml, /e2e-automation = \[/u);
  assert.match(updaterSmokeWorkflow, /--features production,ci-updater-fixture/u);
  assert.doesNotMatch(updaterSmokeWorkflow, /e2e-automation/u);
  assert.match(journey, /compile_error!/u);
  assert.match(journey, /updater-smoke\.yml/u);
});

test('About really reaches the native updater (app_health / app_update_check), not a legacy direct GitHub fetch', () => {
  assert.match(aboutTab, /import \{ getGitVersion, getDisplayVersion, getLatestVersion/u);
  assert.match(gitVersion, /window\.isTauri/u);
  assert.match(gitVersion, /getDesktopAppVersion\(\)/u);
  assert.match(gitVersion, /startStartupUpdateCheck\(\)/u);
  assert.match(gitVersion, /Signed updater is not configured/u);
  assert.match(updateService, /invokeCommand\('app_update_check'\)/u);
  assert.match(updateService, /invokeCommand\('app_health'\)/u);
  assert.match(startupUpdateCoordinator, /checkDesktopUpdate, installDesktopUpdate/u);
  assert.match(journey, /app_health/u);
});

test('the honest failed-check branch is the one this journey asserts, not a fabricated up-to-date/available state', () => {
  assert.match(aboutTab, /'settings\.updateCheckFailed', 'Unable to check for updates'/u);
  assert.match(aboutTab, /className="update-check-failed"/u);
  assert.match(aboutTab, /className="update-notification"/u);
  assert.match(aboutTab, /className="up-to-date"/u);
  assert.match(journey, /updateCheckFailedPresent, true/u);
  assert.match(journey, /updateCheckFailedText, 'Unable to check for updates'/u);
  assert.match(journey, /allowVisibleProblems:\s*\{\s*errorAlerts:/u);
  assert.match(journey, /updateAvailablePresent, false/u);
  assert.match(journey, /upToDatePresent, false/u);
});

test('the journey reaches About through the same real Settings navigation settingsSurface already proves', () => {
  assert.match(settingsSurfaceJourney, /tab: 'about', step: '07-about', root: '\.about-section'/u);
  assert.match(journey, /data-app-action="open-settings"/u);
  assert.match(journey, /data-settings-tab="about"/u);
  assert.match(journey, /clickSettingsControl/u);
  assert.match(journey, /data-settings-action="close"/u);
  assert.match(journey, /await openEditor\(\)/u);
  assert.doesNotMatch(journey, /openProjectWithMedia/u);
  assert.match(journey, /focusSelector: '\.version-info'/u);
  assert.match(journey, /focusSelector: '\.update-check-failed'/u);
  assert.doesNotMatch(journey, /focusSelector: '\.about-section'/u);
});

test('the durable-state oracle this journey depends on reads real SQLite, not a fixture', () => {
  assert.match(database, /export const durableState = \(root\) => withDatabase/u);
});

test('the journey never substitutes a native command, private IPC, raw SQL, or a real credential', () => {
  for (const [label, forbidden] of [
    ['private IPC', /__TAURI__|invokeDesktop|invokeCommand/u],
    ['native picker', /showOpen|showSave|input\s*\[\s*type\s*=\s*["']file/u],
    ['raw SQL', /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|app_settings|projects|jobs)\b/iu],
    ['a real minisign key value', /RWQ|RW[A-Za-z0-9+/]{40,}/u],
  ]) {
    assert.doesNotMatch(journey, forbidden, `journey contains forbidden ${label}`);
  }
});

test('the contract fails when any one load-bearing assertion is removed', () => {
  const assertJourneyStillProvesTheDisabledChannel = (source) => {
    assert.match(source, /updateCheckFailedPresent, true/u);
    assert.match(source, /"outcome":"disabled"/u);
    assert.match(source, /unexplained,\s*\[\],/u);
    assert.match(source, /versionDisplay, \/v\\d\+\\\.\\d\+\\\.\\d\+\//u);
  };
  assertJourneyStillProvesTheDisabledChannel(journey);
  for (const needle of [
    'updateCheckFailedPresent, true',
    '"outcome":"disabled"',
    'unexplained,',
  ]) {
    const weakened = journey.replace(needle, '/* removed */');
    assert.notEqual(weakened, journey, `mutation needle is stale: ${needle}`);
    assert.throws(() => assertJourneyStillProvesTheDisabledChannel(weakened), undefined, needle);
  }
});
