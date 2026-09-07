import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  JOURNEY_MEDIA_REQUIREMENT, classifiedMediaJourneys, journeyMediaRequirement,
} from './journeyMediaRequirements.js';

const e2eRoot = join(import.meta.dirname, '..');
const journeyRoot = join(e2eRoot, 'journeys');
const source = (...parts) => readFileSync(join(e2eRoot, ...parts), 'utf8');
const mediaConsumer = /(?:openProjectWithMedia|selectStagedMediaFile)\s*\(|process\.env\.OSG_E2E_MEDIA_SELECTION\b/u;

test('every journey has exactly the media classification its shipping actions require', () => {
  const journeys = readdirSync(journeyRoot)
    .filter((name) => name.endsWith('.journey.js'))
    .sort();
  for (const journey of journeys) {
    const consumesStagedMedia = mediaConsumer.test(readFileSync(join(journeyRoot, journey), 'utf8'));
    const requirement = journeyMediaRequirement(journey);
    assert.equal(
      requirement === JOURNEY_MEDIA_REQUIREMENT.none,
      !consumesStagedMedia,
      `${journey} must be explicitly classified when its customer actions consume staged media`,
    );
  }

  const classified = classifiedMediaJourneys();
  assert.deepEqual(
    [...classified.generic, ...classified.custom, ...classified.none].sort(),
    journeys,
    'classification must be an exact exhaustive union of every journey source',
  );
  assert.deepEqual(classified.custom, [
    'geminiBackgroundImageSuccess.journey.js',
    'geminiMediaBenchmark.journey.js',
    'geminiMultiWindowTranscription.journey.js',
    'longMediaOperationRecovery.journey.js',
    'longMediaResourceBounds.journey.js',
    'multiWindowAsrPersistence.journey.js',
  ]);
  assert.equal(new Set([...classified.generic, ...classified.custom]).size,
    classified.generic.length + classified.custom.length);
  assert.throws(() => journeyMediaRequirement('futureJourney.journey.js'), /no explicit/u);
  assert.equal(
    journeyMediaRequirement('journeys/localFileImport.journey.js'),
    JOURNEY_MEDIA_REQUIREMENT.generic,
    'the direct native-picker environment consumer must receive generic real media',
  );
});

test('outer lease owners prepare generic media while WDIO remains read-only', () => {
  const isolated = source('run-isolated.mjs');
  assert.match(
    isolated,
    /cacheMaintenance\.withLeases\([\s\S]*?journeyMediaRequirement\(journey\)[\s\S]*?ensureRealVideo\(\{ applicationLease \}\)[\s\S]*?createRunRoot/u,
  );

  const scenarios = source('support', 'twoProcessScenario.js');
  assert.match(
    scenarios,
    /withScenarioLeases\([\s\S]*?journeyMediaRequirement\(spec\)[\s\S]*?ensureRealVideo\(\{ applicationLease \}\)[\s\S]*?createRunRoot[\s\S]*?copyFileSync\(preparedRealMedia, staged\)[\s\S]*?stagedMediaSelection/u,
  );

  const config = source('wdio.conf.js');
  assert.doesNotMatch(config, /cachedRealVideo|cachedSourceSwitchVideo|verifiedLongSyntheticMedia/u);
  assert.doesNotMatch(config, /copyFileSync/u);
  assert.doesNotMatch(
    config,
    /\bensure[A-Z][A-Za-z0-9]*\s*\(/u,
    'WDIO configuration may verify/copy prepared inputs but must never acquire persistent assets',
  );

  const realMedia = source('support', 'realMedia.js');
  assert.match(
    realMedia,
    /ensureSourceSwitchVideo[\s\S]*?runSupervisedSync\(\{[\s\S]*?ownerProcessId:\s*process\.pid,[\s\S]*?managedPaths:\s*applicationLease\.managedPaths/u,
    'source-switch network acquisition must remain kill-on-owner supervised under the outer lease',
  );

  for (const custom of classifiedMediaJourneys().custom) {
    assert.equal(
      journeyMediaRequirement(custom),
      JOURNEY_MEDIA_REQUIREMENT.custom,
      `${custom} must bypass generic acquisition so its purpose-built fixture remains authoritative`,
    );
  }
});
