// Animation continuity oracle: per-phase timing, visible-sample completeness, playback
// continuity and phase-frame distinctness.

import { strict as assert } from 'node:assert';

import { easeSubtitle } from '../../src/components/previews/canvas/canvasSubtitleMath.js';

import {
  ANIMATION_CUE,
  ANIMATION_PHASES,
  MAXIMUM_CONTINUITY_PLATEAU_MS,
  activeAnimationCueAt,
  expectedAnimationCueAt,
} from './subtitleMaterialAnimationCases.js';

export const assertFrameProof = (proof, context) => {
  assert.ok(proof !== null && typeof proof === 'object', `${context}: frame proof is absent`);
  for (const [name, signal] of [['composed', proof.composedSignal], ['source', proof.sourceSignal]]) {
    assert.ok(signal?.totalPixels > 0, `${context}: ${name} signal is absent`);
    assert.ok(signal.opaqueRatio >= 0.99, `${context}: ${name} frame is unexpectedly transparent`);
    assert.ok(signal.nearBlackRatio < 0.985, `${context}: ${name} frame is a black target`);
    assert.ok(signal.meanLuma >= 2, `${context}: ${name} frame carries no measured light`);
  }
  assert.ok(proof.subtitlePixels?.changedPixels >= 64, `${context}: composed frame is source-only`);
  assert.ok(proof.subtitlePixels.changedRatio >= 0.000_1, `${context}: subtitle pixels are negligible`);
  assert.ok(proof.subtitlePixels.maximumChannelDelta >= 32, `${context}: subtitle contrast is negligible`);
  assert.equal(proof.subtitleGeometry?.changedPixels, proof.subtitlePixels.changedPixels, (
    `${context}: spatial and scalar pixel oracles disagree`
  ));
  assert.ok(Number.isFinite(proof.subtitleGeometry?.centroidXRatio), `${context}: subtitle has no X centroid`);
  assert.ok(Number.isFinite(proof.subtitleGeometry?.centroidYRatio), `${context}: subtitle has no Y centroid`);
  assert.ok(proof.subtitleGeometry?.bounds?.areaPixels >= proof.subtitleGeometry.changedPixels, (
    `${context}: subtitle bounds cannot contain its changed pixels`
  ));
  assert.ok(
    proof.subtitleGeometry.bounds.areaPixels
      < proof.subtitleGeometry.width * proof.subtitleGeometry.height * 0.9,
    `${context}: subtitle geometry is contaminated across the full composition`,
  );
  assert.ok(proof.subtitleGeometry.meanChangedChannelDelta > 0, `${context}: subtitle carries no pixel energy`);
};

export const longestPlateauMs = (samples, read) => {
  let longest = 0;
  let started = samples[0].atMs;
  let last = read(samples[0]);
  for (let index = 1; index < samples.length; index += 1) {
    const value = read(samples[index]);
    if (value > last) {
      longest = Math.max(longest, samples[index].atMs - started);
      started = samples[index].atMs;
      last = value;
    }
  }
  return Math.max(longest, samples.at(-1).atMs - started);
};

export const assertRecoveredMediaEvents = (events, context) => {
  assert.ok(Array.isArray(events), `${context}: media-event ledger is absent`);
  const allowed = new Set(['abort', 'emptied', 'error', 'playing', 'stalled', 'waiting']);
  let priorAtMs = -1;
  for (const [index, event] of events.entries()) {
    assert.ok(event !== null && typeof event === 'object' && !Array.isArray(event), (
      `${context}: media event ${index} is invalid`
    ));
    assert.ok(allowed.has(event.type), `${context}: unexpected media event ${event.type}`);
    assert.ok(Number.isFinite(event.atMs) && event.atMs >= priorAtMs, (
      `${context}: media event clocks moved backwards at ${index}`
    ));
    assert.ok(Number.isFinite(event.mediaTime) && event.mediaTime >= 0, (
      `${context}: media event ${index} has no source clock`
    ));
    priorAtMs = event.atMs;
  }

  const hardFailure = events.find(({ type }) => ['abort', 'emptied', 'error'].includes(type));
  assert.equal(hardFailure, undefined, (
    `${context}: source video emitted fatal ${hardFailure?.type ?? 'media'} event`
  ));
  const stalled = events.find(({ type }) => type === 'stalled');
  assert.equal(stalled, undefined, `${context}: source video emitted a stalled event`);

  const recoveries = [];
  for (const [index, waiting] of events.entries()) {
    if (waiting.type !== 'waiting') continue;
    const playing = events.slice(index + 1).find(event => event.type === 'playing');
    assert.ok(playing !== undefined, `${context}: media waiting event never recovered to playing`);
    const recoveryMs = playing.atMs - waiting.atMs;
    assert.ok(recoveryMs >= 0 && recoveryMs < MAXIMUM_CONTINUITY_PLATEAU_MS, (
      `${context}: media waiting recovery took ${recoveryMs}ms; `
      + `continuity permits less than ${MAXIMUM_CONTINUITY_PLATEAU_MS}ms`
    ));
    recoveries.push(Object.freeze({
      waitingAtMs: waiting.atMs,
      playingAtMs: playing.atMs,
      recoveryMs,
    }));
  }
  return Object.freeze(recoveries);
};

