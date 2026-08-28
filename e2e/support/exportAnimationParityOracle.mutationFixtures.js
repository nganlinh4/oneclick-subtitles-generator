import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EXPORT_ANIMATION_PARITY_CASES,
  EXPORT_PARITY_FPS,
} from './exportAnimationParityOracle.js';
import { compareFrames } from './nativeMediaOracle.js';

/**
 * Shared fixture builders for exportAnimationParityOracle.mutation.test.mjs.
 *
 * Pulled out of the test file itself purely to keep that file under the project's 600-line file
 * budget (CLAUDE.md); this module has no `test()` calls of its own and is not a standalone suite.
 */

export const WIDTH = 480;
export const HEIGHT = 360;

export const rgba = (width = WIDTH, height = HEIGHT, value = 12) => {
  const bytes = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes[offset] = value;
    bytes[offset + 1] = value;
    bytes[offset + 2] = value;
    bytes[offset + 3] = 255;
  }
  return bytes;
};

export const paint = (bytes, width, { left, top, right, bottom, value = 245 }) => {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 4;
      bytes[offset] = value;
      bytes[offset + 1] = value;
      bytes[offset + 2] = value;
    }
  }
  return bytes;
};

// ---------------------------------------------------------------------------------------------
// Real-SSIM helper: writes minimal PPM (P6) files -- dependency-free, ffmpeg decodes them natively
// -- and reuses the oracle's own `compareFrames` (the exact FFmpeg SSIM filter the product's E2E
// harness uses to produce the `renderExport`/`mainExport`/`mainRender` scores fed into
// `verifyExportAnimationParityObservation`). This keeps the mutation suite honest: floor comparisons
// use MEASURED SSIM, not literals chosen to make a point. PPM instead of PNG because this checkout
// has no pngjs installed under e2e/node_modules (see the final report for that finding).
// ---------------------------------------------------------------------------------------------

let ppmDir = null;
const ppmScratch = () => {
  if (ppmDir === null) ppmDir = mkdtempSync(join(tmpdir(), 'osg-export-parity-mutation-'));
  return ppmDir;
};

const writePpm = (path, width, height, rgbaBytes) => {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii');
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let pixel = 0, si = 0, di = 0; pixel < width * height; pixel += 1, si += 4, di += 3) {
    rgb[di] = rgbaBytes[si];
    rgb[di + 1] = rgbaBytes[si + 1];
    rgb[di + 2] = rgbaBytes[si + 2];
  }
  writeFileSync(path, Buffer.concat([header, rgb]));
  return path;
};

let ppmCounter = 0;
export const realSsim = (leftRgba, rightRgba, width = WIDTH, height = HEIGHT) => {
  ppmCounter += 1;
  const leftPath = writePpm(join(ppmScratch(), `f${ppmCounter}-a.ppm`), width, height, leftRgba);
  const rightPath = writePpm(join(ppmScratch(), `f${ppmCounter}-b.ppm`), width, height, rightRgba);
  return compareFrames(leftPath, rightPath);
};

// ---------------------------------------------------------------------------------------------
// A minimal, always-valid observation baseline. Individual tests clone and mutate `regions` and
// `scores`; every other field stays internally consistent so a thrown assertion can only be coming
// from the mechanism under test.
// ---------------------------------------------------------------------------------------------

const probe = ({ width = 480, height = 360, fps = '30/1', duration = 19 } = {}) => ({
  streams: [
    { codec_type: 'video', width, height, avg_frame_rate: fps },
    {
      codec_type: 'audio', channels: 2, sample_rate: '48000', duration: String(duration),
      duration_ts: String(duration * 48_000), time_base: '1/48000',
    },
  ],
  format: { duration: String(duration), size: '440628' },
});

const sourceProbe = () => ({
  streams: [
    { codec_type: 'video', width: 320, height: 240, avg_frame_rate: '15/1' },
    {
      codec_type: 'audio', channels: 1, sample_rate: '44100', duration: '19',
      duration_ts: String(19 * 44_100), time_base: '1/44100',
    },
  ],
  format: { duration: '19', size: '250000' },
});

export const scoresFor = (renderExport, mainExport, mainRender = mainExport) => ({
  entry: {
    renderExport, sourceExport: 0.9, mainRender, mainExport,
    mainSourceSelected: 0.98, renderSourceSelected: 0.98,
  },
  exit: {
    renderExport, sourceExport: 0.9, mainRender, mainExport,
    mainSourceSelected: 0.98, renderSourceSelected: 0.98,
  },
});

const durableCues = () => EXPORT_ANIMATION_PARITY_CASES.map(definition => ({
  text: definition.text,
  startMs: Math.round((definition.startFrame / EXPORT_PARITY_FPS) * 1_000),
  endMs: Math.round((definition.endFrame / EXPORT_PARITY_FPS) * 1_000),
}));

const measurement = ({ meanRgbDistance = 20, changedRatio = 0.5 } = {}) => ({
  pixels: 1_200,
  changedPixels: Math.round(1_200 * changedRatio),
  changedRatio,
  meanRgbDistance,
  maximumChannelDelta: 48,
});

const temporalDelta = () => ({
  changedPixels: 8_000,
  changedRatio: 8_000 / 172_800,
  maximumChannelDelta: 140,
});

