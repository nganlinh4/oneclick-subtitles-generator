import { strict as assert } from 'node:assert';
import test from 'node:test';

/* global structuredClone */

import {
  EXPORT_ANIMATION_PARITY_CASES,
  buildExportAnimationParitySrt,
  parseFfprobeRate,
  validateExportAnimationParityMatrix,
} from './exportAnimationParityOracle.js';
import { parseVolumeDetect } from './nativeMediaOracle.js';

const cloneCases = () => structuredClone(EXPORT_ANIMATION_PARITY_CASES);

test('the narrow gradient samples both animated edges above the codec-noise opacity region', () => {
  const definition = EXPORT_ANIMATION_PARITY_CASES.find(
    ({ id }) => id === '05-slide-right-narrow-gradient',
  );
  assert.ok(definition, 'the narrow gradient parity case is missing');
  assert.equal(definition.sampleOffsetFrames, 6);
  assert.equal(definition.entryFrame, definition.startFrame - 6);
  assert.equal(definition.exitFrame, definition.endFrame + 6);
  assert.equal(definition.animationType, 'slide-right');
  assert.equal(definition.animationEasing, 'ease-in-out');
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
