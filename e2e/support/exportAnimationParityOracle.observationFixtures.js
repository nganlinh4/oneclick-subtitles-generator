// Observation and RGBA fixtures shared by the export parity oracle tests: a complete passing
// observation plus painted-pixel ROI builders.

import {
  EXPORT_ANIMATION_PARITY_CASES,
  EXPORT_PARITY_FPS,
  analyzeSubtitleParityRgba,
} from './exportAnimationParityOracle.js';

export const probe = ({ width = 480, height = 360, fps = '30/1', duration = 19 } = {}) => ({
  streams: [
    { codec_type: 'video', width, height, avg_frame_rate: fps },
    {
      codec_type: 'audio', channels: 2, sample_rate: '48000', duration: String(duration),
      duration_ts: String(duration * 48_000), time_base: '1/48000',
    },
  ],
  format: { duration: String(duration), size: '440628' },
});

const sourceProbe = ({ duration = 19 } = {}) => ({
  streams: [
    { codec_type: 'video', width: 320, height: 240, avg_frame_rate: '15/1' },
    {
      codec_type: 'audio', channels: 1, sample_rate: '44100', duration: String(duration),
      duration_ts: String(duration * 44_100), time_base: '1/44100',
    },
  ],
  format: { duration: String(duration), size: '250000' },
});

export const scene = (definition) => ({
  projectId: '1'.repeat(32),
  sceneRevision: 12,
  scene: {
    renderSettings: { resolution: '360p', frameRate: EXPORT_PARITY_FPS },
    customization: { ...definition.customization },
  },
});

export const scores = () => ({
  entry: {
    renderExport: 0.98, sourceExport: 0.92, mainRender: 0.94, mainExport: 0.96,
    mainSourceSelected: 0.98, renderSourceSelected: 0.98,
  },
  exit: {
    renderExport: 0.97, sourceExport: 0.91, mainRender: 0.93, mainExport: 0.95,
    mainSourceSelected: 0.98, renderSourceSelected: 0.98,
  },
});

const durableCues = () => EXPORT_ANIMATION_PARITY_CASES.map(definition => ({
  text: definition.text,
  startMs: Math.round(definition.startFrame / EXPORT_PARITY_FPS * 1_000),
  endMs: Math.round(definition.endFrame / EXPORT_PARITY_FPS * 1_000),
}));

const measurement = ({ meanRgbDistance = 4, changedRatio = 0.08 } = {}) => ({
  pixels: 1_200,
  changedPixels: Math.round(1_200 * changedRatio),
  changedRatio,
  meanRgbDistance,
  maximumChannelDelta: 48,
});

export const region = ({ signature = '1a2b3c4d', centroid = { x: 240, y: 300 } } = {}) => ({
  width: 480,
  height: 360,
  totalPixels: 172_800,
  subtitleMaskPixels: 480,
  subtitleMaskRatio: 480 / 172_800,
  roiPixels: 1_200,
  roiRatio: 1_200 / 172_800,
  mainMaskPixels: 450,
  renderMaskPixels: 460,
  exportMaskPixels: 455,
  exportMaskRatio: 455 / 172_800,
  exportSubtitleMaskCoverage: 0.90,
  exportMainMaskCoverage: 0.88,
  exportRenderMaskCoverage: 0.86,
  mainRenderMaskOverlap: 0.82,
  maskSignature: signature,
  maskCentroid: centroid,
  mainMaskCentroid: { x: centroid.x - 2, y: centroid.y + 1 },
  renderMaskCentroid: { x: centroid.x + 2, y: centroid.y - 1 },
  exportMaskCentroid: centroid,
  pairs: {
    mainRender: measurement(),
    mainExport: measurement(),
    renderExport: measurement(),
  },
  signals: {
    mainIndependentSource: measurement({ meanRgbDistance: 22, changedRatio: 0.55 }),
    renderIndependentSource: measurement({ meanRgbDistance: 21, changedRatio: 0.53 }),
    exportIndependentSource: measurement({ meanRgbDistance: 20, changedRatio: 0.51 }),
  },
});