const phaseBindingFor = (definition) => ({
  frames: { entry: definition.entryFrame, exit: definition.exitFrame },
  publicSeeks: Object.fromEntries(['main', 'render'].map(surface => [surface, {
    entry: {
      frame: definition.entryFrame,
      seconds: definition.entryFrame / EXPORT_PARITY_FPS,
      keys: surface === 'main' ? ['ArrowRight', 'ArrowLeft'] : [],
    },
    exit: {
      frame: definition.exitFrame,
      seconds: definition.exitFrame / EXPORT_PARITY_FPS,
      keys: surface === 'main' ? ['ArrowRight', 'ArrowLeft'] : [],
    },
  }])),
  hashes: Object.fromEntries(['main', 'render', 'exported', 'independentSource'].map(
    (surface, index) => [surface, {
      entry: String(index + 1).repeat(64),
      exit: String(index + 5).repeat(64),
    }],
  )),
  deltas: Object.fromEntries(['main', 'render', 'exported', 'independentSource'].map(
    surface => [surface, temporalDelta()],
  )),
});

const durableOwnership = () => ({
  projects: [{ id: '1'.repeat(32) }],
  media: [{
    id: '2'.repeat(32), display_name: 'selected-source.mp4', size_bytes: 250_000,
    content_hash: '3'.repeat(64),
  }],
  links: [{ project_id: '1'.repeat(32), media_id: '2'.repeat(32), role: 'primary' }],
  sourceFiles: [{
    media_id: '2'.repeat(32), available: true, size_bytes: 250_000, sha256: '4'.repeat(64),
  }],
});

const exportOwnership = () => ({
  jobs: [{ id: '5'.repeat(32), kind: 'renderVideo', state: 'succeeded' }],
  artifacts: [{
    id: '6'.repeat(32), project_id: '1'.repeat(32), job_id: '5'.repeat(32),
    kind: 'renderedVideo', state: 'ready', size_bytes: 440_628,
  }],
  durableArtifact: { sizeBytes: 440_628, sha256: '7'.repeat(64) },
  customerSave: { sizeBytes: 440_628, sha256: '7'.repeat(64) },
  expectedJobId: '5'.repeat(32),
  expectedArtifactId: '6'.repeat(32),
});

/** A default region: strong, correctly-placed, correctly-sized ink -- passes every check. */
export const goodRegion = (overrides = {}) => ({
  width: WIDTH,
  height: HEIGHT,
  totalPixels: WIDTH * HEIGHT,
  subtitleMaskPixels: 9_000,
  subtitleMaskRatio: 9_000 / (WIDTH * HEIGHT),
  roiPixels: 12_000,
  roiRatio: 12_000 / (WIDTH * HEIGHT),
  mainMaskPixels: 8_800,
  renderMaskPixels: 8_900,
  exportMaskPixels: 8_850,
  exportMaskRatio: 8_850 / (WIDTH * HEIGHT),
  exportSubtitleMaskCoverage: 0.9,
  exportMainMaskCoverage: 0.9,
  exportRenderMaskCoverage: 0.9,
  mainRenderMaskOverlap: 0.85,
  maskSignature: 'aaaaaaaa',
  maskCentroid: { x: 240, y: 300 },
  mainMaskCentroid: { x: 240, y: 300 },
  renderMaskCentroid: { x: 240, y: 300 },
  pairs: {
    mainRender: measurement({ meanRgbDistance: 5, changedRatio: 0.05 }),
    mainExport: measurement({ meanRgbDistance: 5, changedRatio: 0.05 }),
    renderExport: measurement({ meanRgbDistance: 5, changedRatio: 0.05 }),
  },
  signals: {
    mainIndependentSource: measurement({ meanRgbDistance: 22, changedRatio: 0.55 }),
    renderIndependentSource: measurement({ meanRgbDistance: 21, changedRatio: 0.53 }),
    exportIndependentSource: measurement({ meanRgbDistance: 20, changedRatio: 0.51 }),
  },
  ...overrides,
});

export const baseline = (definition = EXPORT_ANIMATION_PARITY_CASES[0]) => ({
  definition,
  probe: probe(),
  sourceProbe: sourceProbe(),
  durableScene: {
    projectId: '1'.repeat(32),
    sceneRevision: 12,
    scene: {
      renderSettings: { resolution: '360p', frameRate: EXPORT_PARITY_FPS },
      customization: { ...definition.customization },
    },
  },
  durableCues: durableCues(),
  scores: scoresFor(0.97, 0.96),
  // Distinct signatures: rotate/bounce/flip phase-behavior checks require entry !== exit ink.
  regions: { entry: goodRegion({ maskSignature: 'aaaaaaaa' }), exit: goodRegion({ maskSignature: 'bbbbbbbb' }) },
  phaseBinding: phaseBindingFor(definition),
  durableOwnership: durableOwnership(),
  selectedSourceIdentity: { displayName: 'selected-source.mp4', sizeBytes: 250_000, sha256: '4'.repeat(64) },
  exportOwnership: exportOwnership(),
  audioSignals: {
    source: { meanVolumeDb: -24, peakVolumeDb: -3, samples: 837_900 },
    exported: { meanVolumeDb: -24.5, peakVolumeDb: -3.5, samples: 912_000 },
  },
});

export const rotateDefinition = EXPORT_ANIMATION_PARITY_CASES.find(entry => entry.animationType === 'rotate');
export const case03Definition = EXPORT_ANIMATION_PARITY_CASES.find(entry => entry.id === '03-slide-down-arabic-glow');
