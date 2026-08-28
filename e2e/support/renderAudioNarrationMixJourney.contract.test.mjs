import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const journeyPath = join(
  import.meta.dirname, '..', 'journeys', 'renderAudioNarrationMix.journey.js',
);
const count = (source, needle) => source.split(needle).length - 1;

const assertJourneyContract = (source) => {
  // One shared render call site, invoked exactly twice: job A (narration off), job B (narration on).
  assert.equal(count(source, 'await clickControl(RENDER_BUTTON);'), 1, (
    'the two renders must share one reviewed click path rather than two hand-written duplicates'
  ));
  assert.equal(count(source, 'await runRenderAndDownload({'), 2, (
    'the journey must render the project exactly twice: once without narration, once with it'
  ));
  assert.match(source, /clickControl\('label\[for="narration-none"\]'\)/u);
  assert.match(source, /clickControl\('label\[for="narration-generated"\]'\)/u);
  assert.match(source, /waitForDurableNarrationSelection\(root, 'none'\)/u);
  assert.match(source, /waitForDurableNarrationSelection\(root, 'generated'\)/u);
  // Every other public setting is set exactly once and shared by both renders.
  assert.equal(count(source, 'await setRenderSettings('), 1, (
    'render settings must be configured once and shared by both renders, or the comparison is not A/B'
  ));

  // Narration generation reuses the already-proven ownership oracle rather than reinventing it.
  assert.match(source, /verifyNarrationGenerationOwnership\(/u);
  assert.match(source, /durableProjectNarrations\(root\)\.length, 0/u);
  assert.match(source, /expectedNarrationPlacements\(generation\.bindings, clipDurations\)/u);

  // The alignment step is independently proven through SQLite, not merely a visible label change.
  assert.match(source, /jobKind: 'alignNarration'/u);
  assert.match(source, /artifactKind: 'alignedNarration'/u);

  // The comparison is the point of the journey and must not be skippable.
  assert.match(source, /verifyStructuralAudioParity\(\{ withProbe, withoutProbe \}\)/u);
  assert.match(source, /verifyNarrationMixWindows\(\{/u);
  assert.match(source, /assert\.notEqual\(narrationOn\.job\.id, baseline\.job\.id/u);

  // Independent oracles beyond the two renders themselves.
  assert.match(source, /assertManagedArtifactLedgerMatchesDisk\(root\)/u);
  assert.match(source, /installTransientRenderErrorLedger\(\)/u);
  assert.match(source, /assertNoRenderFailure\(surface\)/u);

  for (const [label, forbidden] of [
    ['browser storage mutation', /\b(?:localStorage|sessionStorage|indexedDB)\b/u],
    ['private IPC', /__TAURI__|invokeDesktop|invokeCommand/u],
    ['native picker', /showOpen|showSave|input\s*\[\s*type\s*=\s*["']file/u],
    ['raw SQL mutation', /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|app_settings|projects|jobs)\b/iu],
    ['window movement', /setPosition|maximize|minimize|setFocus/u],
    ['fullscreen request', /requestFullscreen|exitFullscreen/u],
  ]) {
    assert.doesNotMatch(source, forbidden, `journey contains forbidden ${label}`);
  }
};

test('the journey proves an A/B narration-mix toggle on one project through public controls only', () => {
  const source = readFileSync(journeyPath, 'utf8');
  assertJourneyContract(source);
});

test('the contract fails when any one load-bearing comparison oracle is removed', () => {
  const source = readFileSync(journeyPath, 'utf8');
  for (const needle of [
    "verifyStructuralAudioParity({ withProbe, withoutProbe })",
    'verifyNarrationMixWindows({',
    'assertManagedArtifactLedgerMatchesDisk(root)',
    'narrationOn.job.id, baseline.job.id',
    "await setRenderSettings({",
  ]) {
    const weakened = source.replace(needle, '/* removed */');
    assert.notEqual(weakened, source, `mutation needle is stale: ${needle}`);
    assert.throws(() => assertJourneyContract(weakened), undefined, needle);
  }
});