export const regions = () => ({
  entry: region({ signature: '11111111' }),
  exit: region({ signature: '22222222' }),
});

const temporalDelta = () => ({
  changedPixels: 8_000,
  changedRatio: 8_000 / 172_800,
  maximumChannelDelta: 140,
});

const phaseBinding = (definition = EXPORT_ANIMATION_PARITY_CASES[0]) => ({
  frames: { entry: definition.entryFrame, exit: definition.exitFrame },
  // Main proves its grid landing with a bounded arrow correction; the Render native range commits
  // the exact rational value directly and legitimately records no keys.
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
    id: '2'.repeat(32),
    display_name: 'selected-source.mp4',
    size_bytes: 250_000,
    content_hash: '3'.repeat(64),
  }],
  links: [{ project_id: '1'.repeat(32), media_id: '2'.repeat(32), role: 'primary' }],
  sourceFiles: [{
    media_id: '2'.repeat(32), available: true, size_bytes: 250_000, sha256: '4'.repeat(64),
  }],
});

const selectedSourceIdentity = () => ({
  displayName: 'selected-source.mp4',
  sizeBytes: 250_000,
  sha256: '4'.repeat(64),
});

const audioSignals = () => ({
  source: { meanVolumeDb: -24, peakVolumeDb: -3, samples: 837_900 },
  exported: { meanVolumeDb: -24.5, peakVolumeDb: -3.5, samples: 912_000 },
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

export const observation = (definition = EXPORT_ANIMATION_PARITY_CASES[0]) => ({
  definition,
  probe: probe(),
  sourceProbe: sourceProbe(),
  durableScene: scene(definition),
  durableCues: durableCues(),
  scores: scores(),
  regions: regions(),
  phaseBinding: phaseBinding(definition),
  durableOwnership: durableOwnership(),
  selectedSourceIdentity: selectedSourceIdentity(),
  exportOwnership: exportOwnership(),
  audioSignals: audioSignals(),
});

export const rgba = (width, height, value = 12) => {
  const bytes = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes[offset] = value;
    bytes[offset + 1] = value;
    bytes[offset + 2] = value;
    bytes[offset + 3] = 255;
  }
  return bytes;
};

const paint = (bytes, width, { left, top, right, bottom, value = 245 }) => {
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

export const pixelRegion = ({ blankMain = false, shiftedExport = false, partialExport = false } = {}) => {
  const width = 480;
  const height = 360;
  const independentSource = rgba(width, height);
  const mainSource = rgba(width, height);
  const renderSource = rgba(width, height);
  const main = rgba(width, height);
  const render = rgba(width, height);
  const exported = rgba(width, height);
  const subtitle = {
    left: 220, top: 300, right: 236, bottom: 308,
    ...(partialExport ? { value: 42 } : {}),
  };
  if (!blankMain) paint(main, width, subtitle);
  paint(render, width, subtitle);
  paint(exported, width, shiftedExport
    ? { left: 0, top: 0, right: 16, bottom: 8 }
    : partialExport
      ? { ...subtitle, right: subtitle.left + 5, value: 42 }
      : subtitle);
  return analyzeSubtitleParityRgba({
    width, height, independentSource, mainSource, renderSource, main, render, exported,
  });
};

export const sourceOnlyColorShiftRegion = () => {
  const width = 480;
  const height = 360;
  const independentSource = rgba(width, height, 12);
  const mainSource = rgba(width, height, 12);
  const renderSource = rgba(width, height, 12);
  const main = rgba(width, height, 12);
  const render = rgba(width, height, 12);
  const exported = rgba(width, height, 32);
  const subtitle = { left: 200, top: 290, right: 240, bottom: 305, value: 42 };
  paint(main, width, subtitle);
  paint(render, width, subtitle);
  return analyzeSubtitleParityRgba({
    width, height, independentSource, mainSource, renderSource, main, render, exported,
  });
};
