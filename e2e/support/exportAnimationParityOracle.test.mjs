import { strict as assert } from 'node:assert';
import test from 'node:test';

/* global structuredClone */

import {
  EXPORT_ANIMATION_PARITY_CASES,
  EXPORT_PARITY_FPS,
  analyzeSubtitleParityRgba,
  buildExportAnimationParitySrt,
  parseFfprobeRate,
  validateExportAnimationParityMatrix,
  verifyExportAnimationParityObservation,
} from './exportAnimationParityOracle.js';
import { parseVolumeDetect } from './nativeMediaOracle.js';

const cloneCases = () => structuredClone(EXPORT_ANIMATION_PARITY_CASES);

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

const scene = (definition) => ({
  projectId: '1'.repeat(32),
  sceneRevision: 12,
  scene: {
    renderSettings: { resolution: '360p', frameRate: EXPORT_PARITY_FPS },
    customization: { ...definition.customization },
  },
});

const scores = () => ({
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

const region = ({ signature = '1a2b3c4d', centroid = { x: 240, y: 300 } } = {}) => ({
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
  mainRenderMaskOverlap: 0.82,
  maskSignature: signature,
  maskCentroid: centroid,
  mainMaskCentroid: { x: centroid.x - 2, y: centroid.y + 1 },
  renderMaskCentroid: { x: centroid.x + 2, y: centroid.y - 1 },
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

const regions = () => ({
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

const observation = (definition = EXPORT_ANIMATION_PARITY_CASES[0]) => ({
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

test('the matrix is exactly ten animations with disjoint rational fade samples', () => {
  assert.equal(validateExportAnimationParityMatrix().length, 10);
  const srt = buildExportAnimationParitySrt();
  assert.equal((srt.match(/ --> /gu) ?? []).length, 10);
  assert.match(srt, /Tiếng Việt/u);
  assert.match(srt, /한국어/u);
  assert.match(srt, /النص العربي/u);
  assert.match(srt, /👩‍💻/u);
});

test('duplicate or missing animation coverage is refused', () => {
  const cases = cloneCases();
  cases[9].animationType = cases[0].animationType;
  assert.throws(() => validateExportAnimationParityMatrix(cases), /animation coverage changed/u);
});

test('all five border styles must remain represented exactly twice', () => {
  const cases = cloneCases();
  cases[9].borderStyle = 'solid';
  cases[9].customization.borderStyle = 'solid';
  cases[9].customization.borderWidth = 4;
  assert.throws(
    () => validateExportAnimationParityMatrix(cases),
    /solid must have exactly two cases/u,
  );
});

test('language, shaping, wrapping and effect coverage cannot silently disappear', () => {
  for (const mutation of [
    (cases) => { cases[0].textFeatures = []; },
    (cases) => { cases[9].textFeatures = []; },
    (cases) => {
      for (const entry of cases) {
        entry.effects = entry.effects.filter(effect => effect !== 'stroke');
        entry.customization.strokeEnabled = false;
      }
    },
  ]) {
    const cases = cloneCases();
    mutation(cases);
    assert.throws(
      () => validateExportAnimationParityMatrix(cases),
      /(?:text feature|effect) is uncovered/u,
    );
  }
});

test('samples outside a true fade phase or off the exact SRT grid are refused', () => {
  const outside = cloneCases();
  outside[0].entryFrame = outside[0].startFrame;
  assert.throws(
    () => validateExportAnimationParityMatrix(outside),
    /entry sample offset changed/u,
  );

  const rounded = cloneCases();
  rounded[0].startFrame += 1;
  assert.throws(() => validateExportAnimationParityMatrix(rounded), /SRT milliseconds/u);
});

test('ffprobe rates accept only positive exact rational strings', () => {
  assert.deepEqual(parseFfprobeRate('30000/1001'), {
    numerator: 30000,
    denominator: 1001,
    value: 30000 / 1001,
  });
  for (const hostile of ['30', '30/0', '-30/1', 'nan/1', '', null]) {
    assert.equal(parseFfprobeRate(hostile), null);
  }
});

test('FFmpeg volume evidence parses real levels and preserves explicit silence', () => {
  assert.deepEqual(parseVolumeDetect([
    '[Parsed_volumedetect_0] n_samples: 912000',
    '[Parsed_volumedetect_0] mean_volume: -24.5 dB',
    '[Parsed_volumedetect_0] max_volume: -3.5 dB',
  ].join('\n')), { samples: 912_000, meanVolumeDb: -24.5, peakVolumeDb: -3.5 });
  assert.deepEqual(parseVolumeDetect([
    'n_samples: 912000', 'mean_volume: -inf dB', 'max_volume: -inf dB',
  ].join('\n')), {
    samples: 912_000,
    meanVolumeDb: Number.NEGATIVE_INFINITY,
    peakVolumeDb: Number.NEGATIVE_INFINITY,
  });
  assert.throws(() => parseVolumeDetect('max_volume: -3 dB'), /no bounded audio-energy/u);
  // FFmpeg 8 flushes a sample-less graph-setup instance before the instance that saw the audio;
  // the final flush is the measurement.
  assert.deepEqual(parseVolumeDetect([
    '[Parsed_volumedetect_0 @ 0x1] n_samples: 0',
    'Stream mapping:',
    '[Parsed_volumedetect_0 @ 0x2] n_samples: 1825248',
    '[Parsed_volumedetect_0 @ 0x2] mean_volume: -25.9 dB',
    '[Parsed_volumedetect_0 @ 0x2] max_volume: -7.4 dB',
  ].join('\n')), { samples: 1_825_248, meanVolumeDb: -25.9, peakVolumeDb: -7.4 });
});

test('a complete decoded, durable and pixel-matched observation passes', () => {
  const definition = EXPORT_ANIMATION_PARITY_CASES[0];
  const observed = verifyExportAnimationParityObservation(observation(definition));
  assert.deepEqual(observed.dimensions, [480, 360]);
  assert.equal(observed.audioChannels, 2);
  assert.equal(observed.audioSampleRate, 48_000);
});

test('missing audio, wrong dimensions, fps or duration can never pass', () => {
  const definition = EXPORT_ANIMATION_PARITY_CASES[0];
  const valid = observation(definition);
  const noAudio = structuredClone(valid.probe);
  noAudio.streams = noAudio.streams.filter(stream => stream.codec_type !== 'audio');
  assert.throws(() => verifyExportAnimationParityObservation({ ...valid, probe: noAudio }), /audio stream/u);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, probe: probe({ width: 640 }),
  }), /source aspect/u);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, probe: probe({ fps: '25/1' }),
  }), /fps numerator/u);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, probe: probe({ duration: 18.5 }),
  }), /disagrees/u);
});

