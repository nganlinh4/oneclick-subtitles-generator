import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(import.meta.dirname, '..', 'journeys', 'geminiLiveMusicSuccess.journey.js'), 'utf8');
const backgroundMusicSource = readFileSync(
  join(import.meta.dirname, '..', '..', 'src', 'components', 'BackgroundMusicSection.jsx'),
  'utf8',
);

test('the live music journey uses real controls, one native session, PCM, recording and an independent signature', () => {
  for (const witness of [
    'enrollGeminiCredentials({ limit: 20 })',
    'clickPromptDjTransport()',
    'dragActivePromptKnob()',
    "entry.control === 'Pause'",
    "entry.control === 'Play'",
    "entry.control === 'ResetContext'",
    "entry.event === 'live-music.started').length === 1",
    "live.playbackState === 'playing'",
    'peakLevel > 0.0001',
    'browser.pause(5_000)',
    "signature, '52494646'",
  ]) assert.ok(source.includes(witness), `missing live-music witness: ${witness}`);
  assert.doesNotMatch(source, /dispatchEvent|postMessage|live_music_start|executeAsync/u);
});

test('PromptDJ has one direct application frame and one message owner', () => {
  assert.match(backgroundMusicSource, /src=\{midiAppUrl\}/u);
  assert.match(backgroundMusicSource, /iframeRef\.current\?\.contentWindow \|\| null/u);
  assert.doesNotMatch(backgroundMusicSource, /srcDoc|promptdj-inner/u);
});
