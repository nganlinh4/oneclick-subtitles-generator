import assert from 'node:assert/strict';
import test from 'node:test';

import { selectPublicFrontendEnvironment } from '../vite.config.mjs';

test('only reviewed build metadata is exposed to the frontend', () => {
  const selected = selectPublicFrontendEnvironment({
    REACT_APP_GIT_COMMIT_HASH: 'abc123',
    REACT_APP_BUILD_TIME: '2026-08-10T00:00:00Z',
    REACT_APP_BACKEND_PORT: '3031',
    REACT_APP_SERVER_URL: 'http://127.0.0.1:3031',
    REACT_APP_VIDEO_RENDERER_PORT: '3033',
  }, 'production');

  assert.deepEqual(selected, {
    NODE_ENV: 'production',
    REACT_APP_GIT_COMMIT_HASH: 'abc123',
    REACT_APP_BUILD_TIME: '2026-08-10T00:00:00Z',
  });
  assert.equal(JSON.stringify(selected).includes('3031'), false);
  assert.equal(JSON.stringify(selected).includes('3033'), false);
});

test('provider credentials and unreviewed public variables fail closed', () => {
  for (const key of [
    'REACT_APP_GEMINI_API_KEY',
    'REACT_APP_YOUTUBE_CLIENT_SECRET',
    'REACT_APP_PROVIDER_TOKEN',
  ]) {
    assert.throws(
      () => selectPublicFrontendEnvironment({ [key]: 'must-not-ship' }, 'production'),
      /Refusing to expose unreviewed frontend environment variables/,
    );
  }
});