test('source-closer pixels, durable drift and transient errors are hard failures', () => {
  const definition = EXPORT_ANIMATION_PARITY_CASES[0];
  const valid = observation(definition);
  // A faint sample can legitimately rank the export closer to source-only in whole-frame SSIM
  // (each pair's resampling path dominates), so no "closer" tiebreak exists; missing export ink
  // is caught by the ROI mask claims, proven in their own tests. These real measured scores from
  // a correct faint frame must pass.
  const faintButCorrect = scores();
  faintButCorrect.entry = {
    renderExport: 0.966282, sourceExport: 0.973175, mainRender: 0.94, mainExport: 0.95,
    mainSourceSelected: 0.98, renderSourceSelected: 0.98,
  };
  verifyExportAnimationParityObservation({ ...valid, scores: faintButCorrect });
  const drifted = scene(definition);
  drifted.scene.customization.animationType = 'rotate';
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, durableScene: drifted,
  }), /animationType drifted/u);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, recordedProblems: ['fontUnavailable'],
  }), /transient refusal/u);
});

test('wrong active media or project ownership cannot hide behind internally consistent previews', () => {
  const valid = observation();
  const wrongBackground = structuredClone(valid.scores);
  wrongBackground.entry.mainSourceSelected = 0.45;
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, scores: wrongBackground,
  }), /Main is showing another source/u);

  const wrongProject = structuredClone(valid.durableOwnership);
  wrongProject.links[0].project_id = 'f'.repeat(32);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, durableOwnership: wrongProject,
  }), /media link belongs to another project/u);

  const wrongBytes = structuredClone(valid.selectedSourceIdentity);
  wrongBytes.sizeBytes += 1;
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, selectedSourceIdentity: wrongBytes,
  }), /active media bytes do not match/u);

  const hashCollision = structuredClone(valid.selectedSourceIdentity);
  hashCollision.sha256 = '5'.repeat(64);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, selectedSourceIdentity: hashCollision,
  }), /durable source bytes do not match/u);

  const wrongLocationOwner = structuredClone(valid.durableOwnership);
  wrongLocationOwner.sourceFiles[0].media_id = 'f'.repeat(32);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, durableOwnership: wrongLocationOwner,
  }), /durable source belongs to another media asset/u);

  const wrongOutputProject = structuredClone(valid.exportOwnership);
  wrongOutputProject.artifacts[0].project_id = 'e'.repeat(32);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, exportOwnership: wrongOutputProject,
  }), /rendered artifact belongs to another project/u);

  const staleCustomerSave = structuredClone(valid.exportOwnership);
  staleCustomerSave.customerSave.sha256 = '8'.repeat(64);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, exportOwnership: staleCustomerSave,
  }), /customer save does not match/u);
});

