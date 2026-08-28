import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  ASR_CATALOG_ENGINES,
  expectedCardStatesForPackagePresence,
  isTruthfulCardState,
  NARRATION_CATALOG_ENGINES,
  pickNotInstalledEngine,
  SETTLED_CARD_STATES,
} from './engineCatalogOracle.js';

test('the ASR catalog mirror matches crates/osg-asr/src/catalog.rs:67-103 exactly', () => {
  assert.deepEqual(ASR_CATALOG_ENGINES.map(({ cardId }) => cardId), [
    'parakeet',
    'faster-whisper-turbo',
    'faster-whisper-large-v3',
    'qwen3-asr-1.7b',
    'qwen3-asr-0.6b',
  ]);
  // ASR card ids equal their native package id everywhere.
  for (const engine of ASR_CATALOG_ENGINES) assert.equal(engine.packageId, engine.cardId);
  assert.deepEqual(
    ASR_CATALOG_ENGINES.filter((engine) => engine.proven).map(({ cardId }) => cardId),
    ['faster-whisper-turbo'],
    'only Faster-Whisper Turbo has a green real-binary local ASR generation journey',
  );
});

test('the narration catalog mirror matches crates/osg-speech/src/types.rs:11-17 and managedEngineCatalog.js', () => {
  assert.deepEqual(NARRATION_CATALOG_ENGINES.map(({ cardId }) => cardId), [
    'f5tts', 'chatterbox', 'edge-tts', 'gtts', 'gemini-tts',
  ]);
  assert.deepEqual(NARRATION_CATALOG_ENGINES.map(({ packageId }) => packageId), [
    'f5-tts', 'chatterbox', 'edge-tts', 'gtts', 'gemini-tts',
  ]);
  assert.deepEqual(
    NARRATION_CATALOG_ENGINES.filter((engine) => engine.proven).map(({ cardId }) => cardId),
    ['edge-tts', 'gtts'],
    'gTTS is proven by narrationGeneration.journey.js and edge-tts by edgeTtsNarrationGeneration.journey.js',
  );
});

test('every catalog entry is frozen and every list is frozen (accidental mutation would silently drift from the Rust catalog)', () => {
  for (const list of [ASR_CATALOG_ENGINES, NARRATION_CATALOG_ENGINES]) {
    assert.equal(Object.isFrozen(list), true);
    for (const entry of list) assert.equal(Object.isFrozen(entry), true);
  }
});

test('an installed package accepts exactly ready/installed-stopped/corrupt/update-available', () => {
  assert.deepEqual(
    expectedCardStatesForPackagePresence(true),
    ['ready', 'installed-stopped', 'corrupt', 'update-available'],
  );
  assert.equal(isTruthfulCardState('ready', true), true);
  assert.equal(isTruthfulCardState('installed-stopped', true), true);
  assert.equal(isTruthfulCardState('corrupt', true), true);
  assert.equal(isTruthfulCardState('update-available', true), true);
  assert.equal(isTruthfulCardState('not-installed', true), false, (
    'a package with real bytes on disk claiming not-installed would be a lying surface'
  ));
});

test('a missing package accepts exactly not-installed', () => {
  assert.deepEqual(expectedCardStatesForPackagePresence(false), ['not-installed']);
  assert.equal(isTruthfulCardState('not-installed', false), true);
  for (const lying of ['ready', 'installed-stopped', 'corrupt', 'update-available']) {
    assert.equal(isTruthfulCardState(lying, false), false, (
      `a package with no bytes on disk claiming ${lying} would be a lying surface`
    ));
  }
});

test('SETTLED_CARD_STATES excludes the transient checking/status-error probe states', () => {
  assert.equal(SETTLED_CARD_STATES.includes('checking'), false);
  assert.equal(SETTLED_CARD_STATES.includes('status-error'), false);
  assert.equal(SETTLED_CARD_STATES.includes('not-installed'), true);
  assert.equal(SETTLED_CARD_STATES.includes('ready'), true);
});

test('pickNotInstalledEngine finds the first catalog entry with no on-disk directory', () => {
  const exists = new Set(['faster-whisper-turbo']);
  const picked = pickNotInstalledEngine(ASR_CATALOG_ENGINES, (id) => exists.has(id));
  assert.equal(picked.cardId, 'parakeet');
});

test('pickNotInstalledEngine returns null when every catalog entry is already installed', () => {
  const allInstalled = ASR_CATALOG_ENGINES.map(({ packageId }) => packageId);
  const picked = pickNotInstalledEngine(ASR_CATALOG_ENGINES, (id) => allInstalled.includes(id));
  assert.equal(picked, null);
});
