// The parity matrix must describe the real catalog, or the removal gate under-covers silently.
//
// The gate that authorises deleting the old renderer has to exercise all 30 shipped presets and all
// 70 persisted options. Those definitions live in JavaScript and the gate runs in Rust, so a
// generated fixture bridges them — and a generated fixture is exactly the kind of artifact that goes
// stale without anyone noticing. This checks the committed fixture still matches what the modules
// say today, so adding a preset or renaming a field fails here rather than quietly falling outside
// the gate.
//
// Regenerate with: node scripts/generate-parity-matrix.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_PATH = join(REPOSITORY_ROOT, 'crates/osg-export/tests/fixtures/parity-matrix.json');

const committed = () => JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

test('the committed matrix is what the generator produces today', () => {
  const before = readFileSync(FIXTURE_PATH, 'utf8');
  execFileSync(process.execPath, [join(REPOSITORY_ROOT, 'scripts/generate-parity-matrix.mjs')], {
    cwd: REPOSITORY_ROOT,
    stdio: 'pipe',
  });
  const after = readFileSync(FIXTURE_PATH, 'utf8');
  assert.equal(
    after,
    before,
    'the parity matrix is stale — regenerate it deliberately and review what changed',
  );
});

test('every shipped preset is present and fully merged', () => {
  const { presets, coverage } = committed();
  assert.equal(presets.length, 30, 'the migration was scoped against 30 shipped presets');
  assert.equal(coverage.presets, presets.length);

  for (const preset of presets) {
    assert.ok(preset.id, 'a preset must be identifiable');
    // Merged, not sparse: the gate renders what a user gets, and a preset stores only overrides.
    assert.equal(
      Object.keys(preset.customization).length,
      54,
      `${preset.id} must carry all 54 fields after merging`,
    );
  }

  const ids = presets.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, 'preset ids must be unique');
});

test('the matrix covers all 70 persisted options', () => {
  const { fieldMatrix, outputFields, coverage } = committed();
  assert.equal(fieldMatrix.length, 54);
  assert.equal(outputFields.length, 16);
  assert.equal(coverage.totalPersistedOptions, 70);

  for (const entry of fieldMatrix) {
    assert.ok(entry.values.length >= 1, `${entry.field} must contribute at least one render`);
    assert.ok(
      entry.values.some((value) => JSON.stringify(value) === JSON.stringify(entry.default)),
      `${entry.field} must render its default`,
    );
  }
});

test('the text set is not only Latin', () => {
  const { texts } = committed();
  const ids = texts.map((entry) => entry.id);
  // The removal gate is explicitly required to cover these, and a gate that only ever drew English
  // would pass while the feature was broken for most of the catalog's fonts.
  for (const required of ['korean', 'vietnamese', 'mixed-rtl', 'emoji']) {
    assert.ok(ids.includes(required), `the matrix must exercise ${required} text`);
  }
  for (const entry of texts) {
    assert.ok(entry.text.length > 0, `${entry.id} must carry text`);
  }
});

test('the output shapes span resolution and frame rate, including 4K and high fps', () => {
  const { outputs } = committed();
  const resolutions = new Set(outputs.map((output) => output.resolution));
  const rates = new Set(outputs.map((output) => output.frameRate));
  assert.ok(resolutions.has('4K'), 'the gate must render 4K');
  assert.ok(Math.max(...rates) >= 60, 'the gate must render a high frame rate');
  assert.ok(resolutions.size >= 3 && rates.size >= 3, 'shapes must actually vary');
});
