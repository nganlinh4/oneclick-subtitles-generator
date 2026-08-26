import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  FOUR_WINDOW_ASR_FIXTURE,
  validateFourWindowAsrProbe,
} from './fourWindowAsrFixture.js';

const validProbe = () => ({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 320, height: 180 },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '204.000000', size: '1800000' },
});

test('the frozen real-speech recipe requires exactly four one-minute requests', () => {
  assert.equal(FOUR_WINDOW_ASR_FIXTURE.source.durationSeconds, 20.4);
  assert.equal(FOUR_WINDOW_ASR_FIXTURE.repeats, 10);
  assert.equal(
    FOUR_WINDOW_ASR_FIXTURE.source.durationSeconds * FOUR_WINDOW_ASR_FIXTURE.repeats,
    FOUR_WINDOW_ASR_FIXTURE.durationSeconds,
  );
  assert.equal(
    Math.ceil(
      FOUR_WINDOW_ASR_FIXTURE.durationSeconds / FOUR_WINDOW_ASR_FIXTURE.maxRequestSeconds,
    ),
    FOUR_WINDOW_ASR_FIXTURE.expectedWindowCount,
  );
});

test('the semantic probe accepts the intended real container', () => {
  assert.deepEqual(validateFourWindowAsrProbe(validProbe()), {
    duration: 204,
    size: 1_800_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
  });
});

test('the fixture cannot silently lose speech, video, or the four-window duration', () => {
  for (const mutate of [
    (probe) => { probe.streams = probe.streams.filter(({ codec_type: type }) => type !== 'audio'); },
    (probe) => { probe.streams = probe.streams.filter(({ codec_type: type }) => type !== 'video'); },
    (probe) => { probe.streams[0].codec_name = 'vp9'; },
    (probe) => { probe.streams[1].codec_name = 'opus'; },
    (probe) => { probe.format.duration = '179.999'; },
    (probe) => { probe.format.duration = '241'; },
    (probe) => { probe.format.size = '0'; },
  ]) {
    const probe = validProbe();
    mutate(probe);
    assert.throws(() => validateFourWindowAsrProbe(probe), /fixture is invalid/u);
  }
});

