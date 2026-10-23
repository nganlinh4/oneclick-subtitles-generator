import { strict as assert } from 'node:assert';
import test from 'node:test';

/* global structuredClone */

import {
  EXPORT_ANIMATION_PARITY_CASES,
  analyzeSubtitleParityRgba,
  verifyExportAnimationParityObservation,
} from './exportAnimationParityOracle.js';
import {
  observation, pixelRegion, probe, region, regions, rgba, scene, scores, sourceOnlyColorShiftRegion,
} from './exportAnimationParityOracle.observationFixtures.js';

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

  // Export coverage is judged against each real surface, not the divergence-inflated union:
  // measured capture-path differences may dilute one surface modestly, but an export cannot use
  // strong agreement with one surface to conceal substantial disagreement with the other.
  const unionDiluted = { entry: region(), exit: region() };
  unionDiluted.entry.exportSubtitleMaskCoverage = 0.496;
  unionDiluted.entry.exportMainMaskCoverage = 0.81;
  unionDiluted.entry.exportRenderMaskCoverage = 0.54;
  verifyExportAnimationParityObservation({ ...valid, regions: unionDiluted });

  const abandonsRenderSurface = { entry: region(), exit: region() };
  abandonsRenderSurface.entry.exportMainMaskCoverage = 1;
  abandonsRenderSurface.entry.exportRenderMaskCoverage = 0.49;
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, regions: abandonsRenderSurface,
  }), /weaker surface subtitle mask/u);

  const coversNeither = { entry: region(), exit: region() };
  coversNeither.entry.exportMainMaskCoverage = 0.40;
  coversNeither.entry.exportRenderMaskCoverage = 0.38;
  assert.throws(() => verifyExportAnimationParityObservation({
    ...valid, regions: coversNeither,
  }), /covers only .* of the stronger surface subtitle mask/u);
});
