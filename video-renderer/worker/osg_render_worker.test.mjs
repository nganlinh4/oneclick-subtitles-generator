import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  decodeSingleRequest,
  encodeFrame,
  validateRequest,
} from './osg_render_worker.mjs';

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-render-worker-'));
  const bundle = path.join(root, 'bundle');
  const renderer = path.join(root, 'renderer');
  const binaries = path.join(root, 'binaries');
  fs.mkdirSync(bundle);
  fs.mkdirSync(renderer);
  fs.mkdirSync(binaries);
  const browser = path.join(root, process.platform === 'win32' ? 'browser.exe' : 'browser');
  fs.writeFileSync(browser, 'browser');
  return {
    root,
    request: {
      protocolVersion: PROTOCOL_VERSION,
      requestType: 'render',
      serveUrl: bundle,
      browserExecutable: browser,
      rendererRoot: renderer,
      binariesDirectory: binaries,
      outputLocation: path.join(root, 'output.mp4'),
      compositionId: 'subtitled-video',
      inputProps: {
        audioUrl: 'job-media/source-audio.aac',
        framesPathUrl: 'job-media/frames',
        extractedAudioUrl: 'job-media/source-audio.aac',
        metadata: {fontStylesheetUrl: 'fonts/fonts.css'},
      },
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 60,
    },
  };
};

test('length-prefixed request round-trips exactly', () => {
  const {root, request} = fixture();
  try {
    const frame = encodeFrame(request);
    assert.deepEqual(decodeSingleRequest(frame), request);
    assert.equal(validateRequest(request), true);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('path injection, unknown fields, and existing output fail closed', () => {
  const {root, request} = fixture();
  try {
    assert.equal(validateRequest({...request, sourcePath: 'C:/private'}), false);
    assert.equal(validateRequest({...request, outputLocation: '../escape.mp4'}), false);
    fs.writeFileSync(request.outputLocation, 'partial');
    assert.equal(validateRequest(request), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('framing rejects trailing, truncated, and oversized payloads', () => {
  const valid = encodeFrame({type: 'ready', protocolVersion: 1});
  assert.throws(() => decodeSingleRequest(Buffer.concat([valid, Buffer.from([0])])));
  assert.throws(() => decodeSingleRequest(valid.subarray(0, valid.length - 1)));
  assert.throws(() => encodeFrame({text: 'x'.repeat(MAX_MESSAGE_BYTES)}));
});
