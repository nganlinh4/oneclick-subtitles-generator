import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  REFERENCE_VOICE_ENGINE_UNAVAILABLE_MESSAGE,
  verifyPerCueRegenerationRebinding,
  verifySiblingArtifactsUntouched,
} from './narrationControlOracle.js';

const baseResults = () => ([
  {
    outputIndex: 1, subtitleId: 1, text: 'Cue one alpha', artifactId: 'artifact-1a', method: 'gtts',
    startMicros: 500_000, endMicros: 2_000_000,
  },
  {
    outputIndex: 2, subtitleId: 2, text: 'Cue two bravo', artifactId: 'artifact-2a', method: 'gtts',
    startMicros: 3_000_000, endMicros: 4_500_000,
  },
  {
    outputIndex: 3, subtitleId: 3, text: 'Cue three charlie', artifactId: 'artifact-3a', method: 'gtts',
    startMicros: 6_000_000, endMicros: 7_500_000,
  },
]);

test('a clean single-cue regenerate rebinds only the regenerated ordinal', () => {
  const before = baseResults();
  const after = baseResults();
  after[1] = { ...after[1], artifactId: 'artifact-2b' };

  const outcome = verifyPerCueRegenerationRebinding({
    beforeResults: before,
    afterResults: after,
    regeneratedOrdinal: 2,
    newArtifactId: 'artifact-2b',
  });
  assert.deepEqual(outcome.siblingOrdinals, [1, 3]);
});

test('rebinding a sibling cue is a hard failure', () => {
  const before = baseResults();
  const after = baseResults();
  after[1] = { ...after[1], artifactId: 'artifact-2b' };
  after[2] = { ...after[2], artifactId: 'artifact-3-drifted' };

  assert.throws(
    () => verifyPerCueRegenerationRebinding({
      beforeResults: before,
      afterResults: after,
      regeneratedOrdinal: 2,
      newArtifactId: 'artifact-2b',
    }),
    /cue 3 was rebound to a different artifact/u,
  );
});

test('a regenerate that keeps the stale artifact id is a hard failure', () => {
  const before = baseResults();
  const after = baseResults();

  assert.throws(
    () => verifyPerCueRegenerationRebinding({
      beforeResults: before,
      afterResults: after,
      regeneratedOrdinal: 2,
      newArtifactId: 'artifact-2a',
    }),
    /kept its stale artifact id/u,
  );
});

test('editing a sibling cue text during an unrelated regenerate is a hard failure', () => {
  const before = baseResults();
  const after = baseResults();
  after[1] = { ...after[1], artifactId: 'artifact-2b' };
  after[0] = { ...after[0], text: 'Cue one alpha, edited' };

  assert.throws(
    () => verifyPerCueRegenerationRebinding({
      beforeResults: before,
      afterResults: after,
      regeneratedOrdinal: 2,
      newArtifactId: 'artifact-2b',
    }),
    /narration text changed/u,
  );
});

test('a checkpoint that drops or gains a cue is a hard failure', () => {
  const before = baseResults();
  const after = baseResults().slice(0, 2);
  assert.throws(
    () => verifyPerCueRegenerationRebinding({
      beforeResults: before,
      afterResults: after,
      regeneratedOrdinal: 2,
      newArtifactId: 'artifact-2b',
    }),
    /changed the total number/u,
  );
});

test('two artifacts rebinding at once is a hard failure even if the target ordinal is correct', () => {
  const before = baseResults();
  const after = baseResults();
  after[1] = { ...after[1], artifactId: 'artifact-2b' };
  after[2] = { ...after[2], artifactId: 'artifact-3b' };

  assert.throws(
    () => verifyPerCueRegenerationRebinding({
      beforeResults: before,
      afterResults: after,
      regeneratedOrdinal: 2,
      newArtifactId: 'artifact-2b',
    }),
    /rebound to a different artifact/u,
  );
});

test('untouched siblings with identical hashes and sizes pass', () => {
  const outcome = verifySiblingArtifactsUntouched([
    {
      ordinal: 1, beforeSize: 4_096, afterSize: 4_096, beforeSha256: 'a'.repeat(64), afterSha256: 'a'.repeat(64),
    },
    {
      ordinal: 3, beforeSize: 5_120, afterSize: 5_120, beforeSha256: 'b'.repeat(64), afterSha256: 'b'.repeat(64),
    },
  ]);
  assert.deepEqual(outcome.untouchedOrdinals, [1, 3]);
});

test('a sibling whose bytes changed is a hard failure', () => {
  assert.throws(
    () => verifySiblingArtifactsUntouched([
      {
        ordinal: 1, beforeSize: 4_096, afterSize: 4_096, beforeSha256: 'a'.repeat(64), afterSha256: 'c'.repeat(64),
      },
    ]),
    /artifact bytes changed/u,
  );
});

test('a sibling whose size changed is a hard failure even if a hash was not recomputed', () => {
  assert.throws(
    () => verifySiblingArtifactsUntouched([
      {
        ordinal: 3, beforeSize: 4_096, afterSize: 4_100, beforeSha256: 'a'.repeat(64), afterSha256: 'a'.repeat(64),
      },
    ]),
    /artifact size changed/u,
  );
});

test('an empty sibling list is refused rather than silently proving nothing', () => {
  assert.throws(() => verifySiblingArtifactsUntouched([]), /no sibling artifacts/u);
});

test('the unavailable-engine tooltip text is pinned to the shipped i18n default', () => {
  // Read the shipped resource rather than keeping a third hand-copied literal here. A hardcoded
  // copy silently went stale once already: the oracle constant was corrected to the arrow the
  // loaded resource actually uses while this pin still asserted the plain '>' from the call site's
  // i18next FALLBACK, so the test failed even though both the product and the oracle were right.
  // Comparing the oracle against narration.json keeps the real invariant -- the oracle must state
  // exactly what a customer is shown -- and it cannot drift again.
  const narration = JSON.parse(readFileSync(
    join(import.meta.dirname, '..', '..', 'src', 'i18n', 'locales', 'en', 'narration.json'),
    'utf8',
  ));
  assert.equal(REFERENCE_VOICE_ENGINE_UNAVAILABLE_MESSAGE, narration.engineUnavailableMessage);
  // The arrow is the whole point of the correction, so assert it explicitly: a regression that
  // reverted the shipped copy to '>' would otherwise still satisfy the equality above.
  assert.match(REFERENCE_VOICE_ENGINE_UNAVAILABLE_MESSAGE, /Settings → Tools\.$/u);
});
