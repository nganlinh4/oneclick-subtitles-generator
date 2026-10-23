import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { LOCAL_MEDIA_RESULT_EXPRESSION } from '../inspect-installed-local-media-flow.mjs';
import { MEDIA_RESULT_EXPRESSION } from './expressions.mjs';
import { validResult } from './test-fixtures.mjs';

test('executed media probes use native identity and visible playback without legacy storage', async () => {
  const value = validResult();
  const video = {
    currentSrc: value.currentFileUrl, duration: 4, videoHeight: 360, videoWidth: 640,
    readyState: 4, paused: true,
  };
  const context = {
    localStorage: { getItem(key) {
      assert.equal(key, 'uploaded_srt_info', 'obsolete media mirrors must never be read');
      return JSON.stringify(value.uploadedSrtInfo);
    } },
    HTMLInputElement: class {},
    document: {
      body: { innerText: 'OSG installed media smoke' },
      querySelector: (selector) => selector === 'video.video-player' ? video : null,
      querySelectorAll: () => [],
    },
    window: { __TAURI_INTERNALS__: { invoke: async (command, payload) => {
      if (command === 'get_session_snapshot') return value.session;
      if (command === 'active_workspace_get') return { initialized: true, workspace: value.workspace };
      if (command === 'native_tools_status') return value.tools;
      if (command === 'jobs_list') return value.jobs;
      assert.equal(command, 'media_pipeline_inspect');
      assert.equal(payload.assetId, value.assetId);
      return {};
    } } },
  };
  for (const expression of [MEDIA_RESULT_EXPRESSION, LOCAL_MEDIA_RESULT_EXPRESSION]) {
    const result = await vm.runInNewContext(expression, context);
    assert.equal(result.assetId, value.assetId);
    assert.equal(result.currentFileUrl, video.currentSrc);
    video.currentSrc = 'http://127.0.0.1:43123/stale-visible-video';
    const stale = await vm.runInNewContext(expression, context);
    assert.notEqual(stale.currentFileUrl, stale.session.playback.playbackUrl,
      'the probe must expose a stale visible video, not replace it with the native answer');
    video.currentSrc = value.currentFileUrl;
  }
});
test('the URL media flow targets selector hooks the product UI still renders', () => {
  const inputMethods = fs.readFileSync(
    new URL('../../src/components/InputMethods.js', import.meta.url),
    'utf8',
  );
  const buttonsContainer = fs.readFileSync(
    new URL('../../src/components/app/ButtonsContainer.jsx', import.meta.url),
    'utf8',
  );
  assert.equal((inputMethods.match(/data-input-tab="unified-url"/g) || []).length, 1);
  assert.match(buttonsContainer, /data-generation-mode=\{generationMode\}/);
});
