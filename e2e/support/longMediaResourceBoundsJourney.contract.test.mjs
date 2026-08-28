import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const boundsJourney = readFileSync(
  new URL('../journeys/longMediaResourceBounds.journey.js', import.meta.url),
  'utf8',
);
const recoveryJourney = readFileSync(
  new URL('../journeys/longMediaOperationRecovery.journey.js', import.meta.url),
  'utf8',
);
const recoveryScenario = readFileSync(
  new URL('../scenarios/longMediaOperationRecovery.mjs', import.meta.url),
  'utf8',
);
const fixture = readFileSync(new URL('./longSyntheticMediaFixture.js', import.meta.url), 'utf8');
const oracle = readFileSync(new URL('./longMediaResourceOracle.js', import.meta.url), 'utf8');
const runIsolated = readFileSync(new URL('../run-isolated.mjs', import.meta.url), 'utf8');
const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const wdioConf = readFileSync(new URL('../wdio.conf.js', import.meta.url), 'utf8');

test('the long-media fixture is wholly synthetic, offline, and reviewed-tool-driven', () => {
  assert.doesNotMatch(fixture, /https?:\/\//u);
  assert.match(fixture, /findReviewedMediaTool\('ffmpeg\.exe'\)/u);
  assert.match(fixture, /'-f', 'lavfi'/u);
  assert.match(fixture, /durationSeconds: 7_200/u);
});

test('the resource-bounds journey drives only the public UI and never substitutes a native command', () => {
  assert.doesNotMatch(boundsJourney, /__TAURI_INTERNALS__|\.invoke\(|invokeCommand/u);
  assert.doesNotMatch(boundsJourney, /localStorage\.setItem/u);
  assert.match(boundsJourney, /assertManagedArtifactLedgerMatchesDisk\(root\)/u);
  assert.match(boundsJourney, /clickControl\('\.file-info-card \.file-info-content'\)/u);
  assert.match(boundsJourney, /browser\.capabilities\['osg:e2eProcessId'\]/u);
});

test('the resource-bounds journey cites the real source of every cap it asserts', () => {
  for (const citation of [
    'src/components/lyrics/waveformRendering.js',
    'src/components/lyrics/utils/timelineDomain.js',
    'apps/desktop/src-tauri/src/waveform_cache.rs:20',
    'apps/desktop/src-tauri/src/media_pipeline.rs:36',
    'apps/desktop/src-tauri/src/render/host.rs:22',
    'src/components/lyrics/VolumeVisualizer.js:21',
    'crates/osg-application/src/jobs.rs:11',
  ]) {
    assert.ok(boundsJourney.includes(citation), `missing cap citation: ${citation}`);
  }
});

test('the resource-bounds journey proves the waveform/selectable range at a real zoom-in interaction', () => {
  assert.match(boundsJourney, /waveformInkBoundary/u);
  assert.match(boundsJourney, /getVisibleTimeRange/u);
  assert.match(boundsJourney, /ZOOM_REPETITIONS/u);
  assert.match(boundsJourney, /range-action-bar/u);
});

test('the resource-bounds journey samples desktop-process resources and the run root before and after heavy interaction', () => {
  assert.match(boundsJourney, /sampleApplicationProcess\(processId\)/u);
  assert.match(boundsJourney, /runRootFileCensus\(root\)/u);
  assert.match(boundsJourney, /databaseFootprintBytes\(root\)/u);
  assert.match(boundsJourney, /THREAD_COUNT_GROWTH_CAP/u);
  assert.match(boundsJourney, /HANDLE_COUNT_GROWTH_CAP/u);
  assert.match(boundsJourney, /WORKING_SET_GROWTH_CAP_BYTES/u);
});

test('wdio.conf.js stages the long-media fixture through the inherited lease, never a competing one', () => {
  // wdio.conf.js loads twice per run (launcher, then worker), and each load already holds the
  // inherited application lease from run-isolated.mjs's outer withE2eApplicationLease. Calling the
  // fixture's self-acquiring ensureLongSyntheticMedia() here would race a second lease acquisition
  // against that already-live hold; stagedLongSyntheticMedia's inheritedApplication contract is the
  // same one scenarios/multiWindowAsrPersistence.mjs already relies on for stagedFourWindowAsrVideo.
  assert.doesNotMatch(wdioConf, /\bensureLongSyntheticMedia\(/u);
  assert.match(wdioConf, /stagedLongSyntheticMedia\(\{\s*\n\s*inheritedApplication,/u);
});

test('wdio.conf.js stages exactly the three media selections the journey consumes in order', () => {
  // The journey triggers the staged open-file dialog exactly three times: the initial selection
  // (openProjectWithMedia), the switch to the short second source (cancelling the long file's
  // waveform job), and the switch back to the long source. A two-entry sequence here would make
  // the third dialog trigger refuse with automation_dialog_refused, per dialog_paths.rs's
  // parse_staged_media_sequence/get(index) contract.
  const branch = wdioConf.slice(wdioConf.indexOf("'long-media-resource-bounds'"));
  const sequenceStart = branch.indexOf('OSG_E2E_MEDIA_SELECTION_SEQUENCE = JSON.stringify([');
  const sequenceEnd = branch.indexOf(']);', sequenceStart);
  const sequenceBody = branch.slice(sequenceStart, sequenceEnd);
  const entries = sequenceBody.match(/staged\w+/gu);
  assert.deepEqual(entries, ['stagedLongMedia', 'stagedSecondSource', 'stagedLongMedia']);
  const dialogTriggers = (
    boundsJourney.match(/openProjectWithMedia\(\)/gu)?.length ?? 0
  ) + (boundsJourney.match(/switchActiveMedia\(\)/gu)?.length ?? 0);
  assert.equal(dialogTriggers, 3, `the journey must trigger the staged dialog exactly 3 times to match the sequence: ${dialogTriggers}`);
});

test('the process/file-census oracle never interpolates its process id into a shell command', () => {
  assert.match(oracle, /OSG_E2E_SAMPLE_PROCESS_ID/u);
  assert.doesNotMatch(oracle, /Get-Process -Id \$\{/u);
});

test('recovery is a two-process PHASE-gated scenario over the same synthetic long source', () => {
  assert.match(recoveryJourney, /PHASE === 'seed' \|\| PHASE === 'verify'/u);
  assert.match(recoveryJourney, /HONEST_INTERRUPTED_STATES/u);
  assert.match(recoveryJourney, /assertManagedArtifactLedgerMatchesDisk\(root\)/u);
  assert.match(recoveryScenario, /phases: \['seed', 'verify'\]/u);
  assert.match(recoveryScenario, /runScenarioProcesses/u);
  assert.match(recoveryScenario, /stagedMediaSelection/u);
  assert.match(recoveryScenario, /stagedLongSyntheticMedia/u);
});

test('both heavy long-media journeys are excluded from the default suite with their own npm scripts', () => {
  assert.match(runIsolated, /'longMediaOperationRecovery\.journey\.js'/u);
  assert.match(runIsolated, /'longMediaResourceBounds\.journey\.js'/u);
  const packageManifest = JSON.parse(packageJson);
  assert.equal(
    packageManifest.scripts['test:long-media-resource-bounds'],
    'node --test support/longSyntheticMediaFixture.test.mjs support/longMediaResourceBoundsJourney.contract.test.mjs && node run-isolated.mjs journeys/longMediaResourceBounds.journey.js',
  );
  assert.equal(
    packageManifest.scripts['test:long-media-recovery'],
    'node --test support/longSyntheticMediaFixture.test.mjs support/longMediaResourceBoundsJourney.contract.test.mjs && node scenarios/longMediaOperationRecovery.mjs',
  );
});