const sampleFallsInsideRecovery = (sample, recoveries) => recoveries.some(recovery => (
  sample.atMs >= recovery.waitingAtMs && sample.atMs <= recovery.playingAtMs
));

export const assertTemporalPhase = (samples, phase, context) => {
  assert.ok(Array.isArray(samples) && samples.length >= 5, `${context}: too few ${phase.name} samples`);
  for (const [index, sample] of samples.entries()) {
    assert.ok(Number.isFinite(sample.atMs) && sample.atMs >= 0, `${context}: invalid sample clock`);
    assert.ok(sample.mediaTime >= phase.minimum && sample.mediaTime <= phase.maximum, (
      `${context}: ${phase.name} sample escaped its cue window: ${sample.mediaTime}`
    ));
    const expected = expectedAnimationCueAt(sample.mediaTime);
    assert.equal(expected?.phase, phase.expectedPhase, (
      `${context}: ${phase.name} sample is ${expected?.phase ?? 'inactive'} under authored cue maths`
    ));
    const active = activeAnimationCueAt(sample.mediaTime);
    assert.equal(active?.phase, expected?.phase, `${context}: product and authored cue phases disagree`);
    assert.ok(Math.abs(active.progress - expected.progress) <= 1e-9, (
      `${context}: product and authored cue progress disagree`
    ));
    assert.ok(Number.isSafeInteger(sample.revision) && sample.revision > 0, `${context}: invalid revision`);
    assert.ok(Number.isSafeInteger(sample.overlayRebuilds) && sample.overlayRebuilds > 0, `${context}: invalid overlay revision`);
    assert.equal(sample.cue, '0', `${context}: subtitle blinked during ${phase.name}`);
    assert.equal(sample.preview, 'ready', `${context}: preview left ready during ${phase.name}`);
    assert.equal(sample.previewCode, null, `${context}: preview refused during ${phase.name}`);
    assert.equal(sample.paused, false, `${context}: playback paused during ${phase.name}`);
    assert.equal(sample.ended, false, `${context}: playback ended during ${phase.name}`);
    assert.ok(Number.isSafeInteger(sample.readyState)
      && sample.readyState >= 0 && sample.readyState <= 4
      && sample.error === null, `${context}: media failed during ${phase.name}`);
    assert.deepEqual(sample.visibleErrors, [], `${context}: visible error during ${phase.name}`);
    assert.deepEqual(sample.recordedRefusals, [], `${context}: transient refusal during ${phase.name}`);
    if (index > 0) {
      assert.ok(sample.atMs > samples[index - 1].atMs, `${context}: rAF clock did not advance`);
      assert.ok(sample.mediaTime + 0.002 >= samples[index - 1].mediaTime, `${context}: media moved backwards`);
      assert.ok(sample.revision >= samples[index - 1].revision, `${context}: compositor revision moved backwards`);
    }
  }
  assert.ok(samples.at(-1).mediaTime - samples[0].mediaTime >= 0.2, `${context}: media stalled`);
  assert.ok(samples.at(-1).revision - samples[0].revision >= 2, `${context}: compositor froze`);
  assert.ok(longestPlateauMs(samples, sample => sample.mediaTime) < MAXIMUM_CONTINUITY_PLATEAU_MS, (
    `${context}: media plateaued`
  ));
  assert.ok(longestPlateauMs(samples, sample => sample.revision) < MAXIMUM_CONTINUITY_PLATEAU_MS, (
    `${context}: compositor plateaued`
  ));
};

// The fixture video decodes at 15 fps, so the compositor's SCENE clock (which owns cue selection
// and eased alpha) can lead the decoded pixel clock by up to one source frame plus timer jitter.
const SOURCE_PIXEL_CLOCK_LAG_SECONDS = (1 / 15) + 0.005;