const rgba = (width, height, value = 12) => {
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

const pixelRegion = ({ blankMain = false, shiftedExport = false, partialExport = false } = {}) => {
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

const sourceOnlyColorShiftRegion = () => {
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

test('the independent subtitle ROI proves Main, Render and export contain matching pixels', () => {
  const measured = pixelRegion();
  assert.equal(measured.mainMaskPixels, 128);
  assert.equal(measured.renderMaskPixels, 128);
  assert.equal(measured.exportMaskPixels, 128);
  assert.equal(measured.mainRenderMaskOverlap, 1);
  assert.equal(measured.pairs.mainExport.changedPixels, 0);
  assert.ok(measured.signals.mainIndependentSource.meanRgbDistance > 2);
});

test('missing Main subtitles and spatially wrong export text cannot hide in whole-frame SSIM', () => {
  const valid = observation();
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid,
    regions: { entry: pixelRegion({ blankMain: true }), exit: valid.regions.exit },
  }), /Main has no subtitle mask/u);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid,
    regions: { entry: pixelRegion({ shiftedExport: true }), exit: valid.regions.exit },
  }), /(?:mean ROI distance|changed .*subtitle ROI|covers only .*subtitle mask)/u);
});

test('a low-opacity subtitle fragment cannot satisfy a whole-frame or loose ROI oracle', () => {
  const valid = observation();
  const partial = pixelRegion({ partialExport: true });
  assert.ok(partial.exportSubtitleMaskCoverage > 0.30, (
    'hostile fragment must demonstrate that the previous coverage floor would pass'
  ));
  assert.ok(partial.pairs.mainExport.meanRgbDistance < 30);
  assert.ok(partial.pairs.mainExport.changedRatio < 0.65);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, regions: { entry: partial, exit: partial },
  }), /covers only .*subtitle mask/u);
});

test('six identical source-only frames cannot manufacture a subtitle ROI', () => {
  const width = 480;
  const height = 360;
  const source = rgba(width, height);
  const identical = analyzeSubtitleParityRgba({
    width,
    height,
    independentSource: source,
    mainSource: source,
    renderSource: source,
    main: source,
    render: source,
    exported: source,
  });
  assert.equal(identical.subtitleMaskPixels, 0);
  assert.equal(identical.roiPixels, 0);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...observation(), regions: { entry: identical, exit: regions().exit },
  }), /subtitle mask has only 0 pixels/u);
});

test('a broad color-path shift cannot masquerade as a localized exported subtitle', () => {
  const valid = observation();
  const shifted = sourceOnlyColorShiftRegion();
  assert.equal(shifted.exportMaskRatio, 1, 'hostile export must differ across the whole source frame');
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid,
    regions: { entry: shifted, exit: shifted },
  }), /cannot prove a localized subtitle composition/u);
});

