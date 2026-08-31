/* global fetch */

import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers';
import { test } from 'node:test';

import {
  parseSingleByteRange, readDownloadFixtureEvents, startDownloadFixtureOrigin,
} from './downloadFixtureOrigin.js';

test('single-range parsing is bounded and rejects ambiguous requests', () => {
  assert.deepEqual(parseSingleByteRange(undefined, 100), { start: 0, end: 99, partial: false });
  assert.deepEqual(parseSingleByteRange('bytes=10-19', 100), { start: 10, end: 19, partial: true });
  assert.deepEqual(parseSingleByteRange('bytes=90-', 100), { start: 90, end: 99, partial: true });
  assert.deepEqual(parseSingleByteRange('bytes=-10', 100), { start: 90, end: 99, partial: true });
  for (const invalid of ['bytes=', 'bytes=100-', 'bytes=20-10', 'bytes=0-1,4-5', 'items=0-1']) {
    assert.equal(parseSingleByteRange(invalid, 100), null, invalid);
  }
});

test('the exact origin serves ranges and records an interrupted partial transfer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-download-origin-test-'));
  const a = join(root, 'source-a.mp4');
  const b = join(root, 'source-b.mp4');
  const aBytes = Buffer.alloc(256 * 1024, 0x41);
  const bBytes = Buffer.from('distinct-b');
  writeFileSync(a, aBytes);
  writeFileSync(b, bBytes);
  const eventsPath = join(root, 'evidence', 'events.jsonl');
  let origin;
  try {
    origin = await startDownloadFixtureOrigin({
      eventsPath,
      sources: [{ label: 'a', path: a }, { label: 'b', path: b }],
      chunkBytes: 4 * 1024,
      chunkDelayMs: 10,
    });
    assert.equal(origin.manifest.length, 2);
    assert.notEqual(origin.manifest[0].url, origin.manifest[1].url);
    assert.match(origin.manifest[0].url, /^http:\/\/127\.0\.0\.1:\d+\/a\.mp4\?token=[a-f0-9]{64}$/u);

    const range = await fetch(origin.manifest[0].url, { headers: { Range: 'bytes=8-31' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('accept-ranges'), 'bytes');
    assert.equal(range.headers.get('content-range'), `bytes 8-31/${aBytes.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), aBytes.subarray(8, 32));

    const interrupted = await fetch(origin.manifest[0].url);
    const reader = interrupted.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    await reader.cancel();
    const deadline = Date.now() + 3_000;
    let events = [];
    do {
      events = readDownloadFixtureEvents(eventsPath);
      if (events.some(({ event }) => event === 'request-aborted')) break;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    } while (Date.now() < deadline);
    assert.ok(events.some(({ event, route }) => event === 'request-complete' && route === 'a'));
    assert.ok(events.some(({ event, route }) => event === 'request-aborted' && route === 'a'));
    assert.equal(JSON.stringify(events).includes('token='), false, 'event ledger leaked a capability');

    const missing = await fetch(origin.manifest[0].url.replace('/a.mp4', '/missing.mp4'));
    assert.equal(missing.status, 404);
  } finally {
    if (origin) await origin.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the optional multi-format page exposes both exact throttled sources without widening production', async () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-download-multi-origin-test-'));
  const a = join(root, 'source-a.mp4');
  const b = join(root, 'source-b.mp4');
  writeFileSync(a, Buffer.from('first-format'));
  writeFileSync(b, Buffer.from('second-format'));
  let origin;
  try {
    origin = await startDownloadFixtureOrigin({
      eventsPath: join(root, 'events.jsonl'),
      sources: [{ label: 'a', path: a }, { label: 'b', path: b }],
      multiFormatPage: true,
    });
    assert.match(origin.multiFormatUrl, /^http:\/\/127\.0\.0\.1:\d+\/multi\.html\?token=[a-f0-9]{64}$/u);
    const page = await fetch(origin.multiFormatUrl);
    const body = await page.text();
    assert.equal(page.status, 200);
    for (const { url } of origin.manifest) assert.ok(body.includes(url));
    assert.equal((body.match(/<source /gu) ?? []).length, 2);
  } finally {
    if (origin) await origin.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('event reader rejects unbounded or malformed ledgers', () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-download-events-test-'));
  try {
    mkdirSync(root, { recursive: true });
    const path = join(root, 'events.jsonl');
    writeFileSync(path, '{"sequence":1,"route":"a"}\n');
    assert.throws(() => readDownloadFixtureEvents(path), /malformed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