export const assertCompleteVisibleSample = (sample, context, expectsSubtitleInk = true) => {
  const visual = sample?.visual;
  const failureFrame = JSON.stringify({
    atMs: sample?.atMs,
    mediaTime: sample?.mediaTime,
    revision: sample?.revision,
    overlayRebuilds: sample?.overlayRebuilds,
    visual,
  });
  assert.equal(visual?.classified, true, `${context}: visible canvas publication is unclassified`);
  assert.ok([
    'pixels-and-operation-trace',
    'tainted-operation-trace',
  ].includes(visual.mode), `${context}: visual sentinel has no authoritative mode`);
  assert.ok(Number.isSafeInteger(visual.publication) && visual.publication > 0, (
    `${context}: visual publication sequence is invalid`
  ));
  assert.equal(visual.blank, false, `${context}: blank frame reached the visible canvas: ${failureFrame}`);
  assert.equal(visual.transparent, false, (
    `${context}: transparent frame reached the visible canvas: ${failureFrame}`
  ));
  assert.equal(visual.black, false, `${context}: black frame reached the visible canvas: ${failureFrame}`);
  assert.equal(visual.visible, true, `${context}: composed canvas became invisible: ${failureFrame}`);
  assert.equal(visual.hasVideo, true, `${context}: visible frame has no decoded video: ${failureFrame}`);
  // `null` marks a zero-crossing window where the scene clock and the pixel clock straddle the
  // eased-opacity boundary: either an inked or a source-only publication is mathematically
  // legitimate there, and only the completeness claims above apply.
  if (expectsSubtitleInk === null) return;
  if (expectsSubtitleInk) {
    assert.equal(visual.sourceOnly, false, (
      `${context}: source-only frame reached the visible canvas: ${failureFrame}`
    ));
    assert.equal(visual.hasOverlay, true, `${context}: visible frame has no subtitle paint: ${failureFrame}`);
    assert.equal(visual.hasGlyphInk, true, `${context}: visible frame has no glyph ink: ${failureFrame}`);
  } else {
    // CSS permits cubic-bezier y control points outside 0..1. Interpolated opacity is then clamped
    // at the property boundary, so the reviewed overshoot curve intentionally emits complete
    // source-only frames while its eased fade value is <= 0. This is not a compositor blink: cue
    // identity/readiness and the video publication remain continuous, and both Canvas and Rust use
    // this same easing. Accept exactly that mathematical interval, not arbitrary missing ink.
    assert.equal(visual.sourceOnly, true, (
      `${context}: non-positive eased opacity unexpectedly carried subtitle pixels: ${failureFrame}`
    ));
    assert.equal(visual.hasOverlay, false, `${context}: zero-opacity frame carried subtitle paint`);
    assert.equal(visual.hasGlyphInk, false, `${context}: zero-opacity frame carried glyph ink`);
  }
  assert.ok(Number.isFinite(visual.sourceTime), `${context}: visible frame has no source clock`);
  assert.ok(Math.abs(visual.sourceTime - sample.mediaTime) < 0.25, (
    `${context}: visible pixels lagged the playback clock: ${failureFrame}`
  ));
};

