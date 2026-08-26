import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const journeyPath = join(import.meta.dirname, '..', 'journeys', 'failedDownloadNoStale.journey.js');
const configPath = join(import.meta.dirname, '..', 'wdio.conf.js');

const count = (source, needle) => source.split(needle).length - 1;

const assertJourneyContract = (source) => {
  assert.equal(count(source, 'await clickControl(GENERATE);'), 2,
    'the journey must perform exactly one successful A action and one failing C action');
  assert.match(source, /assert\.deepEqual\(manifest\.map\(\(\{ label \}\) => label\), \['a', 'c'\]\)/u);
  assert.match(source, /kind: 'rejectGetAfter', after: 1, status: 503/u);
  assert.match(source, /networkWhileStale/u,
    'the journey no longer proves withdrawal before fallible network work');
  assert.ok(count(source, 'assertNoVisibleOrPlayableMedia(') >= 4,
    'the journey no longer guards the full failure interval against stale media');
  assert.match(source, /failedSurface\.errorToasts\.length === 1/u);
  assert.match(source, /assert\.deepEqual\(failedSurface\.inlineErrors, \[\]\)/u);
  assert.match(source, /assertFailedDownloadLeavesOnlyHistory\(before, after\)/u);
  assert.match(source, /event === 'request-rejected' && status === 503/u);
  assert.match(source, /sample < 20/u,
    'the journey no longer watches for a late stale-media restoration');
  assert.doesNotMatch(source, /localStorage\.(?:setItem|removeItem|clear)\s*\(/u,
    'the journey writes browser product state');
  assert.doesNotMatch(source, /(?:invokeDesktop|browser\.url|browser\.refresh|reloadSession)\s*\(/u,
    'the journey bypasses the public customer flow');
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|app_settings|projects|jobs)\b/iu,
    'the journey writes native durability state');
};

test('the failed-download journey stays public-UI, toast-only, and durability-backed', () => {
  const source = readFileSync(journeyPath, 'utf8');
  assertJourneyContract(source);
  const config = readFileSync(configPath, 'utf8');
  assert.match(config, /process\.env\.OSG_E2E_WORKFLOW === 'failed-download-no-stale'/u);
  assert.match(config,
    /label: 'c', path: verifiedDownloadIdentityVideo\(\), rejectGetAfter: 1/u,
    'the application did not receive the exact deterministic failure capability before launch');
});

test('the contract fails when any one load-bearing failure oracle is removed', () => {
  const source = readFileSync(journeyPath, 'utf8');
  for (const needle of [
    'assertFailedDownloadLeavesOnlyHistory(before, after)',
    "event === 'request-rejected' && status === 503",
    'failedSurface.errorToasts.length === 1',
    'assert.deepEqual(failedSurface.inlineErrors, [])',
    'sample < 20',
  ]) {
    const weakened = source.replace(needle, 'true');
    assert.notEqual(weakened, source, `mutation needle is stale: ${needle}`);
    assert.throws(() => assertJourneyContract(weakened), undefined, needle);
  }
});
