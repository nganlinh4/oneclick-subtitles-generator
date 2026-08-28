import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  NARRATION_MIX_RMS_FLOOR,
  verifyNarrationMixWindows,
  verifyStructuralAudioParity,
} from './renderAudioNarrationMixOracle.js';

const windowsFor = (values, windowSeconds = 0.5) => values.map((rms, index) => ({
  startSeconds: index * windowSeconds,
  endSeconds: (index + 1) * windowSeconds,
  rms,
  peak: rms,
}));

const analysisFor = (values, windowSeconds = 0.5) => ({
  durationSeconds: values.length * windowSeconds,
  maximumRms: Math.max(...values),
  windows: windowsFor(values, windowSeconds),
});

const probeFor = ({
  width = 640,
  height = 360,
  frameRate = '24/1',
  sampleRate = '48000',
  channels = 2,
  duration = 19,
} = {}) => ({
  format: { duration: String(duration) },
  streams: [
    { codec_type: 'video', width, height, avg_frame_rate: frameRate },
    { codec_type: 'audio', sample_rate: sampleRate, channels },
  ],
});

test('verifyStructuralAudioParity accepts two renders that agree on everything but audio energy', () => {
  const result = verifyStructuralAudioParity({
    withProbe: probeFor({ duration: 19.05 }),
    withoutProbe: probeFor({ duration: 19.0 }),
  });
  assert.equal(result.withDuration, 19.05);
  assert.equal(result.withoutDuration, 19.0);
});

test('verifyStructuralAudioParity rejects a video-dimension drift between the two renders', () => {
  assert.throws(() => verifyStructuralAudioParity({
    withProbe: probeFor({ width: 480 }),
    withoutProbe: probeFor({ width: 640 }),
  }), /video width/);
});

test('verifyStructuralAudioParity rejects a frame-rate drift between the two renders', () => {
  assert.throws(() => verifyStructuralAudioParity({
    withProbe: probeFor({ frameRate: '30/1' }),
    withoutProbe: probeFor({ frameRate: '24/1' }),
  }), /frame rate/);
});

test('verifyStructuralAudioParity rejects an audio-format drift between the two renders', () => {
  assert.throws(() => verifyStructuralAudioParity({
    withProbe: probeFor({ channels: 1 }),
    withoutProbe: probeFor({ channels: 2 }),
  }), /channel count/);
});

test('verifyStructuralAudioParity rejects a duration drift beyond its tolerance', () => {
  assert.throws(() => verifyStructuralAudioParity({
    withProbe: probeFor({ duration: 20 }),
    withoutProbe: probeFor({ duration: 19 }),
    toleranceSeconds: 0.3,
  }), /duration/);
});

test('verifyStructuralAudioParity rejects a probe missing an audio stream', () => {
  const missingAudio = probeFor();
  missingAudio.streams = missingAudio.streams.filter(({ codec_type: type }) => type !== 'audio');
  assert.throws(() => verifyStructuralAudioParity({
    withProbe: missingAudio,
    withoutProbe: probeFor(),
  }), /video\/audio stream pair/);
});

test('verifyNarrationMixWindows accepts a measurable energy delta at every placement', () => {
  const withNarration = analysisFor([0.01, 0.2, 0.01, 0.25, 0.01]);
  const withoutNarration = analysisFor([0.01, 0.01, 0.01, 0.02, 0.01]);
  const placements = [
    { cueId: 'a', start: 0.5, end: 1.0 },
    { cueId: 'b', start: 1.5, end: 2.0 },
  ];
  const deltas = verifyNarrationMixWindows({ withNarration, withoutNarration, placements });
  assert.equal(deltas.length, 2);
  assert.ok(deltas[0].delta > NARRATION_MIX_RMS_FLOOR);
  assert.ok(deltas[1].delta > NARRATION_MIX_RMS_FLOOR);
});

test('verifyNarrationMixWindows accepts a ducked (decreased) energy delta, not only an increase', () => {
  // A mixer that ducks the original track under narration can plausibly produce a QUIETER window
  // once narration is selected. The oracle must not assume a direction, only a measurable magnitude.
  const withNarration = analysisFor([0.01, 0.01]);
  const withoutNarration = analysisFor([0.2, 0.2]);
  const placements = [{ cueId: 'a', start: 0, end: 1.0 }];
  const deltas = verifyNarrationMixWindows({ withNarration, withoutNarration, placements });
  assert.ok(deltas[0].delta < -NARRATION_MIX_RMS_FLOOR);
});

test('verifyNarrationMixWindows rejects a placement with no measurable difference', () => {
  const withNarration = analysisFor([0.05, 0.05]);
  const withoutNarration = analysisFor([0.0501, 0.0501]);
  const placements = [{ cueId: 'a', start: 0, end: 1.0 }];
  assert.throws(
    () => verifyNarrationMixWindows({ withNarration, withoutNarration, placements }),
    /no measurable/,
  );
});

test('verifyNarrationMixWindows rejects an empty placement list', () => {
  const analysis = analysisFor([0.05]);
  assert.throws(
    () => verifyNarrationMixWindows({ withNarration: analysis, withoutNarration: analysis, placements: [] }),
    /no narration placement windows/,
  );
});

test('verifyNarrationMixWindows rejects a non-positive RMS floor', () => {
  const analysis = analysisFor([0.05]);
  assert.throws(() => verifyNarrationMixWindows({
    withNarration: analysis,
    withoutNarration: analysis,
    placements: [{ cueId: 'a', start: 0, end: 1.0 }],
    minimumRmsDelta: 0,
  }), /positive number/);
});
