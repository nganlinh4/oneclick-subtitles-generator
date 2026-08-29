import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const journey = readFileSync(
  new URL('../journeys/multiWindowAsrPersistence.journey.js', import.meta.url),
  'utf8',
);
const scenario = readFileSync(
  new URL('../scenarios/multiWindowAsrPersistence.mjs', import.meta.url),
  'utf8',
);
const fixture = readFileSync(new URL('./fourWindowAsrFixture.js', import.meta.url), 'utf8');
const engines = readFileSync(new URL('./engines.js', import.meta.url), 'utf8');
const scenarioSupport = readFileSync(new URL('./twoProcessScenario.js', import.meta.url), 'utf8');

test('the four-window journey uses the public UI and never substitutes a native command', () => {
  assert.match(journey, /clickControl\('\[data-osg-action="generate-subtitles"\]'\)/u);
  assert.match(journey, /data-transcription-method=/u);
  assert.match(journey, /ensureEngineReady\(ENGINE, \{ allowInstall: false \}\)/u);
  assert.match(journey, /actuateNativeRange\(\{/u);
  assert.match(journey, /selector: '#asr-max-duration-slider'/u);
  assert.match(journey, /value: MAX_REQUEST_MINUTES/u);
  assert.match(journey, /splitLabel\.value === '1' && \/4\/u\.test\(splitLabel\.parallel\)/u);
  assert.match(journey, /clickControl\('\[data-osg-action="process-subtitles"\]'\)/u);
  assert.doesNotMatch(journey, /__TAURI_INTERNALS__|\.invoke\(|invokeCommand/u);
  assert.doesNotMatch(journey, /localStorage\.setItem/u);
  const networkRefusal = engines.indexOf('if (!allowInstall)');
  const installClick = engines.indexOf('await clickControl(`${selector} .engine-card__btn`)', networkRefusal);
  assert.ok(networkRefusal >= 0 && installClick > networkRefusal,
    'network refusal must precede the product Install control');
});

test('the journey independently owns jobs, live publications, deletion safety, and durable merge', () => {
  assert.match(journey, /baselineJobIds/u);
  assert.match(journey, /newTranscribeJobs/u);
  assert.match(journey, /ownedJobs\.length === EXPECTED_WINDOWS/u);
  assert.match(journey, /ownedJobs\.every\(\(\{ state \}\) => state === 'succeeded'\)/u);
  assert.match(journey, /addEventListener\('processing-ranges'/u);
  assert.match(journey, /addEventListener\('streaming-update'/u);
  assert.match(journey, /generationActive/u);
  assert.match(journey, /visibleMilestones/u);
  assert.match(journey, /assertNoDeletedCue/u);
  assert.match(journey, /assertMultiWindowAsrResult/u);
  assert.match(journey, /durableCueSignatures/u);
  assert.match(journey, /visibleProblemSurfacesInPage/u);
});

test('persistence is two hidden desktop processes over one isolated staged fixture', () => {
  assert.match(journey, /PHASE === 'seed' \|\| PHASE === 'verify'/u);
  assert.match(scenario, /phases: \['seed', 'verify'\]/u);
  assert.match(scenario, /runScenarioProcesses/u);
  assert.match(scenario, /runScenarioAttemptWithEvidence/u);
  assert.match(scenario, /stagedMediaSelection/u);
  assert.match(scenarioSupport, /OSG_E2E_EVIDENCE_ATTEMPT: process\.env\.OSG_E2E_EVIDENCE_ATTEMPT/u);
  assert.match(fixture, /en-ami-meeting\.flac/u);
  assert.match(fixture, /resolveVerifiedNativeToolRoles\([\s\S]*?roles:\s*\['ffmpeg', 'ffprobe'\]/u);
  assert.match(fixture, /runSupervisedAssetTool\(\{ applicationLease, command: ffmpeg/u);
  assert.match(fixture, /'-stream_loop'/u);
  assert.doesNotMatch(fixture, /https?:\/\//u);
});