test('entry and exit must bind to distinct bytes and independently changing source frames', () => {
  const valid = observation();
  const sameHash = structuredClone(valid.phaseBinding);
  sameHash.hashes.exported.exit = sameHash.hashes.exported.entry;
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, phaseBinding: sameHash,
  }), /exported entry\/exit artifacts are identical/u);

  const frozenSource = structuredClone(valid.phaseBinding);
  frozenSource.deltas.independentSource = {
    changedPixels: 0, changedRatio: 0, maximumChannelDelta: 0,
  };
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, phaseBinding: frozenSource,
  }), /independentSource entry\/exit frames are not materially distinct/u);

  const wrongFrame = structuredClone(valid.phaseBinding);
  wrongFrame.frames.entry += 3;
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, phaseBinding: wrongFrame,
  }), /bound to the wrong frame/u);

  const privateSeek = structuredClone(valid.phaseBinding);
  privateSeek.publicSeeks.main.entry.keys = [];
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, phaseBinding: privateSeek,
  }), /lacks its expected public seek proof shape/u);

  const renderKeyboard = structuredClone(valid.phaseBinding);
  renderKeyboard.publicSeeks.render.exit.keys = ['ArrowRight'];
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, phaseBinding: renderKeyboard,
  }), /lacks its expected public seek proof shape/u);
});

test('implausible or truncated ffprobe audio is a hard failure', () => {
  const valid = observation();
  const oneHertz = structuredClone(valid.probe);
  Object.assign(oneHertz.streams.find(stream => stream.codec_type === 'audio'), {
    sample_rate: '1', duration: '19',
  });
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, probe: oneHertz,
  }), /audio sample rate is invalid/u);

  const truncated = structuredClone(valid.probe);
  Object.assign(truncated.streams.find(stream => stream.codec_type === 'audio'), {
    duration: '0.001', duration_ts: '48', time_base: '1/48000',
  });
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, probe: truncated,
  }), /does not cover/u);

  const corruptTimebase = structuredClone(valid.probe);
  Object.assign(corruptTimebase.streams.find(stream => stream.codec_type === 'audio'), {
    time_base: '1/1',
  });
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, probe: corruptTimebase,
  }), /timebase .* does not cover/u);

  const silent = structuredClone(valid.audioSignals);
  silent.exported = { meanVolumeDb: -91, peakVolumeDb: -91, samples: 912_000 };
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, audioSignals: silent,
  }), /silent or effectively silent/u);

  const attenuated = structuredClone(valid.audioSignals);
  attenuated.exported = { meanVolumeDb: -37, peakVolumeDb: -16, samples: 912_000 };
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, audioSignals: attenuated,
  }), /fell more than 12 dB below source/u);
});

test('durable cue text and rational times cannot drift behind a convincing picture', () => {
  const valid = observation();
  const cues = structuredClone(valid.durableCues);
  cues[0].text = 'wrong subtitle';
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, durableCues: cues,
  }), /durable cue 0 text drifted/u);
});

test('mask agreement branches: strong masks demand overlap, faint masks demand co-location', () => {
  const definition = EXPORT_ANIMATION_PARITY_CASES[0];
  const valid = observation(definition);

  const strongLowOverlap = { entry: region(), exit: region() };
  strongLowOverlap.entry.mainMaskPixels = 5_000;
  strongLowOverlap.entry.renderMaskPixels = 5_200;
  strongLowOverlap.entry.mainRenderMaskOverlap = 0.22;
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, regions: strongLowOverlap,
  }), /subtitle-mask overlap .* is too low/u);

  // Faint masks carry no reliable geometry (their pixels are capture-path noise at the channel
  // threshold); their agreement is bounded by pairs.mainRender inside the ROI instead, so a low
  // exact overlap must be accepted there.
  const faintLowOverlap = { entry: region(), exit: region() };
  faintLowOverlap.entry.mainRenderMaskOverlap = 0.22;
  verifyExportAnimationParityObservation({ ...valid, regions: faintLowOverlap });
});
