import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  FRAME_RATE_DROPDOWN_OPTIONS, RENDER_TRANSFORM_MATRIX_CASES, RESOLUTION_CANONICAL_HEIGHT,
  RESOLUTION_DROPDOWN_OPTIONS, expectedRenderWidth, parseFrameRateFraction, verifyRenderMatrixCase,
} from './renderFormatTransformMatrixOracle.js';

const probeFor = ({
  width, height, frameRate = '24/1', duration = 19, videoCodec = 'h264', audioCodec = 'aac',
} = {}) => ({
  format: { duration: String(duration) },
  streams: [
    {
      codec_type: 'video', width, height, avg_frame_rate: frameRate, codec_name: videoCodec,
    },
    { codec_type: 'audio', sample_rate: '48000', channels: 2, codec_name: audioCodec },
  ],
});

test('the matrix is small, bounded, and every option index still names its dropdown value', () => {
  assert.equal(RENDER_TRANSFORM_MATRIX_CASES.length, 5);
  assert.deepEqual(
    new Set(RENDER_TRANSFORM_MATRIX_CASES.map(({ name }) => name)).size,
    RENDER_TRANSFORM_MATRIX_CASES.length,
    'matrix case names must be unique',
  );
  for (const matrixCase of RENDER_TRANSFORM_MATRIX_CASES) {
    assert.equal(
      RESOLUTION_DROPDOWN_OPTIONS[matrixCase.resolutionOptionIndex], matrixCase.resolution,
    );
    assert.equal(
      FRAME_RATE_DROPDOWN_OPTIONS[matrixCase.frameRateOptionIndex], matrixCase.frameRate,
    );
  }
  const cropCases = RENDER_TRANSFORM_MATRIX_CASES.filter(({ crop }) => crop !== null);
  assert.equal(cropCases.length, 1, 'only one crop case is in scope for this bounded matrix');
  const [cropCase] = cropCases;
  assert.ok(
    RENDER_TRANSFORM_MATRIX_CASES.some(({ name }) => name === cropCase.baselineCase),
    'the crop case must name a baseline case that actually exists in the matrix',
  );
});

test('RESOLUTION_CANONICAL_HEIGHT covers every dropdown option exactly once', () => {
  assert.deepEqual(
    Object.keys(RESOLUTION_CANONICAL_HEIGHT).sort(),
    [...RESOLUTION_DROPDOWN_OPTIONS].sort(),
  );
});

test('parseFrameRateFraction reads a plain and a drop-frame rational', () => {
  assert.equal(parseFrameRateFraction('24/1'), 24);
  assert.equal(parseFrameRateFraction('60/1'), 60);
  assert.ok(Math.abs(parseFrameRateFraction('24000/1001') - 23.976) < 0.001);
});

test('parseFrameRateFraction rejects an unrecognized or zero-denominator fraction', () => {
  assert.throws(() => parseFrameRateFraction('not-a-fraction'), /unrecognized/);
  assert.throws(() => parseFrameRateFraction('24/0'), /zero denominator/);
  assert.throws(() => parseFrameRateFraction(24), /must be a string/);
});

test('expectedRenderWidth reproduces the request contract for an ordinary landscape source', () => {
  // Mirrors crates/osg-export/src/convert/dimensions.rs's own regression table for a 16:9 source.
  assert.equal(expectedRenderWidth(1_920, 1_080, 480), 854);
  assert.equal(expectedRenderWidth(1_920, 1_080, 720), 1_280);
  assert.equal(expectedRenderWidth(1_920, 1_080, 1_080), 1_920);
  assert.equal(expectedRenderWidth(1_920, 1_080, 2_160), 3_840);
});

test('expectedRenderWidth rounds an odd computed edge up to the nearest even number', () => {
  // 640x360 at height 361 -> round(361 * 640/360) = round(641.78) = 642 (already even).
  // Pick a source/height combination that lands on an odd rounded edge to exercise the +1 branch.
  assert.equal(expectedRenderWidth(853, 480, 481), 856);
});

