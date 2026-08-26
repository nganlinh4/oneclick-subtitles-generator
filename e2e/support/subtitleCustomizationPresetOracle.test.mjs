import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildSync } from 'esbuild';

import {
  customizationDigest,
  SUBTITLE_PRESET_MATRIX,
  verifyExactWeightDropdown,
  verifyPresetObservation,
} from './subtitleCustomizationPresetOracle.js';

const clone = value => JSON.parse(JSON.stringify(value));

const loadShippedPresets = async () => {
  const supportRoot = dirname(fileURLToPath(import.meta.url));
  const source = buildSync({
    entryPoints: [join(
      supportRoot,
      '..',
      '..',
      'src',
      'components',
      'subtitleCustomization',
      'presetDefinitions.js',
    )],
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    write: false,
  }).outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};

test('freezes all 30 public presets in shipped button order and only ten review screenshots', () => {
  assert.equal(SUBTITLE_PRESET_MATRIX.length, 30);
  assert.deepEqual(
    SUBTITLE_PRESET_MATRIX.filter(({ captureScreenshot }) => captureScreenshot).map(({ name }) => name),
    ['Default', 'Modern', 'Classic', 'Neon', 'Minimal', 'Gaming', 'Cinematic', 'Retro', 'Comic', 'Vaporwave'],
  );
  assert.deepEqual(
    SUBTITLE_PRESET_MATRIX.map(({ index }) => index),
    Array.from({ length: 30 }, (_, index) => index + 1),
  );
  const artifacts = SUBTITLE_PRESET_MATRIX.map(({ nativeArtifactName }) => nativeArtifactName);
  const screenshots = SUBTITLE_PRESET_MATRIX
    .map(({ screenshotStep }) => screenshotStep)
    .filter(Boolean);
  assert.equal(new Set(artifacts).size, 30);
  assert.equal(new Set(screenshots).size, 10);
  assert.deepEqual(artifacts.filter(name => screenshots.includes(name)), []);
});

test('every frozen digest describes the complete shipped preset, not a hand-picked field subset', async () => {
  const { presetOrder, presets } = await loadShippedPresets();
  assert.deepEqual(presetOrder, SUBTITLE_PRESET_MATRIX.map(({ id }) => id));
  for (const preset of SUBTITLE_PRESET_MATRIX) {
    assert.equal(Object.keys(presets[preset.id]).length, 56, `${preset.name} field count drifted`);
    assert.equal(customizationDigest(presets[preset.id]), preset.digest, `${preset.name} digest drifted`);
  }
});

test('preset observation requires the active button, a newer durable revision, and every field', async () => {
  const { presets } = await loadShippedPresets();
  const preset = SUBTITLE_PRESET_MATRIX[0];
  const exactScene = {
    sceneRevision: 8,
    scene: { customization: clone(presets[preset.id]) },
  };
  assert.deepEqual(verifyPresetObservation({
    preset,
    activePreset: preset.name,
    activePresetId: preset.id,
    beforeSceneRevision: 7,
    durableScene: exactScene,
  }), {
    id: 'default',
    name: 'Default',
    beforeSceneRevision: 7,
    sceneRevision: 8,
    fieldCount: 56,
    digest: preset.digest,
  });

  assert.throws(() => verifyPresetObservation({
    preset,
    activePreset: 'Modern',
    activePresetId: preset.id,
    beforeSceneRevision: 7,
    durableScene: exactScene,
  }), /active public button/u);
  assert.throws(() => verifyPresetObservation({
    preset,
    activePreset: preset.name,
    activePresetId: 'modern',
    beforeSceneRevision: 7,
    durableScene: exactScene,
  }), /another preset ID/u);
  assert.throws(() => verifyPresetObservation({
    preset,
    activePreset: preset.name,
    activePresetId: preset.id,
    beforeSceneRevision: 8,
    durableScene: exactScene,
  }), /advance the durable scene revision/u);
  const incompleteScene = clone(exactScene);
  delete incompleteScene.scene.customization.textColor;
  assert.throws(() => verifyPresetObservation({
    preset,
    activePreset: preset.name,
    activePresetId: preset.id,
    beforeSceneRevision: 7,
    durableScene: incompleteScene,
  }), /exact 56-field definition/u);
});

test('exact-weight dropdown rejects hidden extra weights and a selected-state lie', () => {
  const exact = verifyExactWeightDropdown({
    expectedValues: [400, 700],
    currentValue: 700,
    options: [
      { label: 'Normal', selected: false, disabled: false },
      { label: 'Bold', selected: true, disabled: false },
    ],
  });
  assert.deepEqual(exact.values, ['400', '700']);

  assert.throws(() => verifyExactWeightDropdown({
    expectedValues: [400],
    currentValue: 400,
    options: [
      { label: 'Normal', selected: true, disabled: false },
      { label: 'Bold', selected: false, disabled: false },
    ],
  }), /expected exactly 1 renderer-backed weights/u);
  assert.throws(() => verifyExactWeightDropdown({
    expectedValues: [400],
    currentValue: 400,
    options: [{ label: 'Normal', selected: false, disabled: false }],
  }), /selected option disagrees/u);
});