const assertVisualContinuity = (samples, context, easing = null, animationType = null) => {
  const classified = samples.filter(sample => sample.visual?.classified === true);
  assert.ok(classified.length >= samples.length * 0.95, (
    `${context}: visual publication sentinel stayed unclassified for too many frames`
  ));
  assert.ok(classified[0]?.atMs < 500, `${context}: visible canvas published nothing for 500ms`);
  const firstClassifiedIndex = samples.indexOf(classified[0]);
  assert.ok(samples.slice(firstClassifiedIndex).every(sample => sample.visual?.classified === true), (
    `${context}: visual publication sentinel lost the visible canvas after attaching`
  ));
  let intentionalZeroOpacitySamples = 0;
  for (const [index, sample] of classified.entries()) {
    const visual = sample.visual;
    // Bind subtitle expectations to the clock recorded when drawImage(video) actually published
    // these pixels — the later rAF witness clock manufactured a one-frame "blink" — but the eased
    // ALPHA the composition used follows the SCENE clock, which legitimately leads the decoded
    // pixel clock by up to one source frame. Demand ink only when the whole clock window owes it,
    // demand source-only only when the whole window is at non-positive opacity, and accept either
    // publication inside a window that straddles the zero crossing.
    const pixelTime = Number.isFinite(visual.sourceTime) ? visual.sourceTime : sample.mediaTime;
    const inkOwedAt = (instant) => {
      const active = activeAnimationCueAt(instant);
      return active === null || easeSubtitle(active.progress, easing) > 0;
    };
    const expectsSubtitleInk = easing === null
      ? true
      : (() => {
        // Typewriter reveals glyphs cumulatively through the fade-in: at low progress ZERO
        // characters are typed yet, so an inkless overlay is correct product behavior for an
        // unknowable slice of the ramp (the reveal boundary depends on cluster widths). The
        // per-phase frame proofs still pin that typewriter entry carries fewer pixels than
        // holding, so accepting either publication during its fade-in loses no coverage.
        if (animationType === 'typewriter') {
          const active = activeAnimationCueAt(pixelTime);
          if (active !== null && active.phase === 'fadingIn') return null;
        }
        const atPixels = inkOwedAt(pixelTime);
        const atScene = inkOwedAt(pixelTime + SOURCE_PIXEL_CLOCK_LAG_SECONDS);
        return atPixels === atScene ? atPixels : null;
      })();
    if (expectsSubtitleInk !== true && visual.sourceOnly === true) intentionalZeroOpacitySamples += 1;
    assertCompleteVisibleSample(sample, context, expectsSubtitleInk);
    if (index > 0) {
      assert.ok(visual.publication >= classified[index - 1].visual.publication, (
        `${context}: visible publication sequence moved backwards`
      ));
    }
  }
  assert.ok(longestPlateauMs(
    classified,
    sample => sample.visual.publication,
  ) < MAXIMUM_CONTINUITY_PLATEAU_MS, (
    `${context}: visible canvas publication plateaued`
  ));
  return Object.freeze({
    samples: classified.length,
    publications: classified.at(-1).visual.publication - classified[0].visual.publication + 1,
    modes: Object.freeze([...new Set(classified.map(sample => sample.visual.mode))].sort()),
    intentionalZeroOpacitySamples,
    firstFailure: null,
  });
};

export const assertPlaybackContinuity = (samples, mediaEvents, animation) => {
  const context = `${animation.type}/${animation.easing}`;
  assert.ok(Array.isArray(samples) && samples.length >= 120, `${context}: continuous witness is too sparse`);
  const recoveries = assertRecoveredMediaEvents(mediaEvents, context);
  assert.ok(samples[0].mediaTime <= ANIMATION_CUE.witnessStart + 0.2, (
    `${context}: continuous witness missed fade entry`
  ));
  assert.ok(samples.at(-1).mediaTime >= ANIMATION_CUE.witnessEnd - 0.1, (
    `${context}: continuous witness missed fade exit`
  ));
  for (const [index, sample] of samples.entries()) {
    assert.equal(sample.cue, '0', `${context}: subtitle blinked at ${sample.mediaTime}s`);
    assert.equal(sample.preview, 'ready', `${context}: preview left ready at ${sample.mediaTime}s`);
    assert.equal(sample.previewCode, null, `${context}: preview refused at ${sample.mediaTime}s`);
    assert.equal(sample.paused, false, `${context}: playback paused at ${sample.mediaTime}s`);
    assert.equal(sample.ended, false, `${context}: playback ended before the cue exit`);
    assert.ok(Number.isSafeInteger(sample.readyState)
      && sample.readyState >= 0 && sample.readyState <= 4
      && sample.error === null, `${context}: media failed during playback`);
    if (!sampleFallsInsideRecovery(sample, recoveries)) {
      assert.ok(sample.readyState >= 2, `${context}: media was unreadable outside a recovered wait`);
    }
    assert.deepEqual(sample.visibleErrors, [], `${context}: visible error during playback`);
    assert.deepEqual(sample.recordedRefusals, [], `${context}: transient refusal during playback`);
    const expected = expectedAnimationCueAt(sample.mediaTime);
    assert.ok(expected !== null, (
      `${context}: witness sampled outside the authored cue window at ${sample.mediaTime}s`
    ));
    const active = activeAnimationCueAt(sample.mediaTime);
    assert.equal(active?.phase, expected.phase, `${context}: product and authored cue phases disagree`);
    assert.ok(Math.abs(active.progress - expected.progress) <= 1e-9, (
      `${context}: product and authored cue progress disagree`
    ));
    if (index > 0) {
      assert.ok(sample.atMs > samples[index - 1].atMs, `${context}: rAF clock did not advance`);
      assert.ok(sample.mediaTime + 0.002 >= samples[index - 1].mediaTime, `${context}: media moved backwards`);
      assert.ok(sample.revision >= samples[index - 1].revision, `${context}: compositor revision moved backwards`);
    }
  }
  assert.ok(samples.at(-1).mediaTime - samples[0].mediaTime >= 13.7, `${context}: playback skipped the cue`);
  assert.ok(samples.at(-1).revision - samples[0].revision >= 20, `${context}: compositor froze across the cue`);
  assert.ok(longestPlateauMs(samples, sample => sample.mediaTime) < MAXIMUM_CONTINUITY_PLATEAU_MS, (
    `${context}: media plateaued`
  ));
  assert.ok(longestPlateauMs(samples, sample => sample.revision) < MAXIMUM_CONTINUITY_PLATEAU_MS, (
    `${context}: compositor plateaued`
  ));
  return Object.freeze({
    ...assertVisualContinuity(samples, context, animation.easing, animation.type),
    waitingRecoveries: recoveries,
  });
};

