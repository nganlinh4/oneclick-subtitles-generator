import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const source = readFileSync(
  resolve(import.meta.dirname, '..', 'journeys', 'settingsVideoProcessingAndPrompts.journey.js'),
  'utf8',
);

test('the journey uses only public controls and never a private or native-dialog shortcut', () => {
  assert.doesNotMatch(source, /__TAURI__|invokeDesktop|invokeCommand|browser\.executeAsync/u);
  assert.doesNotMatch(source, /select_media|open_document|save_document|dialog_paths/u);
  assert.match(source, /data-app-action=\\?"open-settings/);
  assert.match(source, /#enable-gemini-effects/u);
  assert.match(source, /#auto-split-subtitles/u);
  assert.match(source, /favorite-max-subtitle-length/u);
  assert.match(source, /#auto-import-site-subtitles/u);
  assert.match(source, /#enable-youtube-search/u);
  assert.match(source, /#use-cookies-download/u);
  assert.match(source, /#transcription-prompt/u);
});

test('every extended setting is asserted durable in SQLite and mirrored into localStorage', () => {
  for (const key of [
    'show_favorite_max_length',
    'video_processing_max_words',
    'enable_gemini_effects',
    'auto_import_site_subtitles',
    'enable_youtube_search',
    'use_cookies_for_download',
    'download_cookie_source',
    'transcription_prompt',
  ]) {
    assert.match(source, new RegExp(`'${key}'`), `${key} is not part of the extended settings journey`);
  }
  assert.match(source, /durableSettings\(root, EXTENDED_KEYS\)/u);
  assert.match(source, /localStorage\.getItem\(key\)/u);
  assert.match(source, /mirroring the same values into localStorage/u);
});

test('the Gemini-effects and prompt claims are each backed by a real runtime observable, not only storage', () => {
  assert.match(source, /window\.geminiAnimationFrameId/u);
  assert.match(source, /gemini-icon-container/u);
  assert.match(source, /attemptCredentialFreeGeneration/u);
  assert.match(source, /data-osg-action="process-subtitles"/u);
  assert.match(source, /errorToasts\.some\(\(message\) => \/API\/i\.test\(message\)\)/u);
  assert.match(source, /providerKinds/u);
  assert.doesNotMatch(source, /clickControl\([^\n]*factory-reset-btn/u, 'this journey does not own factory reset');
});
