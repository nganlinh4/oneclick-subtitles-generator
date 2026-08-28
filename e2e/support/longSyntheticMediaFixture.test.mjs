import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  LONG_SYNTHETIC_MEDIA,
  validateLongSyntheticMediaProbe,
} from './longSyntheticMediaFixture.js';

const validProbe = () => ({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 64, height: 36 },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '7200.000000', size: '15000000' },
});

test('the frozen synthetic recipe is unambiguously "long" and tiny on disk', () => {
  assert.equal(LONG_SYNTHETIC_MEDIA.durationSeconds, 7_200);
  // "60+ minutes" is the letter of the requirement; this fixture keeps a real 2x margin.
  assert.ok(LONG_SYNTHETIC_MEDIA.durationSeconds >= 3_600);
  assert.ok(LONG_SYNTHETIC_MEDIA.width > 0 && LONG_SYNTHETIC_MEDIA.width % 2 === 0);
  assert.ok(LONG_SYNTHETIC_MEDIA.height > 0 && LONG_SYNTHETIC_MEDIA.height % 2 === 0);
  assert.ok(LONG_SYNTHETIC_MEDIA.frameRate > 0);
  assert.ok(LONG_SYNTHETIC_MEDIA.audioSampleRateHz > 0);
});

test('the semantic probe accepts the intended real synthetic container', () => {
  assert.deepEqual(validateLongSyntheticMediaProbe(validProbe()), {
    duration: 7_200,
    size: 15_000_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
  });
});

test('the fixture cannot silently lose its video, audio, geometry, or two-hour duration', () => {
  for (const mutate of [
    (probe) => { probe.streams = probe.streams.filter(({ codec_type: type }) => type !== 'audio'); },
    (probe) => { probe.streams = probe.streams.filter(({ codec_type: type }) => type !== 'video'); },
    (probe) => { probe.streams[0].codec_name = 'vp9'; },
    (probe) => { probe.streams[1].codec_name = 'opus'; },
    (probe) => { probe.streams[0].width = 128; },
    (probe) => { probe.streams[0].height = 72; },
    (probe) => { probe.format.duration = '7197.9'; },
    (probe) => { probe.format.duration = '7202.1'; },
    (probe) => { probe.format.size = '0'; },
  ]) {
    const probe = validProbe();
    mutate(probe);
    assert.throws(() => validateLongSyntheticMediaProbe(probe), /fixture is invalid/u);
  }
});