test('expectedRenderWidth folds a crop rectangle into the source aspect before rounding', () => {
  // The 1:1 aspect preset on a 16:9 source: VideoCropControls solves cropWidth/cropHeight for
  // 1/sourceAspect, so effectiveAspect = sourceAspect * cropRatio collapses to exactly 1.
  const cropWidthPercent = (1_080 / 1_920) * 100; // 56.25, mirroring calculateCropDimensions
  const width = expectedRenderWidth(1_920, 1_080, 720, cropWidthPercent, 100);
  assert.equal(width, 720, 'a crop that cancels the source aspect must produce a square frame');
});

test('expectedRenderWidth rejects non-positive inputs', () => {
  assert.throws(() => expectedRenderWidth(0, 1_080, 720), /source width/);
  assert.throws(() => expectedRenderWidth(1_920, 0, 720), /source height/);
  assert.throws(() => expectedRenderWidth(1_920, 1_080, 0), /target height/);
  assert.throws(() => expectedRenderWidth(1_920, 1_080, 720, 0), /crop width/);
  assert.throws(() => expectedRenderWidth(1_920, 1_080, 720, 100, 0), /crop height/);
});

test('verifyRenderMatrixCase accepts a decoded export matching its requested settings exactly', () => {
  const expected = { name: '720p-24fps', resolution: '720p', frameRate: 24 };
  const result = verifyRenderMatrixCase({
    probe: probeFor({ width: 1_280, height: 720, frameRate: '24/1', duration: 19.05 }),
    sourceProbe: probeFor({ width: 1_920, height: 1_080, duration: 19.0 }),
    expected,
  });
  assert.equal(result.width, 1_280);
  assert.equal(result.height, 720);
  assert.equal(result.frameRate, 24);
  assert.equal(result.videoCodec, 'h264');
  assert.equal(result.audioCodec, 'aac');
});

test('verifyRenderMatrixCase rejects a height that disagrees with the requested resolution', () => {
  assert.throws(() => verifyRenderMatrixCase({
    probe: probeFor({ width: 640, height: 360 }),
    sourceProbe: probeFor({ width: 1_920, height: 1_080 }),
    expected: { name: '720p-24fps', resolution: '720p', frameRate: 24 },
  }), /wrong output height/);
});

test('verifyRenderMatrixCase rejects a width that does not follow the source aspect', () => {
  assert.throws(() => verifyRenderMatrixCase({
    probe: probeFor({ width: 999, height: 720 }),
    sourceProbe: probeFor({ width: 1_920, height: 1_080 }),
    expected: { name: '720p-24fps', resolution: '720p', frameRate: 24 },
  }), /source-aspect/);
});

test('verifyRenderMatrixCase rejects a decoded frame rate that disagrees with the request', () => {
  assert.throws(() => verifyRenderMatrixCase({
    probe: probeFor({
      width: 1_280, height: 720, frameRate: '30/1',
    }),
    sourceProbe: probeFor({ width: 1_920, height: 1_080 }),
    expected: { name: '720p-24fps', resolution: '720p', frameRate: 24 },
  }), /requested 24fps but decoded 30fps/);
});

test('verifyRenderMatrixCase rejects a duration that drifted from the source timeline', () => {
  assert.throws(() => verifyRenderMatrixCase({
    probe: probeFor({
      width: 1_280, height: 720, duration: 25,
    }),
    sourceProbe: probeFor({ width: 1_920, height: 1_080, duration: 19 }),
    expected: { name: '720p-24fps', resolution: '720p', frameRate: 24 },
  }), /disagrees with the source timeline/);
});

test('verifyRenderMatrixCase folds the durable crop percentages into the expected width', () => {
  const crop = { width: 56.25, height: 100 }; // the 1:1 aspect preset for a 16:9 (1920x1080) source
  const result = verifyRenderMatrixCase({
    probe: probeFor({ width: 720, height: 720 }),
    sourceProbe: probeFor({ width: 1_920, height: 1_080 }),
    expected: { name: '720p-24fps-crop-1x1', resolution: '720p', frameRate: 24 },
    crop,
  });
  assert.equal(result.width, result.height, 'a 1:1 crop must produce a square decoded frame');
});