const assertTemporalTransition = (transition, context) => {
  assert.ok(transition?.pixels?.changedPixels >= 64, `${context}: temporal pixels were reused`);
  assert.ok(transition.pixels.changedRatio >= 0.000_1, `${context}: temporal pixel delta is negligible`);
  assert.ok(transition.pixels.maximumChannelDelta >= 16, `${context}: temporal contrast is negligible`);
  assert.ok(transition.ssim < 0.999_99, `${context}: temporal frames are visually identical`);
};

export const geometryFingerprint = proof => JSON.stringify([
  Number(proof.subtitleGeometry.centroidXRatio.toFixed(5)),
  Number(proof.subtitleGeometry.centroidYRatio.toFixed(5)),
  proof.subtitleGeometry.changedPixels,
  proof.subtitleGeometry.bounds.x,
  proof.subtitleGeometry.bounds.y,
  proof.subtitleGeometry.bounds.width,
  proof.subtitleGeometry.bounds.height,
  proof.subtitleGeometry.bounds.areaPixels,
  Number(proof.subtitleGeometry.meanChangedChannelDelta.toFixed(3)),
]);

export const spatialFingerprint = proof => JSON.stringify([
  Number(proof.subtitleGeometry.centroidXRatio.toFixed(5)),
  Number(proof.subtitleGeometry.centroidYRatio.toFixed(5)),
  proof.subtitleGeometry.bounds.x,
  proof.subtitleGeometry.bounds.y,
  proof.subtitleGeometry.bounds.width,
  proof.subtitleGeometry.bounds.height,
]);

export const assertPhaseFrames = ({ animation, frameProofs, phaseTransitions }) => {
  const hashes = ANIMATION_PHASES.map(phase => frameProofs[phase.name].composed.frame.sha256);
  assert.equal(new Set(hashes).size, hashes.length, `${animation.id}: entry/mid/exit reused a frame`);
  assertTemporalTransition(phaseTransitions?.entryToSteady, `${animation.id}: entry→steady`);
  assertTemporalTransition(phaseTransitions?.steadyToExit, `${animation.id}: steady→exit`);
  assertTemporalTransition(phaseTransitions?.entryToExit, `${animation.id}: entry→exit`);
  const fingerprints = ANIMATION_PHASES.map(phase => geometryFingerprint(frameProofs[phase.name]));
  assert.equal(new Set(fingerprints).size, fingerprints.length, (
    `${animation.id}: animation produced constant subtitle geometry/energy across entry, mid and exit`
  ));

  for (const phase of ANIMATION_PHASES) {
    const proof = frameProofs[phase.name];
    assert.ok(Math.abs(proof.mediaTime - phase.seconds) <= 0.06, (
      `${animation.id}: ${phase.name} capture missed reviewed time ${phase.seconds}`
    ));
    const expected = expectedAnimationCueAt(proof.mediaTime);
    assert.equal(expected?.phase, phase.expectedPhase, (
      `${animation.id}: ${phase.name} capture is ${expected?.phase ?? 'inactive'} under authored cue maths`
    ));
    assert.ok(Math.abs(expected.progress - phase.expectedProgress) <= 0.06, (
      `${animation.id}: ${phase.name} progress ${expected.progress} missed ${phase.expectedProgress}`
    ));
    const active = activeAnimationCueAt(proof.mediaTime);
    assert.equal(active?.phase, expected.phase, `${animation.id}: product and authored cue phases disagree`);
    assert.ok(Math.abs(active.progress - expected.progress) <= 1e-9, (
      `${animation.id}: product and authored cue progress disagree`
    ));
  }
};
