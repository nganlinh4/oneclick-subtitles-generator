// The other half of the parity lock.
//
// crates/osg-scene/tests/parity.rs asserts the Rust renderer against this fixture; this asserts the
// shipped TypeScript against the same file. Together they pin the two implementations to each other,
// so neither can drift silently while the native renderer replaces the old one.

import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = JSON.parse(readFileSync(
  join(REPOSITORY_ROOT, 'crates/osg-scene/tests/fixtures/subtitle-math-golden.json'),
  'utf8',
));

const bitsOf = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};

const fromBits = (hex) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
};

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'osg-parity-test-'));
const load = async (relativePath) => {
  const outfile = join(temporaryDirectory, `${relativePath.replace(/[^a-z0-9]+/gi, '_')}.mjs`);
  await build({
    entryPoints: [join(REPOSITORY_ROOT, relativePath)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
};

const easingModule = await load(FIXTURE.generatedFrom.easing);
const visualMathModule = await load(FIXTURE.generatedFrom.visualMath);

test.after(() => rmSync(temporaryDirectory, { force: true, recursive: true }));

test('the fixture is not vacuous', () => {
  assert.equal(FIXTURE.schemaVersion, 1);
  assert.ok(FIXTURE.easingSamples.length > 0, 'no easing samples');
  assert.ok(FIXTURE.scaleSamples.length > 0, 'no scale samples');
  assert.deepEqual(
    [...easingModule.SUBTITLE_ANIMATION_EASINGS],
    FIXTURE.easings,
    'the shipped easing catalog drifted from the fixture',
  );
});

test('the shipped easing reproduces every recorded sample bit for bit', () => {
  for (const sample of FIXTURE.easingSamples) {
    const eased = easingModule.applySubtitleAnimationEasing(
      fromBits(sample.progressBits),
      sample.easing,
    );
    assert.equal(
      bitsOf(eased),
      sample.easedBits,
      `${sample.easing} at progress ${sample.progress} produced ${eased}, fixture records ${sample.eased}`,
    );
  }
});

test('the shipped scaling reproduces every recorded sample bit for bit', () => {
  for (const sample of FIXTURE.scaleSamples) {
    const scaled = visualMathModule.scaleSubtitleStyleValue(
      fromBits(sample.valueBits),
      fromBits(sample.compositionHeightBits),
    );
    assert.equal(
      bitsOf(scaled),
      sample.scaledBits,
      `scaling ${sample.value} at height ${sample.compositionHeight} produced ${scaled},`
        + ` fixture records ${sample.scaled}`,
    );
  }
});
