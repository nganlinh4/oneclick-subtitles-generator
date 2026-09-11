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
const mediaPipeline = readFileSync(
  new URL('../../apps/desktop/src-tauri/src/media_pipeline.rs', import.meta.url),
  'utf8',
);

test('the long-media fixture is wholly synthetic, offline, and reviewed-tool-driven', () => {
  assert.doesNotMatch(fixture, /https?:\/\//u);
  assert.match(fixture, /resolveVerifiedNativeToolRoles\(\{[\s\S]*?roles: \['ffmpeg', 'ffprobe'\]/u);
  assert.match(fixture, /'-f', 'lavfi'/u);
  assert.match(fixture, /durationSeconds: 7_200/u);
});

test('the resource-bounds journey drives only the public UI and never substitutes a native command', () => {
  assert.doesNotMatch(boundsJourney, /__TAURI_INTERNALS__|\.invoke\(|invokeCommand/u);
  assert.doesNotMatch(boundsJourney, /localStorage\.setItem/u);
  assert.match(boundsJourney, /assertManagedArtifactLedgerMatchesDisk\(root\)/u);
  assert.match(boundsJourney, /openProjectWithMedia\(\)/u);
  assert.match(boundsJourney, /clickControl\('#show-waveform-long-videos'\)/u);
  assert.match(boundsJourney, /browser\.capabilities\['osg:e2eProcessId'\]/u);
});

test('the resource-bounds journey cites the real source of every cap it asserts', () => {
  for (const citation of [
    'src/components/lyrics/waveformRendering.js',
    'apps/desktop/src-tauri/src/waveform_cache.rs:20',
    'apps/desktop/src-tauri/src/media_pipeline.rs:36',
    'apps/desktop/src-tauri/src/render/host.rs:22',
    'src/components/lyrics/VolumeVisualizer.js:21',
    'crates/osg-application/src/jobs.rs:11',
  ]) {
    assert.ok(boundsJourney.includes(citation), `missing cap citation: ${citation}`);
  }
});

test('the resource-bounds journey proves the waveform boundary at a real zoom-in interaction', () => {
  assert.match(boundsJourney, /waveformInkBoundary/u);
  assert.match(boundsJourney, /getVisibleTimeRange/u);
  assert.match(boundsJourney, /ZOOM_REPETITIONS/u);
});

test('the resource-bounds journey samples desktop-process resources and the run root before and after heavy interaction', () => {
  assert.match(boundsJourney, /sampleApplicationProcess\(processId\)/u);
  assert.match(boundsJourney, /runRootFileCensus\(root\)/u);
  assert.match(boundsJourney, /databaseFootprintBytes\(root\)/u);
  assert.match(boundsJourney, /THREAD_COUNT_GROWTH_CAP/u);
  assert.match(boundsJourney, /HANDLE_COUNT_GROWTH_CAP/u);
  assert.match(boundsJourney, /WORKING_SET_GROWTH_CAP_BYTES/u);
});

test('the outer runner prepares long media under branded authority and WDIO stays read-only', () => {
  assert.match(
    runIsolated,
    /ensureLongSyntheticMedia\(\{ applicationLease \}\)[\s\S]*?createRunRoot/u,
  );
  assert.doesNotMatch(wdioConf, /\bensureLongSyntheticMedia\(/u);
  assert.doesNotMatch(wdioConf, /stagedLongSyntheticMedia/u);
  assert.doesNotMatch(wdioConf, /verifiedLongSyntheticMedia/u);
  assert.match(runIsolated, /const stagedLong = stageMedia\(preparedLongMedia\)/u);
});

test('the long-media bounds journey stages only its one customer-selected source', () => {
  const branch = runIsolated.slice(
    runIsolated.indexOf("if (journeyName === 'longMediaResourceBounds.journey.js')"),
  );
  assert.match(branch, /OSG_E2E_MEDIA_SELECTION = stagedLong/u);
  assert.doesNotMatch(branch.slice(0, branch.indexOf("if (new Set([")), /stagedSwitch/u);
  assert.equal(boundsJourney.match(/openProjectWithMedia\(\)/gu)?.length ?? 0, 1);
});

test('the process/file-census oracle never interpolates its process id into a shell command', () => {
  assert.match(oracle, /OSG_E2E_SAMPLE_PROCESS_ID/u);
  assert.doesNotMatch(oracle, /Get-Process -Id \$\{/u);
});

test('recovery is a two-process PHASE-gated scenario over the same synthetic long source', () => {
  assert.match(recoveryJourney, /PHASE === 'seed' \|\| PHASE === 'verify'/u);
  // A killed running/cancelling job has exactly ONE honest restored state -- interrupt_in_flight
  // (crates/osg-infrastructure/src/storage/jobs.rs) unconditionally applies JobUpdate::Interrupt to
  // every in-flight job at boot, with no branch to 'failed' or 'cancelled'. The journey asserts the
  // exact state rather than tolerating a broader set of terminal states the product never produces
  // for this recovery path.
  assert.match(recoveryJourney, /interrupted\.state, 'interrupted'/u);
  assert.match(recoveryJourney, /interruptedJobs\.length[\s\S]*?1/u);
  assert.match(recoveryJourney, /id !== interrupted\.id/u);
  assert.match(recoveryJourney, /assertManagedArtifactLedgerMatchesDisk\(root\)/u);
  assert.match(recoveryJourney, /clickControl\('#show-waveform-long-videos'\)/u);
  assert.doesNotMatch(recoveryJourney, /localStorage\.setItem/u);
  assert.match(recoveryScenario, /phases: \['seed', 'verify'\]/u);
  assert.match(recoveryScenario, /runScenarioProcesses/u);
  assert.match(recoveryScenario, /runScenarioAttemptWithEvidence/u);
  assert.match(recoveryScenario, /stagedMediaSelection/u);
  assert.match(recoveryScenario, /stagedLongSyntheticMedia/u);
  assert.match(
    mediaPipeline,
    /#\[cfg\(feature = "e2e-automation"\)\][\s\S]*?OSG_E2E_WORKFLOW[\s\S]*?OSG_E2E_PERSISTENCE_PHASE/u,
  );
  // Rust 1.91 added Duration::from_mins; keep checking the one-minute hold's semantics instead
  // of pinning whichever equivalent constructor spelling rustfmt/current Rust encourages.
  assert.match(
    mediaPipeline,
    /tokio::time::sleep\(Duration::from_(?:secs\(60\)|mins\(1\))\)/u,
  );
});

test('both heavy long-media journeys are excluded from the default suite with their own npm scripts', () => {
  assert.match(runIsolated, /'longMediaOperationRecovery\.journey\.js'/u);
  assert.match(runIsolated, /'longMediaResourceBounds\.journey\.js'/u);
  const packageManifest = JSON.parse(packageJson);
  assert.equal(
    packageManifest.scripts['test:long-media-resource-bounds'],
    'node --test support/managedFixturePublication.test.mjs support/longSyntheticMediaFixture.test.mjs support/longMediaResourceBoundsJourney.contract.test.mjs && node run-isolated.mjs journeys/longMediaResourceBounds.journey.js',
  );
  assert.equal(
    packageManifest.scripts['test:long-media-recovery'],
    'node --test support/managedFixturePublication.test.mjs support/longSyntheticMediaFixture.test.mjs support/longMediaResourceBoundsJourney.contract.test.mjs && node scenarios/longMediaOperationRecovery.mjs',
  );
});
