import { strict as assert } from 'node:assert';
import test from 'node:test';

import { PcmRecording } from './PcmRecording.js';

test('writes a finite PCM16LE WAV from the exact received chunks', () => {
  const recording = new PcmRecording({ sampleRate: 48_000, channels: 2, maxBytes: 1_024 });
  recording.append(Uint8Array.from([1, 2, 3, 4]).buffer);
  recording.append(Uint8Array.from([5, 6, 7, 8]).buffer);
  const wav = recording.finish();
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE');
  assert.equal(view.getUint32(4, true), 44);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual(Array.from(wav.subarray(44)), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('refuses empty, partial-frame and over-limit recordings', () => {
  const recording = new PcmRecording({ sampleRate: 48_000, channels: 2, maxBytes: 8 });
  assert.throws(() => recording.finish(), /contains no audio/u);
  assert.throws(() => recording.append(Uint8Array.from([1, 2]).buffer), /whole non-empty frames/u);
  recording.append(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]).buffer);
  assert.throws(
    () => recording.append(Uint8Array.from([9, 10, 11, 12]).buffer),
    /safe size limit/u,
  );
});
