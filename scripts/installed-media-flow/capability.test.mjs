import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import test from 'node:test';

import { waitForValue } from '../inspect-installed-media-flow.mjs';
import { readPlaybackCapability, sanitizeInspectorError } from './capability.mjs';
import { MEDIA_RESULT_EXPRESSION } from './expressions.mjs';
import { hasMediaFlowStarted, summarizeMediaFlowFailure } from './guards.mjs';
import { validResult } from './test-fixtures.mjs';

test('keeps byte verification outside the production WebView CSP boundary', async () => {
  assert.doesNotMatch(MEDIA_RESULT_EXPRESSION, /\bfetch\s*\(/);
  assert.doesNotMatch(MEDIA_RESULT_EXPRESSION, /crypto\.subtle/);
  const bytes = Buffer.alloc(366_888, 0x2a);
  let requestedUrl = null;
  const result = await readPlaybackCapability(validResult().currentFileUrl, {
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.redirect, 'error');
      assert.equal(options.method, 'GET');
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-length': String(bytes.length),
          'content-type': 'video/mp4',
        },
      });
    },
    timeoutMs: 1_000,
  });
  assert.equal(requestedUrl, validResult().currentFileUrl);
  assert.deepEqual(result, {
    byteLength: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
});

test('never serializes an opaque playback capability in failures or timeouts', async () => {
  const hostile = validResult();
  hostile.errorToastMessages = [
    `failure currentFileUrl playbackUrl localhost 127.0.0.1 token ${hostile.currentFileUrl}`,
  ];
  let applicationError;
  try {
    hasMediaFlowStarted(hostile);
  } catch (error) {
    applicationError = error;
  }
  const timeoutError = await waitForValue(
    async () => hostile,
    () => false,
    { now: (() => { let tick = 0; return () => ++tick * 10; })(), timeoutMs: 15, delay: async () => {} },
  ).catch((error) => error);
  const sanitized = sanitizeInspectorError(new Error(
    `${hostile.errorToastMessages[0]} at "C:\\Users\\runner admin\\private fixture.mp4" `
      + 'and /home/runner/private-fixture.mp4',
  ));
  const serialized = [
    applicationError?.message,
    timeoutError?.message,
    sanitized,
    JSON.stringify(summarizeMediaFlowFailure(hostile)),
  ].join('\n');
  for (const forbidden of [
    'a'.repeat(64), 'playbackUrl', 'currentFileUrl', 'localhost', '127.0.0.1', 'token',
    'runner admin', 'private fixture.mp4', '/home/runner',
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test('capability read failures are bounded and capability-free', async () => {
  const error = await readPlaybackCapability(validResult().currentFileUrl, {
    fetchImpl: async () => new Response(Buffer.alloc(366_889), {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    }),
    timeoutMs: 1_000,
  }).catch((failure) => failure);
  assert.equal(error.message, 'Installed playback capability could not be verified');
  assert.equal(error.message.includes('127.0.0.1'), false);
  assert.equal(error.message.includes('a'.repeat(64)), false);
});
