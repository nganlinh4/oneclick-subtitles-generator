#!/usr/bin/env node
// Freeze the subtitle math that the native renderer must reproduce.
//
// The fixture is generated from the CURRENT shipped implementation, by bundling the real TypeScript
// source rather than reimplementing it, so it records behaviour as it actually is — including the
// quirks the migration has to decide about deliberately. Both the TypeScript and the Rust renderer
// assert against this one file, which is what locks them to each other.
//
// Regenerate deliberately, never to make a failing test pass:
//   node scripts/generate-render-parity-fixture.mjs

import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_PATH = join(
  REPOSITORY_ROOT,
  'crates/osg-scene/tests/fixtures/subtitle-math-golden.json',
);

const SOURCES = {
  easing: 'video-renderer/src/subtitleAnimationEasing.ts',
  visualMath: 'video-renderer/src/subtitleVisualMath.ts',
};

// Progress samples: the boundaries, the piecewise split, and values chosen to expose rounding.
const PROGRESS_SAMPLES = [
  -1, -0.0001, 0, 0.0001, 0.01, 0.1, 0.25, 0.3333333333333333, 0.49999999999999994, 0.5,
  0.5000000000000001, 0.6666666666666666, 0.75, 0.9, 0.99, 0.9999, 1, 1.0001, 2,
];

// Scale samples: reference height, every shipped resolution height, and values whose exact decimal
// lands on a rounding boundary.
const SCALE_VALUES = [
  0, 1, 8, 12, 16, 24, 28, 32, 48, 64, 100, 120, 0.5, 1.005, 2.675, 8.125, 1.115, -28, 1000,
];
const SCALE_HEIGHTS = [360, 480, 720, 1080, 1440, 2160, 3840, 1081, 1079];

// Bit patterns, not decimals. A parity fixture that round-trips through decimal text inherits the
// disagreements of two float parsers; the IEEE-754 bits are what both sides must actually agree on.
const bitsOf = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};

const bundleModule = async (relativePath, temporaryDirectory) => {
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

const main = async () => {
  const temporaryDirectory = mkdtempSync(join(require('node:os').tmpdir(), 'osg-parity-'));
  try {
    const easingModule = await bundleModule(SOURCES.easing, temporaryDirectory);
    const visualMathModule = await bundleModule(SOURCES.visualMath, temporaryDirectory);

    const easings = easingModule.SUBTITLE_ANIMATION_EASINGS;
    if (!Array.isArray(easings) || easings.length === 0) {
      throw new Error('The easing catalog is empty; refusing to write an empty fixture');
    }

    const easingSamples = [];
    // 'unknown-easing' pins the documented fall-through to linear.
    for (const easing of [...easings, 'unknown-easing']) {
      for (const progress of PROGRESS_SAMPLES) {
        const eased = easingModule.applySubtitleAnimationEasing(progress, easing);
        easingSamples.push({
          easing,
          progress,
          progressBits: bitsOf(progress),
          eased,
          easedBits: bitsOf(eased),
        });
      }
    }

    const scaleSamples = [];
    for (const value of SCALE_VALUES) {
      for (const compositionHeight of SCALE_HEIGHTS) {
        const scaled = visualMathModule.scaleSubtitleStyleValue(value, compositionHeight);
        scaleSamples.push({
          value,
          valueBits: bitsOf(value),
          compositionHeight,
          compositionHeightBits: bitsOf(compositionHeight),
          scaled,
          scaledBits: bitsOf(scaled),
        });
      }
    }

    const fixture = {
      schemaVersion: 1,
      generatedFrom: SOURCES,
      note: 'Generated from the shipped implementation. Do not hand-edit to make a test pass.',
      easings: [...easings],
      easingSamples,
      scaleSamples,
    };

    mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
    const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
    let previous = null;
    try {
      previous = readFileSync(FIXTURE_PATH, 'utf8');
    } catch {
      // A first generation has nothing to compare against.
    }
    writeFileSync(FIXTURE_PATH, serialized, 'utf8');
    process.stdout.write(
      `${previous === serialized ? 'unchanged' : 'wrote'} ${FIXTURE_PATH}\n`
        + `  ${easingSamples.length} easing samples across ${easings.length + 1} curves\n`
        + `  ${scaleSamples.length} scale samples\n`,
    );
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
};

await main();
