import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  approximateBitrateKbps, assertRoundsAreDistinct, chooseQualityRounds, parseQualityHeight,
  verifyQualityRound,
} from './downloadQualityVariantsOracle.js';

test('parseQualityHeight reads the leading height off a real pill label', () => {
  assert.equal(parseQualityHeight('240p (Very Low)'), 240);
  assert.equal(parseQualityHeight('144p (Minimum)'), 144);
  assert.equal(parseQualityHeight('1080p (Full HD)'), 1_080);
  assert.equal(parseQualityHeight('720p'), 720);
});

test('parseQualityHeight refuses a label with no leading height', () => {
  assert.throws(() => parseQualityHeight('Very Low'), /unrecognized quality pill label/);
  assert.throws(() => parseQualityHeight(''), /unrecognized quality pill label/);
  assert.throws(() => parseQualityHeight(42), /must be a string/);
});

test('chooseQualityRounds picks tallest and shortest when only two rungs are offered', () => {
  const rounds = chooseQualityRounds(['240p (Very Low)', '144p (Minimum)']);
  assert.deepEqual(rounds.map(({ index }) => index), [0, 1]);
  assert.deepEqual(rounds.map(({ height }) => height), [240, 144]);
  assert.deepEqual(rounds.map(({ label }) => label), ['240p (Very Low)', '144p (Minimum)']);
});

test('chooseQualityRounds picks a genuine middle rung when three or more are offered', () => {
  const rounds = chooseQualityRounds(['720p (HD)', '480p (SD)', '360p (Low)', '144p (Minimum)']);
  assert.deepEqual(rounds.map(({ index }) => index), [0, 1, 3]);
  assert.deepEqual(rounds.map(({ height }) => height), [720, 480, 144]);
});

test('chooseQualityRounds refuses a scan with fewer than two real rungs', () => {
  assert.throws(() => chooseQualityRounds(['720p']), /at least two real qualities/);
  assert.throws(() => chooseQualityRounds([]), /at least two real qualities/);
});

test('chooseQualityRounds refuses a scan that is not sorted tallest-first', () => {
  assert.throws(
    () => chooseQualityRounds(['144p (Minimum)', '240p (Very Low)']),
    /not sorted tallest-first/,
  );
});

test('verifyQualityRound accepts a decoded height exactly equal to the requested rung', () => {
  const round = { label: '240p (Very Low)', height: 240 };
  const probe = { streams: [{ codec_type: 'video', width: 426, height: 240 }] };
  const verified = verifyQualityRound({ round, probe });
  assert.deepEqual(verified, {
    label: '240p (Very Low)', requestedHeight: 240, decodedHeight: 240, video: probe.streams[0],
  });
});

test('verifyQualityRound rejects a decoded height taller than requested', () => {
  const round = { label: '144p (Minimum)', height: 144 };
  const probe = { streams: [{ codec_type: 'video', width: 426, height: 240 }] };
  assert.throws(() => verifyQualityRound({ round, probe }), /requested at most 144p but decoded 240p/);
});

test('verifyQualityRound rejects a decoded height shorter than the exact requested rung', () => {
  const round = { label: '240p (Very Low)', height: 240 };
  const probe = { streams: [{ codec_type: 'video', width: 256, height: 144 }] };
  assert.throws(() => verifyQualityRound({ round, probe }), /the requested height did not reach/);
});

test('verifyQualityRound requires a video stream to exist at all', () => {
  const round = { label: '240p (Very Low)', height: 240 };
  assert.throws(
    () => verifyQualityRound({ round, probe: { streams: [{ codec_type: 'audio' }] } }),
    /produced no video stream/,
  );
});

test('assertRoundsAreDistinct passes when every round decoded a different height', () => {
  assert.doesNotThrow(() => assertRoundsAreDistinct([
    { decodedHeight: 240 }, { decodedHeight: 144 },
  ]));
});

test('assertRoundsAreDistinct catches the regression where every round decodes identically', () => {
  assert.throws(
    () => assertRoundsAreDistinct([{ decodedHeight: 240 }, { decodedHeight: 240 }]),
    /never reached the real download/,
  );
});

test('approximateBitrateKbps computes a positive floor from size and duration', () => {
  const kbps = approximateBitrateKbps({ format: { duration: '10', size: '1250000' } });
  assert.equal(kbps, 1_000);
});

test('approximateBitrateKbps refuses a non-positive duration or size', () => {
  assert.throws(
    () => approximateBitrateKbps({ format: { duration: '0', size: '100' } }),
    /positive duration/,
  );
  assert.throws(
    () => approximateBitrateKbps({ format: { duration: '10', size: 'not-a-number' } }),
    /positive size/,
  );
});
